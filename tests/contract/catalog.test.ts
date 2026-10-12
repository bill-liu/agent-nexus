import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DownloadManager, verifyManifest, extractArchive, type DownloadOptions } from '../../packages/catalog-client/src/index';
import { fixture, FixtureSource, resign } from '../fixtures/catalog/source';

const target = { os: 'linux', arch: 'arm64', provider: 'fake', appProtocol: 1, runnerProtocol: 1 };
let directory: string; let db: DatabaseSync;
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'an-catalog-'))); db = new DatabaseSync(join(directory, 'db.sqlite')); });
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
function manager(value: ReturnType<typeof fixture>, source = new FixtureSource(value.bytes), options: Partial<DownloadOptions> = {}) {
  return new DownloadManager({ db, directory: join(directory, 'catalog'), trustedKeys: value.trustedKeys, target, source, ...options });
}
const request = (value: ReturnType<typeof fixture>, key = 'download-1') => ({ commandId: key, idempotencyKey: key, botId: 'existing-bot', envelope: value.envelope });

describe('strict catalog trust and compatibility', () => {
  it('uses the execution node architecture and rejects mismatches, withdrawal and unmet protocols', () => {
    const value = fixture();
    expect(verifyManifest(value.envelope, value.trustedKeys, target).target.arch).toBe('arm64');
    expect(() => verifyManifest(value.envelope, value.trustedKeys, { ...target, arch: 'x64' })).toThrow('CATALOG_INCOMPATIBLE');
    expect(() => verifyManifest(resign(value, { withdrawn: true }), value.trustedKeys, target)).toThrow('CATALOG_WITHDRAWN');
    expect(() => verifyManifest(resign(value, { minRunnerProtocol: 2 }), value.trustedKeys, target)).toThrow('CATALOG_INCOMPATIBLE');
  });
  it('requires a trusted independent publisher signature, canonical payload and strict schema', () => {
    const value = fixture();
    expect(() => verifyManifest(value.envelope, new Map(), target)).toThrow('CATALOG_UNTRUSTED_PUBLISHER');
    expect(() => verifyManifest({ ...value.envelope, manifest: { ...value.envelope.manifest, publisher: 'attacker' } }, value.trustedKeys, target)).toThrow('CATALOG_SIGNATURE_INVALID');
    expect(() => verifyManifest({ ...value.envelope, manifest: { ...value.envelope.manifest, installCommand: 'touch stolen' } }, value.trustedKeys, target)).toThrow('CATALOG_MANIFEST_INVALID');
    expect(() => verifyManifest({ ...value.envelope, signature: { ...value.envelope.signature, value: 'garbage' } }, value.trustedKeys, target)).toThrow('CATALOG_SIGNATURE_INVALID');
    expect(() => manager(value).start({ ...request(value), envelope: resign(value, { source: 'https://publisher.example/package' }) })).toThrow('PUBLIC_PUBLISHER_PREFLIGHT_REQUIRED');
  });
});

