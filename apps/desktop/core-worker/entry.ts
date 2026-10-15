import {DatabaseSync} from 'node:sqlite';
import {P1Application} from '../../../packages/core/src/p1-application.js';
import {P0Application} from '../../../packages/core/src/p0-application.js';
import type {WorkerRequest,WorkerReply} from '../../../packages/contracts/src/events.js';
// Electron utilityProcess supplies a parent port; no Electron/UI import in Core.
const port=(process as typeof process & {parentPort:{on(event:'message',listener:(event:{data:WorkerRequest})=>void):void;postMessage(value:unknown):void}}).parentPort;
let application:P0Application|P1Application;let admitting=true;
try{
 const probe=new DatabaseSync(':memory:');probe.exec('CREATE TABLE readiness (value TEXT NOT NULL)');probe.prepare('INSERT INTO readiness VALUES (?)').run('worker-sqlite');const proof=probe.prepare('SELECT value, sqlite_version() AS version FROM readiness').get() as {value:string;version:string};if(proof.value!=='worker-sqlite')throw Error('SQLITE_PROBE_FAILED');probe.close();
 if(process.argv[3]==='p1-preparation')application=P1Application.fromAdmission(process.argv[2]!,process.argv[4]??'');else application=new P0Application(process.argv[2]!);port.postMessage({id:'ready',ok:true,sqliteVersion:proof.version} satisfies WorkerReply);
}catch(error){port.postMessage({id:'ready',ok:false,error:error instanceof Error?error.message:'CORE_STARTUP_FAILED'});process.exit(1);}
let work=Promise.resolve();
port.on('message',({data:request})=>{work=work.then(async()=>{
 try{
  if(typeof request.id!=='string' || request.subject!=='local-user')throw Error('UNAUTHORIZED_SUBJECT');let result:unknown;
  switch(request.type){
   case 'environment-cancel':if(!(application instanceof P1Application))throw Error('P1_COMMAND_UNAVAILABLE');result=application.cancelEnvironmentPreparation(request.environment!,request.subject);port.postMessage({type:'changed'});break;
   case 'environment':if(!admitting)throw Error('APP_QUITTING');if(!(application instanceof P1Application))throw Error('P1_COMMAND_UNAVAILABLE');result=application.beginEnvironmentPreparation(request.environment!,request.subject);port.postMessage({type:'changed'});break;
   case 'auth':if(!(application instanceof P1Application))throw Error('P1_COMMAND_UNAVAILABLE');result=await application.auth(request.auth!,request.subject);break;
   case 'material':if(!(application instanceof P1Application))throw Error('P1_COMMAND_UNAVAILABLE');result=application.importMaterial(request.material!,request.subject);port.postMessage({type:'changed'});break;
   case 'snapshot':result=application.snapshot();break;
   case 'admissions':admitting=request.accepting===true;result={accepting:admitting};break;
   case 'command':{
    if(!admitting)throw Error('APP_QUITTING');result=await application.command(request.command,request.subject);port.postMessage({type:'changed'});break;
   }
   case 'shutdown':{admitting=false;result=await application.shutdown();port.postMessage({id:request.id,ok:true,result});setImmediate(()=>process.exit(0));return;}
   default:throw Error('UNKNOWN_COMMAND');
  }port.postMessage({id:request.id,ok:true,result} satisfies WorkerReply);
 }catch(error){port.postMessage({id:request.id,ok:false,error:error instanceof Error?error.message:'CORE_REJECTED'} satisfies WorkerReply);}
});});

let reconciling=false;
const reconciliation=setInterval(()=>{if(reconciling||!admitting||!(application instanceof P1Application))return;reconciling=true;work=work.then(async()=>{try{await (application as P1Application).reconcile();port.postMessage({type:'changed'});}finally{reconciling=false;}}).catch(()=>{reconciling=false;});},2000);reconciliation.unref();
