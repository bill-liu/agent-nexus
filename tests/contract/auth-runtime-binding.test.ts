import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AuthFlowService, createConnectionFixture, type ResolveRequest } from '../../packages/connections/src/index.js';
import type { ExecutionBinding, ExecutionCommand } from '../../packages/execution/src/contracts.js';

function setup() { return createConnectionFixture(new DatabaseSync(':memory:'), () => 1000); }
function live(f: ReturnType<typeof setup>): ResolveRequest {
  return { ...f.request, executionMode: 'live', explicitConnectionId: f.connection.id } as ResolveRequest;
}
describe('P1 scoped authentication admission', () => {
  it('fake_backend_cannot_admit_live_connection', () => {
    const f = setup();
    expect(() => f.resolver.resolve(live(f))).toThrow('LIVE_AUTH_EVIDENCE_REQUIRED');
    expect(f.store.all('snapshots')).toHaveLength(0);
  });
  it('live mode requires a user selected connection', () => {
    const f = setup();
    expect(() => f.resolver.resolve({ ...f.request, executionMode: 'live' } as ResolveRequest)).toThrow('EXPLICIT_CONNECTION_REQUIRED');
  });
  it('conflicting_env_blocks_selected_subscription', () => {
    const f = setup();
    f.registry.update(f.connection.id, 1, { route: 'direct', authMethod: 'runtime_managed_login', billingSource: 'subscription', credentialRef: undefined });
    f.auth.setInspection(f.request, { ...f.inspection, authMethod: 'runtime_managed_login', billingSource: 'subscription' });
    expect(() => f.resolver.resolve({ ...live(f), inheritedEnvironment: { OPENAI_API_KEY: 'SYNTHETIC_A4_KEY' }, runtimePolicy: { nativeLoginAllowed: true, authMethods: ['runtime_managed_login'] } })).toThrow('AUTH_MODE_MISMATCH');
    expect(f.auth.lastEnvironment).toEqual({});
  });
  it('grant_revoked_after_auth_blocks_start', () => {
    const f = setup(); const snapshot = f.resolver.resolve(f.request);
    f.grants.revoke(f.grant.id, f.grant.revision);
    expect(() => f.resolver.authorizeStart(snapshot, f.request)).toThrow('GRANT_REVOKED');
  });
  it('expired_login_preserves_workspace', () => {
    const f = setup(); const before = f.registry.get(f.connection.id);
    f.auth.setInspection(f.request, { ...f.inspection, status: 'expired' });
    expect(() => f.resolver.resolve(f.request)).toThrow('AUTH_EXPIRED');
    expect(f.registry.get(f.connection.id)).toEqual(before); expect(f.store.all('snapshots')).toHaveLength(0);
  });
  it('async inspection runs outside transaction and revocation persists', async () => {
    const f = setup();
    const resolveAsync = (f.resolver as unknown as { resolveAsync: (r: ResolveRequest, auth: unknown) => Promise<unknown> }).resolveAsync;
    expect(typeof resolveAsync).toBe('function');
    await expect(resolveAsync.call(f.resolver, f.request, { inspectAuth: async () => {
      expect(f.store.db.isTransaction).toBe(false);
      f.grants.revoke(f.grant.id, f.grant.revision); return f.inspection;
    } })).rejects.toThrow('GRANT_REVOKED');
    expect(f.grants.get(f.grant.id).revoked).toBe(true); expect(f.store.all('snapshots')).toHaveLength(0);
  });
  it('connection revision change during async auth rejects stale result', async () => {
    const f = setup();
    const resolveAsync = (f.resolver as unknown as { resolveAsync: (r: ResolveRequest, auth: unknown) => Promise<unknown> }).resolveAsync;
    expect(typeof resolveAsync).toBe('function');
    await expect(resolveAsync.call(f.resolver, f.request, { inspectAuth: async () => {
      f.registry.update(f.connection.id, 1, { name: 'Changed while awaiting' }); return f.inspection;
    } })).rejects.toThrow('CONNECTION_REVISION_MISMATCH');
    expect(f.store.all('snapshots')).toHaveLength(0);
  });
  it('async resolver rejects being called inside a SQLite transaction', async () => {
    const f = setup(); let pending: Promise<unknown> | undefined;
    f.store.transaction(() => { pending = f.resolver.resolveAsync(f.request, { inspectAuth: async () => f.inspection }); });
    await expect(pending).rejects.toThrow('ASYNC_TRANSACTION_FORBIDDEN'); expect(f.store.all('snapshots')).toHaveLength(0);
  });
  it('fresh scoped runtime evidence admits native connection while billing remains unknown', async () => {
    const f = setup(); const accountRef = `codex-account:${'a'.repeat(64)}`;
    f.registry.create({ ...f.connection, id: 'selected-codex', provider: 'openai', runtimeProfiles: ['codex-cli'], route: 'direct', authMethod: 'runtime_managed_login', credentialRef: undefined, accountRef });
    f.grants.grant({ ...f.scope, connectionId: 'selected-codex', approvedBy: f.scope.userId, expiresAt: 5000, maxBudget: 10 });
    const request = { ...live(f), explicitConnectionId: 'selected-codex', runtime: 'codex-cli', executionBinding, runtimePolicy: { nativeLoginAllowed: true, authMethods: ['runtime_managed_login' as const] } };
    const inspection = { ...f.inspection, runtime: request.runtime, authMethod: 'runtime_managed_login' as const, accountRef, billingSource: 'unknown' as const, billingEvidence: 'unknown' as const, executionBinding, observedAt: 1000 };
    const auth = { evidenceKind: 'runtime_reported' as const, inspectAuth: async () => inspection };
    const snapshot = await f.resolver.resolveAsync(request, auth);
    expect(snapshot.billingSource).toBe('unknown'); expect(snapshot.usage.amount).toBeNull(); expect(f.resolver.authorizeStart(snapshot, request).id).toBe(snapshot.id);
    await expect(f.resolver.resolveAsync({ ...request, requireKnownBilling: true }, auth)).rejects.toThrow('BILLING_UNKNOWN');
    expect(() => f.resolver.authorizeStart(snapshot, { ...request, executionBinding: { ...executionBinding, processInstanceId: 'other' } })).toThrow('AUTH_TARGET_MISMATCH');
  });
  it('stale or future auth observations cannot create a live snapshot', async () => {
    const f = setup(); f.registry.create({ ...f.connection, id: 'selected-codex', provider: 'openai', runtimeProfiles: ['codex-cli'], route: 'direct', credentialRef: undefined });
    f.grants.grant({ ...f.scope, connectionId: 'selected-codex', approvedBy: f.scope.userId, expiresAt: 5000, maxBudget: 10 });
    const request = { ...live(f), explicitConnectionId: 'selected-codex', runtime: 'codex-cli', executionBinding };
    for (const observedAt of [-30_000, 1001, NaN]) {
      await expect(f.resolver.resolveAsync(request, { evidenceKind: 'runtime_reported', inspectAuth: async () => ({ ...f.inspection, runtime: request.runtime, executionBinding, observedAt }) })).rejects.toThrow('AUTH_EXPIRED');
    }
    expect(f.store.all('snapshots')).toHaveLength(0);
  });
  it('fake protected backend cannot admit an API connection even with scoped auth evidence', async () => {
    const f = setup(); f.registry.create({ ...f.connection, id: 'api:selected', provider: 'openai', runtimeProfiles: ['codex-cli'], route: 'direct', authMethod: 'api_key' });
    f.grants.grant({ ...f.scope, connectionId: 'api:selected', approvedBy: f.scope.userId, expiresAt: 5000, maxBudget: 10 });
    const request = { ...live(f), explicitConnectionId: 'api:selected', runtime: 'codex-cli', executionBinding, runtimePolicy: { nativeLoginAllowed: false, authMethods: ['api_key' as const] } };
    await expect(f.resolver.resolveAsync(request, { evidenceKind: 'runtime_reported', inspectAuth: async () => ({ ...f.inspection, authMethod: 'api_key', runtime: request.runtime, executionBinding, observedAt: 1000 }) })).rejects.toThrow('LIVE_SECRET_BACKEND_REQUIRED');
  });
});

