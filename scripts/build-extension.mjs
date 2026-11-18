import { access, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Build the Chrome MV3 extension into dist/extension.
 *
 * `pnpm build` runs this with no arguments. `--root` and `--output` exist so
 * tests/build-extension.test.ts can run the real build against a throwaway
 * directory instead of the working tree.
 */
const root = path.resolve(option('root') ?? fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve('vite/package.json'));
const { build } = viteRequire('esbuild');
const web = path.join(root, 'dist/web');
const output = extensionOutput(root, option('output') ?? path.join('dist', 'extension'));

await access(path.join(web, 'index.html'));
// Empty the destination before copying. A fresh copy laid beside the previous
// one leaves stale index-<hash>.js behind, and Chrome then loads a blend of two
// builds instead of the one that was just assembled.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(web, output, { recursive: true });
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

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value.`);
  return value;
}

function extensionOutput(rootDir, target) {
  const dist = path.join(rootDir, 'dist');
  const webDir = path.join(dist, 'web');
  const resolved = path.resolve(rootDir, target);
  const fromDist = path.relative(dist, resolved);
  if (!fromDist || fromDist.startsWith('..') || path.isAbsolute(fromDist)) {
    throw new Error(`Refusing to write the extension outside ${dist}: ${resolved}`);
  }
  const fromWeb = path.relative(webDir, resolved);
  // dist/web is the input of this build; writing inside it would copy it onto itself.
  if (!fromWeb || path.isAbsolute(fromWeb) || !fromWeb.startsWith('..')) {
    throw new Error(`Refusing to write the extension over the web build at ${webDir}: ${resolved}`);
  }
  return resolved;
}
