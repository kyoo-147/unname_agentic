/**
 * Monolingual layout-preserving PDF export (backlog item G01).
 *
 * Why this module exists: browser Print reflows and repaginates through the user's print sheet,
 * losing exact source page geometry and producing inconsistent results across browsers. This writer
 * produces a real PDF file directly via `pdf-lib` with:
 *
 * - 1-based page-range filtering (`"1-3, 5"`, `number[]`, or `{ start, end }`);
 * - layout preservation at each source page's exact dimensions in points, plus optional full-bleed
 *   page raster behind the translated blocks;
 * - paper-color masking rectangles painted over every translated block before any text is drawn,
 *   so source glyphs never show through and overlapping covers never hide translated runs;
 * - structured reflow (`src/core/reflow.ts`: wrap -> shrink -> condense -> overflow marker) with
 *   explicit `overflowBlocks`, `truncatedCount`, `warnings`, and `OVERFLOW_LIMITATION` so overflow
 *   is never truncated silently;
 * - Unicode Noto Sans embedding via `src/export/fonts.ts` (falling back explicitly to WinAnsi with
 *   `FONT_LIMITATION` if unavailable) and PDF document metadata (`title`, `author`, `lang`).
 *
 * Two layers, matching `src/export/pdf.ts`: `planMonolingualPdf` is pure and synchronous (no DOM,
 * no pdf-lib); `buildMonolingualPdf` embeds the font, executes the plan, draws masks and text, and
 * writes metadata.
 */

import {
  PDFDocument,
  degrees,
  fill,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setCharacterSqueeze,
  setFillingRgbColor,
} from 'pdf-lib';
import {
  DEFAULT_CHAR_WIDTH_RATIO,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_MIN_FONT_SIZE,
  fitText as reflowFitText,
  type FitStrategy,
} from '../core/reflow';
import type { Rect } from '../core/types';
import {
  BUNDLED_FONT_NAME,
  FALLBACK_FACE_NAME,
  foldToWinAnsi,
  registerPdfFonts,
  type PdfFontsOptions,
  type PreparedText,
} from './fonts';
import {
  BIDI_LIMITATION,
  DEFAULT_BASELINE_RATIO,
  DEFAULT_INK,
  DEFAULT_MEASURE_RATIO,
  EMPTY_DOCUMENT_MESSAGE,
  FONT_LIMITATION,
  PAPER_COLOR,
  PdfExportError,
  UNICODE_GAP_LIMITATION,
  compareReadingOrder,
  type Measure,
  type PdfBlockSource,
  type PdfPageSource,
  type SkipReason,
  type SkippedBlock,
  type TextRun,
} from './pdf';

export type PageRangeInput =
  | string
  | readonly number[]
  | { start?: number; end?: number };

export interface MonolingualPdfMetadata {
  title?: string;
  author?: string;
  lang?: string;
  subject?: string;
  keywords?: readonly string[];
  creator?: string;
  producer?: string;
}

export interface PlanMonolingualPdfOptions {
  /** Page selection (`"1-3, 5"`, `[1, 3]`, or `{ start, end }`). Omitted selects all pages. */
  pageRange?: PageRangeInput;
  /** Hex colour used to mask source blocks behind translated text. Defaults to `#ffffff`. */
  paperColor?: string;
  /** Width of `text` at `size` in points. Defaults to 0.5 em per character. */
  measure?: Measure;
  /** Minimum point size allowed during shrink reflow. Defaults to `DEFAULT_MIN_FONT_SIZE` (7 pt). */
  minimumFontSize?: number;
  /** Line advance as a multiple of font size. Defaults to `DEFAULT_LINE_HEIGHT` (1.2). */
  lineHeight?: number;
  /** Baseline offset from line-box top as a fraction of font size. Defaults to 0.8. */
  baselineRatio?: number;
  /** Whether horizontal tracking compression (down to 0.9) is allowed during reflow. Default true. */
  allowCondense?: boolean;
  /** Rewrites text for the drawing face. Defaults to `foldToWinAnsi` (WinAnsi fallback). */
  prepare?: (text: string) => PreparedText;
  /** Whether `prepare` targets the Unicode face rather than the WinAnsi fallback. */
  unicode?: boolean;
  /** Font name reported in the plan. Defaults to `BUNDLED_FONT_NAME` when `unicode`, else `FALLBACK_FACE_NAME`. */
  fontName?: string;
}

