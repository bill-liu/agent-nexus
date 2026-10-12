import { createHash, randomUUID } from 'node:crypto';
import { ConnectionStore } from './store.js';
import { ConnectionRegistry } from './registry.js';
import { FakeAuthAdapter, projectAuth } from './fake-auth.js';
import { deny, type Clock, type AuthInspection } from './types.js';
interface FlowTarget { botId: string; nodeId: string; generation: number; runtime: string; connectionId: string; connectionRevision: number; }
export interface AuthFlowMetadata extends FlowTarget { id: string; status: 'waiting' | 'completed' | 'cancelled' | 'expired'; expiresAt: number; expectedAccountRef?: string; }
export interface BeginAuthFlow extends FlowTarget { expectedAccountRef?: string; expiresAt: number; officialUrl: string; allowedDomains: string[]; }
export interface AuthCallback extends FlowTarget { flowId: string; state: string; callbackUrl: string; rawResponse?: unknown; deviceCode?: string; }
interface StoredFlow extends AuthFlowMetadata { stateDigest: string; allowedDomains: string[]; }
function hash(state: string): string { return createHash('sha256').update(state).digest('hex'); }
function projection(f: AuthFlowMetadata): AuthFlowMetadata { return { id: f.id, status: f.status, botId: f.botId, nodeId: f.nodeId, generation: f.generation, runtime: f.runtime, connectionId: f.connectionId, connectionRevision: f.connectionRevision, expiresAt: f.expiresAt, ...(f.expectedAccountRef ? { expectedAccountRef: f.expectedAccountRef } : {}) }; }
function approvedUrl(raw: string, domains: string[]): void {
  let url: URL; try { url = new URL(raw); } catch { return deny('AUTH_URL_DENIED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !domains.includes(url.hostname)) deny('AUTH_URL_DENIED');
}
/** Dedicated trusted channel retains state only until terminal status; public status never carries state/code/token. */
export class AuthFlowService {
  private ephemeralState = new Map<string, string>();
  constructor(readonly store: ConnectionStore, readonly registry: ConnectionRegistry, readonly auth: FakeAuthAdapter, readonly clock: Clock = Date.now, readonly adapterDomains: readonly string[] = ['auth.example.invalid']) {}
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
    const f = this.stored(id); if (f.status === 'waiting' && f.expiresAt <= this.clock()) { f.status = 'expired'; this.store.replace('auth_flows', id, f); this.ephemeralState.delete(id); }
    return projection(f);
  }
  /** Trusted adapter transport only. Never expose this method through general Renderer IPC. */
  callbackBinding(id: string): Omit<AuthCallback, 'callbackUrl'> {
    const f = this.stored(id); const state = this.ephemeralState.get(id) ?? deny('AUTH_FLOW_STATE_UNAVAILABLE');
    return { flowId: id, state, botId: f.botId, nodeId: f.nodeId, generation: f.generation, runtime: f.runtime, connectionId: f.connectionId, connectionRevision: f.connectionRevision };
  }
  private assertWaiting(original: StoredFlow): void {
    this.status(original.id); const current = this.stored(original.id);
    if (current.status === 'cancelled') deny('AUTH_FLOW_CANCELLED');
    if (current.status === 'expired' || current.expiresAt <= this.clock()) deny('AUTH_FLOW_EXPIRED');
    if (current.status !== 'waiting' || !this.ephemeralState.has(original.id)) deny('AUTH_FLOW_STATE_UNAVAILABLE');
    if (current.stateDigest !== original.stateDigest) deny('AUTH_FLOW_BINDING_MISMATCH');
  }
  cancel(id: string): AuthFlowMetadata {
    const f = this.stored(id); if (f.status === 'waiting') { f.status = 'cancelled'; this.store.replace('auth_flows', id, f); } this.ephemeralState.delete(id); return projection(f);
  }
  complete(callback: AuthCallback): AuthFlowMetadata {
    const f = this.stored(callback.flowId);
    if (f.status === 'cancelled') deny('AUTH_FLOW_CANCELLED');
    if (f.expiresAt <= this.clock() || f.status === 'expired') { this.status(f.id); deny('AUTH_FLOW_EXPIRED'); }
    if (f.status !== 'waiting' || !this.ephemeralState.has(f.id)) deny('AUTH_FLOW_STATE_UNAVAILABLE');
    if (hash(callback.state) !== f.stateDigest || ['botId', 'nodeId', 'generation', 'runtime', 'connectionId', 'connectionRevision'].some(k => f[k as keyof FlowTarget] !== callback[k as keyof FlowTarget])) deny('AUTH_FLOW_BINDING_MISMATCH');
    approvedUrl(callback.callbackUrl, f.allowedDomains);
    if (this.registry.get(f.connectionId).revision !== f.connectionRevision) deny('CONNECTION_REVISION_MISMATCH');
    const actual = this.auth.inspectAuth(f);
    this.assertWaiting(f);
    if (actual.status !== 'valid') deny(actual.status === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED');
    if (actual.expiresAt <= this.clock()) deny('AUTH_EXPIRED');
    if (actual.botId !== f.botId || actual.nodeId !== f.nodeId || actual.generation !== f.generation || actual.runtime !== f.runtime) deny('AUTH_FLOW_BINDING_MISMATCH');
    if (actual.accountRef !== f.expectedAccountRef && f.expectedAccountRef) deny('ACCOUNT_MISMATCH');
    if (actual.authMethod !== this.registry.get(f.connectionId).authMethod) deny('AUTH_MODE_MISMATCH');
    return this.store.transaction(() => {
      this.assertWaiting(f);
      if (this.registry.get(f.connectionId).revision !== f.connectionRevision) deny('CONNECTION_REVISION_MISMATCH');
      const session = projectAuth(actual); const existing = this.store.get<AuthInspection>('auth_sessions', session.authSessionRef);
      if (existing && (existing.botId !== session.botId || existing.nodeId !== session.nodeId || existing.generation !== session.generation || existing.runtime !== session.runtime)) deny('AUTH_SESSION_BINDING_MISMATCH');
      if (existing) this.store.replace('auth_sessions', session.authSessionRef, session); else this.store.insert('auth_sessions', session.authSessionRef, session);
      f.status = 'completed'; this.store.replace('auth_flows', f.id, f); this.ephemeralState.delete(f.id); return projection(f);
    });
  }
}
