// Re-export shared types so existing imports from this module continue to work
export type {
  CardStatus,
  ToolCall,
  PendingQuestion,
  CardState,
  BackgroundEvent,
  BackgroundTaskStatus,
} from '../types.js';
import type { CardState, CardStatus } from '../types.js';

// Feishu content audit (code 230028) blocks messages containing raw email addresses.
// Replace "@domain.com" with "[at]domain.com" to pass the audit.
const EMAIL_RE = /([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

function sanitizeForFeishu(text: string): string {
  return text.replace(EMAIL_RE, '$1[at]$2');
}

const STATUS_CONFIG: Record<CardStatus, { color: string; title: string; icon: string }> = {
  thinking: { color: 'blue', title: 'Thinking...', icon: '🔵' },
  running: { color: 'blue', title: 'Running...', icon: '🔵' },
  complete: { color: 'green', title: 'Complete', icon: '🟢' },
  error: { color: 'red', title: 'Error', icon: '🔴' },
  waiting_for_input: { color: 'yellow', title: 'Waiting for Input', icon: '🟡' },
};

const BG_ICON: Record<'running' | 'completed' | 'failed' | 'stopped', string> = {
  running: '⏳',
  completed: '✅',
  failed: '❌',
  stopped: '⏹️',
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

// Feishu card patch API limit is 30KB total. Reserve ~5KB for card structure
// (header, tool calls, JSON overhead). Use byte length since CJK chars = 3 bytes in UTF-8.
const MAX_CONTENT_BYTES = 24000;

function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf-8');
}

function truncateContent(text: string): string {
  if (byteLength(text) <= MAX_CONTENT_BYTES) return text;
  const halfBudget = Math.floor(MAX_CONTENT_BYTES / 2) - 100;
  let headEnd = text.length;
  for (let i = Math.min(text.length, Math.floor(halfBudget / 2)); i >= 0; i--) {
    if (byteLength(text.slice(0, i)) <= halfBudget) {
      headEnd = i;
      break;
    }
  }
  let tailStart = 0;
  for (let i = Math.max(0, text.length - Math.floor(halfBudget / 2)); i <= text.length; i++) {
    if (byteLength(text.slice(i)) <= halfBudget) {
      tailStart = i;
      break;
    }
  }
  return (
    text.slice(0, headEnd) +
    '\n\n... (内容过长，中间部分已省略) ...\n\n' +
    text.slice(tailStart)
  );
}

// Marker the assistant writes to delimit its final conclusion from the preceding
// process/analysis, e.g. "━━━━━ 🎯 结论 ━━━━━". Matched loosely (≥3 heavy bars,
// the word 结论 somewhere on the line).
const CONCLUSION_MARKER_RE = /\n*[ \t]*━{3,}[^\n]*结论[^\n]*━{3,}[ \t]*\n*/;

/**
 * Split a turn's text into a "process" part and a "conclusion" part so the bridge
 * can render them as two separate Feishu cards (user request: jump to the bottom
 * card for the verdict, scroll up to the process card for the working).
 *
 * Priority:
 *   1. An explicit conclusion marker the assistant wrote (semantic, precise).
 *   2. Structural fallback: the LAST top-level text block is the conclusion and
 *      everything before it is process (the model's natural explain→tool→sign-off).
 * Returns null when there is nothing meaningful to separate (single short answer).
 */
export function splitProcessConclusion(
  segments: string[],
): { process: string; conclusion: string } | null {
  const clean = segments.map((s) => (s || '').trim()).filter(Boolean);
  if (clean.length === 0) return null;
  const full = clean.join('\n\n');

  const m = full.match(CONCLUSION_MARKER_RE);
  if (m && m.index !== undefined) {
    const process = full.slice(0, m.index).trim();
    const conclusion = full.slice(m.index + m[0].length).trim();
    if (process && conclusion) return { process, conclusion };
  }

  if (clean.length >= 2) {
    const conclusion = clean[clean.length - 1];
    const process = clean.slice(0, -1).join('\n\n').trim();
    if (process && conclusion) return { process, conclusion };
  }
  return null;
}

export function buildCard(state: CardState): string {
  const config = STATUS_CONFIG[state.status];
  const elements: unknown[] = [];

  // Tool calls section
  if (state.toolCalls.length > 0) {
    const toolLines = state.toolCalls.map((t) => {
      const icon = t.status === 'running' ? '⏳' : '✅';
      return `${icon} **${t.name}** ${t.detail}`;
    });
    elements.push({
      tag: 'markdown',
      content: toolLines.join('\n'),
    });
    elements.push({ tag: 'hr' });
  }

  // Background tasks (Monitor, etc.) — show live stdout events / final status
  if (state.backgroundEvents && state.backgroundEvents.length > 0) {
    const lines = state.backgroundEvents.map((ev) => {
      const icon = BG_ICON[ev.status];
      const shortId = ev.taskId.slice(0, 6);
      const desc = truncate(ev.description, 60);
      const last = ev.lastEvent ? ` — _${truncate(ev.lastEvent, 140)}_` : '';
      return `${icon} **${desc}** \`${shortId}\`${last}`;
    });
    elements.push({
      tag: 'markdown',
      content: '📡 **Background**\n' + lines.join('\n'),
    });
    elements.push({ tag: 'hr' });
  }

  // Response content
  if (state.responseText) {
    elements.push({
      tag: 'markdown',
      content: truncateContent(state.responseText),
    });
  } else if (state.status === 'thinking') {
    elements.push({
      tag: 'markdown',
      content: '_Thinking..._',
    });
  }

  // Pending question section — interactive buttons + text-fallback hint
  if (state.pendingQuestion) {
    elements.push({ tag: 'hr' });
    state.pendingQuestion.questions.forEach((q, qi) => {
      // Question prompt
      const descLines = q.options.map(
        (opt, i) => `**${i + 1}.** ${opt.label} — _${opt.description}_`,
      );
      elements.push({
        tag: 'markdown',
        content: [`**[${q.header}] ${q.question}**`, '', ...descLines].join('\n'),
      });
      // Interactive buttons: one per option + an explicit "Other" button
      const actions = q.options.map((opt, oi) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: `${oi + 1}. ${opt.label}` },
        type: 'primary',
        value: {
          action: 'answer_question',
          toolUseId: state.pendingQuestion!.toolUseId,
          questionIndex: qi,
          optionIndex: oi,
        },
      }));
      elements.push({
        tag: 'action',
        actions,
      });
    });
    elements.push({
      tag: 'markdown',
      content: '_点击按钮选择，或直接输入自定义答案_',
    });
  }

  // Error message
  if (state.errorMessage) {
    elements.push({
      tag: 'markdown',
      content: `**Error:** ${state.errorMessage}`,
    });
  }

  // Stats note — show context usage during all states, full stats on complete/error
  {
    const parts: string[] = [];
    if (state.totalTokens && state.contextWindow) {
      const pct = Math.round((state.totalTokens / state.contextWindow) * 100);
      const tokensK = state.totalTokens >= 1000
        ? `${(state.totalTokens / 1000).toFixed(1)}k`
        : `${state.totalTokens}`;
      const ctxK = `${Math.round(state.contextWindow / 1000)}k`;
      parts.push(`ctx: ${tokensK}/${ctxK} (${pct}%)`);
    }
    if (state.status === 'complete' || state.status === 'error') {
      // For Gemini (flat-tier AI Pro subscription), the $-cost slot is
      // always $0.00 (no per-call cost). Replace with `quota: X% used (还有
      // Yh reset)` when quotaInfo is present. Other engines fall back to
      // the $-cost display.
      if (state.quotaInfo) {
        const { usedPct, hoursToReset, secondary } = state.quotaInfo;
        const resetStr = hoursToReset >= 1
          ? `还有 ${hoursToReset.toFixed(1)}h reset`
          : hoursToReset > 0
            ? `还有 ${Math.round(hoursToReset * 60)}min reset`
            : '即将 reset';
        if (secondary) {
          // Codex: dual window (5h primary + weekly secondary).
          const shortReset = (h: number): string =>
            h >= 24 ? `${(h / 24).toFixed(1)}d` : h >= 1 ? `${h.toFixed(1)}h` : h > 0 ? `${Math.round(h * 60)}min` : '即将';
          parts.push(
            `quota: 5h ${usedPct.toFixed(1)}% (${shortReset(hoursToReset)}) · 周 ${secondary.usedPct.toFixed(1)}% (${shortReset(secondary.hoursToReset)})`,
          );
        } else {
          parts.push(`quota: ${usedPct.toFixed(1)}% used (${resetStr})`);
        }
      } else if (state.sessionCostUsd != null) {
        parts.push(`$${state.sessionCostUsd.toFixed(2)}`);
      }
      if (state.model) {
        // Strip the claude- prefix (claude-opus-4-7 → opus-4-7) but keep the
        // full Kimi model name since e.g. `for-coding` loses too much context.
        parts.push(state.model.replace(/^claude-/, ''));
      }
      if (state.durationMs !== undefined) {
        parts.push(`${(state.durationMs / 1000).toFixed(1)}s`);
      }
    }
    if (parts.length > 0) {
      elements.push({
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: parts.join(' | '),
          },
        ],
      });
    }
  }

  const card = {
    // update_multi lets us re-render the same card after an action click
    // without hitting Feishu error 108002 ("card has already been updated").
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: config.color,
      title: {
        content: state.cardLabel ? `${config.icon} ${state.cardLabel}` : `${config.icon} ${config.title}`,
        tag: 'plain_text',
      },
    },
    elements,
  };

  let json = JSON.stringify(card);

  // Final safety check: Feishu patch API hard limit is 30KB
  const MAX_CARD_BYTES = 30000;
  if (byteLength(json) > MAX_CARD_BYTES) {
    // Aggressively truncate responseText and rebuild
    const shortened = state.responseText
      ? state.responseText.slice(0, 2000) + '\n\n... (内容过长已截断，请查看 PDF) ...'
      : '';
    const fallbackElements: unknown[] = [];
    if (state.toolCalls.length > 0) {
      const toolLines = state.toolCalls.map((t) => {
        const icon = t.status === 'running' ? '⏳' : '✅';
        return `${icon} **${t.name}**`;
      });
      fallbackElements.push({ tag: 'markdown', content: toolLines.join('\n') });
      fallbackElements.push({ tag: 'hr' });
    }
    if (shortened) {
      fallbackElements.push({ tag: 'markdown', content: shortened });
    }
    const fallbackCard = {
      config: { wide_screen_mode: true },
      header: card.header,
      elements: fallbackElements,
    };
    json = JSON.stringify(fallbackCard);
  }

  // Sanitize email addresses to avoid Feishu audit rejection (code 230028)
  return sanitizeForFeishu(json);
}

