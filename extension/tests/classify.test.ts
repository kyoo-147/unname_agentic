import { describe, expect, it } from 'vitest';
import {
  FULL_PAGE_IMAGE_RATIO,
  LARGE_IMAGE_RATIO,
  REASONS,
  SCAN_STAMP_GLYPH_LIMIT,
  SPARSE_TEXT_COVERAGE,
  SPARSE_TEXT_ITEM_LIMIT,
  classifyDocument,
  classifyPage,
} from '../viewer/src/core/classify';
import type { ClassifyImage, ClassifyPageInput, ClassifyTextItem } from '../viewer/src/core/classify';

const A4_WIDTH = 595;
const A4_HEIGHT = 842;
const A4_AREA = A4_WIDTH * A4_HEIGHT;
const SQUARE_AREA = 1000 * 1000;

/** One short line of text stamped over a raster. */
const WATERMARK = 'DRAFT COPY - INTERNAL USE ONLY';

function rect(x: number, y: number, width: number, height: number) {
  return { x, y, width, height };
}

function textItem(text: string, x: number, y: number, width: number, height = 12): ClassifyTextItem {
  return { text, rect: rect(x, y, width, height) };
}

function glyphsOf(items: readonly ClassifyTextItem[]): number {
  return items.reduce((total, item) => total + item.text.length, 0);
}

/** Body text: one run per line down the left column, like a real text page. */
function bodyText(lines: number): { textItems: ClassifyTextItem[]; glyphCount: number } {
  const textItems = Array.from({ length: lines }, (_, line) =>
    textItem(`line ${line} of body text`, 56, 56 + line * 14, 480),
  );
  return { textItems, glyphCount: glyphsOf(textItems) };
}

function page(overrides: Partial<ClassifyPageInput> = {}): ClassifyPageInput {
  return { textItems: [], images: [], pageArea: A4_AREA, glyphCount: 0, ...overrides };
}

function fullPageScan(): ClassifyImage {
  return { rect: rect(0, 0, A4_WIDTH, A4_HEIGHT) };
}

function bornDigitalPage(): ClassifyPageInput {
  return page({ ...bodyText(40) });
}

/** A scan whose image sits inside the scanner margin, plus a text watermark. */
function watermarkedScan(): ClassifyPageInput {
  return page({
    images: [{ rect: rect(20, 20, A4_WIDTH - 40, A4_HEIGHT - 40) }],
    textItems: [textItem(WATERMARK, 148, 380, 300, 24)],
    glyphCount: WATERMARK.length,
  });
}

describe('classifyPage kinds', () => {
  it('classifies a born-digital page as digital', () => {
    const result = classifyPage(bornDigitalPage());
    expect(result.kind).toBe('digital');
    expect(result.reasons).toEqual([REASONS.textLayer, REASONS.noDominantImage]);
    expect(result.stats.textItemCount).toBe(40);
    expect(result.stats.imageCount).toBe(0);
    expect(result.stats.textCoverage).toBeGreaterThan(SPARSE_TEXT_COVERAGE);
  });

  it('classifies a full-page scan as scanned', () => {
    const result = classifyPage(page({ images: [fullPageScan()] }));
    expect(result.kind).toBe('scanned');
    expect(result.reasons).toEqual([REASONS.fullPageImage, REASONS.noTextLayer]);
    expect(result.stats.largestImageRatio).toBe(1);
  });

  it('classifies a scan with a text watermark as hybrid', () => {
    const result = classifyPage(watermarkedScan());
    expect(result.kind).toBe('hybrid');
    expect(result.reasons).toEqual([REASONS.fullPageImage, REASONS.sparseText]);
    expect(result.stats.glyphCount).toBe(WATERMARK.length);
    expect(result.stats.largestImageRatio).toBeGreaterThanOrEqual(FULL_PAGE_IMAGE_RATIO);
  });

  it('keeps a page with one small logo and text as digital', () => {
    const result = classifyPage(page({ ...bodyText(40), images: [{ rect: rect(520, 40, 40, 40) }] }));
    expect(result.kind).toBe('digital');
    expect(result.reasons).toEqual([REASONS.textLayer, REASONS.noDominantImage]);
    expect(result.stats.largestImageRatio).toBeLessThan(LARGE_IMAGE_RATIO);
  });

  it('classifies an empty page as digital with reason "no content"', () => {
    const result = classifyPage(page());
    expect(result.kind).toBe('digital');
    expect(result.reasons).toEqual([REASONS.noContent]);
    expect(result.stats).toEqual({
      textItemCount: 0,
      glyphCount: 0,
      textCoverage: 0,
      imageCount: 0,
      largestImageRatio: 0,
    });
  });

  it('treats whitespace-only text runs as no content', () => {
    const result = classifyPage(page({ textItems: [textItem('   \n\t', 56, 56, 40)], glyphCount: 4 }));
    expect(result.reasons).toEqual([REASONS.noContent]);
  });

  it('ignores malformed image boxes instead of dividing by a bad area', () => {
    const result = classifyPage(page({ ...bodyText(40), images: [{ rect: rect(0, 0, -100, -100) }] }));
    expect(result.kind).toBe('digital');
    expect(result.stats.largestImageRatio).toBe(0);
  });

  it('rejects a non-positive page area', () => {
    expect(() => classifyPage(page({ pageArea: 0 }))).toThrow(RangeError);
    expect(() => classifyPage(page({ pageArea: -1 }))).toThrow(RangeError);
  });
});

