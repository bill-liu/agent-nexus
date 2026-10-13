import { CoreStore } from './store.js';
import { RunnerClient } from '../../execution/src/runner-client.js';
import type { AsyncExecutionServices, AsyncRunnerTransport, TrustedNodeVerifier } from '../../execution/src/contracts.js';

/** Minimal privileged assembly. No implicit credentials, providers, CLI or fake readiness. */
export class AsyncApplication {
 private readonly runner: RunnerClient;
 constructor(readonly core: CoreStore, transport: AsyncRunnerTransport, private readonly services: AsyncExecutionServices, private readonly nodeVerifier: TrustedNodeVerifier) {this.runner=new RunnerClient(transport);}
 dispatch(botId: string) {return this.core.dispatchAsync(botId,this.services);}
 flush(limit=100) {return this.core.flushOutboxAsync(this.runner,this.services,limit);}
 observeStop(runId: string,evidenceRef: string) {return this.core.observeTrustedStop(runId,evidenceRef,this.nodeVerifier);}
}
