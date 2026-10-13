import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setup} from '../fixtures/p1-oracle/harness.js';
const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
function fixture(){const d=mkdtempSync(join(tmpdir(),'an-review-'));dirs.push(d);return setup(d,'task-b','B');}
for(const file of ['test/export-records.test.mjs','CHANGELOG.md'])test(`required_deliverable_missing_${file}`,async()=>{
 const h=fixture();rmSync(join(h.workspace,file));const s=h.store.capture(h.workspace);
 const r=await h.worker.verifyCandidate({...h.input,candidateDigest:s.digest,immutableSnapshotRef:s.ref});
 expect(r.status).toBe('FAIL');expect(r.assertions.find(a=>a.id==='required-project-files')?.status).toBe('FAIL');
});
test('unchanged_A_tests_fail_B_acceptance',async()=>{
 const h=fixture();writeFileSync(join(h.workspace,'test/export-records.test.mjs'),readFileSync('tests/fixtures/p1-oracle/controls/task-a.test.mjs'));const s=h.store.capture(h.workspace);
 const r=await h.worker.verifyCandidate({...h.input,candidateDigest:s.digest,immutableSnapshotRef:s.ref});expect(r.status).toBe('FAIL');expect(r.assertions.find(a=>a.id==='boundary-tests-added')?.status).toBe('FAIL');
});
test('replaced_changelog_fails_B_acceptance',async()=>{
 const h=fixture();writeFileSync(join(h.workspace,'CHANGELOG.md'),'replacement, not continuation');const s=h.store.capture(h.workspace);
 const r=await h.worker.verifyCandidate({...h.input,candidateDigest:s.digest,immutableSnapshotRef:s.ref});expect(r.status).toBe('FAIL');expect(r.assertions.find(a=>a.id==='changelog-appended')?.status).toBe('FAIL');
});
test('B_requires_bound_A_snapshot',async()=>{
 const h=fixture();const input:any={...h.input};delete input.continuation;
 await expect(h.worker.verifyCandidate(input)).rejects.toThrow('INVALID_VERIFICATION_INPUT');
});
