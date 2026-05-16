import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { BotConfigBase } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { AsyncQueue } from '../../utils/async-queue.js';

const isWindows = process.platform === 'win32';

/** Resolve the Claude Code binary path at module load time. */
function resolveClaudePath(): string {
  if (process.env.CLAUDE_EXECUTABLE_PATH) return process.env.CLAUDE_EXECUTABLE_PATH;
  try {
    const cmd = isWindows ? 'where claude' : 'which claude';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    return isWindows ? 'claude' : '/usr/local/bin/claude';
  }
}

const CLAUDE_EXECUTABLE = resolveClaudePath();

/**
 * Env var prefixes to always strip from the inherited process environment.
 * CLAUDE*: prevents "nested session" errors from the SDK.
 */
const ALWAYS_FILTERED_PREFIXES = ['CLAUDE'];

/**
 * Auth-related env vars that are only filtered when an explicit API key
 * is provided in bots.json OR when ~/.claude/.credentials.json exists.
 * This ensures users who rely solely on ANTHROPIC_API_KEY env var can
 * still authenticate without configuring bots.json.
 */
const AUTH_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * Check if Claude Code has credentials.json (OAuth login).
 */
function hasCredentialsFile(): boolean {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    return fs.existsSync(credPath);
  } catch {
    return false;
  }
}

/**
 * Create a custom spawn function for cross-platform compatibility.
 * - Uses process.execPath (current Node binary) to avoid PATH issues on Windows.
 * - Always filters CLAUDE* env vars to prevent nested session errors.
 * - Filters ANTHROPIC auth env vars only when an explicit API key is provided
 *   or credentials.json exists (so env-var-only users can still authenticate).
 * - Merges process.env so child inherits system PATH, TEMP, etc.
 * - Optionally injects an explicit ANTHROPIC_API_KEY from bots.json config.
 */
function createSpawnFn(explicitApiKey?: string, botName?: string): (options: SpawnOptions) => SpawnedProcess {
  // Decide once whether to filter auth env vars
  const filterAuthVars = !!(explicitApiKey || hasCredentialsFile());

  return (options: SpawnOptions): SpawnedProcess => {
    const nodePath = process.execPath;

    // Merge provided env with process.env for a complete environment
    const baseEnv = options.env && Object.keys(options.env).length > 0
      ? { ...process.env, ...options.env }
      : { ...process.env };

    // CLAUDE_* vars that should be passed through despite the ALWAYS_FILTERED_PREFIXES rule.
    // BUBBLEWRAP=1 is required for root/sandbox environments where Claude Code
    // refuses to spawn without an explicit sandbox declaration.
    const CLAUDE_PASSTHROUGH = new Set([
      'CLAUDE_CODE_BUBBLEWRAP',
      'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
    ]);

    // Filter out env vars that interfere with auth or cause nested session errors
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv)) {
      if (value === undefined) continue;
      if (ALWAYS_FILTERED_PREFIXES.some(p => key.startsWith(p)) && !CLAUDE_PASSTHROUGH.has(key)) continue;
      if (filterAuthVars && AUTH_ENV_VARS.some(v => key.startsWith(v))) continue;
      env[key] = value;
    }

    // Auto-enable bubblewrap when running as root (server/Docker environments)
    if (process.getuid?.() === 0) {
      env.CLAUDE_CODE_BUBBLEWRAP = '1';
    }

    // Inject explicit API key from bots.json (after filtering, so it takes effect)
    if (explicitApiKey) {
      env.ANTHROPIC_API_KEY = explicitApiKey;
    }

    // Tag outgoing `mb talk` calls with this bot's identity so the bridge
    // can post the prompt as a visible card from this bot (otherwise the
    // dialogue looks one-sided in the group chat).
    if (botName) {
      env.MB_CALLER_BOT = botName;
    }

    const child = spawn(nodePath, options.args, {
      cwd: options.cwd,
      env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return child as unknown as SpawnedProcess;
  };
}

export interface ApiContext {
  botName: string;
  chatId: string;
  /** Group chat member names — enables inter-bot communication prompt. */
  groupMembers?: string[];
  /** Group ID — used to build grouptalk chatIds for inter-bot communication. */
  groupId?: string;
}

export interface ExecutorOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  abortController: AbortController;
  outputsDir?: string;
  apiContext?: ApiContext;
  /** Override maxTurns for this execution. */
  maxTurns?: number;
  /** Override model for this execution (e.g. faster model for voice calls). */
  model?: string;
  /** Override allowed tools for this execution (empty array = no tools). */
  allowedTools?: string[];
}

