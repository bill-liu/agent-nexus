import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../../packages/persistence/src/unit-of-work.js';
import { assertionIds, validateEvidenceRecord, validateVerificationInput, type AssertionResult, type EvidenceAuthority, type EvidenceRecord, type EvidenceSource, type VerificationInput } from '../../../packages/contracts/src/evidence.js';
import { projectDeliverables } from './project-deliverables.js';
import { CandidateStore, hash } from './candidate.js';
export interface VerificationRequest { candidatePath: string; oraclePath: string; oracleDigest: string; stage: 'A' | 'B'; candidateDigest: string }
/** Supplied only by trusted composition, never IPC/Bot data. The provider owns the
 * isolated mount and report channel; a capability string supplied by a Bot grants nothing. */
export interface TrustedVerifierExecutor {
 readonly source: EvidenceSource; readonly platform: { os: string; arch: string }; readonly capabilities: string[];
 execute(request: VerificationRequest): Promise<{ assertions: AssertionResult[]; exitCode: number; command: string[]; outputDigest: string }>;
}
export interface VerifierOptions {
 store: CandidateStore; oraclePath: string;
 contract: { stage: 'A' | 'B'; contractDigest: string; oracleDigest: string; verifierVersion: string };
 executor?: TrustedVerifierExecutor;
}
export type { EvidenceAuthority } from '../../../packages/contracts/src/evidence.js';
export const evidenceDigest = (record: Omit<EvidenceRecord, 'reportDigest'> | EvidenceRecord): string => { const { reportDigest: _, ...body } = record as EvidenceRecord; return hash(canonicalJson(body)); };
const isolatedCapabilities = ['os-sandbox','immutable-candidate','immutable-oracle','independent-assertion-channel','no-network'];
export class VerificationWorker implements EvidenceAuthority {
 private readonly issued = new WeakMap<object, string>();
 private readonly contract: VerifierOptions['contract'];
 private oracleSnapshot: { ref: string; digest: string; path: string } | undefined;
 constructor(private readonly options: VerifierOptions) { this.contract = structuredClone(options.contract); }
 async verifyCandidate(input: VerificationInput): Promise<EvidenceRecord> {
  validateVerificationInput(input); input = structuredClone(input);
  const { store, executor } = this.options;
  if (!executor || (input.executionKind === 'live' && (executor.source !== 'isolated-verifier' || !isolatedCapabilities.every(c => executor.capabilities.includes(c))))) throw new Error('ISOLATED_VERIFIER_REQUIRED');
  if (input.contractDigest !== this.contract.contractDigest || input.stage !== this.contract.stage || input.verifierVersion !== this.contract.verifierVersion) throw new Error('CONTRACT_MISMATCH');
  if (input.oracleDigest !== this.contract.oracleDigest || hash(readFileSync(this.options.oraclePath)) !== input.oracleDigest) throw new Error('ORACLE_MISMATCH');
  if (canonicalJson(input.platform) !== canonicalJson(executor.platform) || canonicalJson([...input.capabilities].sort()) !== canonicalJson([...executor.capabilities].sort())) throw new Error('PLATFORM_CAPABILITY_MISMATCH');
  let snapshot;
  try { snapshot = store.resolve(input.immutableSnapshotRef, input.candidateDigest); }
  catch (error) { if ((error as Error).message === 'SNAPSHOT_TAMPERED') throw new Error('CANDIDATE_MISMATCH'); throw error; }
  if (!this.oracleSnapshot) this.oracleSnapshot = store.captureFile(this.options.oraclePath);
  const oracle = store.resolve(this.oracleSnapshot.ref, this.oracleSnapshot.digest);
  const frozenOraclePath = join(oracle.path, 'files/oracle.mjs');
  if (hash(readFileSync(frozenOraclePath)) !== input.oracleDigest) throw new Error('ORACLE_MISMATCH');
  const prior = input.continuation ? store.resolve(input.continuation.immutableSnapshotRef,input.continuation.candidateDigest) : undefined;
  const deliverables = projectDeliverables(join(snapshot.path,'files'), input.stage, prior ? join(prior.path,'files') : undefined);
  const startedAt = Date.now();
  const result = await executor.execute({ candidatePath: join(snapshot.path, 'files'), oraclePath: frozenOraclePath, oracleDigest: input.oracleDigest, candidateDigest: input.candidateDigest, stage: input.stage });
  store.resolve(input.immutableSnapshotRef, input.candidateDigest);
  if(input.continuation) store.resolve(input.continuation.immutableSnapshotRef,input.continuation.candidateDigest);
  result.assertions = [...result.assertions, ...deliverables];
  if (deliverables.some(a=>a.status==='FAIL')) result.exitCode=1;
  store.resolve(oracle.ref, oracle.digest);
  if (hash(readFileSync(this.options.oraclePath)) !== input.oracleDigest) throw new Error('ORACLE_MISMATCH');
  const ids = assertionIds(input.stage);
  const passing = result.exitCode === 0 && Array.isArray(result.assertions) && result.assertions.length === ids.length && ids.every(id => result.assertions.some(a => a.id === id && a.status === 'PASS'));
  const body = { ...input, ...result, id: `evidence-${randomUUID()}`, source: executor.source, status: passing ? 'PASS' as const : 'FAIL' as const, startedAt, finishedAt: Date.now() };
  const record: EvidenceRecord = { ...body, reportDigest: evidenceDigest(body) }; validateEvidenceRecord(record);
  this.issued.set(record, record.reportDigest); return record;
 }
 assertArtifacts(record: EvidenceRecord): void {
  this.options.store.resolve(record.immutableSnapshotRef, record.candidateDigest);
  if(record.continuation) this.options.store.resolve(record.continuation.immutableSnapshotRef,record.continuation.candidateDigest);
 }
 assertIssued(record: EvidenceRecord): void {
  if (!this.issued.has(record) || this.issued.get(record) !== evidenceDigest(record) || record.reportDigest !== evidenceDigest(record)) throw new Error('UNTRUSTED_EVIDENCE');
  validateEvidenceRecord(record);
 }
}
