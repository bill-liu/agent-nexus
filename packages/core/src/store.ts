import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { migrateCore } from '../../persistence/src/migrations.js';
import { canonicalJson, transaction } from '../../persistence/src/unit-of-work.js';
import { validateExitEvidence, type Bot, type Task, type Run, type Message, type ExitEvidence, type ExecutionCommand, type RunnerTransport, type RunnerReceipt, type CommandContext, type SendMessageInput } from './control.js';
export type { Bot, Task, Run, Message, ExitEvidence, ExecutionCommand } from './control.js';

type Row = Record<string, unknown>;
export interface CoreEvent { id: number; type: string; payload: unknown; occurredAt: number }
export interface RunEventInput { runId: string; fencingToken: number; sequence: number; type: string; payload: unknown }
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const botProjection = 'id,name,owner,version,accepting_tasks AS acceptingTasks,dispatch_paused AS dispatchPaused,sandbox_id AS sandboxId,generation';
const taskProjection = 'id,bot_id AS botId,text,revision,status';
const runProjection = 'id,bot_id AS botId,task_id AS taskId,task_revision AS taskRevision,command_id AS commandId,fencing_token AS fencingToken,generation,owner_epoch AS ownerEpoch,lease_expires_at AS leaseExpiresAt,session_id AS sessionId,turn_id AS turnId,state,slot_held AS slotHeld,version,last_sequence AS lastSequence,stop_kind AS stopKind,context_manifest_ref AS contextManifestRef,resolved_connection_ref AS resolvedConnectionRef';
const messageProjection = 'id,bot_id AS botId,task_id AS taskId,task_revision AS taskRevision,run_id AS runId,session_id AS sessionId,turn_id AS turnId,text,intent,status,reason';

/** Trusted Core authority. Never expose this object or its SQLite handle through IPC. */
export class CoreStore {
 readonly database: DatabaseSync;
 readonly epoch: number;
 private closed = false;

 constructor(path: string) {
  this.database = new DatabaseSync(path);
  try {
   migrateCore(this.database);
   this.epoch = transaction(this.database, () => {
    this.database.exec("UPDATE core_metadata SET value=value+1 WHERE key='epoch'");
    const epoch = this.metadata('epoch');
    // A persisted state is not evidence of a live process. Keep every unreleased slot.
    this.database.exec("UPDATE run SET state='LOST',version=version+1 WHERE slot_held=1");
    return epoch;
   });
  } catch (error) { this.database.close(); throw error; }
 }

 close(): void { if (!this.closed) { this.database.close(); this.closed = true; } }
 private metadata(key: string): number { return Number(this.database.prepare('SELECT value FROM core_metadata WHERE key=?').get(key)?.value); }
 private own(): void { if (this.metadata('epoch') !== this.epoch) throw new Error('STALE_CORE_EPOCH'); }
 private write<T>(operation: () => T): T { return transaction(this.database, () => { this.own(); return operation(); }); }
 private getRow(sql: string, ...values: SQLInputValue[]): Row | undefined { return this.database.prepare(sql).get(...values); }
 private bot(id: string): Bot {
  const row = this.getRow(`SELECT ${botProjection} FROM bot WHERE id=?`,id);
  if (!row) throw new Error('BOT_NOT_FOUND');
  return {...row,acceptingTasks:Boolean(row.acceptingTasks),dispatchPaused:Boolean(row.dispatchPaused)} as unknown as Bot;
 }
 private task(id: string): Task {
  const row = this.getRow(`SELECT ${taskProjection} FROM task WHERE id=?`,id);
  if (!row) throw new Error('TASK_NOT_FOUND'); return row as unknown as Task;
 }
 private run(id: string): Run {
  const row = this.getRow(`SELECT ${runProjection} FROM run WHERE id=?`,id);
  if (!row) throw new Error('RUN_NOT_FOUND'); return {...row,slotHeld:Boolean(row.slotHeld)} as unknown as Run;
 }
 private message(id: string): Message {
  const row = this.getRow(`SELECT ${messageProjection} FROM message WHERE id=?`,id);
  if (!row) throw new Error('MESSAGE_NOT_FOUND'); return row as unknown as Message;
 }
 private authorize(bot: Bot, subject: string): void { if (!subject || subject !== bot.owner) throw new Error('FORBIDDEN'); }
 private version(actual: number, expected: number): void { if (!Number.isSafeInteger(expected) || actual !== expected) throw new Error('VERSION_CONFLICT'); }
 private text(value: string, max = 65536): void { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('INVALID_INPUT'); }
 private command<T>(commandId: string, request: unknown, action: () => T): T {
  this.text(commandId,256); const requestDigest = digest(request);
  const existing = this.getRow('SELECT request_digest,result FROM command_receipt WHERE command_id=?',commandId);
  if (existing) {
   if (existing.request_digest !== requestDigest) throw new Error('IDEMPOTENCY_CONFLICT');
   return JSON.parse(String(existing.result)) as T;
  }
  const result = action();
  this.database.prepare('INSERT INTO command_receipt VALUES (?,?,?)').run(commandId,requestDigest,canonicalJson(result));
  return result;
 }
 private event(type: string, payload: unknown, commandId: string | null = null): void {
  const json = canonicalJson(payload); if (json.length > 131072) throw new Error('EVENT_TOO_LARGE');
  this.database.prepare('INSERT INTO outbox_event(type,payload,command_id,occurred_at) VALUES (?,?,?,?)').run(type,json,commandId,Date.now());
 }

