import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface QuotaWindow {
  usedPct: number;
  hoursToReset: number;
}

export interface CodexQuota {
  /** 5-hour rolling window (rate_limits.primary). */
  primary?: QuotaWindow;
  /** Weekly window (rate_limits.secondary). */
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
  const hoursToReset = typeof b.resets_at === 'number'
    ? Math.max(0, (b.resets_at - nowSec) / 3600)
    : 0;
  return {
    usedPct: Math.round(b.used_percent * 10) / 10,
    hoursToReset: Math.round(hoursToReset * 10) / 10,
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
 * Read live Codex session status from the rollout file: account-level quota
 * (rate_limits) plus the current-turn token occupation and effective context
 * window (token_count `info`). All three live in `event_msg/token_count`
 * payloads; we scan from the end and take the most recent of each.
 *
 * `rate_limits.limit_id` is "codex" (account-global, not per-session), so the
 * most recently written rollout reflects the live quota regardless of thread.
 *
 * Returns null on any failure — callers must degrade gracefully; this is
 * best-effort footer cosmetics, never load-bearing.
 */
export function readCodexSessionStatus(sessionId?: string): CodexSessionStatus | null {
  try {
    const file = locateSessionFile(sessionId);
    if (!file) return null;

    const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
    const nowSec = Date.now() / 1000;

    let quota: CodexQuota | null = null;
    let lastTurnInputTokens: number | undefined;
    let lastTurnOutputTokens: number | undefined;
    let contextWindow: number | undefined;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes('token_count')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = (parsed as { payload?: Record<string, unknown> })?.payload;
      if (!payload || payload.type !== 'token_count') continue;

      // Quota (most recent token_count carrying rate_limits).
      if (!quota) {
        const rl = payload.rate_limits as { primary?: unknown; secondary?: unknown } | undefined;
        if (rl) {
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

      if (quota && lastTurnInputTokens !== undefined) break;
    }

    if (!quota && lastTurnInputTokens === undefined) return null;
    return { quota, lastTurnInputTokens, lastTurnOutputTokens, contextWindow };
  } catch {
    return null;
  }
}
