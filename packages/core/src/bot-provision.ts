import type { DatabaseSync } from 'node:sqlite';
import { canonicalManifest, hashBytes, type DownloadManager, type SignedManifest } from '../../catalog-client/src';
import type { SandboxProvider, SandboxObservation, SandboxRef, EvidenceKind } from '../../contracts/src/sandbox';

/** Root migration owner installs this table on the existing Core DB. No second database. */
export { BOT_PROVISION_SCHEMA } from '../../persistence/src/p1-schema.js';
export interface ProvisionRequest {operationId:string;botId:string;sandboxId:string;envelope:SignedManifest}
export interface ProvisionRecord {
 operationId:string;botId:string;sandboxId:string;generation:number;stage:'registered'|'creating'|'downloading'|'environment-ready'|'blocked'|'ready';
 downloadOperationId?:string;readinessObservedAt?:number;readiness:{environment:boolean;runner:boolean;runtime:boolean;auth:boolean};liveReady:boolean;evidenceKind:EvidenceKind;errorCode?:string;
}
export interface ReadinessObservation {
 sandboxId:string;generation:number;environment:boolean;runner:boolean;runtime:boolean;auth:boolean;evidenceKind:EvidenceKind;protocolVersion:2;observedAt:number;
}
export interface ProvisionRegistration {operationId:string;botId:string;sandboxId:string}
export function inspectProvision(db:DatabaseSync,operationId:string):ProvisionRecord {
 const row=db.prepare('SELECT record FROM bot_provision WHERE operation_id=?').get(operationId);
 if(!row)throw new Error('PROVISION_NOT_FOUND');return JSON.parse(String(row.record));
}
/** Durable blocked intent, usable before any provider, source, target or device authorization exists. */
export function registerProvision(db:DatabaseSync,input:ProvisionRegistration):ProvisionRecord {
 if(Object.values(input).some(value=>typeof value!=='string'||!value||value.length>256))throw new Error('INVALID_PROVISION_REGISTRATION');
 const digest=hashBytes(canonicalManifest(input));
 const existing=db.prepare('SELECT operation_id,request_digest,record FROM bot_provision WHERE operation_id=? OR bot_id=?').get(input.operationId,input.botId);
 if(existing){const record=JSON.parse(String(existing.record)) as ProvisionRecord;if(record.operationId!==input.operationId||record.botId!==input.botId||record.sandboxId!==input.sandboxId)throw new Error('PROVISION_IDEMPOTENCY_CONFLICT');return record;}
 if(!db.prepare('SELECT id FROM bot WHERE id=?').get(input.botId))throw new Error('BOT_NOT_FOUND');
 const record:ProvisionRecord={...input,generation:0,stage:'registered',readiness:{environment:false,runner:false,runtime:false,auth:false},liveReady:false,evidenceKind:'scripted',errorCode:'PROVISION_AUTHORIZATION_REQUIRED'};
 db.prepare('INSERT INTO bot_provision VALUES(?,?,?,?)').run(input.operationId,input.botId,digest,JSON.stringify(record));return record;
}
/** This service and its observation callback belong to trusted Core composition, never renderer input. */
export class BotProvisioner {
 private readonly pending=new Map<string,Promise<ProvisionRecord>>();
 constructor(private readonly db:DatabaseSync,private readonly provider:SandboxProvider,private readonly downloads:DownloadManager) {}
 inspect(operationId:string):ProvisionRecord {
  return inspectProvision(this.db,operationId);
 }
 private save(record:ProvisionRecord):ProvisionRecord {this.db.prepare('UPDATE bot_provision SET record=? WHERE operation_id=?').run(JSON.stringify(record),record.operationId);return structuredClone(record);}
 provision(request:ProvisionRequest):Promise<ProvisionRecord> {
  const digest=hashBytes(canonicalManifest(request));
  const existing=this.db.prepare('SELECT operation_id,request_digest FROM bot_provision WHERE operation_id=? OR bot_id=?').get(request.operationId,request.botId);
  if(existing && existing.operation_id===request.operationId && this.inspect(request.operationId).stage==='registered') {
   const record=this.inspect(request.operationId);
   if(record.botId!==request.botId||record.sandboxId!==request.sandboxId)return Promise.reject(new Error('PROVISION_IDEMPOTENCY_CONFLICT'));
   record.stage='creating';delete record.errorCode;
   this.db.prepare('UPDATE bot_provision SET request_digest=?,record=? WHERE operation_id=? AND request_digest=?').run(digest,JSON.stringify(record),request.operationId,existing.request_digest);
   existing.request_digest=digest;
  }
  if(existing && (existing.operation_id!==request.operationId || existing.request_digest!==digest)) return Promise.reject(new Error('PROVISION_IDEMPOTENCY_CONFLICT'));
  if(!existing) {
   if(!this.db.prepare('SELECT id FROM bot WHERE id=?').get(request.botId)) return Promise.reject(new Error('BOT_NOT_FOUND'));
   const record:ProvisionRecord={operationId:request.operationId,botId:request.botId,sandboxId:request.sandboxId,generation:0,stage:'creating',readiness:{environment:false,runner:false,runtime:false,auth:false},liveReady:false,evidenceKind:'scripted'};
   this.db.prepare('INSERT INTO bot_provision VALUES(?,?,?,?)').run(request.operationId,request.botId,digest,JSON.stringify(record));
  }
  const pending=this.pending.get(request.operationId); if(pending) return pending;
  const work=this.perform(request).finally(()=>this.pending.delete(request.operationId));this.pending.set(request.operationId,work);return work;
 }
 private async perform(request:ProvisionRequest):Promise<ProvisionRecord> {
  let record=this.inspect(request.operationId);
  if(record.stage==='environment-ready'||record.stage==='ready') return record;
  try {
   // A deterministic create operation is replayed after crash; provider must persist its receipt.
   if(record.stage==='creating' || (record.stage==='blocked'&&!record.downloadOperationId)) {
    const observed=await this.provider.create({operationId:request.operationId,botId:request.botId,sandboxId:request.sandboxId});
    if(observed.sandboxId!==request.sandboxId || !['created','stopped'].includes(observed.state)) throw new Error('PROVISION_SANDBOX_MISMATCH');
    record.generation=observed.generation;record.evidenceKind=observed.evidenceKind;
    record.downloadOperationId=this.downloads.start({commandId:`${request.operationId}:download`,idempotencyKey:request.operationId,botId:request.botId,envelope:request.envelope}).operationId;
    record.stage='downloading';this.save(record);
   }
   const status=await this.downloads.resume(record.downloadOperationId!);
   if(status.state!=='ready') throw new Error('PROVISION_DOWNLOAD_INCOMPLETE');
   record.readiness.environment=true;record.stage='environment-ready';delete record.errorCode;return this.save(record);
  } catch(error) {record.stage='blocked';record.liveReady=false;record.errorCode='PROVISION_BLOCKED';this.save(record);throw error;}
 }
 /** Attach an already installed environment only after live helper reconciliation and trusted installed-file/Node validation. */
 adoptInstalled(operationId:string,ref:SandboxRef,verifyInstalled:(observation:SandboxObservation)=>Promise<void>):Promise<ProvisionRecord> {
  if(this.pending.has(operationId))return Promise.reject(new Error('PROVISION_BUSY'));
  const work=(async()=>{
   const record=this.inspect(operationId);
   if(ref.sandboxId!==record.sandboxId||!Number.isSafeInteger(ref.generation)||ref.generation<record.generation||ref.generation<1)throw new Error('STALE_SANDBOX');
   record.liveReady=false;record.readiness={environment:false,runner:false,runtime:false,auth:false};delete record.readinessObservedAt;record.stage='blocked';record.errorCode='INSTALLED_VALIDATION_REQUIRED';this.save(record);
   const validate=(observation:SandboxObservation)=>{if(observation.protocolVersion!==1||observation.sandboxId!==record.sandboxId||observation.evidenceKind!=='live'||observation.state!=='running'||!Number.isSafeInteger(observation.generation)||observation.generation<record.generation||observation.generation<1||!Number.isFinite(observation.observedAt)||Math.abs(Date.now()-observation.observedAt)>30000)throw new Error('INSTALLED_SANDBOX_UNCONFIRMED');};
   const before=await this.provider.inspect(ref);validate(before);if(before.generation!==ref.generation)throw new Error('STALE_SANDBOX');
   await verifyInstalled(structuredClone(before));
   const after=await this.provider.inspect({sandboxId:record.sandboxId,generation:before.generation});validate(after);
   if(after.generation!==before.generation)throw new Error('STALE_SANDBOX');
   record.generation=after.generation;record.evidenceKind='live';record.readiness.environment=true;record.stage='environment-ready';delete record.errorCode;return this.save(record);
  })().finally(()=>this.pending.delete(operationId));this.pending.set(operationId,work);return work;
 }
 observeReadiness(operationId:string,observation:ReadinessObservation):ProvisionRecord {
  const record=this.inspect(operationId);
  if(observation.sandboxId!==record.sandboxId || observation.generation!==record.generation) throw new Error('STALE_SANDBOX');
  if(observation.protocolVersion!==2 || !Number.isFinite(observation.observedAt) || Math.abs(Date.now()-observation.observedAt)>30_000) throw new Error('STALE_READINESS');
  const live=observation.evidenceKind==='live'&&record.evidenceKind==='live';
  record.readiness={environment:record.readiness.environment&&observation.environment,runner:live&&observation.runner,runtime:live&&observation.runtime,auth:live&&observation.auth};
  record.readinessObservedAt=observation.observedAt;record.liveReady=live&&Object.values(record.readiness).every(Boolean);record.stage=record.liveReady?'ready':'environment-ready';return this.save(record);
 }
}
