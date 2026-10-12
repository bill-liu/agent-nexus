import type { DatabaseSync } from 'node:sqlite';
import { ConnectionStore } from './store.js';
import { ConnectionRegistry } from './registry.js';
import { GrantService } from './grants.js';
import { FakeAuthAdapter } from './fake-auth.js';
import { FakeGateway, LeaseService, type GatewayRequest } from './leases.js';
import { ConnectionResolver } from './resolver.js';
import type { AuthInspection, Clock, Connection, ResolveRequest } from './types.js';
/** Explicit demo setup. The caller owns the DB and installs fixtures intentionally. */
export function createConnectionFixture(db: DatabaseSync, clock: Clock = Date.now) {
  const store = new ConnectionStore(db); const registry = new ConnectionRegistry(store); const grants = new GrantService(store, clock);
  const auth = new FakeAuthAdapter(); const leases = new LeaseService(store, clock); const resolver = new ConnectionResolver(registry, grants, auth, leases);
  const gateway = new FakeGateway(grants, registry, leases); const now = clock();
  const connection: Connection = { id: 'demo-gateway', name: '演示连接（Fake Gateway）', provider: 'fake', runtimeProfiles: ['fake-runtime-v1'],
    authMethod: 'gateway_credential', billingSource: 'organization_gateway', billingEvidence: 'user_declared', accountRef: 'demo-account',
    route: 'gateway', endpoint: 'https://gateway.example.invalid/model', allowedModels: ['fake-model'], credentialRef: 'upstream:fake-demo',
    dataPolicy: 'cloud_allowed', allowedNodes: ['demo-node'], fallbackPolicy: 'ask_user', status: 'ready', revision: 1 };
  if (!store.get('connections', connection.id)) registry.create(connection);
  const scope = { userId: 'demo-user', projectId: 'demo-project', botId: 'demo-bot', nodeId: 'demo-node', generation: 1, action: 'model.request' };
  const grant = store.get('grants', 'demo-grant') ? grants.get('demo-grant') : grants.grant({ ...scope, id: 'demo-grant', connectionId: connection.id, approvedBy: 'demo-user', expiresAt: now + 4000, maxBudget: 10 });
  const request: ResolveRequest = { ...scope, defaultConnectionId: connection.id, runId: 'demo-run', taskId: 'demo-task', runtimeSessionRef: 'demo-session',
    runtime: 'fake-runtime-v1', model: 'fake-model', budget: 10, expiresAt: now + 3000, nodeLocation: 'local',
    processingSources: [{ stage: 'model', location: 'remote' }], runtimePolicy: { nativeLoginAllowed: true, authMethods: ['gateway_credential'] } };
  const inspection: AuthInspection = { status: 'valid', authMethod: 'gateway_credential', accountRef: 'demo-account', billingSource: 'organization_gateway',
    billingEvidence: 'user_declared', authSessionRef: 'auth:fake-demo', botId: scope.botId, nodeId: scope.nodeId, generation: 1, runtime: request.runtime, expiresAt: now + 4000 };
  auth.setInspection(request, inspection);
  const gatewayRequest: GatewayRequest = { ...scope, runId: request.runId, model: request.model, endpoint: connection.endpoint, budget: 1 };
  return { store, registry, grants, auth, leases, resolver, gateway, connection, grant, scope, request, inspection, gatewayRequest };
}
