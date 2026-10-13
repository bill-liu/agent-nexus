import type { ExecutionBinding, ExecutionCommand } from '../../execution/src/contracts.js';
import type { ApprovalBinding, ApprovalRecord } from '../../core/src/approvals.js';
import type { Readable, Writable } from 'node:stream';
export interface DriverScope { binding: ExecutionBinding; }
export interface DriverInitialize extends DriverScope { runtimeVersion: '0.159.2'; }
/** Trusted frozen selection; modelProvider is an admitted native provider ID, never inferred from a ref. */
export interface DriverSelectedRuntime { model:string;modelProvider:string; }
export interface DriverStartTurn extends DriverScope {
 approvalBinding: ApprovalBinding; input: Array<{type:'text';text:string}>; cwd:string;
 contextManifestRef:string; resolvedConnectionRef:string; selectedRuntime:DriverSelectedRuntime;
}
export interface DriverSteer extends DriverScope { text:string; }
export interface DriverReply extends DriverScope { approvalId:string; expectedRequestHash:string; }
export interface DriverAuthInspection extends DriverScope {
 status:'authenticated'|'unauthenticated'|'unknown'; authMethod:'api_key'|'runtime_managed_login'|'unknown';
 source:'runtime_reported'; accountRef?:string;
}
export interface NativeTurnMapping extends DriverScope { nativeThreadId:string; nativeTurnId:string; }
export interface ApprovalDelivery {
 approvalId:string; delivery:'NOT_SENT'|'SENDING'|'SENT'|'UNKNOWN'; lifecycle:'PENDING'|'RESOLVED'|'CANCELLED'; effect:'UNKNOWN';
}
/** Trusted execution-side API; never expose this object or raw transport to Renderer. */
export interface RuntimeDriver {
 initialize(input:DriverInitialize):Promise<void>;
 startTurn(input:DriverStartTurn):Promise<NativeTurnMapping>;
 steer(input:DriverSteer):Promise<{delivery:'DELIVERED';applied:'UNKNOWN'}>;
 interrupt(input:DriverScope):Promise<{requested:true;stopped:'UNKNOWN'}>;
 inspectAuth(input:DriverScope):Promise<DriverAuthInspection>;
 replyServerRequest(input:DriverReply):Promise<ApprovalDelivery>;
}
/** Streams from an authenticated, already isolated Node channel. No spawn or host fallback here. */
export interface NativeDriverTransport extends DriverScope { input:Readable; output:Writable; }
export interface DriverApprovalBridge {
 onApproval(approval:ApprovalRecord):void;
 replyServerRequest(input:DriverReply):Promise<ApprovalDelivery>;
}
/** Resolves frozen references in trusted composition; no arbitrary native parameters from UI. */
export interface RunnerDriverServices {
 prepare(command:ExecutionCommand):Promise<() => Promise<void> | void>;
 authorizeNow(command:ExecutionCommand):void;
}

/** Authenticated Runner→Core approval operations. Core alone owns the approval database. */
export interface CoreApprovalPort {
 receive(input:import('../../execution/src/approval-adapter.js').CodexApprovalInput):Promise<import('../../execution/src/approval-adapter.js').ApprovalMapping>;
 respond(input:import('../../execution/src/approval-adapter.js').CodexApprovalResponseInput):Promise<import('../../execution/src/approval-adapter.js').NativeApprovalResponse>;
 replay(input:import('../../execution/src/approval-adapter.js').CodexApprovalInput & {expectedRequestHash:string}):Promise<import('../../execution/src/approval-adapter.js').NativeApprovalResponse>;
 resolved(input:Omit<import('../../execution/src/approval-adapter.js').CodexApprovalInput,'request'|'expiresAt'|'fileChangeEvent'> & {notification:unknown}):Promise<number>;
 interruptTurn(binding:ApprovalBinding):Promise<number>;
 get(input:{id:string;binding:ApprovalBinding}):Promise<ApprovalRecord>;
 cancel(input:{id:string;binding:ApprovalBinding}):Promise<number>;
}

export type DriverLoginParams={type:'chatgpt'}|{type:'chatgptDeviceCode'};
export type DriverLoginResponse={type:'chatgpt';authUrl:string;loginId:string}|{type:'chatgptDeviceCode';verificationUrl:string;loginId:string;userCode:string};
/** Dedicated temporary auth channel. Responses must never enter ordinary events, logs or exports. */
export interface DriverNativeAuthTransport {
 readonly binding:ExecutionBinding;readonly runtimeVersion:'0.159.2';
 loginStart(input:{binding:ExecutionBinding;params:DriverLoginParams}):Promise<DriverLoginResponse>;
 loginCancel(input:{binding:ExecutionBinding;params:{loginId:string}}):Promise<{status:'canceled'|'notFound'}>;
 observeLogin(input:{binding:ExecutionBinding;loginId:string}):Promise<'pending'|'completed'|'failed'|'unknown'>;
}
export interface DriverNativeAuthOptions {
 /** Omitted means denied. Must throw to deny, return void synchronously to allow. */
 authorizeOperation?:(operation:'start'|'inspect',binding:ExecutionBinding)=>void;
 /** Scoped cancellation of an owned login is allowed after this TTL/authorization expires. */
 loginTtlMs?:number;
}

/** Authenticated Core sends an immutable full run bundle; guest never parses opaque references as config. */
export interface PreparedDriverBundlePort {prepareRun(input:DriverStartTurn):Promise<void>;}
