import type {DatabaseSync} from 'node:sqlite';
import type {Duplex} from 'node:stream';
import type {NativeDriverTransport,CoreApprovalPort} from '../../../packages/contracts/src/runtime-driver.js';
import type {ExecutionBinding} from '../../../packages/execution/src/contracts.js';
import {assertExecutionBinding} from '../../../packages/execution/src/runner-client.js';
import {canonicalJson} from '../../../packages/persistence/src/unit-of-work.js';
import {GuestRuntimeRegistry} from '../../runner/src/processes.js';
import {serveNodeChannel} from './channel.js';
/** Fixed initialize-only endpoint. Reuses the real Runner registry and Codex protocol adapter.
 * No task/model/login/approval/raw-native capability and no fabricated cgroup/BPF attestation.
 * Native EOF or group signals cannot prove all descendants stopped; Core must isolate the owning container. */
export function servePodmanAccountless(options:{stream:Duplex;key:Buffer;binding:ExecutionBinding;db:DatabaseSync;assertCurrent():void;openNative(binding:ExecutionBinding):Promise<NativeDriverTransport>}){
 assertExecutionBinding(options.binding);const frozen=Object.freeze(structuredClone(options.binding));
 const authorize=(b:ExecutionBinding)=>{const result:unknown=options.assertCurrent();if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});throw Error('INVALID_AUTHORITY_CHECK');}if(canonicalJson(b)!==canonicalJson(frozen))throw Error('STALE_EXECUTION_BINDING');};authorize(frozen);
 const denied=()=>{throw Error('ACCOUNTLESS_ONLY');};
 const approvalPort:CoreApprovalPort={receive:async()=>denied(),respond:async()=>denied(),replay:async()=>denied(),resolved:async()=>denied(),interruptTurn:async()=>denied(),get:async()=>denied(),cancel:async()=>denied()};
 const registry=new GuestRuntimeRegistry({db:options.db,openNative:options.openNative,driverAuthorizeNow:authorize,commandAuthorizeNow:denied,approvalPortFor:()=>approvalPort});
 const endpoint=serveNodeChannel(options.stream,options.key,{nodeId:frozen.nodeId,sandboxId:frozen.sandboxId,generation:frozen.generation,transportInstanceId:frozen.transportInstanceId},{receive:async()=>denied(),query:async()=>null},{observeStop:async()=>null},undefined,undefined,undefined,undefined,undefined,{
  initializeEnvironment:async b=>{authorize(b);await registry.driver.initialize({binding:b,runtimeVersion:'0.159.2'});authorize(b);},
  attestRuntime:async()=>denied(),finishNative:async()=>null,stopNative:async()=>null,
 });
 return ()=>{endpoint();registry.stopScheduling();};
}
