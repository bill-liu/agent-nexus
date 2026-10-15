import {PodmanDesktopPreparation,podmanPreparationPlan} from './podman-preparation.js';
import {parseEnvironmentInput} from '../../contracts/src/events.js';
import {readP1ProtectedJSON,readP1Admission,readP1EnvironmentAdmission,installAdmissionMetadata} from './p1-admission.js';
import {createConfiguredP1Capabilities,createConfiguredEnvironmentInitializer} from './p1-installed.js';
import type {AuthInput,AuthView,MaterialInput} from '../../contracts/src/events.js';
import type {FlowTarget} from '../../connections/src/auth-flow.js';
import {dirname,join} from 'node:path';
import {CoreStore} from './store.js';
import {AsyncApplication} from './application.js';
import {ApprovalService,canonicalDigest,type ApprovalBinding} from './approvals.js';
import {CoreEvidenceService} from './evidence.js';
import {registerProvision,inspectProvision,type BotProvisioner,type ProvisionRequest} from './bot-provision.js';
import {parseCommand,type Command} from '../../contracts/src/commands.js';
import type {RuntimeDriver} from '../../contracts/src/runtime-driver.js';
import type {EvidenceAuthority,VerificationInput,EvidenceRecord} from '../../contracts/src/evidence.js';
import type {AsyncRunnerTransport,ExecutionBinding,TrustedNodeVerifier} from '../../execution/src/contracts.js';
import type {ExecutionCommand,Run} from './control.js';
import {AssetRegistry,AssetBindings,ContextAssembler,type AssembleContext} from '../../assets/src/index.js';
import {ConnectionStore,ConnectionRegistry,GrantService,LeaseService,ConnectionResolver,AuthFlowService,type AuthInspector,type AsyncAuthInspector,type ResolveRequest,type NativeAuthFlowRuntime,type AuthInspection} from '../../connections/src/index.js';
import {transaction} from '../../persistence/src/unit-of-work.js';

