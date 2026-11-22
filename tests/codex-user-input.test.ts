import { describe, expect, it, vi } from 'vitest';
import { CodexUserInput } from '../src/engines/codex/user-input.js';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';
function setup() {
  const client = { respond: vi.fn().mockResolvedValue(undefined) };
  const processor = new StreamProcessor('test');
  const emit = vi.fn((m) => processor.processMessage(m));
  const input = new CodexUserInput(
    client as any,
    emit,
    () => 'thread',
    () => 'turn',
  );
  const req = {
    id: 1,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      questions: [{ id: 'permission', header: 'Approval', question: 'Allow?', options: null, isSecret: false }],
    },
  };
  return { client, processor, emit, input, req };
}
describe('Codex native input RPC', () => {
  it('renders the native question and responds by question id', async () => {
    const { client, processor, input, req } = setup();
    expect(input.handle(req)).toBe(true);
    const q = processor.getPendingQuestion()!;
    expect(q.questions[0]).toMatchObject({ answerKey: 'permission', options: [] });
    await input.resolve(q.toolUseId, { permission: 'No' });
    expect(client.respond).toHaveBeenCalledWith(1, { answers: { permission: { answers: ['No'] } } });
    expect(processor.getPendingQuestion()).toBeNull();
  });
  it('does not approve an unanswered prompt', async () => {
    const { client, input, req, processor } = setup();
    input.handle(req);
    await input.resolve(processor.getPendingQuestion()!.toolUseId, {});
    expect(client.respond).toHaveBeenCalledWith(1, { answers: { permission: { answers: [] } } });
  });
  it('rejects stale, secret, and other-thread questions', () => {
    const { input, req, emit } = setup();
    expect(input.handle({ ...req, params: { ...req.params, turnId: 'old' } })).toBe(false);
    expect(input.handle({ ...req, params: { ...req.params, threadId: 'other' } })).toBe(false);
    req.params.questions[0].isSecret = true;
    expect(input.handle(req)).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
  it('expires only the matching RPC and refuses its stale answer', async () => {
    const { input, req, processor, client } = setup();
    input.handle(req);
    const old = processor.getPendingQuestion()!.toolUseId;
    input.handle({ ...req, id: 2 });
    input.resolved(1);
    processor.clearPendingQuestion(old); // asynchronous UI cleanup must not remove the next prompt
    expect(processor.getPendingQuestion()?.toolUseId).toBe('codex-input:number:2');
    await expect(input.resolve(old, { permission: 'Yes' })).rejects.toThrow('expired');
    expect(client.respond).not.toHaveBeenCalled();
  });
});
