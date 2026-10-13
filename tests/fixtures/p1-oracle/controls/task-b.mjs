export function exportRecords(records, maxRecords = 1000) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 10000) throw new RangeError('invalid maximum');
  return records.slice(0, maxRecords);
}
