import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Browser coverage for two feature-board rows that only had unit or incidental coverage:
//   A01 - open local PDFs, drag and drop, multi-file pick (src/main.ts change/drop handlers).
//   A20 - source-language hint after opening a PDF, which must never overwrite the target choice.
// Nothing from src/ is imported or mocked; every assertion drives the real app in Chromium. Each
// test first proves the four-page fixture really rendered (page rows, painted canvas, extracted
// text regions) so a blank or unrendered app can never produce a false pass later in the test.
const FIXTURE = resolve('tests/fixtures/mirror-field-notes.pdf');
const OUT = resolve('artifacts/reader-import');
const PROVIDER_ENDPOINT = 'http://127.0.0.1:4319/v1';
const SAMPLE_PDF_URL = 'http://127.0.0.1:4319/sample.pdf';
const FIXTURE_NAME = 'mirror-field-notes.pdf';
const FIXTURE_PAGES = 4;
const ALPHA_NAME = 'alpha-import-probe.pdf';
const BETA_NAME = 'beta-import-probe.pdf';
const DROP_NAME = 'dropped-field-notes.pdf';
// detectLanguage() on page 1 of the bundled fixture (all Latin, English prose) yields "en", and
// renderDetectedLanguage() interpolates the native name through the English dictionary.
const ENGLISH_HINT = 'Looks like this document is in English.';

test.use({ trace: 'off' });

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
});

interface Upload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

interface DragProbe {
  dragging: boolean;
  files: number;
}

async function pinEnglish(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
}

async function canvasInk(canvas: Locator): Promise<number> {
  return canvas.evaluate(node => {
    const source = node as HTMLCanvasElement;
    const { data } = source.getContext('2d')!.getImageData(0, 0, source.width, source.height);
    let painted = 0;
    for (let y = 0; y < source.height; y += 8) {
      for (let x = 0; x < source.width; x += 8) {
        const index = (y * source.width + x) * 4;
        if (data[index]! < 240 || data[index + 1]! < 240 || data[index + 2]! < 240) painted++;
      }
    }
    return painted;
  });
}

