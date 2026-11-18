import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
});

test('exports bilingual text and restores the imported library after reload', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/mirror-field-notes.pdf'));
  await expect(page.locator('.page-pair')).toHaveCount(4);

  await page.locator('#settings-open').click();
  await page.locator('[name=endpoint]').fill('http://127.0.0.1:4319/v1');
  await page.locator('[name=model]').fill('deterministic-test-only');
  await page.getByRole('button', { name: 'Apply & translate visible pages' }).click();
  await expect(page.locator('.painted-region').filter({ hasText: 'Đọc không còn rào cản' }).first()).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-bilingual').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/mirror-field-notes\.bilingual\.txt$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  const exported = await readFile(path!, 'utf8');
  expect(exported).toContain('Reading without boundaries');
  expect(exported).toContain('Đọc không còn rào cản');
  expect(exported).toContain('---');

  await page.reload();
  await expect(page.locator('.document-card')).toHaveCount(1);
  await expect(page.locator('.document-card')).toContainText('mirror-field-notes.pdf');
  await page.locator('.document-card').click();
  await expect(page.locator('.page-pair')).toHaveCount(4);
});
