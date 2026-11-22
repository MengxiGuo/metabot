import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AntigravityExecutor } from '../src/engines/antigravity/executor.js';
import {
  hasDisqualifyingAntigravityStderr,
  verifyHistoricalInterruption,
  verifyHistoricalInterruptionDetailed,
} from '../src/engines/antigravity/historical-error.js';
import {
  createAntigravityTranslatorState,
  translateAntigravityJsonEvent,
} from '../src/engines/antigravity/jsonl-translator.js';

vi.mock('../src/engines/antigravity/quota-reader.js', () => ({
  fetchAntigravityQuota: vi.fn(async () => undefined),
  resolveAntigravityContextWindow: vi.fn(() => undefined),
}));

const id = '00000000-0000-4000-8000-000000000001';
const error = 'The stream was interrupted. Please continue the task you were working on.';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agy-history-'));
  dirs.push(dir);
  const runner = join(dir, 'runner');
  writeFileSync(runner, `#!/bin/sh\nexec /bin/true --gemini_dir='${dir}' "$@"\n`, { mode: 0o755 });
  const history = join(dir, 'antigravity-cli', 'brain', id, '.system_generated/logs/transcript.jsonl');
  mkdirSync(dirname(history), { recursive: true });
  const rows = [
    { step_index: 334, type: 'ERROR_MESSAGE', status: 'DONE', content: 'Error: ' + error },
    {
      step_index: 338,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      status: 'DONE',
      created_at: new Date().toISOString(),
    },
    { step_index: 348, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'Finished.' },
  ];
  const save = () => writeFileSync(history, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  save();
  const events = [
    { event: 'init', conversation_id: id },
    { event: 'step_update', step_update: { step_index: 338, step_type: 'user_input', state: 'DONE' } },
    {
      event: 'step_update',
      step_update: { step_index: 348, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Finished.' },
    },
    { event: 'step_update', step_update: { step_index: 348, step_type: 'agent_response', state: 'DONE' } },
  ];
  const state = createAntigravityTranslatorState();
  for (const event of events) translateAntigravityJsonEvent(event, state);
  const result = { conversation_id: id, status: 'ERROR', finished_reason: 'error', response: 'Finished.', error };
  return { dir, runner, history, rows, save, events, state, result };
}

describe('prior-turn Antigravity interruption recovery', () => {
  it.each([
    ['', false],
    ['\r\n', false],
    ['root agent idle; waiting for 1 background task(s) to finish\n', false],
    ['root agent idle; waiting up to 2m0s for 2 background task(s)\r\n', false],
    ['WaitForConversationFullyIdle: root agent idle but others running, starting timeout timer for 5s', false],
    ['terminating 1 daemon task(s) on exit\n', false],
    ['upstream failed\n', true],
    ['terminating 1 background task(s) on exit\n', true],
    ['prefix terminating 1 daemon task(s) on exit', true],
    ['terminating 1 daemon task(s) on exit suffix', true],
    ['terminating 1 daemon task(s) on exit\nupstream failed\n', true],
    [' ', true],
  ])('stderr whitelist %j => disqualifying=%s', (stderr, expected) => {
    expect(hasDisqualifyingAntigravityStderr(stderr as string)).toBe(expected);
  });
  it.each(['valid', 'tampered', 'missing', 'reordered', 'terminal_only', 'empty_stream', 'wrong_final'])(
    'independently verifies every response segment: %s',
    async (kind) => {
      const f = fixture();
      const first = 'First segment.\n';
      const second = 'Second segment.\n';
      f.state.responseSteps = new Map([
        [340, first],
        [342, second],
        [348, f.state.finalStepText],
      ]);
      f.state.lastAgentText = first + second + f.state.finalStepText;
      f.result.response = f.state.lastAgentText;
      const rows = [
        f.rows[0],
        f.rows[1],
        { step_index: 340, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: first },
        { step_index: 342, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: second },
        f.rows[2],
      ];
      if (kind === 'tampered') rows[2].content = 'tampered';
      if (kind === 'missing') rows.splice(2, 1);
      if (kind === 'reordered') {
        rows[2].content = second;
        rows[3].content = first;
      }
      if (kind === 'terminal_only') f.result.response = f.state.finalStepText;
      if (kind === 'empty_stream') f.state.lastAgentText = '';
      if (kind === 'wrong_final') f.state.finalStepText = 'different';
      writeFileSync(f.history, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      expect(await verifyHistoricalInterruption(f.runner, id, f.result, f.state)).toBe(kind === 'valid');
    },
  );
  it.each([
    ['valid', 'verified'],
    ['tampered', 'response_step_mismatch'],
    ['missing', 'response_step_missing'],
    ['extra', 'response_step_mismatch'],
    ['missing_content', 'response_content_invalid'],
    ['terminal_suffix', 'stream_step_coverage_mismatch'],
    ['interior_whitespace', 'response_step_mismatch'],
    ['wrong_index', 'response_step_mismatch'],
  ])('verifies real streamed segment newlines and rejects %s', async (kind, reason) => {
    const f = fixture();
    const state = createAntigravityTranslatorState();
    for (const event of [
      ...f.events.slice(0, 2),
      {
        event: 'step_update',
        step_update: { step_index: 340, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Inter' },
      },
      {
        event: 'step_update',
        step_update: { step_index: 340, step_type: 'agent_response', state: 'DONE', text_delta: 'im.\n' },
      },
      {
        event: 'step_update',
        step_update: { step_index: 348, step_type: 'agent_response', state: 'DONE', text_delta: 'Final.\n' },
      },
    ])
      translateAntigravityJsonEvent(event, state);
    const response = 'Interim.\nFinal.' + (kind === 'terminal_suffix' ? '\nUNSTREAMED' : '');
    const result = { ...f.result, response };
    if (kind === 'terminal_suffix') state.lastAgentText = response;
    translateAntigravityJsonEvent({ event: 'result', result }, state);
    expect(state.responseSteps).toEqual(
      new Map([
        [340, 'Interim.\n'],
        [348, 'Final.\n'],
      ]),
    );
    const rows = [
      f.rows[0],
      f.rows[1],
      { step_index: 340, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'Interim.' },
      { ...f.rows[2], content: 'Final.' },
    ];
    if (kind === 'tampered') rows[2].content = 'Tampered.';
    if (kind === 'interior_whitespace') rows[2].content = 'Inter im.';
    if (kind === 'wrong_index') rows[2].step_index = 341;
    if (kind === 'missing') rows.splice(2, 1);
    if (kind === 'extra') rows.splice(3, 0, { ...rows[2], step_index: 342, content: 'Unexpected.' });
    if (kind === 'missing_content') delete rows[2].content;
    writeFileSync(
      join(dirname(f.history), 'transcript_full.jsonl'),
      rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
    expect(await verifyHistoricalInterruptionDetailed(f.runner, id, result, state)).toEqual({
      verified: kind === 'valid',
      reason,
    });
  });
  it.each(['absent', 'empty', 'null', 'object'])(
    'permits tool-only planner content omission, not arbitrary types: %s',
    async (kind) => {
      const f = fixture();
      const row: Record<string, unknown> = {
        step_index: 340,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
      };
      if (kind !== 'absent') row.content = kind === 'empty' ? '' : kind === 'null' ? null : {};
      writeFileSync(f.history, [f.rows[0], f.rows[1], row, f.rows[2]].map((x) => JSON.stringify(x)).join('\n') + '\n');
      expect(await verifyHistoricalInterruption(f.runner, id, f.result, f.state)).toBe(
        ['absent', 'empty'].includes(kind),
      );
    },
  );
  it('keeps only the single-segment compatibility fallback for empty synthetic maps', async () => {
    const f = fixture();
    f.state.responseSteps.clear();
    expect(await verifyHistoricalInterruption(f.runner, id, f.result, f.state)).toBe(true);
    f.state.lastAgentText = f.result.response = 'Unproven intermediate.\nFinished.';
    expect(await verifyHistoricalInterruption(f.runner, id, f.result, f.state)).toBe(false);
  });
  it('logs bounded diagnostic codes rather than exception contents', async () => {
    const f = fixture();
    writeFileSync(f.history, '{"private_path":"/secret",invalid');
    expect(await verifyHistoricalInterruptionDetailed(f.runner, id, f.result, f.state)).toEqual({
      verified: false,
      reason: 'history_json_invalid',
    });
    rmSync(f.history);
    expect(await verifyHistoricalInterruptionDetailed(f.runner, id, f.result, f.state)).toEqual({
      verified: false,
      reason: 'history_read_failed',
    });
  });
  it.each([
    'resolved',
    'truncated',
    'truncated_file',
    'bad_truncation',
    'missing',
    'failed',
    'negative_exit',
    'invalid_exit',
    'wrong_task',
    'tool_output',
    'old_completion',
    'future_completion',
  ])('checks exported RUNNING background snapshots against SYSTEM completion: %s', async (kind) => {
    const f = fixture();
    const task = `${id}/task-340`;
    const stamp =
      kind === 'old_completion'
        ? '2020-01-01T00:00:00Z'
        : kind === 'future_completion'
          ? '2099-01-01T00:00:00Z'
          : new Date().toISOString();
    const truncation = kind.startsWith('truncated')
      ? "The tool's output was truncated due to being too long." +
        (kind === 'truncated_file' ? ' You can find the full output in a file at file:///tmp/output.txt.' : '') +
        '\n\nHere is a preview with the middle of the output truncated:\n\n'
      : kind === 'bad_truncation'
        ? 'Some arbitrary output header\n'
        : '';
    const namedTask = kind === 'wrong_task' ? `${id}/task-341` : task;
    const rows = [
      f.rows[0],
      f.rows[1],
      {
        step_index: 340,
        type: 'GENERIC',
        source: 'MODEL',
        status: 'RUNNING',
        content: `Created At: ${stamp}\nTool is running as a background task with task id: ${task}\nTask Description: inspect`,
      },
      ...(kind === 'missing'
        ? []
        : [
            {
              step_index: 345,
              type: kind === 'tool_output' ? 'GENERIC' : 'SYSTEM_MESSAGE',
              source: kind === 'tool_output' ? 'MODEL' : 'SYSTEM',
              status: 'DONE',
              content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${stamp} sender=${namedTask} priority=MESSAGE_PRIORITY_HIGH content=Task id "${namedTask}" finished with result:\n${truncation}Command exited with code ${kind === 'failed' ? 1 : kind === 'negative_exit' ? -1 : kind === 'invalid_exit' ? 'unknown' : 0}.\n\nCommand output:\nexample\n</SYSTEM_MESSAGE>`,
            },
          ]),
      f.rows[2],
    ];
    writeFileSync(f.history, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    expect(await verifyHistoricalInterruption(f.runner, id, f.result, f.state)).toBe(
      ['resolved', 'failed', 'negative_exit', 'truncated', 'truncated_file'].includes(kind),
    );
  });
  it.each(['error', undefined])('allows the historical-error terminal reason %s', async (reason) => {
    const f = fixture();
    expect(await verifyHistoricalInterruption(f.runner, id, { ...f.result, finished_reason: reason }, f.state)).toBe(
      true,
    );
  });
  it.each(['handled_tool', 'system_error', 'model_error_message', 'wrong_source', 'final_error', 'unfinished_tool'])(
    'distinguishes intermediate tool errors from stream failures: %s',
    async (kind) => {
      const f = fixture();
      const intermediate = {
        step_index: 340,
        source: kind === 'wrong_source' ? 'SYSTEM' : 'MODEL',
        type: kind === 'system_error' || kind === 'model_error_message' ? 'ERROR_MESSAGE' : 'GENERIC',
        status: kind === 'unfinished_tool' ? 'RUNNING' : 'ERROR',
        content: 'tool failed',
      };
      if (kind === 'system_error') intermediate.source = 'SYSTEM';
      const final = { ...f.rows[2], ...(kind === 'final_error' ? { type: 'GENERIC', status: 'ERROR' } : {}) };
      writeFileSync(
        f.history,
        [f.rows[0], f.rows[1], intermediate, final].map((row) => JSON.stringify(row)).join('\n') + '\n',
      );
      expect(await verifyHistoricalInterruption(f.runner, id, f.result, f.state)).toBe(kind === 'handled_tool');
    },
  );
  it.each([
    'prefer_full',
    'fallback_truncated',
    'full_invalid',
    'full_directory',
    'full_truncated',
    'long_full',
    'oversized_line',
  ])('uses full history and fails closed on invalid or truncated evidence: %s', async (kind) => {
    const f = fixture();
    const full = join(dirname(f.history), 'transcript_full.jsonl');
    const content =
      kind === 'long_full'
        ? 'x'.repeat(600_000)
        : kind === 'oversized_line'
          ? 'x'.repeat(4 * 1024 * 1024 + 1)
          : 'Finished.';
    f.state.finalStepText = content;
    f.state.lastAgentText = content;
    f.state.responseSteps.set(348, content);
    f.result.response = content;
    const rows = [f.rows[0], f.rows[1], { ...f.rows[2], content }];
    const compact = [
      f.rows[0],
      f.rows[1],
      { ...f.rows[2], content: '<truncated 100 bytes>', truncated_fields: ['content'] },
    ];
    writeFileSync(f.history, compact.map((row) => JSON.stringify(row)).join('\n') + '\n');
    if (kind === 'full_directory') mkdirSync(full);
    else if (kind !== 'fallback_truncated')
      writeFileSync(
        full,
        kind === 'full_invalid'
          ? '{'
          : (kind === 'full_truncated' ? compact : rows).map((row) => JSON.stringify(row)).join('\n') + '\n',
      );
    expect(await verifyHistoricalInterruption(f.runner, id, f.result, f.state)).toBe(
      ['prefer_full', 'long_full'].includes(kind),
    );
  });
  it('requires independent history evidence in addition to a completed response', async () => {
    const f = fixture();
    expect(await verifyHistoricalInterruption(f.runner, id, f.result, f.state)).toBe(true);
    f.rows.shift();
    f.save();
    expect(await verifyHistoricalInterruption(f.runner, id, f.result, f.state)).toBe(false);
  });
  it.each(['print_timeout', 'interrupted', 'unknown'])('preserves explicit stop reason %s', async (reason) => {
    const f = fixture();
    expect(await verifyHistoricalInterruption(f.runner, id, { ...f.result, finished_reason: reason }, f.state)).toBe(
      false,
    );
  });
  it.each([
    'error',
    'unfinished',
    'later_tool',
    'next_turn',
    'old_boundary',
    'wrong_text',
    'wrong_error',
    'invalid_json',
    'missing_file',
  ])('fails closed on %s', async (kind) => {
    const f = fixture();
    if (kind === 'error') f.rows[2].type = 'ERROR_MESSAGE';
    if (kind === 'unfinished') f.rows[2].status = 'ACTIVE';
    if (kind === 'later_tool') f.rows.push({ ...f.rows[2], step_index: 349, type: 'GENERIC' });
    if (kind === 'next_turn') f.rows[2].type = 'USER_INPUT';
    if (kind === 'old_boundary') f.rows[1].created_at = '2020-01-01T00:00:00Z';
    if (kind === 'wrong_text') f.rows[2].content = 'Something else';
    if (kind === 'wrong_error') f.result.error = 'permission denied';
    f.save();
    if (kind === 'invalid_json') writeFileSync(f.history, '{');
    if (kind === 'missing_file') rmSync(f.history);
    expect(await verifyHistoricalInterruption(f.runner, id, f.result, f.state)).toBe(false);
  });
  it('rejects a current error event even when text later completes', async () => {
    const f = fixture();
    f.state.currentTurnError = true;
    expect(await verifyHistoricalInterruption(f.runner, id, f.result, f.state)).toBe(false);
  });
  it('rejects an unfinished or later tool step and a mismatched session', async () => {
    const f = fixture();
    expect(
      await verifyHistoricalInterruption(f.runner, '00000000-0000-0000-0000-000000000000', f.result, f.state),
    ).toBe(false);
    translateAntigravityJsonEvent(
      { event: 'step_update', step_update: { step_index: 349, step_type: 'tool', state: 'ACTIVE' } },
      f.state,
    );
    expect(await verifyHistoricalInterruption(f.runner, id, f.result, f.state)).toBe(false);
  });
  it.each([
    'clean',
    'multi_segment',
    'progress_stderr',
    'background_stderr',
    'overflow_stderr',
    'nonzero',
    'stderr',
    'malformed',
    'timeout',
    'current_error',
    'cancelled',
  ])('executor handles %s without replaying work', async (kind) => {
    const f = fixture();
    const executable = join(f.dir, 'emit');
    if (kind === 'multi_segment') {
      const content = 'Interim.\n';
      f.rows.splice(2, 0, {
        step_index: 340,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        content: content.trim(),
      });
      f.rows[3].content = 'Final.';
      f.save();
      f.events.splice(2, 0, {
        event: 'step_update',
        step_update: {
          step_index: 340,
          step_type: 'agent_response',
          state: 'DONE',
          text_delta: content,
        },
      });
      f.events[3].step_update!.text_delta = 'Final.\n';
      f.result.response = content + 'Final.';
    }
    const stderrText =
      kind === 'progress_stderr'
        ? 'root agent idle; waiting for 1 background task(s) to finish\n'
        : kind === 'background_stderr'
          ? 'terminating 1 background task(s) on exit\n'
          : kind === 'overflow_stderr'
            ? 'upstream failed\n' + '\n'.repeat(32_768)
            : kind === 'stderr'
              ? 'upstream failed\n'
              : '';
    const events = [
      ...f.events,
      {
        event: 'result',
        result: {
          ...f.result,
          ...(kind === 'timeout' ? { finished_reason: 'print_timeout' } : {}),
        },
      },
    ];
    const lines = events.map((event) => JSON.stringify(event));
    if (kind === 'current_error')
      lines.splice(
        2,
        0,
        JSON.stringify({
          event: 'step_update',
          step_update: { step_index: 340, step_type: 'error_message', state: 'DONE' },
        }),
      );
    if (kind === 'malformed') lines.splice(2, 0, '{malformed');
    writeFileSync(
      executable,
      "#!/bin/sh\ncat <<'EVENTS'\n" +
        lines.join('\n') +
        '\nEVENTS\n' +
        (stderrText ? "cat >&2 <<'STDERR'\n" + stderrText + 'STDERR\n' : '') +
        (kind === 'cancelled' ? 'sleep 0.2\n' : '') +
        `exit ${kind === 'nonzero' ? 1 : 0}\n`,
      { mode: 0o755 },
    );
    writeFileSync(f.runner, `#!/bin/sh\nexec '${executable}' --gemini_dir='${f.dir}' "$@"\n`);
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const executor = new AntigravityExecutor(
      { name: 'test', engine: 'antigravity', antigravity: { executable: f.runner } } as any,
      logger as any,
    );
    const messages = [];
    const controller = new AbortController();
    for await (const msg of executor.execute({
      cwd: f.dir,
      prompt: 'hi',
      sessionId: id,
      abortController: controller,
    })) {
      messages.push(msg);
      if (kind === 'cancelled' && msg.type === 'assistant') controller.abort();
    }
    const results = messages.filter((msg) => msg.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].is_error).toBe(!['clean', 'multi_segment', 'progress_stderr'].includes(kind));
    expect(results[0].result.trim()).toBe(f.result.response.trim());
    if (['clean', 'multi_segment', 'progress_stderr'].includes(kind)) expect(results[0].errors).toBeUndefined();
    const evidence = logger.info.mock.calls.find(([entry]) => entry.historicalErrorRecoveryEvidence)?.[0];
    expect(evidence).toBeDefined();
    expect(evidence.verificationReason).toBe(
      ['clean', 'multi_segment', 'progress_stderr'].includes(kind)
        ? 'verified'
        : kind === 'timeout'
          ? 'stop_reason'
          : kind === 'current_error'
            ? 'current_turn_error'
            : 'process_ineligible',
    );
    expect(evidence.multiResponseTurn).toBe(kind === 'multi_segment');
    expect(evidence.disqualifyingStderr).toBe(['stderr', 'background_stderr', 'overflow_stderr'].includes(kind));
    expect(evidence.stderrTruncated).toBe(kind === 'overflow_stderr');
  });
});
