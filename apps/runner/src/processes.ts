import type {DatabaseSync} from 'node:sqlite';
import {DurableRunner,ScheduledRunner} from './commands.js';
import {CodexAppServerDriver} from '../../../packages/execution/src/drivers/codex-app-server.js';
import type {CoreApprovalPort,DriverTerminalObservation,NativeDriverTransport,PreparedDriverBundlePort,DriverNativeAuthOptions} from '../../../packages/contracts/src/runtime-driver.js';
import type {ExecutionBinding} from '../../../packages/execution/src/contracts.js';
import { canonicalDigest } from '../../../packages/core/src/approvals.js';
import type { ExecutionCommand } from '../../../packages/execution/src/contracts.js';
import type { DriverStartTurn,RuntimeDriver,RunnerDriverServices } from '../../../packages/contracts/src/runtime-driver.js';
/** Composition seam: trusted frozen bundle resolver supplies input; driver cannot receive arbitrary RPC. */
export class DriverCommandExecutor implements RunnerDriverServices {
 constructor(private readonly driver:RuntimeDriver,private readonly resolveStart:(command:ExecutionCommand)=>Promise<DriverStartTurn>,readonly authorizeNow:(command:ExecutionCommand)=>void,private readonly stopNative?:(binding:ExecutionBinding)=>Promise<unknown>){}
 async prepare(command:ExecutionCommand):Promise<()=>Promise<void>>{
  const binding=command.executionBinding;if(command.protocolVersion!==2||!binding)throw Error('REAL_BINDING_REQUIRED');
  if(command.type==='run.start'){const start=await this.resolveStart(command);if(canonicalDigest(start.binding)!==canonicalDigest(binding)||start.contextManifestRef!==command.contextManifestRef||start.resolvedConnectionRef!==command.resolvedConnectionRef||start.approvalBinding.botId!==command.botId||start.approvalBinding.taskId!==command.taskId||start.approvalBinding.taskRevision!==command.taskRevision)throw Error('PREPARED_BINDING_MISMATCH');return async()=>{await this.driver.startTurn(start);};}
  if(command.type==='run.cancel'||command.type==='run.interrupt')return async()=>{try{await this.driver.interrupt({binding});}finally{await this.stopNative?.(binding);}};
  if(command.type==='message.send'&&command.intent==='supplement'&&command.text)return async()=>{await this.driver.steer({binding,text:command.text!});};
  throw Error('UNSUPPORTED_DRIVER_COMMAND');
 }
}

