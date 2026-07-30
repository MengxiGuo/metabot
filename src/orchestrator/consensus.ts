/**
 * N-Bot Consensus Protocol — orchestrator (state machine driver).
 *
 * Drives the 5-phase consensus protocol across N bots. N=2 short-term
 * (Claude + Gemini), N=3+ when Codex (or other engines) is wired in.
 *
 * Day 1 status: Phase 1 (Independent Take) implemented end-to-end.
 * Phases 2-5 are stubbed and return early — they get fleshed out once
 * Phase 1 smoke test passes.
 */

import type { Logger } from '../utils/logger.js';
import type { BotRegistry } from '../api/bot-registry.js';
import type { CardState, CardStatus } from '../types.js';
import { normalizeApiTaskResult } from '../utils/upstream-api-error.js';
import {
  buildPhase1Prompt,
  buildPhase2Prompt,
  buildPhase3Prompt,
  buildPhase4SynthesizerPrompt,
  buildPhase4CriticPrompt,
  buildPhase5Prompt,
  extractJsonFromReply,
} from './prompts.js';
import {
  validateIndependentTake,
  validateCritique,
  validateFalsification,
  validateDelta,
  validateDissent,
  traceDroppedPoints,
  type ConsensusEvent,
  type ConsensusOutput,
  type ConsensusState,
  type Critique,
  type Delta,
  type Dissent,
  type Falsification,
  type Phase,
  type ProblemType,
  type Stakes,
  type IndependentTake,
  type SynthesisCandidate,
} from './types.js';

export interface ConsensusInput {
  taskId: string;
  problem: string;
  type: ProblemType;
  stakes: Stakes;
  bots: string[];
  costCapUsd?: number;
  maxRounds?: number;
  /** Trigger chat — consensus events surface as cards here so user can
   *  watch the inter-bot dialogue mid-flight and intervene if needed. */
  chatId?: string;
  /** Caller bot name whose sender is used to post cards to chatId. Typically
   *  the bot that triggered the consensus (e.g. quatumtrading-claude). */
  callerBotName?: string;
  /** Optional non-panelist bot that writes the first synthesis candidate. */
  synthesizerBot?: string;
}

export type ConsensusEventListener = (event: ConsensusEvent, state: ConsensusState) => void;

const MAX_JSON_RETRIES = 2;
type DashboardBotStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
type DashboardRole = 'panelist' | 'synthesizer' | 'critic';
type DashboardRow = { phase: Phase; bot: string; role: DashboardRole };

export class ConsensusOrchestrator {
  private chatId: string | undefined;
  private callerBotName: string | undefined;
  private currentTaskId: string | undefined;
  private dashboardMessageId: string | undefined;
  private dashboardUpdateChain: Promise<void> = Promise.resolve();
  private dashboardStatusByKey = new Map<string, DashboardBotStatus>();
  private dashboardCardStatus: CardStatus = 'running';
  private dashboardNote = 'Starting consensus...';

  constructor(
    private registry: BotRegistry,
    private logger: Logger,
  ) {}

  /**
   * Run the consensus protocol. Returns the final structured output.
   * Caller may pass `onEvent` to stream progress (for card heartbeat).
   */
  async run(input: ConsensusInput, onEvent?: ConsensusEventListener): Promise<ConsensusOutput> {
    this.chatId = input.chatId;
    this.callerBotName = input.callerBotName;
    this.currentTaskId = input.taskId;
    this.resetDashboard();

    const state = this.initState(input);

    // Send the stable dashboard before the first expensive bot call, so the
    // user gets immediate feedback that the consensus run is alive.
    const dashboardStarted = await this.renderDashboard(state);
    if (!dashboardStarted && this.chatId && this.callerBotName) {
      const fallbackStarted = await this.postDashboardFallbackNotice(
        state,
        'Initial dashboard card could not be posted or did not return a message id.',
      );
      if (!fallbackStarted) {
        this.emit(state, 'consensus_failed', { reason: 'dashboard_start_notice_failed' }, onEvent);
        await this.waitForDashboardUpdates();
        return this.toOutput(state, 'consensus_failed');
      }
    }

    this.emit(state, 'phase_entered', { phase: 0 }, onEvent);

    try {
      // Phase 1 — Independent Take
      state.phase = 1;
      this.emit(state, 'phase_entered', { phase: 1 }, onEvent);
      await this.runPhase1(state, onEvent);

      if (state.takes.size < 2) {
        // Not enough bots completed Phase 1 to proceed.
        this.emit(state, 'consensus_failed', { reason: 'insufficient_phase1_takes' }, onEvent);
        await this.waitForDashboardUpdates();
        await this.postFinalSnapshot(state, 'consensus_failed');
        return this.toOutput(state, 'consensus_failed');
      }

      // Phase 2 — Cross-Critique
      state.phase = 2;
      this.emit(state, 'phase_entered', { phase: 2 }, onEvent);
      await this.runPhase2(state, onEvent);

      // Phase 3 — Falsification Round (only if there are critiques to falsify)
      if (state.critiques.length > 0) {
        state.phase = 3;
        this.emit(state, 'phase_entered', { phase: 3 }, onEvent);
        await this.runPhase3(state, onEvent);
      } else {
        this.markDashboardPhaseSkipped(state, 3, 'Phase 3 skipped: no critiques');
        this.postCard('▶️ Phase 3 skipped', 'No critiques surfaced in Phase 2 — nothing to falsify.', 'turquoise');
      }

      // Phase 4 — Synthesis + Adversarial Verifier
      state.phase = 4;
      this.emit(state, 'phase_entered', { phase: 4 }, onEvent);
      const phase4Status = await this.runPhase4(state, onEvent);

      // Phase 5 — Final Dissent declaration
      if (state.candidate) {
        state.phase = 5;
        this.emit(state, 'phase_entered', { phase: 5 }, onEvent);
        await this.runPhase5(state, onEvent);
      }

      if (phase4Status === 'escalated') {
        this.emit(state, 'user_escalated', { reason: 'phase4_fork_exhausted' }, onEvent);
        await this.waitForDashboardUpdates();
        await this.postFinalSnapshot(state, 'user_escalated');
        return this.toOutput(state, 'user_escalated');
      }

      this.emit(state, 'consensus_reached', { completedPhase: 5 }, onEvent);
      await this.waitForDashboardUpdates();
      await this.postFinalSnapshot(state, 'consensus_reached');
      return this.toOutput(state, 'consensus_reached');
    } catch (err: any) {
      this.logger.error({ err: err.message, taskId: state.taskId }, 'Consensus orchestrator crashed');
      this.emit(state, 'consensus_failed', { reason: 'orchestrator_crash', error: err.message }, onEvent);
      await this.waitForDashboardUpdates();
      await this.postFinalSnapshot(state, 'consensus_failed');
      return this.toOutput(state, 'consensus_failed');
    }
  }

  // ---------- Phase 1: Independent Take ----------

