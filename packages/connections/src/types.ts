export type AuthMethod = 'runtime_managed_login' | 'api_key' | 'gateway_credential' | 'local_endpoint';
export type BillingSource = 'subscription' | 'console' | 'api' | 'organization_gateway' | 'local' | 'unknown';
export type EvidenceSource = 'provider_reported' | 'runtime_estimated' | 'gateway_measured' | 'user_declared' | 'unknown';
export type Clock = () => number;
export interface Connection {
  id: string; name: string; provider: string; runtimeProfiles: string[]; authMethod: AuthMethod;
  billingSource: BillingSource; billingEvidence: EvidenceSource; accountRef?: string; route: 'direct' | 'gateway' | 'local';
  endpoint: string; allowedModels: string[]; credentialRef?: string; dataPolicy: 'local_only' | 'cloud_allowed'; allowedNodes: string[];
  fallbackPolicy: 'deny' | 'ask_user'; status: 'ready' | 'revoked' | 'unknown'; revision: number;
}
export interface Scope { userId: string; projectId: string; botId: string; nodeId: string; generation: number; action: string; }
export interface ConnectionGrant extends Scope { id: string; connectionId: string; approvedBy: string; expiresAt: number; maxBudget: number; revision: number; revoked: boolean; }
export interface AuthInspection {
  status: 'valid' | 'required' | 'expired' | 'quota_limited'; authMethod: AuthMethod; accountRef?: string;
  billingSource: BillingSource; billingEvidence: EvidenceSource; authSessionRef: string;
  nodeId: string; botId: string; generation: number; runtime: string; expiresAt: number;
}
export interface ResolveRequest extends Scope {
  defaultConnectionId: string; explicitConnectionId?: string; runId: string; taskId: string; runtimeSessionRef: string;
  runtime: string; model: string; budget: number; expiresAt: number; nodeLocation: 'local' | 'remote';
  processingSources: { stage: string; location: 'local' | 'remote' }[]; localOnly?: boolean; gatewayRequired?: boolean;
  requireAccount?: boolean; requireKnownBilling?: boolean; allowedBillingSources?: BillingSource[];
  inheritedEnvironment?: Record<string, string>; runtimePolicy: { nativeLoginAllowed: boolean; authMethods: AuthMethod[] }; userAcceptsRisk?: boolean;
}
export interface ResolvedConnectionSnapshot extends Scope {
  id: string; connectionId: string; connectionRevision: number; grantId: string; grantRevision: number;
  fallbackApprovalRef?: string; fallbackApprovalRevision?: number;
  authMethod: AuthMethod; billingSource: BillingSource; billingEvidence: EvidenceSource; accountRef?: string; route: Connection['route'];
  endpointDigest: string; runtime: string; model: string; authSessionRef: string; runtimeSessionRef: string;
  executionLeaseRef: string; gatewayLeaseRef?: string; upstreamCredentialRef?: string; runId: string; taskId: string;
  expiresAt: number; budget: number; sharedUpstreamLimits: true; usage: { amount: null; source: 'unknown' };
}
export class ConnectionError extends Error { constructor(public readonly code: string) { super(code); this.name = 'ConnectionError'; } }
export function deny(code: string): never { throw new ConnectionError(code); }
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
export const scopeFields = ['userId', 'projectId', 'botId', 'nodeId', 'generation', 'action'] as const;
export function sameScope(a: Scope, b: Scope): boolean { return scopeFields.every(key => a[key] === b[key]); }
