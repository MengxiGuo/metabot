import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { MessageBridge } from '../src/bridge/message-bridge.js';
import { handleTaskRoutes } from '../src/api/routes/task-routes.js';
import { taskReplyEnv } from '../src/engines/shared/task-reply.js';
import { codexAppServerEnabled } from '../src/engines/codex/app-server-client.js';

let bridge: MessageBridge, internal: any, dir: string, previous: string | undefined;
const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
logger.child = () => logger;
const sender = { sendTextNotice: vi.fn().mockResolvedValue(true) };
function setup(engine: string) {
  bridge = new MessageBridge(
    { name: 'bot', engine, claude: { defaultWorkingDirectory: dir, outputsBaseDir: join(dir, 'out') } } as any,
    logger,
    sender as any,
    'http://127.0.0.1:1',
  );
  internal = bridge;
  const task = {
    userId: 'owner',
    chatId: 'chat',
    replyToken: 'per-task-test-capability',
    abortController: new AbortController(),
    executionHandle: {},
  };
  internal.runningTasks.set('chat', task);
  return task;
}
const message = (text: string, userId = 'owner') => ({
  text,
  userId,
  chatId: 'chat',
  chatType: 'group',
  messageId: 'm',
});
beforeEach(() => {
  sender.sendTextNotice.mockReset().mockResolvedValue(true);
  dir = mkdtempSync(join(tmpdir(), 'metabot-ask-'));
  previous = process.env.SESSION_STORE_DIR;
  process.env.SESSION_STORE_DIR = dir;
});
afterEach(() => {
  for (const t of internal?.runningTasks.values() || []) t.abortController.abort();
  bridge?.getSessionManager().destroy();
  if (previous === undefined) delete process.env.SESSION_STORE_DIR;
  else process.env.SESSION_STORE_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('default question channel across engines', () => {
  it.each(['codex', 'claude', 'antigravity'])(
    '%s: channel availability alone neither asks nor opens a waiter',
    async (engine) => {
      const task = setup(engine);
      const ask = vi.spyOn(bridge, 'askUser');
      await bridge.handleMessage(message('继续原任务'));
      expect(ask).not.toHaveBeenCalled();
      expect((task as any).externalQuestion).toBeUndefined();
      expect((task as any).pendingQuestion).toBeUndefined();
      expect(internal.messageQueues.get('chat')).toHaveLength(1);
      expect(sender.sendTextNotice.mock.calls.some((call) => call[1] === '需要你的回答')).toBe(false);
    },
  );
  it.each(['codex', 'claude', 'antigravity'])(
    '%s: actual CLI + HTTP route returns /reply to the same waiting tool',
    async (engine) => {
      const task = setup(engine);
      const ctx = { registry: { get: (name: string) => (name === 'bot' ? { bridge } : undefined) } } as any;
      const server = createServer(async (req, res) => {
        try {
          await handleTaskRoutes(ctx, req, res, req.method!, req.url!);
        } catch {
          res.statusCode = 500;
          res.end('{}');
        }
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as any).port;
      const child = spawn(process.execPath, ['bin/mb-ask.mjs', '允许验证吗？'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          METABOT_HOME: dir,
          METABOT_URL: `http://127.0.0.1:${port}`,
          ...taskReplyEnv({ botName: 'bot', chatId: 'chat', replyToken: task.replyToken }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (d) => {
        output += d;
      });
      const done = new Promise<number | null>((r) => child.on('close', r));
      try {
        await vi.waitFor(() => expect((task as any).externalQuestion).toBeDefined());
        await bridge.handleMessage(message('/reply 是', 'intruder'));
        expect((task as any).externalQuestion).toBeDefined();
        await bridge.handleMessage(message('/reply 不允许发送，只检查日志'));
        expect(await done).toBe(0);
        expect(JSON.parse(output)).toEqual({ success: true, answer: '不允许发送，只检查日志' });
        expect(internal.messageQueues.size).toBe(0);
      } finally {
        child.kill();
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );
  it('accepts ordinary text directly only while a question is registered', async () => {
    const t = setup('antigravity');
    const wait = bridge.askUser('chat', t.replyToken, '选择？', new AbortController().signal);
    await bridge.handleMessage(message('选择第二种'));
    expect(await wait).toEqual({ success: true, answer: '选择第二种' });
  });
  it('rejects stale capabilities and overlapping prompts', async () => {
    const t = setup('claude');
    expect((await bridge.askUser('chat', 'old', 'question', new AbortController().signal)).success).toBe(false);
    expect(sender.sendTextNotice).not.toHaveBeenCalled();
    const wait = bridge.askUser('chat', t.replyToken, 'first', new AbortController().signal);
    expect((await bridge.askUser('chat', t.replyToken, 'second', new AbortController().signal)).success).toBe(false);
    t.abortController.abort();
    expect((await wait).success).toBe(false);
  });
  it('failed Feishu delivery does not leave an invisible question pending', async () => {
    const t = setup('antigravity');
    sender.sendTextNotice.mockResolvedValue(false);
    expect((await bridge.askUser('chat', t.replyToken, 'question', new AbortController().signal)).success).toBe(false);
    expect((t as any).externalQuestion).toBeUndefined();
  });
  it('timeout and disconnected caller never imply approval', async () => {
    vi.useFakeTimers();
    const t = setup('antigravity');
    const wait = bridge.askUser('chat', t.replyToken, 'question', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(await wait).toMatchObject({ success: false });
    const caller = new AbortController();
    const next = bridge.askUser('chat', t.replyToken, 'question', caller.signal);
    caller.abort();
    expect(await next).toMatchObject({ success: false });
    expect((t as any).externalQuestion).toBeUndefined();
  });
  it('defaults new Codex engines to app-server and preserves explicit exec escape hatch', () => {
    setup('codex');
    const previous = process.env.CODEX_TRANSPORT;
    delete process.env.CODEX_TRANSPORT;
    try {
      expect(codexAppServerEnabled(undefined)).toBe(true);
      expect(codexAppServerEnabled({ transport: 'exec' })).toBe(false);
    } finally {
      if (previous !== undefined) process.env.CODEX_TRANSPORT = previous;
    }
    expect(taskReplyEnv()).toEqual({});
  });
});
