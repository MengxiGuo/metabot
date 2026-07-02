/**
 * N-Bot Consensus Protocol — type definitions and validators.
 *
 * Designed for N-bot generic operation. Most state is Map-keyed by bot name
 * to scale.
 */

export type Phase = 0 | 1 | 2 | 3 | 4 | 5;

export type ProblemType = 'empirical' | 'architectural' | 'preference';

export type Stakes = 'low' | 'medium' | 'high';

export interface IndependentTake {
  bot: string;
  proposal: string;
  reasoning: string;
  knownCounterArgs: string[];
  raw: string; // raw LLM output, kept for source-tracing in Phase 4
  timestamp: number;
}

export interface CritiqueIssue {
  description: string;
  severity: 'high' | 'medium' | 'low';
}

export interface Critique {
  bot: string; // critic identity
  targetBot: string; // whose take is being critiqued
  issues: CritiqueIssue[];
}

export interface RiskTag {
  bot: string;
  domain: string; // e.g. "concurrency bottleneck", "data consistency"
  description: string;
}

export interface Falsification {
  bot: string;
  disagreementTarget: string; // which other bot's claim
  falsificationScenario: string | null;
  riskTag: RiskTag | null;
  demotedToPreference: boolean; // true when both scenario and riskTag are null
}

export interface SynthesisCandidate {
  synthesizer: string;
  content: string;
  raw: string;
  iteration: number; // 0 = first candidate, increments on Fork
}

export interface ReframedPoint {
  original: string;
  synthesizedAs: string;
}

export interface Delta {
  bot: string;
  preservedPoints: string[];
  reframedPoints: ReframedPoint[];
  droppedPoints: string[];
  decision: 'accept' | 'reject';
  rationale: string;
}

export interface Dissent {
  bot: string;
  scenario: string; // required falsification scenario
}

export interface EjectedBot {
  bot: string;
  reason: 'json_malformed' | 'execution_error' | 'timeout';
  detail: string;
  phase: Phase;
}

export interface ConsensusEvent {
  ts: number;
  type:
    | 'phase_entered'
    | 'bot_started'
    | 'bot_completed'
    | 'bot_ejected'
    | 'fork_triggered'
    | 'consensus_reached'
    | 'consensus_failed'
    | 'user_escalated';
  payload: Record<string, unknown>;
}

export interface ConsensusState {
  taskId: string;
  problem: string;
  type: ProblemType;
  stakes: Stakes;
  bots: string[]; // ordered list of all bots (some may end up ejected)
  ejected: EjectedBot[];
  phase: Phase;
  round: number;
  takes: Map<string, IndependentTake>;
  critiques: Critique[];
  falsifications: Falsification[];
  riskTags: RiskTag[];
  candidate: SynthesisCandidate | null;
  deltas: Map<string, Delta>;
  rejectCounters: Map<string, number>; // per bot, count of consecutive Delta rejects
  synthesizerQueue: string[]; // falsification-weighted, most-attacked first
  currentSynthesizer: string | null;
  dissents: Dissent[];
  events: ConsensusEvent[];
  startTime: number;
  costUsd: number;
  costCapUsd: number; // default $5
  maxRounds: number; // default 5
}

export interface ConsensusOutput {
  taskId: string;
  status: 'consensus_reached' | 'consensus_failed' | 'user_escalated' | 'aborted';
  problem: string;
  agreedPoints: Array<{
    point: string;
    falsificationsAttempted: string[]; // scenarios that failed to break it
  }>;
  standingDissents: Dissent[];
  riskTags: RiskTag[];
  empiricalQuestions: string[];
  pureDifferences: string[]; // demoted preferences
  ejectedBots: EjectedBot[];
  durationMs: number;
  costUsd: number;
  rounds: number;
}

// ---------- Validators (instead of zod) ----------

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

export function validateIndependentTake(raw: unknown): IndependentTake | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isString(o.proposal) || !isString(o.reasoning)) return null;
  if (!isStringArray(o.knownCounterArgs)) return null;
  if (!isString(o.bot)) return null;
  return {
    bot: o.bot,
    proposal: o.proposal,
    reasoning: o.reasoning,
    knownCounterArgs: o.knownCounterArgs,
    raw: isString(o.raw) ? o.raw : JSON.stringify(raw),
    timestamp: Date.now(),
  };
}

