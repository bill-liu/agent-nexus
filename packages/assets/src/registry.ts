import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

export interface AssetScope { projectId: string; botId: string }
export type DataPolicy = { mode: 'local-only' } | { mode: 'restricted'; locations: string[] };
export type AssetKind = 'knowledge' | 'skill' | 'rule' | 'experience';
export interface SkillScript { path: string; permissions: string[] }
export interface ImportAsset { id: string; title: string; source: string; content: string; kind: AssetKind; policy?: DataPolicy; scripts?: SkillScript[] }
export interface AssetVersion { assetId: string; kind: AssetKind; title: string; source: string; version: number; digest: string; updatedAt: string; policy: DataPolicy; contentPath: string; indexPath: string; scripts: SkillScript[] }
export interface AssetBinding { assetId: string; version: number; epoch: number; enabled: boolean; grants: string[] }
export interface SearchResult { assetId: string; title: string; version: number; digest: string; source: string; snippet: string }
export function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function policyLocations(policy: DataPolicy): string[] { return policy.mode === 'local-only' ? ['local'] : [...policy.locations]; }
export function assertPolicy(policy: DataPolicy): void {
  if (!policy || !['local-only', 'restricted'].includes(policy.mode) || (policy.mode === 'restricted' && (!Array.isArray(policy.locations) || policy.locations.some(x => typeof x !== 'string' || !x)))) throw new Error('INVALID_DATA_POLICY');
}
export function validateScope(scope: AssetScope): void { if (!scope.projectId || !scope.botId) throw new Error('INVALID_ASSET_SCOPE'); }

