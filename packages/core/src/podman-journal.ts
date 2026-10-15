import type {DatabaseSync} from 'node:sqlite';
import type {PodmanJournal,PodmanState} from '../../execution/src/providers/podman.js';
import {canonicalJson} from '../../persistence/src/unit-of-work.js';
/** Backend intent references the existing Bot provision identity in the same Core DB.
 * A separate row prevents old ProvisionRecord saves from erasing backend intents/writer claims. */
export function createPodmanJournal(db:DatabaseSync,operationId:string,assertCurrent:()=>void):PodmanJournal {
 const check=()=>{const result:unknown=assertCurrent();if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});throw Error('INVALID_AUTHORITY_CHECK');}if(!db.prepare('SELECT 1 FROM bot_provision WHERE operation_id=?').get(operationId))throw Error('PROVISION_NOT_FOUND');};
 const raw=()=>{check();return db.prepare('SELECT record FROM podman_sandbox_state WHERE operation_id=?').get(operationId)?.record as string|undefined;};
 return {
  read(){const value=raw();return value?JSON.parse(value):undefined;},
  compareAndSet(expected:PodmanState|undefined,next:PodmanState){check();const old=raw();if(canonicalJson(old?JSON.parse(old):null)!==canonicalJson(expected??null))throw Error('PODMAN_JOURNAL_CONFLICT');check();
   if(old===undefined){try{db.prepare('INSERT INTO podman_sandbox_state VALUES(?,?)').run(operationId,JSON.stringify(next));}catch{throw Error('PODMAN_JOURNAL_CONFLICT');}}
   else if(db.prepare('UPDATE podman_sandbox_state SET record=? WHERE operation_id=? AND record=?').run(JSON.stringify(next),operationId,old).changes!==1)throw Error('PODMAN_JOURNAL_CONFLICT');
  }
 };
}
