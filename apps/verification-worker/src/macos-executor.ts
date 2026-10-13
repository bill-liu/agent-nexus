import {spawn} from 'node:child_process';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {transformSync} from 'esbuild';
import {behaviorAssertionIds,type AssertionResult} from '../../../packages/contracts/src/evidence.js';
import {canonicalJson} from '../../../packages/persistence/src/unit-of-work.js';
import {hash} from './candidate.js';
import type {TrustedVerifierExecutor,VerificationRequest} from './evidence.js';
import type {VerifierBinding,VerificationAuthorization} from './isolated-executor.js';
export interface MacProtectedVerifierOptions {
 binaryPath:string;binaryDigest:string;trustedRoot:string;oracleDigest:string;
 authorization:VerificationAuthorization;binding:VerifierBinding;
 /** Main/Core checks current epoch, task/run/sandbox generation/fence and candidate
  * binding synchronously. Never sourced from renderer/Node request callbacks. */
 assertCurrent:(binding:Readonly<VerifierBinding>,candidateDigest:string)=>void;
}
interface Call {records:unknown;recordsKind?:'undefined';maximumKind:'value'|'omitted'|'undefined'|'NaN'|'Infinity';maximum?:unknown}
interface Observation {value:unknown;isArray:boolean;sameArray:boolean;inputUnchanged:boolean;errorName:null|'TypeError'|'RangeError'|'OtherError';sandbox:'pure-computation-no-fds-v1'}
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
/** Compiler only; generated JS is never evaluated by Node. Imports have no native
 * bridge (require is unbound); dynamic imports cannot access a module loader. */
export function compileCandidate(source:string):string {
 if(Buffer.byteLength(source)>262144)throw new Error('BLOCKED_CANDIDATE_SOURCE_LIMIT');
 const transformed=transformSync(source,{loader:'js',format:'cjs',target:'es2022',platform:'neutral',logLevel:'silent'}).code;
 return `(()=>{ 'use strict'; const module={exports:{}}; const exports=module.exports;\n${transformed}\nreturn module.exports.exportRecords; })()`;
}
function pinnedBinary(o:MacProtectedVerifierOptions):void {
 const root=resolve(o.trustedRoot);const file=resolve(o.binaryPath);
 if(realpathSync(root)!==root||realpathSync(file)!==file||!file.startsWith(root+'/')||file===root)throw new Error('BLOCKED_UNTRUSTED_HELPER_PATH');
 for(let p=file;;p=dirname(p)){const s=lstatSync(p);if(s.isSymbolicLink()||(s.mode&0o022)!==0||(p===file&&(!s.isFile()||s.nlink!==1)))throw new Error('BLOCKED_WRITABLE_HELPER');if(p===root)break;}
 if(!/^[a-f0-9]{64}$/.test(o.binaryDigest)||hash(readFileSync(file))!==o.binaryDigest)throw new Error('BLOCKED_HELPER_DIGEST');
}
/** Only a pinned native executable runs on the host. Candidate JS is a string in
 * JavaScriptCore with no host bridges, after actual OS denial/resource checks.
 * Candidate stdout is impossible at the language boundary: no process/print/
 * console/require/native callback is ever installed. This is not Node vm. */
