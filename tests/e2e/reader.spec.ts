import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

test('imports a real PDF, translates anchored regions and keeps vector artwork', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your reading room.' })).toBeVisible();
  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/mirror-field-notes.pdf'));
  await expect(page.locator('.page-pair')).toHaveCount(4);
  await expect(page.locator('.original-slot canvas').first()).toBeVisible();
  await page.locator('#settings-open').click();
  await page.locator('[name=endpoint]').fill('http://127.0.0.1:4319/v1');
  await page.locator('[name=model]').fill('deterministic-test-only');
  await page.getByRole('button', { name: 'Apply & translate visible pages' }).click();
  await expect(page.locator('.painted-region').filter({ hasText: 'Đọc không còn rào cản' }).first()).toBeVisible();
  const pixels = await page.locator('.page-pair').first().evaluate(row => {
    const original = row.querySelector<HTMLCanvasElement>('.original-slot canvas')!;
    const mirror = row.querySelector<HTMLCanvasElement>('.translated-slot canvas')!;
    const a = original.getContext('2d')!.getImageData(0, 0, original.width, original.height).data;
    const b = mirror.getContext('2d')!.getImageData(0, 0, mirror.width, mirror.height).data;
    const sx = original.width / 612, sy = original.height / 792;
    let differences = 0;
    for (let y = Math.ceil(300 * sy); y < Math.floor(380 * sy); y++) {
      for (let x = Math.ceil(370 * sx); x < Math.floor(520 * sx); x++) {
        const index = (y * original.width + x) * 4;
        for (let c = 0; c < 4; c++) if (a[index + c] !== b[index + c]) differences++;
      }
    }
    let sourceTitleInk = 0, mirrorTitleInk = 0;
    for (let y = Math.ceil(76 * sy); y < Math.floor(101 * sy); y++) {
      for (let x = Math.ceil(44 * sx); x < Math.floor(440 * sx); x++) {
        const index = (y * original.width + x) * 4;
        if (a[index]! < 200 && a[index + 1]! < 200 && a[index + 2]! < 200) sourceTitleInk++;
        if (b[index]! < 200 && b[index + 1]! < 200 && b[index + 2]! < 200) mirrorTitleInk++;
      }
    }
    return { differences, sourceTitleInk, mirrorTitleInk, width: original.width, mirrorWidth: mirror.width };
  });
  expect(pixels.width).toBe(pixels.mirrorWidth);
  expect(pixels.differences).toBe(0);
  expect(pixels.sourceTitleInk).toBeGreaterThan(100);
  expect(pixels.mirrorTitleInk).toBe(0);
  await page.locator('.source-region').filter({ hasText: 'Reading without boundaries' }).first().click();
  await expect(page.locator('#selected-source')).toHaveText('Reading without boundaries');
  await expect(page.locator('#selected-translation')).toHaveText('Đọc không còn rào cản');
  await page.locator('#selection-close').click();
  const separator = page.getByRole('separator').first();
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '52');
  await page.screenshot({ path: 'artifacts/reader-verified.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('shows a real provider failure without substituting source text', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/mirror-field-notes.pdf'));
  await page.locator('#settings-open').click();
  await page.locator('[name=endpoint]').fill('http://127.0.0.1:4319/unavailable');
  await page.getByRole('button', { name: 'Apply & translate visible pages' }).click();
  await expect(page.locator('#status')).toContainText('HTTP 404');
  await expect(page.locator('.painted-region')).toHaveCount(0);
  await expect(page.locator('.original-slot canvas').first()).toBeVisible();
});
