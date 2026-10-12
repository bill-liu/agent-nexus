import {test,expect} from '@playwright/test';
import {launchPackaged} from './helpers.js';
import {join} from 'node:path';
test('packaged renderer is sandboxed and worker proves SQLite readiness',async()=>{const {app,page,cleanup}=await launchPackaged();try{expect(await app.evaluate(({app})=>app.commandLine.hasSwitch('no-sandbox'))).toBe(false);expect(await page.evaluate(()=>({node:typeof (window as any).require,process:typeof (window as any).process,keys:Object.keys((window as any).an)}))).toMatchObject({node:'undefined',process:'undefined'});const keys=await page.evaluate(()=>Object.keys((window as any).an));expect(keys).not.toContain('invoke');expect(keys).not.toContain('sql');expect(keys).not.toContain('shell');const prefs=await app.evaluate(({BrowserWindow})=>(BrowserWindow.getAllWindows()[0]!.webContents as any).getLastWebPreferences());expect(prefs).toMatchObject({nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true});if(process.platform==='darwin')expect(await app.evaluate(({app,BrowserWindow})=>{const pid=BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId();return app.getAppMetrics().find(metric=>metric.pid===pid)?.sandboxed;})).toBe(true);await expect(page.getByTestId('core-status')).toContainText('SQLite');expect(await page.evaluate(async()=>{try{await (window as any).an.createBot({commandId:'bad',botId:'bad',name:'x',subject:'admin'});return false;}catch{return true;}})).toBe(true);}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});cleanup();}});
test('unregistered packaged window cannot acquire subject authority',async()=>{
 const {app,cleanup}=await launchPackaged();
 try {
  // Electron 44's SaveLastPreferences omits preload; use the actual packaged entry.
  const preload=join(await app.evaluate(({app})=>app.getAppPath()),'build','preload.cjs');
  const result=await app.evaluate(async({BrowserWindow},preload)=>{
   const original=BrowserWindow.getAllWindows()[0]!;
   const attacker=new BrowserWindow({show:false,webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false}});
   try {
    await attacker.loadURL(original.webContents.getURL());
    return await attacker.webContents.executeJavaScript(`(async()=>{
     const bridgePresent=typeof window.an?.snapshot==='function';
     if(!bridgePresent)return {bridgePresent,error:'ATTACKER_PRELOAD_MISSING'};
     try{await window.an.snapshot();return {bridgePresent,error:null};}
     catch(error){return {bridgePresent,error:String(error)};}
    })()`);
   } finally {attacker.destroy();}
  },preload);
  expect(result.bridgePresent).toBe(true);
  expect(result.error).toContain('UNAUTHORIZED_FRAME');
 } finally {await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});cleanup();}
});
test('packaged IPC rejects size, schema, stale versions and external navigation',async()=>{const {app,page,cleanup}=await launchPackaged();try{await expect(page.getByTestId('core-status')).toContainText('SQLite');const results=await page.evaluate(async()=>{const bridge=(window as any).an;const input={commandId:crypto.randomUUID(),scope:{botId:crypto.randomUUID()},expectedVersion:0,name:'边界演示'};await bridge.createBot(input);const bot=(await bridge.snapshot()).bots.find((b:any)=>b.id===input.scope.botId);await bridge.setPaused({commandId:crypto.randomUUID(),scope:input.scope,expectedVersion:bot.version,paused:true});const cases=[{commandId:crypto.randomUUID(),scope:input.scope,expectedVersion:bot.version,paused:false},{commandId:crypto.randomUUID(),scope:{...input.scope,subject:'admin'},expectedVersion:bot.version,paused:false}];const rejected=[];for(const c of cases){try{await bridge.setPaused(c);rejected.push(false);}catch{rejected.push(true);}}try{await bridge.submitWork({commandId:crypto.randomUUID(),scope:input.scope,expectedVersion:bot.version,taskId:'oversize',text:'x'.repeat(40000)});rejected.push(false);}catch{rejected.push(true);}return rejected;});expect(results).toEqual([true,true,true]);const url=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.getURL());
 await app.evaluate(({BrowserWindow})=>{const wc=BrowserWindow.getAllWindows()[0]!.webContents;(globalThis as any).__anDeniedNavigation=null;wc.once('will-frame-navigate',event=>{(globalThis as any).__anDeniedNavigation={attempted:event.url,blocked:event.defaultPrevented};});});
 await page.evaluate(()=>{location.href='https://example.com/';});
 await expect.poll(()=>app.evaluate(()=>(globalThis as any).__anDeniedNavigation)).toEqual({attempted:'https://example.com/',blocked:true});
 // Electron is authoritative when a denied provisional navigation confuses CDP's URL cache.
 const actual=await app.evaluate(async({BrowserWindow})=>{const wc=BrowserWindow.getAllWindows()[0]!.webContents;return {url:wc.getURL(),document:await wc.executeJavaScript('location.href')};});
 expect(actual).toEqual({url,document:url});}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});cleanup();}});
test('registered read-only settings view cannot write Bot state',async()=>{const {app,page,cleanup}=await launchPackaged();try{const opened=app.waitForEvent('window');await page.getByRole('button',{name:'设置与上下文'}).click();const settings=await opened;await settings.getByText('真实登录未启用').waitFor();expect(await settings.evaluate(async()=>{try{await (window as any).an.createBot({commandId:'settings-write',scope:{botId:'settings-bot'},expectedVersion:0,name:'不应创建'});return false;}catch{return true;}})).toBe(true);expect((await page.evaluate(()=>(window as any).an.snapshot())).bots.length).toBe(0);}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});cleanup();}});
