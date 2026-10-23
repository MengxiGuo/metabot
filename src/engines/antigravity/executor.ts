// Applied lessons: DELIVERY-CLOSURE-OUTCOME-035, GOAL-CONTINUITY-123,
// JUDGMENT-001, MEMORY-002, METABOT-RAW-LOG-SECRET-037,
// METABOT-SENSITIVE-CONFIG-036, REASONING-004.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { isAntigravityReasoningEffort, type AntigravityReasoningEffort, type AntigravityBotConfig, type BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import type { ApiContext, ExecutionHandle, ExecutorOptions, SDKMessage } from '../claude/executor.js';
import { INDEPENDENT_JUDGMENT_POLICY, INDEPENDENT_JUDGMENT_POLICY_VERSION } from '../shared/independent-judgment.js';
import {
  createAntigravityTranslatorState,
  translateAntigravityJsonEvent,
  type AntigravityJsonEvent,
} from './jsonl-translator.js';
import { resolveAntigravityAccount } from './account-config.js';
import { fetchAntigravityQuota, resolveAntigravityContextWindow } from './quota-reader.js';
import { isExplicitQuotaExhaustion, startQuotaFailover } from './quota-failover.js';

function resolveAntigravityPath(): string {
  if (process.env.ANTIGRAVITY_EXECUTABLE_PATH) return process.env.ANTIGRAVITY_EXECUTABLE_PATH;
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['agy'], {
      encoding: 'utf-8',
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return process.platform === 'win32' ? 'agy.exe' : path.join(os.homedir(), '.local', 'bin', 'agy');
  }
}

const ANTIGRAVITY_EXECUTABLE = resolveAntigravityPath();

export function buildAntigravityArgs(
  config: AntigravityBotConfig,
  prompt: string,
  model: string | undefined,
  conversationId: string | undefined,
  effortOverride?: AntigravityReasoningEffort,
): string[] {
  const args = ['--output-format', 'stream-json'];
  args.push('--print-timeout', config.printTimeout ?? '15m');
  if (config.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  } else if (config.sandbox !== false) {
    args.push('--sandbox');
  }
  const effort = effortOverride ?? config.effort;
  // agy rejects a pinned '-low' variant together with '--effort high'.
  // Keep the family and pin the matching variant, so init/card model labels
  // describe the requested tier as well as the --effort argument.
  const requestedModel = effort !== undefined ? model?.replace(/-(low|medium|high|xhigh|max)$/, `-${effort}`) : model;
  if (requestedModel) args.push('--model', requestedModel);
  if (effort !== undefined) {
    if (!isAntigravityReasoningEffort(effort)) throw new Error('Invalid Antigravity reasoning effort');
    args.push('--effort', effort);
  }
  if (config.agent) args.push('--agent', config.agent);
  if (conversationId) args.push('--conversation', conversationId);
  const reservedExtraArg =
    /^(--dangerously-skip-permissions|--output-format(?:=|$)|--input-format(?:=|$)|--conversation(?:=|$)|--continue$|-c$|--print$|--prompt(?:=|$)|-p$|--gemini_dir(?:=|$)|--model(?:=|$)|--effort(?:=|$)|--sandbox$|--agent(?:=|$)|--print-timeout(?:=|$))/;
  for (const extra of config.extraArgs ?? []) {
    if (reservedExtraArg.test(extra)) {
      throw new Error(`Antigravity extraArgs contains a reserved or unsafe option: ${extra}`);
    }
    args.push(extra);
  }
  args.push('-p', prompt);
  return args;
}

export type AntigravityFailureKind =
  | 'authentication_required'
  | 'quota_exhausted'
  | 'permission_blocked'
  | 'eligibility_or_location'
  | 'model_unavailable'
  | 'generic';

/** Classify stderr without returning provider text, URLs, cookies, or tokens. */
export function classifyAntigravityFailure(stderr: string): AntigravityFailureKind {
  if (/authentication required|not authenticated|sign[ -]?in|oauth|authorization code/i.test(stderr)) {
    return 'authentication_required';
  }
  if (/quota|rate.?limit|capacity|resource.?exhausted/i.test(stderr)) return 'quota_exhausted';
  if (/permission|approval|waiting|denied/i.test(stderr)) return 'permission_blocked';
  if (
    /not eligible|unsupported (?:country|region)|unavailable in (?:your |this )?location|location.*unavailable/i.test(
      stderr,
    )
  ) {
    return 'eligibility_or_location';
  }
  if (/unknown model|model (?:is )?not found|model.*unavailable|invalid model/i.test(stderr)) {
    return 'model_unavailable';
  }
  return 'generic';
}

