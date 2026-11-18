import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

test('a scanned PDF is OCRed locally and the recognized blocks are translated', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/scanned-page.pdf'));
  await expect(page.locator('.page-pair')).toHaveCount(1);
  await expect(page.locator('.source-region').first()).toBeVisible({ timeout: 60_000 });

  await page.locator('#settings-open').click();
  await page.locator('[name=endpoint]').fill('http://127.0.0.1:4319/v1');
  await page.locator('[name=model]').fill('deterministic-test-only');
  await page.locator('#settings-form button[type=submit]').click();

  const callout = page.locator('.callout-region').first();
  await expect(callout).toBeVisible({ timeout: 30_000 });
  await callout.click();
  await expect(page.locator('#selected-translation')).toContainText('Bản dịch kiểm thử', { timeout: 30_000 });
  await expect(page.locator('.painted-region')).toHaveCount(0);
});
