import {test,expect} from '@playwright/test';
import {launchPackaged} from '../electron-security/helpers.js';
test('packaged P1 preparation keeps durable queue and separate readiness across renderer reload',async()=>{
 test.skip(process.platform!=='darwin','Actual packaged macOS App required; no VM/login/model implied');
 const {app,page,cleanup}=await launchPackaged('p1-preparation');
 try{
  await page.getByLabel('Bot 名称').fill('P1 准备 Bot');await page.getByRole('button',{name:'创建准备 Bot'}).click();
  await page.getByLabel('交新工作').fill('合成准备任务');await page.getByRole('button',{name:'提交到队列'}).click();
  await expect(page.getByText('合成准备任务',{exact:true})).toBeVisible();
  const before=await page.evaluate(()=>window.an.snapshot());expect(before.connections).toEqual([]);expect(before.runs).toEqual([]);expect(before.environments?.[0].liveReady).toBe(false);
  await page.getByRole('tab',{name:'环境',exact:true}).click();await expect(page.getByText('等待准备：PROVISION_AUTHORIZATION_REQUIRED')).toBeVisible();await expect(page.getByRole('button',{name:'无账号初始化',exact:true})).toBeDisabled();
  await page.getByText('Podman 准备计划与授权范围',{exact:true}).click();await expect(page.getByText('授权状态：missing · 操作状态：blocked')).toBeVisible();await expect(page.getByText(/没有开始下载/)).toBeVisible();const cancelDenied=await page.evaluate(async input=>{try{await window.an.cancelEnvironment(input);return 'UNEXPECTED_ALLOW';}catch(error){return error instanceof Error?error.message:'DENIED';}},{commandId:'unadmitted-cancel',botId:before.bots[0].id,expectedVersion:before.bots[0].version});expect(cancelDenied).toContain('PODMAN_ADMISSION_REQUIRED');
  const initializeDenied=await page.evaluate(async input=>{try{await window.an.prepareEnvironment(input);return 'UNEXPECTED_ALLOW';}catch(error){return error instanceof Error?error.message:'DENIED';}},{commandId:'unadmitted-initialize',botId:before.bots[0].id,expectedVersion:before.bots[0].version});expect(initializeDenied).toContain('ENVIRONMENT_ADMISSION_REQUIRED');expect((await page.evaluate(()=>window.an.snapshot())).runs).toEqual([]);
  await page.reload();const after=await page.evaluate(()=>window.an.snapshot());expect(after.tasks).toEqual(before.tasks);expect(after.environments?.[0].operationId).toBe(before.environments?.[0].operationId);expect(after.bots).toEqual(before.bots);
  const opened=app.waitForEvent('window');await page.getByRole('button',{name:'设置与上下文'}).click();const settings=await opened;await settings.waitForLoadState();
  const denied=await settings.evaluate(async()=>{try{await window.an.createBot({commandId:'readonly-create',scope:{botId:'readonly'},expectedVersion:0,name:'denied'});return false;}catch{return true;}});expect(denied).toBe(true);
 }finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});cleanup();}
});
