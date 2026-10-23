import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandHandler } from '../src/bridge/command-handler.js';
import { SessionManager } from '../src/engines/claude/session-manager.js';
import { AntigravityExecutor, buildAntigravityArgs } from '../src/engines/antigravity/executor.js';
import { fetchAntigravityModels, antigravityEffortLevels } from '../src/engines/antigravity/model-catalog.js';
import { ANTIGRAVITY_REASONING_EFFORTS } from '../src/config.js';

vi.mock('../src/engines/antigravity/model-catalog.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/engines/antigravity/model-catalog.js')>(),
  fetchAntigravityModels: vi.fn(),
}));

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;

describe('Antigravity per-chat effort', () => {
  let dir: string;
  let manager: SessionManager;
  let sender: { sendTextNotice: ReturnType<typeof vi.fn> };
  let oldStore: string | undefined;
  beforeEach(() => {
    vi.mocked(fetchAntigravityModels).mockResolvedValue(ANTIGRAVITY_REASONING_EFFORTS.map(level => ({id: `gemini-4-argon-${level}`, label: level})));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-agy-effort-'));
    oldStore = process.env.SESSION_STORE_DIR;
    process.env.SESSION_STORE_DIR = dir;
    manager = new SessionManager(dir, logger, 'agy-test');
    sender = { sendTextNotice: vi.fn().mockResolvedValue(undefined) };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    manager.destroy();
    if (oldStore === undefined) delete process.env.SESSION_STORE_DIR;
    else process.env.SESSION_STORE_DIR = oldStore;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function handler(busy = false, defaultEffort: string | undefined = 'high', engine = 'antigravity') {
    return new CommandHandler({
      name: 'agy-test', engine,
      claude: { defaultWorkingDirectory: dir, outputsBaseDir: dir },
      antigravity: { model: 'gemini-4-argon-low', effort: defaultEffort },
    } as any, logger, sender as any, manager, {} as any, { log: vi.fn() } as any,
    () => busy ? { startTime: Date.now() } : undefined, vi.fn());
  }
  function msg(text: string, chatId = 'chat1') {
    return { text, chatId, userId: 'user1', messageId: 'msg1', chatType: 'p2p' } as any;
  }
  const body = () => sender.sendTextNotice.mock.calls.at(-1)?.[2];

  it.each(ANTIGRAVITY_REASONING_EFFORTS)('sets %s and persists without touching other chats or Codex', async level => {
    manager.setCodexReasoningEffort('chat1', 'ultra');
    manager.setSessionId('chat1', 'old-conversation');
    manager.setSessionId('chat2', 'other-conversation');
    const h = handler();
    expect(await h.handle(msg(`/effort ${level}`))).toBe(true);
    expect(manager.getSession('chat1')).toMatchObject({ antigravityReasoningEffort: level, codexReasoningEffort: 'ultra' });
    expect(manager.getSession('chat1').sessionId).toBeUndefined();
    expect(manager.getSession('chat2').sessionId).toBe('other-conversation');
    expect(manager.getSession('chat2').antigravityReasoningEffort).toBeUndefined();
    manager.destroy();
    manager = new SessionManager(dir, logger, 'agy-test');
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBe(level);
    const otherBot = new SessionManager(dir, logger, 'other-bot');
    try { expect(otherBot.getSession('chat1').antigravityReasoningEffort).toBeUndefined(); }
    finally { otherBot.destroy(); }
  });
  it.each(['/effort', '/effort show', '/effort status', '/status', '/model'])('shows default source through %s', async command => {
    await handler().handle(msg(command));
    expect(body()).toContain('high');
    expect(body()).toContain('机器人默认');
  });
  it('reports unspecified CLI default instead of inventing a level', async () => {
    const h = handler();
    (h as any).config.antigravity.effort = undefined;
    (h as any).config.antigravity.model = undefined;
    await h.handle(msg('/effort'));
    expect(body()).toContain('CLI 默认');
    expect(body()).toContain('未指定');
  });
  it('shows a requested session override even while busy', async () => {
    manager.setAntigravityReasoningEffort('chat1', 'max');
    await handler(true).handle(msg('/effort'));
    expect(body()).toContain('max');
    expect(body()).toContain('当前群聊');
  });
  it('lists only the five Antigravity levels', async () => {
    await handler().handle(msg('/effort list'));
    for (const level of ANTIGRAVITY_REASONING_EFFORTS) expect(body()).toContain(level);
    expect(body()).not.toContain('ultra');
  });
  it.each(['ultra', 'highest', 'max garbage', 'high --agent bad', 'list high'])('rejects %s without losing history', async bad => {
    manager.setSessionId('chat1', 'unchanged');
    await handler().handle(msg(`/effort ${bad}`));
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBeUndefined();
    expect(manager.getSession('chat1').sessionId).toBe('unchanged');
    expect(sender.sendTextNotice.mock.calls.at(-1)?.[3]).toBe('orange');
  });
  it.each(['reset', 'clear', 'default'])('returns to bot default with %s', async reset => {
    manager.setAntigravityReasoningEffort('chat1', 'max');
    await handler().handle(msg(`/effort ${reset}`));
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBeUndefined();
    expect(body()).toContain('high');
    expect(body()).toContain('机器人默认');
  });
  it.each(['max', 'reset'])('refuses mutation %s during a running task', async value => {
    manager.setAntigravityReasoningEffort('chat1', 'low');
    manager.setSessionId('chat1', 'busy-conversation');
    await handler(true).handle(msg(`/effort ${value}`));
    expect(manager.getSession('chat1')).toMatchObject({ antigravityReasoningEffort: 'low', sessionId: 'busy-conversation' });
    expect(sender.sendTextNotice.mock.calls.at(-1)?.[3]).toBe('orange');
  });
  it('does not detach history when setting the same value', async () => {
    manager.setAntigravityReasoningEffort('chat1', 'max');
    manager.setSessionId('chat1', 'keep');
    await handler().handle(msg('/effort MAX'));
    expect(manager.getSession('chat1').sessionId).toBe('keep');
  });
  it('retains preferences after /reset and expiry', async () => {
    manager.setAntigravityReasoningEffort('chat1', 'xhigh');
    manager.resetSession('chat1');
    manager.getSession('chat1').lastUsed = Date.now() - 6 * 86400000;
    manager.destroy();
    manager = new SessionManager(dir, logger, 'agy-test');
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBe('xhigh');
  });
  it('ignores corrupt persisted values', () => {
    manager.destroy();
    fs.writeFileSync(path.join(dir, 'sessions-agy-test.json'), JSON.stringify({ chat1: {
      sessionId: 'keep', workingDirectory: dir, lastUsed: Date.now(), antigravityReasoningEffort: 'ultra',
    } }));
    manager = new SessionManager(dir, logger, 'agy-test');
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBeUndefined();
    expect(manager.getSession('chat1').sessionId).toBe('keep');
  });
  it('reports persistence failure and restores the old in-memory conversation', async () => {
    manager.setAntigravityReasoningEffort('chat1', 'low');
    manager.setSessionId('chat1', 'keep');
    const save = vi.spyOn(manager as any, 'saveToDisk').mockReturnValueOnce(false);
    await handler().handle(msg('/effort max'));
    expect(manager.getSession('chat1')).toMatchObject({ sessionId: 'keep', antigravityReasoningEffort: 'low' });
    expect(sender.sendTextNotice.mock.calls.at(-1)?.[3]).toBe('red');
    save.mockRestore();
  });
  it('clears effort on /model reset but refuses that reset while busy', async () => {
    manager.setAntigravityReasoningEffort('chat1', 'max');
    manager.setSessionId('chat1', 'keep');
    await handler(true).handle(msg('/model reset'));
    expect(manager.getSession('chat1')).toMatchObject({ sessionId: 'keep', antigravityReasoningEffort: 'max' });
    await handler().handle(msg('/model reset'));
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBeUndefined();
  });
  it('does not retain a new override if its first save fails', async () => {
    manager.setSessionId('chat1', 'keep');
    vi.spyOn(manager as any, 'saveToDisk').mockReturnValueOnce(false);
    await handler().handle(msg('/effort max'));
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBeUndefined();
    expect(manager.getSession('chat1').sessionId).toBe('keep');
  });
  it('routes by active engine override and does not enable legacy Gemini', async () => {
    manager.setSessionEngine('chat1', 'antigravity');
    await handler(false, 'high', 'codex').handle(msg('/effort max'));
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBe('max');
    manager.setSessionEngine('chat1', 'gemini');
    await handler().handle(msg('/effort low'));
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBe('max');
  });
  it('only offers variants for the exact model family', () => {
    expect(antigravityEffortLevels([
      { id: 'gemini-4-argon-low', label: 'Low' },
      { id: 'gemini-4-argon-high', label: 'High' },
      { id: 'different-model-max', label: 'Max' },
    ], 'gemini-4-argon-low')).toEqual(['low', 'high']);
  });
  it('rejects CLI-valid values absent from the selected account catalog', async () => {
    vi.mocked(fetchAntigravityModels).mockResolvedValue([{ id: 'gemini-4-argon-high', label: 'High' }]);
    await handler().handle(msg('/effort max'));
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBeUndefined();
    expect(sender.sendTextNotice.mock.calls.at(-1)?.[3]).toBe('orange');
  });
  it('leaves state untouched on catalog errors; reset remains available offline', async () => {
    manager.setAntigravityReasoningEffort('chat1', 'low');
    manager.setSessionId('chat1', 'keep');
    vi.mocked(fetchAntigravityModels).mockRejectedValue(new Error('unavailable'));
    await handler().handle(msg('/effort high'));
    expect(manager.getSession('chat1')).toMatchObject({sessionId: 'keep', antigravityReasoningEffort: 'low'});
    await handler().handle(msg('/effort reset'));
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBeUndefined();
  });
  it('rechecks state after asynchronous catalog lookup', async () => {
    vi.mocked(fetchAntigravityModels).mockImplementationOnce(async () => {
      manager.setSessionModel('chat1', 'changed-model');
      return [{ id: 'gemini-4-argon-high', label: 'High' }];
    });
    await handler().handle(msg('/effort high'));
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBeUndefined();
  });
  it('rechecks task activity after catalog lookup and queries only the selected account', async () => {
    manager.setAntigravityAccount('chat1', 'backup');
    const h = handler();
    vi.mocked(fetchAntigravityModels).mockImplementationOnce(async () => {
      (h as any).getRunningTask = () => ({ startTime: Date.now() });
      return [{ id: 'gemini-4-argon-high', label: 'High' }];
    });
    await h.handle(msg('/effort high'));
    expect(fetchAntigravityModels).toHaveBeenLastCalledWith(expect.anything(), 'backup');
    expect(manager.getSession('chat1').antigravityReasoningEffort).toBeUndefined();
    expect(sender.sendTextNotice.mock.calls.at(-1)?.[3]).toBe('orange');
  });
  it('passes the override through the actual spawned executable without changing bot defaults', async () => {
    const runner = path.join(dir, 'runner.cjs');
    fs.writeFileSync(runner, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('/usage')) { process.exit(0); }
fs.writeFileSync(${JSON.stringify(path.join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',conversation_id:'fixture',response:'OK',duration_seconds:0.1}}));
`, { mode: 0o755 });
    const config = { name: 'fixture', antigravity: { executable: runner, effort: 'low', model: 'gemini-4-argon-low' } } as any;
    const executor = new AntigravityExecutor(config, logger);
    const handle = executor.startExecution({ prompt: 'OK', cwd: dir, abortController: new AbortController(), antigravityReasoningEffort: 'max' });
    const results = [];
    for await (const event of handle.stream) if (event.type === 'result') results.push(event);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ subtype: 'success' });
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')) as string[];
    expect(args.filter(x => x === '--effort')).toHaveLength(1);
    expect(args[args.indexOf('--effort') + 1]).toBe('max');
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-4-argon-max');
    expect(config.antigravity.effort).toBe('low');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
  it('replaces conflicting effort suffixes only when effort is explicit', () => {
    const pinned = buildAntigravityArgs({}, '', 'gemini-4-argon-low', undefined);
    expect(pinned[pinned.indexOf('--model') + 1]).toBe('gemini-4-argon-low');
    const overridden = buildAntigravityArgs({}, '', 'gemini-4-argon-low', undefined, 'high');
    expect(overridden[overridden.indexOf('--model') + 1]).toBe('gemini-4-argon-high');
    expect(overridden[overridden.indexOf('--effort') + 1]).toBe('high');
  });
  it('uses defaults when no override exists and rejects invalid config before spawning', () => {
    expect(buildAntigravityArgs({}, '', undefined, undefined)).not.toContain('--effort');
    expect(buildAntigravityArgs({ effort: 'xhigh' }, '', undefined, undefined)).toContain('xhigh');
    expect(() => buildAntigravityArgs({ effort: 'ultra' as any }, '', undefined, undefined)).toThrow();
    expect(() => buildAntigravityArgs({}, '', undefined, undefined, 'bad' as any)).toThrow();
  });
});
