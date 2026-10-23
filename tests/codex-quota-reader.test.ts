import { describe, expect, it, vi } from 'vitest';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';
import { resolveCodexQuotaInfo } from '../src/engines/codex/executor.js';
import { parseCodexSessionStatusLines } from '../src/engines/codex/quota-reader.js';
import { buildCard } from '../src/feishu/card-builder.js';

describe('parseCodexSessionStatusLines', () => {
  it('reads the latest actual effort alongside token and quota status', () => {
    const nowSec = 1_000;
    const lines = [
      JSON.stringify({ type: 'turn_context', payload: { effort: 'medium' } }),
      JSON.stringify({ type: 'turn_context', payload: { effort: 'xhigh' } }),
      JSON.stringify({
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 26_000, output_tokens: 500 },
            model_context_window: 828_000,
          },
          rate_limits: {
            primary: { used_percent: 3, resets_at: nowSec + 3_600 },
          },
        },
      }),
    ];

    expect(parseCodexSessionStatusLines(lines, nowSec, 'gpt-6-astra')).toEqual({
      quota: { primary: { usedPct: 3, hoursToReset: 1 }, secondary: undefined },
      lastTurnInputTokens: 26_000,
      lastTurnOutputTokens: 500,
      contextWindow: 828_000,
      reasoningEffort: 'xhigh',
    });
  });

  it('does not reuse a stale general quota from before the latest turn boundary', () => {
    const nowSec = 1_000;
    const lines = [
      JSON.stringify({
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'codex',
            limit_name: null,
            primary: { used_percent: 19, resets_at: nowSec + 7 * 86_400, window_minutes: 10_080 },
            secondary: null,
          },
        },
      }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'high' } }),
      JSON.stringify({
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 506_000, output_tokens: 1_000 },
            model_context_window: 828_000,
          },
          rate_limits: {
            limit_id: 'codex_bengalfox',
            limit_name: 'GPT-5.3-Codex-Spark',
            primary: { used_percent: 0, resets_at: nowSec + 5 * 3_600, window_minutes: 300 },
            secondary: { used_percent: 0, resets_at: nowSec + 7 * 86_400, window_minutes: 10_080 },
          },
        },
      }),
    ];

    expect(parseCodexSessionStatusLines(lines, nowSec, 'gpt-5.6-sol')).toEqual({
      quota: null,
      lastTurnInputTokens: 506_000,
      lastTurnOutputTokens: 1_000,
      contextWindow: 828_000,
      reasoningEffort: 'high',
    });
  });

  it('refreshes missing current-turn quota and renders the fresh weekly value end to end', async () => {
    const readFreshAccountQuota = vi.fn().mockResolvedValue({
      usedPct: 35,
      hoursToReset: 110.4,
      label: '周',
    });
    const quotaInfo = await resolveCodexQuotaInfo(null, readFreshAccountQuota);

    expect(readFreshAccountQuota).toHaveBeenCalledOnce();
    expect(quotaInfo).toEqual({ usedPct: 35, hoursToReset: 110.4, label: '周' });

    const processor = new StreamProcessor('check quota');
    const cardState = processor.processMessage({
      type: 'result',
      subtype: 'success',
      result: 'Checked.',
      quotaInfo,
      reasoningEffort: 'high',
      duration_ms: 708_200,
      modelUsage: {
        'gpt-5.6-sol': {
          inputTokens: 74_000,
          outputTokens: 0,
          contextWindow: 828_000,
          costUSD: 0,
        },
      },
    });
    const card = JSON.parse(buildCard(cardState));
    const footer = card.elements.find((element: { tag?: string }) => element.tag === 'note');

    expect(footer?.elements[0].content).toBe(
      'ctx: 74.0k/828k (9%) | quota: 周 35.0% (4.6d) | gpt-5.6-sol | effort: high | 708.2s',
    );
  });

  it('keeps a matching current-turn quota without making an account refresh', async () => {
    const readFreshAccountQuota = vi.fn();

    await expect(resolveCodexQuotaInfo({
      primary: { usedPct: 36, hoursToReset: 100, label: '周' },
    }, readFreshAccountQuota)).resolves.toEqual({ usedPct: 36, hoursToReset: 100, label: '周' });
    expect(readFreshAccountQuota).not.toHaveBeenCalled();
  });

  it('does not report Spark quota as Astra quota when no matching bucket exists', () => {
    const lines = [
      JSON.stringify({ type: 'turn_context', payload: { effort: 'high' } }),
      JSON.stringify({
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 100, output_tokens: 5 } },
          rate_limits: {
            limit_id: 'codex_bengalfox',
            primary: { used_percent: 0, resets_at: 10_000, window_minutes: 300 },
          },
        },
      }),
    ];

    expect(parseCodexSessionStatusLines(lines, 1_000, 'gpt-6-astra')?.quota).toBeNull();
  });

  it('ignores unsupported effort values', () => {
    const lines = [JSON.stringify({ type: 'turn_context', payload: { effort: 'extreme' } })];
    expect(parseCodexSessionStatusLines(lines, 1_000)).toBeNull();
  });
});
