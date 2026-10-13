import {CodexAuthAdapter,createCodexNativeAuthRuntime} from '../../execution/src/drivers/codex-auth.js';
import {NodeRunnerChannel} from '../../../apps/node-agent/src/channel.js';
import type {FlowTarget,NativeAuthFlowRuntime} from '../../connections/src/auth-flow.js';
import type {Run} from './control.js';
import {createConnection} from 'node:net';
import {lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readP1ProtectedJSON,readP1Admission,type P1Admission} from './p1-admission.js';
import {canonicalDigest} from './approvals.js';
import {createInstalledP1Capabilities,type P1InstalledConfiguration} from './p1-composition.js';
import type {P1Application} from './p1-application.js';
import {VMHelperProcessTransport,MacOSVMProvider} from '../../execution/src/providers/macos-vm.js';
import {CandidateStore} from '../../../apps/verification-worker/src/candidate.js';
import {MacProtectedVerifierExecutor} from '../../../apps/verification-worker/src/macos-executor.js';
import type {NativePolicyAttestation} from '../../../apps/node-agent/src/control.js';
import {DownloadManager} from '../../catalog-client/src/index.js';
export {createConfiguredEnvironmentInitializer} from './p1-environment-installed.js';
/** Explicit, preinstalled and separately admitted target. These are private paths, never renderer fields. */
export interface InstalledRuntime {
 version:1;targetId:string;expiresAt:number;botId:string;nodeId:string;sandboxId:string;generation:number;
 helper:{helperPath:string;helperSHA256:string;authorityPath:string};
 node:{privateRoot:string;keyPath:string;transportInstanceId:string;runtimeDigest:string;policyDigest:string};
 loginKind?:'chatgpt'|'chatgptDeviceCode';
 profile:ReturnType<P1InstalledConfiguration['profile']>;
 verification?:{candidatePath?:string;storePath:string;oraclePath:string;binaryPath:string;binaryDigest:string;trustedRoot:string;contracts:Record<string,{stage:'A'|'B';contractDigest:string;oracleDigest:string;verifierVersion:string;priorTaskId?:string}>};
}
function exact(v:unknown,keys:string[],optional:string[]=[]):asserts v is Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)&&!optional.includes(k))||keys.some(k=>!Object.hasOwn(v,k)))throw Error('INSTALLED_CONFIGURATION_INVALID');}
const absolute=(v:unknown):v is string=>typeof v==='string'&&isAbsolute(v)&&resolve(v)===v;
export function readInstalledRuntime(path:string):InstalledRuntime {
 const v=readP1ProtectedJSON(path);exact(v,['version','targetId','expiresAt','botId','nodeId','sandboxId','generation','helper','node','profile'],['verification','loginKind']);
 if(v.version!==1||!['targetId','botId','nodeId','sandboxId'].every(k=>typeof v[k]==='string'&&String(v[k]).length>0&&String(v[k]).length<=256)||!Number.isSafeInteger(v.expiresAt)||Number(v.expiresAt)<=Date.now()||!Number.isSafeInteger(v.generation)||Number(v.generation)<1)throw Error('INSTALLED_CONFIGURATION_INVALID');
 exact(v.helper,['helperPath','helperSHA256','authorityPath']);exact(v.node,['privateRoot','keyPath','transportInstanceId','runtimeDigest','policyDigest']);
 if(![v.node.runtimeDigest,v.node.policyDigest].every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))||!absolute(v.helper.helperPath)||!absolute(v.helper.authorityPath)||typeof v.helper.helperSHA256!=='string'||!/^[a-f0-9]{64}$/.test(v.helper.helperSHA256)||!absolute(v.node.privateRoot)||!absolute(v.node.keyPath)||typeof v.node.transportInstanceId!=='string'||!v.node.transportInstanceId)throw Error('INSTALLED_CONFIGURATION_INVALID');
 if(v.loginKind!==undefined&&!['chatgpt','chatgptDeviceCode'].includes(String(v.loginKind)))throw Error('INSTALLED_CONFIGURATION_INVALID');
 exact(v.profile,['projectId','runtime','model','modelProvider','botDirectory','cwd','candidateVersion','budget','requireAccount','requireKnownBilling','context']);
 const p=v.profile;if(p.runtime!=='codex-0.159.2'||!['projectId','model','modelProvider','candidateVersion'].every(k=>typeof p[k]==='string'&&String(p[k]).length>0)||p.botDirectory!=='/bot'||p.cwd!=='/workspace'||typeof p.budget!=='number'||!Number.isFinite(p.budget)||p.budget<0||typeof p.requireAccount!=='boolean'||typeof p.requireKnownBilling!=='boolean'||!p.context||typeof p.context!=='object')throw Error('INSTALLED_CONFIGURATION_INVALID');
 if(v.verification!==undefined){exact(v.verification,['storePath','oraclePath','binaryPath','binaryDigest','trustedRoot','contracts'],['candidatePath']);const q=v.verification;if(!['storePath','oraclePath','binaryPath','trustedRoot'].every(k=>absolute(q[k]))||typeof q.binaryDigest!=='string'||!/^[a-f0-9]{64}$/.test(q.binaryDigest)||!q.contracts||typeof q.contracts!=='object'||Array.isArray(q.contracts)||Object.keys(q.contracts).length>16)throw Error('INSTALLED_CONFIGURATION_INVALID');for(const contract of Object.values(q.contracts)){exact(contract,['stage','contractDigest','oracleDigest','verifierVersion'],['priorTaskId']);if(!['A','B'].includes(String(contract.stage))||![contract.contractDigest,contract.oracleDigest].every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))||typeof contract.verifierVersion!=='string'||!contract.verifierVersion||(contract.stage==='B'&&typeof contract.priorTaskId!=='string')||(contract.stage==='A'&&contract.priorTaskId!==undefined))throw Error('INSTALLED_CONFIGURATION_INVALID');}}
 return structuredClone(v) as unknown as InstalledRuntime;
}
/** Construction has no helper, Node, login or model effects. Every later operation rereads scoped private admission. */
export function installedConfiguration(app:P1Application,admissionPath:string,admission:P1Admission):P1InstalledConfiguration {
 if(!admission.runtimeConfigPath)throw Error('INSTALLED_CONFIGURATION_REQUIRED');const config=readInstalledRuntime(admission.runtimeConfigPath);
 if(config.targetId!==admission.targetId||config.botId!==admission.grant.botId||config.nodeId!==admission.grant.nodeId||config.generation!==admission.grant.generation||config.profile.projectId!==admission.grant.projectId||config.expiresAt>admission.expiresAt||!admission.connection.allowedModels.includes(config.profile.model)||!admission.connection.runtimeProfiles.includes(config.profile.runtime))throw Error('INSTALLED_ADMISSION_MISMATCH');
 const assertAction=(action:string)=>{const current=readP1Admission(admissionPath);if(canonicalDigest(current)!==canonicalDigest(admission)||!current.actions.includes(action)||canonicalDigest(readInstalledRuntime(admission.runtimeConfigPath!))!==canonicalDigest(config))throw Error('B_ADMISSION_REQUIRED');};
 const helper=new VMHelperProcessTransport(config.helper),provider=new MacOSVMProvider(helper);
 const downloads=new DownloadManager({db:app.core.database,directory:join(dirname(admissionPath),'downloads'),trustedKeys:new Map(),target:{os:'linux',arch:'arm64',provider:'macos-vm',nodeId:config.nodeId,appProtocol:1,runnerProtocol:2},source:{authorize:async()=>{throw Error('CATALOG_SOURCE_ADMISSION_REQUIRED');},read:async()=>{throw Error('CATALOG_SOURCE_ADMISSION_REQUIRED');}}});
 const result:P1InstalledConfiguration={prepareInstalled:true,assertAdmitted:()=>assertAction('model.request'),vmHelper:helper,downloads,provisionRequest:()=>{throw Error('PREINSTALLED_TARGET_REQUIRED');},projectForBot:botId=>botId===config.botId?config.profile.projectId:`preparation:${botId}`,profile:r=>{if(r.botId!==config.botId)throw Error('B_ADMISSION_REQUIRED');return structuredClone(config.profile);},
  connectRun:(run,sandboxId)=>connectInstalledRun(config,provider,run,sandboxId,assertAction)
 };
 if(config.loginKind){
  const owned=new Map<string,{channel:NodeRunnerChannel;runtime?:NativeAuthFlowRuntime;runtimeBinding:import('../../execution/src/contracts.js').ExecutionBinding}>();
  const target:FlowTarget={botId:config.botId,nodeId:config.nodeId,generation:config.generation,runtime:config.profile.runtime,connectionId:admission.connection.id,connectionRevision:admission.connection.revision};
  const authorized=(actual:FlowTarget)=>{assertAction('login');if(Object.keys(target).some(k=>target[k as keyof FlowTarget]!==actual[k as keyof FlowTarget]))throw Error('AUTH_FLOW_BINDING_MISMATCH');const connection=app.registry.get(target.connectionId);if(connection.revision!==target.connectionRevision||connection.status==='revoked'||connection.authMethod!=='runtime_managed_login'||app.core.snapshot().bots.find(b=>b.id===target.botId)?.generation!==target.generation)throw Error('AUTH_FLOW_BINDING_MISMATCH');app.grants.assertAuthorized(admission.grant.id,admission.grant);};
  result.authTarget=(botId,connectionId)=>{if(botId!==target.botId||connectionId!==target.connectionId)throw Error('AUTH_FLOW_BINDING_MISMATCH');return {...target};};
  result.releaseAuth=async flowId=>{const entry=owned.get(flowId);if(!entry)return;let status=await entry.channel.finishNative(entry.runtimeBinding!);if(!status?.processTree.complete||status.processTree.writableProcesses!==0)status=await entry.channel.stopNative(entry.runtimeBinding);if(!status?.processTree.complete||status.processTree.writableProcesses!==0)throw Error('AUTH_PROCESS_STOP_UNKNOWN');entry.channel.close();owned.delete(flowId);};
  result.nativeAuthRuntime={allowedDomains:['auth.openai.com','chatgpt.com'],assertAuthorized:authorized,
   async start(input){authorized(input);if(owned.size)throw Error('AUTH_PROCESS_STATE_UNKNOWN');if(app.core.snapshot().runs.some(r=>r.botId===target.botId&&r.slotHeld))throw Error('ACTIVE_RUN');
    // A dedicated initialize/login session has no Task, turn/start or Core writer.
    const id=`auth-${randomUUID()}`;const r:Run={id,botId:target.botId,taskId:id,taskRevision:1,commandId:id,fencingToken:Math.max(1,Number(app.core.database.prepare("SELECT value FROM core_metadata WHERE key='fencing_token'").get()?.value??0)+1),generation:target.generation,ownerEpoch:app.core.epoch,leaseExpiresAt:Math.min(input.expiresAt,admission.expiresAt),sessionId:id,turnId:id,state:'DISPATCHED',slotHeld:false,version:1,lastSequence:0,stopKind:null,contextManifestRef:'',resolvedConnectionRef:''};
    const installed=await result.connectRun(r,config.sandboxId);authorized(input);const channel=new NodeRunnerChannel(installed.stream,installed.key,{nodeId:target.nodeId,sandboxId:config.sandboxId,generation:target.generation,transportInstanceId:config.node.transportInstanceId});
    owned.set(input.flowId,{channel,runtimeBinding:installed.binding});
    await channel.remoteDriver().initialize({binding:installed.binding,runtimeVersion:'0.159.2'});await installed.attestRuntime?.(channel);authorized(input);
    const adapter=new CodexAuthAdapter({runtimeEvidence:'verified_sandbox_runtime',binding:installed.binding,botId:target.botId,runtime:target.runtime,driver:channel.remoteDriver(),botDirectory:'/bot',home:'/bot/home',configuration:'clean',assertSandbox:installed.assertSandbox,assertRuntimeEnvironment:installed.assertRuntimeEnvironment});
    const runtime=createCodexNativeAuthRuntime({binding:installed.binding,botId:target.botId,runtime:target.runtime,connectionId:target.connectionId,connectionRevision:target.connectionRevision,loginKind:config.loginKind!,transport:channel.remoteAuthTransport(installed.binding),assertOperationAuthorized:(operation,t)=>{if(operation!=='cancel')authorized(t);},inspectTarget:async()=>{await installed.attestRuntime?.(channel);return adapter.inspectAuth({userId:'local-user',projectId:config.profile.projectId,botId:target.botId,nodeId:target.nodeId,generation:target.generation,action:'model.request',defaultConnectionId:target.connectionId,explicitConnectionId:target.connectionId,runId:r.id,taskId:r.taskId,runtimeSessionRef:r.sessionId,runtime:target.runtime,model:config.profile.model,budget:0,expiresAt:r.leaseExpiresAt,nodeLocation:'local',processingSources:[],requireAccount:config.profile.requireAccount,requireKnownBilling:false,runtimePolicy:{nativeLoginAllowed:true,authMethods:['runtime_managed_login']},executionMode:'live',executionBinding:installed.binding});}});
    owned.set(input.flowId,{channel,runtime,runtimeBinding:installed.binding});return runtime.start(input);
   },cancel:input=>{const entry=owned.get(input.flowId);if(!entry)throw Error('AUTH_PROCESS_STATE_UNKNOWN');if(!entry.runtime)throw Error('AUTH_PROCESS_STATE_UNKNOWN');return entry.runtime.cancel(input);},
   inspectAuth:async input=>{authorized(input);const entry=input.flowId&&owned.get(input.flowId);if(!entry)throw Error('AUTH_PROCESS_STATE_UNKNOWN');if(!entry.runtime)throw Error('AUTH_PROCESS_STATE_UNKNOWN');return entry.runtime.inspectAuth(input);},
   recoverCancellation:input=>owned.get(input.flowId)?.runtime?.recoverCancellation?.(input)??(owned.has(input.flowId)?{status:'not_started'}:{status:'unknown'}),
   forget:flowId=>owned.get(flowId)?.runtime?.forget?.(flowId)
  };
 }
 const verification=config.verification;if(verification){const store=new CandidateStore(verification.storePath);const selected=(run:Parameters<P1InstalledConfiguration['profile']>[0])=>{const contract=verification.contracts[run.taskId];if(!contract)throw Error('TASK_CONTRACT_ADMISSION_REQUIRED');return contract;};result.verification={store,oraclePath:verification.oraclePath,contract:r=>{const {priorTaskId:_,...contract}=selected(r);return contract;},capture:async(r,binding,channel)=>{assertAction('verify-candidate');selected(r);const captured=await channel.captureCandidate(binding);assertAction('verify-candidate');if(canonicalDigest(captured.binding)!==canonicalDigest(binding))throw Error('CANDIDATE_BINDING_MISMATCH');return store.captureTransferred(captured);},continuation:r=>{const c=selected(r);if(c.stage==='A')return;const prior=app.evidence.inspect(c.priorTaskId!);const accepted=app.core.database.prepare('SELECT accepted_evidence_id FROM task_acceptance WHERE task_id=?').get(c.priorTaskId!);const evidence=prior.evidence.find(e=>e.id===accepted?.accepted_evidence_id);if(!evidence)throw Error('CONTINUATION_REQUIRED');return {evidenceId:evidence.id,candidateDigest:evidence.candidateDigest,immutableSnapshotRef:evidence.immutableSnapshotRef};},executor:(r,binding)=>{const epoch=app.core.epoch;return new MacProtectedVerifierExecutor({binaryPath:verification.binaryPath,binaryDigest:verification.binaryDigest,trustedRoot:verification.trustedRoot,oracleDigest:selected(r).oracleDigest,binding,authorization:{targetId:binding.sandboxId,expiresAt:admission.expiresAt,actions:admission.actions},assertCurrent:(current,digest)=>{assertAction('verify-candidate');const state=app.core.snapshot(),run=state.runs.find(x=>x.id===r.id),task=state.tasks.find(x=>x.id===r.taskId),frozen=app.evidence.inspect(r.taskId).current;if(app.core.epoch!==epoch||canonicalDigest(current)!==canonicalDigest(binding)||!run||run.slotHeld||run.fencingToken!==binding.fencingToken||run.generation!==binding.generation||task?.status!=='VERIFYING'||task.revision!==r.taskRevision||frozen?.candidateDigest!==digest||state.runs.some(x=>x.botId===r.botId&&x.slotHeld))throw Error('STALE_EVIDENCE');}});}};}
 return result;
}
export function createConfiguredP1Capabilities(app:P1Application,path:string,admission:P1Admission){return createInstalledP1Capabilities(app,installedConfiguration(app,path,admission));}

