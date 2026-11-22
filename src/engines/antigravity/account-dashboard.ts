import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { AntigravityBotConfig } from '../../config.js';

interface Bucket {
  window: string;
  usedPct?: number;
  resetAt?: string;
}
export interface AccountSnapshot {
  email?: string;
  groups: Array<{ name: string; buckets: Bucket[] }>;
  checkedAt: number;
  error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only the explicit literal profile flag is supported. Never guess from alias/HOME. */
export function profileFromRunner(source: string): string | undefined {
  const script = source.replace(/\\\r?\n/g, ' ');
  const lines = script.split(/\r?\n/).filter(line => /^\s*exec\s/.test(line));
  if (lines.length !== 1) return undefined;
  const matches = [...lines[0].matchAll(/(?:^|\s)--gemini_dir(?:=|\s+)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))/g)];
  if (matches.length !== 1) return undefined;
  const profile = matches[0][1] ?? matches[0][2] ?? matches[0][3];
  return isAbsolute(profile) && ![...profile].some(char => char.charCodeAt(0) < 32) && !/[$`\\;|&<>]/.test(profile)
    ? profile : undefined;
}

async function smallFile(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16_384) throw new Error('unsupported file');
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) throw new Error('oversized file');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

/** Read only the provider-saved identity field; never return credentials or raw errors. */
async function readIdentity(runner: string): Promise<string | undefined> {
  try {
    const profile = profileFromRunner(await smallFile(runner));
    if (!profile) return undefined;
    const data: unknown = JSON.parse(await smallFile(join(profile, 'antigravity-cli', 'antigravity-oauth-token')));
    const email = isRecord(data) ? data.id_token_email : undefined;
    return typeof email === 'string' && /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email) && email.length <= 254
      ? email : undefined;
  } catch {
    return undefined;
  }
}

export function parseAccountUsage(output: string, checkedAt = Date.now()): AccountSnapshot {
  const failed = { groups: [], checkedAt, error: '额度响应无效，使用量未知' };
  try {
    const data: unknown = JSON.parse(output);
    if (!isRecord(data) || data.status !== 'SUCCESS' || !isRecord(data.command) ||
        data.command.name !== 'usage' || !isRecord(data.command.data) || !Array.isArray(data.command.data.groups)) return failed;
    const groups = data.command.data.groups.filter(isRecord).map(group => ({
      name: typeof group.name === 'string' ? group.name : '未命名额度池',
      buckets: (Array.isArray(group.buckets) ? group.buckets : []).filter(isRecord).map(bucket => {
        const remaining = bucket.remaining_fraction;
        const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN;
        return {
          window: typeof bucket.window === 'string' ? bucket.window : '未知周期',
          usedPct: typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= 1
            ? Math.round((1 - remaining) * 1000) / 10 : undefined,
          resetAt: Number.isFinite(reset) ? new Date(reset).toISOString() : undefined,
        };
      }).sort((a, b) => (a.window === '5h' ? -1 : 0) - (b.window === '5h' ? -1 : 0)),
    }));
    return groups.some(group => group.buckets.length) ? { groups, checkedAt } : failed;
  } catch {
    return failed;
  }
}

// Share a short cache/in-flight query across bots and chats using the same runner.
// One child process at a time, 15s timeout, 2 MiB output cap; no model generation.
const cache = new Map<string, { expires: number; value: Promise<AccountSnapshot> }>();
let queue: Promise<unknown> = Promise.resolve();
export function fetchAccountSnapshot(runner: string, envOverrides: Record<string, string> = {}): Promise<AccountSnapshot> {
  const key = JSON.stringify([runner, Object.entries(envOverrides).sort(([a], [b]) => a.localeCompare(b))]);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const entry = { expires: Infinity, value: Promise.resolve({ groups: [], checkedAt: 0 } as AccountSnapshot) };
  entry.value = queue.then(async () => {
    const email = await readIdentity(runner);
    const snapshot = await new Promise<AccountSnapshot>(resolve => {
      execFile(runner, ['--output-format', 'json', '-p', '/usage'], {
        encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, ...envOverrides },
      }, (error, stdout) => {
        resolve(error ? {
          groups: [], checkedAt: Date.now(),
          error: error.killed ? '额度查询超时，使用量未知' : '额度查询失败，使用量未知',
        } : parseAccountUsage(stdout));
      });
    });
    return { ...snapshot, email };
  }).finally(() => { entry.expires = Date.now() + 30_000; });
  queue = entry.value.catch(() => undefined);
  // Completed cache entries are disposable; retain in-flight deduplication.
  for (const [oldKey, old] of cache) {
    if (cache.size < 64) break;
    if (old.expires !== Infinity) cache.delete(oldKey);
  }
  cache.set(key, entry);
  return entry.value;
}

function safeText(value: string): string {
  return [...value].map(char => char.charCodeAt(0) < 32 ? ' ' : char).join('').slice(0, 254)
    .replace(/[\\`*_[\]<>|]/g, '\\$&');
}

function localTime(value: string | number): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

export function formatAccountSnapshot(alias: string, current: string, snapshot: AccountSnapshot): string {
  // Minimize identity data sent to IM. Never reconstruct a full address with [at].
  const localName = snapshot.email?.split('@')[0];
  const visible = localName ? (localName.length > 8
    ? `${localName.slice(0, 4)}…${localName.slice(-4)}`
    : `${localName.slice(0, 2)}…${localName.length > 2 ? localName.slice(-2) : ''}`) : undefined;
  const lines = [
    `**\`${safeText(alias)}\`${alias === current ? ' ✅ 当前账号' : ''}**`,
    `账号标识：${visible ? safeText(visible) + '（已脱敏）' : '身份未知（无法读取此 runner 的登录邮箱）'}`,
    `查询时间：${localTime(snapshot.checkedAt)}`,
  ];
  if (snapshot.error) lines.push(snapshot.error);
  for (const group of snapshot.groups) {
    lines.push(`**${safeText(group.name)}**`);
    if (!group.buckets.length) lines.push('- 额度未知（接口未返回额度窗口）');
    for (const bucket of group.buckets) {
      const label = ({ weekly: '周', monthly: '月', '5h': '5 小时' } as Record<string, string>)[bucket.window] ?? safeText(bucket.window);
      const usage = bucket.usedPct === undefined ? '使用量未知' : `已用 ${bucket.usedPct}% · 剩余 ${Math.round((100 - bucket.usedPct) * 10) / 10}%`;
      lines.push(`- ${label}额度：${usage}`);
      lines.push(`  重置：${bucket.resetAt ? localTime(bucket.resetAt) + (Date.parse(bucket.resetAt) <= snapshot.checkedAt ? '（已到期，待服务端更新）' : '') : '未知'}`);
    }
  }
  return lines.join('\n');
}

export async function buildAccountDashboard(config: AntigravityBotConfig | undefined, current: string, all = true): Promise<string[]> {
  const accounts = Object.entries(config?.accounts ?? {});
  const selected = accounts.length
    ? accounts.filter(([alias]) => all || alias === current).map(([alias, account]) => ({ alias, runner: account.runner }))
    : [{ alias: '_default_', runner: config?.executable || process.env.ANTIGRAVITY_EXECUTABLE_PATH || 'agy' }];
  if (!selected.length) return [formatAccountSnapshot(current, current, {
    groups: [], checkedAt: Date.now(), error: '此账号已不在配置中；请用 /account list 查看后重新选择。',
  })];
  const sections: string[] = [];
  for (const { alias, runner } of selected) {
    sections.push(formatAccountSnapshot(alias, current, await fetchAccountSnapshot(runner, config?.env)));
  }
  return sections;
}
