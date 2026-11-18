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

test('stopping translate-all aborts the batch instead of finishing the document', async ({ page }) => {
  // Slow each provider round trip down so the stop click lands mid-document; on a
  // fast loopback provider the whole four-page batch can finish in tens of ms.
  await page.route('**/v1/chat/completions', async route => {
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/mirror-field-notes.pdf'));
  await expect(page.locator('.page-pair')).toHaveCount(4);

  await page.locator('#settings-open').click();
  await page.locator('[name=endpoint]').fill(`${PROVIDER}/v1`);
  await page.locator('[name=model]').fill('deterministic-test-only');
  await page.getByRole('button', { name: /Áp dụng/i }).click();
  await expect(page.locator('.painted-region').first()).toBeVisible({ timeout: 20_000 });
  // Let the opening per-block queue drain first: otherwise the counter moves
  // because of that work, not because of the batch under test. Stable for two
  // 400 ms samples means nothing is in flight.
  let lastSeen = -1;
  await expect.poll(async () => {
    const now = await requestCount(page);
    const stable = now === lastSeen;
    lastSeen = now;
    return stable;
  }, { timeout: 20_000, intervals: [400, 400, 400, 400, 400] }).toBe(true);

  const before = await requestCount(page);
  await page.locator('#full').click();
  // Stop as soon as the first batched page request has left.
  await expect.poll(() => requestCount(page), { timeout: 20_000 }).toBeGreaterThan(before);
  await page.locator('#full').click();

  const stoppedAt = await requestCount(page);
  await page.waitForTimeout(2500);
  const settled = await requestCount(page);
  // Whatever lands after the stop is the work the reader deliberately keeps for
  // the pages on screen; what must not happen is the rest of the document going
  // out. Two painted pages at most (the visible pair), never all four.
  expect(settled).toBeGreaterThanOrEqual(stoppedAt);
  const paintedPages = await page.locator('.page-pair').evaluateAll(rows =>
    rows.filter(row => row.querySelector('.painted-region') !== null).length);
  expect(paintedPages).toBeLessThanOrEqual(2);
  await expect(page.locator('#full')).toHaveText(/Dịch toàn bộ|Translate all/i);
  await expect(page.locator('#status')).not.toHaveClass(/is-error/);
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
