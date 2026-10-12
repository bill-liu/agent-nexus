import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalService, canonicalDigest, type ApprovalBinding } from '../../packages/core/src/approvals.js';
import { CodexApprovalAdapter } from '../../packages/execution/src/approval-adapter.js';
import { evaluateRuntimePolicy } from '../../packages/execution/src/runtime-policy.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/cli-approvals/${name}.json`, import.meta.url), 'utf8'));
const binding: ApprovalBinding = { subjectId: 'owner', projectId: 'project', botId: 'bot', taskId: 'task', taskRevision: 1, candidateVersion: 'candidate', contextDigest: 'context', runId: 'run', sessionId: 'session', turnId: 'turn', connectionId: 'connection', connectionRevision: 1, grantId: 'grant', grantRevision: 1, nodeId: 'node', nodeGeneration: 1 };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function harness() {
  const db = new DatabaseSync(':memory:'); databases.push(db); let allowed = true;
  const service = new ApprovalService(db, { now: () => 100, trustedActor: () => 'owner', authorizeDecision: (actor, scope) => actor === scope.subjectId, revalidate: () => allowed });
  const adapter = new CodexApprovalAdapter(service, { runtimeVersion: '0.159.2' });
  const input = { request: fixture('command'), binding, nativeThreadId: 'native-thread', nativeTurnId: 'native-turn', expiresAt: 200 };
  const receive = (overrides = {}) => adapter.receive({ ...input, ...overrides });
  const approve = (overrides = {}) => { const mapped = receive(overrides); if (mapped.kind !== 'approval') throw new Error(mapped.code); service.decide({ id: mapped.approval.id, expectedRequestHash: mapped.approval.requestHash, decision: 'APPROVED' }); return mapped; };
  return { service, adapter, input, receive, approve, revoke: () => { allowed = false; } };
}
describe('pinned Codex approval protocol', () => {
  it('refuses unverified runtime versions instead of assuming schema compatibility', () => {
    const h = harness();
    expect(() => new CodexApprovalAdapter(h.service, { runtimeVersion: '0.160.0' })).toThrow('UNSUPPORTED_RUNTIME_VERSION');
    expect(() => new CodexApprovalAdapter(h.service, undefined as never)).toThrow('UNSUPPORTED_RUNTIME_VERSION');
  });
  it('verifies unmodified generated schemas against recorded version hashes', () => {
    const metadata = fixture('metadata'); expect(metadata.version).toBe('0.159.2');
    for (const [file, expected] of Object.entries(metadata.files)) {
      const bytes = readFileSync(new URL(`../fixtures/cli-approvals/${file}`, import.meta.url)); expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
    }
    const command = fixture('CommandExecutionRequestApprovalParams'); expect(command.required).toEqual(['itemId', 'startedAtMs', 'threadId', 'turnId']);
    const file = fixture('FileChangeRequestApprovalParams'); expect(file.properties).not.toHaveProperty('changes');
    expect(fixture('PermissionsRequestApprovalResponse').definitions.PermissionGrantScope.enum).toEqual(['turn', 'session']);
  });
  it('maps exact native command bytes and cwd to one durable consume response', () => {
    const h = harness(); const mapped = h.approve();
    expect(mapped.approval.action).toBe('command.execute');
    expect(mapped.approval.parameters).toMatchObject({ command: 'git status --short', cwd: '/sandbox/project', itemId: 'command-item' });
    const response = h.adapter.respond({ ...h.input, expectedRequestHash: mapped.approval.requestHash, decision: 'accept' });
    expect(response).toEqual({ id: 7, result: { decision: 'accept' } }); expect(h.service.get(mapped.approval.id).status).toBe('CONSUMED');
    expect(() => h.adapter.respond({ ...h.input, expectedRequestHash: mapped.approval.requestHash, decision: 'accept' })).toThrow('ALREADY_CONSUMED');
    expect(h.adapter.replay({ ...h.input, expectedRequestHash: mapped.approval.requestHash })).toEqual(response);
    h.revoke(); expect(() => h.adapter.replay({ ...h.input, expectedRequestHash: mapped.approval.requestHash })).toThrow('POLICY_BLOCKED');
  });
  it('requires a matching proposed file-change item and binds exact changes', () => {
    const h = harness(); const request = fixture('file-change');
    expect(h.receive({ request }).kind).toBe('blocked');
    const fileChangeEvent = fixture('file-change-started'); const mapped = h.approve({ request, fileChangeEvent });
    expect(mapped.approval.parameters).toMatchObject({ changes: fileChangeEvent.params.item.changes });
    const changed = structuredClone(fileChangeEvent); changed.params.item.changes[0].diff = '+different';
    expect(() => h.adapter.respond({ ...h.input, request, fileChangeEvent: changed, expectedRequestHash: mapped.approval.requestHash, decision: 'accept' })).toThrow('REQUEST_CONFLICT');
  });
  it.each(['network', 'permissions'])('denies %s scopes broader than one exact action with a native protocol response', (name) => {
    const h = harness(); const blocked = h.receive({ request: fixture(name) }); expect(blocked.kind).toBe('blocked');
    if (blocked.kind === 'blocked') expect(blocked.response).toEqual(name === 'network' ? { id: 8, result: { decision: 'decline' } } : { id: 9, result: { permissions: {}, scope: 'turn' } });
  });
  it.each(['acceptForSession', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git'] } }, { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' } } }])('rejects broad native response %j', (decision) => {
    const h = harness(); const mapped = h.approve(); expect(() => h.adapter.respond({ ...h.input, expectedRequestHash: mapped.approval.requestHash, decision } as never)).toThrow('UNSUPPORTED_DECISION');
    expect(h.service.get(mapped.approval.id).status).toBe('APPROVED');
  });
  it.each([{ kind: 'writeStdin' }, { proposedExecpolicyAmendment: ['git'] }, { proposedNetworkPolicyAmendments: [{ host: 'example.com', action: 'allow' }] }, { environmentId: 'opaque-environment' }, { command: null }, { cwd: null }, { unknownPower: true }, { additionalPermissions: { network: { enabled: true } } }])('rejects unsupported or incompletely specified native command %j', (change) => {
    const h = harness(); const request = fixture('command'); Object.assign(request.params, change); expect(h.receive({ request }).kind).toBe('blocked');
  });
  it('rejects grantRoot and stale file-change event identity', () => {
    const h = harness(); const request = fixture('file-change'); request.params.grantRoot = '/'; expect(h.receive({ request, fileChangeEvent: fixture('file-change-started') }).kind).toBe('blocked');
    request.params.grantRoot = null; const event = fixture('file-change-started'); event.params.turnId = 'other'; expect(h.receive({ request, fileChangeEvent: event }).kind).toBe('blocked');
  });
  it('does not route native ids across sessions, runs or turns and refuses mutated replays', () => {
    const h = harness(); const mapped = h.approve(); h.adapter.respond({ ...h.input, expectedRequestHash: mapped.approval.requestHash, decision: 'accept' });
    const request = fixture('command'); request.params.turnId = 'older'; expect(h.receive({ request }).kind).toBe('blocked');
    expect(() => h.adapter.replay({ ...h.input, binding: { ...binding, sessionId: 'other' }, expectedRequestHash: mapped.approval.requestHash })).toThrow('NOT_FOUND');
    const changed = fixture('command'); changed.params.command = 'git push'; expect(() => h.adapter.replay({ ...h.input, request: changed, expectedRequestHash: mapped.approval.requestHash })).toThrow('REQUEST_MISMATCH');
  });
  it('requires a real denied decision before declining or cancelling an approval', () => {
    const h = harness(); const mapped = h.receive(); if (mapped.kind !== 'approval') throw new Error(mapped.code);
    expect(() => h.adapter.respond({ ...h.input, expectedRequestHash: mapped.approval.requestHash, decision: 'decline' })).toThrow('APPROVAL_BLOCKED');
    h.service.decide({ id: mapped.approval.id, expectedRequestHash: mapped.approval.requestHash, decision: 'DENIED' });
    expect(h.adapter.respond({ ...h.input, expectedRequestHash: mapped.approval.requestHash, decision: 'decline' })).toEqual({ id: 7, result: { decision: 'decline' } });
  });
  it('cleans native resolved requests and refuses late decisions and consumed receipt replay', () => {
    const h = harness(); const mapped = h.approve();
    const notification = { method: 'serverRequest/resolved', params: { threadId: 'native-thread', requestId: 7 } };
    expect(() => h.adapter.resolved({ ...h.input, notification: { ...notification, params: { ...notification.params, threadId: 'other' } } })).toThrow('STALE_NATIVE_SCOPE');
    expect(() => h.adapter.resolved({ ...h.input, nativeThreadId: 'other', notification: { ...notification, params: { ...notification.params, threadId: 'other' } } })).toThrow('STALE_NATIVE_SCOPE');
    expect(() => h.adapter.resolved({ ...h.input, nativeTurnId: 'other', notification })).toThrow('STALE_NATIVE_SCOPE');
    expect(h.adapter.resolved({ ...h.input, notification })).toBe(1);
    expect(() => h.adapter.respond({ ...h.input, expectedRequestHash: mapped.approval.requestHash, decision: 'accept' })).toThrow('APPROVAL_BLOCKED');
    const other = harness(); const approved = other.approve(); other.adapter.respond({ ...other.input, expectedRequestHash: approved.approval.requestHash, decision: 'accept' });
    other.adapter.resolved({ ...other.input, notification }); expect(() => other.adapter.replay({ ...other.input, expectedRequestHash: approved.approval.requestHash })).toThrow('APPROVAL_BLOCKED');
  });
  it('blocks a late approval after trusted interruption of the native turn', () => {
    const h = harness(); const mapped = h.receive(); if (mapped.kind !== 'approval') throw new Error(mapped.code);
    h.adapter.interruptTurn(binding);
    expect(() => h.service.decide({ id: mapped.approval.id, expectedRequestHash: mapped.approval.requestHash, decision: 'APPROVED' })).toThrow('DECISION_CONFLICT');
  });
});
describe('Runner policy intersection', () => {
  it('requires the exact action digest in all five hard permission layers', () => {
    const request = { action: 'command.execute', parameters: { command: 'git status', cwd: '/project' } }; const digest = canonicalDigest(request);
    const layers = { user: { exactActionDigests: [digest] }, project: { exactActionDigests: [digest] }, bot: { exactActionDigests: [digest] }, task: { exactActionDigests: [digest] }, node: { exactActionDigests: [digest] } };
    expect(evaluateRuntimePolicy(request, { intent: 'work', layers }).allowed).toBe(true);
    for (const scope of Object.keys(layers)) expect(evaluateRuntimePolicy(request, { intent: 'work', layers: { ...layers, [scope]: { exactActionDigests: [] } } }).allowed).toBe(false);
    expect(evaluateRuntimePolicy({ ...request, action: 'publish' }, { intent: 'work', layers }).allowed).toBe(false);
    expect(evaluateRuntimePolicy(request, { intent: 'discussion', layers }).allowed).toBe(false);
  });
  it('fails closed for missing layers, unknown intent and opaque digest permissions', () => {
    const request = { action: 'resource.read', parameters: { path: '/project/README' } }; const digest = canonicalDigest(request); const permission = { exactActionDigests: [digest] };
    const policy = { intent: 'discussion' as const, layers: { user: permission, project: permission, bot: permission, task: permission, node: permission } };
    expect(evaluateRuntimePolicy(request, policy).allowed).toBe(true);
    expect(evaluateRuntimePolicy(request, { ...policy, intent: 'anything' } as never).allowed).toBe(false);
    expect(evaluateRuntimePolicy(request, { ...policy, layers: { user: permission } } as never).allowed).toBe(false);
    expect(evaluateRuntimePolicy(request, { ...policy, layers: { ...policy.layers, node: { exactActionDigests: ['*'] } } }).allowed).toBe(false);
  });
});
