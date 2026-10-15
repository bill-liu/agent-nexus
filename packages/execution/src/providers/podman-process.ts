import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {Duplex} from 'node:stream';
import type {PodmanCLI} from './podman.js';
/** No installation or key generation. Construct only from protected, explicitly scoped Core admission. */
export class PodmanProcessCLI implements PodmanCLI {
 readonly evidenceKind='live' as const;
 private readonly clients=new WeakMap<Duplex,Promise<void>>();
 constructor(private readonly options:{executable:string;sha256:string;assertAuthorized():void}){}
 private check(){
  this.options.assertAuthorized();if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('BLOCKED_MAC_TARGET_REQUIRED');
  const p=this.options.executable,s=lstatSync(p);if(!p.startsWith('/')||!s.isFile()||s.isSymbolicLink()||(s.mode&0o022)!==0||![0,process.getuid?.()].includes(s.uid)||realpathSync(p)!==p||!/^([a-f0-9]{64})$/.test(this.options.sha256)||createHash('sha256').update(readFileSync(p)).digest('hex')!==this.options.sha256)throw Error('UNTRUSTED_PODMAN_EXECUTABLE');
 }
 private process(args:readonly string[]){this.check();const child=spawn(this.options.executable,[...args],{env:{HOME:homedir(),PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe']});child.on('error',()=>{});child.stdin.on('error',()=>{});return child;}
 async machineConfig(path:string):Promise<unknown>{this.check();const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o022)!==0||realpathSync(path)!==path||s.size>1024*1024)throw Error('PROTECTED_MACHINE_CONFIG_REQUIRED');return JSON.parse(readFileSync(path,'utf8'));}
 run(args:readonly string[]):Promise<{code:number;stdout:string}>{
  const child=this.process(args);child.stdin.end();return new Promise((resolve,reject)=>{let stdout='',bytes=0,finished=false;
   const done=(error?:Error,code?:number)=>{if(finished)return;finished=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve({code:code!,stdout});};
   const timer=setTimeout(()=>done(Error('PODMAN_DELIVERY_UNKNOWN')),30000);timer.unref();
   child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>1024*1024)done(Error('PODMAN_OUTPUT_LIMIT'));else stdout+=b.toString('utf8');});
   child.stderr.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>1024*1024)done(Error('PODMAN_OUTPUT_LIMIT'));});
   child.once('error',()=>done(Error('PODMAN_UNAVAILABLE')));child.once('close',code=>{try{this.options.assertAuthorized();if(code===null)throw 0;done(undefined,code);}catch{done(Error('PODMAN_DELIVERY_UNKNOWN'));}});
  });
 }
 async open(args:readonly string[]):Promise<Duplex>{
  const child=this.process(args);let bytes=0;const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));const stream=Duplex.from({readable:child.stdout,writable:child.stdin});
  child.stderr.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>65536)stream.destroy(Error('PODMAN_STDERR_LIMIT'));});
  child.once('error',()=>stream.destroy(Error('PODMAN_EXEC_UNKNOWN')));child.once('close',()=>stream.destroy());stream.once('close',()=>{child.kill();});
  this.clients.set(stream,closed);
  await new Promise<void>((resolve,reject)=>{child.once('spawn',()=>resolve());child.once('error',()=>reject(Error('PODMAN_EXEC_UNKNOWN')));});
  // Killing the client is never remote process-stop evidence; durable writer remains held.
  return stream;
 }
 async closeExec(stream:Duplex):Promise<void>{const closed=this.clients.get(stream);if(!closed)throw Error('PODMAN_EXEC_DELIVERY_UNKNOWN');stream.destroy();let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([closed,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(Error('PODMAN_EXEC_DELIVERY_UNKNOWN')),5000);})]);}finally{clearTimeout(timer);}}
}
