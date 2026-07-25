// Shared types used across IM platforms (Feishu, Telegram, etc.)

export type CardStatus = 'thinking' | 'running' | 'complete' | 'error' | 'waiting_for_input';

export interface ToolCall {
  name: string;
  detail: string;
  status: 'running' | 'done';
}

export interface PendingQuestion {
  toolUseId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface BackgroundEvent {
  taskId: string;
  description: string;
  status: BackgroundTaskStatus;
  /** Latest stdout event line from the task, if any. */
  lastEvent?: string;
}

export interface GoalProgress {
  threadId?: string;
  objective: string;
  status: string;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  /** True when usage includes the current in-flight turn and may differ slightly from `/goal`. */
  estimated?: boolean;
  /** Latest goal-level event supplied by the execution transport. */
  lastEvent?: string;
}

export interface CardState {
  status: CardStatus;
  userPrompt: string;
  responseText: string;
  toolCalls: ToolCall[];
  /** Optional header title override (keeps the status color/icon). Used to label
   *  the split process/conclusion cards as "过程" / "🎯 结论". */
  cardLabel?: string;
  costUsd?: number;
  durationMs?: number;
  errorMessage?: string;
  pendingQuestion?: PendingQuestion;
  /** Primary model used (e.g. "claude-opus-4-7") */
  model?: string;
  /** Total input+output tokens consumed */
  totalTokens?: number;
  /** Context window size of the primary model */
  contextWindow?: number;
  /** Cumulative session cost (USD), accumulated across queries until /reset */
  sessionCostUsd?: number;
  /** Background tasks (e.g. Monitor) the agent has spawned during this turn. */
  backgroundEvents?: BackgroundEvent[];
  /** Official goal-mode progress, currently emitted by Codex app-server. */
  goalProgress?: GoalProgress;
  /** Quota info for flat-tier engines. Gemini (Google Code Assist
   *  retrieveUserQuota) sets only the primary fields; Codex (account-level
   *  rate_limits) additionally sets `secondary` for the weekly window. When
   *  present, card footer shows quota instead of `$cost`. */
  quotaInfo?: {
    usedPct: number;
    hoursToReset: number;
    label?: string;
    /** Codex weekly window (rate_limits.secondary). */
    secondary?: {
      usedPct: number;
      hoursToReset: number;
      label?: string;
    };
    /** Optional third window, used by providers that expose monthly limits. */
    tertiary?: {
      usedPct: number;
      hoursToReset: number;
      label?: string;
    };
  };
}

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  userId: string;
  text: string;
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
  /** Additional media from batched messages (smart debounce). */
  extraMedia?: Array<{
    messageId: string;
    imageKey?: string;
    fileKey?: string;
    fileName?: string;
  }>;
}
