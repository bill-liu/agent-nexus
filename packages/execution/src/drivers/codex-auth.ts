import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { RuntimeDriver } from '../../../contracts/src/runtime-driver.js';
import { deny, sameExecutionBinding, assertSynchronousAuthorization, type AsyncAuthInspector, type AuthInspection, type Clock, type ResolveRequest, type ResolvedConnectionSnapshot } from '../../../connections/src/types.js';
import type { ConnectionResolver } from '../../../connections/src/resolver.js';
import type { FlowTarget, NativeAuthFlowRequest, NativeAuthFlowRuntime, NativeAuthFlowStart, NativeCancellationRecovery } from '../../../connections/src/auth-flow.js';
import type { ExecutionBinding, ExecutionCommand } from '../contracts.js';

const bindingFields: readonly (keyof ExecutionBinding)[] = ['nodeId', 'sandboxId', 'generation', 'transportInstanceId', 'processInstanceId', 'runId', 'fencingToken', 'sessionId', 'turnId'];
export { sameExecutionBinding } from '../../../connections/src/types.js';
export interface CodexAuthAdapterOptions {
  /** Trusted composition supplies this only after real Node/runtime readiness; default is scripted. */
  runtimeEvidence?: 'scripted' | 'verified_sandbox_runtime';
  binding: ExecutionBinding; botId: string; runtime: string; driver: Pick<RuntimeDriver, 'inspectAuth'>;
  botDirectory: string; home: string; configuration: 'clean' | 'conflicting' | 'unknown';
  /** Authenticated Node verifies current sandbox/generation; it must never permit host execution. */
  assertSandbox(binding: ExecutionBinding): void;
  /** Verify that this already-running process was started with this exact clean configuration. */
  assertRuntimeEnvironment(binding: ExecutionBinding, environment: Readonly<Record<string, string>>): void;
  clock?: Clock; inspectionTTL?: number;
}

/** Pinned 0.159.2 official schema subset; excludes API secrets, tokens and unstable methods. */
export type CodexLoginParams = { type: 'chatgpt' } | { type: 'chatgptDeviceCode' };
export type CodexLoginResponse = { type: 'chatgpt'; authUrl: string; loginId: string }
  | { type: 'chatgptDeviceCode'; verificationUrl: string; loginId: string; userCode: string };
