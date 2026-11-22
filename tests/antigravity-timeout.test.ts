import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AntigravityExecutor, classifyAntigravityFailure } from '../src/engines/antigravity/executor.js';
import {
  createAntigravityTranslatorState,
  translateAntigravityJsonEvent,
} from '../src/engines/antigravity/jsonl-translator.js';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';
import { buildCard } from '../src/feishu/card-builder.js';

const oldError = 'API error (attempt 2): request failed: stream idle timeout (5m0s): context deadline exceeded';
describe('Antigravity timeout and usage contract', () => {
  it.each(['SUCCESS', 'ERROR'])(
    'keeps a %s partial print timeout failed and does not blame an old stream error',
    (status) => {
      const messages = translateAntigravityJsonEvent(
        {
          event: 'result',
          result: {
            status,
            finished_reason: 'print_timeout',
            response: 'Still checking.',
            error: oldError,
          },
        },
        createAntigravityTranslatorState(),
      );
      expect(messages.at(-1)).toMatchObject({ is_error: true, result: 'Still checking.' });
      expect(messages.at(-1)?.errors?.[0]).toMatch(/configured print timeout/);
      expect(messages.at(-1)?.errors?.[0]).not.toContain('attempt 2');
    },
  );
  it('preserves interruption even if SUCCESS was reported', () => {
    const messages = translateAntigravityJsonEvent(
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          finished_reason: 'interrupted',
          response: 'Partial',
        },
      },
      createAntigravityTranslatorState(),
    );
    expect(messages.at(-1)).toMatchObject({ is_error: true, subtype: 'error_cancelled' });
  });
  it('never infers recovery from text alone when the provider says ERROR', () => {
    const messages = translateAntigravityJsonEvent(
      {
        event: 'result',
        result: {
          status: 'ERROR',
          response: '你好',
          error: oldError,
        },
      },
      createAntigravityTranslatorState(),
    );
    expect(messages.at(-1)).toMatchObject({ is_error: true, errors: [oldError] });
  });
  it('publishes a completed assistant step before terminal result without duplicating it', () => {
    const state = createAntigravityTranslatorState();
    translateAntigravityJsonEvent(
      {
        event: 'step_update',
        step_update: {
          step_type: 'agent_response',
          state: 'ACTIVE',
          text_delta: 'OK',
        },
      },
      state,
    );
    const done = translateAntigravityJsonEvent(
      {
        event: 'step_update',
        step_update: {
          step_type: 'agent_response',
          state: 'DONE',
        },
      },
      state,
    );
    expect(done).toHaveLength(1);
    expect(done[0].type).toBe('assistant');
    const result = translateAntigravityJsonEvent(
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'OK',
        },
      },
      state,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'result', is_error: false, result: 'OK' });
  });
  it('renders cumulative usage without claiming a context overflow', () => {
    const processor = new StreamProcessor('hello');
    const messages = translateAntigravityJsonEvent(
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'OK',
          usage: { input_tokens: 1_245_000, output_tokens: 20 },
        },
      },
      createAntigravityTranslatorState({ model: 'gemini-4-argon-low', contextWindow: 1_048_576 }),
    );
    let card = '';
    for (const message of messages) card = buildCard(processor.processMessage(message));
    expect(card).toContain('累计 tokens: 1245.0k');
    expect(card).not.toContain('119%');
    expect(card).not.toContain('ctx:');
  });
  it('keeps explicit context usage for other engines', () => {
    const card = buildCard({
      status: 'complete',
      userPrompt: 'hi',
      responseText: 'OK',
      toolCalls: [],
      totalTokens: 20_000,
      contextWindow: 100_000,
    });
    expect(card).toContain('ctx: 20.0k/100k (20%)');
  });
  it('classifies timeout evidence independently from authentication and permission log chatter', () => {
    expect(classifyAntigravityFailure('authentication initialized; ' + oldError)).toBe('stream_idle_timeout');
    expect(classifyAntigravityFailure(oldError + '\nprint timeout after 20m0s')).toBe('print_timeout');
  });
  it('rejects a success payload followed by a nonzero process exit and does not replay it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-timeout-test-'));
    const runner = path.join(dir, 'runner');
    const event = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Partial' } });
    fs.writeFileSync(
      runner,
      "#!/bin/sh\nprintf '%s\\n' '" + event + "'\nprintf 'print timeout after 20m0s\\n' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    try {
      const executor = new AntigravityExecutor(
        { name: 'test', engine: 'antigravity', antigravity: { executable: runner } } as any,
        { debug() {}, info() {}, warn() {}, error() {} } as any,
      );
      const messages = [];
      for await (const msg of executor.execute({ cwd: dir, prompt: 'hi', abortController: new AbortController() }))
        messages.push(msg);
      expect(messages.at(-1)).toMatchObject({
        is_error: true,
        antigravityFailure: { safeToRetry: false, quotaExhausted: false },
      });
      expect(messages.at(-1)?.errors?.[0]).toContain('print timeout');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
