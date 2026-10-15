import {it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {Duplex} from 'node:stream';
import {servePodmanAccountless} from '../../apps/node-agent/src/podman-accountless';
import {NodeRunnerChannel} from '../../apps/node-agent/src/channel';
import {binding,peer} from '../fixtures/codex-driver/harness';
function pair(){let a:Duplex,b:Duplex;a=new Duplex({read(){},write(c,_e,done){b.push(c);done();}});b=new Duplex({read(){},write(c,_e,done){a.push(c);done();}});return [a,b] as const;}
it('uses existing registry/Codex initialize only; no login, turn, commands or old OS policy attestation',async()=>{
 const [a,b]=pair(),key=Buffer.alloc(32,5),db=new DatabaseSync(':memory:'),protocol=peer();let allowed=true,opened=0;
 const endpoint=servePodmanAccountless({stream:b,key,binding,db,assertCurrent(){if(!allowed)throw Error('REVOKED');},openNative:async v=>{opened++;return {...protocol,binding:v};}});
 const channel=new NodeRunnerChannel(a,key,{nodeId:binding.nodeId,sandboxId:binding.sandboxId,generation:binding.generation,transportInstanceId:binding.transportInstanceId});
 try{
  await channel.initializeEnvironment(binding);await channel.initializeEnvironment(binding);expect(opened).toBe(1);
  expect(protocol.frames.map(v=>v.method)).toEqual(['initialize','initialized']);
  await expect(channel.initializeEnvironment({...binding,fencingToken:2})).rejects.toThrow('NODE_REQUEST_REFUSED');
  await expect(channel.remoteDriver().initialize({binding,runtimeVersion:'0.159.2'})).rejects.toThrow('NODE_REQUEST_REFUSED');
  expect(await channel.finishNative(binding)).toBeNull();expect(await channel.stopNative(binding)).toBeNull();
  await expect(channel.attestRuntime(binding)).rejects.toThrow('NODE_REQUEST_REFUSED');
  allowed=false;await expect(channel.initializeEnvironment(binding)).rejects.toThrow('NODE_REQUEST_REFUSED');
  expect(protocol.frames.some(v=>/thread|turn|account/.test(v.method??''))).toBe(false);
 }finally{channel.close();endpoint();protocol.close();a.destroy();b.destroy();db.close();}
});

import {fixture} from '../fixtures/podman';
import {createPodmanEnvironmentAdapter} from '../../packages/core/src/podman-environment';
it('Core adapter traverses scripted Podman exec and actual channel/Driver, isolates and retains both volumes',async()=>{
 const f=fixture(),protocol=peer(),guestDB=new DatabaseSync(':memory:');let endpoint:undefined|(()=>void),args:readonly string[]=[];
 f.cli.closeExec=async()=>{};
 f.cli.open=async command=>{args=command;const [host,guest]=pair();const bootstrap=(chunk:Buffer)=>{const raw=JSON.parse(chunk.toString());guest.off('data',bootstrap);endpoint=servePodmanAccountless({stream:guest,key:Buffer.from(raw.key,'hex'),binding:raw.binding,db:guestDB,assertCurrent(){},openNative:async b=>({...protocol,binding:b})});};guest.on('data',bootstrap);host.once('close',()=>{endpoint?.();guest.destroy();});return host;};
 const adapter=createPodmanEnvironmentAdapter({db:f.db,target:f.target,cli:f.cli,assertCurrent(){},assertAuthorized(){}});
 try{
  await adapter.provider.create({operationId:'op',botId:'bot',sandboxId:'box'});await adapter.provider.start({sandboxId:'box',generation:0});
  const result=await adapter.initialize({...binding,nodeId:'node',sandboxId:'box'});
  expect(result).toMatchObject({evidenceKind:'scripted',initialized:true,readiness:{auth:false},liveReady:false});
  expect(args.slice(-5)).toEqual(['--interactive',f.container.Id,'/usr/local/bin/node','/opt/an/podman-entry.cjs','accountless']);expect(args.join(' ')).not.toMatch(/--env|token=|password=|--tty/);
  expect(f.journal.read()?.writer).toBeUndefined();expect(f.container.State.Status).toBe('exited');expect(f.volumes.size).toBe(2);expect(protocol.frames.map(v=>v.method)).toEqual(['initialize','initialized']);
 }finally{endpoint?.();protocol.close();guestDB.close();f.db.close();}
});