export class MacProtectedVerifierExecutor implements TrustedVerifierExecutor {
 readonly source='isolated-verifier' as const;
 readonly platform={os:'darwin',arch:process.arch};
 readonly capabilities=['os-sandbox','immutable-candidate','immutable-oracle','independent-assertion-channel','no-network'];
 private busy=false;
 private readonly options:MacProtectedVerifierOptions;
 constructor(options:MacProtectedVerifierOptions){this.options={...options,binding:structuredClone(options.binding),authorization:structuredClone(options.authorization)};}
 private authorize(candidateDigest:string):void {
  const o=this.options;
  if(process.platform!=='darwin')throw new Error('BLOCKED_MACOS_PROTECTED_VERIFIER_REQUIRED');
  if(o.authorization.targetId!==o.binding.sandboxId||o.authorization.expiresAt<=Date.now()||!o.authorization.actions.includes('verify-candidate'))throw new Error('VERIFIER_AUTHORIZATION_REQUIRED');
  o.assertCurrent(structuredClone(o.binding),candidateDigest);pinnedBinary(o);
 }
 private async probe(source:string,call:Call):Promise<Observation|null>{
  const result=await new Promise<{stdout:string;code:number|null;signal:string|null}>((resolveResult,reject)=>{
   // Explicitly empty environment; no HOME/PATH/runtime options or credentials.
   const child=spawn(this.options.binaryPath,[],{env:{},cwd:this.options.trustedRoot,stdio:['pipe','pipe','pipe']});
   let stdout='';let size=0;let failure:Error|undefined;
   // Await close even after timeout/output failure; never release the verifier
   // while its bounded process may still exist. The helper cannot fork.
   const fail=(error:Error)=>{if(failure)return;failure=error;child.kill('SIGKILL');};
   const timer=setTimeout(()=>fail(new Error('BLOCKED_VERIFIER_TIMEOUT')),5000);
   child.on('error',error=>{clearTimeout(timer);fail(error);});
   child.stdout.on('data',(data:Buffer)=>{size+=data.length;if(size>65536)fail(new Error('BLOCKED_VERIFIER_OUTPUT_LIMIT'));else stdout+=data.toString('utf8');});
   child.stderr.on('data',(data:Buffer)=>{size+=data.length;if(size>65536)fail(new Error('BLOCKED_VERIFIER_OUTPUT_LIMIT'));});
   child.stdin.on('error',()=>{});
   child.on('close',(code,signal)=>{clearTimeout(timer);if(failure)reject(failure);else resolveResult({stdout,code,signal});});
   child.stdin.end(JSON.stringify({source,call}));
  });
  if(result.signal||result.code!==0)throw new Error('BLOCKED_NATIVE_VERIFIER');
  let p:Observation;try{p=JSON.parse(result.stdout) as Observation;}catch{throw new Error('BLOCKED_NATIVE_REPORT');}
  const keys=['value','isArray','sameArray','inputUnchanged','errorName','sandbox'];
  if(!p||Object.keys(p).length!==keys.length||keys.some(k=>!Object.hasOwn(p,k))||typeof p.isArray!=='boolean'||typeof p.sameArray!=='boolean'||typeof p.inputUnchanged!=='boolean'||(p.errorName!==null&&!['TypeError','RangeError','OtherError'].includes(p.errorName))||p.sandbox!=='pure-computation-no-fds-v1')throw new Error('BLOCKED_NATIVE_REPORT');
  return p;
 }
 async execute(input:VerificationRequest){
  this.authorize(input.candidateDigest);
  if(this.busy)throw new Error('VERIFIER_BUSY');this.busy=true;
  try{
   if(input.oracleDigest!==this.options.oracleDigest||hash(readFileSync(input.oraclePath))!==input.oracleDigest)throw new Error('ORACLE_MISMATCH');
   const recipe=JSON.parse(readFileSync(input.oraclePath,'utf8'));
   if(recipe.version!=='p1-protected-oracle-v2'||recipe.entry!=='src/export-records.mjs'||!same(recipe.assertionsA,behaviorAssertionIds('A'))||!same([...recipe.assertionsA,...recipe.assertionsB],behaviorAssertionIds('B')))throw new Error('INVALID_ORACLE');
   const sourceBytes=readFileSync(join(input.candidatePath,'src/export-records.mjs'),'utf8');
   const source=compileCandidate(sourceBytes);const assertions:AssertionResult[]=[];const observations:unknown[]=[];const deadline=Date.now()+175000;
   const probe=async(call:Call)=>{this.authorize(input.candidateDigest);if(Date.now()>deadline)throw new Error('BLOCKED_VERIFIER_TIMEOUT');const p=await this.probe(source,call);this.authorize(input.candidateDigest);observations.push(p);return p;};
   const normal=async(records:unknown[],maximumKind:Call['maximumKind'],maximum?:number)=>{const p=await probe({records,maximumKind,maximum});return !!p&&p.errorName===null&&p.isArray&&!p.sameArray&&p.inputUnchanged&&same(p.value,records.slice(0,maximum??1000));};
   const check=async(id:string,run:()=>Promise<boolean>)=>assertions.push({id,status:await run()?'PASS':'FAIL'});
   await check('ordered-limit',()=>normal([3,1,2],'value',2));
   await check('short-input',()=>normal([3],'value',10));
   await check('fresh-empty',()=>normal([],'omitted'));
   await check('fresh-nonmutating',()=>normal([3,1,2],'value',3));
   const large=Array.from({length:10002},(_,i)=>i);
   await check('default-1000',async()=>{const a=await normal(large.slice(0,1002),'omitted');return await normal(large.slice(0,1002),'undefined')&&a;});
   await check('valid-boundaries',async()=>{const a=await normal(large,'value',1);return await normal(large,'value',10000)&&a;});
   if(input.stage==='B'){
    await check('invalid-records',async()=>{let pass=true;for(const records of recipe.invalidRecords){const p=await probe({records,maximumKind:'omitted'});pass=p?.errorName==='TypeError'&&pass;}return (await probe({records:null,recordsKind:'undefined',maximumKind:'omitted'}))?.errorName==='TypeError'&&pass;});
    await check('invalid-limits',async()=>{let pass=true;for(const maximum of recipe.invalidLimits){const p=await probe({records:[],maximumKind:'value',maximum});pass=p?.errorName==='RangeError'&&pass;}for(const maximumKind of recipe.specialInvalidLimits){const p=await probe({records:[],maximumKind});pass=p?.errorName==='RangeError'&&pass;}return pass;});
   }
   this.authorize(input.candidateDigest);
   if(readFileSync(join(input.candidatePath,'src/export-records.mjs'),'utf8')!==sourceBytes||hash(readFileSync(input.oraclePath))!==input.oracleDigest)throw new Error('SNAPSHOT_TAMPERED');
   return {assertions,exitCode:assertions.every(a=>a.status==='PASS')?0:1,command:['an-macos-verifier','javascriptcore-c-api-v2'],outputDigest:hash(canonicalJson(observations))};
  }finally{this.busy=false;}
 }
}
