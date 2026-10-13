import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {AssertionResult} from '../../../packages/contracts/src/evidence.js';
/** Reads only rehashed immutable snapshots. This is structural deliverable evidence,
 * not a claim that arbitrary project tests were executed or that changed text has
 * adequate coverage; the independent behavior oracle owns runtime assertions. */
export function projectDeliverables(candidate:string,stage:'A'|'B',prior?:string):AssertionResult[]{
 const read=(root:string|undefined,path:string):string|null=>{try{return root?readFileSync(join(root,path),'utf8'):null;}catch{return null;}};
 const source=read(candidate,'src/export-records.mjs');const tests=read(candidate,'test/export-records.test.mjs');const log=read(candidate,'CHANGELOG.md');
 const result:AssertionResult[]=[{id:'required-project-files',status:[source,tests,log].every(s=>s!==null&&s.trim().length>0)?'PASS':'FAIL'}];
 if(stage==='B'){
  const oldTests=read(prior,'test/export-records.test.mjs');const oldLog=read(prior,'CHANGELOG.md');
  result.push({id:'boundary-tests-added',status:tests!==null&&oldTests!==null&&tests.trim().length>0&&tests!==oldTests?'PASS':'FAIL'});
  result.push({id:'changelog-appended',status:log!==null&&oldLog!==null&&log.startsWith(oldLog)&&log.slice(oldLog.length).trim().length>0?'PASS':'FAIL'});
 }
 return result;
}
