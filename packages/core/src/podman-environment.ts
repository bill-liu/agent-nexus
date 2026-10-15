import {randomBytes} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ExecutionBinding} from '../../execution/src/contracts.js';
import {assertExecutionBinding} from '../../execution/src/runner-client.js';
import {PodmanProvider,type PodmanCLI,type PodmanTarget} from '../../execution/src/providers/podman.js';
import {createPodmanJournal} from './podman-journal.js';
import {NodeRunnerChannel} from '../../../apps/node-agent/src/channel.js';
/** Trusted accountless composition seam. No Renderer route/admission autodiscovery or model capability.
 * Core's current owner/epoch/Bot version and named action authorization must be rechecked synchronously.
 * A synthetic peer can verify this path, but only a live admitted engine can produce live observations. */
export function createPodmanEnvironmentAdapter(options:{db:DatabaseSync;target:PodmanTarget;cli:PodmanCLI;assertCurrent():void;assertAuthorized(action:string):void;cleanup?:{begin():void;end():void}}){
 const sync=(fn:()=>void)=>{const result:unknown=fn();if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});throw Error('INVALID_AUTHORITY_CHECK');}};
 const current=()=>{sync(options.assertCurrent);const row=options.db.prepare('SELECT record FROM bot_provision WHERE operation_id=?').get(options.target.operationId);const r=row&&JSON.parse(String(row.record));if(!r||r.botId!==options.target.botId||r.sandboxId!==options.target.sandboxId)throw Error('PODMAN_IDENTITY_MISMATCH');};
 const authorize=(action:string)=>{current();sync(()=>options.assertAuthorized(action));};
 const provider=new PodmanProvider(options.target,options.cli,createPodmanJournal(options.db,options.target.operationId,current),authorize);
 return {provider,async initialize(binding:ExecutionBinding){
  assertExecutionBinding(binding);authorize('initialize-runtime');const frozen=Object.freeze(structuredClone(binding));
  const writer=provider.claimWriter(frozen),key=randomBytes(32);let stream:import('node:stream').Duplex|undefined,channel:NodeRunnerChannel|undefined,initialized=false;
  try{
   stream=await provider.openAccountless(frozen,key,writer);authorize('initialize-runtime');
   channel=new NodeRunnerChannel(stream,key,{nodeId:frozen.nodeId,sandboxId:frozen.sandboxId,generation:frozen.generation,transportInstanceId:frozen.transportInstanceId});
   await channel.initializeEnvironment(frozen);authorize('initialize-runtime');initialized=true;
  }finally{
   channel?.close();stream?.destroy();key.fill(0);
   // Always isolate the sole owning Bot container; EOF/native parent exit never releases its writer.
   // A failed stop/authorization leaves the durable writer and intent for explicit reconciliation.
   options.cleanup?.begin();try{await provider.isolateWriter(frozen,writer);}finally{options.cleanup?.end();}
  }
  authorize('initialize-runtime');return {backend:'podman' as const,evidenceKind:options.cli.evidenceKind,initialized,readiness:{environment:true,runner:true,runtime:true,auth:false},liveReady:false as const};
 }};
}
