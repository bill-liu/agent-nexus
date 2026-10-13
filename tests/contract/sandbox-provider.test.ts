import { describe, expect, it, vi } from 'vitest';
import { MacOSVMProvider, PINNED_BOOTSTRAP, validateBootstrap } from '../../packages/execution/src/providers/macos-vm';
import { buildSandboxCommand, accountlessProbe } from '../../apps/node-agent/src/control';

describe('sandbox provider policy contracts (scripted, not live isolation)', () => {
 it('wrong_generation_rejected', async () => {
  const call = vi.fn(async () => ({ protocolVersion: 1, sandboxId: 's', generation: 2, state: 'stopped', evidenceKind: 'scripted' }));
  const provider = new MacOSVMProvider({ call } as never);
  await expect(provider.inspect({sandboxId:'s',generation:1})).rejects.toThrow('STALE_SANDBOX');
 });
 it('untrusted_bootstrap_rejected', () => {
  expect(() => validateBootstrap({...PINNED_BOOTSTRAP, sha256:'0'.repeat(64)})).toThrow('UNTRUSTED_BOOTSTRAP');
  expect(() => validateBootstrap({...PINNED_BOOTSTRAP, source:'https://evil.invalid/disk.iso'})).toThrow('UNTRUSTED_BOOTSTRAP');
 });
 it('refuses unsupported network policy before launching', () => {
  expect(() => buildSandboxCommand({network:'gateway'} as never)).toThrow('NETWORK_POLICY_UNSUPPORTED');
 });
 it('accountless probe refuses missing protected authorization', async () => {
  await expect(accountlessProbe(undefined as never)).rejects.toThrow('BLOCKED');
 });
});

import { cgroupTreeState } from '../../apps/node-agent/src/control';
import { resourceProperties } from '../../apps/node-agent/src/limits';
import { privatePath } from '../../apps/node-agent/src/storage';
import { mkdtempSync, realpathSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('dead_parent_live_child_is_not_stopped',()=>{
 expect(cgroupTreeState('populated 1\nfrozen 0\n')).toBe('running');
 expect(cgroupTreeState('populated 0\nfrozen 0\n')).toBe('stopped');
 expect(cgroupTreeState('populated 0\npopulated 1\n')).toBe('unknown');
 expect(cgroupTreeState('')).toBe('unknown');
});
it('discussion is a read-only mount and isolated cache remains writable',()=>{
 const argv=buildSandboxCommand({network:'none',discussion:true,rootfs:'/base',home:'/bot/home',project:'/bot/project',cache:'/bot/cache',limits:{cpuPercent:100,memoryBytes:256*1024**2,pids:64}});
 expect(argv.join(' ')).toContain('--ro-bind /bot/project /workspace');
 expect(argv.join(' ')).toContain('--bind /bot/cache /bot/home/.cache');
 expect(argv).toContain('--unshare-all');expect(argv).toContain('--clearenv');
});
it('unsupported disk quotas refuse instead of advertising a limit',()=>{
 expect(()=>resourceProperties({cpuPercent:100,memoryBytes:256*1024**2,pids:64,diskBytes:1e9})).toThrow('DISK_QUOTA_UNSUPPORTED');
});
it('private paths reject cross-bot traversal and symlink escapes',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'an-path-test-')));try {
  mkdirSync(join(root,'a'));mkdirSync(join(root,'b'));symlinkSync(join(root,'b'),join(root,'a','escape'));
  expect(()=>privatePath(join(root,'a'),join(root,'b'))).toThrow('NODE_PATH_DENIED');
  expect(()=>privatePath(join(root,'a'),join(root,'a','escape'))).toThrow('NODE_PATH_DENIED');
 } finally {rmSync(root,{recursive:true,force:true});}
});

import { execFileSync } from 'node:child_process';
it('missing actual cgroup enforcement blocks before any user argv executes',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'an-gate-test-')));const marker=join(root,'unexpected');
 const policy=Buffer.from(JSON.stringify({unit:`an-${'0'.repeat(64)}.service`,cpuPercent:100,memoryBytes:256*1024**2,pids:64,gatewayAddresses:['192.0.2.1']})).toString('base64url');
 try {
  expect(()=>execFileSync(process.execPath,['apps/node-agent/src/enforcement-gate.mjs',policy,'--','/usr/bin/touch',marker],{stdio:'pipe'})).toThrow();
  expect(()=>privatePath(root,marker)).toThrow();
 } finally {rmSync(root,{recursive:true,force:true});}
});

import { NodeProcessJournal } from '../../apps/node-agent/src/storage';
it('trusted process registry survives restart and preserves unknown exit status',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'an-journal-test-')));
 try {const journal=new NodeProcessJournal<{processInstanceId:string;exitCode?:number}>(root);journal.save([{processInstanceId:'p'}]);expect(new NodeProcessJournal(root).load()).toEqual([{processInstanceId:'p'}]);}
 finally {rmSync(root,{recursive:true,force:true});}
});
it('runtime attestation cannot be fabricated without an active native journal record',async()=>{
 const authority={nodeId:'n',sandboxId:'s',generation:1,privateRoot:'/not-mounted',rootfsRoot:'/not-rootfs',authorization:{targetId:'test-only',expiresAt:Date.now()+10000,actions:['sandbox-exec']}};
 const {NodeController}=await import('../../apps/node-agent/src/control');const controller=new NodeController(authority as never);
 await expect(controller.attestNative({nodeId:'n',sandboxId:'s',generation:1,transportInstanceId:'t',processInstanceId:'p',runId:'r',sessionId:'s',turnId:'t',fencingToken:1},{} as never)).rejects.toThrow(process.platform==='linux'?'NATIVE_ATTESTATION_UNAVAILABLE':'BLOCKED_NODE_AUTHORIZATION');
});

it('guest native environment agrees exactly with admitted A4 clean profile',async()=>{
 const {NATIVE_GUEST_ENVIRONMENT}=await import('../../apps/node-agent/src/control');
 const {codexBotEnvironment}=await import('../../packages/execution/src/drivers/codex-auth');
 expect(NATIVE_GUEST_ENVIRONMENT).toEqual(codexBotEnvironment({botDirectory:'/bot',home:'/bot/home',configuration:'clean'}));
});
