import { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { NodeRunnerChannel, serveNodeChannel } from '../../apps/node-agent/src/channel';
import { observedProcessTree } from '../../apps/node-agent/src/control';
import type { ExecutionBinding } from '../../packages/execution/src/contracts';
function pair() {
 let left:Duplex;let right:Duplex;
 left=new Duplex({read(){},write(chunk,_encoding,done){right.push(chunk);done();},destroy(error,done){right.push(null);done(error);}});
 right=new Duplex({read(){},write(chunk,_encoding,done){left.push(chunk);done();},destroy(error,done){left.push(null);done(error);}});
 return {left,right};
}
const channel={nodeId:'node',sandboxId:'sandbox',generation:1,transportInstanceId:'transport'};
const binding:ExecutionBinding={...channel,processInstanceId:'process',runId:'run',sessionId:'session',turnId:'turn',fencingToken:1};
describe('authenticated Node frames (synthetic streams)',()=>{
 it('queries trusted guest handler and refuses wrong generation native open',async()=>{
  const {left,right}=pair();const query=vi.fn(async()=>null);const open=vi.fn();
  const close=serveNodeChannel(right,Buffer.alloc(32,7),channel,{receive:vi.fn(),query},{observeStop:vi.fn()},undefined,{open,write:vi.fn(),read:vi.fn(),close:vi.fn()});
  const client=new NodeRunnerChannel(left,Buffer.alloc(32,7),channel);
  expect(await client.query('command')).toBeNull();expect(query).toHaveBeenCalledWith('command');
  await expect(client.openNativeTransport({...binding,generation:2})).rejects.toThrow('NODE_REQUEST_REFUSED');expect(open).not.toHaveBeenCalled();client.close();close();
 });
 it('wrong authentication key never reaches backend',async()=>{
  const {left,right}=pair();const query=vi.fn(async()=>null);
  const close=serveNodeChannel(right,Buffer.alloc(32,8),channel,{receive:vi.fn(),query},{observeStop:vi.fn()});
  const client=new NodeRunnerChannel(left,Buffer.alloc(32,7),channel);
  await expect(client.query('command')).rejects.toThrow('NODE_CHANNEL_DISCONNECTED');expect(query).not.toHaveBeenCalled();client.close();close();
 });
 it('native streams preserve bounded UTF8 byte data and EOF',async()=>{
  const {left,right}=pair();let read=0;const write=vi.fn(async()=>({written:true}));
  const close=serveNodeChannel(right,Buffer.alloc(32,7),channel,{receive:vi.fn(),query:vi.fn()},{observeStop:vi.fn()},undefined,{open:async()=>({opened:true}),write,read:async()=>({sequence:++read,data:Buffer.from('你好\n').toString('base64'),ended:true}),close:async()=>null});
  const client=new NodeRunnerChannel(left,Buffer.alloc(32,7),channel);const native=await client.openNativeTransport(binding);
  await new Promise<void>((resolve,reject)=>native.output.write('request\n',error=>error?reject(error):resolve()));
  const chunks:Buffer[]=[];for await(const chunk of native.input)chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe('你好\n');expect(write).toHaveBeenCalledWith(binding,Buffer.from('request\n').toString('base64'));client.close();close();
 });
});
it('empty process tree does not manufacture successful exit',()=>{
 expect(observedProcessTree('populated 0\n')).toEqual({complete:true,writableProcesses:0,state:'isolated'});
 expect(observedProcessTree('populated 0\n',9)).toEqual({complete:true,writableProcesses:0,state:'stopped'});
 expect(observedProcessTree('populated 1\n',0)).toEqual({complete:false,writableProcesses:1,state:'running'});
});

import type { CoreApprovalPort, RuntimeDriver } from '../../packages/contracts/src/runtime-driver';
it('guest approval request returns only through bound Core authority',async()=>{
 const {left,right}=pair();const get=vi.fn(async()=>({id:'approval'}));const authorizeBinding=vi.fn();
 const core=new NodeRunnerChannel(left,Buffer.alloc(32,7),channel,{port:{get} as unknown as CoreApprovalPort,authorizeBinding});
 const guest=serveNodeChannel(right,Buffer.alloc(32,7),channel,{receive:vi.fn(),query:vi.fn()},{observeStop:vi.fn()});
 const approval={runId:'run',sessionId:'session',turnId:'turn',nodeId:'node',nodeGeneration:1};
 expect(await guest.approvalPort(binding).get({id:'approval',binding:approval} as never)).toEqual({id:'approval'});
 expect(authorizeBinding).toHaveBeenCalledWith(binding,approval);
 await expect(guest.approvalPort(binding).get({id:'approval',binding:{...approval,turnId:'other'}} as never)).rejects.toThrow('CORE_APPROVAL_REFUSED');
 expect(get).toHaveBeenCalledTimes(1);core.close();guest();
});
it('Core Driver proxy reaches only bound guest Driver',async()=>{
 const {left,right}=pair();const inspectAuth=vi.fn(async()=>({binding,status:'unauthenticated'}));
 const guest=serveNodeChannel(right,Buffer.alloc(32,7),channel,{receive:vi.fn(),query:vi.fn()},{observeStop:vi.fn()},undefined,undefined,{inspectAuth} as unknown as RuntimeDriver);
 const core=new NodeRunnerChannel(left,Buffer.alloc(32,7),channel);
 expect((await core.remoteDriver().inspectAuth({binding})).status).toBe('unauthenticated');
 await expect(core.remoteDriver().inspectAuth({binding:{...binding,generation:3}})).rejects.toThrow('NODE_REQUEST_REFUSED');
 expect(inspectAuth).toHaveBeenCalledTimes(1);core.close();guest();
});

import { assertTrustedStop } from '../../packages/execution/src/runner-client';
it('Node stop shape satisfies the Core contract only with complete containment',()=>{
 const now=Date.now();
 const observation={protocolVersion:2 as const,observationId:'observation',evidenceRef:'evidence',observedAt:now,binding,processTree:observedProcessTree('populated 0\n')};
 expect(()=>assertTrustedStop(binding,'evidence',observation,now,now)).not.toThrow();
 expect(()=>assertTrustedStop(binding,'evidence',{...observation,processTree:observedProcessTree('populated 1\n')},now,now)).toThrow('WRITABLE_PROCESS_TREE_UNCONFIRMED');
 expect(()=>assertTrustedStop(binding,'evidence',{...observation,processTree:observedProcessTree('populated 0\n',0),exitCode:0},now,now)).not.toThrow();
});
it('runtime attestation requires a current bound guest readback service',async()=>{
 const {left,right}=pair();const attestRuntime=vi.fn(async()=>({protocolVersion:2,binding,observedAt:Date.now()} as never));
 const guest=serveNodeChannel(right,Buffer.alloc(32,7),channel,{receive:vi.fn(),query:vi.fn()},{observeStop:vi.fn()},undefined,undefined,undefined,undefined,undefined,{attestRuntime});
 const core=new NodeRunnerChannel(left,Buffer.alloc(32,7),channel);
 expect((await core.attestRuntime(binding)).binding).toEqual(binding);
 await expect(core.attestRuntime({...binding,generation:2})).rejects.toThrow('NODE_REQUEST_REFUSED');expect(attestRuntime).toHaveBeenCalledTimes(1);core.close();guest();
});
it('native terminal closes only exact owned stdin and never turns unknown containment into success',async()=>{
 const {NodeController}=await import('../../apps/node-agent/src/control');const {EventEmitter}=await import('node:events');
 const controller=new NodeController({} as never);const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,stdin:{end:vi.fn(()=>queueMicrotask(()=>child.emit('close',0)))},kill:vi.fn()});
 const internal=controller as unknown as {records:Map<string,unknown>;nativeChildren:Map<string,unknown>};
 internal.records.set(binding.processInstanceId,{binding,unit:'unit',evidenceRef:'evidence',nativePolicyDigest:'policy'});internal.nativeChildren.set(binding.processInstanceId,child);
 const observe=vi.spyOn(controller,'observeStop').mockResolvedValue(null);
 expect(await controller.finishNative({...binding,runId:'other'})).toBeNull();expect(child.stdin.end).not.toHaveBeenCalled();
 expect(await controller.finishNative(binding)).toBeNull();expect(child.stdin.end).toHaveBeenCalledTimes(1);expect(child.kill).not.toHaveBeenCalled();expect(observe).toHaveBeenCalledWith(binding,'evidence');
});

