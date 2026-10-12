export const MAX_PAYLOAD_BYTES = 32_768;
export type Scope = { botId:string };
type Base = { commandId:string; scope:Scope; expectedVersion:number };
export type Command = Base & (
 | {type:'bot.create';name:string}
 | {type:'work.submit';taskId:string;text:string}
 | {type:'bot.pause';paused:boolean}
 | {type:'bot.accept';accepting:boolean}
 | {type:'run.cancel';runId:string}
);
export type Input<T extends Command['type']> = Omit<Extract<Command,{type:T}>,'type'>;
function object(value:unknown):Record<string,unknown> { if(!value || typeof value!=='object' || Array.isArray(value)) throw Error('INVALID_SCHEMA');return value as Record<string,unknown>; }
function exact(value:Record<string,unknown>,keys:string[]) {if(Object.keys(value).some(key=>!keys.includes(key)) || keys.some(key=>!(key in value)))throw Error('INVALID_SCHEMA');}
function id(value:unknown):asserts value is string {if(typeof value!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))throw Error('INVALID_ID');}
export function parseCommand(value:unknown):Command {
 let encoded:string;try{encoded=JSON.stringify(value);}catch{throw Error('INVALID_SCHEMA');}
 if(typeof encoded!=='string' || new TextEncoder().encode(encoded).length>MAX_PAYLOAD_BYTES)throw Error('PAYLOAD_TOO_LARGE');
 const v=object(value); const fields:Record<string,string[]>={'bot.create':['name'],'work.submit':['taskId','text'],'bot.pause':['paused'],'bot.accept':['accepting'],'run.cancel':['runId']};
 if(typeof v.type!=='string' || !Object.hasOwn(fields,v.type))throw Error('UNKNOWN_COMMAND');
 exact(v,['type','commandId','scope','expectedVersion',...fields[v.type]!]);id(v.commandId);const scope=object(v.scope);exact(scope,['botId']);id(scope.botId);
 if(!Number.isSafeInteger(v.expectedVersion) || (v.expectedVersion as number)<(v.type==='bot.create'?0:1))throw Error('INVALID_VERSION');
 if(v.type==='bot.create' && (v.expectedVersion!==0 || typeof v.name!=='string' || !v.name.trim() || v.name.length>120))throw Error('INVALID_NAME');
 if(v.type==='work.submit'){id(v.taskId);if(typeof v.text!=='string' || !v.text.trim() || v.text.length>12000)throw Error('INVALID_TEXT');}
 if(v.type==='bot.pause' && typeof v.paused!=='boolean')throw Error('INVALID_SCHEMA');
 if(v.type==='bot.accept' && typeof v.accepting!=='boolean')throw Error('INVALID_SCHEMA');
 if(v.type==='run.cancel')id(v.runId);
 return v as Command;
}
