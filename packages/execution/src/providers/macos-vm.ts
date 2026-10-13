import { randomUUID } from 'node:crypto';
import type { SandboxProvider, SandboxRef, SandboxObservation, SandboxChannel } from '../../../contracts/src/sandbox';

/** Source pin is an integrity anchor, not proof that the image was downloaded, licensed for redistribution or booted. */
export const PINNED_BOOTSTRAP = Object.freeze({
 id:'ubuntu-24.04.3-live-server-arm64', version:'24.04.3', architecture:'arm64', format:'iso',
 source:'https://cdimage.ubuntu.com/ubuntu/releases/24.04.3/release/ubuntu-24.04.3-live-server-arm64.iso',
 checksumSource:'https://cdimage.ubuntu.com/ubuntu/releases/24.04.3/release/SHA256SUMS',
 sha256:'2ee2163c9b901ff5926400e80759088ff3b879982a3956c02100495b489fd555',
 licenseSource:'https://ubuntu.com/legal/intellectual-property-policy',
 license:'Component licenses; retain /usr/share/doc/*/copyright. Unmodified local installation only; redistribution requires separate review.',
});
export function validateBootstrap(value: { [K in keyof typeof PINNED_BOOTSTRAP]: string }): void {
 if (Object.keys(PINNED_BOOTSTRAP).some(key => value?.[key as keyof typeof value] !== PINNED_BOOTSTRAP[key as keyof typeof value])) throw new Error('UNTRUSTED_BOOTSTRAP');
}
export interface VMHelperRequest { protocolVersion:1;commandId:string;command:'create'|'start'|'stop'|'inspect'|'connect'|'destroy';sandboxId:string;generation:number;operationId?:string;botId?:string }
/** Adapter is supplied by trusted Main/Core over the helper's private inherited channel. */
export interface VMHelperTransport { call(request:VMHelperRequest):Promise<SandboxObservation|SandboxChannel> }
export class MacOSVMProvider implements SandboxProvider {
 constructor(private readonly transport:VMHelperTransport) {}
 private async call(command:VMHelperRequest['command'],ref:SandboxRef,extra:Partial<VMHelperRequest>={}):Promise<SandboxObservation|SandboxChannel> {
  if (!ref.sandboxId || !Number.isSafeInteger(ref.generation) || ref.generation<0) throw new Error('INVALID_SANDBOX');
  const result=await this.transport.call({...extra,protocolVersion:1,commandId:randomUUID(),command,...ref});
  const generation=command==='start'?ref.generation+1:ref.generation;
  if(result.protocolVersion!==1 || result.sandboxId!==ref.sandboxId || result.generation!==generation) throw new Error('STALE_SANDBOX');
  if(!['live','scripted'].includes(result.evidenceKind)) throw new Error('UNTRUSTED_HELPER');
  return result;
 }
 create(input:{operationId:string;botId:string;sandboxId:string}) {return this.call('create',{sandboxId:input.sandboxId,generation:0},input) as Promise<SandboxObservation>;}
 start(ref:SandboxRef) {return this.call('start',ref) as Promise<SandboxObservation>;}
 stop(ref:SandboxRef) {return this.call('stop',ref) as Promise<SandboxObservation>;}
 inspect(ref:SandboxRef) {return this.call('inspect',ref) as Promise<SandboxObservation>;}
 connect(ref:SandboxRef) {return this.call('connect',ref) as Promise<SandboxChannel>;}
 destroy(ref:SandboxRef) {return this.call('destroy',ref) as Promise<SandboxObservation>;}
}

/** Concrete trusted helper transport. Construct only after named target/device authorization. */
export class VMHelperProcessTransport implements VMHelperTransport {
 private child:import('node:child_process').ChildProcessWithoutNullStreams|undefined;
 private queue:Promise<unknown>=Promise.resolve();
 private poisoned=false;
 constructor(private readonly config:{helperPath:string;helperSHA256:string;authorityPath:string}) {}
 private async process() {
  if(this.child&&!this.child.killed)return this.child;
  if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('BLOCKED_MAC_TARGET_REQUIRED');
  const {lstatSync,readFileSync,realpathSync}=await import('node:fs');
  const {createHash}=await import('node:crypto');
  const authority=lstatSync(this.config.authorityPath);
  if(!authority.isFile()||authority.isSymbolicLink()||(authority.mode&0o077)!==0||authority.uid!==process.getuid?.()||realpathSync(this.config.authorityPath)!==this.config.authorityPath)throw new Error('PROTECTED_AUTHORIZATION_REQUIRED');
  const helper=lstatSync(this.config.helperPath);
  if(!helper.isFile()||helper.isSymbolicLink()||helper.nlink!==1||createHash('sha256').update(readFileSync(this.config.helperPath)).digest('hex')!==this.config.helperSHA256)throw new Error('UNTRUSTED_HELPER');
  const {spawn}=await import('node:child_process');
  const child=spawn(this.config.helperPath,['--authority',this.config.authorityPath],{env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe']});
  child.stderr.resume();this.child=child;child.on('exit',()=>{this.child=undefined;});return child;
 }
 call(request:VMHelperRequest):Promise<SandboxObservation|SandboxChannel> {
  const result=this.queue.then(async()=>{
   if(this.poisoned)throw new Error('HELPER_RECONCILIATION_REQUIRED');
   const child=await this.process();
   return new Promise<SandboxObservation|SandboxChannel>((resolve,reject)=>{
    let buffer='';
    const cleanup=()=>{clearTimeout(timer);child.stdout.off('data',data);child.off('error',failed);child.off('exit',failed);};
    const failed=()=>{this.poisoned=true;cleanup();reject(new Error('HELPER_DELIVERY_UNKNOWN'));};
    const data=(chunk:Buffer)=>{buffer+=chunk.toString('utf8');if(Buffer.byteLength(buffer)>65536){failed();return;}const newline=buffer.indexOf('\n');if(newline<0)return;cleanup();try{const value=JSON.parse(buffer.slice(0,newline));if(value.error)reject(new Error(/^[A-Z_]+$/.test(value.error)?value.error:'HELPER_FAILED'));else resolve(value);}catch{this.poisoned=true;reject(new Error('HELPER_PROTOCOL_INVALID'));}};
    const timer=setTimeout(failed,30000);timer.unref();child.stdout.on('data',data);child.once('error',failed);child.once('exit',failed);
    child.stdin.write(JSON.stringify(request)+'\n',error=>{if(error)failed();});
   });
  });
  // A timeout leaves delivery unknown; Core must inspect current generation before any retry.
  this.queue=result.catch(()=>{});return result;
 }
}

/** Preinstalled-image alternative: verify before an explicitly authorized qcow2-to-raw preparation step. */
export const PINNED_CLOUD_BOOTSTRAP=Object.freeze({
 id:'ubuntu-noble-arm64-20260926',architecture:'arm64',format:'qcow2',
 source:'https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-arm64.img',
 checksumSource:'https://cloud-images.ubuntu.com/releases/noble/release-20260926/SHA256SUMS',
 sha256:'1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55',
 licenseSource:'https://canonical.com/legal/intellectual-property-policy',
});
