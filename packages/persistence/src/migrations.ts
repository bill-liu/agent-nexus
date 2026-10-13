import { DatabaseSync } from 'node:sqlite';
import { coreSchema } from './schema.js';
import { BOT_PROVISION_SCHEMA, P1_APPLICATION_SCHEMA, evidenceSchema, evidenceTaskUpgradeSql } from './p1-schema.js';

export function migrateCore(db: DatabaseSync): void {
  if (db.isTransaction) throw new Error('CORE_MIGRATION_TRANSACTION_FORBIDDEN');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='core_metadata'").get();
  const version = existing ? db.prepare("SELECT value FROM core_metadata WHERE key='schema_version'").get()?.value : undefined;
  if (existing && version !== 1 && version !== 2 && version !== 3) throw new Error('UNSUPPORTED_CORE_SCHEMA');
  // SQLite cannot disable FK enforcement inside a transaction. Rebuild only old
  // task CHECK constraints, preserving referencing table names and all rows.
  const upgrade = version === 1 || version === 2;
  if (upgrade) db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(coreSchema);
    if (upgrade) db.exec(evidenceTaskUpgradeSql);
    db.exec(BOT_PROVISION_SCHEMA + P1_APPLICATION_SCHEMA + evidenceSchema);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('CORE_MIGRATION_FOREIGN_KEY_VIOLATION');
    db.exec("UPDATE core_metadata SET value=3 WHERE key='schema_version'");
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.exec('PRAGMA foreign_keys=ON'); }
}