describe('classifyPage threshold boundaries', () => {
  it('treats an image exactly at the full-page ratio as a scan', () => {
    const atLimit = classifyPage(
      page({ images: [{ rect: rect(0, 0, A4_WIDTH, A4_HEIGHT * FULL_PAGE_IMAGE_RATIO) }] }),
    );
    expect(atLimit.stats.largestImageRatio).toBeCloseTo(FULL_PAGE_IMAGE_RATIO, 6);
    expect(atLimit.kind).toBe('scanned');

    const justBelow = classifyPage(
      page({ images: [{ rect: rect(0, 0, A4_WIDTH, A4_HEIGHT * (FULL_PAGE_IMAGE_RATIO - 0.0001)) }] }),
    );
    expect(justBelow.stats.largestImageRatio).toBeLessThan(FULL_PAGE_IMAGE_RATIO);
    expect(justBelow.kind).toBe('digital');
    expect(justBelow.reasons).toEqual([REASONS.noTextLayer, REASONS.imageBelowFullPage]);
  });

  it('treats text exactly at the stamp glyph limit as scanned, one glyph more as hybrid', () => {
    const stamp = 'CONFIDENTIAL';
    expect(stamp).toHaveLength(SCAN_STAMP_GLYPH_LIMIT);
    const stamped = classifyPage(
      page({ images: [fullPageScan()], textItems: [textItem(stamp, 56, 56, 120, 14)], glyphCount: stamp.length }),
    );
    expect(stamped.kind).toBe('scanned');
    expect(stamped.reasons).toEqual([REASONS.fullPageImage, REASONS.stampText]);

    const overLimit = classifyPage(
      page({
        images: [fullPageScan()],
        textItems: [textItem(`${stamp}!`, 56, 56, 130, 14)],
        glyphCount: stamp.length + 1,
      }),
    );
    expect(overLimit.kind).toBe('hybrid');
    expect(overLimit.reasons).toEqual([REASONS.fullPageImage, REASONS.sparseText]);
  });

  it('treats an image exactly at the large-image ratio as hybrid when text is sparse', () => {
    const caption = textItem('Figure 1. Revenue by quarter', 56, 700, 300);
    const image = (ratio: number): ClassifyImage => ({ rect: rect(0, 0, A4_WIDTH, A4_HEIGHT * ratio) });

    const atLimit = classifyPage(page({ images: [image(LARGE_IMAGE_RATIO)], textItems: [caption], glyphCount: glyphsOf([caption]) }));
    expect(atLimit.stats.largestImageRatio).toBeCloseTo(LARGE_IMAGE_RATIO, 6);
    expect(atLimit.kind).toBe('hybrid');
    expect(atLimit.reasons).toEqual([REASONS.largeImage, REASONS.sparseText]);

    const justBelow = classifyPage(
      page({ images: [image(LARGE_IMAGE_RATIO - 0.0001)], textItems: [caption], glyphCount: glyphsOf([caption]) }),
    );
    expect(justBelow.stats.largestImageRatio).toBeLessThan(LARGE_IMAGE_RATIO);
    expect(justBelow.kind).toBe('digital');
  });

  it('treats a page exactly at the sparse item limit as hybrid, one run more as digital', () => {
    // Each run covers 1100 pt² so 20 runs (0.022) is already above the coverage
    // threshold: only the run count decides these two cases.
    const runs = (count: number): ClassifyTextItem[] =>
      Array.from({ length: count }, (_, index) => textItem(`line ${index}`, 0, index * 10, 110, 10));
    const image: ClassifyImage = { rect: rect(0, 0, 1000, 500) };

    const atLimitItems = runs(SPARSE_TEXT_ITEM_LIMIT);
    const atLimit = classifyPage({
      textItems: atLimitItems,
      images: [image],
      pageArea: SQUARE_AREA,
      glyphCount: glyphsOf(atLimitItems),
    });
    expect(atLimit.stats.textItemCount).toBe(SPARSE_TEXT_ITEM_LIMIT);
    expect(atLimit.stats.textCoverage).toBeGreaterThan(SPARSE_TEXT_COVERAGE);
    expect(atLimit.kind).toBe('hybrid');

    const overLimitItems = runs(SPARSE_TEXT_ITEM_LIMIT + 1);
    const overLimit = classifyPage({
      textItems: overLimitItems,
      images: [image],
      pageArea: SQUARE_AREA,
      glyphCount: glyphsOf(overLimitItems),
    });
    expect(overLimit.stats.textItemCount).toBe(SPARSE_TEXT_ITEM_LIMIT + 1);
    expect(overLimit.kind).toBe('digital');
    expect(overLimit.reasons).toEqual([REASONS.textLayer, REASONS.denseTextOverImage]);
  });

  it('treats text coverage exactly at the sparse coverage limit as hybrid', () => {
    // 25 runs cover exactly 20,000 of 1,000,000 pt² (2%), so only the coverage
    // rule decides: the limit is inclusive.
    const image: ClassifyImage = { rect: rect(0, 0, 1000, 500) };
    const atLimit = [
      textItem('heading', 0, 0, 800, 10),
      ...Array.from({ length: 24 }, (_, index) => textItem(`note ${index}`, 0, 20 + index * 10, 50, 10)),
    ];
    const atLimitResult = classifyPage({
      textItems: atLimit,
      images: [image],
      pageArea: SQUARE_AREA,
      glyphCount: glyphsOf(atLimit),
    });
    expect(atLimitResult.stats.textCoverage).toBe(SPARSE_TEXT_COVERAGE);
    expect(atLimitResult.kind).toBe('hybrid');

    const overLimit = [textItem('heading', 0, 0, 801, 10), ...atLimit.slice(1)];
    const overLimitResult = classifyPage({
      textItems: overLimit,
      images: [image],
      pageArea: SQUARE_AREA,
      glyphCount: glyphsOf(overLimit),
    });
    expect(overLimitResult.stats.textCoverage).toBeGreaterThan(SPARSE_TEXT_COVERAGE);
    expect(overLimitResult.kind).toBe('digital');
  });

  it('keeps a dense text layer over a full-page image as digital', () => {
    const result = classifyPage(page({ ...bodyText(40), images: [fullPageScan()] }));
    expect(result.kind).toBe('digital');
    expect(result.reasons).toEqual([REASONS.textLayer, REASONS.denseTextOverImage]);
  });
});

