import {expect,it} from 'vitest';
import {CommandRetries,commandFailure} from '../../apps/desktop/renderer/retry-state.js';
it('a definite version conflict accepts the next deliberate intent at the refreshed version',()=>{
 const retry=new CommandRetries<{commandId:string;expectedVersion:number}>();
 expect(retry.getOrCreate('pause',()=>({commandId:'first',expectedVersion:1}))).toEqual({commandId:'first',expectedVersion:1});
 expect(retry.fail('pause',new Error("Error invoking remote method 'an:command': Error: VERSION_CONFLICT"))).toBe('rejected');
 expect(retry.getOrCreate('pause',()=>({commandId:'next',expectedVersion:2}))).toEqual({commandId:'next',expectedVersion:2});
});
it.each(['INVALID_SCHEMA','PAYLOAD_TOO_LARGE','POLICY_RESTRICTED','GRANT_REVOKED','AUTH_REQUIRED'])('a confirmed %s rejection releases the original intent',code=>{
 const retry=new CommandRetries<string>();retry.getOrCreate('submit',()=>'old');expect(retry.fail('submit',Error(code))).toBe('rejected');expect(retry.getOrCreate('submit',()=>'new')).toBe('new');
});
it.each(['RESULT_UNKNOWN','CORE_UNAVAILABLE','Unexpected transport disconnection'])('an uncertain %s response preserves the original command across a new version',code=>{
 const retry=new CommandRetries<{commandId:string;expectedVersion:number}>();const first=retry.getOrCreate('submit',()=>({commandId:'same',expectedVersion:1}));
 expect(retry.fail('submit',Error(code))).toBe('uncertain');expect(retry.getOrCreate('submit',()=>({commandId:'unsafe-new',expectedVersion:2}))).toBe(first);
 retry.clear('submit');expect(retry.getOrCreate('submit',()=>({commandId:'next',expectedVersion:2}))).toEqual({commandId:'next',expectedVersion:2});
});
it('accepted-but-blocked scheduler errors remain uncertain even if a policy code follows',()=>{expect(commandFailure(Error('RESULT_UNKNOWN: command accepted; scheduler blocked GRANT_REVOKED'))).toBe('uncertain');});