const executionBinding: ExecutionBinding = { nodeId: 'demo-node', sandboxId: 'sandbox:a4', generation: 1, transportInstanceId: 'transport:a4', processInstanceId: 'process:a4', runId: 'demo-run', fencingToken: 1, sessionId: 'demo-session', turnId: 'turn:a4' };
describe('Codex runtime adapter binding and unknown evidence', () => {
  async function adapter(resultPatch: Record<string, unknown> = {}, optionPatch: Record<string, unknown> = {}) {
    const { CodexAuthAdapter } = await import('../../packages/execution/src/drivers/codex-auth.js');
    const f = setup(); let observedEnvironment: Record<string, string> = {}; const request = { ...f.request, runtime: 'codex-cli', executionBinding };
    const auth = new CodexAuthAdapter({ binding: executionBinding, botId: f.scope.botId, runtime: request.runtime,
      botDirectory: '/sandbox/bots/demo-bot', home: '/sandbox/bots/demo-bot/home', configuration: 'clean',
      assertSandbox: () => {}, assertRuntimeEnvironment: (_binding: ExecutionBinding, environment: Record<string, string>) => { observedEnvironment = environment; },
      clock: () => 1000, driver: { inspectAuth: async () => ({ binding: executionBinding, status: 'authenticated', authMethod: 'runtime_managed_login', source: 'runtime_reported', accountRef: `codex-account:${'a'.repeat(64)}`, ...resultPatch }) }, ...optionPatch } as never);
    return { ...f, auth, request, environment: () => observedEnvironment };
  }
  it('scrubs inherited environment and keeps provider billing unknown', async () => {
    const f = await adapter(); const actual = await f.auth.inspectAuth(f.request, { PATH: '/host/bin', RANDOM: 'SYNTHETIC_A4_CANARY' });
    expect(actual.billingSource).toBe('unknown'); expect(actual.billingEvidence).toBe('unknown');
    expect(actual.accountRef).toBe(`codex-account:${'a'.repeat(64)}`);
    expect(f.environment()).toMatchObject({ HOME: '/sandbox/bots/demo-bot/home', CODEX_HOME: '/sandbox/bots/demo-bot/home/.codex', XDG_CONFIG_HOME: '/sandbox/bots/demo-bot/home/.config' });
    expect(f.environment().PATH).not.toBe('/host/bin'); expect(JSON.stringify(f.environment())).not.toContain('SYNTHETIC_A4_CANARY');
    expect(actual.executionBinding).toEqual(executionBinding);
  });
  it('scripted/default adapter cannot report evidence that admits live execution', async () => {
    const f = await adapter(); expect(f.auth.evidenceKind).toBe('fake');
    const verified = await adapter({}, { runtimeEvidence: 'verified_sandbox_runtime' }); expect(verified.auth.evidenceKind).toBe('runtime_reported');
  });
  it('stale runtime binding and unknown auth mode fail closed', async () => {
    const stale = await adapter({ binding: { ...executionBinding, transportInstanceId: 'stale' } });
    await expect(stale.auth.inspectAuth(stale.request)).rejects.toThrow('AUTH_TARGET_MISMATCH');
    const unknown = await adapter({ authMethod: 'unknown', status: 'unknown' });
    await expect(unknown.auth.inspectAuth(unknown.request)).rejects.toThrow('AUTH_REQUIRED');
  });
  it('conflicting config blocks before runtime inspection and host home cannot be used', async () => {
    const conflicting = await adapter({}, { configuration: 'conflicting' });
    await expect(conflicting.auth.inspectAuth(conflicting.request)).rejects.toThrow('AUTH_MODE_MISMATCH');
    const host = await adapter({}, { home: '/host/user/home' });
    await expect(host.auth.inspectAuth(host.request)).rejects.toThrow('AUTH_TARGET_MISMATCH');
  });
  it('raw runtime errors and unrecognized payload fields never leak through auth metadata', async () => {
    const safe = await adapter({ token: 'SYNTHETIC_A4_CANARY', deviceCode: 'SYNTHETIC_A4_CANARY' });
    expect(JSON.stringify(await safe.auth.inspectAuth(safe.request))).not.toContain('SYNTHETIC_A4_CANARY');
    const broken = await adapter({}, { driver: { inspectAuth: async () => { throw new Error('SYNTHETIC_A4_CANARY'); } } });
    await expect(broken.auth.inspectAuth(broken.request)).rejects.toThrow('AUTH_INSPECTION_FAILED');
  });
  it('async or boolean sandbox authority callbacks fail closed', async () => {
    const promise = await adapter({}, { assertSandbox: async () => {} });
    await expect(promise.auth.inspectAuth(promise.request)).rejects.toThrow('ASYNC_AUTHORIZATION_FORBIDDEN');
    const boolean = await adapter({}, { assertRuntimeEnvironment: () => true });
    await expect(boolean.auth.inspectAuth(boolean.request)).rejects.toThrow('ASYNC_AUTHORIZATION_FORBIDDEN');
  });
  it('fresh preflight and final send check reject revocation after preparation', async () => {
    const f = await adapter({}, { runtimeEvidence: 'verified_sandbox_runtime' });
    const accountRef = `codex-account:${'a'.repeat(64)}`;
    f.registry.create({ ...f.connection, id: 'native:selected', provider: 'openai', runtimeProfiles: [f.request.runtime], accountRef, authMethod: 'runtime_managed_login', route: 'direct', credentialRef: undefined });
    f.grants.grant({ ...f.scope, connectionId: 'native:selected', approvedBy: f.scope.userId, expiresAt: 5000, maxBudget: 10 });
    const request = { ...f.request, executionMode: 'live' as const, explicitConnectionId: 'native:selected', runtimePolicy: { nativeLoginAllowed: true, authMethods: ['runtime_managed_login' as const] } };
    const snapshot = await f.resolver.resolveAsync(request, f.auth);
    const command: ExecutionCommand = { protocolVersion: 2, executionBinding, type: 'run.start', commandId: 'command:a4', botId: request.botId, runId: request.runId, taskId: request.taskId,
      taskRevision: 1, fencingToken: 1, generation: 1, sessionId: executionBinding.sessionId, turnId: executionBinding.turnId, expiresAt: 4000, contextManifestRef: 'context:a4', resolvedConnectionRef: snapshot.id };
    await f.auth.preflight(command, snapshot, request, f.resolver);
    f.grants.revoke(snapshot.grantId, snapshot.grantRevision);
    expect(() => f.auth.authorizeNow(command, snapshot, request, f.resolver)).toThrow('GRANT_REVOKED');
    await expect(f.auth.preflight(command, snapshot, request, f.resolver)).rejects.toThrow('GRANT_REVOKED');
  });
});

