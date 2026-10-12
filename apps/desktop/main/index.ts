import {app,BrowserWindow,dialog,ipcMain} from 'electron';
import {dirname} from 'node:path';
import {mkdirSync} from 'node:fs';
import {CoreClient} from './bootstrap.js';
import {authorizeFrame,type WindowContext} from './ipc.js';
import {parseCommand} from '../../../packages/contracts/src/commands.js';
import type {Snapshot,DesktopEvent,AssetSelection} from '../../../packages/contracts/src/events.js';
import {createWindow} from './windows.js';
import {installMenu} from './menu.js';
import {validateSelectedFile} from './files.js';
import {PendingNavigation} from './navigation.js';
import {QuitCoordinator} from './quit-coordinator.js';
const navigation=new PendingNavigation();
const buildDirectory=__dirname;const contexts=new Map<number,WindowContext>();let core:CoreClient;let quit:QuitCoordinator;let main:BrowserWindow|undefined;let settings:BrowserWindow|undefined;let finishing=false;
let cached:Omit<Snapshot,'windowId'|'view'|'quitPending'>={cursor:0,epoch:0,bots:[],tasks:[],runs:[],messages:[],available:false,sqliteVersion:'',observedAt:''};
if(process.env.AN_APP_USER_DATA)app.setPath('userData',process.env.AN_APP_USER_DATA);
const broadcast=(event:DesktopEvent)=>{for(const window of BrowserWindow.getAllWindows())if(contexts.has(window.webContents.id))window.webContents.send('an:event',event);};
function workspace(){if(main && !main.isDestroyed()){main.show();main.focus();return main;}main=createWindow(buildDirectory,'workspace',contexts);return main;}
function openSettings(){if(settings && !settings.isDestroyed()){settings.show();settings.focus();return;}settings=createWindow(buildDirectory,'settings',contexts);}
async function resolvePendingNavigation(){if(!navigation.hasPending||!core?.available)return;const state=await core.request('snapshot','local-user') as typeof cached;const target=navigation.take(state.bots,'local-user');if(!target)return;const window=workspace();const context=contexts.get(window.webContents.id);if(context)context.selectedBotId=target.botId;window.webContents.send('an:event',{type:'navigate',botId:target.botId});}
async function requestQuit(){if(finishing)return;try{await quit.begin();broadcast({type:'changed'});workspace();}catch{const decision=await dialog.showMessageBox({type:'warning',message:'Core 不可用，运行结果未知',detail:'退出会保留未知状态；重新打开必须先核验。',buttons:['取消退出','保留未知并退出'],defaultId:0,cancelId:0});if(decision.response===1){finishing=true;app.exit(0);}}}
if(!app.requestSingleInstanceLock()){app.quit();}else{
 app.on('second-instance',()=>{if(app.isReady())workspace();});
 app.on('activate',()=>{if(app.isReady())workspace();});
 app.on('window-all-closed',()=>{/* Closing views never stops the authority. */});
 app.on('before-quit',event=>{if(!finishing){event.preventDefault();void requestQuit();}});
 app.on('open-url',(event,url)=>{event.preventDefault();try{navigation.queue(url);void resolvePendingNavigation().catch(()=>{});}catch{/* No action on malformed or unauthorized links. */}});
 void app.whenReady().then(async()=>{
  mkdirSync(app.getPath('userData'),{recursive:true});core=new CoreClient(buildDirectory,app.getPath('userData'),()=>broadcast({type:'changed'}),()=>broadcast({type:'unavailable'}));
  quit=new QuitCoordinator({stopAdmissions:async()=>{await core.request('admissions','local-user',{accepting:false});},resumeAdmissions:async()=>{await core.request('admissions','local-user',{accepting:true});},saveAndStop:async()=>{const result=await core.request('shutdown','local-user') as {unknownRuns:string[]};await core.exited;return result.unknownRuns;}});
  const contextFor=(event:Electron.IpcMainInvokeEvent,permission:'read'|'write')=>authorizeFrame({webContentsId:event.sender.id,frameRoutingId:event.senderFrame?.routingId??-1,url:event.senderFrame?.url??'',isMainFrame:event.senderFrame===event.sender.mainFrame},contexts.get(event.sender.id),permission);
  ipcMain.handle('an:snapshot',async(event,payload)=>{const ctx=contextFor(event,'read');if(payload!==undefined)throw Error('INVALID_SCHEMA');if(core.available){cached={...await core.request('snapshot',ctx.subject) as typeof cached,available:true,sqliteVersion:core.sqliteVersion,observedAt:new Date().toISOString()};}return {...cached,available:core.available,windowId:ctx.webContentsId,view:ctx.view??'workspace',quitPending:quit.state!=='idle',selectedBotId:ctx.selectedBotId};});
  ipcMain.handle('an:command',async(event,payload)=>{const ctx=contextFor(event,'write');const command=parseCommand(payload);if(quit.state!=='idle')throw Error('APP_QUITTING');return core.request('command',ctx.subject,{command});});
  ipcMain.handle('an:settings',(event,payload)=>{contextFor(event,'read');if(payload!==undefined)throw Error('INVALID_SCHEMA');openSettings();});
  ipcMain.handle('an:select-asset',async(event,payload):Promise<AssetSelection|null>=>{contextFor(event,'read');if(payload!==undefined)throw Error('INVALID_SCHEMA');const selection=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!,{title:'选择非秘密资料 · 仅本机文本预览',properties:['openFile']});if(selection.canceled || !selection.filePaths[0])return null;return validateSelectedFile(selection.filePaths[0]);});
  ipcMain.handle('an:quit',async(event,payload)=>{contextFor(event,'write');if(payload==='begin'){await requestQuit();return{unknownRuns:[]};}if(payload==='cancel'){await quit.cancel();broadcast({type:'changed'});return{unknownRuns:[]};}if(payload==='save'){const active=cached.runs.filter(run=>run.slotHeld);if(active.length){const result=await dialog.showMessageBox({type:'warning',message:'仍有执行未确认停止',detail:`${active.length} 个运行将保留结果未知；不会宣称已停止。`,buttons:['返回核验','保留未知并退出'],defaultId:0,cancelId:0});if(result.response===0)return{unknownRuns:active.map(run=>run.id)};}const unknownRuns=await quit.save();finishing=true;setImmediate(()=>app.quit());return{unknownRuns};}throw Error('INVALID_SCHEMA');});
  installMenu(openSettings,()=>void requestQuit());workspace();try{await core.ready;await resolvePendingNavigation();broadcast({type:'changed'});}catch{broadcast({type:'unavailable'});}
 });
}
