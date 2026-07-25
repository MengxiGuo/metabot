import { execSync, spawn, type ChildProcess } from 'node:child_process';
import type { BotConfigBase, CodexBotConfig } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type {
  ApiContext,
  ExecutionHandle,
  ExecutorOptions,
  SDKMessage,
} from '../claude/executor.js';
import {
  createCodexTranslatorState,
  translateCodexJsonEvent,
  type CodexJsonEvent,
} from './jsonl-translator.js';
import { readCodexSessionStatus } from './quota-reader.js';
import { CodexAppServerClient, codexAppServerEnabled } from './app-server-client.js';
import {
  buildCodexAppServerGoalProgressMessage,
  createCodexAppServerTranslatorState,
  enableCodexAppServerGoalOperation,
  translateCodexAppServerNotification,
} from './app-server-translator.js';
import type { CodexGoal } from './goal.js';

const isWindows = process.platform === 'win32';

function resolveCodexPath(): string {
  if (process.env.CODEX_EXECUTABLE_PATH) return process.env.CODEX_EXECUTABLE_PATH;
  try {
    const cmd = isWindows ? 'where codex' : 'which codex';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    return isWindows ? 'codex' : '/usr/local/bin/codex';
  }
}

const CODEX_EXECUTABLE = resolveCodexPath();

