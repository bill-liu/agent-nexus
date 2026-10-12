export type Permission='read'|'write';
export type WindowContext={webContentsId:number;frameRoutingId:number;url:string;subject:string;permissions:readonly Permission[];view?:'workspace'|'settings';selectedBotId?:string};
export type FrameIdentity={webContentsId:number;frameRoutingId:number;url:string;isMainFrame:boolean};
export function authorizeFrame(frame:FrameIdentity,context:WindowContext|undefined,permission:Permission):WindowContext {
 if(!context || !frame.isMainFrame || frame.webContentsId!==context.webContentsId || frame.frameRoutingId!==context.frameRoutingId || frame.url!==context.url || !context.permissions.includes(permission))throw Error('UNAUTHORIZED_FRAME');
 return context;
}
export function workerEnvironment(source:Record<string,string|undefined>):Record<string,string> {
 const allowed=['PATH','HOME','TMPDIR','LANG','LC_ALL','TZ'];const env:Record<string,string>={};for(const key of allowed){const value=source[key];if(value!==undefined)env[key]=value;}return env;
}