export interface BuildMonolingualPdfOptions {
  pageRange?: PageRangeInput;
  paperColor?: string;
  title?: string;
  author?: string;
  lang?: string;
  producer?: string;
  metadata?: MonolingualPdfMetadata;
  measure?: Measure;
  minimumFontSize?: number;
  lineHeight?: number;
  baselineRatio?: number;
  allowCondense?: boolean;
  fonts?: PdfFontsOptions;
}

export interface MonolingualOverflowBlock {
  id: string;
  page: number;
  strategy: FitStrategy;
  clippedCharacters: number;
  leftover: string;
  unbreakableWords: number;
  truncated: boolean;
  fontSize: number;
  trackingFactor: number;
  reasons: string[];
}

export interface PlannedMonolingualBlock {
  id: string;
  /** Paper-color masking rectangle in PDF space (y-up, points) covering the source block. */
  cover: Rect;
  paperColor: string;
  inkColor: string;
  runs: TextRun[];
  fontSize: number;
  lineHeight: number;
  trackingFactor: number;
  strategy: FitStrategy;
  rotation: number;
  direction: 'ltr' | 'rtl';
  overflow: boolean;
  truncated: boolean;
  clippedCharacters: number;
  leftover: string;
  unbreakableWords: number;
  reasons: string[];
  folded: boolean;
  dropped: number;
}

export interface PlannedMonolingualPage {
  number: number;
  width: number;
  height: number;
  image: Rect | null;
  paperColor: string;
  blocks: PlannedMonolingualBlock[];
  skipped: SkippedBlock[];
  overflowBlocks: MonolingualOverflowBlock[];
  truncatedCount: number;
}

export interface MonolingualPdfPlan {
  pages: PlannedMonolingualPage[];
  selectedPages: number[];
  totalSourcePages: number;
  pageCount: number;
  blockCount: number;
  imagePages: number;
  skipped: SkippedBlock[];
  overflowBlocks: MonolingualOverflowBlock[];
  truncatedCount: number;
  warnings: string[];
  limitations: string[];
  fontName: string;
}

export interface WrittenMonolingualMetadata {
  title?: string;
  author?: string;
  lang?: string;
  subject?: string;
  keywords?: string[];
  creator: string;
  producer: string;
}

export interface MonolingualPdfResult {
  bytes: Uint8Array;
  pageCount: number;
  selectedPages: number[];
  totalSourcePages: number;
  blockCount: number;
  imagePages: number;
  skipped: SkippedBlock[];
  overflowBlocks: MonolingualOverflowBlock[];
  truncatedCount: number;
  warnings: string[];
  limitations: string[];
  fontName: string;
  metadata: WrittenMonolingualMetadata;
}

export const OVERFLOW_LIMITATION =
  'Some translated blocks overflowed their source box after reflow; trailing text was marked with "…" and reported in overflowBlocks so nothing is truncated silently.';
export const EMPTY_PAGE_RANGE_MESSAGE = 'PDF export page range matched no pages.';
export const DEFAULT_MONOLINGUAL_PRODUCER = 'Mirror monolingual PDF export';
export const DEFAULT_MONOLINGUAL_CREATOR = 'Mirror';

const EPSILON = 0.01;
const COORDINATE_PRECISION = 10_000;
const MAX_RATIO_REFINEMENTS = 4;

const defaultMeasure: Measure = (text, size) => text.length * size * DEFAULT_MEASURE_RATIO;

function round(value: number): number {
  return Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function positive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PdfExportError(`PDF export needs a positive page ${field}.`);
  }
  return value;
}

function normalizeHexColor(color: string | null | undefined, fallback: string): string {
  const raw = typeof color === 'string' ? color.trim().replace(/^#/, '') : '';
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    const expanded = raw
      .split('')
      .map(ch => `${ch}${ch}`)
      .join('')
      .toLowerCase();
    return `#${expanded}`;
  }
  return fallback;
}