/** Registered by the integration owner's migration, on the single Core database. */
export { P1_APPLICATION_SCHEMA } from '../../persistence/src/p1-schema.js';
interface BotConfiguration {bot_id:string;operation_id:string;connection_id:string|null}
export interface P1Capabilities {
 /** Trusted B admission; never populated from a renderer payload or environment discovery. */
 assertAdmitted():void;
 transport:AsyncRunnerTransport;nodeVerifier:TrustedNodeVerifier;
 auth:AuthInspector & {begin():void};asyncAuth:AsyncAuthInspector;
 secretBackend?:'macos_safe_storage';nativeAuth?:NativeAuthFlowRuntime;authTarget?:(botId:string,connectionId:string)=>FlowTarget;releaseAuth?:(flowId:string)=>Promise<void>;materialScope?:(botId:string)=>string;evidenceAuthority?:EvidenceAuthority;
 provisioner?:BotProvisioner;
 provisionRequest?(botId:string,operationId:string,sandboxId:string):ProvisionRequest;
 releaseRun?(runId:string):void;discardPreparation?(runId:string):Promise<void>;reconcilePreparations?():Promise<void>;
 stopEvidence?(run:Run):Promise<string|undefined>;
 prepareReadiness?(run:Run,sandboxId:string,connectionId:string):Promise<void>;
 binding(run:Run,sandboxId:string):Promise<ExecutionBinding>;
 request(run:Run,binding:ExecutionBinding,connectionId:string):ResolveRequest;
 context(run:Run):Omit<AssembleContext,'runId'|'turnId'|'scope'> & {projectId:string};
 preflight(command:ExecutionCommand,request:ResolveRequest):Promise<void>;
 driver(runId:string):{binding:ExecutionBinding;driver:RuntimeDriver}|undefined;
 revalidateApproval(binding:ApprovalBinding):boolean;
 verification?:{prepare(run:Run):Promise<{input:VerificationInput;continuation?:{evidenceId:string;inputCandidateDigest:string}}>;verifyCandidate(input:VerificationInput):Promise<EvidenceRecord>};
}
const blocked=():never=>{throw Error('B_ADMISSION_REQUIRED');};
const blockedAuth:AuthInspector & {begin():void}={begin:blocked,inspectAuth:blocked};
/** One durable Core, no FakeRuntime, fake grant, implicit Connection, or host CLI. */
export class P1Application {
 static fromAdmission(path:string,admissionPath=''){
  if(!admissionPath)return new P1Application(path);
  const raw=readP1ProtectedJSON(admissionPath) as {purpose?:unknown};
  if(raw?.purpose==='podman-environment-prepare')return new P1Application(path,undefined,app=>new PodmanDesktopPreparation(app,admissionPath));
  if(raw?.purpose==='environment-initialize'){const admission=readP1EnvironmentAdmission(admissionPath);return new P1Application(path,undefined,app=>createConfiguredEnvironmentInitializer(app,admissionPath,admission));}
  const admission=readP1Admission(admissionPath),app=new P1Application(path,admission.runtimeConfigPath?a=>createConfiguredP1Capabilities(a,admissionPath,admission):undefined);
  try{installAdmissionMetadata(app,admission);if(!admission.runtimeConfigPath)app.installationBlocked();return app;}catch(error){app.close();throw error;}
 }
 readonly core:CoreStore;readonly assets:AssetRegistry;readonly bindings:AssetBindings;readonly context:ContextAssembler;
 readonly connections:ConnectionStore;readonly registry:ConnectionRegistry;readonly grants:GrantService;readonly leases:LeaseService;
 readonly resolver:ConnectionResolver;readonly approvals:ApprovalService;readonly authFlows:AuthFlowService;readonly evidence:CoreEvidenceService;readonly execution:AsyncApplication;
 private installationError:string|null=null;
 private readonly capabilities?:P1Capabilities;private closed=false;private schedulerError:string|null=null;private pumping?:Promise<void>;
 private readonly environmentInitializer?:import('./p1-environment.js').P1EnvironmentInitializer|PodmanDesktopPreparation;
 constructor(path:string,configure?:(app:P1Application)=>P1Capabilities,configureEnvironment?:(app:P1Application)=>import('./p1-environment.js').P1EnvironmentInitializer|PodmanDesktopPreparation){
  if(configure&&configureEnvironment)throw Error('ENVIRONMENT_MODE_EXCLUSIVE');
  this.core=new CoreStore(path);
  this.assets=new AssetRegistry(this.core.database,join(dirname(path),'p1-assets'));this.bindings=new AssetBindings(this.assets);this.context=new ContextAssembler(this.assets,this.bindings);
  this.connections=new ConnectionStore(this.core.database);this.registry=new ConnectionRegistry(this.connections);this.grants=new GrantService(this.connections);this.leases=new LeaseService(this.connections);
  this.approvals=new ApprovalService(this.core.database,{trustedActor:()=> 'local-user',authorizeDecision:(actor,b)=>actor==='local-user'&&this.bot(b.botId).owner===actor,revalidate:b=>this.revalidateApproval(b)});
  try{this.capabilities=configure?.(this);this.environmentInitializer=configureEnvironment?.(this);}catch(error){this.core.close();throw error;}
  this.resolver=new ConnectionResolver(this.registry,this.grants,this.capabilities?.auth??blockedAuth,this.leases,this.capabilities?.secretBackend?{secretBackend:this.capabilities.secretBackend}:undefined);
  this.authFlows=new AuthFlowService(this.connections,this.registry,this.capabilities?.auth??blockedAuth,Date.now,[],this.capabilities?.nativeAuth);
  this.evidence=new CoreEvidenceService(this.core,this.capabilities?.evidenceAuthority??{assertIssued:blocked,assertArtifacts:blocked});
  this.execution=new AsyncApplication(this.core,this.capabilities?.transport??{receive:async()=>blocked(),query:async()=>blocked()},
   {prepare:(run,sandbox)=>this.prepare(run,sandbox),authorizeNow:command=>this.authorize(command),discardPrepared:run=>this.capabilities?.discardPreparation?.(run.id)??Promise.resolve(),preflight:async command=>{const request=this.requestFor(command.runId);await this.capabilities!.preflight(command,request);}},this.capabilities?.nodeVerifier??{observeStop:async()=>null});
 }
 private bot(id:string){const bot=this.core.snapshot().bots.find(b=>b.id===id);if(!bot||bot.owner!=='local-user')throw Error('NOT_AUTHORIZED');return bot;}
 private config(id:string){const row=this.core.database.prepare('SELECT * FROM p1_bot_configuration WHERE bot_id=?').get(id);if(!row)throw Error('P1_CONFIGURATION_REQUIRED');return row as unknown as BotConfiguration;}
 private revalidateApproval(binding:ApprovalBinding):boolean{try{this.capabilities?.assertAdmitted();const run=this.core.snapshot().runs.find(r=>r.id===binding.runId);return !!this.capabilities&&!!run&&run.slotHeld&&!run.stopKind&&run.botId===binding.botId&&run.turnId===binding.turnId&&run.sessionId===binding.sessionId&&run.taskRevision===binding.taskRevision&&run.generation===binding.nodeGeneration&&this.capabilities.revalidateApproval(binding);}catch{return false;}}
 private requestFor(runId:string):ResolveRequest{const row=this.core.database.prepare('SELECT request FROM p1_run_request WHERE run_id=?').get(runId);if(!row)throw Error('RUN_CONTEXT_REQUIRED');return JSON.parse(String(row.request));}
 private authorize(command:ExecutionCommand){
  const cap=this.capabilities;if(!cap)throw Error('B_ADMISSION_REQUIRED');cap.assertAdmitted();
  const request=this.requestFor(command.runId),manifest=this.context.get(command.contextManifestRef);
  if(command.protocolVersion!==2||request.runId!==command.runId||request.taskId!==command.taskId||request.botId!==command.botId||request.generation!==command.generation||request.runtimeSessionRef!==command.sessionId||canonicalDigest(request.executionBinding)!==canonicalDigest(command.executionBinding)||manifest.runId!==command.runId||manifest.turnId!==command.turnId||manifest.scope.botId!==command.botId)throw Error('RUN_BINDING_MISMATCH');
  // dispatchAsync validates the prepared candidate before inserting its Run. Later sends additionally match the committed Run.
  const run=this.core.snapshot().runs.find(r=>r.id===command.runId);
  if(run&&(run.botId!==command.botId||run.contextManifestRef!==command.contextManifestRef||run.resolvedConnectionRef!==command.resolvedConnectionRef||run.taskRevision!==command.taskRevision||run.turnId!==command.turnId||run.sessionId!==command.sessionId||run.generation!==command.generation||run.fencingToken!==command.fencingToken))throw Error('RUN_BINDING_MISMATCH');
  this.context.assertProcessing(command.contextManifestRef,'inference',request.localOnly?'local':this.registry.get(request.explicitConnectionId!).provider);
  this.resolver.authorizeStart(this.connections.snapshot(command.resolvedConnectionRef),request);
 }
 private async prepare(run:Run,sandboxId:string){const cap=this.capabilities;if(!cap)throw Error('B_ADMISSION_REQUIRED');cap.assertAdmitted();const config=this.config(run.botId);if(config.connection_id&&cap.prepareReadiness)await cap.prepareReadiness(run,sandboxId,config.connection_id);const readiness=this.environment(run.botId);if(!readiness.liveReady)throw Error(readiness.errorCode??'READINESS_REQUIRED');if(!config.connection_id)throw Error('CONNECTION_REQUIRED');const binding=await cap.binding(run,sandboxId);const input=cap.context(run);const assembled=this.context.assemble({...input,runId:run.id,turnId:run.turnId,scope:{botId:run.botId,projectId:input.projectId}});const request=cap.request(run,binding,config.connection_id);if(request.explicitConnectionId!==config.connection_id||request.executionMode!=='live'||canonicalDigest(request.executionBinding)!==canonicalDigest(binding)||request.botId!==run.botId||request.runId!==run.id)throw Error('RUN_BINDING_MISMATCH');this.context.assertProcessing(assembled.manifest.manifestId,'inference',request.localOnly?'local':this.registry.get(config.connection_id).provider);const resolved=await this.resolver.resolveAsync(request,cap.asyncAuth);this.resolver.authorizeStart(resolved,request);this.core.database.prepare('INSERT INTO p1_run_request VALUES(?,?)').run(run.id,JSON.stringify(request));return {binding,contextManifestRef:assembled.manifest.manifestId,resolvedConnectionRef:resolved.id,verifiedAt:Date.now(),expiresAt:run.leaseExpiresAt};}
 private once(command:Command,work:()=>unknown){return transaction(this.core.database,()=>{const hash=canonicalDigest(command);const prior=this.core.database.prepare('SELECT * FROM p1_desktop_command WHERE command_id=?').get(command.commandId);if(prior){if(prior.request_hash!==hash)throw Error('IDEMPOTENCY_CONFLICT');return JSON.parse(String(prior.result));}const result=work();this.core.database.prepare('INSERT INTO p1_desktop_command VALUES(?,?,?)').run(command.commandId,hash,JSON.stringify(result));return result;});}
 async command(value:unknown,subject:string):Promise<unknown>{if(subject!=='local-user')throw Error('UNAUTHORIZED_SUBJECT');const c=parseCommand(value);const botId=c.scope.botId;let result:unknown;
  switch(c.type){
   case 'bot.create':{result=transaction(this.core.database,()=>{const bot=this.core.createBot({commandId:c.commandId,botId,name:c.name,subject});const operationId=`provision-${botId}`;registerProvision(this.core.database,{operationId,botId,sandboxId:bot.sandboxId});this.core.database.prepare('INSERT OR IGNORE INTO p1_bot_configuration VALUES(?,?,NULL)').run(botId,operationId);return bot;});break;}
   case 'work.submit':result=this.core.submit({commandId:c.commandId,botId,taskId:c.taskId,text:c.text,expectedVersion:c.expectedVersion,subject});break;
   case 'bot.pause':result=this.core.setPaused({commandId:c.commandId,botId,paused:c.paused,expectedVersion:c.expectedVersion,subject});break;
   case 'bot.accept':result=this.core.setAcceptingTasks({commandId:c.commandId,botId,accepting:c.accepting,expectedVersion:c.expectedVersion,subject});break;
   case 'connection.select':result=this.once(c,()=>{const bot=this.bot(botId);if(this.connections.all<import('../../connections/src/auth-flow.js').AuthFlowMetadata>('auth_flows').some(f=>f.botId===botId&&['waiting','cancel_unknown'].includes(this.authFlows.status(f.id).status)))throw Error('AUTH_FLOW_ACTIVE');if(bot.version!==c.expectedVersion)throw Error('VERSION_CONFLICT');if(this.core.snapshot().runs.some(r=>r.botId===botId&&r.slotHeld))throw Error('ACTIVE_RUN');const connection=this.registry.get(c.connectionId);if(connection.provider==='fake'||connection.runtimeProfiles.some(p=>p.startsWith('fake')))throw Error('SIMULATED_CONNECTION_DENIED');this.core.database.prepare('UPDATE p1_bot_configuration SET connection_id=? WHERE bot_id=?').run(c.connectionId,botId);this.core.database.prepare('UPDATE bot SET version=version+1 WHERE id=?').run(botId);return {connectionId:c.connectionId,version:this.bot(botId).version};});break;
   case 'run.cancel':case 'run.interrupt':{this.bot(botId);const run=this.core.snapshot().runs.find(r=>r.id===c.runId&&r.botId===botId);if(!run)throw Error('NOT_AUTHORIZED');result=c.type==='run.cancel'?this.core.requestCancel(run.id,{commandId:c.commandId,expectedVersion:c.expectedVersion,subject}):this.core.requestInterrupt(run.id,{commandId:c.commandId,expectedVersion:c.expectedVersion,subject});this.approvals.cancelRun(run.id);break;}
   case 'approval.decide':{const record=this.approvals.get(c.approvalId);if(record.binding.botId!==botId)throw Error('NOT_AUTHORIZED');const bot=this.bot(botId);if(bot.version!==c.expectedVersion)throw Error('VERSION_CONFLICT');const route=this.capabilities?.driver(record.binding.runId);if(!route)throw Error('APPROVAL_TRANSPORT_UNAVAILABLE');this.approvals.decide({id:c.approvalId,expectedRequestHash:c.expectedRequestHash,decision:c.decision});try{result=await route.driver.replyServerRequest({binding:route.binding,approvalId:c.approvalId,expectedRequestHash:c.expectedRequestHash});}catch{result={approvalId:c.approvalId,delivery:'UNKNOWN',effect:'UNKNOWN'};}break;}
  }
  await this.pump();return result;
 }
 /** Dedicated temporary auth channel; state and native login refs never leave Core. */
 async auth(value:AuthInput,subject:string):Promise<AuthView>{
  if(subject!=='local-user')throw Error('UNAUTHORIZED_SUBJECT');
  const input=value as AuthInput;const keys=input?.action==='begin'?['action','botId','expectedVersion']:['action','botId','flowId'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==keys.length||keys.some(k=>!Object.hasOwn(input,k))||!['begin','inspect','cancel','view'].includes(input.action)||typeof input.botId!=='string'||!input.botId)throw Error('INVALID_AUTH_INPUT');
  const bot=this.bot(input.botId),config=this.config(bot.id);let metadata;
  if(input.action==='begin'){
   if(bot.version!==input.expectedVersion)throw Error('VERSION_CONFLICT');
   const cap=this.capabilities;if(!cap?.nativeAuth||!cap.authTarget||!config.connection_id)throw Error('AUTH_FLOW_UNAVAILABLE');
   if(this.connections.all<import('../../connections/src/auth-flow.js').AuthFlowMetadata>('auth_flows').some(f=>f.botId===bot.id&&['waiting','cancel_unknown'].includes(this.authFlows.status(f.id).status)))throw Error('AUTH_FLOW_ALREADY_ACTIVE');
   const target=cap.authTarget(bot.id,config.connection_id);if(target.botId!==bot.id||target.generation!==bot.generation||target.connectionId!==config.connection_id)throw Error('AUTH_FLOW_BINDING_MISMATCH');
   metadata=await this.authFlows.beginAsync({...target,expiresAt:Date.now()+300000});
  }else{
   if(typeof input.flowId!=='string'||!input.flowId||input.flowId.length>256)throw Error('INVALID_AUTH_INPUT');metadata=this.authFlows.status(input.flowId);
   if(metadata.botId!==bot.id||metadata.generation!==bot.generation||metadata.connectionId!==config.connection_id)throw Error('AUTH_FLOW_BINDING_MISMATCH');
   if(input.action==='cancel')metadata=await this.authFlows.cancelAsync(input.flowId);
   if(input.action==='inspect'){
    if(metadata.status!=='waiting'&&metadata.status!=='completed')throw Error('AUTH_FLOW_CANCELLED');
    if(metadata.status==='waiting'){const callback=this.authFlows.callbackBinding(input.flowId);const view=this.authFlows.authorizationView(input.flowId);try{metadata=await this.authFlows.completeAsync({...callback,callbackUrl:view.officialUrl});}catch(error){if(!(error instanceof Error)||error.message!=='AUTH_REQUIRED')throw error;}}
   }
  }
  if(['completed','cancelled'].includes(metadata.status))await this.capabilities?.releaseAuth?.(metadata.id);
  if(metadata.status==='waiting')this.capabilities?.nativeAuth?.assertAuthorized(metadata);
  return {metadata,...(metadata.status==='waiting'?{view:this.authFlows.authorizationView(metadata.id)}:{})};
 }
 /** Main supplies only a system-dialog text selection; no path or executable input. */
 importMaterial(input:MaterialInput,subject:string){
  if(subject!=='local-user')throw Error('UNAUTHORIZED_SUBJECT');const keys=['botId','expectedVersion','kind','name','text'];
  if(!input||Object.keys(input).length!==keys.length||keys.some(k=>!Object.hasOwn(input,k))||!['knowledge','skill','rule'].includes(input.kind)||typeof input.name!=='string'||!input.name||input.name.length>256||typeof input.text!=='string'||Buffer.byteLength(input.text)>1048576)throw Error('INVALID_MATERIAL_INPUT');
  const bot=this.bot(input.botId);if(bot.version!==input.expectedVersion)throw Error('VERSION_CONFLICT');if(this.core.snapshot().runs.some(r=>r.botId===bot.id&&r.slotHeld))throw Error('ACTIVE_RUN');
  const projectId=this.capabilities?.materialScope?.(bot.id)??`preparation:${bot.id}`;const scope={botId:bot.id,projectId};const id=`material-${canonicalDigest({scope,kind:input.kind,name:input.name,text:input.text})}`;
  const existing=this.core.database.prepare('SELECT id FROM assets_asset WHERE id=?').get(id);
  const material=existing?this.assets.latest(id):this.assets.import({id,title:input.name,source:'system-dialog',content:input.text,kind:input.kind,policy:{mode:'local-only'}});
  this.bindings.bind(id,scope,material.version);if(input.kind==='skill')this.bindings.enableSkill(id,scope);
  return {botId:bot.id,assetId:material.assetId,version:material.version,kind:material.kind,title:material.title,digest:material.digest,policy:material.policy};
 }
 environment(botId:string){const bot=this.bot(botId);const config=this.config(botId);const record=inspectProvision(this.core.database,config.operation_id);let errorCode=record.errorCode;let auth=record.readiness.auth;if(record.liveReady&&(!record.readinessObservedAt||record.readinessObservedAt>Date.now()||record.readinessObservedAt<Date.now()-30000)){auth=false;errorCode='READINESS_STALE';}const sessions=this.connections.all<AuthInspection>('auth_sessions').filter(s=>s.botId===botId&&s.generation===bot.generation);if(sessions.some(s=>s.status==='expired'||s.expiresAt<=Date.now())){auth=false;errorCode='AUTH_EXPIRED';}if(!config.connection_id){auth=false;errorCode=errorCode??'CONNECTION_REQUIRED';}return {...record,preparation:this.environmentInitializer instanceof PodmanDesktopPreparation?this.environmentInitializer.view(botId):podmanPreparationPlan(),canInitialize:!record.initialization&&this.environmentInitializer?.allowsBot(botId)===true,readiness:{...record.readiness,auth},liveReady:record.liveReady&&auth,connectionId:config.connection_id,errorCode:errorCode??(!record.readiness.runner?'RUNNER_REQUIRED':!record.readiness.runtime?'RUNTIME_REQUIRED':!auth?'AUTH_REQUIRED':undefined)};}
 snapshot(){this.approvals.expire();const state=this.core.snapshot();return {...state,mode:'p1-preparation' as const,authFlows:this.connections.all<import('../../connections/src/auth-flow.js').AuthFlowMetadata>('auth_flows').map(f=>this.authFlows.status(f.id)),materials:state.bots.flatMap(bot=>this.assets.list({botId:bot.id,projectId:this.capabilities?.materialScope?.(bot.id)??`preparation:${bot.id}`}).map(b=>{const m=this.assets.version(b.assetId,b.version);return {botId:bot.id,assetId:m.assetId,version:m.version,kind:m.kind,title:m.title,digest:m.digest,policy:m.policy};})),schedulerError:this.installationError??this.schedulerError,environments:state.bots.map(b=>this.environment(b.id)),connections:this.registry.list().filter(c=>c.provider!=='fake'&&!c.runtimeProfiles.some(p=>p.startsWith('fake'))).map(c=>({id:c.id,name:c.name,authMethod:c.authMethod,billingSource:c.billingSource,billingEvidence:c.billingEvidence,route:c.route,status:c.status,revision:c.revision,fallbackPolicy:c.fallbackPolicy})),approvals:this.core.database.prepare('SELECT id FROM approval_requests').all().map(row=>this.approvals.get(String(row.id))).map(a=>({id:a.id,botId:a.binding.botId,runId:a.binding.runId,action:a.action,parameters:a.parameters,requestHash:a.requestHash,status:a.status,expiresAt:a.expiresAt})),contexts:state.runs.filter(r=>r.contextManifestRef).map(r=>this.context.get(r.contextManifestRef)),evidence:state.tasks.map(t=>({taskId:t.id,...this.evidence.inspect(t.id)}))};}
 pump():Promise<void>{if(this.pumping)return this.pumping;this.pumping=(async()=>{try{await this.execution.flush();for(const bot of this.core.snapshot().bots){if(!this.capabilities)continue;await this.execution.dispatch(bot.id);}await this.execution.flush();this.schedulerError=null;}catch(error){this.schedulerError=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'EXECUTION_BLOCKED';}finally{this.pumping=undefined;}})();return this.pumping;}
 /** Trusted Node/coordinator entry only: no renderer method accepts stop proof, candidate, oracle or report. */
 async completeRun(runId:string,stopEvidenceRef:string){
  const cap=this.capabilities;if(!cap)throw Error('B_ADMISSION_REQUIRED');cap.assertAdmitted();
  await this.execution.observeStop(runId,stopEvidenceRef);
  const run=this.core.snapshot().runs.find(r=>r.id===runId);if(!run)throw Error('RUN_NOT_FOUND');
  const task=this.core.snapshot().tasks.find(t=>t.id===run.taskId);
  if(run.slotHeld||task?.status!=='VERIFYING')throw Error('VERIFICATION_NOT_READY');
  if(!cap.verification)throw Error('ISOLATED_VERIFIER_REQUIRED');
  const prepared=await cap.verification.prepare(run);cap.assertAdmitted();
  if(prepared.input.taskId!==run.taskId||prepared.input.taskRevision!==run.taskRevision)throw Error('VERIFICATION_BINDING_MISMATCH');
  const continuation=prepared.input.continuation;this.evidence.freezeAcceptance(prepared.input,continuation?{evidenceId:continuation.evidenceId,inputCandidateDigest:continuation.candidateDigest}:prepared.continuation);
  const report=await cap.verification.verifyCandidate(prepared.input);cap.assertAdmitted();
  this.evidence.persist(report);
  if(report.status==='PASS')this.evidence.acceptCurrent(run.taskId,report.id);
  cap.releaseRun?.(run.id);return this.evidence.inspect(run.taskId);
 }
 /** Bounded trusted completion polling; renderer cannot submit evidence references. */
 async reconcile(){if(!this.capabilities?.stopEvidence)return;try{await this.capabilities.reconcilePreparations?.();}catch{this.schedulerError='PREPARATION_STOP_UNKNOWN';return;}let failed=false;for(const run of this.core.snapshot().runs.filter(r=>r.slotHeld).slice(0,8)){try{const ref=await this.capabilities.stopEvidence(run);if(ref){if(run.stopKind){await this.execution.observeStop(run.id,ref);this.capabilities.releaseRun?.(run.id);}else await this.completeRun(run.id,ref);}}catch(error){failed=true;this.schedulerError=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'VERIFICATION_BLOCKED';}}if(!failed)await this.pump();}
 async provision(botId:string){const cap=this.capabilities;if(!cap?.provisioner||!cap.provisionRequest)throw Error('B_ADMISSION_REQUIRED');cap.assertAdmitted();const bot=this.bot(botId),config=this.config(botId);return cap.provisioner.provision(cap.provisionRequest(botId,config.operation_id,bot.sandboxId));}
 /** Narrow user intent; configuration and lifecycle authority come only from trusted startup. */
 async prepareEnvironment(input:import('../../contracts/src/events.js').EnvironmentInput,subject:string){
  if(subject!=='local-user')throw Error('UNAUTHORIZED_SUBJECT');
  const value=parseEnvironmentInput(input);
  this.bot(value.botId);if(!this.environmentInitializer)throw Error('ENVIRONMENT_ADMISSION_REQUIRED');
  return this.environmentInitializer.prepare(value);
 }
 beginEnvironmentPreparation(input:import('../../contracts/src/events.js').EnvironmentInput,subject:string){
  if(subject!=='local-user')throw Error('UNAUTHORIZED_SUBJECT');const value=parseEnvironmentInput(input);this.bot(value.botId);if(!this.environmentInitializer)throw Error('ENVIRONMENT_ADMISSION_REQUIRED');
  const accepted=this.environmentInitializer.start(value);void accepted.completion.catch(error=>{this.schedulerError=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'ENVIRONMENT_STATE_UNKNOWN';});return {operationId:accepted.operationId,acceptance:'RECEIVED' as const};
 }
 cancelEnvironmentPreparation(input:import('../../contracts/src/events.js').EnvironmentInput,subject:string){if(subject!=='local-user')throw Error('UNAUTHORIZED_SUBJECT');const value=parseEnvironmentInput(input);this.bot(value.botId);if(!(this.environmentInitializer instanceof PodmanDesktopPreparation))throw Error('PODMAN_ADMISSION_REQUIRED');return this.environmentInitializer.cancel(value);}
 async shutdown(){await this.environmentInitializer?.settle();for(const run of this.core.snapshot().runs.filter(r=>r.slotHeld)){this.core.requestCancel(run.id);this.approvals.cancelRun(run.id);}await this.execution.flush().catch(()=>{});const unknownRuns=this.core.snapshot().runs.filter(r=>r.slotHeld).map(r=>r.id);for(const bot of this.core.snapshot().bots){const environment=this.environment(bot.id);if(environment.initialization&&!environment.initialization.completedAt)unknownRuns.push(`environment:${environment.operationId}`);}this.close();return {unknownRuns};}
 installationBlocked(){this.installationError='BLOCKED_CODE_INSTALLED_RUNTIME_REQUIRED';}
 close(){if(!this.closed){this.core.close();this.closed=true;}}
}
