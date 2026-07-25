import 'dotenv/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Agent engine backing a bot. */
export type EngineName = 'claude' | 'kimi' | 'codex' | 'gemini';

/** Shared config fields used by MessageBridge and Executors (platform-agnostic). */
export interface BotConfigBase {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  ttsVoice?: string;
  /** Agent engine. Defaults to 'claude' for backward compatibility. */
  engine?: EngineName;
  claude: {
    defaultWorkingDirectory: string;
    maxTurns: number | undefined;
    maxBudgetUsd: number | undefined;
    model: string | undefined;
    /** Explicit Anthropic API key. When set, child Claude Code processes use this
     *  key instead of ~/.claude/.credentials.json. Supports cc-switch compatibility:
     *  leave unset to let Claude Code resolve auth dynamically. */
    apiKey: string | undefined;
    /** Extra environment variables passed only to this Claude Code subprocess. */
    env?: Record<string, string>;
    /** File containing ANTHROPIC_AUTH_TOKEN for Claude-compatible providers. */
    authTokenFile?: string;
    /** Optional Volcengine Ark control-plane credentials for Coding/Agent Plan quota. */
    arkQuota?: ArkQuotaConfig;
    outputsBaseDir: string;
    downloadsDir: string;
  };
  /** Kimi-specific overrides. Populated only when engine === 'kimi'. Phase 2. */
  kimi?: {
    executable?: string;
    model?: string;
    thinking?: boolean;
    apiKey?: string;
    /** Context window size in tokens (defaults to 262144 — Kimi for Coding default). */
    contextWindow?: number;
  };
  /** Codex-specific overrides. Populated only when engine === 'codex'. */
  codex?: CodexBotConfig;
  /** Gemini-specific overrides. Populated only when engine === 'gemini'. */
  gemini?: GeminiBotConfig;
  /**
   * Optional map: Feishu chatId → list of peer bot names that also live in
   * that chat. When set, MessageBridge.handleMessage fills apiContext with
   * groupMembers + groupId (= chatId) so the engine's system prompt includes
   * the "## Group Chat" hint teaching the bot to use
   * `mb talk <peer> grouptalk-<chatId>-<peer> "..."` for visible inter-bot
   * dialogue. Without this map, the bot operates as a solo bot even if
   * other bots happen to be in the same Feishu chat.
   */
  feishuGroups?: Record<string, string[]>;
}

/** Gemini-specific overrides. Populated only when engine === 'gemini'. */
export interface GeminiBotConfig {
  executable?: string;
  model?: string;
  displayModel?: string;
  /** gemini-cli --approval-mode value. Defaults to 'yolo' (auto-approve). */
  approvalMode?: 'default' | 'auto_edit' | 'yolo' | 'plan';
  /** Context window size in tokens for display only. */
  contextWindow?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
}

/** Codex-specific overrides. Populated only when engine === 'codex'. */
export interface CodexBotConfig {
  executable?: string;
  /** Codex execution transport. 'exec' keeps the legacy codex exec path; 'app-server' enables official thread APIs like goal. */
  transport?: 'exec' | 'app-server';
  model?: string;
  displayModel?: string;
  profile?: string;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** Context window size in tokens for display only. */
  contextWindow?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
  /**
   * Browser origins that MetaBot may approve automatically when Codex app-server
   * asks for browser-origin access. Exact origins only, e.g.
   * "https://chatgpt.com".
   */
  autoApproveBrowserOrigins?: string[];
}

/** Feishu bot config (extends base with Feishu credentials). */
export interface BotConfig extends BotConfigBase {
  feishu: {
    appId: string;
    appSecret: string;
  };
  /** When true, respond to all messages in group chats without requiring @mention. */
  groupNoMention?: boolean;
}

/** Telegram bot config (extends base with Telegram credentials). */
export interface TelegramBotConfig extends BotConfigBase {
  telegram: {
    botToken: string;
  };
}

/** WeChat bot config (extends base with iLink credentials). */
export interface WechatBotConfig extends BotConfigBase {
  wechat: {
    ilinkBaseUrl?: string;
    botToken?: string;
  };
}

export interface PeerConfig {
  name: string;
  url: string;
  secret?: string;
}

