import { randomUUID } from 'node:crypto';
import { ConnectionStore } from './store.js';
import { deepFreeze, deny, sameScope, type Clock, type ConnectionGrant, type Scope } from './types.js';
export class GrantService {
  constructor(readonly store: ConnectionStore, readonly clock: Clock = Date.now) {}
  grant(input: Omit<ConnectionGrant, 'id' | 'revision' | 'revoked'> & { id?: string }): Readonly<ConnectionGrant> {
    if (!Number.isFinite(input.maxBudget) || input.maxBudget < 0 || !Number.isFinite(input.expiresAt) || input.expiresAt <= this.clock()) deny('INVALID_GRANT');
    const g: ConnectionGrant = { id: input.id ?? `grant:${randomUUID()}`, connectionId: input.connectionId,
      userId: input.userId, projectId: input.projectId, botId: input.botId, nodeId: input.nodeId, generation: input.generation, action: input.action,
      approvedBy: input.approvedBy, expiresAt: input.expiresAt, maxBudget: input.maxBudget, revision: 1, revoked: false };
    this.store.insert('grants', g.id, g); return deepFreeze(g);
  }
  get(id: string): Readonly<ConnectionGrant> { const g = this.store.get<ConnectionGrant>('grants', id); return g ? deepFreeze(g) : deny('GRANT_REQUIRED'); }
  find(connectionId: string, scope: Scope): Readonly<ConnectionGrant> {
    const choices = this.store.all<ConnectionGrant>('grants').filter(g => g.connectionId === connectionId);
    const exact = choices.find(g => sameScope(g, scope) && !g.revoked && g.expiresAt > this.clock()) ?? choices.find(g => sameScope(g, scope));
    if (!exact) deny(choices.length ? 'GRANT_SCOPE_MISMATCH' : 'GRANT_REQUIRED');
    return this.assertAuthorized(exact.id, scope);
  }
  assertAuthorized(id: string, scope: Scope, expectedRevision?: number): Readonly<ConnectionGrant> {
    const g = this.get(id); if (g.revoked) deny('GRANT_REVOKED'); if (g.expiresAt <= this.clock()) deny('GRANT_EXPIRED');
    if (expectedRevision !== undefined && expectedRevision !== g.revision) deny('GRANT_REVISION_MISMATCH');
    if (!sameScope(g, scope)) deny('GRANT_SCOPE_MISMATCH'); return g;
  }
  revoke(id: string, expectedRevision: number): { grantId: string; revision: number; upstreamCredentialRevoked: false; rotationRequired: true; affectedLeaseRefs: string[] } {
    return this.store.transaction(() => {
      const g = this.get(id); if (g.revision !== expectedRevision) deny('GRANT_REVISION_MISMATCH');
      const next = { ...g, revision: g.revision + 1, revoked: true }; this.store.replace('grants', id, next);
      const leases = this.store.all<{ id: string; grantId: string }>('leases').filter(l => l.grantId === id);
      return { grantId: id, revision: next.revision, upstreamCredentialRevoked: false, rotationRequired: true, affectedLeaseRefs: leases.map(l => l.id) };
    });
  }
}
