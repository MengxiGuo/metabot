import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageBridge } from '../src/bridge/message-bridge.js';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';

let bridge: MessageBridge, internal: any, dir: string, prior: string | undefined;
const sender = { sendTextNotice: vi.fn(), updateCard: vi.fn(), sendText: vi.fn() };
const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
logger.child = () => logger;
function message(text: string, userId = 'owner', chatId = 'chat') {
  return { text, userId, chatId, chatType: 'group', messageId: 'm' };
}
function task(steer: any = vi.fn().mockResolvedValue(undefined)) {
  const t = {
    userId: 'owner',
    chatId: 'chat',
    abortController: new AbortController(),
    executionHandle: { steer, resolveQuestion: vi.fn().mockResolvedValue(undefined) },
    pendingQuestion: null,
    currentQuestionIndex: 0,
    collectedAnswers: {},
    processor: new StreamProcessor('test'),
    cardMessageId: 'card',
  };
  internal.runningTasks.set('chat', t);
  return t as any;
}
beforeEach(() => {
  vi.clearAllMocks();
  sender.updateCard.mockResolvedValue(true);
  dir = mkdtempSync(join(tmpdir(), 'metabot-reply-'));
  prior = process.env.SESSION_STORE_DIR;
  process.env.SESSION_STORE_DIR = dir;
  bridge = new MessageBridge(
    {
      name: 'reply-test',
      engine: 'codex',
      codex: { transport: 'app-server' },
      claude: { defaultWorkingDirectory: dir, downloadsDir: join(dir, 'downloads'), outputsBaseDir: join(dir, 'out') },
    } as any,
    logger,
    sender as any,
    'http://127.0.0.1:1',
  );
  internal = bridge;
  vi.spyOn(internal, 'executeQuery').mockResolvedValue(undefined);
});
afterEach(() => {
  for (const t of internal.runningTasks.values()) if (t.questionTimeoutId) clearTimeout(t.questionTimeoutId);
  bridge.getSessionManager().destroy();
  if (prior === undefined) delete process.env.SESSION_STORE_DIR;
  else process.env.SESSION_STORE_DIR = prior;
  rmSync(dir, { recursive: true, force: true });
});
describe('/reply through MessageBridge', () => {
  it('bypasses an existing queue and only acknowledges after engine acceptance', async () => {
    let accept!: () => void;
    const t = task(
      vi.fn(
        () =>
          new Promise<void>((r) => {
            accept = r;
          }),
      ),
    );
    internal.messageQueues.set('chat', [message('next task')]);
    const run = bridge.handleMessage(message(' /RePlY 允许验证\n保持原任务 '));
    expect(sender.sendTextNotice).not.toHaveBeenCalled();
    expect(t.executionHandle.steer).toHaveBeenCalledWith('允许验证\n保持原任务');
    accept();
    await run;
    expect(sender.sendTextNotice.mock.calls[0][1]).toBe('回答已提交当前任务');
    expect(internal.messageQueues.get('chat')).toHaveLength(1);
    expect(internal.executeQuery).not.toHaveBeenCalled();
  });
  it('keeps normal messages queued', async () => {
    const t = task();
    await bridge.handleMessage(message('普通新任务'));
    expect(internal.messageQueues.get('chat')[0].text).toBe('普通新任务');
    expect(t.executionHandle.steer).not.toHaveBeenCalled();
  });
  it.each(['/reply', '/reply   ', '/reply ' + 'x'.repeat(16001)])('validates bounded nonempty text', async (text) => {
    const t = task();
    await bridge.handleMessage(message(text));
    expect(t.executionHandle.steer).not.toHaveBeenCalled();
    expect(internal.messageQueues.size).toBe(0);
  });
  it('does not launch a new task when idle', async () => {
    await bridge.handleMessage(message('/reply yes'));
    expect(internal.executeQuery).not.toHaveBeenCalled();
    expect(sender.sendTextNotice.mock.calls[0][1]).toBe('没有进行中的任务');
  });
  it('isolates other users and other chats', async () => {
    const t = task();
    await bridge.handleMessage(message('/reply yes', 'other'));
    await bridge.handleMessage(message('/reply yes', 'owner', 'other-chat'));
    expect(t.executionHandle.steer).not.toHaveBeenCalled();
  });
  it('reports unsupported legacy transport instead of queueing', async () => {
    const t = task();
    delete t.executionHandle.steer;
    await bridge.handleMessage(message('/reply yes'));
    expect(sender.sendTextNotice.mock.calls[0][1]).toBe('当前运行方式不支持任务内追加');
    expect(internal.messageQueues.size).toBe(0);
  });
  it('reports unknown delivery on RPC failure, without retry or queue', async () => {
    task(vi.fn().mockRejectedValue(new Error('secret provider details')));
    await bridge.handleMessage(message('/reply yes'));
    expect(sender.sendTextNotice.mock.calls[0][1]).toBe('未确认回答送达');
    expect(JSON.stringify(sender.sendTextNotice.mock.calls)).not.toContain('secret');
    expect(internal.messageQueues.size).toBe(0);
  });
  it('prevents a concurrent reply from submitting twice', async () => {
    let accept!: () => void;
    const t = task(
      vi.fn(
        () =>
          new Promise<void>((r) => {
            accept = r;
          }),
      ),
    );
    const first = bridge.handleMessage(message('/reply yes'));
    await bridge.handleMessage(message('/reply yes'));
    accept();
    await first;
    expect(t.executionHandle.steer).toHaveBeenCalledTimes(1);
  });
  it('answers a pending choice by exact index and does not steer', async () => {
    const t = task();
    t.pendingQuestion = {
      toolUseId: 'q',
      questions: [
        { question: 'Allow?', answerKey: 'allow_id', header: 'Approval', options: [{ label: 'Yes' }, { label: 'No' }] },
      ],
    };
    await bridge.handleMessage(message('/reply 2'));
    expect(t.executionHandle.resolveQuestion).toHaveBeenCalledWith('q', { allow_id: 'No' });
    expect(t.executionHandle.steer).not.toHaveBeenCalled();
  });
  it('does not interpret a numeric-prefix custom answer as a choice', async () => {
    const t = task();
    t.pendingQuestion = {
      toolUseId: 'q',
      questions: [{ question: 'Allow?', header: 'A', options: [{ label: 'Yes' }] }],
    };
    await bridge.handleMessage(message('/reply 1 次都不允许'));
    expect(t.executionHandle.resolveQuestion).toHaveBeenCalledWith('q', { 'Allow?': '1 次都不允许' });
  });
  it('keeps a question available if submission fails', async () => {
    const t = task();
    t.executionHandle.resolveQuestion.mockRejectedValue(new Error('expired'));
    t.pendingQuestion = { toolUseId: 'q', questions: [{ question: 'Allow?', header: 'A', options: [] }] };
    await bridge.handleMessage(message('/reply no'));
    expect(t.pendingQuestion?.toolUseId).toBe('q');
    expect(sender.updateCard).not.toHaveBeenCalled();
  });
});

