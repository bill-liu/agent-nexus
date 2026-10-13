// Standard macOS CI only. Builds a protected pure-JS helper and executes ONLY
// curated controls. No VM, account, Agent CLI, external model or host candidate
// import. No production live task evidence is emitted by this canary.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,chmodSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {transformSync,build} from 'esbuild';
if(process.platform!=='darwin')throw new Error('MACOS_CANARY_REQUIRED');
const root=realpathSync(mkdtempSync(join(tmpdir(),'an-native-verifier-')));chmodSync(root,0o700);
const binary=join(root,'an-macos-verifier');
const compile=source=>`(()=>{'use strict'; const module={exports:{}};const exports=module.exports;\n${transformSync(source,{loader:'js',format:'cjs',target:'es2022',platform:'neutral'}).code}\nreturn module.exports.exportRecords;})()`;
const call={records:[3,1,2],maximumKind:'value',maximum:2};
let passed=0;
function probe(source,data=call){return spawnSync(binary,[],{input:JSON.stringify({source:compile(source),call:data}),env:{},encoding:'utf8',timeout:5000,maxBuffer:65536,killSignal:'SIGKILL'});}
function observation(source,data){const r=probe(source,data);assert.equal(r.status,0,`${r.stderr} ${r.error?.message??''}`);assert.equal(r.signal,null);const p=JSON.parse(r.stdout);assert.equal(p.sandbox,'pure-computation-no-fds-v1');return p;}
function check(name,run){run();passed++;console.log(`PASS ${name}`);}
try{
 execFileSync('clang',['-fobjc-arc','-Wall','-Wextra','-Werror','-framework','Foundation','-framework','JavaScriptCore',resolve('native/macos-verifier/main.m'),'-o',binary],{stdio:'inherit'});chmodSync(binary,0o500);
 const source=name=>readFileSync(resolve(`tests/fixtures/p1-oracle/controls/${name}.mjs`),'utf8');
 check('known correct native observation',()=>{const p=observation(source('task-b'));assert.deepEqual(p.value,[3,1]);assert.equal(p.isArray,true);assert.equal(p.sameArray,false);assert.equal(p.inputUnchanged,true);assert.equal(p.errorName,null);});
 check('wrong candidate native value cannot PASS',()=>{const p=observation(source('wrong'));assert.notDeepEqual(p.value,[3,1]);});
 check('correctly shaped stdout/exit forgery cannot PASS',()=>{const p=observation(source('forged-observation'));assert.notEqual(p.errorName,null);assert.equal(p.isArray,false);assert.equal(p.value,null);});
 check('intrinsic/toJSON tampering cannot PASS',()=>{const p=observation(source('tampered-intrinsics'));assert.equal(p.isArray,false);assert.equal(p.value,'WRONG');});
 check('native identity survives Object.is replacement',()=>{const p=observation('Object.is=()=>false; export function exportRecords(a){return a;}');assert.equal(p.sameArray,true);});
 check('error name is not a JS-controlled string',()=>{const p=observation("export function exportRecords(){throw {name:'TypeError'};}");assert.equal(p.errorName,'OtherError');});
 check('original TypeError/RangeError prototypes observed',()=>{assert.equal(observation(source('task-b'),{records:null,maximumKind:'omitted'}).errorName,'TypeError');assert.equal(observation(source('task-b'),{records:[],maximumKind:'NaN'}).errorName,'RangeError');});
 check('host bridge globals absent',()=>{const p=observation("export function exportRecords(){return [typeof process,typeof require,typeof console,typeof print,typeof fetch,typeof readFile,typeof ObjC,typeof $];}");assert.deepEqual(p.value,Array(8).fill('undefined'));});
 check('mutation blocked by native captured freeze',()=>{const p=observation("Object.freeze=x=>x; export function exportRecords(a){a[0]=999;return a.slice(0,2);}");assert.equal(p.errorName,'TypeError');});
 check('CPU/time bound kills infinite JS',()=>{const r=probe('export function exportRecords(){while(true){}}');assert.notEqual(r.status,0);});
 // Exercise the actual TypeScript supervisor + pinned native adapter as well.
 const bundle=join(root,'executor.mjs');await build({entryPoints:[resolve('apps/verification-worker/src/macos-executor.ts')],outfile:bundle,bundle:true,platform:'node',format:'esm',plugins:[{name:'existing-esbuild',setup(build){build.onResolve({filter:/^esbuild$/},()=>({path:fileURLToPath(import.meta.resolve('esbuild')),external:true}));}}]});
 // esbuild is resolved from the repo for the bundle, not a new dependency.
 const {MacProtectedVerifierExecutor}=await import(bundle);
 const {mkdtempSync:mktemp,mkdirSync,writeFileSync}=await import('node:fs');
 const work=mktemp(join(root,'candidate-'));mkdirSync(join(work,'src'));
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');const oraclePath=resolve('apps/verification-worker/oracle/p1.json');
 const binding={nodeId:'synthetic-node',sandboxId:'synthetic-canary',generation:1,transportInstanceId:'transport',processInstanceId:'native',runId:'synthetic-run',fencingToken:1,sessionId:'session',turnId:'turn'};
 const executor=new MacProtectedVerifierExecutor({binaryPath:binary,binaryDigest:digest(readFileSync(binary)),trustedRoot:root,oracleDigest:digest(readFileSync(oraclePath)),binding,authorization:{targetId:binding.sandboxId,expiresAt:Date.now()+180000,actions:['verify-candidate']},assertCurrent:()=>{}});
 for(const name of ['task-a','task-b','wrong','forged-observation','tampered-intrinsics']){
  writeFileSync(join(work,'src/export-records.mjs'),source(name));
  const r=await executor.execute({candidatePath:work,oraclePath,oracleDigest:digest(readFileSync(oraclePath)),candidateDigest:digest(source(name)),stage:name==='task-a'?'A':'B'});
  assert.equal(r.exitCode,name==='task-a'||name==='task-b'?0:1);passed++;console.log(`PASS supervisor ${name}`);
 }
 console.log(`PASS ${passed} curated native checks (synthetic only)`);
}finally{rmSync(root,{recursive:true,force:true});}
