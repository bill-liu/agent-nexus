export const coreSchema = `
CREATE TABLE IF NOT EXISTS core_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO core_metadata VALUES ('schema_version',1),('epoch',0),('fencing_token',0);
CREATE TABLE IF NOT EXISTS bot (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 accepting_tasks INTEGER NOT NULL DEFAULT 1 CHECK(accepting_tasks IN (0,1)),
 dispatch_paused INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_paused IN (0,1)),
 sandbox_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS task (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot(id), text TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','VERIFYING','WAITING_INPUT','FAILED','CANCELLED'))
);
CREATE TABLE IF NOT EXISTS bot_inbox (
 position INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL UNIQUE REFERENCES task(id),
 bot_id TEXT NOT NULL REFERENCES bot(id), state TEXT NOT NULL CHECK(state IN ('QUEUED','CLAIMED','DONE'))
);
CREATE TABLE IF NOT EXISTS command_receipt (
 command_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot(id), task_id TEXT NOT NULL REFERENCES task(id),
 task_revision INTEGER NOT NULL, command_id TEXT NOT NULL UNIQUE, fencing_token INTEGER NOT NULL UNIQUE,
 generation INTEGER NOT NULL, owner_epoch INTEGER NOT NULL, lease_expires_at INTEGER NOT NULL,
 session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('DISPATCHED','RUNNING','LOST','CANCEL_REQUESTED','INTERRUPT_REQUESTED','EXITED')),
 slot_held INTEGER NOT NULL CHECK(slot_held IN (0,1)), version INTEGER NOT NULL DEFAULT 1,
 last_sequence INTEGER NOT NULL DEFAULT 0, stop_kind TEXT CHECK(stop_kind IN ('cancel','interrupt')),
 exit_evidence TEXT, context_manifest_ref TEXT NOT NULL, resolved_connection_ref TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_bot_writer ON run(bot_id) WHERE slot_held=1;
CREATE TABLE IF NOT EXISTS outbox_event (
 id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL,
 command_id TEXT UNIQUE, delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)),
 occurred_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_event (
 run_id TEXT NOT NULL REFERENCES run(id), sequence INTEGER NOT NULL CHECK(sequence>0),
 fencing_token INTEGER NOT NULL, request_digest TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(run_id,sequence)
);
CREATE TABLE IF NOT EXISTS message (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot(id), task_id TEXT NOT NULL REFERENCES task(id),
 task_revision INTEGER NOT NULL, run_id TEXT NOT NULL REFERENCES run(id), session_id TEXT NOT NULL,
 turn_id TEXT NOT NULL, text TEXT NOT NULL, intent TEXT NOT NULL CHECK(intent IN ('discussion','supplement')),
 status TEXT NOT NULL CHECK(status IN ('RECEIVED','QUEUED','DELIVERED','APPLIED','REJECTED')),
 reason TEXT
);
`;