function readAppServerTurnId(params: Record<string, unknown> | undefined): string | undefined {
  const turn = params?.turn;
  if (!turn || typeof turn !== 'object') return undefined;
  const id = (turn as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Build the argv array for `codex exec`. Exported for unit testing.
 * Values are passed as discrete argv entries (never through a shell), so
 * `extraArgs` / `profile` / `model` cannot introduce shell-injection even
 * if they contain metacharacters — but they will still be visible to the
 * Codex CLI as literal arguments.
 */
export function buildCodexArgs(
  codexConfig: CodexBotConfig,
  cwd: string,
  prompt: string,
  sessionId: string | undefined,
  model: string | undefined,
): string[] {
  const args: string[] = [];

  if (codexConfig.dangerouslyBypassApprovalsAndSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('-a', codexConfig.approvalPolicy ?? 'never');
    args.push('--sandbox', codexConfig.sandbox ?? 'workspace-write');
  }

  args.push('-C', cwd);
  if (model) args.push('-m', model);
  if (codexConfig.profile) args.push('-p', codexConfig.profile);
  for (const extraArg of codexConfig.extraArgs ?? []) args.push(extraArg);

  args.push('exec');
  if (sessionId) {
    args.push('resume', '--json', '--skip-git-repo-check', sessionId, prompt);
  } else {
    args.push('--json', '--color', 'never', '--skip-git-repo-check', prompt);
  }
  return args;
}

export class CodexExecutor {
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  startExecution(options: ExecutorOptions): ExecutionHandle {
    if (codexAppServerEnabled(this.config.codex)) {
      const unsupportedConstraint = this.getUnsupportedAppServerConstraint(options);
      if (unsupportedConstraint) {
        return this.startImmediateErrorExecution(unsupportedConstraint, options.sessionId, options.abortController);
      }
      return this.startAppServerExecution(options);
    }

    const { prompt, cwd, sessionId, abortController, outputsDir, apiContext } = options;
    const codexConfig = this.config.codex ?? {};
    const model = options.model ?? codexConfig.model;
    const fullPrompt = this.buildPromptWithContext(prompt, outputsDir, apiContext);
    const queue = new AsyncQueue<SDKMessage>();
    const state = createCodexTranslatorState({
      model: model || codexConfig.displayModel,
      contextWindow: codexConfig.contextWindow,
    });
    const args = buildCodexArgs(codexConfig, cwd, fullPrompt, sessionId, model);
    const startTime = Date.now();
    let lastActivityAt = startTime;
    let lastActivityMessageAt = 0;
    let child: ChildProcess | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let sawResult = false;
    let stderr = '';
    let stdoutBuffer = '';
    // Success result is held back (not enqueued live) so the close handler can
    // enrich it with account quota read from the session rollout file — the
    // quota is not present in the `exec --json` stdout stream.
    let pendingResult: SDKMessage | undefined;

    this.logger.info({ cwd, hasSession: !!sessionId, outputsDir, engine: 'codex' }, 'Starting Codex execution');

    const finishWithError = (message: string): void => {
      if (sawResult) return;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      sawResult = true;
      queue.enqueue({
        type: 'result',
        subtype: abortController.signal.aborted ? 'error_cancelled' : 'error_during_execution',
        session_id: state.sessionId ?? sessionId,
        duration_ms: Date.now() - startTime,
        result: state.lastAgentText,
        is_error: true,
        errors: [message],
      });
    };

    const emitEvent = (event: CodexJsonEvent): void => {
      const messages = translateCodexJsonEvent(event, state);
      for (const message of messages) {
        if (message.type === 'result' && !message.is_error) {
          // Hold the success result; close handler enriches + enqueues it.
          sawResult = true;
          pendingResult = message;
        } else {
          queue.enqueue(message);
        }
      }
    };

    const recordProcessActivity = (): void => {
      lastActivityAt = Date.now();
      // Surface a quiet heartbeat so a long-running goal is shown as Running
      // even when its raw Codex event type is intentionally not translated.
      // Throttling avoids card-update churn during commands with heavy output.
      if (lastActivityAt - lastActivityMessageAt >= 15_000) {
        lastActivityMessageAt = lastActivityAt;
        queue.enqueue({
          type: 'engine_activity',
          session_id: state.sessionId ?? sessionId,
          duration_ms: lastActivityAt - startTime,
        });
      }
    };

    const processStdout = (chunk: Buffer): void => {
      recordProcessActivity();
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          emitEvent(JSON.parse(line) as CodexJsonEvent);
        } catch (err) {
          this.logger.warn({ err, line }, 'Failed to parse Codex JSONL event');
        }
      }
    };

    try {
      child = spawn(codexConfig.executable || CODEX_EXECUTABLE, args, {
        cwd,
        env: {
          ...process.env,
          // Tag outgoing `mb talk` calls with this bot's identity so the
          // bridge can post the prompt as a visible card from this bot.
          MB_CALLER_BOT: this.config.name,
          ...(codexConfig.env ?? {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      finishWithError(err?.message || String(err));
      queue.finish();
    }

    if (child) {
      heartbeatTimer = setInterval(() => {
        queue.enqueue({
          type: 'engine_heartbeat',
          session_id: state.sessionId ?? sessionId,
          duration_ms: Date.now() - startTime,
        });
      }, 60_000);
      heartbeatTimer.unref();

      if (abortController.signal.aborted) {
        child.kill('SIGTERM');
      } else {
        abortController.signal.addEventListener('abort', () => child?.kill('SIGTERM'), { once: true });
      }

      child.stdout?.on('data', processStdout);
      child.stderr?.on('data', (chunk: Buffer) => {
        recordProcessActivity();
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (err) => {
        finishWithError(err.message);
        queue.finish();
      });
      child.on('close', (code, signal) => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (stdoutBuffer.trim()) {
          try {
            emitEvent(JSON.parse(stdoutBuffer) as CodexJsonEvent);
          } catch (err) {
            this.logger.warn({ err, line: stdoutBuffer }, 'Failed to parse final Codex JSONL event');
          }
        }
        if (code !== 0 && !sawResult) {
          const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
          finishWithError(`Codex exited with ${signal ? `signal ${signal}` : `code ${code}`}${suffix}`);
        }
        // Enrich the held success result with account-level quota and the
        // correct context occupation, then emit it. The stdout `usage` is the
        // cumulative session total; we override with last_token_usage so the
        // ctx footer reflects current occupation (and tracks compaction).
        if (pendingResult) {
          try {
            const status = readCodexSessionStatus(state.sessionId ?? sessionId);
            if (status?.quota?.primary) {
              pendingResult.quotaInfo = {
                usedPct: status.quota.primary.usedPct,
                hoursToReset: status.quota.primary.hoursToReset,
                secondary: status.quota.secondary,
              };
            }
            const mu = state.model ? pendingResult.modelUsage?.[state.model] : undefined;
            if (mu && status?.lastTurnInputTokens !== undefined) {
              mu.inputTokens = status.lastTurnInputTokens;
              mu.outputTokens = status.lastTurnOutputTokens ?? 0;
              if (status.contextWindow) mu.contextWindow = status.contextWindow;
            }
          } catch (err) {
            this.logger.warn({ err }, 'Codex session status read failed (non-fatal, footer degraded)');
          }
          queue.enqueue(pendingResult);
          pendingResult = undefined;
        }
        if (stderr.trim()) {
          this.logger.debug({ stderr: stderr.trim() }, 'Codex stderr');
        }
        queue.finish();
      });
    }

    return {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      getLastActivityAt: () => lastActivityAt,
      sendAnswer: (_toolUseId: string, _sid: string, _answerText: string) => {
        this.logger.warn({ engine: 'codex' }, 'sendAnswer called on Codex executor — not implemented');
      },
      resolveQuestion: (_toolUseId: string, _answers: Record<string, string>) => {
        this.logger.warn({ engine: 'codex' }, 'resolveQuestion called on Codex executor — not implemented');
      },
      finish: () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (child && !child.killed) child.kill('SIGTERM');
        queue.finish();
      },
    };
  }

  async *execute(options: ExecutorOptions): AsyncGenerator<SDKMessage> {
    const handle = this.startExecution(options);
    try {
      for await (const msg of handle.stream) {
        yield msg;
      }
    } finally {
      handle.finish();
    }
  }

  private getUnsupportedAppServerConstraint(options: ExecutorOptions): string | null {
    const constraints: string[] = [];
    if (options.allowedTools !== undefined) constraints.push('allowedTools');
    if (options.maxTurns !== undefined) constraints.push('maxTurns');
    if (constraints.length === 0) return null;
    return [
      `Codex app-server transport does not support per-turn execution constraints: ${constraints.join(', ')}.`,
      'Refusing to run because ignoring these constraints could enable tools or extra turns unexpectedly.',
    ].join(' ');
  }

  private startImmediateErrorExecution(
    message: string,
    sessionId: string | undefined,
    abortController: AbortController,
  ): ExecutionHandle {
    const queue = new AsyncQueue<SDKMessage>();
    queue.enqueue({
      type: 'result',
      subtype: abortController.signal.aborted ? 'error_cancelled' : 'error_during_execution',
      session_id: sessionId,
      duration_ms: 0,
      result: '',
      is_error: true,
      errors: [message],
    });
    queue.finish();
    return {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      sendAnswer: () => undefined,
      resolveQuestion: () => undefined,
      finish: () => queue.finish(),
    };
  }

  private startAppServerExecution(options: ExecutorOptions): ExecutionHandle {
    const { prompt, cwd, sessionId, abortController, outputsDir, apiContext } = options;
    const codexConfig = this.config.codex ?? {};
    const model = options.model ?? codexConfig.model;
    const fullPrompt = this.buildPromptWithContext(prompt, outputsDir, apiContext);
    const goalObjective = options.codexGoal
      ? this.buildPromptWithContext(options.codexGoal.objective, outputsDir, apiContext)
      : undefined;
    const queue = new AsyncQueue<SDKMessage>();
    const state = createCodexAppServerTranslatorState({
      model: model || codexConfig.displayModel,
      contextWindow: codexConfig.contextWindow,
    });
    if (options.codexGoal) enableCodexAppServerGoalOperation(state);
    const client = new CodexAppServerClient({
      codexConfig,
      logger: this.logger,
      botName: this.config.name,
    });
    let activeThreadId = sessionId;
    let activeTurnId: string | undefined;
    let finished = false;
    let initEmitted = false;
    let goalStartResolve: ((turnId: string) => void) | undefined;

    this.logger.info({ cwd, hasSession: !!sessionId, outputsDir, engine: 'codex', transport: 'app-server' }, 'Starting Codex app-server execution');

    const finishWithError = (message: string): void => {
      if (finished) return;
      finished = true;
      queue.enqueue({
        type: 'result',
        subtype: abortController.signal.aborted ? 'error_cancelled' : 'error_during_execution',
        session_id: state.threadId ?? activeThreadId ?? sessionId,
        duration_ms: Date.now() - state.startTime,
        result: state.lastAgentText,
        is_error: true,
        errors: [message],
      });
      queue.finish();
      client.close();
    };

    client.onNotification((notification) => {
      if (abortController.signal.aborted || finished) return;
      if (notification.method === 'turn/started') {
        const turnId = readAppServerTurnId(notification.params);
        if (turnId) {
          activeTurnId = turnId;
          goalStartResolve?.(turnId);
          goalStartResolve = undefined;
        }
      }
      const messages = translateCodexAppServerNotification(notification, state);
      for (const message of messages) {
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          if (initEmitted) continue;
          initEmitted = true;
          activeThreadId = message.session_id;
        }
        if (message.type === 'result') {
          queue.enqueue(this.enrichAppServerResult(message, state.threadId ?? activeThreadId, codexConfig, state.model));
        } else {
          queue.enqueue(message);
        }
        if (message.type === 'result') {
          finished = true;
          queue.finish();
          client.close();
          return;
        }
      }
    });

    client.onClose((err) => {
      if (finished) return;
      if (err) finishWithError(err.message);
      else finishWithError('Codex app-server ended before the turn completed');
    });

    const threadParams = (): Record<string, unknown> => ({
      cwd,
      ...(model ? { model } : {}),
      approvalPolicy: codexConfig.dangerouslyBypassApprovalsAndSandbox
        ? 'never'
        : (codexConfig.approvalPolicy ?? 'never'),
      sandbox: codexConfig.dangerouslyBypassApprovalsAndSandbox
        ? 'danger-full-access'
        : (codexConfig.sandbox ?? 'workspace-write'),
    });

    const run = async (): Promise<void> => {
      await client.start();

      if (abortController.signal.aborted) {
        finishWithError('Task was stopped');
        return;
      }

      if (activeThreadId) {
        try {
          await client.request('thread/resume', {
            ...threadParams(),
            threadId: activeThreadId,
            excludeTurns: true,
          }, 30_000);
          state.threadId = activeThreadId;
          if (!initEmitted) {
            initEmitted = true;
            queue.enqueue({ type: 'system', subtype: 'init', session_id: activeThreadId });
          }
        } catch (err) {
          this.logger.warn(
            { err, threadId: activeThreadId },
            'Codex app-server resume failed; starting a fresh thread',
          );
          activeThreadId = undefined;
          state.threadId = undefined;
        }
      }

      if (!activeThreadId) {
        const started = await client.request<{ thread: { id: string } }>('thread/start', threadParams(), 30_000);
        activeThreadId = started.thread.id;
        state.threadId = activeThreadId;
        if (!initEmitted) {
          initEmitted = true;
          queue.enqueue({ type: 'system', subtype: 'init', session_id: activeThreadId });
        }
      }

      try {
        const result = await client.request<{ goal?: typeof state.goal }>('thread/goal/get', {
          threadId: activeThreadId,
        }, 15_000);
        state.goal = result.goal ?? null;
        state.goalObservedAt = Date.now();
        const progress = buildCodexAppServerGoalProgressMessage(state, 'goal loaded');
        if (progress) queue.enqueue(progress);
      } catch (err) {
        this.logger.debug({ err, threadId: activeThreadId }, 'Codex app-server goal read failed; continuing without goal progress card');
      }

      if (options.codexGoal && goalObjective) {
        await this.startOfficialGoalOperation({
          client,
          threadId: activeThreadId,
          objective: goalObjective,
          tokenBudget: options.codexGoal.tokenBudget,
          onGoalSet: (goal) => {
            state.goal = goal;
            state.goalObservedAt = Date.now();
            const progress = buildCodexAppServerGoalProgressMessage(state, 'goal active');
            if (progress) queue.enqueue(progress);
          },
          waitForStart: () => new Promise<string>((resolve, reject) => {
            if (activeTurnId) {
              resolve(activeTurnId);
              return;
            }
            const timer = setTimeout(() => {
              goalStartResolve = undefined;
              reject(new Error('Timed out waiting for Codex goal runtime-generated first turn'));
            }, 30_000);
            goalStartResolve = (turnId: string) => {
              clearTimeout(timer);
              resolve(turnId);
            };
          }),
        });
        return;
      }

      const turn = await client.request<{ turn: { id: string } }>('turn/start', {
        threadId: activeThreadId,
        cwd,
        ...(model ? { model } : {}),
        input: [{ type: 'text', text: fullPrompt }],
      }, 30_000);
      activeTurnId = turn.turn.id;
    };

    run().catch((err) => {
      finishWithError(err instanceof Error ? err.message : String(err));
    });

    const finish = (): void => {
      if (finished) return;
      if (activeThreadId && client.isInitialized()) {
        if (options.codexGoal) {
          client.request('thread/goal/set', { threadId: activeThreadId, status: 'paused' }, 5_000)
            .catch((err) => this.logger.debug({ err }, 'Codex app-server goal pause failed'));
        }
        if (activeTurnId) {
          client.request('turn/interrupt', { threadId: activeThreadId, turnId: activeTurnId }, 5_000)
            .catch((err) => this.logger.debug({ err }, 'Codex app-server turn interrupt failed'));
        }
      }
      finishWithError('Task was stopped');
    };

    if (abortController.signal.aborted) {
      finish();
    } else {
      abortController.signal.addEventListener('abort', finish, { once: true });
    }

    return {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      sendAnswer: (_toolUseId: string, _sid: string, _answerText: string) => {
        this.logger.warn({ engine: 'codex', transport: 'app-server' }, 'sendAnswer called on Codex app-server executor — not implemented');
        finishWithError('Codex app-server interactive answers are not supported yet.');
      },
      resolveQuestion: (_toolUseId: string, _answers: Record<string, string>) => {
        this.logger.warn({ engine: 'codex', transport: 'app-server' }, 'resolveQuestion called on Codex app-server executor — not implemented');
        finishWithError('Codex app-server interactive questions are not supported yet.');
      },
      finish,
    };
  }

  private async startOfficialGoalOperation(opts: {
    client: CodexAppServerClient;
    threadId: string;
    objective: string;
    tokenBudget?: number | null;
    onGoalSet?: (goal: CodexGoal) => void;
    waitForStart: () => Promise<string>;
  }): Promise<void> {
    await opts.client.request('thread/goal/clear', { threadId: opts.threadId }, 15_000)
      .catch((err) => this.logger.debug({ err, threadId: opts.threadId }, 'Codex goal clear before replace failed; continuing with goal set'));
    const result = await opts.client.request<{ goal?: CodexGoal | null }>('thread/goal/set', {
      threadId: opts.threadId,
      objective: opts.objective,
      status: 'active',
      ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
    }, 15_000);
    if (result.goal) opts.onGoalSet?.(result.goal);
    await opts.waitForStart();
  }

  private enrichAppServerResult(
    message: SDKMessage,
    sessionId: string | undefined,
    codexConfig: CodexBotConfig,
    model: string | undefined,
  ): SDKMessage {
    try {
      const status = readCodexSessionStatus(sessionId);
      if (!message.quotaInfo && status?.quota?.primary) {
        message.quotaInfo = {
          usedPct: status.quota.primary.usedPct,
          hoursToReset: status.quota.primary.hoursToReset,
          secondary: status.quota.secondary,
        };
      }
      const modelName = model || codexConfig.model || codexConfig.displayModel;
      const mu = modelName ? message.modelUsage?.[modelName] : undefined;
      if (mu && status?.lastTurnInputTokens !== undefined) {
        mu.inputTokens = status.lastTurnInputTokens;
        mu.outputTokens = status.lastTurnOutputTokens ?? 0;
        if (status.contextWindow) mu.contextWindow = status.contextWindow;
      }
    } catch (err) {
      this.logger.warn({ err }, 'Codex app-server session status read failed (non-fatal, footer degraded)');
    }
    return message;
  }

  private buildPromptWithContext(
    prompt: string,
    outputsDir: string | undefined,
    apiContext: ApiContext | undefined,
  ): string {
    const sections: string[] = [];

    if (outputsDir) {
      sections.push(
        `## Output Files\nWhen producing output files for the user (images, PDFs, documents, archives, code files, etc.), copy them to: ${outputsDir}\nThe bridge will automatically send files placed there to the user.`,
      );
    }

    if (apiContext) {
      sections.push(
        `## MetaBot API\nYou are running as bot "${apiContext.botName}" in chat "${apiContext.chatId}".\nUse the /metabot skill for full API documentation (agent bus, scheduling, bot management).`,
      );

      // See claude/executor.ts for the two-mode rationale.
      if (apiContext.groupMembers && apiContext.groupMembers.length > 0) {
        const others = apiContext.groupMembers.filter((m) => m !== apiContext.botName);
        const groupId = apiContext.groupId;
        if (groupId && groupId !== apiContext.chatId) {
          sections.push(
            `## Group Chat\nYou are in a group chat (group: ${groupId}) with these bots: ${others.join(', ')}.\nTo talk to another bot, use: \`mb talk <botName> grouptalk-${groupId}-<botName> "message"\``,
          );
        } else if (others.length > 0) {
          sections.push(
            `## Group Chat\nYou are in a Feishu group chat (chat: ${apiContext.chatId}) with these other bots: ${others.join(', ')}.\nTo talk to one of them with both your prompt and their reply visible in this group, use: \`mb talk <peerBot> ${apiContext.chatId} "<message>"\`\nIMPORTANT: Use the real chat id (${apiContext.chatId}), NOT a grouptalk- prefix.`,
          );
        }
      }
    }

    if (sections.length === 0) return prompt;
    return `${prompt}\n\n---\n\n${sections.join('\n\n')}`;
  }
}
