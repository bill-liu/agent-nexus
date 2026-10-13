import { createHmac, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable, Writable, type Duplex } from 'node:stream';
import type { AsyncRunnerTransport, ExecutionCommand, RunnerReceipt, ExecutionBinding, TrustedNodeVerifier, TrustedStopObservation } from '../../../packages/execution/src/contracts';
import type { CoreApprovalPort, RuntimeDriver, DriverNativeAuthTransport, DriverStartTurn, PreparedDriverBundlePort } from '../../../packages/contracts/src/runtime-driver';
import type {RunnerSpool,SpoolEntry} from '../../runner/src/spool';
import type { NativePolicyAttestation } from './control';
import type { ApprovalBinding } from '../../../packages/core/src/approvals';
import { canonicalManifest } from '../../../packages/catalog-client/src/manifest';
export interface NodeChannelBinding { nodeId:string;sandboxId:string;generation:number;transportInstanceId:string }
interface Payload { protocolVersion:2;channel:NodeChannelBinding;id:string;sequence:number;method:'receive'|'query'|'observeStop'|'verifyCandidate'|'nativeOpen'|'nativeWrite'|'nativeRead'|'nativeClose'|'approvalReceive'|'approvalRespond'|'approvalReplay'|'approvalResolved'|'approvalInterruptTurn'|'approvalGet'|'approvalCancel'|'driverInitialize'|'driverStartTurn'|'driverSteer'|'driverInterrupt'|'driverInspectAuth'|'driverReplyServerRequest'|'authLoginStart'|'authLoginCancel'|'authObserveLogin'|'prepareRun'|'attestRuntime'|'spoolReplay'|'spoolAcknowledge'|'finishNative'|'captureCandidate'|'stopNative'|'initializeEnvironment';body:unknown;response:boolean }
interface Frame {payload:Payload;mac:string}
const fingerprint=(value:unknown)=>canonicalManifest(value);
/** Authenticates an already connected private stream (e.g. approved vsock bridge); never discovers host services. */
class AuthenticatedFrames {
 private buffer='';private sendSequence=0;private receiveSequence=0;private readonly nonce=randomBytes(32).toString('hex');private sessionKey?:Buffer;private readonly queued:Omit<Payload,'protocolVersion'|'channel'|'sequence'>[]=[];
 constructor(private readonly stream:Duplex,private readonly secret:Buffer,private readonly binding:NodeChannelBinding,private readonly received:(payload:Payload)=>void,private readonly failed:()=>void,private readonly role:'client'|'server') {
  if(secret.length<32||!binding.nodeId||!binding.sandboxId||!binding.transportInstanceId||!Number.isSafeInteger(binding.generation)||binding.generation<1)throw new Error('NODE_CHANNEL_AUTH_REQUIRED');
  stream.setEncoding('utf8');
  stream.on('data',(chunk:string)=>{
   this.buffer+=chunk;
   if(Buffer.byteLength(this.buffer)>262144){this.close();return;}
   let newline:number;
   while((newline=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);try{this.accept(line);}catch{this.close();return;}}
  });
  const hello={protocolVersion:2,channel:binding,role,nonce:this.nonce};
  stream.write(JSON.stringify({hello,mac:createHmac('sha256',secret).update(fingerprint(hello)).digest('hex')})+'\n');
  stream.on('error',()=>this.failed());stream.on('close',()=>this.failed());stream.on('end',()=>this.failed());
 }
 private mac(payload:Payload):Buffer{return createHmac('sha256',this.sessionKey!).update(fingerprint(payload)).digest();}
 private accept(line:string):void {
  const decoded=JSON.parse(line);
  if(decoded.hello) {
   const hello=decoded.hello;
   if(this.sessionKey||hello.protocolVersion!==2||fingerprint(hello.channel)!==fingerprint(this.binding)||hello.role==this.role||!['client','server'].includes(hello.role)||typeof hello.nonce!=='string'||!/^[a-f0-9]{64}$/.test(hello.nonce)||typeof decoded.mac!=='string'||!/^[a-f0-9]{64}$/.test(decoded.mac))throw new Error('NODE_CHANNEL_INVALID');
   const expected=createHmac('sha256',this.secret).update(fingerprint(hello)).digest();
   if(!timingSafeEqual(expected,Buffer.from(decoded.mac,'hex')))throw new Error('NODE_CHANNEL_INVALID');
   const nonces=this.role==='client'?this.nonce+hello.nonce:hello.nonce+this.nonce;
   this.sessionKey=createHmac('sha256',this.secret).update('an-node-session-v2:'+nonces).digest();
   for(const value of this.queued.splice(0))this.send(value);return;
  }
  if(!this.sessionKey)throw new Error('NODE_CHANNEL_AUTH_REQUIRED');
  const frame=decoded as Frame;const p=frame.payload;
  if(!p||p.protocolVersion!==2||fingerprint(p.channel)!==fingerprint(this.binding)||p.sequence!==this.receiveSequence+1||typeof p.id!=='string'||!p.id||p.id.length>128||typeof p.response!=='boolean'||!['receive','query','observeStop','verifyCandidate','nativeOpen','nativeWrite','nativeRead','nativeClose','approvalReceive','approvalRespond','approvalReplay','approvalResolved','approvalInterruptTurn','approvalGet','approvalCancel','driverInitialize','driverStartTurn','driverSteer','driverInterrupt','driverInspectAuth','driverReplyServerRequest','authLoginStart','authLoginCancel','authObserveLogin','prepareRun','attestRuntime','spoolReplay','spoolAcknowledge','finishNative','captureCandidate','stopNative','initializeEnvironment'].includes(p.method)||typeof frame.mac!=='string'||!/^[a-f0-9]{64}$/.test(frame.mac))throw new Error('NODE_CHANNEL_INVALID');
  if(!timingSafeEqual(this.mac(p),Buffer.from(frame.mac,'hex')))throw new Error('NODE_CHANNEL_INVALID');
  this.receiveSequence++;this.received(p);
 }
 send(value:Omit<Payload,'protocolVersion'|'channel'|'sequence'>):void {
  if(!this.sessionKey){if(this.queued.length>=32)throw new Error('NODE_CHANNEL_BACKPRESSURE');this.queued.push(value);return;}
  const payload:Payload={...value,protocolVersion:2,channel:this.binding,sequence:++this.sendSequence};
  const line=JSON.stringify({payload,mac:this.mac(payload).toString('hex')})+'\n';
  if(Buffer.byteLength(line)>262144||this.stream.destroyed)throw new Error('NODE_CHANNEL_UNAVAILABLE');
  // Bounded channel: a slow peer cannot accumulate unlimited trusted-process memory.
  if(this.stream.writableLength>262144){this.close();throw new Error('NODE_CHANNEL_BACKPRESSURE');}
  this.stream.write(line);
 }
 close():void {this.stream.destroy();this.failed();}
}
export class NodeRunnerChannel implements AsyncRunnerTransport,TrustedNodeVerifier {
 private readonly frames:AuthenticatedFrames;
 private readonly pending=new Map<string,{method:Payload['method'];resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 constructor(stream:Duplex,key:Buffer,readonly binding:NodeChannelBinding,private readonly coreApproval?:{port:CoreApprovalPort;authorizeBinding:(execution:ExecutionBinding,approval:ApprovalBinding)=>void}) {
  this.frames=new AuthenticatedFrames(stream,Buffer.from(key),structuredClone(binding),payload=>{
   if(!payload.response&&payload.method.startsWith('approval')) {
    void this.handleApproval(payload);return;
   }
   const pending=this.pending.get(payload.id);
   if(!payload.response||!pending||payload.method!==pending.method){this.frames.close();return;}
   clearTimeout(pending.timer);this.pending.delete(payload.id);
   const body=payload.body as {ok?:boolean;value?:unknown};
   if(body?.ok!==true)pending.reject(new Error('NODE_REQUEST_REFUSED'));else pending.resolve(body.value);
  },()=>{for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('NODE_CHANNEL_DISCONNECTED'));}this.pending.clear();},'client');
 }
 private async handleApproval(payload:Payload):Promise<void> {
  try {
   if(!this.coreApproval)throw new Error('CORE_APPROVAL_UNAVAILABLE');
   const body=payload.body as {binding:ExecutionBinding;input:unknown};const b=body?.binding;
   if(!b||b.nodeId!==this.binding.nodeId||b.sandboxId!==this.binding.sandboxId||b.generation!==this.binding.generation||b.transportInstanceId!==this.binding.transportInstanceId)throw new Error('STALE_SANDBOX');
   const input=body.input as {binding:ApprovalBinding};
   const approval=payload.method==='approvalInterruptTurn'?body.input as ApprovalBinding:input?.binding;
   if(!approval||approval.runId!==b.runId||approval.sessionId!==b.sessionId||approval.turnId!==b.turnId||approval.nodeId!==b.nodeId||approval.nodeGeneration!==b.generation)throw new Error('APPROVAL_BINDING_MISMATCH');
   this.coreApproval.authorizeBinding(b,approval);
   const port=this.coreApproval.port;let value:unknown;
   switch(payload.method){
    case 'approvalReceive':value=await port.receive(body.input as Parameters<CoreApprovalPort['receive']>[0]);break;
    case 'approvalRespond':value=await port.respond(body.input as Parameters<CoreApprovalPort['respond']>[0]);break;
    case 'approvalReplay':value=await port.replay(body.input as Parameters<CoreApprovalPort['replay']>[0]);break;
    case 'approvalResolved':value=await port.resolved(body.input as Parameters<CoreApprovalPort['resolved']>[0]);break;
    case 'approvalInterruptTurn':value=await port.interruptTurn(approval);break;
    case 'approvalGet':value=await port.get(body.input as Parameters<CoreApprovalPort['get']>[0]);break;
    case 'approvalCancel':value=await port.cancel(body.input as Parameters<CoreApprovalPort['cancel']>[0]);break;
    default:throw new Error('APPROVAL_METHOD_UNSUPPORTED');
   }
   this.frames.send({id:payload.id,method:payload.method,body:{ok:true,value},response:true});
  }catch{try{this.frames.send({id:payload.id,method:payload.method,body:{ok:false},response:true});}catch{this.frames.close();}}
 }
 captureCandidate(binding:ExecutionBinding):Promise<import('../../verification-worker/src/candidate').SnapshotTransfer&{binding:ExecutionBinding}>{return this.request('captureCandidate',{binding}) as Promise<import('../../verification-worker/src/candidate').SnapshotTransfer&{binding:ExecutionBinding}>;}
 initializeEnvironment(binding:ExecutionBinding):Promise<void>{return this.request('initializeEnvironment',{binding}) as Promise<void>;}
 stopNative(binding:ExecutionBinding):Promise<TrustedStopObservation|null>{return this.request('stopNative',{binding}) as Promise<TrustedStopObservation|null>;}
 finishNative(binding:ExecutionBinding):Promise<TrustedStopObservation|null>{return this.request('finishNative',{binding}) as Promise<TrustedStopObservation|null>;}
 replaySpool():Promise<SpoolEntry[]>{return this.request('spoolReplay',{}) as Promise<SpoolEntry[]>;}
 acknowledgeSpool(cursor:number):Promise<void>{return this.request('spoolAcknowledge',{cursor}) as Promise<void>;}
 attestRuntime(binding:ExecutionBinding):Promise<NativePolicyAttestation> {return this.request('attestRuntime',{binding}) as Promise<NativePolicyAttestation>;}
 prepareRun(input:DriverStartTurn):Promise<void> {return this.request('prepareRun',input) as Promise<void>;}
 remoteAuthTransport(binding:ExecutionBinding):DriverNativeAuthTransport {
  return {binding:structuredClone(binding),runtimeVersion:'0.159.2',
   loginStart:input=>this.request('authLoginStart',input) as ReturnType<DriverNativeAuthTransport['loginStart']>,
   loginCancel:input=>this.request('authLoginCancel',input) as ReturnType<DriverNativeAuthTransport['loginCancel']>,
   observeLogin:input=>this.request('authObserveLogin',input) as ReturnType<DriverNativeAuthTransport['observeLogin']>};
 }
 remoteDriver():RuntimeDriver {
  return {
   initialize:input=>this.request('driverInitialize',input) as ReturnType<RuntimeDriver['initialize']>,
   startTurn:input=>this.request('driverStartTurn',input) as ReturnType<RuntimeDriver['startTurn']>,
   steer:input=>this.request('driverSteer',input) as ReturnType<RuntimeDriver['steer']>,
   interrupt:input=>this.request('driverInterrupt',input) as ReturnType<RuntimeDriver['interrupt']>,
   inspectAuth:input=>this.request('driverInspectAuth',input) as ReturnType<RuntimeDriver['inspectAuth']>,
   replyServerRequest:input=>this.request('driverReplyServerRequest',input) as ReturnType<RuntimeDriver['replyServerRequest']>,
  };
 }
 private request(method:Payload['method'],body:unknown):Promise<unknown> {
  if(this.pending.size>=32)return Promise.reject(new Error('NODE_CHANNEL_BACKPRESSURE'));
  return new Promise((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('NODE_CHANNEL_UNKNOWN_DELIVERY'));},method==='verifyCandidate'?180000:15000);timer.unref();this.pending.set(id,{method,resolve,reject,timer});try{this.frames.send({id,method,body,response:false});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
 }
 receive(command:ExecutionCommand):Promise<RunnerReceipt> {return this.request('receive',command) as Promise<RunnerReceipt>;}
 query(commandId:string):Promise<RunnerReceipt|null> {return this.request('query',{commandId}) as Promise<RunnerReceipt|null>;}
 observeStop(binding:ExecutionBinding,evidenceRef:string):Promise<TrustedStopObservation|null> {return this.request('observeStop',{binding,evidenceRef}) as Promise<TrustedStopObservation|null>;}
 async openNativeTransport(binding:ExecutionBinding):Promise<{binding:ExecutionBinding;input:Readable;output:Writable}> {
  await this.request('nativeOpen',{binding});
  let closed=false;let reading=false;let sequence=0;
  const readNext=async()=>{
   if(reading||closed)return;reading=true;
   try {while(!closed){const result=await this.request('nativeRead',{binding}) as {sequence:number;data:string;ended:boolean};if(result.sequence!==++sequence||typeof result.data!=='string'||result.data.length>87384||typeof result.ended!=='boolean')throw new Error('NATIVE_FRAME_INVALID');const data=Buffer.from(result.data,'base64');if(data.toString('base64')!==result.data)throw new Error('NATIVE_FRAME_INVALID');if(data.length&&!input.push(data))break;if(result.ended){closed=true;input.push(null);break;}}}catch(error){closed=true;input.destroy(error as Error);}finally{reading=false;}
  };
  const input=new Readable({read(){void readNext();},destroy:(error,callback)=>{closed=true;void this.request('nativeClose',{binding}).catch(()=>{});callback(error);}});
  const output=new Writable({write:(chunk,_encoding,callback)=>{const data=Buffer.from(chunk);if(data.length>65536){callback(new Error('NATIVE_FRAME_LIMIT'));return;}void this.request('nativeWrite',{binding,data:data.toString('base64')}).then(()=>callback(),()=>callback(new Error('NATIVE_WRITE_UNKNOWN')));},final:callback=>{void this.request('nativeClose',{binding}).then(()=>callback(),()=>callback(new Error('NATIVE_CLOSE_UNKNOWN')));}});
  return {binding:structuredClone(binding),input,output};
 }
 verifyCandidate(request:unknown):Promise<unknown> {return this.request('verifyCandidate',request);}
 close():void {this.frames.close();}
}
/** Guest endpoint, composed with the persistent Runner and trusted Node observer. Key never enters Bot mounts. */
export type NodeGuestEndpoint=(()=>void)&{approvalPort(binding:ExecutionBinding):CoreApprovalPort};
export function serveNodeChannel(stream:Duplex,key:Buffer,binding:NodeChannelBinding,runner:AsyncRunnerTransport,verifier:TrustedNodeVerifier,verificationService?:{verifyCandidate(request:unknown):Promise<unknown>},nativeService?:{open(binding:ExecutionBinding):Promise<unknown>;write(binding:ExecutionBinding,data:string):Promise<unknown>;read(binding:ExecutionBinding):Promise<unknown>;close(binding:ExecutionBinding):Promise<unknown>},driver?:RuntimeDriver,authTransport?:DriverNativeAuthTransport|((binding:ExecutionBinding)=>DriverNativeAuthTransport),bundlePort?:PreparedDriverBundlePort,runtimeAttestation?:{initializeEnvironment?(binding:ExecutionBinding):Promise<void>;attestRuntime(binding:ExecutionBinding):Promise<NativePolicyAttestation>;finishNative?(binding:ExecutionBinding):Promise<TrustedStopObservation|null>;stopNative?(binding:ExecutionBinding):Promise<TrustedStopObservation|null>;captureCandidate?(binding:ExecutionBinding):Promise<import('../../verification-worker/src/candidate').SnapshotTransfer&{binding:ExecutionBinding}>},spool?:Pick<RunnerSpool,'replayAvailable'|'acknowledge'>):NodeGuestEndpoint {
 let active=0;
 const pending=new Map<string,{method:Payload['method'];resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 const frames=new AuthenticatedFrames(stream,Buffer.from(key),structuredClone(binding),payload=>{
  if(payload.response){const request=pending.get(payload.id);if(!request||request.method!==payload.method){frames.close();return;}clearTimeout(request.timer);pending.delete(payload.id);const body=payload.body as {ok:boolean;value:unknown};if(body?.ok===true)request.resolve(body.value);else request.reject(new Error('CORE_APPROVAL_REFUSED'));return;}
  if(active>=32||payload.method.startsWith('approval')){frames.close();return;}active++;
  void (async()=>{
   let value:unknown;
   try {
    if(payload.method==='spoolReplay'||payload.method==='spoolAcknowledge') {
     if(!spool)throw Error('RUNNER_SPOOL_UNAVAILABLE');const body=payload.body as Record<string,unknown>;
     if(!body||typeof body!=='object'||Array.isArray(body))throw Error('INVALID_CURSOR');
     if(payload.method==='spoolReplay'){if(Object.keys(body).length)throw Error('INVALID_CURSOR');value=spool.replayAvailable(100);}
     else {if(Object.keys(body).length!==1||!Number.isSafeInteger(body.cursor))throw Error('INVALID_CURSOR');spool.acknowledge(body.cursor as number);}
    } else if(payload.method==='receive') {
     const command=payload.body as ExecutionCommand;const b=command?.executionBinding;
     if(command.protocolVersion!==2||!b||b.nodeId!==binding.nodeId||b.sandboxId!==binding.sandboxId||b.generation!==binding.generation||b.transportInstanceId!==binding.transportInstanceId)throw new Error('STALE_SANDBOX');
     value=await runner.receive(command);
    } else if(payload.method==='query') {
     const body=payload.body as {commandId:string};if(typeof body?.commandId!=='string'||!body.commandId||body.commandId.length>256)throw new Error('INVALID_QUERY');value=await runner.query(body.commandId);
    } else if(payload.method==='attestRuntime'||payload.method==='finishNative'||payload.method==='captureCandidate'||payload.method==='stopNative') {
     const b=(payload.body as {binding:ExecutionBinding})?.binding;
     if(!runtimeAttestation||!b||b.nodeId!==binding.nodeId||b.sandboxId!==binding.sandboxId||b.generation!==binding.generation||b.transportInstanceId!==binding.transportInstanceId)throw new Error('STALE_SANDBOX');
     if(payload.method==='stopNative'){if(!runtimeAttestation.stopNative)throw Error('TRUSTED_STOP_UNAVAILABLE');value=await runtimeAttestation.stopNative(b);}else if(payload.method==='captureCandidate'){if(!runtimeAttestation.captureCandidate)throw Error('CANDIDATE_CAPTURE_UNAVAILABLE');value=await runtimeAttestation.captureCandidate(b);}else if(payload.method==='finishNative'){if(!runtimeAttestation.finishNative)throw Error('TRUSTED_FINISH_UNAVAILABLE');value=await runtimeAttestation.finishNative(b);}else value=await runtimeAttestation.attestRuntime(b);
    } else if(payload.method==='prepareRun') {
     const input=payload.body as DriverStartTurn;const b=input?.binding;
     if(!bundlePort||!b||b.nodeId!==binding.nodeId||b.sandboxId!==binding.sandboxId||b.generation!==binding.generation||b.transportInstanceId!==binding.transportInstanceId)throw new Error('STALE_SANDBOX');
     value=await bundlePort.prepareRun(input);
    } else if(payload.method.startsWith('auth')) {
     const input=payload.body as {binding:ExecutionBinding};const b=input?.binding;
     const selectedAuth=b&&typeof authTransport==='function'?authTransport(b):authTransport as DriverNativeAuthTransport|undefined;
     if(!selectedAuth||!b||fingerprint(selectedAuth.binding)!==fingerprint(b)||b.nodeId!==binding.nodeId||b.sandboxId!==binding.sandboxId||b.generation!==binding.generation||b.transportInstanceId!==binding.transportInstanceId)throw new Error('STALE_SANDBOX');
     if(payload.method==='authLoginStart')value=await selectedAuth.loginStart(payload.body as Parameters<DriverNativeAuthTransport['loginStart']>[0]);
     else if(payload.method==='authLoginCancel')value=await selectedAuth.loginCancel(payload.body as Parameters<DriverNativeAuthTransport['loginCancel']>[0]);
     else value=await selectedAuth.observeLogin(payload.body as Parameters<DriverNativeAuthTransport['observeLogin']>[0]);
    } else if(payload.method==='initializeEnvironment') {
     const body=payload.body as {binding:ExecutionBinding},b=body?.binding;
     if(!body||Object.keys(body).length!==1||!b||b.nodeId!==binding.nodeId||b.sandboxId!==binding.sandboxId||b.generation!==binding.generation||b.transportInstanceId!==binding.transportInstanceId||!runtimeAttestation?.initializeEnvironment)throw Error('ACCOUNTLESS_INITIALIZE_REQUIRED');
     value=await runtimeAttestation.initializeEnvironment(b);
    } else if(payload.method.startsWith('driver')) {
     const input=payload.body as {binding:ExecutionBinding};const b=input?.binding;
     if(!driver||!b||b.nodeId!==binding.nodeId||b.sandboxId!==binding.sandboxId||b.generation!==binding.generation||b.transportInstanceId!==binding.transportInstanceId)throw new Error('STALE_SANDBOX');
     switch(payload.method){
      case 'driverInitialize':value=await driver.initialize(payload.body as Parameters<RuntimeDriver['initialize']>[0]);break;
      case 'driverStartTurn':throw new Error('RUNNER_START_REQUIRED');
      case 'driverSteer':value=await driver.steer(payload.body as Parameters<RuntimeDriver['steer']>[0]);break;
      case 'driverInterrupt':value=await driver.interrupt(payload.body as Parameters<RuntimeDriver['interrupt']>[0]);break;
      case 'driverInspectAuth':value=await driver.inspectAuth(input);break;
      case 'driverReplyServerRequest':value=await driver.replyServerRequest(payload.body as Parameters<RuntimeDriver['replyServerRequest']>[0]);break;
      default:throw new Error('DRIVER_METHOD_UNSUPPORTED');
     }
    } else if(payload.method.startsWith('native')) {
     const body=payload.body as {binding:ExecutionBinding;data:string};const b=body?.binding;
     if(!nativeService||!b||b.nodeId!==binding.nodeId||b.sandboxId!==binding.sandboxId||b.generation!==binding.generation||b.transportInstanceId!==binding.transportInstanceId)throw new Error('STALE_SANDBOX');
     if(payload.method==='nativeOpen')value=await nativeService.open(b);
     else if(payload.method==='nativeWrite')value=await nativeService.write(b,body.data);
     else if(payload.method==='nativeRead')value=await nativeService.read(b);
     else value=await nativeService.close(b);
    } else if(payload.method==='verifyCandidate') {
     if(!verificationService)throw new Error('VERIFIER_UNAVAILABLE');
     const request=payload.body as {binding:ExecutionBinding};const b=request?.binding;
     if(!b||b.nodeId!==binding.nodeId||b.sandboxId!==binding.sandboxId||b.generation!==binding.generation||b.transportInstanceId!==binding.transportInstanceId)throw new Error('STALE_SANDBOX');
     value=await verificationService.verifyCandidate(payload.body);
    } else {
     const body=payload.body as {binding:ExecutionBinding;evidenceRef:string};const b=body?.binding;
     if(!b||b.nodeId!==binding.nodeId||b.sandboxId!==binding.sandboxId||b.generation!==binding.generation||b.transportInstanceId!==binding.transportInstanceId||typeof body.evidenceRef!=='string')throw new Error('STALE_SANDBOX');
     value=await verifier.observeStop(b,body.evidenceRef);
    }
    frames.send({id:payload.id,method:payload.method,body:{ok:true,value},response:true});
   } catch {try{frames.send({id:payload.id,method:payload.method,body:{ok:false},response:true});}catch{frames.close();}}
   finally{active--;}
  })();
 },()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('CORE_APPROVAL_DISCONNECTED'));}pending.clear();},'server');
 const request=(method:Payload['method'],binding:ExecutionBinding,input:unknown):Promise<unknown>=>{
  if(pending.size>=32)return Promise.reject(new Error('CORE_APPROVAL_BACKPRESSURE'));
  return new Promise((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CORE_APPROVAL_UNKNOWN_DELIVERY'));},15000);timer.unref();pending.set(id,{method,resolve,reject,timer});try{frames.send({id,method,body:{binding,input},response:false});}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}});
 };
 return Object.assign(()=>frames.close(),{approvalPort:(binding:ExecutionBinding):CoreApprovalPort=>({
  receive:input=>request('approvalReceive',binding,input) as ReturnType<CoreApprovalPort['receive']>,
  respond:input=>request('approvalRespond',binding,input) as ReturnType<CoreApprovalPort['respond']>,
  replay:input=>request('approvalReplay',binding,input) as ReturnType<CoreApprovalPort['replay']>,
  resolved:input=>request('approvalResolved',binding,input) as ReturnType<CoreApprovalPort['resolved']>,
  interruptTurn:input=>request('approvalInterruptTurn',binding,input) as ReturnType<CoreApprovalPort['interruptTurn']>,
  get:input=>request('approvalGet',binding,input) as ReturnType<CoreApprovalPort['get']>,
  cancel:input=>request('approvalCancel',binding,input) as ReturnType<CoreApprovalPort['cancel']>,
 })});
}
