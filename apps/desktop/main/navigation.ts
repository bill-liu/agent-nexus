import {parseDeepLink} from './files.js';
/** A single bounded navigation intent waits for authoritative ownership data. Never a business command. */
export class PendingNavigation {
 private pending:{botId:string}|undefined;
 get hasPending():boolean{return this.pending!==undefined;}
 queue(url:string):void {const target=parseDeepLink(url);this.pending=target;}
 take(bots:readonly {id:string;owner:string}[]|undefined,subject:string):{botId:string}|undefined {
  if(!bots || !this.pending)return undefined;
  const target=this.pending;this.pending=undefined;
  return bots.some(bot=>bot.id===target.botId&&bot.owner===subject)?target:undefined;
 }
}