function safeFailureMessage(kind: AntigravityFailureKind, code: number | null, signal: NodeJS.Signals | null): string {
  const terminal = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
  switch (kind) {
    case 'authentication_required':
      return `Antigravity authentication is required (${terminal}). Run agy interactively on this host and complete the official sign-in flow.`;
    case 'quota_exhausted':
      return `Antigravity quota is exhausted (${terminal}). Wait for the plan quota to refresh or use configured AI credits.`;
    case 'permission_blocked':
      return `Antigravity stopped on a permission gate (${terminal}). Update the account's explicit read-only permission policy; MetaBot will not bypass it automatically.`;
    case 'eligibility_or_location':
      return `This Antigravity account is not eligible in its current country or region (${terminal}). MetaBot will not switch accounts automatically.`;
    case 'model_unavailable':
      return `The selected Antigravity model is unavailable for this account (${terminal}). Use the exact slug returned by agy models for the selected account.`;
    default:
      return `Antigravity exited with ${terminal}. Provider stderr was withheld because it may contain authentication material.`;
  }
}

export class AntigravityExecutor {
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const config = this.config.antigravity;
    if (config?.quotaFailover === true && Object.keys(config.accounts ?? {}).length > 1) {
      return startQuotaFailover(config, options, attempt => this.startSingleExecution(attempt));
    }
    return this.startSingleExecution(options);
  }

  private startSingleExecution(options: ExecutorOptions): ExecutionHandle {
    const { prompt, cwd, sessionId, abortController, outputsDir, apiContext } = options;
    const antigravityConfig = this.config.antigravity ?? {};
    const account = resolveAntigravityAccount(antigravityConfig, options.antigravityAccount);
    const fullPrompt = this.buildPromptWithContext(prompt, outputsDir, apiContext);
    const model = options.model ?? antigravityConfig.model;
    const args = buildAntigravityArgs(antigravityConfig, fullPrompt, model, sessionId, options.antigravityReasoningEffort);
    const executable = account?.runner || antigravityConfig.executable || ANTIGRAVITY_EXECUTABLE;
    const executionEnv = {
      ...process.env,
      MB_CALLER_BOT: this.config.name,
      ...(antigravityConfig.env ?? {}),
    };
    const queue = new AsyncQueue<SDKMessage>();
    const state = createAntigravityTranslatorState({
      model: model ?? antigravityConfig.displayModel,
      contextWindow: resolveAntigravityContextWindow(
        model ?? antigravityConfig.displayModel,
        antigravityConfig.contextWindow,
      ),
    });
    let child: ChildProcess | undefined;
    let stdoutBuffer = '';
    let stderr = '';
    let sawTerminalResult = false;
    let pendingResult: SDKMessage | undefined;
    let observedWork = false;
    let quotaError = false;

    const emitEvent = (event: AntigravityJsonEvent): void => {
      if (event.event === 'result') {
        quotaError = event.result?.status !== 'SUCCESS' && isExplicitQuotaExhaustion(event.result?.error ?? '');
        // agy counts the submitted user input as one turn even on preflight quota rejection.
        if (event.result?.response || (event.result?.num_turns ?? 0) > 1) observedWork = true;
      } else if (event.event !== 'init') {
        const update = event.step_update;
        const inputOrErrorOnly = event.event === 'step_update' && update?.state === 'DONE'
          && (update.step_type === 'user_input' || update.step_type === 'error_message')
          && !update.text_delta && !update.tool_name && !update.tool_info;
        // Includes buffered text/thinking/tool events and unknown progress.
        if (!inputOrErrorOnly) observedWork = true;
      }
      const messages = translateAntigravityJsonEvent(event, state);
      for (const message of messages) {
        if (message.type === 'result') {
          sawTerminalResult = true;
          pendingResult = message;
        } else {
          queue.enqueue(message);
        }
      }
    };

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        emitEvent(JSON.parse(trimmed) as AntigravityJsonEvent);
      } catch {
        observedWork = true;
        this.logger.warn('Failed to parse Antigravity JSONL event (provider payload withheld)');
      }
    };

    const processStdout = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    };

    if (abortController.signal.aborted) {
      queue.finish();
    } else {
      this.logger.info(
        {
          cwd,
          hasConversation: !!sessionId,
          engine: 'antigravity',
          account: account?.alias,
          model,
          sandbox: antigravityConfig.dangerouslySkipPermissions !== true && antigravityConfig.sandbox !== false,
          dangerouslySkipPermissions: antigravityConfig.dangerouslySkipPermissions === true,
          judgmentPolicyVersion: INDEPENDENT_JUDGMENT_POLICY_VERSION,
        },
        'Starting Antigravity execution',
      );

      try {
        child = spawn(executable, args, {
          cwd,
          env: executionEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        queue.enqueue({
          type: 'result',
          subtype: 'error_during_execution',
          session_id: sessionId ?? '',
          duration_ms: 0,
          result: '',
          is_error: true,
          errors: [err?.message || String(err)],
        });
        queue.finish();
      }

      child?.stdout?.on('data', processStdout);
      child?.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf-8')).slice(-32_768);
      });
      child?.on('error', (err: NodeJS.ErrnoException) => {
        if (sawTerminalResult) return;
        sawTerminalResult = true;
        const message =
          err.code === 'ENOENT'
            ? `Antigravity executable not found at ${antigravityConfig.executable || ANTIGRAVITY_EXECUTABLE}.`
            : `Antigravity process failed to start: ${err.code || err.name}`;
        queue.enqueue({
          type: 'result',
          subtype: 'error_during_execution',
          session_id: sessionId ?? '',
          duration_ms: Date.now() - state.startTime,
          result: '',
          is_error: true,
          errors: [message],
        });
      });
      child?.on('close', async (code, signal) => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        const failureEvidence = {
          quotaExhausted: quotaError || (!sawTerminalResult && code !== 0 && isExplicitQuotaExhaustion(stderr)),
          safeToRetry: !observedWork && !abortController.signal.aborted && !signal && code !== null,
        };
        if (!sawTerminalResult) {
          const subtype = abortController.signal.aborted ? 'error_cancelled' : 'error_during_execution';
          queue.enqueue({
            type: 'result',
            subtype,
            antigravityFailure: failureEvidence,
            session_id: state.conversationId ?? sessionId ?? '',
            duration_ms: Date.now() - state.startTime,
            result: '',
            is_error: true,
            errors: [
              abortController.signal.aborted
                ? 'Antigravity execution was cancelled.'
                : safeFailureMessage(classifyAntigravityFailure(stderr), code, signal),
            ],
          });
        }
        if (pendingResult) {
          if (pendingResult.is_error) pendingResult.antigravityFailure = failureEvidence;
          if (!pendingResult.is_error && state.model) {
            try {
              pendingResult.quotaInfo = await fetchAntigravityQuota(executable, state.model, executionEnv);
            } catch (err) {
              this.logger.warn({ err }, 'Antigravity usage read failed (non-fatal, footer degraded)');
            }
          }
          queue.enqueue(pendingResult);
          pendingResult = undefined;
        }
        queue.finish();
      });

      abortController.signal.addEventListener(
        'abort',
        () => {
          if (child && !child.killed) child.kill('SIGTERM');
        },
        { once: true },
      );
    }

    return {
      stream: queue[Symbol.asyncIterator]() as AsyncGenerator<SDKMessage>,
      sendAnswer: () => {
        this.logger.warn({ engine: 'antigravity' }, 'sendAnswer is unavailable in headless Antigravity mode');
      },
      resolveQuestion: () => {
        this.logger.warn({ engine: 'antigravity' }, 'resolveQuestion is unavailable in headless Antigravity mode');
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
      for await (const message of handle.stream) yield message;
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
        `## Output Files\nWhen producing output files for the user, copy them to: ${outputsDir}\nThe bridge will automatically send files placed there to the user.`,
      );
    }
    if (apiContext) {
      sections.push(
        `## MetaBot API\nYou are running as bot "${apiContext.botName}" in chat "${apiContext.chatId}".\nUse the /metabot skill for agent bus, scheduling, and bot-management documentation.`,
      );
    }
    sections.push(INDEPENDENT_JUDGMENT_POLICY);
    return `${prompt}\n\n---\n\n${sections.join('\n\n')}`;
  }
}
