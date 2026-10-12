import {BrowserWindow} from 'electron';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {WindowContext} from './ipc.js';
export function createWindow(buildDirectory:string,view:'workspace'|'settings',contexts:Map<number,WindowContext>):BrowserWindow{
 const url=pathToFileURL(join(buildDirectory,'index.html')).href;
 const window=new BrowserWindow({width:view==='settings'?900:1240,height:850,minWidth:650,minHeight:500,title:view==='settings'?'Agent Nexus · 设置':'Agent Nexus',show:false,webPreferences:{preload:join(buildDirectory,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false}});
 const wc=window.webContents;contexts.set(wc.id,{webContentsId:wc.id,frameRoutingId:wc.mainFrame.routingId,url,subject:'local-user',permissions:view==='settings'?['read']:['read','write'],view});
 wc.setWindowOpenHandler(()=>({action:'deny'}));wc.on('will-navigate',event=>event.preventDefault());wc.on('will-frame-navigate',event=>event.preventDefault());wc.on('will-attach-webview',event=>event.preventDefault());
 wc.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));wc.session.setPermissionCheckHandler(()=>false);
 const contentsId=wc.id;wc.on('did-finish-load',()=>{const context=contexts.get(contentsId);if(context && wc.getURL()===url)context.frameRoutingId=wc.mainFrame.routingId;});wc.on('render-process-gone',(_event,details)=>{if(details.reason!=='clean-exit' && !window.isDestroyed())void window.loadURL(url);});
 window.on('closed',()=>contexts.delete(contentsId));window.once('ready-to-show',()=>window.show());void window.loadURL(url);return window;
}
