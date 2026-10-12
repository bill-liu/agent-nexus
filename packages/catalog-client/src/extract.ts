import { existsSync, lstatSync, mkdirSync, rmSync, openSync, closeSync, writeFileSync, fsyncSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, parse } from 'node:path';
import { exactKeys } from './manifest';
export interface ArchiveLimits { maxArchiveBytes?: number; maxEntries?: number; maxExpandedBytes?: number; maxFileBytes?: number }
export const DEFAULT_ARCHIVE_LIMITS = { maxArchiveBytes: 16 * 1024 * 1024, maxEntries: 1024, maxExpandedBytes: 16 * 1024 * 1024, maxFileBytes: 4 * 1024 * 1024 };
export interface ArchiveEntry { type: 'file' | 'directory'; path: string; content?: string }
/** Reject all symlink ancestors in the Core-owned installation/cache hierarchy. */
export function assertSafeParents(path: string): void {
  const absolute = resolve(path); const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())) throw new Error('CATALOG_ARCHIVE_UNSAFE');
  }
}
export function archiveEntries(bytes: Uint8Array, overrides: ArchiveLimits = {}): ArchiveEntry[] {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  if (Object.values(limits).some(x => !Number.isSafeInteger(x) || x < 1) || bytes.length > limits.maxArchiveBytes) throw new Error('CATALOG_ARCHIVE_LIMIT');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('CATALOG_ARCHIVE_UNSAFE'); }
  if (!exactKeys(parsed, ['format', 'entries']) || parsed.format !== 'an-fixture-v1' || !Array.isArray(parsed.entries)) throw new Error('CATALOG_ARCHIVE_UNSAFE');
  if (parsed.entries.length > limits.maxEntries) throw new Error('CATALOG_ARCHIVE_LIMIT');
  const paths = new Map<string, string>(); const prefixes = new Map<string, string>(); let expandedBytes = 0;
  const result: ArchiveEntry[] = [];
  for (const value of parsed.entries) {
    if (!value || typeof value !== 'object') throw new Error('CATALOG_ARCHIVE_UNSAFE');
    const entry = value as Record<string, unknown>;
    if ((entry.type !== 'file' && entry.type !== 'directory') || !exactKeys(entry, entry.type === 'file' ? ['type', 'path', 'content'] : ['type', 'path']) || typeof entry.path !== 'string' || !entry.path || entry.path.length > 512 || /[\\:\u0000-\u001f\u007f]/.test(entry.path)) throw new Error('CATALOG_ARCHIVE_UNSAFE');
    const parts = entry.path.split('/');
    if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^\.an-/i.test(part))) throw new Error('CATALOG_ARCHIVE_UNSAFE');
    const normalizedParts = entry.path.normalize('NFKC').split('/');
    if (normalizedParts.length !== parts.length || normalizedParts.some(part => !part || part === '.' || part === '..' || /[\\:\u0000-\u001f\u007f]/.test(part) || /[. ]$/.test(part) || /^\.an-/i.test(part))) throw new Error('CATALOG_ARCHIVE_UNSAFE');
    for (let i = 1; i <= parts.length; i++) {
      const original = parts.slice(0, i).join('/'); const canonical = original.normalize('NFKC').toLowerCase();
      const prior = prefixes.get(canonical);
      if (prior !== undefined && prior !== original) throw new Error('CATALOG_ARCHIVE_UNSAFE');
      prefixes.set(canonical, original);
    }
    const normalized = entry.path.normalize('NFKC').toLowerCase();
    if (paths.has(normalized)) throw new Error('CATALOG_ARCHIVE_UNSAFE');
    paths.set(normalized, entry.type);
    if (entry.type === 'file') {
      if (typeof entry.content !== 'string') throw new Error('CATALOG_ARCHIVE_UNSAFE');
      const size = Buffer.byteLength(entry.content);
      expandedBytes += size;
      if (size > limits.maxFileBytes || expandedBytes > limits.maxExpandedBytes) throw new Error('CATALOG_ARCHIVE_LIMIT');
    }
    result.push(entry as unknown as ArchiveEntry);
  }
  for (const path of paths.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (paths.get(parts.slice(0, i).join('/')) === 'file') throw new Error('CATALOG_ARCHIVE_UNSAFE');
  }
  return result;
}
/** Existing cache marker alone is insufficient: every installed entry must still match the verified archive. */
export function verifyExtractedArchive(bytes: Uint8Array, directory: string, limits: ArchiveLimits = {}): void {
  const entries = archiveEntries(bytes, limits);
  const allowed = new Map<string, ArchiveEntry | undefined>([['.an-manifest.json', undefined]]);
  for (const entry of entries) {
    allowed.set(entry.path, entry);
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i++) if (!allowed.has(parts.slice(0, i).join('/'))) allowed.set(parts.slice(0, i).join('/'), { type: 'directory', path: parts.slice(0, i).join('/') });
  }
  try {
    const visit = (prefix: string): void => {
      for (const name of readdirSync(join(directory, prefix))) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (!allowed.has(path)) throw new Error();
        const entry = allowed.get(path); const stat = lstatSync(join(directory, path));
        if (stat.isSymbolicLink()) throw new Error();
        if (entry?.type === 'directory') { if (!stat.isDirectory()) throw new Error(); visit(path); }
        else if (!stat.isFile() || stat.nlink !== 1 || (entry && (!readFileSync(join(directory, path)).equals(Buffer.from(entry.content!, 'utf8'))))) throw new Error();
      }
    };
    visit('');
    for (const path of allowed.keys()) if (!existsSync(join(directory, path))) throw new Error();
  } catch { throw new Error('CATALOG_INSTALL_INTEGRITY'); }
}
/** Deliberately accepts only inert JSON fixture entries, never tar/zip scripts or links. */
export function extractArchive(bytes: Uint8Array, destination: string, limits: ArchiveLimits = {}): void {
  const entries = archiveEntries(bytes, limits); const root = resolve(destination);
  assertSafeParents(dirname(root));
  // Destination must be freshly created. Never merge into a live version or follow a preexisting link.
  try { mkdirSync(root, { mode: 0o700 }); } catch { throw new Error('CATALOG_ARCHIVE_UNSAFE'); }
  try {
    for (const entry of entries.filter(x => x.type === 'directory').sort((a, b) => a.path.length - b.path.length)) mkdirSync(join(root, entry.path), { recursive: true, mode: 0o700 });
    for (const entry of entries.filter(x => x.type === 'file')) {
      const path = join(root, entry.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const handle = openSync(path, 'wx', 0o600);
      try { writeFileSync(handle, entry.content!, 'utf8'); fsyncSync(handle); } finally { closeSync(handle); }
    }
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
