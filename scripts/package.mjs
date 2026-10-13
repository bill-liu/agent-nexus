import { packager } from '@electron/packager';
import { readFile, mkdir, cp, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir,release } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
if (process.platform !== 'darwin') throw new Error('MAC_REQUIRED: package:mac must run on a Mac runner; Linux checks are not Mac verification');
const archArg = process.argv.find(x => x.startsWith('--arch='));
const arch = archArg?.split('=')[1] ?? process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('UNSUPPORTED_ARCH');
execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const staging = await mkdtemp(join(tmpdir(), 'an-p1-package-'));
await cp('build', join(staging, 'build'), { recursive: true });
// Existing esbuild compiler is a runtime tool for text transformation only.
// Keep its JS and native executable outside asar so utilityProcess can invoke it.
await mkdir(join(staging,'node_modules/@esbuild'),{recursive:true});
await cp('node_modules/esbuild',join(staging,'node_modules/esbuild'),{recursive:true});
await cp(`node_modules/@esbuild/darwin-${arch}`,join(staging,`node_modules/@esbuild/darwin-${arch}`),{recursive:true});
await writeFile(join(staging, 'package.json'), JSON.stringify({name:pkg.name,version:pkg.version,main:'build/main.cjs',private:true}));
const output = await packager({dir:staging,name:'Agent Nexus',platform:'darwin',arch,
  electronVersion:pkg.devDependencies.electron,out:'out',overwrite:true,asar:{unpack:'{node_modules/esbuild/**,node_modules/@esbuild/**}'},
  prune:false,appBundleId:'dev.agentnexus.p0',appVersion:'0.0.0',
  protocols:[{name:'Agent Nexus',schemes:['agent-nexus']}],
  extendInfo:{LSMinimumSystemVersion:'15.0'},
});
const app = join(output[0], 'Agent Nexus.app');
const asar = await readFile(join(app, 'Contents/Resources/app.asar'));
await mkdir('out', {recursive:true});
const evidence = {appPath:app,executable:join(app,'Contents/MacOS/Agent Nexus'),arch,platform:process.platform,kernel:release(),
  macOS:execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim(),
  workflowRun:process.env.GITHUB_RUN_ID??null,workflowAttempt:process.env.GITHUB_RUN_ATTEMPT??null,
  appAsarSha256:createHash('sha256').update(asar).digest('hex'),
  electron:pkg.devDependencies.electron,phase:'P1-A',runtime:'p0-demo-default; p1-preparation-explicit; no-live-admission-by-default',
  signing:'No release signing or notarization configured; development package only',
  build:JSON.parse(await readFile('build/build-info.json','utf8'))};
await writeFile('out/package-evidence.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
