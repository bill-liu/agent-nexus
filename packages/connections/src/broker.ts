export { FakeSecretVault, SecretBroker } from '../../desktop-platform/src/secrets.js';
import type { ExecutionSecretSource } from '../../desktop-platform/src/secrets.js';
import type { ConnectionResolver } from './resolver.js';
import { deny, type ResolveRequest, type ResolvedConnectionSnapshot } from './types.js';
/** Trusted Main/Node only. Renderer receives the separate save/revoke SecretBroker. */
export class TrustedExecutionSecretBroker {
  constructor(private readonly vault: ExecutionSecretSource, private readonly resolver: ConnectionResolver) {}
  async withExecutionSecret<T>(supplied: ResolvedConnectionSnapshot, request: ResolveRequest, deliver: (bytes: Uint8Array) => Promise<T>): Promise<T> {
    const snapshot = this.resolver.authorizeStart(supplied, request);
    if (snapshot.executionMode !== 'live' || this.vault.storage !== 'macos_safe_storage') deny('LIVE_SECRET_BACKEND_REQUIRED');
    if (!this.vault.isAvailable()) deny('SECRET_STORAGE_UNAVAILABLE');
    if (snapshot.authMethod !== 'api_key' && snapshot.authMethod !== 'gateway_credential') deny('AUTH_MODE_MISMATCH');
    const reference = snapshot.upstreamCredentialRef ?? deny('CREDENTIAL_REFERENCE_REQUIRED');
    if (!reference.startsWith('credential:')) deny('CREDENTIAL_REFERENCE_REQUIRED');
    let bytes: Uint8Array | undefined;
    try {
      bytes = this.vault.readForExecution(reference);
      // Retrieval may execute platform code; recheck authority immediately before delivery.
      this.resolver.authorizeStart(supplied, request);
      return await deliver(bytes);
    } finally { bytes?.fill(0); }
  }
}
export function projectSafeMetadata(input: unknown, _surface: 'ipc' | 'log' | 'draft' | 'preview' | 'prompt' | 'export' | 'snapshot'): { id?: string; status?: string } {
  if (!input || typeof input !== 'object') return {};
  const source = input as Record<string, unknown>;
  return { ...(typeof source.id === 'string' ? { id: source.id } : {}), ...(typeof source.status === 'string' ? { status: source.status } : {}) };
}
/** Known-value canary redaction only; this does not detect arbitrary unknown secrets. */
export function redactKnownSecrets(text: string, knownValues: readonly string[]): string {
  let result = text; for (const secret of [...knownValues].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]'); return result;
}
