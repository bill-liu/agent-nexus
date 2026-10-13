import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretBroker } from '../../packages/desktop-platform/src/secrets.js';
import { DatabaseSync } from 'node:sqlite';
import { createConnectionFixture } from '../../packages/connections/src/index.js';
import type { ExecutionBinding } from '../../packages/execution/src/contracts.js';

describe('P1 protected storage synthetic isolated store', () => {
  it('secure_storage_unavailable_fails_closed', () => {
    const broker = new SecretBroker({ storage: 'macos_safe_storage', isAvailable: () => false, put: () => { throw new Error('must not write'); }, remove: () => {} } as never);
    const input = Buffer.from('SYNTHETIC_A4_CANARY');
    expect(() => broker.save(input)).toThrow('SECRET_STORAGE_UNAVAILABLE'); expect(input.every(b => b === 0)).toBe(true);
  });
  it('reports actual protected backend and never adds ordinary plaintext read', () => {
    const broker = new SecretBroker({ storage: 'macos_safe_storage', isAvailable: () => true, put: () => {}, remove: () => {} } as never);
    expect(broker.save(Buffer.from('SYNTHETIC_A4_CANARY')).storage).toBe('macos_safe_storage');
    expect('readPlaintext' in broker).toBe(false);
  });
  it('encrypted persistence uses private modes and trusted scoped retrieval', async () => {
    const module = await import('../../packages/desktop-platform/src/macos-secrets.js');
    const root = mkdtempSync(join(tmpdir(), 'an-a4-vault-'));
    // Scripted safeStorage surrogate is synthetic evidence, not macOS OS-protection evidence.
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from([...Buffer.from(s)].map(b => b ^ 0xa5)), decryptString: (b: Buffer) => Buffer.from([...b].map(v => v ^ 0xa5)).toString() };
    try {
      const vault = new module.MacOSSecretVault({ directory: join(root, 'vault'), safeStorage, platform: 'darwin' });
      const broker = new SecretBroker(vault); const saved = broker.save(Buffer.from('SYNTHETIC_A4_CANARY'));
      const files = readdirSync(join(root, 'vault')); expect(files).toHaveLength(1);
      expect(readFileSync(join(root, 'vault', files[0])).includes('SYNTHETIC_A4_CANARY')).toBe(false);
      expect(statSync(join(root, 'vault')).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, 'vault', files[0])).mode & 0o777).toBe(0o600);
      expect(vault.readForExecution(saved.credentialRef).toString()).toBe('SYNTHETIC_A4_CANARY');
      broker.revoke(saved.credentialRef); expect(readdirSync(join(root, 'vault'))).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('symlinked roots and broad permissions cannot write or read credentials', async () => {
    const { MacOSSecretVault } = await import('../../packages/desktop-platform/src/macos-secrets.js');
    const root = mkdtempSync(join(tmpdir(), 'an-a4-path-'));
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
    try {
      symlinkSync(root, join(root, 'link'));
      const symlinked = new MacOSSecretVault({ directory: join(root, 'link', 'vault'), safeStorage, platform: 'darwin' });
      expect(() => symlinked.put('credential:test', Buffer.from('SYNTHETIC_A4_CANARY'))).toThrow('SECRET_PATH_DENIED');
      const vault = new MacOSSecretVault({ directory: join(root, 'vault'), safeStorage, platform: 'darwin' });
      vault.put('credential:test', Buffer.from('SYNTHETIC_A4_CANARY')); chmodSync(join(root, 'vault'), 0o755);
      expect(() => vault.readForExecution('credential:test')).toThrow('SECRET_PATH_DENIED');
      chmodSync(join(root, 'vault'), 0o700);
      const file = join(root, 'vault', readdirSync(join(root, 'vault'))[0]); chmodSync(file, 0o644);
      expect(() => vault.readForExecution('credential:test')).toThrow('SECRET_PATH_DENIED');
      expect(() => vault.put('../escape', Buffer.from('SYNTHETIC_A4_CANARY'))).toThrow('SECRET_REFERENCE_REQUIRED');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('storage unavailable never writes plaintext, and primitive failures do not expose raw errors', async () => {
    const { MacOSSecretVault } = await import('../../packages/desktop-platform/src/macos-secrets.js');
    const root = mkdtempSync(join(tmpdir(), 'an-a4-unavailable-'));
    let available = false;
    const safeStorage = { isEncryptionAvailable: () => available, encryptString: () => { throw new Error('SYNTHETIC_A4_CANARY'); }, decryptString: () => { throw new Error('SYNTHETIC_A4_CANARY'); } };
    try {
      const vault = new MacOSSecretVault({ directory: join(root, 'vault'), safeStorage, platform: 'darwin' });
      expect(() => new SecretBroker(vault).save(Buffer.from('SYNTHETIC_A4_CANARY'))).toThrow('SECRET_STORAGE_UNAVAILABLE');
      expect(readdirSync(root)).toHaveLength(0); available = true;
      expect(() => new SecretBroker(vault).save(Buffer.from('SYNTHETIC_A4_CANARY'))).toThrow('SECRET_STORAGE_UNAVAILABLE');
      expect(readdirSync(join(root, 'vault'))).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('trusted execution reads only the selected scoped credential and clears it after delivery', async () => {
    const { TrustedExecutionSecretBroker } = await import('../../packages/connections/src/broker.js');
    const f = createConnectionFixture(new DatabaseSync(':memory:'), () => 1000);
    const binding: ExecutionBinding = { nodeId: f.scope.nodeId, sandboxId: 'sandbox:a4', generation: 1, transportInstanceId: 'transport:a4', processInstanceId: 'process:a4', runId: f.request.runId, sessionId: f.request.runtimeSessionRef, turnId: 'turn:a4', fencingToken: 1 };
    f.registry.create({ ...f.connection, id: 'api:selected', provider: 'openai', runtimeProfiles: ['codex-cli'], route: 'direct', authMethod: 'api_key', credentialRef: 'credential:synthetic', billingSource: 'api' });
    f.grants.grant({ ...f.scope, connectionId: 'api:selected', approvedBy: f.scope.userId, expiresAt: 5000, maxBudget: 10 });
    const request = { ...f.request, explicitConnectionId: 'api:selected', runtime: 'codex-cli', executionMode: 'live' as const, executionBinding: binding, runtimePolicy: { nativeLoginAllowed: false, authMethods: ['api_key' as const] } };
    const { ConnectionResolver } = await import('../../packages/connections/src/resolver.js');
    const resolver = new ConnectionResolver(f.registry, f.grants, f.auth, f.leases, { secretBackend: 'macos_safe_storage' });
    const snapshot = await resolver.resolveAsync(request, { evidenceKind: 'runtime_reported', inspectAuth: async () => ({ ...f.inspection, runtime: 'codex-cli', authMethod: 'api_key', billingSource: 'api', executionBinding: binding, observedAt: 1000 }) });
    let delivered: Uint8Array | undefined;
    const source = { storage: 'macos_safe_storage' as const, isAvailable: () => true, put: () => {}, remove: () => {}, readForExecution: (reference: string) => { expect(reference).toBe('credential:synthetic'); return Buffer.from('SYNTHETIC_A4_CANARY'); } };
    const broker = new TrustedExecutionSecretBroker(source, resolver);
    await broker.withExecutionSecret(snapshot, request, async (bytes: Uint8Array) => { delivered = bytes; expect(Buffer.from(bytes).toString()).toBe('SYNTHETIC_A4_CANARY'); });
    expect(delivered!.every(byte => byte === 0)).toBe(true);
    f.grants.revoke(snapshot.grantId, snapshot.grantRevision);
    await expect(broker.withExecutionSecret(snapshot, request, async () => { throw new Error('delivery must not occur'); })).rejects.toThrow('GRANT_REVOKED');
  });
});
