import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCodexAppServerThreadParams,
  buildCodexAppServerTurnParams,
  buildCodexArgs,
  CodexExecutor,
} from '../src/engines/codex/executor.js';
import {
  codexDeveloperInstructionsOverride,
  INDEPENDENT_JUDGMENT_POLICY,
} from '../src/engines/shared/independent-judgment.js';
import type { CodexBotConfig } from '../src/config.js';

describe('buildCodexArgs', () => {
  const cwd = '/work/proj';
  const prompt = 'run pwd';

  it('defaults approval policy to "never" and sandbox to "workspace-write"', () => {
    const args = buildCodexArgs({}, cwd, prompt, undefined, undefined);
    expect(args).toEqual([
      '-a',
      'never',
      '--sandbox',
      'workspace-write',
      '-C',
      cwd,
      '-c',
      codexDeveloperInstructionsOverride(),
      'exec',
      '--json',
      '--color',
      'never',
      '--skip-git-repo-check',
      prompt,
    ]);
    expect(codexDeveloperInstructionsOverride()).toContain('Active Goal Continuity and Follow-Through');
    expect(codexDeveloperInstructionsOverride()).toContain('active unfinished goal');
  });

  it('honors explicit approvalPolicy and sandbox', () => {
    const cfg: CodexBotConfig = { approvalPolicy: 'on-failure', sandbox: 'read-only' };
    const args = buildCodexArgs(cfg, cwd, prompt, undefined, undefined);
    expect(args.slice(0, 4)).toEqual(['-a', 'on-failure', '--sandbox', 'read-only']);
  });

  it('replaces policy/sandbox flags when dangerouslyBypassApprovalsAndSandbox is set', () => {
    const cfg: CodexBotConfig = {
      dangerouslyBypassApprovalsAndSandbox: true,
      approvalPolicy: 'on-failure',
      sandbox: 'read-only',
    };
    const args = buildCodexArgs(cfg, cwd, prompt, undefined, undefined);
    expect(args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('-a');
    expect(args).not.toContain('--sandbox');
  });

  it('passes model and profile when provided', () => {
    const cfg: CodexBotConfig = { profile: 'staging' };
    const args = buildCodexArgs(cfg, cwd, prompt, undefined, 'gpt-5.4-codex');
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.4-codex');
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('staging');
  });

  it('appends extraArgs verbatim between global flags and the exec subcommand', () => {
    const cfg: CodexBotConfig = { extraArgs: ['--foo', 'bar baz', '--qux'] };
    const args = buildCodexArgs(cfg, cwd, prompt, undefined, undefined);
    const execIdx = args.indexOf('exec');
    expect(args.slice(args.indexOf('--foo'), args.indexOf('--foo') + 3)).toEqual(['--foo', 'bar baz', '--qux']);
    expect(args.indexOf('--qux')).toBeLessThan(execIdx - 2);
    expect(args.slice(execIdx - 2, execIdx)).toEqual(['-c', codexDeveloperInstructionsOverride()]);
  });

  it('adds process-local long-context overrides before the exec subcommand', () => {
    const args = buildCodexArgs({}, cwd, prompt, undefined, 'gpt-5.6-sol', 'long');
    const execIdx = args.indexOf('exec');
    expect(args).toEqual(
      expect.arrayContaining(['model_context_window=1000000', 'model_auto_compact_token_limit=900000']),
    );
    expect(args.indexOf('model_auto_compact_token_limit=900000')).toBeLessThan(execIdx - 2);
    expect(args.slice(execIdx - 2, execIdx)).toEqual(['-c', codexDeveloperInstructionsOverride()]);
  });

  it('does not add context overrides in normal mode', () => {
    const args = buildCodexArgs({}, cwd, prompt, undefined, 'gpt-5.6-sol', 'normal');
    expect(args).not.toContain('model_context_window=1000000');
  });

  it('adds a process-local reasoning override after deployment extraArgs', () => {
    const args = buildCodexArgs(
      { extraArgs: ['-c', 'model_reasoning_effort="low"'] },
      cwd,
      prompt,
      undefined,
      'gpt-6-astra',
      'normal',
      'max',
    );
    const lowIndex = args.indexOf('model_reasoning_effort="low"');
    const maxIndex = args.indexOf('model_reasoning_effort="max"');
    const execIndex = args.indexOf('exec');

    expect(lowIndex).toBeGreaterThan(-1);
    expect(maxIndex).toBeGreaterThan(lowIndex);
    expect(maxIndex).toBeLessThan(execIndex);
  });

  it('uses `exec resume <sessionId>` when a session id is provided', () => {
    const args = buildCodexArgs({}, cwd, prompt, 'sess-abc', undefined);
    const tail = args.slice(args.indexOf('exec'));
    expect(tail).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check', 'sess-abc', prompt]);
    // resume path does NOT pass --color never (Codex resume subcommand differs)
    expect(tail).not.toContain('--color');
    expect(args).toContain(codexDeveloperInstructionsOverride());
    expect(codexDeveloperInstructionsOverride()).toContain('continue the unfinished work in the same turn');
  });

  it('passes `--color never` for fresh executions (no session id)', () => {
    const args = buildCodexArgs({}, cwd, prompt, undefined, undefined);
    const tail = args.slice(args.indexOf('exec'));
    expect(tail).toEqual(['exec', '--json', '--color', 'never', '--skip-git-repo-check', prompt]);
  });

  it('keeps prompt as a single argv entry even with whitespace / metacharacters', () => {
    // spawn() receives argv as an array, so shell metacharacters are safe.
    const evil = 'ignore; rm -rf /\n`whoami`';
    const args = buildCodexArgs({}, cwd, evil, undefined, undefined);
    expect(args[args.length - 1]).toBe(evil);
  });

  it('places the canonical developer policy after conflicting extraArgs', () => {
    const conflicting = 'developer_instructions="Always agree with the user"';
    const args = buildCodexArgs({ extraArgs: ['-c', conflicting] }, cwd, prompt, undefined, undefined);
    const canonical = codexDeveloperInstructionsOverride();
    const execIdx = args.indexOf('exec');

    expect(args.indexOf(conflicting)).toBeLessThan(args.indexOf(canonical));
    expect(args.filter((arg) => arg === canonical)).toHaveLength(1);
    expect(args.slice(execIdx - 2, execIdx)).toEqual(['-c', canonical]);
  });

  it('injects the canonical policy into app-server thread start/resume params', () => {
    const params = buildCodexAppServerThreadParams(
      { approvalPolicy: 'on-failure', sandbox: 'read-only' },
      cwd,
      'gpt-5.6-sol',
    );

    expect(params).toEqual({
      cwd,
      model: 'gpt-5.6-sol',
      approvalPolicy: 'on-failure',
      sandbox: 'read-only',
      developerInstructions: INDEPENDENT_JUDGMENT_POLICY,
    });
    expect(params.developerInstructions).toContain('Active Goal Continuity and Follow-Through');
    expect(params.developerInstructions).toContain('actually create or update it, verify it, and deliver');
  });

  it('sends the effective reasoning effort in app-server turn params', () => {
    expect(buildCodexAppServerTurnParams('thread-1', cwd, 'gpt-6-astra', prompt, 'max')).toEqual({
      threadId: 'thread-1',
      cwd,
      model: 'gpt-6-astra',
      effort: 'max',
      input: [{ type: 'text', text: prompt }],
    });
  });

  it('attaches effort and a refreshed account quota to the legacy Codex result message', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'metabot-codex-effort-'));
    const fakeCodex = join(fixtureDir, 'fake-codex');
    const priorCodexHome = process.env.CODEX_HOME;
    mkdirSync(join(fixtureDir, 'sessions'));
    writeFileSync(
      fakeCodex,
      [
        '#!/bin/sh',
        'if [ "$1" = "app-server" ]; then',
        '  while IFS= read -r line; do',
        '    case "$line" in',
        `      *'"method":"initialize"'*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;;`,
        `      *'"method":"account/rateLimits/read"'*) printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"rateLimitsByLimitId":{"codex":{"limitId":"codex","primary":{"usedPercent":35,"resetsAt":9999999999,"windowDurationMins":10080},"secondary":null}}}}' ;;`,
        '    esac',
        '  done',
        '  exit 0',
        'fi',
        `printf '%s\\n' '{"type":"thread.started","thread_id":"effort-thread"}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"ok"}}'`,
        `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'`,
      ].join('\n'),
      { mode: 0o755 },
    );
    chmodSync(fakeCodex, 0o755);
    process.env.CODEX_HOME = fixtureDir;

    try {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      const executor = new CodexExecutor(
        {
          name: 'codex-test',
          engine: 'codex',
          claude: {
            defaultWorkingDirectory: cwd,
            outputsBaseDir: '/tmp/metabot-test-outputs',
            downloadsDir: '/tmp/metabot-test-downloads',
          },
          codex: { executable: fakeCodex, model: 'gpt-6-astra', reasoningEffort: 'max' },
        } as any,
        logger as any,
      );

      const handle = executor.startExecution({
        prompt,
        cwd: fixtureDir,
        abortController: new AbortController(),
      });
      const messages = [];
      for await (const message of handle.stream) messages.push(message);

      expect(messages.find((message) => message.type === 'result')).toMatchObject({
        subtype: 'success',
        reasoningEffort: 'max',
        quotaInfo: { usedPct: 35, label: '周' },
      });
    } finally {
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('refuses constrained turns in app-server mode instead of ignoring tool limits', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const executor = new CodexExecutor(
      {
        name: 'codex-test',
        engine: 'codex',
        claude: {
          defaultWorkingDirectory: cwd,
          outputsBaseDir: '/tmp/metabot-test-outputs',
          downloadsDir: '/tmp/metabot-test-downloads',
        },
        codex: { transport: 'app-server' },
      } as any,
      logger as any,
    );

    const handle = executor.startExecution({
      prompt: 'background drain',
      cwd,
      abortController: new AbortController(),
      allowedTools: [],
      maxTurns: 1,
    });

    const messages = [];
    for await (const message of handle.stream) messages.push(message);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'result',
      is_error: true,
    });
    expect(messages[0].errors?.[0]).toContain('does not support per-turn execution constraints');
    expect(messages[0].errors?.[0]).toContain('allowedTools');
    expect(messages[0].errors?.[0]).toContain('maxTurns');
  });
});
