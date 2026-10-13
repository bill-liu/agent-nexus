import type { ExecutionCommand, RunnerReceipt, RunnerTransport, Run } from '../../core/src/control.js';
export type { ExecutionCommand, RunnerReceipt, RunnerTransport };

/** Missing protocolVersion is the legacy P0 fake protocol, never a real execution. */
export const EXECUTION_PROTOCOL_VERSION = 2 as const;
export interface AsyncRunnerTransport {
 receive(command: ExecutionCommand): Promise<RunnerReceipt>;
 query(commandId: string): Promise<RunnerReceipt | null>;
}
export interface ExecutionBinding {
 nodeId: string; sandboxId: string; generation: number;
 transportInstanceId: string; processInstanceId: string;
 runId: string; fencingToken: number; sessionId: string; turnId: string;
}
export interface TrustedStopObservation {
 protocolVersion: 2; observationId: string; evidenceRef: string; observedAt: number;
 binding: ExecutionBinding;
 processTree: {complete: boolean; writableProcesses: number; state: 'stopped' | 'isolated' | 'running' | 'unknown'};
 exitCode?: number;
}
/** Inject only a trusted authenticated Node/Provider adapter, never a Runner or UI assertion. */
export interface TrustedNodeVerifier {
 observeStop(binding: ExecutionBinding, evidenceRef: string): Promise<TrustedStopObservation | null>;
}
export interface PreparedExecution {
 contextManifestRef: string; resolvedConnectionRef: string; binding: ExecutionBinding;
 verifiedAt: number; expiresAt: number;
}
export interface AsyncExecutionServices {
 prepare(run: Run, sandboxId: string): Promise<PreparedExecution>;
 /** Current Grant/revision/lease check; no async work or cached allow decision here. */
 authorizeNow(command: ExecutionCommand): void;
 preflight?(command: ExecutionCommand): Promise<void>;
}
