#!/usr/bin/env node
// Installed read-only at /opt/an/node/enforcement-gate.mjs by the authorized bootstrap.
// Runs inside the final systemd cgroup, before any Bot argv or candidate code executes.
import { readFileSync, statfsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const fail=()=>{process.stderr.write('BLOCKED_ENFORCEMENT_NOT_APPLIED\n');process.exit(2);};
try {
 const policy=JSON.parse(Buffer.from(process.argv[2]??'', 'base64url').toString('utf8'));
 if(!/^an-[a-f0-9]{64}\.service$/.test(policy.unit)||typeof policy.memoryBytes!=='number'||typeof policy.pids!=='number'||typeof policy.cpuPercent!=='number')fail();
 const relative=`/system.slice/${policy.unit}`;
 if(readFileSync('/proc/self/cgroup','utf8').trim()!==`0::${relative}`)fail();
 const path=`/sys/fs/cgroup${relative}`;
 if(Number(statfsSync(path).type)!==0x63677270)fail();
 if(readFileSync(`${path}/memory.max`,'utf8').trim()!==String(policy.memoryBytes)||readFileSync(`${path}/pids.max`,'utf8').trim()!==String(policy.pids))fail();
 const cpu=readFileSync(`${path}/cpu.max`,'utf8').trim().split(/\s+/);
 if(cpu[0]!==String(policy.cpuPercent*1000)||cpu[1]!=='100000')fail();
 if(policy.gatewayAddresses) {
  const attached=JSON.parse(execFileSync('/usr/sbin/bpftool',['-j','cgroup','show',path],{encoding:'utf8',timeout:5000,maxBuffer:65536}));
  if(!Array.isArray(attached)||!['ingress','egress'].every(type=>attached.some(item=>item.attach_type===type||item.attach_type===`cgroup_inet_${type}`)))fail();
  const properties=execFileSync('/usr/bin/systemctl',['show',policy.unit,'--property=IPAddressDeny','--property=IPAddressAllow'],{encoding:'utf8',timeout:5000,maxBuffer:65536});
  const values=Object.fromEntries(properties.trim().split('\n').map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
  const normalize=value=>value.trim().split(/\s+/).filter(Boolean).sort().join(' ');
  if(normalize(values.IPAddressDeny??'')!==normalize('0.0.0.0/0 ::/0')||normalize(values.IPAddressAllow??'')!==normalize(policy.gatewayAddresses.map(address=>address.includes(':')?`${address}/128`:`${address}/32`).join(' ')))fail();
 }
 const args=process.argv.slice(3);if(args[0]!=='--'||args.length<3)fail();
 if(typeof process.execve!=='function')fail();
 process.execve('/usr/bin/bwrap',['/usr/bin/bwrap',...args.slice(1)],{PATH:'/usr/bin:/bin',LANG:'C'});
} catch {fail();}
