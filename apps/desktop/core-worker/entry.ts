import {DatabaseSync} from 'node:sqlite';
import {P0Application} from '../../../packages/core/src/p0-application.js';
import type {WorkerRequest,WorkerReply} from '../../../packages/contracts/src/events.js';
// Electron utilityProcess supplies a parent port; no Electron/UI import in Core.
const port=(process as typeof process & {parentPort:{on(event:'message',listener:(event:{data:WorkerRequest})=>void):void;postMessage(value:unknown):void}}).parentPort;
let application:P0Application;let admitting=true;
try{
 const probe=new DatabaseSync(':memory:');probe.exec('CREATE TABLE readiness (value TEXT NOT NULL)');probe.prepare('INSERT INTO readiness VALUES (?)').run('worker-sqlite');const proof=probe.prepare('SELECT value, sqlite_version() AS version FROM readiness').get() as {value:string;version:string};if(proof.value!=='worker-sqlite')throw Error('SQLITE_PROBE_FAILED');probe.close();
 application=new P0Application(process.argv[2]!);port.postMessage({id:'ready',ok:true,sqliteVersion:proof.version} satisfies WorkerReply);
}catch(error){port.postMessage({id:'ready',ok:false,error:error instanceof Error?error.message:'CORE_STARTUP_FAILED'});process.exit(1);}
port.on('message',({data:request})=>{
 try{
  if(typeof request.id!=='string' || request.subject!=='local-user')throw Error('UNAUTHORIZED_SUBJECT');let result:unknown;
  switch(request.type){
   case 'snapshot':result=application.snapshot();break;
   case 'admissions':admitting=request.accepting===true;result={accepting:admitting};break;
   case 'command':{
    if(!admitting)throw Error('APP_QUITTING');result=application.command(request.command,request.subject);port.postMessage({type:'changed'});break;
   }
   case 'shutdown':{admitting=false;result=application.shutdown();port.postMessage({id:request.id,ok:true,result});setImmediate(()=>process.exit(0));return;}
   default:throw Error('UNKNOWN_COMMAND');
  }port.postMessage({id:request.id,ok:true,result} satisfies WorkerReply);
 }catch(error){port.postMessage({id:request.id,ok:false,error:error instanceof Error?error.message:'CORE_REJECTED'} satisfies WorkerReply);}
});
