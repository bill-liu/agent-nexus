import {afterEach,beforeEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {P0Application} from '../../packages/core/src/p0-application.js';

let directory:string;let app:P0Application;
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'an-p0-'));app=new P0Application(join(directory,'core.db'));app.command({type:'bot.create',commandId:'create',scope:{botId:'bot'},expectedVersion:0,name:'演示 Bot'},'local-user');});
afterEach(()=>{app.close();rmSync(directory,{recursive:true,force:true});});
function submit(id='task'){return app.command({type:'work.submit',commandId:`submit-${id}`,scope:{botId:'bot'},expectedVersion:1,taskId:id,text:'演示任务'},'local-user',false);}

test('composed dispatch freezes local context and named fake Connection before any execution',()=>{
 submit();const run=app.prepare('bot')!;
 expect(app.runtime.receipts()).toHaveLength(0);
 expect(app.context.get(run.contextManifestRef)).toMatchObject({runId:run.id,turnId:run.turnId,allowedProcessingLocations:['local']});
 expect(app.connections.snapshot(run.resolvedConnectionRef)).toMatchObject({connectionId:'p0-local-fake',runId:run.id,route:'local',billingSource:'local'});
 app.flush();expect(app.runtime.inspect(run.id)?.state).toBe('RUNNING');
 expect(app.core.snapshot().tasks[0]?.status).toBe('RUNNING');
});
test('Grant revoked between prepare and dispatch prevents all Runtime effects',()=>{
 submit();const run=app.prepare('bot')!;const snapshot=app.connections.snapshot(run.resolvedConnectionRef);
 app.grants.revoke(snapshot.grantId,snapshot.grantRevision);
 expect(()=>app.flush()).toThrow('GRANT_REVOKED');expect(app.runtime.receipts()).toHaveLength(0);
 expect(app.core.snapshot().runs[0]?.slotHeld).toBe(true);
});
test('revoked asset cannot be used through an already frozen context',()=>{
 app.assets.import({id:'private',kind:'knowledge',title:'私密资料',source:'test',content:'不可外发'});
 app.bindings.bind('private',{projectId:'p0-project',botId:'bot'});
 submit();app.prepare('bot');app.bindings.revoke('private',{projectId:'p0-project',botId:'bot'});
 expect(()=>app.flush()).toThrow('ASSET_ACCESS_DENIED');expect(app.runtime.receipts()).toHaveLength(0);
});
test('failed preparation rolls back context and keeps the submitted task queued',()=>{
 const grant=app.grants.get('p0-grant:bot');app.grants.revoke(grant.id,grant.revision);submit();
 expect(()=>app.prepare('bot')).toThrow('GRANT_REVOKED');
 expect(app.core.snapshot().runs).toHaveLength(0);expect(app.core.snapshot().tasks[0]?.status).toBe('QUEUED');
 expect(app.core.database.prepare('SELECT COUNT(*) AS n FROM assets_context').get()?.n).toBe(0);
});
test('duplicate submission has one run and cancellation needs an observed fake exit',()=>{
 submit();app.pump();submit();app.pump();expect(app.core.snapshot().runs).toHaveLength(1);
 const run=app.core.snapshot().runs[0]!;
 app.command({type:'run.cancel',commandId:'cancel',scope:{botId:'bot'},expectedVersion:run.version,runId:run.id},'local-user');
 expect(app.runtime.inspect(run.id)).toMatchObject({state:'EXITED',slotHeld:false});
 expect(app.core.snapshot().tasks[0]?.status).toBe('CANCELLED');
});
test('untrusted actor cannot create a Bot or acquire its fake grant',()=>{
 expect(()=>app.command({type:'bot.create',commandId:'foreign',scope:{botId:'other'},expectedVersion:0,name:'Other'},'intruder')).toThrow('UNAUTHORIZED_SUBJECT');
 expect(app.core.snapshot().bots).toHaveLength(1);expect(()=>app.grants.get('p0-grant:other')).toThrow('GRANT_REQUIRED');
});
test('reopening reconciles fake receipts and retains one Bot write slot',()=>{
 submit();app.pump();const first=app.core.snapshot().runs[0]!;app.close();app=new P0Application(join(directory,'core.db'));
 expect(app.core.snapshot().runs[0]).toMatchObject({id:first.id,state:'RUNNING',slotHeld:true});
 submit('second');app.pump();expect(app.core.snapshot().runs).toHaveLength(1);
 expect(app.core.snapshot().tasks.find(t=>t.id==='second')?.status).toBe('QUEUED');
});
test('reopening reconciles durable fake exit proof without inventing successful completion',()=>{
 submit();app.pump();const run=app.core.snapshot().runs[0]!;app.runtime.exit(run.id,17);app.close();
 app=new P0Application(join(directory,'core.db'));
 expect(app.core.snapshot().runs[0]).toMatchObject({state:'EXITED',slotHeld:false});
 expect(app.core.snapshot().tasks[0]?.status).toBe('FAILED');
 submit('next');app.pump();expect(app.core.snapshot().runs).toHaveLength(2);
});
test('scheduler failure after accepted submission preserves retry identity',()=>{
 const grant=app.grants.get('p0-grant:bot');app.grants.revoke(grant.id,grant.revision);
 const input={type:'work.submit',commandId:'retry-accepted',scope:{botId:'bot'},expectedVersion:1,taskId:'accepted',text:'已受理但执行受阻'};
 expect(()=>app.command(input,'local-user')).toThrow('RESULT_UNKNOWN');
 expect(()=>app.command(input,'local-user')).toThrow('RESULT_UNKNOWN');
 expect(app.core.snapshot().tasks).toHaveLength(1);expect(app.core.snapshot().tasks[0]?.status).toBe('QUEUED');
});
test('startup resumes accepted queued work without another business command',()=>{
 submit();app.close();app=new P0Application(join(directory,'core.db'));
 expect(app.core.snapshot().tasks[0]?.status).toBe('RUNNING');expect(app.runtime.receipts()).toHaveLength(1);
});
test('startup authorization failure keeps Core readable with an explicit blocked reason',()=>{
 submit();const grant=app.grants.get('p0-grant:bot');app.grants.revoke(grant.id,grant.revision);app.close();
 app=new P0Application(join(directory,'core.db'));
 expect(app.snapshot().schedulerError).toBe('GRANT_REVOKED');
 expect(app.snapshot().tasks[0]?.status).toBe('QUEUED');expect(app.runtime.receipts()).toHaveLength(0);
});
