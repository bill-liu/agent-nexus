import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {podmanDeviceFingerprint} from '../../packages/execution/src/providers/podman-device';
it('binds a single synthetic hardware UUID without returning or logging the raw identity',()=>{const id='aabbccdd-1122-3344-5566-778899aabbcc';expect(podmanDeviceFingerprint(`"IOPlatformUUID" = "${id.toUpperCase()}"`)).toBe(createHash('sha256').update(id).digest('hex'));});
it.each(['','"IOPlatformUUID" = "------------------------------------"','"IOPlatformUUID" = "aabbccdd-1122-3344-5566-778899aabbcc"\n"IOPlatformUUID" = "aabbccdd-1122-3344-5566-778899aabbcc"'])('rejects missing/malformed/ambiguous hardware facts',value=>{expect(()=>podmanDeviceFingerprint(value)).toThrow('PODMAN_DEVICE_MISMATCH');});
