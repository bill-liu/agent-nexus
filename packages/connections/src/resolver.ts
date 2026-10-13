import { randomUUID } from 'node:crypto';
import { ConnectionRegistry } from './registry.js';
import { GrantService } from './grants.js';
import { isolatedEnvironment, projectAuth } from './fake-auth.js';
import type { SecretStorageBackend } from '../../desktop-platform/src/secrets.js';
import { LeaseService, endpointDigest } from './leases.js';
import { deepFreeze, deny, sameScope, sameExecutionBinding, type AuthInspection, type AuthInspector, type AsyncAuthInspector, type ResolveRequest, type ResolvedConnectionSnapshot, type Scope } from './types.js';
export interface FallbackApproval { connectionId: string; projectId: string; reason: string; expiresAt: number; maxBudget: number; dataPolicy: 'local_only' | 'cloud_allowed'; }
export interface RegisteredFallbackApproval extends FallbackApproval, Scope { id: string; revision: number; connectionRevision: number; revoked: boolean; approvedBy: string; }
interface FallbackContext { old: ResolvedConnectionSnapshot; approval: RegisteredFallbackApproval; reason: string; }
export class ConnectionResolver {
  constructor(readonly registry: ConnectionRegistry, readonly grants: GrantService, readonly auth: AuthInspector, readonly leases: LeaseService, readonly liveAdmission?: { secretBackend: SecretStorageBackend }) {}
  resolve(r: ResolveRequest): Readonly<ResolvedConnectionSnapshot> { return this.resolveBound(r); }
  async resolveAsync(request: ResolveRequest, auth: AsyncAuthInspector): Promise<Readonly<ResolvedConnectionSnapshot>> {
    if (this.registry.store.db.isTransaction) deny('ASYNC_TRANSACTION_FORBIDDEN');
    // Keep a scoped immutable request across the await. No SQLite transaction spans inspection.
    const r: ResolveRequest = deepFreeze(structuredClone(request));
    this.assertLiveSelection(r);
    const c = this.registry.get(r.explicitConnectionId ?? r.defaultConnectionId); const grant = this.grants.find(c.id, r);
    const environment = this.environment(r, c.authMethod);
    this.assertLiveEvidence(r, auth.evidenceKind);
    let actual: AuthInspection;
    try { actual = projectAuth(await auth.inspectAuth(r, environment)); } catch (error) {
      if (error instanceof Error && ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_MODE_MISMATCH', 'AUTH_TARGET_MISMATCH', 'GRANT_REVOKED', 'GRANT_EXPIRED', 'POLICY_RESTRICTED'].includes(error.message)) throw error;
      return deny('AUTH_INSPECTION_FAILED');
    }
    this.grants.assertAuthorized(grant.id, r, grant.revision);
    if (this.registry.get(c.id).revision !== c.revision) deny('CONNECTION_REVISION_MISMATCH');
    return this.resolveBound(r, undefined, { actual, evidenceKind: auth.evidenceKind, connectionRevision: c.revision, grantId: grant.id, grantRevision: grant.revision });
  }
  private assertLiveSelection(r: ResolveRequest): void { if (r.executionMode === 'live' && !r.explicitConnectionId) deny('EXPLICIT_CONNECTION_REQUIRED'); }
  private assertLiveEvidence(r: ResolveRequest, evidenceKind?: string): void { if (r.executionMode === 'live' && evidenceKind !== 'runtime_reported') deny('LIVE_AUTH_EVIDENCE_REQUIRED'); }
  private environment(r: ResolveRequest, method: string): Record<string, string> {
    if (r.executionMode === 'live' && Object.entries(r.inheritedEnvironment ?? {}).some(([key, value]) => value && /(?:KEY|TOKEN|SECRET|AUTH|CREDENTIAL|HOME|CONFIG|PROXY)/i.test(key))) deny('AUTH_MODE_MISMATCH');
    return isolatedEnvironment(r.inheritedEnvironment);
  }
  private resolveBound(r: ResolveRequest, fallback?: FallbackContext, inspected?: { actual: AuthInspection; evidenceKind?: string; connectionRevision: number; grantId: string; grantRevision: number }): Readonly<ResolvedConnectionSnapshot> {
    this.assertLiveSelection(r);
    const c = this.registry.get(r.explicitConnectionId ?? r.defaultConnectionId);
    const grant = this.grants.find(c.id, r);
    if (inspected && (inspected.connectionRevision !== c.revision || inspected.grantId !== grant.id || inspected.grantRevision !== grant.revision)) deny('CONNECTION_REVISION_MISMATCH');
    if (c.status === 'revoked') deny('CONNECTION_REVOKED'); if (c.status !== 'ready') deny('CONNECTION_UNVERIFIED');
    if (!Number.isFinite(r.budget) || r.budget < 0 || r.budget > grant.maxBudget) deny('BUDGET_EXCEEDED');
    if (r.gatewayRequired && c.route !== 'gateway') deny('GATEWAY_REQUIRED');
    if ((r.localOnly || c.dataPolicy === 'local_only') && (c.route !== 'local' || r.nodeLocation !== 'local' || r.processingSources.some(s => s.location !== 'local'))) deny('DATA_POLICY_DENIED');
    if (!c.runtimeProfiles.includes(r.runtime) || !c.allowedModels.includes(r.model) || !c.allowedNodes.includes(r.nodeId)) deny('CONNECTION_INCOMPATIBLE');
    if ((c.authMethod === 'runtime_managed_login' && !r.runtimePolicy.nativeLoginAllowed) || !r.runtimePolicy.authMethods.includes(c.authMethod)) deny('POLICY_RESTRICTED');
    if (c.route === 'gateway' && !this.leases.gatewayAvailable) deny('GATEWAY_UNAVAILABLE');
    const environment = this.environment(r, c.authMethod);
    this.assertLiveEvidence(r, inspected?.evidenceKind ?? this.auth.evidenceKind);
    if (r.executionMode === 'live' && (c.provider === 'fake' || c.runtimeProfiles.some(p => p.startsWith('fake-')))) deny('LIVE_CONNECTION_REQUIRED');
    if (r.executionMode === 'live' && c.credentialRef && this.liveAdmission?.secretBackend !== 'macos_safe_storage') deny('LIVE_SECRET_BACKEND_REQUIRED');
    const actual = inspected?.actual ?? projectAuth(this.auth.inspectAuth(r, environment));
    if (r.executionMode === 'live' && !sameExecutionBinding(r.executionBinding, actual.executionBinding)) deny('AUTH_TARGET_MISMATCH');
    if (r.executionMode === 'live' && (actual.observedAt === undefined || !Number.isFinite(actual.observedAt) || actual.observedAt > this.grants.clock() || actual.observedAt < this.grants.clock() - 30_000)) deny('AUTH_EXPIRED');
    if (actual.status !== 'valid') deny(actual.status === 'expired' ? 'AUTH_EXPIRED' : actual.status === 'quota_limited' ? 'USAGE_LIMITED' : 'AUTH_REQUIRED');
    if (actual.expiresAt <= this.grants.clock()) deny('AUTH_EXPIRED');
    if (actual.authMethod !== c.authMethod) deny('AUTH_MODE_MISMATCH');
    if (actual.botId !== r.botId || actual.nodeId !== r.nodeId || actual.generation !== r.generation || actual.runtime !== r.runtime) deny('AUTH_TARGET_MISMATCH');
    if (actual.accountRef && c.accountRef && actual.accountRef !== c.accountRef) deny('ACCOUNT_MISMATCH');
    if (r.requireAccount !== false && !actual.accountRef) deny('ACCOUNT_UNKNOWN');
    if (actual.billingSource !== 'unknown' && c.billingSource !== 'unknown' && actual.billingSource !== c.billingSource) deny('BILLING_SOURCE_MISMATCH');
    if ((r.requireKnownBilling && (actual.billingSource === 'unknown' || actual.billingEvidence === 'unknown')) || (r.allowedBillingSources && !r.allowedBillingSources.includes(actual.billingSource))) deny('BILLING_UNKNOWN');
    const expiresAt = Math.min(r.expiresAt, grant.expiresAt, actual.expiresAt, fallback?.approval.expiresAt ?? Infinity); if (!Number.isFinite(expiresAt) || expiresAt <= this.grants.clock()) deny('LEASE_EXPIRED');
    const s: ResolvedConnectionSnapshot = {
      ...(r.executionMode === 'live' ? { executionMode: 'live', authEvidenceKind: 'runtime_reported' } : {}),
      ...(actual.executionBinding ? { authExecutionBinding: actual.executionBinding } : {}),
      id: `snapshot:${randomUUID()}`, userId: r.userId, projectId: r.projectId, botId: r.botId, nodeId: r.nodeId, generation: r.generation, action: r.action,
      connectionId: c.id, connectionRevision: c.revision, grantId: grant.id, grantRevision: grant.revision,
      ...(fallback ? { fallbackApprovalRef: fallback.approval.id, fallbackApprovalRevision: fallback.approval.revision } : {}),
      authMethod: actual.authMethod, billingSource: actual.billingSource, billingEvidence: actual.billingEvidence,
      ...(actual.accountRef ? { accountRef: actual.accountRef } : {}), route: c.route, endpointDigest: endpointDigest(c.endpoint), runtime: r.runtime,
      model: r.model, authSessionRef: actual.authSessionRef, runtimeSessionRef: r.runtimeSessionRef,
      executionLeaseRef: `execution:${randomUUID()}`, ...(c.route === 'gateway' ? { gatewayLeaseRef: `gateway:${randomUUID()}` } : {}),
      ...(c.credentialRef ? { upstreamCredentialRef: c.credentialRef } : {}), runId: r.runId, taskId: r.taskId, expiresAt, budget: r.budget,
      sharedUpstreamLimits: true, usage: { amount: null, source: 'unknown' }
    };
    return this.registry.store.transaction(() => {
      this.grants.assertAuthorized(grant.id, r, grant.revision);
      if (fallback) this.assertFallback(r, fallback.approval, fallback.reason);
      if (this.registry.get(c.id).revision !== c.revision) deny('CONNECTION_REVISION_MISMATCH');
      this.registry.store.insert('snapshots', s.id, s); this.leases.issue('execution', s); if (s.gatewayLeaseRef) this.leases.issue('gateway', s);
      if (fallback) {
        this.leases.revoke(fallback.old.executionLeaseRef); if (fallback.old.gatewayLeaseRef) this.leases.revoke(fallback.old.gatewayLeaseRef);
        const id = `switch:${randomUUID()}`; this.registry.store.insert('switches', id, { id, taskId: fallback.old.taskId, oldSnapshotRef: fallback.old.id, newSnapshotRef: s.id, fallbackApprovalRef: fallback.approval.id, fallbackApprovalRevision: fallback.approval.revision, reason: fallback.reason, oldRunStopped: true, sideEffects: 'reconciled' });
      }
      return deepFreeze(s);
    });
  }
  /** Call synchronously inside the final core start transaction, immediately before creating the dispatch outbox. */
  authorizeStart(supplied: ResolvedConnectionSnapshot, r: ResolveRequest): Readonly<ResolvedConnectionSnapshot> {
    const s = this.registry.store.snapshot(supplied.id);
    if (JSON.stringify(s) !== JSON.stringify(supplied)) deny('SNAPSHOT_MISMATCH');
    if ((r.executionMode === 'live') !== (s.executionMode === 'live')) deny('SNAPSHOT_SCOPE_MISMATCH');
    if (s.executionMode === 'live' && (r.explicitConnectionId !== s.connectionId || s.authEvidenceKind !== 'runtime_reported')) deny('LIVE_AUTH_EVIDENCE_REQUIRED');
    if (s.executionMode === 'live' && !sameExecutionBinding(s.authExecutionBinding, r.executionBinding)) deny('AUTH_TARGET_MISMATCH');
    this.grants.assertAuthorized(s.grantId, r, s.grantRevision);
    if (!sameScope(s, r) || s.runId !== r.runId || s.taskId !== r.taskId || s.runtime !== r.runtime || s.model !== r.model || s.runtimeSessionRef !== r.runtimeSessionRef) deny('SNAPSHOT_SCOPE_MISMATCH');
    const c = this.registry.get(s.connectionId); if (c.revision !== s.connectionRevision || c.status !== 'ready') deny('CONNECTION_REVISION_MISMATCH');
    if (s.route === 'gateway' && !this.leases.gatewayAvailable) deny('GATEWAY_UNAVAILABLE');
    this.leases.get(s.executionLeaseRef, 'execution'); return s;
  }
  approveFallback(scope: Scope, input: FallbackApproval): Readonly<RegisteredFallbackApproval> {
    if (scope.projectId !== input.projectId || !Number.isFinite(input.maxBudget) || input.maxBudget < 0 || !Number.isFinite(input.expiresAt)) deny('FALLBACK_NOT_APPROVED');
    const c = this.registry.get(input.connectionId); this.grants.find(c.id, scope);
    const approval: RegisteredFallbackApproval = { id: `fallback:${randomUUID()}`, revision: 1, connectionRevision: c.revision, revoked: false, approvedBy: scope.userId,
      userId: scope.userId, projectId: scope.projectId, botId: scope.botId, nodeId: scope.nodeId, generation: scope.generation, action: scope.action,
      connectionId: input.connectionId, reason: input.reason, expiresAt: input.expiresAt, maxBudget: input.maxBudget, dataPolicy: input.dataPolicy };
    this.registry.store.insert('fallback_approvals', approval.id, approval); return deepFreeze(approval);
  }
  revokeFallback(id: string, expectedRevision: number): void {
    this.registry.store.transaction(() => {
      const old = this.registry.store.get<RegisteredFallbackApproval>('fallback_approvals', id);
      if (!old || old.revision !== expectedRevision) deny('FALLBACK_NOT_APPROVED');
      this.registry.store.replace('fallback_approvals', id, { ...old, revision: old.revision + 1, revoked: true });
    });
  }
  private assertFallback(r: ResolveRequest, suppliedApproval: RegisteredFallbackApproval, reason: string): RegisteredFallbackApproval {
    const approval = this.registry.store.get<RegisteredFallbackApproval>('fallback_approvals', suppliedApproval.id);
    if (!approval || approval.revoked || approval.revision !== suppliedApproval.revision || !sameScope(approval, r)) deny('FALLBACK_NOT_APPROVED');
    const selected = r.explicitConnectionId ?? r.defaultConnectionId;
    if (this.registry.get(selected).revision !== approval.connectionRevision) deny('FALLBACK_NOT_APPROVED');
    if (approval.connectionId !== selected || approval.reason !== reason || approval.expiresAt <= this.grants.clock() || r.budget > approval.maxBudget) deny('FALLBACK_NOT_APPROVED');
    if (approval.dataPolicy === 'local_only' && (!r.localOnly || this.registry.get(selected).route !== 'local')) deny('DATA_POLICY_DENIED');
    return approval;
  }
  switchConnection(old: ResolvedConnectionSnapshot, r: ResolveRequest, suppliedApproval: RegisteredFallbackApproval, evidence: { stopped: boolean; sideEffects: 'reconciled' | 'unknown'; reason: string }): Readonly<ResolvedConnectionSnapshot> {
    if (!evidence.stopped || evidence.sideEffects !== 'reconciled') deny('STATE_UNKNOWN');
    const persistedOld = this.registry.store.snapshot(old.id);
    if (JSON.stringify(persistedOld) !== JSON.stringify(old)) deny('SNAPSHOT_MISMATCH');
    if (!sameScope(persistedOld, r)) deny('FALLBACK_NOT_APPROVED');
    const approval = this.assertFallback(r, suppliedApproval, evidence.reason);
    if (r.taskId !== persistedOld.taskId || r.runId === persistedOld.runId || r.runtimeSessionRef === persistedOld.runtimeSessionRef) deny('NEW_RUNTIME_SESSION_REQUIRED');
    // Auth inspection precedes the write transaction, so concurrent cancellation/revocation is not rolled back with a rejected switch.
    return this.resolveBound(r, { old: persistedOld, approval, reason: evidence.reason });
  }
  assertCredentialTransition(old: ResolvedConnectionSnapshot, credentialRef: string, actual: { sessionRef: string; updateProtocolVerified: boolean; applyCredential?: (credentialRef: string) => { credentialRef: string; sessionRef: string } }): 'unchanged' | 'verified_update' | 'new_session' {
    if (old.upstreamCredentialRef === credentialRef) return 'unchanged';
    if (actual.sessionRef !== old.runtimeSessionRef) return 'new_session';
    if (actual.updateProtocolVerified && actual.applyCredential) {
      const applied = actual.applyCredential(credentialRef);
      if (applied.credentialRef !== credentialRef || applied.sessionRef !== old.runtimeSessionRef) deny('AUTH_MODE_MISMATCH');
      return 'verified_update';
    }
    return deny('NEW_RUNTIME_SESSION_REQUIRED');
  }
}
