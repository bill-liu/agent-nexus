import type {SecretBroker} from '../../../packages/connections/src/broker.js';
/** Narrow secret channel. Main frame/write authorization is checked by the caller. */
export class DesktopCredentials {
 constructor(private readonly broker:SecretBroker){}
 save(value:unknown){if(!(value instanceof Uint8Array)||value.byteLength<1||value.byteLength>16384)throw Error('INVALID_CREDENTIAL_INPUT');try{return this.broker.save(value);}finally{value.fill(0);}}
 revoke(value:unknown){if(typeof value!=='string'||!/^credential:[A-Za-z0-9_.-]{1,160}$/.test(value))throw Error('INVALID_CREDENTIAL_REFERENCE');return this.broker.revoke(value);}
}