/** Guest-only storage of trusted immutable execution bundles, bounded independently from spool. */
export class DurableDriverBundles implements PreparedDriverBundlePort {
 constructor(private readonly db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS runner_bundles(run_id TEXT PRIMARY KEY,digest TEXT NOT NULL,payload TEXT NOT NULL)');}
 async prepareRun(input:DriverStartTurn):Promise<void>{
  const digest=canonicalDigest(input);const keys=['binding','approvalBinding','input','cwd','contextManifestRef','resolvedConnectionRef','selectedRuntime'];
  if(keys.some(k=>!Object.hasOwn(input,k))||Object.keys(input).some(k=>!keys.includes(k))||!input.binding||!input.approvalBinding||!input.selectedRuntime||!Array.isArray(input.input)||typeof input.cwd!=='string'||!input.cwd.startsWith('/')||!input.contextManifestRef||!input.resolvedConnectionRef||!input.binding.runId)throw Error('INVALID_PREPARED_BUNDLE');
  const payload=JSON.stringify(input);if(Buffer.byteLength(payload)>256*1024)throw Error('PREPARED_BUNDLE_LIMIT');
  const old=this.db.prepare('SELECT digest FROM runner_bundles WHERE run_id=?').get(input.binding.runId) as {digest:string}|undefined;if(old){if(old.digest!==digest)throw Error('PREPARED_BUNDLE_CONFLICT');return;}
  this.db.exec('BEGIN IMMEDIATE');try{const usage=this.db.prepare('SELECT COUNT(*) AS entries,COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM runner_bundles').get() as {entries:number;bytes:number};if(usage.entries>=1000||usage.bytes+Buffer.byteLength(payload)>16*1024*1024)throw Error('PREPARED_BUNDLE_BACKPRESSURE');this.db.prepare('INSERT INTO runner_bundles VALUES(?,?,?)').run(input.binding.runId,digest,payload);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 async resolveStart(command:ExecutionCommand):Promise<DriverStartTurn>{
  const row=this.db.prepare('SELECT digest,payload FROM runner_bundles WHERE run_id=?').get(command.runId) as {digest:string;payload:string}|undefined;if(!row)throw Error('PREPARED_BUNDLE_REQUIRED');const start=JSON.parse(row.payload) as DriverStartTurn;if(canonicalDigest(start)!==row.digest)throw Error('PREPARED_BUNDLE_CORRUPT');
  if(!command.executionBinding||canonicalDigest(start.binding)!==canonicalDigest(command.executionBinding)||start.contextManifestRef!==command.contextManifestRef||start.resolvedConnectionRef!==command.resolvedConnectionRef||start.approvalBinding.botId!==command.botId||start.approvalBinding.taskId!==command.taskId||start.approvalBinding.taskRevision!==command.taskRevision)throw Error('PREPARED_BINDING_MISMATCH');return start;
 }
}
/** Native terminal journal is independent of spool capacity. Publication and its receipt commit atomically. */
class DurableTerminalPublisher {
 private readonly inFlight=new Set<string>();private closed=false;private handoffAfter=0;private readonly unsubscribe:()=>void;
 constructor(private readonly db:DatabaseSync,private readonly runner:DurableRunner,private readonly hook?:GuestRunnerOptions['onTerminal']){db.exec('CREATE TABLE IF NOT EXISTS codex_driver_terminal(run_id TEXT PRIMARY KEY,observation TEXT NOT NULL);CREATE TABLE IF NOT EXISTS runner_terminal_publications(run_id TEXT PRIMARY KEY,cursor INTEGER NOT NULL,handoff_done INTEGER NOT NULL DEFAULT 0)');this.unsubscribe=runner.spool.onCapacityAvailable(()=>this.retry());this.retry();}
 retry():void{if(this.closed)return;
  // Publish new journals independently; retryable old handoffs cannot consume this window.
  const unpublished=this.db.prepare('SELECT t.run_id,t.observation FROM codex_driver_terminal t LEFT JOIN runner_terminal_publications p ON p.run_id=t.run_id WHERE p.run_id IS NULL ORDER BY t.rowid LIMIT 64').all() as {run_id:string;observation:string}[];
  for(const row of unpublished){const observation=JSON.parse(row.observation) as DriverTerminalObservation;this.db.exec('BEGIN IMMEDIATE');try{const cursor=this.runner.spool.append({runId:observation.binding.runId,kind:'terminal',payload:{...observation.binding,nativeThreadId:observation.nativeThreadId,nativeTurnId:observation.nativeTurnId,status:observation.status,stopped:'UNKNOWN'}});this.db.prepare('INSERT INTO runner_terminal_publications VALUES(?,?,0)').run(row.run_id,cursor);this.db.exec('COMMIT');}catch{this.db.exec('ROLLBACK');break;}this.handoff(row.run_id,observation);}
  if(!this.hook)return;
  const pending=()=>this.db.prepare('SELECT t.rowid AS position,t.run_id,t.observation FROM codex_driver_terminal t JOIN runner_terminal_publications p ON p.run_id=t.run_id WHERE p.handoff_done=0 AND t.rowid>? ORDER BY t.rowid LIMIT 64').all(this.handoffAfter) as {position:number;run_id:string;observation:string}[];
  let rows=pending();if(!rows.length){this.handoffAfter=0;rows=pending();}
  for(const row of rows){this.handoffAfter=row.position;this.handoff(row.run_id,JSON.parse(row.observation) as DriverTerminalObservation);}
 }
 private handoff(runId:string,observation:DriverTerminalObservation):void{if(!this.hook||this.inFlight.has(runId))return;this.inFlight.add(runId);void Promise.resolve().then(()=>{if(this.closed)return;return this.hook!(structuredClone(observation));}).then(()=>{if(!this.closed)this.db.prepare('UPDATE runner_terminal_publications SET handoff_done=1 WHERE run_id=?').run(runId);}).catch(()=>{/* Retain pending handoff; native completion is not stop evidence. */}).finally(()=>{this.inFlight.delete(runId);});}
 stop():void{this.closed=true;this.unsubscribe();}
}

export interface GuestRunnerOptions {
 db:DatabaseSync;transport:NativeDriverTransport;approvalPort:CoreApprovalPort;runtimeVersion:'0.159.2';
 commandAuthorizeNow(command:ExecutionCommand):void;driverAuthorizeNow(binding:ExecutionBinding):void;
 now?:()=>number;nativeAuth?:DriverNativeAuthOptions;stopNative?:(binding:ExecutionBinding)=>Promise<unknown>;onTerminal?:(observation:DriverTerminalObservation)=>Promise<void>|void;
}
/** Run only within an admitted guest Sandbox. This factory does not spawn, find accounts, or launch a model. */
export async function createGuestRunner(options:GuestRunnerOptions){
 const bundles=new DurableDriverBundles(options.db);let runner:DurableRunner;let terminals:DurableTerminalPublisher;
 const driver=new CodexAppServerDriver({db:options.db,transport:options.transport,approvalPort:options.approvalPort,authorizeNow:options.driverAuthorizeNow,now:options.now,onTerminal:()=>terminals.retry(),onClosed:()=>terminals?.stop(),onApproval:approval=>runner.spool.append({runId:approval.binding.runId,kind:'approval',payload:{approvalId:approval.id,state:'PENDING'}})});
 const executor=new DriverCommandExecutor(driver,command=>bundles.resolveStart(command),options.commandAuthorizeNow,options.stopNative);
 runner=new DurableRunner({db:options.db,prepare:command=>executor.prepare(command),authorizeNow:command=>executor.authorizeNow(command),now:options.now});
 terminals=new DurableTerminalPublisher(options.db,runner,options.onTerminal);
 try{await driver.initialize({binding:options.transport.binding,runtimeVersion:options.runtimeVersion});}catch(error){driver.close();throw error;}
 const transport=new ScheduledRunner(runner);return {runner,transport,driver,bundles,authTransport:driver.createAuthTransport(options.nativeAuth)};
}

export interface GuestRuntimeRegistryOptions {
 db:DatabaseSync;openNative(binding:ExecutionBinding):Promise<NativeDriverTransport>;
 approvalPortFor(binding:ExecutionBinding):CoreApprovalPort;
 commandAuthorizeNow(command:ExecutionCommand):void;driverAuthorizeNow(binding:ExecutionBinding):void;
 nativeAuthFor?:(binding:ExecutionBinding)=>DriverNativeAuthOptions;now?:()=>number;stopNative?:(binding:ExecutionBinding)=>Promise<unknown>;onTerminal?:(observation:DriverTerminalObservation)=>Promise<void>|void;
}
/** One long-lived guest Runner with per-execution native drivers. No Core tables, host CLI or implicit restart. */
export class GuestRuntimeRegistry {
 readonly bundles:DurableDriverBundles;readonly runner:DurableRunner;readonly transport:ScheduledRunner;readonly driver:RuntimeDriver;
 private readonly entries=new Map<string,{driver:CodexAppServerDriver;auth:ReturnType<CodexAppServerDriver['createAuthTransport']>}>();
 private readonly opening=new Map<string,Promise<void>>();private closed=false;private readonly terminals:DurableTerminalPublisher;
 constructor(private readonly options:GuestRuntimeRegistryOptions){
  options.db.exec('CREATE TABLE IF NOT EXISTS runner_driver_instances(run_id TEXT PRIMARY KEY,binding_digest TEXT NOT NULL)');this.bundles=new DurableDriverBundles(options.db);
  this.runner=new DurableRunner({db:options.db,now:options.now,authorizeNow:command=>options.commandAuthorizeNow(command),prepare:async command=>{if(!command.executionBinding)throw Error('REAL_BINDING_REQUIRED');const driver=this.entry(command.executionBinding).driver;return new DriverCommandExecutor(driver,c=>this.bundles.resolveStart(c),options.commandAuthorizeNow,options.stopNative).prepare(command);}});this.transport=new ScheduledRunner(this.runner);this.terminals=new DurableTerminalPublisher(options.db,this.runner,options.onTerminal);
  this.driver={initialize:input=>this.initialize(input),startTurn:async()=>{throw Error('RUNNER_START_REQUIRED');},steer:async input=>this.entry(input.binding).driver.steer(input),interrupt:async input=>this.entry(input.binding).driver.interrupt(input),inspectAuth:async input=>this.entry(input.binding).driver.inspectAuth(input),replyServerRequest:async input=>this.entry(input.binding).driver.replyServerRequest(input)};
 }
 private entry(binding:ExecutionBinding){if(this.closed)throw Error('GUEST_REGISTRY_CLOSED');const entry=this.entries.get(canonicalDigest(binding));if(!entry)throw Error('DRIVER_BINDING_NOT_INITIALIZED');return entry;}
 authTransport(binding:ExecutionBinding){return this.entry(binding).auth;}
 private async initialize(input:Parameters<RuntimeDriver['initialize']>[0]):Promise<void>{
  if(this.closed)throw Error('GUEST_REGISTRY_CLOSED');if(input.runtimeVersion!=='0.159.2')throw Error('UNSUPPORTED_RUNTIME_VERSION');const binding=structuredClone(input.binding),key=canonicalDigest(binding);if(this.entries.has(key))return;const pending=this.opening.get(key);if(pending)return pending;
  const authorize=()=>{const result:unknown=this.options.driverAuthorizeNow(binding);if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});throw Error('INVALID_AUTHORITY_CHECK');}};authorize();
  if(this.opening.size+this.entries.size>=64)throw Error('GUEST_DRIVER_BACKPRESSURE');
  // Claim before native open: after guest crash, a trusted Node must reconcile instead of silently reopening.
  if(this.options.db.prepare('SELECT 1 FROM runner_driver_instances WHERE run_id=?').get(binding.runId))throw Error('DRIVER_PROCESS_STATE_UNKNOWN');this.options.db.prepare('INSERT INTO runner_driver_instances VALUES(?,?)').run(binding.runId,key);
  const opening=(async()=>{const transport=await this.options.openNative(binding);authorize();if(canonicalDigest(transport.binding)!==key)throw Error('STALE_EXECUTION_BINDING');const driver=new CodexAppServerDriver({db:this.options.db,transport,approvalPort:this.options.approvalPortFor(binding),authorizeNow:this.options.driverAuthorizeNow,now:this.options.now,onTerminal:()=>this.terminals.retry(),onApproval:approval=>this.runner.spool.append({runId:approval.binding.runId,kind:'approval',payload:{approvalId:approval.id,state:'PENDING'}})});
   try{await driver.initialize({binding,runtimeVersion:input.runtimeVersion});if(this.closed)throw Error('GUEST_REGISTRY_CLOSED');this.entries.set(key,{driver,auth:driver.createAuthTransport(this.options.nativeAuthFor?.(binding))});}catch(error){driver.close();throw error;}
  })();this.opening.set(key,opening);try{await opening;}finally{this.opening.delete(key);}
 }
 /** Detaches protocol and scheduling only. Explicit trusted Node shutdown owns process termination evidence. */
 stopScheduling():void{this.closed=true;this.transport.stopScheduling();this.terminals.stop();for(const entry of this.entries.values())entry.driver.close();this.entries.clear();}
}
