import { ApprovalError, canonicalDigest, type ApprovalBinding, type ApprovalRecord, type ApprovalService, type ApprovalRequest } from '../../core/src/approvals.js';
export interface CodexApprovalInput { request: unknown; binding: ApprovalBinding; nativeThreadId: string; nativeTurnId: string; expiresAt: number; fileChangeEvent?: unknown; }
export type NativeApprovalResponse = { id: string | number; result: { decision: 'accept' | 'decline' | 'cancel' } | { permissions: Record<string, never>; scope: 'turn' } };
export type ApprovalMapping = { kind: 'approval'; approval: ApprovalRecord } | { kind: 'blocked'; code: string; response?: NativeApprovalResponse };
export interface CodexApprovalResponseInput extends CodexApprovalInput { expectedRequestHash: string; decision: 'accept' | 'decline' | 'cancel'; }
export const CODEX_APPROVAL_PROTOCOL_VERSION = '0.159.2';
export interface CodexApprovalAdapterOptions { runtimeVersion: string; }
const commandMethod = 'item/commandExecution/requestApproval';
const fileMethod = 'item/fileChange/requestApproval';
const permissionMethod = 'item/permissions/requestApproval';
function fail(code: string): never { throw new ApprovalError(code); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('UNSUPPORTED_NATIVE_FIELDS');
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function nullableString(value: unknown): boolean { return value === undefined || value === null || typeof value === 'string'; }
function validId(value: unknown): value is string | number { return nonempty(value) || (typeof value === 'number' && Number.isSafeInteger(value)); }
function integer(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function path(value: unknown): value is string { return nonempty(value) && value.startsWith('/') && !value.includes('\0'); }
function displayActions(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!object(entry)) return false;
    switch (entry.type) {
      case 'read': keys(entry, ['type', 'command', 'name', 'path']); if (!nonempty(entry.name) || !path(entry.path)) return false; break;
      case 'listFiles': keys(entry, ['type', 'command'], ['path']); if (!nullableString(entry.path)) return false; break;
      case 'search': keys(entry, ['type', 'command'], ['path', 'query']); if (!nullableString(entry.path) || !nullableString(entry.query)) return false; break;
      case 'unknown': keys(entry, ['type', 'command']); break;
      default: return false;
    }
    if (typeof entry.command !== 'string') return false;
  }
  return true;
}
interface NativeEnvelope { id: string | number; method: string; params: Record<string, unknown>; trace?: unknown; }
function envelope(value: unknown): NativeEnvelope {
  canonicalDigest(value); // Reject getters, cycles, non-JSON values and opaque prototypes before any interpretation.
  keys(value, ['id', 'method', 'params'], ['trace']);
  if (!validId(value.id) || !nonempty(value.method) || !object(value.params)) fail('INVALID_NATIVE_REQUEST');
  if (value.trace !== undefined && value.trace !== null) {
    keys(value.trace, [], ['traceparent', 'tracestate']);
    if (!nullableString(value.trace.traceparent) || !nullableString(value.trace.tracestate)) fail('INVALID_NATIVE_REQUEST');
  }
  return value as unknown as NativeEnvelope;
}
function denial(request: NativeEnvelope): NativeApprovalResponse | undefined {
  if (request.method === permissionMethod) return { id: request.id, result: { permissions: {}, scope: 'turn' } };
  if (request.method === commandMethod || request.method === fileMethod) return { id: request.id, result: { decision: 'decline' } };
  return undefined;
}
function descriptor(input: CodexApprovalInput): ApprovalRequest {
  const request = envelope(input.request); const params = request.params;
  if (params.threadId !== input.nativeThreadId || params.turnId !== input.nativeTurnId || !nonempty(params.itemId) || !integer(params.startedAtMs)) fail('STALE_NATIVE_SCOPE');
  let action: string; let changes: unknown;
  if (request.method === commandMethod) {
    keys(params, ['itemId', 'startedAtMs', 'threadId', 'turnId'], ['approvalId', 'command', 'commandActions', 'cwd', 'environmentId', 'kind', 'networkApprovalContext', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'reason']);
    if (params.networkApprovalContext !== undefined && params.networkApprovalContext !== null) fail('NETWORK_NOT_SINGLE_ACTION');
    if (params.kind !== undefined && params.kind !== 'command') fail('UNSUPPORTED_COMMAND_KIND');
    if (params.proposedExecpolicyAmendment != null || params.proposedNetworkPolicyAmendments != null) fail('POLICY_AMENDMENT_UNSUPPORTED');
    if (params.environmentId != null) fail('UNSUPPORTED_ENVIRONMENT');
    if (!nonempty(params.command) || !path(params.cwd) || !nullableString(params.approvalId) || !nullableString(params.reason) || !displayActions(params.commandActions)) fail('INCOMPLETE_COMMAND');
    action = 'command.execute';
  } else if (request.method === fileMethod) {
    keys(params, ['itemId', 'startedAtMs', 'threadId', 'turnId'], ['grantRoot', 'reason']);
    if (params.grantRoot != null) fail('SESSION_GRANT_UNSUPPORTED');
    if (!nullableString(params.reason)) fail('INVALID_NATIVE_REQUEST');
    canonicalDigest(input.fileChangeEvent);
    keys(input.fileChangeEvent, ['method', 'params']);
    if (input.fileChangeEvent.method !== 'item/started') fail('MISSING_FILE_CHANGE_EVIDENCE');
    const event = input.fileChangeEvent.params; keys(event, ['item', 'startedAtMs', 'threadId', 'turnId']);
    if (event.threadId !== input.nativeThreadId || event.turnId !== input.nativeTurnId || !integer(event.startedAtMs)) fail('STALE_NATIVE_SCOPE');
    const item = event.item; keys(item, ['changes', 'id', 'status', 'type']);
    if (item.id !== params.itemId || item.type !== 'fileChange' || item.status !== 'inProgress' || !Array.isArray(item.changes) || item.changes.length === 0) fail('MISSING_FILE_CHANGE_EVIDENCE');
    for (const change of item.changes) {
      keys(change, ['path', 'kind', 'diff']);
      if (!path(change.path) || typeof change.diff !== 'string' || !object(change.kind)) fail('UNSUPPORTED_FILE_CHANGE');
      const kind = change.kind;
      if (kind.type === 'update') { keys(kind, ['type'], ['move_path']); if (kind.move_path != null && !path(kind.move_path)) fail('UNSUPPORTED_FILE_CHANGE'); }
      else if (kind.type === 'add' || kind.type === 'delete') keys(kind, ['type']);
      else fail('UNSUPPORTED_FILE_CHANGE');
    }
    changes = item.changes; action = 'file.change';
  } else if (request.method === permissionMethod) fail('PERMISSION_GRANT_NOT_SINGLE_ACTION');
  else fail('UNSUPPORTED_NATIVE_METHOD');
  const parameters = { ...params, nativeRequest: request, ...(action === 'file.change' ? { changes, fileChangeEvent: input.fileChangeEvent } : {}) };
  const id = `codex:${canonicalDigest({ runId: input.binding.runId, sessionId: input.binding.sessionId, nativeRequestId: request.id })}`;
  return { id, binding: input.binding, action, parameters, expiresAt: input.expiresAt, nativeRequestId: request.id };
}
export class CodexApprovalAdapter {
  constructor(private readonly service: ApprovalService, options: CodexApprovalAdapterOptions) {
    if (options?.runtimeVersion !== CODEX_APPROVAL_PROTOCOL_VERSION) fail('UNSUPPORTED_RUNTIME_VERSION');
  }
  receive(input: CodexApprovalInput): ApprovalMapping {
    let description: ApprovalRequest;
    try { description = descriptor(input); }
    catch (error) {
      if (!(error instanceof ApprovalError)) throw error;
      let response: NativeApprovalResponse | undefined;
      try { response = denial(envelope(input.request)); } catch { /* Malformed transport has no safe response target. */ }
      return { kind: 'blocked', code: error.code, ...(response ? { response } : {}) };
    }
    return { kind: 'approval', approval: this.service.request(description) };
  }
  respond(input: CodexApprovalResponseInput): NativeApprovalResponse {
    if (!['accept', 'decline', 'cancel'].includes(input.decision)) fail('UNSUPPORTED_DECISION');
    const description = descriptor(input); const record = this.service.request(description);
    if (record.requestHash !== input.expectedRequestHash) fail('REQUEST_MISMATCH');
    const response: NativeApprovalResponse = { id: description.nativeRequestId!, result: { decision: input.decision } };
    if (input.decision === 'accept') {
      this.service.consume({ id: record.id, expectedRequestHash: input.expectedRequestHash, binding: description.binding,
        action: description.action, parameters: description.parameters, claimId: `native-response:${record.id}`, receipt: response });
    } else if (record.status !== 'DENIED') fail('APPROVAL_BLOCKED');
    return response;
  }
  /** A transport receipt retry only. Never pass this through an execution-start path. */
  replay(input: CodexApprovalInput & { expectedRequestHash: string }): NativeApprovalResponse {
    const description = descriptor(input); const record = this.service.get(description.id);
    if (record.requestHash !== input.expectedRequestHash || canonicalDigest(record.parameters) !== canonicalDigest(description.parameters) || record.expiresAt !== description.expiresAt || record.action !== description.action) fail('REQUEST_MISMATCH');
    return this.service.receipt({ id: record.id, expectedRequestHash: input.expectedRequestHash, binding: description.binding, nativeRequestId: description.nativeRequestId! }) as NativeApprovalResponse;
  }
  resolved(input: Omit<CodexApprovalInput, 'request' | 'expiresAt' | 'fileChangeEvent'> & { notification: unknown }): number {
    canonicalDigest(input.notification); keys(input.notification, ['method', 'params']);
    if (input.notification.method !== 'serverRequest/resolved') fail('UNSUPPORTED_NATIVE_METHOD');
    const params = input.notification.params; keys(params, ['requestId', 'threadId']);
    if (params.threadId !== input.nativeThreadId || !validId(params.requestId)) fail('STALE_NATIVE_SCOPE');
    const id = `codex:${canonicalDigest({ runId: input.binding.runId, sessionId: input.binding.sessionId, nativeRequestId: params.requestId })}`;
    const record = this.service.get(id);
    if (canonicalDigest(record.binding) !== canonicalDigest(input.binding) || record.nativeRequestId !== params.requestId) fail('STALE_NATIVE_SCOPE');
    const original = envelope((record.parameters as Record<string, unknown>).nativeRequest);
    if (original.params.threadId !== input.nativeThreadId || original.params.turnId !== input.nativeTurnId) fail('STALE_NATIVE_SCOPE');
    return this.service.cancel(id);
  }
  interruptTurn(binding: ApprovalBinding): number { return this.service.cancelTurn(binding); }
  cleanupExpired(): number { return this.service.expire(); }
}
