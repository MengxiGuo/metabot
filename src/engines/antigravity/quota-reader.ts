import { execFile } from 'node:child_process';
import type { SDKMessage } from '../claude/executor.js';

const USAGE_TIMEOUT_MS = 15_000;
const USAGE_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const GEMINI_4_ARGON_CONTEXT_WINDOW = 1_048_576;
const CLAUDE_5_5_CONTEXT_WINDOW = 1_000_000;

interface AntigravityQuotaBucket {
  id?: unknown;
  window?: unknown;
  remaining_fraction?: unknown;
  reset_time?: unknown;
}

interface AntigravityQuotaGroup {
  name?: unknown;
  buckets?: unknown;
}

type QuotaInfo = NonNullable<SDKMessage['quotaInfo']>;
type QuotaWindow = Pick<QuotaInfo, 'usedPct' | 'hoursToReset' | 'label'>;

/**
 * Resolve only context windows backed by either explicit configuration or
 * provider documentation. Gemini 4 Argon's unified input/output limit is
 * 1,048,576 tokens. Google Cloud documents 1,000,000 tokens for both Claude
 * Opus 5.5 and Sonnet 5.5. Unknown models deliberately return undefined.
 */
export function resolveAntigravityContextWindow(model?: string, configured?: number): number | undefined {
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return configured;
  if (model && /^gemini-4-argon(?:-|$)/i.test(model)) return GEMINI_4_ARGON_CONTEXT_WINDOW;
  if (model && /^claude-(?:opus|sonnet)-5-5(?:-|$)/i.test(model)) return CLAUDE_5_5_CONTEXT_WINDOW;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function selectGroup(groups: AntigravityQuotaGroup[], model: string): AntigravityQuotaGroup | undefined {
  const normalizedModel = model.toLowerCase();
  if (normalizedModel.includes('argon')) {
    return groups.find((group) => {
      const name = typeof group.name === 'string' ? group.name.toLowerCase() : '';
      const buckets = Array.isArray(group.buckets) ? (group.buckets as AntigravityQuotaBucket[]) : [];
      return (
        name.includes('argon') ||
        buckets.some((bucket) =>
          String(bucket.id ?? '')
            .toLowerCase()
            .includes('argon'),
        )
      );
    });
  }
  if (normalizedModel.startsWith('gemini-')) {
    return groups.find((group) => {
      const name = typeof group.name === 'string' ? group.name.toLowerCase() : '';
      const buckets = Array.isArray(group.buckets) ? (group.buckets as AntigravityQuotaBucket[]) : [];
      return (
        name === 'gemini models' ||
        buckets.some((bucket) => {
          const id = String(bucket.id ?? '').toLowerCase();
          return id.startsWith('gemini-') && !id.includes('argon');
        })
      );
    });
  }
  if (normalizedModel.startsWith('claude-') || normalizedModel.startsWith('gpt-')) {
    return groups.find((group) => {
      const name = typeof group.name === 'string' ? group.name.toLowerCase() : '';
      const buckets = Array.isArray(group.buckets) ? (group.buckets as AntigravityQuotaBucket[]) : [];
      return (
        name.includes('claude') ||
        name.includes('gpt') ||
        buckets.some((bucket) => String(bucket.id ?? '').startsWith('3p-'))
      );
    });
  }
  return undefined;
}

function quotaLabel(window: string): string {
  const normalized = window.toLowerCase();
  if (normalized === 'weekly' || normalized === 'week' || normalized === '7d') return '周';
  if (normalized === 'monthly' || normalized === 'month' || normalized === '30d') return '月';
  return window;
}

function parseWindow(bucket: AntigravityQuotaBucket, nowMs: number): QuotaWindow | undefined {
  if (typeof bucket.remaining_fraction !== 'number' || !Number.isFinite(bucket.remaining_fraction)) return undefined;
  if (typeof bucket.window !== 'string' || !bucket.window) return undefined;
  if (typeof bucket.reset_time !== 'string') return undefined;
  const resetMs = Date.parse(bucket.reset_time);
  if (!Number.isFinite(resetMs)) return undefined;
  const remaining = Math.min(1, Math.max(0, bucket.remaining_fraction));
  return {
    usedPct: Math.round((1 - remaining) * 1000) / 10,
    hoursToReset: Math.round((Math.max(0, resetMs - nowMs) / 3_600_000) * 10) / 10,
    label: quotaLabel(bucket.window),
  };
}

function windowRank(window: QuotaWindow): number {
  const label = window.label?.toLowerCase() ?? '';
  if (label === '5h') return 0;
  if (label === '周') return 1;
  if (label === '月') return 2;
  return 3;
}

/** Parse the machine-readable payload returned by `agy -p /usage`. */
export function parseAntigravityQuota(output: string, model: string, nowMs = Date.now()): QuotaInfo | undefined {
  let document: unknown;
  try {
    document = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(document) || document.status !== 'SUCCESS') return undefined;
  const command = document.command;
  if (!isRecord(command) || command.name !== 'usage' || !isRecord(command.data)) return undefined;
  const rawGroups = command.data.groups;
  if (!Array.isArray(rawGroups)) return undefined;
  const groups = rawGroups.filter(isRecord) as AntigravityQuotaGroup[];
  const selected = selectGroup(groups, model);
  if (!selected || !Array.isArray(selected.buckets)) return undefined;
  const windows = (selected.buckets as AntigravityQuotaBucket[])
    .map((bucket) => parseWindow(bucket, nowMs))
    .filter((window): window is QuotaWindow => Boolean(window))
    .sort((left, right) => windowRank(left) - windowRank(right));
  if (windows.length === 0) return undefined;
  const [primary, secondary, tertiary] = windows;
  return {
    ...primary,
    ...(secondary ? { secondary } : {}),
    ...(tertiary ? { tertiary } : {}),
  };
}

/**
 * Read current quota through the exact runner selected for this turn. The
 * `/usage` print command is read-only and does not start an agent turn.
 */
export function fetchAntigravityQuota(
  executable: string,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<QuotaInfo | undefined> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ['--output-format', 'json', '-p', '/usage'],
      {
        encoding: 'utf8',
        timeout: USAGE_TIMEOUT_MS,
        maxBuffer: USAGE_MAX_BUFFER_BYTES,
        env,
      },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(parseAntigravityQuota(stdout, model));
      },
    );
  });
}