it('authenticated spool drain recovers acknowledged cursor and releases pressure without conferring stop authority',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const {RunnerSpool}=await import('../../apps/runner/src/spool');
 const db=new DatabaseSync(':memory:');const spool=new RunnerSpool(db,{maxEntries:2,maxBytes:2048,reservedEntries:1});const {left,right}=pair();
 const first=spool.append({runId:'run',kind:'approval',payload:{approvalId:'approval',state:'PENDING'}});const second=spool.append({runId:'run',kind:'terminal',payload:{status:'completed',stopped:'UNKNOWN'}});
 const guest=serveNodeChannel(right,Buffer.alloc(32,7),channel,{receive:vi.fn(),query:vi.fn()},{observeStop:vi.fn()},undefined,undefined,undefined,undefined,undefined,undefined,spool);
 const core=new NodeRunnerChannel(left,Buffer.alloc(32,7),channel);
 try{const entries=await core.replaySpool();expect(entries.map(e=>e.cursor)).toEqual([first,second]);expect(entries[1].payload.stopped).toBe('UNKNOWN');await core.acknowledgeSpool(second);expect(await core.replaySpool()).toEqual([]);await expect(core.acknowledgeSpool(second+1)).rejects.toThrow('NODE_REQUEST_REFUSED');}
 finally{core.close();guest();db.close();}
});
it('candidate capture is authenticated and bound to trusted guest policy, never a renderer path',async()=>{
 const {left,right}=pair();const captureCandidate=vi.fn(async b=>({binding:b,candidateDigest:'a'.repeat(64),files:[],contents:[]}));
 const guest=serveNodeChannel(right,Buffer.alloc(32,7),channel,{receive:vi.fn(),query:vi.fn()},{observeStop:vi.fn()},undefined,undefined,undefined,undefined,undefined,{attestRuntime:vi.fn(),captureCandidate});const core=new NodeRunnerChannel(left,Buffer.alloc(32,7),channel);
 try{expect((await core.captureCandidate(binding)).binding).toEqual(binding);await expect(core.captureCandidate({...binding,generation:2})).rejects.toThrow('NODE_REQUEST_REFUSED');expect(captureCandidate).toHaveBeenCalledTimes(1);}finally{core.close();guest();}
});
