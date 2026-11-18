import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Board rows B06 (extension capture chain) and A07 (linked view), driven through
 * the real MV3 extension built into dist/extension.
 *
 * What is real in these tests:
 *  - the service worker from dist/extension/background.js and its message router;
 *  - a real popup document (chrome-extension://.../popup.html, opened in an
 *    inactive tab) sends the same mirror:open-capture request extension/popup.ts
 *    sends after a visible-tab capture;
 *  - the capture viewer opens with ?capture=1, asks the background for
 *    mirror:get-capture, runs Tesseract over the PNG, and translates each block
 *    through the background's mirror:translate handler;
 *  - the source tab is the real fixture PDF served by scripts/test-provider.mjs,
 *    and the automatic mirror opens through the extension's own detector;
 *  - A07 scrolls the source document and lets extension/content.ts send its real
 *    mirror:view-state message; no message is synthesized by the test.
 *
 * The one seam: extension/background.ts cannot fire chrome.commands shortcuts
 * from a test process, and chrome.tabs.captureVisibleTab needs an activeTab grant
 * that only a real browser gesture provides. So the PNG is captured with
 * Playwright's screenshot of the already-visible PDF tab (the same pixels Chrome
 * would hand the background) and delivered through the real router message.
 *
 * Provider note: the reader defaults to http://127.0.0.1:11434/v1, and
 * background.ts creates its transport with the global fetch captured at module
 * evaluation, so the test redirects that one origin to the deterministic fixture
 * provider at 127.0.0.1:4319 at the network layer. No product source changes.
 */
test.use({ trace: 'off' });

const EXTENSION = resolve('dist/extension');
const PROVIDER_ORIGIN = 'http://127.0.0.1:4319';
const PROVIDER_METRICS = `${PROVIDER_ORIGIN}/metrics`;
const FIXTURE_PDF = `${PROVIDER_ORIGIN}/sample.pdf`;
const DEFAULT_LOCAL_ENDPOINT = 'http://127.0.0.1:11434';
const OUT = 'artifacts/extension-capture';

interface Launch {
  context: BrowserContext;
  worker: Worker;
  routed: { count: number };
}

function isCaptureUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.get('capture') === '1';
  } catch {
    return false;
  }
}

function isMirrorUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'chrome-extension:'
      && parsed.pathname.endsWith('/index.html')
      && parsed.searchParams.has('sourceTab')
      && parsed.searchParams.get('capture') === null;
  } catch {
    return false;
  }
}

async function launchExtension(): Promise<Launch> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const routed = { count: 0 };
  await context.route(`${DEFAULT_LOCAL_ENDPOINT}/**`, async route => {
    routed.count += 1;
    await route.continue({ url: `${PROVIDER_ORIGIN}${new URL(route.request().url()).pathname}` });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => { await chrome.storage.local.set({ 'mirror:enabled': true }); });
  return { context, worker, routed };
}

async function waitForOne(context: BrowserContext, predicate: (url: string) => boolean, timeout = 20_000): Promise<Page> {
  await expect.poll(() => context.pages().filter(page => predicate(page.url())).length, { timeout }).toBe(1);
  const page = context.pages().find(candidate => predicate(candidate.url()));
  if (!page) throw new Error('The expected extension page did not open.');
  return page;
}

async function providerRequests(context: BrowserContext): Promise<number> {
  const response = await context.request.get(PROVIDER_METRICS);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { requests: number }).requests;
}

async function openPopupInBackground(context: BrowserContext, worker: Worker): Promise<Page> {
  const popupUrl = await worker.evaluate(() => chrome.runtime.getURL('popup.html'));
  await worker.evaluate(async url => { await chrome.tabs.create({ url, active: false }); }, popupUrl);
  const popup = await waitForOne(context, url => url === popupUrl, 15_000);
  await popup.waitForLoadState();
  // popup.ts renders the toggle synchronously once its module has executed.
  await popup.waitForFunction(() => (document.querySelector('#toggle')?.textContent ?? '').length > 0);
  return popup;
}

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

