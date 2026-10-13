import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CoreStore } from '../../packages/core/src/store.js';
import type { Run } from '../../packages/core/src/control.js';
import type { ExecutionBinding, PreparedExecution, TrustedStopObservation, TrustedNodeVerifier } from '../../packages/execution/src/contracts.js';
let core:CoreStore;let binding:ExecutionBinding;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));core=new CoreStore(':memory:');core.createBot({commandId:'c',botId:'bot',name:'Bot',subject:'user'});for(const id of ['a','b'])core.submit({commandId:id,botId:'bot',taskId:id,text:id,subject:'user',expectedVersion:1});});
afterEach(()=>{core.close();vi.useRealTimers();});
async function start(){return (await core.dispatchAsync('bot',{prepare:async(run:Run,sandboxId:string):Promise<PreparedExecution>=>{
 binding={nodeId:'node',sandboxId,generation:run.generation,transportInstanceId:'transport',processInstanceId:'process',runId:run.id,fencingToken:run.fencingToken,sessionId:run.sessionId,turnId:run.turnId};return {contextManifestRef:'context',resolvedConnectionRef:'connection',binding,verifiedAt:Date.now(),expiresAt:Date.now()+60000};},authorizeNow:()=>{}}))!;}
function observation():TrustedStopObservation{return {protocolVersion:2,observationId:'observation',evidenceRef:'node:proof',observedAt:Date.now(),binding:{...binding},processTree:{complete:true,writableProcesses:0,state:'stopped'},exitCode:0};}
function verifier(value:TrustedStopObservation|null):TrustedNodeVerifier{return {observeStop:async()=>{expect(core.database.isTransaction).toBe(false);return value;}};}
test('dead_parent_live_child_keeps_slot',async()=>{
 const run=await start();const proof=observation();proof.processTree.writableProcesses=1;
 await expect(core.observeTrustedStop(run.id,'node:proof',verifier(proof))).rejects.toThrow('WRITABLE_PROCESS_TREE_UNCONFIRMED');
 expect(core.snapshot().runs[0]?.slotHeld).toBe(true);expect(core.dispatch('bot',()=>({contextManifestRef:'fake',resolvedConnectionRef:'fake'}))).toBeNull();
});
test('untrusted_exit_is_rejected',async()=>{
 const run=await start();const evidence={kind:'process-exit' as const,source:'fake-runner' as const,exitCode:0};
 expect(()=>core.observeExit(run.id,run.fencingToken,evidence)).toThrow('TRUSTED_NODE_OBSERVATION_REQUIRED');
 expect(()=>core.reconcile(run.id,{kind:'exited',fencingToken:run.fencingToken,evidence})).toThrow('TRUSTED_NODE_OBSERVATION_REQUIRED');
 expect(()=>core.ingestRunEvent({runId:run.id,fencingToken:run.fencingToken,sequence:1,type:'run.exited',payload:{evidence}})).toThrow('TRUSTED_NODE_OBSERVATION_REQUIRED');
 expect(core.snapshot().runs[0]?.slotHeld).toBe(true);
});
test('complete_trusted_process_tree_stop_releases_slot_but_not_task_success',async()=>{
 const run=await start();await core.observeTrustedStop(run.id,'node:proof',verifier(observation()));
 expect(core.snapshot().runs[0]?.slotHeld).toBe(false);expect(core.snapshot().tasks[0]?.status).toBe('VERIFYING');expect(core.dispatch('bot',()=>({contextManifestRef:'fake',resolvedConnectionRef:'fake'}))?.taskId).toBe('b');
});
test.each(['nodeId','sandboxId','generation','transportInstanceId','processInstanceId','runId','fencingToken','sessionId','turnId'] as const)('trusted observation rejects wrong %s',async key=>{
 const run=await start();const proof=observation();Object.assign(proof.binding,{[key]:typeof proof.binding[key]==='number'?999:'wrong'});
 await expect(core.observeTrustedStop(run.id,'node:proof',verifier(proof))).rejects.toThrow('STOP_OBSERVATION_BINDING_MISMATCH');expect(core.snapshot().runs[0]?.slotHeld).toBe(true);
});
test.each(['unknown','stale','incomplete','future','wrong-reference'] as const)('stop observation fails closed: %s',async kind=>{
 const run=await start();const proof=observation();if(kind==='stale')proof.observedAt-=120000;if(kind==='future')proof.observedAt+=60000;if(kind==='incomplete')proof.processTree.complete=false;if(kind==='wrong-reference')proof.evidenceRef='other';
 await expect(core.observeTrustedStop(run.id,'node:proof',verifier(kind==='unknown'?null:proof))).rejects.toThrow();expect(core.snapshot().runs[0]?.slotHeld).toBe(true);
});

