import { describe, expect, it } from 'vitest';
import { parseCommand, MAX_PAYLOAD_BYTES } from '../../packages/contracts/src/commands.js';
import { authorizeFrame, workerEnvironment } from '../../apps/desktop/main/ipc.js';
const command = { type:'bot.pause', commandId:'cmd-1', scope:{botId:'bot-1'}, expectedVersion:1, paused:true };
const context = { webContentsId:7, frameRoutingId:1, url:'file:///app/index.html', subject:'local-user', permissions:['read','write'] as const };
describe('desktop IPC boundary', () => {
  it('accepts only a typed versioned scoped command', () => { expect(parseCommand(command)).toEqual(command); });
  it.each([{...command,subject:'admin'}, {...command,expectedVersion:0}, {...command,scope:{botId:'bot-1',subject:'admin'}}, {...command,paused:'yes'}, {type:'shell',commandId:'cmd-1'}])('rejects malformed or authority-bearing payload %j', value => { expect(()=>parseCommand(value)).toThrow(); });
  it('rejects oversize text before work', () => { expect(()=>parseCommand({type:'work.submit',commandId:'cmd-2',scope:{botId:'bot-1'},expectedVersion:1,taskId:'t',text:'x'.repeat(MAX_PAYLOAD_BYTES)})).toThrow(); });
  it.each([{webContentsId:8,frameRoutingId:1,url:context.url,isMainFrame:true}, {webContentsId:7,frameRoutingId:2,url:context.url,isMainFrame:false}, {webContentsId:7,frameRoutingId:1,url:context.url+'?x=1',isMainFrame:true}, {webContentsId:7,frameRoutingId:1,url:'https://evil.test',isMainFrame:true}])('rejects foreign sender/frame/origin %j', sender => { expect(()=>authorizeFrame(sender,context,'read')).toThrow(); });
  it('rejects writes from a read-only window',()=>{expect(()=>authorizeFrame({webContentsId:7,frameRoutingId:1,url:context.url,isMainFrame:true},{...context,permissions:['read']},'write')).toThrow();});
  it('passes no inherited tokens, proxy credentials or runtime switches to Core',()=>{expect(workerEnvironment({HOME:'/home/me',PATH:'/bin',OPENAI_API_KEY:'secret',NODE_OPTIONS:'--inspect',AWS_SECRET_ACCESS_KEY:'secret',HTTPS_PROXY:'secret'})).toEqual({HOME:'/home/me',PATH:'/bin'});});
});
