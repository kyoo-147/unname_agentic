import { access, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

/**
 * Build the Chrome MV3 extension into dist/extension.
 *
 * The native app is the product surface. The extension owns its browser viewer
 * under extension/viewer; this build no longer depends on a standalone Vite
 * application or a dist/web staging directory.
 */
const root = path.resolve(option('root') ?? fileURLToPath(new URL('../', import.meta.url)));
const viewer = path.join(root, 'extension', 'viewer');
const output = extensionOutput(root, option('output') ?? path.join('dist', 'extension'));
const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));

await access(path.join(viewer, 'index.html'));
await access(path.join(viewer, 'src', 'main.ts'));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(viewer, 'public'), output, { recursive: true });
await mkdir(path.join(output, 'assets'), { recursive: true });
await cp(path.join(pdfjsRoot, 'build', 'pdf.worker.min.mjs'), path.join(output, 'assets', 'pdf.worker.min.mjs'));

await build({
  entryPoints: [path.join(viewer, 'src', 'main.ts')],
  bundle: true,
  outfile: path.join(output, 'index.js'),
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  loader: { '.css': 'css', '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
  assetNames: 'assets/[name]-[hash]',
});

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

await cp(path.join(viewer, 'index.html'), path.join(output, 'index.html'));
for (const file of ['manifest.json', 'popup.html']) await cp(path.join(root, 'extension', file), path.join(output, file));
const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Expected Chrome Manifest V3.');
console.log(`Built Chrome MV3 extension at ${output}`);

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value.`);
  return value;
}

function extensionOutput(rootDir, target) {
  const dist = path.join(rootDir, 'dist');
  const resolved = path.resolve(rootDir, target);
  const fromDist = path.relative(dist, resolved);
  if (!fromDist || fromDist.startsWith('..') || path.isAbsolute(fromDist)) {
    throw new Error(`Refusing to write the extension outside ${dist}: ${resolved}`);
  }
  return resolved;
}
