import { describe, expect, it, vi } from 'vitest';
import { ClaudeExecutor } from '../src/engines/claude/executor.js';
import { INDEPENDENT_JUDGMENT_POLICY_VERSION } from '../src/engines/shared/independent-judgment.js';

describe('ClaudeExecutor query options', () => {
  it('does not send Anthropic context beta headers to custom providers', () => {
    const executor = new ClaudeExecutor(
      {
        name: 'custom-claude-provider',
        engine: 'claude',
        model: 'custom-model',
        defaultWorkingDirectory: '/tmp',
        claude: {
          model: 'custom-model',
          env: {
            ANTHROPIC_BASE_URL: 'https://provider.example/api/coding',
            ANTHROPIC_MODEL: 'custom-model',
          },
        },
      } as any,
      {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any,
    );

    const options = (executor as any).buildQueryOptions('/tmp', undefined, new AbortController());

    expect(options).not.toHaveProperty('betas');
    expect(options.systemPrompt).toMatchObject({
      type: 'preset',
      preset: 'claude_code',
    });
    expect(options.systemPrompt.append).toContain(INDEPENDENT_JUDGMENT_POLICY_VERSION);
    expect(options.systemPrompt.append).toContain('correct, partly correct, unsupported, or incorrect');
    expect(options.systemPrompt.append).toContain('Do not manufacture disagreement');
    expect(options.systemPrompt.append).toContain('Active Goal Continuity and Follow-Through');
    expect(options.systemPrompt.append).toContain('active unfinished goal');
    expect(options.systemPrompt.append).toContain('continue the unfinished work in the same turn');
    expect(options.systemPrompt.append).toContain(
      'Do not invent state-changing work when the active request is only for explanation, review, diagnosis, or status',
    );
  });
});

it('passes task-scoped environment without adding question instructions to the SDK child', async () => {
  const context = { botName: 'claude-test', chatId: 'chat', replyToken: 'fixture-task-token' };
  const executor = new ClaudeExecutor(
    { name: 'claude-test', engine: 'claude', claude: {} } as any,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
  );
  const options = (executor as any).buildQueryOptions('/tmp', undefined, new AbortController(), undefined, context);
  expect(options.systemPrompt.append).not.toContain('mb ask');
  expect(options.systemPrompt.append).not.toContain(context.replyToken);
  const child = options.spawnClaudeCodeProcess({
    command: process.execPath,
    args: [
      '-e',
      'console.log(JSON.stringify({token:process.env.MB_TASK_REPLY_TOKEN,chat:process.env.MB_REPLY_CHAT,bot:process.env.MB_REPLY_BOT}))',
    ],
    cwd: '/tmp',
    env: {},
  });
  let output = '';
  child.stdout.on('data', (d: Buffer) => {
    output += d;
  });
  await new Promise<void>((resolve, reject) => {
    child.on('close', (code: number) => (code === 0 ? resolve() : reject(new Error('child failed'))));
    child.on('error', reject);
  });
  expect(JSON.parse(output)).toEqual({ token: context.replyToken, chat: context.chatId, bot: context.botName });
  expect(process.env.MB_TASK_REPLY_TOKEN).not.toBe(context.replyToken);
});
