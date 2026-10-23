import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';

const OPENAPI_HOST = 'open.volcengineapi.com';
const OPENAPI_VERSION = '2024-01-01';
const SERVICE = 'ark';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const SIGNED_HEADERS = 'host;x-date;x-content-sha256;content-type';

export interface QuotaWindow {
  usedPct: number;
  hoursToReset: number;
  label?: string;
}

export interface ArkQuotaInfo extends QuotaWindow {
  secondary?: QuotaWindow;
  tertiary?: QuotaWindow;
}

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

function readOptionalFile(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  try {
    const value = readFileSync(filePath, 'utf-8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function resolveCredentials(config: BotConfigBase['claude']): Credentials | undefined {
  const quota = config.arkQuota;
  const accessKeyId =
    quota?.accessKeyId ??
    readOptionalFile(quota?.accessKeyIdFile) ??
    process.env.ARK_QUOTA_ACCESS_KEY_ID ??
    process.env.VOLC_ACCESSKEY;
  const secretAccessKey =
    quota?.secretAccessKey ??
    readOptionalFile(quota?.secretAccessKeyFile) ??
    process.env.ARK_QUOTA_SECRET_ACCESS_KEY ??
    process.env.VOLC_SECRETKEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey };
}

function inferRegion(config: BotConfigBase['claude']): string {
  if (config.arkQuota?.region) return config.arkQuota.region;
  const baseUrl = config.env?.ANTHROPIC_BASE_URL;
  const match = baseUrl?.match(/ark\.([a-z0-9-]+)\.volces\.com/i);
  return match?.[1] ?? 'cn-beijing';
}

function canonicalQuery(action: string, region: string): string {
  return [
    ['Action', action],
    ['Region', region],
    ['Version', OPENAPI_VERSION],
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function utcDateParts(now = new Date()): { xDate: string; shortDate: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    xDate: iso,
    shortDate: iso.slice(0, 8),
  };
}

export function signArkOpenApiRequest(opts: {
  action: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
}): { authorization: string; xDate: string; xContentSha256: string; query: string } {
  const query = canonicalQuery(opts.action, opts.region);
  const { xDate, shortDate } = utcDateParts(opts.now);
  const xContentSha256 = sha256Hex('');
  const canonicalHeaders =
    `host:${OPENAPI_HOST}\n` +
    `x-date:${xDate}\n` +
    `x-content-sha256:${xContentSha256}\n` +
    `content-type:${CONTENT_TYPE}\n`;
  const canonicalRequest = [
    'POST',
    '/',
    query,
    canonicalHeaders,
    SIGNED_HEADERS,
    xContentSha256,
  ].join('\n');
  const credentialScope = `${shortDate}/${opts.region}/${SERVICE}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const kDate = hmac(opts.secretAccessKey, shortDate);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  return {
    authorization: `HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    xDate,
    xContentSha256,
    query,
  };
}

async function callArkOpenApi(
  credentials: Credentials,
  region: string,
  action: string,
): Promise<Record<string, unknown> | null> {
  const signed = signArkOpenApiRequest({
    action,
    region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
  });
  const path = `/?${signed.query}`;

  return new Promise((resolve) => {
    const req = request({
      hostname: OPENAPI_HOST,
      path,
      method: 'POST',
      headers: {
        Host: OPENAPI_HOST,
        'Content-Type': CONTENT_TYPE,
        'X-Date': signed.xDate,
        'X-Content-Sha256': signed.xContentSha256,
        Authorization: signed.authorization,
        'Content-Length': '0',
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString('utf-8'); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const metadata = parsed.ResponseMetadata as Record<string, unknown> | undefined;
          if (metadata?.Error) {
            resolve(null);
            return;
          }
          resolve(parsed);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function hoursToReset(value: unknown): number {
  const raw = asNumber(value);
  if (!raw || raw <= 0) return 0;
  const resetMs = raw > 10_000_000_000 ? raw : raw * 1000;
  return Math.max(0, Math.round(((resetMs - Date.now()) / 3_600_000) * 10) / 10);
}

function mkWindow(label: string, usedPct: number, reset: unknown): QuotaWindow {
  return {
    label,
    usedPct: Math.round(usedPct * 10) / 10,
    hoursToReset: hoursToReset(reset),
  };
}

function combine(windows: QuotaWindow[]): ArkQuotaInfo | null {
  if (windows.length === 0) return null;
  const [primary, secondary, tertiary] = windows;
  return {
    ...primary,
    ...(secondary ? { secondary } : {}),
    ...(tertiary ? { tertiary } : {}),
  };
}

export function parseArkAfpUsage(body: Record<string, unknown>): ArkQuotaInfo | null {
  const result = asRecord(body.Result) ?? body;
  const windows: QuotaWindow[] = [];
  for (const [key, label] of [
    ['AFPFiveHour', '5h'],
    ['AFPWeekly', '周'],
    ['AFPMonthly', '月'],
  ] as const) {
    const win = asRecord(result[key]);
    if (!win) continue;
    const quota = asNumber(win.Quota) ?? 0;
    if (quota <= 0) continue;
    const used = asNumber(win.Used) ?? 0;
    windows.push(mkWindow(label, (used / quota) * 100, win.ResetTime));
  }
  return combine(windows);
}

export function parseArkCodingPlanUsage(body: Record<string, unknown>): ArkQuotaInfo | null {
  const result = asRecord(body.Result) ?? body;
  const items =
    (Array.isArray(result.QuotaUsage) ? result.QuotaUsage : undefined) ??
    (Array.isArray(result.Usages) ? result.Usages : undefined) ??
    (Array.isArray(result.Details) ? result.Details : undefined);
  if (!items) return null;

  const labelMap: Record<string, string> = {
    session: '5h',
    '5h': '5h',
    fivehour: '5h',
    five_hour: '5h',
    rolling_5h: '5h',
    weekly: '周',
    week: '周',
    '7d': '周',
    monthly: '月',
    month: '月',
  };
  const windows: QuotaWindow[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;
    const level = String(item.Level ?? item.Type ?? item.Period ?? item.Label ?? item.Window ?? '').toLowerCase();
    const label = labelMap[level];
    if (!label) continue;
    const pct = asNumber(item.Percent ?? item.UsedPercent ?? item.UsagePercent);
    if (pct === undefined) continue;
    windows.push(mkWindow(label, pct, item.ResetTime ?? item.ResetTimestamp));
  }
  return combine(windows);
}

export async function fetchArkQuotaInfo(
  config: BotConfigBase['claude'],
  logger: Logger,
): Promise<ArkQuotaInfo | null> {
  const baseUrl = config.env?.ANTHROPIC_BASE_URL ?? '';
  const isArk = /ark\.[a-z0-9-]+\.volces\.com/i.test(baseUrl) || !!config.arkQuota;
  if (!isArk) return null;

  const credentials = resolveCredentials(config);
  if (!credentials) return null;

  const region = inferRegion(config);
  try {
    const afp = await callArkOpenApi(credentials, region, 'GetAFPUsage');
    if (afp) {
      const quota = parseArkAfpUsage(afp);
      if (quota) return quota;
    }

    const coding = await callArkOpenApi(credentials, region, 'GetCodingPlanUsage');
    if (coding) {
      const quota = parseArkCodingPlanUsage(coding);
      if (quota) return quota;
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Ark quota fetch failed (non-fatal)');
  }
  return null;
}
