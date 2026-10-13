import {test,expect} from '@playwright/test';
import {launchPackaged} from '../electron-security/helpers.js';

test('actual packaged Mac safeStorage protects a temporary synthetic credential',async()=>{
 expect(process.platform).toBe('darwin');
 const {app,page,cleanup}=await launchPackaged();
 try {
  const result=await app.evaluate(({app,safeStorage})=>{
   const {createRequire}=process.getBuiltinModule('node:module');
   const require=createRequire(`${app.getAppPath()}/package.json`);
   const fs=require('node:fs') as typeof import('node:fs');
   const {join}=require('node:path') as typeof import('node:path');
   const {tmpdir}=require('node:os') as typeof import('node:os');
   const {randomUUID}=require('node:crypto') as typeof import('node:crypto');
   const {MacOSSecretVault}=require(join(app.getAppPath(),'build/macos-secrets.cjs'));
   const {SecretBroker}=require(join(app.getAppPath(),'build/protected-secrets.cjs'));
   const temporary=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'an-safe-storage-canary-')));
   const directory=join(temporary,'vault');
   try {
    const vault=new MacOSSecretVault({directory,safeStorage});
    if(!vault.isAvailable())throw Error('MAC_SAFE_STORAGE_NOT_AVAILABLE');
    const broker=new SecretBroker(vault);
    const canary=`SYNTHETIC_MAC_CANARY_${randomUUID()}`;
    const bytes=Buffer.from(canary);
    const saved=broker.save(bytes);
    const files=fs.readdirSync(directory);
    if(files.length!==1)throw Error('UNEXPECTED_CANARY_FILES');
    const file=join(directory,files[0]!);
    const encrypted=fs.readFileSync(file);
    const decoded=vault.readForExecution(saved.credentialRef) as Buffer;
    const evidence={platform:process.platform,electron:process.versions.electron,
     backend:saved.storage,inputZeroed:bytes.every(byte=>byte===0),
     directoryMode:fs.statSync(directory).mode&0o777,fileMode:fs.statSync(file).mode&0o777,
     ciphertextHasPlaintext:encrypted.includes(canary)||encrypted.includes(Buffer.from(canary).toString('base64')),
     roundtrip:decoded.toString()===canary,deleted:false};
    decoded.fill(0);encrypted.fill(0);
    broker.revoke(saved.credentialRef);evidence.deleted=fs.readdirSync(directory).length===0;
    return evidence;
   } finally {fs.rmSync(temporary,{recursive:true,force:true});}
  });
  expect(result).toMatchObject({platform:'darwin',backend:'macos_safe_storage',inputZeroed:true,
   directoryMode:0o700,fileMode:0o600,ciphertextHasPlaintext:false,roundtrip:true,deleted:true});
  expect(await page.evaluate(()=>Object.keys((window as any).an).some(key=>/read.*secret|plaintext/i.test(key)))).toBe(false);
  await test.info().attach('macos-safe-storage-evidence',{body:JSON.stringify(result,null,2),contentType:'application/json'});
 } finally {
  await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});cleanup();
 }
});

test('packaged verifier compiler transforms text using its unpacked fixed tool without executing source',async()=>{
 const {app,cleanup}=await launchPackaged();
 try{const result=await app.evaluate(({app})=>{
  const {createRequire}=process.getBuiltinModule('node:module')!;const {join,dirname}=process.getBuiltinModule('node:path')!;
  const require=createRequire(join(app.getAppPath(),'package.json'));
  process.env.ESBUILD_BINARY_PATH=join(dirname(app.getAppPath()),`app.asar.unpacked/node_modules/@esbuild/darwin-${process.arch}/bin/esbuild`);
  // The production utilityProcess has explicit physical cwd=userData. Electron
  // Main's ASAR cwd is not a real directory suitable for spawning the compiler.
  const previous=process.cwd();process.chdir(app.getPath('userData'));
  try{const {compileCandidate}=require(join(app.getAppPath(),'build/verifier-compiler.cjs'));const code=compileCandidate("throw new Error('MUST_NOT_EXECUTE');export function exportRecords(a){return a.slice()}");
  return {transformed:code.includes('module.exports.exportRecords'),containsUnevaluatedThrow:code.includes('MUST_NOT_EXECUTE')};}
  finally{process.chdir(previous);}
 });expect(result).toEqual({transformed:true,containsUnevaluatedThrow:true});}
 finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});cleanup();}
});