export interface ConsensusProfileConfig {
  /** Panelist bots that produce independent takes and critiques. */
  panelists: string[];
  /** Optional non-panelist bot used first in Phase 4 synthesis. */
  synthesizerBot?: string;
  type?: 'empirical' | 'architectural' | 'preference';
  stakes?: 'low' | 'medium' | 'high';
  costCapUsd?: number;
  maxRounds?: number;
}

export interface AppConfig {
  feishuBots: BotConfig[];
  telegramBots: TelegramBotConfig[];
  webBots: BotConfigBase[];
  wechatBots: WechatBotConfig[];
  /** Optional named consensus presets. Bot names are deployment-local. */
  consensusProfiles: Record<string, ConsensusProfileConfig>;
  /** Dedicated Feishu service app for wiki sync & doc reader (independent of chat bots). */
  feishuService?: {
    appId: string;
    appSecret: string;
  };
  log: {
    level: string;
  };
  memoryServerUrl: string;
  api: {
    port: number;
    secret?: string;
  };
  memory: {
    enabled: boolean;
    port: number;
    databaseDir: string;
    secret: string;
    adminToken?: string;
    readerToken?: string;
  };
  /** Peer MetaBot instances for cross-instance bot discovery and task delegation. */
  peers: PeerConfig[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function expandUserPath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

// --- Feishu JSON entry (used in bots.json) ---

/** Kimi-specific overrides in bots.json. */
export interface KimiJsonConfig {
  executable?: string;
  model?: string;
  thinking?: boolean;
  apiKey?: string;
  /** Context window size in tokens (defaults to 262144 — Kimi for Coding default). */
  contextWindow?: number;
}

/** Claude-specific overrides in bots.json. */
export interface ClaudeJsonConfig {
  env?: Record<string, string>;
  authTokenFile?: string;
  arkQuota?: ArkQuotaJsonConfig;
}

export interface ArkQuotaJsonConfig {
  accessKeyId?: string;
  secretAccessKey?: string;
  accessKeyIdFile?: string;
  secretAccessKeyFile?: string;
  region?: string;
}

export interface ArkQuotaConfig extends ArkQuotaJsonConfig {
  accessKeyIdFile?: string;
  secretAccessKeyFile?: string;
}

/** Gemini-specific overrides in bots.json. */
export interface GeminiJsonConfig {
  executable?: string;
  model?: string;
  displayModel?: string;
  approvalMode?: 'default' | 'auto_edit' | 'yolo' | 'plan';
  contextWindow?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
}

/** Codex-specific overrides in bots.json. */
export interface CodexJsonConfig {
  executable?: string;
  /** Codex execution transport. 'exec' keeps the legacy codex exec path; 'app-server' enables official thread APIs like goal. */
  transport?: 'exec' | 'app-server';
  model?: string;
  displayModel?: string;
  profile?: string;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** Context window size in tokens for display only. */
  contextWindow?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
  autoApproveBrowserOrigins?: string[];
}

/** Fields shared across all bot JSON entries (engine selection and engine overrides). */
interface EngineJsonFields {
  engine?: EngineName;
  claude?: ClaudeJsonConfig;
  kimi?: KimiJsonConfig;
  codex?: CodexJsonConfig;
  gemini?: GeminiJsonConfig;
}

export interface FeishuBotJsonEntry extends EngineJsonFields {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  ttsVoice?: string;
  feishuAppId: string;
  feishuAppSecret: string;
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  apiKey?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
  /** When true, respond to all messages in group chats without requiring @mention. */
  groupNoMention?: boolean;
  /**
   * Optional map: Feishu chatId → list of peer bot names (this bot's name may
   * be included or omitted; it is auto-filtered out). Declares which other
   * metabot-managed bots also live in that chat so the engine's system prompt
   * can teach the bot how to reach them via `mb talk`.
   *
   * Example:
   *   "feishuGroups": {
   *     "oc_d1e2d41e0427d84d2aa3b7f3cf81509f": ["gemini"],
   *     "oc_a9b393cd795f4dd7de3f0cf0b5193335": ["gemini", "codex-helper"]
   *   }
   */
  feishuGroups?: Record<string, string[]>;
}

function feishuBotFromJson(entry: FeishuBotJsonEntry): BotConfig {
  const codex = buildCodexConfig(entry.codex);
  const gemini = buildGeminiConfig(entry.gemini);
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.specialties?.length ? { specialties: entry.specialties } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    ...(entry.maxConcurrentTasks != null ? { maxConcurrentTasks: entry.maxConcurrentTasks } : {}),
    ...(entry.budgetLimitDaily != null ? { budgetLimitDaily: entry.budgetLimitDaily } : {}),
    ...(entry.ttsVoice ? { ttsVoice: entry.ttsVoice } : {}),
    ...(entry.groupNoMention ? { groupNoMention: true } : {}),
    ...(entry.engine ? { engine: entry.engine } : {}),
    ...(entry.kimi ? { kimi: entry.kimi } : {}),
    ...(codex ? { codex } : {}),
    ...(gemini ? { gemini } : {}),
    ...(entry.feishuGroups ? { feishuGroups: entry.feishuGroups } : {}),
    feishu: {
      appId: entry.feishuAppId,
      appSecret: entry.feishuAppSecret,
    },
    claude: buildClaudeConfig(entry),
  };
}

// --- Telegram JSON entry (used in bots.json) ---

export interface TelegramBotJsonEntry extends EngineJsonFields {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  ttsVoice?: string;
  telegramBotToken: string;
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  apiKey?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}

function telegramBotFromJson(entry: TelegramBotJsonEntry): TelegramBotConfig {
  const codex = buildCodexConfig(entry.codex);
  const gemini = buildGeminiConfig(entry.gemini);
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.specialties?.length ? { specialties: entry.specialties } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    ...(entry.maxConcurrentTasks != null ? { maxConcurrentTasks: entry.maxConcurrentTasks } : {}),
    ...(entry.budgetLimitDaily != null ? { budgetLimitDaily: entry.budgetLimitDaily } : {}),
    ...(entry.ttsVoice ? { ttsVoice: entry.ttsVoice } : {}),
    ...(entry.engine ? { engine: entry.engine } : {}),
    ...(entry.kimi ? { kimi: entry.kimi } : {}),
    ...(codex ? { codex } : {}),
    ...(gemini ? { gemini } : {}),
    telegram: {
      botToken: entry.telegramBotToken,
    },
    claude: buildClaudeConfig(entry),
  };
}

