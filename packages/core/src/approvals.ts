import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export interface ApprovalBinding {
  subjectId: string; projectId: string; botId: string; taskId: string; taskRevision: number;
  candidateVersion: string; contextDigest: string; runId: string; sessionId: string; turnId: string;
  connectionId: string; connectionRevision: number; grantId: string; grantRevision: number; nodeId: string; nodeGeneration: number;
}
export interface ApprovalRequest { id: string; binding: ApprovalBinding; action: string; parameters: unknown; expiresAt: number; nativeRequestId?: string | number; }
export interface ApprovalRecord extends ApprovalRequest { requestHash: string; parameterDigest: string; status: 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED' | 'REVOKED' | 'CONSUMED'; decidedBy: string | null; claimId: string | null; }
export interface ApprovalOptions {
  now?: () => number;
  trustedActor: () => string;
  authorizeDecision: (actor: string, binding: ApprovalBinding) => boolean;
  /** Trusted synchronous final authority/policy/version lookup, performed inside the SQLite claim transaction. */
  revalidate: (binding: ApprovalBinding, action: string, parameters: unknown) => boolean;
}
export interface ApprovalDecision { id: string; expectedRequestHash: string; decision: 'APPROVED' | 'DENIED'; }
export interface ApprovalClaim { id: string; expectedRequestHash: string; binding: ApprovalBinding; action: string; parameters: unknown; claimId: string; receipt?: unknown; }
export interface ApprovalReceiptQuery { id: string; expectedRequestHash: string; binding: ApprovalBinding; nativeRequestId: string | number; }
export class ApprovalError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ApprovalError'; }
}
function fail(code: string): never { throw new ApprovalError(code); }
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || value === null || seen.has(value)) return fail('INVALID_JSON');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) return fail('INVALID_JSON');
      const entries = Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail('INVALID_JSON');
        return canonical(descriptor.value, seen);
      });
      return `[${entries.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return fail('INVALID_JSON');
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) return fail('INVALID_JSON');
    const entries = Object.keys(value).sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) return fail('INVALID_JSON');
      return `${JSON.stringify(key)}:${canonical(descriptor.value, seen)}`;
    });
    if (Reflect.ownKeys(value).length !== entries.length) return fail('INVALID_JSON');
    return `{${entries.join(',')}}`;
  } finally { seen.delete(value); }
}
export function canonicalDigest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_REQUEST');
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) return fail('INVALID_REQUEST');
}
const bindingStrings = ['subjectId', 'projectId', 'botId', 'taskId', 'candidateVersion', 'contextDigest', 'runId', 'sessionId', 'turnId', 'connectionId', 'grantId', 'nodeId'] as const;
const bindingVersions = ['taskRevision', 'connectionRevision', 'grantRevision', 'nodeGeneration'] as const;
function validateBinding(value: unknown): asserts value is ApprovalBinding {
  shape(value, [...bindingStrings, ...bindingVersions]);
  if (bindingStrings.some(key => !text(value[key])) || bindingVersions.some(key => !Number.isSafeInteger(value[key]) || (value[key] as number) < 1)) return fail('INVALID_REQUEST');
}
function requestContent(input: ApprovalRequest) {
  return { binding: input.binding, action: input.action, parameters: input.parameters, expiresAt: input.expiresAt, nativeRequestId: input.nativeRequestId ?? null };
}
function turnKey(binding: ApprovalBinding): string { return canonicalDigest({ runId: binding.runId, sessionId: binding.sessionId, turnId: binding.turnId }); }
interface StoredRow { id: string; payload: string; request_hash: string; parameter_digest: string; status: ApprovalRecord['status']; decided_by: string | null; claim_id: string | null; receipt: string | null; }
export class ApprovalService {
  constructor(private readonly db: DatabaseSync, private readonly options: ApprovalOptions) {
    if (typeof options.revalidate !== 'function' || typeof options.trustedActor !== 'function' || typeof options.authorizeDecision !== 'function') fail('INVALID_CONFIGURATION');
    db.exec(`CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, request_hash TEXT NOT NULL, parameter_digest TEXT NOT NULL,
      native_key TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','DENIED','CANCELLED','REVOKED','CONSUMED')),
      decided_by TEXT, claim_id TEXT UNIQUE, receipt TEXT
    ); CREATE TABLE IF NOT EXISTS approval_invalidations (kind TEXT NOT NULL, scope_id TEXT NOT NULL, PRIMARY KEY(kind,scope_id));
    CREATE TRIGGER IF NOT EXISTS approval_request_immutable BEFORE UPDATE OF payload,request_hash,parameter_digest,native_key ON approval_requests BEGIN SELECT RAISE(ABORT,'IMMUTABLE_APPROVAL'); END;`);
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private currentTime(): number {
    const value = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_CLOCK');
    return value;
  }
  private row(id: string): StoredRow {
    if (!text(id)) fail('INVALID_REQUEST');
    const row = this.db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as unknown as StoredRow | undefined;
    if (!row) return fail('NOT_FOUND');
    return row;
  }
  private record(row: StoredRow): ApprovalRecord {
    const content = JSON.parse(row.payload) as ReturnType<typeof requestContent>;
    if (canonicalDigest(content) !== row.request_hash || canonicalDigest(content.parameters) !== row.parameter_digest) fail('CORRUPT_APPROVAL');
    const result: ApprovalRecord = { id: row.id, binding: content.binding, action: content.action, parameters: content.parameters, expiresAt: content.expiresAt,
      requestHash: row.request_hash, parameterDigest: row.parameter_digest, status: row.status, decidedBy: row.decided_by, claimId: row.claim_id };
    if (content.nativeRequestId !== null) result.nativeRequestId = content.nativeRequestId;
    return result;
  }
  private policy(record: ApprovalRequest): void {
    if (this.db.prepare("SELECT 1 FROM approval_invalidations WHERE (kind='run' AND scope_id=?) OR (kind='grant' AND scope_id=?) OR (kind='approval' AND scope_id=?) OR (kind='turn' AND scope_id=?)").get(record.binding.runId, record.binding.grantId, record.id, turnKey(record.binding))) fail('APPROVAL_BLOCKED');
    if (this.options.revalidate(record.binding, record.action, record.parameters) !== true) fail('POLICY_BLOCKED');
  }
  private live(record: ApprovalRequest): void { if (record.expiresAt <= this.currentTime()) fail('EXPIRED'); this.policy(record); }
  request(input: ApprovalRequest): ApprovalRecord {
    shape(input, ['id', 'binding', 'action', 'parameters', 'expiresAt'], ['nativeRequestId']); validateBinding(input.binding);
    if (!text(input.id) || !text(input.action) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.currentTime()) fail('INVALID_REQUEST');
    if (input.nativeRequestId !== undefined && !(text(input.nativeRequestId) || (typeof input.nativeRequestId === 'number' && Number.isSafeInteger(input.nativeRequestId)))) fail('INVALID_REQUEST');
    const payload = canonical(requestContent(input)); const requestHash = canonicalDigest(requestContent(input));
    const nativeKey = input.nativeRequestId === undefined ? null : canonicalDigest({ runId: input.binding.runId, sessionId: input.binding.sessionId, nativeRequestId: input.nativeRequestId });
    return this.transaction(() => {
      this.policy(input);
      const existing = this.db.prepare('SELECT * FROM approval_requests WHERE id = ? OR native_key = ?').all(input.id, nativeKey) as unknown as StoredRow[];
      if (existing.length > 1 || (existing[0] && existing[0].request_hash !== requestHash)) fail('REQUEST_CONFLICT');
      if (existing[0]) return this.record(existing[0]);
      this.db.prepare("INSERT INTO approval_requests(id,payload,request_hash,parameter_digest,native_key,status) VALUES(?,?,?,?,?,'PENDING')")
        .run(input.id, payload, requestHash, canonicalDigest(input.parameters), nativeKey);
      return this.get(input.id);
    });
  }
  get(id: string): ApprovalRecord { return this.record(this.row(id)); }
  decide(input: ApprovalDecision): ApprovalRecord {
    shape(input, ['id', 'expectedRequestHash', 'decision']);
    if (!['APPROVED', 'DENIED'].includes(input.decision)) fail('INVALID_REQUEST');
    return this.transaction(() => {
      const record = this.get(input.id);
      const actor = this.options.trustedActor();
      if (!text(actor) || this.options.authorizeDecision(actor, record.binding) !== true) fail('FORBIDDEN');
      if (record.requestHash !== input.expectedRequestHash) fail('REQUEST_MISMATCH');
      if (record.expiresAt <= this.currentTime()) fail('EXPIRED');
      if (record.status !== 'PENDING') fail('DECISION_CONFLICT');
      if (input.decision === 'APPROVED') this.policy(record);
      this.db.prepare("UPDATE approval_requests SET status=?, decided_by=? WHERE id=? AND status='PENDING'").run(input.decision, actor, input.id);
      return this.get(input.id);
    });
  }
  consume(input: ApprovalClaim): ApprovalRecord {
    shape(input, ['id', 'expectedRequestHash', 'binding', 'action', 'parameters', 'claimId'], ['receipt']); validateBinding(input.binding);
    if (!text(input.claimId)) fail('INVALID_REQUEST');
    const receipt = Object.hasOwn(input, 'receipt') ? canonical(input.receipt) : null;
    return this.transaction(() => {
      const record = this.get(input.id);
      if (record.requestHash !== input.expectedRequestHash || canonicalDigest(record.binding) !== canonicalDigest(input.binding) || record.action !== input.action || record.parameterDigest !== canonicalDigest(input.parameters)) fail('REQUEST_MISMATCH');
      if (record.status === 'CONSUMED') fail('ALREADY_CONSUMED');
      if (record.status !== 'APPROVED') fail('APPROVAL_BLOCKED');
      this.live(record);
      if (this.db.prepare('SELECT 1 FROM approval_requests WHERE claim_id=?').get(input.claimId)) fail('CLAIM_CONFLICT');
      this.db.prepare("UPDATE approval_requests SET status='CONSUMED',claim_id=?,receipt=? WHERE id=? AND status='APPROVED'").run(input.claimId, receipt, input.id);
      return this.get(input.id);
    });
  }
  receipt(input: ApprovalReceiptQuery): unknown {
    shape(input, ['id', 'expectedRequestHash', 'binding', 'nativeRequestId']); validateBinding(input.binding);
    return this.transaction(() => {
      const row = this.row(input.id); const record = this.record(row);
      if (record.requestHash !== input.expectedRequestHash || canonicalDigest(record.binding) !== canonicalDigest(input.binding) || record.nativeRequestId !== input.nativeRequestId) fail('REQUEST_MISMATCH');
      if (record.status !== 'CONSUMED' || row.receipt === null) fail('NO_RECEIPT');
      this.live(record);
      return JSON.parse(row.receipt);
    });
  }
  cancel(id: string): number {
    return this.transaction(() => {
      this.get(id); this.db.prepare("INSERT OR IGNORE INTO approval_invalidations(kind,scope_id) VALUES('approval',?)").run(id);
      return Number(this.db.prepare("UPDATE approval_requests SET status='CANCELLED' WHERE id=? AND status IN ('PENDING','APPROVED')").run(id).changes);
    });
  }
  cancelTurn(binding: ApprovalBinding): number {
    validateBinding(binding);
    return this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO approval_invalidations(kind,scope_id) VALUES('turn',?)").run(turnKey(binding));
      return Number(this.db.prepare("UPDATE approval_requests SET status='CANCELLED' WHERE json_extract(payload,'$.binding.runId')=? AND json_extract(payload,'$.binding.sessionId')=? AND json_extract(payload,'$.binding.turnId')=? AND status IN ('PENDING','APPROVED')").run(binding.runId, binding.sessionId, binding.turnId).changes);
    });
  }
  expire(): number {
    return this.transaction(() => Number(this.db.prepare("UPDATE approval_requests SET status='CANCELLED' WHERE json_extract(payload,'$.expiresAt')<=? AND status IN ('PENDING','APPROVED')").run(this.currentTime()).changes));
  }
  private invalidate(kind: 'run' | 'grant', id: string): number {
    if (!text(id)) fail('INVALID_REQUEST');
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO approval_invalidations(kind,scope_id) VALUES(?,?)').run(kind, id);
      const field = kind === 'run' ? 'runId' : 'grantId';
      return Number(this.db.prepare(`UPDATE approval_requests SET status=? WHERE json_extract(payload,'$.binding.${field}')=? AND status IN ('PENDING','APPROVED')`).run(kind === 'run' ? 'CANCELLED' : 'REVOKED', id).changes);
    });
  }
  cancelRun(runId: string): number { return this.invalidate('run', runId); }
  revokeGrant(grantId: string): number { return this.invalidate('grant', grantId); }
}
