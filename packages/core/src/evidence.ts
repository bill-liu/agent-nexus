import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, transaction } from '../../persistence/src/unit-of-work.js';
import { validateEvidenceRecord, validateVerificationInput, type EvidenceAuthority, type EvidenceRecord, type VerificationInput } from '../../contracts/src/evidence.js';
const evidenceDigest = (record: EvidenceRecord): string => { const { reportDigest: _, ...body } = record; return createHash('sha256').update(canonicalJson(body)).digest('hex'); };

interface CoreAuthority { readonly database: DatabaseSync; readonly epoch: number }
interface Continuation { evidenceId: string; inputCandidateDigest: string }
const bindingKeys: (keyof VerificationInput)[] = ['taskId','taskRevision','candidateDigest','immutableSnapshotRef','contractDigest','verifierVersion','oracleDigest','stage','executionKind','platform','capabilities'];
const bindingOf = (record: EvidenceRecord): VerificationInput => Object.fromEntries([...bindingKeys.map(k => [k,record[k]]),...(record.continuation ? [['continuation',record.continuation]] : [])]) as unknown as VerificationInput;

/** Trusted Core-only service. Never expose freezeAcceptance or the issuer through
 * generic IPC; its inputs come from the coordinator's frozen task/candidate state. */
export class CoreEvidenceService {
 private readonly db: DatabaseSync;
 constructor(private readonly core: CoreAuthority, private readonly issuer: EvidenceAuthority) { this.db=core.database; }
 private own(): void { if (this.db.prepare("SELECT value FROM core_metadata WHERE key='epoch'").get()?.value !== this.core.epoch) throw new Error('STALE_CORE_EPOCH'); }
 private write<T>(action: () => T): T { return transaction(this.db,()=>{this.own();return action();}); }
 private task(id: string) {
  const row=this.db.prepare('SELECT id,bot_id,revision,status FROM task WHERE id=?').get(id);
  if(!row) throw new Error('TASK_NOT_FOUND'); return row;
 }
 private report(id: string): EvidenceRecord {
  const row=this.db.prepare('SELECT report,report_digest FROM evaluation WHERE id=?').get(id);
  if(!row) throw new Error('EVIDENCE_NOT_FOUND');
  const record: unknown=JSON.parse(String(row.report)); validateEvidenceRecord(record);
  if(record.id!==id || evidenceDigest(record)!==row.report_digest || record.reportDigest!==row.report_digest) throw new Error('TAMPERED_EVIDENCE');
  return record;
 }
 freezeAcceptance(input: VerificationInput, continuation?: Continuation): void {
  validateVerificationInput(input);
  this.write(()=>{
   const task=this.task(input.taskId);
   if(task.revision!==input.taskRevision) throw new Error('STALE_EVIDENCE');
   if(task.status!=='VERIFYING') throw new Error('TASK_NOT_VERIFYING');
   if(input.stage==='B') {
    if(!continuation) throw new Error('CONTINUATION_REQUIRED');
    if(input.continuation?.evidenceId!==continuation.evidenceId || input.continuation?.candidateDigest!==continuation.inputCandidateDigest) throw new Error('CONTINUATION_MISMATCH');
    const prior=this.report(continuation.evidenceId); const priorTask=this.task(prior.taskId);
    const acceptance=this.db.prepare('SELECT accepted_evidence_id,binding FROM task_acceptance WHERE task_id=?').get(prior.taskId);
    if(input.continuation?.immutableSnapshotRef!==prior.immutableSnapshotRef || priorTask.revision!==prior.taskRevision || acceptance?.binding!==canonicalJson(bindingOf(prior)) || prior.stage!=='A' || prior.status!=='PASS' || priorTask.status!=='SUCCEEDED' || priorTask.bot_id!==task.bot_id || acceptance?.accepted_evidence_id!==prior.id || prior.candidateDigest!==continuation.inputCandidateDigest || prior.executionKind!==input.executionKind) throw new Error('CONTINUATION_MISMATCH');
   } else if(continuation) throw new Error('UNEXPECTED_CONTINUATION');
   this.db.prepare(`INSERT INTO task_acceptance(task_id,binding,input_evidence_id,input_candidate_digest) VALUES (?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET binding=excluded.binding,input_evidence_id=excluded.input_evidence_id,input_candidate_digest=excluded.input_candidate_digest,accepted_evidence_id=NULL`)
    .run(input.taskId,canonicalJson(input),continuation?.evidenceId??null,continuation?.inputCandidateDigest??null);
  });
 }
 persist(record: EvidenceRecord): void {
  this.issuer.assertIssued(record);
  this.write(()=>{
   if(this.db.prepare('SELECT id FROM evaluation WHERE id=?').get(record.id)) throw new Error('EVIDENCE_ALREADY_STORED');
   this.task(record.taskId);
   this.db.prepare('INSERT INTO evaluation VALUES (?,?,?,?,?)').run(record.id,record.taskId,canonicalJson(record),record.reportDigest,Date.now());
  });
 }
 acceptCurrent(taskId: string, evidenceId: string): void {
  this.write(()=>{
   const task=this.task(taskId); const record=this.report(evidenceId);
   const current=this.db.prepare('SELECT binding,input_evidence_id,input_candidate_digest FROM task_acceptance WHERE task_id=?').get(taskId);
   if(!current || record.taskId!==taskId || task.revision!==record.taskRevision || current.binding!==canonicalJson(bindingOf(record))) throw new Error('STALE_EVIDENCE');
   if(task.status!=='VERIFYING') throw new Error('TASK_NOT_VERIFYING');
   if(record.stage==='B') {
    if(!current.input_evidence_id) throw new Error('STALE_UPSTREAM_EVIDENCE');
    const upstream=this.report(String(current.input_evidence_id)); const upstreamTask=this.task(upstream.taskId);
    const upstreamAcceptance=this.db.prepare('SELECT binding,accepted_evidence_id FROM task_acceptance WHERE task_id=?').get(upstream.taskId);
    if(upstreamTask.revision!==upstream.taskRevision || upstreamTask.status!=='SUCCEEDED' || upstreamTask.bot_id!==task.bot_id || upstream.candidateDigest!==current.input_candidate_digest || upstreamAcceptance?.accepted_evidence_id!==upstream.id || upstreamAcceptance?.binding!==canonicalJson(bindingOf(upstream))) throw new Error('STALE_UPSTREAM_EVIDENCE');
    this.issuer.assertArtifacts(upstream);
   }
   if(this.db.prepare('SELECT id FROM run WHERE bot_id=? AND slot_held=1').get(task.bot_id)) throw new Error('ACTIVE_WRITER');
   if(record.status!=='PASS') throw new Error('ACCEPTANCE_FAILED');
   this.issuer.assertArtifacts(record);
   if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approval_requests'").get() && this.db.prepare("SELECT id FROM approval_requests WHERE json_extract(payload,'$.binding.taskId')=? AND status IN ('PENDING','APPROVED')").get(taskId)) throw new Error('PENDING_APPROVAL');
   this.db.prepare("UPDATE task SET status='SUCCEEDED' WHERE id=?").run(taskId);
   this.db.prepare('UPDATE task_acceptance SET accepted_evidence_id=? WHERE task_id=?').run(evidenceId,taskId);
   this.db.prepare('INSERT INTO outbox_event(type,payload,occurred_at) VALUES (?,?,?)').run('task.succeeded',canonicalJson({taskId,evidenceId,candidateDigest:record.candidateDigest,source:record.source}),Date.now());
  });
 }
 /** Safe read model: returns persisted evidence, never an issuer capability. */
 inspect(taskId: string): { current: VerificationInput | null; evidence: EvidenceRecord[] } {
  this.own(); this.task(taskId);
  const current=this.db.prepare('SELECT binding FROM task_acceptance WHERE task_id=?').get(taskId);
  return {current:current?JSON.parse(String(current.binding)):null,evidence:this.db.prepare('SELECT id FROM evaluation WHERE task_id=? ORDER BY stored_at,id').all(taskId).map(row=>this.report(String(row.id)))};
 }
}
