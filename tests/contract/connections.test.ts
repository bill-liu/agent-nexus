import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createConnectionFixture, ConnectionStore, ConnectionRegistry, GrantService } from '../../packages/connections/src/index.js';

const setup = () => createConnectionFixture(new DatabaseSync(':memory:'), () => 1000);

describe('connection resolution C01–C20 (fake protocol only)', () => {
  it('C01 freezes default named metadata and separate execution/gateway/upstream refs', () => {
    const f = setup(); const s = f.resolver.resolve(f.request);
    expect(s.connectionId).toBe('demo-gateway');
    expect(Object.isFrozen(s)).toBe(true);
    expect(new Set([s.executionLeaseRef, s.gatewayLeaseRef, s.upstreamCredentialRef]).size).toBe(3);
    expect(f.store.snapshot(s.id)).toEqual(s);
  });
  it('C02 refuses an ungranted explicit task override', () => {
    const f = setup(); f.registry.create({ ...f.connection, id: 'other' });
    expect(() => f.resolver.resolve({ ...f.request, explicitConnectionId: 'other' })).toThrow('GRANT_REQUIRED');
  });
  it('C03 reuses valid target environment auth without starting login', () => {
    const f = setup(); f.resolver.resolve(f.request); f.resolver.resolve({ ...f.request, runId: 'run2' });
    expect(f.auth.beginCount).toBe(0);
  });
  it.each(['required', 'expired'] as const)('C04 blocks %s authentication without fallback', status => {
    const f = setup(); f.auth.setInspection(f.request, { ...f.inspection, status });
    expect(() => f.resolver.resolve(f.request)).toThrow(status === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED');
    expect(f.store.all('snapshots')).toHaveLength(0);
  });
  it('C05 blocks unavailable quota without silently using another source', () => {
    const f = setup(); f.auth.setInspection(f.request, { ...f.inspection, status: 'quota_limited' });
    expect(() => f.resolver.resolve(f.request)).toThrow('USAGE_LIMITED');
  });
  it('C06/C17 gateway unavailable or app stopped refuses egress', () => {
    const f = setup(); const s = f.resolver.resolve(f.request); f.gateway.setAvailable(false);
    expect(() => f.gateway.request(s.gatewayLeaseRef!, f.gatewayRequest)).toThrow('GATEWAY_UNAVAILABLE');
    expect(f.gateway.acceptedRequests).toBe(0);
  });
  it('C07 clears inherited keys and refuses conflicting actual authentication', () => {
    const f = setup(); f.auth.setInspection(f.request, { ...f.inspection, authMethod: 'api_key' });
    expect(() => f.resolver.resolve({ ...f.request, inheritedEnvironment: { ANTHROPIC_API_KEY: 'CANARY_KEY', PATH: '/safe', UNKNOWN: 'CANARY' } })).toThrow('AUTH_MODE_MISMATCH');
    expect(f.auth.lastEnvironment).toEqual({ PATH: '/safe' });
  });
  it('C09/C19 revocation denies old gateway lease and final startup', () => {
    const f = setup(); const s = f.resolver.resolve(f.request); f.grants.revoke(f.grant.id, 1);
    expect(() => f.resolver.authorizeStart(s, f.request)).toThrow('GRANT_REVOKED');
    expect(() => f.gateway.request(s.gatewayLeaseRef!, f.gatewayRequest)).toThrow('GRANT_REVOKED');
  });
  it('C10 local direct revocation explicitly requires upstream rotation', () => {
    const f = setup(); const notice = f.grants.revoke(f.grant.id, 1);
    expect(notice.upstreamCredentialRevoked).toBe(false); expect(notice.rotationRequired).toBe(true);
  });
  it.each([{ nodeId: 'wrong' }, { botId: 'wrong' }, { generation: 2 }, { userId: 'wrong' }, { action: 'export' }])('C11 refuses scoped target mismatch %j', mismatch => {
    const f = setup(); expect(() => f.resolver.resolve({ ...f.request, ...mismatch })).toThrow('GRANT_SCOPE_MISMATCH');
  });
  it('C11 refuses runtime-reported account mismatch', () => {
    const f = setup(); f.auth.setInspection(f.request, { ...f.inspection, accountRef: 'other-account' });
    expect(() => f.resolver.resolve(f.request)).toThrow('ACCOUNT_MISMATCH');
  });
  it('C12 multiple Bots share reported account limits; no independent quota is fabricated', () => {
    const f = setup(); const s = f.resolver.resolve(f.request);
    expect(s.sharedUpstreamLimits).toBe(true); expect(s.usage).toEqual({ amount: null, source: 'unknown' });
  });
  it('C13 named approved fallback creates a new run/session preserving task', () => {
    const f = setup(); const s = f.resolver.resolve(f.request);
    const next = f.resolver.switchConnection(s, { ...f.request, explicitConnectionId: 'demo-gateway', runId: 'new-run', runtimeSessionRef: 'new-session' }, f.resolver.approveFallback(f.scope, { connectionId: 'demo-gateway', projectId: 'demo-project', reason: 'quota', expiresAt: 5000, maxBudget: 10, dataPolicy: 'cloud_allowed' }), { stopped: true, sideEffects: 'reconciled', reason: 'quota' });
    expect(next.runId).toBe('new-run'); expect(next.taskId).toBe(s.taskId); expect(next.runtimeSessionRef).toBe('new-session');
    expect(f.store.all('switches')).toHaveLength(1);
  });
  it('C14 unknown old side effects block switching and task replay', () => {
    const f = setup(); const s = f.resolver.resolve(f.request);
    expect(() => f.resolver.switchConnection(s, { ...f.request, runId: 'new-run', runtimeSessionRef: 'new' }, f.resolver.approveFallback(f.scope, { connectionId: 'demo-gateway', projectId: 'demo-project', reason: 'quota', expiresAt: 5000, maxBudget: 10, dataPolicy: 'cloud_allowed' }), { stopped: true, sideEffects: 'unknown', reason: 'quota' })).toThrow('STATE_UNKNOWN');
  });
  it('C16 unlicensed runtime login cannot be enabled by user override', () => {
    const f = setup(); expect(() => f.resolver.resolve({ ...f.request, runtimePolicy: { nativeLoginAllowed: false, authMethods: [] }, userAcceptsRisk: true })).toThrow('POLICY_RESTRICTED');
  });
  it('C18 changing credentials needs verified update protocol or a new session', () => {
    const f = setup(); const s = f.resolver.resolve(f.request);
    expect(() => f.resolver.assertCredentialTransition(s, 'changed', { sessionRef: s.runtimeSessionRef, updateProtocolVerified: false })).toThrow('NEW_RUNTIME_SESSION_REQUIRED');
    expect(f.resolver.assertCredentialTransition(s, 'changed', { sessionRef: 'new', updateProtocolVerified: false })).toBe('new_session');
  });
  it('C19 grant revoked during actual auth inspect denies snapshot issue', () => {
    const f = setup(); f.auth.onInspect = () => f.grants.revoke(f.grant.id, 1);
    expect(() => f.resolver.resolve(f.request)).toThrow('GRANT_REVOKED');
  });
  it('C20 missing billing metadata stays unknown and required known billing blocks', () => {
    const f = setup(); f.auth.setInspection(f.request, { ...f.inspection, billingSource: 'unknown', billingEvidence: 'unknown', accountRef: undefined });
    const s = f.resolver.resolve({ ...f.request, requireAccount: false }); expect(s.billingSource).toBe('unknown'); expect(s.billingEvidence).toBe('unknown');
    expect(() => f.resolver.resolve({ ...f.request, requireAccount: false, requireKnownBilling: true })).toThrow('BILLING_UNKNOWN');
  });
  it('connection and grant metadata persist across service recreation', () => {
    const db = new DatabaseSync(':memory:'); const f = createConnectionFixture(db, () => 1000);
    const store = new ConnectionStore(db); expect(new ConnectionRegistry(store).get(f.connection.id)).toEqual(f.connection);
    expect(new GrantService(store, () => 1000).get(f.grant.id)).toEqual(f.grant);
  });
  it('expired grants, stale revisions and incompatible models fail closed', () => {
    const f = setup(); expect(() => f.resolver.resolve({ ...f.request, model: 'other' })).toThrow('CONNECTION_INCOMPATIBLE');
    const s = f.resolver.resolve(f.request); f.registry.update(f.connection.id, 1, { name: 'updated' });
    expect(() => f.resolver.authorizeStart(s, f.request)).toThrow('CONNECTION_REVISION_MISMATCH');
    const later = new GrantService(f.store, () => 6000); expect(() => later.assertAuthorized(f.grant.id, f.request)).toThrow('GRANT_EXPIRED');
  });
  it.each([{ botId: 'wrong' }, { runId: 'wrong' }, { nodeId: 'wrong' }, { generation: 99 }, { model: 'wrong' }, { endpoint: 'https://evil.invalid' }, { budget: 11 }])('gateway checks actual request constraints %j', mismatch => {
    const f = setup(); const s = f.resolver.resolve(f.request);
    expect(() => f.gateway.request(s.gatewayLeaseRef!, { ...f.gatewayRequest, ...mismatch })).toThrow(); expect(f.gateway.acceptedRequests).toBe(0);
  });
  it('gateway accepts scoped request and cumulatively enforces budget', () => {
    const f = setup(); const s = f.resolver.resolve(f.request);
    expect(f.gateway.request(s.gatewayLeaseRef!, { ...f.gatewayRequest, budget: 6 }).status).toBe('fake_accepted');
    expect(() => f.gateway.request(s.gatewayLeaseRef!, { ...f.gatewayRequest, budget: 5 })).toThrow('BUDGET_EXCEEDED');
  });
});

describe('adversarial connection lifecycle', () => {
  it('native login license gate preserves explicitly allowed API/gateway capability', () => {
    const f = setup(); expect(f.resolver.resolve({ ...f.request, runtimePolicy: { nativeLoginAllowed: false, authMethods: ['gateway_credential'] } }).route).toBe('gateway');
  });
  it('native login gate rejects simulated subscription path despite risk override', () => {
    const f = setup(); f.registry.update(f.connection.id, 1, { route: 'direct', authMethod: 'runtime_managed_login', billingSource: 'subscription' });
    f.auth.setInspection(f.request, { ...f.inspection, authMethod: 'runtime_managed_login', billingSource: 'subscription' });
    expect(() => f.resolver.resolve({ ...f.request, userAcceptsRisk: true, runtimePolicy: { nativeLoginAllowed: false, authMethods: ['runtime_managed_login'] } })).toThrow('POLICY_RESTRICTED');
  });
  it('known billing mismatch blocks instead of changing selected payment source', () => {
    const f = setup(); f.auth.setInspection(f.request, { ...f.inspection, billingSource: 'api', billingEvidence: 'provider_reported' });
    expect(() => f.resolver.resolve(f.request)).toThrow('BILLING_SOURCE_MISMATCH');
  });
  it('unknown billing evidence cannot satisfy required verified billing', () => {
    const f = setup(); f.auth.setInspection(f.request, { ...f.inspection, billingEvidence: 'unknown' });
    expect(() => f.resolver.resolve({ ...f.request, requireKnownBilling: true })).toThrow('BILLING_UNKNOWN');
  });
  it('gateway unavailable blocks resolver and final start before fake dispatch', () => {
    const f = setup(); const snapshot = f.resolver.resolve(f.request); f.gateway.setAvailable(false);
    expect(() => f.resolver.resolve(f.request)).toThrow('GATEWAY_UNAVAILABLE');
    expect(() => f.resolver.authorizeStart(snapshot, f.request)).toThrow('GATEWAY_UNAVAILABLE');
  });
  it('restart invalidates persisted old lease instead of reviving authority', () => {
    const db = new DatabaseSync(':memory:'); const f = createConnectionFixture(db, () => 1000); const s = f.resolver.resolve(f.request);
    const restarted = createConnectionFixture(db, () => 1000);
    expect(() => restarted.resolver.authorizeStart(s, restarted.request)).toThrow('LEASE_REVOKED');
    expect(() => restarted.gateway.request(s.gatewayLeaseRef!, restarted.gatewayRequest)).toThrow('LEASE_REVOKED');
  });
  it('tampered immutable snapshot and task/session substitutions are denied', () => {
    const f = setup(); const s = f.resolver.resolve(f.request);
    expect(() => f.resolver.authorizeStart({ ...s, budget: 100 }, f.request)).toThrow('SNAPSHOT_MISMATCH');
    expect(() => f.resolver.authorizeStart(s, { ...f.request, taskId: 'other' })).toThrow('SNAPSHOT_SCOPE_MISMATCH');
    expect(() => f.store.replace('snapshots', s.id, { ...s, budget: 100 })).toThrow('IMMUTABLE_SNAPSHOT');
  });
  it('C02 explicit authorized alternate connection resolves without implicit discovery', () => {
    const f = setup(); f.registry.create({ ...f.connection, id: 'alternate' });
    f.grants.grant({ ...f.scope, connectionId: 'alternate', approvedBy: 'demo-user', expiresAt: 5000, maxBudget: 10 });
    expect(f.resolver.resolve({ ...f.request, explicitConnectionId: 'alternate' }).connectionId).toBe('alternate');
  });
  it('C10 direct API snapshot has no gateway lease and revoke cannot invalidate upstream key', () => {
    const f = setup(); f.registry.update(f.connection.id, 1, { route: 'direct', authMethod: 'api_key', billingSource: 'api' });
    f.auth.setInspection(f.request, { ...f.inspection, authMethod: 'api_key', billingSource: 'api' });
    const s = f.resolver.resolve({ ...f.request, runtimePolicy: { nativeLoginAllowed: false, authMethods: ['api_key'] } });
    expect(s.gatewayLeaseRef).toBeUndefined(); expect(s.upstreamCredentialRef).toBe('upstream:fake-demo');
    expect(f.grants.revoke(f.grant.id, 1).upstreamCredentialRevoked).toBe(false);
  });
  it('endpoint updates cannot smuggle insecure or secret-bearing URL into persistent metadata', () => {
    const f = setup();
    expect(() => f.registry.update(f.connection.id, 1, { endpoint: 'https://user:password@evil.invalid' })).toThrow('ENDPOINT_DENIED');
    expect(() => f.registry.update(f.connection.id, 1, { endpoint: 'https://gateway.example.invalid/?token=CANARY' })).toThrow('ENDPOINT_DENIED');
    expect(f.registry.get(f.connection.id).revision).toBe(1);
  });
});

describe('execution credential renewal and time bounds', () => {
  it('C18 a claimed update boolean alone cannot change a long-lived process credential', () => {
    const f = setup(); const old = f.resolver.resolve(f.request);
    expect(() => f.resolver.assertCredentialTransition(old, 'changed', { sessionRef: old.runtimeSessionRef, updateProtocolVerified: true })).toThrow('NEW_RUNTIME_SESSION_REQUIRED');
  });
  it('C18 fake supported update must execute and confirm effective credential reference', () => {
    const f = setup(); const old = f.resolver.resolve(f.request); let applied = '';
    expect(f.resolver.assertCredentialTransition(old, 'changed', { sessionRef: old.runtimeSessionRef, updateProtocolVerified: true, applyCredential: (credentialRef: string) => { applied = credentialRef; return { credentialRef, sessionRef: old.runtimeSessionRef }; } })).toBe('verified_update');
    expect(applied).toBe('changed');
    expect(() => f.resolver.assertCredentialTransition(old, 'changed', { sessionRef: old.runtimeSessionRef, updateProtocolVerified: true, applyCredential: () => ({ credentialRef: 'old', sessionRef: old.runtimeSessionRef }) })).toThrow('AUTH_MODE_MISMATCH');
  });
  it('gateway expiry and explicit execution-lease revocation both refuse further requests', () => {
    let now = 1000; const f = createConnectionFixture(new DatabaseSync(':memory:'), () => now); const s = f.resolver.resolve(f.request);
    now = s.expiresAt; expect(() => f.gateway.request(s.gatewayLeaseRef!, f.gatewayRequest)).toThrow('LEASE_EXPIRED');
    const g = setup(); const t = g.resolver.resolve(g.request); g.leases.revoke(t.executionLeaseRef);
    expect(() => g.gateway.request(t.gatewayLeaseRef!, g.gatewayRequest)).toThrow('LEASE_REVOKED');
  });
  it('expired named fallback approval cannot authorize switching', () => {
    const f = setup(); const old = f.resolver.resolve(f.request);
    expect(() => f.resolver.switchConnection(old, { ...f.request, runId: 'new-run', runtimeSessionRef: 'new-session' }, f.resolver.approveFallback(f.scope, { connectionId: 'demo-gateway', projectId: 'demo-project', reason: 'quota', expiresAt: 1000, maxBudget: 10, dataPolicy: 'cloud_allowed' }), { stopped: true, sideEffects: 'reconciled', reason: 'quota' })).toThrow('FALLBACK_NOT_APPROVED');
  });
});

describe('revocable named fallback approval', () => {
  it('revoked preapproval cannot authorize new Run even when ConnectionGrant remains valid', () => {
    const f = setup(); const old = f.resolver.resolve(f.request);
    const approval = f.resolver.approveFallback(f.scope, { connectionId: f.connection.id, projectId: f.scope.projectId, reason: 'quota', expiresAt: 5000, maxBudget: 10, dataPolicy: 'cloud_allowed' });
    f.resolver.revokeFallback(approval.id, approval.revision);
    expect(() => f.resolver.switchConnection(old, { ...f.request, runId: 'new', runtimeSessionRef: 'new' }, approval, { stopped: true, sideEffects: 'reconciled', reason: 'quota' })).toThrow('FALLBACK_NOT_APPROVED');
  });
  it('forged approval identifier and caller-edited expiry cannot confer authorization', () => {
    const f = setup(); const old = f.resolver.resolve(f.request);
    const approval = f.resolver.approveFallback(f.scope, { connectionId: f.connection.id, projectId: f.scope.projectId, reason: 'quota', expiresAt: 1000, maxBudget: 10, dataPolicy: 'cloud_allowed' });
    const next = { ...f.request, runId: 'new', runtimeSessionRef: 'new' };
    expect(() => f.resolver.switchConnection(old, next, { ...approval, expiresAt: 5000 }, { stopped: true, sideEffects: 'reconciled', reason: 'quota' })).toThrow('FALLBACK_NOT_APPROVED');
    expect(() => f.resolver.switchConnection(old, next, { ...approval, id: 'forged' }, { stopped: true, sideEffects: 'reconciled', reason: 'quota' })).toThrow('FALLBACK_NOT_APPROVED');
  });
});
it('synchronous store transactions reject async callback and roll back metadata', () => {
  const f = setup();
  expect(() => f.store.transaction(() => { f.store.insert('switches', 'bad', { id: 'bad' }); return Promise.resolve('bad'); })).toThrow('ASYNC_TRANSACTION_FORBIDDEN');
  expect(f.store.all('switches')).toHaveLength(0);
});
it('C03 simulated native login reuses valid target state across Runs without reauthorization', () => {
  const f = setup(); f.registry.update(f.connection.id, 1, { route: 'direct', authMethod: 'runtime_managed_login', billingSource: 'subscription', credentialRef: undefined });
  f.auth.setInspection(f.request, { ...f.inspection, authMethod: 'runtime_managed_login', billingSource: 'subscription', billingEvidence: 'provider_reported' });
  const request = { ...f.request, runtimePolicy: { nativeLoginAllowed: true, authMethods: ['runtime_managed_login' as const] } };
  const one = f.resolver.resolve(request); const two = f.resolver.resolve({ ...request, runId: 'second-run' });
  expect(one.authSessionRef).toBe(two.authSessionRef); expect(one.upstreamCredentialRef).toBeUndefined(); expect(f.auth.beginCount).toBe(0);
});
it('C12 two simulated Bots on one account show shared limits while auth targets remain separate', () => {
  const f = setup(); const other = { ...f.request, botId: 'second-bot', runId: 'second-run', runtimeSessionRef: 'second-session' };
  f.grants.grant({ ...f.scope, botId: other.botId, connectionId: f.connection.id, approvedBy: 'demo-user', expiresAt: 5000, maxBudget: 10 });
  f.auth.setInspection(other, { ...f.inspection, botId: other.botId, authSessionRef: 'auth:second-target' });
  const first = f.resolver.resolve(f.request); const second = f.resolver.resolve(other);
  expect(first.accountRef).toBe(second.accountRef); expect(first.authSessionRef).not.toBe(second.authSessionRef);
  expect([first.sharedUpstreamLimits, second.sharedUpstreamLimits]).toEqual([true, true]); expect([first.usage.amount, second.usage.amount]).toEqual([null, null]);
});

describe('review regressions: account evidence and fallback revocation', () => {
  it.each([true, undefined])('required/default account policy refuses absent selected and inspected account (%s)', requireAccount => {
    const f = setup(); f.registry.update(f.connection.id, 1, { accountRef: undefined });
    f.auth.setInspection(f.request, { ...f.inspection, accountRef: undefined });
    expect(() => f.resolver.resolve({ ...f.request, requireAccount })).toThrow('ACCOUNT_UNKNOWN');
    expect(f.store.all('snapshots')).toHaveLength(0);
    expect(f.resolver.resolve({ ...f.request, requireAccount: false }).accountRef).toBeUndefined();
  });
  it('revocation during fallback authentication denies switch without rolling back the revocation', () => {
    const f = setup(); const old = f.resolver.resolve(f.request);
    const approval = f.resolver.approveFallback(f.scope, { connectionId: f.connection.id, projectId: f.scope.projectId, reason: 'quota', expiresAt: 5000, maxBudget: 10, dataPolicy: 'cloud_allowed' });
    f.auth.onInspect = () => f.resolver.revokeFallback(approval.id, approval.revision);
    expect(() => f.resolver.switchConnection(old, { ...f.request, runId: 'new', runtimeSessionRef: 'new' }, approval, { stopped: true, sideEffects: 'reconciled', reason: 'quota' })).toThrow('FALLBACK_NOT_APPROVED');
    expect(f.store.get<{ revoked: boolean }>('fallback_approvals', approval.id)?.revoked).toBe(true);
    expect(f.store.all('snapshots')).toHaveLength(1); expect(f.store.all('switches')).toHaveLength(0);
    expect(f.resolver.authorizeStart(old, f.request).id).toBe(old.id);
    expect(f.gateway.request(old.gatewayLeaseRef!, f.gatewayRequest).status).toBe('fake_accepted');
  });
  it('revocation after successful fallback denies final start and gateway use of switched snapshot', () => {
    const f = setup(); const old = f.resolver.resolve(f.request);
    const approval = f.resolver.approveFallback(f.scope, { connectionId: f.connection.id, projectId: f.scope.projectId, reason: 'quota', expiresAt: 5000, maxBudget: 10, dataPolicy: 'cloud_allowed' });
    const request = { ...f.request, runId: 'new', runtimeSessionRef: 'new' };
    const switched = f.resolver.switchConnection(old, request, approval, { stopped: true, sideEffects: 'reconciled', reason: 'quota' });
    expect(switched.fallbackApprovalRef).toBe(approval.id); expect(switched.fallbackApprovalRevision).toBe(approval.revision);
    f.resolver.revokeFallback(approval.id, approval.revision);
    expect(() => f.resolver.authorizeStart(switched, request)).toThrow('FALLBACK_NOT_APPROVED');
    expect(() => f.gateway.request(switched.gatewayLeaseRef!, { ...f.gatewayRequest, runId: 'new' })).toThrow('FALLBACK_NOT_APPROVED');
    expect(f.gateway.acceptedRequests).toBe(0);
  });
});
