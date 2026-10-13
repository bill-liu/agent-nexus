import { deny, type AuthInspection, type AuthTarget } from './types.js';
export type { AuthTarget } from './types.js';
function targetKey(t: AuthTarget): string { return JSON.stringify([t.botId, t.nodeId, t.generation, t.runtime]); }
export function projectAuth(i: AuthInspection): AuthInspection {
  return { status: i.status, authMethod: i.authMethod, ...(i.accountRef ? { accountRef: i.accountRef } : {}), billingSource: i.billingSource,
    ...(i.executionBinding ? { executionBinding: { nodeId: i.executionBinding.nodeId, sandboxId: i.executionBinding.sandboxId, generation: i.executionBinding.generation,
      transportInstanceId: i.executionBinding.transportInstanceId, processInstanceId: i.executionBinding.processInstanceId, runId: i.executionBinding.runId,
      fencingToken: i.executionBinding.fencingToken, sessionId: i.executionBinding.sessionId, turnId: i.executionBinding.turnId } } : {}), ...(i.observedAt !== undefined ? { observedAt: i.observedAt } : {}),
    billingEvidence: i.billingEvidence, authSessionRef: i.authSessionRef, nodeId: i.nodeId, botId: i.botId, generation: i.generation, runtime: i.runtime, expiresAt: i.expiresAt };
}
/** No host cache, CLI, network, subscription token, or real authentication access. */
export class FakeAuthAdapter {
  readonly evidenceKind = 'fake' as const;
  private inspections = new Map<string, AuthInspection>();
  beginCount = 0; lastEnvironment: Record<string, string> = {}; onInspect?: () => unknown;
  setInspection(target: AuthTarget, metadata: AuthInspection): void { this.inspections.set(targetKey(target), projectAuth(metadata)); }
  inspectAuth(target: AuthTarget, environment: Record<string, string> = {}): AuthInspection {
    this.lastEnvironment = { ...environment }; this.onInspect?.(); const i = this.inspections.get(targetKey(target));
    return i ? projectAuth(i) : deny('AUTH_REQUIRED');
  }
  begin(): void { this.beginCount++; }
}
export function isolatedEnvironment(input: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {}; for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (typeof input[key] === 'string') result[key] = input[key]; return result;
}
