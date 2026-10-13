import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { canonicalManifest, parseSignedManifest, type ArtifactManifest, type TargetNode } from './manifest';
export type TrustedKeys = ReadonlyMap<string, KeyObject | string>;
export function hashBytes(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
export function verifyManifest(envelope: unknown, trustedKeys: TrustedKeys, target: TargetNode, options: { allowWithdrawn?: boolean } = {}): ArtifactManifest {
  const { manifest, signature } = parseSignedManifest(envelope);
  const trusted = trustedKeys.get(signature.keyId);
  if (!trusted) throw new Error('CATALOG_UNTRUSTED_PUBLISHER');
  try {
    const publicKey = typeof trusted === 'string' ? createPublicKey(trusted) : trusted;
    const bytes = Buffer.from(signature.value, 'base64');
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519' || bytes.length !== 64 || bytes.toString('base64') !== signature.value || !verify(null, Buffer.from(canonicalManifest(manifest)), publicKey, bytes)) throw new Error();
  } catch { throw new Error('CATALOG_SIGNATURE_INVALID'); }
  if (manifest.withdrawn && !options.allowWithdrawn) throw new Error('CATALOG_WITHDRAWN');
  if (manifest.target.os !== target.os || manifest.target.arch !== target.arch || manifest.target.provider !== target.provider || !Number.isSafeInteger(target.appProtocol) || !Number.isSafeInteger(target.runnerProtocol) || target.appProtocol < manifest.minAppProtocol || target.runnerProtocol < manifest.minRunnerProtocol) throw new Error('CATALOG_INCOMPATIBLE');
  return manifest;
}
export function verifyArtifact(bytes: Uint8Array, manifest: ArtifactManifest): void {
  if (bytes.length !== manifest.size || hashBytes(bytes) !== manifest.digest) throw new Error('CATALOG_DIGEST_INVALID');
}

/** Streaming verification for raw VM artifacts; never buffer an entire image in Core memory. */
export async function verifyArtifactFile(path: string, manifest: ArtifactManifest): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== manifest.size) throw new Error('CATALOG_DIGEST_INVALID');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== manifest.digest) throw new Error('CATALOG_DIGEST_INVALID');
}
