/** Trusted Core/Node lifecycle protocol. Never exposed as arbitrary renderer RPC. */
export interface SandboxRef { sandboxId: string; generation: number }
export type EvidenceKind = 'scripted' | 'live';
export interface SandboxObservation extends SandboxRef {
 protocolVersion: 1; state: 'created' | 'running' | 'stopped' | 'unknown' | 'destroyed';
 evidenceKind: EvidenceKind; observedAt: number;
}
export interface SandboxChannel extends SandboxRef { protocolVersion: 1; nodeId: string; channelRef: string; evidenceKind: EvidenceKind }
export interface SandboxProvider {
 create(input: {operationId:string;botId:string;sandboxId:string}):Promise<SandboxObservation>;
 start(ref:SandboxRef):Promise<SandboxObservation>;
 stop(ref:SandboxRef):Promise<SandboxObservation>;
 inspect(ref:SandboxRef):Promise<SandboxObservation>;
 connect(ref:SandboxRef):Promise<SandboxChannel>;
 destroy(ref:SandboxRef):Promise<SandboxObservation>;
}