describe('P1 native flow reuses the authoritative AuthFlow state machine', () => {
  function nativeSetup() {
    const f = setup(); f.registry.update(f.connection.id, 1, { authMethod: 'runtime_managed_login', route: 'direct', credentialRef: undefined });
    let flowId = ''; let cancelled = false; let afterInspect = () => {};
    const runtime = {
      allowedDomains: ['auth.openai.com'],
      assertAuthorized: () => { f.grants.assertAuthorized(f.grant.id, f.scope, f.grant.revision); },
      start: async (input: { flowId: string }) => { flowId = input.flowId; return { officialUrl: 'https://auth.openai.com/authorize', loginRef: 'login:synthetic', deviceCode: 'SYNTHETIC_A4_DEVICE' }; },
      cancel: async () => { cancelled = true; },
      inspectAuth: async () => { afterInspect(); return { ...f.inspection, authMethod: 'runtime_managed_login' as const }; }
    };
    const flows = new AuthFlowService(f.store, f.registry, f.auth, () => 1000, ['auth.example.invalid'], runtime);
    const begin = { ...f.request, connectionId: f.connection.id, connectionRevision: 2, expectedAccountRef: 'demo-account', expiresAt: 5000 };
    return { ...f, flows, runtime, begin, get flowId() { return flowId; }, get cancelled() { return cancelled; }, setAfterInspect: (fn: () => void) => { afterInspect = fn; } };
  }
  it('official synthetic flow stores no device code, completes only after target inspection', async () => {
    const f = nativeSetup(); expect(typeof f.flows.beginAsync).toBe('function');
    const flow = await f.flows.beginAsync(f.begin);
    expect(f.flows.authorizationView(flow.id).deviceCode).toBe('SYNTHETIC_A4_DEVICE');
    expect(JSON.stringify(f.store.all('auth_flows'))).not.toContain('SYNTHETIC_A4_DEVICE');
    const done = await f.flows.completeAsync({ ...f.flows.callbackBinding(flow.id), callbackUrl: 'https://auth.openai.com/callback' });
    expect(done.status).toBe('completed'); expect(f.store.all('auth_sessions')).toHaveLength(1);
    expect(() => f.flows.authorizationView(flow.id)).toThrow('AUTH_FLOW_STATE_UNAVAILABLE');
  });
  it('cancel during native inspection persists cancellation and refuses late callback', async () => {
    const f = nativeSetup(); expect(typeof f.flows.beginAsync).toBe('function'); const flow = await f.flows.beginAsync(f.begin);
    const callback = { ...f.flows.callbackBinding(flow.id), callbackUrl: 'https://auth.openai.com/callback' };
    f.setAfterInspect(() => { f.flows.cancel(flow.id); });
    await expect(f.flows.completeAsync(callback)).rejects.toThrow('AUTH_FLOW_CANCELLED');
    expect(f.flows.status(flow.id).status).toBe('cancel_unknown'); expect(f.store.all('auth_sessions')).toHaveLength(0);
    await f.flows.cancelAsync(flow.id); expect(f.cancelled).toBe(true); expect(f.flows.status(flow.id).status).toBe('cancelled');
  });
  it('Grant revocation while native auth is awaited blocks completion', async () => {
    const f = nativeSetup(); expect(typeof f.flows.beginAsync).toBe('function'); const flow = await f.flows.beginAsync(f.begin);
    f.setAfterInspect(() => { f.grants.revoke(f.grant.id, f.grant.revision); });
    await expect(f.flows.completeAsync({ ...f.flows.callbackBinding(flow.id), callbackUrl: 'https://auth.openai.com/callback' })).rejects.toThrow('GRANT_REVOKED');
    expect(f.store.all('auth_sessions')).toHaveLength(0);
  });
  it('native selected account cannot be overridden when starting authorization', async () => {
    const f = nativeSetup();
    await expect(f.flows.beginAsync({ ...f.begin, expectedAccountRef: 'other-account' })).rejects.toThrow('ACCOUNT_MISMATCH');
    expect(f.flowId).toBe(''); expect(f.store.all('auth_flows')).toHaveLength(0);
  });
  it('native auth authority callback cannot return an async allow decision', async () => {
    const f = nativeSetup();
    const flows = new AuthFlowService(f.store, f.registry, f.auth, () => 1000, [], { ...f.runtime, assertAuthorized: async () => {} });
    await expect(flows.beginAsync(f.begin)).rejects.toThrow('ASYNC_AUTHORIZATION_FORBIDDEN'); expect(f.flowId).toBe('');
  });
});

