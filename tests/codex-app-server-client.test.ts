import { describe, expect, it, vi } from 'vitest';
import {
  buildCodexAppServerArgs,
  CodexAppServerClient,
} from '../src/engines/codex/app-server-client.js';

describe('buildCodexAppServerArgs', () => {
  it('selects a configured bot profile before the app-server subcommand', () => {
    expect(buildCodexAppServerArgs({ profile: 'staging' })).toEqual([
      '--profile', 'staging',
      'app-server', '--listen', 'stdio://',
    ]);
  });

  it('adds long-context overrides only to the selected app-server process', () => {
    expect(buildCodexAppServerArgs({}, 'long')).toEqual([
      'app-server', '--listen', 'stdio://',
      '-c', 'model_context_window=1000000',
      '-c', 'model_auto_compact_token_limit=900000',
    ]);
    expect(buildCodexAppServerArgs({}, 'normal')).toEqual([
      'app-server', '--listen', 'stdio://',
    ]);
  });

  it('adds a process-local reasoning override for app-server', () => {
    expect(buildCodexAppServerArgs({}, 'normal', 'ultra')).toEqual([
      'app-server', '--listen', 'stdio://',
      '-c', 'model_reasoning_effort="ultra"',
    ]);
  });
});

function createClient(autoApproveBrowserOrigins: string[] = []) {
  const writes: string[] = [];
  const client = new CodexAppServerClient({
    botName: 'codex-test',
    codexConfig: { autoApproveBrowserOrigins },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any,
  });
  (client as any).child = {
    stdin: {
      write: (line: string) => {
        writes.push(line);
      },
    },
  };
  return { client, writes };
}

describe('CodexAppServerClient browser-origin elicitation', () => {
  it('auto-approves access_browser_origin only for configured origins', () => {
    const { client, writes } = createClient(['https://chatgpt.com']);

    (client as any).handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 'origin-approval-1',
      method: 'mcpServer/elicitation/request',
      params: {
        _meta: {
          tool_name: 'access_browser_origin',
          tool_params: { origin: 'https://chatgpt.com/deep-research' },
        },
      },
    }));

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toEqual({
      jsonrpc: '2.0',
      id: 'origin-approval-1',
      result: {
        action: 'accept',
        content: {},
      },
    });
  });

  it('does not auto-approve unlisted browser origins', () => {
    const { client, writes } = createClient(['https://chatgpt.com']);

    (client as any).handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'mcpServer/elicitation/request',
      params: {
        _meta: {
          tool_name: 'access_browser_origin',
          tool_params: { origin: 'https://example.com' },
        },
      },
    }));

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601 },
    });
  });
});

describe('CodexAppServerClient activity tracking', () => {
  it('refreshes idle-watchdog activity for untranslated JSON-RPC traffic', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000);
    const { client } = createClient();
    expect(client.getLastActivityAt()).toBe(1_000);

    now.mockReturnValue(9_000);
    (client as any).handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: { delta: 'internal progress that may not render' },
    }));

    expect(client.getLastActivityAt()).toBe(9_000);
    now.mockRestore();
  });
});
