import {it,expect} from 'vitest';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPackageWithOptions,statFile} from '@electron/asar';
it('actual ASAR leaves fixed compiler library and binary as physical files usable by spawn',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'an-archive-contract-'))),src=join(dir,'source'),archive=join(dir,'app.asar');
 const files=['node_modules/esbuild/lib/main.js','node_modules/@esbuild/darwin-arm64/bin/esbuild'];
 try{for(const file of files){mkdirSync(join(src,file,'..'),{recursive:true});writeFileSync(join(src,file),'SYNTHETIC_COMPILER_BYTES',{mode:0o500});}
 const {compilerAsarOptions}=await import(new URL('../../scripts/package-policy.mjs',import.meta.url).href);await createPackageWithOptions(src,archive,compilerAsarOptions);
 for(const file of files){expect(statFile(archive,file).unpacked).toBe(true);expect(readFileSync(join(archive+'.unpacked',file),'utf8')).toBe('SYNTHETIC_COMPILER_BYTES');}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
