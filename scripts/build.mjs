import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await mkdir('build', { recursive: true });
for (const [entry, name] of [
  ['apps/desktop/main/index.ts', 'main'],
  ['apps/desktop/preload/index.ts', 'preload'],
  ['apps/desktop/core-worker/entry.ts', 'core-worker'],
]) {
  await build({ entryPoints: [entry], outfile: `build/${name}.cjs`, bundle: true,
    platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'node:*'], sourcemap: false });
}
await build({ entryPoints: ['apps/desktop/renderer/index.tsx'], outfile: 'build/renderer.js',
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome140',
  define: { 'process.env.NODE_ENV': '"production"' }, sourcemap: false });
await copyFile('apps/desktop/renderer/index.html', 'build/index.html');
await copyFile('apps/desktop/renderer/style.css', 'build/style.css');
await writeFile('build/build-info.json', JSON.stringify({
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  phase: 'P0', runtime: 'fake-only', node: process.version
}, null, 2));
