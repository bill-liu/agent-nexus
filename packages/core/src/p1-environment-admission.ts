import {readP1ProtectedJSON} from './p1-admission.js';
import type {EnvironmentAction} from './p1-environment.js';
import {isAbsolute,resolve} from 'node:path';

export interface P1EnvironmentAdmission {
 version:1;purpose:'environment-initialize';targetId:string;authorizationRef:string;expiresAt:number;
 botId:string;nodeId:string;sandboxId:string;generation:number;actions:EnvironmentAction[];
 runtimeConfigPath:string;installationManifestPath:string;
}
const actions:EnvironmentAction[]=['inspect','create-sandbox','start-sandbox','connect','initialize-runtime','stop'];
/** No Connection, Grant, credential, login or model scope is accepted here. */
export function readP1EnvironmentAdmission(path:string):P1EnvironmentAdmission {
 const value=readP1ProtectedJSON(path) as Record<string,unknown>,keys=['version','purpose','targetId','authorizationRef','expiresAt','botId','nodeId','sandboxId','generation','actions','runtimeConfigPath','installationManifestPath'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k))||value.version!==1||value.purpose!=='environment-initialize'||!['targetId','authorizationRef','botId','nodeId','sandboxId'].every(k=>typeof value[k]==='string'&&String(value[k]).trim().length>0&&String(value[k]).length<=256)||!Number.isSafeInteger(value.expiresAt)||Number(value.expiresAt)<=Date.now()||!Number.isSafeInteger(value.generation)||Number(value.generation)<1||!Array.isArray(value.actions)||value.actions.length!==actions.length||actions.some(a=>!(value.actions as unknown[]).includes(a))||!['runtimeConfigPath','installationManifestPath'].every(k=>typeof value[k]==='string'&&isAbsolute(String(value[k]))&&resolve(String(value[k]))===value[k]))throw Error('ENVIRONMENT_ADMISSION_INVALID');
 return structuredClone(value) as unknown as P1EnvironmentAdmission;
}
