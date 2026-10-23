import { describe, expect, it } from 'vitest';
import {
  detectUpstreamApiError,
  normalizeApiTaskResult,
} from '../src/utils/upstream-api-error.js';

describe('detectUpstreamApiError', () => {
  it('detects the production Kimi persistence preamble + context overflow', () => {
    const raw = [
      '本次无数据可记，跳过入库。',
      '',
      'API Error: 400 context window exceeds limit Request id: 021785396537425ffa263910bfaab0198f27d0234753c494b2287',
    ].join('\n');

    expect(detectUpstreamApiError(raw)).toEqual({
      code: 'context_window_exceeded',
      message: 'context window exceeds limit',
      raw,
      httpStatus: 400,
      requestId: '021785396537425ffa263910bfaab0198f27d0234753c494b2287',
      retryable: true,
    });
  });

  it('detects a plain rate-limit API error', () => {
    expect(detectUpstreamApiError('API Error: 429 too many requests')).toMatchObject({
      code: 'rate_limited',
      httpStatus: 429,
      retryable: true,
    });
  });

  it('does not misclassify normal prose that quotes an API error', () => {
    const explanation = [
      'The user reported this provider response:',
      'API Error: 400 context window exceeds limit',
      'We should split the request into bounded chunks.',
    ].join('\n');
    expect(detectUpstreamApiError(explanation)).toBeUndefined();
  });

  it('allows bare provider errors only for trusted error fields', () => {
    expect(detectUpstreamApiError('maximum context length exceeded')).toBeUndefined();
    expect(
      detectUpstreamApiError('maximum context length exceeded', { allowBare: true }),
    ).toMatchObject({ code: 'context_window_exceeded' });
  });
});

describe('normalizeApiTaskResult', () => {
  it('turns embedded provider errors into a structured failed result', () => {
    const normalized = normalizeApiTaskResult({
      success: true,
      responseText: '本次无数据可记，跳过入库。\n\nAPI Error: 400 context window exceeds limit Request id: req_123',
      costUsd: 0,
    });

    expect(normalized).toMatchObject({
      success: false,
      errorCode: 'context_window_exceeded',
      upstreamStatus: 400,
      upstreamRequestId: 'req_123',
      retryable: true,
    });
    expect(normalized.error).toContain('context_window_exceeded');
  });

  it('leaves ordinary successful responses unchanged', () => {
    const result = { success: true, responseText: 'Completed normally' };
    expect(normalizeApiTaskResult(result)).toBe(result);
  });
});
