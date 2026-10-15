import {randomUUID} from 'node:crypto';
import type {EnvironmentInput} from '../../contracts/src/events.js';
import type {SandboxObservation} from '../../contracts/src/sandbox.js';
import type {ExecutionBinding} from '../../execution/src/contracts.js';
import {assertExecutionBinding,assertTrustedStop} from '../../execution/src/runner-client.js';
import {MacOSVMProvider,type VMHelperTransport} from '../../execution/src/providers/macos-vm.js';
import {NodeRunnerChannel} from '../../../apps/node-agent/src/channel.js';
import {transaction} from '../../persistence/src/unit-of-work.js';
import {BotProvisioner,inspectProvision,type ProvisionRecord} from './bot-provision.js';
import {canonicalDigest} from './approvals.js';
import type {P1Application} from './p1-application.js';
import type {InstalledRunChannel} from './p1-composition.js';
import type {Run} from './control.js';

export type EnvironmentAction='inspect'|'create-sandbox'|'start-sandbox'|'connect'|'initialize-runtime'|'stop';
export interface EnvironmentConfiguration {
 target:{targetId:string;botId:string;nodeId:string;sandboxId:string;generation:number;transportInstanceId:string;expiresAt:number};
 vmHelper?:VMHelperTransport;
 sandboxProvider?:import('../../contracts/src/sandbox.js').SandboxProvider;
 /** owned=true permits only the original scoped cleanup after expiry/revocation. */
 assertAction(action:EnvironmentAction,owned?:boolean):void;
 connectRun(run:Run,sandboxId:string,assertCurrent:()=>void):Promise<InstalledRunChannel>;
 verifyInstallation?():Promise<void>;
}
/** Sole Core entry for supervised initialization, never a Task/model/login or installer. */
export class P1EnvironmentInitializer {
 private readonly provider:import('../../contracts/src/sandbox.js').SandboxProvider;
 private readonly provisioner:BotProvisioner;
 private pending?:{digest:string;operationId:string;work:Promise<ProvisionRecord>};
 constructor(private readonly app:P1Application,private readonly options:EnvironmentConfiguration){
  if((options.vmHelper?1:0)+(options.sandboxProvider?1:0)!==1)throw Error('EXACTLY_ONE_SANDBOX_PROVIDER_REQUIRED');
  this.provider=options.sandboxProvider??new MacOSVMProvider(options.vmHelper!);
  // adoptInstalled does not use the download seam; no second catalog/install path.
  this.provisioner=new BotProvisioner(app.core.database,this.provider);
 }
 prepare(input:EnvironmentInput):Promise<ProvisionRecord>{try{return this.start(input).completion;}catch(error){return Promise.reject(error);}}
 start(input:EnvironmentInput):{operationId:string;completion:Promise<ProvisionRecord>}{
   for(const action of ['inspect','create-sandbox','start-sandbox','connect','initialize-runtime','stop'] as const)this.options.assertAction(action);
   const target=this.options.target;
   if(target.expiresAt<=Date.now()||input.botId!==target.botId)throw Error('ENVIRONMENT_ADMISSION_REQUIRED');
   const digest=canonicalDigest(input);
   if(this.pending){if(this.pending.digest!==digest)throw Error('ENVIRONMENT_BUSY');return {operationId:this.pending.operationId,completion:this.pending.work};}
   const db=this.app.core.database,bot=this.app.core.snapshot().bots.find(b=>b.id===input.botId);
   if(!bot||bot.owner!=='local-user'||bot.sandboxId!==target.sandboxId||bot.generation!==target.generation)throw Error('ENVIRONMENT_BINDING_MISMATCH');
   if(this.app.core.snapshot().runs.some(r=>r.botId===bot.id&&r.slotHeld)||this.app.connections.all<any>('auth_flows').some(f=>f.botId===bot.id&&['waiting','cancel_unknown'].includes(this.app.authFlows.status(f.id).status)))throw Error('ACTIVE_RUN');
   const prior=db.prepare('SELECT request_hash,result FROM p1_desktop_command WHERE command_id=?').get(input.commandId);
   if(prior){if(prior.request_hash!==digest)throw Error('IDEMPOTENCY_CONFLICT');const result=JSON.parse(String(prior.result)) as ProvisionRecord;return {operationId:result.operationId,completion:Promise.resolve(result)};}
   if(bot.version!==input.expectedVersion)throw Error('VERSION_CONFLICT');
   const record=inspectProvision(db,this.app.environment(bot.id).operationId);
   if(record.initialization)throw Error('ENVIRONMENT_STATE_UNKNOWN');
   this.epoch();
   const registered=JSON.stringify(record);
   transaction(db,()=>{
    this.epoch();if(JSON.stringify(inspectProvision(db,record.operationId))!==registered)throw Error('ENVIRONMENT_STATE_UNKNOWN');
    const token=Number(db.prepare("SELECT value FROM core_metadata WHERE key='fencing_token'").get()?.value)+1;
    if(!Number.isSafeInteger(token)||token<1)throw Error('INVALID_FENCING_TOKEN');
    db.prepare("UPDATE core_metadata SET value=? WHERE key='fencing_token'").run(token);
    record.initialization={commandId:input.commandId,requestDigest:digest,ownerEpoch:this.app.core.epoch,fencingToken:token,expectedVersion:input.expectedVersion};
    record.stage='blocked';record.errorCode='ENVIRONMENT_STATE_UNKNOWN';record.liveReady=false;
    record.readiness={environment:false,runner:false,runtime:false,auth:false};delete record.readinessObservedAt;
    this.save(record);
   });
   const work=this.perform(record,input).finally(()=>{this.pending=undefined;});this.pending={digest,operationId:record.operationId,work};return {operationId:record.operationId,completion:work};
 }
 async settle(){await this.pending?.work.catch(()=>{});}
 allowsBot(botId:string){try{this.options.assertAction('initialize-runtime');return botId===this.options.target.botId&&this.options.target.expiresAt>Date.now();}catch{return false;}}
 private epoch(){if(Number(this.app.core.database.prepare("SELECT value FROM core_metadata WHERE key='epoch'").get()?.value)!==this.app.core.epoch)throw Error('STALE_CORE_EPOCH');}
 private own(record:ProvisionRecord){
  this.epoch();const current=inspectProvision(this.app.core.database,record.operationId),intent=record.initialization;
  const owner=(v:ProvisionRecord['initialization'])=>v&&{commandId:v.commandId,requestDigest:v.requestDigest,ownerEpoch:v.ownerEpoch,fencingToken:v.fencingToken,expectedVersion:v.expectedVersion,binding:v.binding??null};
  if(!intent||intent.ownerEpoch!==this.app.core.epoch||canonicalDigest(owner(current.initialization))!==canonicalDigest(owner(intent))||current.botId!==record.botId||current.sandboxId!==record.sandboxId)throw Error('STALE_ENVIRONMENT_OWNER');
  if(this.app.core.snapshot().runs.some(r=>r.botId===record.botId&&r.slotHeld))throw Error('ACTIVE_RUN');
 }
 private authorize(record:ProvisionRecord,action:EnvironmentAction){this.own(record);const bot=this.app.core.snapshot().bots.find(b=>b.id===record.botId);if(!bot||bot.owner!=='local-user'||bot.version!==record.initialization?.expectedVersion||bot.sandboxId!==this.options.target.sandboxId||bot.generation!==this.options.target.generation)throw Error('ENVIRONMENT_BINDING_MISMATCH');this.options.assertAction(action);if(this.options.target.expiresAt<=Date.now())throw Error('ENVIRONMENT_ADMISSION_REQUIRED');}
 private save(record:ProvisionRecord){const updated=this.app.core.database.prepare("UPDATE bot_provision SET record=? WHERE operation_id=? AND (SELECT value FROM core_metadata WHERE key='epoch')=?").run(JSON.stringify(record),record.operationId,this.app.core.epoch);if(updated.changes!==1)throw Error('STALE_CORE_EPOCH');}
 private observation(actual:SandboxObservation,state:SandboxObservation['state'],generation:number){
  if(actual.protocolVersion!==1||actual.sandboxId!==this.options.target.sandboxId||actual.generation!==generation||actual.state!==state||actual.evidenceKind!=='live'||!Number.isFinite(actual.observedAt)||actual.observedAt>Date.now()||Date.now()-actual.observedAt>30000)throw Error('ENVIRONMENT_OBSERVATION_REQUIRED');
 }
 private async perform(record:ProvisionRecord,input:EnvironmentInput):Promise<ProvisionRecord>{
  const target=this.options.target,intent=record.initialization!;
  let ownedVM=false,channel:NodeRunnerChannel|undefined,installed:InstalledRunChannel|undefined,nativeIssued=false;
  let failed:unknown,stopFailed=false,binding:ExecutionBinding|undefined;
  try{
   if(record.generation===0){this.authorize(record,'inspect');await this.options.verifyInstallation?.();this.authorize(record,'inspect');}
   this.authorize(record,'inspect');const current=await this.provider.inspect({sandboxId:record.sandboxId,generation:record.generation});this.authorize(record,'inspect');
   if(current.state==='running'){this.observation(current,'running',target.generation);}
   else{
    if(record.generation!==0||target.generation!==1)throw Error('ENVIRONMENT_RESTART_ADMISSION_REQUIRED');
    if(current.state==='absent'){
     this.observation(current,'absent',0);this.authorize(record,'create-sandbox');
     const created=await this.provider.create({operationId:record.operationId,botId:record.botId,sandboxId:record.sandboxId});this.authorize(record,'create-sandbox');this.observation(created,'created',0);
    }else this.observation(current,'created',0);
    this.authorize(record,'start-sandbox');const started=await this.provider.start({sandboxId:record.sandboxId,generation:0});
    this.observation(started,'running',1);ownedVM=true;this.own(record);record.generation=1;this.save(record);this.authorize(record,'start-sandbox');
   }
   this.authorize(record,'connect');
   const id=`initialize-${randomUUID()}`;
   const run:Run={id,botId:record.botId,taskId:id,taskRevision:1,commandId:input.commandId,generation:target.generation,fencingToken:intent.fencingToken,ownerEpoch:intent.ownerEpoch,leaseExpiresAt:target.expiresAt,sessionId:id,turnId:id,state:'DISPATCHED',slotHeld:false,version:1,lastSequence:0,stopKind:null,contextManifestRef:'',resolvedConnectionRef:''};
   installed=await this.options.connectRun(run,record.sandboxId,()=>this.authorize(record,'connect'));this.authorize(record,'connect');binding=Object.freeze(structuredClone(installed.binding));assertExecutionBinding(binding);
   if(binding.nodeId!==target.nodeId||binding.sandboxId!==target.sandboxId||binding.generation!==target.generation||binding.transportInstanceId!==target.transportInstanceId||binding.runId!==run.id||binding.fencingToken!==run.fencingToken||binding.sessionId!==run.sessionId||binding.turnId!==run.turnId)throw Error('ENVIRONMENT_BINDING_MISMATCH');
   installed.assertSandbox(binding);intent.binding=structuredClone(binding);this.save(record);
   channel=new NodeRunnerChannel(installed.stream,installed.key,{nodeId:binding.nodeId,sandboxId:binding.sandboxId,generation:binding.generation,transportInstanceId:binding.transportInstanceId});
   this.authorize(record,'initialize-runtime');nativeIssued=true;
   await channel.initializeEnvironment(binding);this.authorize(record,'initialize-runtime');installed.assertSandbox(binding);
   const adopted=await this.provisioner.adoptInstalled(record.operationId,{sandboxId:record.sandboxId,generation:target.generation},async()=>{
    this.authorize(record,'initialize-runtime');const actual=await installed!.attestRuntime?.(channel!);this.authorize(record,'initialize-runtime');
    if(!actual||actual.accountless!==true||actual.containment?.network!=='none'||canonicalDigest(actual.binding)!==canonicalDigest(binding)||actual.observedAt>Date.now()||Date.now()-actual.observedAt>30000)throw Error('ACCOUNTLESS_ATTESTATION_REQUIRED');
   },()=>this.authorize(record,'initialize-runtime'));
   // Never refresh this attempt's immutable owner from a newer reconciliation record.
   Object.assign(record,{generation:adopted.generation,evidenceKind:adopted.evidenceKind,readiness:adopted.readiness,stage:adopted.stage,errorCode:adopted.errorCode});
   this.authorize(record,'initialize-runtime');
  }catch(error){failed=error;}
  finally{
   if(nativeIssued&&channel&&binding){
    try{this.own(record);this.options.assertAction('stop',true);const requestedAt=Date.now();let stopped=await channel.finishNative(binding);
     if(!stopped?.processTree.complete||stopped.processTree.writableProcesses!==0)stopped=await channel.stopNative(binding);
     assertTrustedStop(binding,stopped?.evidenceRef??'',stopped,requestedAt);intent.cleanup={native:true,vm:!ownedVM};
    }catch{stopFailed=true;}
   }
   if(ownedVM){try{this.own(record);this.options.assertAction('stop',true);const stopped=await this.provider.stop({sandboxId:record.sandboxId,generation:target.generation});this.observation(stopped,'stopped',target.generation);intent.cleanup={native:!nativeIssued||intent.cleanup?.native===true,vm:true};}catch{stopFailed=true;}}
   channel?.close();installed?.stream.destroy();installed?.key.fill(0);
  }
  // Loss of owner/epoch must never overwrite the new Core's reconciliation state.
  this.own(record);
  if(!failed&&!stopFailed){try{this.authorize(record,'initialize-runtime');}catch(error){failed=error;}}
  record.initialization=intent;
  if(failed||stopFailed){record.stage='blocked';record.liveReady=false;record.readiness={environment:false,runner:false,runtime:false,auth:false};record.errorCode='ENVIRONMENT_STATE_UNKNOWN';this.save(record);throw stopFailed?Error('ENVIRONMENT_STOP_UNKNOWN'):failed;}
  record.readiness={environment:true,runner:true,runtime:true,auth:false};record.liveReady=false;record.stage='environment-ready';record.evidenceKind='live';record.readinessObservedAt=Date.now();delete record.errorCode;
  intent.completedAt=Date.now();record.initialization=intent;
  transaction(this.app.core.database,()=>{this.own(record);this.save(record);this.app.core.database.prepare('INSERT INTO p1_desktop_command VALUES(?,?,?)').run(input.commandId,intent.requestDigest,JSON.stringify(record));});return structuredClone(record);
 }
}
export function createP1EnvironmentInitializer(app:P1Application,options:EnvironmentConfiguration){return new P1EnvironmentInitializer(app,options);}
