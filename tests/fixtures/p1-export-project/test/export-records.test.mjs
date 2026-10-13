import assert from 'node:assert/strict';
import { exportRecords } from '../src/export-records.mjs';
assert.deepEqual(exportRecords([1, 2, 3], 2), [1, 2]);
