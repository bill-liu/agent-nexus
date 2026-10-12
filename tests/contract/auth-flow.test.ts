import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AuthFlowService, createConnectionFixture } from '../../packages/connections/src/index.js';
function setup() { const f = createConnectionFixture(new DatabaseSync(':memory:'), () => 1000); const flows = new AuthFlowService(f.store, f.registry, f.auth, () => 1000); return { ...f, flows, begin: { ...f.request, connectionId: f.connection.id, connectionRevision: 1, expectedAccountRef: 'demo-account', expiresAt: 5000, officialUrl: 'https://auth.example.invalid/device', allowedDomains: ['auth.example.invalid'] } }; }
describe('AuthFlow C15 fake target binding and metadata', () => {
  it('binds state target and validates runtime metadata before completion', () => {
    const f = setup(); const flow = f.flows.begin(f.begin); const callback = f.flows.callbackBinding(flow.id);
    const done = f.flows.complete({ ...callback, callbackUrl: 'https://auth.example.invalid/callback', rawResponse: 'CANARY_OAUTH', deviceCode: 'CANARY_DEVICE' });
    expect(done.status).toBe('completed'); expect(JSON.stringify(f.store.all('auth_flows'))).not.toContain('CANARY');
    expect(JSON.stringify(done)).not.toContain(callback.state);
  });
  it('cancelled flow rejects late callback', () => {
    const f = setup(); const flow = f.flows.begin(f.begin); const callback = f.flows.callbackBinding(flow.id); f.flows.cancel(flow.id);
    expect(() => f.flows.complete({ ...callback, callbackUrl: f.begin.officialUrl })).toThrow('AUTH_FLOW_CANCELLED');
  });
  it.each([{ botId: 'other' }, { generation: 2 }, { nodeId: 'other' }, { runtime: 'other' }, { state: 'wrong' }, { connectionRevision: 2 }])('rejects stale/mismatched callback %j', mismatch => {
    const f = setup(); const flow = f.flows.begin(f.begin);
    expect(() => f.flows.complete({ ...f.flows.callbackBinding(flow.id), ...mismatch, callbackUrl: f.begin.officialUrl })).toThrow('AUTH_FLOW_BINDING_MISMATCH');
  });
  it('connection changed during flow rejects callback', () => {
    const f = setup(); const flow = f.flows.begin(f.begin); f.registry.update(f.connection.id, 1, { name: 'changed' });
    expect(() => f.flows.complete({ ...f.flows.callbackBinding(flow.id), callbackUrl: f.begin.officialUrl })).toThrow('CONNECTION_REVISION_MISMATCH');
  });
  it.each(['http://auth.example.invalid/device', 'https://auth.example.invalid.evil.invalid', 'https://user:pass@auth.example.invalid', 'javascript:alert(1)', 'https://evil.invalid'])('rejects malicious authorization URL %s', officialUrl => {
    const f = setup(); expect(() => f.flows.begin({ ...f.begin, officialUrl })).toThrow('AUTH_URL_DENIED');
  });
  it('expired flow refuses callback, browser completion alone cannot authorize target', () => {
    const f = setup(); const flow = f.flows.begin({ ...f.begin, expiresAt: 1000 });
    expect(() => f.flows.complete({ ...f.flows.callbackBinding(flow.id), callbackUrl: f.begin.officialUrl })).toThrow('AUTH_FLOW_EXPIRED');
    const g = setup(); const other = g.flows.begin(g.begin); g.auth.setInspection(g.request, { ...g.inspection, status: 'required' });
    expect(() => g.flows.complete({ ...g.flows.callbackBinding(other.id), callbackUrl: g.begin.officialUrl })).toThrow('AUTH_REQUIRED');
  });
});

describe('AuthFlow fail-closed callback gates', () => {
  it('untrusted URL cannot become approved by passing arbitrary domain list', () => {
    const f = setup(); expect(() => f.flows.begin({ ...f.begin, officialUrl: 'https://evil.invalid', allowedDomains: ['evil.invalid'] })).toThrow('AUTH_URL_DENIED');
  });
  it('licensed methods cannot be bypassed through separate auth begin entrypoint', () => {
    const f = setup(); f.registry.update(f.connection.id, 1, { authMethod: 'runtime_managed_login' });
    expect(() => f.flows.begin({ ...f.begin, connectionRevision: 2 })).toThrow('POLICY_RESTRICTED');
  });
  it('cross-runtime and unapproved-node begin are refused before adapter login', () => {
    const f = setup(); expect(() => f.flows.begin({ ...f.begin, runtime: 'unrecognized-runtime' })).toThrow('CONNECTION_INCOMPATIBLE');
    expect(() => f.flows.begin({ ...f.begin, nodeId: 'other' })).toThrow('CONNECTION_INCOMPATIBLE');
    expect(f.auth.beginCount).toBe(0);
  });
  it('malicious callback URL is denied even when state and binding match', () => {
    const f = setup(); const flow = f.flows.begin(f.begin);
    expect(() => f.flows.complete({ ...f.flows.callbackBinding(flow.id), callbackUrl: 'https://evil.invalid' })).toThrow('AUTH_URL_DENIED');
  });
  it('native auth sessions cannot overwrite metadata for a different Bot', () => {
    const f = setup(); const flow = f.flows.begin(f.begin);
    f.store.insert('auth_sessions', f.inspection.authSessionRef, { ...f.inspection, botId: 'different-bot' });
    expect(() => f.flows.complete({ ...f.flows.callbackBinding(flow.id), callbackUrl: f.begin.officialUrl })).toThrow('AUTH_SESSION_BINDING_MISMATCH');
  });
});

describe('review regression: terminal AuthFlow state during inspection', () => {
  it('cancel during target inspection cannot be overwritten completed or create auth session', () => {
    const f = setup(); const flow = f.flows.begin(f.begin); const callback = f.flows.callbackBinding(flow.id);
    f.auth.onInspect = () => f.flows.cancel(flow.id);
    expect(() => f.flows.complete({ ...callback, callbackUrl: f.begin.officialUrl })).toThrow('AUTH_FLOW_CANCELLED');
    expect(f.flows.status(flow.id).status).toBe('cancelled'); expect(f.store.all('auth_sessions')).toHaveLength(0);
  });
  it('expiry during target inspection cannot create auth session or complete flow', () => {
    let now = 1000; const f = setup(); const flows = new AuthFlowService(f.store, f.registry, f.auth, () => now);
    const flow = flows.begin(f.begin); const callback = flows.callbackBinding(flow.id);
    f.auth.onInspect = () => { now = 5000; flows.status(flow.id); };
    expect(() => flows.complete({ ...callback, callbackUrl: f.begin.officialUrl })).toThrow('AUTH_FLOW_EXPIRED');
    expect(flows.status(flow.id).status).toBe('expired'); expect(f.store.all('auth_sessions')).toHaveLength(0);
  });
});
