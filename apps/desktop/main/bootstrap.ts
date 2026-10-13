import {utilityProcess,type UtilityProcess} from 'electron';
import {join,dirname} from 'node:path';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {workerEnvironment} from './ipc.js';
import type {WorkerRequest,WorkerReply} from '../../../packages/contracts/src/events.js';
/** Single authority. A crash enters read-only mode; recovery is deliberately manual. */
export class CoreClient {
 private child:UtilityProcess;private pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 available=false;sqliteVersion='';readonly ready:Promise<void>;readonly exited:Promise<void>;
 constructor(buildDirectory:string,dataDirectory:string,onChange:()=>void,onExit:()=>void,mode:'p0-demo'|'p1-preparation'='p0-demo',admissionFile=''){
  let readyResolve!:()=>void;let readyReject!:(error:Error)=>void;this.ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});let exitResolve!:()=>void;this.exited=new Promise(resolve=>{exitResolve=resolve;});
  const env=workerEnvironment(process.env);
  const compiler=join(dirname(dirname(buildDirectory)),`app.asar.unpacked/node_modules/@esbuild/darwin-${process.arch}/bin/esbuild`);
  if(process.platform==='darwin'&&existsSync(compiler))env.ESBUILD_BINARY_PATH=compiler;
  this.child=utilityProcess.fork(join(buildDirectory,'core-worker.cjs'),[join(dataDirectory,mode==='p1-preparation'?'p1.sqlite':'core.sqlite'),mode,admissionFile],{env,serviceName:'AN Core',stdio:'ignore'});
  const startup=setTimeout(()=>readyReject(Error('CORE_STARTUP_TIMEOUT')),15_000);
  this.child.on('message',(reply:WorkerReply|{type:string})=>{if('type' in reply){if(reply.type==='changed')onChange();return;}if(reply.id==='ready'){clearTimeout(startup);if(!reply.ok){readyReject(Error(reply.error??'CORE_STARTUP_FAILED'));return;}this.available=true;this.sqliteVersion=reply.sqliteVersion??'';readyResolve();return;}const waiting=this.pending.get(reply.id);if(!waiting)return;clearTimeout(waiting.timer);this.pending.delete(reply.id);if(reply.ok)waiting.resolve(reply.result);else waiting.reject(Error(reply.error??'CORE_REJECTED'));});
  this.child.on('exit',()=>{clearTimeout(startup);this.available=false;readyReject(Error('CORE_UNAVAILABLE'));for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('CORE_UNAVAILABLE'));}this.pending.clear();exitResolve();onExit();});
 }
 async request(type:WorkerRequest['type'],subject:string,extra:Pick<WorkerRequest,'command'|'accepting'|'auth'|'material'>={}):Promise<unknown>{await this.ready;if(!this.available)throw Error('CORE_UNAVAILABLE');if(this.pending.size>=128)throw Error('CORE_BACKPRESSURE');const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('RESULT_UNKNOWN'));},10_000);this.pending.set(id,{resolve,reject,timer});this.child.postMessage({id,type,subject,...extra});});}
}
