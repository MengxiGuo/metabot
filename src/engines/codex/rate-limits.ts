export const DEFAULT_CODEX_RATE_LIMIT_ID = 'codex';
export const CODEX_SPARK_RATE_LIMIT_ID = 'codex_bengalfox';

/**
 * Codex exposes separate metered buckets for the regular model family and the
 * Spark model. The app-server does not guarantee that the last rolling update
 * belongs to the model running the current turn, so callers must select by
 * model instead of treating the newest bucket as account-global.
 */
export function codexRateLimitIdForModel(model?: string): string {
  return model?.toLowerCase().includes('spark')
    ? CODEX_SPARK_RATE_LIMIT_ID
    : DEFAULT_CODEX_RATE_LIMIT_ID;
}

export function quotaWindowLabel(windowDurationMins: unknown): string | undefined {
  if (typeof windowDurationMins !== 'number' || !Number.isFinite(windowDurationMins)) return undefined;
  if (windowDurationMins === 300) return '5h';
  if (windowDurationMins === 10_080) return '周';
  if (windowDurationMins === 43_200) return '月';
  if (windowDurationMins > 0 && windowDurationMins < 60) return `${windowDurationMins}min`;
  if (windowDurationMins > 0 && windowDurationMins % 1_440 === 0) return `${windowDurationMins / 1_440}d`;
  if (windowDurationMins > 0 && windowDurationMins % 60 === 0) return `${windowDurationMins / 60}h`;
  return undefined;
}
