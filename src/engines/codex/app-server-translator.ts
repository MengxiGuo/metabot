import type { SDKMessage } from '../claude/executor.js';
import type { JsonRpcNotification } from './app-server-client.js';
import type { CodexGoal } from './goal.js';

export interface CodexAppServerTranslatorState {
  threadId?: string;
  lastAgentText: string;
  startTime: number;
  goalObservedAt?: number;
  model?: string;
  contextWindow?: number;
  lastUsage?: {
    inputTokens: number;
    outputTokens: number;
    contextWindow?: number;
  };
  quotaInfo?: SDKMessage['quotaInfo'];
  goal?: CodexGoal | null;
  currentTurnTokens?: number;
  streamedAgentItems: Set<string>;
  goalOperation?: {
    enabled: boolean;
    lastCompletedDurationMs?: number;
  };
}

export function createCodexAppServerTranslatorState(options: {
  model?: string;
  contextWindow?: number;
} = {}): CodexAppServerTranslatorState {
  return {
    lastAgentText: '',
    startTime: Date.now(),
    model: options.model,
    contextWindow: options.contextWindow,
    streamedAgentItems: new Set<string>(),
  };
}

export function translateCodexAppServerNotification(
  notification: JsonRpcNotification,
  state: CodexAppServerTranslatorState,
): SDKMessage[] {
  const params = notification.params ?? {};

  switch (notification.method) {
    case 'thread/started': {
      const threadId = readString(params.thread, 'id');
      if (!threadId) return [];
      state.threadId = threadId;
      return [{ type: 'system', subtype: 'init', session_id: threadId }];
    }

    case 'turn/started': {
      const progress = buildCodexAppServerGoalProgressMessage(state, 'turn started');
      return progress ? [progress] : [];
    }

    case 'thread/goal/updated': {
      const goal = readGoal(params.goal);
      if (!goal) return [];
      state.goal = goal;
      state.threadId = state.threadId ?? goal.threadId;
      state.currentTurnTokens = 0;
      state.goalObservedAt = Date.now();
      const progress = buildCodexAppServerGoalProgressMessage(state, `goal ${goal.status}`);
      if (state.goalOperation?.enabled && isTerminalGoalStatus(goal.status) && state.goalOperation.lastCompletedDurationMs !== undefined) {
        return [
          ...(progress ? [progress] : []),
          buildResultMessage(state, false, undefined, state.goalOperation.lastCompletedDurationMs),
        ];
      }
      return progress ? [progress] : [];
    }

    case 'thread/goal/cleared': {
      state.goal = null;
      state.currentTurnTokens = 0;
      if (state.goalOperation?.enabled && state.goalOperation.lastCompletedDurationMs !== undefined) {
        return [buildResultMessage(state, false, undefined, state.goalOperation.lastCompletedDurationMs)];
      }
      return [];
    }

    case 'item/started':
      return withGoalProgress(translateStartedItem(params, state), state, describeStartedItem(params));

    case 'item/agentMessage/delta':
      return translateAgentDelta(params, state);

    case 'item/completed':
      return withGoalProgress(translateCompletedItem(params, state), state, describeCompletedItem(params));

    case 'thread/tokenUsage/updated':
      captureTokenUsage(params, state);
      return withGoalProgress([], state, 'usage updated');

    case 'account/rateLimits/updated':
      captureQuota(params, state);
      return [];

    case 'turn/completed': {
      const durationMs = readNumber(params.turn, 'durationMs');
      if (state.goalOperation?.enabled) {
        state.goalOperation.lastCompletedDurationMs = durationMs;
        if (state.goal && !isTerminalGoalStatus(state.goal.status)) {
          const progress = buildCodexAppServerGoalProgressMessage(state, 'turn completed');
          return progress ? [progress] : [];
        }
      }
      return [buildResultMessage(state, false, undefined, readNumber(params.turn, 'durationMs'))];
    }

    case 'error': {
      const message = readErrorMessage(params.error) || 'Codex app-server turn failed';
      if (params.willRetry === true) {
        return [{ type: 'task_notification', session_id: state.threadId, result: message }];
      }
      return [buildResultMessage(state, true, message)];
    }

    default:
      return [];
  }
}

