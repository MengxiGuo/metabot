/** Read-only local preview. Never sends messages, changes accounts or starts a model turn. */
import { readFile } from 'node:fs/promises';
import { buildAccountDashboard } from '../src/engines/antigravity/account-dashboard.js';
import type { AntigravityBotConfig } from '../src/config.js';

const configPath = process.argv[2] ?? './bots.json';
const botName = process.argv[3] ?? 'antigravity-gemini';
const document = JSON.parse(await readFile(configPath, 'utf8')) as {
  feishuBots?: Array<{ name: string; antigravity?: AntigravityBotConfig }>;
};
const bot = document.feishuBots?.find(candidate => candidate.name === botName);
if (!bot?.antigravity) throw new Error('Requested bot has no Antigravity configuration');
console.log('Antigravity 账号看板 · 北京时间（UTC+8）');
console.log('本地预览：当前标记使用 bot 配置默认值，群内 /account 使用该群实际选择。\n');
for (const section of await buildAccountDashboard(bot.antigravity, bot.antigravity.defaultAccount ?? '_default_')) {
  console.log(section + '\n');
}
