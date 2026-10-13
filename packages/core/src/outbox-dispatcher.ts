import type { CoreStore } from './store.js';
import type { AsyncRunnerTransport, AsyncExecutionServices, RunnerReceipt } from '../../execution/src/contracts.js';
import { assertRunnerReceipt } from '../../execution/src/runner-client.js';

/** Network awaits are outside Core transactions. The final send has a synchronous authorization boundary. */
export class OutboxDispatcher {
 constructor(private readonly core: CoreStore, private readonly runner: AsyncRunnerTransport, private readonly services: Pick<AsyncExecutionServices,'authorizeNow'|'preflight'>) {}
 async flush(limit=100): Promise<RunnerReceipt[]> {
  const receipts:RunnerReceipt[]=[];
  for (const command of this.core.pendingCommands(limit)) {
   this.core.assertAsyncCommand(command);
   const prior=await this.runner.query(command.commandId);
   this.core.assertAsyncCommand(command);
   if(prior){assertRunnerReceipt(command,prior);this.core.acceptAsyncReceipt(command,prior);receipts.push(prior);continue;}
   if(this.core.suppressStoppedCommand(command))continue;
   if(command.type==='run.start'||command.type==='message.send'){
    if(this.services.preflight)await this.services.preflight(command);
    // Cancellation/epoch changes during either await must win over this stale start.
    this.core.assertAsyncCommand(command);
    if(this.core.suppressStoppedCommand(command))continue;
    const result:unknown=this.services.authorizeNow(command);
    if(result && typeof result==='object' && 'then' in result)throw new Error('ASYNC_AUTHORIZATION_FORBIDDEN');
    this.core.assertAsyncCommand(command,true);
    if(this.core.suppressStoppedCommand(command))continue;
   }
   const receipt=await this.runner.receive(command);
   assertRunnerReceipt(command,receipt);
   this.core.acceptAsyncReceipt(command,receipt);receipts.push(receipt);
  }
  return receipts;
 }
}
