import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

const FIXTURE = resolve('tests/fixtures/mirror-field-notes.pdf');
const OUT = resolve('artifacts/journeys');
const PROVIDER_ENDPOINT = 'http://127.0.0.1:4319/v1';
const PROVIDER_URL = 'http://127.0.0.1:4319/v1/chat/completions';
const PROVIDER_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

// Click-through journeys against the real app. Nothing in src/ is mocked or imported.
// Journey 06 derives an outline-carrying copy of the bundled fixture in memory because the
// bundled fixture itself has no PDF bookmarks; setInputFiles takes that buffer directly.
test.use({ trace: 'off' });

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
});

type FixtureUpload = string | { name: string; mimeType: string; buffer: Buffer };

interface Geometry {
  ratio: number;
  width: number;
  height: number;
}

interface StatusCounts {
  regions: number;
  characters: number;
}

async function pinEnglish(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
}

async function expectPdfRendered(page: Page): Promise<void> {
  await expect(page.locator('.page-pair')).toHaveCount(4);
  const canvas = page.locator('.original-slot canvas').first();
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(node => (node as HTMLCanvasElement).width)).toBeGreaterThan(200);
  const ink = await canvas.evaluate(node => {
    const source = node as HTMLCanvasElement;
    const context = source.getContext('2d')!;
    const { data } = context.getImageData(0, 0, source.width, source.height);
    let painted = 0;
    for (let y = 0; y < source.height; y += 8) {
      for (let x = 0; x < source.width; x += 8) {
        const index = (y * source.width + x) * 4;
        if (data[index]! < 240 || data[index + 1]! < 240 || data[index + 2]! < 240) painted++;
      }
    }
    return painted;
  });
  expect(ink, 'the first page canvas is blank: the reader did not paint the PDF').toBeGreaterThan(500);
  await expect(page.locator('.source-region').first()).toBeVisible();
}

async function openReader(page: Page, upload: FixtureUpload = FIXTURE): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your reading room.' })).toBeVisible();
  await page.locator('#file-input').setInputFiles(upload);
  await expectPdfRendered(page);
}

async function applyFixtureProvider(page: Page, glossary?: string): Promise<void> {
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('[name=endpoint]').fill(PROVIDER_ENDPOINT);
  await page.locator('[name=model]').fill('deterministic-test-only');
  if (glossary !== undefined) await page.locator('[name=glossary]').fill(glossary);
  await page.locator('#settings-form button[type=submit]').click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
}

async function translateVisible(page: Page): Promise<void> {
  await applyFixtureProvider(page);
  await expect(page.locator('.translated-slot .painted-region').filter({ hasText: 'Đọc không còn rào cản' }).first()).toBeVisible({ timeout: 20_000 });
}

// Translation completions rewrite the status bar, so wait for that text to stop changing
// before asserting a status message that a late completion could otherwise replace.
async function waitForTranslationSettled(page: Page): Promise<void> {
  await expect.poll(async () => {
    const text = await page.locator('#status').innerText();
    await page.waitForTimeout(400);
    return (await page.locator('#status').innerText()) === text;
  }, { timeout: 20_000 }).toBe(true);
  await expect(page.locator('#status')).not.toHaveClass(/is-error/);
}

async function snap(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(OUT, name) });
}

function statusCounts(text: string): StatusCounts | null {
  const match = text.match(/(\d+) regions translated · (\d+) characters sent/);
  return match ? { regions: Number(match[1]), characters: Number(match[2]) } : null;
}

function parsePercent(label: string): number {
  return Number.parseFloat(label.replace('%', ''));
}

async function zoomPercent(page: Page): Promise<number> {
  return parsePercent(await page.locator('#zoom-label').innerText());
}

async function pageGeometry(page: Page): Promise<Geometry> {
  return page.locator('.page-pair').first().evaluate(row => {
    const canvas = row.querySelector<HTMLCanvasElement>('.original-slot canvas');
    if (!canvas) throw new Error('page canvas is missing');
    return {
      ratio: Number.parseFloat(getComputedStyle(row).getPropertyValue('--page-ratio')),
      width: canvas.width,
      height: canvas.height,
    };
  });
}

async function waitForLandscape(page: Page, landscape: boolean): Promise<void> {
  await expect.poll(async () => {
    const geometry = await pageGeometry(page);
    return geometry.width > geometry.height;
  }, { timeout: 20_000 }).toBe(landscape);
}

