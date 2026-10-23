import { describe, expect, it } from 'vitest';
import {
  parseArkAfpUsage,
  parseArkCodingPlanUsage,
  signArkOpenApiRequest,
} from '../src/engines/claude/ark-quota-fetcher.js';

describe('Ark quota fetcher', () => {
  it('parses Agent Plan AFP windows into quotaInfo shape', () => {
    const quota = parseArkAfpUsage({
      Result: {
        AFPFiveHour: { Quota: 50, Used: 12.5, ResetTime: Date.now() + 3_600_000 },
        AFPWeekly: { Quota: 500, Used: 150, ResetTime: Date.now() + 86_400_000 },
        AFPMonthly: { Quota: 2000, Used: 850.5, ResetTime: Date.now() + 7 * 86_400_000 },
      },
    });

    expect(quota?.label).toBe('5h');
    expect(quota?.usedPct).toBe(25);
    expect(quota?.secondary?.label).toBe('周');
    expect(quota?.secondary?.usedPct).toBe(30);
    expect(quota?.tertiary?.label).toBe('月');
    expect(quota?.tertiary?.usedPct).toBe(42.5);
  });

  it('parses Coding Plan percentage windows defensively', () => {
    const quota = parseArkCodingPlanUsage({
      Result: {
        QuotaUsage: [
          { Level: 'session', Percent: 0, ResetTimestamp: -1 },
          { Level: 'weekly', Percent: 1.672568, ResetTimestamp: 1782057600 },
          { Level: 'monthly', Percent: 0.836284, ResetTimestamp: 1784303999 },
        ],
      },
    });

    expect(quota?.label).toBe('5h');
    expect(quota?.usedPct).toBe(0);
    expect(quota?.secondary?.label).toBe('周');
    expect(quota?.secondary?.usedPct).toBe(1.7);
    expect(quota?.tertiary?.label).toBe('月');
    expect(quota?.tertiary?.usedPct).toBe(0.8);
  });

  it('builds Volcengine OpenAPI signature metadata', () => {
    const signed = signArkOpenApiRequest({
      action: 'GetCodingPlanUsage',
      region: 'cn-beijing',
      accessKeyId: 'AKLTtest',
      secretAccessKey: 'secret',
      now: new Date('2026-06-21T12:34:56Z'),
    });

    expect(signed.query).toBe('Action=GetCodingPlanUsage&Region=cn-beijing&Version=2024-01-01');
    expect(signed.xDate).toBe('20260621T123456Z');
    expect(signed.authorization).toContain('HMAC-SHA256 Credential=AKLTtest/20260621/cn-beijing/ark/request');
    expect(signed.authorization).toContain('SignedHeaders=host;x-date;x-content-sha256;content-type');
  });
});
