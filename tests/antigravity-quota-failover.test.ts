import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityExecutor } from '../src/engines/antigravity/executor.js';
import { AntigravityQuotaHealth, isExplicitQuotaExhaustion } from '../src/engines/antigravity/quota-failover.js';
import { SessionManager } from '../src/engines/claude/session-manager.js';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';
import type { ExecutorOptions, SDKMessage } from '../src/engines/claude/executor.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function fixture(error = 'quota exhausted', work?: string, backupModel = 'gemini-4-argon-low', backupError?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-failover-'));
  dirs.push(dir);
  const calls = path.join(dir, 'calls.jsonl');
  const runners: Record<string, { runner: string }> = {};
  for (const alias of ['primary', 'backup']) {
    const runner = path.join(dir, alias);
    const events: any[] = [
      { event: 'init', conversation_id: alias + '-conversation', init: { model: 'gemini-4-argon-low' } },
    ];
    events.push({ event: 'step_update', step_update: { state: 'DONE', step_type: 'user_input', step_index: 0 } });
    if (alias === 'primary' && work) {
      if (work !== 'malformed')
        events.push({
          event: 'step_update',
          step_update: {
            state: 'ACTIVE',
            step_type: work,
            text_delta: work === 'agent_response' ? 'partial' : undefined,
            tool_name: work === 'tool' ? 'write_file' : undefined,
            step_index: 1,
          },
        });
    }
    if (alias === 'primary' || backupError)
      events.push({ event: 'step_update', step_update: { state: 'DONE', step_type: 'error_message', step_index: 2 } });
    events.push({
      event: 'result',
      result: {
        conversation_id: alias + '-conversation',
        status: alias === 'primary' || backupError ? 'ERROR' : 'SUCCESS',
        num_turns: 1,
        error: alias === 'primary' ? error : backupError,
        response: alias === 'backup' && !backupError ? 'OK' : undefined,
      },
    });
    fs.writeFileSync(
      runner,
      `#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({alias:${JSON.stringify(alias)},args})+'\\n');if(args[0]==='models'){console.log(${JSON.stringify(backupModel + ' Fixture model')});process.exit(0);}if(args.includes('/usage')){console.log('{}');process.exit(0);}if(${JSON.stringify(alias === 'primary' && work === 'malformed')})console.log('not-json');for(const e of ${JSON.stringify(events)})console.log(JSON.stringify(e));\n`,
      { mode: 0o700 },
    );
    runners[alias] = { runner };
  }
  const config: any = {
    name: 'fixture',
    engine: 'antigravity',
    antigravity: { model: 'gemini-4-argon-low', defaultAccount: 'primary', accounts: runners, quotaFailover: true },
  };
  const readCalls = () =>
    fs.existsSync(calls)
      ? fs
          .readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  return { dir, config, readCalls };
}
async function run(f: ReturnType<typeof fixture>, overrides: Partial<ExecutorOptions> = {}) {
  const messages: SDKMessage[] = [];
  const executor = new AntigravityExecutor(f.config, logger);
  for await (const message of executor.execute({
    prompt: 'bounded fixture',
    cwd: f.dir,
    abortController: new AbortController(),
    ...overrides,
  }))
    messages.push(message);
  return messages;
}
const attempts = (f: ReturnType<typeof fixture>) => f.readCalls().filter((c) => c.args.includes('stream-json'));

