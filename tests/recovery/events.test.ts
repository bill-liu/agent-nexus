import { prepareFake, authorizeFake } from './fixtures.js';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreStore } from '../../packages/core/src/store.js';

let dir:string; let core:CoreStore;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'an-events-'));core=new CoreStore(join(dir,'core.db'));core.createBot({commandId:'create',botId:'bot',name:'Bot',subject:'user'});core.submit({commandId:'task',botId:'bot',taskId:'task',text:'task',expectedVersion:1,subject:'user'});});
afterEach(()=>{core.close();rmSync(dir,{recursive:true,force:true});});

test('snapshot cursor reflects exactly its atomic read watermark and bounded event replay generates no commands',()=>{
 const snapshot=core.snapshot(); core.setPaused({commandId:'pause',botId:'bot',paused:true,expectedVersion:1,subject:'user'});
 expect(snapshot.bots[0]?.dispatchPaused).toBe(false);
 const page=core.readEvents(snapshot.cursor,1);expect(page.events).toHaveLength(1);expect(page.events[0]?.type).toBe('bot.dispatch-paused');
 expect(core.readEvents(page.cursor,1).events).toHaveLength(0);
 expect(()=>core.readEvents(0,1001)).toThrow('INVALID_EVENT_LIMIT');expect(core.snapshot().runs).toHaveLength(0);
});

test('out-of-order and duplicate run events survive reopen and only apply contiguous causality',()=>{
 const run=core.dispatch('bot',prepareFake)!;
 const exit={runId:run.id,fencingToken:run.fencingToken,sequence:2,type:'run.exited',payload:{evidence:{kind:'process-exit',exitCode:0,source:'fake-runner'}}};
 expect(core.ingestRunEvent(exit).contiguousSequence).toBe(0);expect(core.snapshot().runs[0]?.slotHeld).toBe(true);
 core.close();core=new CoreStore(join(dir,'core.db'));
 expect(core.ingestRunEvent(exit).duplicate).toBe(true);
 core.ingestRunEvent({runId:run.id,fencingToken:run.fencingToken,sequence:1,type:'run.started',payload:{}});
 expect(core.snapshot().runs[0]?.slotHeld).toBe(false);expect(core.snapshot().tasks[0]?.status).toBe('VERIFYING');
 expect(()=>core.ingestRunEvent({...exit,payload:{changed:true}})).toThrow('EVENT_CONFLICT');
});