function parseRgb(hexColor: string, fallback: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(hexColor, fallback).slice(1);
  const value = Number.parseInt(normalized, 16);
  return {
    r: ((value >> 16) & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: (value & 0xff) / 255,
  };
}

function normalizeBlockText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n');
}

function isFiniteRect(rect: Rect | null | undefined): rect is Rect {
  return !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);
}

function clampRect(rect: Rect, width: number, height: number): Rect {
  const left = Math.max(0, Math.min(rect.x, width));
  const top = Math.max(0, Math.min(rect.y, height));
  const right = Math.max(left, Math.min(rect.x + Math.max(0, rect.width), width));
  const bottom = Math.max(top, Math.min(rect.y + Math.max(0, rect.height), height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function positiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new PdfExportError(`Invalid page range: ${label} must be a positive integer.`);
  }
  return value;
}

/**
 * Parses a 1-based page-range specification into the selected set of page numbers.
 *
 * Accepts `"1-3, 5"`, `[1, 3]`, or `{ start, end }`. Rejects descending bounds, zero/negative
 * numbers, or malformed tokens with `PdfExportError`.
 */
export function parsePageRange(range: PageRangeInput, maxPage?: number): Set<number> {
  if (typeof range === 'string') {
    const trimmed = range.trim();
    if (!trimmed) throw new PdfExportError('Invalid page range: empty string.');
    const selected = new Set<number>();
    for (const rawPart of trimmed.split(',')) {
      const part = rawPart.trim();
      if (!part) throw new PdfExportError(`Invalid page range segment in "${range}".`);
      const single = /^(\d+)$/.exec(part);
      if (single) {
        selected.add(positiveInt(Number(single[1]), part));
        continue;
      }
      const span = /^(\d+)\s*-\s*(\d+)$/.exec(part);
      if (!span) {
        throw new PdfExportError(`Invalid page range segment "${part}".`);
      }
      const from = positiveInt(Number(span[1]), part);
      const to = positiveInt(Number(span[2]), part);
      if (from > to) {
        throw new PdfExportError(`Invalid page range "${part}": start exceeds end.`);
      }
      for (let page = from; page <= to; page++) selected.add(page);
    }
    return selected;
  }

  if (Array.isArray(range)) {
    const selected = new Set<number>();
    for (const item of range) {
      selected.add(positiveInt(item, String(item)));
    }
    return selected;
  }

  if (range && typeof range === 'object') {
    const { start, end } = range as { start?: number; end?: number };
    const from = start !== undefined ? positiveInt(start, 'start') : 1;
    const to = end !== undefined ? positiveInt(end, 'end') : maxPage;
    if (to === undefined) {
      throw new PdfExportError('Invalid page range: open-ended range requires end or document page count.');
    }
    if (from > to) {
      throw new PdfExportError(`Invalid page range: start (${from}) exceeds end (${to}).`);
    }
    const selected = new Set<number>();
    for (let page = from; page <= to; page++) selected.add(page);
    return selected;
  }

  throw new PdfExportError('Invalid page range specification.');
}

function isUnboundedRange(range: PageRangeInput | undefined): boolean {
  if (range === undefined) return true;
  if (typeof range === 'string') return range.trim().length === 0;
  if (Array.isArray(range)) return false;
  if (typeof range === 'object' && range !== null) {
    const { start, end } = range as { start?: number; end?: number };
    return start === undefined && end === undefined;
  }
  return false;
}

function selectSourcePages(pages: readonly PdfPageSource[], pageRange: PageRangeInput | undefined): PdfPageSource[] {
  if (!pages.length) throw new PdfExportError(EMPTY_DOCUMENT_MESSAGE);
  const indexed = pages.map((page, index) => ({
    page,
    index,
    number: Number.isFinite(page.number) && page.number > 0 ? Math.trunc(page.number) : index + 1,
  }));
  indexed.sort((left, right) => left.number - right.number || left.index - right.index);

  if (isUnboundedRange(pageRange)) {
    return indexed.map(entry => entry.page);
  }

  const maxPage = indexed.reduce((max, entry) => Math.max(max, entry.number), 1);
  const selected = parsePageRange(pageRange!, maxPage);
  if (selected.size === 0) throw new PdfExportError(EMPTY_PAGE_RANGE_MESSAGE);

  const filtered = indexed.filter(entry => selected.has(entry.number)).map(entry => entry.page);
  if (!filtered.length) throw new PdfExportError(EMPTY_PAGE_RANGE_MESSAGE);
  return filtered;
}

function estimateCharWidthRatio(text: string, size: number, measure: Measure): number {
  const flat = text.replace(/\n+/g, ' ');
  const units = Array.from(flat).length;
  if (units <= 0 || size <= 0) return DEFAULT_CHAR_WIDTH_RATIO;
  const width = measure(flat, size);
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_CHAR_WIDTH_RATIO;
  return clamp(width / (units * size), 0.1, 4);
}

function fitBlockWithReflow(
  text: string,
  rect: Rect,
  preferred: number,
  minimumFontSize: number,
  lineHeightRatio: number,
  allowCondense: boolean,
  measure: Measure,
) {
  const runFit = (charWidthRatio: number) =>
    reflowFitText(
      text,
      { width: rect.width, height: rect.height },
      {
        fontSize: preferred,
        minFontSize: minimumFontSize,
        lineHeight: lineHeightRatio,
        charWidthRatio,
        allowCondense,
      },
    );

  let charWidthRatio = estimateCharWidthRatio(text, preferred, measure);
  let fit = runFit(charWidthRatio);

  for (let attempt = 0; attempt < MAX_RATIO_REFINEMENTS; attempt++) {
    const maxLineWidth = fit.lines.reduce((max, line) => {
      const width = measure(line, fit.fontSize) * fit.trackingFactor;
      return Number.isFinite(width) && width > max ? width : max;
    }, 0);
    if (maxLineWidth <= rect.width + EPSILON) break;
    const nextRatio = clamp(charWidthRatio * (maxLineWidth / rect.width) * 1.02, 0.1, 4);
    if (nextRatio <= charWidthRatio + 1e-4) break;
    charWidthRatio = nextRatio;
    fit = runFit(charWidthRatio);
  }

  return fit;
}

function planMonolingualPage(
  page: PdfPageSource,
  opts: {
    measure: Measure;
    prepare: (text: string) => PreparedText;
    paperColor: string;
    minimumFontSize: number;
    lineHeightRatio: number;
    baselineRatio: number;
    allowCondense: boolean;
  },
): PlannedMonolingualPage {
  const width = positive(page.width, 'width');
  const height = positive(page.height, 'height');
  const pageNumber = Number.isFinite(page.number) ? Math.trunc(page.number) : 0;

  const skipped = new Map<number, SkipReason>();
  const source = page.blocks ?? [];
  const candidates: { block: PdfBlockSource; index: number }[] = [];
  source.forEach((block, index) => {
    if (!block || !isFiniteRect(block.rect)) {
      skipped.set(index, 'invalid');
      return;
    }
    candidates.push({ block, index });
  });

  const sorted = candidates.sort((left, right) => compareReadingOrder(left.block, right.block));

  const blocks: PlannedMonolingualBlock[] = [];
  const overflowBlocks: MonolingualOverflowBlock[] = [];
  let truncatedCount = 0;

  for (const { block, index } of sorted) {
    const prepared = opts.prepare(typeof block.text === 'string' ? block.text : '');
    const text = normalizeBlockText(prepared.text);
    if (!text) {
      skipped.set(index, prepared.dropped > 0 ? 'unrepresentable' : 'empty');
      continue;
    }
    const rect = clampRect(block.rect, width, height);
    if (rect.width <= 0 || rect.height <= 0) {
      skipped.set(index, 'invalid');
      continue;
    }

    const rotation = finite(block.rotation ?? 0, 0);
    const preferred = Math.max(1, finite(block.fontSize, 0) || Math.min(rect.height, 12));
    const fit = fitBlockWithReflow(
      text,
      rect,
      preferred,
      opts.minimumFontSize,
      opts.lineHeightRatio,
      opts.allowCondense,
      opts.measure,
    );

    const lineHeightPt = fit.fontSize * opts.lineHeightRatio;
    const cover: Rect = {
      x: round(rect.x),
      y: round(height - rect.y - rect.height),
      width: round(rect.width),
      height: round(rect.height),
    };

    const runs: TextRun[] = [];
    let baselineTruncated = false;
    for (let lineIndex = 0; lineIndex < fit.lines.length; lineIndex++) {
      const line = (fit.lines[lineIndex] ?? '').replace(/\s+$/, '');
      if (!line.trim()) continue;
      const offset = lineIndex * lineHeightPt + fit.fontSize * opts.baselineRatio;
      if (offset > rect.height + EPSILON) {
        baselineTruncated = true;
        break;
      }
      const originY = height - rect.y - offset;
      const radians = (-rotation * Math.PI) / 180;
      const x = rotation === 0 ? rect.x : rect.x + offset * Math.sin(radians);
      const y = rotation === 0 ? originY : height - rect.y - offset * Math.cos(radians);
      runs.push({ text: line, x: round(x), y: round(y) });
    }

    const widthExceeded = runs.some(
      run => opts.measure(run.text, fit.fontSize) * fit.trackingFactor > rect.width + EPSILON,
    );
    const truncated = fit.clippedCharacters > 0 || baselineTruncated;
    const overflow = fit.overflow || baselineTruncated || widthExceeded;
    const reasons = [...fit.reasons];
    if (baselineTruncated && !reasons.includes('fit:baseline-overflow')) {
      reasons.push('fit:baseline-overflow');
    }
    if (widthExceeded && !fit.overflow && !reasons.includes('fit:measured-wide')) {
      reasons.push('fit:measured-wide');
    }

    const plannedBlock: PlannedMonolingualBlock = {
      id: block.id,
      cover,
      paperColor: opts.paperColor,
      inkColor: normalizeHexColor(block.color, DEFAULT_INK),
      runs,
      fontSize: round(fit.fontSize),
      lineHeight: round(lineHeightPt),
      trackingFactor: fit.trackingFactor,
      strategy: fit.strategy,
      rotation: round(rotation),
      direction: block.direction === 'rtl' ? 'rtl' : 'ltr',
      overflow,
      truncated,
      clippedCharacters: fit.clippedCharacters,
      leftover: fit.leftover,
      unbreakableWords: fit.unbreakableWords,
      reasons,
      folded: prepared.changed,
      dropped: prepared.dropped,
    };

    blocks.push(plannedBlock);

    if (overflow) {
      if (truncated) truncatedCount += 1;
      overflowBlocks.push({
        id: block.id,
        page: pageNumber,
        strategy: fit.strategy,
        clippedCharacters: fit.clippedCharacters,
        leftover: fit.leftover,
        unbreakableWords: fit.unbreakableWords,
        truncated,
        fontSize: round(fit.fontSize),
        trackingFactor: fit.trackingFactor,
        reasons,
      });
    }
  }

  return {
    number: pageNumber,
    width: round(width),
    height: round(height),
    image: page.image && page.image.bytes.length > 0
      ? { x: 0, y: 0, width: round(width), height: round(height) }
      : null,
    paperColor: opts.paperColor,
    blocks,
    skipped: [...skipped.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([index, reason]) => ({ id: source[index]?.id ?? '', reason })),
    overflowBlocks,
    truncatedCount,
  };
}

/**
 * Pure monolingual PDF planner (no DOM, no pdf-lib).
 *
 * Applies page-range selection, converts reader geometry to PDF coordinates, computes paper-color
 * masking rects, runs reflow (`wrap -> shrink -> condense -> overflow`), and collects overflow,
 * truncation, font, glyph-gap, and bidi diagnostics without silently dropping content.
 */
export function planMonolingualPdf(
  pages: readonly PdfPageSource[],
  opts: PlanMonolingualPdfOptions = {},
): MonolingualPdfPlan {
  const selected = selectSourcePages(pages, opts.pageRange);
  const measure = opts.measure ?? defaultMeasure;
  const unicode = opts.unicode === true;
  const prepare = opts.prepare ?? foldToWinAnsi;
  const fontName = opts.fontName ?? (unicode ? BUNDLED_FONT_NAME : FALLBACK_FACE_NAME);
  const paperColor = normalizeHexColor(opts.paperColor, PAPER_COLOR);
  const minimumFontSize = Math.max(
    1,
    finite(opts.minimumFontSize ?? DEFAULT_MIN_FONT_SIZE, DEFAULT_MIN_FONT_SIZE),
  );
  const lineHeightRatio = Math.max(
    0.8,
    finite(opts.lineHeight ?? DEFAULT_LINE_HEIGHT, DEFAULT_LINE_HEIGHT),
  );
  const baselineRatio = clamp(
    finite(opts.baselineRatio ?? DEFAULT_BASELINE_RATIO, DEFAULT_BASELINE_RATIO),
    0,
    1.2,
  );
  const allowCondense = opts.allowCondense !== false;

  const plannedPages = selected.map(source =>
    planMonolingualPage(source, {
      measure,
      prepare,
      paperColor,
      minimumFontSize,
      lineHeightRatio,
      baselineRatio,
      allowCondense,
    }),
  );

  const skipped: SkippedBlock[] = [];
  const overflowBlocks: MonolingualOverflowBlock[] = [];
  let blockCount = 0;
  let imagePages = 0;
  let truncatedCount = 0;
  let rightToLeft = false;
  let glyphGap = false;

  for (const plannedPage of plannedPages) {
    skipped.push(...plannedPage.skipped);
    for (const entry of plannedPage.skipped) {
      if (entry.reason === 'unrepresentable') glyphGap = true;
    }
    if (plannedPage.image) imagePages += 1;
    overflowBlocks.push(...plannedPage.overflowBlocks);
    truncatedCount += plannedPage.truncatedCount;
    for (const block of plannedPage.blocks) {
      if (block.direction === 'rtl') rightToLeft = true;
      if (block.dropped > 0) glyphGap = true;
      blockCount += 1;
    }
  }

  const limitations = new Set<string>();
  if (!unicode) limitations.add(FONT_LIMITATION);
  if (unicode && glyphGap) limitations.add(UNICODE_GAP_LIMITATION);
  if (rightToLeft) limitations.add(BIDI_LIMITATION);

  const warnings: string[] = [];
  if (overflowBlocks.length > 0) {
    const clippedTotal = overflowBlocks.reduce((sum, entry) => sum + entry.clippedCharacters, 0);
    limitations.add(OVERFLOW_LIMITATION);
    warnings.push(
      `${overflowBlocks.length} block(s) overflowed their source box (${truncatedCount} truncated, ${clippedTotal} character(s) clipped).`,
    );
  }

  return {
    pages: plannedPages,
    selectedPages: plannedPages.map(page => page.number),
    totalSourcePages: pages.length,
    pageCount: plannedPages.length,
    blockCount,
    imagePages,
    skipped,
    overflowBlocks,
    truncatedCount,
    warnings,
    limitations: [...limitations],
    fontName,
  };
}

function cleanMetadataText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveMetadata(opts: BuildMonolingualPdfOptions): WrittenMonolingualMetadata {
  const meta = opts.metadata ?? {};
  const title = cleanMetadataText(meta.title ?? opts.title);
  const author = cleanMetadataText(meta.author ?? opts.author);
  const lang = cleanMetadataText(meta.lang ?? opts.lang);
  const subject = cleanMetadataText(meta.subject);
  const keywords = Array.isArray(meta.keywords)
    ? meta.keywords.map(item => item.trim()).filter(item => item.length > 0)
    : undefined;
  const creator = cleanMetadataText(meta.creator) ?? DEFAULT_MONOLINGUAL_CREATOR;
  const producer = cleanMetadataText(meta.producer ?? opts.producer) ?? DEFAULT_MONOLINGUAL_PRODUCER;

  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(lang ? { lang } : {}),
    ...(subject ? { subject } : {}),
    ...(keywords && keywords.length > 0 ? { keywords } : {}),
    creator,
    producer,
  };
}

