import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { SessionManager } from '../src/engines/claude/session-manager.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

describe('SessionManager', () => {
  let manager: SessionManager;
  let sessionStoreDir: string;

  beforeEach(() => {
    sessionStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-session-manager-'));
    process.env.SESSION_STORE_DIR = sessionStoreDir;
  });

  afterEach(() => {
    if (manager) manager.destroy();
    delete process.env.SESSION_STORE_DIR;
    fs.rmSync(sessionStoreDir, { recursive: true, force: true });
  });

  it('creates a new session with default working directory', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    const session = manager.getSession('chat1');
    expect(session.workingDirectory).toBe('/tmp/test-dir');
    expect(session.sessionId).toBeUndefined();
  });

  it('returns the same session for the same chatId', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    const s1 = manager.getSession('chat1');
    const s2 = manager.getSession('chat1');
    expect(s1).toBe(s2);
  });

  it('returns different sessions for different chatIds', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    const s1 = manager.getSession('chat1');
    const s2 = manager.getSession('chat2');
    expect(s1).not.toBe(s2);
  });

  it('sets session ID', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.getSession('chat1');
    manager.setSessionId('chat1', 'sess-abc');
    const session = manager.getSession('chat1');
    expect(session.sessionId).toBe('sess-abc');
  });

  it('persists a long Codex context preference and resets conversation state when it changes', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger(), 'codex-test');
    manager.setSessionId('chat1', 'sess-abc');
    manager.addUsage('chat1', 123, 0.45, 6789);

    expect(manager.setCodexContextMode('chat1', 'long')).toEqual({
      changed: true,
      sessionReset: true,
    });
    const session = manager.getSession('chat1');
    expect(session.codexContextMode).toBe('long');
    expect(session.sessionId).toBeUndefined();
    expect(session.cumulativeTokens).toBe(0);

    manager.destroy();
    manager = new SessionManager('/tmp/test-dir', createLogger(), 'codex-test');
    expect(manager.getSession('chat1').codexContextMode).toBe('long');
  });

  it('restores normal context mode without deleting the working directory', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.setSessionWorkingDirectory('chat1', '/tmp/alternate');
    manager.setCodexContextMode('chat1', 'long');

    expect(manager.setCodexContextMode('chat1', 'normal')).toEqual({
      changed: true,
      sessionReset: false,
    });
    const session = manager.getSession('chat1');
    expect(session.codexContextMode).toBeUndefined();
    expect(session.workingDirectory).toBe('/tmp/alternate');
  });

  it('persists a Codex reasoning override and resets conversation state when it changes', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger(), 'codex-test');
    manager.setSessionId('chat1', 'sess-abc');
    manager.addUsage('chat1', 123, 0.45, 6789);

    expect(manager.setCodexReasoningEffort('chat1', 'max')).toEqual({
      changed: true,
      sessionReset: true,
    });
    expect(manager.getSession('chat1')).toMatchObject({
      codexReasoningEffort: 'max',
      cumulativeTokens: 0,
    });
    expect(manager.getSession('chat1').sessionId).toBeUndefined();

    manager.destroy();
    manager = new SessionManager('/tmp/test-dir', createLogger(), 'codex-test');
    expect(manager.getSession('chat1').codexReasoningEffort).toBe('max');
  });

  it('clears a Codex reasoning override without changing the working directory', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.setSessionWorkingDirectory('chat1', '/tmp/alternate');
    manager.setCodexReasoningEffort('chat1', 'xhigh');

    expect(manager.setCodexReasoningEffort('chat1', undefined)).toEqual({
      changed: true,
      sessionReset: false,
    });
    expect(manager.getSession('chat1').codexReasoningEffort).toBeUndefined();
    expect(manager.getSession('chat1').workingDirectory).toBe('/tmp/alternate');
  });

  it('resets session (clears sessionId)', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.getSession('chat1');
    manager.setSessionId('chat1', 'sess-abc');
    manager.resetSession('chat1');
    const session = manager.getSession('chat1');
    expect(session.sessionId).toBeUndefined();
  });

  it('clears expired conversation state while retaining model override', () => {
    manager = new SessionManager('/tmp/test-dir', createLogger());
    manager.getSession('chat1');
    manager.setSessionModel('chat1', 'gpt-5.6-sol');
    manager.setSessionId('chat1', 'sess-abc');
    manager.addUsage('chat1', 123, 0.45, 6789);

    const session = manager.getSession('chat1');
    session.lastUsed = Date.now() - 6 * 24 * 60 * 60 * 1000;
    (manager as any).cleanupExpired();

    const retained = manager.getSession('chat1');
    expect(retained.model).toBe('gpt-5.6-sol');
    expect(retained.sessionId).toBeUndefined();
    expect(retained.cumulativeTokens).toBe(0);
    expect(retained.cumulativeCostUsd).toBe(0);
    expect(retained.cumulativeDurationMs).toBe(0);
  });

  it('loads expired persisted model override without stale sessionId', () => {
    const persistPath = path.join(sessionStoreDir, 'sessions-default.json');
    const lastUsed = Date.now() - 6 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(
      persistPath,
      JSON.stringify({
        chat1: {
          sessionId: 'sess-stale',
          workingDirectory: '/tmp/test-dir',
          lastUsed,
          cumulativeTokens: 123,
          cumulativeCostUsd: 0.45,
          cumulativeDurationMs: 6789,
          model: 'gpt-5.6-sol',
        },
      }),
      'utf-8',
    );

    manager = new SessionManager('/tmp/test-dir', createLogger());
    const session = manager.getSession('chat1');
    expect(session.model).toBe('gpt-5.6-sol');
    expect(session.sessionId).toBeUndefined();
    expect(session.cumulativeTokens).toBe(0);
    expect(session.cumulativeCostUsd).toBe(0);
    expect(session.cumulativeDurationMs).toBe(0);
  });
});
