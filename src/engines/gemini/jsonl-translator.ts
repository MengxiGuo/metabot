import type { SDKMessage } from '../claude/executor.js';

export interface GeminiTranslatorState {
  sessionId?: string;
  lastAgentText: string;
  accumulatedDelta: string;
  startTime: number;
  model?: string;
  contextWindow?: number;
}

export interface GeminiJsonEvent {
  type: string;
  timestamp?: string;
  session_id?: string;
  model?: string;
  role?: 'user' | 'assistant' | 'system';
  content?: string;
  delta?: boolean;
  tool_name?: string;
  tool_id?: string;
  parameters?: Record<string, unknown>;
  status?: string;
  stats?: GeminiStats;
  error?: { message?: string } | string;
  message?: string;
}

export interface GeminiStats {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached?: number;
  input?: number;
  duration_ms?: number;
  tool_calls?: number;
  models?: Record<string, {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    input?: number;
  }>;
}

export function createGeminiTranslatorState(options: {
  model?: string;
  contextWindow?: number;
} = {}): GeminiTranslatorState {
  return {
    lastAgentText: '',
    accumulatedDelta: '',
    startTime: Date.now(),
    model: options.model,
    contextWindow: options.contextWindow,
  };
}

/**
 * Map a known gemini-cli internal tool name to a Claude-equivalent display name.
 * Falls back to the original name if unknown.
 */
function mapToolName(name: string): string {
  switch (name) {
    case 'read_file': return 'Read';
    case 'write_file': return 'Write';
    case 'replace': case 'edit': return 'Edit';
    case 'list_directory': return 'LS';
    case 'glob': case 'find_files': return 'Glob';
    case 'search_file_content': case 'grep': return 'Grep';
    case 'run_shell_command': case 'shell': return 'Bash';
    case 'google_web_search': case 'web_search': return 'WebSearch';
    case 'web_fetch': return 'WebFetch';
    case 'save_memory': return 'Memory';
    default: return name;
  }
}

/**
 * Flush accumulated delta text as an assistant message. Returns [] if nothing pending.
 * Resets accumulatedDelta. Caller decides when to flush (before tool calls, on result, etc.).
 */
function flushAccumulatedText(state: GeminiTranslatorState): SDKMessage[] {
  if (!state.accumulatedDelta) return [];
  const text = state.accumulatedDelta;
  state.lastAgentText = text;
  state.accumulatedDelta = '';
  return [{
    type: 'assistant',
    session_id: state.sessionId,
    message: { content: [{ type: 'text', text }] },
  }];
}

export function translateGeminiJsonEvent(
  event: GeminiJsonEvent,
  state: GeminiTranslatorState,
): SDKMessage[] {
  switch (event.type) {
    case 'init': {
      if (event.session_id) state.sessionId = event.session_id;
      if (event.model) state.model = event.model;
      return state.sessionId
        ? [{ type: 'system', subtype: 'init', session_id: state.sessionId }]
        : [];
    }

    case 'message': {
      // Skip the echoed user prompt (gemini-cli echoes it as a 'message' event with role=user).
      if (event.role === 'user' || event.role === 'system') return [];
      if (event.role !== 'assistant') return [];
      const chunk = typeof event.content === 'string' ? event.content : '';
      if (!chunk) return [];
      state.accumulatedDelta += chunk;
      return []; // hold until tool call or result; emit as single assistant message then
    }

    case 'tool_use': {
      const flushed = flushAccumulatedText(state);
      const toolName = mapToolName(event.tool_name ?? 'unknown_tool');
      return [
        ...flushed,
        {
          type: 'assistant',
          session_id: state.sessionId,
          message: {
            content: [{
              type: 'tool_use',
              id: event.tool_id ?? `gemini_tool_${Date.now()}`,
              name: toolName,
              input: event.parameters ?? {},
            }],
          },
        },
      ];
    }

    case 'tool_result': {
      const statusText = event.status === 'success' ? '(ok)' : `(${event.status ?? 'unknown'})`;
      return [{
        type: 'user',
        session_id: state.sessionId,
        message: {
          content: [{
            type: 'tool_result',
            id: event.tool_id ?? '',
            text: statusText,
          }],
        },
      }];
    }

    case 'result': {
      const flushed = flushAccumulatedText(state);
      const isError = event.status !== 'success';
      const errMsg = typeof event.error === 'string'
        ? event.error
        : event.error?.message;
      return [...flushed, buildResultMessage(event.stats, state, isError, errMsg)];
    }

    case 'error': {
      const flushed = flushAccumulatedText(state);
      const errMsg = typeof event.error === 'string'
        ? event.error
        : (event.error?.message ?? event.message ?? 'Gemini error');
      return [...flushed, buildResultMessage(undefined, state, true, errMsg)];
    }

    default:
      return [];
  }
}

function buildResultMessage(
  stats: GeminiStats | undefined,
  state: GeminiTranslatorState,
  isError: boolean,
  errorMessage?: string,
): SDKMessage {
  const modelKey = state.model;
  const modelStats = modelKey && stats?.models?.[modelKey]
    ? stats.models[modelKey]
    : undefined;
  const inputTokens = modelStats?.input_tokens ?? stats?.input_tokens ?? 0;
  const outputTokens = modelStats?.output_tokens ?? stats?.output_tokens ?? 0;

  const modelUsage = modelKey
    ? {
        [modelKey]: {
          inputTokens,
          outputTokens,
          contextWindow: state.contextWindow ?? 0,
          costUSD: 0,
        },
      }
    : undefined;

  return {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    session_id: state.sessionId,
    duration_ms: stats?.duration_ms ?? (Date.now() - state.startTime),
    result: state.lastAgentText,
    is_error: isError,
    errors: isError ? [errorMessage || 'Gemini execution failed'] : undefined,
    modelUsage,
  };
}
