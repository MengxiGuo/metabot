import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityQuotaHealth, quotaResetAt } from '../src/engines/antigravity/quota-failover.js';
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
function location(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'quota-health-'));dirs.push(d);return path.join(d,'state.json');}
describe('quota reset deadlines',()=>{
 it('parses actual 60h11m55s, from observation time with a 60s reserve',()=>{
  expect(quotaResetAt('Individual quota reached. Resets in 60h11m55s.',1000)).toBe(1000+(60*3600+11*60+55+60)*1000);
 });
 it.each(['429','quota exhausted','Resets in 9999999h','Resets in -1h','Resets in 0s'])('rejects unknown/unbounded duration %s',text=>{expect(quotaResetAt(text,1000)).toBeUndefined();});
 it('survives process reinitialization and does not retry a multi-day exhausted account after five minutes',()=>{
  let now=1000;const file=location();const first=new AntigravityQuotaHealth(()=>now);first.enablePersistence(file);
  const until=quotaResetAt('Resets in 60h11m55s.',now)!;first.markExhausted('/runner/primary','gemini-4-argon-high',until);
  now+=10*60*1000;const second=new AntigravityQuotaHealth(()=>now);second.enablePersistence(file);
  expect(second.isExhausted('/runner/primary','gemini-4-argon-low')).toBe(true);
  expect(second.isExhausted('/runner/backup','gemini-4-argon-low')).toBe(false);
  expect(second.isExhausted('/runner/primary','claude-opus-5-5-medium')).toBe(false);
  second.markExhausted('/runner/primary','gemini-4-argon-low');
  now=until-1;expect(second.isExhausted('/runner/primary','gemini-4-argon-low')).toBe(true);
  now=until;expect(second.isExhausted('/runner/primary','gemini-4-argon-low')).toBe(false);
  expect(fs.readFileSync(file,'utf8')).not.toContain('/runner/primary');expect(fs.statSync(file).mode&0o777).toBe(0o600);
 });
 it('uses five minutes for unknown reset times and warns on corrupt state',()=>{
  let now=0;const file=location();fs.writeFileSync(file,'broken');const warning=vi.fn();const h=new AntigravityQuotaHealth(()=>now);h.enablePersistence(file,warning);expect(warning).toHaveBeenCalledOnce();
  h.markExhausted('/runner','gemini-x');now=299999;expect(h.isExhausted('/runner','gemini-x')).toBe(true);now=300000;expect(h.isExhausted('/runner','gemini-x')).toBe(false);
 });
});