export function buildCodexAppServerGoalProgressMessage(
  state: CodexAppServerTranslatorState,
  lastEvent?: string,
): SDKMessage | null {
  if (!state.goal) return null;
  const elapsedSeconds = state.goal.status === 'active'
    ? Math.max(0, Math.round((Date.now() - (state.goalObservedAt ?? state.startTime)) / 1000))
    : 0;
  const currentTurnTokens = state.currentTurnTokens ?? 0;
  return {
    type: 'system',
    subtype: 'goal_progress',
    session_id: state.threadId ?? state.goal.threadId,
    goalProgress: {
      threadId: state.threadId ?? state.goal.threadId,
      objective: state.goal.objective,
      status: state.goal.status,
      tokenBudget: state.goal.tokenBudget,
      tokensUsed: state.goal.tokensUsed + currentTurnTokens,
      timeUsedSeconds: state.goal.timeUsedSeconds + elapsedSeconds,
      estimated: currentTurnTokens > 0 || elapsedSeconds > 0,
      lastEvent,
    },
  };
}

export function enableCodexAppServerGoalOperation(state: CodexAppServerTranslatorState): void {
  state.goalOperation = { enabled: true };
}

function isTerminalGoalStatus(status: string | undefined): boolean {
  return status === 'paused'
    || status === 'blocked'
    || status === 'usageLimited'
    || status === 'budgetLimited'
    || status === 'complete';
}

function withGoalProgress(
  messages: SDKMessage[],
  state: CodexAppServerTranslatorState,
  lastEvent?: string,
): SDKMessage[] {
  const progress = buildCodexAppServerGoalProgressMessage(state, lastEvent);
  return progress ? [...messages, progress] : messages;
}

function translateStartedItem(
  params: Record<string, unknown>,
  state: CodexAppServerTranslatorState,
): SDKMessage[] {
  const item = params.item;
  if (!isRecord(item)) return [];

  if (item.type === 'agentMessage') {
    return [{
      type: 'stream_event',
      session_id: state.threadId,
      event: {
        type: 'content_block_start',
        content_block: { type: 'text', text: '' },
      },
      parent_tool_use_id: null,
    }];
  }

  if (item.type === 'commandExecution') {
    const command = readString(item, 'command') || '';
    return [{
      type: 'assistant',
      session_id: state.threadId,
      message: {
        content: [{
          type: 'tool_use',
          id: readString(item, 'id'),
          name: 'Bash',
          input: { command },
        }],
      },
    }];
  }

  return [];
}

function translateAgentDelta(
  params: Record<string, unknown>,
  state: CodexAppServerTranslatorState,
): SDKMessage[] {
  const delta = typeof params.delta === 'string' ? params.delta : '';
  if (!delta) return [];
  const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
  if (itemId) state.streamedAgentItems.add(itemId);
  state.lastAgentText += delta;
  return [{
    type: 'stream_event',
    session_id: state.threadId,
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: delta },
    },
    parent_tool_use_id: null,
  }];
}

