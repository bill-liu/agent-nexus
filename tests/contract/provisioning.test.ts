import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { BotProvisioner, BOT_PROVISION_SCHEMA } from '../../packages/core/src/bot-provision';

function fixture() {
 const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE bot(id TEXT PRIMARY KEY); INSERT INTO bot VALUES (\'b\');'); db.exec(BOT_PROVISION_SCHEMA);
 const provider = {create:vi.fn(async()=>({sandboxId:'s',generation:1,state:'stopped',evidenceKind:'scripted'})),destroy:vi.fn()};
 const download = {start:vi.fn(()=>({operationId:'download-1'})),resume:vi.fn(async()=>({state:'ready'}))};
 const p = new BotProvisioner(db, provider as never, download as never);
 const request = {operationId:'op',botId:'b',sandboxId:'s',envelope:{manifest:{digest:'digest'}}};
 return {db,p,provider,download,request};
}
describe('provisioning (scripted)',()=>{
 it('task_finish_keeps_sandbox',async()=>{
  const f=fixture(); await f.p.provision(f.request as never); const result=f.p.inspect('op');
  expect(result.botId).toBe('b'); expect(f.provider.destroy).not.toHaveBeenCalled(); f.db.close();
 });
 it('retry_provision_keeps_bot_and_operation',async()=>{
  const f=fixture(); f.download.resume.mockRejectedValueOnce(new Error('INTERRUPTED'));
  await expect(f.p.provision(f.request as never)).rejects.toThrow();
  const restarted=new BotProvisioner(f.db,f.provider as never,f.download as never);
  expect((await restarted.provision(f.request as never)).operationId).toBe('op');
  expect(f.provider.create).toHaveBeenCalledTimes(1); expect(f.db.prepare('SELECT COUNT(*) AS n FROM bot').get()?.n).toBe(1); f.db.close();
 });
 it('stub_health_is_not_live_ready',async()=>{
  const f=fixture(); await f.p.provision(f.request as never);
  const observed = f.p.observeReadiness('op',{sandboxId:'s',generation:1,environment:true,runner:true,runtime:true,auth:true,evidenceKind:'scripted',protocolVersion:2,observedAt:Date.now()});
  expect(observed.liveReady).toBe(false); expect(observed.readiness.auth).toBe(false); f.db.close();
 });
});

import { registerProvision, inspectProvision } from '../../packages/core/src/bot-provision';
it('blocked registration persists without invoking provider or download',async()=>{
 const f=fixture();const initial=registerProvision(f.db,{operationId:'op',botId:'b',sandboxId:'s'});
 expect(initial.stage).toBe('registered');expect(initial.liveReady).toBe(false);expect(f.provider.create).not.toHaveBeenCalled();
 expect(inspectProvision(f.db,'op')).toEqual(initial);
 await f.p.provision(f.request as never);expect(f.p.inspect('op').stage).toBe('environment-ready');
 expect(()=>registerProvision(f.db,{operationId:'other',botId:'b',sandboxId:'s'})).toThrow('PROVISION_IDEMPOTENCY_CONFLICT');f.db.close();
});
it('installed adoption advances only from current live helper plus trusted validation',async()=>{
 const f=fixture();registerProvision(f.db,{operationId:'op',botId:'b',sandboxId:'s'});
 const inspect=vi.fn(async()=>({protocolVersion:1,sandboxId:'s',generation:2,state:'running',evidenceKind:'live',observedAt:Date.now()}));
 const installed=new BotProvisioner(f.db,{...f.provider,inspect} as never,f.download as never);
 const verify=vi.fn(async()=>{});const record=await installed.adoptInstalled('op',{sandboxId:'s',generation:2},verify);
 expect(record.generation).toBe(2);expect(record.readiness.environment).toBe(true);expect(record.liveReady).toBe(false);expect(inspect).toHaveBeenCalledTimes(2);expect(verify).toHaveBeenCalledTimes(1);
 expect(f.provider.create).not.toHaveBeenCalled();expect(f.download.start).not.toHaveBeenCalled();f.db.close();
});
it('failed installed validation clears old readiness and never advances generation',async()=>{
 const f=fixture();registerProvision(f.db,{operationId:'op',botId:'b',sandboxId:'s'});
 const inspect=vi.fn(async()=>({protocolVersion:1,sandboxId:'s',generation:2,state:'running',evidenceKind:'live',observedAt:Date.now()}));
 const installed=new BotProvisioner(f.db,{...f.provider,inspect} as never,f.download as never);
 await expect(installed.adoptInstalled('op',{sandboxId:'s',generation:2},async()=>{throw new Error('CORRUPT_INSTALLED_ARTIFACT');})).rejects.toThrow('CORRUPT_INSTALLED_ARTIFACT');
 expect(installed.inspect('op').generation).toBe(0);expect(installed.inspect('op').readiness.environment).toBe(false);expect(installed.inspect('op').liveReady).toBe(false);f.db.close();
});
it('scripted installed state cannot invoke trusted validation or set environment ready',async()=>{
 const f=fixture();registerProvision(f.db,{operationId:'op',botId:'b',sandboxId:'s'});
 const inspect=vi.fn(async()=>({protocolVersion:1,sandboxId:'s',generation:2,state:'running',evidenceKind:'scripted',observedAt:Date.now()}));
 const installed=new BotProvisioner(f.db,{...f.provider,inspect} as never,f.download as never),verify=vi.fn();
 await expect(installed.adoptInstalled('op',{sandboxId:'s',generation:2},verify)).rejects.toThrow('INSTALLED_SANDBOX_UNCONFIRMED');expect(verify).not.toHaveBeenCalled();f.db.close();
});
