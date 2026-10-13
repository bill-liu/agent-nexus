import { createHash } from 'node:crypto';
import { canonicalJson } from '../../persistence/src/unit-of-work.js';
import type { AsyncRunnerTransport, ExecutionBinding, ExecutionCommand, RunnerReceipt, RunnerTransport, TrustedStopObservation } from './contracts.js';
export const commandDigest = (command: ExecutionCommand): string => createHash('sha256').update(canonicalJson(command)).digest('hex');
export function assertRunnerReceipt(command: ExecutionCommand, receipt: RunnerReceipt): void {
 if (!receipt || receipt.commandId !== command.commandId || receipt.runId !== command.runId || receipt.requestDigest !== commandDigest(command) || !['ACCEPTED','REJECTED'].includes(receipt.state)) throw new Error('RUNNER_RECEIPT_MISMATCH');
}
export function assertExecutionProtocol(command: ExecutionCommand): void {
 if (command.protocolVersion === undefined && command.executionBinding === undefined) return;
 if (command.protocolVersion !== 2 || !command.executionBinding) throw new Error('UNSUPPORTED_EXECUTION_PROTOCOL');
 const b=command.executionBinding;assertExecutionBinding(b);
 if (b.runId!==command.runId || b.generation!==command.generation || b.fencingToken!==command.fencingToken || b.sessionId!==command.sessionId || b.turnId!==command.turnId) throw new Error('EXECUTION_BINDING_MISMATCH');
}
export function assertExecutionBinding(binding: ExecutionBinding): void {
 if (!binding || !['nodeId','sandboxId','transportInstanceId','processInstanceId','runId','sessionId','turnId'].every(k=>typeof binding[k as keyof ExecutionBinding]==='string' && String(binding[k as keyof ExecutionBinding]).trim().length>0 && String(binding[k as keyof ExecutionBinding]).length<=256) || !Number.isSafeInteger(binding.generation) || binding.generation<1 || !Number.isSafeInteger(binding.fencingToken) || binding.fencingToken<1) throw new Error('EXECUTION_BINDING_MISMATCH');
}
export function assertTrustedStop(binding: ExecutionBinding, evidenceRef: string, observation: TrustedStopObservation | null, requestedAt: number, now = Date.now()): asserts observation is TrustedStopObservation {
 if (!observation || observation.protocolVersion!==2 || !observation.observationId || observation.observationId.length>256 || observation.evidenceRef!==evidenceRef || !evidenceRef || evidenceRef.length>256) throw new Error('TRUSTED_NODE_OBSERVATION_REQUIRED');
 assertExecutionBinding(observation.binding);
 if (canonicalJson(binding)!==canonicalJson(observation.binding)) throw new Error('STOP_OBSERVATION_BINDING_MISMATCH');
 if (!Number.isSafeInteger(observation.observedAt) || observation.observedAt<requestedAt || observation.observedAt>now || now-observation.observedAt>30000) throw new Error('STOP_OBSERVATION_STALE');
 const tree=observation.processTree;
 if (!tree || tree.complete!==true || tree.writableProcesses!==0 || !['stopped','isolated'].includes(tree.state)) throw new Error('WRITABLE_PROCESS_TREE_UNCONFIRMED');
 if (tree.state==='stopped' && !Number.isInteger(observation.exitCode)) throw new Error('EXIT_EVIDENCE_REQUIRED');
}
/** The adapter preserves P0 test semantics; it cannot attest to real processes. */
export function adaptSyncRunner(runner: RunnerTransport): AsyncRunnerTransport {
 return {receive:async command=>{assertExecutionProtocol(command);if(command.protocolVersion===2)throw new Error('FAKE_TRANSPORT_REAL_EXECUTION_FORBIDDEN');return runner.receive(command);},query:async id=>runner.query(id)};
}
/** Validation at a transport boundary; durable command deduplication belongs to the Runner. */
export class RunnerClient implements AsyncRunnerTransport {
 constructor(private readonly transport: AsyncRunnerTransport) {}
 async receive(command: ExecutionCommand): Promise<RunnerReceipt> {assertExecutionProtocol(command);const receipt=await this.transport.receive(command);assertRunnerReceipt(command,receipt);return receipt;}
 query(commandId: string): Promise<RunnerReceipt|null> {return this.transport.query(commandId);}
}
