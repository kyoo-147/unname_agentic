import { access, constants, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const extension = path.join(root, 'dist', 'extension');
const required = ['manifest.json', 'background.js', 'content.js', 'popup.js', 'popup.html', 'index.html', 'index.js'];

if (!process.env.CHROME_PATH) fail('CHROME_PATH is required. Point it at an installed Chrome or Chromium executable.');
const chromePath = path.resolve(process.env.CHROME_PATH);
let chromeStat;
try {
  chromeStat = await stat(chromePath);
} catch {
  fail(`Chrome/Chromium executable does not exist: ${chromePath}. Set CHROME_PATH to the browser binary, not its installation directory.`);
}
if (!chromeStat.isFile() || chromeStat.size === 0) {
  fail(`CHROME_PATH must point to a non-empty Chrome/Chromium executable file, not a directory or special file: ${chromePath}`);
}
if (process.platform === 'win32' && !['.exe', '.com'].includes(path.extname(chromePath).toLowerCase())) {
  fail(`CHROME_PATH must point to a Windows executable (.exe or .com): ${chromePath}`);
}
try {
  await access(chromePath, constants.X_OK);
} catch {
  fail(`Chrome/Chromium path is not executable: ${chromePath}. Set CHROME_PATH to an executable browser binary.`);
}
for (const file of required) {
  try {
    await access(path.join(extension, file));
  } catch {
    fail(`Built extension file is missing: dist/extension/${file}. Run [1mpnpm build[0m first.`);
  }
}
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) fail('dist/extension/manifest.json is not a Manifest V3 extension.');
try {
  createRequire(import.meta.url).resolve('@playwright/test');
} catch {
  fail('Playwright is not installed. Install the project test tooling before running this lane; no fallback browser is used.');
}

console.log(`Extension browser E2E: built MV3 artifact and Chrome/Chromium executable found at ${chromePath}.`);
console.log('Each test launches a fresh temporary Chrome profile and loads dist/extension unpacked.');
console.log('Native-host reconnect and packaged-host evidence remain external release gates.');
const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '--config', 'extension/playwright.config.ts'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) fail(`Could not start Playwright: ${result.error.message}`);
process.exitCode = result.status ?? 1;

function fail(message) {
  console.error(`Extension browser E2E blocked: ${message}`);
  process.exit(1);
}
