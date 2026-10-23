import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsensusControl, consensusControl } from '../src/orchestrator/consensus-control.js';
import { ConsensusOrchestrator } from '../src/orchestrator/consensus.js';
import { CommandHandler } from '../src/bridge/command-handler.js';
import { AsyncTaskStore } from '../src/api/async-task-store.js';
import { handleConsensusRoutes } from '../src/api/routes/consensus-routes.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const input = { taskId: 'test-run', problem: 'Review the design', bots: ['a','b'], type: 'architectural' as const, stakes: 'low' as const };
afterEach(() => { for (const id of ['test-run','other-run']) consensusControl.finish(id); vi.restoreAllMocks(); });

function fixture() {
  const sender = { sendCard: vi.fn().mockResolvedValue('card'), updateCard: vi.fn().mockResolvedValue(true), sendTextNotice: vi.fn().mockResolvedValue(undefined) };
  const calls: any[] = [];
  const done: any[] = [];
  const executeApiTask = vi.fn((options: any) => {
    calls.push(options);
    return new Promise<any>(resolve => {
      const finish = () => { done.push(options.chatId); resolve({ success: false, responseText: 'partial', error: 'Task was stopped' }); };
      options.signal.addEventListener('abort', finish, { once: true });
      if (options.signal.aborted) finish();
    });
  });
  const registry = { get: () => ({ bridge: { executeApiTask }, sender }) } as any;
  return { sender, calls, done, executeApiTask, registry };
}

describe('consensus ownership and cancellation', () => {
  it('stops only the exact source chat and addressed participant, idempotently', () => {
    const control = new ConsensusControl(); const notify = vi.fn();
    const first = control.register('one','group1',['caller','a'],notify);
    const second = control.register('two','group2',['caller','a']);
    expect(control.stopForChat('group1','stranger')).toEqual([]);
    expect(control.stopForChat('group1','a')).toEqual(['one']);
    expect(first.aborted).toBe(true); expect(second.aborted).toBe(false);
    control.stop('one'); expect(notify).toHaveBeenCalledTimes(1);
    control.finish('one'); expect(control.stop('one')).toBe(false);
  });
  it('cancels all independent takes, retains partial results and never advances', async () => {
    const f = fixture(); const controller = new AbortController(); const events: string[] = [];
    const run = new ConsensusOrchestrator(f.registry,logger).run({ ...input, signal: controller.signal, chatId:'group1',callerBotName:'caller' },e=>events.push(e.type));
    await turn(); expect(f.calls).toHaveLength(2);
    expect(f.calls[0]).toMatchObject({ preferenceSourceChatId:'group1', chatId:'consensus-test-run-a' });
    controller.abort(); const output = await run;
    expect(f.done).toHaveLength(2); expect(f.calls).toHaveLength(2);
    expect(output.status).toBe('aborted'); expect(output.ejectedBots).toEqual([]);
    expect(events).toContain('consensus_aborted'); expect(events).not.toContain('consensus_reached');
    expect(f.sender.sendTextNotice.mock.calls.at(-1)?.[2]).toContain('aborted');
  });
  it('does not launch even one bot when stopped before start', async () => {
    const f=fixture(); const c=new AbortController(); c.abort();
    const result=await new ConsensusOrchestrator(f.registry,logger).run({...input,signal:c.signal});
    expect(result.status).toBe('aborted');expect(f.calls).toEqual([]);
  });
  it('honors stop while the initial dashboard is awaiting delivery', async () => {
    const f=fixture(); const c=new AbortController(); let release!: (x:string)=>void;
    f.sender.sendCard.mockImplementationOnce(()=>new Promise<string>(r=>{release=r;}));
    const run=new ConsensusOrchestrator(f.registry,logger).run({...input,signal:c.signal,chatId:'group1',callerBotName:'caller'});
    c.abort();release('card');expect((await run).status).toBe('aborted');expect(f.calls).toEqual([]);
  });
  it.each([1,2,3,4,5])('blocks later execution when stop arrives at phase %s', async phase => {
    const f=fixture(); const c=new AbortController(); const orchestrator=new ConsensusOrchestrator(f.registry,logger);
    // Earlier phases are completed locally; target and later phases use the real invocation guard.
    for(let p=1;p<phase;p++) vi.spyOn(orchestrator as any,`runPhase${p}`).mockImplementation(async (state:any)=>{
      state.takes.set('a',{bot:'a',proposal:'a',reasoning:'r',knownCounterArgs:[],raw:'a',timestamp:0});
      state.takes.set('b',{bot:'b',proposal:'b',reasoning:'r',knownCounterArgs:[],raw:'b',timestamp:0});
      state.critiques=[{bot:'a',targetBot:'b',issues:[{description:'issue',severity:'low'}]}];
      state.candidate={synthesizer:'a',content:'candidate',raw:'candidate',iteration:0};
      return 'accepted';
    });
    const output=await orchestrator.run({...input,signal:c.signal},e=>{if(e.type==='phase_entered'&&e.payload.phase===phase)c.abort();});
    expect(output.status).toBe('aborted');expect(f.calls).toHaveLength(0);
  });
  it('does not issue a JSON retry after a cancelled invalid response', async () => {
    const f=fixture();const c=new AbortController();
    f.executeApiTask.mockImplementation((async()=>{c.abort();return {success:true,responseText:'not json'};}) as any);
    expect((await new ConsensusOrchestrator(f.registry,logger).run({...input,signal:c.signal})).status).toBe('aborted');
    expect(f.executeApiTask).toHaveBeenCalledTimes(1);
  });
  it.each(['stop',' STOP ','/stop'])('routes %s deterministically without pausing schedules', async text=>{
    const signal=consensusControl.register('test-run','group1',['caller','a']);
    const other=consensusControl.register('other-run','group2',['caller']);
    const sender={sendTextNotice:vi.fn()};const stop=vi.fn();const schedule=vi.fn();
    const h=new CommandHandler({name:'caller'} as any,logger,sender as any,{} as any,{} as any,{log:vi.fn()} as any,()=>({startTime:Date.now()}),stop);
    h.setScheduleStopper(schedule);
    expect(await h.handle({text,chatId:'group1',userId:'user'} as any)).toBe(true);
    expect(signal.aborted).toBe(true);expect(other.aborted).toBe(false);expect(stop).toHaveBeenCalledTimes(1);expect(schedule).not.toHaveBeenCalled();
  });
  it('keeps ordinary /stop behavior when no consensus matches', async()=>{
    const sender={sendTextNotice:vi.fn()};const stop=vi.fn();
    const h=new CommandHandler({name:'caller'} as any,logger,sender as any,{} as any,{} as any,{log:vi.fn()} as any,()=>({startTime:Date.now()}),stop);
    await h.handle({text:'/stop',chatId:'ordinary',userId:'u'} as any);expect(stop).toHaveBeenCalledTimes(1);
  });
  it('API stop is scoped, idempotent and distinguishes stopping from settled', async()=>{
    const store=new AsyncTaskStore();
    try {
      const task=store.create({botName:'consensus-orchestrator',chatId:'group',prompt:'p'});
      const signal=consensusControl.register(task.id,'group',['a'],()=>store.update(task.id,{status:'stopping'}));
      const res={writeHead:vi.fn(),end:vi.fn()} as any;const ctx={asyncTaskStore:store,logger} as any;
      await handleConsensusRoutes(ctx,{} as any,res,'POST',`/api/consensus/${task.id}/stop`);
      expect(signal.aborted).toBe(true);expect(store.get(task.id)?.status).toBe('stopping');
      expect(JSON.parse(res.end.mock.calls.at(-1)[0]).status).toBe('stopping');
      store.update(task.id,{status:'cancelled'});consensusControl.finish(task.id);
      await handleConsensusRoutes(ctx,{} as any,res,'POST',`/api/consensus/${task.id}/stop`);
      expect(JSON.parse(res.end.mock.calls.at(-1)[0]).status).toBe('cancelled');
      const other=store.create({botName:'a',chatId:'group',prompt:'p'});
      await handleConsensusRoutes(ctx,{} as any,res,'POST',`/api/consensus/${other.id}/stop`);
      expect(res.writeHead.mock.calls.at(-1)[0]).toBe(404);
    } finally {store.destroy();}
  });
});