/**
 * A source page that renders four numbered pages and embeds the fixture PDF,
 * which is how the extension is meant to be discovered on a web page. The
 * content script's scroll listener reads [data-page-number], so scrolling here
 * exercises the production mirror:view-state path.
 */
async function startFixtureServer(): Promise<FixtureServer> {
  const pdf = await readFile(resolve('tests/fixtures/mirror-field-notes.pdf'));
  const sections = Array.from({ length: 4 }, (_, index) => {
    const number = index + 1;
    return `<section data-page-number="${number}" style="height:900px;border-bottom:4px solid #333;font:700 60px sans-serif;padding:40px">Page ${number}</section>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><title>Embedded PDF fixture</title><body style="margin:0">${sections}<embed type="application/pdf" src="/sample.pdf" width="600" height="800"></body>`;
  const server = createServer((request, response) => {
    if (request.url === '/sample.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end(pdf);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((listening, failed) => {
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => listening());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The fixture server did not expose a port.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((closed, failed) => server.close(error => error ? failed(error) : closed())),
  };
}

async function scrollSourceTo(source: Page, number: number): Promise<void> {
  await source.evaluate(pageNumber => {
    const target = document.querySelector<HTMLElement>(`[data-page-number="${pageNumber}"]`);
    if (!target) throw new Error(`The fixture has no page ${pageNumber}.`);
    window.scrollTo(0, target.offsetTop + 20);
  }, number);
}

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true });
  for (const asset of [
    'dist/extension/manifest.json',
    'dist/extension/background.js',
    'dist/extension/ocr/worker.min.js',
    'dist/extension/ocr/eng.traineddata',
    'tests/fixtures/mirror-field-notes.pdf',
  ]) {
    expect(existsSync(resolve(asset)), `${asset} is missing; run node scripts/build-extension.mjs`).toBe(true);
  }
});

test('B06: one ?capture=1 viewer OCRs the visible PDF tab and translates a card', async () => {
  test.setTimeout(240_000);
  const { context, worker, routed } = await launchExtension();
  try {
    const source = await context.newPage();
    await source.setViewportSize({ width: 1200, height: 800 });
    await source.goto(FIXTURE_PDF);

    // The PDF tab is detected and mirrored automatically; wait for that viewer so
    // it cannot activate itself later and race the capture request.
    await waitForOne(context, isMirrorUrl, 25_000);
    await source.bringToFront();

    // Chrome would capture the visible tab here; a Playwright screenshot of the
    // same active tab produces those pixels without the user-gesture grant.
    // The embedded PDF viewer paints after navigation commits, so wait until the
    // tab yields real pixels: a blank page compresses to a few kilobytes, while
    // the rendered fixture page is ~100 KB.
    await expect.poll(async () => (await source.screenshot({ type: 'png' })).length, { timeout: 30_000 }).toBeGreaterThan(20_000);
    const png = await source.screenshot({ type: 'png' });
    expect(png.length).toBeGreaterThan(20_000);
    await source.screenshot({ path: `${OUT}/b06-source-pdf-tab.png` });

    const sourceTabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
    if (sourceTabId === undefined) throw new Error('No active source tab to capture.');

    const popup = await openPopupInBackground(context, worker);
    const before = await providerRequests(context);
    const reply = await popup.evaluate(async (args: { sourceTabId: number; image: string }) => {
      return await chrome.runtime.sendMessage({ type: 'mirror:open-capture', sourceTabId: args.sourceTabId, image: args.image });
    }, { sourceTabId, image: `data:image/png;base64,${png.toString('base64')}` }) as
      { ok?: boolean; viewerTabId?: number; error?: string } | undefined;
    expect(reply?.ok, reply?.error).toBe(true);

    const captureViewer = await waitForOne(context, isCaptureUrl, 20_000);
    await captureViewer.waitForLoadState();
    expect(new URL(captureViewer.url()).searchParams.get('sourceTab')).toBe(String(sourceTabId));

    // Prove the capture reader itself mounted before asserting OCR content.
    await expect(captureViewer.locator('.capture-reader')).toBeVisible();
    await expect(captureViewer.locator('#capture-error')).toBeHidden();
    const sources = captureViewer.locator('.capture-card__source');
    await expect(sources.first()).toBeVisible({ timeout: 180_000 });
    await expect(captureViewer.locator('#capture-image')).toBeVisible();
    const imageWidth = await captureViewer.locator('#capture-image').evaluate(image => (image as HTMLImageElement).naturalWidth);
    expect(imageWidth).toBeGreaterThan(500);

    // OCR pipeline: every recognized block has both a card and an overlay region.
    const cardCount = await captureViewer.locator('.capture-card').count();
    expect(cardCount).toBeGreaterThan(5);
    await expect(captureViewer.locator('.capture-region')).toHaveCount(cardCount);
    const recognized = (await sources.allInnerTexts()).join('\n');
    expect(recognized).toMatch(/reading without boundaries/i);
    expect(recognized).toMatch(/scientific reading depends on context|evidence remains visible|results and discussion/i);

    // At least one translated card reaches the done state through the real
    // background mirror:translate handler and the deterministic provider.
    const done = captureViewer.locator('.capture-card[data-state="done"]');
    await expect(done.first()).toBeVisible({ timeout: 90_000 });
    const translations = await done.locator('.capture-card__translation').allInnerTexts();
    expect(translations.some(text => /Đọc không còn rào cản|Bản dịch kiểm thử/.test(text))).toBe(true);
    expect(routed.count).toBeGreaterThan(0);
    expect(await providerRequests(context)).toBeGreaterThan(before);

    // The router must not have opened a second capture viewer.
    expect(context.pages().filter(page => isCaptureUrl(page.url()))).toHaveLength(1);
    await captureViewer.screenshot({ path: `${OUT}/b06-capture-viewer.png`, fullPage: true });
  } finally {
    await context.close();
  }
});

