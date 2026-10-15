import {createHash,randomUUID} from 'node:crypto';
import type {Duplex} from 'node:stream';
import type {SandboxProvider,SandboxRef,SandboxObservation,SandboxChannel,EvidenceKind} from '../../../contracts/src/sandbox.js';
import type {ExecutionBinding,TrustedStopObservation} from '../contracts.js';
import {assertExecutionBinding,assertTrustedStop} from '../runner-client.js';
import {canonicalJson} from '../../../persistence/src/unit-of-work.js';

/** Candidate pin; synthetic tests are not target-Mac qualification. */
export const PODMAN_VERSION='6.1.4';
export const PODMAN_SOURCE='464c15fec06f0074c916f9eff87c4806869c2833';
export interface PodmanTarget {
 installationId:string;botId:string;sandboxId:string;operationId:string;nodeId:string;
 engine:{connection:string;uri:string;identity:string;machine:string;machineConfigPath:string};
 image:{reference:string;version:string;sourceRevision:string;architecture:'arm64';codexVersion:'0.159.2';protocolVersion:2};
 limits:{memory:number;cpus:number;pids:number};
}
export interface PodmanCLI {
 readonly evidenceKind:EvidenceKind;
 run(args:readonly string[]):Promise<{code:number;stdout:string}>;
 machineConfig(path:string):Promise<unknown>;
 /** Trusted fixed entrypoint only; ephemeral bootstrap travels over stdin, never argv/env/disk. */
 open?(args:readonly string[]):Promise<Duplex>;
 /** Resolve only once the local exec client cannot submit more engine requests. */
 closeExec?(stream:Duplex):Promise<void>;
}
export interface PodmanState {
 contract:string;generation:number;containerId?:string;retired?:boolean;
 pending?:{id:string;action:'create'|'start'|'stop'|'destroy';from:number;to:number};
 lastStartFrom?:number;writer?:{binding:ExecutionBinding;token:string;opened?:true};
}
/** Persist on the existing Core DB. CAS must reject a competing Core/owner. */
export interface PodmanJournal {read():PodmanState|undefined;compareAndSet(expected:PodmanState|undefined,next:PodmanState):void;}
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const token=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v);
const record=(v:unknown):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('PODMAN_RESPONSE_INVALID');return v as Record<string,any>;};
const one=(v:unknown)=>{if(!Array.isArray(v)||v.length!==1)throw Error('PODMAN_RESPONSE_INVALID');return record(v[0]);};
export function validatePodmanTarget(t:PodmanTarget):void {
 try{
  const e=t.engine,i=t.image,l=t.limits,u=new URL(e.uri);
  if(![t.installationId,t.botId,t.sandboxId,t.operationId,t.nodeId,e.connection,e.machine].every(token)||!/^[-a-zA-Z0-9_.]+$/.test(e.machine)||!e.identity.startsWith('/')||!e.machineConfigPath.startsWith('/')||u.protocol!=='ssh:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!u.username||u.username==='root'||u.password||!u.port||u.search||u.hash||!/^\/run\/user\/\d+\/podman\/podman\.sock$/.test(u.pathname)||!/^[-a-z0-9.]+(?::\d+)?\/[a-z0-9/_.-]+@sha256:[a-f0-9]{64}$/.test(i.reference)||!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(i.version)||!/^([a-f0-9]{40})$/.test(i.sourceRevision)||i.architecture!=='arm64'||i.codexVersion!=='0.159.2'||i.protocolVersion!==2||!Number.isSafeInteger(l.memory)||l.memory<64*1024*1024||!Number.isSafeInteger(l.cpus)||l.cpus<1||l.cpus>16||!Number.isSafeInteger(l.pids)||l.pids<16||l.pids>4096)throw 0;
 }catch{throw Error('PODMAN_TARGET_INVALID');}
}
/** Narrow accountless provider. No install/pull/machine lifecycle/global default/volume removal operations. */
export class PodmanProvider implements SandboxProvider {
 readonly target:Readonly<PodmanTarget>;readonly names:{container:string;work:string;private:string};
 private readonly executions=new Map<string,Duplex>();
 private readonly contract:string;private queue:Promise<unknown>=Promise.resolve();
 constructor(target:PodmanTarget,private readonly cli:PodmanCLI,private readonly journal:PodmanJournal,private readonly authority:(action:string)=>void){
  validatePodmanTarget(target);this.target=structuredClone(target);Object.freeze(this.target.engine);Object.freeze(this.target.image);Object.freeze(this.target.limits);Object.freeze(this.target);this.contract=digest(target);
  const id=digest([target.installationId,target.botId,target.sandboxId]).slice(0,40);this.names=Object.freeze({container:`an-${id}`,work:`an-${id}-work`,private:`an-${id}-private`});
 }
 private assertAuthorized(action:string){const result:unknown=this.authority(action);if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});throw Error('INVALID_AUTHORITY_CHECK');}}
 private serial<T>(work:()=>Promise<T>):Promise<T>{const result=this.queue.then(work);this.queue=result.catch(()=>{});return result;}
 private state(){const state=this.journal.read();if(state&&state.contract!==this.contract)throw Error('PODMAN_CONTRACT_CHANGED');return state;}
 private ref(ref:SandboxRef,state:PodmanState|undefined){if(ref.sandboxId!==this.target.sandboxId||!Number.isSafeInteger(ref.generation)||ref.generation<0||ref.generation!==(state?.generation??0))throw Error('STALE_SANDBOX');}
 private async run(args:readonly string[],remote=true){this.assertAuthorized(args[0]);const e=this.target.engine;const result=await this.cli.run(remote?['--remote','--url',e.uri,'--identity',e.identity,...args]:args);this.assertAuthorized(args[0]);if(!result||!Number.isInteger(result.code)||typeof result.stdout!=='string'||Buffer.byteLength(result.stdout)>1024*1024)throw Error('PODMAN_RESPONSE_INVALID');return result;}
 private async json(args:readonly string[],remote=true){const r=await this.run(args,remote);if(r.code!==0)throw Error('PODMAN_QUERY_FAILED');try{return JSON.parse(r.stdout);}catch{throw Error('PODMAN_RESPONSE_INVALID');}}
 private async check(){
  const e=this.target.engine,u=new URL(e.uri);const connections=await this.json(['system','connection','list','--format','json'],false);
  if(!Array.isArray(connections)||connections.filter(v=>v.Name===e.connection&&v.URI===e.uri&&v.Identity===e.identity&&v.IsMachine===true).length!==1)throw Error('PODMAN_CONNECTION_CHANGED');
  const m=one(await this.json(['machine','inspect',e.machine],false));
  if(m.Name!==e.machine||m.State!=='running'||m.Rootful!==false||m.SSHConfig?.IdentityPath!==e.identity||String(m.SSHConfig?.Port)!==u.port||m.SSHConfig?.RemoteUsername!==u.username||`${m.ConfigDir?.Path}/${e.machine}.json`!==e.machineConfigPath)throw Error('PODMAN_MACHINE_MISMATCH');
  // machine inspect has no Mounts field in this version. Read the named protected config, not a fabricated inspect property.
  const config=record(await this.cli.machineConfig(e.machineConfigPath));this.assertAuthorized('inspect');
  if(config.Name!==e.machine||config.Version!==1||config.SSH?.IdentityPath!==e.identity||String(config.SSH?.Port)!==u.port||config.SSH?.RemoteUsername!==u.username||!(config.Mounts===null||Array.isArray(config.Mounts)&&config.Mounts.length===0))throw Error('PODMAN_MACHINE_SHARES_BLOCKED');
  const v=record(await this.json(['version','--format','json']));if(v.Client?.Version!==PODMAN_VERSION||v.Server?.Version!==PODMAN_VERSION)throw Error('PODMAN_VERSION_MISMATCH');
  const info=record(await this.json(['info','--format','json']));if(info.host?.security?.rootless!==true)throw Error('PODMAN_ROOTLESS_REQUIRED');if(info.host?.cgroupVersion!=='v2'||!Array.isArray(info.host?.cgroupControllers)||!['cpu','memory','pids'].every(c=>info.host.cgroupControllers.includes(c)))throw Error('PODMAN_RESOURCE_CONTROLLERS_REQUIRED');
 }
 private labels(kind:string){const t=this.target;return {'io.agent-nexus.installation':t.installationId,'io.agent-nexus.bot':t.botId,'io.agent-nexus.sandbox':t.sandboxId,'io.agent-nexus.operation':t.operationId,'io.agent-nexus.kind':kind,...(kind==='container'?{'io.agent-nexus.contract':this.contract}:{})};}
 private labelsMatch(actual:unknown,kind:string){const a=record(actual);return Object.entries(this.labels(kind)).every(([k,v])=>a[k]===v);}
 private labelArgs(kind:string){return Object.entries(this.labels(kind)).flatMap(([k,v])=>['--label',`${k}=${v}`]);}
 private async image(){const i=this.target.image,x=one(await this.json(['image','inspect',i.reference]));if(x.Digest!==i.reference.split('@')[1]||!Array.isArray(x.RepoDigests)||!x.RepoDigests.includes(i.reference)||x.Architecture!==i.architecture||x.Os!=='linux'||x.Labels?.['org.opencontainers.image.version']!==i.version||x.Labels?.['org.opencontainers.image.revision']!==i.sourceRevision||x.Labels?.['io.agent-nexus.protocol']!=='2'||x.Labels?.['io.agent-nexus.codex']!==i.codexVersion||!/^sha256:[a-f0-9]{64}$/.test(x.Id))throw Error('PODMAN_IMAGE_MISMATCH');return x;}
 private async exists(kind:'container'|'volume',name:string){const r=await this.run([kind,'exists',name]);if(r.code===0)return true;if(r.code===1)return false;throw Error('PODMAN_QUERY_FAILED');}
 private async volume(kind:'work'|'private'){
  const name=this.names[kind];if(!await this.exists('volume',name))return false;
  const v=one(await this.json(['volume','inspect',name]));if(v.Name!==name||v.Driver!=='local'||!this.labelsMatch(v.Labels,kind)||v.Options&&Object.keys(v.Options).length)throw Error('PODMAN_VOLUME_DRIFT');return true;
 }
 private async container(state:PodmanState|undefined){
  if(!await this.exists('container',this.names.container))return undefined;
  const c=one(await this.json(['container','inspect',this.names.container])),h=c.HostConfig,m=c.Mounts;
  const labels=c.Config?.Labels;
  if(!/^[a-f0-9]{64}$/.test(c.Id)||state?.containerId&&c.Id!==state.containerId||c.Name!==this.names.container||!labels||!this.labelsMatch(labels,'container')||c.ImageDigest!==this.target.image.reference.split('@')[1]||c.Config?.User!=='1000:1000'||canonicalJson(c.Config?.Entrypoint)!==canonicalJson(['/usr/local/bin/node','/opt/an/podman-entry.cjs'])||canonicalJson(c.Config?.Cmd)!==canonicalJson(['idle'])||!h||h.Privileged!==false||h.ReadonlyRootfs!==true||h.NetworkMode!=='none'||h.CapAdd?.length||!h.CapDrop?.includes('ALL')||!(h.SecurityOpt?.length===1&&h.SecurityOpt[0]==='no-new-privileges')||h.PidMode!=='private'||h.IpcMode!=='private'||h.UTSMode!=='private'||!Array.isArray(c.Config.Env)||c.Config.Env.some((v:unknown)=>typeof v!=='string'||!['HOME=/an/private/home','CODEX_HOME=/an/private/home/.codex','PATH=/usr/local/bin:/usr/bin:/bin','NODE_VERSION=24.19.0','YARN_VERSION=1.22.22'].includes(v))||!c.Config.Env.includes('HOME=/an/private/home')||!c.Config.Env.includes('CODEX_HOME=/an/private/home/.codex')||h.Binds?.length||h.Devices?.length||h.PortBindings&&Object.keys(h.PortBindings).length||h.Memory!==this.target.limits.memory||h.CpuPeriod!==100000||h.CpuQuota!==100000*this.target.limits.cpus||h.PidsLimit!==this.target.limits.pids||!Array.isArray(m)||m.length!==2||!(['work','private'] as const).every(k=>m.filter(v=>v.Type==='volume'&&v.Name===this.names[k]&&v.Destination===(k==='work'?'/an/work':'/an/private')&&v.RW===true).length===1))throw Error('PODMAN_CONTAINER_DRIFT');
  if(!await this.volume('work')||!await this.volume('private'))throw Error('PODMAN_VOLUME_DRIFT');
  return c;
 }
 private observation(state:PodmanState|undefined,c:Record<string,any>|undefined):SandboxObservation {
  let status:SandboxObservation['state'];if(state?.retired)status=c?'unknown':'destroyed';else if(state?.pending)status='unknown';else if(!c)status=state?.containerId?'unknown':'absent';else if(c.State?.Status==='created'&&state?.generation===0)status='created';else if(c.State?.Running===true&&c.State.Status==='running'&&state?.generation!>0)status='running';else if(c.State?.Running===false&&['exited','stopped'].includes(c.State.Status))status='stopped';else status='unknown';
  return {protocolVersion:1,sandboxId:this.target.sandboxId,generation:state?.generation??0,state:status,evidenceKind:this.cli.evidenceKind,observedAt:Date.now()};
 }
 private async reconcile(state:PodmanState|undefined,c:Record<string,any>|undefined){
  const p=state?.pending;if(!state||!p)return state;
  const done=p.action==='create'?c?.State?.Status==='created':p.action==='start'?c?.State?.Running===true&&!!c.State.StartedAt:p.action==='stop'?c?.State?.Running===false&&['exited','stopped'].includes(c.State.Status):!c;
  if(!done)return state;
  const next={...state,generation:p.to,containerId:c?.Id??state.containerId,...(p.action==='destroy'?{retired:true}:{}),...(p.action==='start'?{lastStartFrom:p.from}:{})};delete next.pending;this.journal.compareAndSet(state,next);return next;
 }
 private intent(state:PodmanState|undefined,action:NonNullable<PodmanState['pending']>['action'],to=state?.generation??0){if(state?.pending||state?.retired)throw Error('PODMAN_RECONCILIATION_REQUIRED');const next:PodmanState={...state,contract:this.contract,generation:state?.generation??0,pending:{id:randomUUID(),action,from:state?.generation??0,to}};this.journal.compareAndSet(state,next);return next;}
 private async effect(state:PodmanState,args:readonly string[]){if(canonicalJson(this.state())!==canonicalJson(state))throw Error('PODMAN_RECONCILIATION_REQUIRED');try{const r=await this.run(args);if(r.code!==0)throw Error('PODMAN_MUTATION_FAILED');}catch{throw Error('PODMAN_DELIVERY_UNKNOWN');}}
 create(input:{operationId:string;botId:string;sandboxId:string}):Promise<SandboxObservation>{return this.serial(async()=>{
  if(input.operationId!==this.target.operationId||input.botId!==this.target.botId||input.sandboxId!==this.target.sandboxId)throw Error('PODMAN_IDENTITY_MISMATCH');await this.check();let state=this.state();let c=await this.container(state);state=await this.reconcile(state,c);if(state?.pending||state?.retired)throw Error('PODMAN_RECONCILIATION_REQUIRED');if(c){if(!state)throw Error('PODMAN_RECONCILIATION_REQUIRED');return this.observation(state,c);}if(state?.containerId)throw Error('PODMAN_RECONCILIATION_REQUIRED');
  await this.image();state=this.intent(state,'create');for(const kind of ['work','private'] as const){if(!await this.volume(kind))await this.effect(state,['volume','create','--driver','local','--uid','1000','--gid','1000',...this.labelArgs(kind),this.names[kind]]);}
  const t=this.target;await this.effect(state,['create','--name',this.names.container,...this.labelArgs('container'),'--pull=never','--network=none','--pid=private','--ipc=private','--uts=private','--user','1000:1000','--read-only','--read-only-tmpfs=false','--cap-drop=ALL','--security-opt','no-new-privileges','--http-proxy=false','--image-volume=ignore','--log-driver=none','--memory',String(t.limits.memory),'--cpu-period','100000','--cpu-quota',String(t.limits.cpus*100000),'--pids-limit',String(t.limits.pids),'--env','PATH=/usr/local/bin:/usr/bin:/bin','--env','HOME=/an/private/home','--env','CODEX_HOME=/an/private/home/.codex','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777','--mount',`type=volume,src=${this.names.work},dst=/an/work`,'--mount',`type=volume,src=${this.names.private},dst=/an/private`,'--workdir','/an/work','--entrypoint','["/usr/local/bin/node","/opt/an/podman-entry.cjs"]',t.image.reference,'idle']);
  c=await this.container(state);state=await this.reconcile(state,c);if(state?.pending)throw Error('PODMAN_RECONCILIATION_REQUIRED');return this.observation(state,c);
 });}
 inspect(ref:SandboxRef):Promise<SandboxObservation>{return this.serial(async()=>{await this.check();let s=this.state();const c=await this.container(s);s=await this.reconcile(s,c);this.ref(ref,s);return this.observation(s,c);});}
 start(ref:SandboxRef):Promise<SandboxObservation>{return this.serial(async()=>{await this.check();let s=this.state();const c=await this.container(s);s=await this.reconcile(s,c);if(s&&ref.sandboxId===this.target.sandboxId&&s.lastStartFrom===ref.generation&&s.generation===ref.generation+1&&this.observation(s,c).state==='running')return this.observation(s,c);this.ref(ref,s);if(!s||s.writer||s.pending||!c||!['created','stopped'].includes(this.observation(s,c).state))throw Error('PODMAN_RECONCILIATION_REQUIRED');s=this.intent(s,'start',s.generation+1);await this.effect(s,['start',c.Id]);const actual=await this.container(s);s=await this.reconcile(s,actual);return this.observation(s,actual);});}
 stop(ref:SandboxRef):Promise<SandboxObservation>{return this.serial(async()=>{await this.check();let s=this.state();const c=await this.container(s);s=await this.reconcile(s,c);this.ref(ref,s);if(!s||s.writer||s.pending||!c)throw Error('PODMAN_RECONCILIATION_REQUIRED');if(this.observation(s,c).state==='stopped')return this.observation(s,c);s=this.intent(s,'stop');await this.effect(s,['stop','--time','10',c.Id]);const actual=await this.container(s);s=await this.reconcile(s,actual);return this.observation(s,actual);});}
 destroy(ref:SandboxRef):Promise<SandboxObservation>{return this.serial(async()=>{await this.check();let s=this.state();const c=await this.container(s);s=await this.reconcile(s,c);this.ref(ref,s);if(s?.retired)return this.observation(s,c);if(!s||s.writer||s.pending||!c||!['created','stopped'].includes(this.observation(s,c).state))throw Error('PODMAN_RECONCILIATION_REQUIRED');s=this.intent(s,'destroy');await this.effect(s,['rm',c.Id]);const actual=await this.container(s);s=await this.reconcile(s,actual);return this.observation(s,actual);});}
 connect(ref:SandboxRef):Promise<SandboxChannel>{return this.serial(async()=>{await this.check();const s=this.state(),c=await this.container(s);this.ref(ref,s);if(this.observation(s,c).state!=='running')throw Error('PODMAN_RECONCILIATION_REQUIRED');return {protocolVersion:1,...ref,nodeId:this.target.nodeId,channelRef:`podman:${c!.Id}:${ref.generation}`,evidenceKind:this.cli.evidenceKind};});}
 /** One durable writer even across competing provider objects/restarts. No release on EOF or container status. */
 claimWriter(binding:ExecutionBinding):string {assertExecutionBinding(binding);this.assertAuthorized('connect');const s=this.state();this.ref(binding,s);if(!s||s.pending||s.retired||s.writer||binding.nodeId!==this.target.nodeId)throw Error('PODMAN_WRITER_BUSY');const key=randomUUID();this.journal.compareAndSet(s,{...s,writer:{binding:structuredClone(binding),token:key}});return key;}
 private releaseWriter(binding:ExecutionBinding,key:string,proof:TrustedStopObservation,requestedAt:number){assertTrustedStop(binding,proof.evidenceRef,proof,requestedAt);this.assertAuthorized('stop');const s=this.state();if(!s?.writer||s.writer.token!==key||digest(s.writer.binding)!==digest(binding))throw Error('PODMAN_WRITER_MISMATCH');const next={...s};delete next.writer;this.journal.compareAndSet(s,next);}
 /** Safe fallback: stop only the exact Bot container carrying this sole writer. Never stop the shared Machine.
  * This is isolation evidence, not a native exit-code/task-success claim. Missing PID/exec readback keeps the writer. */
 isolateWriter(binding:ExecutionBinding,key:string):Promise<TrustedStopObservation>{return this.serial(async()=>{
  await this.check();let s=this.state();this.ref(binding,s);if(!s?.writer||s.writer.token!==key||digest(s.writer.binding)!==digest(binding)||s.pending)throw Error('PODMAN_WRITER_MISMATCH');
  if(s.writer.opened){const stream=this.executions.get(key);if(!stream||!this.cli.closeExec)throw Error('PODMAN_EXEC_DELIVERY_UNKNOWN');stream.destroy();await this.cli.closeExec(stream);this.assertAuthorized('stop');const now=this.state();if(!now?.writer||now.writer.token!==key||digest(now.writer.binding)!==digest(binding))throw Error('PODMAN_WRITER_MISMATCH');s=now;}
  const c=await this.container(s);if(!c)throw Error('PODMAN_RECONCILIATION_REQUIRED');const requestedAt=Date.now();
  // Journal stop intent before delivery; loss never releases the writer. inspect can reconcile intent, not the writer.
  if(c.State.Running===true){s=this.intent(s,'stop');await this.effect(s,['stop','--time','10',c.Id]);}
  const actual=await this.container(s);s=await this.reconcile(s,actual);
  if(s?.pending||!actual||actual.State?.Running!==false||actual.State?.Status!=='exited'||actual.State?.Pid!==0||!(actual.ExecIDs===null||Array.isArray(actual.ExecIDs)&&actual.ExecIDs.length===0)||!Number.isFinite(Date.parse(actual.State.FinishedAt)))throw Error('PODMAN_STOP_UNKNOWN');
  const proof:TrustedStopObservation={protocolVersion:2,binding:structuredClone(binding),evidenceRef:`podman-isolation:${actual.Id}:${binding.generation}`,observationId:randomUUID(),observedAt:Date.now(),processTree:{complete:true,writableProcesses:0,state:'isolated'},};
  this.releaseWriter(binding,key,proof,requestedAt);this.executions.delete(key);return proof;
 });}
 async openAccountless(binding:ExecutionBinding,key:Buffer,writerToken:string):Promise<Duplex>{const channel=await this.connect(binding);this.assertAuthorized('initialize-runtime');const s=this.state();if(!s?.writer||s.writer.token!==writerToken||s.writer.opened||digest(s.writer.binding)!==digest(binding)||key.length!==32||!this.cli.open)throw Error('PODMAN_ACCOUNTLESS_REQUIRED');this.journal.compareAndSet(s,{...s,writer:{...s.writer,opened:true}});const stream=await this.cli.open(['--remote','--url',this.target.engine.uri,'--identity',this.target.engine.identity,'exec','--interactive',channel.channelRef.split(':')[1],'/usr/local/bin/node','/opt/an/podman-entry.cjs','accountless']);this.executions.set(writerToken,stream);try{this.assertAuthorized('initialize-runtime');const current=this.state();if(!current?.writer||current.writer.token!==writerToken||digest(current.writer.binding)!==digest(binding))throw Error('PODMAN_WRITER_MISMATCH');stream.write(JSON.stringify({protocolVersion:2,purpose:'accountless',binding,key:key.toString('hex')})+'\n');return stream;}catch(error){stream.destroy();throw error;}}
}
