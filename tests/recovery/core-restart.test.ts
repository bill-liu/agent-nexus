import { prepareFake, authorizeFake } from './fixtures.js';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { CoreStore } from '../../packages/core/src/store.js';
import { FakeRuntime } from '../../packages/execution/src/fake-runtime.js';

let dir:string; let core:CoreStore;
beforeEach(() => {dir=mkdtempSync(join(tmpdir(),'an-restart-'));core=new CoreStore(join(dir,'core.db'));core.createBot({commandId:'create',botId:'bot',name:'Bot',subject:'user'}); for(const id of ['a','b']) core.submit({commandId:id,botId:'bot',taskId:id,text:id,expectedVersion:1,subject:'user'});});
afterEach(()=>{core.close();rmSync(dir,{recursive:true,force:true});});

test('restart fences old Core ownership and LOST retains the write slot until trusted exit evidence', () => {
 const old=core; const run=old.dispatch('bot',prepareFake)!;
 core=new CoreStore(join(dir,'core.db'));
 expect(()=>old.dispatch('bot',prepareFake)).toThrow('STALE_CORE_EPOCH');
 expect(core.snapshot().runs[0]?.state).toBe('LOST');
 core.reconcile(run.id,{kind:'unreachable',fencingToken:run.fencingToken});
 expect(core.dispatch('bot',prepareFake)).toBeNull();
 expect(()=>core.observeExit(run.id,run.fencingToken-1,{kind:'process-exit',exitCode:0,source:'fake-runner'})).toThrow('STALE_FENCING_TOKEN');
 core.observeExit(run.id,run.fencingToken,{kind:'process-exit',exitCode:0,source:'fake-runner'});
 expect(core.snapshot().tasks[0]?.status).toBe('VERIFYING');
 expect(core.dispatch('bot',prepareFake)?.taskId).toBe('b'); old.close();
});

test('crash before outbox send preserves exact Run and unexpired command for recovery', () => {
 const run=core.dispatch('bot',prepareFake)!; const cmd=core.pendingCommands()[0]!;
 core.close();core=new CoreStore(join(dir,'core.db'));
 expect(core.pendingCommands()[0]).toEqual(cmd); expect(core.snapshot().runs[0]?.id).toBe(run.id);
 expect(core.dispatch('bot',prepareFake)).toBeNull();
});

test('completion claim and expired lease never authorize success or release the writer', () => {
 const run=core.dispatch('bot',prepareFake)!;
 core.ingestRunEvent({runId:run.id,fencingToken:run.fencingToken,sequence:1,type:'agent.completed',payload:{status:'SUCCEEDED'}});
 expect(core.snapshot().tasks[0]?.status).toBe('RUNNING');
 core.expireLeases(Date.now()+120000);
 expect(core.snapshot().runs[0]?.state).toBe('LOST'); expect(core.dispatch('bot',prepareFake)).toBeNull();
 expect(()=>core.observeExit(run.id,run.fencingToken,{kind:'ack'} as never)).toThrow('EXIT_EVIDENCE_REQUIRED');
});

test('historical start receipt after restart cannot claim the process is still alive',()=>{
 const runner=new FakeRuntime(join(dir,'runner.db'));const run=core.dispatch('bot',prepareFake)!;
 runner.receive(core.pendingCommands()[0]!);core.close();core=new CoreStore(join(dir,'core.db'));
 core.flushOutbox(runner,authorizeFake);
 expect(core.snapshot().runs[0]?.state).toBe('LOST');
 core.ingestRunEvent({runId:run.id,fencingToken:run.fencingToken,sequence:1,type:'run.started',payload:{}});
 expect(core.snapshot().runs[0]?.state).toBe('LOST');
 core.reconcile(run.id,{kind:'alive',fencingToken:run.fencingToken});
 expect(core.snapshot().runs[0]?.state).toBe('RUNNING');runner.close();
});

