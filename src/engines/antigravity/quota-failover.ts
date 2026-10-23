// Applied: METABOT-ANTIGRAVITY-ENTITLEMENT-128 (quota != entitlement),
// METABOT-ANTIGRAVITY-EFFORT-VARIANT-001, DELIVERY-CLOSURE-OUTCOME-035.
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { AntigravityBotConfig } from '../../config.js';
import type { ExecutorOptions, ExecutionHandle, SDKMessage } from '../claude/executor.js';
import { resolveAntigravityAccount } from './account-config.js';

/** Do not mistake transient 429/backpressure, login or model entitlement for quota. */
export function isExplicitQuotaExhaustion(text: string): boolean {
  if (
    /oauth|authenticat|sign[ -]?in|permission|denied|not eligible|country|region|location|unknown model|model.*(?:unavailable|not found)|invalid model/i.test(
      text,
    )
  )
    return false;
  return /\bquota(?:[_ -]+limit)?(?:\s+(?:has been|is))?[_ -]*(?:exhausted|exceeded|depleted|reached)\b|\b(?:exhausted|exceeded|depleted)\s+(?:your\s+|the\s+)?quota\b|\b(?:weekly|monthly|daily)\s+(?:usage\s+)?limit\s+(?:reached|exceeded)\b|\binsufficient\s+(?:quota|credits)\b/i.test(
    text,
  );
}

/** Only accept an explicit provider duration, not arbitrary numbers in an error. */
export function quotaResetAt(text: string, now = Date.now()): number | undefined {
  const match = /\bresets?\s+in\s+((?:\d+(?:\.\d+)?\s*[dhms]\s*)+)/i.exec(text);
  if (!match) return undefined;
  const units: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  let seconds = 0;
  for (const part of match[1].matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) seconds += Number(part[1]) * units[part[2].toLowerCase()];
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 35 * 86400) return undefined;
  return now + (seconds + 60) * 1000;
}

/** Shared across chats; production enables durable deadlines once at startup. */
export class AntigravityQuotaHealth {
  private exhausted = new Map<string, number>();
  private storePath?: string;
  private persistenceWarning?: () => void;
  constructor(
    private now: () => number = Date.now,
    private cooldownMs = 5 * 60_000,
  ) {}
  enablePersistence(storePath: string, onWarning?: () => void): void {
    this.storePath = storePath;
    this.persistenceWarning = onWarning;
    try {
      if (!fs.existsSync(storePath)) return;
      if (fs.statSync(storePath).size > 256 * 1024) throw new Error('Quota state too large');
      const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > 1024) throw new Error('Invalid quota state');
      for (const entry of saved.entries) {
        if (!Array.isArray(entry) || !/^[a-f0-9]{64}$/.test(entry[0]) || !Number.isFinite(entry[1])) throw new Error('Invalid quota entry');
      }
      for (const [key, until] of saved.entries) {
        if (until > this.now()) this.exhausted.set(key, Math.max(until, this.exhausted.get(key) ?? 0));
      }
    } catch { this.persistenceWarning?.(); }
  }

  private persist(): void {
    if (!this.storePath) return;
    const temporary = `${this.storePath}.${randomUUID()}.tmp`;
    let owned = false;
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify({version: 1, entries: [...this.exhausted]}), { mode: 0o600, flag: 'wx' });
      owned = true;
      fs.renameSync(temporary, this.storePath);
    } catch {
      if (owned) { try { fs.unlinkSync(temporary); } catch { /* only our own temporary */ } }
      this.persistenceWarning?.();
    }
  }
  private key(runner: string, model: string): string {
    const group = /^(claude|gpt)-/.test(model)
      ? '3p'
      : /^gemini-.*argon/.test(model)
        ? 'argon'
        : /^gemini-/.test(model)
          ? 'gemini'
          : model;
    return createHash('sha256').update(`${path.resolve(runner)}\0${group}`).digest('hex');
  }
  isExhausted(runner: string, model: string): boolean {
    const key = this.key(runner, model);
    const until = this.exhausted.get(key) ?? 0;
    if (until <= this.now()) {
      this.exhausted.delete(key);
      return false;
    }
    return true;
  }
  markExhausted(runner: string, model: string, resetAt?: number): void {
    for (const [key, until] of this.exhausted) if (until <= this.now()) this.exhausted.delete(key);
    if (this.exhausted.size >= 1024) this.exhausted.delete(this.exhausted.keys().next().value!);
    const key = this.key(runner, model);
    const until = Number.isFinite(resetAt) && resetAt! > this.now() ? resetAt! : this.now() + this.cooldownMs;
    this.exhausted.set(key, Math.max(until, this.exhausted.get(key) ?? 0));
    this.persist();
  }
}
export const sharedAntigravityQuotaHealth = new AntigravityQuotaHealth();

