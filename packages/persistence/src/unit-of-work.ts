import type { DatabaseSync } from 'node:sqlite';

let savepointSequence = 0;

/** A synchronous SQLite transaction: transport calls belong after commit. */
export function transaction<T>(db: DatabaseSync, operation: () => T, write = true): T {
  const savepoint = db.isTransaction ? `an_uow_${++savepointSequence}` : null;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : write ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = operation();
    if (result && typeof result === 'object' && 'then' in result) throw new Error('ASYNC_TRANSACTION_FORBIDDEN');
    db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    if (savepoint) { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); }
    else db.exec('ROLLBACK');
    throw error;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('INVALID_JSON');
    return json;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