it('resumes a native question in the real chat execution loop without starting a second task', async () => {
  const { AsyncQueue } = await import('../src/utils/async-queue.js');
  const queue = new AsyncQueue<any>();
  (internal.executeQuery as any).mockRestore();
  (sender as any).sendCard = vi.fn().mockResolvedValue('card');
  internal.outputHandler = { sendOutputFiles: vi.fn() };
  const resolveQuestion = vi.fn(async () => {
    queue.enqueue({ type: 'question_resolved', uuid: 'native' });
    queue.enqueue({ type: 'result', subtype: 'success', result: 'answer received', is_error: false });
    queue.finish();
  });
  const finish = vi.fn(() => queue.finish());
  const startExecution = vi.fn(() => ({
    stream: queue[Symbol.asyncIterator](),
    supportsQuestions: true,
    resolveQuestion,
    finish,
  }));
  vi.spyOn(internal, 'executorForChat').mockReturnValue({ startExecution });
  queue.enqueue({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'native',
          name: 'AskUserQuestion',
          input: { questions: [{ answerKey: 'allow', question: 'Allow?', header: 'A', options: [] }] },
        },
      ],
    },
  });
  const run = bridge.handleMessage(message('start task'));
  await vi.waitFor(() => expect(internal.runningTasks.get('chat')?.pendingQuestion?.toolUseId).toBe('native'));
  await bridge.handleMessage(message('/reply 不允许'));
  await run;
  expect(resolveQuestion).toHaveBeenCalledWith('native', { allow: '不允许' });
  expect(startExecution).toHaveBeenCalledTimes(1);
  expect(internal.messageQueues.size).toBe(0);
  expect(sender.updateCard.mock.calls.at(-1)?.[1].status).toBe('complete');
});
