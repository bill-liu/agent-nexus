import {DatabaseSync} from 'node:sqlite';
import {PodmanProvider,PODMAN_VERSION,type PodmanCLI,type PodmanTarget} from '../../packages/execution/src/providers/podman';
import {createPodmanJournal} from '../../packages/core/src/podman-journal';
const sha='a'.repeat(64);
export function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE bot_provision(operation_id TEXT PRIMARY KEY,record TEXT);CREATE TABLE podman_sandbox_state(operation_id TEXT PRIMARY KEY REFERENCES bot_provision(operation_id),record TEXT NOT NULL)');db.prepare('INSERT INTO bot_provision VALUES(?,?)').run('op',JSON.stringify({operationId:'op',botId:'bot',sandboxId:'box'}));
 const target:PodmanTarget={installationId:'install',botId:'bot',sandboxId:'box',operationId:'op',nodeId:'node',engine:{connection:'chosen',uri:'ssh://core@127.0.0.1:5555/run/user/501/podman/podman.sock',identity:'/private/existing-key',machine:'chosen',machineConfigPath:'/private/chosen.json'},image:{reference:`example.org/an/runner@sha256:${sha}`,version:'0.1.0',sourceRevision:'b'.repeat(40),architecture:'arm64',codexVersion:'0.159.2',protocolVersion:2},limits:{memory:268435456,cpus:1,pids:64}};
 const calls:string[][]=[];let denied=false,connection='chosen',version=PODMAN_VERSION,shares:unknown[]=[],rootless=true;
 const volumes=new Map<string,any>();let container:any;let image=true;let lose:string|undefined;
 const cli:PodmanCLI={evidenceKind:'scripted',async machineConfig(){return {Name:'chosen',Version:1,Mounts:shares,SSH:{IdentityPath:target.engine.identity,Port:5555,RemoteUsername:'core'}};},async run(args){calls.push([...args]);const i=args.indexOf('--identity'),a=i>=0?args.slice(i+2):args;const ok=(v:unknown)=>({code:0,stdout:JSON.stringify(v)});const missing=()=>({code:1,stdout:''});
 if(a[0]==='system')return ok([{Name:connection,URI:target.engine.uri,Identity:target.engine.identity,IsMachine:true,Default:false}]);
 if(a[0]==='machine')return ok([{Name:'chosen',State:'running',Rootful:false,ConfigDir:{Path:'/private'},SSHConfig:{IdentityPath:target.engine.identity,Port:5555,RemoteUsername:'core'}}]);
 if(a[0]==='version')return ok({Client:{Version:version},Server:{Version:version}});
 if(a[0]==='info')return ok({host:{security:{rootless},cgroupVersion:'v2',cgroupControllers:['cpu','memory','pids']},version:{Version:version}});
 if(a[0]==='image')return image?ok([{Id:`sha256:${'c'.repeat(64)}`,Digest:`sha256:${sha}`,RepoDigests:[target.image.reference],Architecture:'arm64',Os:'linux',Labels:{'org.opencontainers.image.version':target.image.version,'org.opencontainers.image.revision':target.image.sourceRevision,'io.agent-nexus.protocol':'2','io.agent-nexus.codex':'0.159.2'}}]):missing();
 if(a[0]==='volume'&&a[1]==='exists')return {code:volumes.has(a[2])?0:1,stdout:''};
 if(a[0]==='volume'&&a[1]==='inspect')return volumes.has(a[2])?ok([volumes.get(a[2])]):missing();
 if(a[0]==='volume'&&a[1]==='create'){const name=a.at(-1)!;const labels=Object.fromEntries(a.flatMap((x,n)=>x==='--label'?[a[n+1].split('=')]:[]));volumes.set(name,{Name:name,Driver:'local',Options:{},Labels:labels});return ok(name);}
 if(a[0]==='container'&&a[1]==='exists')return {code:container?0:1,stdout:''};
 if(a[0]==='container'&&a[1]==='inspect')return container?ok([container]):missing();
 if(a[0]==='create'){const labels=Object.fromEntries(a.flatMap((x,n)=>x==='--label'?[a[n+1].split('=')]:[]));const mounts=a.flatMap((x,n)=>x==='--mount'?[Object.fromEntries(a[n+1].split(',').map(v=>v.split('=')))]:[]).map(v=>({Type:'volume',Name:v.src,Destination:v.dst,RW:true}));container={Id:'d'.repeat(64),Name:a[a.indexOf('--name')+1],Image:`sha256:${'c'.repeat(64)}`,ImageDigest:`sha256:${sha}`,Config:{Labels:labels,User:'1000:1000',Env:['HOME=/an/private/home','CODEX_HOME=/an/private/home/.codex','PATH=/usr/local/bin:/usr/bin:/bin'],Entrypoint:['/usr/local/bin/node','/opt/an/podman-entry.cjs'],Cmd:['idle']},HostConfig:{Privileged:false,ReadonlyRootfs:true,NetworkMode:'none',PidMode:'private',IpcMode:'private',UTSMode:'private',CapAdd:[],CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Binds:[],Devices:[],PortBindings:{},Memory:target.limits.memory,CpuPeriod:100000,CpuQuota:100000,PidsLimit:64},Mounts:mounts,ExecIDs:[],State:{Status:'created',Running:false,StartedAt:'',Pid:0}};if(lose==='create')throw Error('DISCONNECTED');return ok(container.Id);}
 if(a[0]==='start'){container.State={Status:'running',Running:true,StartedAt:new Date().toISOString(),Pid:42};if(lose==='start')throw Error('DISCONNECTED');return ok(container.Id);}
 if(a[0]==='stop'){container.State={...container.State,Status:'exited',Running:false,Pid:0,FinishedAt:new Date().toISOString()};if(lose==='stop')throw Error('DISCONNECTED');return ok(container.Id);}
 if(a[0]==='rm'){container=undefined;return ok([]);}
 throw Error(`unexpected ${a.join(' ')}`);
 }};
 const journal=createPodmanJournal(db,'op',()=>{});const provider=()=>new PodmanProvider(target,cli,journal,()=>{if(denied)throw Error('REVOKED');});
 return {db,target,cli,calls,volumes,journal,provider,setDenied(){denied=true;},setShares(v:unknown[]){shares=v;},setVersion(v:string){version=v;},setConnection(v:string){connection=v;},setRootless(v:boolean){rootless=v;},setImage(v:boolean){image=v;},lose(v:string){lose=v;},get container(){return container;}};
}
