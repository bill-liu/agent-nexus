import {expect,test} from 'vitest';
import {compileCandidate,MacProtectedVerifierExecutor} from '../../apps/verification-worker/src/macos-executor.js';
import {readFileSync} from 'node:fs';
// No candidate evaluated in Node. Native invocation/forgery regressions live in
// native/macos-verifier/canary.mjs and are actual macOS CI checks, not OS mocks.
test('compilation_is_only_text_transformation_not_host_evaluation',()=>{
 const code=compileCandidate("throw new Error('MUST_NOT_EXECUTE_IN_NODE');export function exportRecords(){return []}");
 expect(code).toContain('MUST_NOT_EXECUTE_IN_NODE');expect(code).toContain('module.exports.exportRecords');
});
test('forged_observation_control_remains_always_wrong_and_uses_old_stdout_attack',()=>{
 const code=readFileSync('tests/fixtures/p1-oracle/controls/forged-observation.mjs','utf8');
 expect(code).toContain("export function exportRecords() { return 'WRONG'; }");expect(code).toContain('process.stdout.write');expect(code).toContain('process.exit(0)');
 expect(()=>compileCandidate(code)).not.toThrow();
});
test('native_evaluator_has_no_JS_host_bridge_registration',()=>{
 const code=readFileSync('native/macos-verifier/main.m','utf8');
 expect(code).toContain('JSObjectCallAsFunction');expect(code).toContain('JSValueIsStrictEqual');expect(code).toContain('JSValueIsArray');
 expect(code).not.toContain('JSObjectMakeFunctionWithCallback');expect(code).not.toContain('JSClassCreate');expect(code).not.toContain('JSValueCreateJSONString');
});
test('protected_executor_failsclosed_beforeeffects_on_unsupported_platform_or_authorization',async()=>{
 let calls=0;const executor=new MacProtectedVerifierExecutor({binaryPath:'/does-not-exist',binaryDigest:'0'.repeat(64),trustedRoot:'/does-not-exist',oracleDigest:'a'.repeat(64),authorization:{targetId:'sandbox',expiresAt:0,actions:[]},binding:{sandboxId:'sandbox'} as any,assertCurrent:()=>{calls++;}});
 await expect(executor.execute({candidateDigest:'a'.repeat(64)} as any)).rejects.toThrow(process.platform==='darwin'?'VERIFIER_AUTHORIZATION_REQUIRED':'BLOCKED_MACOS_PROTECTED_VERIFIER_REQUIRED');expect(calls).toBe(0);
});
