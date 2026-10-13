import { randomUUID } from 'node:crypto';
export type SecretStorageBackend = 'fake' | 'macos_safe_storage';
export interface ProtectedSecretSink { readonly storage: SecretStorageBackend; isAvailable(): boolean; put(reference: string, bytes: Uint8Array): void; remove(reference: string): void; }
/** Trusted Main/Node capability. Never expose this source over Renderer IPC. */
export interface ExecutionSecretSource extends ProtectedSecretSink { readForExecution(reference: string): Uint8Array; }
/** Test fixture only. Never substitutes for Keychain/safeStorage in a real credential workflow. */
export class FakeSecretVault implements ProtectedSecretSink {
  readonly storage = 'fake' as const; #secrets = new Map<string, Uint8Array>();
  constructor(private available = true) {}
  isAvailable(): boolean { return this.available; }
  put(reference: string, bytes: Uint8Array): void { if (!this.available) throw new Error('SECRET_STORAGE_UNAVAILABLE'); this.#secrets.set(reference, new Uint8Array(bytes)); }
  remove(reference: string): void { this.#secrets.get(reference)?.fill(0); this.#secrets.delete(reference); }
}
/** Accepts ephemeral bytes on the dedicated trusted platform channel; exposes no plaintext retrieval. */
export class SecretBroker {
  constructor(private vault: ProtectedSecretSink) {}
  save(bytes: Uint8Array): { credentialRef: string; status: 'stored'; storage: SecretStorageBackend } {
    try {
      if (!this.vault.isAvailable()) throw new Error('SECRET_STORAGE_UNAVAILABLE');
      if (bytes.length === 0 || bytes.length > 16384) throw new Error('SECRET_INPUT_INVALID');
      const credentialRef = `credential:${randomUUID()}`; this.vault.put(credentialRef, bytes); return { credentialRef, status: 'stored', storage: this.vault.storage };
    } finally { bytes.fill(0); }
  }
  revoke(reference: string): { credentialRef: string; localDeleted: true; upstreamRevoked: false } { this.vault.remove(reference); return { credentialRef: reference, localDeleted: true, upstreamRevoked: false }; }
}