describe('persistent resumable operation and activation', () => {
  it('deduplicates commands, resumes after interruption/restart and refreshes expired authorization', async () => {
    const value = fixture(); const source = new FixtureSource(value.bytes); source.expired = true; source.interruptAt = 32;
    const first = manager(value, source); const operation = first.start(request(value));
    expect(first.start(request(value)).operationId).toBe(operation.operationId);
    expect(await first.resume(operation.operationId)).toMatchObject({ state: 'interrupted', downloadedBytes: 32, botId: 'existing-bot' });
    expect(source.authorizations).toBe(2);
    const restarted = manager(value, source);
    expect(await restarted.resume(operation.operationId)).toMatchObject({ state: 'ready', downloadedBytes: value.bytes.length, botId: 'existing-bot' });
    expect(source.offsets.filter(x => x === 0)).toHaveLength(1);
    expect(readFileSync(join(restarted.installed('skill-example')!.directory, 'SKILL.md'), 'utf8')).toBe('# fixture skill');
    const oldCalls = source.offsets.length;
    expect(await restarted.resume(operation.operationId)).toMatchObject({ state: 'ready' });
    expect(source.offsets).toHaveLength(oldCalls);
    expect(() => first.start({ ...request(value), botId: 'another-bot' })).toThrow('CATALOG_IDEMPOTENCY_CONFLICT');
  });
  it('cancelled work never activates even when an in-flight fixture read resolves late', async () => {
    const value = fixture(); const source = new FixtureSource(value.bytes); let release!: () => void;
    source.block = new Promise<void>(resolve => { release = resolve; });
    const client = manager(value, source); const operation = client.start(request(value));
    const pending = client.resume(operation.operationId);
    await Promise.resolve(); client.cancel(operation.operationId); release();
    expect(await pending).toMatchObject({ state: 'cancelled' });
    expect(await client.resume(operation.operationId)).toMatchObject({ state: 'cancelled' });
    expect(client.installed('skill-example')).toBeUndefined();
  });
  it('offline source and failed hash leave the prior installed version usable', async () => {
    const value = fixture(); const first = manager(value); const installed = first.start(request(value)); await first.resume(installed.operationId);
    const next = fixture(undefined, '2'); const corrupt = new FixtureSource(Buffer.from('corrupt'.padEnd(next.bytes.length, '!'))); const second = manager(next, corrupt);
    const bad = second.start(request(next, 'update'));
    expect(await second.resume(bad.operationId)).toMatchObject({ state: 'failed', errorCode: 'CATALOG_DIGEST_INVALID' });
    expect(second.installed('skill-example')?.version).toBe('1');
    const third = fixture(undefined, '3'); const offline = new FixtureSource(third.bytes); offline.offline = true; const unavailable = manager(third, offline);
    expect(await unavailable.resume(unavailable.start(request(third, 'offline')).operationId)).toMatchObject({ state: 'waiting-source' });
    expect(unavailable.installed('skill-example')?.version).toBe('1');
  });
  it('never overwrites immutable versions with a newly signed different package', async () => {
    const first = fixture(); const client = manager(first); await client.resume(client.start(request(first)).operationId);
    const other = fixture([{ type: 'file', path: 'SKILL.md', content: 'changed' }]);
    expect(() => manager(other).start(request(other, 'another'))).toThrow('CATALOG_VERSION_CONFLICT');
    expect(client.installed('skill-example')?.digest).toBe(first.envelope.manifest.digest);
  });
  it('does not reactivate a tampered cached version based only on its manifest marker', async () => {
    const value = fixture(); const client = manager(value); await client.resume(client.start(request(value)).operationId);
    const installed = client.installed('skill-example')!;
    const { writeFileSync } = await import('node:fs'); writeFileSync(join(installed.directory, 'SKILL.md'), 'tampered');
    const another = client.start(request(value, 'second-install'));
    expect(await client.resume(another.operationId)).toMatchObject({ state: 'failed', errorCode: 'CATALOG_INSTALL_INTEGRITY' });
  });
  it('fences a stale manager after a second manager resumes the same operation', async () => {
    const value = fixture(); const blocked = new FixtureSource(value.bytes); let release!: () => void;
    blocked.block = new Promise<void>(resolve => { release = resolve; });
    const first = manager(value, blocked); const operation = first.start(request(value)); const pending = first.resume(operation.operationId);
    await Promise.resolve();
    const second = manager(value); expect(await second.resume(operation.operationId)).toMatchObject({ state: 'ready' });
    release(); expect(await pending).toMatchObject({ state: 'ready' });
    expect(blocked.offsets).toHaveLength(1);
    expect(readFileSync(join(second.installed('skill-example')!.directory, 'SKILL.md'), 'utf8')).toBe('# fixture skill');
  });
  it('persists authenticated withdrawal and blocks old pending and new installs without destroying cache', async () => {
    const value = fixture(); const client = manager(value); await client.resume(client.start(request(value)).operationId);
    const pending = client.start(request(value, 'pending'));
    expect(() => client.start({ ...request(value, 'withdrawn'), envelope: resign(value, { withdrawn: true }) })).toThrow('CATALOG_WITHDRAWN');
    const restarted = manager(value);
    expect(await restarted.resume(pending.operationId)).toMatchObject({ state: 'failed', errorCode: 'CATALOG_WITHDRAWN' });
    expect(() => restarted.start(request(value, 'old-manifest'))).toThrow('CATALOG_WITHDRAWN');
    expect(restarted.installed('skill-example')?.version).toBe('1');
  });
  it('does not persist a forged withdrawal and rechecks withdrawal after an in-flight read', async () => {
    const value = fixture(); const source = new FixtureSource(value.bytes); const client = manager(value, source);
    expect(() => client.start({ ...request(value, 'forged'), envelope: { ...value.envelope, manifest: { ...value.envelope.manifest, withdrawn: true } } })).toThrow('CATALOG_SIGNATURE_INVALID');
    const operation = client.start(request(value)); let release!: () => void;
    source.block = new Promise<void>(resolve => { release = resolve; }); const pending = client.resume(operation.operationId); await Promise.resolve();
    try { client.start({ ...request(value, 'valid-withdrawal'), envelope: resign(value, { withdrawn: true }) }); } catch (error) { expect((error as Error).message).toBe('CATALOG_WITHDRAWN'); }
    release(); expect(await pending).toMatchObject({ state: 'failed', errorCode: 'CATALOG_WITHDRAWN' });
    expect(client.installed('skill-example')).toBeUndefined();
  });
});

