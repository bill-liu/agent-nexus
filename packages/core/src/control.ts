import type { ExecutionBinding } from '../../execution/src/contracts.js';
export type TaskStatus = 'QUEUED' | 'RUNNING' | 'VERIFYING' | 'WAITING_INPUT' | 'FAILED' | 'CANCELLED' | 'SUCCEEDED';
export type RunState = 'DISPATCHED' | 'RUNNING' | 'LOST' | 'CANCEL_REQUESTED' | 'INTERRUPT_REQUESTED' | 'EXITED';
export interface Bot { id: string; name: string; owner: string; version: number; acceptingTasks: boolean; dispatchPaused: boolean; sandboxId: string; generation: number }
export interface Task { id: string; botId: string; text: string; revision: number; status: TaskStatus }
export interface Run { id: string; botId: string; taskId: string; taskRevision: number; commandId: string; fencingToken: number; generation: number; ownerEpoch: number; leaseExpiresAt: number; sessionId: string; turnId: string; state: RunState; slotHeld: boolean; version: number; lastSequence: number; stopKind: 'cancel' | 'interrupt' | null; contextManifestRef: string; resolvedConnectionRef: string }
export interface Message { id: string; botId: string; taskId: string; taskRevision: number; runId: string; sessionId: string; turnId: string; text: string; intent: 'discussion' | 'supplement'; status: 'RECEIVED' | 'QUEUED' | 'DELIVERED' | 'APPLIED' | 'REJECTED'; reason: string | null }
export interface ExitEvidence { kind: 'process-exit' | 'isolated'; exitCode?: number; source: 'fake-runner'; proofId?: string }
export interface ExecutionCommand {
 protocolVersion?: 2; executionBinding?: ExecutionBinding;
 commandId: string; type: 'run.start' | 'run.cancel' | 'run.interrupt' | 'message.send';
 runId: string; botId: string; taskId: string; taskRevision: number;
 fencingToken: number; generation: number; sessionId: string; turnId: string; expiresAt: number;
 contextManifestRef: string; resolvedConnectionRef: string;
 messageId?: string; intent?: 'discussion' | 'supplement'; text?: string;
}
export interface RunnerReceipt { commandId: string; runId: string; requestDigest: string; state: 'ACCEPTED' | 'REJECTED'; reason?: string; exitEvidence?: ExitEvidence }
export interface RunnerTransport { receive(command: ExecutionCommand): RunnerReceipt; query(commandId: string): RunnerReceipt | null }
export interface CommandContext { commandId: string; expectedVersion: number; subject: string }
export interface SendMessageInput { commandId: string; messageId: string; botId: string; taskId: string; taskRevision: number; runId: string; sessionId: string; turnId: string; text: string; intent: 'discussion' | 'supplement'; subject: string }

export function validateExitEvidence(evidence: ExitEvidence): void {
 if (!evidence || evidence.source !== 'fake-runner' ||
     (evidence.kind !== 'process-exit' && evidence.kind !== 'isolated') ||
     (evidence.kind === 'process-exit' && !Number.isInteger(evidence.exitCode)) ||
     (evidence.kind === 'isolated' && !evidence.proofId)) throw new Error('EXIT_EVIDENCE_REQUIRED');
}
