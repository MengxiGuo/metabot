import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBridge } from '../src/bridge/message-bridge.js';
import { SessionManager } from '../src/engines/claude/session-manager.js';
import { consensusControl } from '../src/orchestrator/consensus-control.js';
const logger={info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()} as any;
logger.child=()=>logger;
let dir:string, oldStore:string|undefined, bridge:MessageBridge;
beforeEach(()=>{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'consensus-bridge-'));oldStore=process.env.SESSION_STORE_DIR;process.env.SESSION_STORE_DIR=dir;
 bridge=new MessageBridge({name:'test',engine:'antigravity',claude:{defaultWorkingDirectory:dir,outputsBaseDir:path.join(dir,'outputs')},antigravity:{model:'gemini-4-argon-low'}} as any,logger,{sendTextNotice:vi.fn(),sendCard:vi.fn(),updateCard:vi.fn()} as any,'http://127.0.0.1:1');
 // File delivery is unrelated to execution cancellation; never send any external messages.
 (bridge as any).outputHandler={sendOutputFiles:vi.fn()};
});
afterEach(()=>{
 consensusControl.finish('bridge-run');bridge.getSessionManager().destroy();vi.restoreAllMocks();
 if(oldStore===undefined)delete process.env.SESSION_STORE_DIR;else process.env.SESSION_STORE_DIR=oldStore;
 fs.rmSync(dir,{recursive:true,force:true});
});
function stubExecution(implementation?:any) {
 const starts:any[]=[];
 const startExecution=vi.fn((options:any)=>{
   let release!:()=>void; const waiting=new Promise<void>(r=>{release=r;});
   const finish=vi.fn(()=>release()); starts.push({options,finish});
   return {stream:(async function*(){if(implementation){yield* implementation(options);return;} await waiting;})(),finish,resolveQuestion:vi.fn()};
 });
 vi.spyOn(bridge as any,'executorForChat').mockReturnValue({startExecution});return {starts,startExecution};
}
describe('consensus through the real message bridge',()=>{
 it('abort reaches the running execution and settles without a retry',async()=>{
  const stub=stubExecution();const c=new AbortController();
  const run=bridge.executeApiTask({prompt:'test',chatId:'isolated',signal:c.signal});
  expect(stub.starts).toHaveLength(1);c.abort();const result=await run;
  expect(result.success).toBe(false);expect(stub.starts[0].options.abortController.signal.aborted).toBe(true);
  expect(stub.starts[0].finish).toHaveBeenCalled();expect(stub.starts).toHaveLength(1);expect(bridge.isBusy('isolated')).toBe(false);
 });
 it('pre-aborted work does not spawn',async()=>{
  const stub=stubExecution();const c=new AbortController();c.abort();
  expect((await bridge.executeApiTask({prompt:'test',chatId:'isolated',signal:c.signal})).success).toBe(false);expect(stub.starts).toEqual([]);
 });
 it('abort suppresses recovery even when the stream throws a stale-session error',async()=>{
  const c=new AbortController();const stub=stubExecution(async function*(){yield* [];c.abort();throw new Error('Conversation not found');});
  bridge.getSessionManager().setSessionId('isolated','old');
  const result=await bridge.executeApiTask({prompt:'test',chatId:'isolated',signal:c.signal});
  expect(result.success).toBe(false);expect(stub.starts).toHaveLength(1);
 });
 it('backup/high and model reach the executor with a fresh conversation',async()=>{
  const manager=bridge.getSessionManager();manager.setAntigravityAccount('source','backup');manager.setAntigravityReasoningEffort('source','high');manager.setSessionModel('source','gemini-4-argon-high');manager.setSessionId('source','group-history');
  const stub=stubExecution();const c=new AbortController();const run=bridge.executeApiTask({prompt:'test',chatId:'isolated',preferenceSourceChatId:'source',signal:c.signal});
  expect(stub.starts[0].options).toMatchObject({antigravityAccount:'backup',antigravityReasoningEffort:'high',model:'gemini-4-argon-high',sessionId:undefined});
  c.abort();await run;expect(manager.getSession('source').sessionId).toBe('group-history');
  manager.setAntigravityAccount('isolated','primary');manager.inheritExecutionPreferences('source','isolated');expect(manager.getSession('isolated').antigravityAccount).toBe('primary');
  const reloaded=new SessionManager(dir,logger,'test');try{expect(reloaded.getSession('isolated').antigravityAccount).toBe('primary');}finally{reloaded.destroy();}
 });
 it('inheritance persistence failure fails closed and leaves source intact',async()=>{
  const manager=bridge.getSessionManager();manager.setAntigravityAccount('source','backup');
  vi.spyOn(manager as any,'saveToDisk').mockReturnValue(false);const stub=stubExecution();
  await expect(bridge.executeApiTask({prompt:'test',chatId:'isolated',preferenceSourceChatId:'source'})).rejects.toThrow('persist');
  expect(stub.starts).toEqual([]);expect(manager.getSession('source').antigravityAccount).toBe('backup');
 });
 it('plain stop through handleMessage reaches a consensus participant',async()=>{
  const signal=consensusControl.register('bridge-run','group',['test']);const stub=stubExecution();
  const run=bridge.executeApiTask({prompt:'test',chatId:'isolated',signal});
  await bridge.handleMessage({text:'stop',chatId:'group',userId:'u',messageId:'m',chatType:'p2p'} as any);
  expect(signal.aborted).toBe(true);expect((await run).success).toBe(false);expect(stub.starts).toHaveLength(1);
 });
});
