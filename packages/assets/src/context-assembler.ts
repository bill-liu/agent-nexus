import { randomUUID } from 'node:crypto';
import { AssetRegistry, digest, policyLocations, assertPolicy, type AssetScope, type DataPolicy, type SkillScript } from './registry';
import { AssetBindings } from './bindings';
import { resolveRules, preserveUserInstructions, type HardPermissions, type RuleVersion } from './rules';
export type ProcessingStage = 'retrieval' | 'embedding' | 'summary' | 'tool' | 'inference';
export interface ContextAsset { assetId: string; version: number; digest: string; bindingEpoch: number }
export interface ScriptCapability extends SkillScript { executionLocation: 'sandbox' }
export interface ContextManifest {
  manifestId: string; runId: string; turnId: string; scope: AssetScope; assets: ContextAsset[];
  ruleSet: { id: string; version: number; source: string; digest: string }[];
  skillVersions: (ContextAsset & { grantEpoch: number; scriptCapabilities: ScriptCapability[] })[];
  retrievalSources: { assetId: string; version: number; source: string; query: string }[];
  allowedProcessingLocations: string[]; contextBudget: { maxBytes: number; usedBytes: number }; effectivePermissions: HardPermissions;
}
export interface AssembleContext { runId: string; turnId: string; scope: AssetScope; projectPolicy: DataPolicy; permissions: HardPermissions; rules: RuleVersion[]; maxBytes: number; query?: string; userInstructions?: Record<string, string> }
export interface AssembledContext { manifest: ContextManifest; materials: { assetId: string; content: string }[]; instructions: Record<string, string> }
export class ContextAssembler {
  constructor(readonly registry: AssetRegistry, readonly bindings: AssetBindings) {}
  assemble(input: AssembleContext): AssembledContext {
    assertPolicy(input.projectPolicy);
    if (!input.runId || !input.turnId || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) throw new Error('INVALID_CONTEXT');
    const requestDigest = digest(JSON.stringify(input));
    const prior = this.registry.db.prepare('SELECT request_digest,manifest FROM assets_context WHERE run_id=? AND turn_id=?').get(input.runId, input.turnId);
    if (prior) {
      if (prior.request_digest !== requestDigest) throw new Error('CONTEXT_IDEMPOTENCY_CONFLICT');
      const manifest = JSON.parse(String(prior.manifest)) as ContextManifest;
      return { manifest, materials: manifest.assets.map(asset => ({ assetId: asset.assetId, content: this.read(manifest.manifestId, asset.assetId) })), instructions: preserveUserInstructions(input.userInstructions ?? {}, JSON.stringify(resolveRules(input.rules, input.permissions).preferences)) };
    }
    const resolved = resolveRules(input.rules, input.permissions);
    let allowed = policyLocations(input.projectPolicy);
    const assets: ContextAsset[] = []; const materials: AssembledContext['materials'] = []; const skillVersions: ContextManifest['skillVersions'] = [];
    for (const binding of this.bindings.list(input.scope)) {
      const metadata = this.registry.version(binding.assetId, binding.version);
      if (metadata.kind === 'skill' && !binding.enabled) continue;
      allowed = allowed.filter(location => policyLocations(metadata.policy).includes(location));
      const ref: ContextAsset = { assetId: binding.assetId, version: binding.version, digest: metadata.digest, bindingEpoch: binding.epoch };
      assets.push(ref); materials.push({ assetId: binding.assetId, content: this.registry.read(binding.assetId, binding.version, input.scope) });
      if (metadata.kind === 'skill') skillVersions.push({ ...ref, grantEpoch: this.bindings.grantEpoch(binding.assetId, input.scope), scriptCapabilities: metadata.scripts.filter(script => binding.grants.includes('script') && resolved.permissions.tools.includes('script') && script.permissions.every(permission => binding.grants.includes(permission) && resolved.permissions.tools.includes(permission))).map(script => ({ ...script, executionLocation: 'sandbox' })) });
    }
    if (!allowed.length) throw new Error('DATA_POLICY_DENIED');
    const maxBytes = Math.min(input.maxBytes, resolved.permissions.maxBytes);
    const usedBytes = materials.reduce((sum, material) => sum + Buffer.byteLength(material.content), 0);
    if (usedBytes > maxBytes) throw new Error('CONTEXT_BUDGET_EXCEEDED');
    const retrievalSources = input.query ? this.registry.search(input.query, input.scope).filter(result => assets.some(x => x.assetId === result.assetId)).map(result => ({ assetId: result.assetId, version: result.version, source: result.source, query: input.query! })) : [];
    const manifest: ContextManifest = { manifestId: randomUUID(), runId: input.runId, turnId: input.turnId, scope: structuredClone(input.scope), assets, ruleSet: input.rules.map(rule => ({ id: rule.id, version: rule.version, source: rule.source, digest: digest(JSON.stringify(rule)) })), skillVersions, retrievalSources, allowedProcessingLocations: allowed, contextBudget: { maxBytes, usedBytes }, effectivePermissions: resolved.permissions };
    const instructions = preserveUserInstructions(input.userInstructions ?? {}, JSON.stringify(resolved.preferences));
    this.registry.db.exec('SAVEPOINT assemble_context');
    try {
      for (const rule of input.rules) {
        if (!rule.id || !Number.isSafeInteger(rule.version) || rule.version < 1) throw new Error('INVALID_RULE_VERSION');
        const payload = JSON.stringify(rule); const ruleDigest = digest(payload);
        const existing = this.registry.db.prepare('SELECT digest FROM assets_rule_version WHERE rule_id=? AND version=?').get(rule.id, rule.version);
        if (existing && existing.digest !== ruleDigest) throw new Error('RULE_VERSION_CONFLICT');
        this.registry.db.prepare('INSERT OR IGNORE INTO assets_rule_version VALUES(?,?,?,?)').run(rule.id, rule.version, ruleDigest, payload);
      }
      this.registry.db.prepare('INSERT INTO assets_context VALUES(?,?,?,?,?)').run(manifest.manifestId, input.runId, input.turnId, requestDigest, JSON.stringify(manifest));
      for (const asset of assets) this.bindings.trackUsage(asset.assetId, input.scope, input.runId);
      this.registry.db.exec('RELEASE assemble_context');
    } catch (error) { this.registry.db.exec('ROLLBACK TO assemble_context'); this.registry.db.exec('RELEASE assemble_context'); throw error; }
    return { manifest: structuredClone(manifest), materials, instructions };
  }
  get(manifestId: string): ContextManifest {
    const row = this.registry.db.prepare('SELECT manifest FROM assets_context WHERE manifest_id=?').get(manifestId);
    if (!row) throw new Error('CONTEXT_NOT_FOUND');
    return JSON.parse(String(row.manifest)) as ContextManifest;
  }
  read(manifestId: string, assetId: string): string {
    const manifest = this.get(manifestId); const asset = manifest.assets.find(x => x.assetId === assetId);
    if (!asset) throw new Error('ASSET_ACCESS_DENIED');
    return this.registry.readSnapshot(assetId, asset.version, manifest.scope, manifestId);
  }
  assertProcessing(manifestId: string, stage: ProcessingStage, location: string): void {
    const manifest = this.get(manifestId);
    if (!['retrieval', 'embedding', 'summary', 'tool', 'inference'].includes(stage)) throw new Error('INVALID_PROCESSING_STAGE');
    for (const asset of manifest.assets) this.registry.assertAccess(asset.assetId, manifest.scope, asset.bindingEpoch);
    if (!manifest.allowedProcessingLocations.includes(location)) throw new Error('DATA_POLICY_DENIED');
  }
  scriptBundle(manifestId: string, executionLocation: string): { assetId: string; version: number; scripts: ScriptCapability[] }[] {
    if (executionLocation !== 'sandbox') throw new Error('SANDBOX_REQUIRED');
    const manifest = this.get(manifestId); this.assertProcessing(manifestId, 'tool', 'local');
    return manifest.skillVersions.filter(skill => skill.scriptCapabilities.length).map(skill => {
      const current = this.registry.assertAccess(skill.assetId, manifest.scope, skill.bindingEpoch);
      if (!current.enabled || !current.grants.includes('script') || !manifest.effectivePermissions.tools.includes('script') || skill.grantEpoch !== this.bindings.grantEpoch(skill.assetId, manifest.scope) || skill.scriptCapabilities.some(script => script.permissions.some(permission => !current.grants.includes(permission)))) throw new Error('SKILL_GRANT_REVOKED');
      return { assetId: skill.assetId, version: skill.version, scripts: structuredClone(skill.scriptCapabilities) };
    });
  }
}