/** Shared authenticated installed channel; lifecycle and model/login admission remain callers' responsibility. */
export async function connectInstalledRun(config:InstalledRuntime,provider:MacOSVMProvider,run:Run,sandboxId:string,assertAction:(action:string)=>void):Promise<import('./p1-composition.js').InstalledRunChannel> {
 assertAction('initialize-runtime');
 if(run.botId!==config.botId||sandboxId!==config.sandboxId||run.generation!==config.generation)throw Error('INSTALLED_BINDING_MISMATCH');
 const inspect=async()=>{assertAction('initialize-runtime');const actual=await provider.inspect({sandboxId,generation:config.generation});assertAction('initialize-runtime');if(actual.state!=='running'||actual.evidenceKind!=='live'||!Number.isFinite(actual.observedAt)||actual.observedAt>Date.now()||Date.now()-actual.observedAt>30000)throw Error('SANDBOX_NOT_RUNNING');return actual;};
 let observed=await inspect();
 assertAction('initialize-runtime');const channel=await provider.connect({sandboxId,generation:config.generation});assertAction('initialize-runtime');
 if(channel.evidenceKind!=='live'||channel.nodeId!==config.nodeId||dirname(channel.channelRef)!==config.node.privateRoot)throw Error('NODE_PRIVATE_SOCKET_REQUIRED');
 const root=lstatSync(config.node.privateRoot),socket=lstatSync(channel.channelRef);
 if(!root.isDirectory()||root.isSymbolicLink()||(root.mode&0o077)!==0||root.uid!==process.getuid?.()||realpathSync(config.node.privateRoot)!==config.node.privateRoot||!socket.isSocket()||socket.isSymbolicLink()||(socket.mode&0o077)!==0||socket.uid!==process.getuid?.())throw Error('NODE_PRIVATE_SOCKET_REQUIRED');
 const secret=readP1ProtectedJSON(config.node.keyPath);exact(secret,['keyBase64']);if(typeof secret.keyBase64!=='string')throw Error('NODE_CHANNEL_AUTH_REQUIRED');
 const key=Buffer.from(secret.keyBase64,'base64');let stream:ReturnType<typeof createConnection>|undefined;
 try{
  if(key.length!==32||key.toString('base64')!==secret.keyBase64)throw Error('NODE_CHANNEL_AUTH_REQUIRED');
  assertAction('initialize-runtime');stream=createConnection(channel.channelRef);
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{stream!.destroy();reject(Error('NODE_CONNECT_TIMEOUT'));},5000);stream!.once('connect',()=>{clearTimeout(timeout);resolve();});stream!.once('error',()=>{clearTimeout(timeout);reject(Error('NODE_CHANNEL_UNAVAILABLE'));});});
  assertAction('initialize-runtime');
  const binding={nodeId:config.nodeId,sandboxId,generation:config.generation,transportInstanceId:config.node.transportInstanceId,processInstanceId:randomUUID(),runId:run.id,fencingToken:run.fencingToken,sessionId:run.sessionId,turnId:run.turnId};
  let attestation:NativePolicyAttestation|undefined;
  const assertFresh=()=>{assertAction('initialize-runtime');if(Date.now()-observed.observedAt>30000||observed.observedAt>Date.now()||attestation&&(Date.now()-attestation.observedAt>30000||attestation.observedAt>Date.now()))throw Error('NODE_ATTESTATION_STALE');};
  return {stream,key,binding,stopEvidenceRef:()=>attestation?.evidenceRef,
   async attestRuntime(channel){
    observed=await inspect();assertAction('initialize-runtime');const actual=await channel.attestRuntime(binding);assertAction('initialize-runtime');
    if(actual.protocolVersion!==2||canonicalDigest(actual.binding)!==canonicalDigest(binding)||actual.policyDigest!==config.node.policyDigest||actual.runtime?.version!=='0.159.2'||actual.runtime.sha256!==config.node.runtimeDigest||!actual.environment?.clean||!actual.environment.privateHome||!actual.environment.privateProject||!actual.environment.privateCache||!actual.containment?.cgroupV2||!actual.containment.resources||!actual.containment.namespaces||actual.containment.projectReadOnly||!['none','gateway'].includes(actual.containment.network)||!Number.isFinite(actual.observedAt)||actual.observedAt>Date.now()||Date.now()-actual.observedAt>30000)throw Error('NODE_CONTAINMENT_ATTESTATION_REQUIRED');
    attestation=actual;return actual;
   },
   assertSandbox(b){assertFresh();if(canonicalDigest(b)!==canonicalDigest(binding))throw Error('STALE_EXECUTION_BINDING');},
   assertRuntimeEnvironment(b,environment){assertFresh();if(!attestation||canonicalDigest(b)!==canonicalDigest(binding)||canonicalDigest(environment)!==canonicalDigest((attestation.environment as unknown as {values:unknown}).values))throw Error('NODE_ENVIRONMENT_ATTESTATION_REQUIRED');}
  };
 }catch(error){stream?.destroy();key.fill(0);throw error;}
}
