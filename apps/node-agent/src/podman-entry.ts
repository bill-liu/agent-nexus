import {DatabaseSync} from 'node:sqlite';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync,readFileSync,readdirSync} from 'node:fs';
import {Duplex} from 'node:stream';
import type {ExecutionBinding} from '../../../packages/execution/src/contracts.js';
import {assertExecutionBinding} from '../../../packages/execution/src/runner-client.js';
import {canonicalJson} from '../../../packages/persistence/src/unit-of-work.js';
import {servePodmanAccountless} from './podman-accountless.js';

function directory(path:string){try{mkdirSync(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==1000||(s.mode&0o077)!==0)throw Error('PRIVATE_DIRECTORY_REQUIRED');}
async function bootstrap():Promise<{binding:ExecutionBinding;key:Buffer}>{
 return new Promise((resolve,reject)=>{let bytes=Buffer.alloc(0);const done=(error?:Error,value?:{binding:ExecutionBinding;key:Buffer})=>{clearTimeout(timer);process.stdin.pause();process.stdin.off('data',data);process.stdin.off('end',end);error?reject(error):resolve(value!);};const end=()=>done(Error('BOOTSTRAP_REQUIRED'));const timer=setTimeout(end,10000);
  const data=(chunk:Buffer)=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length>8192){done(Error('BOOTSTRAP_LIMIT'));return;}const at=bytes.indexOf(10);if(at<0)return;try{const raw=JSON.parse(bytes.subarray(0,at).toString('utf8'));if(raw.protocolVersion!==2||raw.purpose!=='accountless'||Object.keys(raw).sort().join(',')!=='binding,key,protocolVersion,purpose'||typeof raw.key!=='string'||!/^[a-f0-9]{64}$/.test(raw.key))throw 0;assertExecutionBinding(raw.binding);if(Object.keys(raw.binding).length!==9)throw 0;const rest=bytes.subarray(at+1);if(rest.length)process.stdin.unshift(rest);done(undefined,{binding:raw.binding,key:Buffer.from(raw.key,'hex')});bytes.fill(0);}catch{done(Error('BOOTSTRAP_INVALID'));}};
  process.stdin.on('data',data);process.stdin.once('end',end);process.stdin.resume();
 });
}
async function main(){
 if(process.platform!=='linux'||process.arch!=='arm64'||process.getuid?.()!==1000||process.version!=='v24.19.0')throw Error('OCI_RUNTIME_REQUIRED');
 if(process.argv.length!==3)throw Error('FIXED_MODE_REQUIRED');
 if(process.argv[2]==='idle'){const timer=setInterval(()=>{},60000);process.once('SIGTERM',()=>{clearInterval(timer);process.exit(0);});return;}
 if(process.argv[2]!=='accountless')throw Error('FIXED_MODE_REQUIRED');
 const {binding,key}=await bootstrap();
 // Distinct probe homes never borrow or overwrite Bot login state. Business work remains on the work volume.
 directory('/an/private/probes');const root=`/an/private/probes/${createHash('sha256').update(canonicalJson(binding)).digest('hex')}`;directory(root);directory(`${root}/home`);
 const home=`${root}/home`;for(const name of ['.codex','.config']){directory(`${home}/${name}`);if(readdirSync(`${home}/${name}`).length)throw Error('ACCOUNTLESS_HOME_REQUIRED');}
 const runtime=JSON.parse(readFileSync('/opt/an/runtime.json','utf8'));const binary='/opt/an/bin/codex';const stat=lstatSync(binary);
 if(runtime.version!=='0.159.2'||!/^([a-f0-9]{64})$/.test(runtime.sha256)||!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o022)!==0||createHash('sha256').update(readFileSync(binary)).digest('hex')!==runtime.sha256)throw Error('UNTRUSTED_CODEX');
 // The namespace/engine lifecycle, not killpg or parent exit, owns final stop proof.
 let child:ChildProcessWithoutNullStreams|undefined,closed=false;const db=new DatabaseSync(`${root}/runner.sqlite`),stream=Duplex.from({readable:process.stdin,writable:process.stdout});
 const endpoint=servePodmanAccountless({db,stream,key,binding,assertCurrent(){if(closed)throw Error('CHANNEL_CLOSED');},async openNative(b){
  if(child)throw Error('NATIVE_ALREADY_OPEN');child=spawn(binary,['app-server','--listen','stdio://'],{cwd:'/tmp',env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',HOME:home,CODEX_HOME:`${home}/.codex`,XDG_CONFIG_HOME:`${home}/.config`,XDG_CACHE_HOME:`${home}/.cache`,XDG_DATA_HOME:`${home}/.local/share`},stdio:['pipe','pipe','pipe'],detached:true});child.on('error',()=>stream.destroy());child.stdin.on('error',()=>{});let bytes=0;child.stderr.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>65536)stream.destroy();});return {binding:b,input:child.stdout,output:child.stdin};
 }});
 const cleanup=()=>{if(closed)return;closed=true;endpoint();key.fill(0);if(child?.pid){try{process.kill(-child.pid,'SIGTERM');}catch{/* No stop proof is issued. */}}db.close();};
 stream.once('close',cleanup);stream.once('error',cleanup);process.once('SIGTERM',()=>{cleanup();process.exit(0);});process.stdin.resume();
}
// Sanitized constant error only: never log bootstrap keys, credentials or runtime stderr.
void main().catch(()=>{process.stderr.write('PODMAN_ACCOUNTLESS_BLOCKED\n');process.exitCode=1;process.stdin.destroy();});
