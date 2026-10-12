import { mkdtempSync, realpathSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect,it } from 'vitest';
import { validateSelectedFile, previewDocument, parseDeepLink } from '../../apps/desktop/main/files.js';
import { QuitCoordinator } from '../../apps/desktop/main/quit-coordinator.js';
it('file authority rejects a symlink and previews hostile markup as text',async()=>{const root=realpathSync(mkdtempSync(join(tmpdir(),'an-file-')));try{writeFileSync(join(root,'note.html'),'<script>window.an.createBot({})</script><img src="https://tracker.test">');symlinkSync(join(root,'note.html'),join(root,'link'));await expect(validateSelectedFile(join(root,'link'))).rejects.toThrow();const selected=await validateSelectedFile(join(root,'note.html'));expect(previewDocument(selected.text)).toContain('&lt;script&gt;');expect(previewDocument(selected.text)).toContain("default-src 'none'");}finally{rmSync(root,{recursive:true,force:true});}});
it('deep links navigate only allowlisted objects and never mutate',()=>{expect(parseDeepLink('agent-nexus://bot/bot-1')).toEqual({botId:'bot-1'});expect(()=>parseDeepLink('agent-nexus://bot/bot-1?command=cancel')).toThrow();expect(()=>parseDeepLink('https://evil.test')).toThrow();});
it('quit stops admissions before offering cancel and save',async()=>{const order:string[]=[];const q=new QuitCoordinator({stopAdmissions:async()=>{order.push('stop');},resumeAdmissions:async()=>{order.push('resume');},saveAndStop:async()=>{order.push('save');return ['run-unknown'];}});await q.begin();expect(order).toEqual(['stop']);await q.cancel();expect(order).toEqual(['stop','resume']);await q.begin();expect(await q.save()).toEqual(['run-unknown']);expect(order).toEqual(['stop','resume','stop','save']);});

it('rejects an ancestor symlink while permitting the canonical fixture file',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'an-ancestor-')));
 try {
  writeFileSync(join(root,'note.txt'),'本机资料');
  symlinkSync(root,join(root,'alias'));
  await expect(validateSelectedFile(join(root,'alias','note.txt'))).rejects.toThrow('SYMLINK_PATH');
  expect((await validateSelectedFile(join(root,'note.txt'))).text).toBe('本机资料');
 } finally {rmSync(root,{recursive:true,force:true});}
});
