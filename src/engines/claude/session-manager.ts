import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Logger } from '../../utils/logger.js';
import { isAntigravityReasoningEffort, type AntigravityReasoningEffort, isCodexReasoningEffort, type CodexContextMode, type CodexReasoningEffort } from '../../config.js';
import type { EngineName } from '../types.js';

export interface UserSession {
  sessionId: string | undefined;
  workingDirectory: string;
  lastUsed: number;
  /** Cumulative token usage across all queries in this session */
  cumulativeTokens: number;
  /** Cumulative cost (USD) across all queries in this session */
  cumulativeCostUsd: number;
  /** Cumulative duration (ms) across all queries in this session */
  cumulativeDurationMs: number;
  /** Durable per-chat model override (e.g. "claude-opus-4-7"). Falls back to bot default when undefined. */
  model?: string;
  /** Durable per-chat engine override ("claude" | "kimi"). Falls back to bot default when undefined. */
  engine?: EngineName;
  /** Durable per-chat Codex context override. Undefined means the bot/Codex default. */
  codexContextMode?: 'long';
  /** Durable per-chat Codex reasoning override. Undefined uses model/bot/Codex defaults. */
  codexReasoningEffort?: CodexReasoningEffort;
  /** Durable, manually selected Antigravity account alias. */
  antigravityAccount?: string;
  antigravityReasoningEffort?: AntigravityReasoningEffort;
}

interface PersistedSession {
  sessionId: string;
  workingDirectory: string;
  lastUsed: number;
  cumulativeTokens?: number;
  cumulativeCostUsd?: number;
  cumulativeDurationMs?: number;
  model?: string;
  engine?: EngineName;
  codexContextMode?: 'long';
  codexReasoningEffort?: CodexReasoningEffort;
  antigravityAccount?: string;
  antigravityReasoningEffort?: AntigravityReasoningEffort;
}

