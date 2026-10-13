import { RunnerSpool,type SpoolLimits } from './spool.js';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalDigest } from '../../../packages/core/src/approvals.js';
import type { AsyncRunnerTransport,ExecutionCommand,RunnerReceipt } from '../../../packages/execution/src/contracts.js';
import type { RunnerDriverServices } from '../../../packages/contracts/src/runtime-driver.js';
export interface DurableRunnerOptions extends RunnerDriverServices { db:DatabaseSync;now?:()=>number;spoolLimits?:SpoolLimits; }
type ExecutionState='RECEIVED'|'CLAIMED'|'INVOKED'|'UNKNOWN'|'REJECTED';
interface CommandRow { payload:string;digest:string;receipt:string;state:ExecutionState; }
/** A dedicated Runner-owned database, not the Core database. ACK is persistence, never execution. */
export class DurableRunner implements AsyncRunnerTransport {
 readonly spool:RunnerSpool;
 private readonly db:DatabaseSync;
 constructor(private readonly options:DurableRunnerOptions){this.db=options.db;this.db.exec(`PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS runner_commands(id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL,receipt TEXT NOT NULL,state TEXT NOT NULL);CREATE UNIQUE INDEX IF NOT EXISTS runner_one_start ON runner_commands(json_extract(payload,'$.runId')) WHERE json_extract(payload,'$.type')='run.start';`);this.spool=new RunnerSpool(this.db,options.spoolLimits);}
 async receive(command:ExecutionCommand):Promise<RunnerReceipt>{
  const digest=canonicalDigest(command),old=this.row(command.commandId);if(old){if(old.digest!==digest)throw Error('COMMAND_CONFLICT');return JSON.parse(old.receipt);}
  this.validate(command);if(command.type==='run.start'&&this.db.prepare("SELECT 1 FROM runner_commands WHERE json_extract(payload,'$.runId')=? AND json_extract(payload,'$.type')='run.start'").get(command.runId))throw Error('RUN_ALREADY_CLAIMED');const receipt:RunnerReceipt={commandId:command.commandId,runId:command.runId,requestDigest:digest,state:'ACCEPTED'};
  this.db.exec('BEGIN IMMEDIATE');try{if(command.type==='run.start'||command.type==='message.send')this.spool.append({runId:command.runId,kind:'status',payload:{commandId:command.commandId,state:'ACCEPTED'}});
   this.db.prepare("INSERT INTO runner_commands VALUES(?,?,?,?,'RECEIVED')").run(command.commandId,JSON.stringify(command),digest,JSON.stringify(receipt));this.db.exec('COMMIT');return receipt;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 pendingCommands(limit=64):ExecutionCommand[]{if(!Number.isSafeInteger(limit)||limit<1||limit>256)throw Error('INVALID_RUNNER_LIMIT');return (this.db.prepare("SELECT payload FROM runner_commands WHERE state='RECEIVED' ORDER BY CASE WHEN json_extract(payload,'$.type') IN ('run.cancel','run.interrupt') THEN 0 ELSE 1 END,rowid LIMIT ?").all(limit) as {payload:string}[]).map(row=>JSON.parse(row.payload));}
 async query(commandId:string):Promise<RunnerReceipt|null>{const row=this.row(commandId);return row?JSON.parse(row.receipt):null;}
 executionState(id:string):ExecutionState|null {const state=this.row(id)?.state;return state==='CLAIMED'?'UNKNOWN':state??null;}
 async execute(id:string):Promise<void>{
  const row=this.row(id);if(!row)throw Error('COMMAND_NOT_FOUND');if(row.state!=='RECEIVED')return;
  // Claim before any async preparation. A crash on either side of invocation is never replayed.
  if(!this.db.prepare("UPDATE runner_commands SET state='CLAIMED' WHERE id=? AND state='RECEIVED'").run(id).changes)return;
  const command=JSON.parse(row.payload) as ExecutionCommand;let invoked=false;
  try{this.validate(command);const stop=command.type==='run.cancel'||command.type==='run.interrupt';if(!stop)this.authorize(command);
   const invoke=await this.options.prepare(command);this.validate(command);if(!stop)this.authorize(command);
   invoked=true;await invoke();this.db.prepare("UPDATE runner_commands SET state='INVOKED' WHERE id=?").run(id);
  }catch{this.db.prepare('UPDATE runner_commands SET state=? WHERE id=?').run(invoked?'UNKNOWN':'REJECTED',id);}
 }
 private authorize(command:ExecutionCommand):void{const result:unknown=this.options.authorizeNow(command);if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});throw Error('INVALID_AUTHORITY_CHECK');}}
 private row(id:string):CommandRow|undefined{return this.db.prepare('SELECT * FROM runner_commands WHERE id=?').get(id) as unknown as CommandRow|undefined;}
 private validate(c:ExecutionCommand):void{
  const allowed=['commandId','type','runId','botId','taskId','taskRevision','fencingToken','generation','sessionId','turnId','expiresAt','contextManifestRef','resolvedConnectionRef','messageId','intent','text','protocolVersion','executionBinding'];
  if(Object.keys(c).some(k=>!allowed.includes(k))||c.protocolVersion!==2||!c.executionBinding||!['run.start','run.cancel','run.interrupt','message.send'].includes(c.type))throw Error('INVALID_RUNNER_COMMAND');
  const b=c.executionBinding;const bindingStrings=['nodeId','sandboxId','transportInstanceId','processInstanceId','runId','sessionId','turnId'] as const;const bindingNumbers=['generation','fencingToken'] as const;if(Object.keys(b).some(k=>![...bindingStrings,...bindingNumbers].includes(k as never))||bindingStrings.some(k=>typeof b[k]!=='string'||!b[k].trim())||bindingNumbers.some(k=>!Number.isSafeInteger(b[k])||b[k]<1)||['taskRevision','generation','fencingToken'].some(k=>!Number.isSafeInteger(c[k as 'taskRevision'])||c[k as 'taskRevision']<1))throw Error('INVALID_RUNNER_COMMAND');if(b.runId!==c.runId||b.generation!==c.generation||b.fencingToken!==c.fencingToken||b.sessionId!==c.sessionId||b.turnId!==c.turnId)throw Error('STALE_EXECUTION_BINDING');
  if(['commandId','runId','botId','taskId','sessionId','turnId','contextManifestRef','resolvedConnectionRef'].some(k=>typeof c[k as keyof ExecutionCommand]!=='string'||!c[k as keyof ExecutionCommand]))throw Error('INVALID_RUNNER_COMMAND');
  if(c.type==='message.send'&&(!c.messageId||!['discussion','supplement'].includes(c.intent??'')||typeof c.text!=='string'||!c.text.trim()||Buffer.byteLength(c.text)>64*1024))throw Error('INVALID_RUNNER_COMMAND');
  if(!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=(this.options.now??Date.now)())throw Error('EXPIRED');
 }
}

