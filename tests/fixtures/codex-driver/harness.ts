import {createCoreApprovalPort} from '../../../packages/execution/src/drivers/core-approval-port.js';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ApprovalService, type ApprovalBinding, type ApprovalRecord } from '../../../packages/core/src/approvals.js';
import type { ExecutionBinding } from '../../../packages/execution/src/contracts.js';
export const binding: ExecutionBinding = { nodeId:'node',sandboxId:'sandbox',generation:1,transportInstanceId:'transport',processInstanceId:'process',runId:'run',fencingToken:1,sessionId:'session',turnId:'turn' };
export const approvalBinding: ApprovalBinding = { subjectId:'owner',projectId:'project',botId:'bot',taskId:'task',taskRevision:1,candidateVersion:'candidate',contextDigest:'context',runId:'run',sessionId:'session',turnId:'turn',connectionId:'connection',connectionRevision:1,grantId:'grant',grantRevision:1,nodeId:'node',nodeGeneration:1 };
export const commandRequest = () => JSON.parse(readFileSync(new URL('../cli-approvals/command.json',import.meta.url),'utf8'));
export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
/** Synthetic protocol peer, never a CLI or model. Effects are an in-memory oracle. */
export function peer() {
 const input=new PassThrough(),output=new PassThrough(); const frames:any[]=[]; const pending=new Map<string,string>(); let effects=0; let override:((method:string,result:unknown)=>unknown)|null=null;
 let buffer=''; output.on('data',chunk=> { buffer+=chunk.toString(); let n; while((n=buffer.indexOf('\n'))>=0){ const frame=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);frames.push(frame);
 if(frame.method && Object.hasOwn(frame,'id')) { let result:any={};
 if(frame.method==='initialize') result={codexHome:'/synthetic/home',platformFamily:'unix',platformOs:'linux',userAgent:'synthetic'};
 if(frame.method==='thread/start') result={approvalPolicy:'untrusted',approvalsReviewer:'user',cwd:'/sandbox/project',model:'synthetic',modelProvider:'synthetic',sandbox:{type:'readOnly',networkAccess:false},thread:{id:'native-thread',cliVersion:'0.159.2',createdAt:100,cwd:'/sandbox/project',ephemeral:false,modelProvider:'synthetic',preview:'synthetic',projectId:null,sessionId:'native-session',source:'appServer',status:{type:'idle'},turns:[],updatedAt:100}};
 if(frame.method==='turn/start') result={turn:{id:'native-turn',items:[],status:'inProgress'}};
 if(frame.method==='turn/steer') result={turnId:'native-turn'};
 if(frame.method==='account/login/start') result=frame.params.type==='chatgpt'?{type:'chatgpt',loginId:'synthetic-login',authUrl:'https://auth.openai.com/synthetic'}:{type:'chatgptDeviceCode',loginId:'synthetic-login',verificationUrl:'https://auth.openai.com/device',userCode:'SYNTHETIC-DEVICE-CODE'};
 if(frame.method==='account/login/cancel') result={status:'canceled'};
 if(frame.method==='account/read') result={account:{type:'chatgpt',email:'SYNTHETIC-PRIVATE',planType:'plus'},requiresOpenaiAuth:true};
 if(override)result=override(frame.method,result);input.write(JSON.stringify({id:frame.id,result})+'\n');
 } else if(Object.hasOwn(frame,'id')) { const key=JSON.stringify(frame.id);if(pending.has(key)){ if(frame.result?.decision==='accept') effects++;pending.delete(key); } }
 }});
 return { input,output,frames,pending,setResponse(fn:(method:string,result:any)=>unknown){override=fn;},get effects(){return effects;},send(frame:unknown){ input.write(JSON.stringify(frame)+'\n'); },request(frame:any){pending.set(JSON.stringify(frame.id),JSON.stringify(frame));input.write(JSON.stringify(frame)+'\n');},close(){ input.destroy();output.destroy();} };
}
export async function harness(db = new DatabaseSync(':memory:'), execution = binding, customize?:(protocol:ReturnType<typeof peer>)=>void) {
 const { CodexAppServerDriver } = await import('../../../packages/execution/src/drivers/codex-app-server.js'); const protocol=peer();customize?.(protocol);let allowed=true,current=100; const approvals:ApprovalRecord[]=[];
 const service=new ApprovalService(db,{now:()=>current,trustedActor:()=> 'owner',authorizeDecision:()=>true,revalidate:()=>allowed});
 const port=createCoreApprovalPort(service,{runtimeVersion:'0.159.2'});const driver=new CodexAppServerDriver({db,transport:{...protocol,binding:execution},approvalPort:port,now:()=>current,approvalTtlMs:100,authorizeNow:()=>{if(!allowed)throw Error('REVOKED');},onApproval:a=>approvals.push(a)});
 try { await driver.initialize({binding:execution,runtimeVersion:'0.159.2'});
 await driver.startTurn({binding:execution,approvalBinding,input:[{type:'text',text:'synthetic work'}],cwd:'/sandbox/project',contextManifestRef:'context',resolvedConnectionRef:'connection',selectedRuntime:{model:'synthetic',modelProvider:'synthetic'}}); } catch(error){driver.close();protocol.close();throw error;}
 return {driver,protocol,service,approvals,port,db,advance(time:number){current=time;},revoke(){allowed=false;},async request(frame=commandRequest()){ protocol.request(frame);await tick();return approvals.at(-1)!;},decide(a:ApprovalRecord,decision:'APPROVED'|'DENIED'='APPROVED'){service.decide({id:a.id,expectedRequestHash:a.requestHash,decision});},reply(a:ApprovalRecord){return driver.replyServerRequest({binding:execution,approvalId:a.id,expectedRequestHash:a.requestHash});},close(){driver.close();protocol.close();db.close();}};
}

export async function authHarness(authorizeOperation?: (operation:'start'|'inspect',binding:ExecutionBinding)=>void) {
 const {CodexAppServerDriver}=await import('../../../packages/execution/src/drivers/codex-app-server.js');const db=new DatabaseSync(':memory:'),protocol=peer();let time=100;
 const service=new ApprovalService(db,{now:()=>time,trustedActor:()=> 'owner',authorizeDecision:()=>true,revalidate:()=>true});const driver=new CodexAppServerDriver({db,transport:{...protocol,binding},approvalPort:createCoreApprovalPort(service,{runtimeVersion:'0.159.2'}),now:()=>time,authorizeNow:()=>{},onApproval:()=>{}});
 await driver.initialize({binding,runtimeVersion:'0.159.2'});return {driver,db,protocol,auth:driver.createAuthTransport({authorizeOperation,loginTtlMs:100}),advance(t:number){time=t;},close(){driver.close();protocol.close();db.close();}};
}
