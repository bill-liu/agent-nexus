import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as cp from 'node:child_process';
import * as path from 'node:path';
import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
const sourcePath=new URL('../../../scripts/prepare-vm-disk.mjs',import.meta.url).pathname;
const source=fs.readFileSync(sourcePath,'utf8');
const pinned='1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55';
const results=[];
for(const mode of ['initially-expired','missing-expiry','nonnumeric-expiry','expires-during-hash','revoked-during-hash','expires-during-convert','expires-during-resize','expiry-between-clock-reads','existing-destination','interrupted-staging','destination-created-during-convert','valid']){
 const root=fs.realpathSync(fs.mkdtempSync('/tmp/an-disk-auth-test-'));
 fs.chmodSync(root,0o700);
 const image=path.join(root,'small-synthetic-image'),converter=path.join(root,'inert-converter'),configPath=path.join(root,'authority.json');
 fs.writeFileSync(image,'SYNTHETIC INERT SOURCE');fs.writeFileSync(converter,'NOT AN EXECUTABLE');
 let clock=1_000_000;const expiresAt=mode==='initially-expired'?clock-1:clock+10;
 fs.writeFileSync(configPath,JSON.stringify({targetId:'synthetic-review-only',...(mode==='missing-expiry'?{}:{expiresAt:mode==='nonnumeric-expiry'?'invalid':expiresAt}),action:'prepare-disk',operationId:'synthetic',root,destination:path.join(root,'disk.raw'),diskBytes:1024**3,qemuImg:converter,qemuImgSHA256:crypto.createHash('sha256').update(fs.readFileSync(converter)).digest('hex')}),{mode:0o600});
 if(mode==='existing-destination')fs.writeFileSync(path.join(root,'disk.raw'),'EXISTING USER DATA');if(mode==='interrupted-staging')fs.mkdirSync(path.join(root,'an-prepare-synthetic'),{mode:0o700});
 const calls=[],logs=[];let hashNumber=0,exitCode=0;
 let clockReads=0;class TestDate extends Date {static now(){if(mode==='expiry-between-clock-reads'&&++clockReads===5)clock=expiresAt;return clock;}}
 const context=createContext({Buffer,Date:TestDate,console:{log:s=>logs.push(JSON.parse(s))},process:{argv:['node',sourcePath,'--apply',configPath,image],getuid:process.getuid,exit:c=>{exitCode=c;}}});
 const imports={
  'node:fs':{...fs,statSync:p=>{const stat=fs.statSync(p);if(p.endsWith('/disk.raw'))stat.size=1024**3;return stat;},createReadStream:p=>{if(p===image&&mode==='expires-during-hash')clock=expiresAt+1;if(p===image&&mode==='revoked-during-hash'){const changed=JSON.parse(fs.readFileSync(configPath,'utf8'));changed.action='revoked';fs.writeFileSync(configPath,JSON.stringify(changed),{mode:0o600});}return fs.createReadStream(p);}},
  // The first source digest alone is substituted to reach the admitted branch without an image download.
  // Converter pin, all private file/path checks, and script control flow are actual current source.
  'node:crypto':{...crypto,createHash:algorithm=>{const n=++hashNumber,h=crypto.createHash(algorithm);return {update:b=>{h.update(b);},digest:encoding=>n===1?pinned:h.digest(encoding)};}},
  'node:path':path,
  // No qemu process starts and no VM-sized artifact is allocated. Only record reached side effects.
  'node:child_process':{...cp,execFileSync:(executable,args,options)=>{calls.push({command:args[0],expired:clock>=expiresAt,timeout:options.timeout,killSignal:options.killSignal});if(args[0]==='convert')fs.writeFileSync(args.at(-1),'INERT SMALL OUTPUT');if(mode==='destination-created-during-convert'&&args[0]==='convert')fs.writeFileSync(path.join(root,'disk.raw'),'EXISTING USER DATA');if(mode===`expires-during-${args[0]}`)clock=expiresAt+1;return Buffer.alloc(0);}}
 };
 const module=new SourceTextModule(source,{context,identifier:sourcePath});
 await module.link(async specifier=>{const values=imports[specifier];const names=Object.keys(values);const dependency=new SyntheticModule(names,function(){for(const name of names)this.setExport(name,values[name]);},{context});return dependency;});
 await module.evaluate();
 results.push({mode,exitCode,logs,converterCalls:calls,stagingCreated:fs.existsSync(path.join(root,'an-prepare-synthetic')),destinationExists:fs.existsSync(path.join(root,'disk.raw')),destinationContent:fs.existsSync(path.join(root,'disk.raw'))?fs.readFileSync(path.join(root,'disk.raw'),'utf8'):null});
 fs.rmSync(root,{recursive:true,force:true});
}
console.log(JSON.stringify({sourcePath,sourceSHA256:crypto.createHash('sha256').update(source).digest('hex'),syntheticSourceDigest:true,converterActuallyExecuted:false,vmStarted:false,results},null,2));
