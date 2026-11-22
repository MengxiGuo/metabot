#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const question = process.argv.slice(2).join(' ').trim();
const botName = process.env.MB_REPLY_BOT;
const chatId = process.env.MB_REPLY_CHAT;
const token = process.env.MB_TASK_REPLY_TOKEN;
if (!question || question.length > 4000 || !botName || !chatId || !token) {
  console.error('mb ask: requires a running MetaBot task and a question of 1–4000 characters');
  process.exit(1);
}
const settings = {};
const envPath = path.join(process.env.METABOT_HOME || path.join(os.homedir(), 'metabot'), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^(API_PORT|API_SECRET|METABOT_URL)=(.*)$/);
    if (match) settings[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}
try {
  const url =
    process.env.METABOT_URL ||
    settings.METABOT_URL ||
    `http://localhost:${settings.API_PORT || process.env.API_PORT || 9100}`;
  const response = await fetch(url + '/api/ask', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.API_SECRET || process.env.API_SECRET || 'changeme'}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ botName, chatId, token, question }),
    signal: AbortSignal.timeout(31 * 60 * 1000),
  });
  const result = await response.json();
  console.log(JSON.stringify(result));
  if (!response.ok || result.success !== true) process.exitCode = 1;
} catch {
  console.error('mb ask: question channel failed or timed out; no authorization was granted');
  process.exitCode = 1;
}
