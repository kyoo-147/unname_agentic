import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

// A28: the translation region must handle right-to-left and CJK scripts. The
// deterministic provider returns Arabic when the requested target is Arabic and
// Chinese when it is Chinese, so this exercises the real render path (direction
// resolution, wrapping, painting) without shipping a font-embedded fixture PDF.
// It does not prove bidi reordering of a *source* Arabic PDF — that needs a
// source fixture with an embedded Arabic font, which the repo does not have.
const PROVIDER = 'http://127.0.0.1:4319';
const ARABIC = /[\u0600-\u06ff]/;
const CJK = /[\u4e00-\u9fff]/;

async function openTranslated(page: import('@playwright/test').Page, target: string) {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/mirror-field-notes.pdf'));
  await expect(page.locator('.page-pair')).toHaveCount(4);
  await page.locator('#target-language').selectOption(target);
  await page.locator('#settings-open').click();
  await page.locator('[name=endpoint]').fill(`${PROVIDER}/v1`);
  await page.locator('[name=model]').fill('deterministic-test-only');
  await page.getByRole('button', { name: /Áp dụng/i }).click();
  await expect(page.locator('.painted-region').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#status')).not.toHaveClass(/is-error/, { timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mirror.locale', 'vi'));
});

test('an Arabic target paints right-to-left regions', async ({ page }) => {
  await openTranslated(page, 'ar');

  const rtl = page.locator('.painted-region[dir="rtl"]');
  await expect(rtl.first()).toBeVisible({ timeout: 20_000 });
  const text = await rtl.first().innerText();
  expect(ARABIC.test(text)).toBe(true);

  // The region must actually have been laid out, not collapsed to zero width.
  const boxes = await rtl.evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  expect(boxes.some(box => box.width > 10 && box.height > 5)).toBe(true);
});

test('a Chinese target paints CJK regions with wrapped lines', async ({ page }) => {
  await openTranslated(page, 'zh');

  const painted = page.locator('.painted-region');
  await expect(painted.first()).toBeVisible({ timeout: 20_000 });
  const texts = await painted.allInnerTexts();
  const cjk = texts.filter(value => CJK.test(value));
  expect(cjk.length).toBeGreaterThan(0);

  // A long CJK paragraph must wrap instead of overflowing on one line.
  const wrapped = await painted.evaluateAll(elements => elements
    .filter(element => /[\u4e00-\u9fff]/.test(element.textContent ?? ''))
    .map(element => ({ lines: (element.textContent ?? '').split('\n').length, overflow: (element as HTMLElement).scrollHeight > (element as HTMLElement).clientHeight + 1 })));
  expect(wrapped.some(entry => entry.lines > 1)).toBe(true);
  expect(wrapped.every(entry => entry.overflow === false)).toBe(true);
});
