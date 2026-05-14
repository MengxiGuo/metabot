import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';
import { ConsensusOrchestrator, type ConsensusInput } from '../../orchestrator/consensus.js';
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

  // POST /api/consensus — start consensus task (async)
  if (method === 'POST' && url === '/api/consensus') {
    const body = await parseJsonBody(req);
    const bots = body.bots as string[] | undefined;
    const problem = body.problem as string | undefined;
    const type = (body.type ?? 'architectural') as ProblemType;
    const stakes = (body.stakes ?? 'medium') as Stakes;
    const costCapUsd = typeof body.costCapUsd === 'number' ? body.costCapUsd : undefined;
    const maxRounds = typeof body.maxRounds === 'number' ? body.maxRounds : undefined;

    // Validation
    if (!Array.isArray(bots) || bots.length < 2) {
      jsonResponse(res, 400, { error: 'Missing or invalid `bots`: must be an array of ≥2 bot names' });
      return true;
    }
    if (bots.length > 4) {
      jsonResponse(res, 400, { error: 'Too many bots: N is capped at 4 for cost/latency reasons' });
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

    // Pre-flight: ensure all bots exist in registry
    const missingBots = bots.filter((b) => !registry.get(b));
    if (missingBots.length > 0) {
      jsonResponse(res, 404, { error: `Bots not found in registry: ${missingBots.join(', ')}` });
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
    };

    logger.info({ taskId: asyncTask.id, bots, type, stakes, problemLength: problem.length }, 'Consensus task started');

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
