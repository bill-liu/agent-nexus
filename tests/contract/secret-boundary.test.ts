import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createConnectionFixture, projectSafeMetadata, redactKnownSecrets } from '../../packages/connections/src/index.js';
import { FakeSecretVault, SecretBroker } from '../../packages/desktop-platform/src/secrets.js';
describe('C08 secret boundary fake vault only', () => {
  it('stores secret by reference and destroys ephemeral input bytes', () => {
    const broker = new SecretBroker(new FakeSecretVault()); const input = new TextEncoder().encode('CANARY_PRIVATE_KEY');
    const saved = broker.save(input); expect(input.every(v => v === 0)).toBe(true);
    expect(saved).toEqual({ credentialRef: expect.stringMatching(/^credential:/), status: 'stored', storage: 'fake' });
    expect('read' in broker).toBe(false); expect(JSON.stringify(saved)).not.toContain('CANARY');
  });
  it('unavailable protected storage fails closed and clears input', () => {
    const broker = new SecretBroker(new FakeSecretVault(false)); const input = new TextEncoder().encode('CANARY');
    expect(() => broker.save(input)).toThrow('SECRET_STORAGE_UNAVAILABLE'); expect(input.every(v => v === 0)).toBe(true);
  });
  it('allowlisted projections exclude auth payloads from IPC/log/draft/preview/prompt/export/snapshot', () => {
    const unsafe = { id: 'safe', status: 'ready', token: 'CANARY_OAUTH', deviceCode: 'CANARY_DEVICE', rawResponse: 'CANARY_RAW', environment: { KEY: 'CANARY_KEY' } };
    for (const surface of ['ipc', 'log', 'draft', 'preview', 'prompt', 'export', 'snapshot'] as const) {
      expect(projectSafeMetadata(unsafe, surface)).toEqual({ id: 'safe', status: 'ready' });
    }
    expect(redactKnownSecrets('visible CANARY_RAW content', ['CANARY_RAW'])).toBe('visible [REDACTED] content');
  });
  it('ignores extra runtime auth fields before database and immutable snapshot persistence', () => {
    const f = createConnectionFixture(new DatabaseSync(':memory:'), () => 1000);
    f.auth.setInspection(f.request, { ...f.inspection, token: 'CANARY_AUTH', deviceCode: 'CANARY_CODE' } as typeof f.inspection);
    const snapshot = f.resolver.resolve(f.request);
    expect(JSON.stringify(snapshot)).not.toContain('CANARY'); expect(JSON.stringify(f.store.all('snapshots'))).not.toContain('CANARY');
  });
});
it('raw key cannot be disguised as metadata credential reference', () => {
  const f = createConnectionFixture(new DatabaseSync(':memory:'), () => 1000);
  expect(() => f.registry.update(f.connection.id, 1, { credentialRef: 'sk-CANARY_SECRET_KEY' })).toThrow('CREDENTIAL_REFERENCE_REQUIRED');
  expect(JSON.stringify(f.store.all('connections'))).not.toContain('CANARY');
});
