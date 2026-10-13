import type { CatalogSource, DownloadAuthorization } from './download';
import type { ArtifactManifest } from './manifest';
/** Bounded raw public artifact reads. Caller pins publisher, source, digest, size and license in DownloadOptions. */
export class HTTPSBootstrapSource implements CatalogSource {
 constructor(private readonly source:string,private readonly size:number,private readonly chunkSize=1024*1024) {
  const url=new URL(source);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||!Number.isSafeInteger(size)||size<1||!Number.isSafeInteger(chunkSize)||chunkSize<1||chunkSize>8*1024*1024) throw new Error('CATALOG_AUTHORIZATION_INVALID');
 }
 async authorize(manifest:ArtifactManifest):Promise<DownloadAuthorization> {
  if(manifest.source!==this.source||manifest.size!==this.size||manifest.format!=='raw-bootstrap-v1') throw new Error('CATALOG_AUTHORIZATION_INVALID');
  return {url:this.source,expiresAt:Date.now()+60_000};
 }
 async read(authorization:DownloadAuthorization,offset:number,signal:AbortSignal) {
  if(authorization.url!==this.source||authorization.expiresAt<=Date.now()||!Number.isSafeInteger(offset)||offset<0||offset>=this.size) throw new Error('CATALOG_AUTHORIZATION_INVALID');
  const end=Math.min(offset+this.chunkSize,this.size)-1;
  const response=await fetch(this.source,{headers:{Range:`bytes=${offset}-${end}`,'Accept-Encoding':'identity'},redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)]),credentials:'omit'});
  if(response.status!==206||response.headers.get('content-range')!==`bytes ${offset}-${end}/${this.size}`||!response.body) throw new Error('CATALOG_DOWNLOAD_INVALID');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let total=0;
  try {while(true){const result=await reader.read();if(result.done)break;total+=result.value.byteLength;if(total>end-offset+1)throw new Error('CATALOG_DOWNLOAD_INVALID');chunks.push(result.value);}} finally {await reader.cancel();}
  if(total!==end-offset+1) throw new Error('DOWNLOAD_INTERRUPTED');
  return {bytes:Buffer.concat(chunks),done:end===this.size-1};
 }
}

/** Consume an explicitly selected local copy through the same signature/digest/activation pipeline. */
export class LocalBootstrapSource implements CatalogSource {
 constructor(private readonly source:string,private readonly path:string,private readonly size:number) {}
 async authorize(manifest:ArtifactManifest):Promise<DownloadAuthorization> {
  if(manifest.format!=='raw-bootstrap-v1'||manifest.source!==this.source||manifest.size!==this.size)throw new Error('CATALOG_AUTHORIZATION_INVALID');
  return {url:this.source,expiresAt:Date.now()+60000};
 }
 async read(authorization:DownloadAuthorization,offset:number,signal:AbortSignal) {
  if(signal.aborted||authorization.url!==this.source||authorization.expiresAt<=Date.now()||!Number.isSafeInteger(offset)||offset<0||offset>=this.size)throw new Error('CATALOG_AUTHORIZATION_INVALID');
  const {open}=await import('node:fs/promises');const {constants}=await import('node:fs');
  const file=await open(this.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size!==this.size)throw new Error('CATALOG_DOWNLOAD_INVALID');
   const buffer=Buffer.alloc(Math.min(1024*1024,this.size-offset));const result=await file.read(buffer,0,buffer.length,offset);
   if(result.bytesRead!==buffer.length)throw new Error('DOWNLOAD_INTERRUPTED');return {bytes:buffer,done:offset+buffer.length===this.size};
  }finally{await file.close();}
 }
}
