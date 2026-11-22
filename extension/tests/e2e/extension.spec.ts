import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

const EXTENSION = resolve('dist/extension');
const PDF = resolve('extension/tests/fixtures/mirror-field-notes.pdf');

async function launch(): Promise<{ context: BrowserContext; worker: Worker; close(primaryError?: unknown): Promise<void> }> {
  const profile = await mkdtemp(join(tmpdir(), 'mirror-extension-e2e-'));
  let context: BrowserContext | undefined;
  let closed = false;
  const close = async (primaryError?: unknown) => {
    if (closed) return;
    closed = true;
    const cleanupErrors: unknown[] = [];
    try {
      if (context) await context.close();
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      try {
        await rm(profile, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      const cleanupError = new AggregateError(cleanupErrors, 'Failed to clean up the temporary Chrome profile.');
      if (primaryError !== undefined) {
        throw new AggregateError([primaryError, cleanupError], 'The E2E test failed and cleanup also failed.');
      }
      throw cleanupError;
    }
  };

  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROME_PATH,
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    return { context, worker, close };
  } catch (error) {
    await close(error);
    throw error;
  }
}

async function withExtension(run: (context: BrowserContext, worker: Worker) => Promise<void>): Promise<void> {
  const extension = await launch();
  let primaryError: unknown;
  try {
    await run(extension.context, extension.worker);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await extension.close(primaryError);
  }
}

test('built MV3 starts and its reader imports a PDF and navigates pages', async () => {
  await withExtension(async (context, worker) => {
    const manifest = await worker.evaluate(async () => {
      const response = await fetch(chrome.runtime.getURL('manifest.json'));
      return response.json();
    }) as { manifest_version: number; background: { service_worker: string }; action: { default_popup: string } };
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.action.default_popup).toBe('popup.html');
    expect(await worker.evaluate(() => chrome.runtime.id)).not.toBe('');

    const reader = await context.newPage();
    await reader.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
    await reader.goto(await worker.evaluate(() => chrome.runtime.getURL('index.html')));
    await reader.locator('#file-input').setInputFiles(PDF);
    await expect(reader.locator('.page-pair')).toHaveCount(4);
    await expect(reader.locator('#page-total')).toHaveText('4');
    await reader.locator('#page-input').fill('3');
    await reader.locator('#page-input').press('Enter');
    await expect(reader.locator('#page-input')).toHaveValue('3');
    await expect(reader.locator('.page-pair[data-page="3"]')).toBeVisible();
    await reader.locator('#export-pdf').click();
    await expect(reader.locator('#status')).toHaveText('Translate at least one region before exporting.');
    await expect(reader.locator('#status')).toHaveClass(/is-error/);
  });
});

test('popup language preference reaches the extension reader', async () => {
  await withExtension(async (context, worker) => {
    const popup = await context.newPage();
    await popup.goto(await worker.evaluate(() => chrome.runtime.getURL('popup.html')));
    await popup.locator('#target-language').selectOption('en');
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('mirror:targetLanguage'))['mirror:targetLanguage'])).toBe('en');

    const reader = await context.newPage();
    await reader.goto(await worker.evaluate(() => chrome.runtime.getURL('index.html')));
    await reader.locator('#file-input').setInputFiles(PDF);
    await expect(reader.locator('.page-pair')).toHaveCount(4);
    await expect(reader.locator('#target-language')).toHaveValue('en');
  });
});

test('synthetic service-worker capture handoff opens the built extension capture reader', async () => {
  const server = createServer((_request, response) => response.end('<title>Capture source</title><p>Local capture handoff fixture</p>'));
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local capture fixture server failed to start.');
  try {
    await withExtension(async (context, worker) => {
      const source = await context.newPage();
      await source.goto(`http://127.0.0.1:${address.port}/`);
      const image = await source.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 8;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#fff';
        context.fillRect(0, 0, 8, 8);
        return canvas.toDataURL('image/png');
      });
      const sourceTabId = await worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(candidate => candidate.url?.startsWith('http://127.0.0.1:'));
        if (tab?.id === undefined) throw new Error('Capture source tab was not found.');
        return tab.id;
      });
      await worker.evaluate(async payload => {
        const result = await chrome.runtime.sendMessage({ type: 'mirror:open-capture', sourceTabId: payload.tabId, image: payload.image });
        if (!result?.ok) throw new Error(result?.error ?? 'Capture handoff failed.');
      }, { tabId: sourceTabId, image });
      await expect.poll(() => context.pages().filter(page => new URL(page.url()).searchParams.get('capture') === '1').length).toBe(1);
      const captureReader = context.pages().find(page => new URL(page.url()).searchParams.get('capture') === '1');
      expect(captureReader).toBeDefined();
      await expect(captureReader!.locator('.capture-reader')).toBeVisible();
    });
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

