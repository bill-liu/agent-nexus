export const P1_APPLICATION_SCHEMA=`
CREATE TABLE IF NOT EXISTS p1_bot_configuration(bot_id TEXT PRIMARY KEY REFERENCES bot(id),operation_id TEXT UNIQUE NOT NULL,connection_id TEXT);
CREATE TABLE IF NOT EXISTS p1_run_input(run_id TEXT PRIMARY KEY,candidate_digest TEXT NOT NULL,snapshot_ref TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS p1_run_request(run_id TEXT PRIMARY KEY,request TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS p1_runner_cursor(channel_id TEXT PRIMARY KEY,cursor INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS podman_sandbox_state(operation_id TEXT PRIMARY KEY REFERENCES bot_provision(operation_id),record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS p1_desktop_command(command_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL);
`;

export const BOT_PROVISION_SCHEMA=`CREATE TABLE IF NOT EXISTS bot_provision(operation_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL UNIQUE REFERENCES bot(id), request_digest TEXT NOT NULL, record TEXT NOT NULL);`;
export const evidenceTaskUpgradeSql = `
CREATE TABLE task_evidence_v3 (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot(id), text TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','VERIFYING','WAITING_INPUT','FAILED','CANCELLED','SUCCEEDED'))
);
INSERT INTO task_evidence_v3 SELECT id,bot_id,text,revision,status FROM task;
DROP TABLE task;
ALTER TABLE task_evidence_v3 RENAME TO task;
`;
export const evidenceSchema = `CREATE TABLE IF NOT EXISTS task_acceptance (
 task_id TEXT PRIMARY KEY REFERENCES task(id), binding TEXT NOT NULL,
 input_evidence_id TEXT, input_candidate_digest TEXT, accepted_evidence_id TEXT
);
CREATE TABLE IF NOT EXISTS evaluation (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id), report TEXT NOT NULL,
 report_digest TEXT NOT NULL, stored_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS evaluation_no_update BEFORE UPDATE ON evaluation BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVIDENCE'); END;
CREATE TRIGGER IF NOT EXISTS evaluation_no_delete BEFORE DELETE ON evaluation BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVIDENCE'); END;
`;
