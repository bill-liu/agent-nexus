import {transaction} from '../../persistence/src/unit-of-work.js';
import type {Duplex} from 'node:stream';
import type {P1Application,P1Capabilities} from './p1-application.js';
import type {Run,ExecutionCommand} from './control.js';
import {canonicalDigest,type ApprovalBinding} from './approvals.js';
import {BotProvisioner,type ProvisionRequest} from './bot-provision.js';
import {MacOSVMProvider,type VMHelperTransport} from '../../execution/src/providers/macos-vm.js';
import {NodeRunnerChannel} from '../../../apps/node-agent/src/channel.js';
import {createCoreApprovalPort} from '../../execution/src/drivers/core-approval-port.js';
import {CodexAuthAdapter,createCodexNativeAuthRuntime,type CodexNativeAuthOptions} from '../../execution/src/drivers/codex-auth.js';
import type {ExecutionBinding} from '../../execution/src/contracts.js';
import type {DriverStartTurn} from '../../contracts/src/runtime-driver.js';
import type {FlowTarget,NativeAuthFlowRuntime} from '../../connections/src/auth-flow.js';
import type {ResolveRequest} from '../../connections/src/types.js';
import type {DownloadManager} from '../../catalog-client/src/index.js';
import {CandidateStore} from '../../../apps/verification-worker/src/candidate.js';
import {VerificationWorker,type VerifierOptions,type TrustedVerifierExecutor} from '../../../apps/verification-worker/src/evidence.js';
export {createP1EnvironmentInitializer} from './p1-environment.js';

export interface InstalledRunChannel {
 stream:Duplex;key:Buffer;binding:ExecutionBinding;
 /** Verified Node facts about this exact already-isolated process; never Renderer fields. */
 stopEvidenceRef?():string|undefined;
 attestRuntime?(channel:NodeRunnerChannel):Promise<void|import('../../../apps/node-agent/src/control.js').NativePolicyAttestation>;
 assertSandbox(binding:ExecutionBinding):void;
 assertRuntimeEnvironment(binding:ExecutionBinding,environment:Readonly<Record<string,string>>):void;
}
export interface P1InstalledConfiguration {
 /** Recheck protected named B admission at every operation; no environment/account autodiscovery. */
 assertAdmitted():void;
 prepareInstalled?:boolean;
 vmHelper:VMHelperTransport;downloads:DownloadManager;
 provisionRequest(botId:string,operationId:string,sandboxId:string):ProvisionRequest;
 connectRun(run:Run,sandboxId:string):Promise<InstalledRunChannel>;
 profile(run:Run):{
  projectId:string;runtime:'codex-0.159.2';model:string;modelProvider:string;botDirectory:string;cwd:string;
  candidateVersion:string;budget:number;requireAccount:boolean;requireKnownBilling:boolean;
  context:ReturnType<P1Capabilities['context']>;
 };
 nativeAuth?:CodexNativeAuthOptions;nativeAuthRuntime?:NativeAuthFlowRuntime;authTarget?:(botId:string,connectionId:string)=>FlowTarget;releaseAuth?:(flowId:string)=>Promise<void>;projectForBot?:(botId:string)=>string;
 verification?:{
  store:CandidateStore;oraclePath:string;contract(run:Run):VerifierOptions['contract'];
  capture(run:Run,binding:ExecutionBinding,channel:NodeRunnerChannel):Promise<{ref:string;digest:string}>;
  executor(run:Run,binding:ExecutionBinding):TrustedVerifierExecutor;
  continuation?(run:Run):import('../../contracts/src/evidence.js').VerificationInput['continuation'];
 };
}
/** Production composition over a trusted installed helper/guest channel. Runner, Driver and CLI stay in the guest.
 * Loading a private configuration alone is not admission; each capability asserts its scoped authorization.
 */
