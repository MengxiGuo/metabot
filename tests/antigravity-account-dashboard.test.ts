import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAccountSnapshot, formatAccountSnapshot, parseAccountUsage, profileFromRunner } from '../src/engines/antigravity/account-dashboard.js';

const now = Date.parse('2026-11-01T00:00:00Z');
const payload = (buckets: unknown[]) => JSON.stringify({ status: 'SUCCESS', command: {
  name: 'usage', data: { groups: [{ name: 'Claude and GPT models', buckets }] },
} });

describe('Antigravity account dashboard', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('extracts only an explicit literal profile on the runner exec command', () => {
    expect(profileFromRunner('#!/bin/sh\nexec /bin/agy \\\n --gemini_dir=/root/.gemini "$@"')).toBe('/root/.gemini');
    expect(profileFromRunner('exec /bin/agy --gemini_dir="/tmp/with space" "$@"')).toBe('/tmp/with space');
    expect(profileFromRunner('exec /bin/agy --gemini_dir \'/tmp/backup\' "$@"')).toBe('/tmp/backup');
    for (const source of [
      'exec agy "$@"', '# --gemini_dir=/root/.gemini\nexec agy "$@"',
      'exec agy --gemini_dir="$HOME/.gemini" "$@"',
      'exec agy --gemini_dir=/a --gemini_dir=/b', 'exec agy --gemini_dir=relative',
    ]) expect(profileFromRunner(source)).toBeUndefined();
  });

  it('retains every window, distinguishes unknown from zero, and shows Beijing reset dates', () => {
    const snapshot = parseAccountUsage(payload([
      { window: 'weekly', remaining_fraction: 0.05, reset_time: '2026-11-05T10:28:01Z' },
      { window: '5h', remaining_fraction: 1, reset_time: '2026-11-01T05:00:00Z' },
      { window: 'monthly', remaining_fraction: 0, reset_time: 'invalid' },
      { window: 'daily', remaining_fraction: 1.1, reset_time: '2026-10-31T00:00:00Z' },
      null,
    ]), now);
    expect(snapshot.groups[0].buckets).toHaveLength(4);
    const body = formatAccountSnapshot('primary', 'primary', snapshot);
    expect(body).toContain('周额度：已用 95% · 剩余 5%');
    expect(body).toContain('5 小时额度：已用 0% · 剩余 100%');
    expect(body).toContain('2026-11-05 18:28');
    expect(body).toContain('月额度：已用 100%');
    expect(body).toContain('重置：未知');
    expect(body).toContain('daily额度：使用量未知');
    expect(body).toContain('已到期');
    expect(body).toContain('身份未知');
  });

  it('rejects invalid, unsuccessful, or empty responses without inventing unused quota', () => {
    for (const output of ['bad json', '{}', payload([]), payload([null]),
      JSON.stringify({ status: 'ERROR', command: { name: 'usage', data: { groups: [] } } })]) {
      const snapshot = parseAccountUsage(output, now);
      expect(snapshot.error).toBeDefined();
      expect(formatAccountSnapshot('a', 'a', snapshot)).not.toContain('已用 0%');
    }
  });

  it('deduplicates concurrent queries, invokes only /usage, and caches the timestamp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-'));
    dirs.push(dir);
    const runner = join(dir, 'runner');
    writeFileSync(runner, `#!/bin/sh\n[ "$1" = '--output-format' ] && [ "$2" = 'json' ] && [ "$3" = '-p' ] && [ "$4" = '/usage' ] || exit 3\n[ ! -f '${dir}/called' ] || exit 4\ntouch '${dir}/called'\ncat <<'JSON'\n${payload([{ window: '5h', remaining_fraction: 0.6 }])}\nJSON\n`, { mode: 0o755 });
    const [a, b] = await Promise.all([fetchAccountSnapshot(runner), fetchAccountSnapshot(runner)]);
    expect(a.error).toBeUndefined();
    expect(a.groups[0].buckets[0].usedPct).toBe(40);
    expect(a).toBe(b);
    expect(await fetchAccountSnapshot(runner)).toBe(a);
    expect(a.email).toBeUndefined();
  });

  it('hides provider stderr on failure and leaves quota unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-'));
    dirs.push(dir);
    const runner = join(dir, 'runner');
    writeFileSync(runner, '#!/bin/sh\necho private-credential >&2\nexit 1\n', { mode: 0o755 });
    const snapshot = await fetchAccountSnapshot(runner);
    const body = formatAccountSnapshot('backup', 'primary', snapshot);
    expect(body).toContain('查询失败');
    expect(body).not.toContain('private-credential');
    expect(body).not.toContain('已用 0%');
  });
});
