import {constants,openSync,closeSync,lstatSync,fstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import type {Connection,ConnectionGrant} from '../../connections/src/types.js';
import {canonicalDigest} from './approvals.js';
import type {P1Application} from './p1-application.js';
export {readP1EnvironmentAdmission,type P1EnvironmentAdmission} from './p1-environment-admission.js';
export interface P1Admission {version:1;targetId:string;expiresAt:number;actions:string[];authorizationRef:string;connection:Connection;grant:Omit<ConnectionGrant,'revision'|'revoked'>;runtimeConfigPath?:string}
function denied(code='P1_ADMISSION_INVALID'):never{throw Error(code);}
function object(value:unknown,required:string[],optional:string[]=[]):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))denied();}
function text(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=256;}
/** Explicit opt-in only. No search, fallback credentials, dynamic modules or socket creation. */
export function readP1ProtectedJSON(path:string):unknown {
 if(!isAbsolute(path)||resolve(path)!==path)denied('P1_ADMISSION_PATH_DENIED');
 let current=path;for(;;){const stat=lstatSync(current);if(stat.isSymbolicLink())denied('P1_ADMISSION_PATH_DENIED');const parent=dirname(current);if(parent===current)break;current=parent;}
 if(realpathSync(path)!==path)denied('P1_ADMISSION_PATH_DENIED');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let value:unknown;
 try{const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||(before.mode&0o777)!==0o600||(process.getuid&&before.uid!==process.getuid())||before.size>65536)denied('P1_ADMISSION_PATH_DENIED');const bytes=readFileSync(fd);const after=fstatSync(fd),current=lstatSync(path);if(before.ino!==current.ino||before.dev!==current.dev||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.size!==bytes.length)denied('P1_ADMISSION_PATH_DENIED');try{value=JSON.parse(bytes.toString('utf8'));}catch{denied();}}finally{closeSync(fd);}
 return value;
}
export function readP1Admission(path:string):P1Admission {
 const value=readP1ProtectedJSON(path);
 object(value,['version','targetId','expiresAt','actions','authorizationRef','connection','grant'],['runtimeConfigPath']);
 if(value.runtimeConfigPath!==undefined&&(typeof value.runtimeConfigPath!=='string'||!isAbsolute(value.runtimeConfigPath)||resolve(value.runtimeConfigPath)!==value.runtimeConfigPath))denied();
 if(value.version!==1||!text(value.targetId)||!text(value.authorizationRef)||!Number.isSafeInteger(value.expiresAt)||Number(value.expiresAt)<=Date.now()||!Array.isArray(value.actions)||!value.actions.length||new Set(value.actions).size!==value.actions.length||value.actions.some(a=>!['inspect','create-sandbox','start-sandbox','initialize-runtime','login','model.request','verify-candidate','stop'].includes(String(a))))denied();
 const c=value.connection;object(c,['id','name','provider','runtimeProfiles','authMethod','billingSource','billingEvidence','route','endpoint','allowedModels','dataPolicy','allowedNodes','fallbackPolicy','status','revision'],['accountRef','credentialRef']);
 if(!['id','name','provider','endpoint'].every(k=>text(c[k]))||c.provider==='fake'||!['runtime_managed_login','api_key','gateway_credential','local_endpoint'].includes(String(c.authMethod))||!['unknown','subscription','console','api','organization_gateway','local'].includes(String(c.billingSource))||!['provider_reported','runtime_estimated','gateway_measured','user_declared','unknown'].includes(String(c.billingEvidence))||!['local','direct','gateway'].includes(String(c.route))||!['local_only','cloud_allowed'].includes(String(c.dataPolicy))||!['deny','ask_user'].includes(String(c.fallbackPolicy))||!['ready','unknown','revoked'].includes(String(c.status))||!Number.isSafeInteger(c.revision)||Number(c.revision)<1)denied();
 for(const key of ['runtimeProfiles','allowedModels','allowedNodes'])if(!Array.isArray(c[key])||!c[key].length||c[key].some(x=>!text(x)))denied();
 if((c.runtimeProfiles as string[]).some(x=>x.startsWith('fake'))||c.credentialRef!==undefined&&(typeof c.credentialRef!=='string'||!/^credential:[A-Za-z0-9_.-]{1,160}$/.test(c.credentialRef)))denied();
 const g=value.grant;object(g,['id','connectionId','userId','projectId','botId','nodeId','generation','action','approvedBy','expiresAt','maxBudget']);
 if(!['id','connectionId','userId','projectId','botId','nodeId','action','approvedBy'].every(k=>text(g[k]))||g.userId!=='local-user'||g.approvedBy!=='local-user'||g.connectionId!==c.id||!(c.allowedNodes as string[]).includes(String(g.nodeId))||!Number.isSafeInteger(g.generation)||Number(g.generation)<1||g.action!=='model.request'||!value.actions.includes(g.action)||!Number.isSafeInteger(g.expiresAt)||Number(g.expiresAt)<=Date.now()||Number(g.expiresAt)>Number(value.expiresAt)||typeof g.maxBudget!=='number'||!Number.isFinite(g.maxBudget)||g.maxBudget<0)denied();
 return structuredClone(value) as unknown as P1Admission;
}
/** Only the trusted Worker startup receives this parsed private record. Selection remains an explicit desktop command. */
export function installAdmissionMetadata(app:P1Application,admission:P1Admission):void {
 const existing=app.connections.get<Connection>('connections',admission.connection.id);
 if(existing){if(canonicalDigest(existing)!==canonicalDigest(admission.connection))throw Error('P1_ADMISSION_REVISION_CONFLICT');}
 else app.registry.create(admission.connection);
 const prior=app.connections.get<ConnectionGrant>('grants',admission.grant.id);
 if(prior){const {revision:_revision,revoked:_revoked,...original}=prior;if(prior.revoked||canonicalDigest(original)!==canonicalDigest(admission.grant))throw Error('P1_ADMISSION_GRANT_CONFLICT');}
 else app.grants.grant(admission.grant);
}
