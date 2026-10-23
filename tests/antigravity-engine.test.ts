import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { webBotFromJson } from '../src/config.js';
import { createEngine } from '../src/engines/index.js';
import {
  AntigravityExecutor,
  buildAntigravityArgs,
  classifyAntigravityFailure,
} from '../src/engines/antigravity/executor.js';
import {
  createAntigravityTranslatorState,
  sanitizeAntigravityError,
  translateAntigravityJsonEvent,
} from '../src/engines/antigravity/jsonl-translator.js';
import { parseAntigravityModelList } from '../src/engines/antigravity/model-catalog.js';

describe('Antigravity engine', () => {
  it('loads bot configuration and registers the engine factory', () => {
    const config = webBotFromJson({
      name: 'antigravity-review',
      engine: 'antigravity',
      defaultWorkingDirectory: '/tmp/project',
      antigravity: { effort: 'high', sandbox: true },
    });
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    expect(config.antigravity).toMatchObject({ effort: 'high', sandbox: true });
    expect(createEngine(config, logger as any).name).toBe('antigravity');
  });

  it('builds safe headless argv and resumes the exact conversation', () => {
    expect(
      buildAntigravityArgs(
        { sandbox: true, effort: 'high', printTimeout: '20m', agent: 'code-reviewer' },
        'Review this diff.',
        'claude-sonnet-5.5-thinking',
        'conversation-123',
      ),
    ).toEqual([
      '--output-format',
      'stream-json',
      '--print-timeout',
      '20m',
      '--sandbox',
      '--model',
      'claude-sonnet-5.5-thinking',
      '--effort',
      'high',
      '--agent',
      'code-reviewer',
      '--conversation',
      'conversation-123',
      '-p',
      'Review this diff.',
    ]);
  });

  it('defaults to sandboxed execution and never enables permission bypass', () => {
    const args = buildAntigravityArgs({}, 'Inspect only.', undefined, undefined);
    expect(args).toContain('--sandbox');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(() =>
      buildAntigravityArgs({ extraArgs: ['--dangerously-skip-permissions'] }, 'Inspect only.', undefined, undefined),
    ).toThrow(/reserved or unsafe/);
    expect(() =>
      buildAntigravityArgs({ extraArgs: ['--gemini_dir=/tmp/other-account'] }, 'Inspect only.', undefined, undefined),
    ).toThrow(/reserved or unsafe/);
    expect(() =>
      buildAntigravityArgs({ extraArgs: ['--model=other-model'] }, 'Inspect only.', undefined, undefined),
    ).toThrow(/reserved or unsafe/);
  });

  it('uses explicit full-access mode instead of the terminal sandbox', () => {
    const args = buildAntigravityArgs(
      { sandbox: true, dangerouslySkipPermissions: true },
      'Inspect the repository.',
      'claude-opus-5-5-medium',
      undefined,
    );
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--sandbox');
  });

  it('translates init, text, tool, and result events without duplicating output', () => {
    const state = createAntigravityTranslatorState({ model: 'gemini-3.1-pro' });
    expect(
      translateAntigravityJsonEvent(
        {
          event: 'init',
          conversation_id: 'conversation-123',
          init: { model: 'gemini-3.1-pro' },
        },
        state,
      ),
    ).toMatchObject([{ type: 'system', session_id: 'conversation-123' }]);

    expect(
      translateAntigravityJsonEvent(
        {
          event: 'step_update',
          step_update: {
            conversation_id: 'conversation-123',
            step_index: 1,
            state: 'ACTIVE',
            step_type: 'agent_response',
            text_delta: 'Reviewing ',
          },
        },
        state,
      ),
    ).toEqual([]);
    const toolStart = translateAntigravityJsonEvent(
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conversation-123',
          step_index: 2,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: { parameters: { path: 'src/app.ts' } },
        },
      },
      state,
    );
    expect(toolStart).toHaveLength(2);
    expect(toolStart[0]).toMatchObject({ type: 'assistant' });
    expect(toolStart[1]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'antigravity_step_2', name: 'read_file' }] },
    });

    const toolDone = translateAntigravityJsonEvent(
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conversation-123',
          step_index: 2,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: { output: 'secret-looking provider output is not forwarded' },
        },
      },
      state,
    );
    expect(toolDone).toMatchObject([{ type: 'user' }]);

    translateAntigravityJsonEvent(
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conversation-123',
          step_index: 3,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'complete.',
        },
      },
      state,
    );
    const terminal = translateAntigravityJsonEvent(
      {
        event: 'result',
        result: {
          conversation_id: 'conversation-123',
          status: 'SUCCESS',
          response: 'Reviewing complete.',
          duration_seconds: 2.4,
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      },
      state,
    );
    expect(terminal).toHaveLength(2);
    expect(terminal[0]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'complete.' }] },
    });
    expect(terminal[1]).toMatchObject({
      type: 'result',
      subtype: 'success',
      session_id: 'conversation-123',
      duration_ms: 2400,
      is_error: false,
      result: 'Reviewing complete.',
    });
  });

  it('rejects a provider SUCCESS result with no final assistant response', () => {
    const state = createAntigravityTranslatorState({ model: 'claude-opus-5-5-medium' });
    const terminal = translateAntigravityJsonEvent(
      {
        event: 'result',
        result: {
          conversation_id: 'conversation-empty',
          status: 'SUCCESS',
          response: '',
          duration_seconds: 4.2,
        },
      },
      state,
    );
    expect(terminal).toEqual([
      expect.objectContaining({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: '',
        errors: [expect.stringContaining('without a final response')],
      }),
    ]);
  });

  it('classifies stderr without returning provider text', () => {
    expect(classifyAntigravityFailure('authentication required: https://example.invalid/secret')).toBe(
      'authentication_required',
    );
    expect(classifyAntigravityFailure('RESOURCE_EXHAUSTED quota')).toBe('quota_exhausted');
    expect(classifyAntigravityFailure('waiting for permission approval')).toBe('permission_blocked');
    expect(classifyAntigravityFailure('This account is not eligible; unavailable in your location')).toBe(
      'eligibility_or_location',
    );
    expect(classifyAntigravityFailure('unknown model: gemini-future')).toBe('model_unavailable');
    expect(
      sanitizeAntigravityError('OAuth code=abcdefghijklmnopqrstuvwxyz0123456789 at https://example.invalid/private'),
    ).toBe('OAuth code=<redacted> at <redacted-url>');
  });

  it('parses the exact account model catalog and ignores progress text', () => {
    expect(
      parseAntigravityModelList(
        [
          'Fetching available models...',
          'gemini-4-argon-low\tGemini 4 Argon (Low)',
          'claude-opus-5-5-low Claude Opus 5.5 (Low)',
          'gemini-4-argon-low\tduplicate',
          '',
        ].join('\n'),
      ),
    ).toEqual([
      { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
      { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
    ]);
  });

  it('attaches context and quota from the exact selected runner before emitting the result', async () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-antigravity-executor-'));
    const runner = path.join(fixtureDir, 'run-agy');
    fs.writeFileSync(
      runner,
      [
        '#!/bin/sh',
        'case " $* " in',
        '  *" /usage "*)',
        `    printf '%s\\n' '${JSON.stringify({
          status: 'SUCCESS',
          command: {
            name: 'usage',
            data: {
              groups: [
                {
                  name: 'Gemini 4 Argon',
                  buckets: [
                    {
                      id: 'gemini-argon-wtu-weekly',
                      window: 'weekly',
                      remaining_fraction: 0.95,
                      reset_time: '2099-01-01T00:00:00Z',
                    },
                  ],
                },
              ],
            },
          },
        })}'`,
        '    ;;',
        '  *)',
        `    printf '%s\\n' '${JSON.stringify({
          event: 'init',
          conversation_id: 'conversation-123',
          init: { model: 'gemini-4-argon-low' },
        })}'`,
        `    printf '%s\\n' '${JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'conversation-123',
            status: 'SUCCESS',
            response: 'OK',
            duration_seconds: 1.5,
            usage: { input_tokens: 20_000, output_tokens: 5 },
          },
        })}'`,
        '    ;;',
        'esac',
      ].join('\n'),
      { mode: 0o755 },
    );

    try {
      const executor = new AntigravityExecutor(
        {
          name: 'antigravity-test',
          engine: 'antigravity',
          antigravity: {
            model: 'gemini-4-argon-low',
            defaultAccount: 'primary',
            accounts: { primary: { runner } },
          },
        } as any,
        { debug() {}, info() {}, warn() {}, error() {} } as any,
      );
      const handle = executor.startExecution({
        prompt: 'Reply with OK',
        cwd: fixtureDir,
        abortController: new AbortController(),
      });
      const messages = [];
      for await (const message of handle.stream) messages.push(message);

      expect(messages.find((message) => message.type === 'result')).toMatchObject({
        subtype: 'success',
        quotaInfo: { usedPct: 5, label: '周' },
        modelUsage: {
          'gemini-4-argon-low': {
            inputTokens: 20_000,
            outputTokens: 5,
            contextWindow: 1_048_576,
          },
        },
      });
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
