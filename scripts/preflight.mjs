import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { platform, arch, release } from 'node:os';
const pkg = JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const {values} = parseArgs({options:{profile:{type:'string',default:'base'},'connection-id':{type:'string'},'require-macos':{type:'boolean'}}});
if (!['base','runtime-auth'].includes(values.profile)) throw new Error('UNKNOWN_PREFLIGHT_PROFILE');
if (values.profile === 'runtime-auth') {
  console.log(JSON.stringify({status:'BLOCKED',phase:'P1',reason:'Named Connection authorization, runtime/license preflight and Mac validation target require parent confirmation. No login or model call performed.'},null,2));
  process.exitCode=2;
} else {
  const db = new DatabaseSync(':memory:');
  const sqlite = db.prepare('select sqlite_version() as version').get().version;
  db.close();
  console.log(JSON.stringify({phase:'P0',host:{platform:platform(),arch:arch(),release:release(),node:process.version},sqlite,
    dependencies:pkg.devDependencies,macPackage:platform()==='darwin'?'AVAILABLE_FOR_TEST':'BLOCKED_MAC_REQUIRED',
    manualMac:'NOT_RUN: IME, VoiceOver, multi-display and sleep require an approved interactive Mac',
    runtime:'fake-only; no authentication or model requests',p1:'BLOCKED_PENDING_MAC_AND_NAMED_CONNECTION'},null,2));
  if(values['require-macos'] && platform()!=='darwin') process.exitCode=2;
}
