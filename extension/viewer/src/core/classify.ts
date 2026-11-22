/**
 * Page classifier (backlog E01). Decides, per page, whether the text layer can be
 * trusted as the page content ('digital'), whether the page only exists as pixels
 * ('scanned'), or whether both are needed ('hybrid'), and records why so the
 * pipeline can route each page without OCR-ing text it already has.
 *
 * Input is plain data gathered by the PDF layer (text item boxes and image
 * placements), never the DOM, so classification can run before rendering.
 */

import type { Rect } from './types';

export type PageKind = 'digital' | 'scanned' | 'hybrid';

export type DocumentRecommendation = 'native' | 'ocr' | 'mixed';

export interface ClassifyTextItem {
  /** Extracted text of the run. Whitespace-only runs are ignored. */
  text: string;
  /** Bounding box of the run, in the unit used for `pageArea`. */
  rect: Rect;
}

export interface ClassifyImage {
  /** Placement box of the raster image on the page. */
  rect: Rect;
}

export interface ClassifyPageInput {
  textItems: readonly ClassifyTextItem[];
  images: readonly ClassifyImage[];
  /** Page area in the squared unit of every rect (e.g. PDF points²). */
  pageArea: number;
  /**
   * Glyphs across `textItems`, as counted by the extractor. Used only to tell a
   * scan stamp from written content, so callers must report it consistently.
   */
  glyphCount: number;
}

/**
 * A raster covering at least 85% of the page is a picture of the whole page.
 * A 300 dpi A4 scan puts its image over roughly 90% of the page box, leaving
 * only the scanner margin; at 85% the leftover strip is thinner than any text
 * column, so the page cannot be born-digital.
 */
export const FULL_PAGE_IMAGE_RATIO = 0.85;

/**
 * An image covering at least 40% of the page displaces half a column or a whole
 * column at A4 width, so the page mixes pixels with text. Inline logos, rules
 * and small figures stay under 5% and must not change the routing.
 */
export const LARGE_IMAGE_RATIO = 0.4;

/**
 * Text runs per page that still count as "not a body of text". pdf.js emits one
 * run per style or position change, so a filled A4 page yields hundreds; 20 runs
 * is about a heading plus a caption — not enough to be the page's text, but
 * enough to keep once the rest of the page is a picture.
 */
export const SPARSE_TEXT_ITEM_LIMIT = 20;

/**
 * Same judgement measured by area. Glyph boxes of a filled A4 page cover roughly
 * 15-45% of it; under 2% (about 10,000 pt² of A4, a short caption strip) the
 * text cannot be filling the page, whatever the run count says.
 */
export const SPARSE_TEXT_COVERAGE = 0.02;

/**
 * A page number or "Scanned by <device>" stamp fits in 12 glyphs. A 13th glyph
 * means something was written over the raster (watermark, form field, OCR text
 * layer), which is content the pipeline must not discard.
 */
export const SCAN_STAMP_GLYPH_LIMIT = 12;

/**
 * Ratios are compared and reported rounded to 6 decimals so a value meant to sit
 * exactly on a threshold is not pushed across it by float noise (0.85 can be
 * stored as 0.8499999999999999).
 */
const RATIO_DECIMALS = 6;

/** Why a page got its kind. Stable codes, not sentences: consumers match on them. */
export const REASONS = {
  noContent: 'no content',
  textLayer: 'text layer present',
  noTextLayer: 'no text layer',
  stampText: 'text layer below stamp threshold',
  fullPageImage: 'full-page image',
  largeImage: 'large image',
  sparseText: 'sparse text layer',
  denseTextOverImage: 'dense text layer over image',
  noDominantImage: 'no dominant image',
  imageBelowFullPage: 'image below full-page threshold',
} as const;

export type ClassifyReason = (typeof REASONS)[keyof typeof REASONS];

export interface PageStats {
  textItemCount: number;
  glyphCount: number;
  /** Text box area divided by page area, 0..1. */
  textCoverage: number;
  imageCount: number;
  /** Largest single image area divided by page area, 0..1. */
  largestImageRatio: number;
}

export interface PageClassification {
  kind: PageKind;
  reasons: ClassifyReason[];
  stats: PageStats;
}

