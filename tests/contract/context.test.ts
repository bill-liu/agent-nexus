import { afterEach, beforeEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRegistry, AssetBindings, ContextAssembler } from '../../packages/assets/src/index';
let directory: string; let db: DatabaseSync; let registry: AssetRegistry; let bindings: AssetBindings; let assembler: ContextAssembler;
const scope = { projectId: 'private', botId: 'bot' };
const permissions = { directories: ['/project'], network: [], tools: ['read', 'script'], accounts: [], maxBytes: 1000, requireApproval: true };
const input = () => ({ runId: 'run-1', turnId: 'turn-1', scope, projectPolicy: { mode: 'local-only' as const }, permissions, rules: [], maxBytes: 1000, query: '规范', userInstructions: { 'AGENTS.md': '用户指令' } });
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'an-context-'))); db = new DatabaseSync(join(directory, 'db')); registry = new AssetRegistry(db, join(directory, 'assets')); bindings = new AssetBindings(registry); assembler = new ContextAssembler(registry, bindings); });
afterEach(() => { db.close(); rmSync(directory, { force: true, recursive: true }); });

it('fixes versions/digests and retrieval evidence per run, stores metadata only, and rechecks immediate revoke on every read/request', () => {
  registry.import({ id: 'guide', title: '规范', kind: 'knowledge', content: '第一版规范', source: 'local-file' }); bindings.bind('guide', scope);
  const first = assembler.assemble(input());
  expect(first.manifest.assets).toEqual([expect.objectContaining({ assetId: 'guide', version: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  expect(first.manifest.retrievalSources).toEqual([expect.objectContaining({ assetId: 'guide', query: '规范', source: 'local-file' })]);
  expect(first.manifest.allowedProcessingLocations).toEqual(['local']);
  expect(first.instructions['AGENTS.md']).toBe('用户指令');
  expect(JSON.stringify(first.manifest)).not.toContain('第一版规范');
  registry.update('guide', { title: '规范', source: 'local-file', content: '第二版规范' }); bindings.bind('guide', scope, 2);
  expect(assembler.read(first.manifest.manifestId, 'guide')).toBe('第一版规范');
  expect(assembler.assemble({ ...input(), runId: 'run-2' }).manifest.assets[0]?.version).toBe(2);
  const restart = new ContextAssembler(new AssetRegistry(db, join(directory, 'assets')), bindings);
  expect(restart.get(first.manifest.manifestId)).toEqual(first.manifest);
  expect(bindings.revoke('guide', scope).affectedRunIds).toEqual(['run-1', 'run-2']);
  expect(() => assembler.read(first.manifest.manifestId, 'guide')).toThrow('ASSET_ACCESS_DENIED');
  expect(() => assembler.assertProcessing(first.manifest.manifestId, 'inference', 'local')).toThrow('ASSET_ACCESS_DENIED');
});

it.each(['retrieval', 'embedding', 'summary', 'tool', 'inference'] as const)('enforces local-only at the %s stage', stage => {
  registry.import({ id: 'local', title: '规范', kind: 'knowledge', content: '规范', source: 'local' }); bindings.bind('local', scope);
  const { manifest } = assembler.assemble(input());
  expect(() => assembler.assertProcessing(manifest.manifestId, stage, 'gateway:cloud')).toThrow('DATA_POLICY_DENIED');
  expect(() => assembler.assertProcessing(manifest.manifestId, stage, 'local')).not.toThrow();
});

it('keeps skill installation, scope enablement and explicit script grant distinct', () => {
  registry.import({ id: 'skill', title: '测试Skill', kind: 'skill', content: '# SKILL\n规范', source: 'local', scripts: [{ path: 'scripts/check.sh', permissions: ['script'] }] });
  expect(assembler.assemble(input()).manifest.skillVersions).toEqual([]);
  bindings.bind('skill', scope); bindings.enableSkill('skill', scope);
  const enabled = assembler.assemble({ ...input(), runId: 'enabled' });
  expect(enabled.manifest.skillVersions[0]?.scriptCapabilities).toEqual([]);
  bindings.grantSkill('skill', scope, ['script']);
  const granted = assembler.assemble({ ...input(), runId: 'granted' });
  expect(granted.manifest.skillVersions[0]?.scriptCapabilities).toEqual([{ path: 'scripts/check.sh', permissions: ['script'], executionLocation: 'sandbox' }]);
  expect(() => assembler.scriptBundle(granted.manifest.manifestId, 'main')).toThrow('SANDBOX_REQUIRED');
  expect(assembler.scriptBundle(granted.manifest.manifestId, 'sandbox').length).toBe(1);
  bindings.revokeSkillGrant('skill', scope);
  expect(() => assembler.scriptBundle(granted.manifest.manifestId, 'sandbox')).toThrow('SKILL_GRANT_REVOKED');
});

it('budgets exact UTF-8 bytes and rejects a reused run/turn with different context', () => {
  registry.import({ id: 'guide', title: '规范', kind: 'knowledge', content: '规范中文', source: 'local' }); bindings.bind('guide', scope);
  expect(() => assembler.assemble({ ...input(), maxBytes: 2 })).toThrow('CONTEXT_BUDGET_EXCEEDED');
  const first = assembler.assemble(input());
  expect(first.manifest.contextBudget.usedBytes).toBe(Buffer.byteLength('规范中文'));
  expect(assembler.assemble(input()).manifest).toEqual(first.manifest);
  expect(() => assembler.assemble({ ...input(), query: '中文' })).toThrow('CONTEXT_IDEMPOTENCY_CONFLICT');
});

it('assembles within a Core transaction and rolls context/usage back with the outer command', () => {
  registry.import({ id: 'guide', title: '规范', kind: 'knowledge', content: '规范', source: 'local' }); bindings.bind('guide', scope);
  db.exec('BEGIN IMMEDIATE');
  let manifestId: string;
  try { manifestId = assembler.assemble(input()).manifest.manifestId; } finally { db.exec('ROLLBACK'); }
  expect(() => assembler.get(manifestId!)).toThrow('CONTEXT_NOT_FOUND');
  expect(bindings.revoke('guide', scope).affectedRunIds).toEqual([]);
});

it('persists immutable rule versions and records their digest without instruction contents', () => {
  const rule = { id: 'format', version: 1, source: 'AGENTS.md', priority: 1, preferences: { format: 'json' } };
  const manifest = assembler.assemble({ ...input(), rules: [rule] }).manifest;
  expect(manifest.ruleSet).toEqual([expect.objectContaining({ id: 'format', version: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  expect(() => assembler.assemble({ ...input(), runId: 'run-2', rules: [{ ...rule, preferences: { format: 'xml' } }] })).toThrow('RULE_VERSION_CONFLICT');
});

it('keeps revoked old contexts blocked after the asset is explicitly rebound', () => {
  registry.import({ id: 'guide', title: '规范', kind: 'knowledge', content: '规范', source: 'local' }); bindings.bind('guide', scope);
  const manifest = assembler.assemble(input()).manifest;
  bindings.revoke('guide', scope); bindings.bind('guide', scope);
  expect(() => assembler.read(manifest.manifestId, 'guide')).toThrow('ASSET_ACCESS_DENIED');
  expect(assembler.assemble({ ...input(), runId: 'new-run' }).materials[0]?.content).toBe('规范');
});

it('requires an explicit script grant and script tool even for scripts declaring no child permissions', () => {
  registry.import({ id: 'empty-script', title: '规范', kind: 'skill', content: '规范', source: 'local', scripts: [{ path: 'run.sh', permissions: [] }] });
  bindings.bind('empty-script', scope); bindings.enableSkill('empty-script', scope);
  const denied = assembler.assemble({ ...input(), permissions: { ...permissions, tools: [] } });
  expect(assembler.scriptBundle(denied.manifest.manifestId, 'sandbox')).toEqual([]);
  expect(assembler.assemble({ ...input(), runId: 'no-grant' }).manifest.skillVersions[0]?.scriptCapabilities).toEqual([]);
  bindings.grantSkill('empty-script', scope, ['script']);
  expect(assembler.assemble({ ...input(), runId: 'explicit-grant' }).manifest.skillVersions[0]?.scriptCapabilities).toHaveLength(1);
  bindings.revokeSkillGrant('empty-script', scope);
  expect(assembler.assemble({ ...input(), runId: 'revoked-grant' }).manifest.skillVersions[0]?.scriptCapabilities).toEqual([]);
});

it('rejects forged raw snapshot access to an asset version absent from the persisted context', () => {
  registry.import({ id: 'guide', title: '规范', kind: 'knowledge', content: 'first', source: 'local' }); bindings.bind('guide', scope);
  const manifest = assembler.assemble(input()).manifest;
  registry.update('guide', { title: '规范', content: 'never bound', source: 'local' });
  expect(registry.readSnapshot('guide', 1, scope, manifest.manifestId)).toBe('first');
  expect(() => registry.readSnapshot('guide', 2, scope, manifest.manifestId)).toThrow('ASSET_ACCESS_DENIED');
  expect(() => registry.readSnapshot('guide', 1, { ...scope, botId: 'other' }, manifest.manifestId)).toThrow('ASSET_ACCESS_DENIED');
});
