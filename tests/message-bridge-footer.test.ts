import { describe, it, expect, vi } from 'vitest';
import { MessageBridge } from '../src/bridge/message-bridge.js';
import { buildCard } from '../src/feishu/card-builder.js';
import type { CardState } from '../src/types.js';
describe('split card usage semantics', () => {
  it.each(['cumulative', 'context'] as const)('preserves %s on conclusion only', async (kind) => {
    const sender = { updateCard: vi.fn(async () => true), sendCard: vi.fn(async () => 'sent') };
    const bridge = {
      sender,
      sessionManager: { addUsage: vi.fn(), getSession: () => ({ cumulativeCostUsd: 0 }) },
      logger: { warn: vi.fn() },
    };
    const state: CardState = {
      status: 'complete',
      userPrompt: 'x',
      responseText: 'analysis\n\nconclusion',
      toolCalls: [],
      tokenUsageKind: kind,
      totalTokens: kind === 'cumulative' ? 2614000 : 178900,
      contextWindow: 1048576,
    };
    await (MessageBridge.prototype as any).sendFinalCardOrSplit.call(bridge, 'message', state, 'chat', [
      'analysis',
      'conclusion',
    ]);
    const process = (sender.updateCard.mock.calls[0] as any)[1];
    const final = (sender.sendCard.mock.calls[0] as any)[1];
    expect(process.tokenUsageKind).toBeUndefined();
    expect(process.totalTokens).toBeUndefined();
    expect(final.tokenUsageKind).toBe(kind);
    const note = JSON.parse(buildCard(final)).elements.find((e: any) => e.tag === 'note').elements[0].content;
    if (kind === 'cumulative') {
      expect(note).toContain('累计 tokens: 2614.0k');
      expect(note).not.toContain('ctx:');
    } else expect(note).toContain('ctx: 178.9k/1049k (17%)');
  });
});
