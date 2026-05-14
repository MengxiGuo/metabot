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

import type { ProblemType, Stakes, IndependentTake, Critique, Falsification, SynthesisCandidate } from './types.js';

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

export function buildPhase2Prompt(
  problem: string,
  myBot: string,
  otherTakes: IndependentTake[],
): string {
  const takesText = otherTakes
    .map((t) => `### Bot: ${t.bot}\nProposal: ${t.proposal}\n\nReasoning: ${t.reasoning}\n\nKnown counter-args (already self-identified by ${t.bot}):\n${t.knownCounterArgs.map((a) => `- ${a}`).join('\n')}`)
    .join('\n\n---\n\n');

  return `# Consensus Protocol — Phase 2: Cross-Critique

You are **${myBot}**. Other bots have given their independent takes on the problem. Your task: critique each other bot's take with substantive issues — DO NOT critique your own take.

## Problem
${problem}

## Other bots' takes

${takesText}

## Instructions

1. For each OTHER bot's take, identify the **top 3 most substantive issues**: failure modes, hidden assumptions, missing scenarios, broken edge cases. Skip issues already in the bot's own \`knownCounterArgs\` — don't repeat them.
2. HARD constraint: ≤ 300 words total across all critiques.
3. **Forbidden**: nitpicking trivial issues to appear critical; strawmanning weaker versions of the argument; vague "might have edge case" concerns without specifics.
4. If you genuinely find no substantive issues after honest stress-test, give fewer than 3 — but state explicitly which attack vectors you considered and why they passed.

## Output Format

Respond with ONLY a valid JSON object. No surrounding markdown fences, no preamble.

{
  "critiques": [
    {
      "targetBot": "<bot name>",
      "issues": [
        { "description": "specific issue with concrete scenario", "severity": "high" }
      ]
    }
  ]
}

severity must be one of: "high", "medium", "low". Each description must include a concrete scenario, not vague concern.`;
}

// ---------- Phase 3-5: TODO (Day 1+) ----------

// ---------- Phase 3: Falsification Round ----------

export function buildPhase3Prompt(
  problem: string,
  myBot: string,
  myCritiques: Critique[],
): string {
  const issuesList = myCritiques
    .flatMap((c) =>
      c.issues.map((iss) => `- **vs ${c.targetBot}** [${iss.severity}]: ${iss.description}`),
    )
    .join('\n');

  return `# Consensus Protocol — Phase 3: Falsification Round

You are **${myBot}**. In Phase 2 you raised the following issues against other bots' proposals. Now you must back each one up with a **constructive falsification scenario**, or honestly demote it.

## Problem
${problem}

## Your Phase 2 critiques
${issuesList}

## Instructions

For **each** issue you raised, choose exactly ONE of:

1. **falsificationScenario**: a concrete runtime / data / scenario trace showing the proposal you criticized will break — names, numbers, conditions, expected failure mode. PREFERRED when you can articulate concrete failure.

2. **riskTag**: if you cannot articulate a concrete failure trace, **honestly concede** but identify the specific risk domain you're worried about (e.g., "concurrency bottleneck at >1000 RPS", "data consistency under network partition", "PII exposure in error logs"). Must be a specific domain, NOT vague "concerns".

3. **Both null** → admit the disagreement is just preference / style. The protocol will demote this disagreement so it doesn't block consensus.

**Forbidden**: vague unease without specific risk domain ("I have a feeling..."), fabricated scenarios you can't defend, padding critique just to look critical.

## Output Format

Respond with ONLY a valid JSON object. No markdown fences.

{
  "falsifications": [
    {
      "disagreementTarget": "<bot name>: <brief issue label>",
      "falsificationScenario": "concrete trace ..." or null,
      "riskTag": { "domain": "...", "description": "..." } or null
    }
  ]
}

If both falsificationScenario and riskTag are null for an entry, the protocol marks it as a demoted preference.`;
}

// ---------- Phase 4: Synthesis + Adversarial Verifier ----------

