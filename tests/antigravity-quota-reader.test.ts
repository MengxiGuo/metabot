import { describe, expect, it } from 'vitest';
import { parseAntigravityQuota, resolveAntigravityContextWindow } from '../src/engines/antigravity/quota-reader.js';

const NOW = Date.parse('2026-10-18T00:00:00Z');

function usagePayload(groups: unknown[]): string {
  return JSON.stringify({
    status: 'SUCCESS',
    command: { name: 'usage', data: { groups } },
  });
}

describe('Antigravity quota reader', () => {
  it('selects the dedicated Argon bucket instead of the generic Gemini quota', () => {
    const output = usagePayload([
      {
        name: 'Gemini Models',
        buckets: [
          { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.1, reset_time: '2026-10-25T00:00:00Z' },
        ],
      },
      {
        name: 'Gemini 4 Argon',
        buckets: [
          {
            id: 'gemini-argon-wtu-weekly',
            window: 'weekly',
            remaining_fraction: 0.952,
            reset_time: '2026-10-25T00:00:00Z',
          },
        ],
      },
    ]);

    expect(parseAntigravityQuota(output, 'gemini-4-argon-low', NOW)).toEqual({
      usedPct: 4.8,
      hoursToReset: 168,
      label: '周',
    });
  });

  it('orders short and weekly windows for the shared third-party model pool', () => {
    const output = usagePayload([
      {
        name: 'Claude and GPT models',
        buckets: [
          { id: '3p-weekly', window: 'weekly', remaining_fraction: 0.8, reset_time: '2026-10-25T00:00:00Z' },
          { id: '3p-5h', window: '5h', remaining_fraction: 0.7, reset_time: '2026-10-18T05:00:00Z' },
        ],
      },
    ]);

    expect(parseAntigravityQuota(output, 'claude-opus-5-5-low', NOW)).toEqual({
      usedPct: 30,
      hoursToReset: 5,
      label: '5h',
      secondary: { usedPct: 20, hoursToReset: 168, label: '周' },
    });
  });

  it.each(['gemini-4-argon-low', 'gemini-4-carbon-high'])('uses the Ultra shared Gemini pool for %s', (model) => {
    const output = usagePayload([
      {
        name: 'Gemini Models',
        buckets: [
          { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.9, reset_time: '2026-10-25T00:00:00Z' },
          { id: 'gemini-5h', window: '5h', remaining_fraction: 0.8, reset_time: '2026-10-18T05:00:00Z' },
        ],
      },
    ]);
    expect(parseAntigravityQuota(output, model, NOW)).toEqual({
      usedPct: 20, hoursToReset: 5, label: '5h',
      secondary: { usedPct: 10, hoursToReset: 168, label: '周' },
    });
  });

  it('does not borrow a dedicated model pool or accept malformed payloads', () => {
    const output = usagePayload([{
      name: 'Gemini 4 Argon',
      buckets: [{ id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 0.9, reset_time: '2026-10-25T00:00:00Z' }],
    }]);
    expect(parseAntigravityQuota(output, 'gemini-4-carbon-high', NOW)).toBeUndefined();
    expect(parseAntigravityQuota(output, 'claude-opus-5-5-high', NOW)).toBeUndefined();
    expect(parseAntigravityQuota('not json', 'gemini-4-argon-low', NOW)).toBeUndefined();
  });

  it.each([0, undefined])('never falls back when the dedicated Argon pool is exhausted or invalid (%s)', remaining => {
    const output = usagePayload([
      { name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-25T00:00:00Z' }] },
      { name: 'Gemini 4 Argon', buckets: [{ id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: remaining, reset_time: '2026-10-25T00:00:00Z' }] },
    ]);
    const result = parseAntigravityQuota(output, 'gemini-4-argon-high', NOW);
    if (remaining === undefined) expect(result).toBeUndefined();
    else expect(result?.usedPct).toBe(100);
  });

  it('uses the documented Argon unified context window and never guesses unknown models', () => {
    expect(resolveAntigravityContextWindow('gemini-4-argon-low')).toBe(1_048_576);
    expect(resolveAntigravityContextWindow('gemini-4-argon-high')).toBe(1_048_576);
    expect(resolveAntigravityContextWindow('claude-opus-5-5-low')).toBe(1_000_000);
    expect(resolveAntigravityContextWindow('claude-sonnet-5-5-high')).toBe(1_000_000);
    expect(resolveAntigravityContextWindow('claude-opus-5-low')).toBeUndefined();
    expect(resolveAntigravityContextWindow('gemini-4-argon-low', 900_000)).toBe(900_000);
  });
  it.each(['gemini-4-carbon-medium', 'gemini-4-carbon-high', 'gemini-3.8-flash-low', 'GEMINI-3.8-FLASH', 'gemini-4-argon'])(
    'resolves installed Gemini family %s', model => {
      expect(resolveAntigravityContextWindow(model)).toBe(1_048_576);
      expect(resolveAntigravityContextWindow(model, 900_000)).toBe(900_000);
    });
  it.each(['gemini-4-carbonish', 'gemini-3.8-flashlight', 'gemini-5', undefined])('does not infer an unknown family %s', model => {
    expect(resolveAntigravityContextWindow(model)).toBeUndefined();
  });
});
