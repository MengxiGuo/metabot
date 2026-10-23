import type { CodexContextMode } from '../../config.js';

export const CODEX_LONG_CONTEXT_WINDOW = 1_000_000;
export const CODEX_LONG_AUTO_COMPACT_TOKEN_LIMIT = 900_000;

/** Build process-local Codex config overrides for the selected chat mode. */
export function buildCodexContextOverrideArgs(mode: CodexContextMode | undefined): string[] {
  if (mode !== 'long') return [];
  return [
    '-c',
    `model_context_window=${CODEX_LONG_CONTEXT_WINDOW}`,
    '-c',
    `model_auto_compact_token_limit=${CODEX_LONG_AUTO_COMPACT_TOKEN_LIMIT}`,
  ];
}