export function buildPhase4SynthesizerPrompt(
  problem: string,
  synthesizerBot: string,
  takes: IndependentTake[],
  critiques: Critique[],
  falsifications: Falsification[],
  isForkAttempt: boolean,
): string {
  const takesText = takes
    .map((t) => `### ${t.bot}\nProposal: ${t.proposal}\nReasoning: ${t.reasoning}`)
    .join('\n\n');

  const critiquesText = critiques.length === 0 ? '(none surfaced)' : critiques
    .map((c) => `- ${c.bot} vs ${c.targetBot}: ${c.issues.map((i) => `[${i.severity}] ${i.description}`).join('; ')}`)
    .join('\n');

  const concreteFalsifications = falsifications.filter((f) => f.falsificationScenario);
  const riskTags = falsifications.filter((f) => !f.falsificationScenario && f.riskTag);
  const demoted = falsifications.filter((f) => f.demotedToPreference);

  const falsifText = concreteFalsifications.length === 0 ? '(none)' : concreteFalsifications
    .map((f) => `- ${f.bot} re: ${f.disagreementTarget}: ${f.falsificationScenario}`)
    .join('\n');

  const riskText = riskTags.length === 0 ? '(none)' : riskTags
    .map((f) => `- ${f.bot} re: ${f.disagreementTarget}: \`${f.riskTag!.domain}\` — ${f.riskTag!.description}`)
    .join('\n');

  const demotedText = demoted.length === 0 ? '(none)' : demoted
    .map((f) => `- ${f.bot} re: ${f.disagreementTarget}`)
    .join('\n');

  const forkNotice = isForkAttempt
    ? '\n\n⚠️ **FORK ATTEMPT**: a previous Synthesizer\'s candidate was rejected. You are now in charge. Address what the previous candidate missed. Do not just defend your own original view — produce a *unified* candidate or honestly surface unresolvable dissent.'
    : '';

  return `# Consensus Protocol — Phase 4: Synthesis

You are **${synthesizerBot}**, designated Synthesizer (chosen via Falsification-Weighted queue: most-critiqued bot first, to force you to confront others' issues rather than dismiss them).${forkNotice}

## Problem
${problem}

## All bots' Phase 1 takes

${takesText}

## Phase 2 critiques surfaced
${critiquesText}

## Phase 3 concrete falsification scenarios (must address)
${falsifText}

## Phase 3 risk tags (acknowledge as open questions)
${riskText}

## Phase 3 demoted preferences (DO NOT carry as substantive)
${demotedText}

## Your task

Produce a single **consensus candidate** that:
- Integrates substantive points from all takes
- **Explicitly addresses** every concrete falsification scenario (either by amending the proposal, or by escalating that scenario as a known open question)
- Acknowledges risk tags as future-work concerns
- IGNORES demoted preferences (they are stylistic, not substantive)
- Names disagreements that you cannot reconcile — don't paper over with empty consensus phrasing

**Forbidden**: cheap consensus ("we all agree on X" without addressing critiques); dropping critic's point without justification; padding with restatement.

## Output Format

Respond with ONLY a valid JSON object. No markdown fences.

{
  "synthesisContent": "the candidate text — concrete and actionable",
  "addressedCritiques": ["how I addressed critique X", "how I addressed critique Y"],
  "openRiskTags": ["risk tag domain 1", "risk tag domain 2"],
  "unresolvedDissents": ["disagreement I could not reconcile, if any"]
}`;
}

