import assert from 'node:assert/strict';
import { exportRecords } from '../src/export-records.mjs';
const records = Object.freeze([3, 1, 2]);
assert.deepEqual(exportRecords(records, 2), [3, 1]);
assert.notEqual(exportRecords(records), records);
assert.deepEqual(exportRecords([], 1), []);
assert.throws(() => exportRecords(null), TypeError);
for (const maximum of [0, -1, 10001, 1.5, NaN, Infinity, '2', null]) {
  assert.throws(() => exportRecords([], maximum), RangeError);
}
for (const maximum of [1, 10000, undefined]) assert.deepEqual(exportRecords([1], maximum), [1]);
