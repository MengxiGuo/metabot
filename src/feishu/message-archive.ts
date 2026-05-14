import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from '../utils/logger.js';

// METABOT_HOME defaults to $HOME/metabot per the install convention.
// Override with METABOT_HOME env var if installed elsewhere.
const METABOT_HOME = process.env.METABOT_HOME || path.join(process.env.HOME || '/root', 'metabot');
const ARCHIVE_ROOT = process.env.METABOT_ARCHIVE_ROOT || path.join(METABOT_HOME, 'data', 'messages');

function todayUtc8(): string {
  const d = new Date();
  // CST = UTC+8
  const cst = new Date(d.getTime() + 8 * 3600 * 1000);
  return cst.toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

function logfileFor(chatId: string): string {
  const safeChat = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(ARCHIVE_ROOT, safeChat);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${todayUtc8()}.jsonl`);
}

function append(chatId: string, record: any, logger?: Logger): void {
  try {
    const fp = logfileFor(chatId);
    fs.appendFileSync(fp, JSON.stringify(record) + '\n', { encoding: 'utf-8' });
  } catch (err) {
    logger?.error({ err, chatId }, 'message-archive: append failed');
  }
}

export interface IncomingArchiveRecord {
  msgId?: string;
  chatId: string;
  userId?: string;
  type?: string;
  text?: string;
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
  parentId?: string;
  raw?: any;
}

export function archiveIncoming(rec: IncomingArchiveRecord, logger?: Logger): void {
  if (!rec.chatId) return;
  append(rec.chatId, {
    ts: nowIso(),
    dir: 'in',
    msg_id: rec.msgId,
    user_id: rec.userId,
    type: rec.type,
    text: rec.text,
    image_key: rec.imageKey,
    file_key: rec.fileKey,
    file_name: rec.fileName,
    parent_id: rec.parentId,
  }, logger);
}

// In-memory map: messageId → chatId. Populated by sendCard, consumed by updateCard
// archives so the streaming card updates land in the right chat folder.
// Reset on metabot restart (acceptable: ongoing message streams just lose 1-2 mins of correlation).
const msgIdToChatId = new Map<string, string>();
const MSG_MAP_MAX = 5000;
export function registerMsgChatMapping(messageId: string, chatId: string): void {
  if (!messageId || !chatId) return;
  msgIdToChatId.set(messageId, chatId);
  if (msgIdToChatId.size > MSG_MAP_MAX) {
    // simple cleanup: drop oldest 1000 (Map preserves insertion order)
    const drop = Array.from(msgIdToChatId.keys()).slice(0, 1000);
    drop.forEach(k => msgIdToChatId.delete(k));
  }
}
export function lookupChatIdByMsgId(messageId: string): string | undefined {
  return msgIdToChatId.get(messageId);
}

export interface OutgoingArchiveRecord {
  chatId: string;
  type: 'text' | 'card' | 'image' | 'file' | 'other';
  text?: string;
  card?: any;
  imageKey?: string;
  fileKey?: string;
  msgId?: string;
  isUpdate?: boolean;  // true = updateCard (card_update), false/undef = sendCard (card_initial)
}

export function archiveOutgoing(rec: OutgoingArchiveRecord, logger?: Logger): void {
  if (!rec.chatId) return;
  append(rec.chatId, {
    ts: nowIso(),
    dir: 'out',
    msg_id: rec.msgId,
    type: rec.type,
    update: rec.isUpdate ? 1 : undefined,
    text: rec.text,
    card_summary: rec.card ? extractCardText(rec.card) : undefined,
    card_full: rec.card ? extractCardFullText(rec.card) : undefined,
    image_key: rec.imageKey,
    file_key: rec.fileKey,
  }, logger);
}

function extractCardText(card: any): string {
  // Short summary: first ~500 chars
  try {
    return extractCardFullText(card).slice(0, 500);
  } catch { return '[card]'; }
}

function extractCardFullText(card: any): string {
  // Walk the entire card tree for any text-bearing nodes. Up to 8 levels deep.
  try {
    const texts: string[] = [];
    const walk = (n: any, depth: number) => {
      if (!n || depth > 8) return;
      if (typeof n === 'string') { texts.push(n); return; }
      if (Array.isArray(n)) { n.forEach(x => walk(x, depth + 1)); return; }
      if (typeof n === 'object') {
        // Common Feishu card text fields
        if (typeof n.text === 'string') texts.push(n.text);
        if (typeof n.content === 'string') texts.push(n.content);
        if (typeof n.lark_md === 'string') texts.push(n.lark_md);
        if (typeof n.title === 'string') texts.push(n.title);
        if (n.text && typeof n.text === 'object' && typeof n.text.content === 'string') texts.push(n.text.content);
        // Recurse into nested fields commonly used
        for (const key of ['elements', 'children', 'header', 'card', 'fields', 'columns', 'i18n_elements']) {
          if (n[key]) walk(n[key], depth + 1);
        }
      }
    };
    walk(card, 0);
    // Dedup consecutive duplicates (cards often have nested copies)
    const out: string[] = [];
    for (const t of texts) {
      const tt = String(t).trim();
      if (!tt) continue;
      if (out.length === 0 || out[out.length-1] !== tt) out.push(tt);
    }
    return out.join('\n').slice(0, 50000);  // 50KB cap per record
  } catch { return '[card-extract-err]'; }
}
