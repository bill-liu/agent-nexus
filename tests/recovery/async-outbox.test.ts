import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CoreStore } from '../../packages/core/src/store.js';
import { canonicalJson } from '../../packages/persistence/src/unit-of-work.js';
import type { ExecutionCommand, RunnerReceipt, AsyncRunnerTransport, AsyncExecutionServices, PreparedExecution } from '../../packages/execution/src/contracts.js';
import type { Run } from '../../packages/core/src/control.js';

let dir: string; let core: CoreStore;
beforeEach(() => {
 dir=mkdtempSync(join(tmpdir(),'an-async-'));core=new CoreStore(join(dir,'core.db'));
 core.createBot({commandId:'create',botId:'bot',name:'Bot',subject:'user'});
 for (const id of ['a','b']) core.submit({commandId:id,botId:'bot',taskId:id,text:id,expectedVersion:1,subject:'user'});
});
afterEach(() => {core.close();rmSync(dir,{recursive:true,force:true});});
const fixed=(run: Run,sandboxId: string): PreparedExecution => ({contextManifestRef:`ctx:${run.id}`,resolvedConnectionRef:`conn:${run.id}`,verifiedAt:Date.now(),expiresAt:Date.now()+60000,binding:{nodeId:'trusted-node',sandboxId,generation:run.generation,transportInstanceId:'transport-1',processInstanceId:`process:${run.id}`,runId:run.id,fencingToken:run.fencingToken,sessionId:run.sessionId,turnId:run.turnId}});
const services=(): AsyncExecutionServices=>({prepare:async(run,sandbox)=>{expect(core.database.isTransaction).toBe(false);return fixed(run,sandbox);},authorizeNow:()=>{}});
class Endpoint implements AsyncRunnerTransport {
 receipts=new Map<string,RunnerReceipt>(); starts: string[]=[]; lostAck=false;
 async query(id: string) {expect(core.database.isTransaction).toBe(false);return this.receipts.get(id)??null;}
 async receive(command: ExecutionCommand) {
  expect(core.database.isTransaction).toBe(false);
  const prior=this.receipts.get(command.commandId);if(prior)return prior;
  if(command.type==='run.start')this.starts.push(command.runId);
  const receipt: RunnerReceipt={commandId:command.commandId,runId:command.runId,requestDigest:createHash('sha256').update(canonicalJson(command)).digest('hex'),state:'ACCEPTED'};
  this.receipts.set(command.commandId,receipt);
  if(this.lostAck){this.lostAck=false;throw new Error('ACK_LOST');}return receipt;
 }
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

test('ack_lost_reuses_command',async()=>{
 const policy=services();const run=await core.dispatchAsync('bot',policy);const original=core.pendingCommands()[0];const endpoint=new Endpoint();endpoint.lostAck=true;
 await expect(core.flushOutboxAsync(endpoint,policy)).rejects.toThrow('ACK_LOST');
 expect(core.pendingCommands()[0]).toEqual(original);
 core.close();core=new CoreStore(join(dir,'core.db'));
 await core.flushOutboxAsync(endpoint,policy);
 expect(endpoint.starts).toEqual([run!.id]);expect(core.pendingCommands()).toHaveLength(0);expect(core.snapshot().runs[0]?.state).toBe('LOST');
});
test('revoke_between_prepare_and_send',async()=>{
 let revoked=false;const policy={...services(),authorizeNow:()=>{if(revoked)throw new Error('GRANT_REVOKED');}};
 await core.dispatchAsync('bot',policy);revoked=true;const endpoint=new Endpoint();
 await expect(core.flushOutboxAsync(endpoint,policy)).rejects.toThrow('GRANT_REVOKED');expect(endpoint.starts).toEqual([]);expect(core.pendingCommands()).toHaveLength(1);
});
test('deferred_resolver_revocation_rolls_back_dispatch',async()=>{
 const wait=deferred();let revoked=false;const policy={...services(),prepare:async(run:Run,sandbox:string)=>{await wait.promise;return fixed(run,sandbox);},authorizeNow:()=>{if(revoked)throw new Error('GRANT_REVOKED');}};
 const dispatch=core.dispatchAsync('bot',policy);revoked=true;wait.resolve();
 await expect(dispatch).rejects.toThrow('GRANT_REVOKED');expect(core.snapshot().runs).toHaveLength(0);expect(core.pendingCommands()).toHaveLength(0);
});
test('pause_or_changed_head_during_preparation_cannot_dispatch_stale_candidate',async()=>{
 const wait=deferred();const policy={...services(),prepare:async(run:Run,sandbox:string)=>{await wait.promise;return fixed(run,sandbox);}};
 const dispatch=core.dispatchAsync('bot',policy);core.setPaused({commandId:'pause',botId:'bot',paused:true,subject:'user',expectedVersion:1});wait.resolve();
 await expect(dispatch).rejects.toThrow('DISPATCH_CANDIDATE_STALE');expect(core.snapshot().runs).toHaveLength(0);
});
test('concurrent_preparations_cannot_substitute_the_next_inbox_head',async()=>{
 const wait=deferred();const slow=core.dispatchAsync('bot',{...services(),prepare:async(run,sandbox)=>{await wait.promise;return fixed(run,sandbox);}});
 const first=await core.dispatchAsync('bot',services());wait.resolve();
 await expect(slow).rejects.toThrow('DISPATCH_CANDIDATE_STALE');expect(core.snapshot().runs.map(r=>r.id)).toEqual([first!.id]);expect(core.snapshot().tasks[1]?.status).toBe('QUEUED');
});
test('cancel_during_query_suppresses_start',async()=>{
 const policy=services();const run=(await core.dispatchAsync('bot',policy))!;const endpoint=new Endpoint();const originalQuery=endpoint.query.bind(endpoint);
 endpoint.query=async id=>{const result=await originalQuery(id);core.requestCancel(run.id);return result;};
 await core.flushOutboxAsync(endpoint,policy);expect(endpoint.starts).toEqual([]);expect(core.snapshot().runs[0]?.slotHeld).toBe(true);
});
test('revoke_during_preflight_is_checked_immediately_before_send',async()=>{
 let revoked=false;const policy={...services(),authorizeNow:()=>{if(revoked)throw new Error('GRANT_REVOKED');},preflight:async()=>{revoked=true;}};
 await core.dispatchAsync('bot',policy);const endpoint=new Endpoint();await expect(core.flushOutboxAsync(endpoint,policy)).rejects.toThrow('GRANT_REVOKED');expect(endpoint.starts).toEqual([]);
});
test('core_epoch_change_invalidates_pending_send',async()=>{
 const policy=services();await core.dispatchAsync('bot',policy);const endpoint=new Endpoint();const old=core;const query=endpoint.query.bind(endpoint);
 endpoint.query=async id=>{const result=await query(id);core=new CoreStore(join(dir,'core.db'));return result;};
 await expect(old.flushOutboxAsync(endpoint,policy)).rejects.toThrow('STALE_CORE_EPOCH');expect(endpoint.starts).toEqual([]);old.close();
});
test('malicious_query_receipt_cannot_ack_outbox_or_release_slot',async()=>{
 const policy=services();await core.dispatchAsync('bot',policy);const endpoint=new Endpoint();const command=core.pendingCommands()[0]!;
 endpoint.receipts.set(command.commandId,{commandId:'wrong',runId:command.runId,requestDigest:'fabricated',state:'ACCEPTED',exitEvidence:{kind:'process-exit',source:'fake-runner',exitCode:0}});
 await expect(core.flushOutboxAsync(endpoint,policy)).rejects.toThrow('RUNNER_RECEIPT_MISMATCH');expect(core.pendingCommands()).toHaveLength(1);expect(core.snapshot().runs[0]?.slotHeld).toBe(true);
});
test('query_of_committed_receipt_reconciles_without_new_authorization_or_execution',async()=>{
 const policy=services();await core.dispatchAsync('bot',policy);const endpoint=new Endpoint();await endpoint.receive(core.pendingCommands()[0]!);
 await core.flushOutboxAsync(endpoint,{...policy,authorizeNow:()=>{throw new Error('GRANT_REVOKED');}});
 expect(endpoint.starts).toHaveLength(1);expect(core.pendingCommands()).toHaveLength(0);
});

test('real_receipt_fake_exit_evidence_is_rejected_even_with_valid_digest',async()=>{
 const policy=services();const run=(await core.dispatchAsync('bot',policy))!;const endpoint=new Endpoint();await core.flushOutboxAsync(endpoint,policy);core.requestCancel(run.id);
 const command=core.pendingCommands()[0]!;const receipt=await endpoint.receive(command);receipt.exitEvidence={kind:'process-exit',source:'fake-runner',exitCode:0};
 await expect(core.flushOutboxAsync(endpoint,policy)).rejects.toThrow('TRUSTED_NODE_OBSERVATION_REQUIRED');expect(core.snapshot().runs[0]?.slotHeld).toBe(true);expect(core.pendingCommands()).toHaveLength(1);
});
test('expired_preparation_and_binding_mismatch_never_commit',async()=>{
 await expect(core.dispatchAsync('bot',{...services(),prepare:async(run,sandbox)=>({...fixed(run,sandbox),verifiedAt:Date.now()-31000})})).rejects.toThrow('PREPARATION_STALE');
 await expect(core.dispatchAsync('bot',{...services(),prepare:async(run,sandbox)=>{const p=fixed(run,sandbox);p.binding.processInstanceId='';return p;}})).rejects.toThrow('EXECUTION_BINDING_MISMATCH');
 expect(core.snapshot().runs).toHaveLength(0);
});
test('concurrent_flush_waits_for_same_delivery_and_commits_once',async()=>{
 const policy=services();await core.dispatchAsync('bot',policy);const wait=deferred();const endpoint=new Endpoint();const query=endpoint.query.bind(endpoint);
 endpoint.query=async id=>{await wait.promise;return query(id);};const a=core.flushOutboxAsync(endpoint,policy);const b=core.flushOutboxAsync(endpoint,policy);wait.resolve();
 await Promise.all([a,b]);expect(endpoint.starts).toHaveLength(1);expect(core.readEvents(0).events.filter(e=>e.type==='run.receipt')).toHaveLength(1);
});
test('restart_without_a_receipt_never_starts_an_unknown_old_writer',async()=>{
 const policy=services();await core.dispatchAsync('bot',policy);core.close();core=new CoreStore(join(dir,'core.db'));const endpoint=new Endpoint();
 await expect(core.flushOutboxAsync(endpoint,policy)).rejects.toThrow('STATE_UNKNOWN');expect(endpoint.starts).toEqual([]);expect(core.snapshot().runs[0]?.slotHeld).toBe(true);
});
test('stop_commands_take_priority_over_an_unsent_start',async()=>{
 const policy=services();const run=(await core.dispatchAsync('bot',policy))!;core.requestCancel(run.id);const endpoint=new Endpoint();
 const receipts=await core.flushOutboxAsync(endpoint,policy);expect(receipts.map(r=>r.commandId)).toEqual([`cancel:${run.id}`]);expect(endpoint.starts).toEqual([]);expect(core.pendingCommands()).toHaveLength(0);expect(core.snapshot().runs[0]?.slotHeld).toBe(true);
});
test('async_dispatch_refuses_an_external_sqlite_transaction',async()=>{
 core.database.exec('BEGIN IMMEDIATE');try{await expect(core.dispatchAsync('bot',services())).rejects.toThrow('ASYNC_TRANSACTION_FORBIDDEN');}finally{core.database.exec('ROLLBACK');}
});

test('v1_schema_and_fake_outbox_migrate_without_relabeling_fake_as_real',async()=>{
 const {FakeRuntime}=await import('../../packages/execution/src/fake-runtime.js');
 const {adaptSyncRunner}=await import('../../packages/execution/src/runner-client.js');
 const run=core.dispatch('bot',r=>({contextManifestRef:`fake:${r.id}`,resolvedConnectionRef:`fake:${r.id}`}))!;const command=core.pendingCommands()[0]!;
 // Reconstruct the P0 v1 schema shape with its already committed inbox/run/outbox.
 core.database.exec("DROP TABLE run_execution_binding; UPDATE core_metadata SET value=1 WHERE key='schema_version'");core.close();core=new CoreStore(join(dir,'core.db'));
 expect(core.database.prepare("SELECT value FROM core_metadata WHERE key='schema_version'").get()?.value).toBe(3);
 expect(core.pendingCommands()[0]).toEqual(command);expect(core.executionBinding(run.id)).toBeNull();expect(command.protocolVersion).toBeUndefined();
 const runner=new FakeRuntime(':memory:');try{runner.receive(command);await core.flushOutboxAsync(adaptSyncRunner(runner),services());expect(runner.receipts()).toHaveLength(1);expect(core.snapshot().runs[0]?.slotHeld).toBe(true);}finally{runner.close();}
});
test('real_binding_survives_restart_and_legacy_exit_cannot_release_it',async()=>{
 const run=(await core.dispatchAsync('bot',services()))!;const binding=core.executionBinding(run.id);core.close();core=new CoreStore(join(dir,'core.db'));
 expect(core.executionBinding(run.id)).toEqual(binding);
 expect(()=>core.observeExit(run.id,run.fencingToken,{kind:'process-exit',source:'fake-runner',exitCode:0})).toThrow('TRUSTED_NODE_OBSERVATION_REQUIRED');expect(core.snapshot().runs[0]?.slotHeld).toBe(true);
});
test('failed asynchronous preparation is retired outside SQL before another attempt',async()=>{
 const core=new CoreStore(':memory:');let retired:any;try{core.createBot({commandId:'cleanup-create',botId:'cleanup-bot',name:'Cleanup',subject:'owner'});core.submit({commandId:'cleanup-work',taskId:'cleanup-task',botId:'cleanup-bot',text:'Synthetic',expectedVersion:1,subject:'owner'});
 await expect(core.dispatchAsync('cleanup-bot',{prepare:async()=>{throw Error('AUTH_REQUIRED');},authorizeNow(){},discardPrepared:async r=>{expect(core.database.isTransaction).toBe(false);retired=r;}})).rejects.toThrow('AUTH_REQUIRED');expect(retired.botId).toBe('cleanup-bot');expect(core.snapshot().runs).toEqual([]);expect(core.snapshot().tasks[0].status).toBe('QUEUED');}finally{core.close();}
});
