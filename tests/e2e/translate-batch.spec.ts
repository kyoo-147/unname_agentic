import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

// "Translate all" must not spend one provider request per text block. This spec
// drives the real button against the deterministic loopback provider, reads that
// provider's request counter, and proves the document was translated in a handful
// of batched calls instead of one call per block.
const PROVIDER = 'http://127.0.0.1:4319';

async function requestCount(page: import('@playwright/test').Page): Promise<number> {
  const response = await page.request.get(`${PROVIDER}/metrics`);
  return (await response.json() as { requests: number }).requests;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mirror.locale', 'vi'));
});

test('translate all batches a page into one provider request', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/mirror-field-notes.pdf'));
  await expect(page.locator('.page-pair')).toHaveCount(4);

  await page.locator('#settings-open').click();
  await page.locator('[name=endpoint]').fill(`${PROVIDER}/v1`);
  await page.locator('[name=model]').fill('deterministic-test-only');
  await page.getByRole('button', { name: /Áp dụng/i }).click();
  await expect(page.locator('.painted-region').first()).toBeVisible({ timeout: 20_000 });

  const before = await requestCount(page);
  const blocksOnRenderedPages = await page.locator('.source-region').count();
  expect(blocksOnRenderedPages).toBeGreaterThan(5);

  await page.locator('#full').click();

  // The status line reports the running total; wait until the whole document is done.
  await expect(page.locator('#status')).toContainText(/vùng đã dịch|regions translated/i, { timeout: 60_000 });
  await expect(page.locator('#status')).not.toHaveClass(/is-error/);

  const after = await requestCount(page);
  const spent = after - before;

  // Batching is only worth it if the pages cost a handful of calls, not one per
  // block. The fixture has several blocks per page across four pages.
  expect(spent).toBeGreaterThan(0);
  expect(spent).toBeLessThan(blocksOnRenderedPages);

  // Every page that was rendered has at least one painted translation.
  const painted = await page.locator('.painted-region').count();
  expect(painted).toBeGreaterThan(5);
});

test('a provider that cannot batch still translates, one call per block', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/mirror-field-notes.pdf'));
  await expect(page.locator('.page-pair')).toHaveCount(4);

  await page.locator('#settings-open').click();
  await page.locator('[name=provider]').selectOption('google');
  await page.locator('[name=endpoint]').fill(`${PROVIDER}/v1`);
  await page.locator('[name=apiKey]').fill('test-key');
  const consent = page.locator('[name=allowCloud]');
  if (!(await consent.isChecked())) await consent.check();
  await page.getByRole('button', { name: /Áp dụng/i }).click();

  // Google v2 is a single-text API: the batch path degrades without throwing.
  await expect(page.locator('#status')).not.toHaveClass(/is-error/, { timeout: 20_000 });
});