export function buildHelpCard(): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: {
        content: '📖 Help',
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          '**Available Commands:**',
          '`/reset` - Clear session, start fresh',
          '`/stop` - Abort current running task',
          '`/status` - Show current session info',
          '`/memory` - Memory document commands',
          '`/help` - Show this help message',
          '',
          '**Usage:**',
          'Send any text message to start a conversation with Claude Code.',
          'Each chat has an independent session with a fixed working directory.',
          '',
          '**Memory Commands:**',
          '`/memory list` - Show folder tree',
          '`/memory search <query>` - Search documents',
          '`/memory status` - Server health check',
        ].join('\n'),
      },
    ],
  };
  return JSON.stringify(card);
}

export function buildStatusCard(
  userId: string,
  workingDirectory: string,
  sessionId: string | undefined,
  isRunning: boolean,
): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: {
        content: '📊 Status',
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**User:** \`${userId}\``,
          `**Working Directory:** \`${workingDirectory}\``,
          `**Session:** ${sessionId ? `\`${sessionId.slice(0, 8)}...\`` : '_None_'}`,
          `**Running:** ${isRunning ? 'Yes ⏳' : 'No'}`,
        ].join('\n'),
      },
    ],
  };
  return JSON.stringify(card);
}

export function buildTextCard(title: string, content: string, color: string = 'blue'): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: color,
      title: {
        content: title,
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
    ],
  };
  return JSON.stringify(card);
}
