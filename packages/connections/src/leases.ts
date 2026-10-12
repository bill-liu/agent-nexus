import { randomUUID, createHash } from 'node:crypto';
import { ConnectionStore } from './store.js';
import { ConnectionRegistry } from './registry.js';
import { GrantService } from './grants.js';
import type { RegisteredFallbackApproval } from './resolver.js';
import { deny, sameScope, type Clock, type ResolvedConnectionSnapshot, type Scope } from './types.js';
export function endpointDigest(endpoint: string): string { return createHash('sha256').update(new URL(endpoint).href).digest('hex'); }
export interface CredentialLease extends Scope {
  id: string; kind: 'execution' | 'gateway'; epoch: string; grantId: string; grantRevision: number; connectionId: string;
  connectionRevision: number; snapshotId: string; runId: string; model: string; endpointDigest: string; expiresAt: number; maxBudget: number; spent: number; revoked: boolean;
}
export class LeaseService {
  gatewayAvailable = true;
  private readonly epoch = randomUUID();
  constructor(readonly store: ConnectionStore, readonly clock: Clock = Date.now) {}
  issue(kind: CredentialLease['kind'], s: ResolvedConnectionSnapshot): string {
    const id = kind === 'execution' ? s.executionLeaseRef : s.gatewayLeaseRef!;
    const l: CredentialLease = { id, kind, epoch: this.epoch, grantId: s.grantId, grantRevision: s.grantRevision, connectionId: s.connectionId,
      connectionRevision: s.connectionRevision, snapshotId: s.id, userId: s.userId, projectId: s.projectId, botId: s.botId,
      nodeId: s.nodeId, generation: s.generation, action: s.action, runId: s.runId, model: s.model, endpointDigest: s.endpointDigest,
      expiresAt: s.expiresAt, maxBudget: s.budget, spent: 0, revoked: false };
    this.store.insert('leases', id, l); return id;
  }
  get(id: string, kind: CredentialLease['kind']): CredentialLease {
    const l = this.store.get<CredentialLease>('leases', id); if (!l || l.kind !== kind) deny('LEASE_REQUIRED');
    if (l.revoked || l.epoch !== this.epoch) deny('LEASE_REVOKED'); if (l.expiresAt <= this.clock()) deny('LEASE_EXPIRED');
    const snapshot = this.store.snapshot(l.snapshotId);
    if (snapshot.fallbackApprovalRef) {
      const approval = this.store.get<RegisteredFallbackApproval>('fallback_approvals', snapshot.fallbackApprovalRef);
      if (!approval || approval.revoked || approval.revision !== snapshot.fallbackApprovalRevision || approval.expiresAt <= this.clock() || !sameScope(approval, l) || approval.connectionId !== l.connectionId || approval.connectionRevision !== l.connectionRevision || snapshot.budget > approval.maxBudget) deny('FALLBACK_NOT_APPROVED');
    } else if (snapshot.fallbackApprovalRevision !== undefined) deny('FALLBACK_NOT_APPROVED');
    return l;
  }
  revoke(id: string): void { const l = this.store.get<CredentialLease>('leases', id); if (!l) deny('LEASE_REQUIRED'); this.store.replace('leases', id, { ...l, revoked: true }); }
  charge(id: string, amount: number): void {
    const l = this.get(id, 'gateway'); if (!Number.isFinite(amount) || amount < 0 || l.spent + amount > l.maxBudget) deny('BUDGET_EXCEEDED');
    this.store.replace('leases', id, { ...l, spent: l.spent + amount });
  }
}
export interface GatewayRequest extends Scope { runId: string; model: string; endpoint: string; budget: number; }
/** Fake acceptance is a protocol fixture, not a real upstream call or measured bill. */
export class FakeGateway {
  acceptedRequests = 0;
  constructor(readonly grants: GrantService, readonly registry: ConnectionRegistry, readonly leases: LeaseService) {}
  setAvailable(available: boolean): void { this.leases.gatewayAvailable = available; }
  request(leaseRef: string, request: GatewayRequest): { status: 'fake_accepted'; usage: { amount: null; source: 'unknown' } } {
    if (!this.leases.gatewayAvailable) deny('GATEWAY_UNAVAILABLE');
    return this.leases.store.transaction(() => {
      const l = this.leases.get(leaseRef, 'gateway'); this.grants.assertAuthorized(l.grantId, request, l.grantRevision);
      if (!sameScope(l, request) || request.runId !== l.runId) deny('LEASE_SCOPE_MISMATCH');
      const c = this.registry.get(l.connectionId); if (c.status !== 'ready' || c.route !== 'gateway' || c.revision !== l.connectionRevision) deny('CONNECTION_REVISION_MISMATCH');
      if (request.model !== l.model || endpointDigest(request.endpoint) !== l.endpointDigest) deny('GATEWAY_DESTINATION_DENIED');
      this.leases.get(this.leases.store.snapshot(l.snapshotId).executionLeaseRef, 'execution');
      this.leases.charge(l.id, request.budget); this.acceptedRequests++;
      return { status: 'fake_accepted', usage: { amount: null, source: 'unknown' } };
    });
  }
}
