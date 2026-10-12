import {test,expect} from '@playwright/test';import {launchPackaged} from '../electron-security/helpers.js';
test('Mac close view and settings reuse retain one Core',async({},testInfo)=>{
 test.skip(process.platform!=='darwin','Requires real packaged macOS App');
 const {app,page,cleanup}=await launchPackaged();
 const child=app.process();let probeOutput='';let lifecycle:unknown;
 const collect=(chunk:Buffer)=>{probeOutput=(probeOutput+chunk.toString()).slice(-16000);};
 child.stdout?.on('data',collect);
 const alive=(pid:number|undefined)=>{if(!pid)return false;try{process.kill(pid,0);return true;}catch{return false;}};
 let corePid:number|undefined;
 try {
  await expect(page.getByTestId('core-status')).toContainText('SQLite');
  const first=await page.evaluate(()=>(window as any).an.snapshot());
  expect(first.available).toBe(true);
  corePid=await app.evaluate(({app})=>app.getAppMetrics().find(metric=>metric.name==='AN Core')?.pid);
  expect(corePid).toBeDefined();
  // Keep the inspector operation installed before the last Chromium window disappears.
  // This creates no keepalive view; reopening uses only the product's activate handler.
  lifecycle=await app.evaluate(async({app,BrowserWindow})=>{
   const initial=BrowserWindow.getAllWindows();if(initial.length!==1)throw Error('Expected one initial product view');
   // The probe must not supply the listener that prevents Electron's default quit.
   if(app.listenerCount('window-all-closed')===0)throw Error('Product has no zero-window lifecycle handler');
   const coreBefore=app.getAppMetrics().filter(metric=>metric.name==='AN Core').map(metric=>metric.pid);
   return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Zero-window/product activation probe timed out')),15000);
    const fail=(error:unknown)=>{clearTimeout(timeout);reject(error);};
    initial[0]!.once('closed',()=>{
     // Observe a genuine zero-window interval after native close completion.
     setTimeout(()=>{
      try {
       const zero={windows:BrowserWindow.getAllWindows().length,mainPid:process.pid,corePids:app.getAppMetrics().filter(metric=>metric.name==='AN Core').map(metric=>metric.pid)};
       console.log('AN_ZERO_WINDOW_PROBE '+JSON.stringify({stage:'zero',...zero}));
       if(zero.windows!==0||coreBefore.length!==1||zero.corePids.length!==1||zero.corePids[0]!==coreBefore[0])throw Error('Closing the view changed the authoritative Core or retained a window');
       process.kill(zero.corePids[0]!,0);
       app.once('browser-window-created',(_event,reopened)=>{
        reopened.webContents.once('did-finish-load',()=>{
         const restored={windows:BrowserWindow.getAllWindows().length,corePids:app.getAppMetrics().filter(metric=>metric.name==='AN Core').map(metric=>metric.pid),url:reopened.webContents.getURL()};
         console.log('AN_ZERO_WINDOW_PROBE '+JSON.stringify({stage:'restored',...restored}));
         clearTimeout(timeout);resolve({zero,restored});
        });
       });
       app.emit('activate');
      } catch(error){fail(error);}
     },100);
    });
    initial[0]!.close();
   });
  });
  expect(lifecycle).toMatchObject({zero:{windows:0,mainPid:child.pid,corePids:[corePid]},restored:{windows:1,corePids:[corePid]}});
  expect(alive(child.pid)).toBe(true);expect(alive(corePid)).toBe(true);
  const reopened=await app.firstWindow();
  await expect(reopened.getByTestId('core-status')).toContainText('SQLite');
  const restored=await reopened.evaluate(()=>(window as any).an.snapshot());
  expect(restored.epoch).toBe(first.epoch);expect(restored.bots).toEqual(first.bots);expect(restored.tasks).toEqual(first.tasks);
  const second=app.waitForEvent('window');
  await reopened.getByRole('button',{name:'设置与上下文'}).click();const settings=await second;
  await settings.getByText('真实登录未启用').waitFor();await settings.close();
  expect((await reopened.evaluate(()=>(window as any).an.snapshot())).epoch).toBe(first.epoch);
  expect(await app.evaluate(({app})=>app.getAppMetrics().filter(metric=>metric.name==='AN Core').map(metric=>metric.pid))).toEqual([corePid]);
 } catch(error){
  throw Error(`Mac close/reopen boundary failed: ${String(error)}; Main alive=${alive(child.pid)}; Core alive=${alive(corePid)}; exitCode=${child.exitCode}; signal=${child.signalCode}; probe=${JSON.stringify(lifecycle)}; stdout=${probeOutput}`);
 } finally {
  child.stdout?.off('data',collect);
  await testInfo.attach('zero-window-boundary.json',{body:JSON.stringify({lifecycle,mainAlive:alive(child.pid),coreAlive:alive(corePid),exitCode:child.exitCode,signal:child.signalCode,probeOutput}),contentType:'application/json'});
  await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});cleanup();
 }
});
test('Mac native menu retains close and quit as distinct actions',async()=>{test.skip(process.platform!=='darwin','Requires real packaged macOS App');const {app,cleanup}=await launchPackaged();try{const items=await app.evaluate(({Menu})=>{const menu=Menu.getApplicationMenu();return menu?.items.flatMap(item=>item.submenu?.items.map(child=>({label:child.label,role:child.role,accelerator:child.accelerator}))??[])??[];});expect(items.some(item=>item.role==='close' && item.accelerator==='CmdOrCtrl+W')).toBe(true);expect(items.some(item=>item.label==='退出 Agent Nexus' && item.accelerator==='CmdOrCtrl+Q')).toBe(true);expect(items.some(item=>item.label==='设置…' && item.accelerator==='CmdOrCtrl+,')).toBe(true);}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});cleanup();}});
test('Mac second packaged instance exits without starting another Core',async()=>{test.skip(process.platform!=='darwin','Requires real packaged macOS App');const {app,page,cleanup}=await launchPackaged();try{await expect(page.getByTestId('core-status')).toContainText('SQLite');const before=await page.evaluate(()=>(window as any).an.snapshot());const location=await app.evaluate(({app})=>({executable:process.execPath,data:app.getPath('userData')}));const {spawn}=await import('node:child_process');const second=spawn(location.executable,[],{env:{...process.env,AN_APP_USER_DATA:location.data},stdio:'ignore'});const result=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>{second.kill();reject(Error('Second app did not honor single-instance lock'));},10000);second.on('error',error=>{clearTimeout(timer);reject(error);});second.on('exit',code=>{clearTimeout(timer);resolve(code);});});expect(result).toBe(0);expect((await page.evaluate(()=>(window as any).an.snapshot())).epoch).toBe(before.epoch);expect((await app.evaluate(({app})=>app.getAppMetrics())).filter(metric=>metric.name==='AN Core').length).toBe(1);}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});cleanup();}});