test('SIGKILL after dispatch commit recovers the exact outbox command and retains exclusive write ownership',()=>{
 const entry=join(dir,'crash-core.mjs');
 buildSync({entryPoints:[join(process.cwd(),'packages/core/src/store.ts')],outfile:entry,bundle:true,platform:'node',format:'esm',target:'node24'});
 const child=spawnSync(process.execPath,['--input-type=module','-e',`
  import {CoreStore} from ${JSON.stringify(entry)};
  const core=new CoreStore(${JSON.stringify(join(dir,'core.db'))});
  const run=core.dispatch('bot',r=>({contextManifestRef:'fake-context:'+r.id,resolvedConnectionRef:'fake-connection:'+r.id}));
  process.stdout.write(JSON.stringify({run,command:core.pendingCommands()[0]}));
  process.kill(process.pid,'SIGKILL');
 `],{encoding:'utf8'});
 expect(child.signal).toBe('SIGKILL');const saved=JSON.parse(child.stdout) as {run:{id:string};command:unknown};
 core.close();core=new CoreStore(join(dir,'core.db'));
 expect(core.snapshot().runs[0]?.id).toBe(saved.run.id);expect(core.pendingCommands()[0]).toEqual(saved.command);
 expect(core.snapshot().runs[0]?.state).toBe('LOST');expect(core.dispatch('bot',prepareFake)).toBeNull();
});

test('SIGKILL in an unfinished SQLite write transaction cannot leave a half-enqueued task',()=>{
 const child=spawnSync(process.execPath,['--input-type=module','-e',`
  import {DatabaseSync} from 'node:sqlite';
  const db=new DatabaseSync(${JSON.stringify(join(dir,'core.db'))});
  db.exec("BEGIN IMMEDIATE; INSERT INTO task(id,bot_id,text,status) VALUES ('half','bot','half','QUEUED'); INSERT INTO bot_inbox(task_id,bot_id,state) VALUES ('half','bot','QUEUED');");
  process.kill(process.pid,'SIGKILL');
 `],{encoding:'utf8'});
 expect(child.signal).toBe('SIGKILL');core.close();core=new CoreStore(join(dir,'core.db'));
 expect(core.snapshot().tasks.map(t=>t.id)).toEqual(['a','b']);
 expect(core.database.prepare("SELECT count(*) AS n FROM bot_inbox WHERE task_id='half'").get()?.n).toBe(0);
});

test('Runner exit evidence survives SIGKILL before Core observes it and remains immutable on repeat',()=>{
 const runnerPath=join(dir,'runner.db');let runner=new FakeRuntime(runnerPath);
 const run=core.dispatch('bot',prepareFake)!;core.flushOutbox(runner,authorizeFake);
 const entry=join(dir,'crash-runner.mjs');
 buildSync({entryPoints:[join(process.cwd(),'packages/execution/src/fake-runtime.ts')],outfile:entry,bundle:true,platform:'node',format:'esm',target:'node24'});
 const child=spawnSync(process.execPath,['--input-type=module','-e',`
  import {FakeRuntime} from ${JSON.stringify(entry)};
  const runner=new FakeRuntime(${JSON.stringify(runnerPath)});
  process.stdout.write(JSON.stringify(runner.exit(${JSON.stringify(run.id)},0)));
  process.kill(process.pid,'SIGKILL');
 `],{encoding:'utf8'});
 expect(child.signal).toBe('SIGKILL');const original=JSON.parse(child.stdout);
 runner.close();core.close();runner=new FakeRuntime(runnerPath);core=new CoreStore(join(dir,'core.db'));
 const observed=runner.inspect(run.id)!;
 expect(observed.state).toBe('EXITED');expect(observed.exitEvidence).toEqual(original);
 expect(runner.exit(run.id,99)).toEqual(original);
 core.reconcile(run.id,{kind:'exited',fencingToken:run.fencingToken,evidence:observed.exitEvidence!});
 expect(core.snapshot().tasks[0]?.status).toBe('VERIFYING');expect(core.snapshot().runs[0]?.slotHeld).toBe(false);
 runner.close();
});
