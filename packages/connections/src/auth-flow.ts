import { createHash, randomUUID } from 'node:crypto';
import { ConnectionStore } from './store.js';
import { ConnectionRegistry } from './registry.js';
import { projectAuth } from './fake-auth.js';
import { deny, assertSynchronousAuthorization, type Clock, type AuthInspection, type AuthInspector } from './types.js';
export interface FlowTarget { botId: string; nodeId: string; generation: number; runtime: string; connectionId: string; connectionRevision: number; }
export interface AuthFlowMetadata extends FlowTarget { id: string; status: 'waiting' | 'completed' | 'cancelled' | 'cancel_unknown' | 'expired'; expiresAt: number; expectedAccountRef?: string; }
export interface BeginAuthFlow extends FlowTarget { expectedAccountRef?: string; expiresAt: number; officialUrl: string; allowedDomains: string[]; }
export interface AuthCallback extends FlowTarget { flowId: string; state: string; callbackUrl: string; rawResponse?: unknown; deviceCode?: string; }
interface StoredFlow extends AuthFlowMetadata { stateDigest: string; allowedDomains: string[]; native?: true; }
export interface NativeAuthFlowRequest extends FlowTarget { flowId: string; state: string; expiresAt: number; expectedAccountRef?: string; }
export interface NativeAuthFlowStart { officialUrl: string; loginRef: string; deviceCode?: string; }
export interface AuthFlowInspector extends AuthInspector { begin(): void; }
export type NativeCancellationRecovery = { status: 'pending'; loginRef: string } | { status: 'confirmed' | 'unknown' | 'not_started' };
/** Trusted official runtime capability. It must recheck B authorization and Grant at each call. */
export interface NativeAuthFlowRuntime {
  readonly allowedDomains: readonly string[];
  assertAuthorized(target: FlowTarget): void;
  start(input: NativeAuthFlowRequest): Promise<NativeAuthFlowStart>;
  cancel(input: NativeAuthFlowRequest & { loginRef: string }): Promise<void>;
  inspectAuth(target: FlowTarget & { flowId?: string }): Promise<AuthInspection>;
  /** Trusted service only: recover cleanup correlation after start rejected without leaking it to metadata. */
  recoverCancellation?(original: NativeAuthFlowRequest): NativeCancellationRecovery;
  forget?(flowId: string): void;
}
function hash(state: string): string { return createHash('sha256').update(state).digest('hex'); }
function projection(f: AuthFlowMetadata): AuthFlowMetadata { return { id: f.id, status: f.status, botId: f.botId, nodeId: f.nodeId, generation: f.generation, runtime: f.runtime, connectionId: f.connectionId, connectionRevision: f.connectionRevision, expiresAt: f.expiresAt, ...(f.expectedAccountRef ? { expectedAccountRef: f.expectedAccountRef } : {}) }; }
function approvedUrl(raw: string, domains: string[]): void {
  let url: URL; try { url = new URL(raw); } catch { return deny('AUTH_URL_DENIED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !domains.includes(url.hostname)) deny('AUTH_URL_DENIED');
}
/** Dedicated trusted channel retains state only until terminal status; public status never carries state/code/token. */
export class AuthFlowService {
  private ephemeralState = new Map<string, string>();
  private ephemeralView = new Map<string, NativeAuthFlowStart>();
  private nativeRequests = new Map<string, NativeAuthFlowRequest & { loginRef: string }>();
  private nativeStarts = new Map<string, NativeAuthFlowRequest>();
  constructor(readonly store: ConnectionStore, readonly registry: ConnectionRegistry, readonly auth: AuthFlowInspector, readonly clock: Clock = Date.now, readonly adapterDomains: readonly string[] = ['auth.example.invalid'], readonly nativeRuntime?: NativeAuthFlowRuntime) {}
  async beginAsync(input: Omit<BeginAuthFlow, 'officialUrl' | 'allowedDomains'>): Promise<AuthFlowMetadata> {
    if (this.store.db.isTransaction) deny('ASYNC_TRANSACTION_FORBIDDEN');
    const runtime = this.nativeRuntime ?? deny('POLICY_RESTRICTED'); assertSynchronousAuthorization(runtime.assertAuthorized(input));
    const c = this.registry.get(input.connectionId);
    if (c.revision !== input.connectionRevision) deny('CONNECTION_REVISION_MISMATCH');
    if (c.status === 'revoked') deny('CONNECTION_REVOKED');
    if (input.expectedAccountRef && c.accountRef && input.expectedAccountRef !== c.accountRef) deny('ACCOUNT_MISMATCH');
    if (c.authMethod !== 'runtime_managed_login') deny('AUTH_MODE_MISMATCH');
    if (!c.runtimeProfiles.includes(input.runtime) || !c.allowedNodes.includes(input.nodeId)) deny('CONNECTION_INCOMPATIBLE');
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= this.clock()) deny('AUTH_FLOW_EXPIRED');
    const id = `authflow:${randomUUID()}`; const state = randomUUID();
    const f: StoredFlow = { id, status: 'waiting', botId: input.botId, nodeId: input.nodeId, generation: input.generation, runtime: input.runtime,
      connectionId: input.connectionId, connectionRevision: input.connectionRevision, expiresAt: input.expiresAt, expectedAccountRef: input.expectedAccountRef ?? c.accountRef,
      stateDigest: hash(state), allowedDomains: [...runtime.allowedDomains], native: true };
    this.store.insert('auth_flows', id, f); this.ephemeralState.set(id, state);
    const request: NativeAuthFlowRequest = { flowId: id, state, botId: f.botId, nodeId: f.nodeId, generation: f.generation, runtime: f.runtime,
      connectionId: f.connectionId, connectionRevision: f.connectionRevision, expiresAt: f.expiresAt, expectedAccountRef: f.expectedAccountRef };
    this.nativeStarts.set(id, request);
    try {
      const result = await runtime.start(request);
      this.nativeRequests.set(id, { ...request, loginRef: result.loginRef });
      this.assertWaiting(f); assertSynchronousAuthorization(runtime.assertAuthorized(f));
      if (this.registry.get(f.connectionId).revision !== f.connectionRevision) deny('CONNECTION_REVISION_MISMATCH');
      approvedUrl(result.officialUrl, f.allowedDomains);
      if (!result.loginRef || result.loginRef.length > 256) deny('AUTH_FLOW_BINDING_MISMATCH');
      this.ephemeralView.set(id, { officialUrl: result.officialUrl, loginRef: result.loginRef, ...(result.deviceCode ? { deviceCode: result.deviceCode } : {}) });
      return projection(f);
    } catch (error) {
      this.recoverNativeCancellation(id);
      if (error instanceof Error && error.message === 'AUTH_CANCEL_UNKNOWN') { this.cancel(id); return deny('AUTH_CANCEL_UNKNOWN'); }
      try { await this.cancelAsync(id); } catch {
        if (error instanceof Error && error.message === 'AUTH_NATIVE_RESPONSE_INVALID') throw error;
        return deny('AUTH_CANCEL_UNKNOWN');
      }
      // Runtime responses/errors can contain sensitive authorization material.
      if (error instanceof Error && ['AUTH_FLOW_CANCELLED', 'AUTH_FLOW_EXPIRED', 'GRANT_REVOKED', 'GRANT_EXPIRED', 'CONNECTION_REVISION_MISMATCH', 'AUTH_URL_DENIED', 'AUTH_FLOW_BINDING_MISMATCH', 'AUTH_NATIVE_RESPONSE_INVALID'].includes(error.message)) throw error;
      return deny('AUTH_FLOW_FAILED');
    }
  }
  /** Dedicated temporary auth UI only. This is never part of status/events or ordinary exports. */
  authorizationView(id: string): { officialUrl: string; deviceCode?: string } {
    const f = this.stored(id); this.assertWaiting(f);
    const view = this.ephemeralView.get(id) ?? deny('AUTH_FLOW_STATE_UNAVAILABLE');
    return { officialUrl: view.officialUrl, ...(view.deviceCode ? { deviceCode: view.deviceCode } : {}) };
  }
  async cancelAsync(id: string): Promise<AuthFlowMetadata> {
    if (this.store.db.isTransaction) deny('ASYNC_TRANSACTION_FORBIDDEN');
    const status = this.cancel(id); if (!this.stored(id).native || status.status === 'completed' || status.status === 'cancelled') return status;
    const recovery = this.recoverNativeCancellation(id);
    if (recovery?.status === 'confirmed' || recovery?.status === 'not_started') return this.confirmNativeCancellation(id);
    const request = this.nativeRequests.get(id);
    if (!request || !this.nativeRuntime) deny('AUTH_CANCEL_UNKNOWN');
    try { await this.nativeRuntime.cancel(request); } catch { deny('AUTH_CANCEL_UNKNOWN'); }
    return this.confirmNativeCancellation(id);
  }
  private recoverNativeCancellation(id: string): NativeCancellationRecovery | undefined {
    const original = this.nativeStarts.get(id); if (!original || !this.nativeRuntime?.recoverCancellation) return;
    const recovery = this.nativeRuntime.recoverCancellation(original);
    if (recovery.status === 'pending') this.nativeRequests.set(id, { ...original, loginRef: recovery.loginRef });
    return recovery;
  }
  private confirmNativeCancellation(id: string): AuthFlowMetadata {
    const f = this.stored(id); f.status = 'cancelled'; this.store.replace('auth_flows', id, f);
    this.nativeRequests.delete(id); this.nativeStarts.delete(id); this.nativeRuntime?.forget?.(id); return projection(f);
  }
  begin(input: BeginAuthFlow): AuthFlowMetadata {
    const c = this.registry.get(input.connectionId); if (c.revision !== input.connectionRevision) deny('CONNECTION_REVISION_MISMATCH');
    if (!c.runtimeProfiles.includes(input.runtime) || !c.allowedNodes.includes(input.nodeId)) deny('CONNECTION_INCOMPATIBLE');
    if (c.authMethod === 'runtime_managed_login') deny('POLICY_RESTRICTED'); // P0 has no verified real native-login capability.
    if (!Number.isFinite(input.expiresAt)) deny('AUTH_FLOW_EXPIRED');
    const domains = input.allowedDomains.filter(d => this.adapterDomains.includes(d)); approvedUrl(input.officialUrl, domains);
    const state = randomUUID(); const id = `authflow:${randomUUID()}`;
    const f: StoredFlow = { id, botId: input.botId, nodeId: input.nodeId, generation: input.generation, runtime: input.runtime,
      connectionId: input.connectionId, connectionRevision: input.connectionRevision, expectedAccountRef: input.expectedAccountRef,
      expiresAt: input.expiresAt, status: 'waiting', stateDigest: hash(state), allowedDomains: [...domains] };
    this.store.insert('auth_flows', id, f); this.ephemeralState.set(id, state); this.auth.begin(); return projection(f);
  }
  private stored(id: string): StoredFlow { return this.store.get<StoredFlow>('auth_flows', id) ?? deny('AUTH_FLOW_REQUIRED'); }
  status(id: string): AuthFlowMetadata {
    const f = this.stored(id); if (f.status === 'waiting' && f.expiresAt <= this.clock()) { f.status = 'expired'; this.store.replace('auth_flows', id, f); this.ephemeralState.delete(id); this.ephemeralView.delete(id); }
    return projection(f);
  }
  /** Trusted adapter transport only. Never expose this method through general Renderer IPC. */
  callbackBinding(id: string): Omit<AuthCallback, 'callbackUrl'> {
    const f = this.stored(id); const state = this.ephemeralState.get(id) ?? deny('AUTH_FLOW_STATE_UNAVAILABLE');
    return { flowId: id, state, botId: f.botId, nodeId: f.nodeId, generation: f.generation, runtime: f.runtime, connectionId: f.connectionId, connectionRevision: f.connectionRevision };
  }
  private assertWaiting(original: StoredFlow): void {
    this.status(original.id); const current = this.stored(original.id);
    if (current.status === 'cancelled' || current.status === 'cancel_unknown') deny('AUTH_FLOW_CANCELLED');
    if (current.status === 'expired' || current.expiresAt <= this.clock()) deny('AUTH_FLOW_EXPIRED');
    if (current.status !== 'waiting' || !this.ephemeralState.has(original.id)) deny('AUTH_FLOW_STATE_UNAVAILABLE');
    if (current.stateDigest !== original.stateDigest) deny('AUTH_FLOW_BINDING_MISMATCH');
  }
  cancel(id: string): AuthFlowMetadata {
    const f = this.stored(id); if (f.status === 'waiting' || (f.native && f.status === 'expired')) { f.status = f.native ? 'cancel_unknown' : 'cancelled'; this.store.replace('auth_flows', id, f); } this.ephemeralState.delete(id); this.ephemeralView.delete(id); return projection(f);
  }
  complete(callback: AuthCallback): AuthFlowMetadata {
    if (this.stored(callback.flowId).native) deny('ASYNC_AUTH_INSPECTION_REQUIRED');
    const f = this.validateCallback(callback);
    const actual = this.auth.inspectAuth(f);
    return this.completeInspection(f, actual);
  }
  async completeAsync(callback: AuthCallback): Promise<AuthFlowMetadata> {
    if (this.store.db.isTransaction) deny('ASYNC_TRANSACTION_FORBIDDEN');
    const f = this.validateCallback(callback); if (!f.native) deny('POLICY_RESTRICTED');
    const runtime = this.nativeRuntime ?? deny('POLICY_RESTRICTED'); assertSynchronousAuthorization(runtime.assertAuthorized(f));
    let actual: AuthInspection;
    try { actual = projectAuth(await runtime.inspectAuth({ ...f, flowId: f.id })); } catch (error) {
      if (error instanceof Error && ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_FLOW_BINDING_MISMATCH', 'AUTH_FLOW_CANCELLED', 'AUTH_MODE_MISMATCH', 'GRANT_REVOKED'].includes(error.message)) throw error;
      return deny('AUTH_INSPECTION_FAILED');
    }
    this.assertWaiting(f); assertSynchronousAuthorization(runtime.assertAuthorized(f));
    return this.completeInspection(f, actual);
  }
  private validateCallback(callback: AuthCallback): StoredFlow {
    const f = this.stored(callback.flowId);
    if (f.status === 'cancelled' || f.status === 'cancel_unknown') deny('AUTH_FLOW_CANCELLED');
    if (f.expiresAt <= this.clock() || f.status === 'expired') { this.status(f.id); deny('AUTH_FLOW_EXPIRED'); }
    if (f.status !== 'waiting' || !this.ephemeralState.has(f.id)) deny('AUTH_FLOW_STATE_UNAVAILABLE');
    if (hash(callback.state) !== f.stateDigest || ['botId', 'nodeId', 'generation', 'runtime', 'connectionId', 'connectionRevision'].some(k => f[k as keyof FlowTarget] !== callback[k as keyof FlowTarget])) deny('AUTH_FLOW_BINDING_MISMATCH');
    approvedUrl(callback.callbackUrl, f.allowedDomains);
    if (this.registry.get(f.connectionId).revision !== f.connectionRevision) deny('CONNECTION_REVISION_MISMATCH');
    return f;
  }
  private completeInspection(f: StoredFlow, actual: AuthInspection): AuthFlowMetadata {
    this.assertWaiting(f);
    if (actual.status !== 'valid') deny(actual.status === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED');
    if (actual.expiresAt <= this.clock()) deny('AUTH_EXPIRED');
    if (actual.botId !== f.botId || actual.nodeId !== f.nodeId || actual.generation !== f.generation || actual.runtime !== f.runtime) deny('AUTH_FLOW_BINDING_MISMATCH');
    if (actual.accountRef !== f.expectedAccountRef && f.expectedAccountRef) deny('ACCOUNT_MISMATCH');
    if (actual.authMethod !== this.registry.get(f.connectionId).authMethod) deny('AUTH_MODE_MISMATCH');
    return this.store.transaction(() => {
      this.assertWaiting(f);
      if (f.native) assertSynchronousAuthorization(this.nativeRuntime?.assertAuthorized(f));
      if (this.registry.get(f.connectionId).revision !== f.connectionRevision) deny('CONNECTION_REVISION_MISMATCH');
      const session = projectAuth(actual); const existing = this.store.get<AuthInspection>('auth_sessions', session.authSessionRef);
      if (existing && (existing.botId !== session.botId || existing.nodeId !== session.nodeId || existing.generation !== session.generation || existing.runtime !== session.runtime)) deny('AUTH_SESSION_BINDING_MISMATCH');
      if (existing) this.store.replace('auth_sessions', session.authSessionRef, session); else this.store.insert('auth_sessions', session.authSessionRef, session);
      f.status = 'completed'; this.store.replace('auth_flows', f.id, f); this.ephemeralState.delete(f.id); this.ephemeralView.delete(f.id); this.nativeRequests.delete(f.id); this.nativeStarts.delete(f.id); this.nativeRuntime?.forget?.(f.id); return projection(f);
    });
  }
}