  private async runPhase1(state: ConsensusState, onEvent?: ConsensusEventListener): Promise<void> {
    const prompt = buildPhase1Prompt(state.problem, state.type, state.stakes);

    this.postCard(
      '▶️ Phase 1: Independent Take',
      `${state.bots.length} bots 并行独立 take (no cross-pollination)\nBots: ${state.bots.join(', ')}`,
      'blue',
    );

    // Run all bots in parallel (independence = no cross-pollination).
    const results = await Promise.allSettled(
      state.bots.map((bot) => this.invokePhase1Bot(state, bot, prompt, onEvent)),
    );

    // Validate and store; eject bots that failed.
    for (let i = 0; i < state.bots.length; i++) {
      const bot = state.bots[i];
      const result = results[i];
      if (result.status === 'fulfilled' && result.value) {
        state.takes.set(bot, result.value);
        // Surface bot's take to group so user can see what was proposed.
        const take = result.value;
        const counterArgs = take.knownCounterArgs.length
          ? '\n\n**Known counter-args:**\n' + take.knownCounterArgs.map((a) => `- ${a}`).join('\n')
          : '';
        this.postCard(
          `✅ ${bot} — Phase 1 take`,
          `**Proposal:** ${take.proposal}\n\n**Reasoning:** ${take.reasoning}${counterArgs}`,
          'green',
        );
      } else if (state.ejected.find((e) => e.bot === bot)) {
        const ejected = state.ejected.find((e) => e.bot === bot)!;
        this.postCard(`❌ ${bot} ejected (Phase 1)`, ejected.detail, 'red');
      } else {
        const reason = result.status === 'rejected' ? (result.reason?.message || 'unknown') : 'invalid_output';
        state.ejected.push({ bot, reason: 'json_malformed', detail: reason, phase: 1 });
        this.emit(state, 'bot_ejected', { bot, phase: 1, reason }, onEvent);
        this.postCard(`❌ ${bot} ejected (Phase 1)`, reason, 'red');
      }
    }

    const completed = state.takes.size;
    const total = state.bots.length;
    this.postCard(
      `✓ Phase 1 complete (${completed}/${total} bots)`,
      completed < 2
        ? '⚠️ <2 bots completed — cannot continue, will fail consensus'
        : 'Advancing to Phase 2: Cross-Critique...',
      completed < 2 ? 'orange' : 'turquoise',
    );
  }

  private async invokePhase1Bot(
    state: ConsensusState,
    bot: string,
    prompt: string,
    onEvent?: ConsensusEventListener,
  ): Promise<IndependentTake | null> {
    this.emit(state, 'bot_started', { bot, phase: 1 }, onEvent);

    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
      const cappedPrompt = attempt === 0
        ? prompt
        : `${prompt}\n\n## RETRY NOTICE\nPrevious response was not valid JSON. Respond with ONLY the JSON object, no surrounding text.`;

      const replyText = await this.invokeBotRaw(state, bot, cappedPrompt, onEvent);
      if (replyText === null) {
        // Bot execution failed entirely (e.g. ejected upstream, quota exhausted).
        return null;
      }

      const parsed = extractJsonFromReply(replyText);
      if (parsed !== null && typeof parsed === 'object') {
        // Inject bot name for validator
        const withBot = { ...(parsed as Record<string, unknown>), bot, raw: replyText };
        const take = validateIndependentTake(withBot);
        if (take) {
          this.emit(state, 'bot_completed', { bot, phase: 1, attempt }, onEvent);
          return take;
        }
      }

      this.logger.warn(
        { bot, attempt, replyPreview: replyText.slice(0, 200) },
        'Phase 1 bot output failed validation, retrying',
      );
    }

