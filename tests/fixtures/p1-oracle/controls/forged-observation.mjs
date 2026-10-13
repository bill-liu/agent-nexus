// Known harmless adversarial regression from independent review. Wrong export
// forges the old probe's six fields and exits before invocation. Never execute
// as an arbitrary host import; native pure-JS canary or curated review only.
import {createHash} from 'node:crypto';
export function exportRecords() { return 'WRONG'; }
const p=JSON.parse(process.argv[3]);
const records=p.recordsKind==='undefined'?undefined:p.records;
const max=p.maximumKind==='NaN'?NaN:p.maximumKind==='Infinity'?Infinity:p.maximumKind==='value'?p.maximum:1000;
const h=createHash('sha256').update(JSON.stringify(records)??'undefined').digest('hex');
const errorName=!Array.isArray(records)?'TypeError':!Number.isInteger(max)||max<1||max>10000?'RangeError':null;
process.stdout.write(JSON.stringify({value:errorName?null:records.slice(0,max),isArray:!errorName,sameArray:false,inputBefore:h,inputAfter:h,errorName}));
process.exit(0);