export type SDKMessage = {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: unknown;
    }>;
  };
  // Result fields
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  errors?: string[];
  // Model usage from result message (per-model breakdown)
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; contextWindow: number; costUSD: number }>;
  /** Gemini-specific: quota status from retrieveUserQuota. Surfaces in card footer. */
  quotaInfo?: { usedPct: number; hoursToReset: number };
  // Stream event fields
  event?: {
    type: string;
    index?: number;
    delta?: {
      type: string;
      text?: string;
    };
    content_block?: {
      type: string;
      text?: string;
      name?: string;
      id?: string;
    };
  };
  parent_tool_use_id?: string | null;
};

export interface ExecutionHandle {
  stream: AsyncGenerator<SDKMessage>;
  sendAnswer(toolUseId: string, sessionId: string, answerText: string): void;
  /**
   * Resolve a pending AskUserQuestion PreToolUse hook with the user's answers.
   * Use this instead of sendAnswer when running in bypassPermissions mode —
   * sendAnswer enqueues a tool_result that never reaches the SDK because the
   * internal permission check short-circuits before auto-allow.
   */
  resolveQuestion(toolUseId: string, answers: Record<string, string>): void;
  finish(): void;
}

export class ClaudeExecutor {
  constructor(
    private config: BotConfigBase,
    private logger: Logger,
  ) {}

