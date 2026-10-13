import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalJson } from '../../../packages/persistence/src/unit-of-work.js';
export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export interface ManifestEntry { path: string; kind: 'file' | 'directory'; digest: string; size: number }
export interface CandidateSnapshot { ref: string; digest: string; path: string; files: ManifestEntry[] }
function safePath(path: string): void {
 let part = resolve(path);
 for (;;) { if (lstatSync(part).isSymbolicLink()) throw new Error('UNSAFE_SNAPSHOT_PATH'); const parent = dirname(part); if (parent === part) break; part = parent; }
}
function stableFile(path: string): Buffer {
 safePath(path); if (!lstatSync(path).isFile()) throw new Error('UNSAFE_SNAPSHOT_PATH');
 const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const before = fstatSync(fd); if (!before.isFile() || before.nlink !== 1 || before.size > 4 * 1024 * 1024) throw new Error('UNSAFE_SNAPSHOT_PATH');
  const bytes = readFileSync(fd); const after = fstatSync(fd); const current = lstatSync(path);
  if (before.ino !== current.ino || before.dev !== current.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.ctimeMs !== current.ctimeMs || bytes.length !== before.size) throw new Error('SNAPSHOT_MUTATED');
  return bytes;
 } finally { closeSync(fd); }
}
function tree(root: string): { files: ManifestEntry[]; contents: Map<string, Buffer> } {
 safePath(root); const files: ManifestEntry[] = []; const contents = new Map<string, Buffer>(); let size = 0;
 function walk(path: string, depth = 0): void {
  if (depth > 64 || files.length >= 2048) throw new Error('SNAPSHOT_TOO_LARGE');
  safePath(path); const before = lstatSync(path); if (!before.isDirectory()) throw new Error('UNSAFE_SNAPSHOT_PATH');
  for (const name of readdirSync(path).sort()) {
   const full = join(path, name); const info = lstatSync(full);
   if (info.isSymbolicLink()) throw new Error('UNSAFE_SNAPSHOT_PATH');
   if (info.isDirectory()) { files.push({ path: relative(root, full).split(sep).join('/'), kind: 'directory', digest: hash(''), size: 0 }); walk(full, depth + 1); }
   else {
    const bytes = stableFile(full); size += bytes.length;
    if (files.length >= 2048 || size > 16 * 1024 * 1024) throw new Error('SNAPSHOT_TOO_LARGE');
    const key = relative(root, full).split(sep).join('/'); files.push({ path: key, kind: 'file', digest: hash(bytes), size: bytes.length }); contents.set(key, bytes);
   }
  }
  const after = lstatSync(path); if (before.ino !== after.ino || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) throw new Error('SNAPSHOT_MUTATED');
 }
 walk(root); return { files, contents };
}
/** Trusted storage must be outside every Bot mount; chmod is defense in depth, not an OS sandbox. */
export class CandidateStore {
 readonly root: string;
 constructor(root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); safePath(root); this.root = realpathSync(root); }
 capture(source: string): CandidateSnapshot {
  source = resolve(source); safePath(source);
  if (this.root === source || this.root.startsWith(source + sep) || source.startsWith(this.root + sep)) throw new Error('SNAPSHOT_STORAGE_OVERLAP');
  const before = tree(source); const again = tree(source);
  if (canonicalJson(before.files) !== canonicalJson(again.files)) throw new Error('SNAPSHOT_MUTATED');
  return this.storeFiles(before.files, before.contents);
 }
 captureFile(source: string): CandidateSnapshot {
  const bytes = stableFile(source);
  return this.storeFiles([{ path: 'oracle.mjs', kind: 'file', digest: hash(bytes), size: bytes.length }], new Map([['oracle.mjs',bytes]]));
 }
 private storeFiles(files: ManifestEntry[], contents: Map<string, Buffer>): CandidateSnapshot {
  const digest = hash(canonicalJson(files)); const ref = `snapshot-${randomUUID()}`; const path = join(this.root, ref);
  mkdirSync(path, { mode: 0o700 }); mkdirSync(join(path, 'files'), { mode: 0o700 });
  try {
   for (const entry of files) if (entry.kind === 'directory') mkdirSync(join(path, 'files', entry.path), { recursive: true, mode: 0o700 });
   for (const [file, bytes] of contents) { const target = join(path, 'files', file); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, bytes, { flag: 'wx', mode: 0o400 }); }
   writeFileSync(join(path, 'manifest.json'), canonicalJson(files), { flag: 'wx', mode: 0o400 });
   return this.resolve(ref, digest);
  } catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
 }
 resolve(ref: string, digest: string): CandidateSnapshot {
  if (!/^snapshot-[a-f0-9-]{36}$/.test(ref)) throw new Error('INVALID_SNAPSHOT_REF');
  const path = join(this.root, ref);
  try {
   safePath(path); const manifest = stableFile(join(path, 'manifest.json')).toString('utf8');
   const files = tree(join(path, 'files')).files;
   if (manifest !== canonicalJson(files) || hash(manifest) !== digest) throw new Error('SNAPSHOT_TAMPERED');
   return { ref, digest, path, files };
  } catch { throw new Error('SNAPSHOT_TAMPERED'); }
 }
 resolveFile(ref: string, contentDigest: string): CandidateSnapshot {
  if (!/^snapshot-[a-f0-9-]{36}$/.test(ref)) throw new Error('INVALID_SNAPSHOT_REF');
  try {
   const bytes = stableFile(join(this.root, ref, 'manifest.json'));
   const entries: ManifestEntry[] = JSON.parse(bytes.toString('utf8'));
   if (!Array.isArray(entries) || entries.length !== 1 || entries[0].path !== 'oracle.mjs' || entries[0].kind !== 'file' || entries[0].digest !== contentDigest) throw new Error('ORACLE_MISMATCH');
   return this.resolve(ref, hash(bytes));
  } catch { throw new Error('ORACLE_MISMATCH'); }
 }
 /** Trusted coordinator uses this before B; caller records the returned A digest as B's frozen input. */
 materialize(ref: string, digest: string, destination: string): string {
  const snapshot = this.resolve(ref, digest); mkdirSync(destination, { mode: 0o700 }); safePath(destination);
  try {
   for (const file of snapshot.files) {
    const target = join(destination, file.path);
    if (file.kind === 'directory') { mkdirSync(target, { recursive: true }); continue; }
    const bytes = stableFile(join(snapshot.path, 'files', file.path));
    if (hash(bytes) !== file.digest || bytes.length !== file.size) throw new Error('SNAPSHOT_TAMPERED');
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
   }
   this.resolve(ref, digest);
   if (hash(canonicalJson(tree(destination).files)) !== digest) throw new Error('SNAPSHOT_TAMPERED');
   return digest;
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
 }
}
