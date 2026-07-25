import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';
import { ConsensusOrchestrator, type ConsensusInput } from '../../orchestrator/consensus.js';
import { resolveConsensusRequest, type ResolvedConsensusRequest } from '../../orchestrator/consensus-profile.js';
import type { ProblemType, Stakes } from '../../orchestrator/types.js';

const VALID_TYPES: ProblemType[] = ['empirical', 'architectural', 'preference'];
const VALID_STAKES: Stakes[] = ['low', 'medium', 'high'];

export async function handleConsensusRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, logger, asyncTaskStore } = ctx;
  const consensusProfiles = ctx.consensusProfiles ?? {};

  // GET /api/consensus/profiles — list configured named presets
  if (method === 'GET' && url === '/api/consensus/profiles') {
    jsonResponse(res, 200, {
      profiles: Object.entries(consensusProfiles).map(([name, p]) => ({
        name,
        panelists: p.panelists,
        synthesizerBot: p.synthesizerBot,
        type: p.type,
        stakes: p.stakes,
        costCapUsd: p.costCapUsd,
        maxRounds: p.maxRounds,
      })),
    });
    return true;
  }

  // GET /api/consensus/:taskId — async task status
  if (method === 'GET' && url.startsWith('/api/consensus/')) {
    const taskId = url.slice('/api/consensus/'.length);
    const task = asyncTaskStore.get(taskId);
    if (!task) {
      jsonResponse(res, 404, { error: `Consensus task not found: ${taskId}` });
      return true;
    }
    jsonResponse(res, 200, {
      taskId: task.id,
      status: task.status,
      createdAt: new Date(task.createdAt).toISOString(),
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
      result: task.result,
    });
    return true;
  }

  // POST /api/consensus/doctor — validate a profile/selection without
  // starting LLM work. With dryRun=true it also sends a small card through
  // callerBotName to prove the visible chat path works.
  if (method === 'POST' && url === '/api/consensus/doctor') {
    const body = await parseJsonBody(req);
    const request = resolveConsensusRequest(body as Record<string, unknown>, consensusProfiles);
    if (request.profileName && !consensusProfiles[request.profileName]) {
      jsonResponse(res, 404, { error: `Consensus profile not found: ${request.profileName}` });
      return true;
    }

    const diagnostics = await diagnoseConsensusSelection(
      ctx,
      request,
      Boolean((body as Record<string, unknown>).dryRun),
    );
    jsonResponse(res, diagnostics.ok ? 200 : 400, diagnostics);
    return true;
  }

  // POST /api/consensus — start consensus task (async)
  if (method === 'POST' && url === '/api/consensus') {
    const body = await parseJsonBody(req);
    const request = resolveConsensusRequest(body as Record<string, unknown>, consensusProfiles);
    if (request.profileName && !consensusProfiles[request.profileName]) {
      jsonResponse(res, 404, { error: `Consensus profile not found: ${request.profileName}` });
      return true;
    }
    const { bots, problem, type, stakes, costCapUsd, maxRounds, chatId, callerBotName, synthesizerBot } = request;

    // Validation
    if (!Array.isArray(bots) || bots.length < 2) {
      jsonResponse(res, 400, { error: 'Missing or invalid `bots`: must be an array of ≥2 bot names' });
      return true;
    }
    if (bots.length > 4) {
      jsonResponse(res, 400, { error: 'Too many bots: N is capped at 4 for cost/latency reasons' });
      return true;
    }
    if (new Set(bots).size !== bots.length) {
      jsonResponse(res, 400, {
        error:
          'Duplicate bot names — must be distinct. Same-model dupes only produce sampling noise, not real epistemic diversity. Use cross-engine bots (e.g. claude + gemini + codex) for meaningful consensus.',
      });
      return true;
    }
    if (synthesizerBot && bots.includes(synthesizerBot)) {
      jsonResponse(res, 400, {
        error: '`synthesizerBot` must be synthesizer-only; do not include it in `bots` panelists',
      });
      return true;
    }
    if (!problem || typeof problem !== 'string') {
      jsonResponse(res, 400, { error: 'Missing `problem`' });
      return true;
    }
    if (!VALID_TYPES.includes(type)) {
      jsonResponse(res, 400, { error: `Invalid type: ${type}. Must be one of ${VALID_TYPES.join(', ')}` });
      return true;
    }
    if (!VALID_STAKES.includes(stakes)) {
      jsonResponse(res, 400, { error: `Invalid stakes: ${stakes}. Must be one of ${VALID_STAKES.join(', ')}` });
      return true;
    }

    const diagnostics = await diagnoseConsensusSelection(ctx, request, false);
    if (!diagnostics.ok) {
      jsonResponse(res, 400, { error: 'Consensus pre-flight failed', diagnostics });
      return true;
    }

    // Always async — consensus is 5-15 min wall time, sync would timeout
    const asyncTask = asyncTaskStore.create({
      botName: 'consensus-orchestrator',
      chatId: `consensus-task-${Date.now()}`,
      prompt: problem,
    });

    const input: ConsensusInput = {
      taskId: asyncTask.id,
      problem,
      type,
      stakes,
      bots,
      ...(costCapUsd !== undefined ? { costCapUsd } : {}),
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(chatId !== undefined ? { chatId } : {}),
      ...(callerBotName !== undefined ? { callerBotName } : {}),
      ...(synthesizerBot !== undefined ? { synthesizerBot } : {}),
    };

    logger.info(
      {
        taskId: asyncTask.id,
        bots,
        synthesizerBot,
        type,
        stakes,
        chatId,
        callerBotName,
        profileName: request.profileName,
        problemLength: problem.length,
      },
      'Consensus task started',
    );

    // Kick off async run
    (async () => {
      asyncTaskStore.update(asyncTask.id, { status: 'running' });
      try {
        const orchestrator = new ConsensusOrchestrator(registry, logger);
        const output = await orchestrator.run(input, (event, _state) => {
          logger.debug({ taskId: asyncTask.id, eventType: event.type, payload: event.payload }, 'Consensus event');
          // TODO: forward event to ws subscribers / Feishu card heartbeat
        });

        asyncTaskStore.update(asyncTask.id, {
          status: output.status === 'consensus_reached' ? 'completed' : 'failed',
          completedAt: Date.now(),
          result: {
            success: output.status === 'consensus_reached',
            responseText: JSON.stringify(output, null, 2),
            costUsd: output.costUsd,
            durationMs: output.durationMs,
          },
        });
      } catch (err: any) {
        logger.error({ err: err.message, taskId: asyncTask.id }, 'Consensus orchestrator threw');
        asyncTaskStore.update(asyncTask.id, {
          status: 'failed',
          completedAt: Date.now(),
          result: { success: false, responseText: '', error: err.message },
        });
      }
    })();

    jsonResponse(res, 202, {
      taskId: asyncTask.id,
      status: 'accepted',
      message: 'Consensus task accepted for async execution',
    });
    return true;
  }

  return false;
}

