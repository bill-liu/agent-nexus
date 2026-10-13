import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { canonicalDigest,type ApprovalBinding,type ApprovalRecord } from '../../../core/src/approvals.js';
import type { ExecutionBinding } from '../contracts.js';
import { type CodexApprovalInput,type NativeApprovalResponse } from '../approval-adapter.js';
import type { CoreApprovalPort,DriverTerminalObservation,DriverNativeAuthTransport,DriverNativeAuthOptions,DriverLoginResponse,ApprovalDelivery,DriverAuthInspection,DriverInitialize,DriverReply,DriverScope,DriverSelectedRuntime,DriverStartTurn,DriverSteer,NativeDriverTransport,NativeTurnMapping,RuntimeDriver } from '../../../contracts/src/runtime-driver.js';
interface DriverOptions {
 db:DatabaseSync;transport:NativeDriverTransport;approvalPort:CoreApprovalPort;
 authorizeNow:(binding:ExecutionBinding)=>void;onApproval:(approval:ApprovalRecord)=>void;onTerminal?:(terminal:DriverTerminalObservation)=>void;onClosed?:()=>void;
 now?:()=>number;approvalTtlMs?:number;maxFrameBytes?:number;requestTimeoutMs?:number;
}
interface NativeRow { approval_id:string;binding:string;input:string;request_digest:string;response:string|null;delivery:ApprovalDelivery['delivery'];lifecycle:ApprovalDelivery['lifecycle'];pending_proof:number; }
interface Mapping extends NativeTurnMapping { approvalBinding:ApprovalBinding;selectedRuntime:DriverSelectedRuntime;state:'ACTIVE'|'INTERRUPTED'; }
interface AuthLogin {owner:symbol;expiresAt:number;state:'pending'|'completed'|'failed'|'unknown'|'cancelled';}
interface RpcWait {resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;}
function record(value:unknown):value is Record<string,any>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function shape(value:unknown,required:string[],optional:string[]=[]):asserts value is Record<string,any>{canonicalDigest(value);if(!record(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))throw Error('INVALID_DRIVER_INPUT');}
function nonempty(value:unknown):value is string{return typeof value==='string'&&value.trim().length>0;}
function id(value:unknown):value is string|number{return nonempty(value)||(typeof value==='number'&&Number.isSafeInteger(value));}
/** RPC timeouts are unknown outcomes; a late Core result never itself sends a native response. */
function boundedCorePort(port:CoreApprovalPort,timeoutMs:number):CoreApprovalPort {
 const bounded=<T>(invoke:()=>Promise<T>):Promise<T>=>{let timer:ReturnType<typeof setTimeout>;const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('CORE_APPROVAL_TIMEOUT')),timeoutMs);timer.unref();});return Promise.race([Promise.resolve().then(invoke),timeout]).finally(()=>clearTimeout(timer));};
 return {receive:input=>bounded(()=>port.receive(input)),respond:input=>bounded(()=>port.respond(input)),replay:input=>bounded(()=>port.replay(input)),resolved:input=>bounded(()=>port.resolved(input)),interruptTurn:input=>bounded(()=>port.interruptTurn(input)),get:input=>bounded(()=>port.get(input)),cancel:input=>bounded(()=>port.cancel(input))};
}
/** Pinned 0.159.2 newline-JSON client. Construction requires a trusted isolated transport; never spawns a CLI. */
export class CodexAppServerDriver implements RuntimeDriver {
 private readonly db:DatabaseSync;private readonly core:CoreApprovalPort;private readonly scope:ExecutionBinding;
 private buffer=Buffer.alloc(0);private closed=false;private initialized=false;private mapping:Mapping|null=null;private starting=false;
 private readonly waiters=new Map<string,RpcWait>();private readonly fileEvents=new Map<string,unknown>();private deferred:unknown[]=[];private serverChain:Promise<void>=Promise.resolve();private queuedFrames=0;
 private readonly authLogins=new Map<string,AuthLogin>();private authStarting:{owner:symbol;early:Map<string,'completed'|'failed'>}|null=null;private authUncertain=false;
 private readonly eventLog:Array<{type:string;approvalId?:string}>=[];
 constructor(private readonly options:DriverOptions){
  this.db=options.db;this.scope=structuredClone(options.transport.binding);if(!options.approvalPort)throw Error('CORE_APPROVAL_PORT_REQUIRED');this.core=boundedCorePort(options.approvalPort,options.requestTimeoutMs??10_000);
  this.db.exec(`PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS codex_driver_terminal(run_id TEXT PRIMARY KEY,observation TEXT NOT NULL);CREATE TABLE IF NOT EXISTS codex_driver_start(run_id TEXT PRIMARY KEY,binding TEXT NOT NULL);CREATE TABLE IF NOT EXISTS codex_driver_mapping(run_id TEXT PRIMARY KEY,binding TEXT NOT NULL,mapping TEXT NOT NULL);CREATE TABLE IF NOT EXISTS codex_native_requests(approval_id TEXT PRIMARY KEY,binding TEXT NOT NULL,input TEXT NOT NULL,request_digest TEXT NOT NULL,response TEXT,delivery TEXT NOT NULL,lifecycle TEXT NOT NULL,pending_proof INTEGER NOT NULL);`);
  const old=this.db.prepare('SELECT binding,mapping FROM codex_driver_mapping WHERE run_id=?').get(this.scope.runId) as {binding:string;mapping:string}|undefined;
  if(old){if(canonicalDigest(JSON.parse(old.binding))!==canonicalDigest(this.scope))throw Error('STALE_EXECUTION_BINDING');this.mapping=JSON.parse(old.mapping);}
  // Persisted pending is historical, not proof that a reattached transport still waits for the request.
  this.db.prepare("UPDATE codex_native_requests SET pending_proof=0,delivery=CASE WHEN delivery='SENDING' THEN 'UNKNOWN' ELSE delivery END WHERE binding=?").run(JSON.stringify(this.scope));
  options.transport.input.on('data',this.onData);options.transport.input.on('end',this.onEnd);options.transport.input.on('error',this.onEnd);options.transport.output.on('error',this.onEnd);
 }
 private onEnd=()=>{this.close();};
 private onData=(chunk:Buffer|string)=>{
  if(this.closed)return;try{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);let start=0;
   for(let n=0;n<bytes.length;n++){if(bytes[n]!==10)continue;const part=bytes.subarray(start,n);if(this.buffer.length+part.length>(this.options.maxFrameBytes??1024*1024))throw Error('FRAME_LIMIT');const line=Buffer.concat([this.buffer,part]);this.buffer=Buffer.alloc(0);start=n+1;if(line.length){const frame=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));this.frame(frame);}}
   const tail=bytes.subarray(start);if(this.buffer.length+tail.length>(this.options.maxFrameBytes??1024*1024))throw Error('FRAME_LIMIT');this.buffer=Buffer.concat([this.buffer,tail]);
  }catch{this.event('protocol.blocked');this.close();}
 };
 private frame(frame:unknown):void{
  if(!record(frame))throw Error('INVALID_FRAME');
  if(Object.hasOwn(frame,'id')&&!Object.hasOwn(frame,'method')){
   shape(frame,['id'],['result','error']);if(!id(frame.id)||(Object.hasOwn(frame,'result')===Object.hasOwn(frame,'error')))throw Error('INVALID_FRAME');const key=JSON.stringify(frame.id),waiting=this.waiters.get(key);if(!waiting)throw Error('UNEXPECTED_RESPONSE');this.waiters.delete(key);clearTimeout(waiting.timer);if(frame.error)waiting.reject(Error('NATIVE_RPC_ERROR'));else waiting.resolve(frame.result);return;
  }
  shape(frame,['method','params'],['id','trace']);if(!nonempty(frame.method))throw Error('INVALID_FRAME');
  if(frame.method==='account/login/completed'){if(Object.hasOwn(frame,'id'))throw Error('INVALID_AUTH_NOTIFICATION');this.authCompletion(frame.params);return;}
  if(this.starting&&!this.mapping){if(this.deferred.length>=64)throw Error('FRAME_BACKPRESSURE');this.deferred.push(frame);return;}
  this.enqueueServerFrame(frame);
 }
 private enqueueServerFrame(frame:Record<string,any>):void{if(frame.method==='turn/completed'&&!Object.hasOwn(frame,'id')){this.terminalFrame(frame);return;}if(++this.queuedFrames>64)throw Error('FRAME_BACKPRESSURE');this.serverChain=this.serverChain.then(async()=>{if(!this.closed)await this.serverFrame(frame);}).catch(()=>{this.event('protocol.blocked');this.close();}).finally(()=>{this.queuedFrames--;});}
 private async serverFrame(frame:Record<string,any>):Promise<void>{
  if(Object.hasOwn(frame,'id')){
   if(!id(frame.id))throw Error('INVALID_FRAME');
   if(!frame.method.endsWith('/requestApproval')){this.event('input.blocked');void this.write({id:frame.id,error:{code:-32601,message:'Unsupported request'}}).catch(()=>this.close());return;}
   const mapping=this.active();const existing=this.db.prepare('SELECT * FROM codex_native_requests WHERE approval_id=?').get(`codex:${canonicalDigest({runId:this.scope.runId,sessionId:this.scope.sessionId,nativeRequestId:frame.id})}`) as unknown as NativeRow|undefined;
   const fileChangeEvent=this.fileEvents.get(String(frame.params?.itemId));
   const input:CodexApprovalInput={request:frame,binding:mapping.approvalBinding,nativeThreadId:mapping.nativeThreadId,nativeTurnId:mapping.nativeTurnId,expiresAt:existing?JSON.parse(existing.input).expiresAt:(this.options.now??Date.now)()+(this.options.approvalTtlMs??60_000),...(fileChangeEvent?{fileChangeEvent}:{})};
   if(existing){if(existing.binding!==JSON.stringify(this.scope)||existing.request_digest!==canonicalDigest(frame)||canonicalDigest(JSON.parse(existing.input))!==canonicalDigest(input)||existing.lifecycle!=='PENDING')throw Error('STALE_NATIVE_REQUEST');this.db.prepare('UPDATE codex_native_requests SET pending_proof=1 WHERE approval_id=?').run(existing.approval_id);return;}
   const mapped=await this.core.receive(input);this.active();if(this.closed)throw Error('TRANSPORT_CLOSED');
   if(mapped.kind==='blocked'){this.event('approval.blocked');if(mapped.response)void this.write(mapped.response).catch(()=>this.close());return;}
   this.db.prepare("INSERT INTO codex_native_requests VALUES(?,?,?,?,NULL,'NOT_SENT','PENDING',1)").run(mapped.approval.id,JSON.stringify(this.scope),JSON.stringify(input),canonicalDigest(frame));
   this.event('approval.pending',mapped.approval.id);this.options.onApproval(mapped.approval);return;
  }
  if(frame.method==='item/started'){
   const p=frame.params,m=this.active();if(p?.threadId!==m.nativeThreadId||p?.turnId!==m.nativeTurnId)throw Error('STALE_NATIVE_SCOPE');if(p?.item?.type==='fileChange'){const prior=this.fileEvents.get(p.item.id);if(prior&&canonicalDigest(prior)!==canonicalDigest(frame))throw Error('FILE_EVIDENCE_CHANGED');if(!prior&&this.fileEvents.size>=64)throw Error('FRAME_BACKPRESSURE');this.fileEvents.set(p.item.id,frame);}return;
  }
  if(frame.method==='serverRequest/resolved'){
   const m=this.active();const approvalId=`codex:${canonicalDigest({runId:this.scope.runId,sessionId:this.scope.sessionId,nativeRequestId:frame.params.requestId})}`;
   this.db.prepare("UPDATE codex_native_requests SET lifecycle='RESOLVED',pending_proof=0 WHERE approval_id=?").run(approvalId);await this.core.resolved({binding:m.approvalBinding,nativeThreadId:m.nativeThreadId,nativeTurnId:m.nativeTurnId,notification:frame});this.event('approval.resolved',approvalId);return;
  }
  // Untrusted raw payloads may contain credentials. Ordinary events retain no arbitrary fields.
  this.event('native.notification');
 }
 /** Persist terminal input synchronously: EOF or slow Core RPC must not discard it. */
 private terminalFrame(frame:Record<string,any>):void{
   const m=this.mapping;if(!m||frame.params?.threadId!==m.nativeThreadId||frame.params?.turn?.id!==m.nativeTurnId)throw Error('STALE_NATIVE_SCOPE');shape(frame.params,['threadId','turn']);const turn=frame.params.turn;shape(turn,['id','items','status'],['completedAt','durationMs','error','itemsView','startedAt']);if(!Array.isArray(turn.items)||!['completed','interrupted','failed'].includes(turn.status))throw Error('INVALID_NATIVE_TERMINAL');
   const observation:DriverTerminalObservation={binding:structuredClone(this.scope),nativeThreadId:m.nativeThreadId,nativeTurnId:m.nativeTurnId,status:turn.status};const old=this.db.prepare('SELECT observation FROM codex_driver_terminal WHERE run_id=?').get(this.scope.runId) as {observation:string}|undefined;if(old){if(canonicalDigest(JSON.parse(old.observation))!==canonicalDigest(observation))throw Error('NATIVE_TERMINAL_CONFLICT');return;}
   const previous=m.state;this.db.exec('BEGIN IMMEDIATE');try{this.invalidateLocal();this.db.prepare('INSERT INTO codex_driver_terminal VALUES(?,?)').run(this.scope.runId,JSON.stringify(observation));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');m.state=previous;throw error;}
   try{const result:unknown=this.options.onTerminal?.(structuredClone(observation));if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});throw Error('INVALID_TERMINAL_OBSERVER');}}catch{this.event('terminal.publication-deferred');}void this.core.interruptTurn(m.approvalBinding).catch(()=>this.event('approval.authority-unreachable'));this.event('turn.completed');return;
 }
 private event(type:string,approvalId?:string):void{if(this.eventLog.length===256)this.eventLog.shift();this.eventLog.push({type,...(approvalId?{approvalId}:{})});}
 events():ReadonlyArray<{type:string;approvalId?:string}>{return structuredClone(this.eventLog);}
 private scopeCheck(input:DriverScope):void{if(canonicalDigest(input.binding)!==canonicalDigest(this.scope))throw Error('STALE_EXECUTION_BINDING');if(this.closed)throw Error('TRANSPORT_CLOSED');}
 private authorize():void{const result:unknown=this.options.authorizeNow(this.scope);if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});throw Error('INVALID_AUTHORITY_CHECK');}}
 private active():Mapping{if(!this.mapping||this.mapping.state!=='ACTIVE')throw Error('TURN_NOT_ACTIVE');return this.mapping;}
 private async write(frame:unknown):Promise<void>{if(this.closed)throw Error('TRANSPORT_CLOSED');const bytes=JSON.stringify(frame)+'\n';if(Buffer.byteLength(bytes)>(this.options.maxFrameBytes??1024*1024))throw Error('FRAME_LIMIT');await new Promise<void>((resolve,reject)=>this.options.transport.output.write(bytes,error=>error?reject(Error('TRANSPORT_WRITE_FAILED')):resolve()));}
 private rpc(method:string,params:unknown):Promise<any>{
  if(this.closed)return Promise.reject(Error('TRANSPORT_CLOSED'));if(this.waiters.size>=32)return Promise.reject(Error('RPC_BACKPRESSURE'));const requestId=`an:${randomUUID()}`,key=JSON.stringify(requestId);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiters.delete(key);reject(Error('RPC_TIMEOUT'));},this.options.requestTimeoutMs??10_000);this.waiters.set(key,{resolve,reject,timer});void this.write({id:requestId,method,params}).catch(()=>{clearTimeout(timer);this.waiters.delete(key);reject(Error('TRANSPORT_WRITE_FAILED'));});});
 }
 private authCompletion(params:unknown):void {
  shape(params,['success'],['loginId','error','onboardingEntrypoint']);
  if(typeof params.success!=='boolean'||(params.loginId!==undefined&&params.loginId!==null&&!nonempty(params.loginId))||(params.error!==undefined&&params.error!==null&&typeof params.error!=='string')||(params.onboardingEntrypoint!==undefined&&params.onboardingEntrypoint!==null&&params.onboardingEntrypoint!=='life_sciences'))throw Error('INVALID_AUTH_NOTIFICATION');
  if(!nonempty(params.loginId)||params.loginId.length>256)return;
  const login=this.authLogins.get(params.loginId);
  if(login){if(login.state==='pending'){login.state=login.expiresAt<=(this.options.now??Date.now)()?'unknown':params.success?'completed':'failed';}return;}
  if(this.authStarting&&this.authStarting.early.size<8)this.authStarting.early.set(params.loginId,params.success?'completed':'failed');
 }
 /** Narrow official-login capability. Never expose this facade through general Renderer IPC. */
 createAuthTransport(options:DriverNativeAuthOptions={}):DriverNativeAuthTransport {
  const owner=Symbol('auth-owner'),binding=Object.freeze(structuredClone(this.scope));const ttl=options.loginTtlMs??120_000;
  if(!Number.isSafeInteger(ttl)||ttl<1||ttl>300_000)throw Error('INVALID_AUTH_TTL');
  const authorize=(operation:'start'|'inspect')=>{if(!options.authorizeOperation)throw Error('AUTH_OPERATION_DENIED');const result:unknown=options.authorizeOperation(operation,binding);if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});throw Error('INVALID_AUTHORITY_CHECK');}};
  const own=(loginId:string)=>{const login=this.authLogins.get(loginId);if(!login||login.owner!==owner)throw Error('AUTH_LOGIN_NOT_OWNED');return login;};
  const cancel=async(loginId:string):Promise<{status:'canceled'|'notFound'}>=>{const login=own(loginId);login.state='unknown';const result=await this.rpc('account/login/cancel',{loginId});shape(result,['status']);if(!['canceled','notFound'].includes(result.status))throw Error('INVALID_AUTH_RESPONSE');if(result.status==='canceled')login.state='cancelled';return {status:result.status};};
  return Object.freeze({binding,runtimeVersion:'0.159.2' as const,
   loginStart:async(input:Parameters<DriverNativeAuthTransport['loginStart']>[0]):Promise<DriverLoginResponse>=>{
    shape(input,['binding','params']);shape(input.params,['type']);this.scopeCheck(input);if(!this.initialized)throw Error('NOT_INITIALIZED');if(!['chatgpt','chatgptDeviceCode'].includes(input.params.type))throw Error('AUTH_KIND_UNSUPPORTED');authorize('start');
    if(this.authUncertain||this.authStarting||[...this.authLogins.values()].some(x=>['pending','unknown'].includes(x.state)))throw Error('AUTH_LOGIN_STATE_UNKNOWN');if(this.authLogins.size>=32)throw Error('AUTH_LOGIN_LIMIT');
    const type=input.params.type,expiresAt=(this.options.now??Date.now)()+ttl;this.authStarting={owner,early:new Map()};let loginId:string|undefined;
    try{const result=await this.rpc('account/login/start',{type});if(!record(result)||!nonempty(result.loginId)||result.loginId.length>256||this.authLogins.has(result.loginId))throw Error('INVALID_AUTH_RESPONSE');loginId=result.loginId;const early=this.authStarting?.early.get(loginId);this.authLogins.set(loginId,{owner,expiresAt,state:expiresAt<=(this.options.now??Date.now)()?'unknown':early??'pending'});
     if(type==='chatgpt')shape(result,['type','loginId','authUrl']);else shape(result,['type','loginId','verificationUrl','userCode']);if(result.type!==type)throw Error('INVALID_AUTH_RESPONSE');const address=type==='chatgpt'?result.authUrl:result.verificationUrl;if(!nonempty(address)||address.length>4096||(type==='chatgptDeviceCode'&&(!nonempty(result.userCode)||result.userCode.length>256)))throw Error('INVALID_AUTH_RESPONSE');
     const url=new URL(address);if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!['auth.openai.com','chatgpt.com'].includes(url.hostname))throw Error('AUTH_URL_DENIED');
     // Return only through the ephemeral capability; retain no URL/code/error payload in state or SQLite.
     return type==='chatgpt'?{type,loginId,authUrl:address}:{type,loginId,verificationUrl:address,userCode:result.userCode};
    }catch{if(loginId){try{if((await cancel(loginId)).status!=='canceled')this.authUncertain=true;}catch{this.authUncertain=true;}}else this.authUncertain=true;throw Error('AUTH_LOGIN_START_UNKNOWN');}finally{this.authStarting=null;}
   },
   loginCancel:async(input:Parameters<DriverNativeAuthTransport['loginCancel']>[0])=>{shape(input,['binding','params']);shape(input.params,['loginId']);this.scopeCheck(input);if(!nonempty(input.params.loginId)||input.params.loginId.length>256)throw Error('INVALID_DRIVER_INPUT');return cancel(input.params.loginId);},
   observeLogin:async(input:Parameters<DriverNativeAuthTransport['observeLogin']>[0])=>{shape(input,['binding','loginId']);this.scopeCheck(input);authorize('inspect');if(!nonempty(input.loginId)||input.loginId.length>256)throw Error('INVALID_DRIVER_INPUT');const login=own(input.loginId);if(login.expiresAt<=(this.options.now??Date.now)()&&login.state!=='cancelled')login.state='unknown';return login.state==='cancelled'?'unknown':login.state;}
  });
 }
 async initialize(input:DriverInitialize):Promise<void>{shape(input,['binding','runtimeVersion']);this.scopeCheck(input);if(input.runtimeVersion!=='0.159.2')throw Error('UNSUPPORTED_RUNTIME_VERSION');if(this.initialized)return;
  const result=await this.rpc('initialize',{clientInfo:{name:'agent-nexus',version:'0.0.0-p1'},capabilities:{experimentalApi:false,explicitGatewayOauth:true}});shape(result,['codexHome','platformFamily','platformOs','userAgent']);if(Object.values(result).some(v=>!nonempty(v)))throw Error('INVALID_NATIVE_RESPONSE');await this.write({method:'initialized',params:{}});this.initialized=true;
 }
 async startTurn(input:DriverStartTurn):Promise<NativeTurnMapping>{
  shape(input,['binding','approvalBinding','input','cwd','contextManifestRef','resolvedConnectionRef','selectedRuntime']);input=structuredClone(input);shape(input.selectedRuntime,['model','modelProvider']);if(!nonempty(input.selectedRuntime.model)||input.selectedRuntime.model.length>256||!nonempty(input.selectedRuntime.modelProvider)||input.selectedRuntime.modelProvider.length>256)throw Error('INVALID_DRIVER_INPUT');this.scopeCheck(input);if(!this.initialized)throw Error('NOT_INITIALIZED');if(this.mapping||this.starting)throw Error('TURN_ALREADY_STARTED');
  if(!nonempty(input.cwd)||!input.cwd.startsWith('/')||input.cwd.includes('\0')||!nonempty(input.contextManifestRef)||!nonempty(input.resolvedConnectionRef)||!Array.isArray(input.input)||input.input.length<1||input.input.length>32)throw Error('INVALID_DRIVER_INPUT');
  for(const item of input.input){shape(item,['type','text']);if(item.type!=='text'||!nonempty(item.text)||Buffer.byteLength(item.text)>64*1024)throw Error('INVALID_DRIVER_INPUT');}
  const b=input.approvalBinding;if(b.runId!==this.scope.runId||b.sessionId!==this.scope.sessionId||b.turnId!==this.scope.turnId||b.nodeId!==this.scope.nodeId||b.nodeGeneration!==this.scope.generation)throw Error('STALE_EXECUTION_BINDING');
  this.authorize();if(this.db.prepare('SELECT 1 FROM codex_driver_start WHERE run_id=?').get(this.scope.runId))throw Error('TURN_STATE_UNKNOWN');this.db.prepare('INSERT INTO codex_driver_start VALUES(?,?)').run(this.scope.runId,JSON.stringify(this.scope));this.starting=true;
  try{const thread=await this.rpc('thread/start',{cwd:input.cwd,model:input.selectedRuntime.model,modelProvider:input.selectedRuntime.modelProvider,approvalPolicy:'untrusted',approvalsReviewer:'user',sandbox:'read-only'});shape(thread,['approvalPolicy','approvalsReviewer','cwd','model','modelProvider','sandbox','thread'],['disabledPluginIds','instructionSources','reasoningEffort','serviceTier']);if(!record(thread.thread)||!nonempty(thread.thread.id)||!nonempty(thread.model)||!nonempty(thread.modelProvider))throw Error('INVALID_NATIVE_RESPONSE');if(thread.model!==input.selectedRuntime.model||thread.modelProvider!==input.selectedRuntime.modelProvider)throw Error('SELECTED_RUNTIME_MISMATCH');if(thread.approvalPolicy!=='untrusted'||thread.approvalsReviewer!=='user'||thread.cwd!==input.cwd||!record(thread.sandbox)||thread.sandbox.type!=='readOnly'||(thread.sandbox.networkAccess!==undefined&&thread.sandbox.networkAccess!==false))throw Error('UNSAFE_NATIVE_POLICY');shape(thread.sandbox,['type'],['networkAccess']);
   this.authorize();const turn=await this.rpc('turn/start',{threadId:thread.thread.id,input:input.input,model:input.selectedRuntime.model});shape(turn,['turn']);shape(turn.turn,['id','items','status'],['completedAt','durationMs','error','itemsView','startedAt']);if(!nonempty(turn.turn.id)||!Array.isArray(turn.turn.items)||turn.turn.status!=='inProgress')throw Error('INVALID_NATIVE_RESPONSE');
   this.mapping={binding:this.scope,nativeThreadId:thread.thread.id,nativeTurnId:turn.turn.id,approvalBinding:structuredClone(b),selectedRuntime:input.selectedRuntime,state:'ACTIVE'};this.saveMapping();const waiting=this.deferred;this.deferred=[];for(const frame of waiting)this.enqueueServerFrame(frame as Record<string,any>);await this.serverChain;if(this.closed)throw Error('TRANSPORT_CLOSED');
   return {binding:structuredClone(this.scope),nativeThreadId:this.mapping.nativeThreadId,nativeTurnId:this.mapping.nativeTurnId};
  }catch(error){this.close();throw error;}finally{this.starting=false;}
 }
 async steer(input:DriverSteer):Promise<{delivery:'DELIVERED';applied:'UNKNOWN'}>{shape(input,['binding','text']);this.scopeCheck(input);const m=this.active();if(!nonempty(input.text)||Buffer.byteLength(input.text)>64*1024)throw Error('INVALID_DRIVER_INPUT');this.authorize();const result=await this.rpc('turn/steer',{threadId:m.nativeThreadId,expectedTurnId:m.nativeTurnId,input:[{type:'text',text:input.text}]});shape(result,['turnId']);if(result.turnId!==m.nativeTurnId)throw Error('STALE_NATIVE_SCOPE');return {delivery:'DELIVERED',applied:'UNKNOWN'};}
 async interrupt(input:DriverScope):Promise<{requested:true;stopped:'UNKNOWN'}>{shape(input,['binding']);this.scopeCheck(input);const m=this.active();void this.invalidate();await this.rpc('turn/interrupt',{threadId:m.nativeThreadId,turnId:m.nativeTurnId});return {requested:true,stopped:'UNKNOWN'};}
 private invalidateLocal():void{const m=this.mapping;if(!m)return;m.state='INTERRUPTED';this.saveMapping();this.db.prepare("UPDATE codex_native_requests SET lifecycle='CANCELLED',pending_proof=0 WHERE binding=? AND lifecycle='PENDING'").run(JSON.stringify(this.scope));}
 private async invalidate():Promise<void>{const m=this.mapping;if(!m)return;this.invalidateLocal();try{await this.core.interruptTurn(m.approvalBinding);}catch{this.event('approval.authority-unreachable');}}
 private saveMapping():void{this.db.prepare('INSERT INTO codex_driver_mapping VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET mapping=excluded.mapping').run(this.scope.runId,JSON.stringify(this.scope),JSON.stringify(this.mapping));}
 async inspectAuth(input:DriverScope):Promise<DriverAuthInspection>{shape(input,['binding']);this.scopeCheck(input);if(!this.initialized)throw Error('NOT_INITIALIZED');const result=await this.rpc('account/read',{refreshToken:false});shape(result,['requiresOpenaiAuth'],['account']);if(typeof result.requiresOpenaiAuth!=='boolean')throw Error('INVALID_NATIVE_RESPONSE');const account=result.account;
  const base={binding:structuredClone(this.scope),source:'runtime_reported' as const};if(account==null)return {...base,status:result.requiresOpenaiAuth?'unauthenticated':'unknown',authMethod:'unknown'};
  if(!record(account))throw Error('INVALID_NATIVE_RESPONSE');if(account.type==='apiKey'){shape(account,['type']);return {...base,status:'authenticated',authMethod:'api_key'};}
  if(account.type==='chatgpt'){shape(account,['type','email','planType']);if((account.email!==null&&typeof account.email!=='string')||typeof account.planType!=='string')throw Error('INVALID_NATIVE_RESPONSE');return {...base,status:'authenticated',authMethod:'runtime_managed_login',...(account.email?{accountRef:`codex-account:${canonicalDigest({type:account.type,email:account.email})}`}:{})};}
  return {...base,status:'unknown',authMethod:'unknown'};
 }
 async replyServerRequest(input:DriverReply):Promise<ApprovalDelivery>{
  shape(input,['binding','approvalId','expectedRequestHash']);input=structuredClone(input);{let chain:Promise<void>;do{chain=this.serverChain;await chain;}while(chain!==this.serverChain);}this.scopeCheck(input);this.active();const row=this.db.prepare('SELECT * FROM codex_native_requests WHERE approval_id=?').get(input.approvalId) as unknown as NativeRow|undefined;
  if(!row||row.binding!==JSON.stringify(this.scope)||row.lifecycle!=='PENDING')throw Error('STALE_NATIVE_REQUEST');if(!row.pending_proof)throw Error('PENDING_PROOF_REQUIRED');
  const original=JSON.parse(row.input) as CodexApprovalInput;if(original.fileChangeEvent){const itemId=(original.request as {params:{itemId:string}}).params.itemId;const current=this.fileEvents.get(itemId);if(!current||canonicalDigest(current)!==canonicalDigest(original.fileChangeEvent))throw Error('FILE_EVIDENCE_CHANGED');}const record=await this.core.get({id:input.approvalId,binding:original.binding});if(record.requestHash!==input.expectedRequestHash)throw Error('REQUEST_MISMATCH');
  this.authorize();let response:NativeApprovalResponse;
  if(record.status==='CONSUMED')response=await this.core.replay({...original,expectedRequestHash:input.expectedRequestHash});
  else if(row.response){if(record.status==='DENIED')response=await this.core.respond({...original,expectedRequestHash:input.expectedRequestHash,decision:'decline'});else throw Error('APPROVAL_BLOCKED');}
  else response=await this.core.respond({...original,expectedRequestHash:input.expectedRequestHash,decision:record.status==='DENIED'?'decline':'accept'});
  {let chain:Promise<void>;do{chain=this.serverChain;await chain;}while(chain!==this.serverChain);}this.scopeCheck(input);this.active();this.assertUnexpired(original,input.approvalId);const latest=this.db.prepare('SELECT * FROM codex_native_requests WHERE approval_id=?').get(input.approvalId) as unknown as NativeRow|undefined;if(!latest||latest.lifecycle!=='PENDING'||!latest.pending_proof)throw Error('STALE_NATIVE_REQUEST');if(original.fileChangeEvent){const itemId=(original.request as {params:{itemId:string}}).params.itemId;const current=this.fileEvents.get(itemId);if(!current||canonicalDigest(current)!==canonicalDigest(original.fileChangeEvent))throw Error('FILE_EVIDENCE_CHANGED');}
  // Consume receipt is durable first. Delivery can fail or be unknown; it never becomes proof of an effect.
  this.db.prepare("UPDATE codex_native_requests SET response=?,delivery='SENDING',pending_proof=0 WHERE approval_id=?").run(JSON.stringify(response),input.approvalId);
  try{this.authorize();this.scopeCheck(input);this.active();this.assertUnexpired(original,input.approvalId);await this.write(response);this.db.prepare("UPDATE codex_native_requests SET delivery='SENT' WHERE approval_id=?").run(input.approvalId);}catch{this.db.prepare("UPDATE codex_native_requests SET delivery='UNKNOWN' WHERE approval_id=?").run(input.approvalId);}
  return this.approvalDelivery(input.approvalId)!;
 }
 private assertUnexpired(original:CodexApprovalInput,approvalId:string):void{if(original.expiresAt<=(this.options.now??Date.now)()){this.db.prepare("UPDATE codex_native_requests SET lifecycle='CANCELLED',pending_proof=0 WHERE approval_id=?").run(approvalId);throw Error('APPROVAL_EXPIRED');}}
 async cleanupExpired():Promise<number>{const now=(this.options.now??Date.now)();let count=0;for(const row of this.db.prepare("SELECT * FROM codex_native_requests WHERE binding=? AND lifecycle='PENDING'").all(JSON.stringify(this.scope)) as unknown as NativeRow[]){if((JSON.parse(row.input) as CodexApprovalInput).expiresAt<=now){await this.core.cancel({id:row.approval_id,binding:(JSON.parse(row.input) as CodexApprovalInput).binding});this.db.prepare("UPDATE codex_native_requests SET lifecycle='CANCELLED',pending_proof=0 WHERE approval_id=?").run(row.approval_id);count++;}}return count;}
 approvalDelivery(approvalId:string):ApprovalDelivery|null{const row=this.db.prepare('SELECT * FROM codex_native_requests WHERE approval_id=?').get(approvalId) as unknown as NativeRow|undefined;return row?{approvalId,delivery:row.delivery,lifecycle:row.lifecycle,effect:'UNKNOWN'}:null;}
 close():void{if(this.closed)return;this.closed=true;this.buffer=Buffer.alloc(0);this.deferred=[];this.fileEvents.clear();this.authLogins.clear();this.authStarting=null;for(const waiter of this.waiters.values()){clearTimeout(waiter.timer);waiter.reject(Error('TRANSPORT_CLOSED'));}this.waiters.clear();this.options.transport.input.off('data',this.onData);this.options.transport.input.off('end',this.onEnd);this.options.transport.input.off('error',this.onEnd);this.options.transport.output.off('error',this.onEnd);this.db.prepare('UPDATE codex_native_requests SET pending_proof=0 WHERE binding=?').run(JSON.stringify(this.scope));this.options.onClosed?.();}
}
