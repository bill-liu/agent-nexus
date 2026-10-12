import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { canonicalManifest, hashBytes, type ArtifactManifest, type SignedManifest, type CatalogSource, type DownloadAuthorization } from '../../../packages/catalog-client/src/index';
// Disposable test keys only. This fixture is not a public publisher trust root.
export function fixture(entries: unknown[] = [{ type: 'file', path: 'SKILL.md', content: '# fixture skill' }], version = '1'): { bytes: Buffer; envelope: SignedManifest; trustedKeys: Map<string, KeyObject>; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const bytes = Buffer.from(JSON.stringify({ format: 'an-fixture-v1', entries }));
  const manifest: ArtifactManifest = { schemaVersion: 1, resourceId: 'skill-example', version, digest: hashBytes(bytes), size: bytes.length, publisher: 'fixture-publisher', source: 'fixture://test-only', minAppProtocol: 1, minRunnerProtocol: 1, target: { os: 'linux', arch: 'arm64', provider: 'fake' }, permissions: [], channel: 'test', withdrawn: false, format: 'an-fixture-v1' };
  return { bytes, envelope: { manifest, signature: { algorithm: 'Ed25519', keyId: 'fixture-key', value: sign(null, Buffer.from(canonicalManifest(manifest)), privateKey).toString('base64') } }, trustedKeys: new Map([['fixture-key', publicKey]]), privateKey };
}
export function resign(value: ReturnType<typeof fixture>, patch: Partial<ArtifactManifest>): SignedManifest {
  const manifest = { ...value.envelope.manifest, ...patch };
  return { manifest, signature: { ...value.envelope.signature, value: sign(null, Buffer.from(canonicalManifest(manifest)), value.privateKey).toString('base64') } };
}
export class FixtureSource implements CatalogSource {
  authorizations = 0; offsets: number[] = []; offline = false; expired = false; interruptAt?: number; block?: Promise<void>;
  constructor(readonly bytes: Buffer, readonly chunkSize = 32) {}
  async authorize(): Promise<DownloadAuthorization> {
    if (this.offline) throw new Error('SOURCE_UNAVAILABLE');
    this.authorizations++; return { url: `fixture://authorization/${this.authorizations}`, expiresAt: Date.now() + 10000 };
  }
  async read(_authorization: DownloadAuthorization, offset: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; done: boolean }> {
    if (this.block) await this.block;
    if (signal.aborted) throw new Error('CANCELLED');
    if (this.offline) throw new Error('SOURCE_UNAVAILABLE');
    if (this.expired) { this.expired = false; throw new Error('URL_EXPIRED'); }
    if (this.interruptAt !== undefined && offset >= this.interruptAt) { this.interruptAt = undefined; throw new Error('DOWNLOAD_INTERRUPTED'); }
    this.offsets.push(offset);
    const end = Math.min(offset + this.chunkSize, this.bytes.length);
    return { bytes: this.bytes.subarray(offset, end), done: end === this.bytes.length };
  }
}
