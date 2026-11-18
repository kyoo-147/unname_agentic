import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const OUT = resolve('artifacts/ui-flows');

test('captures the full web reader flow in Vietnamese, English and Chinese', async ({ page }) => {
  test.setTimeout(90_000);
  await mkdir(OUT, { recursive: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Phòng đọc của bạn.' })).toBeVisible();
  await page.screenshot({ path: `${OUT}/01-home-vi.png`, fullPage: true });

  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/mirror-field-notes.pdf'));
  await expect(page.locator('.page-pair')).toHaveCount(4);
  await expect(page.locator('.original-slot canvas').first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/02-reader-source-vi.png` });

  await page.locator('#settings-open').click();
  await page.locator('[name=endpoint]').fill('http://127.0.0.1:4319/v1');
  await page.locator('[name=model]').fill('deterministic-test-only');
  await page.screenshot({ path: `${OUT}/03-settings-vi.png` });
  await page.locator('#settings-form button[type=submit]').click();
  await expect(page.locator('.painted-region').filter({ hasText: 'Đọc không còn rào cản' }).first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/04-reader-translated-vi.png` });

  await page.locator('#outline-toggle').click();
  await expect(page.locator('.reader-panel')).toBeVisible();
  await page.screenshot({ path: `${OUT}/05-outline-vi.png` });
  await page.keyboard.press('Escape');

  await page.locator('#search-toggle').click();
  await page.locator('#reader-panel input[type=search]').fill('Reading');
  await expect(page.locator('.reader-search__result').first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/06-search-vi.png` });
  await page.keyboard.press('Escape');

  await page.locator('#thumbnails-toggle').click();
  await expect(page.locator('#thumbnails')).toBeVisible();
  await page.screenshot({ path: `${OUT}/07-thumbnails-vi.png` });

  await page.locator('.source-region').first().click();
  await expect(page.locator('#selection-dialog')).toBeVisible();
  await page.screenshot({ path: `${OUT}/08-paired-dialog-vi.png` });
  await page.locator('#selection-close').click();

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-bilingual').click();
  await downloadPromise;
  await page.screenshot({ path: `${OUT}/09-export-status-vi.png` });

  await page.locator('[data-locale=en]').first().click();
  await expect(page.getByRole('heading', { name: 'Translation settings' })).toBeHidden();
  await page.screenshot({ path: `${OUT}/10-reader-en.png` });
  await page.locator('[data-locale=zh]').first().click();
  await page.screenshot({ path: `${OUT}/11-reader-zh.png` });
});
