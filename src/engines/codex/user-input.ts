import type { SDKMessage } from '../claude/executor.js';
import type { CodexAppServerClient, ServerRequest } from './app-server-client.js';

interface Question {
  id: string;
  question: string;
  header: string;
  options?: unknown;
  isSecret?: boolean;
}

/** Own pending RPCs separately from display text; never infer approval or replay stale answers. */
export class CodexUserInput {
  private pending = new Map<string, { request: ServerRequest; questions: Question[] }>();

  constructor(
    private client: CodexAppServerClient,
    private emit: (message: SDKMessage) => void,
    private threadId: () => string | undefined,
    private turnId: () => string | undefined,
  ) {}

  handle(request: ServerRequest): boolean {
    if (request.method !== 'item/tool/requestUserInput') return false;
    const p = request.params;
    const questions = p?.questions as Question[] | undefined;
    if (
      p?.threadId !== this.threadId() ||
      p?.turnId !== this.turnId() ||
      !Array.isArray(questions) ||
      !questions.length ||
      questions.length > 3 ||
      questions.some(
        (q) =>
          !q ||
          typeof q.id !== 'string' ||
          !q.id ||
          ['__proto__', 'constructor', 'prototype'].includes(q.id) ||
          typeof q.question !== 'string' ||
          q.isSecret ||
          (q.options != null &&
            (!Array.isArray(q.options) ||
              q.options.some((o) => !o || typeof o.label !== 'string' || typeof o.description !== 'string'))),
      ) ||
      new Set(questions.map((q) => q.id)).size !== questions.length
    )
      return false;
    const key = this.key(request.id);
    if (this.pending.has(key)) return true;
    this.pending.set(key, { request, questions });
    this.emit({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            id: key,
            input: { questions: questions.map((q) => ({ ...q, answerKey: q.id, multiSelect: false })) },
          },
        ],
      },
    });
    return true;
  }

  async resolve(key: string, answers: Record<string, string>): Promise<void> {
    const pending = this.pending.get(key);
    if (!pending || pending.request.params?.turnId !== this.turnId()) throw new Error('Question expired');
    const result: Record<string, { answers: string[] }> = {};
    for (const q of pending.questions) {
      const answer = answers[q.id];
      // An empty answer collection cancels unanswered questions, never approves by default.
      result[q.id] = { answers: typeof answer === 'string' && answer.trim() ? [answer] : [] };
    }
    await this.client.respond(pending.request.id, { answers: result });
    this.resolved(pending.request.id);
  }

  resolved(requestId: unknown): void {
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return;
    const key = this.key(requestId);
    if (this.pending.delete(key)) this.emit({ type: 'question_resolved', uuid: key });
  }

  private key(id: string | number): string {
    return `codex-input:${typeof id}:${id}`;
  }
}