// --- Web bot JSON entry (used in bots.json — no IM credentials needed) ---

export interface WebBotJsonEntry extends EngineJsonFields {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  ttsVoice?: string;
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}

export function webBotFromJson(entry: WebBotJsonEntry): BotConfigBase {
  const codex = buildCodexConfig(entry.codex);
  const gemini = buildGeminiConfig(entry.gemini);
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.specialties?.length ? { specialties: entry.specialties } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    ...(entry.maxConcurrentTasks != null ? { maxConcurrentTasks: entry.maxConcurrentTasks } : {}),
    ...(entry.budgetLimitDaily != null ? { budgetLimitDaily: entry.budgetLimitDaily } : {}),
    ...(entry.ttsVoice ? { ttsVoice: entry.ttsVoice } : {}),
    ...(entry.engine ? { engine: entry.engine } : {}),
    ...(entry.kimi ? { kimi: entry.kimi } : {}),
    ...(codex ? { codex } : {}),
    ...(gemini ? { gemini } : {}),
    claude: buildClaudeConfig(entry),
  };
}

// --- WeChat JSON entry (used in bots.json) ---

export interface WechatBotJsonEntry extends EngineJsonFields {
  name: string;
  description?: string;
  ilinkBaseUrl?: string;
  wechatBotToken?: string;
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  apiKey?: string;
  outputsBaseDir?: string;
  downloadsDir?: string;
}

function wechatBotFromJson(entry: WechatBotJsonEntry): WechatBotConfig {
  const codex = buildCodexConfig(entry.codex);
  const gemini = buildGeminiConfig(entry.gemini);
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.engine ? { engine: entry.engine } : {}),
    ...(entry.kimi ? { kimi: entry.kimi } : {}),
    ...(codex ? { codex } : {}),
    ...(gemini ? { gemini } : {}),
    wechat: {
      ilinkBaseUrl: entry.ilinkBaseUrl,
      botToken: entry.wechatBotToken,
    },
    claude: buildClaudeConfig(entry),
  };
}

