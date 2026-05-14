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
}

export type ConsensusEventListener = (event: ConsensusEvent, state: ConsensusState) => void;

const MAX_JSON_RETRIES = 2;

export class ConsensusOrchestrator {
  private chatId: string | undefined;
  private callerBotName: string | undefined;

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

    const state = this.initState(input);

    // Initial card so user knows consensus has started.
    this.postCard(
      '🧠 Consensus 启动',
      `Bots: ${input.bots.join(', ')}\nType: ${input.type} | Stakes: ${input.stakes}\nProblem: ${input.problem}`,
      'blue',
    );

    this.emit(state, 'phase_entered', { phase: 0 }, onEvent);

    try {
      // Phase 1 — Independent Take
      state.phase = 1;
      this.emit(state, 'phase_entered', { phase: 1 }, onEvent);
      await this.runPhase1(state, onEvent);

      if (state.takes.size < 2) {
        // Not enough bots completed Phase 1 to proceed.
        this.emit(state, 'consensus_failed', { reason: 'insufficient_phase1_takes' }, onEvent);
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
        return this.toOutput(state, 'user_escalated');
      }

      this.emit(state, 'consensus_reached', { completedPhase: 5 }, onEvent);
      return this.toOutput(state, 'consensus_reached');
    } catch (err: any) {
      this.logger.error({ err: err.message, taskId: state.taskId }, 'Consensus orchestrator crashed');
      this.emit(state, 'consensus_failed', { reason: 'orchestrator_crash', error: err.message }, onEvent);
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
        this.postCard(`❌ ${bot} ejected (Phase 1)`, 'JSON validation failed after retries', 'red');
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
        : 'Day 1 stops here. Phase 2-5 implementation pending.',
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

      const replyText = await this.invokeBotRaw(state, bot, cappedPrompt);
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
  ): Promise<Critique[] | null> {
    if (otherTakes.length === 0) return null;
    const prompt = buildPhase2Prompt(state.problem, myBot, otherTakes);

    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
      const cappedPrompt = attempt === 0
        ? prompt
        : `${prompt}\n\n## RETRY NOTICE\nPrevious response was not valid JSON matching the schema. Respond with ONLY the JSON object.`;
      const replyText = await this.invokeBotRaw(state, myBot, cappedPrompt);
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
          return valid;
        }
      }

      this.logger.warn(
        { bot: myBot, attempt, replyPreview: replyText.slice(0, 200) },
        'Phase 2 output failed validation, retrying',
      );
    }
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
      bots.map((bot) => this.invokePhase3Bot(state, bot, myCritiquesByBot.get(bot)!)),
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
  ): Promise<Falsification[] | null> {
    if (myCritiques.length === 0) return null;
    const prompt = buildPhase3Prompt(state.problem, bot, myCritiques);

    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
      const cappedPrompt = attempt === 0
        ? prompt
        : `${prompt}\n\n## RETRY NOTICE\nPrevious response was not valid JSON matching the schema. Respond with ONLY the JSON object.`;
      const replyText = await this.invokeBotRaw(state, bot, cappedPrompt);
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
          return valid;
        }
      }

      this.logger.warn(
        { bot, attempt, replyPreview: replyText.slice(0, 200) },
        'Phase 3 output failed validation, retrying',
      );
    }
    return null;
  }

  // ---------- Phase 4: Synthesis + Adversarial Verifier ----------

  private async runPhase4(state: ConsensusState, onEvent?: ConsensusEventListener): Promise<'consensus' | 'escalated' | 'failed'> {
    const surviving = state.bots.filter((b) => !state.ejected.find((e) => e.bot === b));
    if (surviving.length < 2) return 'failed';

    // Build Falsification-Weighted synthesizer queue:
    // count of issues received against each bot from Phase 2 (most-criticized first).
    // This forces the most-attacked bot to self-defense-synthesize first.
    const criticismCount = new Map<string, number>();
    for (const c of state.critiques) {
      criticismCount.set(c.targetBot, (criticismCount.get(c.targetBot) || 0) + c.issues.length);
    }
    state.synthesizerQueue = [...surviving].sort((a, b) => (criticismCount.get(b) || 0) - (criticismCount.get(a) || 0));

    this.postCard(
      '▶️ Phase 4: Synthesis + Verifier',
      `Falsification-Weighted queue (most-critiqued first):\n${state.synthesizerQueue.map((b, i) => `${i + 1}. ${b} (received ${criticismCount.get(b) || 0} issues)`).join('\n')}\n\nFork rule: 2 consecutive Delta rejects → critic takes over. Max 2 transfers.`,
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
      const candidate = await this.invokePhase4Synthesizer(state, synthesizer, attempt > 0);
      if (!candidate) {
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
        critics.map((c) => this.invokePhase4Critic(state, c, candidate)),
      );

      state.deltas.clear();
      for (let i = 0; i < critics.length; i++) {
        const critic = critics[i];
        const r = deltaResults[i];
        if (r.status === 'fulfilled' && r.value) {
          state.deltas.set(critic, r.value);
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
  ): Promise<SynthesisCandidate | null> {
    const takes = Array.from(state.takes.values());
    const prompt = buildPhase4SynthesizerPrompt(state.problem, bot, takes, state.critiques, state.falsifications, isForkAttempt);

    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
      const cappedPrompt = attempt === 0 ? prompt : `${prompt}\n\n## RETRY: Respond with ONLY the JSON object.`;
      const replyText = await this.invokeBotRaw(state, bot, cappedPrompt);
      if (replyText === null) return null;

      const parsed = extractJsonFromReply(replyText);
      if (parsed && typeof parsed === 'object') {
        const synthesisContent = (parsed as Record<string, unknown>).synthesisContent;
        if (typeof synthesisContent === 'string' && synthesisContent.trim()) {
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
    return null;
  }

  private async invokePhase4Critic(
    state: ConsensusState,
    critic: string,
    candidate: SynthesisCandidate,
  ): Promise<Delta | null> {
    const myTake = state.takes.get(critic);
    const myCritiques = state.critiques.filter((c) => c.bot === critic);
    const myFalsifications = state.falsifications.filter((f) => f.bot === critic);
    const prompt = buildPhase4CriticPrompt(state.problem, critic, candidate, myTake, myCritiques, myFalsifications);

    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
      const cappedPrompt = attempt === 0 ? prompt : `${prompt}\n\n## RETRY: Respond with ONLY the JSON object.`;
      const replyText = await this.invokeBotRaw(state, critic, cappedPrompt);
      if (replyText === null) return null;

      const parsed = extractJsonFromReply(replyText);
      if (parsed && typeof parsed === 'object') {
        const v = validateDelta(parsed, critic);
        if (v) return v;
      }
      this.logger.warn({ critic, attempt, replyPreview: replyText.slice(0, 200) }, 'Phase 4 critic Delta output failed validation');
    }
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
      surviving.map((b) => this.invokePhase5Bot(state, b, state.candidate!)),
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
  ): Promise<Dissent | null> {
    const prompt = buildPhase5Prompt(state.problem, bot, candidate);

    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
      const cappedPrompt = attempt === 0 ? prompt : `${prompt}\n\n## RETRY: Respond with ONLY the JSON object.`;
      const replyText = await this.invokeBotRaw(state, bot, cappedPrompt);
      if (replyText === null) return null;

      const parsed = extractJsonFromReply(replyText);
      if (parsed && typeof parsed === 'object') {
        const o = parsed as Record<string, unknown>;
        if (o.dissent === false) return null;
        if (o.dissent === true) {
          return validateDissent({ scenario: o.scenario }, bot);
        }
      }
      this.logger.warn({ bot, attempt }, 'Phase 5 dissent output failed validation');
    }
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
  private async invokeBotRaw(state: ConsensusState, botName: string, prompt: string): Promise<string | null> {
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
    const result = await bot.bridge.executeApiTask({
      prompt,
      chatId,
      userId: 'consensus-orchestrator',
      sendCards: false,
    });

    if (result.costUsd) state.costUsd += result.costUsd;

    if (!result.success) {
      this.logger.warn({ botName, error: result.error, taskId: state.taskId }, 'Bot execution failed');
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
    onEvent?.(event, state);
  }

  /**
   * Post a visible card to the trigger group so user can watch consensus
   * mid-flight. No-op if chatId/callerBotName not provided (e.g. headless
   * API call without UI surfacing).
   */
  private postCard(title: string, body: string, color: 'blue' | 'green' | 'orange' | 'red' | 'turquoise' = 'blue'): void {
    if (!this.chatId || !this.callerBotName) return;
    const caller = this.registry.get(this.callerBotName);
    if (!caller) {
      this.logger.warn({ callerBotName: this.callerBotName }, 'Consensus: caller bot not in registry, skipping card');
      return;
    }
    // Fire-and-forget — don't block consensus on card delivery.
    caller.sender.sendTextNotice(this.chatId, title, body, color).catch((err: any) => {
      this.logger.warn({ err: err?.message, title }, 'Consensus: card post failed');
    });
  }
}

// ---------- Convenience: return raw takes for smoke test ----------

export function getPhase1TakesSnapshot(state: ConsensusState): IndependentTake[] {
  return Array.from(state.takes.values());
}
