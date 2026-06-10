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
    let child: ChildProcess | undefined;
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

    const processStdout = (chunk: Buffer): void => {
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
      if (abortController.signal.aborted) {
        child.kill('SIGTERM');
      } else {
        abortController.signal.addEventListener('abort', () => child?.kill('SIGTERM'), { once: true });
      }

      child.stdout?.on('data', processStdout);
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (err) => {
        finishWithError(err.message);
        queue.finish();
      });
      child.on('close', (code, signal) => {
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
      sendAnswer: (_toolUseId: string, _sid: string, _answerText: string) => {
        this.logger.warn({ engine: 'codex' }, 'sendAnswer called on Codex executor — not implemented');
      },
      resolveQuestion: (_toolUseId: string, _answers: Record<string, string>) => {
        this.logger.warn({ engine: 'codex' }, 'resolveQuestion called on Codex executor — not implemented');
      },
      finish: () => {
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
