export interface ArtifactManifest {
  schemaVersion: 1; resourceId: string; version: string; digest: string; size: number;
  publisher: string; source: string; minAppProtocol: number; minRunnerProtocol: number;
  target: { os: string; arch: string; provider: string }; permissions: string[];
  channel: string; withdrawn: boolean; format: 'an-fixture-v1';
}
export interface SignedManifest { manifest: ArtifactManifest; signature: { algorithm: 'Ed25519'; keyId: string; value: string } }
export interface TargetNode { os: string; arch: string; provider: string; appProtocol: number; runnerProtocol: number; nodeId?: string }
export function canonicalManifest(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])]));
    return item;
  }
  return JSON.stringify(canonical(value));
}
export function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}
export function parseSignedManifest(value: unknown): SignedManifest {
  const invalid = () => { throw new Error('CATALOG_MANIFEST_INVALID'); };
  if (!exactKeys(value, ['manifest', 'signature'])) return invalid();
  const { manifest: m, signature: s } = value;
  if (!exactKeys(m, ['schemaVersion', 'resourceId', 'version', 'digest', 'size', 'publisher', 'source', 'minAppProtocol', 'minRunnerProtocol', 'target', 'permissions', 'channel', 'withdrawn', 'format']) || !exactKeys(s, ['algorithm', 'keyId', 'value'])) return invalid();
  if (m.schemaVersion !== 1 || m.format !== 'an-fixture-v1' || typeof m.withdrawn !== 'boolean' || !exactKeys(m.target, ['os', 'arch', 'provider'])) return invalid();
  for (const key of ['resourceId', 'version', 'publisher', 'source', 'channel']) if (typeof m[key] !== 'string' || !m[key] || (m[key] as string).length > 2048 || /[\u0000-\u001f]/.test(m[key] as string)) return invalid();
  for (const key of ['os', 'arch', 'provider']) if (typeof m.target[key] !== 'string' || !m.target[key] || (m.target[key] as string).length > 100) return invalid();
  if (typeof m.digest !== 'string' || !/^[a-f0-9]{64}$/.test(m.digest) || !Number.isSafeInteger(m.size) || Number(m.size) < 1 || !Number.isSafeInteger(m.minAppProtocol) || Number(m.minAppProtocol) < 1 || !Number.isSafeInteger(m.minRunnerProtocol) || Number(m.minRunnerProtocol) < 1) return invalid();
  if (!Array.isArray(m.permissions) || m.permissions.length > 128 || m.permissions.some(x => typeof x !== 'string' || !x || x.length > 100) || new Set(m.permissions).size !== m.permissions.length) return invalid();
  if (s.algorithm !== 'Ed25519' || typeof s.keyId !== 'string' || !s.keyId || s.keyId.length > 200 || typeof s.value !== 'string' || s.value.length > 200) return invalid();
  return structuredClone(value) as unknown as SignedManifest;
}