// Real popup storage/UI contracts for every supported target, not count-padding cases.
const popupLanguages = [
  ['vi', 'Tiếng Việt'], ['en', 'English'], ['zh', '中文'], ['ja', '日本語'],
  ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'],
  ['pt', 'Português'], ['ru', 'Русский'], ['ar', 'العربية'], ['hi', 'हिन्दी'],
  ['th', 'ไทย'], ['id', 'Bahasa Indonesia'],
] as const;

for (const [code, nativeName] of popupLanguages) {
  test(`popup persists ${nativeName} (${code}) as the target language`, async () => {
    await withExtension(async (context, worker) => {
      const popup = await context.newPage();
      await popup.goto(await worker.evaluate(() => chrome.runtime.getURL('popup.html')));
      const select = popup.locator('#target-language');
      await expect(select.locator('option')).toHaveCount(popupLanguages.length);
      await select.selectOption(code);
      await expect(select.locator('option:checked')).toHaveText(nativeName);
      await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('mirror:targetLanguage'))['mirror:targetLanguage'])).toBe(code);
    });
  });
}

const invalidPopupValues: unknown[] = ['tlh', '', 17, null, {}];
for (const [index, invalid] of invalidPopupValues.entries()) {
  test(`popup normalizes unsupported stored preference ${index + 1} to Vietnamese`, async () => {
    await withExtension(async (context, worker) => {
      await worker.evaluate(async value => chrome.storage.local.set({ 'mirror:targetLanguage': value }), invalid);
      const popup = await context.newPage();
      await popup.goto(await worker.evaluate(() => chrome.runtime.getURL('popup.html')));
      await expect(popup.locator('#target-language')).toHaveValue('vi');
      await expect(popup.locator('#target-language option:checked')).toHaveText('Tiếng Việt');
    });
  });
}

for (const [locale, heading, skipText] of [
  ['vi', 'Phòng đọc của bạn.', 'Chuyển đến nội dung chính'],
  ['en', 'Your reading room.', 'Skip to main content'],
  ['zh', '你的阅读室。', '跳至主要内容'],
] as const) {
  test(`reader restores ${locale} locale from persisted localStorage on reload`, async () => {
    await withExtension(async (context, worker) => {
      const reader = await context.newPage();
      const url = await worker.evaluate(() => chrome.runtime.getURL('index.html'));
      await reader.goto(url);
      await reader.evaluate(value => localStorage.setItem('mirror.locale', value), locale);
      await reader.reload();
      await expect(reader.locator('html')).toHaveAttribute('lang', locale);
      await expect(reader.locator('h1')).toHaveText(heading);
      await expect(reader.locator('.skip-link')).toHaveText(skipText);
    });
  });
}

for (const pageNumber of [1, 2, 3, 4]) {
  test(`reader page field navigates to page ${pageNumber} in the imported PDF`, async () => {
    await withExtension(async (context, worker) => {
      const reader = await context.newPage();
      await reader.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
      await reader.goto(await worker.evaluate(() => chrome.runtime.getURL('index.html')));
      await reader.locator('#file-input').setInputFiles(PDF);
      await expect(reader.locator('.page-pair')).toHaveCount(4);
      await reader.locator('#page-input').fill(String(pageNumber));
      await reader.locator('#page-input').press('Enter');
      await expect(reader.locator('#page-input')).toHaveValue(String(pageNumber));
      await expect(reader.locator('#page-status')).toHaveText(`Page ${pageNumber} of 4`);
      await expect(reader.locator(`.page-pair[data-page="${pageNumber}"] .original-slot canvas`)).toBeVisible();
    });
  });
}

for (const [mode, label] of [
  ['side-by-side', 'Side by side'], ['overlay', 'Overlay'], ['interleaved', 'Interleaved'], ['reflow', 'Reflow'],
] as const) {
  test(`reader selects ${label} mode and exposes its active state`, async () => {
    await withExtension(async (context, worker) => {
      const reader = await context.newPage();
      await reader.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
      await reader.goto(await worker.evaluate(() => chrome.runtime.getURL('index.html')));
      await reader.locator('#file-input').setInputFiles(PDF);
      await expect(reader.locator('.page-pair')).toHaveCount(4);
      const control = reader.locator(`[data-reading-mode="${mode}"]`);
      await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'true');
      await expect(reader.locator('#reading-mode-switch')).toHaveAttribute('role', 'group');
    });
  });
}

