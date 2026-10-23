import { describe, expect, it } from 'vitest';
import {
  getSessionRecoveryReason,
  isCorruptedSessionError,
  isStaleSessionError,
} from '../src/bridge/message-bridge.js';

describe('isStaleSessionError', () => {
  it('matches the GitHub issue error text', () => {
    expect(
      isStaleSessionError('Error: No conversation found with session ID: d0cfbde2-1357-4da0-acd6-ee36d1da056c'),
    ).toBe(true);
  });

  it('matches other stale session variants', () => {
    expect(isStaleSessionError('invalid session provided')).toBe(true);
    expect(isStaleSessionError('Conversation not found')).toBe(true);
  });

  it('matches conversation corruption errors (duplicate tool_result)', () => {
    expect(
      isStaleSessionError('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.148.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id: toolu_01TPsHXcmpuz5cAY97fM5vXv"}}'),
    ).toBe(true);
    expect(
      isStaleSessionError('each tool_use must have a single result'),
    ).toBe(true);
    expect(
      isStaleSessionError('Found multiple tool_result blocks with id: toolu_abc'),
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isStaleSessionError('Task timed out (24 hour limit)')).toBe(false);
    expect(isStaleSessionError('permission denied')).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
  });
});

describe('isCorruptedSessionError', () => {
  it('matches the persisted Codex tool-argument corruption seen in production', () => {
    const error = [
      'Error: {"type":"error","error":{"type":"invalid_request_error",',
      '"message":"[ObjectParam] [input[555].arguments.]/botslikelizJenn… ',
      '[property_name_above_max_length] Invalid property name in ',
      '\'input[555].arguments\': expected maximum length 256, got 1768"}}',
    ].join('');

    expect(isCorruptedSessionError(error)).toBe(true);
    expect(getSessionRecoveryReason(error)).toBe('corrupted-history');
  });

  it('matches invalid argument types in persisted input history', () => {
    expect(
      isCorruptedSessionError("Invalid type in 'input[42].arguments': expected an object"),
    ).toBe(true);
  });

  it('does not reset sessions for unrelated invalid requests', () => {
    expect(isCorruptedSessionError('invalid_request_error: unsupported model')).toBe(false);
    expect(isCorruptedSessionError('permission denied')).toBe(false);
    expect(isCorruptedSessionError(undefined)).toBe(false);
  });
});

describe('getSessionRecoveryReason', () => {
  it('classifies every error handled by the shared chat/API recovery path', () => {
    expect(getSessionRecoveryReason('Conversation not found')).toBe('stale');
    expect(getSessionRecoveryReason('maximum context length exceeded')).toBe('context-overflow');
    expect(getSessionRecoveryReason('[property_name_above_max_length]')).toBe('corrupted-history');
    expect(getSessionRecoveryReason('HTTP 503 service unavailable')).toBeUndefined();
  });
});