export function startQuotaFailover(
  config: AntigravityBotConfig,
  options: ExecutorOptions,
  startAttempt: (options: ExecutorOptions) => ExecutionHandle,
  health = sharedAntigravityQuotaHealth,
): ExecutionHandle {
  const original = resolveAntigravityAccount(config, options.antigravityAccount)!;
  const effort = options.antigravityReasoningEffort ?? config.effort;
  const baseModel = options.model ?? config.model;
  const model = effort ? baseModel?.replace(/-(low|medium|high|xhigh|max)$/, `-${effort}`) : baseModel;
  if (!model) return startAttempt(options); // Never guess the model/entitlement.
  let active: ExecutionHandle | undefined;
  let stopped = false;
  const cancelled = () => stopped || options.abortController.signal.aborted;
  const failure = (text: string): SDKMessage => ({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: '',
    errors: [text],
  });

  async function* run(): AsyncGenerator<SDKMessage> {
    const aliases = Object.keys(config.accounts!);
    const offset = aliases.indexOf(original.alias);
    const ordered = [...aliases.slice(offset), ...aliases.slice(0, offset)];
    const triedRunners = new Set<string>();
    try {
      for (const alias of ordered) {
        if (cancelled()) return;
        const account = resolveAntigravityAccount(config, alias)!;
        const runnerKey = path.resolve(account.runner);
        if (triedRunners.has(runnerKey)) continue;
        triedRunners.add(runnerKey);
        if (health.isExhausted(account.runner, model!)) continue;
        const switched = alias !== original.alias;
        if (switched) {
          // No fallback on a missing model or failed catalog. Query the isolated runner.
          const { fetchAntigravityModels } = await import('./model-catalog.js');
          let eligible = false;
          try {
            eligible = (await fetchAntigravityModels(config, alias)).some((item) => item.id === model);
          } catch {
            yield failure('备用账号模型目录查询失败；未自动换号，请稍后重试。');
            return;
          }
          if (cancelled()) return;
          if (!eligible) {
            yield failure('备用账号不支持当前模型及思考档位；未降级模型或自动换号。');
            return;
          }
          // Persist account ownership BEFORE starting a new native conversation.
          if (options.sessionId && !options.onAntigravityAccountSwitch) {
            yield failure('账号切换缺少会话持久化回调，已停止以保护旧会话。');
            return;
          }
          try {
            await options.onAntigravityAccountSwitch?.(alias);
          } catch {
            yield failure('无法保存账号切换状态，未启动备用账号。');
            return;
          }
          if (cancelled()) return;
        }
        const prompt =
          switched && options.sessionId
            ? `${options.prompt}\n\n[MetaBot account handoff: the previous native conversation is retained in the old account but is not available in this new conversation. Use only the supplied context and explicit evidence; do not pretend to recall missing history.]`
            : options.prompt;
        active = startAttempt({
          ...options,
          prompt,
          antigravityAccount: alias,
          sessionId: switched ? undefined : options.sessionId,
        });
        let init: SDKMessage | undefined;
        let announced = false;
        let terminal: SDKMessage | undefined;
        for await (const message of active.stream) {
          if (cancelled()) return;
          if (message.type === 'system' && message.subtype === 'init') {
            init = message;
            continue;
          }
          if (message.type === 'result') {
            terminal = message;
            break;
          }
          if (init) {
            yield init;
            init = undefined;
          }
          if (switched && !announced) {
            announced = true;
            yield {
              type: 'assistant',
              message: {
                content: [
                  { type: 'text', text: `额度耗尽，已自动切换到 ${alias}，并开启新会话；旧会话记录保留。\n\n` },
                ],
              },
            };
          }
          yield message;
        }
        active.finish();
        active = undefined;
        if (cancelled()) return;
        if (terminal?.is_error && terminal.antigravityFailure?.quotaExhausted) {
          health.markExhausted(account.runner, model!, quotaResetAt((terminal.errors ?? []).join('\n')));
          if (terminal.antigravityFailure.safeToRetry) continue;
          terminal.errors = [
            ...(terminal.errors ?? []),
            '当前任务已产生执行进展，未换号重跑；后续消息会避开该耗尽账号。',
          ];
        }
        if (init) yield init;
        yield terminal ?? failure('Antigravity 未返回终态，未自动重跑。');
        return;
      }
      if (!cancelled())
        yield failure('已配置账号的当前模型额度均耗尽，未继续重试。有明确恢复时间时避让到该时间；未知恢复时间时冷却 5 分钟。');
    } finally {
      active?.finish();
    }
  }
  return {
    stream: run(),
    sendAnswer: (...args) => active?.sendAnswer(...args),
    resolveQuestion: (...args) => active?.resolveQuestion(...args),
    finish: () => {
      stopped = true;
      active?.finish();
    },
  };
}