for (const [control, expandedSelector] of [
  ['#outline-toggle', '#reader-panel'], ['#search-toggle', '#reader-panel'], ['#thumbnails-toggle', '#thumbnails'],
] as const) {
  test(`${control} exposes expanded state and opens its controlled reader panel`, async () => {
    await withExtension(async (context, worker) => {
      const reader = await context.newPage();
      await reader.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
      await reader.goto(await worker.evaluate(() => chrome.runtime.getURL('index.html')));
      await reader.locator('#file-input').setInputFiles(PDF);
      await expect(reader.locator('.page-pair')).toHaveCount(4);
      const toggle = reader.locator(control);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(reader.locator(expandedSelector)).toBeVisible();
    });
  });
}

test('reader keyboard shortcut opens and closes the shortcut dialog with Escape', async () => {
  await withExtension(async (context, worker) => {
    const reader = await context.newPage();
    await reader.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
    await reader.goto(await worker.evaluate(() => chrome.runtime.getURL('index.html')));
    await reader.locator('#file-input').setInputFiles(PDF);
    await expect(reader.locator('.page-pair')).toHaveCount(4);
    await reader.keyboard.press('Control+k');
    await expect(reader.locator('#command-palette')).toBeVisible();
    await expect(reader.locator('#command-palette')).toHaveAttribute('aria-modal', 'true');
    await reader.keyboard.press('Escape');
    await expect(reader.locator('#command-palette')).toBeHidden();
  });
});

test('reader skip link targets the main content and status uses a polite live region', async () => {
  await withExtension(async (context, worker) => {
    const reader = await context.newPage();
    await reader.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
    await reader.goto(await worker.evaluate(() => chrome.runtime.getURL('index.html')));
    await reader.keyboard.press('Tab');
    await expect(reader.locator('.skip-link')).toBeFocused();
    await reader.keyboard.press('Enter');
    await expect(reader.locator('#main-content')).toBeFocused();
    await expect(reader.locator('#status')).toHaveAttribute('aria-live', 'polite');
    await expect(reader.locator('#status')).toHaveAttribute('aria-atomic', 'true');
  });
});

test('Arabic target selection is available and keeps the reader target explicit', async () => {
  await withExtension(async (context, worker) => {
    const reader = await context.newPage();
    await reader.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
    await reader.goto(await worker.evaluate(() => chrome.runtime.getURL('index.html')));
    await reader.locator('#file-input').setInputFiles(PDF);
    await expect(reader.locator('.page-pair')).toHaveCount(4);
    await reader.locator('#target-language').selectOption('ar');
    await expect(reader.locator('#target-language')).toHaveValue('ar');
    await expect(reader.locator('#provider-label')).toContainText('Arabic');
  });
});

for (const [button, label] of [['#export-print', 'print'], ['#export-bilingual', 'bilingual text']] as const) {
  test(`${label} export explains why untranslated content cannot be exported`, async () => {
    await withExtension(async (context, worker) => {
      const reader = await context.newPage();
      await reader.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
      await reader.goto(await worker.evaluate(() => chrome.runtime.getURL('index.html')));
      await reader.locator('#file-input').setInputFiles(PDF);
      await expect(reader.locator('.page-pair')).toHaveCount(4);
      await reader.locator(button).click();
      await expect(reader.locator('#status')).toHaveText('Translate at least one region before exporting.');
      await expect(reader.locator('#status')).toHaveClass(/is-error/);
    });
  });
}

test('reader exposes separator keyboard semantics and meaningful resize bounds', async () => {
  await withExtension(async (context, worker) => {
    const reader = await context.newPage();
    await reader.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
    await reader.goto(await worker.evaluate(() => chrome.runtime.getURL('index.html')));
    await reader.locator('#file-input').setInputFiles(PDF);
    await expect(reader.locator('.page-pair')).toHaveCount(4);
    const separator = reader.locator('.splitter').first();
    await expect(separator).toHaveAttribute('role', 'separator');
    await expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    await expect(separator).toHaveAttribute('aria-valuemin', '25');
    await expect(separator).toHaveAttribute('aria-valuemax', '75');
  });
});
