import {createHash} from 'node:crypto';
import {constants,createReadStream,openSync,closeSync,fstatSync,lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {readP1ProtectedJSON} from './p1-admission.js';
import {readP1EnvironmentAdmission,type P1EnvironmentAdmission} from './p1-environment-admission.js';
import {readInstalledRuntime,connectInstalledRun} from './p1-installed.js';
import {canonicalDigest} from './approvals.js';
import {VMHelperProcessTransport,MacOSVMProvider} from '../../execution/src/providers/macos-vm.js';
import {createP1EnvironmentInitializer} from './p1-environment.js';
import type {P1Application} from './p1-application.js';

function exact(v:unknown,keys:string[]):asserts v is Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw Error('ENVIRONMENT_INSTALLATION_INVALID');}
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown)=>typeof v==='string'&&v.trim().length>0&&v.length<=256;
const absolute=(v:unknown):v is string=>typeof v==='string'&&isAbsolute(v)&&resolve(v)===v;
/** Construction validates only protected metadata; no helper spawn, disk read, install or VM effect. */
export function createConfiguredEnvironmentInitializer(app:P1Application,path:string,admission:P1EnvironmentAdmission){
 const config=readInstalledRuntime(admission.runtimeConfigPath);
 const manifest=readP1ProtectedJSON(admission.installationManifestPath);
 exact(manifest,['version','targetId','botId','nodeId','sandboxId','disk','runtimeDigest','policyDigest','sourceRevision','packageLockDigest','rootfsManifestDigest','guestArtifactsDigest','signaturesRef']);exact(manifest.disk,['path','bytes','sha256']);
 if(manifest.version!==1||!absolute(manifest.disk.path)||!Number.isSafeInteger(manifest.disk.bytes)||Number(manifest.disk.bytes)<1073741824||Number(manifest.disk.bytes)>128*1073741824||!hash(manifest.disk.sha256)||!['runtimeDigest','policyDigest','packageLockDigest','rootfsManifestDigest','guestArtifactsDigest'].every(k=>hash(manifest[k]))||typeof manifest.sourceRevision!=='string'||!/^[a-f0-9]{40}$/.test(manifest.sourceRevision)||!text(manifest.signaturesRef))throw Error('ENVIRONMENT_INSTALLATION_INVALID');
 if(['targetId','botId','nodeId','sandboxId','generation'].some(k=>config[k as keyof typeof config]!==admission[k as keyof P1EnvironmentAdmission])||config.expiresAt>admission.expiresAt||['targetId','botId','nodeId','sandboxId'].some(k=>manifest[k]!==admission[k as keyof P1EnvironmentAdmission])||manifest.runtimeDigest!==config.node.runtimeDigest||manifest.policyDigest!==config.node.policyDigest||config.loginKind||config.verification||config.profile.budget!==0||config.profile.requireAccount||config.profile.requireKnownBilling)throw Error('ENVIRONMENT_BINDING_MISMATCH');
 const authority=readP1ProtectedJSON(config.helper.authorityPath);
 exact(authority,['protocolVersion','nodeId','targetId','expiresAt','root','actions','sandboxes']);exact(authority.sandboxes,[config.sandboxId]);
 const spec=authority.sandboxes[config.sandboxId];exact(spec,['botId','disk','efi','cpuCount','memoryBytes','diskBytes','networkMode']);
 if(authority.protocolVersion!==1||authority.nodeId!==config.nodeId||authority.targetId!==config.targetId||!Number.isSafeInteger(authority.expiresAt)||Number(authority.expiresAt)<admission.expiresAt||authority.root!==config.node.privateRoot||!absolute(authority.root)||!Array.isArray(authority.actions)||authority.actions.length!==5||['inspect','create','start','connect','stop'].some(a=>!(authority.actions as unknown[]).includes(a))||spec.botId!==config.botId||spec.disk!==manifest.disk.path||spec.diskBytes!==manifest.disk.bytes||spec.networkMode!=='none'||!absolute(spec.efi)||!spec.disk.startsWith(authority.root+'/')||!spec.efi.startsWith(authority.root+'/')||!Number.isSafeInteger(spec.cpuCount)||Number(spec.cpuCount)<1||Number(spec.cpuCount)>8||!Number.isSafeInteger(spec.memoryBytes)||Number(spec.memoryBytes)<536870912||Number(spec.memoryBytes)>16*1073741824)throw Error('ENVIRONMENT_HELPER_SCOPE_INVALID');
 const disk=manifest.disk as {path:string;bytes:number;sha256:string};
 const assertAction=(action:string,owned=false)=>{
  if(owned){if(action!=='stop'||!admission.actions.includes('stop'))throw Error('ENVIRONMENT_ADMISSION_REQUIRED');return;}
  const current=readP1EnvironmentAdmission(path);
  if(!current.actions.includes(action as never)||canonicalDigest(current)!==canonicalDigest(admission)||canonicalDigest(readInstalledRuntime(admission.runtimeConfigPath))!==canonicalDigest(config)||canonicalDigest(readP1ProtectedJSON(admission.installationManifestPath))!==canonicalDigest(manifest)||canonicalDigest(readP1ProtectedJSON(config.helper.authorityPath))!==canonicalDigest(authority))throw Error('ENVIRONMENT_ADMISSION_REQUIRED');
 };
 const helper=new VMHelperProcessTransport(config.helper),provider=new MacOSVMProvider(helper);
 return createP1EnvironmentInitializer(app,{target:{targetId:config.targetId,botId:config.botId,nodeId:config.nodeId,sandboxId:config.sandboxId,generation:config.generation,transportInstanceId:config.node.transportInstanceId,expiresAt:Math.min(config.expiresAt,admission.expiresAt)},vmHelper:helper,assertAction,
  connectRun:(run,sandboxId,assertCurrent)=>connectInstalledRun(config,provider,run,sandboxId,action=>{assertCurrent();assertAction(action);}),
  async verifyInstallation(){
   assertAction('inspect');const root=lstatSync(config.node.privateRoot);
   if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==process.getuid?.()||(root.mode&0o777)!==0o700||realpathSync(config.node.privateRoot)!==config.node.privateRoot||realpathSync(disk.path)!==disk.path)throw Error('ENVIRONMENT_DISK_REQUIRED');
   const fd=openSync(disk.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.uid!==process.getuid?.()||(before.mode&0o777)!==0o600||before.size!==disk.bytes)throw Error('ENVIRONMENT_DISK_REQUIRED');
    const digest=createHash('sha256');for await(const bytes of createReadStream(disk.path,{fd,autoClose:false}))digest.update(bytes);
    const after=fstatSync(fd),named=lstatSync(disk.path);if(before.ino!==named.ino||before.dev!==named.dev||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.size!==after.size||digest.digest('hex')!==disk.sha256)throw Error('ENVIRONMENT_DISK_CHANGED');
    assertAction('inspect');
   }finally{closeSync(fd);}
  }
 });
}