/** Core-only repository. Originals and derived indexes remain separate in the explicit directory. */
export class AssetRegistry {
  readonly directory: string;
  constructor(readonly db: DatabaseSync, directory: string) {
    if (!directory) throw new Error('ASSET_DIRECTORY_REQUIRED');
    this.directory = resolve(directory);
    mkdirSync(join(this.directory, 'originals'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.directory, 'indexes'), { recursive: true, mode: 0o700 });
    db.exec(`CREATE TABLE IF NOT EXISTS assets_asset(id TEXT PRIMARY KEY, kind TEXT NOT NULL, current_version INTEGER NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS assets_version(asset_id TEXT NOT NULL, version INTEGER NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(asset_id,version));
      CREATE TABLE IF NOT EXISTS assets_binding(asset_id TEXT NOT NULL, project_id TEXT NOT NULL, bot_id TEXT NOT NULL, version INTEGER NOT NULL, active INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0, grants TEXT NOT NULL DEFAULT '[]', grant_epoch INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(asset_id,project_id,bot_id));
      CREATE TABLE IF NOT EXISTS assets_usage(asset_id TEXT NOT NULL, project_id TEXT NOT NULL, bot_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(asset_id,project_id,bot_id,run_id));
      CREATE TABLE IF NOT EXISTS assets_rule_version(rule_id TEXT NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(rule_id,version));
      CREATE TABLE IF NOT EXISTS assets_context(manifest_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, turn_id TEXT NOT NULL, request_digest TEXT NOT NULL, manifest TEXT NOT NULL, UNIQUE(run_id,turn_id));`);
  }
  import(input: ImportAsset): AssetVersion {
    if (this.db.prepare('SELECT id FROM assets_asset WHERE id=?').get(input.id)) throw new Error('ASSET_EXISTS');
    return this.save(input, 1);
  }
  update(assetId: string, input: Omit<ImportAsset, 'id' | 'kind'>): AssetVersion {
    const current = this.latest(assetId);
    return this.save({ ...input, id: assetId, kind: current.kind, policy: input.policy ?? current.policy, scripts: input.scripts ?? current.scripts }, current.version + 1);
  }
  private save(input: ImportAsset, version: number): AssetVersion {
    if (!input.id || !input.title || !input.source || typeof input.content !== 'string' || !['knowledge', 'skill', 'rule', 'experience'].includes(input.kind)) throw new Error('INVALID_ASSET');
    if (Buffer.byteLength(input.content) > 16 * 1024 * 1024) throw new Error('ASSET_TOO_LARGE');
    const policy = input.policy ?? { mode: 'local-only' }; assertPolicy(policy);
    const scripts = input.scripts ?? [];
    if (scripts.length && input.kind !== 'skill') throw new Error('INVALID_SKILL');
    for (const script of scripts) if (!script.path || script.path.startsWith('/') || script.path.includes('\\') || script.path.split('/').some(x => x === '..' || x === '.' || !x) || !Array.isArray(script.permissions) || script.permissions.some(x => typeof x !== 'string' || !x)) throw new Error('INVALID_SKILL_SCRIPT');
    const storageId = `${digest(input.id)}-${version}`;
    const value: AssetVersion = { assetId: input.id, kind: input.kind, title: input.title, source: input.source, version, digest: digest(input.content), updatedAt: new Date().toISOString(), policy, scripts, contentPath: join(this.directory, 'originals', storageId), indexPath: join(this.directory, 'indexes', storageId) };
    writeFileSync(value.contentPath, input.content, { flag: 'wx', mode: 0o600 });
    try {
      writeFileSync(value.indexPath, input.content.normalize('NFKC').toLocaleLowerCase(), { flag: 'wx', mode: 0o600 });
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (version === 1) this.db.prepare('INSERT INTO assets_asset(id,kind,current_version) VALUES(?,?,?)').run(input.id, input.kind, version);
        else if (!this.db.prepare('UPDATE assets_asset SET current_version=? WHERE id=? AND current_version=? AND withdrawn=0').run(version, input.id, version - 1).changes) throw new Error('ASSET_VERSION_CONFLICT');
        this.db.prepare('INSERT INTO assets_version VALUES(?,?,?)').run(input.id, version, JSON.stringify(value));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { rmSync(value.contentPath, { force: true }); rmSync(value.indexPath, { force: true }); throw error; }
    return structuredClone(value);
  }
  latest(assetId: string): AssetVersion {
    const row = this.db.prepare('SELECT current_version,withdrawn FROM assets_asset WHERE id=?').get(assetId);
    if (!row) throw new Error('ASSET_NOT_FOUND');
    if (row.withdrawn) throw new Error('ASSET_WITHDRAWN');
    return this.version(assetId, Number(row.current_version));
  }
  version(assetId: string, version: number): AssetVersion {
    const row = this.db.prepare('SELECT metadata FROM assets_version WHERE asset_id=? AND version=?').get(assetId, version);
    if (!row) throw new Error('ASSET_VERSION_NOT_FOUND');
    return JSON.parse(String(row.metadata)) as AssetVersion;
  }
  binding(assetId: string, scope: AssetScope): AssetBinding {
    validateScope(scope);
    const row = this.db.prepare('SELECT b.*,a.withdrawn FROM assets_binding b JOIN assets_asset a ON a.id=b.asset_id WHERE b.asset_id=? AND b.project_id=? AND b.bot_id=? AND b.active=1 AND a.withdrawn=0').get(assetId, scope.projectId, scope.botId);
    if (!row) throw new Error('ASSET_ACCESS_DENIED');
    return { assetId, version: Number(row.version), epoch: Number(row.epoch), enabled: Boolean(row.enabled), grants: JSON.parse(String(row.grants)) as string[] };
  }
  list(scope: AssetScope): AssetBinding[] {
    validateScope(scope);
    return this.db.prepare('SELECT b.asset_id FROM assets_binding b JOIN assets_asset a ON a.id=b.asset_id WHERE b.project_id=? AND b.bot_id=? AND b.active=1 AND a.withdrawn=0 ORDER BY b.asset_id').all(scope.projectId, scope.botId).map(row => this.binding(String(row.asset_id), scope));
  }
  assertAccess(assetId: string, scope: AssetScope, epoch?: number): AssetBinding {
    const binding = this.binding(assetId, scope);
    if (epoch !== undefined && epoch !== binding.epoch) throw new Error('ASSET_ACCESS_DENIED');
    return binding;
  }
  read(assetId: string, version: number, scope: AssetScope): string {
    const binding = this.assertAccess(assetId, scope);
    if (binding.version !== version) throw new Error('ASSET_ACCESS_DENIED');
    return this.readOriginal(assetId, version);
  }
  readSnapshot(assetId: string, version: number, scope: AssetScope, manifestId: string): string {
    const row = this.db.prepare('SELECT manifest FROM assets_context WHERE manifest_id=?').get(manifestId);
    if (!row) throw new Error('ASSET_ACCESS_DENIED');
    const manifest = JSON.parse(String(row.manifest)) as { scope: AssetScope; assets: { assetId: string; version: number; bindingEpoch: number }[] };
    const reference = manifest.assets.find(asset => asset.assetId === assetId && asset.version === version);
    if (!reference || scope.projectId !== manifest.scope.projectId || scope.botId !== manifest.scope.botId) throw new Error('ASSET_ACCESS_DENIED');
    this.assertAccess(assetId, scope, reference.bindingEpoch);
    return this.readOriginal(assetId, version);
  }
  private readOriginal(assetId: string, version: number): string {
    const metadata = this.version(assetId, version);
    const content = readFileSync(metadata.contentPath, 'utf8');
    if (digest(content) !== metadata.digest) throw new Error('ASSET_INTEGRITY_FAILED');
    return content;
  }
  search(query: string, scope: AssetScope): SearchResult[] {
    const normalized = query.normalize('NFKC').toLocaleLowerCase().trim();
    if (!normalized) return [];
    const results: SearchResult[] = [];
    // Authorization precedes index access; unauthorized titles never enter results.
    for (const binding of this.list(scope)) {
      const metadata = this.version(binding.assetId, binding.version);
      const index = readFileSync(metadata.indexPath, 'utf8');
      if (!index.includes(normalized) && !metadata.title.normalize('NFKC').toLocaleLowerCase().includes(normalized)) continue;
      const content = this.read(binding.assetId, binding.version, scope);
      results.push({ assetId: binding.assetId, title: metadata.title, version: binding.version, digest: metadata.digest, source: metadata.source, snippet: content.slice(0, 240) });
    }
    return results;
  }
  withdraw(assetId: string): { affectedRunIds: string[]; alreadyReadContentForgotten: false } {
    this.db.prepare('UPDATE assets_asset SET withdrawn=1 WHERE id=?').run(assetId);
    return { affectedRunIds: this.db.prepare('SELECT DISTINCT run_id FROM assets_usage WHERE asset_id=? ORDER BY run_id').all(assetId).map(x => String(x.run_id)), alreadyReadContentForgotten: false };
  }
}