/** Bounded guest scheduler: persisted RECEIVED work is queued on disk, never in an unbounded JS queue. */
export class ScheduledRunner implements AsyncRunnerTransport {
 private readonly active=new Set<string>();private normalActive=0;private stopActive=0;private scheduled=false;private closed=false;
 constructor(private readonly runner:DurableRunner,private readonly maxNormal=8){if(!Number.isSafeInteger(maxNormal)||maxNormal<1||maxNormal>64)throw Error('INVALID_RUNNER_LIMIT');this.wake();}
 async receive(command:ExecutionCommand):Promise<RunnerReceipt>{if(this.closed)throw Error('RUNNER_CLOSED');const receipt=await this.runner.receive(command);this.wake();return receipt;}
 query(commandId:string):Promise<RunnerReceipt|null>{return this.runner.query(commandId);}
 /** Stops scheduling only; the Node still owns process-stop/isolation evidence. */
 stopScheduling():void{this.closed=true;}
 private wake():void{if(this.closed||this.scheduled)return;this.scheduled=true;setImmediate(()=>{this.scheduled=false;if(this.closed)return;for(const command of this.runner.pendingCommands(64)){const stop=command.type==='run.cancel'||command.type==='run.interrupt';if(this.active.has(command.commandId)||(stop?this.stopActive>=1:this.normalActive>=this.maxNormal))continue;this.active.add(command.commandId);if(stop)this.stopActive++;else this.normalActive++;void this.runner.execute(command.commandId).catch(()=>{/* durable journal/UNKNOWN remains the recovery authority */}).finally(()=>{this.active.delete(command.commandId);if(stop)this.stopActive--;else this.normalActive--;this.wake();});}});}
}