describe('consensus route lifecycle',()=>{
 it('start -> stop -> get reaches cancelled only after participants settle',async()=>{
  const f=fixture();const store=new AsyncTaskStore();
  const registry={...f.registry,list:()=>[{name:'a',engine:'antigravity'},{name:'b',engine:'claude'}]};
  const ctx={asyncTaskStore:store,registry,logger} as any;
  const res={writeHead:vi.fn(),end:vi.fn()} as any;
  try {
   const req=Readable.from([Buffer.from(JSON.stringify({...input,chatId:'group1',callerBotName:'caller'}))]);
   await handleConsensusRoutes(ctx,req as any,res,'POST','/api/consensus');
   const {taskId}=JSON.parse(res.end.mock.calls.at(-1)[0]);expect(taskId).toBeTruthy();
   await turn();expect(f.calls).toHaveLength(2);
   await handleConsensusRoutes(ctx,{} as any,res,'POST',`/api/consensus/${taskId}/stop`);
   expect(JSON.parse(res.end.mock.calls.at(-1)[0]).status).toBe('stopping');
   await turn();await handleConsensusRoutes(ctx,{} as any,res,'GET',`/api/consensus/${taskId}`);
   const result=JSON.parse(res.end.mock.calls.at(-1)[0]);expect(result.status).toBe('cancelled');
   expect(JSON.parse(result.result.responseText).status).toBe('aborted');expect(f.done).toHaveLength(2);
   expect(consensusControl.stop(taskId)).toBe(false);
  } finally {store.destroy();}
 });
 it('uncancelled consensus still completes normally',async()=>{
  const f=fixture();let phase=0;
  f.executeApiTask.mockImplementation((async (options:any)=>({success:true,responseText:JSON.stringify(
   phase===1?{bot:options.chatId.endsWith('-a')?'a':'b',proposal:'retain cancellation',reasoning:'avoid duplicate work',knownCounterArgs:[]}:
   phase===2?{critiques:[]}:
   phase===4?{synthesisContent:'retain cancellation',preservedPoints:['retain cancellation'],droppedPoints:[],reframedPoints:[],decision:'accept',rationale:'safe'}:
   {dissent:false})})) as any);
  const result=await new ConsensusOrchestrator(f.registry,logger).run(input,e=>{if(e.type==='phase_entered')phase=e.payload.phase as number;});
  expect(result.status).toBe('consensus_reached');expect(phase).toBe(5);
 });
});
