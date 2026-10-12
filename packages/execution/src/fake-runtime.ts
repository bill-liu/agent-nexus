import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, transaction } from '../../persistence/src/unit-of-work.js';
import type { ExecutionCommand, RunnerReceipt, ExitEvidence } from '../../core/src/control.js';

/** Deterministic execution substitute. Records effects in SQLite; never launches processes. */
export class FakeRuntime {
 private readonly db: DatabaseSync;
 private closed = false;
 constructor(path: string) {
  this.db = new DatabaseSync(path);
  this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS fake_binding(bot_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,fencing_token INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS fake_run(run_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,task_id TEXT NOT NULL,task_revision INTEGER NOT NULL,generation INTEGER NOT NULL,fencing_token INTEGER NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,state TEXT NOT NULL,slot_held INTEGER NOT NULL,context_manifest_ref TEXT NOT NULL,resolved_connection_ref TEXT NOT NULL,exit_evidence TEXT);
   CREATE UNIQUE INDEX IF NOT EXISTS one_fake_writer ON fake_run(bot_id) WHERE slot_held=1;
   CREATE TABLE IF NOT EXISTS fake_receipt(command_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,receipt TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS fake_message(message_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,turn_id TEXT NOT NULL,intent TEXT NOT NULL);
  `);
  if (!this.db.prepare('PRAGMA table_info(fake_run)').all().some(column=>column.name==='exit_evidence')) this.db.exec('ALTER TABLE fake_run ADD COLUMN exit_evidence TEXT');
 }
 close(): void { if (!this.closed) {this.db.close();this.closed=true;} }
 query(commandId: string): RunnerReceipt | null {
  const row = this.db.prepare('SELECT receipt FROM fake_receipt WHERE command_id=?').get(commandId);
  return row ? JSON.parse(String(row.receipt)) as RunnerReceipt : null;
 }
 receipts(): RunnerReceipt[] { return this.db.prepare('SELECT receipt FROM fake_receipt ORDER BY rowid').all().map(row=>JSON.parse(String(row.receipt)) as RunnerReceipt); }
 receive(command: ExecutionCommand): RunnerReceipt {
  const hash = createHash('sha256').update(canonicalJson(command)).digest('hex');
  return transaction(this.db,() => {
   const prior = this.db.prepare('SELECT request_digest,receipt FROM fake_receipt WHERE command_id=?').get(command.commandId);
   if (prior) {
    if (prior.request_digest !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
    return JSON.parse(String(prior.receipt)) as RunnerReceipt;
   }
   let reason: string | undefined;
   let exitEvidence: ExitEvidence | undefined;
   const binding = this.db.prepare('SELECT generation,fencing_token FROM fake_binding WHERE bot_id=?').get(command.botId);
   const run = this.db.prepare('SELECT * FROM fake_run WHERE run_id=?').get(command.runId);
   if (binding && binding.generation !== command.generation) reason = 'BINDING_GENERATION_CONFLICT';
   else if (binding && Number(binding.fencing_token) > command.fencingToken) reason = 'STALE_FENCING_TOKEN';
   else if (command.type === 'run.start') {
    if (command.expiresAt < Date.now()) reason = 'EXPIRED_COMMAND';
    else if (run) reason = 'RUN_ALREADY_EXISTS';
    else if (this.db.prepare('SELECT run_id FROM fake_run WHERE bot_id=? AND slot_held=1').get(command.botId)) reason = 'WRITE_SLOT_HELD';
    else {
     this.db.prepare('INSERT INTO fake_binding VALUES (?,?,?) ON CONFLICT(bot_id) DO UPDATE SET fencing_token=excluded.fencing_token').run(command.botId,command.generation,command.fencingToken);
     this.db.prepare("INSERT INTO fake_run VALUES (?,?,?,?,?,?,?,?,'RUNNING',1,?,?,NULL)").run(command.runId,command.botId,command.taskId,command.taskRevision,command.generation,command.fencingToken,command.sessionId,command.turnId,command.contextManifestRef,command.resolvedConnectionRef);
    }
   } else if (!run && (command.type === 'run.cancel' || command.type === 'run.interrupt')) {
    // A durable tombstone fences a delayed start for a Run that never began here.
    this.db.prepare('INSERT OR IGNORE INTO fake_binding VALUES (?,?,?)').run(command.botId,command.generation,command.fencingToken);
    exitEvidence={kind:'isolated',source:'fake-runner',proofId:`never-started:${command.runId}:${command.fencingToken}`};
    this.db.prepare("INSERT INTO fake_run VALUES (?,?,?,?,?,?,?,?,'EXITED',0,?,?,?)").run(command.runId,command.botId,command.taskId,command.taskRevision,command.generation,command.fencingToken,command.sessionId,command.turnId,command.contextManifestRef,command.resolvedConnectionRef,canonicalJson(exitEvidence));
   } else if (!run || !run.slot_held) reason = 'RUN_NOT_ACTIVE';
   else if (run.bot_id !== command.botId || run.task_id !== command.taskId || run.task_revision !== command.taskRevision || run.generation !== command.generation || run.fencing_token !== command.fencingToken || run.session_id !== command.sessionId || run.turn_id !== command.turnId || run.context_manifest_ref !== command.contextManifestRef || run.resolved_connection_ref !== command.resolvedConnectionRef) reason = 'MESSAGE_BINDING_CONFLICT';
   else if (command.type === 'run.cancel' || command.type === 'run.interrupt') {
    this.db.prepare('UPDATE fake_run SET state=? WHERE run_id=?').run(command.type === 'run.cancel' ? 'CANCEL_REQUESTED' : 'INTERRUPT_REQUESTED',command.runId);
   } else if (command.type === 'message.send') {
    if (command.expiresAt < Date.now()) reason = 'EXPIRED_COMMAND';
    else if (run.state !== 'RUNNING') reason = 'RUN_NOT_ACTIVE';
    else if (!command.messageId || !['discussion','supplement'].includes(command.intent ?? '')) reason = 'INVALID_MESSAGE_INTENT';
    else this.db.prepare('INSERT INTO fake_message VALUES (?,?,?,?)').run(command.messageId,command.runId,command.turnId,command.intent!);
   } else reason = 'UNSUPPORTED_COMMAND';
   const receipt: RunnerReceipt = {commandId:command.commandId,runId:command.runId,requestDigest:hash,state:reason ? 'REJECTED' : 'ACCEPTED',...(reason ? {reason} : {}),...(exitEvidence ? {exitEvidence} : {})};
   // The receipt is committed in the same transaction as the simulated effect, before ACK.
   this.db.prepare('INSERT INTO fake_receipt VALUES (?,?,?)').run(command.commandId,hash,canonicalJson(receipt));
   return receipt;
  });
 }
 inspect(runId: string): {runId: string; state: string; fencingToken: number; slotHeld: boolean; exitEvidence: ExitEvidence | null} | null {
  const run = this.db.prepare('SELECT run_id,state,fencing_token,slot_held,exit_evidence FROM fake_run WHERE run_id=?').get(runId);
  return run ? {runId:String(run.run_id),state:String(run.state),fencingToken:Number(run.fencing_token),slotHeld:Boolean(run.slot_held),exitEvidence:run.exit_evidence ? JSON.parse(String(run.exit_evidence)) as ExitEvidence : null} : null;
 }
 exit(runId: string, exitCode: number): ExitEvidence {
  if (!Number.isInteger(exitCode)) throw new Error('INVALID_EXIT_CODE');
  return transaction(this.db,() => {
   const observed=this.inspect(runId);if (!observed) throw new Error('RUN_NOT_FOUND');
   if (observed.exitEvidence) return observed.exitEvidence;
   const evidence: ExitEvidence={kind:'process-exit',exitCode,source:'fake-runner',proofId:`fake-exit-${randomUUID()}`};
   this.db.prepare("UPDATE fake_run SET state='EXITED',slot_held=0,exit_evidence=? WHERE run_id=?").run(canonicalJson(evidence),runId);
   return evidence;
  });
 }
 dispatchTool(messageId: string, tool: {name: string; effect: 'read' | 'write'}): {allowed: true} {
  const message = this.db.prepare('SELECT * FROM fake_message WHERE message_id=?').get(messageId);
  if (!message) throw new Error('MESSAGE_NOT_FOUND');
  const run = this.inspect(String(message.run_id));
  if (!run?.slotHeld || run.state !== 'RUNNING') throw new Error('RUN_NOT_ACTIVE');
  if (tool.name === 'shell' || tool.name === 'exec') throw new Error('SHELL_UNSUPPORTED');
  // Tool names determine effects; an untrusted caller cannot label write_file as read.
  const effects: Record<string, 'read' | 'write'> = {read_file:'read',list_files:'read',write_file:'write',delete_file:'write'};
  if (!Object.hasOwn(effects,tool.name)) throw new Error('UNSUPPORTED_TOOL');
  const effect = effects[tool.name];
  if (message.intent === 'discussion' && (effect !== 'read' || tool.effect !== 'read')) throw new Error('READ_ONLY_DISCUSSION');
  return {allowed:true};
 }
}
