import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const fixture = resolve('tests/fixtures/mirror-field-notes.pdf');

// No trace artifacts are needed for these assertions, so the shared test-results directory stays untouched.
test.use({ trace: 'off' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mirror.locale', 'en'));
});

async function openReader(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your reading room.' })).toBeVisible();
    await page.locator('#file-input').setInputFiles(fixture);
    const loaded = await expect(page.locator('.page-pair')).toHaveCount(4).then(() => true).catch(() => false);
    if (loaded) {
      await expect(page.locator('.original-slot canvas').first()).toBeVisible();
      return;
    }
  }
  throw new Error('the reader did not load the fixture PDF after two attempts');
}

async function focusIsInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(scope => Boolean(document.activeElement?.closest(scope)), selector);
}

async function expectFocusTrapped(page: Page, dialogSelector: string, presses: number): Promise<void> {
  for (let index = 0; index < presses; index++) {
    await page.keyboard.press('Tab');
    expect(await focusIsInside(page, dialogSelector), `Tab ${index + 1} escaped ${dialogSelector}`).toBe(true);
  }
}

test('document language follows the chosen locale and the skip link moves focus', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const skip = page.locator('.skip-link');
  await expect(skip).toHaveText('Skip to main content');
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  const ring = await skip.evaluate(element => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(ring.style).toBe('solid');
  expect(ring.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Enter');
  // The skip link must land on the reading area, not on the app root that starts
  // with the sidebar (WCAG 2.4.1 bypass blocks).
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page.locator('#main-content .topbar')).toBeVisible();
  await page.locator('.topbar [data-locale="zh"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
  await expect(skip).toHaveText('跳至主要内容');
  await page.locator('.topbar [data-locale="vi"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(skip).toHaveText('Chuyển đến nội dung chính');
});

test('every button without visible text exposes an aria-label or title', async ({ page }) => {
  await openReader(page);
  await page.locator('#outline-toggle').click();
  await expect(page.locator('#reader-panel')).toBeVisible();
  const unnamed = await page.evaluate(() => {
    const problems: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('button, [role="button"]')) {
      const text = (element.innerText || '').trim();
      const label = (element.getAttribute('aria-label') || element.getAttribute('title') || '').trim();
      if (!text && !label) problems.push(element.id || element.className || element.tagName.toLowerCase());
    }
    return problems;
  });
  expect(unnamed).toEqual([]);
});

test('collapsible panels expose aria-expanded', async ({ page }) => {
  await openReader(page);
  const outline = page.locator('#outline-toggle');
  const thumbnails = page.locator('#thumbnails-toggle');
  await expect(outline).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#search-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(thumbnails).toHaveAttribute('aria-expanded', 'false');
  await outline.click();
  await expect(outline).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#reader-panel')).toBeVisible();
  await page.locator('.reader-panel__close').click();
  await expect(outline).toHaveAttribute('aria-expanded', 'false');
  await thumbnails.click();
  await expect(thumbnails).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#thumbnails')).toBeVisible();
});

test('settings dialog exposes modal semantics, traps focus and returns it to the opener', async ({ page }) => {
  await openReader(page);
  const opener = page.locator('#settings-open');
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Translation settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(await focusIsInside(page, '#settings-dialog')).toBe(true);
  await expectFocusTrapped(page, '#settings-dialog', 18);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('selection dialog exposes modal semantics, traps focus and Escape returns to the region', async ({ page }) => {
  await openReader(page);
  const region = page.locator('.source-region').first();
  await region.click();
  const dialog = page.getByRole('dialog', { name: 'Paired reading view' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(await focusIsInside(page, '#selection-dialog')).toBe(true);
  await expectFocusTrapped(page, '#selection-dialog', 8);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(region).toBeFocused();
});

test('the status bar is a polite, atomic live region', async ({ page }) => {
  await page.goto('/');
  const status = page.locator('#status');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveAttribute('aria-atomic', 'true');
});

test('reduced motion stops the splitter and scroll animation', async ({ page }) => {
  await openReader(page);
  const splitter = page.locator('.splitter').first();
  const read = () => splitter.evaluate(element => {
    const handle = getComputedStyle(element, '::after');
    const scroll = getComputedStyle(document.querySelector('.reading-scroll')!);
    return {
      transition: getComputedStyle(element).transitionDuration,
      animation: getComputedStyle(element).animationDuration,
      handleTransition: handle.transitionDuration,
      scrollBehavior: scroll.scrollBehavior,
    };
  });
  const normal = await read();
  expect(normal.handleTransition).toBe('0.15s');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await read();
  for (const duration of [reduced.transition, reduced.animation, reduced.handleTransition]) {
    expect(['0s', 'none']).toContain(duration.trim());
  }
  expect(reduced.scrollBehavior).toBe('auto');
});

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgba | null {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1]!.split(',').map(part => Number.parseFloat(part));
  if (parts.length < 3) return null;
  return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts.length > 3 ? parts[3]! : 1 };
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function luminance(color: { r: number; g: number; b: number }): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(foreground: Rgba, background: Rgba): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function flattened(color: Rgba, base: Rgba): Rgba {
  return {
    r: color.r * color.a + base.r * (1 - color.a),
    g: color.g * color.a + base.g * (1 - color.a),
    b: color.b * color.a + base.b * (1 - color.a),
    a: 1,
  };
}

test('body text and muted labels reach 4.5:1 in the light shell and dark reader panel', async ({ page }) => {
  await openReader(page);
  const samples = await page.evaluate(() => {
    const parse = (value: string) => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1]!.split(',').map(part => Number.parseFloat(part));
      if (parts.length < 3) return null;
      return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts.length > 3 ? parts[3]! : 1 };
    };
    const resolvedBackground = (element: Element) => {
      const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
      let node: Element | null = element;
      while (node) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0) {
          layers.push(color);
          if (color.a >= 1) break;
        }
        node = node.parentElement;
      }
      let base = { r: 255, g: 255, b: 255 };
      for (const layer of layers.reverse()) {
        base = {
          r: layer.r * layer.a + base.r * (1 - layer.a),
          g: layer.g * layer.a + base.g * (1 - layer.a),
          b: layer.b * layer.a + base.b * (1 - layer.a),
        };
      }
      return `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`;
    };
    const selectors = [
      '#status',
      '.library-heading p',
      '.library-section-heading > span',
      '.library-footnote',
      '.drop-zone small',
      '.document-card-content > span',
      '.page-number',
      '.reader-bottom',
      '.language-label',
      '.pane-headings',
      '.dialog-description',
      '.settings-help',
    ];
    const shell = selectors.map(selector => {
      const element = document.querySelector(selector);
      if (!element) return { selector, found: false, color: '', background: '' };
      return { selector, found: true, color: getComputedStyle(element).color, background: resolvedBackground(element) };
    });
    const sidebar = ['.nav-label', '.privacy-note'].map(selector => {
      const element = document.querySelector(selector);
      if (!element) return { selector, found: false, color: '', background: '' };
      return { selector, found: true, color: getComputedStyle(element).color, background: '' };
    });
    const stops = [...getComputedStyle(document.querySelector('.sidebar')!).backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map(match => match[0]);
    return { shell, sidebar, stops };
  });

  const report: string[] = [];
  const measured: Record<string, number> = {};
  for (const sample of samples.shell) {
    expect(sample.found, `${sample.selector} exists`).toBe(true);
    const foreground = parseColor(sample.color);
    const background = parseColor(sample.background);
    expect(foreground, `${sample.selector} color`).not.toBeNull();
    expect(background, `${sample.selector} background`).not.toBeNull();
    const ratio = contrastRatio(foreground!, background!);
    measured[sample.selector] = Number(ratio.toFixed(2));
    report.push(`${sample.selector} ${ratio.toFixed(2)}:1 (${sample.color} on ${sample.background})`);
    expect(ratio, `${sample.selector} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  }

  const bodyBackground = parseColor('rgb(250, 251, 249)')!;
  for (const sample of samples.sidebar) {
    expect(sample.found, `${sample.selector} exists`).toBe(true);
    const foreground = parseColor(sample.color);
    expect(foreground, `${sample.selector} color`).not.toBeNull();
    expect(samples.stops.length, 'sidebar gradient stops').toBeGreaterThan(0);
    let worst = Number.POSITIVE_INFINITY;
    for (const stop of samples.stops) {
      const layer = parseColor(stop);
      if (!layer) continue;
      const ratio = contrastRatio(foreground!, flattened(layer, bodyBackground));
      worst = Math.min(worst, ratio);
    }
    measured[sample.selector] = Number(worst.toFixed(2));
    report.push(`${sample.selector} ${worst.toFixed(2)}:1 (worst sidebar gradient stop)`);
    expect(worst, `${sample.selector} ${worst.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  }

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('#search-toggle').click();
  await expect(page.locator('.reader-search__hint')).toBeVisible();
  const dark = await page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector)!;
      return { color: getComputedStyle(element).color, background: getComputedStyle(document.querySelector('.reader-panel')!).backgroundColor };
    };
    return { title: read('.reader-panel__title'), hint: read('.reader-search__hint') };
  });
  for (const [label, sample] of Object.entries(dark)) {
    const ratio = contrastRatio(parseColor(sample.color)!, parseColor(sample.background)!);
    measured[`dark:${label}`] = Number(ratio.toFixed(2));
    report.push(`dark .reader-panel ${label} ${ratio.toFixed(2)}:1 (${sample.color} on ${sample.background})`);
    expect(ratio, `dark reader panel ${label} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  }

  for (const line of report) console.log(`[a11y contrast] ${line}`);
  await test.info().attach('contrast-ratios', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
});
