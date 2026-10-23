import { describe, expect, it } from 'vitest';
import { codexReasoningEffortConfigArg, resolveCodexReasoningEffort } from '../src/engines/codex/reasoning-effort.js';

describe('resolveCodexReasoningEffort', () => {
  it('uses session, per-model, and bot defaults in precedence order', () => {
    const config = {
      reasoningEffort: 'high' as const,
      reasoningEffortByModel: {
        'gpt-6-astra': 'max' as const,
      },
    };

    expect(resolveCodexReasoningEffort(config, 'gpt-6-astra', 'ultra')).toEqual({
      effort: 'ultra',
      source: 'session',
    });
    expect(resolveCodexReasoningEffort(config, 'gpt-6-astra')).toEqual({
      effort: 'max',
      source: 'model',
    });
    expect(resolveCodexReasoningEffort(config, 'gpt-5.6-sol')).toEqual({
      effort: 'high',
      source: 'bot',
    });
  });

  it('leaves Codex defaults untouched when MetaBot has no override', () => {
    expect(resolveCodexReasoningEffort(undefined, 'gpt-6-astra')).toEqual({
      source: 'codex-default',
    });
  });

  it('ignores invalid values loaded from untyped JSON configuration', () => {
    expect(
      resolveCodexReasoningEffort(
        {
          reasoningEffort: 'enormous',
          reasoningEffortByModel: { 'gpt-6-astra': 'also-enormous' },
        } as any,
        'gpt-6-astra',
      ),
    ).toEqual({ source: 'codex-default' });
  });

  it('encodes the config value as a TOML string', () => {
    expect(codexReasoningEffortConfigArg('xhigh')).toBe('model_reasoning_effort="xhigh"');
  });
});
