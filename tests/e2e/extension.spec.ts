import { test, expect, chromium } from '@playwright/test';
import { resolve } from 'node:path';

test('production extension automatically mirrors MIME-only PDF navigation once', async () => {
  const extension = resolve('dist/extension');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await worker.evaluate(async () => { await chrome.storage.local.set({ 'mirror:enabled': true }); });
    const source = await context.newPage();
    await source.goto('http://127.0.0.1:4319/document-without-suffix').catch(() => {});
    await expect.poll(() => context.pages().filter(page => page.url().startsWith('chrome-extension://') && page.url().includes('sourceTab=')).length).toBe(1);
    const viewer = context.pages().find(page => page.url().startsWith('chrome-extension://') && page.url().includes('sourceTab='))!;
    await viewer.waitForLoadState();
    await expect(viewer.locator('.original-slot canvas').first()).toBeVisible();
    await expect(viewer.locator('.page-pair')).toHaveCount(4);
    await source.reload().catch(() => {});
    await expect.poll(() => context.pages().filter(page => page.url().startsWith('chrome-extension://') && page.url().includes('sourceTab=')).length).toBe(1);
    await viewer.screenshot({ path: 'artifacts/extension-auto-mirror.png' });
  } finally { await context.close(); }
});
