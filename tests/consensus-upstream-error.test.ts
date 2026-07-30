import { describe, expect, it, vi } from 'vitest';
import { ConsensusOrchestrator } from '../src/orchestrator/consensus.js';
import type {
  ConsensusEvent,
  ConsensusState,
} from '../src/orchestrator/types.js';

describe('ConsensusOrchestrator upstream error handling', () => {
  it('ejects and emits a structured event when a bot embeds an API error in successful text', async () => {
    const executeApiTask = vi.fn().mockResolvedValue({
      success: true,
      responseText: [
        '本次无数据可记，跳过入库。',
        '',
        'API Error: 400 context window exceeds limit Request id: req_consensus',
      ].join('\n'),
    });
    const registry = {
      get: vi.fn().mockReturnValue({ bridge: { executeApiTask } }),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const orchestrator = new ConsensusOrchestrator(registry as never, logger as never);
    const state = {
      taskId: 'task-upstream-error',
      phase: 1,
      costUsd: 0,
      costCapUsd: 5,
      ejected: [],
      events: [],
    } as unknown as ConsensusState;
    const observed: ConsensusEvent[] = [];

    const invokeBotRaw = (
      orchestrator as unknown as {
        invokeBotRaw: (
          currentState: ConsensusState,
          botName: string,
          prompt: string,
          onEvent: (event: ConsensusEvent) => void,
        ) => Promise<string | null>;
      }
    ).invokeBotRaw.bind(orchestrator);

    await expect(
      invokeBotRaw(state, 'kimi', 'review this result', (event) => observed.push(event)),
    ).resolves.toBeNull();

    expect(state.ejected).toEqual([
      expect.objectContaining({
        bot: 'kimi',
        reason: 'execution_error',
        phase: 1,
      }),
    ]);
    expect(observed).toContainEqual(
      expect.objectContaining({
        type: 'bot_ejected',
        payload: expect.objectContaining({
          bot: 'kimi',
          errorCode: 'context_window_exceeded',
          upstreamStatus: 400,
          upstreamRequestId: 'req_consensus',
          retryable: true,
        }),
      }),
    );
  });
});
