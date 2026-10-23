import { execFile } from 'node:child_process';
import * as path from 'node:path';

// Applied lessons: MEMORY-002, METABOT-CATCHUP-API-BYPASS-083,
// METABOT-CATCHUP-NL-083, METABOT-CATCHUP-SKILL-DISCOVERY-080,
// OPS-076, OPS-077, OPS-079, OPS-081, OPS-082.

const DEFAULT_DAYS = 7;
const DEFAULT_MAX_LINES = 80;
const MAX_DAYS = 365;
const MAX_LINES = 200;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 250_000;

export interface CatchupInvocation {
  days: number;
  maxLines: number;
  followup: string;
  originalText: string;
}

export interface CatchupRuntimeOptions {
  scriptPath?: string;
  pythonPath?: string;
  timeoutMs?: number;
}

export type CatchupRunner = (
  invocation: CatchupInvocation,
  chatId: string,
  botName: string,
) => Promise<string>;

export function buildCatchupArgs(
  scriptPath: string,
  invocation: CatchupInvocation,
  chatId: string,
  botName: string,
): string[] {
  return [
    scriptPath,
    '--chat-id', chatId,
    '--bot-name', botName,
    '--source', 'auto',
    '--mode', 'recent',
    '--mac-retention-days', '45',
    '--days', String(invocation.days),
    '--max-lines', String(invocation.maxLines),
    '--max-total-chars', '16000',
  ];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function parseCatchupArguments(
  remainder: string,
  originalText: string,
): CatchupInvocation {
  const tokens = remainder.trim().split(/\s+/).filter(Boolean);
  let days = DEFAULT_DAYS;
  let maxLines = DEFAULT_MAX_LINES;

  if (tokens[0] && /^\d+d$/i.test(tokens[0])) {
    days = clamp(Number.parseInt(tokens.shift()!.slice(0, -1), 10), 1, MAX_DAYS);
  } else if (tokens[0] && /^\d+$/.test(tokens[0])) {
    maxLines = clamp(Number.parseInt(tokens.shift()!, 10), 1, MAX_LINES);
  } else if (tokens[0]?.toLowerCase() === 'all') {
    // The canonical transcript already includes all senders in the current chat.
    tokens.shift();
  }

  return {
    days,
    maxLines,
    followup: tokens.join(' '),
    originalText,
  };
}

/**
 * Parse explicit commands plus bounded imperative natural-language forms.
 * Meta discussion such as "catch up skill 为什么不工作" must continue to the
 * model instead of triggering archive recovery.
 */
export function parseCatchupInvocation(text: string): CatchupInvocation | undefined {
  const originalText = text.trim();
  const slashMatch = originalText.match(/^\/(?:catchup|catch-up)(?:\s+([\s\S]*))?$/i);
  if (slashMatch) {
    return parseCatchupArguments(slashMatch[1] || '', originalText);
  }

  const naturalMatch = originalText.match(
    /^(?:(?:请|麻烦|帮我|你)\s*)?(?:先\s*)?(?:catch(?:\s+|-)?up|同步(?:一下)?(?:最近)?(?:的)?上下文|补(?:一下)?(?:最近)?(?:的)?上下文|追(?:一下)?(?:最近)?(?:的)?上下文|看看(?:最近)?(?:的)?群聊(?:记录)?)\s*(?:一下)?\s*(?:[，,；;。:：!！]\s*)?([\s\S]*)$/i,
  );
  if (!naturalMatch) return undefined;

  let remainder = (naturalMatch[1] || '').trim();
  if (/^(?:skill|技能|规则|为什么|为何|怎么|如何|是怎么回事|不会|不能)/i.test(remainder)) {
    return undefined;
  }
  remainder = remainder.replace(/^(?:然后|再)\s*/, '');
  return parseCatchupArguments(remainder, originalText);
}

export function runCatchupContext(
  invocation: CatchupInvocation,
  chatId: string,
  botName: string,
  options: CatchupRuntimeOptions = {},
): Promise<string> {
  const scriptPath = options.scriptPath
    || process.env.METABOT_CATCHUP_SCRIPT
    || path.join(
      process.env.METABOT_HOME || path.join(process.env.HOME || '/root', 'metabot'),
      'src',
      'skills',
      'catchup',
      'scripts',
      'catchup_context.py',
    );
  const pythonPath = options.pythonPath
    || process.env.METABOT_CATCHUP_PYTHON
    || '/root/anaconda3/envs/quatumtradingnew/bin/python';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = buildCatchupArgs(scriptPath, invocation, chatId, botName);

  return new Promise((resolve) => {
    execFile(
      pythonPath,
      args,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (!error && stdout.trim()) {
          resolve(stdout.trim());
          return;
        }
        const detail = (stderr || error?.message || 'catchup returned no output')
          .replace(/\s+/g, ' ')
          .slice(0, 2000);
        resolve([
          '# MetaBot Catchup Context',
          `chat_id: ${chatId}`,
          `bot_name: ${botName}`,
          'source: unavailable',
          `source_error: ${detail}`,
        ].join('\n'));
      },
    );
  });
}

export async function buildNativeCatchupPrompt(
  invocation: CatchupInvocation,
  chatId: string,
  botName: string,
  runner: CatchupRunner = runCatchupContext,
): Promise<string> {
  const context = await runner(invocation, chatId, botName);
  const followup = invocation.followup
    ? `After the catchup summary, continue this user request: ${invocation.followup}`
    : 'Summarize the recovered context concisely: current topic, decisions, pending work, and blockers.';

  return [
    '<catchup_runtime>',
    'MetaBot already executed the canonical per-date retention-tier workflow: SG exact files first, Mac for missing dates within 45 days, and 3060 only for older dates.',
    'A date inside the Mac 45-day window must never fall through to 3060. Treat recent_blocked_dates or blocked_recent_mac_unavailable as an incomplete result that requires Mac diagnosis.',
    'A tier zero file count is correct when no requested dates belong to that tier; do not call that an ordering failure.',
    'Do not rerun a catchup skill or substitute another archive path.',
    context,
    '</catchup_runtime>',
    '',
    `Original user command: ${invocation.originalText}`,
    followup,
  ].join('\n');
}
