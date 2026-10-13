import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { CandidateStore } from '../../../apps/verification-worker/src/candidate.js';
import { VerificationWorker } from '../../../apps/verification-worker/src/evidence.js';
const exec = promisify(execFile);
export const oracleRoot = resolve('tests/fixtures/p1-oracle');
export function syntheticExecutor(before?: (request: any) => void) {
 return { source: 'synthetic-subprocess' as const, platform: { os: process.platform, arch: process.arch }, capabilities: ['synthetic-fixtures-only'],
 async execute(request: any) {
  const entry = join(request.candidatePath, 'src/export-records.mjs');
  const content = readFileSync(entry, 'utf8');
  const lock = JSON.parse(readFileSync(join(oracleRoot, 'manifest.json'), 'utf8'));
  if (createHash('sha256').update(readFileSync(request.oraclePath)).digest('hex') !== lock.oracleDigest) throw new Error('UNKNOWN_SYNTHETIC_ORACLE');
  if (!['task-a','task-b','wrong'].some(name => lock.controls[`${name}.mjs`] === createHash('sha256').update(content).digest('hex'))) throw new Error('UNKNOWN_SYNTHETIC_FIXTURE');
  let stdout = ''; let exitCode = 0;
  try { stdout = (await exec(process.execPath, [request.oraclePath, entry, request.stage], { env: {}, cwd: request.candidatePath, timeout: 5000, maxBuffer: 65536 })).stdout; }
  catch (error: any) { stdout = error.stdout; exitCode = typeof error.code === 'number' ? error.code : -1; }
  before?.(request);
  return { assertions: JSON.parse(stdout), exitCode, command: ['node', 'trusted-oracle.mjs', 'src/export-records.mjs', request.stage], outputDigest: createHash('sha256').update(stdout).digest('hex') };
 }};
}
export function setup(dir: string, control = 'task-a', stage: 'A' | 'B' = 'A') {
 const workspace = join(dir, 'workspace'); cpSync(resolve('tests/fixtures/p1-export-project'), workspace, { recursive: true });
 writeFileSync(join(workspace, 'src/export-records.mjs'), readFileSync(join(oracleRoot, 'controls', `${control}.mjs`)));
 if (control !== 'wrong') writeFileSync(join(workspace, 'test/export-records.test.mjs'), readFileSync(join(oracleRoot, 'controls', `${control}.test.mjs`)));
 const store = new CandidateStore(join(dir, 'trusted'));
 let continuation: {evidenceId:string;candidateDigest:string;immutableSnapshotRef:string}|undefined;
 if(stage==='B'){
  const prior=join(dir,'prior-A');cpSync(workspace,prior,{recursive:true});
  writeFileSync(join(prior,'src/export-records.mjs'),readFileSync(join(oracleRoot,'controls/task-a.mjs')));
  writeFileSync(join(prior,'test/export-records.test.mjs'),readFileSync(join(oracleRoot,'controls/task-a.test.mjs')));
  const a=store.capture(prior);continuation={evidenceId:'synthetic-A',candidateDigest:a.digest,immutableSnapshotRef:a.ref};
  writeFileSync(join(workspace,'CHANGELOG.md'),readFileSync(join(workspace,'CHANGELOG.md'),'utf8')+'\nTask B: input validation and boundary tests.\n');
 }
 const snapshot = store.capture(workspace);
 const lock = JSON.parse(readFileSync(join(oracleRoot, 'manifest.json'), 'utf8'));
 const oracleDigest: string = lock.oracleDigest;
 const contractDigest: string = lock.contracts[stage];
 if (createHash('sha256').update(readFileSync(join(oracleRoot, `task-${stage.toLowerCase()}.json`))).digest('hex') !== contractDigest) throw new Error('FIXTURE_CONTRACT_DRIFT');
 const contract = { stage, contractDigest, oracleDigest, verifierVersion: 'p1-verifier-v2' };
 const options = { store, oraclePath: join(oracleRoot, 'oracle.mjs'), contract, executor: syntheticExecutor() };
 const worker = new VerificationWorker(options);
 const input = { taskId: 'task', taskRevision: 1, ...(continuation?{continuation}:{}), candidateDigest: snapshot?.digest, immutableSnapshotRef: snapshot?.ref, ...contract, executionKind: 'synthetic' as const, platform: { os: process.platform, arch: process.arch }, capabilities: ['synthetic-fixtures-only'] };
 return { workspace, store, snapshot, options, worker, input };
}
