import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRegistry, AssetBindings, effectivePermissions, resolveRules, preserveUserInstructions } from '../../packages/assets/src/index';

const scope = { projectId: 'project', botId: 'developer' };
let directory: string;
let db: DatabaseSync;
let registry: AssetRegistry;
let bindings: AssetBindings;
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'an-assets-'))); db = new DatabaseSync(join(directory, 'db.sqlite')); registry = new AssetRegistry(db, join(directory, 'assets')); bindings = new AssetBindings(registry); });
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

describe('private local assets', () => {
  it('filters before Chinese keyword matching and hides unauthorized titles and originals', () => {
    const visible = registry.import({ id: 'visible', kind: 'knowledge', title: '接口规范', source: 'private-file', content: '中文接口规范：长期环境必须保留。' });
    registry.import({ id: 'hidden', kind: 'knowledge', title: '秘密项目标题', source: 'private-file', content: '中文接口规范：不应泄漏。' });
    bindings.bind('visible', scope);
    expect(registry.search('长期环境', scope)).toEqual([expect.objectContaining({ assetId: 'visible', title: '接口规范', version: 1 })]);
    expect(registry.search('中文接口规范', scope).map(x => x.assetId)).toEqual(['visible']);
    expect(registry.search('秘密', scope)).toEqual([]);
    expect(registry.search('接口', { ...scope, botId: 'other' })).toEqual([]);
    expect(() => registry.read('hidden', 1, scope)).toThrow('ASSET_ACCESS_DENIED');
    expect(readFileSync(visible.contentPath, 'utf8')).toContain('长期环境');
    expect(visible.indexPath).not.toBe(visible.contentPath);
  });

  it('persists immutable content versions, default local policy and fixed scope bindings', () => {
    const first = registry.import({ id: 'guide', kind: 'knowledge', title: '指南', source: 'file', content: '原文' });
    bindings.bind('guide', scope);
    const second = registry.update('guide', { title: '指南新版', source: 'file', content: '新版' });
    expect(first.version).toBe(1); expect(second.version).toBe(2); expect(first.digest).not.toBe(second.digest);
    expect(first.policy).toEqual({ mode: 'local-only' });
    expect(registry.read('guide', 1, scope)).toBe('原文');
    expect(() => registry.read('guide', 2, scope)).toThrow('ASSET_ACCESS_DENIED');
    const restarted = new AssetRegistry(db, join(directory, 'assets'));
    expect(restarted.read('guide', 1, scope)).toBe('原文');
    expect(() => registry.import({ id: 'guide', kind: 'knowledge', title: 'x', source: 'x', content: 'overwrite' })).toThrow('ASSET_EXISTS');
  });

  it('withdrawal immediately blocks reads and search and reports loaded runs without claiming forgetting', () => {
    registry.import({ id: 'guide', kind: 'knowledge', title: '指南', source: 'file', content: '授权资料' }); bindings.bind('guide', scope);
    bindings.trackUsage('guide', scope, 'run-1');
    expect(bindings.revoke('guide', scope)).toEqual({ affectedRunIds: ['run-1'], alreadyReadContentForgotten: false });
    expect(registry.search('授权', scope)).toEqual([]);
    expect(() => registry.read('guide', 1, scope)).toThrow('ASSET_ACCESS_DENIED');
    bindings.bind('guide', scope);
    registry.withdraw('guide');
    expect(registry.search('授权', scope)).toEqual([]);
    expect(() => bindings.bind('guide', scope)).toThrow('ASSET_WITHDRAWN');
  });
});

describe('rule boundaries', () => {
  const broad = { directories: ['/project'], network: ['gateway'], tools: ['read', 'write'], accounts: ['personal'], maxBytes: 1000, requireApproval: false };
  it('takes the intersection of all permission layers including resource limits and approval', () => {
    expect(effectivePermissions([broad, { ...broad, tools: ['read', 'shell'], network: [], maxBytes: 100, requireApproval: true }])).toEqual({ ...broad, tools: ['read'], network: [], maxBytes: 100, requireApproval: true });
  });
  it('rejects preference contradictions and attempted lower-scope permission expansion with sources', () => {
    expect(() => resolveRules([{ id: 'project-rule', version: 1, priority: 1, source: 'AGENTS.md', preferences: { format: 'json' } }, { id: 'bot-rule', version: 1, priority: 1, source: 'CLAUDE.md', preferences: { format: 'xml' } }], broad)).toThrow(/RULE_CONFLICT.*AGENTS.md.*CLAUDE.md/);
    expect(() => resolveRules([{ id: 'bot', version: 1, priority: 2, source: 'bot', permissions: { tools: ['shell'] } }], broad)).toThrow('RULE_CONFLICT');
    expect(resolveRules([{ id: 'project', version: 1, priority: 1, source: 'project', preferences: { format: 'json' } }, { id: 'task', version: 1, priority: 2, source: 'task', preferences: { format: 'xml' } }], broad).preferences).toEqual({ format: 'xml' });
  });
  it('preserves existing user instruction files and produces an additional AN instruction file', () => {
    expect(preserveUserInstructions({ 'AGENTS.md': '用户规约', 'CLAUDE.md': '原有规范' }, '新增规范')).toEqual({ 'AGENTS.md': '用户规约', 'CLAUDE.md': '原有规范', 'AN.instructions.md': '新增规范' });
  });
});