// pdf-lib cannot author bookmarks through its public API, so the outline dictionaries are
// attached to a copy of the fixture at the object level. The PDF bytes stay in memory.
async function outlinedFixture(): Promise<FixtureUpload> {
  const document = await PDFDocument.load(await readFile(FIXTURE));
  const pages = document.getPages();
  const outlinesRef = document.context.nextRef();
  const refs = [document.context.nextRef(), document.context.nextRef(), document.context.nextRef()];
  const entries = [
    { title: 'Reading without boundaries', pageIndex: 0 },
    { title: 'A closer look at page 3', pageIndex: 2 },
    { title: 'A closer look at page 4', pageIndex: 3 },
  ];
  entries.forEach((entry, index) => {
    document.context.assign(refs[index]!, document.context.obj({
      Title: PDFString.of(entry.title),
      Parent: outlinesRef,
      Dest: document.context.obj([pages[entry.pageIndex]!.ref, PDFName.of('Fit')]),
      ...(index > 0 ? { Prev: refs[index - 1]! } : {}),
      ...(index < refs.length - 1 ? { Next: refs[index + 1]! } : {}),
    }));
  });
  document.context.assign(outlinesRef, document.context.obj({
    Type: PDFName.of('Outlines'),
    First: refs[0]!,
    Last: refs[refs.length - 1]!,
    Count: refs.length,
  }));
  document.catalog.set(PDFName.of('Outlines'), outlinesRef);
  return { name: 'mirror-field-notes-outline.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await document.save()) };
}

test('journey 01 opens a PDF, translates the visible page and reports a character count', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page);
  await translateVisible(page);

  await expect.poll(async () => statusCounts(await page.locator('#status').innerText()) !== null, { timeout: 20_000 }).toBe(true);
  const counts = statusCounts(await page.locator('#status').innerText())!;
  expect(counts.regions, 'the status bar must report translated regions').toBeGreaterThan(0);
  expect(counts.characters, 'the status bar must report characters sent to the provider').toBeGreaterThan(0);

  await expect(page.locator('.translated-slot .painted-region').filter({ hasText: 'Đọc không còn rào cản' }).first()).toBeVisible();
  await snap(page, '01-open-translate.png');
});

test('journey 02 pause stops the queue and resume continues it', async ({ page }) => {
  await pinEnglish(page);
  // Keep the untouched default endpoint from translating before the pause click, even on a
  // machine that happens to run a local model server on the default port.
  await page.route('http://127.0.0.1:11434/**', route => route.abort());
  await openReader(page);
  await page.waitForTimeout(900);

  await page.locator('#pause').click();
  await expect(page.locator('#pause')).toHaveText('Resume');
  await applyFixtureProvider(page);
  await page.waitForTimeout(1500);
  await expect(page.locator('.painted-region')).toHaveCount(0);

  await page.locator('#pause').click();
  await expect(page.locator('#pause')).toHaveText('Pause');
  await expect(page.locator('.translated-slot .painted-region').filter({ hasText: 'Đọc không còn rào cản' }).first()).toBeVisible({ timeout: 20_000 });
  await snap(page, '02-pause-resume.png');
});

test('journey 03 a provider error is shown and Retry recovers', async ({ page }) => {
  await pinEnglish(page);
  await page.route(PROVIDER_URL, async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 400, headers: PROVIDER_CORS, contentType: 'application/json', body: '{"error":"journey fixture failure"}' });
  });
  await openReader(page);
  await applyFixtureProvider(page);

  await expect(page.locator('#status')).toHaveClass(/is-error/, { timeout: 20_000 });
  await expect(page.locator('#status')).not.toHaveText('');
  // Rendered pages ahead of the viewport are not scheduled, so wait for the failed-region
  // count to settle instead of expecting it to equal every rendered region.
  await expect.poll(async () => {
    const failed = await page.locator('.failed-region').count();
    if (failed === 0) return false;
    await page.waitForTimeout(400);
    return (await page.locator('.failed-region').count()) === failed;
  }, { timeout: 20_000 }).toBe(true);
  await expect(page.locator('.painted-region')).toHaveCount(0);

  await page.unroute(PROVIDER_URL);
  await page.locator('#retry').click();
  await expect(page.locator('.translated-slot .painted-region').filter({ hasText: 'Đọc không còn rào cản' }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#status')).not.toHaveClass(/is-error/);
  await snap(page, '03-provider-retry.png');
});

