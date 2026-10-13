#!/usr/bin/env node
// B1-only conversion of an already downloaded and verified cloud image. No network or VM launch.
import { lstatSync, realpathSync, readFileSync, createReadStream, mkdirSync, existsSync, linkSync, unlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
const pinned='1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55';
async function hash(path){const digest=createHash('sha256');for await(const bytes of createReadStream(path))digest.update(bytes);return digest.digest('hex');}
try {
 if(process.argv[2]!=='--apply'||!process.argv[3]||!process.argv[4])throw new Error('PROTECTED_DISK_PREPARATION_AUTHORIZATION_REQUIRED');
 const configPath=process.argv[3],image=process.argv[4],st=lstatSync(configPath);
 if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)||realpathSync(configPath)!==configPath)throw new Error('PROTECTED_DISK_PREPARATION_AUTHORIZATION_REQUIRED');
 const authorizedConfig=readFileSync(configPath,'utf8'),config=JSON.parse(authorizedConfig);
 if(!config.targetId||!Number.isSafeInteger(config.expiresAt)||config.expiresAt<=Date.now()||config.action!=='prepare-disk'||!/^[a-zA-Z0-9_-]{1,80}$/.test(config.operationId)||!Number.isSafeInteger(config.diskBytes)||config.diskBytes<1024**3||config.diskBytes>128*1024**3)throw new Error('PROTECTED_DISK_PREPARATION_AUTHORIZATION_REQUIRED');
 // Hashing/conversion can outlive admission. Revalidate the same protected grant at each effect.
 const authorizeNow=()=>{const current=lstatSync(configPath);if(!current.isFile()||current.isSymbolicLink()||current.uid!==process.getuid?.()||(current.mode&0o077)||realpathSync(configPath)!==configPath||current.size!==st.size||readFileSync(configPath,'utf8')!==authorizedConfig)throw new Error('PROTECTED_DISK_PREPARATION_AUTHORIZATION_REQUIRED');const remaining=config.expiresAt-Date.now();if(!Number.isSafeInteger(remaining)||remaining<=0)throw new Error('PROTECTED_DISK_PREPARATION_AUTHORIZATION_REQUIRED');return remaining;};
 const root=realpathSync(config.root),rootStat=lstatSync(root);if((rootStat.mode&0o077)||rootStat.uid!==process.getuid?.()||dirname(config.destination)!==root||existsSync(config.destination))throw new Error('DISK_DESTINATION_DENIED');
 const source=lstatSync(image);if(!source.isFile()||source.isSymbolicLink()||source.nlink!==1||await hash(image)!==pinned)throw new Error('BOOTSTRAP_INTEGRITY_FAILED');
 if(realpathSync(config.qemuImg)!==config.qemuImg||await hash(config.qemuImg)!==config.qemuImgSHA256)throw new Error('TRUSTED_CONVERTER_REQUIRED');
 const staging=join(root,`an-prepare-${config.operationId}`);if(existsSync(staging))throw new Error('INTERRUPTED_PREPARATION_REQUIRES_REVIEW');authorizeNow();mkdirSync(staging,{mode:0o700});
 const raw=join(staging,'disk.raw');
 execFileSync(config.qemuImg,['convert','-f','qcow2','-O','raw',realpathSync(image),raw],{env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:'pipe',killSignal:'SIGKILL',timeout:Math.min(600000,authorizeNow()),maxBuffer:65536});
 execFileSync(config.qemuImg,['resize','-f','raw',raw,String(config.diskBytes)],{env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:'pipe',killSignal:'SIGKILL',timeout:Math.min(60000,authorizeNow()),maxBuffer:65536});
 if(statSync(raw).size!==config.diskBytes)throw new Error('DISK_SIZE_MISMATCH');authorizeNow();
 // Same-filesystem exclusive publication: a destination appearing during conversion is retained.
 try{linkSync(raw,config.destination);}catch(error){if(error.code==='EEXIST')throw new Error('DISK_DESTINATION_DENIED');throw error;}unlinkSync(raw);
 console.log(JSON.stringify({status:'DISK_PREPARED',operationId:config.operationId,sourceSHA256:pinned,diskSHA256:await hash(config.destination),vmStarted:false,guestNodeInstalled:false}));
} catch(error){console.log(JSON.stringify({status:'BLOCKED',reason:/^[A-Z_]+$/.test(error.message)?error.message:'DISK_PREPARATION_FAILED',vmStarted:false}));process.exit(2);}
