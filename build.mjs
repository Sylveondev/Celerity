// Build script: bundles the Electron main/preload and the renderer with esbuild.
import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const prod = args.has('--prod');
const watch = args.has('--watch');
const out = join(root, 'dist');

if (!watch) rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'renderer'), { recursive: true });

const copyStatic = () => {
  for (const f of ['index.html', 'styles.css']) copyFileSync(join(root, 'src/renderer', f), join(out, 'renderer', f));
};

const common = { bundle: true, sourcemap: prod ? false : 'linked', minify: prod, logLevel: 'info', legalComments: 'none' };

const builds = [
  { ...common, entryPoints: [join(root, 'src/renderer/main.ts')], outfile: join(out, 'renderer/renderer.js'), platform: 'browser', format: 'iife', target: ['chrome120'] },
  { ...common, entryPoints: [join(root, 'src/main/main.ts')], outfile: join(out, 'main.js'), platform: 'node', format: 'cjs', target: ['node20'], external: ['electron', 'ffmpeg-static'] },
  { ...common, entryPoints: [join(root, 'src/main/preload.ts')], outfile: join(out, 'preload.js'), platform: 'node', format: 'cjs', target: ['node20'], external: ['electron'] },
];

copyStatic();
if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context({ ...b, plugins: [{ name: 'static', setup(build) { build.onEnd(() => copyStatic()); } }] });
    await ctx.watch();
  }
  console.log('Watching for changes…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
