import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Board row B04: the extension popup's target language must reach the reader.
 *
 * The popup writes exactly one preference, `mirror:targetLanguage`, holding the
 * plain code from SUPPORTED_TARGETS (extension/target-language.ts declares
 * TARGET_LANGUAGE_KEY and saveTargetLanguage; extension/popup.ts calls
 * initTargetLanguage on #target-language). This spec loads the real MV3 build
 * from dist/extension, seeds that key through chrome.storage.local exactly as
 * the popup does, and then lets the extension's own detector open the mirror
 * viewer for a real PDF served by the deterministic provider.
 *
 * Happy path (test 1) proves, in order:
 *  - the viewer really mounted: four .page-pair rows, a painted canvas, total 4;
 *  - the toolbar #target-language select and #provider-label show the seeded
 *    language, not the Vietnamese default;
 *  - the reader auto-translates the visible page and the request that leaves
 *    the extension carries the chosen target in its system prompt, so the
 *    preference reached the translator, not just the toolbar;
 *  - the deterministic provider's request counter moved.
 *
 * Fallback (test 2) proves:
 *  - a second non-default language ('ja') reaches a freshly opened viewer;
 *  - after storing an unsupported code and reloading the same viewer tab, the
 *    select, option and provider label fall back to the Vietnamese default;
 *  - no error state is painted, nothing throws, and the reloaded reader still
 *    translates — its provider prompt names Vietnamese, not the old Japanese.
 *
 * Seam: the reader defaults to http://127.0.0.1:11434/v1, and
 * extension/background.ts creates its translation transport at module
 * evaluation, so the test redirects only that origin to the deterministic
 * fixture provider on 127.0.0.1:4319 at the network layer — the same seam
 * tests/e2e/extension-capture.spec.ts documents. No product source is changed.
 */
test.use({ trace: 'off' });

const EXTENSION = resolve('dist/extension');
const PROVIDER = 'http://127.0.0.1:4319';
const METRICS = `${PROVIDER}/metrics`;
const PDF = `${PROVIDER}/sample.pdf`;
const READER_DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
const TARGET_LANGUAGE_KEY = 'mirror:targetLanguage';
const DEFAULT_TARGET_LANGUAGE = 'vi';
const OUT = 'artifacts/extension-language';

interface Launch {
  context: BrowserContext;
  worker: Worker;
  /** Raw POST bodies the reader sent towards the provider, in arrival order. */
  bodies: string[];
}

function isViewerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'chrome-extension:'
      && url.pathname.endsWith('/index.html')
      && url.searchParams.has('sourceTab')
      && url.searchParams.get('capture') === null;
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
  const bodies: string[] = [];
  await context.route(`${READER_DEFAULT_ENDPOINT}/**`, async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postData();
      if (body) bodies.push(body);
    }
    await route.continue({ url: `${PROVIDER}${new URL(request.url()).pathname}` });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  return { context, worker, bodies };
}

/** Same storage surface the popup uses: chrome.storage.local under the popup key. */
async function seedTargetLanguage(worker: Worker, value: unknown): Promise<void> {
  await worker.evaluate(async (next: Record<string, unknown>) => {
    await chrome.storage.local.set(next);
  }, { 'mirror:enabled': true, [TARGET_LANGUAGE_KEY]: value });
}

async function openSourcePdf(context: BrowserContext): Promise<Page> {
  const source = await context.newPage();
  await source.goto(PDF).catch(() => {});
  await expect.poll(
    () => context.pages().filter(page => isViewerUrl(page.url())).length,
    { timeout: 30_000, message: 'the extension never opened a mirror viewer for the PDF tab' },
  ).toBe(1);
  const viewer = context.pages().find(page => isViewerUrl(page.url()));
  if (!viewer) throw new Error('The mirror viewer disappeared before it could be inspected.');
  return viewer;
}

