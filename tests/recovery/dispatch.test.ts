import { prepareFake, authorizeFake } from './fixtures.js';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { transaction } from '../../packages/persistence/src/unit-of-work.js';
import { CoreStore } from '../../packages/core/src/store.js';
import { FakeRuntime } from '../../packages/execution/src/fake-runtime.js';

let dir: string;
let core: CoreStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'an-dispatch-')); core = new CoreStore(join(dir, 'core.db')); core.createBot({commandId:'create',botId:'bot',name:'Developer',subject:'user'}); });
afterEach(() => { core.close(); rmSync(dir, {recursive:true,force:true}); });
const submit = (id: string) => core.submit({commandId:`submit-${id}`,botId:'bot',taskId:id,text:`Work ${id}`,expectedVersion:1,subject:'user'});

test('double submission queues persistently and only one run owns the bot write slot', () => {
  submit('a'); submit('b');
  const first = core.dispatch('bot',prepareFake);
  expect(first).not.toBeNull(); expect(core.dispatch('bot',prepareFake)).toBeNull();
  expect(core.snapshot().tasks.map(t => t.status)).toEqual(['RUNNING','QUEUED']);
  core.close(); core = new CoreStore(join(dir,'core.db'));
  expect(core.snapshot().tasks).toHaveLength(2); expect(core.dispatch('bot',prepareFake)).toBeNull();
  expect(core.snapshot().runs[0]?.slotHeld).toBe(true);
});

test('ACK lost after durable Runner receipt retries original command without a second execution', () => {
  submit('a'); const run = core.dispatch('bot',prepareFake)!;
  let runner = new FakeRuntime(join(dir,'runner.db'));
  const command = core.pendingCommands()[0]!;
  runner.receive(command); // Crash/ACK loss between runner commit and Core ACK.
  runner.close(); core.close();
  runner = new FakeRuntime(join(dir,'runner.db')); core = new CoreStore(join(dir,'core.db'));
  core.flushOutbox(runner,authorizeFake);
  expect(runner.receipts()).toHaveLength(1);
  expect(runner.receipts()[0]?.runId).toBe(run.id);
  expect(core.pendingCommands()).toHaveLength(0); expect(core.snapshot().runs).toHaveLength(1);
  runner.close();
});

test('task inbox and outbox roll back together on SQLite write failure', () => {
  const db = new DatabaseSync(join(dir,'core.db'));
  db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox_event BEGIN SELECT RAISE(ABORT,'disk full substitute'); END");
  expect(() => submit('a')).toThrow('disk full substitute');
  expect(core.snapshot().tasks).toHaveLength(0);
  expect(db.prepare('SELECT count(*) AS count FROM bot_inbox').get()?.count).toBe(0);
  db.exec('DROP TRIGGER reject_outbox'); db.close();
  expect(submit('a').status).toBe('QUEUED');
});

test('canonical command digest survives reopen and conflicting payload cannot reuse command id', () => {
  const task = submit('a'); core.close(); core = new CoreStore(join(dir,'core.db'));
  expect(submit('a')).toEqual(task);
  expect(() => core.submit({subject:'user',expectedVersion:1,text:'Changed',taskId:'a',botId:'bot',commandId:'submit-a'})).toThrow('IDEMPOTENCY_CONFLICT');
  expect(core.snapshot().tasks).toHaveLength(1);
});

test('accepting new work and dispatch pause are independent and checked in the claim transaction', () => {
  submit('a');
  core.setAcceptingTasks({commandId:'accept-off',botId:'bot',accepting:false,expectedVersion:1,subject:'user'});
  expect(() => core.submit({commandId:'new',botId:'bot',taskId:'b',text:'new',expectedVersion:2,subject:'user'})).toThrow('NOT_ACCEPTING_TASKS');
  core.setPaused({commandId:'pause',botId:'bot',paused:true,expectedVersion:2,subject:'user'});
  expect(core.dispatch('bot',prepareFake)).toBeNull();
  expect(() => core.setPaused({commandId:'stale',botId:'bot',paused:false,expectedVersion:2,subject:'user'})).toThrow('VERSION_CONFLICT');
  core.setPaused({commandId:'resume',botId:'bot',paused:false,expectedVersion:3,subject:'user'});
  expect(core.dispatch('bot',prepareFake)).not.toBeNull();
});

test('Runner rejects altered payload under same command id and Core refuses a mismatched durable receipt',()=>{
 submit('a');core.dispatch('bot',prepareFake);const command=core.pendingCommands()[0]!;
 const runner=new FakeRuntime(join(dir,'runner.db'));
 runner.receive({...command,taskRevision:99});
 expect(()=>runner.receive(command)).toThrow('IDEMPOTENCY_CONFLICT');
 expect(()=>core.flushOutbox(runner,authorizeFake)).toThrow('RUNNER_RECEIPT_MISMATCH');
 expect(core.pendingCommands()).toHaveLength(1);runner.close();
});

