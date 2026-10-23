import { describe, expect, it, vi } from 'vitest';
import {
  buildCatchupArgs,
  buildNativeCatchupPrompt,
  parseCatchupInvocation,
} from '../src/feishu/catchup-command.js';

describe('parseCatchupInvocation', () => {
  it('recognizes both explicit command spellings', () => {
    expect(parseCatchupInvocation('/catchup')).toMatchObject({ days: 7, maxLines: 80 });
    expect(parseCatchupInvocation('/catch-up 30d')).toMatchObject({ days: 30, maxLines: 80 });
  });

  it('preserves a follow-up task after the range', () => {
    expect(parseCatchupInvocation('/catchup 14d 继续昨天的迁移审计')).toMatchObject({
      days: 14,
      followup: '继续昨天的迁移审计',
    });
  });

  it('keeps backward-compatible bare numeric max-message syntax', () => {
    expect(parseCatchupInvocation('/catchup 120')).toMatchObject({ days: 7, maxLines: 120 });
  });

  it('recognizes bounded natural-language requests', () => {
    expect(parseCatchupInvocation('帮我 catch up 一下')).toMatchObject({
      days: 7,
      followup: '',
    });
    expect(parseCatchupInvocation('你先 catch up 一下，然后继续昨天的迁移审计')).toMatchObject({
      days: 7,
      followup: '继续昨天的迁移审计',
    });
    expect(parseCatchupInvocation('同步一下最近的上下文')).toMatchObject({ days: 7 });
    expect(parseCatchupInvocation('看看最近群聊')).toMatchObject({ days: 7 });
  });

  it('does not intercept catchup meta-discussion or unrelated English uses', () => {
    expect(parseCatchupInvocation('catch up skill 为什么不工作')).toBeUndefined();
    expect(parseCatchupInvocation('不是，我们的这个 catch up 是怎么回事？')).toBeUndefined();
    expect(parseCatchupInvocation('我让 bot 自己去 catch up')).toBeUndefined();
    expect(parseCatchupInvocation('We need to catch up on sales')).toBeUndefined();
  });
});

describe('buildNativeCatchupPrompt', () => {
  it('pins automatic routing to the 45-day Mac retention policy', () => {
    const invocation = parseCatchupInvocation('/catchup 60d')!;
    const args = buildCatchupArgs('/canonical/catchup_context.py', invocation, 'oc_test', 'bot-test');

    expect(args).toEqual(expect.arrayContaining([
      '--source', 'auto',
      '--mac-retention-days', '45',
      '--days', '60',
    ]));
  });

  it('injects runtime context and prevents a second model-selected workflow', async () => {
    const invocation = parseCatchupInvocation('/catchup 7d')!;
    const runner = vi.fn().mockResolvedValue([
      '# MetaBot Catchup Context',
      'source: mixed(local,mac,3060)',
      'covered_dates: 2026-08-16,2026-08-17',
      'missing_dates: _none_',
    ].join('\n'));

    const prompt = await buildNativeCatchupPrompt(invocation, 'oc_test', 'bot-test', runner);

    expect(runner).toHaveBeenCalledWith(invocation, 'oc_test', 'bot-test');
    expect(prompt).toContain('SG exact files first');
    expect(prompt).toContain('source: mixed(local,mac,3060)');
    expect(prompt).toContain('must never fall through to 3060');
    expect(prompt).toContain('blocked_recent_mac_unavailable');
    expect(prompt).toContain('zero file count is correct');
    expect(prompt).toContain('Do not rerun a catchup skill');
  });
});
