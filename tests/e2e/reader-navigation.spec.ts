import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

// Click-level coverage for reader navigation surfaces that had no browser test of their own:
// outline jumps (A22), full-text search jumps (A23) and reading-position persistence across a
// reload plus library reopen (A25), together with the page-number field and thumbnail strip.
// Every test drives the real app: nothing from src/ is imported or mocked, and the reader's
// real canvas state is asserted before a navigation result is trusted.
const FIXTURE = resolve('tests/fixtures/mirror-field-notes.pdf');
const OUT = resolve('artifacts/reader-navigation');
const PAGE_COUNT = 4;

test.use({ trace: 'off' });

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
});

type FixtureUpload = string | { name: string; mimeType: string; buffer: Buffer };

interface CanvasInk {
  width: number;
  height: number;
  painted: number;
}

interface PageGeometry {
  scrollTop: number;
  rowOffsetTop: number;
  viewportTop: number;
  rowTop: number;
  rowBottom: number;
}

async function pinEnglish(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
}

async function canvasInk(canvas: Locator, stride = 8): Promise<CanvasInk> {
  return canvas.evaluate((node, step) => {
    const source = node as HTMLCanvasElement;
    const { data } = source.getContext('2d')!.getImageData(0, 0, source.width, source.height);
    let painted = 0;
    for (let y = 0; y < source.height; y += step) {
      for (let x = 0; x < source.width; x += step) {
        const index = (y * source.width + x) * 4;
        if (data[index]! < 240 || data[index + 1]! < 240 || data[index + 2]! < 240) painted++;
      }
    }
    return { width: source.width, height: source.height, painted };
  }, stride);
}

// A blank shell must fail loudly. The expected page count plus a painted first-page canvas are
// asserted before any navigation assertion, so a regression that renders an empty reader never
// produces a false pass further down.
async function expectReaderLoaded(page: Page): Promise<void> {
  await expect(page.locator('.page-pair')).toHaveCount(PAGE_COUNT);
  const canvas = page.locator('.page-pair').first().locator('.original-slot canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(node => (node as HTMLCanvasElement).width)).toBeGreaterThan(200);
  const ink = await canvasInk(canvas);
  expect(ink.painted, 'the first page canvas is blank: the reader did not paint the PDF').toBeGreaterThan(400);
  await expect(page.locator('.source-region').first()).toBeVisible();
}

async function openReader(page: Page, upload: FixtureUpload = FIXTURE): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your reading room.' })).toBeVisible();
  await page.locator('#file-input').setInputFiles(upload);
  await expectReaderLoaded(page);
}

async function pageGeometry(page: Page, number: number): Promise<PageGeometry> {
  return page.evaluate(target => {
    const scroll = document.querySelector<HTMLElement>('#reading-scroll');
    const row = document.querySelector<HTMLElement>(`.page-pair[data-page="${target}"]`);
    if (!scroll || !row) throw new Error(`missing reading scroll or page row ${target}`);
    const scrollRect = scroll.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      scrollTop: scroll.scrollTop,
      rowOffsetTop: row.offsetTop,
      viewportTop: scrollRect.top,
      rowTop: rowRect.top,
      rowBottom: rowRect.bottom,
    };
  }, number);
}

// Proves a jump landed: the target row starts at the top of the reading viewport and has real
// height inside it, and the viewport actually scrolled away from page 1.
async function expectPageAtTop(page: Page, number: number): Promise<void> {
  await expect.poll(async () => {
    const geometry = await pageGeometry(page, number);
    return Math.abs(geometry.scrollTop - geometry.rowOffsetTop) <= 2
      && Math.abs(geometry.rowTop - geometry.viewportTop) <= 2;
  }, { timeout: 10_000, message: `page ${number} did not become the page at the top of the reading view` }).toBe(true);
  const settled = await pageGeometry(page, number);
  expect(settled.rowBottom - settled.viewportTop, `page ${number} has no visible height in the reading view`).toBeGreaterThan(120);
  if (number > 1) expect(settled.scrollTop, 'the reading view never scrolled away from page 1').toBeGreaterThan(200);
}

// pdf-lib cannot author bookmarks through its public API, so the outline dictionaries are attached
// to an in-memory copy of the fixture at the object level. The bundled fixture itself has none; the
// buffer is passed straight to #file-input without touching the repository tests/fixtures folder.
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

test('outline: the second bookmark jumps to page 3 and becomes the current entry', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page, await outlinedFixture());
  await expect(page.locator('#page-status')).toHaveText('Page 1 of 4');

  await page.locator('#outline-toggle').click();
  await expect(page.locator('#reader-panel')).toBeVisible();
  await expect(page.locator('#outline-toggle')).toHaveAttribute('aria-expanded', 'true');

  const entries = page.locator('.reader-outline__item[data-page]');
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0)).toContainText('Reading without boundaries');
  await expect(entries.nth(1)).toContainText('A closer look at page 3');
  await expect(entries.nth(0)).toHaveAttribute('aria-current', 'page');

  await entries.nth(1).click();
  await expect(page.locator('#page-input')).toHaveValue('3');
  await expect(page.locator('#page-total')).toHaveText('4');
  await expect(page.locator('#page-status')).toHaveText('Page 3 of 4');
  await expect(entries.nth(1)).toHaveAttribute('aria-current', 'page');
  await expect(entries.nth(0)).not.toHaveAttribute('aria-current', 'page');

  await expectPageAtTop(page, 3);
  await expect(page.locator('.page-pair[data-page="3"] .original-slot canvas')).toBeVisible();
  await page.screenshot({ path: resolve(OUT, '01-outline-jump.png') });
});

