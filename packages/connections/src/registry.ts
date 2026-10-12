import { ConnectionStore } from './store.js';
import { deepFreeze, deny, type Connection } from './types.js';
function project(c: Connection): Connection {
  return { id: c.id, name: c.name, provider: c.provider, runtimeProfiles: [...c.runtimeProfiles], authMethod: c.authMethod,
    billingSource: c.billingSource, billingEvidence: c.billingEvidence, ...(c.accountRef ? { accountRef: c.accountRef } : {}), route: c.route,
    endpoint: c.endpoint, allowedModels: [...c.allowedModels], ...(c.credentialRef ? { credentialRef: c.credentialRef } : {}), dataPolicy: c.dataPolicy,
    allowedNodes: [...c.allowedNodes], fallbackPolicy: c.fallbackPolicy ?? 'ask_user', status: c.status, revision: c.revision };
}
function validate(input: Connection): void {
  if (!input.id || !input.allowedNodes.length || !input.allowedModels.length || !input.runtimeProfiles.length) deny('INVALID_CONNECTION');
  if (input.credentialRef && !/^(credential|upstream):[A-Za-z0-9_.-]{1,160}$/.test(input.credentialRef)) deny('CREDENTIAL_REFERENCE_REQUIRED');
  let endpoint: URL; try { endpoint = new URL(input.endpoint); } catch { return deny('ENDPOINT_DENIED'); }
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search || (input.route !== 'local' && endpoint.protocol !== 'https:')) deny('ENDPOINT_DENIED');
  if (input.route === 'local' && (!['http:', 'https:'].includes(endpoint.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) deny('ENDPOINT_DENIED');
}
export class ConnectionRegistry {
  constructor(readonly store: ConnectionStore) {}
  create(input: Connection): Readonly<Connection> {
    if (input.revision !== 1) deny('INVALID_CONNECTION'); validate(input);
    const value = project(input); this.store.insert('connections', value.id, value); return deepFreeze(value);
  }
  get(id: string): Readonly<Connection> { const c = this.store.get<Connection>('connections', id); return c ? deepFreeze(c) : deny('CONNECTION_REQUIRED'); }
  list(): Readonly<Connection>[] { return this.store.all<Connection>('connections').map(deepFreeze); }
  update(id: string, expectedRevision: number, patch: Partial<Omit<Connection, 'id' | 'revision'>>): Readonly<Connection> {
    return this.store.transaction(() => {
      const old = this.get(id); if (old.revision !== expectedRevision) deny('CONNECTION_REVISION_MISMATCH');
      // Endpoint changes invalidate readiness; callers must explicitly verify before future use.
      const next = project({ ...old, ...patch, id, revision: old.revision + 1, status: patch.endpoint && patch.endpoint !== old.endpoint ? 'unknown' : patch.status ?? old.status });
      validate(next); this.store.replace('connections', id, next); return deepFreeze(next);
    });
  }
}