// --- Shared Claude config builder ---

function buildClaudeConfig(entry: {
  defaultWorkingDirectory: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  apiKey?: string;
  claude?: ClaudeJsonConfig;
  outputsBaseDir?: string;
  downloadsDir?: string;
}): BotConfigBase['claude'] {
  return {
    defaultWorkingDirectory: expandUserPath(entry.defaultWorkingDirectory),
    maxTurns: entry.maxTurns ?? (process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined),
    maxBudgetUsd:
      entry.maxBudgetUsd ??
      (process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined),
    model: entry.model || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    apiKey: entry.apiKey || undefined,
    ...(entry.claude?.env ? { env: entry.claude.env } : {}),
    ...(entry.claude?.authTokenFile ? { authTokenFile: expandUserPath(entry.claude.authTokenFile) } : {}),
    ...(entry.claude?.arkQuota
      ? {
          arkQuota: {
            ...entry.claude.arkQuota,
            ...(entry.claude.arkQuota.accessKeyIdFile
              ? { accessKeyIdFile: expandUserPath(entry.claude.arkQuota.accessKeyIdFile) }
              : {}),
            ...(entry.claude.arkQuota.secretAccessKeyFile
              ? { secretAccessKeyFile: expandUserPath(entry.claude.arkQuota.secretAccessKeyFile) }
              : {}),
          },
        }
      : {}),
    outputsBaseDir:
      entry.outputsBaseDir ||
      process.env.OUTPUTS_BASE_DIR ||
      path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
    downloadsDir:
      entry.downloadsDir ||
      process.env.DOWNLOADS_DIR ||
      path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`),
  };
}

function buildCodexConfig(entry?: CodexJsonConfig): BotConfigBase['codex'] | undefined {
  const envAutoApproveOrigins = process.env.CODEX_AUTO_APPROVE_BROWSER_ORIGINS
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const cfg: BotConfigBase['codex'] = {
    ...(process.env.CODEX_EXECUTABLE_PATH ? { executable: process.env.CODEX_EXECUTABLE_PATH } : {}),
    ...(process.env.CODEX_TRANSPORT ? { transport: process.env.CODEX_TRANSPORT as CodexJsonConfig['transport'] } : {}),
    ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
    ...(process.env.CODEX_DISPLAY_MODEL ? { displayModel: process.env.CODEX_DISPLAY_MODEL } : {}),
    ...(process.env.CODEX_PROFILE ? { profile: process.env.CODEX_PROFILE } : {}),
    ...(process.env.CODEX_APPROVAL_POLICY
      ? { approvalPolicy: process.env.CODEX_APPROVAL_POLICY as CodexJsonConfig['approvalPolicy'] }
      : {}),
    ...(process.env.CODEX_SANDBOX ? { sandbox: process.env.CODEX_SANDBOX as CodexJsonConfig['sandbox'] } : {}),
    ...(process.env.CODEX_BYPASS_APPROVALS_AND_SANDBOX === 'true'
      ? { dangerouslyBypassApprovalsAndSandbox: true }
      : {}),
    ...(process.env.CODEX_CONTEXT_WINDOW ? { contextWindow: parseInt(process.env.CODEX_CONTEXT_WINDOW, 10) } : {}),
    ...(envAutoApproveOrigins?.length ? { autoApproveBrowserOrigins: envAutoApproveOrigins } : {}),
    ...(entry ?? {}),
  };
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

function buildGeminiConfig(entry?: GeminiJsonConfig): BotConfigBase['gemini'] | undefined {
  const cfg: BotConfigBase['gemini'] = {
    ...(process.env.GEMINI_EXECUTABLE_PATH ? { executable: process.env.GEMINI_EXECUTABLE_PATH } : {}),
    ...(process.env.GEMINI_MODEL ? { model: process.env.GEMINI_MODEL } : {}),
    ...(process.env.GEMINI_DISPLAY_MODEL ? { displayModel: process.env.GEMINI_DISPLAY_MODEL } : {}),
    ...(process.env.GEMINI_APPROVAL_MODE
      ? { approvalMode: process.env.GEMINI_APPROVAL_MODE as GeminiJsonConfig['approvalMode'] }
      : {}),
    ...(process.env.GEMINI_CONTEXT_WINDOW ? { contextWindow: parseInt(process.env.GEMINI_CONTEXT_WINDOW, 10) } : {}),
    ...(entry ?? {}),
  };
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

// --- Single-bot env var mode ---

function feishuBotFromEnv(): BotConfig {
  const codex = buildCodexConfig();
  const gemini = buildGeminiConfig();
  return {
    name: 'default',
    ...(process.env.METABOT_ENGINE ? { engine: process.env.METABOT_ENGINE as EngineName } : {}),
    ...(codex ? { codex } : {}),
    ...(gemini ? { gemini } : {}),
    feishu: {
      appId: required('FEISHU_APP_ID'),
      appSecret: required('FEISHU_APP_SECRET'),
    },
    claude: {
      defaultWorkingDirectory: expandUserPath(required('CLAUDE_DEFAULT_WORKING_DIRECTORY')),
      maxTurns: process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined,
      maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-8',
      apiKey: undefined,
      outputsBaseDir:
        process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
      downloadsDir: process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`),
    },
  };
}

