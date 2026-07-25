import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage } from '../types.js';
import type { IMessageSender } from './message-sender.interface.js';
import { resolveEngineName, SessionManager } from '../engines/index.js';
import type { EngineName } from '../engines/index.js';
import { MemoryClient } from '../memory/memory-client.js';
import { AuditLogger } from '../utils/audit-logger.js';
import type { DocSync } from '../sync/doc-sync.js';
import { codexAppServerEnabled } from '../engines/codex/app-server-client.js';
import {
  clearCodexGoal,
  getCodexGoal,
  setCodexGoal,
  type CodexGoal,
  type CodexGoalStatus,
} from '../engines/codex/goal.js';

interface RunningTaskInfo {
  startTime: number;
  userId?: string;
}

interface ScheduleStopResult {
  activeCount: number;
  paused: Array<{ id: string; label?: string; cronExpr: string }>;
}

export class CommandHandler {
  private docSync: DocSync | null = null;
  private pauseSchedulesForChat?: (chatId: string) => ScheduleStopResult;

  constructor(
    private config: BotConfigBase,
    private logger: Logger,
    private sender: IMessageSender,
    private sessionManager: SessionManager,
    private memoryClient: MemoryClient,
    private audit: AuditLogger,
    private getRunningTask: (chatId: string) => RunningTaskInfo | undefined,
    private stopTask: (chatId: string) => void,
  ) {}

  /** Set the doc sync service (optional, only available for Feishu bots). */
  setDocSync(docSync: DocSync): void {
    this.docSync = docSync;
  }

  setScheduleStopper(stopSchedulesForChat: (chatId: string) => ScheduleStopResult): void {
    this.pauseSchedulesForChat = stopSchedulesForChat;
  }

