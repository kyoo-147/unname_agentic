import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/build-extension.mjs', import.meta.url));
const created: string[] = [];

interface Result { code: number; stdout: string; stderr: string }

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** Build a throwaway project: real extension sources plus a real dist/web to copy. */
async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mirror-extension-'));
  created.push(root);
  await mkdir(path.join(root, 'extension'), { recursive: true });
  await mkdir(path.join(root, 'dist', 'web', 'assets'), { recursive: true });
  await writeFile(path.join(root, 'extension', 'background.ts'), "const tag = 'background';\nvoid tag;\n");
  await writeFile(path.join(root, 'extension', 'content.ts'), "document.documentElement.dataset.mirror = 'on';\n");
  await writeFile(path.join(root, 'extension', 'popup.ts'), "document.title = 'Mirror PDF';\n");
  await writeFile(path.join(root, 'extension', 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Mirror PDF test',
    version: '0.0.0',
    background: { service_worker: 'background.js', type: 'module' },
  }));
  await writeFile(path.join(root, 'extension', 'popup.html'), '<!doctype html><meta charset="utf-8"><title>Mirror PDF</title><script src="popup.js"></script>');
  await writeFile(path.join(root, 'dist', 'web', 'index.html'), '<!doctype html><script type="module" src="./assets/index-current.js"></script>');
  await writeFile(path.join(root, 'dist', 'web', 'assets', 'index-current.js'), "console.log('current');\n");
  return root;
}

function build(root: string, args: string[] = []): Promise<Result> {
  return new Promise(resolve => {
    execFile(process.execPath, [script, '--root', root, ...args], { cwd: root, timeout: 120_000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Every file under `directory` as a forward-slash path relative to it. */
async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

describe('extension build output', () => {
  it('clears the previous build so a stale bundle cannot blend into the new one', async () => {
    const root = await project();
    await mkdir(path.join(root, 'dist', 'extension', 'assets'), { recursive: true });
    await writeFile(path.join(root, 'dist', 'extension', 'assets', 'index-stale.js'), "console.log('stale');\n");
    await writeFile(path.join(root, 'dist', 'extension', 'assets', 'index-stale.js.map'), '{}\n');
    await writeFile(path.join(root, 'dist', 'extension', 'popup.js'), "document.body.textContent = 'Automatic mirroring is off.';\n");

    const result = await build(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Built Chrome MV3 extension');

    const files = await listFiles(path.join(root, 'dist', 'extension'));
    expect(files).not.toContain('assets/index-stale.js');
    expect(files).not.toContain('assets/index-stale.js.map');
    expect(files).toEqual(expect.arrayContaining([
      'manifest.json',
      'popup.html',
      'background.js',
      'content.js',
      'popup.js',
      'index.html',
      'assets/index-current.js',
    ]));

    // The stale English-only popup must be gone, replaced by this build's bundle.
    const popup = await readFile(path.join(root, 'dist', 'extension', 'popup.js'), 'utf8');
    expect(popup).not.toContain('Automatic mirroring');
    expect(popup).toContain('Mirror PDF');
  }, 30_000);

  it('ships the manifest and does not duplicate files when the build is rewritten', async () => {
    const root = await project();
    expect((await build(root)).code).toBe(0);

    const first = await listFiles(path.join(root, 'dist', 'extension'));
    const manifest = JSON.parse(await readFile(path.join(root, 'dist', 'extension', 'manifest.json'), 'utf8'));
    expect(manifest.manifest_version).toBe(3);
    expect(first.filter(file => file.startsWith('assets/'))).toEqual(['assets/index-current.js']);

    expect((await build(root)).code).toBe(0);
    expect(await listFiles(path.join(root, 'dist', 'extension'))).toEqual(first);
  }, 30_000);

  it('refuses a target outside dist/', async () => {
    const root = await project();
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
    created.push(outside);
    await mkdir(outside, { recursive: true });
    const sentinel = path.join(outside, 'keep.txt');
    await writeFile(sentinel, 'keep\n');

    const escaped = await build(root, ['--output', outside]);
    expect(escaped.code).not.toBe(0);
    expect(escaped.stderr).toMatch(/Refusing to write the extension outside/);
    await expect(access(sentinel)).resolves.toBeUndefined();

    // dist itself is the web build's parent; clearing it would destroy the input.
    const dist = await build(root, ['--output', 'dist']);
    expect(dist.code).not.toBe(0);
    expect(dist.stderr).toMatch(/Refusing to write the extension outside/);
  }, 30_000);
});