test('SQLite conditional unique constraint itself preserves LOST writer slot',()=>{
 submit('a');submit('b');const run=core.dispatch('bot',prepareFake)!;core.expireLeases(Date.now()+120000);
 expect(()=>core.database.prepare(`INSERT INTO run(id,bot_id,task_id,task_revision,command_id,fencing_token,generation,owner_epoch,lease_expires_at,session_id,turn_id,state,slot_held,context_manifest_ref,resolved_connection_ref)
 VALUES ('illegal','bot','b',1,'illegal-start',999,1,1,0,'session','turn','RUNNING',1,'fake-context','fake-connection')`).run()).toThrow(/UNIQUE constraint failed: run.bot_id/);
 expect(core.snapshot().runs[0]?.id).toBe(run.id);expect(core.snapshot().runs[0]?.state).toBe('LOST');
});

test('missing or asynchronous preparation cannot create a Run or acquire its slot',()=>{
 submit('a');
 expect(()=>core.dispatch('bot')).toThrow('PREPARATION_REQUIRED');
 expect(()=>core.dispatch('bot',(()=>Promise.resolve({contextManifestRef:'fake',resolvedConnectionRef:'fake'})) as never)).toThrow('ASYNC_PREPARATION_FORBIDDEN');
 expect(core.snapshot().runs).toHaveLength(0);expect(core.snapshot().tasks[0]?.status).toBe('QUEUED');
});

test('failed preparation rolls all fixed context and dispatch writes back atomically',()=>{
 submit('a');core.database.exec('CREATE TABLE fixed_context(id TEXT PRIMARY KEY)');
 expect(()=>core.dispatch('bot',()=>{core.database.prepare('INSERT INTO fixed_context VALUES (?)').run('context');throw new Error('grant revoked');})).toThrow('grant revoked');
 expect(core.database.prepare('SELECT count(*) AS n FROM fixed_context').get()?.n).toBe(0);
 expect(core.snapshot().runs).toHaveLength(0);expect(core.pendingCommands()).toHaveLength(0);
 const run=core.dispatch('bot',prepareFake)!;expect(run.contextManifestRef).toBe(`fake-context:${run.id}`);expect(core.pendingCommands()[0]?.resolvedConnectionRef).toBe(`fake-connection:${run.id}`);
});

test('final authorization rechecks even existing ACK receipts; revoke cannot be bypassed on retry',()=>{
 submit('a');core.dispatch('bot',prepareFake);const runner=new FakeRuntime(join(dir,'runner.db'));
 expect(()=>core.flushOutbox(runner)).toThrow('START_AUTHORIZATION_REQUIRED');
 expect(()=>core.flushOutbox(runner,()=>{throw new Error('GRANT_REVOKED');})).toThrow('GRANT_REVOKED');
 expect(runner.receipts()).toHaveLength(0);expect(core.pendingCommands()).toHaveLength(1);
 runner.receive(core.pendingCommands()[0]!);
 expect(()=>core.flushOutbox(runner,()=>{throw new Error('GRANT_REVOKED');})).toThrow('GRANT_REVOKED');
 expect(core.pendingCommands()).toHaveLength(1);runner.close();
});

test('snapshot and policy transactions nest inside Core dispatch and final authorization',()=>{
 submit('a');const run=core.dispatch('bot',proposed=>{expect(core.snapshot().tasks[0]?.status).toBe('QUEUED');return prepareFake(proposed);})!;
 const runner=new FakeRuntime(join(dir,'runner.db'));
 core.flushOutbox(runner,()=>{expect(core.snapshot().runs[0]?.id).toBe(run.id);});
 expect(core.snapshot().runs[0]?.state).toBe('RUNNING');runner.close();
});

test('nested savepoint rollback removes only failed inner writes while outer preparation can commit',()=>{
 submit('a');core.database.exec('CREATE TABLE fixed_context(id TEXT PRIMARY KEY)');
 core.dispatch('bot',proposed=>{
  core.database.prepare('INSERT INTO fixed_context VALUES (?)').run('outer');
  expect(()=>transaction(core.database,()=>{core.database.prepare('INSERT INTO fixed_context VALUES (?)').run('inner');throw new Error('inner failure');})).toThrow('inner failure');
  return prepareFake(proposed);
 });
 expect(core.database.prepare('SELECT id FROM fixed_context').all().map(row=>row.id)).toEqual(['outer']);
});
