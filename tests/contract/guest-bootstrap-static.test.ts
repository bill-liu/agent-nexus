import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,existsSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Simulate the Linux guest platform for pure admission (also runnable on macOS CI).
// Supply an already validated listener only: no /run fixture or actual socket/key is needed.
vi.mock('../../apps/node-agent/src/server',async original=>({...await original<object>(),readNodeListenConfig:()=>({binding:{nodeId:'node',sandboxId:'sandbox',generation:1,transportInstanceId:'transport'},expiresAt:Date.now()+120000})}));
import {startP1Guest} from '../../apps/node-agent/src/p1-bootstrap';
describe('guest static authority/journal admission before Runner storage',()=>{
 it.each(['overlap','bad-journal','missing-authority-expiry','empty-authority-target'])('preserves state and creates no DB for %s',mode=>{
  const originalPlatform=process.platform;Object.defineProperty(process,'platform',{value:'linux'});
  const root=realpathSync(mkdtempSync(join(tmpdir(),'an-guest-static-'))),expiresAt=Date.now()+60000;
  try{for(const d of ['runner','journal','bots','rootfs','home','project','cache'])mkdirSync(join(root,d),{mode:0o700});const path=join(root,'guest.json');
   if(mode==='bad-journal')writeFileSync(join(root,'journal','processes.json'),'{}',{mode:0o600});
   writeFileSync(path,JSON.stringify({version:1,listenConfigPath:join(root,'listen.json'),runnerDirectory:join(root,'runner'),botId:'bot',projectId:'project',connectionId:'connection',grantId:'grant',expiresAt,actions:['initialize-runtime'],authority:{nodeId:'node',sandboxId:'sandbox',generation:1,privateRoot:join(root,'bots'),rootfsRoot:join(root,'rootfs'),stateDirectory:join(root,mode==='overlap'?'bots':'journal'),authorization:{targetId:mode==='empty-authority-target'?'':'synthetic',...(mode==='missing-authority-expiry'?{}:{expiresAt}),actions:['sandbox-exec','accountless-probe']}},policy:{network:'none',discussion:false,rootfs:join(root,'rootfs'),home:join(root,'home'),project:join(root,'project'),cache:join(root,'cache'),limits:{cpuPercent:50,memoryBytes:128*1024**2,pids:32}}}),{mode:0o600});
   expect(()=>startP1Guest(path)).toThrow(mode==='overlap'?'NODE_JOURNAL_MOUNT_OVERLAP':mode==='bad-journal'?'NODE_JOURNAL_INVALID':'GUEST_CONFIGURATION_INVALID');expect(existsSync(join(root,'runner','runner.sqlite'))).toBe(false);if(mode==='bad-journal')expect(readFileSync(join(root,'journal','processes.json'),'utf8')).toBe('{}');
  }finally{rmSync(root,{recursive:true,force:true});Object.defineProperty(process,'platform',{value:originalPlatform});}
 });
});
