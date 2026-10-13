import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function launchPackaged(mode:'p0-demo'|'p1-preparation'='p0-demo'):Promise<{app:ElectronApplication;page:Page;cleanup:()=>void}> {
 const executable=process.env.AN_PACKAGED_EXECUTABLE ?? (process.env.AN_APP_PATH ? join(process.env.AN_APP_PATH,'Contents/MacOS/Agent Nexus'):undefined);
 if(!executable || !existsSync(executable)) throw new Error('Packaged Electron executable required: AN_PACKAGED_EXECUTABLE or AN_APP_PATH. No devserver fallback.');
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'an-packaged-')));
 const app=await electron.launch({executablePath:executable,chromiumSandbox:true,env:{...process.env,AN_APP_USER_DATA:dir,AN_APP_MODE:mode}});
 const page=await app.firstWindow();await page.getByText(mode==='p1-preparation'?'P1 准备 · 真实执行待准入':'P0 演示 · Fake Runtime').waitFor();
 return {app,page,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