describe('pinned Codex official auth transport', () => {
  async function runtimeSetup(overrides: Record<string, unknown> = {}) {
    const { createCodexNativeAuthRuntime } = await import('../../packages/execution/src/drivers/codex-auth.js');
    const f = setup(); let phase: 'pending' | 'completed' = 'pending'; const operations: unknown[] = [];
    const runtime = createCodexNativeAuthRuntime({ binding: executionBinding, botId: f.scope.botId, runtime: f.request.runtime,
      connectionId: f.connection.id, connectionRevision: 1, loginKind: 'chatgptDeviceCode', clock: () => 1000,
      assertOperationAuthorized: () => { f.grants.assertAuthorized(f.grant.id, f.scope, f.grant.revision); },
      transport: { binding: executionBinding, runtimeVersion: '0.159.2',
        loginStart: async (input: unknown) => { operations.push(input); return { type: 'chatgptDeviceCode', loginId: 'login:synthetic', verificationUrl: 'https://auth.openai.com/device', userCode: 'SYNTHETIC_A4_DEVICE' }; },
        loginCancel: async (input: unknown) => { operations.push(input); return { status: 'canceled' }; },
        observeLogin: async () => phase },
      inspectTarget: async () => ({ ...f.inspection, authMethod: 'runtime_managed_login' }), ...overrides } as never);
    return { ...f, runtime, operations, complete: () => { phase = 'completed'; }, input: { flowId: 'flow:a4', state: 'state:synthetic', botId: f.scope.botId, nodeId: f.scope.nodeId, generation: 1,
      runtime: f.request.runtime, connectionId: f.connection.id, connectionRevision: 1, expiresAt: 5000 } };
  }
  it('maps only supported official device flow and requires matching native completion', async () => {
    const f = await runtimeSetup(); const start = await f.runtime.start(f.input);
    expect(start).toMatchObject({ officialUrl: 'https://auth.openai.com/device', deviceCode: 'SYNTHETIC_A4_DEVICE' });
    expect(f.operations[0]).toEqual({ binding: executionBinding, params: { type: 'chatgptDeviceCode' } });
    await expect(f.runtime.inspectAuth({ ...f.input, flowId: f.input.flowId })).rejects.toThrow('AUTH_REQUIRED');
    f.complete(); expect((await f.runtime.inspectAuth({ ...f.input, flowId: f.input.flowId })).status).toBe('valid');
    await f.runtime.cancel({ ...f.input, loginRef: start.loginRef });
    expect(f.operations[1]).toEqual({ binding: executionBinding, params: { loginId: 'login:synthetic' } });
  });
  it('cancelled/replaced target and revoked authorization cannot issue official requests', async () => {
    const f = await runtimeSetup();
    await expect(f.runtime.start({ ...f.input, botId: 'other-bot' })).rejects.toThrow('AUTH_FLOW_BINDING_MISMATCH');
    f.grants.revoke(f.grant.id, 1);
    await expect(f.runtime.start(f.input)).rejects.toThrow('GRANT_REVOKED'); expect(f.operations).toHaveLength(0);
  });
  it('revocation during official start cancels the native flow before rejecting', async () => {
    const f = setup(); let cancellations = 0;
    const g = await runtimeSetup({
      assertOperationAuthorized: (operation: string) => { if (operation !== 'cancel') f.grants.assertAuthorized(f.grant.id, f.scope, 1); },
      transport: { binding: executionBinding, runtimeVersion: '0.159.2',
        loginStart: async () => { f.grants.revoke(f.grant.id, 1); return { type: 'chatgptDeviceCode', loginId: 'login:pending', verificationUrl: 'https://auth.openai.com/device', userCode: 'SYNTHETIC_A4_DEVICE' }; },
        loginCancel: async () => { cancellations++; return { status: 'canceled' }; }, observeLogin: async () => 'pending' }
    });
    await expect(g.runtime.start(g.input)).rejects.toThrow('GRANT_REVOKED'); expect(cancellations).toBe(1);
  });
  it('cancel delivery unknown can be retried for the same official login only', async () => {
    let attempts = 0;
    const f = await runtimeSetup({ transport: { binding: executionBinding, runtimeVersion: '0.159.2',
      loginStart: async () => ({ type: 'chatgptDeviceCode', loginId: 'login:pending', verificationUrl: 'https://auth.openai.com/device', userCode: 'SYNTHETIC_A4_DEVICE' }),
      loginCancel: async () => { if (++attempts === 1) throw new Error('scripted transport lost'); return { status: 'canceled' }; }, observeLogin: async () => 'pending' } });
    const start = await f.runtime.start(f.input); const cancel = { ...f.input, loginRef: start.loginRef };
    await expect(f.runtime.cancel(cancel)).rejects.toThrow('AUTH_CANCEL_UNKNOWN');
    await f.runtime.cancel(cancel); expect(attempts).toBe(2);
  });
});

