import {contextBridge,ipcRenderer} from 'electron';
import type {DesktopBridge,DesktopEvent} from '../../../packages/contracts/src/events.js';
const bridge:DesktopBridge={
 cancelEnvironment:input=>ipcRenderer.invoke('an:environment-cancel',input),
 prepareEnvironment:input=>ipcRenderer.invoke('an:environment',input),
 auth:input=>ipcRenderer.invoke('an:auth',input),
 openAuth:input=>ipcRenderer.invoke('an:auth-open',input),
 importMaterial:input=>ipcRenderer.invoke('an:material-import',input),
 snapshot:()=>ipcRenderer.invoke('an:snapshot'),
 createBot:input=>ipcRenderer.invoke('an:command',{...input,type:'bot.create'}),
 submitWork:input=>ipcRenderer.invoke('an:command',{...input,type:'work.submit'}),
 setPaused:input=>ipcRenderer.invoke('an:command',{...input,type:'bot.pause'}),
 setAcceptingTasks:input=>ipcRenderer.invoke('an:command',{...input,type:'bot.accept'}),
 cancelRun:input=>ipcRenderer.invoke('an:command',{...input,type:'run.cancel'}),
 interruptRun:input=>ipcRenderer.invoke('an:command',{...input,type:'run.interrupt'}),
 selectConnection:input=>ipcRenderer.invoke('an:command',{...input,type:'connection.select'}),
 decideApproval:input=>ipcRenderer.invoke('an:command',{...input,type:'approval.decide'}),
 saveCredential:async value=>{try{return await ipcRenderer.invoke('an:credential-save',value);}finally{value.fill(0);}},
 revokeCredential:credentialRef=>ipcRenderer.invoke('an:credential-revoke',credentialRef),
 openSettings:()=>ipcRenderer.invoke('an:settings'),
 selectAsset:()=>ipcRenderer.invoke('an:select-asset'),
 requestQuit:choice=>ipcRenderer.invoke('an:quit',choice),
 subscribe:listener=>{const wrapped=(_event:Electron.IpcRendererEvent,event:DesktopEvent)=>listener(event);ipcRenderer.on('an:event',wrapped);return()=>{ipcRenderer.removeListener('an:event',wrapped);};},
};contextBridge.exposeInMainWorld('an',Object.freeze(bridge));
