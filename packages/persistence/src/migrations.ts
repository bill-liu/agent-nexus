import { DatabaseSync } from 'node:sqlite';
import { coreSchema } from './schema.js';

export function migrateCore(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='core_metadata'").get();
  if (existing) {
    const version = db.prepare("SELECT value FROM core_metadata WHERE key='schema_version'").get()?.value;
    if (version !== 1) throw new Error('UNSUPPORTED_CORE_SCHEMA');
  }
  db.exec('BEGIN IMMEDIATE');
  try { db.exec(coreSchema); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
