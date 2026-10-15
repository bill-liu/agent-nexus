import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export function podmanDeviceFingerprint(text:string):string {
 const matches=[...text.matchAll(/"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})"/g)];
 if(matches.length!==1)throw Error('PODMAN_DEVICE_MISMATCH');return createHash('sha256').update(matches[0][1].toLowerCase()).digest('hex');
}
/** Local-only physical device binding; raw hardware UUID never leaves the trusted process. */
export function verifyPodmanMacDevice(expectedSHA256:string):void {
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('BLOCKED_MAC_TARGET_REQUIRED');
 const text=execFileSync('/usr/sbin/ioreg',['-rd1','-c','IOPlatformExpertDevice'],{encoding:'utf8',timeout:5000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','ignore']});
 if(!/^([a-f0-9]{64})$/.test(expectedSHA256)||podmanDeviceFingerprint(text)!==expectedSHA256)throw Error('PODMAN_DEVICE_MISMATCH');
}
