import type { SDKMessage } from '../claude/executor.js';

export interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AntigravityStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  tool_name?: string;
  text_delta?: string;
  duration_seconds?: number;
  usage?: AntigravityUsage;
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
    output?: string;
  };
}

export interface AntigravityResult {
  conversation_id?: string;
  status?: string;
  finished_reason?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AntigravityUsage;
}

export interface AntigravityJsonEvent {
  event: string;
  conversation_id?: string;
  init?: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
    model?: string;
    agent?: string;
  };
  step_update?: AntigravityStepUpdate;
  result?: AntigravityResult;
}

export interface AntigravityTranslatorState {
  conversationId?: string;
  model?: string;
  contextWindow?: number;
  accumulatedDelta: string;
  lastAgentText: string;
  startTime: number;
  seenToolSteps: Set<number>;
  completedToolSteps: Set<number>;
  currentUserStep?: number;
  latestStep?: AntigravityStepUpdate;
  finalStepText: string;
  responseSteps: Map<number, string>;
  currentTurnError: boolean;
}

export function createAntigravityTranslatorState(
  options: {
    model?: string;
    contextWindow?: number;
  } = {},
): AntigravityTranslatorState {
  return {
    model: options.model,
    contextWindow: options.contextWindow,
    accumulatedDelta: '',
    lastAgentText: '',
    startTime: Date.now(),
    seenToolSteps: new Set<number>(),
    completedToolSteps: new Set<number>(),
    finalStepText: '',
    responseSteps: new Map<number, string>(),
    currentTurnError: false,
  };
}

export function sanitizeAntigravityError(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, '<redacted-url>')
    .replace(/\b(authorization|token|secret|code)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted-long-value>')
    .slice(0, 1000);
}

function flushText(state: AntigravityTranslatorState): SDKMessage[] {
  if (!state.accumulatedDelta) return [];
  const text = state.accumulatedDelta;
  state.accumulatedDelta = '';
  state.lastAgentText += text;
  return [
    {
      type: 'assistant',
      session_id: state.conversationId,
      message: { content: [{ type: 'text', text }] },
    },
  ];
}

function toolId(stepIndex: number): string {
  return `antigravity_step_${stepIndex}`;
}

function translateToolStep(update: AntigravityStepUpdate, state: AntigravityTranslatorState): SDKMessage[] {
  const stepIndex = update.step_index ?? -1;
  const messages = flushText(state);
  const id = toolId(stepIndex);

  if (!state.seenToolSteps.has(stepIndex)) {
    state.seenToolSteps.add(stepIndex);
    messages.push({
      type: 'assistant',
      session_id: state.conversationId,
      message: {
        content: [
          {
            type: 'tool_use',
            id,
            name: update.tool_name ?? update.tool_info?.name ?? 'unknown_tool',
            input: update.tool_info?.parameters ?? {},
          },
        ],
      },
    });
  }

  if (update.state === 'DONE' && !state.completedToolSteps.has(stepIndex)) {
    state.completedToolSteps.add(stepIndex);
    messages.push({
      type: 'user',
      session_id: state.conversationId,
      message: {
        content: [
          {
            type: 'tool_result',
            id,
            text: update.tool_info?.output ? '(completed; output captured by Antigravity)' : '(completed)',
          },
        ],
      },
    });
  }

  return messages;
}

export function translateAntigravityJsonEvent(
  event: AntigravityJsonEvent,
  state: AntigravityTranslatorState,
): SDKMessage[] {
  if (event.event === 'init') {
    state.conversationId = event.conversation_id ?? state.conversationId;
    state.model = event.init?.model ?? state.model;
    return state.conversationId ? [{ type: 'system', subtype: 'init', session_id: state.conversationId }] : [];
  }

  if (event.event === 'step_update' && event.step_update) {
    const update = event.step_update;
    state.conversationId = update.conversation_id ?? state.conversationId;
    // Recovery evidence is scoped to this invocation's user-input boundary.
    if (update.step_type === 'user_input' && Number.isInteger(update.step_index)) {
      state.currentUserStep = update.step_index;
    }
    if (update.step_type === 'error_message') state.currentTurnError = true;
    if (state.latestStep?.step_index !== update.step_index) state.finalStepText = '';
    state.latestStep = update;
    if (update.step_type === 'agent_response') {
      if (Number.isInteger(update.step_index) && update.text_delta) {
        state.responseSteps.set(
          update.step_index!,
          (state.responseSteps.get(update.step_index!) ?? '') + update.text_delta,
        );
      }
      state.finalStepText += update.text_delta ?? '';
      if (update.text_delta) state.accumulatedDelta += update.text_delta;
      return update.state === 'DONE' ? flushText(state) : [];
    }
    if (update.step_type === 'tool') {
      return translateToolStep(update, state);
    }
    return [];
  }

  if (event.event !== 'result' || !event.result) return [];

  const result = event.result;
  state.conversationId = result.conversation_id ?? event.conversation_id ?? state.conversationId;
  if (!state.accumulatedDelta && result.response) {
    if (!state.lastAgentText) {
      state.accumulatedDelta = result.response;
    } else if (result.response.startsWith(state.lastAgentText)) {
      state.accumulatedDelta = result.response.slice(state.lastAgentText.length);
    }
  }
  const messages = flushText(state);
  // A partial response can accompany SUCCESS. The CLI's explicit stop reason
  // is authoritative; never turn a timed-out or cancelled task into success.
  const stopReason = result.finished_reason;
  const providerSuccess = result.status === 'SUCCESS' && !stopReason;
  const hasFinalResponse = state.lastAgentText.trim().length > 0;
  const success = providerSuccess && hasFinalResponse;
  const inputTokens = result.usage?.input_tokens ?? 0;
  const outputTokens = result.usage?.output_tokens ?? 0;
  const modelUsage = state.model
    ? {
        [state.model]: {
          inputTokens,
          outputTokens,
          contextWindow: state.contextWindow ?? 0,
          costUSD: 0,
        },
      }
    : undefined;

  messages.push({
    type: 'result',
    subtype: success ? 'success' : stopReason === 'interrupted' ? 'error_cancelled' : 'error_during_execution',
    session_id: state.conversationId,
    duration_ms:
      typeof result.duration_seconds === 'number'
        ? Math.round(result.duration_seconds * 1000)
        : Date.now() - state.startTime,
    result: state.lastAgentText,
    is_error: !success,
    errors: success
      ? undefined
      : [
          sanitizeAntigravityError(
            stopReason === 'print_timeout'
              ? 'Antigravity reached its configured print timeout. The response is partial and the task is incomplete.'
              : stopReason === 'interrupted'
                ? 'Antigravity execution was interrupted. The response may be partial.'
                : providerSuccess && !hasFinalResponse
                  ? 'Antigravity reported success without a final response. The requested task may be incomplete.'
                  : result.error ||
                    `Antigravity ended with status ${result.status ?? 'UNKNOWN'}${stopReason ? ` (${stopReason})` : ''}`,
          ),
        ],
    tokenUsageKind: 'cumulative',
    modelUsage,
  });
  return messages;
}
