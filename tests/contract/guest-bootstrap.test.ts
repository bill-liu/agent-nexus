import {describe,it,expect} from 'vitest';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startP1Guest} from '../../apps/node-agent/src/p1-bootstrap';
describe('guest bootstrap validation before storage effects (private synthetic files, no CLI)',()=>{
 it.each(['expired','malformed-expiry','outside-socket-root'])('rejects %s listen config without creating Runner DB',mode=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'an-guest-preflight-')));const expiresAt=Date.now()+60000;
  try{for(const d of ['runner','journal','bots','rootfs','home','project','cache'])mkdirSync(join(root,d),{mode:0o700});const listenConfigPath=join(root,'listen.json'),configurationPath=join(root,'guest.json');
   writeFileSync(listenConfigPath,JSON.stringify({socketPath:join(root,'node.sock'),keyPath:join(root,'key.json'),binding:{nodeId:'node',sandboxId:'sandbox',generation:1,transportInstanceId:'transport'},expiresAt:mode==='expired'?1:mode==='malformed-expiry'?'invalid':expiresAt}),{mode:0o600});
   writeFileSync(configurationPath,JSON.stringify({version:1,listenConfigPath,runnerDirectory:join(root,'runner'),botId:'bot',projectId:'project',connectionId:'connection',grantId:'grant',expiresAt,actions:['initialize-runtime'],authority:{nodeId:'node',sandboxId:'sandbox',generation:1,privateRoot:join(root,'bots'),rootfsRoot:join(root,'rootfs'),stateDirectory:join(root,'journal'),authorization:{targetId:'synthetic-only',expiresAt,actions:['sandbox-exec','accountless-probe']}},policy:{network:'none',discussion:true,rootfs:join(root,'rootfs'),home:join(root,'home'),project:join(root,'project'),cache:join(root,'cache'),limits:{cpuPercent:50,memoryBytes:128*1024**2,pids:32}}}),{mode:0o600});
   expect(()=>startP1Guest(configurationPath)).toThrow('BLOCKED_NODE_AUTHORIZATION');expect(existsSync(join(root,'runner','runner.sqlite'))).toBe(false);expect(existsSync(join(root,'node.sock'))).toBe(false);expect(existsSync(join(root,'journal','processes.json'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
});
