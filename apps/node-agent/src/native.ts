import type { ExecutionBinding } from '../../../packages/execution/src/contracts';
import { canonicalManifest } from '../../../packages/catalog-client/src/manifest';
import type { NodeController, SandboxPolicy } from './control';
interface Session {binding:ExecutionBinding;native:Awaited<ReturnType<NodeController['openNative']>>;queue:Buffer[];bytes:number;sequence:number;ended:boolean;failed:boolean;reader?:()=>void}
/** Guest trusted service. Policy and authorization callbacks never accept renderer commands or shell strings. */
export class NodeNativeService {
 private readonly sessions=new Map<string,Session>();
 constructor(private readonly controller:NodeController,private readonly policyFor:(binding:ExecutionBinding)=>SandboxPolicy,private readonly authorizeNow:(binding:ExecutionBinding)=>void) {}
 private session(binding:ExecutionBinding):Session {
  const session=this.sessions.get(binding.processInstanceId);
  if(!session||canonicalManifest(session.binding)!==canonicalManifest(binding))throw new Error('NATIVE_BINDING_MISMATCH');return session;
 }
 async open(binding:ExecutionBinding):Promise<{opened:true}> {
  this.authorizeNow(binding);
  if(this.sessions.has(binding.processInstanceId))throw new Error('NATIVE_INSTANCE_REUSED');
  const native=await this.controller.openNative(binding,this.policyFor(binding));
  const session:Session={binding:structuredClone(binding),native,queue:[],bytes:0,sequence:0,ended:false,failed:false};this.sessions.set(binding.processInstanceId,session);
  native.input.on('data',(chunk:Buffer)=>{
   for(let offset=0;offset<chunk.length;offset+=65536){const piece=Buffer.from(chunk.subarray(offset,offset+65536));session.queue.push(piece);session.bytes+=piece.length;}
   if(session.bytes>=262144)native.input.pause();
   if(session.bytes>1048576){session.failed=true;void this.controller.stop(binding).catch(()=>{});}session.reader?.();
  });
  native.input.on('end',()=>{session.ended=true;session.reader?.();});
  native.process.on('error',()=>{session.failed=true;session.reader?.();});
  native.output.on('error',()=>{session.failed=true;session.reader?.();});
  return {opened:true};
 }
 async write(binding:ExecutionBinding,data:string):Promise<{written:true}> {
  this.authorizeNow(binding);const session=this.session(binding);
  if(typeof data!=='string'||data.length>87384||session.failed||session.ended)throw new Error('NATIVE_WRITE_REFUSED');
  const bytes=Buffer.from(data,'base64');if(bytes.toString('base64')!==data||bytes.length>65536)throw new Error('NATIVE_WRITE_REFUSED');
  await new Promise<void>((resolve,reject)=>session.native.output.write(bytes,error=>error?reject(new Error('NATIVE_WRITE_UNKNOWN')):resolve()));return {written:true};
 }
 async read(binding:ExecutionBinding):Promise<{sequence:number;data:string;ended:boolean}> {
  const session=this.session(binding);if(session.reader)throw new Error('NATIVE_CONCURRENT_READ');
  if(!session.queue.length&&!session.ended&&!session.failed)await new Promise<void>(resolve=>{const timer=setTimeout(()=>{session.reader=undefined;resolve();},1000);session.reader=()=>{clearTimeout(timer);session.reader=undefined;resolve();};});
  if(session.failed)throw new Error('NATIVE_TRANSPORT_FAILED');
  const bytes=session.queue.shift();if(bytes){session.bytes-=bytes.length;if(session.bytes<131072)session.native.input.resume();}
  return {sequence:++session.sequence,data:bytes?.toString('base64')??'',ended:session.ended&&!session.queue.length};
 }
 async close(binding:ExecutionBinding) {this.session(binding);return this.controller.stop(binding);}
}
