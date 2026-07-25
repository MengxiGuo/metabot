import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '../src/engines/codex/app-server-client.js';

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
