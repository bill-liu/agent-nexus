import {it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {coreSchema} from '../../packages/persistence/src/schema.js';
import {migrateCore} from '../../packages/persistence/src/migrations.js';
import {ApprovalService} from '../../packages/core/src/approvals.js';
function legacy(version:1|2){
 const db=new DatabaseSync(':memory:');
 db.exec(coreSchema.replace("('schema_version',3)",`('schema_version',${version})`).replace(",'SUCCEEDED'",''));
 db.exec(`UPDATE core_metadata SET value=${version} WHERE key='schema_version';
 INSERT INTO bot VALUES('bot','Existing','owner',7,1,0,'sandbox',2);
 INSERT INTO task VALUES('task','bot','Existing task',3,'RUNNING');
 INSERT INTO bot_inbox(position,task_id,bot_id,state) VALUES(11,'task','bot','CLAIMED');
 INSERT INTO run VALUES('run','bot','task',3,'start',9,2,4,9999999999999,'session','turn','RUNNING',1,5,0,NULL,NULL,'context','connection');
 INSERT INTO outbox_event(id,type,payload,command_id,delivered,occurred_at) VALUES(13,'run.start','{}','start',0,100);
 INSERT INTO command_receipt VALUES('create','digest','{}');
 INSERT INTO message VALUES('message','bot','task',3,'run','session','turn','kept','supplement','RECEIVED',NULL);`);
 if(version===1)db.exec('DROP TABLE run_execution_binding');
 else db.prepare('INSERT INTO run_execution_binding VALUES(?,?,?)').run('run',2,'{"kept":true}');
 new ApprovalService(db,{trustedActor:()=> 'owner',authorizeDecision:()=>true,revalidate:()=>true});
 db.prepare('INSERT INTO approval_requests(id,payload,request_hash,parameter_digest,status) VALUES(?,?,?,?,?)').run('approval','{"binding":{"taskId":"task"}}','digest','digest','PENDING');
 return db;
}
it.each([1,2] as const)('populated v%s migrates atomically to v3, retaining Core authority and pending state',version=>{
 const db=legacy(version);try{
 const before=new Map(['bot','task','bot_inbox','run','outbox_event','command_receipt','message','approval_requests'].map(t=>[t,db.prepare(`SELECT * FROM ${t}`).all()]));
 migrateCore(db);expect(db.prepare("SELECT value FROM core_metadata WHERE key='schema_version'").get()?.value).toBe(3);
 for(const [table,rows] of before)expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
 expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
 for(const t of ['bot_provision','p1_bot_configuration','p1_run_request','p1_desktop_command','task_acceptance','evaluation'])expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)?.name).toBe(t);
 if(version===2)expect(db.prepare('SELECT binding FROM run_execution_binding').get()?.binding).toBe('{"kept":true}');
 db.prepare("UPDATE task SET status='SUCCEEDED' WHERE id='task'").run();
 db.prepare('INSERT INTO evaluation VALUES(?,?,?,?,?)').run('e','task','{}','digest',1);migrateCore(db);
 expect(db.prepare('SELECT status FROM task').get()?.status).toBe('SUCCEEDED');
 expect(()=>db.prepare("UPDATE evaluation SET report='changed'").run()).toThrow('IMMUTABLE_EVIDENCE');
 }finally{db.close();}
});
it('broken pre-existing FK rolls migration back and restores enforcement',()=>{
 const db=legacy(2);try{db.exec("PRAGMA foreign_keys=OFF;UPDATE task SET bot_id='missing'");
 expect(()=>migrateCore(db)).toThrow('CORE_MIGRATION_FOREIGN_KEY_VIOLATION');
 expect(db.prepare("SELECT value FROM core_metadata WHERE key='schema_version'").get()?.value).toBe(2);
 expect(db.prepare('SELECT bot_id FROM task').get()?.bot_id).toBe('missing');
 expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
 expect(db.prepare("SELECT name FROM sqlite_master WHERE name='evaluation'").get()).toBeUndefined();
 }finally{db.close();}
});
it('failed migration lock acquisition restores foreign-key enforcement',async()=>{
 const {mkdtempSync,rmSync,realpathSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'an-migration-lock-')),path=join(dir,'core.sqlite');const db=new DatabaseSync(path);db.exec(coreSchema);db.exec("UPDATE core_metadata SET value=2 WHERE key='schema_version';PRAGMA journal_mode=WAL");const other=new DatabaseSync(path);other.exec('BEGIN IMMEDIATE');
 try{expect(()=>migrateCore(db)).toThrow();expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);expect(db.prepare("SELECT value FROM core_metadata WHERE key='schema_version'").get()?.value).toBe(2);}
 finally{other.exec('ROLLBACK');other.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
