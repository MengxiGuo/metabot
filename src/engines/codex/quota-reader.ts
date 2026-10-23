import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isCodexReasoningEffort, type CodexReasoningEffort } from '../../config.js';
import { codexRateLimitIdForModel, quotaWindowLabel } from './rate-limits.js';

const MAX_SESSION_TAIL_BYTES = 16 * 1024 * 1024;

export interface QuotaWindow {
  usedPct: number;
  hoursToReset: number;
  label?: string;
}

export interface CodexQuota {
  /** Primary window reported by Codex (currently 5-hour or weekly, depending on the bucket). */
  primary?: QuotaWindow;
  /** Optional secondary window (commonly weekly for the Spark bucket). */
  secondary?: QuotaWindow;
}

export interface CodexSessionStatus {
  quota: CodexQuota | null;
  /** Current-turn context occupation (last_token_usage), NOT the cumulative
   *  session total that `exec --json` reports on stdout. Tracks compaction. */
  lastTurnInputTokens?: number;
  lastTurnOutputTokens?: number;
  /** Effective context window codex applies for the model (model_context_window). */
  contextWindow?: number;
  /** Actual per-turn effort emitted in the latest Codex turn_context event. */
  reasoningEffort?: CodexReasoningEffort;
}

function codexSessionsDir(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

/**
 * Recursively collect rollout-*.jsonl files under the sessions dir.
 * Bounded by a hard file cap so a long-lived install never turns this into
 * an unbounded scan on the hot path.
 */
function collectRolloutFiles(dir: string, cap: number, acc: string[]): void {
  if (acc.length >= cap) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Newest-first traversal (dir names are zero-padded date components, so a
  // reverse lexical sort visits the most recent year/month/day first).
  entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  for (const e of entries) {
    if (acc.length >= cap) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      collectRolloutFiles(full, cap, acc);
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      acc.push(full);
    }
  }
}

function mkWindow(bucket: unknown, nowSec: number): QuotaWindow | undefined {
  if (!bucket || typeof bucket !== 'object') return undefined;
  const b = bucket as Record<string, unknown>;
  if (typeof b.used_percent !== 'number') return undefined;
  const hoursToReset = typeof b.resets_at === 'number' ? Math.max(0, (b.resets_at - nowSec) / 3600) : 0;
  const label = quotaWindowLabel(b.window_minutes);
  return {
    usedPct: Math.round(b.used_percent * 10) / 10,
    hoursToReset: Math.round(hoursToReset * 10) / 10,
    ...(label ? { label } : {}),
  };
}

function locateSessionFile(sessionId?: string): string | undefined {
  const files: string[] = [];
  collectRolloutFiles(codexSessionsDir(), 5000, files);
  if (files.length === 0) return undefined;

  let candidates = sessionId ? files.filter((f) => f.includes(sessionId)) : [];
  if (candidates.length === 0) candidates = files;

  // Newest by mtime — the turn that just finished flushed its file last.
  let newest: string | undefined;
  let newestMtime = -Infinity;
  for (const f of candidates) {
    try {
      const m = statSync(f).mtimeMs;
      if (m > newestMtime) {
        newestMtime = m;
        newest = f;
      }
    } catch {
      // skip unreadable
    }
  }
  return newest;
}

/**
 * Read only a bounded tail of a rollout. Some long-lived Codex sessions are
 * hundreds of MiB; loading the whole JSONL file on every result-card render can
 * exhaust the small SG node. A partial first record is discarded safely.
 */
function readSessionTailLines(file: string): string[] {
  const size = statSync(file).size;
  const start = Math.max(0, size - MAX_SESSION_TAIL_BYTES);
  const length = size - start;
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(file, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < length) {
      const count = readSync(fd, buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    closeSync(fd);
  }

  let text = buffer.subarray(0, bytesRead).toString('utf-8');
  if (start > 0) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  }
  return text.split(/\r?\n/);
}

export function parseCodexSessionStatusLines(
  lines: readonly string[],
  nowSec = Date.now() / 1000,
  model?: string,
): CodexSessionStatus | null {
  let quota: CodexQuota | null = null;
  let lastTurnInputTokens: number | undefined;
  let lastTurnOutputTokens: number | undefined;
  let contextWindow: number | undefined;
  let reasoningEffort: CodexReasoningEffort | undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || (!line.includes('token_count') && !line.includes('turn_context'))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;
    const payload = record.payload as Record<string, unknown> | undefined;

    // Codex writes turn_context as a top-level record, while token_count is an
    // event_msg payload. Accept the older nested shape too for compatibility.
    const turnContext =
      record.type === 'turn_context' ? (payload ?? record) : payload?.type === 'turn_context' ? payload : undefined;
    if (turnContext) {
      if (reasoningEffort === undefined && isCodexReasoningEffort(turnContext.effort)) {
        reasoningEffort = turnContext.effort;
      }
      // This is the latest turn boundary because the scan is newest-first.
      // A matching quota before this record belongs to an older turn and can
      // be arbitrarily stale when the current turn emitted another limit_id.
      break;
    }
    if (!payload || payload.type !== 'token_count') continue;

    // Quota (most recent token_count carrying rate_limits).
    if (!quota) {
      const rl = payload.rate_limits as {
        limit_id?: unknown;
        primary?: unknown;
        secondary?: unknown;
      } | undefined;
      const limitId = typeof rl?.limit_id === 'string' ? rl.limit_id : undefined;
      if (rl && (!limitId || limitId === codexRateLimitIdForModel(model))) {
        const primary = mkWindow(rl.primary, nowSec);
        const secondary = mkWindow(rl.secondary, nowSec);
        if (primary || secondary) quota = { primary, secondary };
      }
    }

    // Current-turn tokens + window (most recent token_count carrying info).
    if (lastTurnInputTokens === undefined) {
      const info = payload.info as Record<string, unknown> | undefined;
      const last = info?.last_token_usage as Record<string, unknown> | undefined;
      if (last && typeof last.input_tokens === 'number') {
        lastTurnInputTokens = last.input_tokens;
        lastTurnOutputTokens = typeof last.output_tokens === 'number' ? last.output_tokens : 0;
        if (typeof info?.model_context_window === 'number') {
          contextWindow = info.model_context_window as number;
        }
      }
    }

    if (quota && lastTurnInputTokens !== undefined && reasoningEffort !== undefined) break;
  }

  if (!quota && lastTurnInputTokens === undefined && reasoningEffort === undefined) return null;
  return { quota, lastTurnInputTokens, lastTurnOutputTokens, contextWindow, reasoningEffort };
}

/**
 * Read live Codex session status from the rollout file: account-level quota
 * (rate_limits) plus the current-turn token occupation and effective context
 * window (token_count `info`), plus the latest top-level turn_context effort.
 * We scan from the end and take the most recent matching value of each.
 *
 * Rate limits are account-level but model-family-specific. The newest rollout
 * event can therefore belong to another bucket (for example Spark's
 * `codex_bengalfox`); select the bucket matching the current model.
 *
 * Returns null on any failure — callers must degrade gracefully; this is
 * best-effort footer cosmetics, never load-bearing.
 */
export function readCodexSessionStatus(sessionId?: string, model?: string): CodexSessionStatus | null {
  try {
    const file = locateSessionFile(sessionId);
    if (!file) return null;

    return parseCodexSessionStatusLines(readSessionTailLines(file), Date.now() / 1000, model);
  } catch {
    return null;
  }
}
