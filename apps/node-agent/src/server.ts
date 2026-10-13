import { createServer, createConnection, type Socket } from 'node:net';
import { lstatSync, readFileSync, realpathSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NodeRunnerChannel, type NodeChannelBinding } from './channel';
/** Protected guest bootstrap files only; no configuration or key paths from Agent/renderer messages. */
export function readProtectedJSON<T>(path:string):T {
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||realpathSync(path)!==path||stat.size>65536)throw new Error('PROTECTED_NODE_CONFIGURATION_REQUIRED');
 return JSON.parse(readFileSync(path,'utf8')) as T;
}
export interface NodeListenConfig {socketPath:string;keyPath:string;binding:NodeChannelBinding;expiresAt:number}
export function listenNode(configPath:string,compose:(stream:Socket,key:Buffer,binding:NodeChannelBinding)=>()=>void) {
 const config=readProtectedJSON<NodeListenConfig>(configPath);
 if(process.platform!=='linux'||config.expiresAt<=Date.now()||!config.socketPath.startsWith('/run/an-node/'))throw new Error('BLOCKED_NODE_AUTHORIZATION');
 const directory=dirname(config.socketPath),parent=lstatSync(directory);
 if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)!==0||parent.uid!==process.getuid?.()||realpathSync(directory)!==directory)throw new Error('NODE_PRIVATE_SOCKET_REQUIRED');
 const secret=readProtectedJSON<{keyBase64:string}>(config.keyPath);const key=Buffer.from(secret.keyBase64,'base64');
 if(key.length!==32||key.toString('base64')!==secret.keyBase64)throw new Error('NODE_CHANNEL_AUTH_REQUIRED');
 let closeCurrent:(()=>void)|undefined;
 const server=createServer(stream=>{
  if(config.expiresAt<=Date.now()||closeCurrent){stream.destroy();return;}
  closeCurrent=compose(stream,key,structuredClone(config.binding));stream.on('close',()=>{closeCurrent=undefined;});
 });
 // Existing socket is never unlinked speculatively: a previous authoritative Node may still own it.
 server.listen(config.socketPath,()=>chmodSync(config.socketPath,0o600));
 return {server,close:async()=>{closeCurrent?.();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));key.fill(0);try{unlinkSync(config.socketPath);}catch{ /* Already removed by Node's server close. */ }}};
}
/** Connect only to the helper-created private Unix path. Authentication is still required end-to-end. */
export async function connectNodeChannel(socketPath:string,privateRoot:string,key:Buffer,binding:NodeChannelBinding,coreApproval?:ConstructorParameters<typeof NodeRunnerChannel>[3]):Promise<NodeRunnerChannel> {
 const root=realpathSync(privateRoot);if(dirname(socketPath)!==root||!socketPath.startsWith(join(root,'channel-')))throw new Error('NODE_PRIVATE_SOCKET_REQUIRED');
 const stat=lstatSync(socketPath);
 if(!stat.isSocket()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw new Error('NODE_PRIVATE_SOCKET_REQUIRED');
 const stream=createConnection(socketPath);await new Promise<void>((resolve,reject)=>{stream.once('connect',resolve);stream.once('error',reject);});
 return new NodeRunnerChannel(stream,key,binding,coreApproval);
}
