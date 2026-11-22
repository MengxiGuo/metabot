import type { ApiContext } from '../claude/executor.js';

export function taskReplyEnv(context?: ApiContext): Record<string, string> {
  return context?.replyToken
    ? {
        MB_REPLY_BOT: context.botName,
        MB_REPLY_CHAT: context.chatId,
        MB_TASK_REPLY_TOKEN: context.replyToken,
      }
    : {};
}