function telegramBotFromEnv(): TelegramBotConfig {
  const codex = buildCodexConfig();
  const gemini = buildGeminiConfig();
  return {
    name: 'telegram-default',
    ...(process.env.METABOT_ENGINE ? { engine: process.env.METABOT_ENGINE as EngineName } : {}),
    ...(codex ? { codex } : {}),
    ...(gemini ? { gemini } : {}),
    telegram: {
      botToken: required('TELEGRAM_BOT_TOKEN'),
    },
    claude: {
      defaultWorkingDirectory: expandUserPath(required('CLAUDE_DEFAULT_WORKING_DIRECTORY')),
      maxTurns: process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined,
      maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-8',
      apiKey: undefined,
      outputsBaseDir:
        process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
      downloadsDir: process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`),
    },
  };
}

function wechatBotFromEnv(): WechatBotConfig {
  const codex = buildCodexConfig();
  const gemini = buildGeminiConfig();
  return {
    name: 'wechat-default',
    ...(process.env.METABOT_ENGINE ? { engine: process.env.METABOT_ENGINE as EngineName } : {}),
    ...(codex ? { codex } : {}),
    ...(gemini ? { gemini } : {}),
    wechat: {
      botToken: process.env.WECHAT_BOT_TOKEN || undefined,
    },
    claude: {
      defaultWorkingDirectory: expandUserPath(required('CLAUDE_DEFAULT_WORKING_DIRECTORY')),
      maxTurns: process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : undefined,
      maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined,
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-8',
      apiKey: undefined,
      outputsBaseDir: expandUserPath(
        process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `metabot-outputs-${os.userInfo().username}`),
      ),
      downloadsDir: expandUserPath(
        process.env.DOWNLOADS_DIR || path.join(os.tmpdir(), `metabot-downloads-${os.userInfo().username}`),
      ),
    },
  };
}

// --- New bots.json format ---

export interface PeerJsonEntry {
  name: string;
  url: string;
  secret?: string;
}

export interface ConsensusProfileJsonEntry {
  /** Preferred name. */
  panelists?: string[];
  /** Backward/ergonomic alias accepted by config loader. */
  bots?: string[];
  synthesizerBot?: string;
  type?: 'empirical' | 'architectural' | 'preference';
  stakes?: 'low' | 'medium' | 'high';
  costCapUsd?: number;
  maxRounds?: number;
}

export interface BotsJsonNewFormat {
  feishuBots?: FeishuBotJsonEntry[];
  telegramBots?: TelegramBotJsonEntry[];
  webBots?: WebBotJsonEntry[];
  wechatBots?: WechatBotJsonEntry[];
  peers?: PeerJsonEntry[];
  consensusProfiles?: Record<string, ConsensusProfileJsonEntry>;
}

function normalizeConsensusProfiles(
  raw?: Record<string, ConsensusProfileJsonEntry>,
): Record<string, ConsensusProfileConfig> {
  if (!raw) return {};
  const validTypes = new Set(['empirical', 'architectural', 'preference']);
  const validStakes = new Set(['low', 'medium', 'high']);
  const profiles: Record<string, ConsensusProfileConfig> = {};
  for (const [name, profile] of Object.entries(raw)) {
    const panelists = profile.panelists ?? profile.bots;
    if (
      !Array.isArray(panelists) ||
      panelists.length === 0 ||
      !panelists.every((b) => typeof b === 'string' && b.trim())
    ) {
      throw new Error(`Invalid consensusProfiles.${name}: panelists must be a non-empty string array`);
    }
    if (profile.type && !validTypes.has(profile.type)) {
      throw new Error(`Invalid consensusProfiles.${name}.type: ${profile.type}`);
    }
    if (profile.stakes && !validStakes.has(profile.stakes)) {
      throw new Error(`Invalid consensusProfiles.${name}.stakes: ${profile.stakes}`);
    }
    if (profile.costCapUsd !== undefined && (!Number.isFinite(profile.costCapUsd) || profile.costCapUsd < 0)) {
      throw new Error(`Invalid consensusProfiles.${name}.costCapUsd: must be a non-negative number`);
    }
    if (profile.maxRounds !== undefined && (!Number.isInteger(profile.maxRounds) || profile.maxRounds < 1)) {
      throw new Error(`Invalid consensusProfiles.${name}.maxRounds: must be a positive integer`);
    }
    profiles[name] = {
      panelists: panelists.map((b) => b.trim()),
      ...(typeof profile.synthesizerBot === 'string' && profile.synthesizerBot.trim()
        ? { synthesizerBot: profile.synthesizerBot.trim() }
        : {}),
      ...(profile.type ? { type: profile.type } : {}),
      ...(profile.stakes ? { stakes: profile.stakes } : {}),
      ...(typeof profile.costCapUsd === 'number' ? { costCapUsd: profile.costCapUsd } : {}),
      ...(typeof profile.maxRounds === 'number' ? { maxRounds: profile.maxRounds } : {}),
    };
  }
  return profiles;
}

export function loadAppConfig(): AppConfig {
  const botsConfigPath = process.env.BOTS_CONFIG;

  let feishuBots: BotConfig[] = [];
  let telegramBots: TelegramBotConfig[] = [];
  let webBots: BotConfigBase[] = [];
  let wechatBots: WechatBotConfig[] = [];
  let consensusProfiles: Record<string, ConsensusProfileConfig> = {};
  let parsedConfig: unknown;

  if (botsConfigPath) {
    const resolved = path.resolve(botsConfigPath);
    const raw = fs.readFileSync(resolved, 'utf-8');
    const parsed = JSON.parse(raw);
    parsedConfig = parsed;

    if (Array.isArray(parsed)) {
      // Old format: array of feishu bot entries (backward compatible)
      if (parsed.length === 0) {
        throw new Error(`BOTS_CONFIG file must contain a non-empty array or object: ${resolved}`);
      }
      feishuBots = (parsed as FeishuBotJsonEntry[]).map(feishuBotFromJson);
    } else if (parsed && typeof parsed === 'object') {
      // New format: { feishuBots: [...], telegramBots: [...], webBots: [...] }
      const cfg = parsed as BotsJsonNewFormat;
      if (cfg.feishuBots) {
        feishuBots = cfg.feishuBots.map(feishuBotFromJson);
      }
      if (cfg.telegramBots) {
        telegramBots = cfg.telegramBots.map(telegramBotFromJson);
      }
      if (cfg.webBots) {
        webBots = cfg.webBots.map(webBotFromJson);
      }
      if (cfg.wechatBots) {
        wechatBots = cfg.wechatBots.map(wechatBotFromJson);
      }
      consensusProfiles = normalizeConsensusProfiles(cfg.consensusProfiles);
      if (feishuBots.length === 0 && telegramBots.length === 0 && webBots.length === 0 && wechatBots.length === 0) {
        throw new Error(`BOTS_CONFIG file must define at least one bot: ${resolved}`);
      }
    } else {
      throw new Error(`BOTS_CONFIG file must contain a JSON array or object: ${resolved}`);
    }
  } else {
    // Single-bot mode from environment variables
    if (process.env.FEISHU_APP_ID) {
      feishuBots = [feishuBotFromEnv()];
    }
    if (process.env.TELEGRAM_BOT_TOKEN) {
      telegramBots = [telegramBotFromEnv()];
    }
    if (process.env.WECHAT_BOT_TOKEN || process.env.WECHAT_ILINK_ENABLED === 'true') {
      wechatBots = [wechatBotFromEnv()];
    }
    if (feishuBots.length === 0 && telegramBots.length === 0 && wechatBots.length === 0) {
      throw new Error(
        'No bot configured. Set FEISHU_APP_ID/FEISHU_APP_SECRET, TELEGRAM_BOT_TOKEN, or WECHAT_ILINK_ENABLED=true, or use BOTS_CONFIG for multi-bot mode.',
      );
    }
  }

  const memoryServerUrl = (
    process.env.META_MEMORY_URL ||
    process.env.MEMORY_SERVER_URL ||
    'http://localhost:8100'
  ).replace(/\/+$/, '');

  const apiPort = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : 9100;
  const apiSecret = process.env.API_SECRET || undefined;

  // Expose as METABOT_* env vars so Claude Code skills can read them via shell expansion
  process.env.METABOT_API_PORT = String(apiPort);
  if (apiSecret) {
    process.env.METABOT_API_SECRET = apiSecret;
  }

  // Feishu service app for wiki sync & doc reader (falls back to first Feishu bot)
  let feishuService: AppConfig['feishuService'];
  if (process.env.FEISHU_SERVICE_APP_ID && process.env.FEISHU_SERVICE_APP_SECRET) {
    feishuService = {
      appId: process.env.FEISHU_SERVICE_APP_ID,
      appSecret: process.env.FEISHU_SERVICE_APP_SECRET,
    };
  } else if (feishuBots.length > 0) {
    feishuService = {
      appId: feishuBots[0].feishu.appId,
      appSecret: feishuBots[0].feishu.appSecret,
    };
  }

  const memoryEnabled = process.env.MEMORY_ENABLED !== 'false';
  const memoryPort = process.env.MEMORY_PORT ? parseInt(process.env.MEMORY_PORT, 10) : 8100;
  const memoryDatabaseDir = process.env.MEMORY_DATABASE_DIR || './data';
  const memorySecret = process.env.MEMORY_SECRET || process.env.API_SECRET || '';
  const memoryAdminToken = process.env.MEMORY_ADMIN_TOKEN || undefined;
  const memoryReaderToken = process.env.MEMORY_TOKEN || undefined;

  // Parse peers from JSON config and/or env vars
  const peers: PeerConfig[] = [];
  if (botsConfigPath && parsedConfig && !Array.isArray(parsedConfig)) {
    const cfg = parsedConfig as BotsJsonNewFormat;
    if (cfg.peers) {
      for (const p of cfg.peers) {
        peers.push({ name: p.name, url: p.url.replace(/\/+$/, ''), secret: p.secret });
      }
    }
  }
  if (process.env.METABOT_PEERS) {
    const urls = process.env.METABOT_PEERS.split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    const secrets = (process.env.METABOT_PEER_SECRETS || '').split(',').map((s) => s.trim());
    const names = (process.env.METABOT_PEER_NAMES || '').split(',').map((s) => s.trim());
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i].replace(/\/+$/, '');
      if (!peers.some((p) => p.url === url)) {
        const autoName = names[i] || url.replace(/^https?:\/\//, '').replace(/[:.]/g, '-');
        peers.push({ name: autoName, url, secret: secrets[i] || undefined });
      }
    }
  }

  return {
    feishuBots,
    telegramBots,
    webBots,
    wechatBots,
    consensusProfiles,
    feishuService,
    log: {
      level: process.env.LOG_LEVEL || 'info',
    },
    memoryServerUrl,
    api: {
      port: apiPort,
      secret: apiSecret,
    },
    memory: {
      enabled: memoryEnabled,
      port: memoryPort,
      databaseDir: memoryDatabaseDir,
      secret: memorySecret,
      adminToken: memoryAdminToken,
      readerToken: memoryReaderToken,
    },
    peers,
  };
}