  /** Returns true if the message was handled as a command, false otherwise. */
  async handle(msg: IncomingMessage): Promise<boolean> {
    const { text } = msg;
    if (!text.startsWith('/')) return false;

    const { userId, chatId } = msg;
    const [cmd] = text.split(/\s+/);

    this.audit.log({ event: 'command', botName: this.config.name, chatId, userId, prompt: cmd });

    switch (cmd.toLowerCase()) {
      case '/help':
        await this.sender.sendTextNotice(chatId, '📖 Help', [
          '**Available Commands:**',
          '`/reset` - Clear session, start fresh',
          '`/stop` - Abort current running task; pauses a single active schedule in this chat when safe',
          '`/status` - Show current session info',
          '`/model` - Show current engine/model; `/model list` - Available options',
          '`/model claude`, `/model kimi`, or `/model codex` - Switch engine (resets session)',
          '`/model <name>` - Set model for current engine',
          '`/goal` - Show or set Codex official goal mode (Codex app-server only)',
          '`/dr <question>` - Start the Deep Research GUI SOP and export the report',
          '`/cd <path>` - Switch working directory for this chat (resets session)',
          '`/memory` - Memory document commands',
          '`/help` - Show this help message',
          '',
          '**Usage:**',
          'Send any text message to start a conversation with the configured agent engine.',
          'Each chat has an independent session with a fixed working directory.',
          '',
          '**Memory Commands:**',
          '`/memory list` - Show folder tree',
          '`/memory search <query>` - Search documents',
          '`/memory status` - Server health check',
          '',
          '**Sync Commands:**',
          '`/sync` - Sync MetaMemory to Feishu Wiki',
          '`/sync status` - Show sync status',
        ].join('\n'));
        return true;

      case '/reset':
        this.sessionManager.resetSession(chatId);
        await this.sender.sendTextNotice(chatId, '✅ Session Reset', 'Conversation cleared. Working directory preserved.', 'green');
        return true;

      case '/stop': {
        const task = this.getRunningTask(chatId);
        const scheduleStop =
          !task || task.userId === 'scheduler'
            ? this.pauseSchedulesForChat?.(chatId)
            : undefined;
        if (task) {
          this.audit.log({ event: 'task_stopped', botName: this.config.name, chatId, userId, durationMs: Date.now() - task.startTime });
          this.stopTask(chatId);
          const paused = scheduleStop?.paused ?? [];
          const extra = paused.length > 0
            ? `\nPaused schedule: \`${paused[0].id}\``
            : scheduleStop && scheduleStop.activeCount > 1
              ? `\nFound ${scheduleStop.activeCount} active schedules; left them unchanged to avoid pausing the wrong one.`
              : '';
          await this.sender.sendTextNotice(chatId, '🛑 Stopped', `Current task has been aborted.${extra}`, 'orange');
        } else if (scheduleStop && scheduleStop.paused.length > 0) {
          const paused = scheduleStop.paused[0];
          await this.sender.sendTextNotice(
            chatId,
            '🛑 Schedule Paused',
            `No running task. Paused active schedule \`${paused.id}\` (${paused.label || paused.cronExpr}).`,
            'orange',
          );
        } else if (scheduleStop && scheduleStop.activeCount > 1) {
          await this.sender.sendTextNotice(
            chatId,
            'ℹ️ No Running Task',
            `No running task. Found ${scheduleStop.activeCount} active schedules for this bot/chat; /stop left them unchanged to avoid pausing the wrong one.`,
            'blue',
          );
        } else {
          await this.sender.sendTextNotice(chatId, 'ℹ️ No Running Task', 'There is no task to stop.', 'blue');
        }
        return true;
      }

      case '/status': {
        const session = this.sessionManager.getSession(chatId);
        const isRunning = !!this.getRunningTask(chatId);
        const botEngine = resolveEngineName(this.config);
        const activeEngine = session.engine ?? botEngine;
        const defaultModel = this.defaultModelForEngine(activeEngine) || '_default_';
        const activeModel = session.model || defaultModel;
        await this.sender.sendTextNotice(chatId, '📊 Status', [
          `**User:** \`${userId}\``,
          `**Engine:** \`${activeEngine}\`${session.engine ? ' (session override)' : ''}`,
          `**Working Directory:** \`${session.workingDirectory}\``,
          `**Session:** ${session.sessionId ? `\`${session.sessionId.slice(0, 8)}...\`` : '_None_'}`,
          `**Model:** \`${activeModel}\`${session.model ? ' (session override)' : ''}`,
          `**Running:** ${isRunning ? 'Yes ⏳' : 'No'}`,
        ].join('\n'));
        return true;
      }

      case '/memory': {
        const args = text.slice('/memory'.length).trim();
        await this.handleMemoryCommand(chatId, args);
        return true;
      }

      case '/sync': {
        const args = text.slice('/sync'.length).trim();
        await this.handleSyncCommand(chatId, args);
        return true;
      }

      case '/model': {
        const args = text.slice('/model'.length).trim();
        await this.handleModelCommand(chatId, args);
        return true;
      }

      case '/goal': {
        const args = text.slice('/goal'.length).trim();
        try {
          return await this.handleGoalCommand(chatId, args);
        } catch (err: any) {
          this.logger.error({ err, chatId }, '/goal command failed');
          await this.sender.sendTextNotice(
            chatId,
            '❌ Goal Failed',
            err?.message || String(err),
            'red',
          );
        }
        return true;
      }

      case '/cd': {
        const args = text.slice('/cd'.length).trim();
        await this.handleCdCommand(chatId, args);
        return true;
      }

      default:
        // Unrecognized /xxx commands — not handled here, pass through to Claude
        return false;
    }
  }

  private async handleMemoryCommand(chatId: string, args: string): Promise<void> {
    const [subCmd, ...rest] = args.split(/\s+/);

    if (!subCmd) {
      await this.sender.sendTextNotice(
        chatId,
        '📝 Memory',
        'Usage:\n- `/memory list` — Show folder tree\n- `/memory search <query>` — Search documents\n- `/memory status` — Health check',
      );
      return;
    }

    try {
      switch (subCmd.toLowerCase()) {
        case 'list': {
          const tree = await this.memoryClient.listFolderTree();
          const formatted = this.memoryClient.formatFolderTree(tree);
          await this.sender.sendTextNotice(chatId, '📂 Memory Folders', formatted);
          break;
        }
        case 'search': {
          const query = rest.join(' ').trim();
          if (!query) {
            await this.sender.sendTextNotice(chatId, '📝 Memory', 'Usage: `/memory search <query>`');
            return;
          }
          const results = await this.memoryClient.search(query);
          const formatted = this.memoryClient.formatSearchResults(results);
          await this.sender.sendTextNotice(chatId, `🔍 Search: ${query}`, formatted);
          break;
        }
        case 'status': {
          const health = await this.memoryClient.health();
          await this.sender.sendTextNotice(
            chatId,
            '📝 Memory Status',
            `Status: ${health.status}\nDocuments: ${health.document_count}\nFolders: ${health.folder_count}`,
            'green',
          );
          break;
        }
        default:
          await this.sender.sendTextNotice(chatId, '📝 Memory', `Unknown sub-command: \`${subCmd}\`\nUse \`/memory\` for help.`, 'orange');
      }
    } catch (err: any) {
      this.logger.error({ err, chatId }, 'Memory command error');
      await this.sender.sendTextNotice(chatId, '❌ Memory Error', `Failed to connect to memory server: ${err.message}`, 'red');
    }
  }

  private async handleSyncCommand(chatId: string, args: string): Promise<void> {
    if (!this.docSync) {
      await this.sender.sendTextNotice(chatId, '❌ Sync Unavailable', 'Wiki sync is not configured for this bot.', 'red');
      return;
    }

    const [subCmd] = args.split(/\s+/);

    if (!subCmd) {
      // Default: trigger full sync
      if (this.docSync.isSyncing()) {
        await this.sender.sendTextNotice(chatId, '⏳ Sync In Progress', 'A sync is already running. Please wait.', 'orange');
        return;
      }

      await this.sender.sendTextNotice(chatId, '🔄 Sync Started', 'Syncing MetaMemory documents to Feishu Wiki...', 'blue');

      try {
        const result = await this.docSync.syncAll();
        const lines = [
          `**Created:** ${result.created}`,
          `**Updated:** ${result.updated}`,
          `**Skipped:** ${result.skipped} (unchanged)`,
          `**Deleted:** ${result.deleted}`,
          `**Duration:** ${(result.durationMs / 1000).toFixed(1)}s`,
        ];
        if (result.errors.length > 0) {
          lines.push('', `**Errors (${result.errors.length}):**`);
          for (const err of result.errors.slice(0, 5)) {
            lines.push(`- ${err}`);
          }
          if (result.errors.length > 5) {
            lines.push(`- ... and ${result.errors.length - 5} more`);
          }
        }
        const color = result.errors.length > 0 ? 'orange' : 'green';
        await this.sender.sendTextNotice(chatId, '✅ Sync Complete', lines.join('\n'), color);
      } catch (err: any) {
        this.logger.error({ err, chatId }, 'Sync command error');
        await this.sender.sendTextNotice(chatId, '❌ Sync Failed', err.message, 'red');
      }
      return;
    }

    switch (subCmd.toLowerCase()) {
      case 'status': {
        const stats = this.docSync.getStats();
        const spaceId = stats.wikiSpaceId || 'Not configured';
        await this.sender.sendTextNotice(chatId, '📊 Sync Status', [
          `**Wiki Space:** \`${spaceId}\``,
          `**Synced Documents:** ${stats.documentCount}`,
          `**Synced Folders:** ${stats.folderCount}`,
          `**Currently Syncing:** ${this.docSync.isSyncing() ? 'Yes' : 'No'}`,
        ].join('\n'));
        break;
      }
      default:
        await this.sender.sendTextNotice(chatId, '📝 Sync', 'Usage:\n- `/sync` — Sync all documents to Feishu Wiki\n- `/sync status` — Show sync status', 'blue');
    }
  }

  private async handleCdCommand(chatId: string, args: string): Promise<void> {
    const session = this.sessionManager.getSession(chatId);
    if (!args) {
      await this.sender.sendTextNotice(chatId, '📂 Working Directory', [
        `Current: \`${session.workingDirectory}\``,
        '',
        'Usage: `/cd <absolute-path>` (e.g., `/cd /root/QuatumTrading_Claude`)',
      ].join('\n'));
      return;
    }
    // Resolve path: must be absolute
    const fs = await import('node:fs');
    const path = await import('node:path');
    const target = path.resolve(args);
    if (!fs.existsSync(target)) {
      await this.sender.sendTextNotice(chatId, '❌ Path not found', `\`${target}\` does not exist on the server.`, 'red');
      return;
    }
    if (!fs.statSync(target).isDirectory()) {
      await this.sender.sendTextNotice(chatId, '❌ Not a directory', `\`${target}\` is not a directory.`, 'red');
      return;
    }
    this.sessionManager.setSessionWorkingDirectory(chatId, target);
    await this.sender.sendTextNotice(chatId, '✅ Working Directory Updated', [
      `\`${target}\``,
      '',
      '_Session ID cleared — next message starts a fresh conversation in the new directory._',
    ].join('\n'), 'green');
  }

  private async handleModelCommand(chatId: string, args: string): Promise<void> {
    const session = this.sessionManager.getSession(chatId);
    const botEngine = resolveEngineName(this.config);
    const activeEngine = session.engine ?? botEngine;
    const botDefault = this.defaultModelForEngine(activeEngine);

    // No args — show current model
    if (!args) {
      const active = session.model || botDefault || '_default_';
      const exampleModels = this.exampleModelsForEngine(activeEngine);
      const lines = [
        `**Engine:** \`${activeEngine}\`${session.engine ? ' (session override)' : ''}`,
        `**Active:** \`${active}\`${session.model ? ' (session override)' : ''}`,
        `**Bot default:** \`${botDefault || '_unset_'}\``,
        '',
        'Usage:',
        '- `/model list` — Show available engines + models',
        '- `/model claude`, `/model kimi`, or `/model codex` — Switch engine (resets session)',
        `- \`/model <name>\` — Set session model (e.g. ${exampleModels})`,
        '- `/model reset` — Clear overrides, use bot defaults',
      ];
      await this.sender.sendTextNotice(chatId, '🤖 Model', lines.join('\n'));
      return;
    }

    const normalized = args.toLowerCase();

    // Engine switch — /model claude, /model kimi, or /model codex
    if (isEngineName(normalized)) {
      if (activeEngine === normalized) {
        await this.sender.sendTextNotice(
          chatId,
          'ℹ️ Already using ' + normalized,
          `This chat is already on the \`${normalized}\` engine.`,
          'blue',
        );
        return;
      }
      this.sessionManager.setSessionEngine(chatId, normalized);
      await this.sender.sendTextNotice(
        chatId,
        `✅ Engine switched to ${normalized}`,
        [
          `Next message will run on the **${normalized}** engine.`,
          '',
          '_Session ID and model override cleared — a fresh conversation starts on the next turn._',
          this.authTipForEngine(normalized),
        ].join('\n'),
        'green',
      );
      return;
    }

    // List available models
    if (normalized === 'list' || normalized === 'ls') {
      const active = session.model || botDefault;
      const claudeModels = [
        { id: 'claude-fable-5', label: 'Fable 5', note: 'Mythos-class · strongest · 1M context · 2x price · free on Max until 6/22' },
        { id: 'claude-opus-4-8', label: 'Opus 4.8', note: 'Most capable · 200k context · default' },
        { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M)', note: '1M context window' },
        { id: 'claude-opus-4-7', label: 'Opus 4.7', note: '200k context' },
        { id: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M)', note: '1M context window' },
        { id: 'claude-opus-4-6', label: 'Opus 4.6', note: '200k context' },
        { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M)', note: '1M context window' },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', note: 'Balanced · 200k context' },
        { id: 'claude-sonnet-4-6[1m]', label: 'Sonnet 4.6 (1M)', note: '1M context window' },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Fastest · 200k context' },
      ];
      const kimiModels = [
        { id: 'kimi-for-coding', label: 'Kimi for Coding', note: 'Subscription default · 256k context · thinking' },
        { id: 'kimi-k2', label: 'Kimi K2', note: 'Legacy coding model' },
      ];
      const codexModels = [
        { id: 'gpt-5.4-codex', label: 'GPT-5.4 Codex', note: 'Recommended Codex coding model' },
        { id: 'gpt-5.4', label: 'GPT-5.4', note: 'General flagship model' },
        { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', note: 'Legacy Codex coding model' },
      ];
      const geminiModels = [
        { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', note: 'Default · 1M context' },
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', note: 'Stable fallback when 3.1 quota exhausted' },
        { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)', note: 'Fastest · separate quota pool' },
      ];
      const models = activeEngine === 'kimi' ? kimiModels
        : activeEngine === 'codex' ? codexModels
        : activeEngine === 'gemini' ? geminiModels
        : claudeModels;
      const header = activeEngine === 'kimi'
        ? '**Available Kimi models:**'
        : activeEngine === 'codex'
          ? '**Common Codex models:**'
          : activeEngine === 'gemini'
            ? '**Available Gemini models:**'
            : '**Available Claude models:**';
      const lines = [
        `**Current engine:** \`${activeEngine}\`${session.engine ? ' (session override)' : ''}`,
        '',
        '**Engines:** `/model claude`, `/model kimi`, `/model codex`, or `/model gemini` to switch.',
        '',
        header,
        '',
      ];
      for (const m of models) {
        const marker = m.id === active ? ' ✅' : '';
        lines.push(`- \`${m.id}\` — ${m.label} · ${m.note}${marker}`);
      }
      lines.push('');
      if (activeEngine === 'claude') {
        lines.push('_Tip: append `[1m]` to a model name to enable the 1M context window. Only Opus 4.8/4.7/4.6 and Sonnet 4.6 support it._');
      } else if (activeEngine === 'codex') {
        lines.push('_Tip: leave unset to use the Codex CLI default from `~/.codex/config.toml`._');
      } else if (activeEngine === 'gemini') {
        lines.push('_Tip: switch to `gemini-3-flash-preview` when 3.1 Pro hits `RESOURCE_EXHAUSTED` (separate quota pool)._');
      } else {
        lines.push('_Tip: leave unset to use the kimi-cli default (recommended for subscription users — the server picks the best available)._');
      }
      lines.push('Use `/model <name>` to set the model for the current engine.');
      await this.sender.sendTextNotice(chatId, '🤖 Available Models', lines.join('\n'));
      return;
    }

    // Reset — clear overrides (both engine AND model)
    if (normalized === 'reset' || normalized === 'clear' || normalized === 'default') {
      this.sessionManager.setSessionModel(chatId, undefined);
      this.sessionManager.setSessionEngine(chatId, undefined);
      const fallback = botDefault || '_default_';
      await this.sender.sendTextNotice(
        chatId,
        '✅ Overrides Cleared',
        `Session engine and model overrides cleared. Using bot defaults: engine \`${botEngine}\`, model \`${fallback}\`.`,
        'green',
      );
      return;
    }

    // Set the model (use only the first token, ignore trailing junk)
    const newModel = args.split(/\s+/)[0];
    this.sessionManager.setSessionModel(chatId, newModel);
    await this.sender.sendTextNotice(
      chatId,
      '✅ Model Set',
      `Session model set to \`${newModel}\` on engine \`${activeEngine}\`. It will take effect on the next message.`,
      'green',
    );
  }

  private async handleGoalCommand(chatId: string, args: string): Promise<boolean> {
    const session = this.sessionManager.getSession(chatId);
    const activeEngine = session.engine ?? resolveEngineName(this.config);
    const codexConfig = this.config.codex ?? {};

    if (activeEngine !== 'codex') {
      await this.sender.sendTextNotice(
        chatId,
        'ℹ️ Goal Unavailable',
        `Current engine is \`${activeEngine}\`. Official Codex goal mode only applies to the \`codex\` engine.`,
        'blue',
      );
      return true;
    }

    if (!codexAppServerEnabled(codexConfig)) {
      await this.sender.sendTextNotice(
        chatId,
        '⚠️ Goal Requires Codex App Server',
        [
          'Official Codex `/goal` is not available through `codex exec`.',
          '',
          'Enable it with `codex.transport: "app-server"` in the bot config, then restart MetaBot.',
          '',
          '_No fake MetaBot-level goal was created._',
        ].join('\n'),
        'orange',
      );
      return true;
    }

    const [rawSubcmd] = args.split(/\s+/).filter(Boolean);
    const subcmd = rawSubcmd?.toLowerCase();

    if (!args || subcmd === 'status' || subcmd === 'show') {
      if (!session.sessionId) {
        await this.sender.sendTextNotice(chatId, '🎯 Goal', 'No active Codex thread yet. Use `/goal <objective>` to create one.', 'blue');
        return true;
      }
      const goal = await getCodexGoal({
        codexConfig,
        logger: this.logger,
        botName: this.config.name,
        threadId: session.sessionId,
      });
      await this.sender.sendTextNotice(chatId, '🎯 Goal', goal ? this.formatGoal(goal) : 'No goal is set for this Codex thread.', goal ? 'green' : 'blue');
      return true;
    }

    if (subcmd === 'clear' || subcmd === 'reset') {
      if (!session.sessionId) {
        await this.sender.sendTextNotice(chatId, '🎯 Goal', 'No active Codex thread; nothing to clear.', 'blue');
        return true;
      }
      await clearCodexGoal({
        codexConfig,
        logger: this.logger,
        botName: this.config.name,
        threadId: session.sessionId,
      });
      await this.sender.sendTextNotice(chatId, '✅ Goal Cleared', 'Official Codex goal cleared for this thread.', 'green');
      return true;
    }

    if (subcmd === 'pause' || subcmd === 'paused' || subcmd === 'resume' || subcmd === 'active' || subcmd === 'complete' || subcmd === 'blocked') {
      if (!session.sessionId) {
        await this.sender.sendTextNotice(chatId, '🎯 Goal', 'No active Codex thread. Set an objective first with `/goal <objective>`.', 'orange');
        return true;
      }
      const status: CodexGoalStatus = subcmd === 'pause' || subcmd === 'paused'
        ? 'paused'
        : subcmd === 'resume' || subcmd === 'active'
          ? 'active'
          : subcmd as CodexGoalStatus;
      const goal = await setCodexGoal({
        codexConfig,
        logger: this.logger,
        botName: this.config.name,
        threadId: session.sessionId,
        status,
      });
      await this.sender.sendTextNotice(chatId, '✅ Goal Updated', goal ? this.formatGoal(goal) : `Goal status set to \`${status}\`.`, 'green');
      return true;
    }

    const parsed = this.parseGoalSetArgs(args.startsWith('set ') ? args.slice(4).trim() : args);
    if (!parsed.objective) {
      await this.sender.sendTextNotice(chatId, '🎯 Goal', [
        'Usage:',
        '- `/goal` — Show current official Codex goal',
        '- `/goal <objective>` — Set or replace goal',
        '- `/goal <objective> --budget 100000` — Set goal with token budget',
        '- `/goal pause|resume|complete|blocked` — Update status',
        '- `/goal clear` — Clear goal',
      ].join('\n'), 'blue');
      return true;
    }

    if (parsed.objective.length > 4000) {
      await this.sender.sendTextNotice(chatId, '❌ Goal Too Long', 'Codex goal objective must be 4000 characters or fewer.', 'red');
      return true;
    }

    // Let MessageBridge run `/goal <objective>` through the normal task card
    // path, where CodexExecutor starts the official goal operation and streams
    // runtime-generated continuation turns. CommandHandler only owns goal
    // management subcommands above.
    return false;
  }

  private parseGoalSetArgs(args: string): { objective: string; tokenBudget?: number | null } {
    const budgetMatch = args.match(/\s+--budget\s+(\d+)\s*$/);
    if (!budgetMatch) return { objective: args.trim() };
    return {
      objective: args.slice(0, budgetMatch.index).trim(),
      tokenBudget: Number.parseInt(budgetMatch[1], 10),
    };
  }

  private formatGoal(goal: CodexGoal): string {
    const lines = [
      `**Status:** \`${goal.status}\``,
      `**Thread:** \`${goal.threadId.slice(0, 8)}...\``,
      `**Objective:** ${goal.objective}`,
      `**Tokens:** ${goal.tokensUsed}${goal.tokenBudget ? ` / ${goal.tokenBudget}` : ''}`,
      `**Time:** ${Math.round(goal.timeUsedSeconds / 60)} min`,
    ];
    return lines.join('\n');
  }

  private defaultModelForEngine(engine: EngineName): string | undefined {
    switch (engine) {
      case 'claude':
        return this.config.claude.model;
      case 'kimi':
        return this.config.kimi?.model;
      case 'codex':
        return this.config.codex?.model || this.config.codex?.displayModel;
      case 'gemini':
        return this.config.gemini?.model || this.config.gemini?.displayModel;
    }
  }

  private exampleModelsForEngine(engine: EngineName): string {
    switch (engine) {
      case 'claude':
        return '`claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`';
      case 'kimi':
        return '`kimi-for-coding`, `kimi-k2`';
      case 'codex':
        return '`gpt-5.4-codex`, `gpt-5.4`, `gpt-5.2-codex`';
      case 'gemini':
        return '`gemini-3.1-pro-preview`, `gemini-2.5-pro`, `gemini-3-flash-preview`';
    }
  }

  private authTipForEngine(engine: EngineName): string {
    switch (engine) {
      case 'claude':
        return '_Make sure Claude Code is authenticated (`claude login`)._';
      case 'kimi':
        return '_Make sure `kimi login` has been completed on this host._';
      case 'codex':
        return '_Make sure Codex CLI is authenticated (`codex login`) or configured with an API key._';
      case 'gemini':
        return '_Make sure `gemini` CLI is authenticated (run `NO_BROWSER=1 gemini` once interactively)._';
    }
  }
}

function isEngineName(value: string): value is EngineName {
  return value === 'claude' || value === 'kimi' || value === 'codex' || value === 'gemini';
}