export function validateCritique(raw: unknown, fromBot: string): Critique | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isString(o.targetBot)) return null;
  if (!Array.isArray(o.issues)) return null;
  const issues: CritiqueIssue[] = [];
  for (const it of o.issues) {
    if (!it || typeof it !== 'object') continue;
    const issue = it as Record<string, unknown>;
    if (!isString(issue.description)) continue;
    const sev = issue.severity;
    if (sev !== 'high' && sev !== 'medium' && sev !== 'low') continue;
    issues.push({ description: issue.description, severity: sev });
  }
  if (issues.length === 0) return null;
  return { bot: fromBot, targetBot: o.targetBot, issues };
}

export function validateFalsification(raw: unknown, fromBot: string): Falsification | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isString(o.disagreementTarget)) return null;

  const scenario = isString(o.falsificationScenario) && o.falsificationScenario.trim()
    ? o.falsificationScenario
    : null;

  let riskTag: RiskTag | null = null;
  if (o.riskTag && typeof o.riskTag === 'object') {
    const rt = o.riskTag as Record<string, unknown>;
    if (isString(rt.domain) && isString(rt.description) && rt.domain.trim()) {
      riskTag = { bot: fromBot, domain: rt.domain, description: rt.description };
    }
  }

  return {
    bot: fromBot,
    disagreementTarget: o.disagreementTarget,
    falsificationScenario: scenario,
    riskTag,
    demotedToPreference: scenario === null && riskTag === null,
  };
}

export function validateDelta(raw: unknown, fromBot: string): Delta | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isStringArray(o.preservedPoints)) return null;
  if (!isStringArray(o.droppedPoints)) return null;
  if (!isString(o.rationale)) return null;
  if (o.decision !== 'accept' && o.decision !== 'reject') return null;

  const reframed: ReframedPoint[] = [];
  if (Array.isArray(o.reframedPoints)) {
    for (const rp of o.reframedPoints) {
      if (!rp || typeof rp !== 'object') continue;
      const r = rp as Record<string, unknown>;
      if (isString(r.original) && isString(r.synthesizedAs)) {
        reframed.push({ original: r.original, synthesizedAs: r.synthesizedAs });
      }
    }
  }

  return {
    bot: fromBot,
    preservedPoints: o.preservedPoints,
    reframedPoints: reframed,
    droppedPoints: o.droppedPoints,
    decision: o.decision,
    rationale: o.rationale,
  };
}

export function validateDissent(raw: unknown, fromBot: string): Dissent | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isString(o.scenario) || !o.scenario.trim()) return null;
  return { bot: fromBot, scenario: o.scenario };
}

// ---------- Source-tracing keyword check (anti-fork-fraud) ----------

/**
 * Verify that "dropped" points claimed in a Delta actually appear (by keyword
 * overlap) in the dropping bot's prior raw output (Phase 1 take, Phase 2
 * critique, or Phase 3 falsification). Returns the list of dropped points
 * that FAILED keyword tracing — these should void the Reject and forfeit
 * Fork rights.
 *
 * Conservative: keyword check is case-insensitive, requires at least 2
 * meaningful words from each dropped point to appear somewhere in the bot's
 * prior raw text. Stopwords filtered out.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'the', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could',
  'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in', 'on', 'at', 'by',
  'for', 'with', 'as', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she',
  'it', 'we', 'they', 'them', 'their', 'his', 'her', 'its', 'our', 'me', 'my',
  'your', 'so', 'if', 'then', 'than', 'not', 'no', 'yes', 'too', 'very',
]);

export function traceDroppedPoints(droppedPoints: string[], priorRawText: string): {
  passed: string[];
  failed: string[];
} {
  const passed: string[] = [];
  const failed: string[] = [];
  const priorLower = priorRawText.toLowerCase();

  for (const point of droppedPoints) {
    const words = point
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/) // english/digit/CJK
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w));

    if (words.length === 0) {
      failed.push(point);
      continue;
    }

    const hits = words.filter((w) => priorLower.includes(w));
    // require >= 50% of meaningful words to appear, min 2 hits if possible
    const required = Math.max(2, Math.ceil(words.length * 0.5));
    if (hits.length >= Math.min(required, words.length)) {
      passed.push(point);
    } else {
      failed.push(point);
    }
  }

  return { passed, failed };
}
