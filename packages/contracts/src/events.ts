import type {Input} from './commands.js';
export type BotView={id:string;name:string;owner:string;version:number;acceptingTasks:boolean;dispatchPaused:boolean;sandboxId:string;generation:number};
export type TaskView={id:string;botId:string;text:string;revision:number;status:string};
export type RunView={id:string;botId:string;taskId:string;state:string;slotHeld:boolean;version:number;fencingToken:number};
export type Snapshot={cursor:number;epoch:number;bots:BotView[];tasks:TaskView[];runs:RunView[];messages:unknown[];available:boolean;sqliteVersion:string;observedAt:string;windowId:number;view:'workspace'|'settings';quitPending:boolean;selectedBotId?:string;schedulerError?:string|null};
export type DesktopEvent={type:'changed'|'unavailable'|'compose'|'navigate';botId?:string};
export type AssetSelection={name:string;text:string;bytes:number;source:'system-dialog';policy:'local-only'};
export interface DesktopBridge {
 snapshot():Promise<Snapshot>;
 createBot(input:Input<'bot.create'>):Promise<unknown>;
 submitWork(input:Input<'work.submit'>):Promise<unknown>;
 setPaused(input:Input<'bot.pause'>):Promise<unknown>;
 setAcceptingTasks(input:Input<'bot.accept'>):Promise<unknown>;
 cancelRun(input:Input<'run.cancel'>):Promise<unknown>;
 openSettings():Promise<void>;
 selectAsset():Promise<AssetSelection|null>;
 requestQuit(choice:'begin'|'cancel'|'save'):Promise<{unknownRuns:string[]}>;
 subscribe(listener:(event:DesktopEvent)=>void):()=>void;
}
export type WorkerRequest={id:string;type:'snapshot'|'command'|'admissions'|'shutdown';subject:string;command?:import('./commands.js').Command;accepting?:boolean};
export type WorkerReply={id:string;ok:boolean;result?:unknown;error?:string;sqliteVersion?:string};
