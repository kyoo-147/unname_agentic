import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const OCR_ASSETS = [
  'public/ocr/worker.min.js',
  'public/ocr/eng.traineddata',
  'public/ocr/tesseract-core-lstm.wasm.js',
];
const MISSING_ASSETS = OCR_ASSETS.filter(asset => !existsSync(resolve(asset)));
const FIXTURE_PROVIDER = 'http://127.0.0.1:4319/v1/chat/completions';
const PROVIDER_METRICS = 'http://127.0.0.1:4319/metrics';

interface ProviderMetrics { requests: number }

async function providerRequests(request: APIRequestContext): Promise<number> {
  const response = await request.get(PROVIDER_METRICS);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as ProviderMetrics).requests;
}

async function captureReads(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __captureReads: () => number }).__captureReads());
}

/**
 * The capture reader is an extension page: it asks the background for
 * `mirror:get-capture` (PNG data URL) and relays translations through the same
 * runtime channel (see extension/background.ts). Stand in for that background
 * page, drawing the "screenshot" inside the page, and relay translation blocks
 * to the deterministic fixture provider used by reader.spec.ts. This fixture is
 * a test double for the provider, never a claim about translation quality.
 */
async function stubCaptureBackground(page: Page): Promise<void> {
  await page.addInitScript(({ provider }) => {
    const drawScreenshot = (): string => {
      const canvas = document.createElement('canvas');
      canvas.width = 1000;
      canvas.height = 420;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas 2d context unavailable');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#000000';
      context.font = 'bold 48px sans-serif';
      context.fillText('MIRROR PDF', 60, 120);
      context.font = '40px sans-serif';
      context.fillText('Capture text one', 60, 220);
      context.fillText('Capture text two', 60, 300);
      return canvas.toDataURL('image/png');
    };
    let captureReads = 0;
    const bridge = {
      id: 'mirror-capture-e2e',
      onMessage: { addListener: () => undefined },
      async sendMessage(message: { type?: string; request?: { text?: string } }) {
        if (message?.type === 'mirror:get-capture') {
          // extension/background.ts hands each capture out once, then deletes it.
          captureReads += 1;
          if (captureReads > 1) return { ok: false, error: 'Capture expired. Capture the visible source tab again.' };
          return { ok: true, image: drawScreenshot(), sourceTabId: 1, captureId: 'e2e' };
        }
        if (message?.type === 'mirror:translate') {
          const response = await fetch(provider, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'deterministic-test-only', temperature: 0, messages: [{ role: 'user', content: message.request?.text ?? '' }] }),
          });
          const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
          return { ok: true, text: payload.choices?.[0]?.message?.content ?? '' };
        }
        return { ok: false, error: `unexpected message: ${String(message?.type)}` };
      },
    };
    const scope = window as unknown as { chrome?: { runtime?: unknown; tabs?: unknown }; __captureReads: () => number };
    scope.chrome = scope.chrome ?? {};
    scope.chrome.runtime = bridge;
    scope.chrome.tabs = { getCurrent: async () => ({ id: 7 }) };
    scope.__captureReads = () => captureReads;
  }, { provider: FIXTURE_PROVIDER });
}

test.describe('screenshot capture reader', () => {
  test.skip(MISSING_ASSETS.length > 0, `Tesseract worker assets are missing (${MISSING_ASSETS.join(', ')}); capture OCR cannot run.`);

  test.setTimeout(180_000);

  test('reads a screenshot through OCR and translates the recognized blocks', async ({ page, request }) => {
    const before = await providerRequests(request);
    await stubCaptureBackground(page);
    await page.goto('/?capture=1&sourceTab=1');
    await expect(page.locator('.capture-reader')).toBeVisible();

    // Tesseract starts cold: fetch the worker, core and both language models.
    const sources = page.locator('.capture-card__source');
    await expect(sources.first()).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('#capture-error')).toBeHidden();

    const recognized = await sources.allInnerTexts();
    const knownWordBlocks = recognized.filter(text => /mirror|pdf|capture|text/i.test(text));
    expect(knownWordBlocks.length).toBeGreaterThan(0);

    // Every recognized block is laid out on the screenshot as an overlay region.
    const regions = page.locator('.capture-region');
    expect(await regions.count()).toBe(recognized.length);
    const firstRegion = await regions.first().evaluate(element => ({ width: (element as HTMLElement).style.width, top: (element as HTMLElement).style.top }));
    expect(firstRegion.width).not.toBe('0%');
    expect(firstRegion.top).toMatch(/%$/);

    // At least one block must reach the deterministic fixture provider and come back.
    const done = page.locator('.capture-card[data-state="done"]');
    await expect(done.first()).toBeVisible({ timeout: 60_000 });
    const translation = (await done.first().locator('.capture-card__translation').innerText()).trim();
    expect(translation.length).toBeGreaterThan(0);
    expect(translation).toContain('Bản dịch kiểm thử');
    expect(await providerRequests(request)).toBeGreaterThan(before);
    expect(await captureReads(page)).toBe(1);

    await page.screenshot({ path: 'artifacts/capture-ocr-e2e.png', fullPage: true });
  });

  test('retries OCR on the delivered screenshot instead of asking the extension again', async ({ page }) => {
    await stubCaptureBackground(page);
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      let failures = 1;
      function FlakyWorker(this: unknown, ...args: ConstructorParameters<typeof Worker>): Worker {
        if (failures > 0) {
          failures -= 1;
          throw new Error('simulated OCR worker startup failure');
        }
        return new NativeWorker(...args);
      }
      (window as unknown as { Worker: unknown }).Worker = FlakyWorker;
    });
    await page.goto('/?capture=1&sourceTab=1');

    // The first OCR attempt fails before Tesseract can start.
    const errorPanel = page.locator('#capture-error');
    await expect(errorPanel).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#capture-error-detail')).toContainText('simulated OCR worker startup failure');
    expect(await captureReads(page)).toBe(1);

    // Retry must re-read the screenshot already delivered, because the extension
    // hands a capture out exactly once (extension/background.ts deletes it).
    await page.locator('#capture-error-retry').click();
    await expect(page.locator('.capture-card__source').first()).toBeVisible({ timeout: 120_000 });
    await expect(errorPanel).toBeHidden();
    expect(await captureReads(page)).toBe(1);
    await expect(page.locator('.capture-card[data-state="done"]').first()).toBeVisible({ timeout: 60_000 });
  });
});
