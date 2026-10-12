import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalService, canonicalDigest, type ApprovalBinding } from '../../packages/core/src/approvals.js';

const binding: ApprovalBinding = {
  subjectId: 'user-1', projectId: 'project-1', botId: 'bot-1', taskId: 'task-1', taskRevision: 1,
  candidateVersion: 'commit-1', contextDigest: 'context-1', runId: 'run-1', sessionId: 'session-1', turnId: 'turn-1',
  connectionId: 'connection-1', connectionRevision: 1, grantId: 'grant-1', grantRevision: 1, nodeId: 'node-1', nodeGeneration: 1,
};
const openDatabases: DatabaseSync[] = [];
const temporaryDirectories: string[] = [];
afterEach(() => { for (const db of openDatabases.splice(0)) db.close(); for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function harness(path = ':memory:') {
  const db = new DatabaseSync(path); openDatabases.push(db);
  let now = 100; let allowed = true; let actor = 'user-1';
  const service = new ApprovalService(db, { now: () => now, trustedActor: () => actor,
    authorizeDecision: (who, scope) => who === scope.subjectId,
    revalidate: () => allowed });
  const request = { id: 'approval-1', binding, action: 'command.execute', parameters: { command: 'git status', cwd: '/project' }, expiresAt: 200, nativeRequestId: 1 };
  const create = () => service.request(request);
  const approve = () => { const record = create(); return service.decide({ id: record.id, expectedRequestHash: record.requestHash, decision: 'APPROVED' }); };
  const consume = (changes = {}) => { const record = service.get(request.id); return service.consume({ id: request.id, binding: request.binding, action: request.action, parameters: request.parameters, expectedRequestHash: record.requestHash, claimId: 'claim-1', ...changes }); };
  return { db, service, request, create, approve, consume, clock: (value: number) => { now = value; }, allow: (value: boolean) => { allowed = value; }, actor: (value: string) => { actor = value; } };
}

describe('durable exact-action approvals', () => {
  it('atomically decides once across windows and consumes once across Core restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'an-approval-')); temporaryDirectories.push(dir);
    const path = join(dir, 'state.sqlite'); const first = harness(path); const created = first.create();
    const second = harness(path); first.approve();
    expect(() => second.service.decide({ id: created.id, expectedRequestHash: created.requestHash, decision: 'APPROVED' })).toThrow('DECISION_CONFLICT');
    const claim = second.consume(); expect(claim.claimId).toBe('claim-1'); expect(claim.status).toBe('CONSUMED');
    const restarted = harness(path); expect(restarted.service.get(created.id).status).toBe('CONSUMED');
    expect(() => restarted.consume({ claimId: 'claim-2' })).toThrow('ALREADY_CONSUMED');
  });
  it('does not authorize execution merely because a decision was approved', () => {
    const h = harness(); h.approve(); h.allow(false);
    expect(() => h.consume()).toThrow('POLICY_BLOCKED'); expect(h.service.get(h.request.id).status).toBe('APPROVED');
  });
  it.each(Object.keys(binding))('rejects changed binding field %s before consuming', (key) => {
    const h = harness(); h.approve(); const value = binding[key as keyof ApprovalBinding];
    const changed = { ...binding, [key]: typeof value === 'number' ? value + 1 : `${value}-changed` };
    expect(() => h.consume({ binding: changed })).toThrow('REQUEST_MISMATCH'); expect(h.service.get(h.request.id).status).toBe('APPROVED');
  });
  it.each([{ action: 'publish' }, { parameters: { command: 'git push', cwd: '/project' } }, { expectedRequestHash: 'forged' }])('rejects changed action, parameters or immutable hash %j', (change) => {
    const h = harness(); h.approve(); expect(() => h.consume(change)).toThrow('REQUEST_MISMATCH');
  });
  it('canonicalizes object key order without changing array order or accepting non-JSON values', () => {
    expect(canonicalDigest({ b: 1, a: [2, 3] })).toBe(canonicalDigest({ a: [2, 3], b: 1 }));
    expect(canonicalDigest([2, 3])).not.toBe(canonicalDigest([3, 2]));
    for (const value of [undefined, NaN, { hidden: undefined }, new Date(), [undefined], new Array(1)]) expect(() => canonicalDigest(value)).toThrow('INVALID_JSON');
  });
  it('deduplicates exact native request retries and rejects content changes under the same native id', () => {
    const h = harness(); const first = h.create(); expect(h.create().requestHash).toBe(first.requestHash);
    expect(() => h.service.request({ ...h.request, id: 'replacement', parameters: { command: 'git push' } })).toThrow('REQUEST_CONFLICT');
    expect(h.service.request({ ...h.request, id: 'another-run', binding: { ...binding, runId: 'run-2' } }).id).toBe('another-run');
    expect(h.service.request({ ...h.request, id: 'string-id', nativeRequestId: '1' }).id).toBe('string-id');
  });
  it('requires the trusted actor rather than renderer supplied identity', () => {
    const h = harness(); const record = h.create(); h.actor('attacker');
    expect(() => h.service.decide({ id: record.id, expectedRequestHash: record.requestHash, decision: 'APPROVED' })).toThrow('FORBIDDEN');
    expect(() => h.service.decide({ id: record.id, expectedRequestHash: record.requestHash, decision: 'APPROVED', actorId: 'user-1' } as never)).toThrow('INVALID_REQUEST');
  });
  it.each(['PENDING', 'APPROVED'])('fails closed on expiry in %s state', (state) => {
    const h = harness(); const record = state === 'APPROVED' ? h.approve() : h.create(); h.clock(200);
    expect(() => state === 'APPROVED' ? h.consume() : h.service.decide({ id: record.id, expectedRequestHash: record.requestHash, decision: 'APPROVED' })).toThrow('EXPIRED');
  });
  it.each(['cancel', 'cancelRun', 'revokeGrant'] as const)('blocks a decided approval after %s', (operation) => {
    const h = harness(); h.approve(); h.service[operation](operation === 'cancel' ? h.request.id : operation === 'cancelRun' ? binding.runId : binding.grantId);
    expect(() => h.consume()).toThrow('APPROVAL_BLOCKED');
  });
  it('refuses pending and denied execution, stale decisions, and policy expansion', () => {
    const h = harness(); const record = h.create(); expect(() => h.consume()).toThrow('APPROVAL_BLOCKED');
    expect(() => h.service.decide({ id: record.id, expectedRequestHash: 'old', decision: 'APPROVED' })).toThrow('REQUEST_MISMATCH');
    h.allow(false); expect(() => h.service.decide({ id: record.id, expectedRequestHash: record.requestHash, decision: 'APPROVED' })).toThrow('POLICY_BLOCKED');
    h.service.decide({ id: record.id, expectedRequestHash: record.requestHash, decision: 'DENIED' }); expect(() => h.consume()).toThrow('APPROVAL_BLOCKED');
  });
  it('rejects omitted scope, extra scope and invalid lifetime values', () => {
    const h = harness();
    for (const expiresAt of [NaN, 100, Infinity]) expect(() => h.service.request({ ...h.request, expiresAt })).toThrow('INVALID_REQUEST');
    expect(() => h.service.request({ ...h.request, binding: { ...binding, admin: true } } as never)).toThrow('INVALID_REQUEST');
    expect(() => h.service.request({ ...h.request, binding: { ...binding, taskRevision: 0 } })).toThrow('INVALID_REQUEST');
  });
  it('stores a deterministic response with the consume claim and retrieves it only within its exact live scope', () => {
    const h = harness(); const record = h.approve(); const receipt = { id: 1, result: { decision: 'accept' } };
    h.consume({ receipt }); expect(h.service.receipt({ id: record.id, expectedRequestHash: record.requestHash, binding, nativeRequestId: 1 })).toEqual(receipt);
    expect(() => h.service.receipt({ id: record.id, expectedRequestHash: record.requestHash, binding: { ...binding, sessionId: 'other' }, nativeRequestId: 1 })).toThrow('REQUEST_MISMATCH');
    h.allow(false); expect(() => h.service.receipt({ id: record.id, expectedRequestHash: record.requestHash, binding, nativeRequestId: 1 })).toThrow('POLICY_BLOCKED');
  });
  it('persists cancellation tombstones after consumed response creation and blocks later scope reuse', () => {
    const h = harness(); const record = h.approve(); h.consume({ receipt: { id: 1, result: { decision: 'accept' } } }); h.service.cancel(record.id);
    expect(() => h.service.receipt({ id: record.id, expectedRequestHash: record.requestHash, binding, nativeRequestId: 1 })).toThrow('APPROVAL_BLOCKED');
    h.service.revokeGrant(binding.grantId);
    expect(() => h.service.request({ ...h.request, id: 'new-approval', binding: { ...binding, botId: 'other', runId: 'new-run' } })).toThrow('APPROVAL_BLOCKED');
  });
  it('durably invalidates only the interrupted Run/Session/Turn and prevents late approval', () => {
    const h = harness(); const record = h.create(); h.service.cancelTurn(binding);
    expect(() => h.service.decide({ id: record.id, expectedRequestHash: record.requestHash, decision: 'APPROVED' })).toThrow('DECISION_CONFLICT');
    expect(() => h.service.request({ ...h.request, id: 'late', nativeRequestId: 2 })).toThrow('APPROVAL_BLOCKED');
    expect(h.service.request({ ...h.request, id: 'new-turn', nativeRequestId: 2, binding: { ...binding, turnId: 'turn-2' } }).status).toBe('PENDING');
  });
  it('sweeps expired pending approvals without turning expiry into permission', () => {
    const h = harness(); h.create(); h.clock(200); expect(h.service.expire()).toBe(1); expect(h.service.get(h.request.id).status).toBe('CANCELLED'); expect(() => h.consume()).toThrow('APPROVAL_BLOCKED');
  });
  it('rejects hidden properties and accessor arrays without executing getters', () => {
    let reads = 0; const value = [1]; Object.defineProperty(value, '0', { get: () => { reads++; return 1; }, enumerable: true });
    expect(() => canonicalDigest(value)).toThrow('INVALID_JSON'); expect(reads).toBe(0);
    expect(() => canonicalDigest(Object.defineProperty({}, 'hidden', { value: 'secret', enumerable: false }))).toThrow('INVALID_JSON');
  });
});
