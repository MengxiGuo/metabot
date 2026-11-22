import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readAntigravityContextUsage } from '../src/engines/antigravity/context-usage.js';
import { AntigravityExecutor } from '../src/engines/antigravity/executor.js';
vi.mock('../src/engines/antigravity/quota-reader.js', async (original) => ({
  ...(await original<typeof import('../src/engines/antigravity/quota-reader.js')>()),
  fetchAntigravityQuota: vi.fn(async () => undefined),
}));
const id = '00000000-0000-4000-8000-000000000001';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agy-context-'));
  dirs.push(dir);
  const runner = join(dir, 'runner'),
    emit = join(dir, 'emit');
  writeFileSync(runner, `#!/bin/sh\nexec '${emit}' --gemini_dir='${dir}' "$@"\n`, { mode: 0o755 });
  const history = join(dir, 'antigravity-cli', 'brain', id, '.system_generated/logs/transcript.jsonl');
  mkdirSync(dirname(history), { recursive: true });
  const rows: any[] = [
    { step_index: 0, type: 'PLANNER_RESPONSE', source: 'MODEL', input_tokens: 999999 },
    { step_index: 1, type: 'USER_INPUT' },
    {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      input_tokens: 100,
      cache_read_tokens: 1000,
      output_tokens: 20,
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      input_tokens: 200,
      cache_read_tokens: 1200,
      output_tokens: 60,
      content: '<truncated>',
      truncated_fields: ['content'],
    },
  ];
  const save = () => writeFileSync(history, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  save();
  return { dir, runner, emit, history, rows, save };
}
describe('Antigravity single-request context usage', () => {
  it('uses the last model request and includes the cached input once', async () => {
    const f = fixture();
    expect(await readAntigravityContextUsage(f.runner, id, 1, 3)).toEqual({
      stepIndex: 3,
      promptTokens: 1400,
      completionTokens: 60,
    });
    expect(await readAntigravityContextUsage(f.runner, id)).toEqual({
      stepIndex: 3,
      promptTokens: 1400,
      completionTokens: 60,
    });
    expect(await readAntigravityContextUsage(f.runner, id, 3)).toBeUndefined();
  });
  it('defaults absent/nonfinite optional counts to zero, not cumulative totals', async () => {
    const f = fixture();
    delete f.rows[3].cache_read_tokens;
    f.rows[3].output_tokens = 'bad';
    f.save();
    expect(await readAntigravityContextUsage(f.runner, id, 1)).toEqual({
      stepIndex: 3,
      promptTokens: 200,
      completionTokens: 0,
    });
  });
  it.each([
    'missing',
    'bad_json',
    'bad_full',
    'directory',
    'negative',
    'oversize',
    'long_line',
    'future_turn',
    'future_step',
    'wrong_source',
    'invalid_input',
    'wrong_session',
    'no_profile',
  ])('fails safely or skips unusable model steps: %s', async (kind) => {
    const f = fixture();
    if (kind === 'negative') f.rows[3].input_tokens = -1;
    if (kind === 'future_turn') f.rows.push({ step_index: 4, type: 'USER_INPUT' });
    if (kind === 'future_step')
      f.rows.push({ step_index: 4, type: 'PLANNER_RESPONSE', source: 'MODEL', input_tokens: 1 });
    if (kind === 'wrong_source') f.rows[3].source = 'SYSTEM';
    if (kind === 'invalid_input') f.rows[3].input_tokens = '200';
    f.save();
    if (kind === 'missing' || kind === 'bad_full') {
      rmSync(f.history);
      if (kind === 'bad_full') writeFileSync(join(dirname(f.history), 'transcript_full.jsonl'), '{');
    }
    if (kind === 'bad_json') {
      writeFileSync(f.history, '{');
      writeFileSync(join(dirname(f.history), 'transcript_full.jsonl'), f.rows.map((x) => JSON.stringify(x)).join('\n'));
    }
    if (kind === 'directory') {
      rmSync(f.history);
      mkdirSync(f.history);
    }
    if (kind === 'oversize') truncateSync(f.history, 64 * 1024 * 1024 + 1);
    if (kind === 'long_line')
      writeFileSync(f.history, JSON.stringify({ step_index: 0, content: 'x'.repeat(4 * 1024 * 1024) }));
    if (kind === 'no_profile') writeFileSync(f.runner, '#!/bin/sh\nexit 0\n');
    const got = await readAntigravityContextUsage(f.runner, kind === 'wrong_session' ? '../oops' : id, 1, 3);
    if (kind === 'wrong_source' || kind === 'invalid_input')
      expect(got).toEqual({ stepIndex: 2, promptTokens: 1100, completionTokens: 20 });
    else expect(got).toBeUndefined();
  });
  it('falls back to full export only when compact export does not exist', async () => {
    const f = fixture();
    writeFileSync(join(dirname(f.history), 'transcript_full.jsonl'), f.rows.map((x) => JSON.stringify(x)).join('\n'));
    rmSync(f.history);
    expect((await readAntigravityContextUsage(f.runner, id, 1))?.promptTokens).toBe(1400);
  });
  it.each(['resumed', 'new', 'no_history', 'unknown_model', 'configured_window', 'failed'])(
    'executor footer integration: %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'no_history') rmSync(f.history);
      const model = kind === 'unknown_model' ? 'unknown-model' : 'gemini-4-carbon-high';
      const events = [
        { event: 'init', conversation_id: id, init: { model } },
        { event: 'step_update', step_update: { step_index: 1, step_type: 'user_input', state: 'DONE' } },
        {
          event: 'step_update',
          step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: 'Finished.' },
        },
        {
          event: 'result',
          result: {
            conversation_id: id,
            status: kind === 'failed' ? 'ERROR' : 'SUCCESS',
            error: kind === 'failed' ? 'real error' : undefined,
            response: 'Finished.',
            duration_seconds: 244760.4,
            usage: { input_tokens: 2614000, output_tokens: 9999 },
          },
        },
      ];
      writeFileSync(
        f.emit,
        "#!/bin/sh\ncat <<'EVENTS'\n" + events.map((x) => JSON.stringify(x)).join('\n') + '\nEVENTS\n',
        { mode: 0o755 },
      );
      const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
      const executor = new AntigravityExecutor(
        {
          name: 'test',
          engine: 'antigravity',
          antigravity: { executable: f.runner, ...(kind === 'configured_window' ? { contextWindow: 900000 } : {}) },
        } as any,
        logger as any,
      );
      let result: any;
      for await (const m of executor.execute({
        cwd: f.dir,
        prompt: 'test',
        abortController: new AbortController(),
        model: 'unknown-before-init',
        sessionId: kind === 'new' ? undefined : id,
      }))
        if (m.type === 'result') result = m;
      expect(result.is_error).toBe(kind === 'failed');
      if (['no_history', 'unknown_model', 'failed'].includes(kind)) expect(result.tokenUsageKind).toBe('cumulative');
      else {
        expect(result.tokenUsageKind).toBe('context');
        expect(result.modelUsage[model]).toEqual({
          inputTokens: 1400,
          outputTokens: 60,
          contextWindow: kind === 'configured_window' ? 900000 : 1048576,
          costUSD: 0,
        });
      }
      if (kind === 'new') expect(result.duration_ms).toBe(244760400);
      else {
        expect(result.duration_ms).toBeGreaterThanOrEqual(0);
        expect(result.duration_ms).toBeLessThan(5000);
      }
    },
  );
});
