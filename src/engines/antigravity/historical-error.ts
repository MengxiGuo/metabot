import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AntigravityResult, AntigravityTranslatorState } from './jsonl-translator.js';

const INTERRUPTION = 'The stream was interrupted. Please continue the task you were working on.';
const normalizeError = (value: string): string => value.trim().replace(/^Error:\s*/, '');

/** Exact agy print-mode progress only; unknown stderr remains a recovery veto. */
export function hasDisqualifyingAntigravityStderr(stderr: string): boolean {
  return stderr
    .split(/\r?\n/)
    .some(
      (line) =>
        line !== '' &&
        !/^root agent idle; waiting (?:for \d+ background task\(s\) to finish|up to \S+ for \d+ background task\(s\))$/.test(
          line,
        ) &&
        !/^WaitForConversationFullyIdle: root agent idle but others running, starting timeout timer for \S+$/.test(
          line,
        ) &&
        !/^terminating \d+ daemon task\(s\) on exit$/.test(line),
    );
}

/** Only literal profile wrappers are supported. Never execute shell code or guess an account. */
function profileFromScript(source: string): string | undefined {
  const lines = source
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .filter((line) => /^\s*exec\s/.test(line));
  if (lines.length !== 1) return undefined;
  const flags = [...lines[0].matchAll(/(?:^|\s)--gemini_dir(?:=|\s+)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))/g)];
  if (flags.length !== 1) return undefined;
  const profile = flags[0][1] ?? flags[0][2] ?? flags[0][3];
  return isAbsolute(profile) && ![...profile].some((char) => char.charCodeAt(0) < 32) && !/[$`\\;|&<>]/.test(profile)
    ? profile
    : undefined;
}

/** Resolve the selected profile without executing the wrapper or reading credentials. */
export async function resolveAntigravityProfile(runner: string): Promise<string | undefined> {
  try {
    const wrapper = await open(runner, 'r');
    try {
      const stat = await wrapper.stat();
      if (!stat.isFile() || stat.size > 16_384) return undefined;
      const buffer = Buffer.alloc(16_385);
      const { bytesRead } = await wrapper.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16_384) return undefined;
      return profileFromScript(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await wrapper.close();
    }
  } catch {
    return undefined;
  }
}

export type HistoricalInterruptionReason =
  | 'verified'
  | 'session_mismatch'
  | 'not_historical_interruption'
  | 'stop_reason'
  | 'current_turn_error'
  | 'missing_user_step'
  | 'invalid_final_step'
  | 'terminal_text_mismatch'
  | 'stream_step_coverage_mismatch'
  | 'profile_unavailable'
  | 'history_file_bound'
  | 'history_line_bound'
  | 'history_json_invalid'
  | 'history_content_truncated'
  | 'history_step_order'
  | 'history_current_error'
  | 'history_unfinished_step'
  | 'completion_timestamp_invalid'
  | 'user_boundary_invalid'
  | 'subsequent_user_turn'
  | 'history_after_final_step'
  | 'response_content_invalid'
  | 'response_step_mismatch'
  | 'historical_error_missing'
  | 'user_boundary_missing'
  | 'final_text_mismatch'
  | 'response_step_missing'
  | 'background_task_unresolved'
  | 'final_step_missing'
  | 'history_changed'
  | 'history_timeout'
  | 'history_read_failed';
export interface HistoricalInterruptionVerification {
  verified: boolean;
  reason: HistoricalInterruptionReason;
}
const verdict = (reason: HistoricalInterruptionReason): HistoricalInterruptionVerification => ({
  verified: reason === 'verified',
  reason,
});

/**
 * Fail closed unless local provider history independently proves the terminal
 * interruption belongs to an older turn. No model request, replay, history
 * mutation or credential read. Called only after a clean process exit.
 */
export async function verifyHistoricalInterruptionDetailed(
  runner: string,
  resumedConversation: string | undefined,
  result: AntigravityResult,
  state: AntigravityTranslatorState,
): Promise<HistoricalInterruptionVerification> {
  const last = state.latestStep;
  const first = state.currentUserStep;
  if (
    !resumedConversation ||
    !/^[a-f0-9-]{36}$/i.test(resumedConversation) ||
    state.conversationId !== resumedConversation
  )
    return verdict('session_mismatch');
  if (result.status !== 'ERROR' || normalizeError(result.error ?? '') !== INTERRUPTION)
    return verdict('not_historical_interruption');
  if (result.finished_reason && result.finished_reason !== 'error') return verdict('stop_reason');
  if (state.currentTurnError) return verdict('current_turn_error');
  if (!Number.isInteger(first) || first === undefined) return verdict('missing_user_step');
  if (
    !Number.isInteger(last?.step_index) ||
    last!.step_index! <= first ||
    last?.step_type !== 'agent_response' ||
    last.state !== 'DONE'
  )
    return verdict('invalid_final_step');
  if (
    !state.finalStepText.trim() ||
    !state.lastAgentText.trim() ||
    result.response?.trim() !== state.lastAgentText.trim()
  )
    return verdict('terminal_text_mismatch');
  const expectedResponseSteps = new Map<number, string>();
  const streamedParts: string[] = [];
  for (const [idx, text] of state.responseSteps) {
    if (idx > first) {
      streamedParts.push(text);
      if (text.trim()) expectedResponseSteps.set(idx, text.trim());
    }
  }
  // Terminal fallback text is not independently evidenced by streamed step deltas.
  if (state.responseSteps.size && streamedParts.join('').trim() !== state.lastAgentText.trim())
    return verdict('stream_step_coverage_mismatch');
  if (!state.responseSteps.size && state.lastAgentText.trim() === state.finalStepText.trim())
    expectedResponseSteps.set(last.step_index!, state.finalStepText.trim());
  const matchedResponseSteps = new Set<number>();
  let timedOut = false;

  try {
    const profile = await resolveAntigravityProfile(runner);
    if (!profile) return verdict('profile_unavailable');
    const logs = join(profile, 'antigravity-cli', 'brain', resumedConversation, '.system_generated', 'logs');
    // The compact export truncates content, including final answers and completion
    // notices. Fall back only when the full export is absent, never when it is invalid.
    const file = await open(join(logs, 'transcript_full.jsonl'), 'r').catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      return open(join(logs, 'transcript.jsonl'), 'r');
    });
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 64 * 1024 * 1024) return verdict('history_file_bound');
      const stream = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      const timer = setTimeout(() => {
        timedOut = true;
        stream.destroy(new Error('History verification timeout'));
      }, 2000);
      let priorIndex = -1;
      let historicalMatch = false;
      let userBoundary = false;
      let finalMatch = false;
      const pendingTasks = new Set<string>();
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          if (Buffer.byteLength(line, 'utf8') > 4 * 1024 * 1024) return verdict('history_line_bound');
          let row;
          try {
            row = JSON.parse(line);
          } catch {
            return verdict('history_json_invalid');
          }
          if (!row || typeof row !== 'object') return verdict('history_json_invalid');
          if (Array.isArray(row.truncated_fields) && row.truncated_fields.includes('content'))
            return verdict('history_content_truncated');
          if (!Number.isInteger(row.step_index) || row.step_index <= priorIndex) return verdict('history_step_order');
          priorIndex = row.step_index;
          if (row.step_index < first) {
            if (
              row.type === 'ERROR_MESSAGE' &&
              typeof row.content === 'string' &&
              normalizeError(row.content) === INTERRUPTION
            )
              historicalMatch = true;
            continue;
          }
          if (row.type === 'ERROR_MESSAGE') return verdict('history_current_error');
          // A completed tool error can be handled by later model steps; it is
          // not a stream failure. Never apply this exception to the final step.
          const handledToolError =
            row.step_index > first &&
            row.step_index < last.step_index! &&
            row.type === 'GENERIC' &&
            row.source === 'MODEL' &&
            row.status === 'ERROR';
          if (row.status !== 'DONE' && !handledToolError) {
            // The exported transcript preserves the initial background snapshot.
            // Only a later provider SYSTEM completion for this exact task can close it.
            const task = `${resumedConversation}/task-${row.step_index}`;
            if (
              row.status !== 'RUNNING' ||
              row.type !== 'GENERIC' ||
              row.source !== 'MODEL' ||
              typeof row.content !== 'string' ||
              !row.content.includes(`\nTool is running as a background task with task id: ${task}\n`)
            )
              return verdict('history_unfinished_step');
            pendingTasks.add(task);
          }
          if (
            row.status === 'DONE' &&
            row.type === 'SYSTEM_MESSAGE' &&
            row.source === 'SYSTEM' &&
            typeof row.content === 'string'
          ) {
            const completion = row.content.match(
              /^The following is a <SYSTEM_MESSAGE>[^\n]*\n\n<SYSTEM_MESSAGE>\n\[Message\] timestamp=([^\s]+) sender=([^\s]+) priority=MESSAGE_PRIORITY_HIGH content=Task id "([^"]+)" finished with result:\n(?:The tool\x27s output was truncated due to being too long\.(?: You can find the full output in a file at [^\n]+\.)?\n\nHere is a preview with the middle of the output truncated:\n\n?)?Command exited with code (-?\d+)\.\n/,
            );
            if (completion && completion[2] === completion[3] && pendingTasks.has(completion[2])) {
              const finished = Date.parse(completion[1]);
              // Any integer exit code closes the task. This verifies transport
              // completion, not whether the command or research goal succeeded.
              if (!Number.isFinite(finished) || finished < state.startTime - 1000 || finished > Date.now())
                return verdict('completion_timestamp_invalid');
              pendingTasks.delete(completion[2]);
            }
          }
          if (row.step_index === first) {
            const created = Date.parse(row.created_at);
            if (
              row.type !== 'USER_INPUT' ||
              row.source !== 'USER_EXPLICIT' ||
              !Number.isFinite(created) ||
              created < state.startTime - 1000 ||
              created > Date.now()
            )
              return verdict('user_boundary_invalid');
            userBoundary = true;
          } else if (row.type === 'USER_INPUT') return verdict('subsequent_user_turn');
          if (row.step_index > last.step_index!) return verdict('history_after_final_step');
          if (row.step_index > first && row.type === 'PLANNER_RESPONSE' && row.source === 'MODEL') {
            // Tool-only planner entries omit content in agy's full export. This
            // exception is only for absent fields with no streamed text at that index.
            const content =
              !Object.prototype.hasOwnProperty.call(row, 'content') && !expectedResponseSteps.has(row.step_index)
                ? ''
                : row.content;
            if (typeof content !== 'string') return verdict('response_content_invalid');
            const actualTrimmed = content.trim();
            const expectedTrimmed = expectedResponseSteps.get(row.step_index) ?? '';
            if (actualTrimmed !== expectedTrimmed) return verdict('response_step_mismatch');
            if (actualTrimmed) matchedResponseSteps.add(row.step_index);
          }
          if (row.step_index === last.step_index) {
            finalMatch =
              row.type === 'PLANNER_RESPONSE' &&
              row.source === 'MODEL' &&
              typeof row.content === 'string' &&
              row.content.trim() === state.finalStepText.trim();
          }
        }
        const after = await file.stat();
        if (!historicalMatch) return verdict('historical_error_missing');
        if (!userBoundary) return verdict('user_boundary_missing');
        if (!finalMatch) return verdict('final_text_mismatch');
        if (matchedResponseSteps.size !== expectedResponseSteps.size) return verdict('response_step_missing');
        if (pendingTasks.size) return verdict('background_task_unresolved');
        if (priorIndex !== last.step_index) return verdict('final_step_missing');
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return verdict('history_changed');
        return verdict('verified');
      } finally {
        clearTimeout(timer);
        lines.close();
        stream.destroy();
      }
    } finally {
      await file.close();
    }
  } catch {
    // Unsupported/missing/malformed history leaves the original failure intact.
    return verdict(timedOut ? 'history_timeout' : 'history_read_failed');
  }
}

/** Compatibility API for callers that only need the boolean verdict. */
export async function verifyHistoricalInterruption(
  runner: string,
  resumedConversation: string | undefined,
  result: AntigravityResult,
  state: AntigravityTranslatorState,
): Promise<boolean> {
  return (await verifyHistoricalInterruptionDetailed(runner, resumedConversation, result, state)).verified;
}
