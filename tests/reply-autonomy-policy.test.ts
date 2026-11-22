import { describe, expect, it, vi } from 'vitest';
import { ClaudeExecutor } from '../src/engines/claude/executor.js';
import { CodexExecutor } from '../src/engines/codex/executor.js';
import { AntigravityExecutor } from '../src/engines/antigravity/executor.js';

const logger: any = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
const context = { botName: 'test', chatId: 'chat', replyToken: 'fixture-private-capability' };

function promptFor(engine: string, replyToken?: string) {
  const config: any = { name: 'test', engine, claude: {}, codex: {}, antigravity: {} };
  const apiContext = { ...context, replyToken };
  if (engine === 'claude') {
    const executor = new ClaudeExecutor(config, logger);
    return (executor as any).buildQueryOptions('/tmp', undefined, new AbortController(), undefined, apiContext)
      .systemPrompt.append as string;
  }
  const executor = engine === 'codex' ? new CodexExecutor(config, logger) : new AntigravityExecutor(config, logger);
  return (executor as any).buildPromptWithContext('Finish the requested work.', undefined, apiContext) as string;
}

describe('Reply is a transport capability, not model instructions', () => {
  it.each(['claude', 'codex', 'antigravity'])(
    '%s has byte-identical prompts with and without Reply capability',
    (engine) => {
      const original = promptFor(engine);
      const withReply = promptFor(engine, context.replyToken);
      expect(withReply).toBe(original);
      expect(withReply).not.toContain('mb ask');
      expect(withReply).not.toContain('/reply');
      expect(withReply).not.toContain('Answers during this task');
      expect(withReply).not.toContain(context.replyToken);
    },
  );
});
