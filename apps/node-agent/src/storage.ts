import { lstatSync, realpathSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, existsSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';
import { createHash } from 'node:crypto';

export function privatePath(root:string,path:string):string {
 const base=realpathSync(root),absolute=resolve(path);
 if(!absolute.startsWith(base+sep)) throw new Error('NODE_PATH_DENIED');
 let current=base;
 for(const part of absolute.slice(base.length+1).split(sep)) {
  current=join(current,part); const st=lstatSync(current);
  if(st.isSymbolicLink() || (!st.isDirectory()&&!st.isFile()) || (st.isFile()&&st.nlink!==1)) throw new Error('NODE_PATH_DENIED');
 }
 if(realpathSync(absolute)!==absolute) throw new Error('NODE_PATH_DENIED');return absolute;
}
export function botStorage(root:string,botId:string) {
 const key=createHash('sha256').update(botId).digest('hex');
 const directory=privatePath(root,join(root,key));
 if((lstatSync(directory).mode&0o077)!==0) throw new Error('NODE_PRIVATE_STORAGE_REQUIRED');
 return {home:privatePath(directory,join(directory,'home')),project:privatePath(directory,join(directory,'project')),cache:privatePath(directory,join(directory,'cache'))};
}

/** Trusted Node-owned registry, outside every Bot mount. No Core database or credentials. */
export class NodeProcessJournal<T> {
 private readonly path:string;
 constructor(directory:string) {
  const stat=lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||realpathSync(directory)!==directory)throw new Error('NODE_PRIVATE_JOURNAL_REQUIRED');
  this.path=join(directory,'processes.json');
 }
 load():T[] {
  if(!existsSync(this.path))return [];
  const stat=lstatSync(this.path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>8*1024*1024)throw new Error('NODE_JOURNAL_INVALID');
  const data=JSON.parse(readFileSync(this.path,'utf8'));
  if(!Array.isArray(data)||data.length>8192)throw new Error('NODE_JOURNAL_INVALID');return data;
 }
 save(records:T[]):void {
  if(records.length>8192)throw new Error('NODE_JOURNAL_FULL');
  const temporary=this.path+'.'+createHash('sha256').update(String(process.hrtime.bigint())).digest('hex')+'.tmp';
  const fd=openSync(temporary,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(records));fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,this.path);
  const directory=openSync(resolve(this.path,'..'),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
 }
}
