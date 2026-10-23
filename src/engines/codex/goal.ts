import type { CodexBotConfig } from '../../config.js';
import type { Logger } from '../../utils/logger.js';
import { CodexAppServerClient } from './app-server-client.js';

export type CodexGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export interface CodexGoal {
  threadId: string;
  objective: string;
  status: CodexGoalStatus;
  tokenBudget?: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

function buildThreadParams(cwd: string, model: string | undefined, cfg: CodexBotConfig): Record<string, unknown> {
  return {
    cwd,
    ...(model ? { model } : {}),
    approvalPolicy: cfg.dangerouslyBypassApprovalsAndSandbox ? 'never' : (cfg.approvalPolicy ?? 'never'),
    sandbox: cfg.dangerouslyBypassApprovalsAndSandbox ? 'danger-full-access' : (cfg.sandbox ?? 'workspace-write'),
  };
}

export async function getCodexGoal(opts: {
  codexConfig: CodexBotConfig;
  logger: Logger;
  botName: string;
  threadId: string;
}): Promise<CodexGoal | null> {
  const client = new CodexAppServerClient({
    codexConfig: opts.codexConfig,
    logger: opts.logger,
    botName: opts.botName,
  });
  try {
    await client.start();
    const result = await client.request<{ goal?: CodexGoal | null }>('thread/goal/get', {
      threadId: opts.threadId,
    }, 15_000);
    return result.goal ?? null;
  } finally {
    client.close();
  }
}

export async function setCodexGoal(opts: {
  codexConfig: CodexBotConfig;
  logger: Logger;
  botName: string;
  threadId: string;
  objective?: string;
  status?: CodexGoalStatus;
  tokenBudget?: number | null;
}): Promise<CodexGoal | null> {
  const client = new CodexAppServerClient({
    codexConfig: opts.codexConfig,
    logger: opts.logger,
    botName: opts.botName,
  });
  try {
    await client.start();
    await client.request('thread/goal/set', {
      threadId: opts.threadId,
      ...(opts.objective !== undefined ? { objective: opts.objective } : {}),
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
    }, 15_000);
    const result = await client.request<{ goal?: CodexGoal | null }>('thread/goal/get', {
      threadId: opts.threadId,
    }, 15_000);
    return result.goal ?? null;
  } finally {
    client.close();
  }
}

export async function setCodexGoalForSession(opts: {
  codexConfig: CodexBotConfig;
  logger: Logger;
  botName: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  objective: string;
  status?: CodexGoalStatus;
  tokenBudget?: number | null;
}): Promise<{ threadId: string; created: boolean; goal: CodexGoal | null }> {
  const client = new CodexAppServerClient({
    codexConfig: opts.codexConfig,
    logger: opts.logger,
    botName: opts.botName,
  });
  try {
    await client.start();
    const params = buildThreadParams(opts.cwd, opts.model, opts.codexConfig);
    let threadId = opts.sessionId;
    let created = false;
    if (threadId) {
      try {
        await client.request('thread/resume', {
          ...params,
          threadId,
          excludeTurns: true,
        }, 30_000);
      } catch (err) {
        opts.logger.warn({ err, threadId }, 'Codex goal thread resume failed; starting a fresh thread');
        threadId = undefined;
      }
    }

    if (!threadId) {
      const started = await client.request<{ thread: { id: string } }>('thread/start', params, 30_000);
      threadId = started.thread.id;
      created = true;
    }

    await client.request('thread/goal/set', {
      threadId,
      objective: opts.objective,
      status: opts.status ?? 'active',
      ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
    }, 15_000);
    const result = await client.request<{ goal?: CodexGoal | null }>('thread/goal/get', { threadId }, 15_000);
    return { threadId, created, goal: result.goal ?? null };
  } finally {
    client.close();
  }
}

export async function clearCodexGoal(opts: {
  codexConfig: CodexBotConfig;
  logger: Logger;
  botName: string;
  threadId: string;
}): Promise<void> {
  const client = new CodexAppServerClient({
    codexConfig: opts.codexConfig,
    logger: opts.logger,
    botName: opts.botName,
  });
  try {
    await client.start();
    await client.request('thread/goal/clear', { threadId: opts.threadId }, 15_000);
  } finally {
    client.close();
  }
}
