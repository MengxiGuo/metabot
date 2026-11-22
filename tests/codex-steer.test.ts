import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexExecutor } from '../src/engines/codex/executor.js';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture(mode = 'accept') {
  const dir = mkdtempSync(join(tmpdir(), 'metabot-steer-'));
  dirs.push(dir);
  const log = join(dir, 'rpc.jsonl');
  const executable = join(dir, 'fake-codex.cjs');
  writeFileSync(
    executable,
    `#!${process.execPath}
const readline = require('node:readline'), fs = require('node:fs');
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
 const reply=result=>send({id:m.id,result});
 if(m.method==='initialize')reply({});
 if(m.method==='account/rateLimits/read')reply({});
 if(m.method==='thread/goal/get')reply({goal:null});
 if(m.method==='thread/start')reply({thread:{id:'thread-1'}});
 if(m.method==='turn/start') {
   send({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});
   reply({turn:{id:'turn-1'}});
   send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'a',delta:'ready'}});
 }
 if(m.method==='turn/steer') {
  if(${JSON.stringify(mode)}==='reject')send({id:m.id,error:{code:-32000,message:'turn already completed'}});
  else reply({turnId:${JSON.stringify(mode === 'wrong' ? 'different-turn' : 'turn-1')}});
 }
});
`,
    { mode: 0o755 },
  );
  const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const executor = new CodexExecutor(
    {
      name: 'test',
      engine: 'codex',
      codex: { executable, transport: 'app-server' },
      claude: { defaultWorkingDirectory: dir },
    } as any,
    logger,
  );
  const handle = executor.startExecution({ prompt: 'initial task', cwd: dir, abortController: new AbortController() });
  return { handle, log };
}
async function ready(handle: ReturnType<CodexExecutor['startExecution']>) {
  for await (const message of handle.stream) {
    if (message.type === 'stream_event') return;
    if (message.type === 'result') throw new Error('ended before readiness');
  }
}
describe('active Codex turn steering over a real child-process RPC channel', () => {
  it('uses the same thread and expected turn with no second turn/start', async () => {
    const { handle, log } = fixture();
    try {
      await ready(handle);
      await handle.steer!('Only verify; do not send');
      const rpc = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s));
      expect(rpc.filter((r) => r.method === 'turn/start')).toHaveLength(1);
      expect(rpc.find((r) => r.method === 'turn/steer').params).toEqual({
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'Only verify; do not send' }],
      });
    } finally {
      handle.finish();
    }
    await expect(handle.steer!('too late')).rejects.toThrow('No active');
  });
  it.each(['reject', 'wrong'])('does not claim acceptance for %s', async (mode) => {
    const { handle } = fixture(mode);
    try {
      await ready(handle);
      await expect(handle.steer!('no')).rejects.toThrow();
    } finally {
      handle.finish();
    }
  });
  it('rejects inputs before initialization without buffering into a future task', async () => {
    const { handle } = fixture();
    try {
      await expect(handle.steer!('early')).rejects.toThrow('No active');
      await ready(handle);
    } finally {
      handle.finish();
    }
  });
});
