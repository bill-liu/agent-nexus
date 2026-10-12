import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createConnectionFixture } from '../../packages/connections/src/index.js';
describe('runtime data and route policy', () => {
  it.each(['embedding', 'summary', 'tool', 'model'])('local-only rejects remote %s processing even with local final model', stage => {
    const f = createConnectionFixture(new DatabaseSync(':memory:'), () => 1000);
    expect(() => f.resolver.resolve({ ...f.request, localOnly: true, processingSources: [{ stage, location: 'remote' }] })).toThrow('DATA_POLICY_DENIED');
  });
  it('required corporate gateway rejects a direct connection', () => {
    const f = createConnectionFixture(new DatabaseSync(':memory:'), () => 1000);
    f.registry.update(f.connection.id, 1, { route: 'direct', authMethod: 'api_key' });
    expect(() => f.resolver.resolve({ ...f.request, gatewayRequired: true })).toThrow('GATEWAY_REQUIRED');
  });
  it('local-only refuses remote execution node regardless of endpoint label', () => {
    const f = createConnectionFixture(new DatabaseSync(':memory:'), () => 1000);
    expect(() => f.resolver.resolve({ ...f.request, localOnly: true, nodeLocation: 'remote', processingSources: [] })).toThrow('DATA_POLICY_DENIED');
  });
});
it('local-only permits a genuinely local endpoint/node and every local processing stage', () => {
  const f = createConnectionFixture(new DatabaseSync(':memory:'), () => 1000);
  f.registry.update(f.connection.id, 1, { route: 'local', authMethod: 'local_endpoint', endpoint: 'http://127.0.0.1:8000/model', dataPolicy: 'local_only', billingSource: 'local' });
  f.registry.update(f.connection.id, 2, { status: 'ready' });
  f.auth.setInspection(f.request, { ...f.inspection, authMethod: 'local_endpoint', billingSource: 'local' });
  const s = f.resolver.resolve({ ...f.request, localOnly: true, processingSources: ['embedding', 'summary', 'tool', 'model'].map(stage => ({ stage, location: 'local' as const })), runtimePolicy: { nativeLoginAllowed: false, authMethods: ['local_endpoint'] } });
  expect(s.route).toBe('local');
});
