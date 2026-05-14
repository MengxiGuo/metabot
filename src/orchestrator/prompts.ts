/**
 * Prompt templates for the N-Bot Consensus Protocol.
 *
 * Each phase has a deterministic prompt that requires JSON output matching
 * a known schema. The orchestrator parses + validates output, retries on
 * malformation (max 2 attempts), and ejects bots that repeatedly fail.
 *
 * Phase 1 (Independent Take) is fully implemented here for Day 1 smoke
 * test. Phases 2-5 are stubbed with TODO markers; they get fleshed out
 * once Phase 1 end-to-end works.
 */

import type { ProblemType, Stakes, IndependentTake } from './types.js';

// ---------- Phase 1: Independent Take ----------

export function buildPhase1Prompt(problem: string, type: ProblemType, stakes: Stakes): string {
  return `# Consensus Protocol — Phase 1: Independent Take

You are participating in a multi-bot consensus discussion. This is **Phase 1: Independent Take** — you give your own take on the problem WITHOUT seeing other bots' takes. Cross-pollination and anchoring are prevented in this phase.

## Problem
${problem}

## Type: ${type}
## Stakes: ${stakes}

## Instructions
1. Give your own take on this problem.
2. **HARD constraint: total output ≤ 300 words.** Be concise and structured.
3. Default mode: honest critical analysis, not agreeable hedging.
4. List known counter-arguments to your own take — what would a thoughtful critic say?

## Output Format
Respond with ONLY a valid JSON object matching this schema. No surrounding markdown fences, no explanation, no preamble. Just the JSON object.

{
  "proposal": "your main take (1-3 sentences)",
  "reasoning": "supporting reasoning (1-2 short paragraphs)",
  "knownCounterArgs": ["specific counter-arg 1", "specific counter-arg 2", "..."]
}

Total word count across all fields must be ≤ 300 words. Counter-args should be specific (not vague "might have edge cases").`;
}

// ---------- Phase 2: Cross-Critique ----------
// TODO Day 1+ — stub for skeleton
export function buildPhase2Prompt(
  problem: string,
  myBot: string,
  otherTakes: IndependentTake[],
): string {
  const takesText = otherTakes
    .map((t) => `### Bot: ${t.bot}\nProposal: ${t.proposal}\nReasoning: ${t.reasoning}\nKnown counter-args: ${t.knownCounterArgs.join('; ')}`)
    .join('\n\n');

  return `# Consensus Protocol — Phase 2: Cross-Critique

You are ${myBot}. Other bots have given their independent takes on the problem. Your task: critique each other bot's take with substantive issues.

## Problem
${problem}

## Other bots' takes
${takesText}

## Instructions
- For each other bot's take, identify the **top 3 most substantive issues** (failure modes, hidden assumptions, missing scenarios).
- HARD constraint: ≤ 300 words total across all critiques.
- Forbidden: nitpicking trivial issues, strawmanning, vague "might have edge case" concerns.
- If you genuinely find no substantive issues, you may give fewer than 3 — but state explicitly "I stress-tested X attack vectors and they all passed".

## Output Format
Respond with ONLY a valid JSON object. No surrounding markdown.

{
  "critiques": [
    {
      "targetBot": "bot name",
      "issues": [
        { "description": "specific issue with concrete scenario", "severity": "high|medium|low" }
      ]
    }
  ]
}`;
}

// ---------- Phase 3-5: TODO (Day 1+) ----------

export function buildPhase3Prompt(): string {
  // TODO: Falsification round — for each remaining disagreement, require
  // constructive falsification scenario or Probabilistic Risk Tag.
  return '// TODO Phase 3';
}

export function buildPhase4SynthesizerPrompt(): string {
  // TODO: Synthesizer writes candidate from all takes + critiques.
  return '// TODO Phase 4 synthesizer';
}

export function buildPhase4CriticPrompt(): string {
  // TODO: Critic gives Delta Mandate sign-off on candidate.
  return '// TODO Phase 4 critic';
}

export function buildPhase5Prompt(): string {
  // TODO: Final dissent declaration with required falsification scenario.
  return '// TODO Phase 5';
}

// ---------- JSON extraction helper ----------

/**
 * Best-effort extraction of a JSON object from an LLM reply. LLMs often
 * wrap JSON in markdown code fences or add preamble/postamble text. This
 * helper handles common patterns:
 *   - Raw JSON object (starts with `{`)
 *   - Fenced ```json ... ``` block
 *   - Fenced ``` ... ``` block (no language hint)
 *   - JSON embedded in surrounding text (extract first balanced {...})
 *
 * Returns parsed object on success, null on failure.
 */
export function extractJsonFromReply(reply: string): unknown {
  const trimmed = reply.trim();

  // Case 1: pure JSON
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to extraction
    }
  }

  // Case 2: fenced block
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Case 3: find first balanced {...} block
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(firstBrace, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            return null;
          }
        }
      }
    }
  }

  return null;
}
