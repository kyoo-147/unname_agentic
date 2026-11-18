import { chromium } from '@playwright/test';
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE = 'http://127.0.0.1:4173';
const PROVIDER = 'http://127.0.0.1:4319/metrics';
const OUT = resolve('artifacts/ui-flows');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(url) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await pause(250);
  }
  throw new Error('Timed out waiting for ' + url);
}

await mkdir(OUT, { recursive: true });
await waitFor(BASE);
await waitFor(PROVIDER);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 820 },
  recordVideo: { dir: resolve('artifacts/ui-flows/video'), size: { width: 1280, height: 820 } },
});
const page = await context.newPage();
page.on('download', () => undefined);
try {
  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Phòng đọc của bạn.' }).waitFor();
  await pause(900);

  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/mirror-field-notes.pdf'));
  await page.locator('.page-pair').first().waitFor();
  await page.locator('.original-slot canvas').first().waitFor();
  await pause(1000);

  await page.locator('#settings-open').click();
  await page.locator('[name=endpoint]').fill('http://127.0.0.1:4319/v1');
  await page.locator('[name=model]').fill('deterministic-test-only');
  await pause(900);
  await page.locator('#settings-form button[type=submit]').click();
  await page.locator('.painted-region').first().waitFor();
  await pause(1200);

  await page.locator('#reading-scroll').evaluate((element) => { element.scrollTop += 320; });
  await pause(900);
  await page.locator('#outline-toggle').click();
  await pause(1100);
  await page.keyboard.press('Escape');
  await page.locator('#search-toggle').click();
  await page.locator('#reader-panel input[type=search]').fill('Reading');
  await page.locator('.reader-search__result').first().waitFor();
  await pause(1100);
  await page.keyboard.press('Escape');
  await page.locator('#thumbnails-toggle').click();
  await pause(1100);
  await page.locator('.source-region').first().click();
  await page.locator('#selection-dialog').waitFor();
  await pause(1100);
  await page.locator('#selection-close').click();
  await page.locator('#export-bilingual').click();
  await pause(900);
  await page.locator('[data-locale=en]').first().click();
  await pause(900);
  await page.locator('[data-locale=zh]').first().click();
  await pause(900);
  await page.locator('[data-locale=vi]').first().click();
  await pause(600);

  const video = page.video();
  await context.close();
  const path = await video?.path();
  if (path) {
    await copyFile(path, resolve(OUT, 'demo-flow.webm'));
    console.log('VIDEO=' + resolve(OUT, 'demo-flow.webm'));
  }
} finally {
  await browser.close().catch(() => undefined);
}