describe('limited fixture archive extraction', () => {
  it.each([
    { type: 'file', path: '../escape', content: 'x' }, { type: 'file', path: '/tmp/escape', content: 'x' },
    { type: 'file', path: 'C:\\escape', content: 'x' }, { type: 'file', path: 'a/../../escape', content: 'x' },
    { type: 'symlink', path: 'escape', target: '../outside' }, { type: 'hardlink', path: 'escape', target: '../outside' },
  ])('rejects unsafe archive entry %j without activation', async entry => {
    const value = fixture([entry]); const client = manager(value); const operation = client.start(request(value));
    expect(await client.resume(operation.operationId)).toMatchObject({ state: 'failed', errorCode: 'CATALOG_ARCHIVE_UNSAFE' });
    expect(client.installed('skill-example')).toBeUndefined();
    expect(existsSync(join(directory, 'escape'))).toBe(false);
  });
  it.each([
    { entries: [{ type: 'file', path: 'a', content: 'x' }, { type: 'file', path: 'a', content: 'y' }] },
    { entries: [{ type: 'file', path: 'A', content: 'x' }, { type: 'file', path: 'a', content: 'y' }] },
    { entries: [{ type: 'file', path: 'a', content: 'x' }, { type: 'file', path: 'a/b', content: 'y' }] },
  ])('rejects duplicate, case-colliding and ancestor file entries', ({ entries }) => {
    expect(() => extractArchive(fixture(entries).bytes, join(directory, 'extract'))).toThrow('CATALOG_ARCHIVE_UNSAFE');
  });
  it('rejects implicit parent case collisions and normalized path traversal', () => {
    expect(() => extractArchive(fixture([{ type: 'file', path: 'A/one', content: 'x' }, { type: 'file', path: 'a/two', content: 'y' }]).bytes, join(directory, 'extract'))).toThrow('CATALOG_ARCHIVE_UNSAFE');
    expect(() => extractArchive(fixture([{ type: 'file', path: '．．/outside', content: 'x' }]).bytes, join(directory, 'extract'))).toThrow('CATALOG_ARCHIVE_UNSAFE');
  });
  it('bounds archive bytes, entry count, and expanded bytes before writing any file', () => {
    const value = fixture([{ type: 'file', path: 'one', content: '1234' }, { type: 'file', path: 'two', content: '5678' }]);
    expect(() => extractArchive(value.bytes, join(directory, 'extract'), { maxArchiveBytes: 1 })).toThrow('CATALOG_ARCHIVE_LIMIT');
    expect(() => extractArchive(value.bytes, join(directory, 'extract'), { maxEntries: 1 })).toThrow('CATALOG_ARCHIVE_LIMIT');
    expect(() => extractArchive(value.bytes, join(directory, 'extract'), { maxExpandedBytes: 3 })).toThrow('CATALOG_ARCHIVE_LIMIT');
    expect(existsSync(join(directory, 'extract', 'one'))).toBe(false);
  });
  it('rejects a preexisting extraction symlink and treats package scripts as inert files', () => {
    mkdirSync(join(directory, 'outside')); symlinkSync(join(directory, 'outside'), join(directory, 'extract'));
    expect(() => extractArchive(fixture().bytes, join(directory, 'extract'))).toThrow('CATALOG_ARCHIVE_UNSAFE');
    const out = join(directory, 'fresh'); extractArchive(fixture([{ type: 'file', path: 'install.sh', content: 'touch /tmp/never-execute-an' }]).bytes, out);
    expect(readFileSync(join(out, 'install.sh'), 'utf8')).toContain('touch');
  });
});
