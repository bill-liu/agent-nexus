import {CandidateStore,type SnapshotTransfer} from '../../verification-worker/src/candidate';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, statfsSync, lstatSync, readlinkSync, createReadStream, readdirSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isIP } from 'node:net';
import type { ExecutionBinding, TrustedNodeVerifier, TrustedStopObservation } from '../../../packages/execution/src/contracts';
import { canonicalManifest } from '../../../packages/catalog-client/src/manifest';
import { privatePath, NodeProcessJournal } from './storage';
import { resourceProperties, type ResourceLimits } from './limits';
const exec=promisify(execFile);
export const NATIVE_GUEST_ENVIRONMENT=Object.freeze({PATH:'/opt/an/runtime/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',HOME:'/bot/home',CODEX_HOME:'/bot/home/.codex',XDG_CONFIG_HOME:'/bot/home/.config',XDG_CACHE_HOME:'/bot/home/.cache',XDG_DATA_HOME:'/bot/home/.local/share'});
export interface SandboxPolicy {
 network:'none'|'gateway';gatewayAddresses?:readonly string[];discussion:boolean;rootfs:string;home:string;project:string;cache:string;limits:ResourceLimits;
}
/** Returns an argument vector only. Enforcement is claimed only by a successful trusted execution/observation. */
export function buildSandboxCommand(policy:SandboxPolicy):string[] {
 if(policy.network!=='none'&&policy.network!=='gateway')throw new Error('NETWORK_POLICY_UNSUPPORTED');
 if(policy.network==='gateway'&&(!policy.gatewayAddresses?.length||policy.gatewayAddresses.length>8||policy.gatewayAddresses.some(address=>!isIP(address))))throw new Error('NETWORK_POLICY_UNSUPPORTED');
 resourceProperties(policy.limits);
 for(const path of [policy.rootfs,policy.home,policy.project,policy.cache]) if(!path?.startsWith('/')||path.includes('\0')) throw new Error('NODE_PATH_DENIED');
 return ['--unshare-all',...(policy.network==='gateway'?['--share-net']:[]),'--die-with-parent','--new-session','--cap-drop','ALL','--clearenv',
  '--ro-bind',policy.rootfs,'/','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/run',
  '--bind',policy.home,'/bot/home',policy.discussion?'--ro-bind':'--bind',policy.project,'/workspace',
  '--bind',policy.cache,'/bot/home/.cache',...Object.entries(NATIVE_GUEST_ENVIRONMENT).flatMap(([key,value])=>['--setenv',key,value]),'--chdir','/workspace'];
}
export interface NodeAuthority {
 nodeId:string;sandboxId:string;generation:number;privateRoot:string;rootfsRoot:string;stateDirectory?:string;
 /** Loaded from protected configuration by trusted composition, not a request-supplied boolean. */
 gatewayAddresses?:readonly string[];verifierProbeDigest?:string;nativeRuntime?:{version:'0.159.2';sha256:string};
 authorization: {targetId:string;expiresAt:number;actions:readonly ('sandbox-exec'|'accountless-probe'|'verify-candidate')[]};
}
function bindingKey(binding:ExecutionBinding):string {return createHash('sha256').update(canonicalManifest(binding)).digest('hex');}
interface ProcessRecord {binding:ExecutionBinding;unit:string;evidenceRef:string;cgroup?:string;waitedExitCode?:number;nativePolicyDigest?:string}
export interface NativePolicyAttestation {
 protocolVersion:2;binding:ExecutionBinding;observedAt:number;evidenceRef:string;policyDigest:string;
 environment:{clean:true;privateHome:true;privateProject:true;privateCache:true;values:Readonly<Record<string,string>>};
 containment:{cgroupV2:true;resources:true;namespaces:true;network:'none'|'gateway';projectReadOnly:boolean};
 runtime:{version:'0.159.2';sha256:string};
}
function overlaps(a:string,b:string):boolean {a=resolve(a);b=resolve(b);return a===b||a.startsWith(b+'/')||b.startsWith(a+'/');}
/** Must run in the authorized Linux guest. No fallback execution on macOS or the host. */
export class NodeController implements TrustedNodeVerifier {
 private readonly records=new Map<string,ProcessRecord>();
 private launching=false;
 private readonly nativeChildren=new Map<string,import('node:child_process').ChildProcessWithoutNullStreams>();
 private readonly journal?:NodeProcessJournal<ProcessRecord>;
 constructor(private readonly authority:NodeAuthority) {
  if(authority.stateDirectory){
   if(overlaps(authority.stateDirectory,authority.privateRoot)||overlaps(authority.stateDirectory,authority.rootfsRoot))throw new Error('NODE_JOURNAL_MOUNT_OVERLAP');
   this.journal=new NodeProcessJournal<ProcessRecord>(authority.stateDirectory);
   for(const record of this.journal.load()) {
    if(!record?.binding||record.binding.nodeId!==authority.nodeId||record.binding.sandboxId!==authority.sandboxId||record.unit!==`an-${bindingKey(record.binding)}.service`||record.evidenceRef!==`node-cgroup:${bindingKey(record.binding)}`||record.cgroup!==`/sys/fs/cgroup/system.slice/${record.unit}`||(record.waitedExitCode!==undefined&&(!Number.isInteger(record.waitedExitCode)||record.waitedExitCode<0||record.waitedExitCode>255)))throw new Error('NODE_JOURNAL_INVALID');
    this.records.set(record.binding.processInstanceId,record);
   }
  }
 }
 private persist():void {if(!this.journal)throw new Error('BLOCKED_NODE_JOURNAL_REQUIRED');this.journal.save([...this.records.values()]);}
 private check(binding:ExecutionBinding,action:'sandbox-exec'|'accountless-probe'|'verify-candidate'='sandbox-exec'):void {
  if(process.platform!=='linux'||!this.authority.authorization?.targetId||this.authority.authorization.expiresAt<=Date.now()||!this.authority.authorization.actions.includes(action)) throw new Error('BLOCKED_NODE_AUTHORIZATION');
  if(binding.nodeId!==this.authority.nodeId||binding.sandboxId!==this.authority.sandboxId||binding.generation!==this.authority.generation) throw new Error('STALE_SANDBOX');
  if(!binding.processInstanceId||!binding.transportInstanceId||!binding.runId||!binding.sessionId||!binding.turnId||!Number.isSafeInteger(binding.fencingToken)||binding.fencingToken<1) throw new Error('INVALID_BINDING');
 }
 private gatewayProperties(policy:SandboxPolicy):string[] {
  if(policy.network==='none')return [];
  if(!policy.gatewayAddresses?.length||policy.gatewayAddresses.some(address=>!isIP(address)||!this.authority.gatewayAddresses?.includes(address)))throw new Error('NETWORK_POLICY_UNSUPPORTED');
  return ['IPAddressDeny=any',`IPAddressAllow=${policy.gatewayAddresses.join(' ')}`];
 }
 private gateArguments(unit:string,policy:SandboxPolicy,args:string[]):string[] {
  const gate={unit,...policy.limits,...(policy.network==='gateway'?{gatewayAddresses:policy.gatewayAddresses}:{})};
  return ['/usr/bin/node','/opt/an/node/enforcement-gate.mjs',Buffer.from(JSON.stringify(gate)).toString('base64url'),'--',...args];
 }
 async launch(binding:ExecutionBinding,policy:SandboxPolicy,argv:string[]):Promise<{processInstanceId:string;evidenceRef:string}> {
  this.check(binding);
  if(!this.journal)throw new Error('BLOCKED_NODE_JOURNAL_REQUIRED');
  if(this.launching) throw new Error('NODE_WRITER_BUSY');
  this.launching=true;
  try {
  for(const record of this.records.values()) {
   const observation=await this.observeStop(record.binding,record.evidenceRef);
   if(!observation?.processTree.complete||observation.processTree.writableProcesses!==0) throw new Error('NODE_WRITER_BUSY');
  }
  if(!argv.length||!argv[0].startsWith('/')||argv.some(x=>typeof x!=='string'||x.includes('\0'))) throw new Error('INVALID_NODE_COMMAND');
  const args=buildSandboxCommand(policy);
  privatePath(this.authority.rootfsRoot,policy.rootfs);
  for(const path of [policy.home,policy.project,policy.cache]) privatePath(this.authority.privateRoot,path);
  // Do not mount any other Bot, management directory, socket or host Home into the guest.
  const allowedRoot=resolve(this.authority.privateRoot);
  const paths=[policy.home,policy.project,policy.cache].map(path=>resolve(path));
  if(paths.some((path,i)=>paths.some((other,j)=>i!==j&&(path===other||path.startsWith(other+'/'))))) throw new Error('NODE_PATH_OVERLAP');
  if([policy.home,policy.project,policy.cache].some(path=>resolve(path)===allowedRoot)) throw new Error('NODE_PATH_DENIED');
  if(Number(statfsSync('/sys/fs/cgroup').type)!==0x63677270) throw new Error('BLOCKED_CGROUP_V2');
  const key=bindingKey(binding),unit=`an-${key}.service`,evidenceRef=`node-cgroup:${key}`;
  if(this.records.has(binding.processInstanceId)) throw new Error('PROCESS_INSTANCE_REUSED');
  this.records.set(binding.processInstanceId,{binding:structuredClone(binding),unit,evidenceRef,cgroup:`/sys/fs/cgroup/system.slice/${unit}`});this.persist();
  this.check(binding);
  // systemd creates the cgroup before exec: no spawn-then-move race with writable children.
  await exec('/usr/bin/systemd-run',['--quiet','--service-type=exec',`--unit=${unit}`,
   ...[...resourceProperties(policy.limits),...this.gatewayProperties(policy)].map(x=>`--property=${x}`),'--property=StandardOutput=null','--property=StandardError=null',
   '--property=RemainAfterExit=yes','--property=Environment=','--',...this.gateArguments(unit,policy,[...args,'--',...argv])],{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:15_000,maxBuffer:65536});
  const result=await exec('/usr/bin/systemctl',['show',unit,'--property=ControlGroup','--value'],{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:5000,maxBuffer:4096});
  const relative=result.stdout.trim();
  if(relative!==`/system.slice/${unit}`) throw new Error('BLOCKED_CGROUP_BINDING');
  this.records.get(binding.processInstanceId)!.cgroup=join('/sys/fs/cgroup',relative);
  // Confirm the actual kernel controls before declaring a usable process reference.
  const group=this.records.get(binding.processInstanceId)!.cgroup!;
  const expectedCpu=String(policy.limits.cpuPercent*1000);
  const cpu=readFileSync(join(group,'cpu.max'),'utf8').trim().split(/\s+/);
  if(readFileSync(join(group,'memory.max'),'utf8').trim()!==String(policy.limits.memoryBytes)||readFileSync(join(group,'pids.max'),'utf8').trim()!==String(policy.limits.pids)||cpu[0]!==expectedCpu||cpu[1]!=='100000') {
   await this.stop(binding);throw new Error('BLOCKED_RESOURCE_ENFORCEMENT');
  }
  const main=await exec('/usr/bin/systemctl',['show',unit,'--property=MainPID','--value'],{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:5000,maxBuffer:4096});
  const pid=Number(main.stdout.trim());
  if(!Number.isSafeInteger(pid)||pid<1) throw new Error('BLOCKED_PROCESS_NOT_RUNNING');
  for(const ns of (policy.network==='none'?['net','mnt','pid','user']:['mnt','pid','user'])) {
   if(readlinkSync(`/proc/${pid}/ns/${ns}`)===readlinkSync(`/proc/self/ns/${ns}`)) {
    await this.stop(binding);throw new Error('BLOCKED_NAMESPACE_ENFORCEMENT');
   }
  }
  return {processInstanceId:binding.processInstanceId,evidenceRef};
  } finally {this.launching=false;}
 }
 private async checkPinnedFile(rootfs:string,relative:string,expected:string|undefined):Promise<void> {
  if(!expected||!/^[a-f0-9]{64}$/.test(expected))throw new Error('TRUSTED_PROFILE_DIGEST_REQUIRED');
  const path=privatePath(rootfs,join(rootfs,relative));const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  if(hash.digest('hex')!==expected)throw new Error('TRUSTED_PROFILE_DIGEST_MISMATCH');
 }
 /** Fixed admitted Codex profile. The trusted gate execs bwrap only after reading actual OS controls. */
 async openNative(binding:ExecutionBinding,policy:SandboxPolicy) {
  this.check(binding);
  if(!this.journal)throw new Error('BLOCKED_NODE_JOURNAL_REQUIRED');
  if(this.launching)throw new Error('NODE_WRITER_BUSY');this.launching=true;
  try {
   for(const prior of this.records.values()){const observation=await this.observeStop(prior.binding,prior.evidenceRef);if(!observation?.processTree.complete||observation.processTree.writableProcesses!==0)throw new Error('NODE_WRITER_BUSY');}
   if(this.records.has(binding.processInstanceId))throw new Error('PROCESS_INSTANCE_REUSED');
   const args=buildSandboxCommand(policy);
   privatePath(this.authority.rootfsRoot,policy.rootfs);
   for(const path of [policy.home,policy.project,policy.cache])privatePath(this.authority.privateRoot,path);
   const paths=[policy.home,policy.project,policy.cache].map(path=>resolve(path));
   if(paths.some((path,i)=>paths.some((other,j)=>i!==j&&(path===other||path.startsWith(other+'/')))))throw new Error('NODE_PATH_OVERLAP');
   if(this.authority.nativeRuntime?.version!=='0.159.2')throw new Error('NATIVE_PROFILE_UNSUPPORTED');
   await this.checkPinnedFile(policy.rootfs,'usr/bin/codex',this.authority.nativeRuntime.sha256);
   this.check(binding);
   const key=bindingKey(binding),unit=`an-${key}.service`,evidenceRef=`node-cgroup:${key}`;
   const record:ProcessRecord={binding:structuredClone(binding),unit,evidenceRef,cgroup:`/sys/fs/cgroup/system.slice/${unit}`,nativePolicyDigest:bindingKey(policy as unknown as ExecutionBinding)};
   this.records.set(binding.processInstanceId,record);this.persist();
   const child=spawn('/usr/bin/systemd-run',['--quiet','--pipe','--wait','--service-type=exec',`--unit=${unit}`,
    ...[...resourceProperties(policy.limits),...this.gatewayProperties(policy)].map(x=>`--property=${x}`),'--property=TimeoutStopSec=5','--property=Environment=','--',
    ...this.gateArguments(unit,policy,[...args,'--','/usr/bin/codex','app-server','--listen','stdio://'])],{env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe']});
   this.nativeChildren.set(binding.processInstanceId,child);
   // Do not export raw stderr (it may include runtime auth material); bounded drain prevents deadlock.
   child.on('error',()=>{});child.stdin.on('error',()=>{});
   let stderrBytes=0;child.stderr.on('data',(bytes:Buffer)=>{stderrBytes+=bytes.length;if(stderrBytes>65536)void this.stop(binding).catch(()=>{});});
   child.on('exit',(code,signal)=>{if(signal===null&&Number.isInteger(code)&&code!>=0){record.waitedExitCode=code!;try{this.persist();}catch{/* Missing persisted exit remains UNKNOWN after restart. */}}});
   return {binding:structuredClone(binding),input:child.stdout,output:child.stdin,evidenceRef,process:child};
  } finally {this.launching=false;}
 }
 /** Guest Driver terminal callback only: graceful EOF is not a fabricated successful stop. */
 async finishNative(binding:ExecutionBinding):Promise<TrustedStopObservation|null> {
  const record=this.record(binding);if(!record?.nativePolicyDigest)return null;
  const child=this.nativeChildren.get(binding.processInstanceId);
  if(child&&child.exitCode===null&&child.signalCode===null){
   await new Promise<void>(resolve=>{
    const done=()=>{clearTimeout(timer);child.off('close',done);child.off('error',done);resolve();};
    const timer=setTimeout(done,5000);
    child.once('close',done);child.once('error',done);
    try{child.stdin.end();}catch{done();}
   });
  }
  // A live descendant or a missing actual exit record remains running/isolated/unknown.
  return this.observeStop(binding,record.evidenceRef);
 }
 /** Fresh OS readbacks for an already initialized exact native process. Never a configuration-only READY. */
 async attestNative(binding:ExecutionBinding,policy:SandboxPolicy):Promise<NativePolicyAttestation> {
  this.check(binding);
  const record=this.record(binding),policyDigest=bindingKey(policy as unknown as ExecutionBinding);
  if(!record?.cgroup||record.nativePolicyDigest!==policyDigest||!this.authority.nativeRuntime)throw new Error('NATIVE_ATTESTATION_UNAVAILABLE');
  await this.checkPinnedFile(policy.rootfs,'usr/bin/codex',this.authority.nativeRuntime.sha256);
  const group=record.cgroup;
  if(Number(statfsSync(group).type)!==0x63677270||cgroupTreeState(readFileSync(join(group,'cgroup.events'),'utf8'))!=='running')throw new Error('NATIVE_ATTESTATION_UNAVAILABLE');
  const cpu=readFileSync(join(group,'cpu.max'),'utf8').trim().split(/\s+/);
  if(cpu[0]!==String(policy.limits.cpuPercent*1000)||cpu[1]!=='100000'||readFileSync(join(group,'memory.max'),'utf8').trim()!==String(policy.limits.memoryBytes)||readFileSync(join(group,'pids.max'),'utf8').trim()!==String(policy.limits.pids))throw new Error('BLOCKED_RESOURCE_ENFORCEMENT');
  const pids:number[]=[];let groups=0;
  const visit=(directory:string)=>{if(++groups>256)throw new Error('NATIVE_ATTESTATION_LIMIT');for(const item of readFileSync(join(directory,'cgroup.procs'),'utf8').trim().split(/\s+/)){if(item){const pid=Number(item);if(!Number.isSafeInteger(pid)||pid<1)throw new Error('NATIVE_ATTESTATION_UNAVAILABLE');pids.push(pid);if(pids.length>1024)throw new Error('NATIVE_ATTESTATION_LIMIT');}}for(const entry of readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory())visit(join(directory,entry.name));};visit(group);
  const expected=statSync(join(policy.rootfs,'usr/bin/codex'));
  const candidates=pids.filter(pid=>{try{const actual=statSync(`/proc/${pid}/exe`);return actual.ino===expected.ino&&actual.dev===expected.dev;}catch{return false;}});
  if(candidates.length!==1)throw new Error('NATIVE_ATTESTATION_UNAVAILABLE');
  const pid=candidates[0];
  for(const ns of (policy.network==='none'?['net','mnt','pid','user']:['mnt','pid','user']))if(readlinkSync(`/proc/${pid}/ns/${ns}`)===readlinkSync(`/proc/self/ns/${ns}`))throw new Error('BLOCKED_NAMESPACE_ENFORCEMENT');
  for(const [source,target] of [[policy.rootfs,''],[policy.home,'/bot/home'],[policy.project,'/workspace'],[policy.cache,'/bot/home/.cache']]){const a=statSync(source),b=statSync(`/proc/${pid}/root${target}`);if(a.ino!==b.ino||a.dev!==b.dev)throw new Error('BLOCKED_MOUNT_ENFORCEMENT');}
  const mounts=readFileSync(`/proc/${pid}/mountinfo`,'utf8').trim().split('\n').map(line=>line.split(' '));
  if(!mounts.some(parts=>parts[4]==='/'&&parts[5].split(',').includes('ro'))||(policy.discussion&&!mounts.some(parts=>parts[4]==='/workspace'&&parts[5].split(',').includes('ro'))))throw new Error('BLOCKED_MOUNT_ENFORCEMENT');
  const environment=readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').filter(Boolean).sort();
  if(JSON.stringify(environment)!==JSON.stringify(Object.entries(NATIVE_GUEST_ENVIRONMENT).map(([key,value])=>`${key}=${value}`).sort()))throw new Error('BLOCKED_ENVIRONMENT_ENFORCEMENT');
  if(policy.network==='gateway'){
   this.gatewayProperties(policy);
   const result=await exec('/usr/sbin/bpftool',['-j','cgroup','show',group],{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:5000,maxBuffer:65536});
   const attached=JSON.parse(result.stdout);
   if(!Array.isArray(attached)||!['ingress','egress'].every(type=>attached.some(item=>item.attach_type===type||item.attach_type===`cgroup_inet_${type}`)))throw new Error('BLOCKED_NETWORK_ENFORCEMENT');
   const resultProperties=await exec('/usr/bin/systemctl',['show',record.unit,'--property=IPAddressDeny','--property=IPAddressAllow'],{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:5000,maxBuffer:65536});
   const properties=Object.fromEntries(resultProperties.stdout.trim().split('\n').map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
   const normalize=(value:string)=>value.trim().split(/\s+/).filter(Boolean).sort().join(' ');
   if(normalize(properties.IPAddressDeny??'')!==normalize('0.0.0.0/0 ::/0')||normalize(properties.IPAddressAllow??'')!==normalize(policy.gatewayAddresses!.map(address=>address.includes(':')?`${address}/128`:`${address}/32`).join(' ')))throw new Error('BLOCKED_NETWORK_ENFORCEMENT');
  }
  this.check(binding);
  if(cgroupTreeState(readFileSync(join(group,'cgroup.events'),'utf8'))!=='running')throw new Error('NATIVE_ATTESTATION_UNAVAILABLE');
  return {protocolVersion:2,binding:structuredClone(binding),observedAt:Date.now(),evidenceRef:record.evidenceRef,policyDigest,environment:{clean:true,privateHome:true,privateProject:true,privateCache:true,values:Object.fromEntries(environment.map(entry=>[entry.slice(0,entry.indexOf('=')),entry.slice(entry.indexOf('=')+1)]))},containment:{cgroupV2:true,resources:true,namespaces:true,network:policy.network,projectReadOnly:policy.discussion},runtime:{...this.authority.nativeRuntime}};
 }
 /** Trusted fixed workspace export, before initialization or after whole-tree stop; no request path. */
 async captureCandidate(binding:ExecutionBinding,policy:SandboxPolicy):Promise<SnapshotTransfer & {binding:ExecutionBinding}> {
  this.check(binding,'verify-candidate');if(!this.authority.stateDirectory||this.launching)throw Error('CANDIDATE_CAPTURE_UNAVAILABLE');
  this.launching=true;try{
  const record=this.record(binding);if(record&&record.nativePolicyDigest!==bindingKey(policy as unknown as ExecutionBinding))throw Error('CANDIDATE_CAPTURE_UNAVAILABLE');
  const noWriters=async()=>{for(const prior of this.records.values()){const stop=await this.observeStop(prior.binding,prior.evidenceRef);if(!stop?.processTree.complete||stop.processTree.writableProcesses!==0)throw Error('ACTIVE_WRITER');}};
  await noWriters();this.check(binding,'verify-candidate');
  const project=privatePath(this.authority.privateRoot,policy.project);const store=new CandidateStore(join(this.authority.stateDirectory,'candidates'));const snapshot=store.capture(project);
  await noWriters();this.check(binding,'verify-candidate');store.resolve(snapshot.ref,snapshot.digest);
  const contents=snapshot.files.filter(f=>f.kind==='file').map(f=>({path:f.path,data:readFileSync(join(snapshot.path,'files',f.path)).toString('base64')}));
  const result={binding:structuredClone(binding),candidateDigest:snapshot.digest,files:snapshot.files,contents};if(Buffer.byteLength(JSON.stringify(result))>160000)throw Error('CANDIDATE_TRANSFER_LIMIT');return result;
  }finally{this.launching=false;}
 }
 /** Dedicated fixed verifier child. Its stdout is untrusted candidate data, never a PASS report. */
 async runVerificationProbe(binding:ExecutionBinding,policy:SandboxPolicy,inputJson:string):Promise<{stdout:string;exitCode:number;stopObservation:TrustedStopObservation}> {
  this.check(binding,'verify-candidate');
  if(!this.journal)throw new Error('BLOCKED_NODE_JOURNAL_REQUIRED');
  if(policy.network!=='none'||policy.discussion!==true||Buffer.byteLength(inputJson)>65536)throw new Error('VERIFIER_POLICY_REQUIRED');
  JSON.parse(inputJson);
  if(this.launching)throw new Error('VERIFIER_DEDICATED_INSTANCE_REQUIRED');
  this.launching=true;
  try {
  for(const prior of this.records.values()){const stopped=await this.observeStop(prior.binding,prior.evidenceRef);if(!stopped?.processTree.complete||stopped.processTree.writableProcesses!==0)throw new Error('VERIFIER_DEDICATED_INSTANCE_REQUIRED');}
  if(this.records.has(binding.processInstanceId))throw new Error('PROCESS_INSTANCE_REUSED');
  privatePath(this.authority.rootfsRoot,policy.rootfs);
  for(const path of [policy.home,policy.project,policy.cache])privatePath(this.authority.privateRoot,path);
  const paths=[policy.home,policy.project,policy.cache].map(path=>resolve(path));
  if(paths.some((path,i)=>paths.some((other,j)=>i!==j&&(path===other||path.startsWith(other+'/')))))throw new Error('NODE_PATH_OVERLAP');
  await this.checkPinnedFile(policy.rootfs,'opt/an/verifier/candidate-probe.mjs',this.authority.verifierProbeDigest);
  const args=buildSandboxCommand(policy);
  if(Number(statfsSync('/sys/fs/cgroup').type)!==0x63677270)throw new Error('BLOCKED_CGROUP_V2');
  const key=bindingKey(binding),unit=`an-${key}.service`,evidenceRef=`node-cgroup:${key}`;
  const group=`/sys/fs/cgroup/system.slice/${unit}`;
  this.records.set(binding.processInstanceId,{binding:structuredClone(binding),unit,evidenceRef,cgroup:group});this.persist();
  let stdout='';let executionFailed=false;
  this.check(binding,'verify-candidate');
  try {
   const result=await exec('/usr/bin/systemd-run',['--quiet','--pipe','--wait','--service-type=exec',`--unit=${unit}`,
    ...[...resourceProperties(policy.limits),...this.gatewayProperties(policy)].map(x=>`--property=${x}`),'--property=RuntimeMaxSec=5','--property=TimeoutStopSec=1',
    '--property=Environment=','--',...this.gateArguments(unit,policy,[...args,'--','/usr/bin/node','/opt/an/verifier/candidate-probe.mjs','/workspace/src/export-records.mjs',inputJson])],
    {env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:10000,maxBuffer:65536});
   stdout=result.stdout;this.records.get(binding.processInstanceId)!.waitedExitCode=0;this.persist();
  } catch {executionFailed=true;}
  const stopObservation=await this.observeStop(binding,evidenceRef);
  if(!stopObservation?.processTree.complete||stopObservation.processTree.writableProcesses!==0||!Number.isInteger(stopObservation.exitCode)) {
   try {await this.stop(binding);}catch { /* UNKNOWN remains blocked; no host-process fallback. */ }
   throw new Error('BLOCKED_VERIFIER_STOP_UNCONFIRMED');
  }
  if(executionFailed||stopObservation.exitCode!==0)throw new Error('VERIFIER_PROBE_FAILED');
  return {stdout,exitCode:stopObservation.exitCode!,stopObservation};
  } finally {this.launching=false;}
 }
 async stop(binding:ExecutionBinding):Promise<TrustedStopObservation|null> {
  const record=this.record(binding);if(!record) return null;
  // cgroup.kill covers descendants, including reparented children; never kill shared host services.
  const {writeFileSync}=await import('node:fs');
  if(!record.cgroup) return null;
  writeFileSync(join(record.cgroup,'cgroup.kill'),'1');
  return this.observeStop(binding,record.evidenceRef);
 }
 private record(binding:ExecutionBinding):ProcessRecord|undefined {
  const record=this.records.get(binding.processInstanceId);
  if(!record||bindingKey(record.binding)!==bindingKey(binding)) return undefined;return record;
 }
 async observeStop(binding:ExecutionBinding,evidenceRef:string):Promise<TrustedStopObservation|null> {
  const record=this.record(binding);
  if(!record?.cgroup||record.evidenceRef!==evidenceRef) return null;
  try {
   if(Number(statfsSync(record.cgroup).type)!==0x63677270) return null;
   const events=readFileSync(join(record.cgroup,'cgroup.events'),'utf8');
   // populated is recursive. Parent PID and direct cgroup.procs alone are deliberately insufficient.
   const state=cgroupTreeState(events);const stopped=state==='stopped',running=state==='running';
   if(!stopped&&!running) return null;
   let exitCode:number|undefined;
   if(stopped) {
    const status=await exec('/usr/bin/systemctl',['show',record.unit,'--property=ExecMainCode','--property=ExecMainStatus'],{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:5000,maxBuffer:4096});
    const code=/^ExecMainCode=(\d+)$/m.exec(status.stdout)?.[1];
    const value=/^ExecMainStatus=(\d+)$/m.exec(status.stdout)?.[1];
    if(code==='1'&&value!==undefined&&Number(value)<=255) exitCode=Number(value);
   }
   return {protocolVersion:2,observationId:randomUUID(),evidenceRef,observedAt:Date.now(),binding:structuredClone(binding),
    processTree:observedProcessTree(events,exitCode),...(exitCode===undefined?{}:{exitCode})};
  } catch {
   if(record.waitedExitCode!==undefined) {
    try {lstatSync(record.cgroup);} catch(error) {
     if((error as NodeJS.ErrnoException).code==='ENOENT')return {protocolVersion:2,observationId:randomUUID(),evidenceRef,observedAt:Date.now(),binding:structuredClone(binding),processTree:{complete:true,writableProcesses:0,state:'stopped'},exitCode:record.waitedExitCode};
    }
   }
   // systemd may remove a completed empty cgroup. A retained exact unit's terminal status is
   // required; an absent group or parent exit alone is never sufficient.
   try {
    const status=await exec('/usr/bin/systemctl',['show',record.unit,'--property=LoadState','--property=ActiveState','--property=SubState','--property=ControlGroup','--property=ExecMainCode','--property=ExecMainStatus'],{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:5000,maxBuffer:4096});
    const fields=Object.fromEntries(status.stdout.trim().split('\n').map(line=>line.split('=')));
    const code=Number(fields.ExecMainStatus);
    if(fields.LoadState!=='loaded'||fields.ActiveState!=='inactive'||fields.SubState!=='dead'||fields.ControlGroup!==''||fields.ExecMainCode!=='1'||!Number.isInteger(code)||code<0||code>255)return null;
    return {protocolVersion:2,observationId:randomUUID(),evidenceRef,observedAt:Date.now(),binding:structuredClone(binding),processTree:{complete:true,writableProcesses:0,state:'stopped'},exitCode:code};
   } catch {return null;}
  }
 }
}
/** Safe preflight only: does not initialize CLI, load inherited credentials, create a turn or launch a VM. */
export async function accountlessProbe(configPath:string):Promise<{status:'PREFLIGHT_ONLY';targetId:string}> {
 if(!configPath) throw new Error('BLOCKED_PROTECTED_AUTHORIZATION_REQUIRED');
 const stat=lstatSync(configPath);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()) throw new Error('BLOCKED_PROTECTED_AUTHORIZATION_REQUIRED');
 const config=JSON.parse(readFileSync(configPath,'utf8')) as NodeAuthority;
 if(process.platform!=='linux'||!config.authorization?.targetId||!config.authorization.actions.includes('accountless-probe')||config.authorization.expiresAt<=Date.now()) throw new Error('BLOCKED_PROTECTED_AUTHORIZATION_REQUIRED');
 if(Number(statfsSync('/sys/fs/cgroup').type)!==0x63677270) throw new Error('BLOCKED_CGROUP_V2');
 if(!readFileSync('/sys/fs/cgroup/cgroup.controllers','utf8').split(/\s+/).includes('pids')) throw new Error('BLOCKED_CGROUP_CONTROLLERS');
 await exec('/usr/bin/bwrap',['--version'],{env:{PATH:'/usr/bin:/bin'},timeout:5000,maxBuffer:4096});
 return {status:'PREFLIGHT_ONLY',targetId:config.authorization.targetId};
}

/** cgroup.events populated includes descendant groups; malformed or contradictory readings remain unknown. */
export function cgroupTreeState(events:string):'stopped'|'running'|'unknown' {
 const populated=events.split(/\n/).filter(line=>line.startsWith('populated '));
 if(populated.length!==1) return 'unknown';return populated[0]==='populated 0'?'stopped':populated[0]==='populated 1'?'running':'unknown';
}

/** Empty recursive containment proves no writers; missing actual exit status cannot manufacture success. */
export function observedProcessTree(events:string,exitCode?:number):TrustedStopObservation['processTree'] {
 const state=cgroupTreeState(events);
 if(state==='stopped')return {complete:true,writableProcesses:0,state:Number.isInteger(exitCode)?'stopped':'isolated'};
 return {complete:false,writableProcesses:state==='running'?1:-1,state};
}
