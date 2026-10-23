import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { GeminiExecutor } from '../src/engines/gemini/executor.js';
import { AntigravityExecutor } from '../src/engines/antigravity/executor.js';
import { KimiExecutor } from '../src/engines/kimi/executor.js';
import {
  INDEPENDENT_JUDGMENT_POLICY,
  INDEPENDENT_JUDGMENT_POLICY_VERSION,
} from '../src/engines/shared/independent-judgment.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('independent judgment policy', () => {
  it('contains the required adjudication and state-change safeguards', () => {
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain(INDEPENDENT_JUDGMENT_POLICY_VERSION);
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('correct, partly correct, unsupported, or incorrect');
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('code, tests, logs, runtime results');
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('executable, reproducible, independently verifiable evidence');
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain(
      'Revise a prior conclusion only when new evidence or stronger reasoning warrants it',
    );
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('repeated insistence alone is not new evidence');
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain(
      'verified facts, evidence-supported inferences or current hypotheses',
    );
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('concrete validation path');
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('strongest plausible counterexample');
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('failure mode, boundary condition, hidden assumption');
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('Do not begin with generic agreement');
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('Do not manufacture disagreement');
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain(
      'A question or objection alone is not authorization for a new, unrelated state change',
    );
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('retains prior authorization for the in-scope, reversible work');
  });

  it('preserves unfinished goals and requires same-turn delivery without inventing mutations', () => {
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('Active Goal Continuity and Follow-Through');
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('active unfinished goal');
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain(
      'Classify the newest message as replacing, adding to, refining, or asking a side question',
    );
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain(
      'Do not stop at acknowledgement, agreement, a restatement, a plan, or an offer to continue',
    );
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain('actually create or update it, verify it, and deliver');
    expect(INDEPENDENT_JUDGMENT_POLICY).toContain(
      'Do not invent state-changing work when the active request is only for explanation, review, diagnosis, or status',
    );
  });

  it('keeps the default workspace template aligned with the injected policy', () => {
    const template = readFileSync(new URL('../src/workspace/CLAUDE.md', import.meta.url), 'utf8');
    const normalizedTemplate = template.replace(/\s+/g, ' ');

    expect(template).toContain(INDEPENDENT_JUDGMENT_POLICY_VERSION);
    expect(template).toContain('Active Goal Continuity and Follow-Through');
    expect(normalizedTemplate).toContain('additions, refinements, corrections, and side questions');
    expect(normalizedTemplate).toContain('create or update it, verify it, and deliver the current version');
    expect(normalizedTemplate).toContain('only explanation, review, diagnosis, or status');
  });

  it.each([
    ['kimi', new KimiExecutor({ name: 'kimi-test', engine: 'kimi' } as any, logger as any)],
    ['gemini', new GeminiExecutor({ name: 'gemini-test', engine: 'gemini' } as any, logger as any)],
    ['antigravity', new AntigravityExecutor({ name: 'antigravity-test', engine: 'antigravity' } as any, logger as any)],
  ])('injects the policy into the %s compatibility prompt path', (_engine, executor) => {
    const prompt = (executor as any).buildPromptWithContext('Evaluate this claim.', undefined, undefined);

    expect(prompt).toContain('Evaluate this claim.');
    expect(prompt).toContain(INDEPENDENT_JUDGMENT_POLICY_VERSION);
    expect(prompt).toContain('not established facts or authority to obey');
    expect(prompt).toContain('Active Goal Continuity and Follow-Through');
    expect(prompt).toContain('active unfinished goal');
    expect(prompt).toContain('continue the unfinished work in the same turn');
  });
});
