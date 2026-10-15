import {describe,it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {PodmanProvider,PODMAN_VERSION,type PodmanCLI,type PodmanTarget} from '../../packages/execution/src/providers/podman';
import {createPodmanJournal} from '../../packages/core/src/podman-journal';

import {fixture} from '../fixtures/podman';
const create={operationId:'op',botId:'bot',sandboxId:'box'};const ref={sandboxId:'box',generation:0};
const binding={nodeId:'node',sandboxId:'box',generation:1,transportInstanceId:'t',processInstanceId:'p',runId:'r',fencingToken:1,sessionId:'s',turnId:'t'};
describe('Podman candidate adapter — scripted engine, never a live container',()=>{
 it('creates once with pinned image, independent work/private volumes, restarts without data deletion',async()=>{const f=fixture(),p=f.provider();try{expect((await p.create(create)).evidenceKind).toBe('scripted');await p.create(create);expect(f.volumes.size).toBe(2);expect(f.calls.filter(a=>a.includes('create')&&a.includes('--pull=never'))).toHaveLength(1);const started=await p.start(ref);expect(started.generation).toBe(1);await p.start(ref);await p.stop({...ref,generation:1});expect(f.volumes.size).toBe(2);expect((await p.start({...ref,generation:1})).generation).toBe(2);await p.stop({...ref,generation:2});await p.destroy({...ref,generation:2});expect(f.volumes.size).toBe(2);expect(f.calls.flat().join(' ')).not.toMatch(/prune|reset|--privileged|--replace|--rm|connection default|machine stop/);}finally{f.db.close();}});
 it.each(['shares','version','connection','rootful','image'] as const)('blocks %s before owned mutations',async kind=>{const f=fixture();try{if(kind==='shares')f.setShares([{Source:'/Users/test',Target:'/Users/test'}]);if(kind==='version')f.setVersion('6.1.3');if(kind==='connection')f.setConnection('other');if(kind==='rootful')f.setRootless(false);if(kind==='image')f.setImage(false);await expect(f.provider().create(create)).rejects.toThrow();expect(f.volumes.size).toBe(0);expect(f.container).toBeUndefined();}finally{f.db.close();}});
 it('reconciles lost create/start response by owned inspect without replay',async()=>{const f=fixture();try{f.lose('create');await expect(f.provider().create(create)).rejects.toThrow('PODMAN_DELIVERY_UNKNOWN');expect((await f.provider().inspect(ref)).state).toBe('created');f.lose('start');await expect(f.provider().start(ref)).rejects.toThrow('PODMAN_DELIVERY_UNKNOWN');expect((await f.provider().inspect({...ref,generation:1})).state).toBe('running');expect(f.calls.filter(a=>a.includes('start'))).toHaveLength(1);}finally{f.db.close();}});
 it('refuses foreign labels, bind mounts, stale generations and revoked authority',async()=>{const f=fixture();try{const p=f.provider();await p.create(create);await p.start(ref);await expect(p.stop(ref)).rejects.toThrow('STALE_SANDBOX');f.container.Mounts.push({Type:'bind',Source:'/host',Destination:'/host'});await expect(p.stop({...ref,generation:1})).rejects.toThrow('PODMAN_CONTAINER_DRIFT');f.container.Mounts.pop();f.container.Config.Labels['io.agent-nexus.bot']='other';await expect(p.stop({...ref,generation:1})).rejects.toThrow('PODMAN_CONTAINER_DRIFT');f.setDenied();await expect(p.inspect({...ref,generation:1})).rejects.toThrow('REVOKED');expect(f.calls.filter(a=>a.includes('stop'))).toHaveLength(0);}finally{f.db.close();}});
 it('blocks unknown state, mutable image tags and unpinned engines',async()=>{const f=fixture();try{expect(()=>new PodmanProvider({...f.target,image:{...f.target.image,reference:'example.org/an/runner:latest'}},{} as any,f.journal,()=>{})).toThrow('PODMAN_TARGET_INVALID');expect(()=>new PodmanProvider({...f.target,engine:{...f.target.engine,uri:'tcp://localhost:1234'}},{} as any,f.journal,()=>{})).toThrow('PODMAN_TARGET_INVALID');await f.provider().create(create);f.container.State.Status='unknown';await expect(f.provider().start(ref)).rejects.toThrow();}finally{f.db.close();}});
});

it('holds the durable sole writer until exact owned-container isolation, including lost stop reply',async()=>{
 const f=fixture();try{const p=f.provider();await p.create(create);await p.start(ref);const key=p.claimWriter(binding);
 expect(()=>f.provider().claimWriter({...binding,runId:'second'})).toThrow('PODMAN_WRITER_BUSY');
 await expect(p.stop({...ref,generation:1})).rejects.toThrow('PODMAN_RECONCILIATION_REQUIRED');
 await expect(p.isolateWriter({...binding,processInstanceId:'other'},key)).rejects.toThrow('PODMAN_WRITER_MISMATCH');
 f.lose('stop');await expect(p.isolateWriter(binding,key)).rejects.toThrow('PODMAN_DELIVERY_UNKNOWN');
 expect(f.journal.read()?.writer?.binding).toEqual(binding);await p.inspect({...ref,generation:1});
 expect(()=>f.provider().claimWriter({...binding,runId:'second'})).toThrow('PODMAN_WRITER_BUSY');
 const proof=await p.isolateWriter(binding,key);expect(proof.processTree.state).toBe('isolated');expect(proof.exitCode).toBeUndefined();expect(f.journal.read()?.writer).toBeUndefined();expect(f.volumes.size).toBe(2);
 }finally{f.db.close();}
});
it('parent exit/container non-running with an unresolved process never frees the writer',async()=>{
 const f=fixture();try{const p=f.provider();await p.create(create);await p.start(ref);const key=p.claimWriter(binding);
 f.container.State={Status:'exited',Running:false,Pid:123,FinishedAt:new Date().toISOString()};
 await expect(p.isolateWriter(binding,key)).rejects.toThrow('PODMAN_STOP_UNKNOWN');expect(f.journal.read()?.writer).toBeDefined();expect(()=>f.provider().claimWriter({...binding,runId:'new'})).toThrow();
 }finally{f.db.close();}
});
it('rejects async authority and keeps journal independent of ordinary provision record saves',async()=>{
 const f=fixture();try{await expect(new PodmanProvider(f.target,f.cli,f.journal,async()=>{}).create(create)).rejects.toThrow('INVALID_AUTHORITY_CHECK');await f.provider().create(create);const before=f.journal.read();f.db.prepare('UPDATE bot_provision SET record=? WHERE operation_id=?').run('{}','op');expect(f.journal.read()).toEqual(before);expect(()=>f.journal.compareAndSet(undefined,before!)).toThrow('PODMAN_JOURNAL_CONFLICT');}finally{f.db.close();}
});
it('never reissues an unknown create with no observed container',async()=>{
 const f=fixture();try{const original=f.cli.run;let attempts=0;f.cli.run=async args=>{if(args.includes('--pull=never')){attempts++;throw Error('DISCONNECTED_BEFORE_RESPONSE');}return original(args);};const p=f.provider();await expect(p.create(create)).rejects.toThrow('PODMAN_DELIVERY_UNKNOWN');expect((await f.provider().inspect(ref)).state).toBe('unknown');await expect(f.provider().create(create)).rejects.toThrow('PODMAN_RECONCILIATION_REQUIRED');expect(attempts).toBe(1);}finally{f.db.close();}
});
it('allows one exec open only and requires exec-client closure before releasing a writer',async()=>{
 const f=fixture();const {Duplex}=await import('node:stream');const stream=new Duplex({read(){},write(_c,_e,done){done();}});let opens=0;
 f.cli.open=async()=>{opens++;return stream;};try{const p=f.provider();await p.create(create);await p.start(ref);const key=p.claimWriter(binding);await p.openAccountless(binding,Buffer.alloc(32),key);stream.destroy();await expect(p.openAccountless(binding,Buffer.alloc(32),key)).rejects.toThrow('PODMAN_ACCOUNTLESS_REQUIRED');expect(opens).toBe(1);await expect(p.isolateWriter(binding,key)).rejects.toThrow('PODMAN_EXEC_DELIVERY_UNKNOWN');expect(f.journal.read()?.writer).toBeDefined();f.cli.closeExec=async()=>{};await p.isolateWriter(binding,key);expect(f.journal.read()?.writer).toBeUndefined();}finally{stream.destroy();f.db.close();}
});
