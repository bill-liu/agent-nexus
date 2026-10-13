export type EvidenceSource = 'isolated-verifier' | 'synthetic-subprocess';
export interface VerificationInput {
 taskId: string; taskRevision: number; candidateDigest: string; immutableSnapshotRef: string;
 contractDigest: string; verifierVersion: string; oracleDigest: string; stage: 'A' | 'B';
 continuation?: { evidenceId: string; candidateDigest: string; immutableSnapshotRef: string };
 executionKind: 'synthetic' | 'live'; platform: { os: string; arch: string }; capabilities: string[];
}
export interface AssertionResult { id: string; status: 'PASS' | 'FAIL' }
export interface EvidenceRecord extends VerificationInput {
 id: string; source: EvidenceSource; status: 'PASS' | 'FAIL'; assertions: AssertionResult[];
 startedAt: number; finishedAt: number; command: string[]; exitCode: number;
 outputDigest: string; reportDigest: string;
}
export interface EvidenceAuthority { assertIssued(record: EvidenceRecord): void; assertArtifacts(record: EvidenceRecord): void }
export const behaviorAssertionIds = (stage: 'A' | 'B'): string[] => [
 'ordered-limit','short-input','fresh-empty','fresh-nonmutating','default-1000','valid-boundaries',
 ...(stage === 'B' ? ['invalid-records','invalid-limits'] : [])
];
export const deliverableAssertionIds = (stage: 'A' | 'B'): string[] => ['required-project-files', ...(stage === 'B' ? ['boundary-tests-added','changelog-appended'] : [])];
export const assertionIds = (stage: 'A' | 'B'): string[] => [...behaviorAssertionIds(stage), ...deliverableAssertionIds(stage)];
const inputKeys = ['taskId','taskRevision','candidateDigest','immutableSnapshotRef','contractDigest','verifierVersion','oracleDigest','stage','executionKind','platform','capabilities'];
const reportKeys = [...inputKeys,'id','source','status','assertions','startedAt','finishedAt','command','exitCode','outputDigest','reportDigest'];
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024;
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
 return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.length <= 64 && v.every(text) && new Set(v).size === v.length; }
function validInput(v: Record<string, unknown>): boolean {
 return text(v.taskId) && Number.isSafeInteger(v.taskRevision) && Number(v.taskRevision) > 0 &&
 ['candidateDigest','contractDigest','oracleDigest'].every(k => digest(v[k])) && text(v.immutableSnapshotRef) && text(v.verifierVersion) &&
 ((v.stage === 'A' && !Object.hasOwn(v,'continuation')) || (v.stage === 'B' && exact(v.continuation,['evidenceId','candidateDigest','immutableSnapshotRef']) && text(v.continuation.evidenceId) && digest(v.continuation.candidateDigest) && text(v.continuation.immutableSnapshotRef))) && (v.executionKind === 'synthetic' || v.executionKind === 'live') &&
 exact(v.platform, ['os','arch']) && text(v.platform.os) && text(v.platform.arch) && strings(v.capabilities);
}
export function validateVerificationInput(v: unknown): asserts v is VerificationInput {
 if (!exact(v, [...inputKeys,...(v && typeof v === 'object' && Object.hasOwn(v,'continuation') ? ['continuation'] : [])]) || !validInput(v)) throw new Error('INVALID_VERIFICATION_INPUT');
}
export function validateEvidenceRecord(v: unknown): asserts v is EvidenceRecord {
 if (!exact(v, [...reportKeys,...(v && typeof v === 'object' && Object.hasOwn(v,'continuation') ? ['continuation'] : [])]) || !validInput(v) || !text(v.id) || !['isolated-verifier','synthetic-subprocess'].includes(String(v.source)) ||
 !['PASS','FAIL'].includes(String(v.status)) || !Array.isArray(v.assertions) || !v.assertions.length || v.assertions.length > 64 ||
 !v.assertions.every(a => exact(a, ['id','status']) && text(a.id) && ['PASS','FAIL'].includes(String(a.status))) ||
 new Set(v.assertions.map(a => a.id)).size !== v.assertions.length || !Number.isSafeInteger(v.startedAt) || !Number.isSafeInteger(v.finishedAt) ||
 Number(v.startedAt) < 0 || Number(v.finishedAt) < Number(v.startedAt) || !strings(v.command) || !v.command.length || !Number.isSafeInteger(v.exitCode) ||
 !digest(v.outputDigest) || !digest(v.reportDigest)) throw new Error('INVALID_EVIDENCE');
 const required = assertionIds(v.stage as 'A' | 'B');
 if (v.status === 'PASS' && (v.exitCode !== 0 || v.assertions.length !== required.length || !required.every(id => (v.assertions as AssertionResult[]).some(a => a.id === id && a.status === 'PASS')))) throw new Error('INVALID_EVIDENCE');
 if (v.executionKind === 'live' && v.source !== 'isolated-verifier') throw new Error('INVALID_EVIDENCE');
}