describe('classifyDocument summary', () => {
  it('summarises a mixed document and recommends mixed', () => {
    const document = classifyDocument([bornDigitalPage(), page({ images: [fullPageScan()] }), watermarkedScan()]);
    expect(document.pages.map(pageResult => pageResult.kind)).toEqual(['digital', 'scanned', 'hybrid']);
    expect(document.summary).toEqual({
      scannedPages: 1,
      digitalPages: 1,
      hybridPages: 1,
      recommended: 'mixed',
    });
  });

  it('recommends native when every page has its own text layer', () => {
    const document = classifyDocument([bornDigitalPage(), bornDigitalPage()]);
    expect(document.summary).toEqual({ scannedPages: 0, digitalPages: 2, hybridPages: 0, recommended: 'native' });
  });

  it('recommends ocr when no page can be extracted natively', () => {
    const document = classifyDocument([page({ images: [fullPageScan()] }), watermarkedScan()]);
    expect(document.summary).toEqual({ scannedPages: 1, digitalPages: 0, hybridPages: 1, recommended: 'ocr' });
  });

  it('recommends native for an empty document', () => {
    const document = classifyDocument([]);
    expect(document.pages).toEqual([]);
    expect(document.summary).toEqual({ scannedPages: 0, digitalPages: 0, hybridPages: 0, recommended: 'native' });
  });
});
