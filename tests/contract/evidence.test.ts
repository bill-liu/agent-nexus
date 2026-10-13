import { afterEach, expect, test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as evidence from '../../apps/verification-worker/src/evidence.js';
import { syntheticExecutor, setup } from '../fixtures/p1-oracle/harness.js';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const fixture = (control = 'task-a') => { const d = mkdtempSync(join(realpathSync(tmpdir()), 'an-evidence-')); dirs.push(d); return setup(d, control); };

test('wrong_candidate_rejected', async () => {
 const h = fixture();
 await expect(h.worker.verifyCandidate({ ...h.input, candidateDigest: '0'.repeat(64) })).rejects.toThrow('CANDIDATE_MISMATCH');
});
test('stale_contract_rejected', async () => {
 const h = fixture();
 await expect(h.worker.verifyCandidate({ ...h.input, contractDigest: '0'.repeat(64) })).rejects.toThrow('CONTRACT_MISMATCH');
});
test('bot_written_pass_not_accepted', async () => {
 const h = fixture('wrong');
 writeFileSync(join(h.workspace, 'PASS'), 'PASS');
 const snapshot = h.store.capture(h.workspace);
 const record = await h.worker.verifyCandidate({...h.input,candidateDigest:snapshot.digest,immutableSnapshotRef:snapshot.ref});
 expect(record.status).toBe('FAIL');
 expect(record.assertions.find(x => x.id === 'ordered-limit')?.status).toBe('FAIL');
 expect(() => h.worker.assertIssued({ ...record, status: 'PASS' })).toThrow('UNTRUSTED_EVIDENCE');
});
test('tampered_report_rejected', async () => {
 const h = fixture(); const record = await h.worker.verifyCandidate(h.input);
 expect(record.status).toBe('PASS');
 expect(() => h.worker.assertIssued({ ...record, exitCode: 5 })).toThrow('UNTRUSTED_EVIDENCE');
});
test('mutation_during_verification_rejected', async () => {
 const h = fixture();
 const executor = syntheticExecutor((request) => {
  const target = join(request.candidatePath, 'src/export-records.mjs'); chmodSync(target, 0o600); writeFileSync(target, 'export const exportRecords = () => [];');
 });
 const worker = new evidence.VerificationWorker({ ...h.options, executor });
 await expect(worker.verifyCandidate(h.input)).rejects.toThrow('SNAPSHOT_TAMPERED');
});
test('source_changes_after_capture_do_not_change_independent_snapshot', async () => {
 const h = fixture(); writeFileSync(join(h.workspace, 'src/export-records.mjs'), 'broken');
 const record = await h.worker.verifyCandidate(h.input);
 expect(record.status).toBe('PASS'); expect(record.source).toBe('synthetic-subprocess');
});
test('live_candidate_requires_isolation_and_never_runs_host_subprocess', async () => {
 const h = fixture(); const worker = new evidence.VerificationWorker({ ...h.options, executor: undefined });
 await expect(worker.verifyCandidate({ ...h.input, executionKind: 'live' })).rejects.toThrow('ISOLATED_VERIFIER_REQUIRED');
 await expect(h.worker.verifyCandidate({ ...h.input, executionKind: 'live' })).rejects.toThrow('ISOLATED_VERIFIER_REQUIRED');
});
test('synthetic_executor_rejects_unknown_code_before_launch', async () => {
 const h = fixture(); writeFileSync(join(h.workspace, 'src/export-records.mjs'), 'process.exit(0)');
 const snapshot = h.store.capture(h.workspace);
 await expect(h.worker.verifyCandidate({ ...h.input, candidateDigest: snapshot.digest, immutableSnapshotRef: snapshot.ref })).rejects.toThrow('UNKNOWN_SYNTHETIC_FIXTURE');
});
test('snapshot_rejects_symlinks_and_manifest_tampering', () => {
 const h = fixture(); symlinkSync('/tmp', join(h.workspace, 'escape'));
 expect(() => h.store.capture(h.workspace)).toThrow('UNSAFE_SNAPSHOT_PATH');
 const manifest = join(h.snapshot.path, 'manifest.json'); chmodSync(manifest, 0o600); writeFileSync(manifest, '{}');
 expect(() => h.store.resolve(h.snapshot.ref, h.snapshot.digest)).toThrow('SNAPSHOT_TAMPERED');
});
test('snapshot_ref_cannot_traverse_trusted_root', () => {
 const h = fixture(); expect(() => h.store.resolve('../outside', h.snapshot.digest)).toThrow('INVALID_SNAPSHOT_REF');
});
test('strict_evidence_validation_rejects_extra_fields_and_missing_assertions', async () => {
 const h = fixture(); const record = await h.worker.verifyCandidate(h.input);
 const { validateEvidenceRecord } = await import('../../packages/contracts/src/evidence.js');
 expect(() => validateEvidenceRecord({ ...record, trusted: true })).toThrow('INVALID_EVIDENCE');
 expect(() => validateEvidenceRecord({ ...record, assertions: [] })).toThrow('INVALID_EVIDENCE');
});
test('missing_platform_capability_and_oracle_tampering_rejected', async () => {
 const h=fixture();
 await expect(h.worker.verifyCandidate({...h.input,capabilities:[]})).rejects.toThrow('PLATFORM_CAPABILITY_MISMATCH');
 const localOracle=join(h.snapshot.path,'changed-oracle.mjs'); writeFileSync(localOracle,'process.exit(0)');
 const worker=new evidence.VerificationWorker({...h.options,oraclePath:localOracle});
 await expect(worker.verifyCandidate(h.input)).rejects.toThrow('ORACLE_MISMATCH');
});
test('immutable_oracle_is_copied_to_trusted_storage_before_execution', async () => {
 const h=fixture();
 let oraclePath=''; const executor=syntheticExecutor(request => {oraclePath=request.oraclePath;});
 await new evidence.VerificationWorker({...h.options,executor}).verifyCandidate(h.input);
 expect(oraclePath.startsWith(h.store.root)).toBe(true);
 expect(oraclePath).not.toBe(h.options.oraclePath);
});
test('snapshot_tracks_nonempty_and_empty_directory_structure', () => {
 const h=fixture();
 mkdirSync(join(h.workspace,'new-directory'));
 expect(h.store.capture(h.workspace).digest).not.toBe(h.snapshot.digest);
});
test('oracle_digest_is_pinned_before_first_candidate_execution', async () => {
 const h=fixture(); const lock=JSON.parse(readFileSync(resolve('tests/fixtures/p1-oracle/manifest.json'),'utf8'));
 const {createHash}=await import('node:crypto');
 expect(createHash('sha256').update(readFileSync(resolve('tests/fixtures/p1-oracle/oracle.mjs'))).digest('hex')).toBe(lock.oracleDigest);
 expect(h.input.oracleDigest).toBe(lock.oracleDigest);
});
test('incomplete_isolation_claim_blocks_live_candidate', async () => {
 const h=fixture(); let launched=false;
 const worker=new evidence.VerificationWorker({...h.options,executor:{...syntheticExecutor(),source:'isolated-verifier',capabilities:['os-sandbox'],async execute(){launched=true;throw new Error('UNREACHABLE');}}});
 await expect(worker.verifyCandidate({...h.input,executionKind:'live',capabilities:['os-sandbox']})).rejects.toThrow('ISOLATED_VERIFIER_REQUIRED');
 expect(launched).toBe(false);
});
test('special_files_rejected_before_opening_candidate_bytes', async () => {
 const h=fixture(); const fifo=join(h.workspace,'fifo');
 const {execFileSync}=await import('node:child_process'); execFileSync('mkfifo',[fifo]);
 const {vi}=await import('vitest'); const fs=(await import('node:fs')).default; const original=fs.openSync; const {syncBuiltinESMExports}=await import('node:module');
 const spy=vi.spyOn(fs,'openSync').mockImplementation((...args: Parameters<typeof original>) => { if(args[0]===fifo) throw new Error('SPECIAL_FILE_OPENED'); return original(...args); });
 syncBuiltinESMExports();
 try { expect(()=>h.store.capture(h.workspace)).toThrow('UNSAFE_SNAPSHOT_PATH'); } finally {spy.mockRestore();syncBuiltinESMExports();}
});
test('continuation_materialization_rejects_content_change_after_manifest_check',()=>{
 const h=fixture();const original=h.store.resolve.bind(h.store);let once=true;
 h.store.resolve=(ref,digest)=>{const snapshot=original(ref,digest);if(once){once=false;const target=join(snapshot.path,'files/src/export-records.mjs');chmodSync(target,0o600);writeFileSync(target,'export const exportRecords=()=>[];');}return snapshot;};
 expect(()=>h.store.materialize(h.snapshot.ref,h.snapshot.digest,join(h.workspace,'continued'))).toThrow('SNAPSHOT_TAMPERED');
});
test('authenticated_snapshot_transfer_rehashes_bytes_and_rejects_traversal_or_digest_substitution',()=>{
 const h=fixture();const files=h.snapshot.files;const contents=files.filter(f=>f.kind==='file').map(f=>({path:f.path,data:readFileSync(join(h.snapshot.path,'files',f.path)).toString('base64')}));
 const copied=h.store.captureTransferred({files,contents,candidateDigest:h.snapshot.digest});expect(copied.digest).toBe(h.snapshot.digest);
 expect(()=>h.store.captureTransferred({files,contents:contents.map((f,i)=>i?f:{...f,data:Buffer.from('wrong').toString('base64')}),candidateDigest:h.snapshot.digest})).toThrow('INVALID_SNAPSHOT_TRANSFER');
 expect(()=>h.store.captureTransferred({files:[{path:'../outside',kind:'file',size:0,digest:'a'.repeat(64)}],contents:[{path:'../outside',data:''}],candidateDigest:'a'.repeat(64)})).toThrow('INVALID_SNAPSHOT_TRANSFER');
});