export interface CodexNativeAuthTransport {
  readonly binding: ExecutionBinding; readonly runtimeVersion: '0.159.2';
  loginStart(input: { binding: ExecutionBinding; params: CodexLoginParams }): Promise<CodexLoginResponse>;
  loginCancel(input: { binding: ExecutionBinding; params: { loginId: string } }): Promise<{ status: 'canceled' | 'notFound' }>;
  /** Trusted Node correlates account/login/completed on this exact process/transport/loginId. */
  observeLogin(input: { binding: ExecutionBinding; loginId: string }): Promise<'pending' | 'completed' | 'failed' | 'unknown'>;
}
export interface CodexNativeAuthOptions {
  binding: ExecutionBinding; botId: string; runtime: string; connectionId: string; connectionRevision: number;
  loginKind: CodexLoginParams['type']; transport: CodexNativeAuthTransport; clock?: Clock;
  /** Real calls require current B authorization plus scope/revision checks in trusted composition. */
  assertOperationAuthorized(operation: 'start' | 'cancel' | 'inspect', target: FlowTarget, binding: ExecutionBinding): void;
  inspectTarget(target: FlowTarget): Promise<AuthInspection>;
}
function boundedNativeString(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
/** Validate raw Node/CLI response at the consuming boundary; TypeScript is not a wire validator. */
export function validateCodexLoginResponse(raw: unknown, expected: CodexLoginParams['type']): CodexLoginResponse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) deny('AUTH_NATIVE_RESPONSE_INVALID');
  const r = raw as Record<string, unknown>;
  const keys = expected === 'chatgpt' ? ['type', 'loginId', 'authUrl'] : ['type', 'loginId', 'verificationUrl', 'userCode'];
  if (r.type !== expected || Object.keys(r).length !== keys.length || Object.keys(r).some(key => !keys.includes(key)) || !boundedNativeString(r.loginId, 256)) deny('AUTH_NATIVE_RESPONSE_INVALID');
  const urlText = expected === 'chatgpt' ? r.authUrl : r.verificationUrl;
  if (!boundedNativeString(urlText, 8192) || (expected === 'chatgptDeviceCode' && !boundedNativeString(r.userCode, 256))) deny('AUTH_NATIVE_RESPONSE_INVALID');
  let url: URL; try { url = new URL(urlText); } catch { return deny('AUTH_NATIVE_RESPONSE_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) deny('AUTH_NATIVE_RESPONSE_INVALID');
  return expected === 'chatgpt' ? { type: expected, loginId: r.loginId, authUrl: urlText } : { type: expected, loginId: r.loginId, verificationUrl: urlText, userCode: r.userCode as string };
}
/** Composes with AuthFlowService; no host process, browser, callback server, token refresh or account discovery. */
export function createCodexNativeAuthRuntime(options: CodexNativeAuthOptions): NativeAuthFlowRuntime {
  const binding = Object.freeze({ ...options.binding }); const clock = options.clock ?? Date.now;
  const active = new Map<string, NativeAuthFlowRequest & { nativeLoginId: string }>();
  const starting = new Set<string>();
  const outcomes = new Map<string, { original: NativeAuthFlowRequest; recovery: NativeCancellationRecovery }>();
  const allowedDomains = ['auth.openai.com', 'chatgpt.com'] as const;
  const assertTarget = (target: FlowTarget, operation: 'start' | 'cancel' | 'inspect') => {
    if (target.botId !== options.botId || target.nodeId !== binding.nodeId || target.generation !== binding.generation || target.runtime !== options.runtime
      || target.connectionId !== options.connectionId || target.connectionRevision !== options.connectionRevision
      || options.transport.runtimeVersion !== '0.159.2' || !sameExecutionBinding(options.transport.binding, binding)) deny('AUTH_FLOW_BINDING_MISMATCH');
    assertSynchronousAuthorization(options.assertOperationAuthorized(operation, target, binding));
  };
  return {
    allowedDomains,
    forget: flowId => { active.delete(flowId); outcomes.delete(flowId); },
    recoverCancellation: original => {
      const outcome = outcomes.get(original.flowId);
      if (!outcome) return { status: 'not_started' };
      if (['flowId', 'state', 'botId', 'nodeId', 'generation', 'runtime', 'connectionId', 'connectionRevision', 'expiresAt'].some(key => original[key as keyof NativeAuthFlowRequest] !== outcome.original[key as keyof NativeAuthFlowRequest])) deny('AUTH_FLOW_BINDING_MISMATCH');
      return { ...outcome.recovery };
    },
    assertAuthorized: target => assertTarget(target, 'inspect'),
    async start(input): Promise<NativeAuthFlowStart> {
      input = Object.freeze({ ...input });
      assertTarget(input, 'start');
      if (active.has(input.flowId) || starting.has(input.flowId)) deny('AUTH_FLOW_BINDING_MISMATCH');
      if (!Number.isFinite(input.expiresAt) || input.expiresAt <= clock() || !input.state || !input.flowId) deny('AUTH_FLOW_EXPIRED');
      if (!['chatgpt', 'chatgptDeviceCode'].includes(options.loginKind)) deny('POLICY_RESTRICTED');
      let result: CodexLoginResponse;
      starting.add(input.flowId);
      outcomes.set(input.flowId, { original: { ...input }, recovery: { status: 'unknown' } });
      let raw: unknown;
      try { raw = await options.transport.loginStart({ binding, params: { type: options.loginKind } }); } catch { return deny('AUTH_FLOW_FAILED'); } finally { starting.delete(input.flowId); }
      // Only a bounded string ID can be retained for failure cleanup; no malformed response can authenticate or reach UI.
      const safeId = raw && typeof raw === 'object' && !Array.isArray(raw) && boundedNativeString((raw as Record<string, unknown>).loginId, 256) ? (raw as { loginId: string }).loginId : undefined;
      if (safeId) outcomes.set(input.flowId, { original: { ...input }, recovery: { status: 'pending', loginRef: safeId } });
      try {
        result = validateCodexLoginResponse(raw, options.loginKind);
        active.set(input.flowId, { ...input, nativeLoginId: result.loginId });
        assertTarget(input, 'start');
        if (input.expiresAt <= clock()) deny('AUTH_FLOW_EXPIRED');
        if (result.type !== options.loginKind) deny('AUTH_FLOW_BINDING_MISMATCH');
        const officialUrl = result.type === 'chatgpt' ? result.authUrl : result.verificationUrl;
        return { officialUrl, loginRef: result.loginId, ...(result.type === 'chatgptDeviceCode' ? { deviceCode: result.userCode } : {}) };
      } catch (error) {
        if (!safeId) throw error;
        // Closing an AN flow must also cancel the exact official login it started.
        assertTarget(input, 'cancel');
        try { const cancelled = await options.transport.loginCancel({ binding, params: { loginId: safeId } }); if (!cancelled || cancelled.status !== 'canceled' || Object.keys(cancelled).length !== 1) deny('AUTH_CANCEL_UNKNOWN'); }
        catch { return deny('AUTH_CANCEL_UNKNOWN'); }
        active.delete(input.flowId); outcomes.set(input.flowId, { original: { ...input }, recovery: { status: 'confirmed' } }); throw error;
      }
    },
    async cancel(input): Promise<void> {
      assertTarget(input, 'cancel'); const outcome = outcomes.get(input.flowId); const current = outcome?.original;
      if (!current || current.state !== input.state || outcome.recovery.status !== 'pending' || outcome.recovery.loginRef !== input.loginRef) deny('AUTH_FLOW_BINDING_MISMATCH');
      let result: { status: 'canceled' | 'notFound' };
      try { result = await options.transport.loginCancel({ binding, params: { loginId: outcome.recovery.loginRef } }); } catch { return deny('AUTH_CANCEL_UNKNOWN'); }
      if (!result || result.status !== 'canceled' || Object.keys(result).length !== 1) deny('AUTH_CANCEL_UNKNOWN');
      active.delete(input.flowId);
      outcomes.set(input.flowId, { original: { ...current }, recovery: { status: 'confirmed' } });
    },
    async inspectAuth(target): Promise<AuthInspection> {
      assertTarget(target, 'inspect'); const current = target.flowId ? active.get(target.flowId) : undefined;
      if (!current) deny('AUTH_FLOW_BINDING_MISMATCH');
      if (current.expiresAt <= clock()) deny('AUTH_FLOW_EXPIRED');
      let phase: 'pending' | 'completed' | 'failed' | 'unknown';
      try { phase = await options.transport.observeLogin({ binding, loginId: current.nativeLoginId }); } catch { return deny('AUTH_INSPECTION_FAILED'); }
      assertTarget(target, 'inspect');
      if (phase !== 'completed') deny('AUTH_REQUIRED');
      const inspection = await options.inspectTarget(target); assertTarget(target, 'inspect');
      return inspection;
    }
  };
}
export function codexBotEnvironment(options: Pick<CodexAuthAdapterOptions, 'botDirectory' | 'home' | 'configuration'>, inherited: Record<string, string> = {}): Readonly<Record<string, string>> {
  if (!isAbsolute(options.botDirectory) || resolve(options.botDirectory) !== options.botDirectory || options.botDirectory === '/' || options.home !== `${options.botDirectory}/home`) deny('AUTH_TARGET_MISMATCH');
  if (options.configuration !== 'clean' || Object.entries(inherited).some(([key, value]) => value && /(?:KEY|TOKEN|SECRET|AUTH|CREDENTIAL|HOME|CONFIG|PROXY)/i.test(key))) deny('AUTH_MODE_MISMATCH');
  return Object.freeze({ PATH: '/opt/an/runtime/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: options.home,
    CODEX_HOME: `${options.home}/.codex`, XDG_CONFIG_HOME: `${options.home}/.config`, XDG_CACHE_HOME: `${options.home}/.cache`, XDG_DATA_HOME: `${options.home}/.local/share` });
}
/** Only status metadata from the official process in an already verified Bot sandbox. No token custody. */
export class CodexAuthAdapter implements AsyncAuthInspector {
  readonly evidenceKind: 'fake' | 'runtime_reported';
  private readonly binding: ExecutionBinding;
  private readonly clock: Clock;
  constructor(private readonly options: CodexAuthAdapterOptions) { this.binding = Object.freeze({ ...options.binding }); this.clock = options.clock ?? Date.now; this.evidenceKind = options.runtimeEvidence === 'verified_sandbox_runtime' ? 'runtime_reported' : 'fake'; }
  async inspectAuth(r: ResolveRequest, environment: Record<string, string> = {}): Promise<AuthInspection> {
    if (r.botId !== this.options.botId || r.nodeId !== this.binding.nodeId || r.generation !== this.binding.generation || r.runtime !== this.options.runtime || r.runId !== this.binding.runId || r.runtimeSessionRef !== this.binding.sessionId || !sameExecutionBinding(r.executionBinding, this.binding)) deny('AUTH_TARGET_MISMATCH');
    const clean = codexBotEnvironment(this.options, { ...environment, ...r.inheritedEnvironment });
    assertSynchronousAuthorization(this.options.assertSandbox(this.binding)); assertSynchronousAuthorization(this.options.assertRuntimeEnvironment(this.binding, clean));
    let actual: Awaited<ReturnType<RuntimeDriver['inspectAuth']>>;
    try { actual = await this.options.driver.inspectAuth({ binding: this.binding }); } catch { return deny('AUTH_INSPECTION_FAILED'); }
    assertSynchronousAuthorization(this.options.assertSandbox(this.binding)); assertSynchronousAuthorization(this.options.assertRuntimeEnvironment(this.binding, clean));
    if (!sameExecutionBinding(actual.binding, this.binding) || actual.source !== 'runtime_reported') deny('AUTH_TARGET_MISMATCH');
    if (actual.status !== 'authenticated' || !['api_key', 'runtime_managed_login'].includes(actual.authMethod)) deny('AUTH_REQUIRED');
    if (actual.accountRef && !/^codex-account:[a-f0-9]{64}$/.test(actual.accountRef)) deny('ACCOUNT_UNKNOWN');
    const observedAt = this.clock(); const ttl = this.options.inspectionTTL ?? 30_000;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 30_000) deny('AUTH_EXPIRED');
    const ref = createHash('sha256').update(JSON.stringify(bindingFields.map(key => this.binding[key]))).digest('hex');
    return { status: 'valid', authMethod: actual.authMethod as 'api_key' | 'runtime_managed_login', ...(actual.accountRef ? { accountRef: actual.accountRef } : {}),
      billingSource: 'unknown', billingEvidence: 'unknown', authSessionRef: `auth:codex-${ref}`, botId: r.botId, nodeId: r.nodeId, generation: r.generation,
      runtime: r.runtime, expiresAt: Math.min(r.expiresAt, observedAt + ttl), executionBinding: this.binding, observedAt };
  }
  /** A1 preflight performs fresh runtime inspection outside SQLite, followed by authorizeNow. */
  async preflight(command: ExecutionCommand, snapshot: ResolvedConnectionSnapshot, r: ResolveRequest, resolver: ConnectionResolver): Promise<void> {
    this.assertCommand(command, snapshot, r); resolver.authorizeStart(snapshot, r);
    const actual = await this.inspectAuth(r);
    if (actual.authMethod !== snapshot.authMethod || actual.accountRef !== snapshot.accountRef || actual.authSessionRef !== snapshot.authSessionRef) deny('AUTH_MODE_MISMATCH');
    if (actual.expiresAt <= this.clock()) deny('AUTH_EXPIRED');
    resolver.authorizeStart(snapshot, r);
  }
  /** Use both in Core immediately before send and in trusted execution-side authorization. */
  authorizeNow(command: ExecutionCommand, snapshot: ResolvedConnectionSnapshot, r: ResolveRequest, resolver: ConnectionResolver): void {
    this.assertCommand(command, snapshot, r); assertSynchronousAuthorization(this.options.assertSandbox(this.binding)); resolver.authorizeStart(snapshot, r);
  }
  private assertCommand(command: ExecutionCommand, snapshot: ResolvedConnectionSnapshot, r: ResolveRequest): void {
    if (command.protocolVersion !== 2 || !sameExecutionBinding(command.executionBinding, this.binding) || !sameExecutionBinding(snapshot.authExecutionBinding, this.binding) || !sameExecutionBinding(r.executionBinding, this.binding)
      || snapshot.executionMode !== 'live' || command.runId !== snapshot.runId || command.botId !== snapshot.botId || command.resolvedConnectionRef !== snapshot.id) deny('AUTH_TARGET_MISMATCH');
  }
}
