import { isCodexReasoningEffort, type CodexBotConfig, type CodexReasoningEffort } from '../../config.js';

export type CodexReasoningEffortSource = 'session' | 'model' | 'bot' | 'codex-default';

export interface ResolvedCodexReasoningEffort {
  effort?: CodexReasoningEffort;
  source: CodexReasoningEffortSource;
}

/** Resolve the effective effort without guessing values from external Codex config files. */
export function resolveCodexReasoningEffort(
  config: CodexBotConfig | undefined,
  model: string | undefined,
  sessionOverride?: CodexReasoningEffort,
): ResolvedCodexReasoningEffort {
  if (sessionOverride) return { effort: sessionOverride, source: 'session' };

  const modelDefault = model ? config?.reasoningEffortByModel?.[model] : undefined;
  if (isCodexReasoningEffort(modelDefault)) return { effort: modelDefault, source: 'model' };

  if (isCodexReasoningEffort(config?.reasoningEffort)) {
    return { effort: config.reasoningEffort, source: 'bot' };
  }

  return { source: 'codex-default' };
}

export function codexReasoningEffortConfigArg(effort: CodexReasoningEffort): string {
  return `model_reasoning_effort=${JSON.stringify(effort)}`;
}
