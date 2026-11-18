import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

// A26's PDF path is the browser's own print-to-PDF sheet over the bilingual HTML.
// This spec proves the control is wired, the print pipeline opens for a document
// with translations, and the page title the browser offers as a filename is the
// document title rather than the app title.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mirror.locale', 'vi'));
});

test('opens the bilingual print sheet for a translated document', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('/');
  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/mirror-field-notes.pdf'));
  await expect(page.locator('.page-pair')).toHaveCount(4);

  await page.locator('#settings-open').click();
  await page.locator('[name=endpoint]').fill('http://127.0.0.1:4319/v1');
  await page.locator('[name=model]').fill('deterministic-test-only');
  await page.getByRole('button', { name: /Áp dụng/i }).click();
  await expect(page.locator('.painted-region').first()).toBeVisible({ timeout: 20_000 });

  await expect(page.locator('#export-print')).toBeVisible();
  await page.locator('#export-print').click();

  await expect(page.locator('#status')).toContainText(/bảng in|print sheet/i, { timeout: 20_000 });
  await expect(page.locator('#status')).not.toHaveClass(/is-error/);
  await expect(page).toHaveTitle(/mirror-field-notes/i);

  expect(errors).toEqual([]);
});

test('leaves the browser print dialog alone when nothing is translated', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/mirror-field-notes.pdf'));
  await expect(page.locator('.page-pair')).toHaveCount(4);

  // With no translations the Ctrl/Cmd+P shortcut must not hijack the browser dialog:
  // the app falls through, so the status line keeps its untranslated message.
  const before = await page.locator('#status').innerText();
  await page.keyboard.press('ControlOrMeta+p');
  const after = await page.locator('#status').innerText();
  expect(after).toBe(before);
});