describe('quota-only failover', () => {
  it.each([
    'quota exhausted',
    'QUOTA_EXCEEDED',
    'Quota reached',
    'quota limit reached',
    'weekly usage limit reached',
    'insufficient quota',
  ])('recognizes explicit %s', (error) => expect(isExplicitQuotaExhaustion(error)).toBe(true));
  it.each([
    '429 rate limit',
    'capacity unavailable',
    'RESOURCE_EXHAUSTED',
    'model unavailable quota exhausted',
    'oauth quota exhausted',
    'permission denied quota exhausted',
    'unsupported region quota exhausted',
    'network timeout',
  ])('does not rotate on %s', async (error) => {
    const f = fixture(error);
    const messages = await run(f);
    expect(attempts(f).map((c) => c.alias)).toEqual(['primary']);
    expect(messages.at(-1)?.is_error).toBe(true);
  });
  it('retries pre-work quota once, preserves exact effort model, detaches old ID and persists before spawn', async () => {
    const f = fixture();
    const saved: string[] = [];
    const messages = await run(f, {
      sessionId: 'old-id',
      onAntigravityAccountSwitch: (alias) => {
        expect(attempts(f).map((c) => c.alias)).toEqual(['primary']);
        saved.push(alias);
      },
    });
    expect(saved).toEqual(['backup']);
    expect(attempts(f).map((c) => c.alias)).toEqual(['primary', 'backup']);
    expect(attempts(f)[0].args).toContain('old-id');
    expect(attempts(f)[1].args).not.toContain('--conversation');
    expect(attempts(f)[1].args).toContain('gemini-4-argon-low');
    expect(messages.filter((m) => m.type === 'result')).toHaveLength(1);
    expect(messages.at(-1)?.is_error).toBe(false);
    expect(messages.some((m) => m.session_id === 'primary-conversation')).toBe(false);
    expect(messages.some((m) => JSON.stringify(m).includes('旧会话记录保留'))).toBe(true);
  });
  it('shares exhausted state across a new bot executor and chat', async () => {
    const f = fixture();
    await run(f);
    f.config.name = 'other-bot';
    await run(f);
    expect(attempts(f).map((c) => c.alias)).toEqual(['primary', 'backup', 'backup']);
  });
  it('persists the backup conversation owner through reload and resumes only that runner', async () => {
    const f = fixture('Quota reached');
    process.env.SESSION_STORE_DIR = f.dir;
    let manager = new SessionManager(f.dir, logger, 'persist-test');
    try {
      manager.setSessionId('chat', 'old-primary');
      const processor = new StreamProcessor('fixture');
      const executor = new AntigravityExecutor(f.config, logger);
      for await (const m of executor.execute({
        prompt: 'test',
        cwd: f.dir,
        sessionId: manager.getSession('chat').sessionId,
        abortController: new AbortController(),
        onAntigravityAccountSwitch: (alias) => {
          manager.setAntigravityAccount('chat', alias);
        },
      })) {
        processor.processMessage(m);
        const sid = processor.getSessionId();
        if (sid) manager.setSessionId('chat', sid);
      }
      manager.destroy();
      manager = new SessionManager(f.dir, logger, 'persist-test');
      const session = manager.getSession('chat');
      expect(session.antigravityAccount).toBe('backup');
      expect(session.sessionId).toBe('backup-conversation');
      await run(f, { antigravityAccount: session.antigravityAccount, sessionId: session.sessionId });
      expect(attempts(f).at(-1).alias).toBe('backup');
      expect(attempts(f).at(-1).args).toContain('backup-conversation');
    } finally {
      manager.destroy();
      delete process.env.SESSION_STORE_DIR;
    }
  });
  it.each(['tool', 'agent_response', 'thinking', 'malformed'])(
    'does not replay after %s but routes next turn away',
    async (work) => {
      const f = fixture('quota exhausted', work);
      const messages = await run(f);
      expect(attempts(f).map((c) => c.alias)).toEqual(['primary']);
      expect(messages.at(-1)?.errors?.join()).toContain('未换号重跑');
      await run(f);
      expect(attempts(f).map((c) => c.alias)).toEqual(['primary', 'backup']);
    },
  );
  it('stops after both accounts exhaust and next chat spawns no generation', async () => {
    const f = fixture('quota exhausted', undefined, 'gemini-4-argon-low', 'quota exhausted');
    expect((await run(f)).at(-1)?.errors?.join()).toContain('均耗尽');
    await run(f);
    expect(attempts(f).map((c) => c.alias)).toEqual(['primary', 'backup']);
  });
  it('rejects missing candidate exact effort without downgrading or persisting', async () => {
    const f = fixture();
    const save = vi.fn();
    await run(f, { antigravityReasoningEffort: 'high', onAntigravityAccountSwitch: save });
    expect(attempts(f).map((c) => c.alias)).toEqual(['primary']);
    expect(save).not.toHaveBeenCalled();
  });
  it('passes the aligned variant to the eligible backup', async () => {
    const f = fixture('quota exhausted', undefined, 'gemini-4-argon-high');
    await run(f, { antigravityReasoningEffort: 'high' });
    expect(attempts(f)[1].args).toContain('gemini-4-argon-high');
    expect(attempts(f)[1].args).toContain('--effort');
  });
  it('does not start backup after state-save failure', async () => {
    const f = fixture();
    const messages = await run(f, {
      onAntigravityAccountSwitch: () => {
        throw new Error('private error');
      },
    });
    expect(attempts(f).map((c) => c.alias)).toEqual(['primary']);
    expect(JSON.stringify(messages)).not.toContain('private error');
  });
  it('cancellation during handoff never spawns backup', async () => {
    const f = fixture();
    const abortController = new AbortController();
    await run(f, { abortController, onAntigravityAccountSwitch: () => abortController.abort() });
    expect(attempts(f).map((c) => c.alias)).toEqual(['primary']);
  });
  it('requires a durable callback when switching a resumed conversation', async () => {
    const f = fixture();
    const messages = await run(f, { sessionId: 'old-id' });
    expect(attempts(f).map((c) => c.alias)).toEqual(['primary']);
    expect(messages.at(-1)?.errors?.join()).toContain('持久化回调');
  });
  it('leaves default-disabled deployments untouched', async () => {
    const f = fixture();
    delete f.config.antigravity.quotaFailover;
    await run(f);
    expect(attempts(f).map((c) => c.alias)).toEqual(['primary']);
  });
  it('cooldown is bounded and isolated by runner and provider quota family', () => {
    let now = 100;
    const h = new AntigravityQuotaHealth(() => now, 1000);
    h.markExhausted('/primary', 'gemini-4-argon-low');
    expect(h.isExhausted('/primary', 'gemini-4-argon-high')).toBe(true);
    expect(h.isExhausted('/primary', 'claude-opus-5-5-medium')).toBe(false);
    expect(h.isExhausted('/backup', 'gemini-4-argon-low')).toBe(false);
    h.markExhausted('/primary', 'claude-opus-5-5-high');
    expect(h.isExhausted('/primary', 'claude-sonnet-5-5-low')).toBe(true);
    now += 1000;
    expect(h.isExhausted('/primary', 'gemini-4-argon-low')).toBe(false);
  });
  it('rolls back account and conversation if persistence fails', () => {
    const f = fixture();
    process.env.SESSION_STORE_DIR = f.dir;
    const manager = new SessionManager(f.dir, logger, 'test');
    delete process.env.SESSION_STORE_DIR;
    try {
      manager.setSessionId('chat', 'old-id');
      const store = path.join(f.dir, 'sessions-test.json');
      fs.unlinkSync(store);
      fs.mkdirSync(store); // Real EISDIR failure, no production files.
      expect(() => manager.setAntigravityAccount('chat', 'backup')).toThrow(/persist/);
      expect(manager.getSession('chat').sessionId).toBe('old-id');
      expect(manager.getSession('chat').antigravityAccount).toBeUndefined();
    } finally {
      manager.destroy();
    }
  });
  it('never overwrites the durable store or removes a pre-existing atomic temp file on collision', () => {
    const f = fixture(); process.env.SESSION_STORE_DIR = f.dir;
    const manager = new SessionManager(f.dir, logger, 'atomic-test'); delete process.env.SESSION_STORE_DIR;
    try {
      manager.setSessionId('chat', 'old-id');
      const store = path.join(f.dir, 'sessions-atomic-test.json');
      const before = fs.readFileSync(store, 'utf8');
      const now = Date.now(); const temporary = `${store}.${process.pid}.${now}.tmp`;
      fs.writeFileSync(temporary, 'pre-existing'); vi.spyOn(Date, 'now').mockReturnValue(now);
      expect(() => manager.setAntigravityAccount('chat', 'backup')).toThrow(/persist/);
      expect(fs.readFileSync(store, 'utf8')).toBe(before);
      expect(fs.readFileSync(temporary, 'utf8')).toBe('pre-existing');
      expect(manager.getSession('chat').antigravityAccount).toBeUndefined();
    } finally { vi.restoreAllMocks(); manager.destroy(); }
  });
});