const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
const MAX_SESSIONS = 10_000;

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private persistPath: string;

  constructor(
    private defaultWorkingDirectory: string,
    private logger: Logger,
    botName: string = 'default',
  ) {
    // Persist sessions to a file under the project data dir
    const dataDir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
    fs.mkdirSync(dataDir, { recursive: true });
    this.persistPath = path.join(dataDir, `sessions-${botName}.json`);

    this.loadFromDisk();

    // Periodic cleanup every hour
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60 * 60 * 1000);
  }

  /** Copy settings once, never native history, usage or subsequent failover state. */
  inheritExecutionPreferences(sourceChatId: string, targetChatId: string): void {
    if (sourceChatId === targetChatId || this.sessions.has(targetChatId)) return;
    const source = this.sessions.get(sourceChatId);
    if (!source) return;
    const target = this.getSession(targetChatId);
    Object.assign(target, {
      workingDirectory: source.workingDirectory,
      engine: source.engine,
      model: source.model,
      codexContextMode: source.codexContextMode,
      codexReasoningEffort: source.codexReasoningEffort,
      antigravityAccount: source.antigravityAccount,
      antigravityReasoningEffort: source.antigravityReasoningEffort,
    });
    try { if (!this.saveToDisk(true)) throw new Error('Unable to persist inherited execution preferences'); }
    catch (error) { this.sessions.delete(targetChatId); throw error; }
  }

  getSession(chatId: string): UserSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      // Evict least-recently-used session if at capacity
      if (this.sessions.size >= MAX_SESSIONS) {
        this.evictOldest();
      }
      session = {
        sessionId: undefined,
        workingDirectory: this.defaultWorkingDirectory,
        lastUsed: Date.now(),
        cumulativeTokens: 0,
        cumulativeCostUsd: 0,
        cumulativeDurationMs: 0,
      };
      this.sessions.set(chatId, session);
    }
    session.lastUsed = Date.now();
    return session;
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, s] of this.sessions) {
      if (s.lastUsed < oldestTime) {
        oldestTime = s.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.sessions.delete(oldestKey);
      this.logger.debug({ chatId: oldestKey }, 'Evicted oldest session (capacity limit)');
    }
  }

  setSessionId(chatId: string, sessionId: string): void {
    const session = this.getSession(chatId);
    session.sessionId = sessionId;
    this.logger.debug({ chatId, sessionId: sessionId.slice(0, 8) }, 'Session ID updated');
    this.saveToDisk();
  }

  /** Set per-session working directory. */
  setSessionWorkingDirectory(chatId: string, dir: string): void {
    const session = this.getSession(chatId);
    session.workingDirectory = dir;
    // Switching workdir invalidates Claude's session_id (filesystem state changes).
    session.sessionId = undefined;
    this.logger.info({ chatId, dir }, 'Session working directory updated');
    this.saveToDisk();
  }

  /** Set per-session model override. Pass undefined to clear. */
  setSessionModel(chatId: string, model: string | undefined): void {
    const session = this.getSession(chatId);
    session.model = model;
    this.logger.info({ chatId, model }, 'Session model override updated');
    this.saveToDisk();
  }

  /**
   * Set the Codex context mode for this chat. Context sizing is process-level,
   * so changing it starts a fresh engine conversation while retaining the
   * chat's working directory and the new durable preference.
   */
  setCodexContextMode(
    chatId: string,
    mode: CodexContextMode,
  ): { changed: boolean; sessionReset: boolean } {
    const session = this.getSession(chatId);
    const nextMode = mode === 'long' ? 'long' : undefined;
    if (session.codexContextMode === nextMode) {
      return { changed: false, sessionReset: false };
    }
    session.codexContextMode = nextMode;
    const sessionReset = this.clearConversationState(session);
    this.logger.info({ chatId, mode, sessionReset }, 'Codex context mode updated');
    this.saveToDisk();
    return { changed: true, sessionReset };
  }

  /** Set a per-chat Codex reasoning override and detach the prior thread. */
  setCodexReasoningEffort(
    chatId: string,
    effort: CodexReasoningEffort | undefined,
  ): { changed: boolean; sessionReset: boolean } {
    const session = this.getSession(chatId);
    if (session.codexReasoningEffort === effort) {
      return { changed: false, sessionReset: false };
    }
    session.codexReasoningEffort = effort;
    const sessionReset = this.clearConversationState(session);
    this.logger.info({ chatId, effort, sessionReset }, 'Codex reasoning effort updated');
    this.saveToDisk();
    return { changed: true, sessionReset };
  }

  /** Persist this chat's effort before acknowledging it; detach old engine state. */
  setAntigravityReasoningEffort(
    chatId: string,
    effort: AntigravityReasoningEffort | undefined,
  ): { changed: boolean; sessionReset: boolean } {
    if (effort !== undefined && !isAntigravityReasoningEffort(effort)) {
      throw new Error('Invalid Antigravity reasoning effort');
    }
    const session = this.getSession(chatId);
    if (session.antigravityReasoningEffort === effort) return { changed: false, sessionReset: false };
    const previous = { ...session };
    session.antigravityReasoningEffort = effort;
    const sessionReset = this.clearConversationState(session);
    if (!this.saveToDisk()) {
      Object.assign(session, previous);
      session.antigravityReasoningEffort = previous.antigravityReasoningEffort;
      throw new Error('Failed to persist Antigravity reasoning effort');
    }
    this.logger.info({ chatId, effort, sessionReset }, 'Antigravity reasoning effort updated');
    return { changed: true, sessionReset };
  }

  /** Select an Antigravity account and detach any conversation owned by the old account. */
  setAntigravityAccount(
    chatId: string,
    account: string | undefined,
  ): { changed: boolean; sessionReset: boolean } {
    const session = this.getSession(chatId);
    if (session.antigravityAccount === account) {
      return { changed: false, sessionReset: false };
    }
    const previous = { ...session };
    session.antigravityAccount = account;
    const sessionReset = this.clearConversationState(session);
    if (!this.saveToDisk(true)) {
      Object.assign(session, previous);
      session.antigravityAccount = previous.antigravityAccount;
      throw new Error('Failed to persist Antigravity account selection');
    }
    this.logger.info({ chatId, account, sessionReset }, 'Antigravity account selection updated');
    return { changed: true, sessionReset };
  }

  /**
   * Set per-session engine override. Pass undefined to clear and fall back
   * to the bot's configured engine. Switching engines also clears the prior
   * `sessionId` (engines track conversation state in different stores) and
   * any stale model override, so the next turn starts a fresh session.
   */
  setSessionEngine(chatId: string, engine: EngineName | undefined): void {
    const session = this.getSession(chatId);
    if (session.engine === engine) return;
    session.engine = engine;
    session.sessionId = undefined;
    session.model = undefined;
    this.logger.info({ chatId, engine }, 'Session engine override updated (session reset)');
    this.saveToDisk();
  }

  /** Accumulate token/cost/duration from a completed query into the session totals. */
  addUsage(chatId: string, tokens: number, costUsd: number, durationMs: number): void {
    const session = this.getSession(chatId);
    session.cumulativeTokens += tokens;
    session.cumulativeCostUsd += costUsd;
    session.cumulativeDurationMs += durationMs;
    this.saveToDisk();
  }

  resetSession(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.sessionId = undefined;
      session.cumulativeTokens = 0;
      session.cumulativeCostUsd = 0;
      session.cumulativeDurationMs = 0;
      // Keep working directory
      this.logger.info({ chatId }, 'Session reset');
      this.saveToDisk();
    }
  }

  private hasDurablePreferences(session: UserSession | PersistedSession): boolean {
    return !!session.model
      || !!session.engine
      || !!session.codexContextMode
      || !!session.codexReasoningEffort
      || !!session.antigravityAccount
      || !!session.antigravityReasoningEffort
      || session.workingDirectory !== this.defaultWorkingDirectory;
  }

  private clearConversationState(session: UserSession): boolean {
    const changed =
      !!session.sessionId ||
      session.cumulativeTokens !== 0 ||
      session.cumulativeCostUsd !== 0 ||
      session.cumulativeDurationMs !== 0;
    session.sessionId = undefined;
    session.cumulativeTokens = 0;
    session.cumulativeCostUsd = 0;
    session.cumulativeDurationMs = 0;
    return changed;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const [chatId, session] of this.sessions) {
      if (now - session.lastUsed > SESSION_TTL_MS) {
        if (this.hasDurablePreferences(session)) {
          if (this.clearConversationState(session)) {
            this.logger.info({ chatId }, 'Expired session state cleared; durable preferences retained');
            changed = true;
          }
        } else {
          this.sessions.delete(chatId);
          this.logger.debug({ chatId }, 'Expired session cleaned up');
          changed = true;
        }
      }
    }
    if (changed) {
      this.saveToDisk();
    }
  }

  private saveToDisk(atomic = false): boolean {
    let temporaryPath: string | undefined;
    try {
      const data: Record<string, PersistedSession> = {};
      for (const [chatId, session] of this.sessions) {
        // Persist sessions that have conversation state or durable preferences.
        if (session.sessionId || this.hasDurablePreferences(session)) {
          data[chatId] = {
            sessionId: session.sessionId || '',
            workingDirectory: session.workingDirectory,
            lastUsed: session.lastUsed,
            cumulativeTokens: session.cumulativeTokens,
            cumulativeCostUsd: session.cumulativeCostUsd,
            cumulativeDurationMs: session.cumulativeDurationMs,
            model: session.model,
            engine: session.engine,
            codexContextMode: session.codexContextMode,
            codexReasoningEffort: session.codexReasoningEffort,
            antigravityAccount: session.antigravityAccount,
            antigravityReasoningEffort: session.antigravityReasoningEffort,
          };
        }
      }
      if (atomic) {
        temporaryPath = `${this.persistPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporaryPath, this.persistPath);
        temporaryPath = undefined;
      } else {
        fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
      }
      return true;
    } catch (err) {
      if (temporaryPath && (err as NodeJS.ErrnoException).code !== 'EEXIST') {
        try { fs.unlinkSync(temporaryPath); } catch { /* preserve original save failure */ }
      }
      this.logger.warn({ err }, 'Failed to persist sessions to disk');
      return false;
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data: Record<string, PersistedSession> = JSON.parse(raw);
      const now = Date.now();
      let loaded = 0;
      let retainedExpiredPreferences = 0;
      for (const [chatId, persisted] of Object.entries(data)) {
        const expired = now - persisted.lastUsed > SESSION_TTL_MS;
        if (expired && !this.hasDurablePreferences(persisted)) continue;
        this.sessions.set(chatId, {
          sessionId: expired ? undefined : persisted.sessionId || undefined,
          workingDirectory: persisted.workingDirectory,
          lastUsed: persisted.lastUsed,
          cumulativeTokens: expired ? 0 : (persisted.cumulativeTokens ?? 0),
          cumulativeCostUsd: expired ? 0 : (persisted.cumulativeCostUsd ?? 0),
          cumulativeDurationMs: expired ? 0 : (persisted.cumulativeDurationMs ?? 0),
          model: persisted.model,
          engine: persisted.engine,
          codexContextMode: persisted.codexContextMode === 'long' ? 'long' : undefined,
          codexReasoningEffort: isCodexReasoningEffort(persisted.codexReasoningEffort)
            ? persisted.codexReasoningEffort
            : undefined,
          antigravityReasoningEffort: isAntigravityReasoningEffort(persisted.antigravityReasoningEffort)
            ? persisted.antigravityReasoningEffort
            : undefined,
          antigravityAccount:
            typeof persisted.antigravityAccount === 'string' && persisted.antigravityAccount
              ? persisted.antigravityAccount
              : undefined,
        });
        loaded++;
        if (expired) retainedExpiredPreferences++;
      }
      if (loaded > 0) {
        this.logger.info({ loaded, retainedExpiredPreferences, path: this.persistPath }, 'Restored sessions from disk');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load sessions from disk, starting fresh');
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.saveToDisk();
  }
}
