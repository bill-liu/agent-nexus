import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
describe('P1 preflight is a real blocking boundary, not a success-looking report', () => {
  for (const args of [['--profile','runtime-auth'],['--profile=runtime-auth']]) {
    it(`refuses real runtime entry via ${args.join(' ')}`, () => {
      const result=spawnSync(process.execPath,['scripts/preflight.mjs',...args],{encoding:'utf8'});
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({status:'BLOCKED',phase:'P1'});
    });
  }
  it('rejects misspelled/unknown profiles instead of green base checks', () => {
    const result=spawnSync(process.execPath,['scripts/preflight.mjs','--profile=runtime-aut'],{encoding:'utf8'});
    expect(result.status).not.toBe(0);
  });
});
