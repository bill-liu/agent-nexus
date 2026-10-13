export function exportRecords(records, maxRecords = 1000) {
  return records.slice(0, maxRecords);
}
