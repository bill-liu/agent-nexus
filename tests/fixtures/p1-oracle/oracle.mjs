// Revision 2: worker additionally verifies mandatory snapshot deliverables and A continuation.
// Trusted fixed synthetic control oracle. Live executor must isolate candidate code
// from this assertion process and its report channel; importing untrusted live code
// into this process is forbidden. This subprocess harness is synthetic-only.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const [entry, stage] = process.argv.slice(2);
const results = [];
try {
  const { exportRecords } = await import(pathToFileURL(entry).href);
  const check = (id, body) => {
    try { body(); results.push({ id, status: 'PASS' }); }
    catch { results.push({ id, status: 'FAIL' }); }
  };
  check('ordered-limit', () => assert.deepEqual(exportRecords([3, 1, 2], 2), [3, 1]));
  check('short-input', () => assert.deepEqual(exportRecords([3], 10), [3]));
  check('fresh-empty', () => { const a = []; const b = exportRecords(a); assert.deepEqual(b, []); assert.notEqual(a, b); });
  check('fresh-nonmutating', () => { const a = Object.freeze([3, 1, 2]); const b = exportRecords(a, 3); assert.deepEqual(b, a); assert.notEqual(a, b); });
  check('default-1000', () => { const a = Array.from({ length: 1002 }, (_, i) => i); assert.deepEqual(exportRecords(a), a.slice(0, 1000)); assert.deepEqual(exportRecords(a, undefined), a.slice(0, 1000)); });
  check('valid-boundaries', () => { const a = Array.from({ length: 10001 }, (_, i) => i); for (const n of [1, 10000]) assert.deepEqual(exportRecords(a, n), a.slice(0, n)); });
  if (stage === 'B') {
    check('invalid-records', () => { for (const a of [null, undefined, {}, 'abc', 1, true]) assert.throws(() => exportRecords(a), TypeError); });
    check('invalid-limits', () => { for (const n of [0, -1, 10001, 1.2, NaN, Infinity, '2', null]) assert.throws(() => exportRecords([], n), RangeError); });
  } else assert.equal(stage, 'A');
} catch { results.push({ id: 'oracle-execution', status: 'FAIL' }); }
process.stdout.write(JSON.stringify(results));
process.exitCode = results.every(x => x.status === 'PASS') ? 0 : 1;