export function createInstalledP1Capabilities(app:P1Application,options:P1InstalledConfiguration):P1Capabilities {
 const routes=new Map<string,{channel:NodeRunnerChannel;binding:ExecutionBinding;auth:CodexAuthAdapter;installed:InstalledRunChannel;botId:string;nativeStarted:boolean}>();
 const commandRoutes=new Map<string,NodeRunnerChannel>();
 const workers=new Map<string,VerificationWorker>();
 const route=(runId:string)=>{const r=routes.get(runId);if(!r)throw Error('NODE_CHANNEL_REQUIRED');return r;};
 const run=(runId:string)=>{const r=app.core.snapshot().runs.find(r=>r.id===runId);if(!r)throw Error('RUN_NOT_FOUND');return r;};
 const authorizeApproval=(binding:ApprovalBinding,requireLive=true)=>{
  options.assertAdmitted();const r=run(binding.runId),fixed=app.connections.snapshot(r.resolvedConnectionRef),context=app.context.get(r.contextManifestRef);
  if((requireLive&&(!r.slotHeld||r.stopKind))||r.botId!==binding.botId||r.taskId!==binding.taskId||r.taskRevision!==binding.taskRevision||r.sessionId!==binding.sessionId||r.turnId!==binding.turnId||r.generation!==binding.nodeGeneration||binding.subjectId!=='local-user'||binding.projectId!==fixed.projectId||binding.connectionId!==fixed.connectionId||binding.connectionRevision!==fixed.connectionRevision||binding.grantId!==fixed.grantId||binding.grantRevision!==fixed.grantRevision||binding.nodeId!==fixed.nodeId||binding.contextDigest!==canonicalDigest(context)||binding.candidateVersion!==options.profile(r).candidateVersion)throw Error('APPROVAL_BINDING_MISMATCH');
  if(requireLive){app.grants.assertAuthorized(fixed.grantId,fixed,fixed.grantRevision);app.leases.get(fixed.executionLeaseRef,'execution');}
 };
 const startBundle=(command:ExecutionCommand):DriverStartTurn=>{
  const r=run(command.runId),profile=options.profile(r),fixed=app.connections.snapshot(command.resolvedConnectionRef),context=app.context.get(command.contextManifestRef);
  const task=app.core.snapshot().tasks.find(t=>t.id===r.taskId);if(!task)throw Error('TASK_NOT_FOUND');
  return {binding:route(r.id).binding,approvalBinding:{subjectId:'local-user',projectId:fixed.projectId,botId:r.botId,taskId:r.taskId,taskRevision:r.taskRevision,candidateVersion:profile.candidateVersion,contextDigest:canonicalDigest(context),runId:r.id,sessionId:r.sessionId,turnId:r.turnId,connectionId:fixed.connectionId,connectionRevision:fixed.connectionRevision,grantId:fixed.grantId,grantRevision:fixed.grantRevision,nodeId:fixed.nodeId,nodeGeneration:r.generation},input:[{type:'text',text:task.text},...context.assets.map(asset=>({type:'text' as const,text:`Context asset ${asset.assetId} v${asset.version} (${asset.digest}):\n${app.context.read(context.manifestId,asset.assetId)}`}))],cwd:profile.cwd,contextManifestRef:command.contextManifestRef,resolvedConnectionRef:command.resolvedConnectionRef,selectedRuntime:{model:fixed.model,modelProvider:profile.modelProvider}};
 };
 const drainSpool=async(channel:NodeRunnerChannel)=>{
  const entries=await channel.replaySpool();if(!entries.length)return;
  const key=canonicalDigest(channel.binding);const db=app.core.database;
  transaction(db,()=>{const previous=Number(db.prepare('SELECT cursor FROM p1_runner_cursor WHERE channel_id=?').get(key)?.cursor??0);let cursor=previous;
   for(const entry of entries){if(!Number.isSafeInteger(entry.cursor)||entry.cursor<1||entry.cursor<=cursor&&entry.cursor>previous||!['status','approval','terminal'].includes(entry.kind)||!entry.payload||Array.isArray(entry.payload)||Object.values(entry.payload).some(v=>v!==null&&!['string','number','boolean'].includes(typeof v))||!db.prepare('SELECT id FROM run WHERE id=?').get(entry.runId))throw Error('RUNNER_METADATA_INVALID');if(entry.cursor<=previous)continue;cursor=entry.cursor;db.prepare('INSERT INTO outbox_event(type,payload,occurred_at) VALUES(?,?,?)').run('runner.metadata',JSON.stringify({channel:key,...entry}),Date.now());}
   db.prepare('INSERT INTO p1_runner_cursor VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET cursor=excluded.cursor').run(key,cursor);
  });
  // Receipt loss can replay metadata; Core persisted cursor makes it idempotent.
  await channel.acknowledgeSpool(entries.at(-1)!.cursor);
 };
 const provisioner=new BotProvisioner(app.core.database,new MacOSVMProvider(options.vmHelper),options.downloads);
 const capabilities:P1Capabilities={
  assertAdmitted:options.assertAdmitted,
  provisioner,provisionRequest:options.provisionRequest,
  auth:{begin(){throw Error('OFFICIAL_FLOW_REQUIRED');},inspectAuth(){throw Error('ASYNC_AUTH_INSPECTION_REQUIRED');}},
  asyncAuth:{evidenceKind:'runtime_reported',inspectAuth:(request,environment)=>route(request.runId).auth.inspectAuth(request,environment)},
  nativeAuth:options.nativeAuthRuntime??(options.nativeAuth?createCodexNativeAuthRuntime(options.nativeAuth):undefined),authTarget:options.authTarget,releaseAuth:options.releaseAuth,materialScope:options.projectForBot,
  transport:{
   async receive(command){options.assertAdmitted();const r=route(command.runId);if(command.type==='run.start')await r.channel.prepareRun(startBundle(command));commandRoutes.set(command.commandId,r.channel);return r.channel.receive(command);},
   async query(commandId){const pending=app.core.pendingCommands(100).find(c=>c.commandId===commandId);const channel=commandRoutes.get(commandId)??(pending?routes.get(pending.runId)?.channel:undefined);if(!channel)throw Error('NODE_RECONCILIATION_REQUIRED');return channel.query(commandId);}
  },
  discardPreparation:async runId=>{const route=routes.get(runId);if(!route)return;if(!route.nativeStarted){capabilities.releaseRun?.(runId);return;}let stopped=await route.channel.finishNative(route.binding);if(!stopped?.processTree.complete||stopped.processTree.writableProcesses!==0)stopped=await route.channel.stopNative(route.binding);if(!stopped?.processTree.complete||stopped.processTree.writableProcesses!==0)throw Error('PREPARATION_STOP_UNKNOWN');capabilities.releaseRun?.(runId);},
  reconcilePreparations:async()=>{const committed=new Set(app.core.snapshot().runs.map(r=>r.id));for(const id of [...routes.keys()].filter(id=>!committed.has(id)).slice(0,8))await capabilities.discardPreparation?.(id);},
  releaseRun:runId=>{const r=routes.get(runId);r?.channel.close();routes.delete(runId);for(const [id,channel] of commandRoutes)if(channel===r?.channel)commandRoutes.delete(id);},
  stopEvidence:async r=>{const current=routes.get(r.id);if(current)await drainSpool(current.channel);const ref=current?.installed.stopEvidenceRef?.();if(!current||!ref)return;const observed=await current.channel.observeStop(current.binding,ref);if(observed?.processTree.complete&&observed.processTree.writableProcesses===0&&observed.processTree.state==='stopped')return ref;},
  nodeVerifier:{observeStop:(binding,evidenceRef)=>route(binding.runId).channel.observeStop(binding,evidenceRef)},
  async binding(r,sandboxId){
   options.assertAdmitted();const existing=routes.get(r.id);if(existing)return existing.binding;if([...routes.values()].some(route=>route.botId===r.botId))throw Error('NODE_RECONCILIATION_REQUIRED');const installed=await options.connectRun(r,sandboxId);options.assertAdmitted();const b=installed.binding;
   if(b.runId!==r.id||b.sandboxId!==sandboxId||b.generation!==r.generation||b.fencingToken!==r.fencingToken||b.sessionId!==r.sessionId||b.turnId!==r.turnId)throw Error('RUN_BINDING_MISMATCH');
   installed.assertSandbox(b);
   const channel=new NodeRunnerChannel(installed.stream,installed.key,{nodeId:b.nodeId,sandboxId:b.sandboxId,generation:b.generation,transportInstanceId:b.transportInstanceId},{port:createCoreApprovalPort(app.approvals,{runtimeVersion:'0.159.2'}),authorizeBinding:(execution,approval)=>{if(canonicalDigest(execution)!==canonicalDigest(b))throw Error('APPROVAL_BINDING_MISMATCH');authorizeApproval(approval,false);}});
   const profile=options.profile(r);const auth=new CodexAuthAdapter({runtimeEvidence:'verified_sandbox_runtime',binding:b,botId:r.botId,runtime:profile.runtime,driver:channel.remoteDriver(),botDirectory:profile.botDirectory,home:`${profile.botDirectory}/home`,configuration:'clean',assertSandbox:installed.assertSandbox,assertRuntimeEnvironment:installed.assertRuntimeEnvironment});const route={channel,binding:b,auth,installed,botId:r.botId,nativeStarted:false};routes.set(r.id,route);
   const prior=options.verification?.continuation?.(r);
   if(prior){const captured=await channel.captureCandidate(b);if(canonicalDigest(captured.binding)!==canonicalDigest(b)||captured.candidateDigest!==prior.candidateDigest)throw Error('CONTINUATION_MISMATCH');const input=options.verification!.store.captureTransferred(captured);app.core.database.prepare('INSERT INTO p1_run_input VALUES(?,?,?)').run(r.id,input.digest,input.ref);}
   const driver=channel.remoteDriver();route.nativeStarted=true;await driver.initialize({binding:b,runtimeVersion:'0.159.2'});await installed.attestRuntime?.(channel);return b;
  },
  request(r,b,connectionId):ResolveRequest{const profile=options.profile(r);return {executionMode:'live',executionBinding:b,userId:'local-user',projectId:profile.projectId,botId:r.botId,nodeId:b.nodeId,generation:r.generation,action:'model.request',defaultConnectionId:connectionId,explicitConnectionId:connectionId,runId:r.id,taskId:r.taskId,runtimeSessionRef:r.sessionId,runtime:profile.runtime,model:profile.model,budget:profile.budget,expiresAt:r.leaseExpiresAt,nodeLocation:'local',processingSources:[{stage:'model',location:'remote'}],requireAccount:profile.requireAccount,requireKnownBilling:profile.requireKnownBilling,runtimePolicy:{nativeLoginAllowed:true,authMethods:['runtime_managed_login']}};},
  context:r=>options.profile(r).context,
  preflight:async(command,request)=>{const r=route(command.runId);await r.installed.attestRuntime?.(r.channel);await r.auth.preflight(command,app.connections.snapshot(command.resolvedConnectionRef),request,app.resolver);},
  driver:runId=>{const r=routes.get(runId);return r?{binding:r.binding,driver:r.channel.remoteDriver()}:undefined;},
  revalidateApproval:binding=>{try{authorizeApproval(binding);return true;}catch{return false;}},
  evidenceAuthority:{assertIssued:record=>{const worker=workers.get(record.taskId);if(!worker)throw Error('UNTRUSTED_EVIDENCE');worker.assertIssued(record);},assertArtifacts:record=>(()=>{if(!options.verification)throw Error('ISOLATED_VERIFIER_REQUIRED');options.verification.store.resolve(record.immutableSnapshotRef,record.candidateDigest);})()},
  verification:{
   async prepare(r){options.assertAdmitted();const config=options.verification;if(!config)throw Error('ISOLATED_VERIFIER_REQUIRED');const contract=config.contract(r),current=route(r.id),snapshot=await config.capture(r,current.binding,current.channel);config.store.resolve(snapshot.ref,snapshot.digest);const prior=config.continuation?.(r);if(prior&&app.core.database.prepare('SELECT candidate_digest FROM p1_run_input WHERE run_id=?').get(r.id)?.candidate_digest!==prior.candidateDigest)throw Error('CONTINUATION_MISMATCH');const executor=config.executor(r,current.binding);if(executor.source!=='isolated-verifier')throw Error('ISOLATED_VERIFIER_REQUIRED');workers.set(r.taskId,new VerificationWorker({store:config.store,oraclePath:config.oraclePath,contract,executor}));return {input:{taskId:r.taskId,taskRevision:r.taskRevision,candidateDigest:snapshot.digest,immutableSnapshotRef:snapshot.ref,...contract,...(config.continuation?.(r)?{continuation:config.continuation(r)}:{}),executionKind:'live',platform:executor.platform,capabilities:executor.capabilities}};},
   async verifyCandidate(input){const worker=workers.get(input.taskId);if(!worker)throw Error('ISOLATED_VERIFIER_REQUIRED');return worker.verifyCandidate(input);}
  }
 };
 if(options.prepareInstalled)capabilities.prepareReadiness=async(r,sandboxId,connectionId)=>{const binding=await capabilities.binding(r,sandboxId),current=route(r.id);if(!current.installed.attestRuntime)throw Error('NODE_CONTAINMENT_ATTESTATION_REQUIRED');const operationId=app.environment(r.botId).operationId;await provisioner.adoptInstalled(operationId,{sandboxId,generation:r.generation},async()=>{await current.installed.attestRuntime!(current.channel);});const request=capabilities.request(r,binding,connectionId);const actual=await current.auth.inspectAuth(request);provisioner.observeReadiness(operationId,{protocolVersion:2,sandboxId,generation:r.generation,environment:true,runner:true,runtime:true,auth:actual.status==='valid',evidenceKind:'live',observedAt:Date.now()});};
 return capabilities;
}
