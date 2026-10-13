#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
// Read-only local verification; never downloads, installs, allocates disk or starts a VM.
const expected='2ee2163c9b901ff5926400e80759088ff3b879982a3956c02100495b489fd555';
const path=process.argv[2];
if(!path){console.log(JSON.stringify({status:'BLOCKED',reason:'LOCAL_BOOTSTRAP_PATH_REQUIRED'}));process.exit(2);}
try {
 const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error();
 const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
 if(hash.digest('hex')!==expected)throw new Error();
 console.log(JSON.stringify({status:'INTEGRITY_VERIFIED',recipe:'ubuntu-24.04.3-live-server-arm64',sha256:expected,bytes:stat.size,booted:false,publisherSignatureVerified:false}));
} catch {console.log(JSON.stringify({status:'BLOCKED',reason:'BOOTSTRAP_INTEGRITY_FAILED'}));process.exit(2);}