export function buildPhase4CriticPrompt(
  problem: string,
  criticBot: string,
  candidate: SynthesisCandidate,
  myTake: IndependentTake | undefined,
  myCritiques: Critique[],
  myFalsifications: Falsification[],
): string {
  const myTakeText = myTake
    ? `### My Phase 1 take\nProposal: ${myTake.proposal}\nReasoning: ${myTake.reasoning}\nKnown counter-args: ${myTake.knownCounterArgs.join('; ')}`
    : '(no Phase 1 take recorded)';

  const myCritiquesText = myCritiques.length === 0 ? '(none)' : myCritiques
    .map((c) => `- vs ${c.targetBot}: ${c.issues.map((i) => `[${i.severity}] ${i.description}`).join('; ')}`)
    .join('\n');

  const myFalsifText = myFalsifications.length === 0 ? '(none)' : myFalsifications
    .map((f) => {
      if (f.falsificationScenario) return `- ${f.disagreementTarget}: ✓ scenario "${f.falsificationScenario.slice(0, 100)}..."`;
      if (f.riskTag) return `- ${f.disagreementTarget}: 🟡 tag \`${f.riskTag.domain}\``;
      return `- ${f.disagreementTarget}: ↘ demoted`;
    })
    .join('\n');

  return `# Consensus Protocol — Phase 4: Delta Mandate Sign-Off

You are **${criticBot}**. The Synthesizer (${candidate.synthesizer}) wrote a consensus candidate. You must Delta-sign it — accept or reject — with a structured comparison to YOUR original position.

## Problem
${problem}

## Synthesizer's candidate
${candidate.content}

### Addressed critiques (claimed by Synthesizer)
${candidate.raw.includes('addressedCritiques') ? '(see candidate raw)' : '(none listed)'}

## YOUR original position

${myTakeText}

### My Phase 2 critiques (against others)
${myCritiquesText}

### My Phase 3 falsifications
${myFalsifText}

## Your task

Output a **Delta Mandate**: an honest accounting of how the candidate compares to your original position. NO "Approved" without structure — protocol-layer enforced.

For each of YOUR substantive points (from take/critiques/falsifications), classify:
- **preservedPoints**: the candidate kept this view (verbatim or paraphrased faithfully)
- **reframedPoints**: the candidate reframed it (state both "original" and "synthesizedAs")
- **droppedPoints**: the candidate dropped this view entirely

**Anti-fork-fraud**: each \`droppedPoint\` you list will be **keyword-traced** against your Phase 1/2/3 raw output. If a droppedPoint's keywords don't appear in your earlier raw text, the protocol will void your reject (you can't fabricate dropped points to force a Fork).

Then decide:
- **accept**: the candidate adequately captures your view and addresses your concrete critiques
- **reject**: only if the candidate dropped substantive points OR ignored falsification scenarios you provided. Must list droppedPoints and explain in rationale.

**Forbidden**: empty preservedPoints + empty droppedPoints + accept (= "Approved" cheap rubber-stamp, will be flagged). Empty preservedPoints + reject without dropped points (= contrarian theater).

## Output Format

JSON only, no markdown fences.

{
  "preservedPoints": ["..."],
  "reframedPoints": [{"original": "...", "synthesizedAs": "..."}],
  "droppedPoints": ["..."],
  "decision": "accept",
  "rationale": "..."
}`;
}

// ---------- Phase 5: Final Dissent ----------

export function buildPhase5Prompt(
  problem: string,
  bot: string,
  finalCandidate: SynthesisCandidate,
): string {
  return `# Consensus Protocol — Phase 5: Final Dissent

You are **${bot}**. The protocol reached its final consensus candidate (after Phase 4 sign-offs / forks). You have a last opportunity to declare a **minority dissent** that will be preserved in the audit trail.

## Problem
${problem}

## Final consensus candidate
${finalCandidate.content}

## Your task

Decide if you want to formally dissent. Three honest options:

1. **No dissent** — you genuinely accept the consensus.
2. **Concrete dissent** — you disagree, AND you can provide a specific falsification scenario showing where the candidate breaks. Required: \`scenario\` field with concrete trace.
3. **Don't dissent if you can't articulate** — protocol forbids "I have unease but can't articulate". If you don't have a concrete scenario, **don't dissent**.

This is anti-cheap-dissent: dissent has weight in the audit trail, so it must be earned with a falsification scenario.

## Output Format

JSON only, no markdown fences.

If no dissent:
{ "dissent": false }

If dissenting:
{ "dissent": true, "scenario": "concrete trace showing where the candidate breaks" }`;
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
