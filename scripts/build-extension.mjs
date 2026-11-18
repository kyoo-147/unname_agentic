import { cp, mkdir, readFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve('vite/package.json'));
const { build } = viteRequire('esbuild');
const output = path.join(root, 'dist/extension');
await access(path.join(root, 'dist/web/index.html'));
await mkdir(output, { recursive: true });
await cp(path.join(root, 'dist/web'), output, { recursive: true });
await build({
  entryPoints: ['background', 'content', 'popup'].map(name => path.join(root, `extension/${name}.ts`)),
  bundle: true,
  outdir: output,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  sourcemap: true,
  legalComments: 'none',
});
for (const file of ['manifest.json', 'popup.html']) await cp(path.join(root, 'extension', file), path.join(output, file));
const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Expected Chrome Manifest V3.');
console.log(`Built Chrome MV3 extension at ${output}`);
