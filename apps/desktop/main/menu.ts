import {Menu,BrowserWindow} from 'electron';
export function installMenu(openSettings:()=>void,requestQuit:()=>void):void{
 Menu.setApplicationMenu(Menu.buildFromTemplate([
  {label:'Agent Nexus',submenu:[{role:'about'},{label:'设置…',accelerator:'CmdOrCtrl+,',click:openSettings},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{label:'退出 Agent Nexus',accelerator:'CmdOrCtrl+Q',click:requestQuit}]},
  {label:'文件',submenu:[{label:'交一件事',accelerator:'CmdOrCtrl+N',click:()=>BrowserWindow.getFocusedWindow()?.webContents.send('an:event',{type:'compose'})},{role:'close',accelerator:'CmdOrCtrl+W'}]},
  {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
  {label:'视图',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},
  {label:'窗口',submenu:[{role:'minimize'},{role:'zoom'},{role:'front'}]},
 ]));
}