/**
 * Exports a real monolingual translated PDF (`Uint8Array`) via `pdf-lib` and `fonts.ts`.
 *
 * Reuses `planMonolingualPdf` for page-range filtering, reading order, paper-color cover rects,
 * and `reflow.ts`-based shrink/condense/overflow reporting, then embeds Noto Sans Unicode once per
 * document, draws background rasters (when provided), paper-color masks, and translated runs, and
 * writes PDF metadata (`title`, `author`, `lang`, `creator`, `producer`).
 */
export async function buildMonolingualPdf(
  pages: readonly PdfPageSource[],
  opts: BuildMonolingualPdfOptions = {},
): Promise<MonolingualPdfResult> {
  // Validate selection before allocating PDF resources or embedding fonts.
  const selectedSources = selectSourcePages(pages, opts.pageRange);
  const doc = await PDFDocument.create();
  const fonts = await registerPdfFonts(doc, opts.fonts);
  const font = fonts.font;

  const measure: Measure = opts.measure ?? ((text, size) => {
    try {
      return font.widthOfTextAtSize(text, size);
    } catch {
      return defaultMeasure(text, size);
    }
  });

  const plan = planMonolingualPdf(selectedSources, {
    paperColor: opts.paperColor,
    measure,
    minimumFontSize: opts.minimumFontSize,
    lineHeight: opts.lineHeight,
    baselineRatio: opts.baselineRatio,
    allowCondense: opts.allowCondense,
    prepare: fonts.prepare,
    unicode: fonts.unicode,
    fontName: fonts.name,
  });

  const limitations = new Set<string>(plan.limitations);
  let embeddedImages = 0;

  for (let index = 0; index < plan.pages.length; index++) {
    const plannedPage = plan.pages[index]!;
    const source = selectedSources[index]!;
    const target = doc.addPage([plannedPage.width, plannedPage.height]);
    target.setFont(font);

    if (source.image && source.image.bytes.length > 0) {
      try {
        const embedded = source.image.format === 'jpeg'
          ? await doc.embedJpg(source.image.bytes)
          : await doc.embedPng(source.image.bytes);
        target.drawImage(embedded, {
          x: 0,
          y: 0,
          width: plannedPage.width,
          height: plannedPage.height,
        });
        embeddedImages += 1;
      } catch {
        limitations.add(
          `Page ${plannedPage.number}: the source image could not be embedded, so only the translated text is present.`,
        );
      }
    }

    // Paint all paper-color covers before any text so overlapping covers never mask written runs.
    for (const block of plannedPage.blocks) {
      const color = parseRgb(block.paperColor, PAPER_COLOR);
      target.pushOperators(
        pushGraphicsState(),
        setFillingRgbColor(color.r, color.g, color.b),
        rectangle(block.cover.x, block.cover.y, block.cover.width, block.cover.height),
        fill(),
        popGraphicsState(),
      );
    }

    for (const block of plannedPage.blocks) {
      if (!block.runs.length) continue;
      const ink = parseRgb(block.inkColor, DEFAULT_INK);
      const condensed = block.trackingFactor < 0.9999;
      if (condensed) {
        target.pushOperators(pushGraphicsState(), setCharacterSqueeze(round(block.trackingFactor * 100)));
      }
      for (const run of block.runs) {
        target.drawText(run.text, {
          x: run.x,
          y: run.y,
          size: block.fontSize,
          color: rgb(ink.r, ink.g, ink.b),
          ...(block.rotation === 0 ? {} : { rotate: degrees(-block.rotation) }),
        });
      }
      if (condensed) {
        target.pushOperators(popGraphicsState());
      }
    }
  }

  const metadata = resolveMetadata(opts);
  if (metadata.title) doc.setTitle(metadata.title);
  if (metadata.author) doc.setAuthor(metadata.author);
  if (metadata.lang) doc.setLanguage(metadata.lang);
  if (metadata.subject) doc.setSubject(metadata.subject);
  if (metadata.keywords) doc.setKeywords(metadata.keywords);
  doc.setCreator(metadata.creator);
  doc.setProducer(metadata.producer);

  const bytes = await doc.save();

  return {
    bytes,
    pageCount: doc.getPageCount(),
    selectedPages: plan.selectedPages,
    totalSourcePages: pages.length,
    blockCount: plan.blockCount,
    imagePages: embeddedImages,
    skipped: plan.skipped,
    overflowBlocks: plan.overflowBlocks,
    truncatedCount: plan.truncatedCount,
    warnings: plan.warnings,
    limitations: [...limitations],
    fontName: fonts.name,
    metadata,
  };
}