/** Fails loudly on a blank app: painted canvas plus four real page rows. */
async function proveReaderLoaded(viewer: Page): Promise<void> {
  await viewer.waitForLoadState();
  await expect(viewer.locator('.page-pair')).toHaveCount(4);
  await expect(viewer.locator('.original-slot canvas').first()).toBeVisible();
  await expect(viewer.locator('#page-total')).toHaveText('4');
}

function systemPrompt(body: string): string {
  try {
    const payload = JSON.parse(body) as { messages?: { role?: string; content?: string }[] };
    return (payload.messages ?? []).filter(message => message.role === 'system').map(message => message.content ?? '').join('\n');
  } catch {
    return '';
  }
}

/** Waits for a provider request whose prompt names `language`, e.g. "English (en)". */
async function expectTargetRequest(bodies: string[], language: string): Promise<void> {
  await expect.poll(
    () => bodies.filter(body => systemPrompt(body).includes(`into ${language}.`)).length,
    { timeout: 45_000, message: `no provider request asked to translate into ${language}` },
  ).toBeGreaterThan(0);
}

async function providerRequests(context: BrowserContext): Promise<number> {
  const response = await context.request.get(METRICS);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { requests: number }).requests;
}

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true });
  for (const asset of ['manifest.json', 'background.js', 'index.html', 'assets']) {
    expect(existsSync(resolve(EXTENSION, asset)), `${EXTENSION}/${asset} is missing; run node scripts/build-extension.mjs`).toBe(true);
  }
});

test('B04: the popup target language reaches the reader and its translation request', async () => {
  test.setTimeout(180_000);
  const { context, worker, bodies } = await launchExtension();
  try {
    // Vietnamese is the reader default, so English can only appear through the
    // popup preference; a test that silently kept the default would fail below.
    expect(DEFAULT_TARGET_LANGUAGE).not.toBe('en');
    await seedTargetLanguage(worker, 'en');
    const before = await providerRequests(context);

    const viewer = await openSourcePdf(context);
    await proveReaderLoaded(viewer);

    await expect(viewer.locator('#target-language')).toHaveValue('en');
    await expect(viewer.locator('#target-language option:checked')).toHaveText('English');
    await expect(viewer.locator('#provider-label')).toHaveText(/·\s*English$/);

    await expectTargetRequest(bodies, 'English (en)');
    expect(await providerRequests(context)).toBeGreaterThan(before);

    await viewer.screenshot({ path: `${OUT}/b04-popup-language-reaches-reader.png` });
  } finally {
    await context.close();
  }
});

test('B04: an unsupported stored language falls back to Vietnamese on reload', async () => {
  test.setTimeout(240_000);
  const { context, worker, bodies } = await launchExtension();
  try {
    await seedTargetLanguage(worker, 'ja');
    const viewer = await openSourcePdf(context);
    await proveReaderLoaded(viewer);
    await expect(viewer.locator('#target-language')).toHaveValue('ja');
    await expect(viewer.locator('#target-language option:checked')).toHaveText('日本語');
    await expectTargetRequest(bodies, 'Japanese (ja)');

    // Corrupt the preference the way an older/unknown writer could, then reload
    // the same viewer tab: the reader must ignore the value, not error on it.
    const pageErrors: string[] = [];
    viewer.on('pageerror', error => pageErrors.push(error.message));
    bodies.length = 0;
    await seedTargetLanguage(worker, 'tlh');
    await viewer.reload();
    await proveReaderLoaded(viewer);

    await expect(viewer.locator('#target-language')).toHaveValue(DEFAULT_TARGET_LANGUAGE);
    await expect(viewer.locator('#target-language option:checked')).toHaveText('Tiếng Việt');
    await expect(viewer.locator('#provider-label')).toHaveText(/·\s*Tiếng Việt$/);
    await expect(viewer.locator('#status')).not.toHaveClass(/is-error/);
    await expectTargetRequest(bodies, 'Vietnamese (vi)');
    expect(pageErrors).toEqual([]);

    await viewer.screenshot({ path: `${OUT}/b04-invalid-value-falls-back-to-default.png` });
  } finally {
    await context.close();
  }
});
