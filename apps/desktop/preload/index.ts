import {contextBridge,ipcRenderer} from 'electron';
import type {DesktopBridge,DesktopEvent} from '../../../packages/contracts/src/events.js';
const bridge:DesktopBridge={
 snapshot:()=>ipcRenderer.invoke('an:snapshot'),
 createBot:input=>ipcRenderer.invoke('an:command',{...input,type:'bot.create'}),
 submitWork:input=>ipcRenderer.invoke('an:command',{...input,type:'work.submit'}),
 setPaused:input=>ipcRenderer.invoke('an:command',{...input,type:'bot.pause'}),
 setAcceptingTasks:input=>ipcRenderer.invoke('an:command',{...input,type:'bot.accept'}),
 cancelRun:input=>ipcRenderer.invoke('an:command',{...input,type:'run.cancel'}),
 openSettings:()=>ipcRenderer.invoke('an:settings'),
 selectAsset:()=>ipcRenderer.invoke('an:select-asset'),
 requestQuit:choice=>ipcRenderer.invoke('an:quit',choice),
 subscribe:listener=>{const wrapped=(_event:Electron.IpcRendererEvent,event:DesktopEvent)=>listener(event);ipcRenderer.on('an:event',wrapped);return()=>{ipcRenderer.removeListener('an:event',wrapped);};},
};contextBridge.exposeInMainWorld('an',Object.freeze(bridge));