// KNOWN ISSUE: at 90° and 270° the rotated block boxes are taller than wide, so fitText
// overflows and paintMirror degrades most regions to invisible callouts. The journey still
// runs and asserts the requested behavior, but it is expected to fail until rotation paints
// translated text. Remove `.fail` to turn this into a hard regression gate.
test('journey 04 rotates 90, 180, 270 and back, changing geometry and keeping translations painted', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page);
  await translateVisible(page);

  const initial = await pageGeometry(page);
  expect(initial.width).toBeLessThan(initial.height);
  expect(initial.ratio).toBeCloseTo(612 / 792, 2);
  await expect(page.locator('.page-pair').first().locator('.painted-region').filter({ hasText: 'Đọc không còn rào cản' }).first()).toBeVisible();

  const steps: { degrees: number; titlePainted: boolean; ratio: number }[] = [];
  for (const degrees of [90, 180, 270, 360]) {
    await page.locator('#rotate').click();
    const landscape = degrees % 180 === 90;
    await waitForLandscape(page, landscape);
    await expect(page.locator('.page-pair').first().locator('.painted-region').first()).toBeVisible({ timeout: 20_000 });
    const title = page.locator('.page-pair').first().locator('.painted-region').filter({ hasText: 'Đọc không còn rào cản' }).first();
    const titlePainted = await title.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    const geometry = await pageGeometry(page);
    expect(geometry.ratio).toBeCloseTo(landscape ? 792 / 612 : 612 / 792, 2);
    steps.push({ degrees, titlePainted, ratio: geometry.ratio });
    if (degrees === 90) await snap(page, '04-rotate-90.png');
  }

  const unpainted = steps.filter(step => !step.titlePainted).map(step => step.degrees);
  const detail = steps.map(step => `${step.degrees}°: painted-title=${step.titlePainted}, ratio=${step.ratio}`).join(' | ');
  expect(unpainted, `the page-1 title translation is no longer painted after rotating; unpainted at ${unpainted.join(', ')}° (${detail})`).toEqual([]);
});

test('journey 05 fit width and fit page set different zoom values', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page);

  await page.locator('#fit-width').click();
  await expect(page.locator('#fit-width')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#fit-page')).toHaveAttribute('aria-pressed', 'false');
  const widthZoom = await zoomPercent(page);

  await page.locator('#fit-page').click();
  await expect(page.locator('#fit-page')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#fit-width')).toHaveAttribute('aria-pressed', 'false');
  const pageZoom = await zoomPercent(page);

  expect(widthZoom).toBeGreaterThanOrEqual(90);
  expect(pageZoom).toBeLessThan(widthZoom);
  await snap(page, '05-fit-modes.png');
});

test('journey 06 the outline panel jumps to a page and the page counter follows', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page, await outlinedFixture());

  await page.locator('#outline-toggle').click();
  await expect(page.locator('#reader-panel')).toBeVisible();
  await expect(page.locator('#outline-toggle')).toHaveAttribute('aria-expanded', 'true');
  const entries = page.locator('.reader-outline__item[data-page]');
  await expect(entries).toHaveCount(3);

  await entries.nth(1).click();
  await expect(page.locator('#page-input')).toHaveValue('3');
  await expect(page.locator('#page-total')).toHaveText('4');
  await expect(page.locator('#page-status')).toHaveText('Page 3 of 4');
  await expect(page.locator('.reader-outline__item[data-page="3"]')).toHaveAttribute('aria-current', 'page');
  await snap(page, '06-outline-jump.png');
});

test('journey 07 search finds a word from page 1 and a result click jumps', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page);

  await page.locator('#search-toggle').click();
  await expect(page.locator('#search-toggle')).toHaveAttribute('aria-expanded', 'true');
  const field = page.locator('#reader-panel input[type=search]');
  await field.fill('Scientific reading');

  const results = page.locator('.reader-search__result');
  await expect(results).toHaveCount(4, { timeout: 20_000 });
  await expect(page.locator('.reader-search__status')).toHaveText('4 results');
  await expect(page.locator('.reader-search__meta').first()).toHaveText('Page 1');

  await results.nth(2).click();
  await expect(page.locator('#page-input')).toHaveValue('3');
  await expect(page.locator('#page-status')).toHaveText('Page 3 of 4');
  await snap(page, '07-search-jump.png');
});

