import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CoreStore } from '../../packages/core/src/store.js';
import { CoreEvidenceService } from '../../packages/core/src/evidence.js';
import { VerificationWorker } from '../../apps/verification-worker/src/evidence.js';
import { evidenceDigest } from '../../apps/verification-worker/src/evidence.js';
import { oracleRoot, setup } from '../fixtures/p1-oracle/harness.js';
import { prepareFake } from '../recovery/fixtures.js';
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(f => f()); });
function fixture(control = 'task-a', stage: 'A' | 'B' = 'A') {
 const dir = mkdtempSync(join(realpathSync(tmpdir()), 'an-evidence-core-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
 const core = new CoreStore(join(dir, 'core.db')); cleanup.push(() => core.close());
 expect(core.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 core.createBot({commandId:'create',botId:'bot',name:'Bot',subject:'user'});
 core.submit({commandId:'task',taskId:'task',botId:'bot',text:'fixture',expectedVersion:1,subject:'user'});
 const run = core.dispatch('bot',prepareFake)!;
 core.observeExit(run.id,run.fencingToken,{source:'fake-runner',kind:'process-exit',exitCode:0});
 const h = setup(join(dir, 'fixture'),control,stage);
 const service = new CoreEvidenceService(core,h.worker);
 return { ...h, core, service, dir, run };
}
test('trusted_report_persists_before_same_core_task_success', async () => {
 const h = fixture(); h.service.freezeAcceptance(h.input);
 expect(h.core.snapshot().tasks[0].status).toBe('VERIFYING');
 const record = await h.worker.verifyCandidate(h.input);
 expect(() => h.service.acceptCurrent('task',record.id)).toThrow('EVIDENCE_NOT_FOUND');
 h.service.persist(record); h.service.acceptCurrent('task',record.id);
 expect(h.core.snapshot().tasks[0].status).toBe('SUCCEEDED');
 expect(h.core.database.prepare('SELECT count(*) AS n FROM evaluation').get()?.n).toBe(1);
 expect(() => h.service.persist(record)).toThrow('EVIDENCE_ALREADY_STORED');
 expect(() => h.core.database.prepare("UPDATE evaluation SET report='{}'").run()).toThrow('IMMUTABLE_EVIDENCE');
});
test('stale_contract_and_candidate_cannot_advance_current_task', async () => {
 const h = fixture(); h.service.freezeAcceptance(h.input); const r = await h.worker.verifyCandidate(h.input); h.service.persist(r);
 h.service.freezeAcceptance({...h.input,candidateDigest:'0'.repeat(64)});
 expect(() => h.service.acceptCurrent('task',r.id)).toThrow('STALE_EVIDENCE');
 h.service.freezeAcceptance({...h.input,contractDigest:'0'.repeat(64)});
 expect(() => h.service.acceptCurrent('task',r.id)).toThrow('STALE_EVIDENCE');
 h.service.freezeAcceptance(h.input); h.core.database.prepare('UPDATE task SET revision=revision+1').run();
 expect(() => h.service.acceptCurrent('task',r.id)).toThrow('STALE_EVIDENCE');
});
test('bot_forgery_and_mutated_issued_object_cannot_be_persisted', async () => {
 const h=fixture(); h.service.freezeAcceptance(h.input); const r=await h.worker.verifyCandidate(h.input);
 expect(() => h.service.persist({...r})).toThrow('UNTRUSTED_EVIDENCE');
 r.outputDigest='0'.repeat(64); r.reportDigest=evidenceDigest(r);
 expect(() => h.service.persist(r)).toThrow('UNTRUSTED_EVIDENCE');
});
test('synthetic_report_cannot_complete_live_acceptance', async () => {
 const h=fixture(); h.service.freezeAcceptance({...h.input,executionKind:'live'}); const r=await h.worker.verifyCandidate(h.input); h.service.persist(r);
 expect(() => h.service.acceptCurrent('task',r.id)).toThrow('STALE_EVIDENCE');
 expect(h.core.snapshot().tasks[0].status).toBe('VERIFYING');
});
test('active_writer_and_old_core_epoch_cannot_complete', async () => {
 const h=fixture(); h.service.freezeAcceptance(h.input); const r=await h.worker.verifyCandidate(h.input); h.service.persist(r);
 h.core.database.prepare('UPDATE run SET slot_held=1').run();
 expect(() => h.service.acceptCurrent('task',r.id)).toThrow('ACTIVE_WRITER');
 h.core.database.prepare('UPDATE run SET slot_held=0').run();
 const next = new CoreStore(join(h.dir,'core.db')); cleanup.push(()=>next.close());
 expect(() => h.service.acceptCurrent('task',r.id)).toThrow('STALE_CORE_EPOCH');
 new CoreEvidenceService(next,h.worker).acceptCurrent('task',r.id);
 expect(next.snapshot().tasks[0].status).toBe('SUCCEEDED');
});
test('task_B_continues_exact_uncommitted_A_snapshot_and_rechecks_A_plus_B', async () => {
 const h=fixture(); h.service.freezeAcceptance(h.input); const a=await h.worker.verifyCandidate(h.input); h.service.persist(a); h.service.acceptCurrent('task',a.id);
 const nextWorkspace=join(h.dir,'continued'); expect(h.store.materialize(h.snapshot.ref,h.snapshot.digest,nextWorkspace)).toBe(a.candidateDigest);
 expect(readFileSync(join(nextWorkspace,'src/export-records.mjs'),'utf8')).toBe(readFileSync(join(h.workspace,'src/export-records.mjs'),'utf8'));
 h.core.submit({commandId:'B',taskId:'B',botId:'bot',text:'continue A',expectedVersion:1,subject:'user'});
 const run=h.core.dispatch('bot',prepareFake)!;
 h.core.observeExit(run.id,run.fencingToken,{source:'fake-runner',kind:'process-exit',exitCode:0});
 const contractB=setup(join(h.dir,'contract-b'),'task-b','B');
 const workerB=new VerificationWorker({...contractB.options,store:h.store});
 const serviceB=new CoreEvidenceService(h.core,workerB);
 const initialB={...contractB.input,continuation:{evidenceId:a.id,candidateDigest:a.candidateDigest,immutableSnapshotRef:a.immutableSnapshotRef},taskId:'B',candidateDigest:a.candidateDigest,immutableSnapshotRef:a.immutableSnapshotRef};
 expect((await workerB.verifyCandidate(initialB)).status).toBe('FAIL');
 writeFileSync(join(nextWorkspace,'src/export-records.mjs'),readFileSync(join(oracleRoot,'controls/task-b.mjs')));
 writeFileSync(join(nextWorkspace,'test/export-records.test.mjs'),readFileSync(join(oracleRoot,'controls/task-b.test.mjs')));
 writeFileSync(join(nextWorkspace,'CHANGELOG.md'),readFileSync(join(nextWorkspace,'CHANGELOG.md'),'utf8')+'\nTask B: validate input and limits.\n');
 const bSnapshot=h.store.capture(nextWorkspace);
 const inputB={...initialB,candidateDigest:bSnapshot.digest,immutableSnapshotRef:bSnapshot.ref};
 expect(() => serviceB.freezeAcceptance(inputB)).toThrow('CONTINUATION_REQUIRED');
 expect(()=>serviceB.freezeAcceptance({...inputB,continuation:{...inputB.continuation,immutableSnapshotRef:'snapshot-wrong'}},{evidenceId:a.id,inputCandidateDigest:a.candidateDigest})).toThrow('CONTINUATION_MISMATCH');
 serviceB.freezeAcceptance(inputB,{evidenceId:a.id,inputCandidateDigest:a.candidateDigest});
 const b=await workerB.verifyCandidate(inputB); expect(b.status).toBe('PASS'); expect(b.assertions).toHaveLength(11);
 serviceB.persist(b);
 h.core.database.prepare('UPDATE task SET revision=revision+1 WHERE id=?').run('task');
 expect(() => serviceB.acceptCurrent('B',b.id)).toThrow('STALE_UPSTREAM_EVIDENCE');
 h.core.database.prepare('UPDATE task SET revision=revision-1 WHERE id=?').run('task');
 serviceB.acceptCurrent('B',b.id);
 expect(h.core.snapshot().tasks.map(t=>t.status)).toEqual(['SUCCEEDED','SUCCEEDED']);
 expect(h.core.snapshot().bots[0].sandboxId).toBe('sandbox:bot');
});
test('deleted_artifact_after_verification_blocks_success', async () => {
 const h=fixture(); h.service.freezeAcceptance(h.input); const r=await h.worker.verifyCandidate(h.input); h.service.persist(r);
 rmSync(h.snapshot.path,{recursive:true,force:true});
 expect(() => h.service.acceptCurrent('task',r.id)).toThrow('SNAPSHOT_TAMPERED');
});
test('negative_oracle_result_cannot_complete_task', async () => {
 const h=fixture('wrong'); h.service.freezeAcceptance(h.input); const r=await h.worker.verifyCandidate(h.input); h.service.persist(r);
 expect(() => h.service.acceptCurrent('task',r.id)).toThrow('ACCEPTANCE_FAILED');
});
test('stored_digest_detects_corruption_on_read_after_restart', async () => {
 const h=fixture(); h.service.freezeAcceptance(h.input); const r=await h.worker.verifyCandidate(h.input); h.service.persist(r);
 // Trusted test fault injection simulates storage corruption; Bot has no SQLite access.
 h.core.database.exec('DROP TRIGGER evaluation_no_update');
 h.core.database.prepare('UPDATE evaluation SET report_digest=?').run('0'.repeat(64));
 expect(() => h.service.inspect('task')).toThrow('TAMPERED_EVIDENCE');
 expect(() => h.service.acceptCurrent('task',r.id)).toThrow('TAMPERED_EVIDENCE');
});
test('pending_approval_cannot_be_hidden_by_passing_evidence', async () => {
 const h=fixture(); h.service.freezeAcceptance(h.input); const r=await h.worker.verifyCandidate(h.input); h.service.persist(r);
 const {ApprovalService}=await import('../../packages/core/src/approvals.js');
 new ApprovalService(h.core.database,{trustedActor:()=> 'user',authorizeDecision:()=>true,revalidate:()=>true});
 h.core.database.prepare("INSERT INTO approval_requests(id,payload,request_hash,parameter_digest,status) VALUES (?,?,?,?,?)").run('pending',JSON.stringify({binding:{taskId:'task'}}),'fixture','fixture','PENDING');
 expect(() => h.service.acceptCurrent('task',r.id)).toThrow('PENDING_APPROVAL');
});
