import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandHandler } from '../src/bridge/command-handler.js';
import { webBotFromJson } from '../src/config.js';
import { resolveAntigravityAccount } from '../src/engines/antigravity/account-config.js';
import { SessionManager } from '../src/engines/claude/session-manager.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

describe('/account command', () => {
  let sessionStoreDir: string;
  let sessionManager: SessionManager;
  let sender: { sendTextNotice: ReturnType<typeof vi.fn> };

  const config = {
    name: 'antigravity-test',
    engine: 'antigravity',
    claude: {
      defaultWorkingDirectory: '/tmp/test-dir',
      outputsBaseDir: '/tmp/test-outputs',
    },
    antigravity: {
      defaultAccount: 'primary',
      accounts: {
        primary: { runner: '/opt/metabot/agy-primary' },
        backup: { runner: '/opt/metabot/agy-backup' },
      },
    },
  } as any;

  beforeEach(() => {
    sessionStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-antigravity-account-'));
    process.env.SESSION_STORE_DIR = sessionStoreDir;
    sessionManager = new SessionManager('/tmp/test-dir', createLogger(), 'antigravity-test');
    sender = { sendTextNotice: vi.fn().mockResolvedValue(undefined) };
  });

  afterEach(() => {
    sessionManager.destroy();
    delete process.env.SESSION_STORE_DIR;
    fs.rmSync(sessionStoreDir, { recursive: true, force: true });
  });

  function createHandler(runningTask?: { startTime: number }, configOverride: any = config) {
    return new CommandHandler(
      configOverride,
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

  it('shows only the current alias and configured aliases', async () => {
    await createHandler().handle(message('/account'));
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '👤 Antigravity Account',
      expect.stringContaining('`primary` (bot default)'),
    );

    sender.sendTextNotice.mockClear();
    await createHandler().handle(message('/account list'));
    const body = sender.sendTextNotice.mock.calls[0][2] as string;
    expect(body).toContain('`primary` ✅');
    expect(body).toContain('`backup`');
    expect(body).not.toMatch(/oauth|token|@/i);
  });

  it('switches explicitly, persists the alias, and detaches the prior conversation', async () => {
    sessionManager.setSessionId('chat1', 'conversation-primary');
    await createHandler().handle(message('/account use backup'));

    expect(sessionManager.getSession('chat1').antigravityAccount).toBe('backup');
    expect(sessionManager.getSession('chat1').sessionId).toBeUndefined();
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '✅ Antigravity Account Updated',
      expect.stringContaining('`backup`'),
      'green',
    );

    sessionManager.destroy();
    sessionManager = new SessionManager('/tmp/test-dir', createLogger(), 'antigravity-test');
    expect(sessionManager.getSession('chat1').antigravityAccount).toBe('backup');
  });

  it('advances only after an explicit next command and wraps in configuration order', async () => {
    await createHandler().handle(message('/account next'));
    expect(sessionManager.getSession('chat1').antigravityAccount).toBe('backup');

    await createHandler().handle(message('/account next'));
    expect(sessionManager.getSession('chat1').antigravityAccount).toBe('primary');
  });

  it('rejects unknown aliases without changing account state', async () => {
    await createHandler().handle(message('/account use missing'));
    expect(sessionManager.getSession('chat1').antigravityAccount).toBeUndefined();
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '⚠️ Invalid Antigravity Account',
      expect.any(String),
      'orange',
    );
  });

  it('refuses to switch while a task is running', async () => {
    await createHandler({ startTime: Date.now() }).handle(message('/account next'));
    expect(sessionManager.getSession('chat1').antigravityAccount).toBeUndefined();
    expect(sender.sendTextNotice).toHaveBeenCalledWith(
      'chat1',
      '⏳ Task In Progress',
      expect.stringContaining('was not changed'),
      'orange',
    );
  });

  it('lists models only from the explicitly selected account runner', async () => {
    const primaryRunner = path.join(sessionStoreDir, 'agy-primary');
    const backupRunner = path.join(sessionStoreDir, 'agy-backup');
    fs.writeFileSync(primaryRunner, '#!/bin/sh\nprintf "gemini-4-argon-low\\tGemini 4 Argon (Low)\\n"\n');
    fs.writeFileSync(backupRunner, '#!/bin/sh\nprintf "gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\n"\n');
    fs.chmodSync(primaryRunner, 0o755);
    fs.chmodSync(backupRunner, 0o755);
    const catalogConfig = {
      ...config,
      antigravity: {
        defaultAccount: 'primary',
        accounts: {
          primary: { runner: primaryRunner },
          backup: { runner: backupRunner },
        },
      },
    };
    const handler = createHandler(undefined, catalogConfig);

    await handler.handle(message('/model list'));
    let body = sender.sendTextNotice.mock.calls.at(-1)?.[2] as string;
    expect(body).toContain('gemini-4-argon-low');
    expect(body).not.toContain('gemini-3.8-flash-low');

    await handler.handle(message('/account use backup'));
    await handler.handle(message('/model list'));
    body = sender.sendTextNotice.mock.calls.at(-1)?.[2] as string;
    expect(body).toContain('gemini-3.8-flash-low');
    expect(body).not.toContain('gemini-4-argon-low');
  });
});

describe('Antigravity account configuration', () => {
  it('resolves only the selected account runner', () => {
    const config = {
      defaultAccount: 'primary',
      accounts: {
        primary: { runner: '/opt/metabot/agy-primary' },
        backup: { runner: '/opt/metabot/agy-backup' },
      },
    };
    expect(resolveAntigravityAccount(config)).toEqual({
      alias: 'primary',
      runner: '/opt/metabot/agy-primary',
    });
    expect(resolveAntigravityAccount(config, 'backup')).toEqual({
      alias: 'backup',
      runner: '/opt/metabot/agy-backup',
    });
    expect(() => resolveAntigravityAccount(config, 'missing')).toThrow(/no longer configured/);
  });

  it('rejects unsafe aliases, relative runners, and missing defaults', () => {
    const base = {
      name: 'invalid-antigravity',
      engine: 'antigravity' as const,
      defaultWorkingDirectory: '/tmp/project',
    };
    expect(() =>
      webBotFromJson({
        ...base,
        antigravity: {
          defaultAccount: 'work email',
          accounts: { 'work email': { runner: '/opt/metabot/agy-work' } },
        },
      }),
    ).toThrow(/Invalid Antigravity account alias/);
    expect(() =>
      webBotFromJson({
        ...base,
        antigravity: {
          defaultAccount: 'primary',
          accounts: { primary: { runner: 'agy-primary' } },
        },
      }),
    ).toThrow(/absolute runner path/);
    expect(() =>
      webBotFromJson({
        ...base,
        antigravity: {
          accounts: { primary: { runner: '/opt/metabot/agy-primary' } },
        },
      }),
    ).toThrow(/defaultAccount/);
  });
});