function translateCompletedItem(
  params: Record<string, unknown>,
  state: CodexAppServerTranslatorState,
): SDKMessage[] {
  const item = params.item;
  if (!isRecord(item)) return [];

  if (item.type === 'agentMessage') {
    const text = readString(item, 'text') || '';
    if (text) state.lastAgentText = text;
    return [{
      type: 'assistant',
      session_id: state.threadId,
      message: { content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    }];
  }

  if (item.type === 'commandExecution') {
    const output = readString(item, 'aggregatedOutput') || '';
    const exitCode = readNumber(item, 'exitCode');
    const text = exitCode !== undefined && exitCode !== 0
      ? `Exit code: ${exitCode}\n${output}`
      : output;
    return [{
      type: 'user',
      session_id: state.threadId,
      message: {
        content: [{
          type: 'tool_result',
          id: readString(item, 'id'),
          text,
        }],
      },
    }];
  }

  return [];
}

function describeStartedItem(params: Record<string, unknown>): string | undefined {
  const item = params.item;
  if (!isRecord(item)) return undefined;
  if (item.type === 'agentMessage') return 'drafting response';
  if (item.type === 'commandExecution') {
    const command = readString(item, 'command') || '';
    return command ? `running Bash: ${command}` : 'running Bash';
  }
  return undefined;
}

function describeCompletedItem(params: Record<string, unknown>): string | undefined {
  const item = params.item;
  if (!isRecord(item)) return undefined;
  if (item.type === 'agentMessage') return 'response updated';
  if (item.type === 'commandExecution') return 'Bash completed';
  return undefined;
}

function buildResultMessage(
  state: CodexAppServerTranslatorState,
  isError: boolean,
  errorMessage?: string,
  durationMs?: number,
): SDKMessage {
  const usage = state.lastUsage;
  const progress = buildCodexAppServerGoalProgressMessage(state, isError ? errorMessage : 'turn completed');
  const modelUsage = state.model
    ? {
        [state.model]: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          contextWindow: usage?.contextWindow ?? state.contextWindow ?? 0,
          costUSD: 0,
        },
      }
    : undefined;

  return {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    session_id: state.threadId,
    duration_ms: durationMs ?? Date.now() - state.startTime,
    result: state.lastAgentText,
    is_error: isError,
    errors: isError ? [errorMessage || 'Codex app-server execution failed'] : undefined,
    modelUsage,
    quotaInfo: state.quotaInfo,
    goalProgress: progress?.goalProgress,
  };
}

function captureTokenUsage(
  params: Record<string, unknown>,
  state: CodexAppServerTranslatorState,
): void {
  const tokenUsage = params.tokenUsage;
  if (!isRecord(tokenUsage)) return;
  const last = tokenUsage.last;
  if (!isRecord(last)) return;
  const inputTokens = readNumber(last, 'inputTokens');
  const outputTokens = readNumber(last, 'outputTokens');
  if (inputTokens === undefined || outputTokens === undefined) return;
  state.lastUsage = {
    inputTokens,
    outputTokens,
    contextWindow: readNumber(tokenUsage, 'modelContextWindow') ?? state.contextWindow,
  };
  state.currentTurnTokens = inputTokens + outputTokens;
}

function captureQuota(
  params: Record<string, unknown>,
  state: CodexAppServerTranslatorState,
): void {
  const rateLimits = params.rateLimits;
  if (!isRecord(rateLimits)) return;
  const primary = makeWindow(rateLimits.primary);
  if (!primary) return;
  const secondary = makeWindow(rateLimits.secondary);
  state.quotaInfo = {
    ...primary,
    ...(secondary ? { secondary } : {}),
  };
}

function readGoal(value: unknown): CodexGoal | undefined {
  if (!isRecord(value)) return undefined;
  const threadId = readString(value, 'threadId');
  const objective = readString(value, 'objective');
  const status = readString(value, 'status');
  const createdAt = readNumber(value, 'createdAt');
  const updatedAt = readNumber(value, 'updatedAt');
  if (!threadId || !objective || !status || createdAt === undefined || updatedAt === undefined) return undefined;
  return {
    threadId,
    objective,
    status: status as CodexGoal['status'],
    tokenBudget: readNullableNumber(value, 'tokenBudget'),
    tokensUsed: readNumber(value, 'tokensUsed') ?? 0,
    timeUsedSeconds: readNumber(value, 'timeUsedSeconds') ?? 0,
    createdAt,
    updatedAt,
  };
}

function makeWindow(raw: unknown): { usedPct: number; hoursToReset: number } | undefined {
  if (!isRecord(raw)) return undefined;
  const used = readNumber(raw, 'usedPercent');
  if (used === undefined) return undefined;
  const resetsAt = readNumber(raw, 'resetsAt');
  const hoursToReset = resetsAt ? Math.max(0, (resetsAt - Date.now() / 1000) / 3600) : 0;
  return {
    usedPct: Math.round(used * 10) / 10,
    hoursToReset: Math.round(hoursToReset * 10) / 10,
  };
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === 'string' ? v : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === 'number' ? v : undefined;
}

function readNullableNumber(value: unknown, key: string): number | null | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  if (v === null) return null;
  return typeof v === 'number' ? v : undefined;
}

function readErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (!isRecord(error)) return undefined;
  if (typeof error.message === 'string') return error.message;
  if (typeof error.kind === 'string') return error.kind;
  return JSON.stringify(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
