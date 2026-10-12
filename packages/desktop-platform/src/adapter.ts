import type {AssetSelection} from '../../contracts/src/events.js';
/** Platform capabilities injected by Main; domain packages never import Electron. */
export interface DesktopPlatformAdapter {selectAsset():Promise<AssetSelection|null>;openSettings():void;requestQuit():Promise<void>;}
