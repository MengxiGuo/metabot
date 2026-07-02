import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { BotConfigBase, GeminiBotConfig } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type {
  ApiContext,
  ExecutionHandle,
  ExecutorOptions,
  SDKMessage,
} from '../claude/executor.js';
import {
  createGeminiTranslatorState,
  translateGeminiJsonEvent,
  type GeminiJsonEvent,
} from './jsonl-translator.js';
import { fetchGeminiQuota } from './quota-fetcher.js';

const isWindows = process.platform === 'win32';

function resolveGeminiPath(): string {
  if (process.env.GEMINI_EXECUTABLE_PATH) return process.env.GEMINI_EXECUTABLE_PATH;
  try {
    const cmd = isWindows ? 'where gemini' : 'which gemini';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    return isWindows ? 'gemini' : '/usr/local/bin/gemini';
  }
}

const GEMINI_EXECUTABLE = resolveGeminiPath();

/**
 * Build argv for `gemini -p ...` non-interactive mode.
 * Exported for unit testing.
 */
export function buildGeminiArgs(
  geminiConfig: GeminiBotConfig,
  prompt: string,
  model: string | undefined,
  sessionId: string | undefined,
  resume: boolean,
  includeDirs?: string[],
): string[] {
  const args: string[] = [];

  args.push('--skip-trust');
  args.push('--approval-mode', geminiConfig.approvalMode ?? 'yolo');
  args.push('-o', 'stream-json');

  if (model) args.push('-m', model);

  // gemini-cli's --resume takes "latest"|<index>, not UUID. For cross-turn
  // continuity in a chat we use a two-phase contract:
  //   first call:       --session-id <UUID>   (creates a fresh session)
  //   subsequent calls: --resume latest       (picks up the most recent
  //                                            session in this project)
  // gemini-cli scopes sessions per-project (cwd). To isolate sessions across
  // Feishu chats we spawn each chat in its own cwd; see startExecution().
  if (resume) {
    args.push('--resume', 'latest');
  } else if (sessionId) {
    args.push('--session-id', sessionId);
  }

  if (includeDirs && includeDirs.length > 0) {
    args.push('--include-directories', includeDirs.join(','));
  }

  for (const extra of geminiConfig.extraArgs ?? []) args.push(extra);

  args.push('-p', prompt);
  return args;
}

const QUOTA_REGEX = /exhausted your capacity|RESOURCE_EXHAUSTED|quota.{0,30}(exceeded|exhausted)/i;

// 2.5 Pro shares the same AI Pro quota pool as 3.1 Pro, so it has no fallback
// value — Flash is on a separate pool. Keep the chain minimal.
const DEFAULT_FALLBACK_CHAIN = [
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
];

type AttemptOutcome =
  | { kind: 'completed'; messages: SDKMessage[] }
  | { kind: 'quota_exhausted'; detail: string }
  | { kind: 'error'; message: string; messages: SDKMessage[] };

export class GeminiExecutor {
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const { prompt, cwd: projectCwd, sessionId, abortController, outputsDir, apiContext } = options;
    const geminiConfig = this.config.gemini ?? {};

    const chatKey = apiContext?.chatId?.replace(/[^a-zA-Z0-9_-]/g, '_');
    const cwd = chatKey ? `/tmp/metabot-gemini/${chatKey}` : projectCwd;
    const includeDirs = cwd !== projectCwd ? [projectCwd] : undefined;
    if (cwd !== projectCwd) {
      try { mkdirSync(cwd, { recursive: true }); } catch { /* ignore EEXIST */ }
    }

    const fullPrompt = this.buildPromptWithContext(prompt, outputsDir, apiContext, includeDirs?.[0]);
    const queue = new AsyncQueue<SDKMessage>();
    const startTime = Date.now();

    // Build model chain: user-specified `options.model` disables fallback (single-element chain).
    // Otherwise use DEFAULT_FALLBACK_CHAIN (3.1 Pro → 2.5 Pro → 3 Flash), prepending bot-default
    // if it's not already there so per-bot config still wins as the primary.
    const userSpecifiedModel = options.model;
    const botDefault = geminiConfig.model;
    let chain: string[];
    if (userSpecifiedModel) {
      chain = [userSpecifiedModel];
    } else {
      const head = botDefault && !DEFAULT_FALLBACK_CHAIN.includes(botDefault)
        ? [botDefault, ...DEFAULT_FALLBACK_CHAIN]
        : DEFAULT_FALLBACK_CHAIN;
      chain = [...new Set(head)];
    }

    const runState: { currentChild?: ChildProcess } = {};

    if (abortController.signal.aborted) {
      queue.finish();
    } else {
      abortController.signal.addEventListener('abort', () => {
        if (runState.currentChild && !runState.currentChild.killed) {
          runState.currentChild.kill('SIGTERM');
        }
      }, { once: true });
      void this.runChain(chain, {
        geminiConfig, fullPrompt, sessionId, cwd, includeDirs, abortController, queue,
        startTime, runState,
      });
    }

