// Separate, explicitly installed guest service; never launched by the desktop or CI.
import {createRequire} from 'node:module';
if(process.argv.length!==4||process.argv[2]!=='--apply'||process.platform!=='linux')throw Error('BLOCKED_EXPLICIT_GUEST_INSTALLATION_REQUIRED');
const require=createRequire(import.meta.url);
const {startP1Guest}=require('../build/guest-node.cjs');
const service=startP1Guest(process.argv[3]);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void service.close().then(()=>process.exit(0),()=>process.exit(2));});
