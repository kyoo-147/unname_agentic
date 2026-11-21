import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const FIXTURE = resolve('tests/fixtures/mirror-field-notes.pdf');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
});

test('extracts a built-in field locally and shows evidence provenance', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('.page-pair')).toHaveCount(4);
  await expect(page.locator('.original-slot canvas').first()).toBeVisible();

  await page.locator('#intelligence-toggle').click();
  await expect(page.locator('#reader-panel')).toBeVisible();
  await expect(page.locator('.reader-intelligence__result')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('.reader-intelligence__value')).toContainText('42, 3.14159');
  await expect(page.locator('.reader-intelligence__meta')).toContainText('Embedded PDF text');
  await expect(page.locator('.reader-intelligence__provenance')).toContainText('decoded locally');
  await expect(page.locator('.reader-intelligence__result')).toHaveAttribute('data-state', 'evidence');
});

test('shows a schema error without leaving a false evidence result', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('.original-slot canvas').first()).toBeVisible();
  await page.locator('#intelligence-toggle').click();
  const schema = page.locator('.reader-intelligence textarea');
  await schema.fill('{"fields":[{"id":"broken","label":"Broken","type":"not-a-field","required":true}]}');
  await page.getByRole('button', { name: 'Extract locally' }).click();
  await expect(page.locator('.reader-intelligence__status')).toContainText('schema could not be used');
  await expect(page.locator('.reader-intelligence__result')).toHaveCount(0);
});
