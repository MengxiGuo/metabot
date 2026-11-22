import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveAntigravityProfile } from './historical-error.js';

export interface AntigravityContextUsage {
  stepIndex: number;
  promptTokens: number;
  completionTokens: number;
}

/** Last single model request, not the CLI's cumulative conversation usage. */
export async function readAntigravityContextUsage(
  runner: string,
  conversationId: string | undefined,
  currentUserStep?: number,
  lastStep?: number,
): Promise<AntigravityContextUsage | undefined> {
  if (!conversationId || !/^[a-f0-9-]{36}$/i.test(conversationId)) return undefined;
  try {
    const profile = await resolveAntigravityProfile(runner);
    if (!profile) return undefined;
    const logs = join(profile, 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs');
    // Compact exports truncate content, but preserve these numeric usage fields.
    const file = await open(join(logs, 'transcript.jsonl'), 'r').catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      return open(join(logs, 'transcript_full.jsonl'), 'r');
    });
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 64 * 1024 * 1024) return undefined;
      const stream = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      const timer = setTimeout(() => stream.destroy(new Error('Usage read timeout')), 2000);
      let selected: AntigravityContextUsage | undefined;
      let priorIndex = -1;
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          if (Buffer.byteLength(line, 'utf8') > 4 * 1024 * 1024) return undefined;
          const row = JSON.parse(line);
          if (!Number.isInteger(row.step_index) || row.step_index <= priorIndex) return undefined;
          priorIndex = row.step_index;
          // Do not accidentally use another invocation's concurrently appended usage.
          if (Number.isInteger(lastStep) && row.step_index > lastStep!) return undefined;
          if (Number.isInteger(currentUserStep)) {
            if (row.step_index <= currentUserStep!) continue;
            if (row.type === 'USER_INPUT') return undefined;
          }
          if (row.type !== 'PLANNER_RESPONSE' || row.source !== 'MODEL' || !Number.isFinite(row.input_tokens)) continue;
          const cached = Number.isFinite(row.cache_read_tokens) ? row.cache_read_tokens : 0;
          const completionTokens = Number.isFinite(row.output_tokens) ? row.output_tokens : 0;
          const promptTokens = row.input_tokens + cached;
          if (row.input_tokens < 0 || cached < 0 || completionTokens < 0 || !Number.isFinite(promptTokens))
            return undefined;
          selected = { stepIndex: row.step_index, promptTokens, completionTokens };
        }
        const after = await file.stat();
        return before.size === after.size && before.mtimeMs === after.mtimeMs ? selected : undefined;
      } finally {
        clearTimeout(timer);
        lines.close();
        stream.destroy();
      }
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}