    return {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      sendAnswer: (_toolUseId: string, _sid: string, _answerText: string) => {
        this.logger.warn({ engine: 'gemini' }, 'sendAnswer called on Gemini executor — not implemented');
      },
      resolveQuestion: (_toolUseId: string, _answers: Record<string, string>) => {
        this.logger.warn({ engine: 'gemini' }, 'resolveQuestion called on Gemini executor — not implemented');
      },
      finish: () => {
        if (runState.currentChild && !runState.currentChild.killed) {
          runState.currentChild.kill('SIGTERM');
        }
        queue.finish();
      },
    };
  }

  private async runChain(
    chain: string[],
    ctx: {
      geminiConfig: GeminiBotConfig;
      fullPrompt: string;
      sessionId: string | undefined;
      cwd: string;
      includeDirs: string[] | undefined;
      abortController: AbortController;
      queue: AsyncQueue<SDKMessage>;
      startTime: number;
      runState: { currentChild?: ChildProcess };
    },
  ): Promise<void> {
    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      const isLast = i === chain.length - 1;
      const isFallback = i > 0;
      const outcome = await this.attemptModel(model, ctx, isFallback);

      if (outcome.kind === 'completed') {
        for (const m of outcome.messages) ctx.queue.enqueue(m);
        break;
      }

      if (outcome.kind === 'quota_exhausted' && !isLast) {
        const next = chain[i + 1];
        this.logger.warn(
          { engine: 'gemini', failedModel: model, fallbackModel: next, detail: outcome.detail },
          'Gemini quota exhausted, falling back to next model in chain',
        );
        ctx.queue.enqueue({
          type: 'assistant',
          session_id: ctx.sessionId,
          message: {
            content: [{ type: 'text', text: `🔁 \`${model}\` quota 满, 切换到 \`${next}\` 重试...` }],
          },
        } as SDKMessage);
        continue;
      }

      // Unrecoverable (final attempt, or non-quota error)
      if (outcome.kind === 'error') {
        for (const m of outcome.messages) ctx.queue.enqueue(m);
      }
      const message = outcome.kind === 'quota_exhausted'
        ? `All Gemini models in fallback chain exhausted (last: ${model}). Quota detail: ${outcome.detail}`
        : outcome.message;
      ctx.queue.enqueue({
        type: 'result',
        subtype: ctx.abortController.signal.aborted ? 'error_cancelled' : 'error_during_execution',
        session_id: ctx.sessionId ?? '',
        duration_ms: Date.now() - ctx.startTime,
        result: '',
        is_error: true,
        errors: [message],
      });
      break;
    }
    ctx.queue.finish();
  }

  private attemptModel(
    model: string,
    ctx: {
      geminiConfig: GeminiBotConfig;
      fullPrompt: string;
      sessionId: string | undefined;
      cwd: string;
      includeDirs: string[] | undefined;
      abortController: AbortController;
      queue: AsyncQueue<SDKMessage>;
      startTime: number;
      runState: { currentChild?: ChildProcess };
    },
    isFallback: boolean,
  ): Promise<AttemptOutcome> {
    return new Promise<AttemptOutcome>((resolve) => {
      const { geminiConfig, fullPrompt, sessionId, cwd, includeDirs } = ctx;
      const state = createGeminiTranslatorState({
        model: model || geminiConfig.displayModel,
        contextWindow: geminiConfig.contextWindow ?? 1_048_576,
      });
      // Fallback attempts skip --resume to avoid hanging when prior model's
      // session history (thinking blocks, etc.) is incompatible with the
      // fallback model. fullPrompt already contains the user's request.
      const resumeFlag = isFallback ? false : !!sessionId;
      const sessionIdFlag = isFallback ? undefined : sessionId;
      const args = buildGeminiArgs(geminiConfig, fullPrompt, model, sessionIdFlag, resumeFlag, includeDirs);
      let child: ChildProcess | undefined;
      let sawResult = false;
      let stderr = '';
      let stdoutBuffer = '';
      const pending: SDKMessage[] = [];

      this.logger.info({ cwd, hasSession: !!sessionId, engine: 'gemini', model }, 'Starting Gemini execution');

      const emitEvent = (event: GeminiJsonEvent): void => {
        const messages = translateGeminiJsonEvent(event, state);
        for (const message of messages) {
          if (message.type === 'result') sawResult = true;
          pending.push(message);
        }
      };

      const processStdout = (chunk: Buffer): void => {
        stdoutBuffer += chunk.toString('utf-8');
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (!trimmed.startsWith('{')) {
            this.logger.debug({ line: trimmed }, 'Gemini stdout (non-JSON)');
            continue;
          }
          try {
            emitEvent(JSON.parse(trimmed) as GeminiJsonEvent);
          } catch (err) {
            this.logger.warn({ err, line: trimmed }, 'Failed to parse Gemini JSONL event');
          }
        }
      };

      try {
        child = spawn(geminiConfig.executable || GEMINI_EXECUTABLE, args, {
          cwd,
          env: {
            ...process.env,
            NO_BROWSER: '1',
            GEMINI_CLI_TRUST_WORKSPACE: 'true',
            // Tag outgoing `mb talk` calls with this bot's identity so the
            // bridge can post the prompt as a visible card from this bot.
            MB_CALLER_BOT: this.config.name,
            ...(geminiConfig.env ?? {}),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        resolve({ kind: 'error', message: err?.message || String(err), messages: pending });
        return;
      }

      ctx.runState.currentChild = child;

      child.stdout?.on('data', processStdout);
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      child.on('error', (err) => {
        resolve({ kind: 'error', message: err.message, messages: pending });
      });
      child.on('close', (code, signal) => {
        if (stdoutBuffer.trim()) {
          const trimmed = stdoutBuffer.trim();
          if (trimmed.startsWith('{')) {
            try { emitEvent(JSON.parse(trimmed) as GeminiJsonEvent); }
            catch (err) { this.logger.warn({ err, line: trimmed }, 'Failed to parse final Gemini JSONL event'); }
          }
        }
        if (stderr.trim()) {
          this.logger.debug({ stderr: stderr.trim() }, 'Gemini stderr');
        }
        const errorTextFromPending = pending
          .filter((m) => m.is_error && m.errors)
          .flatMap((m) => m.errors ?? [])
          .join('\n');
        const combined = `${stderr}\n${state.lastAgentText ?? ''}\n${errorTextFromPending}`;
        const quotaMatch = QUOTA_REGEX.exec(combined);
        if (quotaMatch) {
          resolve({ kind: 'quota_exhausted', detail: quotaMatch[0] });
          return;
        }
        if (code !== 0 && !sawResult) {
          const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
          resolve({
            kind: 'error',
            message: `Gemini exited with ${signal ? `signal ${signal}` : `code ${code}`}${suffix}`,
            messages: pending,
          });
          return;
        }
        // Successful completion — fetch quota and attach quotaInfo to the
        // result SDKMessage. Bridge stream-processor reads quotaInfo and
        // surfaces it in the card footer (replacing the $-cost slot, since
        // Gemini AI Pro is flat-tier and $cost is always 0). Non-blocking.
        void (async () => {
          try {
            const buckets = await fetchGeminiQuota();
            const resultMsg = pending.find((m) => m.type === 'result' && !m.is_error);
            if (resultMsg && buckets && state.model) {
              // Match strategy: exact modelId first; fall back to substring
              // both ways (gemini-cli versions sometimes report a normalized
              // id like 'gemini-3-pro' while the quota API returns the full
              // 'gemini-3.1-pro-preview', or vice versa).
              let bucket = buckets.find((b) => b.modelId === state.model);
              let matchKind: 'exact' | 'substring' | 'none' = bucket ? 'exact' : 'none';
              if (!bucket) {
                bucket = buckets.find(
                  (b) =>
                    typeof b.modelId === 'string' &&
                    (b.modelId.includes(state.model!) || state.model!.includes(b.modelId)),
                );
                if (bucket) matchKind = 'substring';
              }
              if (!bucket) {
                // Surface this so users debugging a missing footer can see
                // exactly why the match failed (no buckets vs. id mismatch).
                this.logger.warn(
                  {
                    stateModel: state.model,
                    bucketModels: buckets.map((b) => b.modelId),
                  },
                  'Gemini quota: no bucket matched state.model — footer will omit quota',
                );
              } else {
                this.logger.debug(
                  { stateModel: state.model, matchedBucket: bucket.modelId, matchKind },
                  'Gemini quota match',
                );
              }
              if (bucket && typeof bucket.remainingFraction === 'number') {
                const usedPct = (1 - bucket.remainingFraction) * 100;
                const hoursToReset = bucket.resetTime
                  ? Math.max(0, (new Date(bucket.resetTime).getTime() - Date.now()) / 3_600_000)
                  : 0;
                resultMsg.quotaInfo = {
                  usedPct: Math.round(usedPct * 10) / 10,
                  hoursToReset: Math.round(hoursToReset * 10) / 10,
                };
              }
            }
          } catch (err: any) {
            this.logger.warn({ err: err?.message }, 'Gemini quota fetch failed (non-fatal, footer will omit quota)');
          }
          resolve({ kind: 'completed', messages: pending });
        })();
      });
    });
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
    projectDir?: string,
  ): string {
    const sections: string[] = [];

    if (projectDir) {
      sections.push(
        `## Project Directory\nYour project files live at: ${projectDir}\nUse this absolute path when reading or writing project files. Your shell cwd is an isolated workspace for this chat's session; the project itself is at the path above.`,
      );
    }

    if (outputsDir) {
      sections.push(
        `## Output Files\nWhen producing output files for the user (images, PDFs, documents, archives, code files, etc.), copy them to: ${outputsDir}\nThe bridge will automatically send files placed there to the user.`,
      );
    }

    if (apiContext) {
      sections.push(
        `## MetaBot API\nYou are running as bot "${apiContext.botName}" in chat "${apiContext.chatId}".\nUse the /metabot skill for full API documentation (agent bus, scheduling, bot management).`,
      );

      // See claude/executor.ts for the two-mode rationale (web UI grouptalk
      // namespace vs Feishu real-chatId).
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
