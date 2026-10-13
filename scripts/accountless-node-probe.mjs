#!/usr/bin/env node
import { lstatSync, readFileSync, statfsSync, existsSync } from 'node:fs';
// No CLI is launched by this prerequisite gate. Actual init requires B1 isolated process wiring.
try {
 const path=process.argv[2];if(!path)throw new Error('PROTECTED_AUTHORIZATION_REQUIRED');
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.uid!==process.getuid?.())throw new Error('PROTECTED_AUTHORIZATION_REQUIRED');
 const value=JSON.parse(readFileSync(path,'utf8'));
 if(!value.authorization?.targetId||value.authorization.expiresAt<=Date.now()||!value.authorization.actions.includes('accountless-probe'))throw new Error('PROTECTED_AUTHORIZATION_REQUIRED');
 if(process.platform!=='linux'||Number(statfsSync('/sys/fs/cgroup').type)!==0x63677270||!existsSync('/usr/bin/bwrap'))throw new Error('SANDBOX_CAPABILITIES_REQUIRED');
 throw new Error('ISOLATED_CLI_INITIALIZATION_NOT_RUN');
} catch(error) {console.log(JSON.stringify({status:'BLOCKED',reason:/^[A-Z_]+$/.test(error.message)?error.message:'PROTECTED_PREFLIGHT_FAILED',cliStarted:false,modelCalled:false}));process.exit(2);}