 createBot(input: {commandId: string; botId: string; name: string; subject: string}): Bot {
  return this.write(() => this.command(input.commandId,{type:'bot.create',...input},() => {
   this.text(input.botId,256);this.text(input.name,256);this.text(input.subject,256);
   this.database.prepare('INSERT INTO bot(id,name,owner,sandbox_id) VALUES (?,?,?,?)').run(input.botId,input.name,input.subject,`sandbox:${input.botId}`);
   const bot = this.bot(input.botId); this.event('bot.created',bot); return bot;
  }));
 }
 submit(input: {commandId: string; botId: string; taskId: string; text: string; expectedVersion: number; subject: string}): Task {
  return this.write(() => this.command(input.commandId,{type:'work.submit',...input},() => {
   const bot = this.bot(input.botId);this.authorize(bot,input.subject);this.version(bot.version,input.expectedVersion);
   if (!bot.acceptingTasks) throw new Error('NOT_ACCEPTING_TASKS');this.text(input.text);this.text(input.taskId,256);
   this.database.prepare("INSERT INTO task(id,bot_id,text,status) VALUES (?,?,?,'QUEUED')").run(input.taskId,input.botId,input.text);
   this.database.prepare("INSERT INTO bot_inbox(task_id,bot_id,state) VALUES (?,?,'QUEUED')").run(input.taskId,input.botId);
   const task = this.task(input.taskId);this.event('task.queued',task);return task;
  }));
 }
 setPaused(input: CommandContext & {botId: string; paused: boolean}): Bot {
  return this.write(() => this.command(input.commandId,{type:'bot.setDispatchPaused',...input},() => {
   const bot = this.bot(input.botId);this.authorize(bot,input.subject);this.version(bot.version,input.expectedVersion);
   if (typeof input.paused !== 'boolean') throw new Error('INVALID_INPUT');
   this.database.prepare('UPDATE bot SET dispatch_paused=?,version=version+1 WHERE id=?').run(Number(input.paused),input.botId);
   const updated = this.bot(input.botId);this.event('bot.dispatch-paused',updated);return updated;
  }));
 }
 setAcceptingTasks(input: CommandContext & {botId: string; accepting: boolean}): Bot {
  return this.write(() => this.command(input.commandId,{type:'bot.setAcceptingTasks',...input},() => {
   const bot = this.bot(input.botId);this.authorize(bot,input.subject);this.version(bot.version,input.expectedVersion);
   if (typeof input.accepting !== 'boolean') throw new Error('INVALID_INPUT');
   this.database.prepare('UPDATE bot SET accepting_tasks=?,version=version+1 WHERE id=?').run(Number(input.accepting),input.botId);
   const updated = this.bot(input.botId);this.event('bot.accepting-tasks',updated);return updated;
  }));
 }
 dispatch(botId: string, prepare?: (run: Run) => {contextManifestRef: string; resolvedConnectionRef: string}): Run | null {
  return this.write(() => {
   const bot = this.bot(botId);
   if (bot.dispatchPaused || this.getRow('SELECT id FROM run WHERE bot_id=? AND slot_held=1',botId)) return null;
   const inbox = this.getRow("SELECT task_id FROM bot_inbox WHERE bot_id=? AND state='QUEUED' ORDER BY position LIMIT 1",botId);
   if (!inbox) return null;
   const task = this.task(String(inbox.task_id));
   this.database.exec("UPDATE core_metadata SET value=value+1 WHERE key='fencing_token'");
   if (!prepare) throw new Error('PREPARATION_REQUIRED');
   const runId = `run-${randomUUID()}`;const commandId = `start:${runId}`;
   const proposed: Run = {id:runId,botId,taskId:task.id,taskRevision:task.revision,commandId,fencingToken:this.metadata('fencing_token'),generation:bot.generation,ownerEpoch:this.epoch,leaseExpiresAt:Date.now()+60000,sessionId:`session-${randomUUID()}`,turnId:`turn-${randomUUID()}`,state:'DISPATCHED',slotHeld:true,version:1,lastSequence:0,stopKind:null,contextManifestRef:'',resolvedConnectionRef:''};
   const fixed = prepare({...proposed});
   if (fixed && typeof fixed === 'object' && 'then' in fixed) throw new Error('ASYNC_PREPARATION_FORBIDDEN');
   if (!fixed) throw new Error('PREPARATION_REQUIRED');
   this.text(fixed.contextManifestRef,256);this.text(fixed.resolvedConnectionRef,256);
   this.database.prepare(`INSERT INTO run(id,bot_id,task_id,task_revision,command_id,fencing_token,generation,owner_epoch,lease_expires_at,session_id,turn_id,state,slot_held,context_manifest_ref,resolved_connection_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,'DISPATCHED',1,?,?)`)
    .run(runId,botId,task.id,task.revision,commandId,proposed.fencingToken,bot.generation,this.epoch,proposed.leaseExpiresAt,proposed.sessionId,proposed.turnId,fixed.contextManifestRef,fixed.resolvedConnectionRef);
   this.database.prepare("UPDATE task SET status='RUNNING' WHERE id=?").run(task.id);
   this.database.prepare("UPDATE bot_inbox SET state='CLAIMED' WHERE task_id=?").run(task.id);
   const run = this.run(runId);this.event('run.dispatched',run);this.event('run.start',this.execution(run,commandId,'run.start'),commandId);return run;
  });
 }
 private execution(run: Run, commandId: string, type: ExecutionCommand['type']): ExecutionCommand {
  return {commandId,type,runId:run.id,botId:run.botId,taskId:run.taskId,taskRevision:run.taskRevision,fencingToken:run.fencingToken,generation:run.generation,sessionId:run.sessionId,turnId:run.turnId,expiresAt:run.leaseExpiresAt,contextManifestRef:run.contextManifestRef,resolvedConnectionRef:run.resolvedConnectionRef};
 }
 pendingCommands(limit = 100): ExecutionCommand[] {
  this.bound(limit);
  return this.database.prepare("SELECT payload FROM outbox_event WHERE command_id IS NOT NULL AND delivered=0 ORDER BY CASE WHEN type IN ('run.cancel','run.interrupt') THEN 0 ELSE 1 END,id LIMIT ?").all(limit).map(row => JSON.parse(String(row.payload)) as ExecutionCommand);
 }
 flushOutbox(runner: RunnerTransport, authorize?: (command: ExecutionCommand) => void, limit = 100): RunnerReceipt[] {
  this.own();const receipts: RunnerReceipt[] = [];
  for (const command of this.pendingCommands(limit)) {
   const current = this.run(command.runId);
   if ((command.type === 'run.start' || command.type === 'message.send') && (current.stopKind || !current.slotHeld)) {
    // Querying an existing effect is safe; never start or steer stopped work on a retry.
    const prior = runner.query(command.commandId);
    if (prior && (prior.runId !== command.runId || prior.requestDigest !== digest(command))) throw new Error('RUNNER_RECEIPT_MISMATCH');
    this.write(() => {
     this.database.prepare('UPDATE outbox_event SET delivered=1 WHERE command_id=?').run(command.commandId);
     if (command.messageId) this.database.prepare("UPDATE message SET status='REJECTED',reason='RUN_STOP_REQUESTED' WHERE id=? AND status='QUEUED'").run(command.messageId);
     this.event('command.suppressed',{commandId:command.commandId,runId:command.runId,reason:'RUN_STOP_REQUESTED'});
    });
    if (prior) receipts.push(prior);
    continue;
   }
   if (command.type === 'run.start' || command.type === 'message.send') {
    if (!authorize) throw new Error('START_AUTHORIZATION_REQUIRED');
    this.write(() => {
     const result: unknown = authorize(command);
     if (result && typeof result === 'object' && 'then' in result) throw new Error('ASYNC_AUTHORIZATION_FORBIDDEN');
    });
   }
   // Query first: the Runner may have committed a receipt immediately before a lost ACK.
   const receipt = runner.query(command.commandId) ?? runner.receive(command);
   this.write(() => {
    if (receipt.commandId !== command.commandId || receipt.runId !== command.runId || receipt.requestDigest !== digest(command)) throw new Error('RUNNER_RECEIPT_MISMATCH');
    this.database.prepare('UPDATE outbox_event SET delivered=1 WHERE command_id=?').run(command.commandId);
    const run = this.run(command.runId);
    if (command.type === 'run.start' && run.slotHeld && !run.stopKind) {
     if (run.state !== 'LOST') this.database.prepare('UPDATE run SET state=?,version=version+1 WHERE id=?').run(receipt.state === 'ACCEPTED' ? 'RUNNING' : 'LOST',run.id);
     this.event('run.receipt',receipt);
    }
    if (command.type === 'message.send' && command.messageId) {
     this.database.prepare("UPDATE message SET status=?,reason=? WHERE id=? AND status='QUEUED'").run(receipt.state === 'ACCEPTED' ? 'DELIVERED' : 'REJECTED',receipt.reason ?? null,command.messageId);
     this.event('message.delivery',this.message(command.messageId));
    }
    if ((command.type === 'run.cancel' || command.type === 'run.interrupt') && receipt.exitEvidence && receipt.state === 'ACCEPTED') this.exit(this.run(command.runId),receipt.exitEvidence);
   });receipts.push(receipt);
  }return receipts;
 }
 requestCancel(runId: string, context?: CommandContext): Run { return this.requestStop(runId,'cancel',context); }
 requestInterrupt(runId: string, context?: CommandContext): Run { return this.requestStop(runId,'interrupt',context); }
 private requestStop(runId: string, kind: 'cancel' | 'interrupt', context?: CommandContext): Run {
  return this.write(() => {
   const initial = this.run(runId);const bot = this.bot(initial.botId);
   if (context) this.authorize(bot,context.subject);
   const commandId = context?.commandId ?? `${kind}:${runId}`;
   return this.command(commandId,{type:`run.${kind}`,runId,...(context ?? {})},() => {
    if (context) this.version(initial.version,context.expectedVersion);
    if (!initial.slotHeld) return initial;
    if (initial.stopKind) {
     if (initial.stopKind !== kind) throw new Error('CONTROL_CONFLICT');return initial;
    }
    this.database.prepare('UPDATE run SET state=?,stop_kind=?,version=version+1 WHERE id=?').run(kind === 'cancel' ? 'CANCEL_REQUESTED' : 'INTERRUPT_REQUESTED',kind,runId);
    const run = this.run(runId);const type = kind === 'cancel' ? 'run.cancel' : 'run.interrupt';
    this.event(type,this.execution(run,commandId,type),commandId);return run;
   });
  });
 }
 observeExit(runId: string, fencingToken: number, evidence: ExitEvidence): Run {
  return this.write(() => this.exit(this.fencedRun(runId,fencingToken),evidence));
 }
 private fencedRun(runId: string, token: number): Run { const run = this.run(runId);if (run.fencingToken !== token) throw new Error('STALE_FENCING_TOKEN');return run; }
 private exit(run: Run, evidence: ExitEvidence): Run {
  validateExitEvidence(evidence);
  if (!run.slotHeld) return run;
  this.database.prepare("UPDATE run SET state='EXITED',slot_held=0,exit_evidence=?,version=version+1 WHERE id=?").run(canonicalJson(evidence),run.id);
  const status = run.stopKind === 'cancel' ? 'CANCELLED' : run.stopKind === 'interrupt' ? 'WAITING_INPUT' : evidence.kind === 'process-exit' && evidence.exitCode !== 0 ? 'FAILED' : 'VERIFYING';
  this.database.prepare('UPDATE task SET status=? WHERE id=?').run(status,run.taskId);
  this.database.prepare("UPDATE bot_inbox SET state='DONE' WHERE task_id=?").run(run.taskId);
  this.event('run.exited',{runId:run.id,evidence,taskStatus:status});return this.run(run.id);
 }
 reconcile(runId: string, observation: {kind: 'alive' | 'unreachable' | 'exited'; fencingToken: number; evidence?: ExitEvidence}): Run {
  return this.write(() => {
   const run = this.fencedRun(runId,observation.fencingToken);
   if (observation.kind === 'exited') { if (!observation.evidence) throw new Error('EXIT_EVIDENCE_REQUIRED');return this.exit(run,observation.evidence); }
   if (!run.slotHeld) return run;
   const state = observation.kind === 'unreachable' ? 'LOST' : run.stopKind === 'cancel' ? 'CANCEL_REQUESTED' : run.stopKind === 'interrupt' ? 'INTERRUPT_REQUESTED' : 'RUNNING';
   this.database.prepare('UPDATE run SET state=?,owner_epoch=?,version=version+1 WHERE id=?').run(state,this.epoch,runId);
   this.event('run.reconciled',{runId,observation:observation.kind});return this.run(runId);
  });
 }
 expireLeases(now = Date.now()): number {
  return this.write(() => {
   const expired = this.database.prepare("SELECT id FROM run WHERE slot_held=1 AND lease_expires_at<? AND state!='LOST'").all(now);
   for (const row of expired) {this.database.prepare("UPDATE run SET state='LOST',version=version+1 WHERE id=?").run(String(row.id));this.event('run.lease-expired',{runId:row.id});}
   return expired.length;
  });
 }
 sendMessage(input: SendMessageInput): Message {
  return this.write(() => this.command(input.commandId,{type:'conversation.send',...input},() => {
   this.authorize(this.bot(input.botId),input.subject);this.text(input.text);this.text(input.messageId,256);
   if (input.intent !== 'discussion' && input.intent !== 'supplement') throw new Error('UNSUPPORTED_MESSAGE_INTENT');
   const run = this.run(input.runId);const task = this.task(input.taskId);
   if (task.botId !== input.botId || run.botId !== input.botId || run.taskId !== input.taskId) throw new Error('MESSAGE_SCOPE_CONFLICT');
   const valid = run.slotHeld && !run.stopKind && run.state !== 'LOST' && input.taskRevision === task.revision && input.taskRevision === run.taskRevision && input.sessionId === run.sessionId && input.turnId === run.turnId;
   this.database.prepare('INSERT INTO message(id,bot_id,task_id,task_revision,run_id,session_id,turn_id,text,intent,status,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(input.messageId,input.botId,input.taskId,input.taskRevision,input.runId,input.sessionId,input.turnId,input.text,input.intent,'RECEIVED',null);
   this.event('message.received',this.message(input.messageId));
   this.database.prepare('UPDATE message SET status=?,reason=? WHERE id=?').run(valid ? 'QUEUED' : 'REJECTED',valid ? null : 'STALE_MESSAGE_BINDING',input.messageId);
   if (valid) this.event('message.send',{...this.execution(run,input.commandId,'message.send'),messageId:input.messageId,intent:input.intent,text:input.text},input.commandId);
   else this.event('message.rejected',this.message(input.messageId));
   return this.message(input.messageId);
  }));
 }
 recordMessageApplied(messageId: string, runId: string, turnId: string, fencingToken: number): Message {
  return this.write(() => {
   const message = this.message(messageId);const run = this.fencedRun(runId,fencingToken);
   if (message.runId !== runId || message.turnId !== turnId || run.turnId !== turnId || message.sessionId !== run.sessionId || message.taskRevision !== run.taskRevision || !run.slotHeld || !['DELIVERED','APPLIED'].includes(message.status)) throw new Error('MESSAGE_BINDING_CONFLICT');
   if (message.status !== 'APPLIED') {this.database.prepare("UPDATE message SET status='APPLIED' WHERE id=?").run(messageId);this.event('message.applied',{messageId,runId,turnId});}
   return this.message(messageId);
  });
 }
 ingestRunEvent(input: RunEventInput): {duplicate: boolean; contiguousSequence: number} {
  return this.write(() => {
   const run = this.fencedRun(input.runId,input.fencingToken);
   if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || input.sequence > run.lastSequence+1000) throw new Error('INVALID_EVENT_SEQUENCE');
   this.text(input.type,256);const json = canonicalJson(input.payload);if (json.length > 65536) throw new Error('EVENT_TOO_LARGE');
   const hash = digest(input);const prior = this.getRow('SELECT request_digest FROM run_event WHERE run_id=? AND sequence=?',run.id,input.sequence);
   if (prior) {if (prior.request_digest !== hash) throw new Error('EVENT_CONFLICT');return {duplicate:true,contiguousSequence:run.lastSequence};}
   this.database.prepare('INSERT INTO run_event VALUES (?,?,?,?,?,?)').run(run.id,input.sequence,input.fencingToken,hash,input.type,json);
   let sequence = run.lastSequence;
   for (;;) {
    const next = this.getRow('SELECT type,payload FROM run_event WHERE run_id=? AND sequence=?',run.id,sequence+1);
    if (!next) break;
    const current = this.run(run.id);const payload = JSON.parse(String(next.payload)) as {evidence?: ExitEvidence};
    if (next.type === 'run.exited') {if (!payload?.evidence) throw new Error('EXIT_EVIDENCE_REQUIRED');this.exit(current,payload.evidence);}
    else if (next.type === 'run.started' && current.slotHeld && !current.stopKind && current.state !== 'LOST') this.database.prepare("UPDATE run SET state='RUNNING',version=version+1 WHERE id=?").run(run.id);
    this.event('runner.event',{runId:run.id,sequence:sequence+1,type:next.type,payload});
    sequence++;
   }
   this.database.prepare('UPDATE run SET last_sequence=? WHERE id=?').run(sequence,run.id);
   return {duplicate:false,contiguousSequence:sequence};
  });
 }
 snapshot(): {cursor: number; epoch: number; bots: Bot[]; tasks: Task[]; runs: Run[]; messages: Message[]} {
  return transaction(this.database,() => ({
   cursor:Number(this.getRow('SELECT coalesce(max(id),0) AS cursor FROM outbox_event')?.cursor),epoch:this.metadata('epoch'),
   bots:this.database.prepare('SELECT id FROM bot ORDER BY rowid').all().map(row=>this.bot(String(row.id))),
   tasks:this.database.prepare(`SELECT ${taskProjection} FROM task ORDER BY rowid`).all() as unknown as Task[],
   runs:this.database.prepare('SELECT id FROM run ORDER BY rowid').all().map(row=>this.run(String(row.id))),
   messages:this.database.prepare(`SELECT ${messageProjection} FROM message ORDER BY rowid`).all() as unknown as Message[],
  }),false);
 }
 private bound(limit: number): void {if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('INVALID_EVENT_LIMIT');}
 readEvents(cursor: number, limit = 100): {events: CoreEvent[]; cursor: number; hasMore: boolean} {
  this.bound(limit);if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('INVALID_CURSOR');
  const rows = this.database.prepare('SELECT id,type,payload,occurred_at AS occurredAt FROM outbox_event WHERE id>? ORDER BY id LIMIT ?').all(cursor,limit+1);
  const events = rows.slice(0,limit).map(row=>({...row,payload:JSON.parse(String(row.payload))})) as unknown as CoreEvent[];
  return {events,cursor:events.at(-1)?.id ?? cursor,hasMore:rows.length>limit};
 }
}
