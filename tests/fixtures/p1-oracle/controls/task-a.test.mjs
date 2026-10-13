import assert from 'node:assert/strict';
import { exportRecords } from '../src/export-records.mjs';
const records = Object.freeze([3, 1, 2]);
assert.deepEqual(exportRecords(records, 2), [3, 1]);
assert.notEqual(exportRecords(records), records);
assert.deepEqual(exportRecords([], 1), []);
