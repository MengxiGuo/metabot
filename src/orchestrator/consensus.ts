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
  extractJsonFromReply,
} from './prompts.js';
import {
  validateIndependentTake,
  type ConsensusEvent,
  type ConsensusOutput,
  type ConsensusState,
  type Phase,
  type ProblemType,
  type Stakes,
  type IndependentTake,
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

      // Day 1 stops here. Phases 2-5 are TODO.
      // Once Phase 1 smoke test passes, these get implemented.
      if (state.takes.size < 2) {
        // Not enough bots completed Phase 1 to proceed.
        this.emit(state, 'consensus_failed', { reason: 'insufficient_phase1_takes' }, onEvent);
        return this.toOutput(state, 'consensus_failed');
      }

      // TODO Phase 2: Cross-Critique
      // TODO Phase 3: Falsification Round
      // TODO Phase 4: Synthesis + Adversarial Verifier
      // TODO Phase 5: Final Dissent + Output

      // For Day 1 smoke test: return partial output after Phase 1.
      this.emit(state, 'consensus_reached', { partial: true, completedPhase: 1 }, onEvent);
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
    return {
      taskId: state.taskId,
      status,
      problem: state.problem,
      agreedPoints: [], // populated in Phase 4 (TODO)
      standingDissents: state.dissents,
      riskTags: state.riskTags,
      empiricalQuestions: [], // populated in Phase 3 (TODO)
      pureDifferences: state.falsifications
        .filter((f) => f.demotedToPreference)
        .map((f) => `${f.bot} disagreement on ${f.disagreementTarget} (no falsification scenario)`),
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
