import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * N02: cancelling a full-document translation must stop the document run, not
 * merely hide its progress.
 *
 * These cases drive the real toolbar control in a real browser against the
 * bundled fixture PDF. The provider route answers with a deliberately slow
 * OpenAI-compatible JSON body, so each cancel click lands while a request is
 * still on the wire. `tests/translation-abort.test.ts` proves the transport
 * honours an AbortSignal; this proves the reader stops issuing requests for the
 * rest of the document once the user asks it to stop.
 */

const FIXTURE = resolve('tests/fixtures/mirror-field-notes.pdf');
const PROVIDER_ENDPOINT = 'http://127.0.0.1:4319/v1';
const PROVIDER_ROUTE = `${PROVIDER_ENDPOINT}/chat/completions`;
const PROVIDER_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

// Documented delay: long enough that the test sees the request and clicks Stop
// while the answer is still pending, short enough to stay well inside the
// default 60 s test timeout.
const RESPONSE_DELAY_MS = 3_000;
// Longer than the delay above, so an aborted response has time to arrive and a
// late paint would still be visible to the assertions below.
const SETTLE_MS = RESPONSE_DELAY_MS + 1_000;

interface BatchEntry {
  id: string;
  text: string;
}

interface ChatBody {
  messages?: { role?: string; content?: unknown }[];
}

interface ProviderProbe {
  /** Wall-clock start time of every provider POST, in request order. */
  readonly startedAt: number[];
  /** Switches the route to the slow fake answer for the rest of the test. */
  readonly slow: () => void;
}

/** Reads the reader's batch envelope; undefined when the prompt is a single text. */
function batchEntries(raw: string): BatchEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const entries: BatchEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) return undefined;
    const entry = item as { id?: unknown; text?: unknown };
    if (typeof entry.id !== 'string' || typeof entry.text !== 'string') return undefined;
    entries.push({ id: entry.id, text: entry.text });
  }
  return entries;
}



/** A valid OpenAI-compatible response for either prompt shape the reader sends. */
function fakeAnswer(raw: string | null): string {
  let body: ChatBody = {};
  try {
    body = JSON.parse(raw ?? '{}') as ChatBody;
  } catch {
    body = {};
  }
  const user = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
  const text = typeof user?.content === 'string' ? user.content : '';
  const entries = batchEntries(text);
  if (entries) {
    return JSON.stringify(entries.map(entry => ({ id: entry.id, text: `Bản dịch kiểm thử: ${entry.text}` })));
  }
  return `Bản dịch kiểm thử: ${text}`;
}

/**
 * Intercepts only the deterministic fixture provider. The route is deliberately
 * exact: the default local endpoint must not be mistaken for fixture traffic
 * before the test applies its provider settings.
 */
async function probeProvider(page: Page): Promise<ProviderProbe> {
  const startedAt: number[] = [];
  let slow = false;
  await page.route(PROVIDER_ROUTE, async route => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.continue();
      return;
    }
    startedAt.push(Date.now());
    if (!slow) return route.continue();
    await new Promise(done => setTimeout(done, RESPONSE_DELAY_MS));
    try {
      await route.fulfill({
        status: 200,
        headers: PROVIDER_CORS,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: fakeAnswer(request.postData()) } }] }),
      });
    } catch {
      // The reader aborted this request while the answer was pending, so there
      // is nobody left to deliver it to. That is exactly what is under test.
    }
  });
  return { startedAt, slow: () => { slow = true; } };
}

async function pinEnglish(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
}

/** Boots the reader exactly the way the other e2e specs do. */
async function openReader(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your reading room.' })).toBeVisible();
  await applyFixtureProvider(page);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await page.locator('#pause').click();
  await expect(page.locator('#pause')).toHaveText('Resume');
  await expect(page.locator('.page-pair')).toHaveCount(4);
  await expect(page.locator('.original-slot canvas').first()).toBeVisible();
}

