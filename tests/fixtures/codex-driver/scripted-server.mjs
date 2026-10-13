// Synthetic protocol peer. This is a Node fixture, never Codex, an Agent CLI, or a model.
import { createInterface } from 'node:readline';
import { writeFileSync,readFileSync } from 'node:fs';
const target=process.argv[2];
const request=JSON.parse(readFileSync(new URL('../cli-approvals/command.json',import.meta.url),'utf8'));
const send=frame=>process.stdout.write(JSON.stringify(frame)+'\n');
let waiting=false;
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);let result={};
 if(frame.method==='initialize')result={codexHome:'/synthetic/home',platformFamily:'unix',platformOs:'linux',userAgent:'synthetic-node-peer'};
 else if(frame.method==='initialized')return;
 else if(frame.method==='thread/start')result={approvalPolicy:'untrusted',approvalsReviewer:'user',cwd:'/sandbox/project',model:'synthetic',modelProvider:'synthetic',sandbox:{type:'readOnly',networkAccess:false},thread:{id:'native-thread',cliVersion:'0.159.2',createdAt:100,cwd:'/sandbox/project',ephemeral:false,modelProvider:'synthetic',preview:'synthetic',projectId:null,sessionId:'native-session',source:'appServer',status:{type:'idle'},turns:[],updatedAt:100}};
 else if(frame.method==='turn/start'){result={turn:{id:'native-turn',items:[],status:'inProgress'}};send({id:frame.id,result});waiting=true;send(request);return;}
 else if(frame.method==='account/read')result={account:null,requiresOpenaiAuth:true};
 else if(frame.method==='turn/interrupt'){waiting=false;}
 else if(!frame.method){if(frame.id===request.id&&waiting){waiting=false;if(frame.result?.decision==='accept')writeFileSync(target,'synthetic approved effect\n',{flag:'wx'});send({method:'serverRequest/resolved',params:{threadId:'native-thread',requestId:request.id}});}return;}
 send({id:frame.id,result});
});
