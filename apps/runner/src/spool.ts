import type { DatabaseSync } from 'node:sqlite';
import { canonicalDigest } from '../../../packages/core/src/approvals.js';
export interface SpoolInput { runId:string;kind:'status'|'approval'|'terminal';payload:Record<string,string|number|boolean|null>; }
export interface SpoolEntry extends SpoolInput { cursor:number; }
export interface SpoolLimits { maxEntries:number;maxBytes:number;reservedEntries:number; }
/** Durable metadata spool. Raw CLI logs/auth/input are deliberately not accepted here. */
export class RunnerSpool {
 private readonly capacityListeners=new Set<()=>void>();
 onCapacityAvailable(listener:()=>void):()=>void{this.capacityListeners.add(listener);return()=>{this.capacityListeners.delete(listener);};}
 constructor(private readonly db:DatabaseSync,private readonly limits:SpoolLimits={maxEntries:1000,maxBytes:1024*1024,reservedEntries:64}) {
  if(!Number.isSafeInteger(limits.maxEntries)||limits.maxEntries<1||!Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<1||!Number.isSafeInteger(limits.reservedEntries)||limits.reservedEntries<0||limits.reservedEntries>=limits.maxEntries)throw Error('INVALID_SPOOL_LIMITS');
  db.exec(`CREATE TABLE IF NOT EXISTS runner_spool(cursor INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL,bytes INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS runner_spool_cursor(id INTEGER PRIMARY KEY CHECK(id=1),ack INTEGER NOT NULL,head INTEGER NOT NULL);INSERT OR IGNORE INTO runner_spool_cursor VALUES(1,0,0);`);
 }
 append(input:SpoolInput):number {
  canonicalDigest(input);
  if(!input.runId||!['status','approval','terminal'].includes(input.kind)||Object.keys(input).some(k=>!['runId','kind','payload'].includes(k))||!input.payload||Array.isArray(input.payload)||Object.values(input.payload).some(v=>v!==null&&!['string','number','boolean'].includes(typeof v)))throw Error('INVALID_SPOOL_ENTRY');
  const payload=JSON.stringify(input),bytes=Buffer.byteLength(payload),ownsTransaction=!this.db.isTransaction;if(ownsTransaction)this.db.exec('BEGIN IMMEDIATE');
  try { const used=this.db.prepare('SELECT COUNT(*) AS entries,COALESCE(SUM(bytes),0) AS bytes FROM runner_spool').get() as {entries:number;bytes:number};
   const cap=input.kind==='status'?this.limits.maxEntries-this.limits.reservedEntries:this.limits.maxEntries;
   // Reserve proportional byte capacity as well as entry slots for terminal/approval metadata.
   const byteCap=input.kind==='status'?Math.floor(this.limits.maxBytes*(this.limits.maxEntries-this.limits.reservedEntries)/this.limits.maxEntries):this.limits.maxBytes;
   if(used.entries>=cap||used.bytes+bytes>byteCap)throw Error('SPOOL_BACKPRESSURE');
   const cursor=Number(this.db.prepare('INSERT INTO runner_spool(payload,bytes) VALUES(?,?)').run(payload,bytes).lastInsertRowid);this.db.prepare('UPDATE runner_spool_cursor SET head=? WHERE id=1').run(cursor);if(ownsTransaction)this.db.exec('COMMIT');return cursor;
  }catch(error){if(ownsTransaction)this.db.exec('ROLLBACK');throw error;}
 }
 replayAvailable(limit=100):SpoolEntry[]{const row=this.db.prepare('SELECT ack FROM runner_spool_cursor WHERE id=1').get() as {ack:number};return this.replay(row.ack,limit);}
 replay(after:number,limit=100):SpoolEntry[]{
  const row=this.db.prepare('SELECT ack,head FROM runner_spool_cursor WHERE id=1').get() as {ack:number;head:number};
  if(!Number.isSafeInteger(after)||after<row.ack||after>row.head||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error('INVALID_CURSOR');
  return (this.db.prepare('SELECT cursor,payload FROM runner_spool WHERE cursor>? ORDER BY cursor LIMIT ?').all(after,limit) as {cursor:number;payload:string}[]).map(r=>({...JSON.parse(r.payload),cursor:r.cursor}));
 }
 acknowledge(cursor:number):void{
  this.db.exec('BEGIN IMMEDIATE');try{const row=this.db.prepare('SELECT ack,head FROM runner_spool_cursor WHERE id=1').get() as {ack:number;head:number};if(!Number.isSafeInteger(cursor)||cursor<row.ack||cursor>row.head)throw Error('INVALID_CURSOR');this.db.prepare('DELETE FROM runner_spool WHERE cursor<=?').run(cursor);this.db.prepare('UPDATE runner_spool_cursor SET ack=? WHERE id=1').run(cursor);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  for(const listener of this.capacityListeners){try{listener();}catch{/* ACK is committed; pending publication remains durable. */}}
 }
}
