import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

const CODE_ASSIST_ENDPOINT = process.env.CODE_ASSIST_ENDPOINT || 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = process.env.CODE_ASSIST_API_VERSION || 'v1internal';
const OAUTH_CREDS_PATH = process.env.GEMINI_OAUTH_CREDS_PATH || path.join(os.homedir(), '.gemini', 'oauth_creds.json');

export interface QuotaBucket {
  modelId: string;
  tokenType: string;
  remainingFraction: number;
  remainingAmount?: string;
  resetTime?: string; // ISO 8601
}

/**
 * Call Google Code Assist's retrieveUserQuota endpoint and return per-model
 * quota buckets for the OAuth user. Reuses ~/.gemini/oauth_creds.json's
 * access_token (refreshed by gemini-cli on use).
 *
 * Returns null on any failure (token expired / network error / API change).
 * Caller should treat null as "quota info unavailable" and degrade
 * gracefully — never block on this call.
 */
export async function fetchGeminiQuota(): Promise<QuotaBucket[] | null> {
  let creds: { access_token?: string };
  try {
    creds = JSON.parse(readFileSync(OAUTH_CREDS_PATH, 'utf-8'));
  } catch {
    return null;
  }
  if (!creds.access_token) return null;

  // Project id is a required param but accepts any non-empty string for the
  // Pro-tier user-scope quota call (Google returns the AI Pro user's quota
  // regardless of which project label is passed — observed empirically).
  const body = JSON.stringify({ project: 'metabot' });
  const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:retrieveUserQuota`;
  const u = new URL(url);

  return new Promise<QuotaBucket[] | null>((resolve) => {
    const req = request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.access_token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (!Array.isArray(parsed?.buckets)) {
            resolve(null);
            return;
          }
          resolve(parsed.buckets);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Render a status line matching Claude's card-footer style.
 * Format: `ctx: 17k/1M (1.7%) | quota: 24.7% used (resets 00:28 UTC) | gemini-3.1-pro-preview | 6.8s`
 *
 * Fields degrade gracefully if any datum is missing:
 *   - quota missing → `quota: ?`
 *   - ctx missing → omit ctx
 *   - model missing → show '?'
 */
export function renderStatusLine(opts: {
  inputTokens?: number;
  contextWindow?: number;
  model?: string;
  durationMs?: number;
  quotaBuckets: QuotaBucket[] | null;
}): string {
  const { inputTokens, contextWindow, model, durationMs, quotaBuckets } = opts;
  const parts: string[] = [];

  if (typeof inputTokens === 'number' && typeof contextWindow === 'number' && contextWindow > 0) {
    const pct = ((inputTokens / contextWindow) * 100).toFixed(1);
    const ctxK = (inputTokens / 1000).toFixed(1);
    const winK = contextWindow >= 1_000_000 ? `${(contextWindow / 1_000_000).toFixed(0)}M` : `${(contextWindow / 1000).toFixed(0)}k`;
    parts.push(`ctx: ${ctxK}k/${winK} (${pct}%)`);
  }

  if (quotaBuckets && model) {
    const bucket = quotaBuckets.find((b) => b.modelId === model);
    if (bucket && typeof bucket.remainingFraction === 'number') {
      const usedPct = ((1 - bucket.remainingFraction) * 100).toFixed(1);
      const resetHHMM = bucket.resetTime
        ? new Date(bucket.resetTime).toISOString().slice(11, 16) + ' UTC'
        : '?';
      parts.push(`quota: ${usedPct}% used (resets ${resetHHMM})`);
    } else {
      parts.push('quota: ?');
    }
  } else if (model) {
    parts.push('quota: ?');
  }

  parts.push(model || '?');

  if (typeof durationMs === 'number') {
    parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  }

  return parts.join(' | ');
}
