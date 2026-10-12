import type { DatabaseSync } from 'node:sqlite';
import { deepFreeze, deny, type ResolvedConnectionSnapshot } from './types.js';
export type Collection = 'connections' | 'grants' | 'snapshots' | 'leases' | 'auth_flows' | 'auth_sessions' | 'switches' | 'fallback_approvals';
/** Only allowlisted domain projections belong here. No authentication responses or secret inputs. */
export class ConnectionStore {
  constructor(readonly db: DatabaseSync) { db.exec('CREATE TABLE IF NOT EXISTS an_connection_metadata (collection TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(collection,id))'); }
  get<T>(collection: Collection, id: string): T | undefined {
    const row = this.db.prepare('SELECT json FROM an_connection_metadata WHERE collection=? AND id=?').get(collection, id);
    return row ? JSON.parse(String(row.json)) as T : undefined;
  }
  all<T = unknown>(collection: Collection): T[] { return this.db.prepare('SELECT json FROM an_connection_metadata WHERE collection=? ORDER BY id').all(collection).map(r => JSON.parse(String(r.json)) as T); }
  insert(collection: Collection, id: string, value: unknown): void {
    if (this.get(collection, id)) deny('ALREADY_EXISTS');
    this.db.prepare('INSERT INTO an_connection_metadata(collection,id,json) VALUES(?,?,?)').run(collection, id, JSON.stringify(value));
  }
  replace(collection: Collection, id: string, value: unknown): void {
    if (collection === 'snapshots') deny('IMMUTABLE_SNAPSHOT');
    this.db.prepare('UPDATE an_connection_metadata SET json=? WHERE collection=? AND id=?').run(JSON.stringify(value), collection, id);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT an_connections');
    try {
      const result = fn();
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) deny('ASYNC_TRANSACTION_FORBIDDEN');
      this.db.exec('RELEASE an_connections'); return result;
    }
    catch (error) { this.db.exec('ROLLBACK TO an_connections'); this.db.exec('RELEASE an_connections'); throw error; }
  }
  snapshot(id: string): Readonly<ResolvedConnectionSnapshot> { const s = this.get<ResolvedConnectionSnapshot>('snapshots', id); return s ? deepFreeze(s) : deny('SNAPSHOT_REQUIRED'); }
}
