export type PodmanPreparationView={backend:'podman';phase:'blocked'|'ready-to-prepare'|'preparing'|'cancelling'|'cancelled'|'complete'|'unknown';authorization:'missing'|'authorized'|'expired'|'changed';planDigest:string|null;engine:{connection:string;machine:string}|null;budgets:{downloadBytes:number|null;machineDiskBytes:number|null;machineMemoryBytes:number|null;containerMemoryBytes:number|null;containerCPUs:number|null};sources:{name:string;version:string;url:string}[];steps:{id:string;label:string;implemented:boolean;authorization:'required'|'granted'}[];blockers:string[];canCancel:boolean;operationCommandId?:string;errorCode?:string};
import type {Input} from './commands.js';
export type BotView={id:string;name:string;owner:string;version:number;acceptingTasks:boolean;dispatchPaused:boolean;sandboxId:string;generation:number};
export type TaskView={id:string;botId:string;text:string;revision:number;status:string};
export type RunView={id:string;botId:string;taskId:string;state:string;slotHeld:boolean;version:number;fencingToken:number};
export type EnvironmentView={botId:string;operationId:string;sandboxId:string;generation:number;stage:string;readiness:{environment:boolean;runner:boolean;runtime:boolean;auth:boolean};liveReady:boolean;evidenceKind:string;connectionId:string|null;errorCode?:string;canInitialize?:boolean;preparation?:PodmanPreparationView;initialization?:{commandId:string;expectedVersion:number;completedAt?:number;cleanup?:{native:boolean;vm:boolean}}};
export type ConnectionView={id:string;name:string;authMethod:string;billingSource:string;billingEvidence:string;route:string;status:string;revision:number;fallbackPolicy:string};
export type ApprovalView={id:string;botId:string;runId:string;action:string;parameters:unknown;requestHash:string;status:string;expiresAt:number};
export type AuthInput={action:'begin';botId:string;expectedVersion:number}|{action:'inspect'|'cancel'|'view';botId:string;flowId:string};
export type AuthView={metadata:import('../../connections/src/auth-flow.js').AuthFlowMetadata;view?:{officialUrl:string;deviceCode?:string}};
export type MaterialInput={botId:string;expectedVersion:number;kind:'knowledge'|'skill'|'rule';name:string;text:string};
export type EnvironmentInput={commandId:string;botId:string;expectedVersion:number};
export function parseEnvironmentInput(value:unknown):EnvironmentInput {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_ENVIRONMENT_INPUT');
 const v=value as Record<string,unknown>,keys=['commandId','botId','expectedVersion'];
 if(Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k))||!['commandId','botId'].every(k=>typeof v[k]==='string'&&String(v[k]).length>0&&String(v[k]).length<=256)||!Number.isSafeInteger(v.expectedVersion)||Number(v.expectedVersion)<1)throw Error('INVALID_ENVIRONMENT_INPUT');
 return {...v} as EnvironmentInput;
}
export type MaterialView={botId:string;assetId:string;version:number;kind:string;title:string;digest:string;policy:import('../../assets/src/registry.js').DataPolicy};
export type Snapshot={mode?:'p0-demo'|'p1-preparation';materials?:MaterialView[];authFlows?:import('../../connections/src/auth-flow.js').AuthFlowMetadata[];environments?:EnvironmentView[];connections?:ConnectionView[];approvals?:ApprovalView[];contexts?:import('../../assets/src/context-assembler.js').ContextManifest[];evidence?:{taskId:string;current:import('./evidence.js').VerificationInput|null;evidence:import('./evidence.js').EvidenceRecord[]}[];secretStorage?:{storage:'macos_safe_storage';available:boolean};cursor:number;epoch:number;bots:BotView[];tasks:TaskView[];runs:RunView[];messages:unknown[];available:boolean;sqliteVersion:string;observedAt:string;windowId:number;view:'workspace'|'settings';quitPending:boolean;selectedBotId?:string;schedulerError?:string|null};
export type DesktopEvent={type:'changed'|'unavailable'|'compose'|'navigate';botId?:string};
export type AssetSelection={name:string;text:string;bytes:number;source:'system-dialog';policy:'local-only'};
export interface DesktopBridge {
 cancelEnvironment(input:EnvironmentInput):Promise<{operationId:string;acceptance:'RECEIVED'}>;
 prepareEnvironment(input:EnvironmentInput):Promise<{operationId:string;acceptance:'RECEIVED'}>;
 snapshot():Promise<Snapshot>;
 auth(input:AuthInput):Promise<AuthView>;
 openAuth(input:{botId:string;flowId:string}):Promise<void>;
 importMaterial(input:Pick<MaterialInput,'botId'|'expectedVersion'|'kind'>):Promise<MaterialView|null>;
 createBot(input:Input<'bot.create'>):Promise<unknown>;
 submitWork(input:Input<'work.submit'>):Promise<unknown>;
 setPaused(input:Input<'bot.pause'>):Promise<unknown>;
 setAcceptingTasks(input:Input<'bot.accept'>):Promise<unknown>;
 cancelRun(input:Input<'run.cancel'>):Promise<unknown>;
 interruptRun(input:Input<'run.interrupt'>):Promise<unknown>;
 selectConnection(input:Input<'connection.select'>):Promise<unknown>;
 decideApproval(input:Input<'approval.decide'>):Promise<unknown>;
 saveCredential(value:Uint8Array):Promise<{credentialRef:string;status:'stored';storage:'macos_safe_storage'|'fake'}>;
 revokeCredential(credentialRef:string):Promise<{credentialRef:string;localDeleted:true;upstreamRevoked:false}>;
 openSettings():Promise<void>;
 selectAsset():Promise<AssetSelection|null>;
 requestQuit(choice:'begin'|'cancel'|'save'):Promise<{unknownRuns:string[]}>;
 subscribe(listener:(event:DesktopEvent)=>void):()=>void;
}
export type WorkerRequest={id:string;type:'snapshot'|'command'|'admissions'|'shutdown'|'auth'|'material'|'environment'|'environment-cancel';subject:string;command?:import('./commands.js').Command;accepting?:boolean;auth?:AuthInput;material?:MaterialInput;environment?:EnvironmentInput};
export type WorkerReply={id:string;ok:boolean;result?:unknown;error?:string;sqliteVersion?:string};
