import {expect,test} from 'vitest';
import {IsolatedVerifierExecutor,NodeVerificationService} from '../../apps/verification-worker/src/isolated-executor.js';
// Regression: every formerly accepted Node observation path is now blocked BEFORE
// its channel/controller can run. The old response-binding tests cannot establish
// trust in a candidate-owned stdout; their adversarial scenarios remain covered.
for(const scenario of ['missing-authorization','wrong-generation','apparently-valid','unknown-process-tree','replayed-operation','correctly-shaped-forged-observations'])test(`legacy_Node_path_blocks_${scenario}_before_effect`,async()=>{
 let effects=0;const channel={async verifyCandidate(){effects++;throw new Error('UNREACHABLE');}};
 const executor=new IsolatedVerifierExecutor({platform:{os:'linux',arch:'x64'},capabilities:[],channel} as any);
 await expect(executor.execute({} as any)).rejects.toThrow('BLOCKED_PROTECTED_INVOCATION_REQUIRED');
 const service=new NodeVerificationService({controller:{async runVerificationProbe(){effects++;throw new Error('UNREACHABLE');}}} as any);
 await expect(service.verifyCandidate({scenario})).rejects.toThrow('BLOCKED_PROTECTED_INVOCATION_REQUIRED');
 expect(effects).toBe(0);
});
