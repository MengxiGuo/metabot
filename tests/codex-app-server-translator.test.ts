import { describe, expect, it } from 'vitest';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';
import {
  createCodexAppServerTranslatorState,
  enableCodexAppServerGoalOperation,
  translateCodexAppServerNotification,
} from '../src/engines/codex/app-server-translator.js';
import type { JsonRpcNotification } from '../src/engines/codex/app-server-client.js';

describe('Codex app-server translator', () => {
  it('maps app-server text deltas and completion into the existing card state', () => {
    const state = createCodexAppServerTranslatorState({ model: 'gpt-5.5', contextWindow: 400000 });
    const processor = new StreamProcessor('hello');
    const events: JsonRpcNotification[] = [
      { method: 'thread/started', params: { thread: { id: 'thread-1' } } },
      { method: 'item/started', params: { item: { id: 'msg-1', type: 'agentMessage', text: '' } } },
      { method: 'item/agentMessage/delta', params: { itemId: 'msg-1', delta: 'Hel' } },
      { method: 'item/agentMessage/delta', params: { itemId: 'msg-1', delta: 'lo' } },
      { method: 'item/completed', params: { item: { id: 'msg-1', type: 'agentMessage', text: 'Hello' } } },
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 105 },
            total: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 105 },
            modelContextWindow: 400000,
          },
        },
      },
      {
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            primary: { usedPercent: 19, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
            secondary: { usedPercent: 3, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
          },
        },
      },
      { method: 'turn/completed', params: { turn: { durationMs: 1234 } } },
    ];

    let cardState = processor.processMessage({ type: 'system' });
    for (const event of events) {
      for (const message of translateCodexAppServerNotification(event, state)) {
        cardState = processor.processMessage(message);
      }
    }

    expect(processor.getSessionId()).toBe('thread-1');
    expect(cardState.status).toBe('complete');
    expect(cardState.responseText).toBe('Hello');
    expect(cardState.model).toBe('gpt-5.5');
    expect(cardState.totalTokens).toBe(105);
    expect(cardState.contextWindow).toBe(400000);
    expect(cardState.durationMs).toBe(1234);
    expect(cardState.quotaInfo).toMatchObject({
      usedPct: 19,
      hoursToReset: 1,
      secondary: { usedPct: 3, hoursToReset: 2 },
    });
  });

  it('maps app-server command execution items to Bash tool cards', () => {
    const state = createCodexAppServerTranslatorState();
    state.threadId = 'thread-2';
    const processor = new StreamProcessor('pwd');
    const events: JsonRpcNotification[] = [
      {
        method: 'item/started',
        params: {
          item: { id: 'call-1', type: 'commandExecution', command: '/bin/bash -c pwd' },
        },
      },
      {
        method: 'item/completed',
        params: {
          item: { id: 'call-1', type: 'commandExecution', aggregatedOutput: '/root/metabot\n', exitCode: 0 },
        },
      },
      { method: 'turn/completed', params: { turn: { durationMs: 100 } } },
    ];

    let cardState = processor.processMessage({ type: 'system' });
    for (const event of events) {
      for (const message of translateCodexAppServerNotification(event, state)) {
        cardState = processor.processMessage(message);
      }
    }

    expect(cardState.toolCalls).toEqual([{ name: 'Bash', detail: '`/bin/bash -c pwd`', status: 'done' }]);
  });

  it('turns non-retrying app-server errors into result errors', () => {
    const state = createCodexAppServerTranslatorState();
    state.threadId = 'thread-err';
    const [message] = translateCodexAppServerNotification(
      { method: 'error', params: { willRetry: false, error: { message: 'boom' } } },
      state,
    );

    expect(message).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['boom'],
      session_id: 'thread-err',
    });
  });

  it('prefixes failed command output with the exit code', () => {
    const state = createCodexAppServerTranslatorState();
    state.threadId = 'thread-failed-command';
    const messages = translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'call-fail',
            type: 'commandExecution',
            aggregatedOutput: 'permission denied\n',
            exitCode: 126,
          },
        },
      },
      state,
    );

    expect(messages[0]?.message?.content?.[0]).toMatchObject({
      type: 'tool_result',
      id: 'call-fail',
      text: 'Exit code: 126\npermission denied\n',
    });
  });

  it('emits official goal progress when an app-server goal is active', () => {
    const state = createCodexAppServerTranslatorState({ model: 'gpt-5.5', contextWindow: 400000 });
    state.threadId = 'thread-goal';
    state.goal = {
      threadId: 'thread-goal',
      objective: 'Finish the migration',
      status: 'active',
      tokenBudget: 20000,
      tokensUsed: 1000,
      timeUsedSeconds: 60,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const processor = new StreamProcessor('continue goal');

    let cardState = processor.processMessage({ type: 'system' });
    const messages = translateCodexAppServerNotification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
            total: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
            modelContextWindow: 400000,
          },
        },
      },
      state,
    );
    for (const message of messages) cardState = processor.processMessage(message);

    expect(messages.some((m) => m.subtype === 'goal_progress')).toBe(true);
    expect(cardState.goalProgress).toMatchObject({
      threadId: 'thread-goal',
      objective: 'Finish the migration',
      status: 'active',
      tokenBudget: 20000,
      tokensUsed: 1250,
      estimated: true,
      lastEvent: 'usage updated',
    });
  });

  it('coalesces official goal continuations until the goal reaches a terminal status', () => {
    const state = createCodexAppServerTranslatorState({ model: 'gpt-5.5', contextWindow: 400000 });
    state.threadId = 'thread-goal';
    enableCodexAppServerGoalOperation(state);
    const processor = new StreamProcessor('/goal Finish the migration');
    const now = Math.floor(Date.now() / 1000);
    const activeGoal = {
      threadId: 'thread-goal',
      objective: 'Finish the migration',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 1000,
      timeUsedSeconds: 60,
      createdAt: now,
      updatedAt: now,
    };
    const completeGoal = {
      ...activeGoal,
      status: 'complete',
      tokensUsed: 1600,
      timeUsedSeconds: 90,
      updatedAt: now + 30,
    };

    let cardState = processor.processMessage({ type: 'system' });
    const firstEvents: JsonRpcNotification[] = [
      { method: 'thread/goal/updated', params: { threadId: 'thread-goal', turnId: null, goal: activeGoal } },
      { method: 'turn/started', params: { turn: { id: 'turn-1' } } },
      { method: 'item/started', params: { item: { id: 'msg-1', type: 'agentMessage', text: '' } } },
      { method: 'item/agentMessage/delta', params: { itemId: 'msg-1', delta: 'Working...' } },
      { method: 'item/completed', params: { item: { id: 'msg-1', type: 'agentMessage', text: 'Working...' } } },
      { method: 'turn/completed', params: { turn: { id: 'turn-1', durationMs: 1234 } } },
    ];

    const firstMessages = firstEvents.flatMap((event) => translateCodexAppServerNotification(event, state));
    for (const message of firstMessages) cardState = processor.processMessage(message);

    expect(firstMessages.some((message) => message.type === 'result')).toBe(false);
    expect(cardState.status).not.toBe('complete');
    expect(cardState.goalProgress).toMatchObject({ status: 'active' });

    const finalMessages = translateCodexAppServerNotification(
      { method: 'thread/goal/updated', params: { threadId: 'thread-goal', turnId: 'turn-1', goal: completeGoal } },
      state,
    );
    for (const message of finalMessages) cardState = processor.processMessage(message);

    expect(finalMessages.some((message) => message.type === 'result' && !message.is_error)).toBe(true);
    expect(cardState.status).toBe('complete');
    expect(cardState.goalProgress).toMatchObject({
      status: 'complete',
      tokensUsed: 1600,
      estimated: false,
    });
  });
});
