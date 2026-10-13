import { randomUUID, createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { ExecutionSecretSource } from './secrets.js';

/** Inject Electron Main's safeStorage after app readiness; never construct from IPC input. */
export interface MacSafeStorage { isEncryptionAvailable(): boolean; encryptString(plainText: string): Buffer; decryptString(encrypted: Buffer): string; }
export interface MacOSSecretVaultOptions { directory: string; safeStorage: MacSafeStorage; platform?: string; }
function fail(code = 'SECRET_STORAGE_UNAVAILABLE'): never { throw new Error(code); }

/** Actual encrypted-file adapter. Tests may inject a synthetic primitive, which is not OS evidence. */
export class MacOSSecretVault implements ExecutionSecretSource {
  readonly storage = 'macos_safe_storage' as const;
  private readonly directory: string;
  private readonly safeStorage: MacSafeStorage;
  private readonly platform: string;
  constructor(options: MacOSSecretVaultOptions) {
    if (!isAbsolute(options.directory) || resolve(options.directory) !== options.directory || options.directory === parse(options.directory).root) fail('SECRET_PATH_DENIED');
    this.directory = options.directory; this.safeStorage = options.safeStorage; this.platform = options.platform ?? process.platform;
  }
  isAvailable(): boolean { try { return this.platform === 'darwin' && this.safeStorage.isEncryptionAvailable(); } catch { return false; } }
  private root(create: boolean): void {
    if (!this.isAvailable()) fail();
    let path = dirname(this.directory);
    while (true) {
      const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isDirectory()) fail('SECRET_PATH_DENIED');
      const parent = dirname(path); if (parent === path) break; path = parent;
    }
    if (!existsSync(this.directory)) { if (!create) fail('SECRET_REFERENCE_REQUIRED'); mkdirSync(this.directory, { mode: 0o700 }); }
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid()) || realpathSync(this.directory) !== this.directory) fail('SECRET_PATH_DENIED');
  }
  private path(reference: string): string {
    if (!/^credential:[A-Za-z0-9_.-]{1,160}$/.test(reference)) fail('SECRET_REFERENCE_REQUIRED');
    return join(this.directory, `${createHash('sha256').update(reference).digest('hex')}.enc`);
  }
  private checkFile(path: string): void {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) fail('SECRET_PATH_DENIED');
  }
  put(reference: string, bytes: Uint8Array): void {
    this.root(true); const target = this.path(reference); this.checkFile(target);
    let encrypted: Buffer;
    try { encrypted = this.safeStorage.encryptString(Buffer.from(bytes).toString('base64')); } catch { return fail(); }
    if (!encrypted.length) fail();
    const temporary = join(this.directory, `.pending-${randomUUID()}`); let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, encrypted); fsyncSync(fd); closeSync(fd); fd = undefined;
      this.root(false); this.checkFile(target); renameSync(temporary, target);
      const directoryFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch { fail(); } finally { encrypted.fill(0); if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary); }
  }
  readForExecution(reference: string): Buffer {
    this.root(false); const target = this.path(reference); this.checkFile(target);
    let fd: number | undefined; let encrypted: Buffer | undefined;
    try {
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 65536 || (process.getuid && stat.uid !== process.getuid())) fail('SECRET_PATH_DENIED');
      encrypted = readFileSync(fd); const decoded = this.safeStorage.decryptString(encrypted);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(decoded)) fail();
      const bytes = Buffer.from(decoded, 'base64'); if (!bytes.length || bytes.length > 16384) { bytes.fill(0); fail(); } return bytes;
    } catch { return fail(); } finally { encrypted?.fill(0); if (fd !== undefined) closeSync(fd); }
  }
  remove(reference: string): void { this.root(false); const target = this.path(reference); this.checkFile(target); if (existsSync(target)) unlinkSync(target); }
}
