import {it,expect} from 'vitest';
import {mkdtempSync,realpathSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as admissions from '../../packages/core/src/p1-admission';
import * as control from '../../apps/node-agent/src/control';
it('environment admission is independent of model/login and rejects expanded scope',()=>{
 expect(typeof (admissions as any).readP1EnvironmentAdmission).toBe('function');
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'an-env-admission-')),file=join(dir,'admission.json');
 const value={version:1,purpose:'environment-initialize',targetId:'synthetic-target',authorizationRef:'synthetic-approval',expiresAt:Date.now()+60000,botId:'bot',nodeId:'node',sandboxId:'sandbox:bot',generation:1,actions:['inspect','create-sandbox','start-sandbox','connect','initialize-runtime','stop'],runtimeConfigPath:join(dir,'runtime.json'),installationManifestPath:join(dir,'installation.json')};
 const write=(v:unknown)=>writeFileSync(file,JSON.stringify(v),{mode:0o600});
 try{write(value);expect((admissions as any).readP1EnvironmentAdmission(file)).toEqual(value);expect(()=>admissions.readP1Admission(file)).toThrow();for(const invalid of [{...value,connection:{}},{...value,grant:{}},{...value,actions:[...value.actions,'login']},{...value,actions:[...value.actions,'model.request']},{...value,actions:['inspect']},{...value,expiresAt:0},{...value,generation:0},{...value,botId:''},{...value,installationManifestPath:'relative'},{...value,exec:'/bin/sh'}]){write(invalid);expect(()=>(admissions as any).readP1EnvironmentAdmission(file)).toThrow();}write(value);chmodSync(file,0o644);expect(()=>(admissions as any).readP1EnvironmentAdmission(file)).toThrow('P1_ADMISSION_PATH_DENIED');}finally{rmSync(dir,{recursive:true,force:true});}
});
it('accountless policy rejects existing authentication/config before any native open',()=>{
 expect(typeof (control as any).assertAccountlessHome).toBe('function');
 const root=mkdtempSync(join(realpathSync(tmpdir()),'an-empty-home-'));
 try{expect(()=>(control as any).assertAccountlessHome(root)).not.toThrow();writeFileSync(join(root,'.codex'),'not-a-directory');expect(()=>(control as any).assertAccountlessHome(root)).toThrow('ACCOUNTLESS_HOME_REQUIRED');}finally{rmSync(root,{recursive:true,force:true});}
});
it('configured environment startup reads only small protected metadata and never spawns or initializes',async()=>{
 const installed=await import('../../packages/core/src/p1-installed');expect(typeof (installed as any).createConfiguredEnvironmentInitializer).toBe('function');
 const {P1Application}=await import('../../packages/core/src/p1-application');
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'an-environment-config-')),file=join(dir,'admission.json'),runtime=join(dir,'runtime.json'),manifest=join(dir,'installation.json'),authority=join(dir,'authority.json');
 const value={version:1,purpose:'environment-initialize',targetId:'synthetic-target',authorizationRef:'synthetic-approval',expiresAt:Date.now()+60000,botId:'bot',nodeId:'node',sandboxId:'sandbox:bot',generation:1,actions:['inspect','create-sandbox','start-sandbox','connect','initialize-runtime','stop'],runtimeConfigPath:runtime,installationManifestPath:manifest};
 const config={version:1,targetId:value.targetId,expiresAt:value.expiresAt,botId:'bot',nodeId:'node',sandboxId:'sandbox:bot',generation:1,helper:{helperPath:join(dir,'helper'),helperSHA256:'a'.repeat(64),authorityPath:authority},node:{privateRoot:dir,keyPath:join(dir,'key.json'),transportInstanceId:'transport',runtimeDigest:'b'.repeat(64),policyDigest:'c'.repeat(64)},profile:{projectId:'project',runtime:'codex-0.159.2',model:'unused',modelProvider:'unused',botDirectory:'/bot',cwd:'/workspace',candidateVersion:'unused',budget:0,requireAccount:false,requireKnownBilling:false,context:{}}};
 const image={version:1,targetId:value.targetId,botId:'bot',nodeId:'node',sandboxId:'sandbox:bot',disk:{path:join(dir,'guest.raw'),bytes:1073741824,sha256:'d'.repeat(64)},runtimeDigest:config.node.runtimeDigest,policyDigest:config.node.policyDigest,sourceRevision:'e'.repeat(40),packageLockDigest:'f'.repeat(64),rootfsManifestDigest:'a'.repeat(64),guestArtifactsDigest:'b'.repeat(64),signaturesRef:'synthetic-verification-ref'};
 const auth={protocolVersion:1,nodeId:'node',targetId:value.targetId,expiresAt:value.expiresAt,root:dir,actions:['inspect','create','start','connect','stop'],sandboxes:{'sandbox:bot':{botId:'bot',disk:image.disk.path,efi:join(dir,'efi'),cpuCount:2,memoryBytes:1073741824,diskBytes:image.disk.bytes,networkMode:'none'}}};
 const write=(path:string,v:unknown)=>writeFileSync(path,JSON.stringify(v),{mode:0o600});const app=new P1Application(':memory:');
 try{write(file,value);write(runtime,config);write(manifest,image);write(authority,auth);const parsed=(admissions as any).readP1EnvironmentAdmission(file);expect(()=>(installed as any).createConfiguredEnvironmentInitializer(app,file,parsed)).not.toThrow();expect(app.registry.list()).toHaveLength(0);expect(app.snapshot().runs).toHaveLength(0);const startup=P1Application.fromAdmission(':memory:',file);try{expect(startup.registry.list()).toHaveLength(0);expect(startup.snapshot().runs).toHaveLength(0);}finally{startup.close();}
 for(const bad of [{...auth,targetId:'other'},{...auth,actions:[...auth.actions,'destroy']},{...auth,sandboxes:{'sandbox:bot':{...auth.sandboxes['sandbox:bot'],networkMode:'nat'}}}]){write(authority,bad);expect(()=>(installed as any).createConfiguredEnvironmentInitializer(app,file,parsed)).toThrow();}write(authority,auth);write(manifest,{...image,disk:{...image.disk,path:'/outside/root.raw'}});expect(()=>(installed as any).createConfiguredEnvironmentInitializer(app,file,parsed)).toThrow();
 }finally{app.close();rmSync(dir,{recursive:true,force:true});}
});
it('Core startup uses independent environment mode; no default admission or invalid file can admit execution',async()=>{
 const {P1Application}=await import('../../packages/core/src/p1-application');expect(typeof (P1Application as any).fromAdmission).toBe('function');
 const app=(P1Application as any).fromAdmission(':memory:','');try{expect(app.registry.list()).toHaveLength(0);expect(app.snapshot().runs).toHaveLength(0);}finally{app.close();}
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'an-env-startup-')),file=join(dir,'bad.json');try{writeFileSync(file,'{}',{mode:0o600});expect(()=>(P1Application as any).fromAdmission(':memory:',file)).toThrow();}finally{rmSync(dir,{recursive:true,force:true});}
});
it('default environment card presents a disabled accountless action rather than implicit startup',async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server'),{createElement}=await import('react'),{Environment}=await import('../../apps/desktop/renderer/environment');const {P1Application}=await import('../../packages/core/src/p1-application');const app=new P1Application(':memory:');
 try{await app.command({type:'bot.create',commandId:'create',scope:{botId:'bot'},expectedVersion:0,name:'Blocked'},'local-user');const snapshot=app.snapshot();const html=renderToStaticMarkup(createElement(Environment,{bot:snapshot.bots[0],snapshot:{...snapshot,available:true} as any}));expect(html).toMatch(/<button[^>]*disabled=""[^>]*>无账号初始化<\/button>/);expect(html).toContain('环境操作批准');}finally{app.close();}
});
it('installed-only provisioner cannot fall through to create without a download manager',async()=>{
 const {P1Application}=await import('../../packages/core/src/p1-application'),{BotProvisioner}=await import('../../packages/core/src/bot-provision');const app=new P1Application(':memory:');let creates=0;
 try{await app.command({type:'bot.create',commandId:'create',scope:{botId:'bot'},expectedVersion:0,name:'Blocked'},'local-user');const provider={create:async()=>{creates++;return {protocolVersion:1,sandboxId:'sandbox:bot',generation:0,state:'created',evidenceKind:'scripted',observedAt:Date.now()};}} as any;const provisioner=new BotProvisioner(app.core.database,provider);await expect(provisioner.provision({operationId:'provision-bot',botId:'bot',sandboxId:'sandbox:bot',envelope:{} as any})).rejects.toThrow('DOWNLOAD_MANAGER_REQUIRED');expect(creates).toBe(0);}finally{app.close();}
});

it('shared installed channel rechecks admission after inspect before sending connect',async()=>{const {connectInstalledRun}=await import('../../packages/core/src/p1-installed');let authorized=true;const calls:string[]=[];const provider={inspect:async()=>{calls.push('inspect');authorized=false;return {state:'running',evidenceKind:'live',observedAt:Date.now()};},connect:async()=>{calls.push('connect');throw Error('CONNECT_AFTER_REVOKE');}};await expect(connectInstalledRun({botId:'bot',sandboxId:'s',generation:1} as any,provider as any,{botId:'bot',generation:1} as any,'s',()=>{if(!authorized)throw Error('REVOKED');})).rejects.toThrow('REVOKED');expect(calls).toEqual(['inspect']);});