test('search: the first result for a later-page word jumps to page 2 and flags the page row', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page);
  await expect(page.locator('#page-status')).toHaveText('Page 1 of 4');

  await page.locator('#search-toggle').click();
  await expect(page.locator('#reader-panel')).toBeVisible();
  await expect(page.locator('#search-toggle')).toHaveAttribute('aria-expanded', 'true');
  const field = page.locator('#reader-panel input[type=search]');
  await expect(field).toBeFocused();
  // "closer" only exists in the titles of pages 2-4, so the first result is page 2: the click proves
  // a real jump instead of a page-1 to page-1 no-op.
  await field.fill('closer');

  const results = page.locator('.reader-search__result');
  await expect(results).toHaveCount(3, { timeout: 20_000 });
  await expect(page.locator('.reader-search__status')).toHaveText('3 results');
  await expect(page.locator('.reader-search__meta').first()).toHaveText('Page 2');
  expect(await results.first().innerText()).toContain('closer');

  await results.first().click();
  const row = page.locator('.page-pair[data-page="2"]');
  await expect(row).toHaveClass(/is-search-hit/, { timeout: 2_000 });
  await expect(page.locator('#page-input')).toHaveValue('2');
  await expect(page.locator('#page-status')).toHaveText('Page 2 of 4');
  await expectPageAtTop(page, 2);
  await expect(row.locator('.original-slot canvas')).toBeVisible();
  await page.screenshot({ path: resolve(OUT, '02-search-jump.png') });
});

test('page input: typing 3 and pressing Enter scrolls the reading view to page 3', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page);
  const initial = await page.evaluate(() => document.querySelector<HTMLElement>('#reading-scroll')!.scrollTop);
  expect(initial, 'the reader did not start at the top of page 1').toBeLessThan(50);
  await expect(page.locator('.page-pair[data-page="1"] .original-slot canvas')).toBeVisible();

  const input = page.locator('#page-input');
  await input.fill('3');
  await input.press('Enter');

  await expect(input).toHaveValue('3');
  await expect(page.locator('#page-status')).toHaveText('Page 3 of 4');
  await expectPageAtTop(page, 3);
  await expect(page.locator('.page-pair[data-page="3"] .original-slot canvas')).toBeVisible();
  await page.screenshot({ path: resolve(OUT, '03-page-input.png') });
});

test('thumbnails: a thumbnail canvas is painted and clicking page 3 jumps there', async ({ page }) => {
  await pinEnglish(page);
  await openReader(page);

  await page.locator('#thumbnails-toggle').click();
  await expect(page.locator('#thumbnails')).toBeVisible();
  await expect(page.locator('#thumbnails-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.reader-thumb')).toHaveCount(PAGE_COUNT);
  const canvases = page.locator('.reader-thumb canvas');
  await expect(canvases).toHaveCount(PAGE_COUNT, { timeout: 20_000 });

  await expect.poll(async () => {
    const ink = await canvasInk(canvases.first(), 4);
    return ink.width > 0 && ink.height > 0 && ink.painted > 50;
  }, { timeout: 20_000, message: 'the first thumbnail canvas was attached but never painted' }).toBe(true);
  const thumbnail = await canvasInk(canvases.first(), 4);
  expect(thumbnail.width, 'the thumbnail canvas has no width').toBeGreaterThanOrEqual(100);
  expect(thumbnail.height, 'the thumbnail canvas has no height').toBeGreaterThanOrEqual(100);

  await page.locator('.reader-thumb[data-page="3"]').click();
  await expect(page.locator('#page-input')).toHaveValue('3');
  await expect(page.locator('#page-status')).toHaveText('Page 3 of 4');
  await expect(page.locator('.reader-thumb[data-page="3"]')).toHaveAttribute('aria-current', 'page');
  await expectPageAtTop(page, 3);
  await expect(page.locator('.page-pair[data-page="3"] .original-slot canvas')).toBeVisible();
  await page.screenshot({ path: resolve(OUT, '04-thumbnail-jump.png') });
});

test('persistence: page 3 and the English UI survive a reload and reopening from the library', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Phòng đọc của bạn.' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');

  await page.locator('.topbar [data-locale=en]').click();
  await expect(page.getByRole('heading', { name: 'Your reading room.' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.evaluate(() => localStorage.getItem('mirror.locale'))).toBe('en');

  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expectReaderLoaded(page);

  await page.locator('#page-input').fill('3');
  await page.locator('#page-input').press('Enter');
  await expect(page.locator('#page-status')).toHaveText('Page 3 of 4');
  await expectPageAtTop(page, 3);

  // The reader saves through a 300 ms debounce; prove the position is already persisted before the
  // reload, then read it back from storage rather than trusting the in-memory UI alone.
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith('mirror.reading-state'))
    .some(([, value]) => {
      try { return (JSON.parse(value) as { page?: number }).page === 3; } catch { return false; }
    })), { timeout: 10_000, message: 'the reader never saved page 3 to localStorage' }).toBe(true);
  const saved = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith('mirror.reading-state'))
    .map(([, value]) => JSON.parse(value) as { page?: number }));
  expect(saved.some(state => state.page === 3)).toBe(true);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your reading room.' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.evaluate(() => localStorage.getItem('mirror.locale'))).toBe('en');

  const card = page.locator('.document-card');
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card).toContainText('mirror-field-notes.pdf');
  await card.click();

  await expectReaderLoaded(page);
  await expect(page.locator('#page-input')).toHaveValue('3');
  await expect(page.locator('#page-status')).toHaveText('Page 3 of 4');
  await expectPageAtTop(page, 3);
  await expect(page.locator('#fit-width')).toHaveText('Fit width');
  await page.screenshot({ path: resolve(OUT, '05-reload-persistence.png') });
});
