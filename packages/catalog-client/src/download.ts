import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, lstatSync, appendFileSync, truncateSync, renameSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { canonicalManifest, type SignedManifest, type ArtifactManifest, type TargetNode } from './manifest';
import { verifyManifest, verifyArtifact, hashBytes, type TrustedKeys } from './verify';
import { extractArchive, verifyExtractedArchive, assertSafeParents, DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from './extract';
export interface DownloadAuthorization { url: string; expiresAt: number }
export interface CatalogSource {
  authorize(manifest: ArtifactManifest, target: TargetNode): Promise<DownloadAuthorization>;
  read(authorization: DownloadAuthorization, offset: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; done: boolean }>;
}
export interface DownloadOptions { db: DatabaseSync; directory: string; trustedKeys: TrustedKeys; target: TargetNode; source: CatalogSource; limits?: ArchiveLimits; permissionGrant?: string[] }
export interface DownloadRequest { commandId: string; idempotencyKey: string; botId: string; envelope: SignedManifest }
export type DownloadState = 'pending' | 'downloading' | 'interrupted' | 'waiting-source' | 'verifying' | 'installing' | 'ready' | 'cancelled' | 'failed';
export interface DownloadStatus { operationId: string; commandId: string; botId: string; resourceId: string; version: string; state: DownloadState; downloadedBytes: number; totalBytes: number; errorCode?: string }
export interface InstalledResource { resourceId: string; version: string; digest: string; directory: string; target: TargetNode }
interface OperationRow { operation_id: string; command_id: string; bot_id: string; envelope: string; state: DownloadState; downloaded_bytes: number; generation: number; error_code: string | null }
const terminal = new Set<DownloadState>(['ready', 'cancelled', 'failed']);
export class DownloadManager {
  readonly directory: string; readonly targetKey: string;
  private running = new Map<string, Promise<DownloadStatus>>(); private aborts = new Map<string, AbortController>();
  constructor(readonly options: DownloadOptions) {
    if (!options.directory) throw new Error('CATALOG_DIRECTORY_REQUIRED');
    this.directory = resolve(options.directory); assertSafeParents(this.directory);
    for (const child of ['', 'partials', 'versions', 'staging']) mkdirSync(join(this.directory, child), { recursive: true, mode: 0o700 });
    this.targetKey = hashBytes(canonicalManifest({ os: options.target.os, arch: options.target.arch, provider: options.target.provider, nodeId: options.target.nodeId ?? 'local-target' }));
    options.db.exec(`CREATE TABLE IF NOT EXISTS catalog_release(resource_id TEXT NOT NULL, version TEXT NOT NULL, target_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(resource_id,version,target_key));
      CREATE TABLE IF NOT EXISTS catalog_operation(operation_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL, bot_id TEXT NOT NULL, target_key TEXT NOT NULL, envelope TEXT NOT NULL, state TEXT NOT NULL, downloaded_bytes INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, error_code TEXT);
      CREATE TABLE IF NOT EXISTS catalog_install(resource_id TEXT NOT NULL,target_key TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(resource_id,target_key));`);
    options.db.exec('CREATE TABLE IF NOT EXISTS catalog_revocation(resource_id TEXT NOT NULL,version TEXT NOT NULL,target_key TEXT NOT NULL,envelope TEXT NOT NULL,PRIMARY KEY(resource_id,version,target_key))');
  }
  start(request: DownloadRequest): DownloadStatus {
    if (!request.commandId || !request.idempotencyKey || !request.botId) throw new Error('CATALOG_REQUEST_INVALID');
    this.observe(request.envelope);
    const manifest = this.checkedManifest(request.envelope);
    const payload = canonicalManifest(manifest);
    const requestDigest = hashBytes(canonicalManifest({ botId: request.botId, manifest, target: this.options.target }));
    const existing = this.options.db.prepare('SELECT operation_id,request_digest FROM catalog_operation WHERE command_id=? OR idempotency_key=?').all(request.commandId, request.idempotencyKey);
    if (existing.length) {
      if (existing.some(x => x.request_digest !== requestDigest) || new Set(existing.map(x => x.operation_id)).size > 1) throw new Error('CATALOG_IDEMPOTENCY_CONFLICT');
      return this.status(String(existing[0]!.operation_id));
    }
    const release = this.options.db.prepare('SELECT payload FROM catalog_release WHERE resource_id=? AND version=? AND target_key=?').get(manifest.resourceId, manifest.version, this.targetKey);
    if (release && release.payload !== payload) throw new Error('CATALOG_VERSION_CONFLICT');
    const operationId = randomUUID();
    this.options.db.exec('SAVEPOINT catalog_start');
    try {
      this.options.db.prepare('INSERT OR IGNORE INTO catalog_release VALUES(?,?,?,?)').run(manifest.resourceId, manifest.version, this.targetKey, payload);
      this.options.db.prepare('INSERT INTO catalog_operation(operation_id,command_id,idempotency_key,request_digest,bot_id,target_key,envelope,state) VALUES(?,?,?,?,?,?,?,?)').run(operationId, request.commandId, request.idempotencyKey, requestDigest, request.botId, this.targetKey, JSON.stringify(request.envelope), 'pending');
      this.options.db.exec('RELEASE catalog_start');
    } catch (error) { this.options.db.exec('ROLLBACK TO catalog_start'); this.options.db.exec('RELEASE catalog_start'); throw error; }
    return this.status(operationId);
  }
  /** A signature-verified revocation is a monotonic local tombstone; older signed manifests cannot undo it. */
  observe(envelope: SignedManifest): { withdrawn: boolean; affectedBotIds: string[] } {
    const manifest = verifyManifest(envelope, this.options.trustedKeys, this.options.target, { allowWithdrawn: true });
    if (!manifest.source.startsWith('fixture://')) throw new Error('PUBLIC_PUBLISHER_PREFLIGHT_REQUIRED');
    if (manifest.withdrawn) this.options.db.prepare('INSERT OR IGNORE INTO catalog_revocation VALUES(?,?,?,?)').run(manifest.resourceId, manifest.version, this.targetKey, JSON.stringify(envelope));
    const withdrawn = this.isWithdrawn(manifest);
    const affectedBotIds = withdrawn ? this.options.db.prepare('SELECT DISTINCT bot_id,envelope FROM catalog_operation WHERE target_key=?').all(this.targetKey).filter(row => {
      const candidate = (JSON.parse(String(row.envelope)) as SignedManifest).manifest;
      return candidate.resourceId === manifest.resourceId && candidate.version === manifest.version;
    }).map(row => String(row.bot_id)) : [];
    return { withdrawn, affectedBotIds: [...new Set(affectedBotIds)].sort() };
  }
  private isWithdrawn(manifest: ArtifactManifest): boolean {
    return Boolean(this.options.db.prepare('SELECT 1 FROM catalog_revocation WHERE resource_id=? AND version=? AND target_key=?').get(manifest.resourceId, manifest.version, this.targetKey));
  }
  private checkedManifest(envelope: unknown): ArtifactManifest {
    const manifest = verifyManifest(envelope, this.options.trustedKeys, this.options.target);
    if (this.isWithdrawn(manifest)) throw new Error('CATALOG_WITHDRAWN');
    if (!manifest.source.startsWith('fixture://')) throw new Error('PUBLIC_PUBLISHER_PREFLIGHT_REQUIRED');
    const maxBytes = this.options.limits?.maxArchiveBytes ?? DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes;
    if (manifest.size > maxBytes) throw new Error('CATALOG_ARCHIVE_LIMIT');
    if (manifest.permissions.some(permission => !this.options.permissionGrant?.includes(permission))) throw new Error('CATALOG_PERMISSION_DENIED');
    return manifest;
  }
  private row(id: string): OperationRow {
    const row = this.options.db.prepare('SELECT * FROM catalog_operation WHERE operation_id=? AND target_key=?').get(id, this.targetKey);
    if (!row) throw new Error('CATALOG_OPERATION_NOT_FOUND');
    return row as unknown as OperationRow;
  }
  status(id: string): DownloadStatus {
    const row = this.row(id); const manifest = (JSON.parse(row.envelope) as SignedManifest).manifest;
    return { operationId: id, commandId: row.command_id, botId: row.bot_id, resourceId: manifest.resourceId, version: manifest.version, state: row.state, downloadedBytes: Number(row.downloaded_bytes), totalBytes: manifest.size, ...(row.error_code ? { errorCode: row.error_code } : {}) };
  }
  installed(resourceId: string): InstalledResource | undefined {
    const row = this.options.db.prepare('SELECT record FROM catalog_install WHERE resource_id=? AND target_key=?').get(resourceId, this.targetKey);
    return row ? JSON.parse(String(row.record)) as InstalledResource : undefined;
  }
  cancel(id: string): DownloadStatus {
    const row = this.row(id);
    if (!terminal.has(row.state)) this.options.db.prepare('UPDATE catalog_operation SET state=\'cancelled\',generation=generation+1,error_code=NULL WHERE operation_id=?').run(id);
    this.aborts.get(id)?.abort();
    return this.status(id);
  }
  resume(id: string): Promise<DownloadStatus> {
    const existing = this.running.get(id); if (existing) return existing;
    const operation = this.perform(id).finally(() => { this.running.delete(id); this.aborts.delete(id); });
    this.running.set(id, operation); return operation;
  }
  private checkGeneration(id: string, generation: number): void {
    const row = this.row(id); if (Number(row.generation) !== generation || row.state === 'cancelled') throw new Error('STALE_DOWNLOAD');
  }
  private state(id: string, generation: number, state: DownloadState, errorCode?: string): void {
    this.checkGeneration(id, generation);
    this.options.db.prepare('UPDATE catalog_operation SET state=?,error_code=? WHERE operation_id=? AND generation=?').run(state, errorCode ?? null, id, generation);
  }
  private async perform(id: string): Promise<DownloadStatus> {
    const row = this.row(id); if (terminal.has(row.state)) return this.status(id);
    const generation = Number(row.generation) + 1;
    this.options.db.prepare('UPDATE catalog_operation SET generation=?,state=\'downloading\',error_code=NULL WHERE operation_id=?').run(generation, id);
    const abort = new AbortController(); this.aborts.set(id, abort);
    const partial = join(this.directory, 'partials', id); let staging: string | undefined;
    try {
      const manifest = this.checkedManifest(JSON.parse(row.envelope));
      assertSafeParents(join(this.directory, 'partials'));
      let offset = Number(row.downloaded_bytes);
      if (existsSync(partial)) {
        if (lstatSync(partial).isSymbolicLink() || !lstatSync(partial).isFile()) throw new Error('CATALOG_ARCHIVE_UNSAFE');
        const size = statSync(partial).size;
        if (size > offset) truncateSync(partial, offset);
        if (size < offset) { truncateSync(partial, 0); offset = 0; }
      } else { writeFileSync(partial, '', { flag: 'wx', mode: 0o600 }); offset = 0; }
      this.options.db.prepare('UPDATE catalog_operation SET downloaded_bytes=? WHERE operation_id=? AND generation=?').run(offset, id, generation);
      let authorization: DownloadAuthorization | undefined; let refreshes = 0; let chunks = 0;
      while (offset < manifest.size) {
        this.checkGeneration(id, generation);
        if (this.isWithdrawn(manifest)) throw new Error('CATALOG_WITHDRAWN');
        if (!authorization || authorization.expiresAt <= Date.now()) {
          if (++refreshes > 4) throw new Error('URL_EXPIRED');
          authorization = await this.options.source.authorize(manifest, this.options.target);
          this.checkGeneration(id, generation);
          if (!authorization || !authorization.url.startsWith('fixture://') || !Number.isFinite(authorization.expiresAt)) throw new Error('CATALOG_AUTHORIZATION_INVALID');
          if (authorization.expiresAt <= Date.now()) { authorization = undefined; continue; }
        }
        let chunk: { bytes: Uint8Array; done: boolean };
        try { chunk = await this.options.source.read(authorization, offset, abort.signal); }
        catch (error) { this.checkGeneration(id, generation); if (error instanceof Error && error.message === 'URL_EXPIRED') { authorization = undefined; continue; } throw error; }
        this.checkGeneration(id, generation);
        if (!(chunk.bytes instanceof Uint8Array) || typeof chunk.done !== 'boolean' || !chunk.bytes.length || offset + chunk.bytes.length > manifest.size) throw new Error('CATALOG_DOWNLOAD_INVALID');
        appendFileSync(partial, chunk.bytes); offset += chunk.bytes.length;
        this.options.db.prepare('UPDATE catalog_operation SET downloaded_bytes=? WHERE operation_id=? AND generation=?').run(offset, id, generation);
        if (chunk.done && offset < manifest.size) throw new Error('DOWNLOAD_INTERRUPTED');
        if (++chunks > 65536) throw new Error('DOWNLOAD_INTERRUPTED');
      }
      this.state(id, generation, 'verifying');
      if (this.isWithdrawn(manifest)) throw new Error('CATALOG_WITHDRAWN');
      const bytes = readFileSync(partial); verifyArtifact(bytes, manifest);
      this.state(id, generation, 'installing');
      assertSafeParents(join(this.directory, 'staging'));
      staging = join(this.directory, 'staging', `${id}-${generation}-${randomUUID()}`);
      extractArchive(bytes, staging, this.options.limits);
      writeFileSync(join(staging, '.an-manifest.json'), canonicalManifest(manifest), { flag: 'wx', mode: 0o600 });
      const versionParent = join(this.directory, 'versions', hashBytes(`${manifest.resourceId}:${this.targetKey}`));
      assertSafeParents(versionParent); mkdirSync(versionParent, { recursive: true, mode: 0o700 });
      const versionDirectory = join(versionParent, hashBytes(manifest.version));
      if (existsSync(versionDirectory)) {
        assertSafeParents(versionDirectory);
        verifyExtractedArchive(bytes, versionDirectory, this.options.limits);
        if (readFileSync(join(versionDirectory, '.an-manifest.json'), 'utf8') !== canonicalManifest(manifest)) throw new Error('CATALOG_VERSION_CONFLICT');
        rmSync(staging, { recursive: true, force: true }); staging = undefined;
      } else { renameSync(staging, versionDirectory); staging = undefined; }
      // A renamed version is inert until this single SQLite transaction activates it.
      this.checkGeneration(id, generation);
      if (this.isWithdrawn(manifest)) throw new Error('CATALOG_WITHDRAWN');
      const record: InstalledResource = { resourceId: manifest.resourceId, version: manifest.version, digest: manifest.digest, directory: versionDirectory, target: this.options.target };
      this.options.db.exec('SAVEPOINT catalog_activate');
      try {
        if (this.isWithdrawn(manifest)) throw new Error('CATALOG_WITHDRAWN');
        this.options.db.prepare('INSERT INTO catalog_install VALUES(?,?,?) ON CONFLICT(resource_id,target_key) DO UPDATE SET record=excluded.record').run(manifest.resourceId, this.targetKey, JSON.stringify(record));
        this.state(id, generation, 'ready'); this.options.db.exec('RELEASE catalog_activate');
      } catch (error) { this.options.db.exec('ROLLBACK TO catalog_activate'); this.options.db.exec('RELEASE catalog_activate'); throw error; }
    } catch (error) {
      if (staging) rmSync(staging, { recursive: true, force: true });
      const current = this.row(id);
      if (Number(current.generation) === generation && current.state !== 'cancelled') {
        const raw = error instanceof Error ? error.message : '';
        const code = /^CATALOG_[A-Z_]+$/.test(raw) || ['DOWNLOAD_INTERRUPTED', 'URL_EXPIRED', 'SOURCE_UNAVAILABLE'].includes(raw) ? raw : 'CATALOG_INSTALL_FAILED';
        this.state(id, generation, raw === 'SOURCE_UNAVAILABLE' ? 'waiting-source' : ['DOWNLOAD_INTERRUPTED', 'URL_EXPIRED'].includes(raw) ? 'interrupted' : 'failed', code);
      }
    }
    return this.status(id);
  }
}