    // All retries exhausted.
    state.ejected.push({
      bot,
      reason: 'json_malformed',
      detail: `Failed JSON validation after ${MAX_JSON_RETRIES + 1} attempts`,
      phase: 1,
    });
    return null;
  }

  // ---------- Phase 2: Cross-Critique ----------

  private async runPhase2(state: ConsensusState, onEvent?: ConsensusEventListener): Promise<void> {
    const takes = Array.from(state.takes.values());
    if (takes.length < 2) return;

    this.postCard(
      '▶️ Phase 2: Cross-Critique',
      `Each bot reads other ${takes.length - 1} take(s) and surfaces top-3 substantive issues.\nForbidden: nitpicking, strawmanning, vague concerns.`,
      'blue',
    );

    const surviving = takes.filter((t) => !state.ejected.find((e) => e.bot === t.bot));

    const results = await Promise.allSettled(
      surviving.map(({ bot: myBot }) =>
        this.invokePhase2Bot(
          state,
          myBot,
          surviving.filter((t) => t.bot !== myBot),
          onEvent,
        ),
      ),
    );

    for (let i = 0; i < surviving.length; i++) {
      const myBot = surviving[i].bot;
      const result = results[i];
      if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
        state.critiques.push(...result.value);
        const summary = result.value
          .map((c) => {
            const lines = c.issues.map((iss) => `- **[${iss.severity}]** ${iss.description}`).join('\n');
            return `**vs ${c.targetBot}:**\n${lines}`;
          })
          .join('\n\n');
        this.postCard(`🔍 ${myBot} — Phase 2 critiques`, summary, 'orange');
      } else {
        this.logger.warn({ bot: myBot, taskId: state.taskId }, 'Phase 2 critique failed for bot (non-fatal)');
        if (!(result.status === 'fulfilled' && result.value && result.value.length === 0)) {
          this.emit(state, 'bot_completed', { bot: myBot, phase: 2, status: 'skipped' }, onEvent);
        }
        this.postCard(`⚠️ ${myBot} — Phase 2 critique skipped`, 'No substantive critique returned (non-fatal)', 'orange');
      }
    }

    this.postCard(
      `✓ Phase 2 complete`,
      `${state.critiques.length} critiques total across ${surviving.length} bots`,
      'turquoise',
    );
  }

  private async invokePhase2Bot(
    state: ConsensusState,
    myBot: string,
    otherTakes: IndependentTake[],
    onEvent?: ConsensusEventListener,
  ): Promise<Critique[] | null> {
    if (otherTakes.length === 0) {
      this.emit(state, 'bot_completed', { bot: myBot, phase: 2, status: 'skipped' }, onEvent);
      return null;
    }
    this.emit(state, 'bot_started', { bot: myBot, phase: 2 }, onEvent);
    const prompt = buildPhase2Prompt(state.problem, myBot, otherTakes);

    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
      const cappedPrompt = attempt === 0
        ? prompt
        : `${prompt}\n\n## RETRY NOTICE\nPrevious response was not valid JSON matching the schema. Respond with ONLY the JSON object.`;
      const replyText = await this.invokeBotRaw(state, myBot, cappedPrompt, onEvent);
      if (replyText === null) return null;

      const parsed = extractJsonFromReply(replyText);
      if (parsed && typeof parsed === 'object') {
        const critiquesArr = (parsed as Record<string, unknown>).critiques;
        if (Array.isArray(critiquesArr)) {
          const valid: Critique[] = [];
          for (const c of critiquesArr) {
            const v = validateCritique(c, myBot);
            if (v) valid.push(v);
          }
          // Empty critiques after validation = bot couldn't form substantive
          // issue. Return empty array (not null) so caller can distinguish
          // "explicitly no issues found" from "execution failure".
          this.emit(state, 'bot_completed', { bot: myBot, phase: 2, attempt, critiques: valid.length }, onEvent);
          return valid;
        }
      }

      this.logger.warn(
        { bot: myBot, attempt, replyPreview: replyText.slice(0, 200) },
        'Phase 2 output failed validation, retrying',
      );
    }
    this.emit(state, 'bot_completed', { bot: myBot, phase: 2, status: 'skipped' }, onEvent);
    return null;
  }

  // ---------- Phase 3: Falsification Round ----------

  private async runPhase3(state: ConsensusState, onEvent?: ConsensusEventListener): Promise<void> {
    // Group critiques by the critic who raised them — each critic must
    // back up their own issues with a falsification scenario or risk tag.
    const myCritiquesByBot = new Map<string, Critique[]>();
    for (const c of state.critiques) {
      const arr = myCritiquesByBot.get(c.bot) || [];
      arr.push(c);
      myCritiquesByBot.set(c.bot, arr);
    }

    this.postCard(
      '▶️ Phase 3: Falsification Round',
      `Each critic must back up their Phase 2 issues with a concrete falsification scenario or honestly tag a risk domain. Issues without either → demoted to preference.`,
      'blue',
    );

    const bots = Array.from(myCritiquesByBot.keys());
    const results = await Promise.allSettled(
      bots.map((bot) => this.invokePhase3Bot(state, bot, myCritiquesByBot.get(bot)!, onEvent)),
    );

    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      const result = results[i];
      if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
        state.falsifications.push(...result.value);
        for (const f of result.value) {
          if (f.riskTag) state.riskTags.push(f.riskTag);
        }

        // Summarize per-bot falsifications for the card
        const lines = result.value.map((f) => {
          if (f.falsificationScenario) {
            return `- ✓ **${f.disagreementTarget}** — falsification scenario provided`;
          } else if (f.riskTag) {
            return `- 🟡 **${f.disagreementTarget}** — risk tag: \`${f.riskTag.domain}\``;
          } else {
            return `- ↘ **${f.disagreementTarget}** — demoted to preference`;
          }
        }).join('\n');

        this.postCard(`🎯 ${bot} — Phase 3 falsifications`, lines, 'orange');
      } else {
        this.logger.warn({ bot, taskId: state.taskId }, 'Phase 3 falsification failed for bot (non-fatal)');
        if (!(result.status === 'fulfilled' && result.value && result.value.length === 0)) {
          this.emit(state, 'bot_completed', { bot, phase: 3, status: 'skipped' }, onEvent);
        }
        this.postCard(`⚠️ ${bot} — Phase 3 skipped`, 'No falsifications returned (non-fatal)', 'orange');
      }
    }

    const demoted = state.falsifications.filter((f) => f.demotedToPreference).length;
    const concrete = state.falsifications.filter((f) => f.falsificationScenario).length;
    const tagged = state.falsifications.filter((f) => !f.falsificationScenario && f.riskTag).length;

    this.postCard(
      '✓ Phase 3 complete',
      `Total: ${state.falsifications.length}\nConcrete falsifications: ${concrete}\nRisk tags: ${tagged}\nDemoted to preference: ${demoted}`,
      'turquoise',
    );
  }

  private async invokePhase3Bot(
    state: ConsensusState,
    bot: string,
    myCritiques: Critique[],
    onEvent?: ConsensusEventListener,
  ): Promise<Falsification[] | null> {
    if (myCritiques.length === 0) {
      this.emit(state, 'bot_completed', { bot, phase: 3, status: 'skipped' }, onEvent);
      return null;
    }
    this.emit(state, 'bot_started', { bot, phase: 3 }, onEvent);
    const prompt = buildPhase3Prompt(state.problem, bot, myCritiques);

    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
      const cappedPrompt = attempt === 0
        ? prompt
        : `${prompt}\n\n## RETRY NOTICE\nPrevious response was not valid JSON matching the schema. Respond with ONLY the JSON object.`;
      const replyText = await this.invokeBotRaw(state, bot, cappedPrompt, onEvent);
      if (replyText === null) return null;

      const parsed = extractJsonFromReply(replyText);
      if (parsed && typeof parsed === 'object') {
        const falsifications = (parsed as Record<string, unknown>).falsifications;
        if (Array.isArray(falsifications)) {
          const valid: Falsification[] = [];
          for (const f of falsifications) {
            const v = validateFalsification(f, bot);
            if (v) valid.push(v);
          }
          this.emit(state, 'bot_completed', { bot, phase: 3, attempt, falsifications: valid.length }, onEvent);
          return valid;
        }
      }

      this.logger.warn(
        { bot, attempt, replyPreview: replyText.slice(0, 200) },
        'Phase 3 output failed validation, retrying',
      );
    }
    this.emit(state, 'bot_completed', { bot, phase: 3, status: 'skipped' }, onEvent);
    return null;
  }

  // ---------- Phase 4: Synthesis + Adversarial Verifier ----------

  private async runPhase4(state: ConsensusState, onEvent?: ConsensusEventListener): Promise<'consensus' | 'escalated' | 'failed'> {
    const surviving = state.bots.filter((b) => !state.ejected.find((e) => e.bot === b));
    if (surviving.length < 2) return 'failed';

    // Build Falsification-Weighted fallback synthesizer queue:
    // count of issues received against each bot from Phase 2 (most-criticized first).
    // When a synthesizer-only bot is configured, it gets the first attempt; the
    // participant queue remains available as fallback/fork path.
    const criticismCount = new Map<string, number>();
    for (const c of state.critiques) {
      criticismCount.set(c.targetBot, (criticismCount.get(c.targetBot) || 0) + c.issues.length);
    }
    const fallbackQueue = [...surviving].sort((a, b) => (criticismCount.get(b) || 0) - (criticismCount.get(a) || 0));
    state.synthesizerQueue = state.synthesizerBot
      ? [state.synthesizerBot, ...fallbackQueue]
      : fallbackQueue;
    this.queueDashboardUpdate(state, 'Phase 4 queue ready');

    this.postCard(
      '▶️ Phase 4: Synthesis + Verifier',
      [
        state.synthesizerBot
          ? `Synthesizer-only first: ${state.synthesizerBot}`
          : 'Synthesizer starts from participant queue',
        `Fallback queue (most-critiqued panelist first):\n${fallbackQueue.map((b, i) => `${i + 1}. ${b} (received ${criticismCount.get(b) || 0} issues)`).join('\n')}`,
        'Fork rule: valid Delta reject → critic takes over. Max 2 transfers.',
      ].join('\n\n'),
      'blue',
    );

    let attempt = 0;
    const MAX_FORK_TRANSFERS = 2;
    let synthIndex = 0;

    while (attempt < MAX_FORK_TRANSFERS + 1) {
      const synthesizer = state.synthesizerQueue[synthIndex];
      if (!synthesizer) break;

      state.currentSynthesizer = synthesizer;

      // Synthesizer writes candidate
      const candidate = await this.invokePhase4Synthesizer(state, synthesizer, attempt > 0, onEvent);
      if (!candidate) {
        this.emit(state, 'bot_completed', { bot: synthesizer, phase: 4, role: 'synthesizer', status: 'failed' }, onEvent);
        this.postCard(`❌ Synthesizer ${synthesizer} failed`, 'Could not produce candidate after retries.', 'red');
        // Try next in queue
        synthIndex++;
        attempt++;
        continue;
      }
      state.candidate = candidate;
      this.postCard(
        `📝 ${synthesizer} — Synthesis candidate ${attempt === 0 ? '' : '(fork ' + attempt + ')'}`,
        candidate.content,
        'blue',
      );

      // Each critic gives Delta-Mandate sign-off
      const critics = surviving.filter((b) => b !== synthesizer);
      const deltaResults = await Promise.allSettled(
        critics.map((c) => this.invokePhase4Critic(state, c, candidate, onEvent)),
      );

      state.deltas.clear();
      for (let i = 0; i < critics.length; i++) {
        const critic = critics[i];
        const r = deltaResults[i];
        if (r.status === 'fulfilled' && r.value) {
          state.deltas.set(critic, r.value);
        } else {
          this.emit(state, 'bot_completed', { bot: critic, phase: 4, role: 'critic', status: 'skipped' }, onEvent);
        }
      }

      // Source-tracing check: each droppedPoint must keyword-trace to that
      // critic's prior raw output. Failed traces → void the reject (fork-fraud).
      const fraudulentRejects: string[] = [];
      for (const [criticBot, delta] of state.deltas.entries()) {
        const priorRaw = this.collectPriorRawForBot(state, criticBot);
        const { passed, failed } = traceDroppedPoints(delta.droppedPoints, priorRaw);
        if (failed.length > 0 && delta.decision === 'reject') {
          this.logger.warn(
            { criticBot, failedTraces: failed, passedTraces: passed },
            'Source-tracing failed for Delta rejection — voiding reject (fork-fraud blocked)',
          );
          fraudulentRejects.push(criticBot);
          // Mutate to accept (forfeit fork rights for this round)
          delta.decision = 'accept';
          delta.rationale = `[Source-tracing voided original reject: ${failed.length} droppedPoints could not be traced to your prior raw output. Original rationale: ${delta.rationale}]`;
        }
      }

      // Surface Delta cards
      for (const [critic, delta] of state.deltas.entries()) {
        const marker = delta.decision === 'accept' ? '✅' : '❌';
        const summary = [
          `**Decision:** ${delta.decision}`,
          `**Preserved:** ${delta.preservedPoints.length} points`,
          `**Reframed:** ${delta.reframedPoints.length} points`,
          `**Dropped:** ${delta.droppedPoints.length} points${fraudulentRejects.includes(critic) ? ' ⚠️ (source-tracing failed, reject voided)' : ''}`,
          `**Rationale:** ${delta.rationale.slice(0, 240)}`,
        ].join('\n');
        this.postCard(`${marker} ${critic} — Delta sign-off`, summary, delta.decision === 'accept' ? 'green' : 'red');
      }

      // Empty-Delta sentinel: accept + empty preserved + empty dropped = rubber-stamp
      for (const [critic, delta] of state.deltas.entries()) {
        if (delta.decision === 'accept' && delta.preservedPoints.length === 0 && delta.droppedPoints.length === 0 && delta.reframedPoints.length === 0) {
          this.logger.warn({ critic }, 'Empty Delta + accept — possible rubber-stamp, flagging for audit');
          this.postCard(`⚠️ ${critic} — Empty Delta (rubber-stamp flag)`, 'No preservedPoints, no droppedPoints, no reframedPoints. Audit-flagged.', 'orange');
        }
      }

      // Check consensus
      const realRejects = Array.from(state.deltas.entries()).filter(([_, d]) => d.decision === 'reject');
      if (realRejects.length === 0) {
        this.postCard(`✅ Synthesis accepted`, `All ${critics.length} critics signed off (after source-tracing checks).`, 'green');
        return 'consensus';
      }

      // Fork: at least one valid reject — designated rejecter takes over as synthesizer
      // Pick the rejecter with most substantive Delta (most preservedPoints, indicating engagement)
      const sortedRejecters = realRejects.sort((a, b) => b[1].preservedPoints.length - a[1].preservedPoints.length);
      const forkTo = sortedRejecters[0][0];

      // Move forkTo to the front of queue for next iteration
      const idx = state.synthesizerQueue.indexOf(forkTo);
      if (idx >= 0) state.synthesizerQueue.splice(idx, 1);
      state.synthesizerQueue.splice(synthIndex + 1, 0, forkTo);

      this.postCard(
        `🔁 Synthesis Fork (${realRejects.length} reject${realRejects.length > 1 ? 's' : ''})`,
        `Forking synthesizer role to **${forkTo}** (next attempt). Cap: ${MAX_FORK_TRANSFERS - attempt} transfer${MAX_FORK_TRANSFERS - attempt > 1 ? 's' : ''} left.`,
        'orange',
      );

      synthIndex++;
      attempt++;
    }

    // Fork cap exhausted
    this.postCard(
      '⚠️ Phase 4: Fork cap exhausted',
      `After ${attempt} synthesizer attempts the candidate(s) remained rejected. Escalating to user.`,
      'red',
    );
    return 'escalated';
  }

  private collectPriorRawForBot(state: ConsensusState, bot: string): string {
    const parts: string[] = [];
    const take = state.takes.get(bot);
    if (take) parts.push(take.raw);
    for (const c of state.critiques.filter((x) => x.bot === bot)) {
      parts.push(c.issues.map((i) => i.description).join(' '));
    }
    for (const f of state.falsifications.filter((x) => x.bot === bot)) {
      if (f.falsificationScenario) parts.push(f.falsificationScenario);
      if (f.riskTag) parts.push(`${f.riskTag.domain} ${f.riskTag.description}`);
    }
    return parts.join('\n');
  }

  private async invokePhase4Synthesizer(
    state: ConsensusState,
    bot: string,
    isForkAttempt: boolean,
    onEvent?: ConsensusEventListener,
  ): Promise<SynthesisCandidate | null> {
    this.emit(state, 'bot_started', { bot, phase: 4, role: 'synthesizer' }, onEvent);
    const takes = Array.from(state.takes.values());
    const prompt = buildPhase4SynthesizerPrompt(state.problem, bot, takes, state.critiques, state.falsifications, isForkAttempt);

    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
      const cappedPrompt = attempt === 0 ? prompt : `${prompt}\n\n## RETRY: Respond with ONLY the JSON object.`;
      const replyText = await this.invokeBotRaw(state, bot, cappedPrompt, onEvent);
      if (replyText === null) return null;

      const parsed = extractJsonFromReply(replyText);
      if (parsed && typeof parsed === 'object') {
        const synthesisContent = (parsed as Record<string, unknown>).synthesisContent;
        if (typeof synthesisContent === 'string' && synthesisContent.trim()) {
          this.emit(state, 'bot_completed', { bot, phase: 4, role: 'synthesizer', attempt }, onEvent);
          return {
            synthesizer: bot,
            content: synthesisContent,
            raw: replyText,
            iteration: isForkAttempt ? 1 : 0,
          };
        }
      }
      this.logger.warn({ bot, attempt, replyPreview: replyText.slice(0, 200) }, 'Phase 4 synthesizer output failed validation');
    }
    this.emit(state, 'bot_completed', { bot, phase: 4, role: 'synthesizer', status: 'failed' }, onEvent);
    return null;
  }

  private async invokePhase4Critic(
    state: ConsensusState,
    critic: string,
    candidate: SynthesisCandidate,
    onEvent?: ConsensusEventListener,
  ): Promise<Delta | null> {
    this.emit(state, 'bot_started', { bot: critic, phase: 4, role: 'critic' }, onEvent);
    const myTake = state.takes.get(critic);
    const myCritiques = state.critiques.filter((c) => c.bot === critic);
    const myFalsifications = state.falsifications.filter((f) => f.bot === critic);
    const prompt = buildPhase4CriticPrompt(state.problem, critic, candidate, myTake, myCritiques, myFalsifications);

    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
      const cappedPrompt = attempt === 0 ? prompt : `${prompt}\n\n## RETRY: Respond with ONLY the JSON object.`;
      const replyText = await this.invokeBotRaw(state, critic, cappedPrompt, onEvent);
      if (replyText === null) return null;

      const parsed = extractJsonFromReply(replyText);
      if (parsed && typeof parsed === 'object') {
        const v = validateDelta(parsed, critic);
        if (v) {
          this.emit(state, 'bot_completed', { bot: critic, phase: 4, role: 'critic', attempt, decision: v.decision }, onEvent);
          return v;
        }
      }
      this.logger.warn({ critic, attempt, replyPreview: replyText.slice(0, 200) }, 'Phase 4 critic Delta output failed validation');
    }
    this.emit(state, 'bot_completed', { bot: critic, phase: 4, role: 'critic', status: 'skipped' }, onEvent);
    return null;
  }

  // ---------- Phase 5: Final Dissent ----------

  private async runPhase5(state: ConsensusState, onEvent?: ConsensusEventListener): Promise<void> {
    if (!state.candidate) return;
    const surviving = state.bots.filter((b) => !state.ejected.find((e) => e.bot === b));

    this.postCard(
      '▶️ Phase 5: Final Dissent',
      'Last chance to declare minority dissent. Must include a concrete falsification scenario (no vague unease).',
      'blue',
    );

    const results = await Promise.allSettled(
      surviving.map((b) => this.invokePhase5Bot(state, b, state.candidate!, onEvent)),
    );

    for (let i = 0; i < surviving.length; i++) {
      const bot = surviving[i];
      const r = results[i];
      if (r.status === 'fulfilled' && r.value) {
        state.dissents.push(r.value);
        this.postCard(`⛔ ${bot} — Final dissent`, `**Scenario:** ${r.value.scenario}`, 'red');
      }
    }

    if (state.dissents.length === 0) {
      this.postCard('✓ Phase 5 complete — no minority dissents', 'All surviving bots accept the final candidate without formal dissent.', 'green');
    } else {
      this.postCard('✓ Phase 5 complete — dissents recorded', `${state.dissents.length} formal dissent(s) preserved in audit trail.`, 'orange');
    }
  }

  private async invokePhase5Bot(
    state: ConsensusState,
    bot: string,
    candidate: SynthesisCandidate,
    onEvent?: ConsensusEventListener,
  ): Promise<Dissent | null> {
    this.emit(state, 'bot_started', { bot, phase: 5 }, onEvent);
    const prompt = buildPhase5Prompt(state.problem, bot, candidate);

    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
      const cappedPrompt = attempt === 0 ? prompt : `${prompt}\n\n## RETRY: Respond with ONLY the JSON object.`;
      const replyText = await this.invokeBotRaw(state, bot, cappedPrompt, onEvent);
      if (replyText === null) return null;

      const parsed = extractJsonFromReply(replyText);
      if (parsed && typeof parsed === 'object') {
        const o = parsed as Record<string, unknown>;
        if (o.dissent === false) {
          this.emit(state, 'bot_completed', { bot, phase: 5, attempt, dissent: false }, onEvent);
          return null;
        }
        if (o.dissent === true) {
          const dissent = validateDissent({ scenario: o.scenario }, bot);
          if (dissent) {
            this.emit(state, 'bot_completed', { bot, phase: 5, attempt, dissent: true }, onEvent);
            return dissent;
          }
        }
      }
      this.logger.warn({ bot, attempt }, 'Phase 5 dissent output failed validation');
    }
    this.emit(state, 'bot_completed', { bot, phase: 5, status: 'skipped' }, onEvent);
    return null;
  }

  /**
   * Invoke a bot via its bridge.executeApiTask. Returns raw responseText on
   * success, or null on bot failure (sendCards: false — orchestrator owns
   * its own rendering via onEvent).
   *
   * Uses a virtual chatId scoped to (consensusTaskId, botName) so each bot
   * gets isolated session state.
   */
  private async invokeBotRaw(
    state: ConsensusState,
    botName: string,
    prompt: string,
    onEvent?: ConsensusEventListener,
  ): Promise<string | null> {
    const bot = this.registry.get(botName);
    if (!bot) {
      this.logger.warn({ botName, taskId: state.taskId }, 'Bot not found in registry');
      return null;
    }

    // Cost cap pre-check.
    if (state.costUsd >= state.costCapUsd) {
      this.logger.warn({ taskId: state.taskId, spent: state.costUsd, cap: state.costCapUsd }, 'Cost cap reached, refusing to invoke bot');
      return null;
    }

    const chatId = `consensus-${state.taskId}-${botName}`;
    const result = normalizeApiTaskResult(
      await bot.bridge.executeApiTask({
        prompt,
        chatId,
        userId: 'consensus-orchestrator',
        sendCards: false,
      }),
    );

    if (result.costUsd) state.costUsd += result.costUsd;

    if (!result.success) {
      this.logger.warn({ botName, error: result.error, taskId: state.taskId }, 'Bot execution failed');
      if (!state.ejected.some((entry) => entry.bot === botName)) {
        const ejected = {
          bot: botName,
          reason: 'execution_error' as const,
          detail: result.error || 'Bot execution failed without an error message',
          phase: state.phase,
        };
        state.ejected.push(ejected);
        this.emit(
          state,
          'bot_ejected',
          {
            bot: botName,
            phase: state.phase,
            reason: ejected.reason,
            detail: ejected.detail,
            errorCode: result.errorCode,
            upstreamStatus: result.upstreamStatus,
            upstreamRequestId: result.upstreamRequestId,
            retryable: result.retryable,
          },
          onEvent,
        );
      }
      return null;
    }

    return result.responseText;
  }

  // ---------- State init / output ----------

  private initState(input: ConsensusInput): ConsensusState {
    return {
      taskId: input.taskId,
      problem: input.problem,
      type: input.type,
      stakes: input.stakes,
      bots: [...input.bots],
      synthesizerBot: input.synthesizerBot ?? null,
      ejected: [],
      phase: 0,
      round: 0,
      takes: new Map(),
      critiques: [],
      falsifications: [],
      riskTags: [],
      candidate: null,
      deltas: new Map(),
      rejectCounters: new Map(),
      synthesizerQueue: [],
      currentSynthesizer: null,
      dissents: [],
      events: [],
      startTime: Date.now(),
      costUsd: 0,
      costCapUsd: input.costCapUsd ?? 5,
      maxRounds: input.maxRounds ?? 5,
    };
  }

  private toOutput(state: ConsensusState, status: ConsensusOutput['status']): ConsensusOutput {
    // agreedPoints: derived from candidate's content + critics' preservedPoints
    // (union of all preservedPoints across deltas that accepted = points the
    // consensus actually carries, with falsifications that were attempted
    // as the "stress-tests that failed to break it" trail)
    const agreedPoints = state.candidate
      ? [{
          point: state.candidate.content,
          falsificationsAttempted: state.falsifications
            .filter((f) => f.falsificationScenario)
            .map((f) => `${f.bot} → ${f.disagreementTarget}: ${f.falsificationScenario}`),
        }]
      : [];

    // empiricalQuestions: derived from risk tags whose domain is well-defined
    // and explicitly need measurement to resolve. Heuristic: any risk tag is
    // a candidate for empirical follow-up.
    const empiricalQuestions = state.riskTags.map((r) => `${r.domain} — ${r.description}`);

    return {
      taskId: state.taskId,
      status,
      problem: state.problem,
      agreedPoints,
      standingDissents: state.dissents,
      riskTags: state.riskTags,
      empiricalQuestions,
      pureDifferences: state.falsifications
        .filter((f) => f.demotedToPreference)
        .map((f) => `${f.bot} re: ${f.disagreementTarget} (no concrete scenario, no risk tag)`),
      ejectedBots: state.ejected,
      durationMs: Date.now() - state.startTime,
      costUsd: state.costUsd,
      rounds: state.round,
    };
  }

  private emit(
    state: ConsensusState,
    type: ConsensusEvent['type'],
    payload: Record<string, unknown>,
    onEvent?: ConsensusEventListener,
  ): void {
    const event: ConsensusEvent = { ts: Date.now(), type, payload };
    state.events.push(event);
    this.logger.info(
      { taskId: state.taskId, type, payload },
      `Consensus event: ${type}`,
    );
    this.updateDashboardFromEvent(state, type, payload);
    onEvent?.(event, state);
  }

  private resetDashboard(): void {
    this.dashboardMessageId = undefined;
    this.dashboardUpdateChain = Promise.resolve();
    this.dashboardStatusByKey.clear();
    this.dashboardCardStatus = 'running';
    this.dashboardNote = 'Starting consensus...';
  }

  private updateDashboardFromEvent(
    state: ConsensusState,
    type: ConsensusEvent['type'],
    payload: Record<string, unknown>,
  ): void {
    const phase = this.phaseFromPayload(payload) ?? state.phase;
    const bot = typeof payload.bot === 'string' ? payload.bot : null;
    const role = this.roleFromPayload(payload);

    if (type === 'phase_entered') {
      this.dashboardCardStatus = 'running';
      this.dashboardNote = `${this.phaseLabel(phase)} started`;
      this.seedDashboardPhase(state, phase);
      this.queueDashboardUpdate(state);
      return;
    }

    if (type === 'bot_started' && bot) {
      this.setDashboardBotStatus(phase, bot, role, 'running');
      this.dashboardNote = `${bot} running in ${this.phaseLabel(phase)}`;
      this.queueDashboardUpdate(state);
      return;
    }

    if (type === 'bot_completed' && bot) {
      this.setDashboardBotStatus(phase, bot, role, this.statusFromPayload(payload) ?? 'done');
      this.dashboardNote = `${bot} completed ${this.phaseLabel(phase)}`;
      this.queueDashboardUpdate(state);
      return;
    }

    if (type === 'bot_ejected' && bot) {
      this.setDashboardBotStatus(phase, bot, role, 'failed');
      const detail = typeof payload.detail === 'string' ? `: ${payload.detail}` : '';
      this.dashboardNote = `${bot} ejected in ${this.phaseLabel(phase)}${detail}`;
      this.queueDashboardUpdate(state);
      return;
    }

    if (type === 'consensus_reached') {
      this.dashboardCardStatus = 'complete';
      this.dashboardNote = 'Consensus reached';
      this.queueDashboardUpdate(state);
      return;
    }

    if (type === 'consensus_failed') {
      this.dashboardCardStatus = 'error';
      this.dashboardNote = `Consensus failed: ${String(payload.reason ?? 'unknown')}`;
      this.queueDashboardUpdate(state);
      return;
    }

    if (type === 'user_escalated') {
      this.dashboardCardStatus = 'waiting_for_input';
      this.dashboardNote = `User escalation needed: ${String(payload.reason ?? 'unknown')}`;
      this.queueDashboardUpdate(state);
    }
  }

  private seedDashboardPhase(state: ConsensusState, phase: Phase): void {
    for (const row of this.dashboardRowsForPhase(state, phase)) {
      const key = this.dashboardKey(row.phase, row.bot, row.role);
      if (!this.dashboardStatusByKey.has(key)) {
        this.dashboardStatusByKey.set(key, 'pending');
      }
    }
  }

  private markDashboardPhaseSkipped(state: ConsensusState, phase: Phase, note: string): void {
    this.dashboardNote = note;
    if (phase === 3 && state.critiques.length === 0) {
      // Phase 3 has no bot rows when there are no critiques; the renderer shows
      // this as a phase-level skip instead of per-bot skipped statuses.
      this.queueDashboardUpdate(state);
      return;
    }
    for (const row of this.dashboardRowsForPhase(state, phase)) {
      this.setDashboardBotStatus(row.phase, row.bot, row.role, 'skipped');
    }
    this.queueDashboardUpdate(state);
  }

  private setDashboardBotStatus(phase: Phase, bot: string, role: DashboardRole, status: DashboardBotStatus): void {
    const key = this.dashboardKey(phase, bot, role);
    const current = this.dashboardStatusByKey.get(key);
    if (current && !this.isDashboardStatusTransitionAllowed(current, status)) return;
    this.dashboardStatusByKey.set(key, status);
  }

  private queueDashboardUpdate(state: ConsensusState, note?: string): void {
    if (note) this.dashboardNote = note;
    if (!this.chatId || !this.callerBotName) return;
    this.dashboardUpdateChain = this.dashboardUpdateChain
      .catch((err: any) => {
        this.logger.warn({ err: err?.message, taskId: state.taskId }, 'Consensus dashboard previous update failed');
      })
      .then(() => this.renderDashboard(state).then(() => undefined));
  }

  private async waitForDashboardUpdates(): Promise<void> {
    await this.dashboardUpdateChain.catch((err: any) => {
      this.logger.warn({ err: err?.message }, 'Consensus dashboard flush failed');
    });
  }

  private async renderDashboard(state: ConsensusState): Promise<boolean> {
    if (!this.chatId || !this.callerBotName) return true;
    const caller = this.registry.get(this.callerBotName);
    if (!caller) {
      this.logger.warn({ callerBotName: this.callerBotName }, 'Consensus: caller bot not in registry, skipping dashboard');
      return false;
    }

    const cardState: CardState = {
      status: this.dashboardCardStatus,
      userPrompt: `Consensus ${state.taskId}`,
      responseText: this.buildDashboardText(state),
      toolCalls: [],
      cardLabel: 'Consensus Dashboard',
      costUsd: state.costUsd,
      durationMs: Date.now() - state.startTime,
    };

    try {
      if (!this.dashboardMessageId) {
        this.dashboardMessageId = await caller.sender.sendCard(this.chatId, cardState);
        this.logger.info(
          { taskId: state.taskId, chatId: this.chatId, messageId: this.dashboardMessageId },
          'Consensus dashboard posted',
        );
        return Boolean(this.dashboardMessageId);
      }

      const updated = await caller.sender.updateCard(this.dashboardMessageId, cardState);
      if (updated) return true;

      if (!updated) {
        this.logger.warn(
          { taskId: state.taskId, chatId: this.chatId, messageId: this.dashboardMessageId },
          'Consensus dashboard update failed; sending replacement card',
        );
        this.dashboardMessageId = await caller.sender.sendCard(this.chatId, cardState);
        return Boolean(this.dashboardMessageId);
      }
    } catch (err: any) {
      this.logger.warn({ err: err?.message, taskId: state.taskId }, 'Consensus dashboard render failed');
      return false;
    }
    return false;
  }

  private async postDashboardFallbackNotice(state: ConsensusState, reason: string): Promise<boolean> {
    if (!this.chatId || !this.callerBotName) return true;
    const caller = this.registry.get(this.callerBotName);
    if (!caller) {
      this.logger.warn({ callerBotName: this.callerBotName }, 'Consensus: caller bot missing, cannot post dashboard fallback');
      return false;
    }

    const body = [
      `Task: ${state.taskId}`,
      'Dashboard card failed to initialize.',
      `Reason: ${reason}`,
      '',
      'Consensus is accepted only after this fallback is visible.',
      `Panelists: ${state.bots.join(', ')}`,
      state.synthesizerBot ? `Synthesizer-only: ${state.synthesizerBot}` : 'Synthesizer: participant queue',
    ].join('\n');

    try {
      await caller.sender.sendTextNotice(this.chatId, `[${state.taskId}] Consensus started`, body, 'orange');
      this.logger.info({ taskId: state.taskId, chatId: this.chatId }, 'Consensus dashboard fallback posted');
      return true;
    } catch (err: any) {
      this.logger.warn({ err: err?.message, taskId: state.taskId }, 'Consensus dashboard fallback failed');
      return false;
    }
  }

  private async postFinalSnapshot(state: ConsensusState, status: ConsensusOutput['status']): Promise<void> {
    if (!this.chatId || !this.callerBotName) return;
    const caller = this.registry.get(this.callerBotName);
    if (!caller) {
      this.logger.warn({ callerBotName: this.callerBotName }, 'Consensus: caller bot missing, cannot post final snapshot');
      return;
    }

    const color = status === 'consensus_reached' ? 'green' : status === 'user_escalated' ? 'orange' : 'red';
    try {
      await caller.sender.sendTextNotice(
        this.chatId,
        `[${state.taskId}] Consensus final snapshot`,
        this.buildFinalSnapshotText(state, status),
        color,
      );
      this.logger.info({ taskId: state.taskId, chatId: this.chatId, status }, 'Consensus final snapshot posted');
    } catch (err: any) {
      this.logger.warn({ err: err?.message, taskId: state.taskId }, 'Consensus final snapshot failed');
    }
  }

  private buildFinalSnapshotText(state: ConsensusState, status: ConsensusOutput['status']): string {
    const lines: string[] = [];
    lines.push(`Task: ${state.taskId}`);
    lines.push(`Status: ${status}`);
    lines.push(`Final phase: ${this.phaseLabel(state.phase)}`);
    lines.push(`Duration: ${this.formatDuration(Date.now() - state.startTime)}`);
    lines.push(`Cost: $${state.costUsd.toFixed(4)} / $${state.costCapUsd.toFixed(2)}`);
    lines.push('');
    lines.push('Panelists:');
    for (const bot of state.bots) {
      const ejected = state.ejected.find((e) => e.bot === bot);
      lines.push(`- ${bot}: ${ejected ? `ejected in P${ejected.phase}` : 'survived'}`);
    }
    lines.push('');
    lines.push(state.synthesizerBot
      ? `Synthesizer-only: ${state.synthesizerBot}`
      : `Synthesizer: ${state.currentSynthesizer ?? 'participant queue'}`);
    if (state.candidate) lines.push(`Candidate by: ${state.candidate.synthesizer}`);
    lines.push(`Dissents: ${state.dissents.length}`);
    lines.push(`Risk tags: ${state.riskTags.length}`);
    lines.push(`Ejected: ${state.ejected.length}`);
    return lines.join('\n');
  }

  private isDashboardStatusTransitionAllowed(current: DashboardBotStatus, next: DashboardBotStatus): boolean {
    const rank: Record<DashboardBotStatus, number> = {
      pending: 0,
      running: 1,
      skipped: 2,
      failed: 3,
      done: 4,
    };
    return rank[next] >= rank[current];
  }

  private buildDashboardText(state: ConsensusState): string {
    const lines: string[] = [];
    lines.push(`Task: ${state.taskId}`);
    lines.push(`Current: ${this.phaseLabel(state.phase)}`);
    lines.push(`Note: ${this.dashboardNote}`);
    lines.push(`Elapsed: ${this.formatDuration(Date.now() - state.startTime)}`);
    lines.push(`Cost: $${state.costUsd.toFixed(4)} / $${state.costCapUsd.toFixed(2)}`);
    lines.push(`Type: ${state.type}  Stakes: ${state.stakes}`);
    lines.push('');
    lines.push('Panelists:');
    for (const bot of state.bots) lines.push(`- ${bot}`);
    lines.push(state.synthesizerBot
      ? `Synthesizer-only: ${state.synthesizerBot}`
      : 'Synthesizer: participant queue');
    lines.push('');
    lines.push(`Problem: ${this.truncateLine(state.problem, 180)}`);
    lines.push('');
    lines.push('Progress:');

    for (const phase of [1, 2, 3, 4, 5] as Phase[]) {
      lines.push('');
      lines.push(`${this.phaseIcon(state, phase)} ${this.phaseLabel(phase)}`);
      const rows = this.dashboardRowsForPhase(state, phase);
      if (rows.length === 0) {
        lines.push(`  ${this.phaseEmptyLine(state, phase)}`);
        continue;
      }
      for (const row of rows) {
        const status = this.getDashboardBotStatus(state, row);
        lines.push(`  ${this.statusIcon(status)} ${this.dashboardRowLabel(row)}`);
      }
    }

    lines.push('');
    lines.push('Legend: pending / running / done / skipped / failed');
    return lines.join('\n');
  }

  private dashboardRowsForPhase(state: ConsensusState, phase: Phase): DashboardRow[] {
    if (phase === 1) return state.bots.map((bot) => ({ phase, bot, role: 'panelist' }));

    if (phase === 2) {
      const bots = state.phase >= 2 && state.takes.size > 0
        ? Array.from(state.takes.keys())
        : state.bots;
      return bots.map((bot) => ({ phase, bot, role: 'panelist' }));
    }

    if (phase === 3) {
      if (state.phase < 3 && state.critiques.length === 0) return [];
      const bots = Array.from(new Set(state.critiques.map((c) => c.bot)));
      return bots.map((bot) => ({ phase, bot, role: 'panelist' }));
    }

    if (phase === 4) {
      if (state.phase < 4 && state.synthesizerQueue.length === 0 && !state.currentSynthesizer) return [];
      const surviving = state.bots.filter((b) => !state.ejected.find((e) => e.bot === b));
      const currentSynthesizer = state.currentSynthesizer ?? state.synthesizerQueue[0] ?? state.synthesizerBot;
      const rows: DashboardRow[] = [];
      const synthRows = new Set<string>();
      for (const candidate of [state.currentSynthesizer, state.synthesizerBot, ...state.synthesizerQueue]) {
        if (!candidate) continue;
        const key = this.dashboardKey(phase, candidate, 'synthesizer');
        if (candidate === currentSynthesizer || this.dashboardStatusByKey.has(key)) synthRows.add(candidate);
      }
      for (const bot of synthRows) rows.push({ phase, bot, role: 'synthesizer' });

      const critics = currentSynthesizer && surviving.includes(currentSynthesizer)
        ? surviving.filter((b) => b !== currentSynthesizer)
        : surviving;
      for (const bot of critics) rows.push({ phase, bot, role: 'critic' });
      return rows;
    }

    if (phase === 5) {
      const surviving = state.bots.filter((b) => !state.ejected.find((e) => e.bot === b));
      return surviving.map((bot) => ({ phase, bot, role: 'panelist' }));
    }

    return [];
  }

  private getDashboardBotStatus(state: ConsensusState, row: DashboardRow): DashboardBotStatus {
    const explicit = this.dashboardStatusByKey.get(this.dashboardKey(row.phase, row.bot, row.role));
    if (explicit) return explicit;
    const ejected = state.ejected.find((e) => e.bot === row.bot);
    if (ejected && ejected.phase <= row.phase) return 'skipped';
    if (row.phase < state.phase) return 'done';
    return 'pending';
  }

  private dashboardKey(phase: Phase, bot: string, role: DashboardRole): string {
    return `${phase}\u001f${role}\u001f${bot}`;
  }

  private phaseFromPayload(payload: Record<string, unknown>): Phase | null {
    const phase = payload.phase;
    if (phase === 0 || phase === 1 || phase === 2 || phase === 3 || phase === 4 || phase === 5) return phase;
    return null;
  }

  private roleFromPayload(payload: Record<string, unknown>): DashboardRole {
    const role = payload.role;
    if (role === 'synthesizer' || role === 'critic' || role === 'panelist') return role;
    return 'panelist';
  }

  private statusFromPayload(payload: Record<string, unknown>): DashboardBotStatus | null {
    const status = payload.status;
    if (status === 'pending' || status === 'running' || status === 'done' || status === 'failed' || status === 'skipped') {
      return status;
    }
    return null;
  }

  private phaseLabel(phase: Phase): string {
    switch (phase) {
      case 0: return 'Phase 0: Startup';
      case 1: return 'Phase 1: Independent Take';
      case 2: return 'Phase 2: Cross-Critique';
      case 3: return 'Phase 3: Falsification';
      case 4: return 'Phase 4: Synthesis + Verify';
      case 5: return 'Phase 5: Final Dissent';
    }
  }

  private phaseIcon(state: ConsensusState, phase: Phase): string {
    if (phase === 3 && state.phase > 3 && state.critiques.length === 0) return '⏭';
    if (this.dashboardCardStatus === 'complete' && phase <= 5) return '✓';
    if (phase < state.phase) return '✓';
    if (phase === state.phase) return '▶';
    return '▫';
  }

  private phaseEmptyLine(state: ConsensusState, phase: Phase): string {
    if (phase === 3 && state.phase > 3 && state.critiques.length === 0) {
      return 'skipped: no Phase 2 critiques';
    }
    if (phase === 3) return 'waiting for Phase 2 critiques';
    if (phase === 4) return 'waiting for synthesizer queue';
    return 'pending';
  }

  private statusIcon(status: DashboardBotStatus): string {
    switch (status) {
      case 'pending': return '▫';
      case 'running': return '⏳';
      case 'done': return '✓';
      case 'failed': return '✗';
      case 'skipped': return '↷';
    }
  }

  private dashboardRowLabel(row: DashboardRow): string {
    if (row.role === 'synthesizer') return `${row.bot} (synthesizer)`;
    if (row.role === 'critic') return `${row.bot} (critic)`;
    return row.bot;
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  private truncateLine(text: string, maxChars: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
  }

  /**
   * Post a visible card to the trigger group so user can watch consensus
   * mid-flight. No-op if chatId/callerBotName not provided (e.g. headless
   * API call without UI surfacing).
   */
  private postCard(title: string, body: string, color: 'blue' | 'green' | 'orange' | 'red' | 'turquoise' = 'blue'): void {
    const displayTitle = this.currentTaskId ? `[${this.currentTaskId}] ${title}` : title;
    if (!this.chatId || !this.callerBotName) {
      this.logger.warn(
        {
          title: displayTitle,
          hasChatId: Boolean(this.chatId),
          hasCallerBotName: Boolean(this.callerBotName),
        },
        'Consensus: card post skipped because chatId/callerBotName is missing',
      );
      return;
    }
    const caller = this.registry.get(this.callerBotName);
    if (!caller) {
      this.logger.warn({ callerBotName: this.callerBotName }, 'Consensus: caller bot not in registry, skipping card');
      return;
    }
    // Fire-and-forget — don't block consensus on card delivery.
    this.logger.info(
      { title: displayTitle, chatId: this.chatId, callerBotName: this.callerBotName, color },
      'Consensus: posting card',
    );
    caller.sender
      .sendTextNotice(this.chatId, displayTitle, body, color)
      .then(() => {
        this.logger.info(
          { title: displayTitle, chatId: this.chatId, callerBotName: this.callerBotName },
          'Consensus: card posted',
        );
      })
      .catch((err: any) => {
        this.logger.warn({ err: err?.message, title: displayTitle, chatId: this.chatId }, 'Consensus: card post failed');
      });
  }
}

// ---------- Convenience: return raw takes for smoke test ----------

export function getPhase1TakesSnapshot(state: ConsensusState): IndependentTake[] {
  return Array.from(state.takes.values());
}
