export { FakeSecretVault, SecretBroker } from '../../desktop-platform/src/secrets.js';
export function projectSafeMetadata(input: unknown, _surface: 'ipc' | 'log' | 'draft' | 'preview' | 'prompt' | 'export' | 'snapshot'): { id?: string; status?: string } {
  if (!input || typeof input !== 'object') return {};
  const source = input as Record<string, unknown>;
  return { ...(typeof source.id === 'string' ? { id: source.id } : {}), ...(typeof source.status === 'string' ? { status: source.status } : {}) };
}
/** Known-value canary redaction only; this does not detect arbitrary unknown secrets. */
export function redactKnownSecrets(text: string, knownValues: readonly string[]): string {
  let result = text; for (const secret of [...knownValues].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]'); return result;
}