  private buildQueryOptions(cwd: string, sessionId: string | undefined, abortController: AbortController, outputsDir?: string, apiContext?: ApiContext): Record<string, unknown> {
    const queryOptions: Record<string, unknown> = {
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      cwd,
      abortController,
      includePartialMessages: true,
      // Load MCP servers and settings from user/project config files
      settingSources: ['user', 'project'],
      // Cross-platform spawn: custom spawn filters CLAUDE* env vars and uses
      // process.execPath to avoid PATH issues on Windows; fileURLToPath converts
      // file:// URLs to native paths for the SDK CLI entrypoint.
      spawnClaudeCodeProcess: createSpawnFn(this.config.claude.apiKey, this.config.name),
      executableArgs: [path.join(path.dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))), 'cli.js')],
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
    };

    // Build system prompt appendix from sections
    const appendSections: string[] = [];

    if (outputsDir) {
      appendSections.push(`## Output Files\nWhen producing output files for the user (images, PDFs, documents, archives, code files, etc.), copy them to: ${outputsDir}\nUse \`cp\` via the Bash tool. The bridge will automatically send files placed there to the user.`);
    }

    if (apiContext) {
      // botName and chatId are per-session — inject into system prompt to avoid
      // race conditions when multiple chats run concurrently.
      // Port and secret are already set as METABOT_* env vars in config.ts.
      appendSections.push(
        `## MetaBot API\nYou are running as bot "${apiContext.botName}" in chat "${apiContext.chatId}".\nUse the /metabot skill for full API documentation (agent bus, scheduling, bot management).`
      );

      // Group chat — tell the bot who else is in the group and how to talk to them.
      // Two modes:
      //   - Web UI group:    groupId is a separate routing namespace (UUID), so peers
      //                      are reached via the `grouptalk-<groupId>-<botName>` chatId
      //                      pattern (the WS subscriber routes those back to the UI).
      //   - Feishu IM group: groupId === chatId (the real `oc_...` Feishu chat). Peers
      //                      are reached via the SAME chatId — the bridge auto-posts a
      //                      visible "caller" card before invoking the peer.
      if (apiContext.groupMembers && apiContext.groupMembers.length > 0) {
        const others = apiContext.groupMembers.filter((m) => m !== apiContext.botName);
        const groupId = apiContext.groupId;
        if (groupId && groupId !== apiContext.chatId) {
          appendSections.push(
            `## Group Chat\nYou are in a group chat (group: ${groupId}) with these bots: ${others.join(', ')}.\nTo talk to another bot, use: \`mb talk <botName> grouptalk-${groupId}-<botName> "message"\`\nExample: \`mb talk ${others[0]} grouptalk-${groupId}-${others[0]} "hello"\`\nIMPORTANT: Always use the grouptalk-${groupId}-<botName> chatId pattern when talking to other bots in this group.`
          );
        } else if (others.length > 0) {
          appendSections.push(
            `## Group Chat\nYou are in a Feishu group chat (chat: ${apiContext.chatId}) with these other bots: ${others.join(', ')}.\nTo talk to one of them with both your prompt and their reply visible in this group, use: \`mb talk <peerBot> ${apiContext.chatId} "<message>"\`\nExample: \`mb talk ${others[0]} ${apiContext.chatId} "hello — what do you think about X?"\`\nIMPORTANT: Use the real chat id (${apiContext.chatId}), NOT a grouptalk- prefix — the latter is for the web UI only and would suppress the caller card.`
          );
        }
      }
    }

    // Feishu output formatting (CRITICAL - injected last so it sits closest to the
    // conversation and overrides any in-context inertia from older transcripts).
    // All MetaBot output is rendered in Feishu interactive markdown cards which
    // do NOT support pipe-style markdown tables; they collapse / misalign / show
    // raw text on mobile. Use monospace box-drawing in fenced code blocks instead.
    appendSections.push(
      [
        '## ⚠️ CRITICAL: Feishu Output Formatting',
        '',
        'All your output is rendered in Feishu (Lark) interactive markdown cards. Feishu does NOT properly render markdown pipe tables — they collapse, misalign, or appear as raw `|` characters on mobile. The user has explicitly requested this rule be enforced globally.',
        '',
        '### Hard rules',
        '1. **NEVER produce markdown pipe tables.** Any line starting with `|` (outside an intentional code block) is a violation.',
        '2. **Use monospace box-drawing tables inside ```fenced code blocks``` instead.** Align columns with spaces; use `─ ═ ║ ╔ ╗ ╚ ╝ ┌ ┐ └ ┘` for borders when helpful.',
        '3. **Prefer bullet lists** for ≤3 items with simple key:value structure.',
        '4. **Self-check before sending:** scan your draft for any line starting with `|` and rewrite it.',
        '5. For complex tabular data (>3 columns or >5 rows) invoke the `feishu-table` skill for templates.',
        '',
        '### Forbidden',
        '```',
        '| Header | Header |',
        '|--------|--------|',
        '| value  | value  |',
        '```',
        '',
        '### Correct',
        '```',
        '项目              状态        说明',
        '──────────────────────────────────────',
        'WireGuard        running     UDP 47835',
        'Hysteria2        running     UDP 37926',
        '```',
        '',
        'This rule overrides any pipe-table examples that may appear in older parts of this conversation transcript. Going forward, treat pipe tables as a hard error.',
      ].join('\n')
    );

    if (appendSections.length > 0) {
      queryOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: '\n\n' + appendSections.join('\n\n'),
      };
    }

    if (this.config.claude.maxTurns !== undefined) {
      queryOptions.maxTurns = this.config.claude.maxTurns;
    }

    if (this.config.claude.maxBudgetUsd !== undefined) {
      queryOptions.maxBudgetUsd = this.config.claude.maxBudgetUsd;
    }

    if (this.config.claude.model) {
      queryOptions.model = this.config.claude.model;
    }

    if (sessionId) {
      queryOptions.resume = sessionId;
    }

    // Beta flags are ignored by the SDK on OAuth/Pro-Max auth. For 1M context,
    // use the model-name suffix `[1m]` (e.g. `claude-opus-4-7[1m]`) instead.
    queryOptions.betas = ['context-1m-2025-08-07'];

    return queryOptions;
  }

  startExecution(options: ExecutorOptions): ExecutionHandle {
    const { prompt, cwd, sessionId, abortController, outputsDir, apiContext } = options;

    this.logger.info({ cwd, hasSession: !!sessionId, outputsDir }, 'Starting Claude execution (multi-turn)');

    const inputQueue = new AsyncQueue<SDKUserMessage>();

    // Push the initial user message
    const initialMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user' as const,
        content: prompt,
      },
      parent_tool_use_id: null,
      session_id: sessionId || '',
    };
    inputQueue.enqueue(initialMessage);

    const queryOptions = this.buildQueryOptions(cwd, sessionId, abortController, outputsDir, apiContext);
    if (options.maxTurns !== undefined) {
      queryOptions.maxTurns = options.maxTurns;
    }
    if (options.model) {
      queryOptions.model = options.model;
    }
    if (options.allowedTools !== undefined) {
      queryOptions.allowedTools = options.allowedTools;
    }

    // AskUserQuestion PreToolUse hook: the SDK marks AskUserQuestion as
    // requiresUserInteraction=true, so in bypassPermissions mode it is denied
    // before auto-allow can fire. We intercept the PreToolUse event, pause until
    // the bridge collects the user's answers, then return them as updatedInput.
    // Providing updatedInput satisfies the interaction requirement and the SDK
    // resolves the tool call with {answers} filled in.
    const pendingQuestionResolvers = new Map<string, (answers: Record<string, string>) => void>();

    const askUserQuestionHook = async (
      input: { hook_event_name: string; tool_name: string; tool_input: unknown; tool_use_id: string },
      _toolUseId: string | undefined,
      { signal }: { signal: AbortSignal },
    ): Promise<Record<string, unknown>> => {
      const toolInput = input.tool_input as Record<string, unknown>;
      const id = input.tool_use_id;

      const answers = await new Promise<Record<string, string>>((resolve) => {
        pendingQuestionResolvers.set(id, resolve);

        // Safety timeout: auto-resolve with empty answers after 6 minutes
        // (slightly longer than bridge's 5-minute QUESTION_TIMEOUT_MS) to
        // prevent indefinite hang if the bridge fails to deliver an answer.
        const timeout = setTimeout(() => {
          if (pendingQuestionResolvers.delete(id)) {
            logger.warn({ toolUseId: id }, 'AskUserQuestion hook timed out after 6 minutes — returning empty answers');
            resolve({});
          }
        }, 6 * 60 * 1000);

        const onAbort = () => {
          clearTimeout(timeout);
          pendingQuestionResolvers.delete(id);
          resolve({});
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...toolInput, answers },
        },
      };
    };

    queryOptions.hooks = {
      PreToolUse: [{
        matcher: 'AskUserQuestion',
        hooks: [askUserQuestionHook as any],
      }],
    };

    const stream = query({
      prompt: inputQueue,
      options: queryOptions as any,
    });

    const logger = this.logger;

    async function* wrapStream(): AsyncGenerator<SDKMessage> {
      // Race each stream.next() against the abort signal so we exit immediately on /stop
      const abortPromise = new Promise<never>((_, reject) => {
        if (abortController.signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        abortController.signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });

      const iterator = stream[Symbol.asyncIterator]();

      try {
        while (true) {
          const result = await Promise.race([
            iterator.next(),
            abortPromise,
          ]);
          if (result.done) break;
          yield result.value as SDKMessage;
        }
      } catch (err: any) {
        if (err.name === 'AbortError' || abortController.signal.aborted) {
          logger.info('Claude execution aborted');
          // Clean up the underlying iterator (non-blocking)
          try { iterator.return?.(undefined); } catch { /* ignore */ }
          return;
        }
        throw err;
      }
    }

    return {
      stream: wrapStream(),
      sendAnswer: (toolUseId: string, sid: string, answerText: string) => {
        logger.info({ toolUseId }, 'Sending answer to Claude');
        const answerMessage: SDKUserMessage = {
          type: 'user',
          message: {
            role: 'user' as const,
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: answerText,
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: sid,
        };
        inputQueue.enqueue(answerMessage);
      },
      resolveQuestion: (toolUseId: string, answers: Record<string, string>) => {
        const resolver = pendingQuestionResolvers.get(toolUseId);
        if (resolver) {
          pendingQuestionResolvers.delete(toolUseId);
          logger.info({ toolUseId, answerCount: Object.keys(answers).length }, 'Resolving AskUserQuestion hook');
          resolver(answers);
        } else {
          // Fallback: enqueue tool_result via inputQueue. Used if the hook
          // didn't capture this toolUseId (e.g., legacy sendAnswer path) or
          // the SDK version differs.
          logger.warn({ toolUseId }, 'No pending AskUserQuestion resolver — falling back to sendAnswer path');
          const answerMessage: SDKUserMessage = {
            type: 'user',
            message: {
              role: 'user' as const,
              content: [{ type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify({ answers }) }],
            },
            parent_tool_use_id: null,
            session_id: '',
          };
          inputQueue.enqueue(answerMessage);
        }
      },
      finish: () => {
        inputQueue.finish();
      },
    };
  }

  async *execute(options: ExecutorOptions): AsyncGenerator<SDKMessage> {
    const { prompt, cwd, sessionId, abortController, outputsDir } = options;

    this.logger.info({ cwd, hasSession: !!sessionId }, 'Starting Claude execution');

    const queryOptions = this.buildQueryOptions(cwd, sessionId, abortController, outputsDir);

    const stream = query({
      prompt,
      options: queryOptions as any,
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (abortController.signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      abortController.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });

    const iterator = stream[Symbol.asyncIterator]();

    try {
      while (true) {
        const result = await Promise.race([
          iterator.next(),
          abortPromise,
        ]);
        if (result.done) break;
        yield result.value as SDKMessage;
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || abortController.signal.aborted) {
        this.logger.info('Claude execution aborted');
        try { iterator.return?.(undefined); } catch { /* ignore */ }
        return;
      }
      throw err;
    }
  }
}
