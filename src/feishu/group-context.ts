import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from '../utils/logger.js';

const METABOT_HOME = process.env.METABOT_HOME || path.join(process.env.HOME || '/root', 'metabot');
const ARCHIVE_ROOT = process.env.METABOT_ARCHIVE_ROOT || path.join(METABOT_HOME, 'data', 'messages');

const MAX_LINES = 50;          // hard cap on injected entries
const FRESH_BOT_LINES = 30;    // when bot has never spoken, take last N
const MAX_CHARS_PER_ENTRY = 400;
const MAX_TOTAL_CHARS = 8000;

function safeChatId(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function cstDateStr(d: Date): string {
  const cst = new Date(d.getTime() + 8 * 3600 * 1000);
  return cst.toISOString().slice(0, 10);
}

function listJsonlFiles(chatId: string, maxDays = 7): string[] {
  const dir = path.join(ARCHIVE_ROOT, safeChatId(chatId));
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  const now = Date.now();
  for (let i = 0; i < maxDays; i++) {
    const d = new Date(now - i * 86400 * 1000);
    const fp = path.join(dir, `${cstDateStr(d)}.jsonl`);
    if (fs.existsSync(fp)) files.push(fp);
  }
  return files.reverse(); // oldest first
}

interface ArchiveRecord {
  ts: string;
  dir: 'in' | 'out';
  bot_name?: string;
  user_id?: string;
  type?: string;
  text?: string;
  card_summary?: string;
  card_full?: string;
  update?: number;
  msg_id?: string;
}

function loadRecords(chatId: string): ArchiveRecord[] {
  const out: ArchiveRecord[] = [];
  for (const fp of listJsonlFiles(chatId)) {
    let content: string;
    try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as ArchiveRecord); } catch {}
    }
  }
  return out;
}

/**
 * Collapse multi-frame streaming card updates: each bot reply produces 1 initial
 * card + many updateCard frames, all sharing one msg_id. Keep only the last frame
 * per msg_id (the final card state, with real reply text).
 */
function collapseOut(records: ArchiveRecord[]): ArchiveRecord[] {
  const byMsg = new Map<string, ArchiveRecord>();
  const out: ArchiveRecord[] = [];
  for (const r of records) {
    if (r.dir === 'out' && r.msg_id) {
      byMsg.set(r.msg_id, r); // overwrite — keep most recent frame
    } else {
      out.push(r);
    }
  }
  // Merge: incoming records + dedup'd outgoing, sorted by ts
  const merged = out.concat(Array.from(byMsg.values()));
  merged.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return merged;
}

const NOISE_PATTERNS = [
  /^_Thinking\.\.\._$/,
  /^✅ Done \(/,
];

function isMeaningful(r: ArchiveRecord): boolean {
  const body = (r.text || r.card_summary || r.card_full || '').trim();
  if (!body && r.type !== 'image' && r.type !== 'file') return false;
  if (r.dir === 'out' && NOISE_PATTERNS.some(p => p.test(body))) return false;
  return true;
}

function renderEntry(r: ArchiveRecord): string | null {
  const ts = r.ts ? r.ts.slice(11, 16) : '??:??';
  let body = (r.text || r.card_summary || r.card_full || '').trim();
  if (!body) {
    if (r.type === 'image') body = '[image]';
    else if (r.type === 'file') body = '[file]';
    else return null;
  }
  if (body.length > MAX_CHARS_PER_ENTRY) body = body.slice(0, MAX_CHARS_PER_ENTRY) + '…';
  const speaker = r.dir === 'in'
    ? `user${r.user_id ? ' ' + r.user_id.slice(-6) : ''}`
    : `bot ${r.bot_name || 'unknown'}`;
  return `[${ts} ${speaker}]: ${body}`;
}

/**
 * Build incremental group history for `botName` in `chatId`.
 * Returns a `<group_history>` block, or '' if nothing to inject.
 *
 * Rules:
 *  - Finds the timestamp of botName's last 'out' entry (t_last_self).
 *  - Returns entries strictly after t_last_self (incremental).
 *  - If botName has never spoken in this chat → returns last N entries (cold start).
 *  - If increment is empty (same bot just spoke + nothing else happened) → returns ''.
 *  - The current user's incoming message that triggered this turn is NOT yet in
 *    the archive (archiveIncoming happens after this fires in some paths), so
 *    we don't worry about excluding it; in paths where it is already archived,
 *    the caller's own prompt will simply repeat — harmless.
 */
export function buildIncrementalContext(
  chatId: string,
  botName: string,
  logger?: Logger,
): string {
  try {
    const records = collapseOut(loadRecords(chatId)).filter(isMeaningful);
    if (records.length === 0) return '';

    // Find t_last_self: most recent dir='out' && bot_name===botName
    let tLastSelf: string | undefined;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.dir === 'out' && r.bot_name === botName) {
        tLastSelf = r.ts;
        break;
      }
    }

    let pick: ArchiveRecord[];
    if (!tLastSelf) {
      // cold start — bot has never spoken in this chat
      pick = records.slice(-FRESH_BOT_LINES);
    } else {
      pick = records.filter(r => r.ts > tLastSelf!);
    }

    if (pick.length === 0) return '';
    if (pick.length > MAX_LINES) pick = pick.slice(-MAX_LINES);

    const rendered: string[] = [];
    let total = 0;
    for (const r of pick) {
      const line = renderEntry(r);
      if (!line) continue;
      if (total + line.length > MAX_TOTAL_CHARS) break;
      rendered.push(line);
      total += line.length + 1;
    }
    if (rendered.length === 0) return '';

    return [
      '<group_history>',
      '(以下是飞书群里最近其他成员/Bot 的发言，作为你处理本次请求的参考上下文。若与本轮无关可忽略。)',
      ...rendered,
      '</group_history>',
      '',
    ].join('\n');
  } catch (err) {
    logger?.warn({ err, chatId, botName }, 'buildIncrementalContext failed');
    return '';
  }
}