test('untrusted_alive_reconciliation_cannot_revive_a_real_run',async()=>{
 const run=await start();core.expireLeases(Date.now()+120000);
 expect(()=>core.reconcile(run.id,{kind:'alive',fencingToken:run.fencingToken})).toThrow('TRUSTED_NODE_OBSERVATION_REQUIRED');
 expect(core.snapshot().runs[0]?.state).toBe('LOST');
});

test('verified_isolation_releases_slot_without_claiming_normal_exit',async()=>{
 const run=await start();core.requestInterrupt(run.id);const proof=observation();proof.processTree.state='isolated';delete proof.exitCode;
 await core.observeTrustedStop(run.id,'node:proof',verifier(proof));
 expect(core.snapshot().runs[0]?.slotHeld).toBe(false);expect(core.snapshot().tasks[0]?.status).toBe('WAITING_INPUT');
});

test('unknown_child_tree_and_runner_reported_success_are_not_stop_evidence',async()=>{
 const run=await start();const proof=observation();proof.processTree.state='unknown';
 await expect(core.observeTrustedStop(run.id,'node:proof',verifier(proof))).rejects.toThrow('WRITABLE_PROCESS_TREE_UNCONFIRMED');
 expect(core.snapshot().runs[0]?.slotHeld).toBe(true);
});

test('caller_cannot_hold_a_sqlite_transaction_while_waiting_for_node',async()=>{
 const run=await start();core.database.exec('BEGIN IMMEDIATE');
 try{await expect(core.observeTrustedStop(run.id,'node:proof',verifier(observation()))).rejects.toThrow('ASYNC_TRANSACTION_FORBIDDEN');}finally{core.database.exec('ROLLBACK');}
});

test('legacy_fake_transport_adapter_remains_available_and_refuses_real_commands',async()=>{
 const {adaptSyncRunner}=await import('../../packages/execution/src/runner-client.js');
 const {FakeRuntime}=await import('../../packages/execution/src/fake-runtime.js');
 const runner=new FakeRuntime(':memory:');
 try{
  const run=core.dispatch('bot',r=>({contextManifestRef:`fake:${r.id}`,resolvedConnectionRef:`fake:${r.id}`}))!;
  const command=core.pendingCommands()[0]!;const adapter=adaptSyncRunner(runner);
  const receipt=await adapter.receive(command);expect(await adapter.query(command.commandId)).toEqual(receipt);expect(runner.inspect(run.id)?.slotHeld).toBe(true);
  await expect(adapter.receive({...command,protocolVersion:2,executionBinding:{nodeId:'node',sandboxId:'sandbox:bot',generation:run.generation,transportInstanceId:'transport',processInstanceId:'process',runId:run.id,fencingToken:run.fencingToken,sessionId:run.sessionId,turnId:run.turnId}})).rejects.toThrow('FAKE_TRANSPORT_REAL_EXECUTION_FORBIDDEN');
 }finally{runner.close();}
});
test('protocol_requires_version_and_complete_binding_together',async()=>{
 const {RunnerClient}=await import('../../packages/execution/src/runner-client.js');
 const client=new RunnerClient({query:async()=>null,receive:async()=>{throw new Error('MUST_NOT_SEND');}});
 await start();const command=core.pendingCommands()[0]!;
 await expect(client.receive({...command,protocolVersion:undefined})).rejects.toThrow('UNSUPPORTED_EXECUTION_PROTOCOL');
 await expect(client.receive({...command,executionBinding:undefined})).rejects.toThrow('UNSUPPORTED_EXECUTION_PROTOCOL');
 await expect(client.receive({...command,executionBinding:{...binding,runId:'wrong'}})).rejects.toThrow('EXECUTION_BINDING_MISMATCH');
});
test('minimal_async_application_uses_injected_trusted_observer',async()=>{
 const {AsyncApplication}=await import('../../packages/core/src/application.js');
 const run=await start();const app=new AsyncApplication(core,{query:async()=>null,receive:async()=>{throw new Error('not-used');}},{prepare:async()=>{throw new Error('not-used');},authorizeNow:()=>{}},{observeStop:async(expected,ref)=>({...observation(),binding:expected,evidenceRef:ref,observedAt:Date.now()})});
 await app.observeStop(run.id,'node:proof');expect(core.snapshot().runs[0]?.slotHeld).toBe(false);
});
