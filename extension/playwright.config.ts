import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const extensionPath = resolve('dist/extension');
if (!existsSync(resolve(extensionPath, 'manifest.json'))) {
  throw new Error('Built MV3 extension is missing at dist/extension. Run `pnpm build` before extension E2E.');
}
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: 'list',
  use: { viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
});
