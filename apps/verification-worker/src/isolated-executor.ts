import type {AssertionResult} from '../../../packages/contracts/src/evidence.js';
import type {CandidateStore} from './candidate.js';
import type {TrustedVerifierExecutor,VerificationRequest} from './evidence.js';

/** Structurally identical to execution/contracts ExecutionBinding; no runtime dependency on Runner. */
export interface VerifierBinding {
 nodeId:string; sandboxId:string; generation:number; transportInstanceId:string; processInstanceId:string;
 runId:string; fencingToken:number; sessionId:string; turnId:string;
}
export interface VerificationAuthorization { targetId:string; expiresAt:number; actions:readonly string[] }
export interface NodeVerificationRequest {
 protocolVersion:1; operationId:string; binding:VerifierBinding; candidateSnapshotRef:string; oracleSnapshotRef:string;
 candidateDigest:string; oracleDigest:string; verifierVersion:string; stage:'A'|'B';
}
export interface NodeVerificationResponse extends NodeVerificationRequest {
 platform:{os:string;arch:string}; capabilities:string[]; assertions:AssertionResult[]; command:string[];
 exitCode:number; outputDigest:string; observationId:string;
 processTree:{complete:boolean;writableProcesses:number;state:string};
}
export interface VerificationNodeChannel { verifyCandidate(request:NodeVerificationRequest):Promise<unknown> }
interface IsolatedOptions {
 binding:VerifierBinding; platform:{os:string;arch:string}; capabilities:string[];
 authorization:VerificationAuthorization; verifierVersion:string; oracleDigest:string;
}
/** Retired transport: candidate-owned stdout cannot establish invocation truth.
 * Kept as an explicit code-level block for stale Main/A3 callers. */
export class IsolatedVerifierExecutor implements TrustedVerifierExecutor {
 readonly source='isolated-verifier' as const;
 readonly platform:{os:string;arch:string}; readonly capabilities:string[];
 constructor(options:IsolatedOptions&{channel:VerificationNodeChannel}) {this.platform=structuredClone(options.platform);this.capabilities=[...options.capabilities];}
 async execute(_input:VerificationRequest):Promise<{assertions:AssertionResult[];command:string[];exitCode:number;outputDigest:string}> {
  throw new Error('BLOCKED_PROTECTED_INVOCATION_REQUIRED');
 }
}
export interface VerificationSandboxPolicy {
 network:'none'|'gateway'; discussion:boolean; rootfs:string; home:string; project:string; cache:string;
 limits:{cpuPercent:number;memoryBytes:number;pids:number;diskBytes?:number};
}
export interface VerificationProbeController {
 runVerificationProbe(binding:VerifierBinding,policy:VerificationSandboxPolicy,inputJson:string):Promise<{
  stdout:string;exitCode:number;stopObservation:{protocolVersion:2;observationId:string;evidenceRef:string;observedAt:number;binding:VerifierBinding;processTree:{complete:boolean;writableProcesses:number;state:string}};
 }>;
}
/** Retired Node supervisor. Use the protected native evaluator, never stdout
 * emitted by a Node process into which candidate code is imported. */
export class NodeVerificationService {
 constructor(_options:IsolatedOptions&{store:CandidateStore;controller:VerificationProbeController;policyForCandidate:(path:string)=>VerificationSandboxPolicy}) {}
 async verifyCandidate(_value:unknown):Promise<NodeVerificationResponse> {
  throw new Error('BLOCKED_PROTECTED_INVOCATION_REQUIRED');
 }
}