async function expectCanvasPainted(page: Page, minimum: number): Promise<void> {
  const canvas = page.locator('.page-pair').first().locator('.original-slot canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(node => (node as HTMLCanvasElement).width)).toBeGreaterThan(200);
  const ink = await canvasInk(canvas);
  expect(ink, 'the first page canvas is blank: the reader did not paint the document').toBeGreaterThan(minimum);
}

// The loud "the app really loaded" gate used by every test in this file.
async function expectFixtureLoaded(page: Page): Promise<void> {
  await expect(page.locator('.page-pair')).toHaveCount(FIXTURE_PAGES);
  await expectCanvasPainted(page, 400);
  await expect(page.locator('.source-region').first()).toBeVisible();
}

async function buildOnePagePdf(title: string, body: readonly string[], width: number, height: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.setTitle(title);
  const page = document.addPage([width, height]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  page.drawText(title, { x: 48, y: height - 84, size: 24, font: bold });
  let y = height - 128;
  for (const line of body) {
    page.drawText(line, { x: 48, y, size: 12, font: regular });
    y -= 20;
  }
  page.drawText(`One page at ${width} x ${height} points.`, { x: 48, y: 56, size: 10, font: regular });
  return Buffer.from(await document.save());
}

async function applyFixtureProvider(page: Page): Promise<void> {
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('[name=endpoint]').fill(PROVIDER_ENDPOINT);
  await page.locator('[name=model]').fill('deterministic-test-only');
  await page.locator('#settings-form button[type=submit]').click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
}

test('A01: a two-file pick lands both documents in the library and opens the first one', async ({ page }) => {
  await pinEnglish(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your reading room.' })).toBeVisible();

  // Baseline: the app is alive and can open the bundled fixture, so the import below is the only
  // variable left in the assertion.
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expectFixtureLoaded(page);
  await expect(page.locator('#document-title')).toHaveText(FIXTURE_NAME);

  const alpha = await buildOnePagePdf(
    'Alpha Import Probe',
    [
      'Alpha probe: this one page document exists only for the multi-file import test.',
      'It carries extractable text so the reader builds regions without OCR.',
      'Its page is 600 by 900 points, a different shape from beta.',
    ],
    600,
    900,
  );
  const beta = await buildOnePagePdf(
    'Beta Import Probe',
    [
      'Beta probe: this one page document is the second file in the same pick.',
      'It must appear in the library but must not be the document left open.',
      'Its page is 500 by 500 points, so the open document shape disambiguates.',
    ],
    500,
    500,
  );
  const uploads: Upload[] = [
    { name: ALPHA_NAME, mimeType: 'application/pdf', buffer: alpha },
    { name: BETA_NAME, mimeType: 'application/pdf', buffer: beta },
  ];

  // One change event carrying two Files, exactly what a multi-select in the picker produces.
  await page.locator('#file-input').setInputFiles(uploads);

  // The first selected file must be the one open: title, page count and page geometry all agree.
  await expect(page.locator('#document-title')).toHaveText(ALPHA_NAME);
  await expect(page.locator('#page-total')).toHaveText('1');
  await expect(page.locator('.page-pair')).toHaveCount(1);
  await expect.poll(async () => {
    const ratio = await page.locator('.page-pair').first().evaluate(row =>
      Number.parseFloat((row as HTMLElement).style.getPropertyValue('--page-ratio')));
    return Math.abs(ratio - 600 / 900) < 0.001;
  }, { message: 'the open page is not the 600x900 alpha document' }).toBe(true);
  await expectCanvasPainted(page, 100);
  await page.screenshot({ path: resolve(OUT, 'a01-multi-file-reader.png'), fullPage: true });

  // Both picked files are real library cards; the reverse-load trick keeps the first file on top.
  await page.locator('#library-nav').click();
  await expect(page.locator('#library')).toBeVisible();
  const cards = page.locator('#documents .document-card');
  await expect(cards).toHaveCount(3);
  await expect(page.locator('#document-count')).toHaveText('3');
  await expect(cards.nth(0)).toContainText(ALPHA_NAME);
  await expect(cards.nth(1)).toContainText(BETA_NAME);
  await expect(cards.nth(2)).toContainText(FIXTURE_NAME);
  await expect(cards.nth(0).locator('[data-pages]')).toHaveAttribute('data-pages', '1');
  await expect(cards.nth(1).locator('[data-pages]')).toHaveAttribute('data-pages', '1');
  await page.screenshot({ path: resolve(OUT, 'a01-multi-file-library.png'), fullPage: true });
});

test('A01: a window drop opens the dropped PDF and clears the dragging state', async ({ page, request }) => {
  await pinEnglish(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your reading room.' })).toBeVisible();

  // Baseline: fixture open means a blank app fails here, before the drag simulation runs.
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expectFixtureLoaded(page);
  await expect(page.locator('#document-title')).toHaveText(FIXTURE_NAME);

  // Drop only makes sense on the library, so go back to it.
  await page.locator('#library-nav').click();
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('.drop-zone')).toBeVisible();
  await expect(page.locator('#app')).not.toHaveClass(/\bdragging\b/);

  const response = await request.get(SAMPLE_PDF_URL);
  expect(response.ok(), 'the deterministic provider did not serve /sample.pdf').toBeTruthy();
  const base64 = (await response.body()).toString('base64');

  // A real DataTransfer built in the page, put through the same dragenter/dragover/drop sequence a
  // browser emits. The class the code toggles on #app is observed between the phases.
  const armed = await page.evaluate((payload): DragProbe => {
    const bytes = Uint8Array.from(atob(payload.base64), char => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], payload.name, { type: 'application/pdf' }));
    (window as unknown as { __mirrorDrop?: DataTransfer }).__mirrorDrop = transfer;
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    return {
      dragging: document.querySelector('#app')!.classList.contains('dragging'),
      files: transfer.files.length,
    };
  }, { base64, name: DROP_NAME });
  expect(armed.files).toBe(1);
  expect(armed.dragging, 'dragover did not mark the drop zone as dragging').toBe(true);
  await expect(page.locator('#app')).toHaveClass(/\bdragging\b/);

  const stillDragging = await page.evaluate(() => {
    const transfer = (window as unknown as { __mirrorDrop?: DataTransfer }).__mirrorDrop;
    if (!transfer) throw new Error('the synthetic DataTransfer disappeared between events');
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    return document.querySelector('#app')!.classList.contains('dragging');
  });
  expect(stillDragging, 'drop left the dragging state on the app root').toBe(false);
  await expect(page.locator('#app')).not.toHaveClass(/\bdragging\b/);

  // The dropped file is the document actually opened, with real pages and a painted canvas.
  await expect(page.locator('#document-title')).toHaveText(DROP_NAME);
  await expect(page.locator('.page-pair')).toHaveCount(FIXTURE_PAGES);
  await expectCanvasPainted(page, 400);
  await page.screenshot({ path: resolve(OUT, 'a01-drop-opened.png'), fullPage: true });

  // The drop also imported the document, not just displayed it.
  await page.locator('#library-nav').click();
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('#documents .document-card').filter({ hasText: DROP_NAME })).toHaveCount(1);
});

