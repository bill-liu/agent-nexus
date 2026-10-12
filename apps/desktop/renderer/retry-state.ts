export type CommandFailure = 'rejected' | 'uncertain';
/** Unknown transport/commit outcomes retain the original identity; proven rejections allow a new intent. */
export function commandFailure(error: unknown): CommandFailure {
 const message=String(error);
 if(/\b(?:RESULT_UNKNOWN|CORE_UNAVAILABLE)\b/.test(message))return 'uncertain';
 const definite=/\b(?:VERSION_CONFLICT|IDEMPOTENCY_CONFLICT|INVALID_[A-Z_]+|PAYLOAD_TOO_LARGE|UNKNOWN_COMMAND|UNAUTHORIZED_[A-Z_]+|UNAUTHORIZED|FORBIDDEN|NOT_AUTHORIZED|NOT_ACCEPTING_TASKS|APP_QUITTING|BOT_NOT_FOUND|RUN_NOT_FOUND|POLICY_RESTRICTED|GRANT_REVOKED|GRANT_EXPIRED|AUTH_REQUIRED|AUTH_EXPIRED|AUTH_MODE_MISMATCH|CONNECTION_INCOMPATIBLE|CONNECTION_REVOKED|ASSET_ACCESS_DENIED|RULE_CONFLICT)\b/;
 return definite.test(message)?'rejected':'uncertain';
}
export class CommandRetries<T> {
 private readonly pending=new Map<string,T>();
 getOrCreate(key:string,create:()=>T):T {if(!this.pending.has(key))this.pending.set(key,create());return this.pending.get(key)!;}
 clear(key:string):void {this.pending.delete(key);}
 fail(key:string,error:unknown):CommandFailure {const outcome=commandFailure(error);if(outcome==='rejected')this.clear(key);return outcome;}
}