describe('review: composed official flow cancellation and raw schema boundary', () => {
  async function composed(raw: unknown, revoke = false, loseCancel = false) {
    const { createCodexNativeAuthRuntime } = await import('../../packages/execution/src/drivers/codex-auth.js');
    const f = setup(); f.registry.update(f.connection.id, 1, { authMethod: 'runtime_managed_login', route: 'direct', credentialRef: undefined });
    const cancellations: unknown[] = [];
    const runtime = createCodexNativeAuthRuntime({ binding: executionBinding, botId: f.scope.botId, runtime: f.request.runtime,
      connectionId: f.connection.id, connectionRevision: 2, loginKind: 'chatgptDeviceCode', clock: () => 1000,
      assertOperationAuthorized: operation => { if (operation !== 'cancel') f.grants.assertAuthorized(f.grant.id, f.scope, 1); },
      transport: { binding: executionBinding, runtimeVersion: '0.159.2', observeLogin: async () => 'pending',
        loginStart: async () => { if (revoke) f.grants.revoke(f.grant.id, 1); return raw as never; },
        loginCancel: async input => { cancellations.push(input); if (loseCancel && cancellations.length === 1) throw new Error('SYNTHETIC_A4_DISCONNECT'); return { status: 'canceled' }; } },
      inspectTarget: async () => ({ ...f.inspection, authMethod: 'runtime_managed_login' }) });
    const flows = new AuthFlowService(f.store, f.registry, f.auth, () => 1000, [], runtime);
    return { ...f, flows, cancellations, begin: { ...f.request, connectionId: f.connection.id, connectionRevision: 2, expiresAt: 5000 } };
  }
  const response = { type: 'chatgptDeviceCode', loginId: 'login:review', verificationUrl: 'https://auth.openai.com/device', userCode: 'SYNTHETIC_A4_DEVICE' };
  it('revoke during start with uncertain compensation preserves exact cancellation for service retry', async () => {
    const f = await composed(response, true, true);
    await expect(f.flows.beginAsync(f.begin)).rejects.toThrow('AUTH_CANCEL_UNKNOWN');
    const stored = f.store.all<{ id: string }>('auth_flows')[0];
    expect(f.flows.status(stored.id).status).toBe('cancel_unknown'); expect(f.cancellations).toHaveLength(1);
    expect(() => f.flows.authorizationView(stored.id)).toThrow('AUTH_FLOW_CANCELLED');
    expect(JSON.stringify(f.store.all('auth_flows'))).not.toContain('login:review');
    const retried = await f.flows.cancelAsync(stored.id); expect(retried.status).toBe('cancelled'); expect(f.cancellations).toHaveLength(2);
    for (const cancellation of f.cancellations) expect(cancellation).toEqual({ binding: executionBinding, params: { loginId: 'login:review' } });
  });
  it.each([
    { ...response, loginId: 42 }, { ...response, loginId: '' }, { ...response, userCode: undefined }, { ...response, userCode: 42 },
    { ...response, userCode: 'x'.repeat(257) }, { ...response, loginId: 'x'.repeat(257) }, { ...response, token: 'SYNTHETIC_A4_TOKEN' },
    { ...response, verificationUrl: 'https://auth.openai.com.evil.invalid/device' }, { ...response, verificationUrl: 42 },
    null, [], { type: 'chatgptDeviceCode', loginId: 'login:review', userCode: 'SYNTHETIC_A4_DEVICE' }
  ])('malformed raw native response is never admitted to the temporary auth view', async raw => {
    const f = await composed(raw);
    await expect(f.flows.beginAsync(f.begin)).rejects.toThrow('AUTH_NATIVE_RESPONSE_INVALID');
    const stored = f.store.all<{ id: string }>('auth_flows')[0];
    expect(f.flows.status(stored.id).status).not.toBe('waiting');
    expect(() => f.flows.authorizationView(stored.id)).toThrow('AUTH_FLOW_CANCELLED');
    expect(JSON.stringify(f.store.all('auth_flows'))).not.toContain('SYNTHETIC_A4');
    expect(f.cancellations.every(input => typeof (input as { params: { loginId: unknown } }).params.loginId === 'string')).toBe(true);
  });
  it('valid device response remains compatible with the pinned required fields', async () => {
    const schema = JSON.parse(readFileSync(new URL('../fixtures/codex-auth/LoginAccountResponse.json', import.meta.url), 'utf8'));
    const variant = schema.oneOf.find((entry: { properties: { type: { enum: string[] } } }) => entry.properties.type.enum.includes('chatgptDeviceCode'));
    for (const required of variant.required as string[]) expect(typeof response[required as keyof typeof response]).toBe(variant.properties[required].type);
    const f = await composed(response); const flow = await f.flows.beginAsync(f.begin);
    expect(flow.status).toBe('waiting'); expect(f.flows.authorizationView(flow.id).deviceCode).toBe(response.userCode);
    await f.flows.cancelAsync(flow.id); expect(f.flows.status(flow.id).status).toBe('cancelled');
  });
  it('valid browser response is compatible with the pinned admitted union and drops no unknown fields', async () => {
    const { validateCodexLoginResponse } = await import('../../packages/execution/src/drivers/codex-auth.js');
    const schema = JSON.parse(readFileSync(new URL('../fixtures/codex-auth/LoginAccountResponse.json', import.meta.url), 'utf8'));
    const browser = { type: 'chatgpt' as const, loginId: 'login:browser', authUrl: 'https://auth.openai.com/authorize' };
    const variant = schema.oneOf.find((entry: { properties: { type: { enum: string[] } } }) => entry.properties.type.enum.includes('chatgpt'));
    for (const required of variant.required as string[]) expect(typeof browser[required as keyof typeof browser]).toBe(variant.properties[required].type);
    expect(validateCodexLoginResponse(browser, 'chatgpt')).toEqual(browser);
    expect(() => validateCodexLoginResponse({ ...browser, token: 'SYNTHETIC_A4_TOKEN' }, 'chatgpt')).toThrow('AUTH_NATIVE_RESPONSE_INVALID');
  });
});