export interface DocumentSummary {
  scannedPages: number;
  digitalPages: number;
  hybridPages: number;
  /** native: no page needs OCR; ocr: every page does; mixed: both cases present. */
  recommended: DocumentRecommendation;
}

export interface DocumentClassification {
  pages: PageClassification[];
  summary: DocumentSummary;
}

function roundRatio(value: number): number {
  const factor = 10 ** RATIO_DECIMALS;
  return Math.round(value * factor) / factor;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return roundRatio(Math.min(1, value));
}

function rectArea(rect: Rect): number {
  const { width, height } = rect;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Classifies one page. Rules are ordered and the first match owns the decision:
 *
 * 1. No text and no raster -> digital, reason "no content" (nothing to route).
 * 2. Full-page raster with at most a stamp of text -> scanned.
 * 3. Text present, raster covers at least 40%, text is sparse -> hybrid.
 * 4. Otherwise digital: the text layer already carries the page.
 */
export function classifyPage(input: ClassifyPageInput): PageClassification {
  const { pageArea } = input;
  if (!Number.isFinite(pageArea) || pageArea <= 0) {
    throw new RangeError('classifyPage: pageArea must be a positive finite number.');
  }

  const items = input.textItems.filter(item => item.text.trim().length > 0);
  const glyphs = Number.isFinite(input.glyphCount) ? Math.max(0, Math.floor(input.glyphCount)) : 0;

  const textArea = items.reduce((sum, item) => sum + rectArea(item.rect), 0);
  const textCoverage = clampRatio(textArea / pageArea);
  const largestImageRatio = clampRatio(
    input.images.reduce((max, image) => Math.max(max, clampRatio(rectArea(image.rect) / pageArea)), 0),
  );

  const stats: PageStats = {
    textItemCount: items.length,
    glyphCount: glyphs,
    textCoverage,
    imageCount: input.images.length,
    largestImageRatio,
  };

  const textPresent = items.length > 0;

  if (!textPresent && input.images.length === 0) {
    return { kind: 'digital', reasons: [REASONS.noContent], stats };
  }

  const fullPageImage = largestImageRatio >= FULL_PAGE_IMAGE_RATIO;
  const largeImage = largestImageRatio >= LARGE_IMAGE_RATIO;
  const sparseText = items.length <= SPARSE_TEXT_ITEM_LIMIT || textCoverage <= SPARSE_TEXT_COVERAGE;

  if (fullPageImage && glyphs <= SCAN_STAMP_GLYPH_LIMIT) {
    return {
      kind: 'scanned',
      reasons: textPresent
        ? [REASONS.fullPageImage, REASONS.stampText]
        : [REASONS.fullPageImage, REASONS.noTextLayer],
      stats,
    };
  }

  if (textPresent && largeImage && sparseText) {
    return {
      kind: 'hybrid',
      reasons: [fullPageImage ? REASONS.fullPageImage : REASONS.largeImage, REASONS.sparseText],
      stats,
    };
  }

  if (!textPresent) {
    return { kind: 'digital', reasons: [REASONS.noTextLayer, REASONS.imageBelowFullPage], stats };
  }

  return {
    kind: 'digital',
    reasons: largeImage
      ? [REASONS.textLayer, REASONS.denseTextOverImage]
      : [REASONS.textLayer, REASONS.noDominantImage],
    stats,
  };
}

/**
 * Classifies every page and summarises what the document needs. A document with
 * no pages recommends 'native': it needs no OCR because it needs nothing.
 */
export function classifyDocument(pages: readonly ClassifyPageInput[]): DocumentClassification {
  const classified = pages.map(classifyPage);
  const scannedPages = classified.filter(page => page.kind === 'scanned').length;
  const hybridPages = classified.filter(page => page.kind === 'hybrid').length;
  const digitalPages = classified.filter(page => page.kind === 'digital').length;

  // Hybrid pages still need OCR for their raster part, so a document is only
  // 'native' when no page needs OCR at all.
  const needsOcr = scannedPages + hybridPages;
  const recommended: DocumentRecommendation =
    needsOcr === 0 ? 'native' : needsOcr === classified.length ? 'ocr' : 'mixed';

  return {
    pages: classified,
    summary: { scannedPages, digitalPages, hybridPages, recommended },
  };
}
