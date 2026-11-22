import { describe, expect, it, vi } from 'vitest';
import { MessageSender } from '../src/feishu/message-sender.js';
import { FeishuSenderAdapter } from '../src/feishu/feishu-sender-adapter.js';
import { formatAccountSnapshot } from '../src/engines/antigravity/account-dashboard.js';

vi.mock('../src/feishu/message-archive.js', () => ({
  archiveOutgoing: vi.fn(), registerMsgChatMapping: vi.fn(), lookupChatIdByMsgId: vi.fn(),
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

describe('account dashboard through the real Feishu notice builder and adapter', () => {
  it('sends only a redacted identifier and preserves quotas/dates in the final API payload', async () => {
    const create = vi.fn(async (request: any) => {
      const card = JSON.parse(request.data.content);
      const serialized = JSON.stringify(card);
      expect(serialized).not.toMatch(/@|\[at\]|example\.com|test_account_1234/);
      expect(serialized).toContain('test…1234');
      expect(serialized).toContain('已用 95%');
      expect(serialized).toContain('2026-11-05 18:28');
      return { code: 0, data: { message_id: 'om_test_receipt' } };
    });
    const sender = new MessageSender({ im: { v1: { message: { create } } } } as any, logger);
    const adapter = new FeishuSenderAdapter(sender);
    const content = formatAccountSnapshot('primary', 'primary', {
      email: 'test_account_1234@example.com', checkedAt: Date.parse('2026-11-01T00:00:00Z'),
      groups: [{ name: 'Claude and GPT models', buckets: [{ window: 'weekly', usedPct: 95, resetAt: '2026-11-05T10:28:01Z' }] }],
    });
    expect(await adapter.sendTextNotice('test-chat', '账号看板', content)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['provider rejection', 'missing receipt'])('surfaces %s as false', async (failure) => {
    const create = failure === 'provider rejection'
      ? vi.fn().mockRejectedValue({ response: { data: { code: 230028 } } })
      : vi.fn().mockResolvedValue({ code: 230028 });
    const adapter = new FeishuSenderAdapter(new MessageSender({ im: { v1: { message: { create } } } } as any, logger));
    expect(await adapter.sendTextNotice('test-chat', '账号看板', '已脱敏')).toBe(false);
  });
});
