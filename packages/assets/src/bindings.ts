import { AssetRegistry, type AssetScope, type AssetBinding, validateScope } from './registry';
export class AssetBindings {
  constructor(readonly registry: AssetRegistry) {}
  bind(assetId: string, scope: AssetScope, version?: number): AssetBinding {
    validateScope(scope);
    const fixedVersion = version ?? this.registry.latest(assetId).version;
    this.registry.latest(assetId); this.registry.version(assetId, fixedVersion);
    this.registry.db.prepare(`INSERT INTO assets_binding(asset_id,project_id,bot_id,version,active) VALUES(?,?,?,?,1)
      ON CONFLICT(asset_id,project_id,bot_id) DO UPDATE SET version=excluded.version, active=1`).run(assetId, scope.projectId, scope.botId, fixedVersion);
    return this.registry.binding(assetId, scope);
  }
  revoke(assetId: string, scope: AssetScope): { affectedRunIds: string[]; alreadyReadContentForgotten: false } {
    validateScope(scope);
    this.registry.db.prepare('UPDATE assets_binding SET active=0,epoch=epoch+1,enabled=0,grants=\'[]\',grant_epoch=grant_epoch+1 WHERE asset_id=? AND project_id=? AND bot_id=?').run(assetId, scope.projectId, scope.botId);
    return { affectedRunIds: this.registry.db.prepare('SELECT run_id FROM assets_usage WHERE asset_id=? AND project_id=? AND bot_id=? ORDER BY run_id').all(assetId, scope.projectId, scope.botId).map(x => String(x.run_id)), alreadyReadContentForgotten: false };
  }
  trackUsage(assetId: string, scope: AssetScope, runId: string): void {
    this.registry.assertAccess(assetId, scope);
    this.registry.db.prepare('INSERT OR IGNORE INTO assets_usage VALUES(?,?,?,?)').run(assetId, scope.projectId, scope.botId, runId);
  }
  list(scope: AssetScope): AssetBinding[] { return this.registry.list(scope); }
  enableSkill(assetId: string, scope: AssetScope, enabled = true): void {
    const binding = this.registry.binding(assetId, scope);
    if (this.registry.version(assetId, binding.version).kind !== 'skill') throw new Error('NOT_A_SKILL');
    this.registry.db.prepare('UPDATE assets_binding SET enabled=? WHERE asset_id=? AND project_id=? AND bot_id=?').run(enabled ? 1 : 0, assetId, scope.projectId, scope.botId);
  }
  grantSkill(assetId: string, scope: AssetScope, permissions: string[]): void {
    const binding = this.registry.binding(assetId, scope);
    if (this.registry.version(assetId, binding.version).kind !== 'skill' || permissions.some(x => typeof x !== 'string' || !x)) throw new Error('INVALID_SKILL_GRANT');
    this.registry.db.prepare('UPDATE assets_binding SET grants=? WHERE asset_id=? AND project_id=? AND bot_id=?').run(JSON.stringify([...new Set(permissions)]), assetId, scope.projectId, scope.botId);
  }
  revokeSkillGrant(assetId: string, scope: AssetScope): void {
    this.registry.db.prepare('UPDATE assets_binding SET grants=\'[]\',grant_epoch=grant_epoch+1 WHERE asset_id=? AND project_id=? AND bot_id=?').run(assetId, scope.projectId, scope.botId);
  }
  grantEpoch(assetId: string, scope: AssetScope): number {
    this.registry.assertAccess(assetId, scope);
    return Number(this.registry.db.prepare('SELECT grant_epoch FROM assets_binding WHERE asset_id=? AND project_id=? AND bot_id=?').get(assetId, scope.projectId, scope.botId)?.grant_epoch);
  }
}
