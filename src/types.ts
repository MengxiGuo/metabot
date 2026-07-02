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
  /** Quota info for flat-tier engines. Codex account-level rate_limits
   *  additionally sets `secondary` for the weekly window. When present, card
   *  footer shows quota instead of `$cost`. */
  quotaInfo?: {
    usedPct: number;
    hoursToReset: number;
    /** Codex weekly window (rate_limits.secondary). */
    secondary?: {
      usedPct: number;
      hoursToReset: number;
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