async function applyFixtureProvider(page: Page): Promise<void> {
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('[name=endpoint]').fill(PROVIDER_ENDPOINT);
  await page.locator('[name=model]').fill('deterministic-test-only');
  await page.locator('#settings-form button[type=submit]').click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
}

/**
 * Holds the per-block queue for the whole test. The reader deliberately
 * re-queues the visible pages when a full-document run stops, and that queue
 * would otherwise start requests of its own; holding it keeps the traffic
 * measured here limited to the full-document batch loop, which does not use
 * this queue at all.
 */
async function holdVisibleQueue(page: Page): Promise<void> {
  await page.locator('#pause').click();
  await expect(page.locator('#pause')).toHaveText('Resume');
}

/** Painted translation count per page row, in document order. */
async function paintedByPage(page: Page): Promise<number[]> {
  return page.locator('.page-pair').evaluateAll(rows =>
    rows.map(row => row.querySelectorAll('.painted-region').length));
}

test('stopping a full-document translation aborts the page in flight and asks for no more', async ({ page }) => {
  await pinEnglish(page);
  const probe = await probeProvider(page);
  await openReader(page);
  probe.startedAt.length = 0;
  probe.slow();

  // The held queue must not have produced any provider traffic: the full run is
  // the only source of requests in this test.
  expect(probe.startedAt).toEqual([]);

  await page.locator('#full').click();
  await expect(page.locator('#full')).toHaveText('Stop full translation');

  // The run translates page by page. Wait for the first page to paint, then for
  // the next page's request, so the cancel lands on a live request.
  await expect(page.locator('.painted-region').first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => probe.startedAt.length, { timeout: 30_000 }).toBeGreaterThan(1);

  await page.locator('#full').click();
  const cancelledAt = Date.now();
  const requestsAtCancel = probe.startedAt.length;

  // Idle state: the control that showed the run is gone.
  await expect(page.locator('#full')).toHaveText('Translate all');
  await expect(page.getByRole('button', { name: 'Stop full translation' })).toHaveCount(0);

  const layoutAtCancel = await paintedByPage(page);
  await page.waitForTimeout(SETTLE_MS);

  // No request may start after the cancel, and the aborted page must not paint.
  expect(probe.startedAt.length).toBe(requestsAtCancel);
  expect(probe.startedAt.filter(startedAt => startedAt > cancelledAt)).toEqual([]);
  expect(await paintedByPage(page)).toEqual(layoutAtCancel);

  // The full-document loop was genuinely mid-flight: it had started more than
  // one page request but had not issued the complete four-page run yet.
  expect(requestsAtCancel).toBeGreaterThan(1);
  expect(requestsAtCancel).toBeLessThan(4);
});

test('cancelling before the first response leaves the document untouched', async ({ page }) => {
  await pinEnglish(page);
  const probe = await probeProvider(page);
  await openReader(page);
  await page.waitForTimeout(1_000);
  const initialLayout = await paintedByPage(page);
  probe.startedAt.length = 0;
  probe.slow();

  // Premise of this case: nothing has answered yet, because the per-block queue
  // is held. This is setup, not the behavior under test.
  expect(probe.startedAt).toEqual([]);
  expect(await paintedByPage(page)).toEqual(initialLayout);

  await page.locator('#full').click();
  await expect.poll(() => probe.startedAt.length, { timeout: 30_000 }).toBeGreaterThan(0);

  await page.locator('#full').click();
  const cancelledAt = Date.now();
  const requestsAtCancel = probe.startedAt.length;

  await expect(page.locator('#full')).toHaveText('Translate all');
  await page.waitForTimeout(SETTLE_MS);

  // The count does not grow, nothing arrived late, and setup painting is not
  expect(probe.startedAt.length).toBe(requestsAtCancel);
  expect(probe.startedAt.filter(startedAt => startedAt > cancelledAt)).toEqual([]);
});
