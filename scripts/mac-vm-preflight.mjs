#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const evidence = { status: 'BLOCKED', platform: process.platform, arch: process.arch, vmStarted: false, diskAllocated: false };
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
 console.log(JSON.stringify({...evidence, reason:'REQUIRES_AUTHORIZED_ARM64_MAC'}));process.exit(2);
}
try {
 const macOS = execFileSync('/usr/bin/sw_vers',['-productVersion'],{encoding:'utf8'}).trim();
 const swift = execFileSync('/usr/bin/xcrun',['swift','--version'],{encoding:'utf8'}).trim();
 console.log(JSON.stringify({...evidence,status:'PREFLIGHT_ONLY',macOS,swift,requiredEntitlement:'com.apple.security.virtualization',remaining:['protected target authorization','helper development signing authorization','VM boot and Node channel','actual isolation negative controls']}));
} catch {console.log(JSON.stringify({...evidence,reason:'MAC_TOOLCHAIN_UNAVAILABLE'}));process.exit(2);}
