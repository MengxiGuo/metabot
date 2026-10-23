import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../utils/logger.js';

/**
 * Per-bot model fallback state.
 *
 * When the configured primary model (typically Opus) hits a plan quota
 * limit, mark `degraded=true` so subsequent queries use `fallbackModel`
 * (Sonnet). A periodic probe re-tries the primary model after `probeAt`
 * to detect quota refresh — on success, clear `degraded`.
 */
export interface FallbackState {
  degraded: boolean;
  /** Reason the primary was degraded (for logs/UI). */
  reason?: string;
  /** Epoch ms when primary first failed. */
  since?: number;
  /** Epoch ms after which we try the primary again as a probe. */
  probeAt?: number;
  /** Last error message captured (truncated). */
  lastError?: string;
}

const DEFAULT_FALLBACK_MODEL = 'claude-sonnet-4-6';
const PROBE_INTERVAL_HOURS = 6;
const STATE_DIR = '/root/metabot/data/model-fallback';

export class ModelFallbackManager {
  private state: FallbackState;
  private readonly statePath: string;

  constructor(
    private readonly botName: string,
    private readonly logger: Logger,
    private readonly fallbackModel: string = DEFAULT_FALLBACK_MODEL,
  ) {
    this.statePath = path.join(STATE_DIR, `${this.sanitizeName(botName)}.json`);
    this.state = this.load();
  }

  /** Returns the model to use right now given the configured primary. */
  resolveModel(configured: string | undefined): string | undefined {
    if (!configured) return configured;
    // Only fall back on Opus → Sonnet. Other primaries pass through unchanged.
    if (!configured.includes('opus')) return configured;
    if (!this.state.degraded) return configured;
    // Probe window — let one request try the primary again.
    if (this.state.probeAt && Date.now() >= this.state.probeAt) {
      this.logger.info({ probeAt: this.state.probeAt }, 'Model fallback probing primary');
      return configured;
    }
    return this.fallbackModel;
  }

  /** True if we are currently routing to the fallback (not probing). */
  isDegraded(): boolean {
    return this.state.degraded && !(this.state.probeAt && Date.now() >= this.state.probeAt);
  }

  /** Returns true if the supplied error looks like a plan/quota rate limit. */
  classifyError(err: unknown): { isQuota: boolean; modelHint?: string } {
    const text = this.errText(err);
    if (!text) return { isQuota: false };
    const lower = text.toLowerCase();
    const isQuota =
      lower.includes('rate_limit') ||
      lower.includes('rate limit') ||
      lower.includes('usage limit') ||
      lower.includes('weekly limit') ||
      lower.includes('quota') ||
      / 429\b/.test(lower);
    let modelHint: string | undefined;
    if (lower.includes('opus')) modelHint = 'opus';
    else if (lower.includes('sonnet')) modelHint = 'sonnet';
    return { isQuota, modelHint };
  }

  /** Mark the primary as exhausted. Sets probeAt to now + interval. */
  markPrimaryExhausted(primaryModel: string, errorText: string): void {
    const now = Date.now();
    this.state = {
      degraded: true,
      reason: `primary quota: ${primaryModel}`,
      since: this.state.since ?? now,
      probeAt: now + PROBE_INTERVAL_HOURS * 3600 * 1000,
      lastError: this.truncate(errorText, 400),
    };
    this.persist();
    this.logger.warn(
      { primary: primaryModel, fallback: this.fallbackModel, probeAt: this.state.probeAt },
      'Model fallback engaged',
    );
  }

  /** Push the probe deadline out — used when a probe attempt also fails. */
  delayNextProbe(errorText: string): void {
    this.state = {
      ...this.state,
      degraded: true,
      probeAt: Date.now() + PROBE_INTERVAL_HOURS * 3600 * 1000,
      lastError: this.truncate(errorText, 400),
    };
    this.persist();
    this.logger.info({ probeAt: this.state.probeAt }, 'Model fallback probe failed; delaying');
  }

  /** Clear the degraded flag — primary is back. */
  markRecovered(): void {
    if (!this.state.degraded) return;
    this.logger.info({ wasDegradedSince: this.state.since }, 'Model fallback cleared — primary recovered');
    this.state = { degraded: false };
    this.persist();
  }

  /** Snapshot for status/debug surfaces. */
  snapshot(): Readonly<FallbackState> & { fallbackModel: string } {
    return { ...this.state, fallbackModel: this.fallbackModel };
  }

  private load(): FallbackState {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf-8');
        return JSON.parse(raw) as FallbackState;
      }
    } catch (err) {
      this.logger.warn({ err, path: this.statePath }, 'Failed to load model-fallback state — starting fresh');
    }
    return { degraded: false };
  }

  private persist(): void {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      this.logger.error({ err, path: this.statePath }, 'Failed to persist model-fallback state');
    }
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
  }

  private errText(err: unknown): string {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (err instanceof Error) return `${err.message}\n${(err as any).stack ?? ''}`;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  private truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
}
