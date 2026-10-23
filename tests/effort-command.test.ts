import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandHandler } from '../src/bridge/command-handler.js';
import { SessionManager } from '../src/engines/claude/session-manager.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

describe('/effort command', () => {
  let sessionStoreDir: string;
  let sessionManager: SessionManager;
  let sender: { sendTextNotice: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    sessionStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-effort-command-'));
    process.env.SESSION_STORE_DIR = sessionStoreDir;
    sessionManager = new SessionManager('/tmp/test-dir', createLogger(), 'codex-test');
    sender = { sendTextNotice: vi.fn().mockResolvedValue(undefined) };
  });

  afterEach(() => {
    sessionManager.destroy();
    delete process.env.SESSION_STORE_DIR;
    fs.rmSync(sessionStoreDir, { recursive: true, force: true });
  });

  function createHandler(runningTask?: { startTime: number }) {
    return new CommandHandler(
      {
        name: 'codex-test',
        engine: 'codex',
        claude: {
          defaultWorkingDirectory: '/tmp/test-dir',
          outputsBaseDir: '/tmp/test-outputs',
        },
        codex: {
          model: 'gpt-6-astra',
          reasoningEffort: 'high',
          reasoningEffortByModel: { 'gpt-6-astra': 'xhigh' },
        },
      } as any,
      createLogger(),
      sender as any,
      sessionManager,
      {} as any,
      { log: vi.fn() } as any,
      () => runningTask,
      vi.fn(),
    );
  }

  function message(text: string) {
    return {
      text,
      chatId: 'chat1',
      userId: 'user1',
      messageId: 'message1',
      chatType: 'p2p',
    } as any;
  }

  it('shows the per-model default and its source', async () => {
    const handled = await createHandler().handle(message('/effort'));

    expect(handled).toBe(true);
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '🧠 Codex Reasoning Effort',
      expect.stringContaining('`xhigh` (model default)'),
      'blue',
    );
  });

  it('shows the effective effort in /status', async () => {
    const handled = await createHandler().handle(message('/status'));

    expect(handled).toBe(true);
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '📊 Status',
      expect.stringContaining('**Reasoning effort:** `xhigh` (model default)'),
    );
  });

  it('sets a per-chat override and detaches the prior Codex thread', async () => {
    sessionManager.setSessionId('chat1', 'sess-abc');
    const handled = await createHandler().handle(message('/effort max'));

    expect(handled).toBe(true);
    expect(sessionManager.getSession('chat1').codexReasoningEffort).toBe('max');
    expect(sessionManager.getSession('chat1').sessionId).toBeUndefined();
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '✅ Codex Reasoning Effort Updated',
      expect.stringContaining('`max` (session override)'),
      'green',
    );
  });

  it('shows the newly selected model default when no session override exists', async () => {
    const handled = await createHandler().handle(message('/model gpt-5.6-sol'));

    expect(handled).toBe(true);
    expect(sessionManager.getSession('chat1').model).toBe('gpt-5.6-sol');
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '✅ Model Set',
      expect.stringContaining('`high` (bot default)'),
      'green',
    );
  });

  it('resets the session override to the selected model default', async () => {
    sessionManager.setCodexReasoningEffort('chat1', 'max');
    const handled = await createHandler().handle(message('/effort reset'));

    expect(handled).toBe(true);
    expect(sessionManager.getSession('chat1').codexReasoningEffort).toBeUndefined();
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '✅ Codex Reasoning Effort Updated',
      expect.stringContaining('`xhigh` (model default)'),
      'green',
    );
  });

  it('clears the reasoning override with /model reset', async () => {
    sessionManager.setCodexReasoningEffort('chat1', 'max');
    const handled = await createHandler().handle(message('/model reset'));

    expect(handled).toBe(true);
    expect(sessionManager.getSession('chat1').codexReasoningEffort).toBeUndefined();
  });

  it('rejects invalid values and changes nothing', async () => {
    const handled = await createHandler().handle(message('/effort enormous'));

    expect(handled).toBe(true);
    expect(sessionManager.getSession('chat1').codexReasoningEffort).toBeUndefined();
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '⚠️ Invalid Reasoning Effort',
      expect.any(String),
      'orange',
    );
  });

  it('refuses to change effort while a task is running', async () => {
    const handled = await createHandler({ startTime: Date.now() }).handle(message('/effort max'));

    expect(handled).toBe(true);
    expect(sessionManager.getSession('chat1').codexReasoningEffort).toBeUndefined();
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '⏳ Task In Progress',
      expect.stringContaining('was not changed'),
      'orange',
    );
  });
});
