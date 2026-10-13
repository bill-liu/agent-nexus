import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadManager, canonicalManifest, hashBytes, type SignedManifest } from '../../packages/catalog-client/src';
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();});
function fixture(approved=true) {
 const db=new DatabaseSync(':memory:');const directory=mkdtempSync(join(tmpdir(),'an-raw-test-'));
 cleanups.push(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
 const bytes=Buffer.from('small inert raw bootstrap test bytes');
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const manifest={schemaVersion:1 as const,resourceId:'bootstrap-test',version:'1',digest:hashBytes(bytes),size:bytes.length,publisher:'test-only',source:'https://example.invalid/boot.iso',minAppProtocol:1,minRunnerProtocol:1,target:{os:'linux',arch:'arm64',provider:'macos-vm'},permissions:[],channel:'test',withdrawn:false,format:'raw-bootstrap-v1' as const};
 const envelope:SignedManifest={manifest,signature:{algorithm:'Ed25519',keyId:'test',value:sign(null,Buffer.from(canonicalManifest(manifest)),privateKey).toString('base64')}};
 let interrupted=false;
 const manager=new DownloadManager({db,directory,trustedKeys:new Map([['test',publicKey]]),target:{...manifest.target,appProtocol:1,runnerProtocol:1},bootstrapSources:approved?[{source:manifest.source,digest:manifest.digest,size:manifest.size,licenseRef:'synthetic-test-only'}]:[],source:{authorize:async()=>({url:manifest.source,expiresAt:Date.now()+60000}),read:async(_auth,offset)=>{if(!interrupted){interrupted=true;return {bytes:bytes.subarray(0,5),done:true};}return {bytes:bytes.subarray(offset),done:true};}}});
 return {manager,envelope,bytes};
}
describe('raw artifact catalog extension (synthetic bytes, no image download)',()=>{
 it('requires both trusted source pin and signed publisher',()=>{
  const {manager,envelope}=fixture(false);expect(()=>manager.start({commandId:'c',idempotencyKey:'i',botId:'b',envelope})).toThrow('PUBLIC_PUBLISHER_PREFLIGHT_REQUIRED');
 });
 it('resumes one operation and verifies inert raw artifact before activation',async()=>{
  const {manager,envelope,bytes}=fixture();const started=manager.start({commandId:'c',idempotencyKey:'i',botId:'b',envelope});
  expect((await manager.resume(started.operationId)).state).toBe('interrupted');
  expect((await manager.resume(started.operationId)).state).toBe('ready');
  expect(manager.start({commandId:'c',idempotencyKey:'i',botId:'b',envelope}).operationId).toBe(started.operationId);
  expect(readFileSync(join(manager.installed('bootstrap-test')!.directory,'artifact.bin'))).toEqual(bytes);
 });
});
