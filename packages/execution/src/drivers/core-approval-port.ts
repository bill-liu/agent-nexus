import {canonicalDigest,type ApprovalService} from '../../../core/src/approvals.js';
import type {CoreApprovalPort} from '../../../contracts/src/runtime-driver.js';
import {CodexApprovalAdapter,type CodexApprovalAdapterOptions} from '../approval-adapter.js';
/** Construct only inside the authoritative Core. A remote Runner receives an authenticated typed proxy. */
export function createCoreApprovalPort(service:ApprovalService,options:CodexApprovalAdapterOptions):CoreApprovalPort {
 const adapter=new CodexApprovalAdapter(service,options);
 const scoped=(input:Parameters<CoreApprovalPort['get']>[0])=>{const record=service.get(input.id);if(canonicalDigest(record.binding)!==canonicalDigest(input.binding))throw Error('APPROVAL_BINDING_MISMATCH');return record;};
 return {receive:async input=>adapter.receive(input),respond:async input=>adapter.respond(input),replay:async input=>adapter.replay(input),resolved:async input=>adapter.resolved(input),interruptTurn:async binding=>adapter.interruptTurn(binding),get:async input=>scoped(input),cancel:async input=>{scoped(input);return service.cancel(input.id);}};
}