type DiagnosticStatus = 'pass' | 'warn' | 'fail';

interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  message: string;
}

async function diagnoseConsensusSelection(
  ctx: RouteContext,
  request: ResolvedConsensusRequest,
  dryRun: boolean,
): Promise<{
  ok: boolean;
  profileName?: string;
  panelists?: string[];
  synthesizerBot?: string;
  checks: DiagnosticCheck[];
}> {
  const { registry, logger } = ctx;
  const checks: DiagnosticCheck[] = [];
  const add = (name: string, status: DiagnosticStatus, message: string) => {
    checks.push({ name, status, message });
  };

  const bots = request.bots;
  if (!Array.isArray(bots) || bots.length < 2) {
    add('panelists', 'fail', 'Consensus requires at least 2 panelist bots');
  } else if (bots.length > 4) {
    add('panelists', 'fail', 'Consensus is capped at 4 panelist bots for cost/latency');
  } else if (new Set(bots).size !== bots.length) {
    add('panelists', 'fail', 'Panelist bot names must be distinct');
  } else {
    add('panelists', 'pass', `${bots.length} panelist bots configured`);
  }

  if (request.synthesizerBot && bots?.includes(request.synthesizerBot)) {
    add('synthesizer', 'fail', 'synthesizerBot must not also be a panelist');
  } else if (request.synthesizerBot) {
    add('synthesizer', 'pass', `${request.synthesizerBot} is synthesizer-only`);
  } else {
    add('synthesizer', 'warn', 'No synthesizer-only bot configured; first synthesis will come from panelist queue');
  }

  if (!VALID_TYPES.includes(request.type)) {
    add('type', 'fail', `Invalid type: ${request.type}`);
  }
  if (!VALID_STAKES.includes(request.stakes)) {
    add('stakes', 'fail', `Invalid stakes: ${request.stakes}`);
  }

  const namesToCheck = bots ? (request.synthesizerBot ? [...bots, request.synthesizerBot] : bots) : [];
  const missingBots = namesToCheck.filter((b) => !registry.get(b));
  if (missingBots.length > 0) {
    add('registry', 'fail', `Missing bot(s): ${missingBots.join(', ')}`);
  } else if (namesToCheck.length > 0) {
    add('registry', 'pass', `All ${namesToCheck.length} referenced bot(s) exist`);
  }

  const botInfos = registry.list();
  const engineCounts = new Map<string, string[]>();
  for (const name of namesToCheck) {
    const info = botInfos.find((b) => b.name === name);
    if (!info) continue;
    const key = `${info.engine}:${info.model ?? 'default'}`;
    const arr = engineCounts.get(key) ?? [];
    arr.push(name);
    engineCounts.set(key, arr);
  }
  for (const [engine, names] of engineCounts.entries()) {
    if (names.length > 1) {
      add(
        'engine-diversity',
        'warn',
        `${names.join(', ')} share ${engine}; useful for redundancy, weaker for epistemic diversity`,
      );
    }
  }

  if (request.chatId) {
    const notInChat: string[] = [];
    for (const botName of namesToCheck) {
      const bot = registry.get(botName);
      if (!bot?.feishuClient) continue; // non-Feishu bot, cannot verify here
      try {
        const resp: any = await bot.feishuClient.im.v1.chat.get({ path: { chat_id: request.chatId } });
        const d = resp?.data;
        if (!d || !d.chat_status || !d.chat_mode) notInChat.push(botName);
      } catch (err: any) {
        logger.warn({ botName, chatId: request.chatId, err: err?.message }, 'Consensus doctor: chats.get failed');
        notInChat.push(botName);
      }
    }
    if (notInChat.length > 0) {
      add('chat-membership', 'fail', `Bot(s) not in chat ${request.chatId}: ${notInChat.join(', ')}`);
    } else {
      add('chat-membership', 'pass', `Referenced Feishu bot(s) are visible in chat ${request.chatId}`);
    }
  } else {
    add('chat-membership', 'warn', 'No chatId provided; visible group membership was not checked');
  }

  if (request.chatId && !request.callerBotName) {
    add(
      'caller',
      'warn',
      'chatId was provided without callerBotName; consensus can run but cannot post visible dashboard cards',
    );
  }
  if (request.callerBotName && !registry.get(request.callerBotName)) {
    add('caller', 'fail', `callerBotName not found: ${request.callerBotName}`);
  }

  if (dryRun) {
    if (!request.chatId || !request.callerBotName) {
      add('dry-run-card', 'fail', 'dryRun requires chatId and callerBotName');
    } else {
      const caller = registry.get(request.callerBotName);
      if (!caller) {
        add('dry-run-card', 'fail', `callerBotName not found: ${request.callerBotName}`);
      } else {
        try {
          await caller.sender.sendTextNotice(
            request.chatId,
            'Consensus dry-run',
            [
              'This is a visibility check only.',
              `Profile: ${request.profileName ?? '(none)'}`,
              `Panelists: ${bots?.join(', ') ?? '(missing)'}`,
              request.synthesizerBot ? `Synthesizer-only: ${request.synthesizerBot}` : 'Synthesizer: participant queue',
            ].join('\n'),
            'turquoise',
          );
          add('dry-run-card', 'pass', 'Dry-run card posted successfully');
        } catch (err: any) {
          add('dry-run-card', 'fail', `Dry-run card failed: ${err?.message ?? 'unknown error'}`);
        }
      }
    }
  }

  return {
    ok: !checks.some((c) => c.status === 'fail'),
    ...(request.profileName ? { profileName: request.profileName } : {}),
    ...(bots ? { panelists: bots } : {}),
    ...(request.synthesizerBot ? { synthesizerBot: request.synthesizerBot } : {}),
    checks,
  };
}