test('A07: the mirror viewer follows the source tab page through mirror:view-state', async () => {
  test.setTimeout(180_000);
  const server = await startFixtureServer();
  const { context, worker } = await launchExtension();
  try {
    const source = await context.newPage();
    await source.setViewportSize({ width: 1200, height: 800 });
    const sourceUrl = `${server.origin}/fixture`;
    await source.goto(sourceUrl);

    const sourceTabId = await worker.evaluate(async url => {
      const tabs = await chrome.tabs.query({});
      return tabs.find(tab => tab.url === url)?.id;
    }, sourceUrl);
    if (sourceTabId === undefined) throw new Error('The fixture source tab was not registered.');

    const viewer = await waitForOne(context, isMirrorUrl, 25_000);
    await viewer.waitForLoadState();
    expect(new URL(viewer.url()).searchParams.get('sourceTab')).toBe(String(sourceTabId));

    // Prove the real reader mounted: four canvases/tiles for the four-page fixture.
    await expect(viewer.locator('.original-slot canvas').first()).toBeVisible();
    await expect(viewer.locator('.page-pair')).toHaveCount(4);
    await expect(viewer.locator('#page-input')).toHaveValue('1');

    // Move the source document to page 3; content.ts sends its real
    // mirror:view-state message and the viewer applies it.
    await source.bringToFront();
    await scrollSourceTo(source, 3);
    await expect.poll(() => viewer.locator('#page-input').inputValue(), { timeout: 20_000 }).toBe('3');
    await expect(viewer.locator('#page-status')).toContainText('3');
    const scrollTop = await viewer.locator('#reading-scroll').evaluate(element => element.scrollTop);
    const rowTop = await viewer.locator('.page-pair[data-page="3"]').evaluate(element => (element as HTMLElement).offsetTop);
    expect(Math.abs(scrollTop - rowTop)).toBeLessThan(200);

    // A second move proves the link keeps following rather than jumping once.
    await scrollSourceTo(source, 4);
    await expect.poll(() => viewer.locator('#page-input').inputValue(), { timeout: 20_000 }).toBe('4');

    await viewer.screenshot({ path: `${OUT}/a07-linked-viewer.png` });
    await source.screenshot({ path: `${OUT}/a07-source-fixture.png` });
  } finally {
    await context.close();
    await server.close();
  }
});