test('A20: the source-language hint never overwrites the target language choice', async ({ page }) => {
  await pinEnglish(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your reading room.' })).toBeVisible();

  // The user's target choice on a fresh profile is Vietnamese (the product default). It is read
  // before detection so a later mismatch is unambiguously the hint overwriting it.
  await expect(page.locator('#detected-language')).toBeHidden();
  const targetChoice = await page.locator('#target-language').evaluate(select => (select as HTMLSelectElement).value);
  expect(targetChoice).toBe('vi');

  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expectFixtureLoaded(page);
  await expect(page.locator('#document-title')).toHaveText(FIXTURE_NAME);

  // Configure the deterministic provider (the local reader still detects the source language itself).
  await applyFixtureProvider(page);

  const hint = page.locator('#detected-language');
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText(ENGLISH_HINT);
  const hintText = (await hint.innerText()).trim();
  expect(hintText.length, 'the language hint is empty').toBeGreaterThan(0);
  expect(hintText, 'the hint does not name a language').toContain('English');

  // Hint landed, target select untouched.
  await expect(page.locator('#target-language')).toHaveValue(targetChoice);
  await expect(page.locator('#provider-label')).toContainText('Tiếng Việt');
  await page.screenshot({ path: resolve(OUT, 'a20-language-hint.png'), fullPage: true });

  // Manual change after the hint is shown: the hint must not fight/clear the new choice.
  await page.locator('#target-language').selectOption('ja');
  await expect(page.locator('#target-language')).toHaveValue('ja');
  await expect(page.locator('#provider-label')).toContainText('日本語');
  await page.waitForTimeout(750);
  await expect(hint).toHaveText(ENGLISH_HINT);
  await expect(page.locator('#target-language')).toHaveValue('ja');

  // Strongest form of the invariant: reopen the same PDF, which runs detection again from scratch,
  // and the deliberate choice must survive the fresh hint.
  await page.locator('#library-nav').click();
  await expect(page.locator('#library')).toBeVisible();
  await page.locator('#documents .document-card').filter({ hasText: FIXTURE_NAME }).click();
  await expectFixtureLoaded(page);
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText(ENGLISH_HINT);
  await expect(page.locator('#target-language')).toHaveValue('ja');
  await page.screenshot({ path: resolve(OUT, 'a20-language-hint-reopened.png'), fullPage: true });
});
