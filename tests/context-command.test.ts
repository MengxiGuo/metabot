import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandHandler } from '../src/bridge/command-handler.js';
import { SessionManager } from '../src/engines/claude/session-manager.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

describe('/context command', () => {
  let sessionStoreDir: string;
  let sessionManager: SessionManager;
  let sender: { sendTextNotice: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    sessionStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-context-command-'));
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
          model: undefined,
        },
        codex: { model: 'gpt-5.6-sol', contextWindow: 258_400 },
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

  it('enables long context for only the current chat and starts a fresh thread', async () => {
    sessionManager.setSessionId('chat1', 'sess-abc');
    const handled = await createHandler().handle(message('/context long'));

    expect(handled).toBe(true);
    expect(sessionManager.getSession('chat1')).toMatchObject({ codexContextMode: 'long' });
    expect(sessionManager.getSession('chat1').sessionId).toBeUndefined();
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '✅ Codex Context Updated',
      expect.stringContaining('1,000,000'),
      'green',
    );
  });

  it('reports the current mode without changing the session', async () => {
    sessionManager.setSessionId('chat1', 'sess-abc');
    const handled = await createHandler().handle(message('/context'));

    expect(handled).toBe(true);
    expect(sessionManager.getSession('chat1').sessionId).toBe('sess-abc');
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '🧠 Codex Context',
      expect.stringContaining('`normal`'),
      'blue',
    );
  });

  it('refuses to change mode while a task is running', async () => {
    const handled = await createHandler({ startTime: Date.now() }).handle(message('/context long'));

    expect(handled).toBe(true);
    expect(sessionManager.getSession('chat1').codexContextMode).toBeUndefined();
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '⏳ Task In Progress',
      expect.stringContaining('was not changed'),
      'orange',
    );
  });
});
