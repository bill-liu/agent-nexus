import {constants} from 'node:fs';
import {lstat,realpath,open} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import type {AssetSelection} from '../../../packages/contracts/src/events.js';
export async function validateSelectedFile(path:string):Promise<AssetSelection> {
 const stat=await lstat(path);if(stat.isSymbolicLink() || !stat.isFile() || stat.size>1_048_576)throw Error('UNSAFE_FILE');
 if(await realpath(path)!==resolve(path))throw Error('SYMLINK_PATH');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const actual=await handle.stat();if(actual.ino!==stat.ino || actual.dev!==stat.dev || actual.size>1_048_576)throw Error('FILE_CHANGED');const buffer=await handle.readFile();if(buffer.length>1_048_576)throw Error('UNSAFE_FILE');return{name:basename(path),text:buffer.toString('utf8'),bytes:buffer.length,source:'system-dialog',policy:'local-only'};}finally{await handle.close();}
}
export function previewDocument(text:string):string {const escaped=text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'"><title>资料文本预览</title><pre>${escaped}</pre>`;}
export function parseDeepLink(value:string):{botId:string} {const url=new URL(value);if(url.protocol!=='agent-nexus:' || url.hostname!=='bot' || url.search || url.hash || !/^\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname))throw Error('INVALID_DEEP_LINK');return{botId:url.pathname.slice(1)};}