test('journey 08 thumbnails open and a thumbnail click jumps', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page);

  await page.locator('#thumbnails-toggle').click();
  await expect(page.locator('#thumbnails')).toBeVisible();
  await expect(page.locator('#thumbnails-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.reader-thumb')).toHaveCount(4);
  await expect(page.locator('.reader-thumb canvas')).toHaveCount(4, { timeout: 20_000 });

  await page.locator('.reader-thumb').nth(3).click();
  await expect(page.locator('#page-input')).toHaveValue('4');
  await expect(page.locator('#page-status')).toHaveText('Page 4 of 4');
  await expect(page.locator('.reader-thumb[data-page="4"]')).toHaveAttribute('aria-current', 'page');
  await snap(page, '08-thumbnails-jump.png');
});

test('journey 09 typing a page number and pressing Enter jumps', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page);

  await page.locator('#page-input').fill('2');
  await page.locator('#page-input').press('Enter');
  await expect(page.locator('#page-input')).toHaveValue('2');
  await expect(page.locator('#page-status')).toHaveText('Page 2 of 4');
  await snap(page, '09-page-input.png');
});

test('journey 10 j and k scroll pages, plus and minus zoom, Ctrl+F searches and Escape closes', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page);
  await page.locator('#document-title').click();

  await page.keyboard.press('j');
  await expect(page.locator('#page-input')).toHaveValue('2');
  await page.keyboard.press('j');
  await expect(page.locator('#page-input')).toHaveValue('3');
  await page.keyboard.press('k');
  await expect(page.locator('#page-input')).toHaveValue('2');

  const zoom = await zoomPercent(page);
  await page.keyboard.press('+');
  await expect.poll(() => zoomPercent(page)).toBeGreaterThan(zoom);
  await page.keyboard.press('-');
  await expect.poll(() => zoomPercent(page)).toBe(zoom);

  await page.keyboard.press('Control+f');
  await expect(page.locator('#reader-panel')).toBeVisible();
  await expect(page.locator('#search-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#reader-panel input[type=search]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#reader-panel')).toBeHidden();
  await expect(page.locator('#search-toggle')).toHaveAttribute('aria-expanded', 'false');
  await snap(page, '10-keyboard.png');
});

test('journey 11 a glossary entry is applied, reaches the provider request and stays error-free', async ({ page }) => {
  await pinEnglish(page);
  const bodies: string[] = [];
  page.on('request', request => {
    if (request.url() === PROVIDER_URL && request.method() === 'POST') bodies.push(request.postData() ?? '');
  });
  await openReader(page);
  await applyFixtureProvider(page, 'AI = trí tuệ nhân tạo');

  await expect(page.locator('.translated-slot .painted-region').filter({ hasText: 'Đọc không còn rào cản' }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#status')).not.toHaveClass(/is-error/);
  await expect.poll(() => bodies.length, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => bodies.some(body => body.includes('AI = trí tuệ nhân tạo'))).toBe(true);
  expect(bodies.some(body => body.includes('Glossary:'))).toBe(true);
  await snap(page, '11-glossary-request.png');
});

test('journey 12 the bilingual export control produces a translated download', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page);
  await translateVisible(page);
  await waitForTranslationSettled(page);

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
  await expect(page.locator('#status')).toContainText(/Exported \d+ pages?/);
  await snap(page, '12-export-download.png');
});

test('journey 13 progress and locale survive a reload and the library card reopens the saved page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Phòng đọc của bạn.' })).toBeVisible();
  await page.locator('.topbar [data-locale=en]').click();
  await expect(page.getByRole('heading', { name: 'Your reading room.' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expectPdfRendered(page);

  for (const number of [2, 3]) {
    await page.locator('#page-input').fill(String(number));
    await page.locator('#page-input').press('Enter');
    await expect(page.locator('#page-status')).toHaveText(`Page ${number} of 4`);
  }
  await page.waitForTimeout(900);

  const saved = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith('mirror.reading-state'))
    .map(([, value]) => JSON.parse(value) as { page?: number }));
  expect(saved.length).toBeGreaterThan(0);
  expect(saved.some(state => state.page === 3)).toBe(true);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your reading room.' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const card = page.locator('.document-card');
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card).toContainText('mirror-field-notes.pdf');
  await card.click();
  await expectPdfRendered(page);

  await expect(page.locator('#page-input')).toHaveValue('3');
  await expect(page.locator('#page-status')).toHaveText('Page 3 of 4');
  await expect(page.locator('#fit-width')).toHaveText('Fit width');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await snap(page, '13-reload-persistence.png');
});
