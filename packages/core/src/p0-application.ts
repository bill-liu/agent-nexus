import {dirname,join} from 'node:path';
import {CoreStore} from './store.js';
import type {ExecutionCommand,Run} from './control.js';
import {parseCommand} from '../../contracts/src/commands.js';
import {FakeRuntime} from '../../execution/src/fake-runtime.js';
import {AssetRegistry,AssetBindings,ContextAssembler} from '../../assets/src/index.js';
import {ConnectionStore,ConnectionRegistry,GrantService,FakeAuthAdapter,LeaseService,ConnectionResolver,type ResolveRequest} from '../../connections/src/index.js';

/** P0 composition only. Every execution is a local SQLite simulation, with no CLI or network. */
export class P0Application {
 readonly core:CoreStore;readonly runtime:FakeRuntime;
 readonly assets:AssetRegistry;readonly bindings:AssetBindings;readonly context:ContextAssembler;
 readonly connections:ConnectionStore;readonly registry:ConnectionRegistry;readonly grants:GrantService;
 readonly auth=new FakeAuthAdapter();readonly leases:LeaseService;readonly resolver:ConnectionResolver;
 private closed=false;private schedulerError:string|null=null;
 constructor(path:string){
  this.core=new CoreStore(path);this.runtime=new FakeRuntime(`${path}.fake-runtime`);
  this.assets=new AssetRegistry(this.core.database,join(dirname(path),'p0-assets'));
  this.bindings=new AssetBindings(this.assets);this.context=new ContextAssembler(this.assets,this.bindings);
  this.connections=new ConnectionStore(this.core.database);this.registry=new ConnectionRegistry(this.connections);
  this.grants=new GrantService(this.connections);this.leases=new LeaseService(this.connections);
  this.resolver=new ConnectionResolver(this.registry,this.grants,this.auth,this.leases);
  this.core.database.exec('CREATE TABLE IF NOT EXISTS p0_run_request(run_id TEXT PRIMARY KEY, request TEXT NOT NULL)');
  if(!this.connections.get('connections','p0-local-fake'))this.registry.create({
   id:'p0-local-fake',name:'演示连接（仅本地 FakeRuntime，无模型调用）',provider:'fake',runtimeProfiles:['fake-runtime-v1'],
   authMethod:'local_endpoint',billingSource:'local',billingEvidence:'user_declared',route:'local',endpoint:'http://localhost',
   allowedModels:['fake-model'],dataPolicy:'local_only',allowedNodes:['p0-fake-node'],fallbackPolicy:'deny',status:'ready',revision:1
  });
  for(const bot of this.core.snapshot().bots)this.restoreFakeInspection(bot.id,bot.generation);
  for(const run of this.core.snapshot().runs.filter(r=>r.slotHeld)){
   const observed=this.runtime.inspect(run.id);
   if(observed?.slotHeld)this.core.reconcile(run.id,{kind:'alive',fencingToken:observed.fencingToken});
   else if(observed?.state==='EXITED'&&observed.exitEvidence)this.core.reconcile(run.id,{kind:'exited',fencingToken:observed.fencingToken,evidence:observed.exitEvidence});
   // An absent Runner record is unknown. Never release a slot from cached Core state.
  }
  try{this.pump();}catch{/* Durable queued work remains inspectable; snapshot exposes the block. */}
 }
 private restoreFakeInspection(botId:string,generation:number){
  this.auth.setInspection({botId,nodeId:'p0-fake-node',generation,runtime:'fake-runtime-v1'},
   {status:'valid',authMethod:'local_endpoint',billingSource:'local',billingEvidence:'user_declared',authSessionRef:`fake-auth:${botId}`,
    nodeId:'p0-fake-node',botId,generation,runtime:'fake-runtime-v1',expiresAt:Date.now()+24*60*60*1000});
 }
 command(value:unknown,subject:string,runScheduler=true):unknown{
  if(subject!=='local-user')throw Error('UNAUTHORIZED_SUBJECT');
  const command=parseCommand(value);const botId=command.scope.botId;let result:unknown;
  switch(command.type){
   case 'bot.create':{
    const bot=this.core.createBot({commandId:command.commandId,botId,name:command.name,subject});
    const id=`p0-grant:${botId}`;
    // This grants only the visibly labelled simulation. Replaying create never renews revoked grants.
    if(!this.connections.get('grants',id))this.grants.grant({id,connectionId:'p0-local-fake',userId:subject,projectId:'p0-project',botId,
     nodeId:'p0-fake-node',generation:bot.generation,action:'model.request',approvedBy:subject,expiresAt:Date.now()+24*60*60*1000,maxBudget:0});
    this.restoreFakeInspection(botId,bot.generation);result=bot;break;
   }
   case 'work.submit':result=this.core.submit({commandId:command.commandId,botId,taskId:command.taskId,text:command.text,expectedVersion:command.expectedVersion,subject});break;
   case 'bot.pause':result=this.core.setPaused({commandId:command.commandId,botId,paused:command.paused,expectedVersion:command.expectedVersion,subject});break;
   case 'bot.accept':result=this.core.setAcceptingTasks({commandId:command.commandId,botId,accepting:command.accepting,expectedVersion:command.expectedVersion,subject});break;
   case 'run.cancel':{
    const run=this.core.snapshot().runs.find(r=>r.id===command.runId&&r.botId===botId);if(!run)throw Error('NOT_AUTHORIZED');
    result=this.core.requestCancel(run.id,{commandId:command.commandId,expectedVersion:command.expectedVersion,subject});break;
   }
  }
  if(runScheduler){
   try{this.pump();}catch(error){
    // The command already committed. Preserve its identity on retry even if scheduling failed.
    throw Error(`RESULT_UNKNOWN: command accepted; scheduler blocked: ${error instanceof Error?error.message:'SCHEDULER_BLOCKED'}`);
   }
  }return result;
 }
 prepare(botId:string):Run|null{
  return this.core.dispatch(botId,run=>{
   const assembled=this.context.assemble({runId:run.id,turnId:run.turnId,scope:{projectId:'p0-project',botId},projectPolicy:{mode:'local-only'},
    permissions:{directories:[],network:[],tools:['read'],accounts:[],maxBytes:65536,requireApproval:true},rules:[],maxBytes:65536});
   this.context.assertProcessing(assembled.manifest.manifestId,'inference','local');
   const request:ResolveRequest={userId:'local-user',projectId:'p0-project',botId,nodeId:'p0-fake-node',generation:run.generation,action:'model.request',
    defaultConnectionId:'p0-local-fake',runId:run.id,taskId:run.taskId,runtimeSessionRef:run.sessionId,runtime:'fake-runtime-v1',model:'fake-model',
    budget:0,expiresAt:run.leaseExpiresAt,nodeLocation:'local',processingSources:[{stage:'model',location:'local'}],localOnly:true,requireAccount:false,requireKnownBilling:true,
    allowedBillingSources:['local'],runtimePolicy:{nativeLoginAllowed:false,authMethods:['local_endpoint']}};
   const resolved=this.resolver.resolve(request);this.resolver.authorizeStart(resolved,request);
   this.core.database.prepare('INSERT INTO p0_run_request VALUES (?,?)').run(run.id,JSON.stringify(request));
   return {contextManifestRef:assembled.manifest.manifestId,resolvedConnectionRef:resolved.id};
  });
 }
 private authorize(command:ExecutionCommand):void{
  const row=this.core.database.prepare('SELECT request FROM p0_run_request WHERE run_id=?').get(command.runId);if(!row)throw Error('RUN_CONTEXT_REQUIRED');
  const request=JSON.parse(String(row.request)) as ResolveRequest;
  const run=this.core.snapshot().runs.find(r=>r.id===command.runId);
  if(!run||run.taskRevision!==command.taskRevision||run.sessionId!==command.sessionId||run.turnId!==command.turnId||run.generation!==command.generation||run.contextManifestRef!==command.contextManifestRef||run.resolvedConnectionRef!==command.resolvedConnectionRef)throw Error('RUN_BINDING_MISMATCH');
  const manifest=this.context.get(command.contextManifestRef);
  if(manifest.runId!==run.id||manifest.turnId!==run.turnId||manifest.scope.botId!==run.botId)throw Error('CONTEXT_BINDING_MISMATCH');
  this.context.assertProcessing(manifest.manifestId,'inference','local');
  this.resolver.authorizeStart(this.connections.snapshot(command.resolvedConnectionRef),request);
 }
 flush():void{
  this.core.flushOutbox(this.runtime,command=>this.authorize(command));
  for(const run of this.core.snapshot().runs.filter(r=>r.slotHeld&&r.stopKind)){
   const observed=this.runtime.inspect(run.id);
   if(observed?.slotHeld&&['CANCEL_REQUESTED','INTERRUPT_REQUESTED'].includes(observed.state))this.core.observeExit(run.id,run.fencingToken,this.runtime.exit(run.id,0));
  }
 }
 snapshot(){return {...this.core.snapshot(),schedulerError:this.schedulerError};}
 pump():void{
  try{this.flush();for(const bot of this.core.snapshot().bots)this.prepare(bot.id);this.flush();this.schedulerError=null;}
  catch(error){this.schedulerError=error instanceof Error?error.message:'SCHEDULER_BLOCKED';throw error;}
 }
 shutdown():{unknownRuns:string[]}{
  for(const run of this.core.snapshot().runs.filter(r=>r.slotHeld))this.core.requestCancel(run.id);
  this.flush();const unknownRuns=this.core.snapshot().runs.filter(r=>r.slotHeld).map(r=>r.id);this.close();return {unknownRuns};
 }
 close():void{if(!this.closed){this.runtime.close();this.core.close();this.closed=true;}}
}
