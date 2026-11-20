/**
 * Real PDF export: rebuild the reader's pages as an actual PDF file.
 *
 * Why this module exists: `print.ts` hands a print sheet to the browser, so a reader who wants a file
 * gets whatever the print dialog produces — reflowed, repaginated, and only as good as the paper size.
 * This module writes the PDF itself, so it keeps the reader's own geometry:
 *
 * - one output page per source page, at the source page size in points;
 * - the original page raster drawn full-bleed as the background;
 * - for every translated block, a paper rectangle over exactly that block's rect and the translated
 *   text drawn inside it. The rect is the same `TextBlock.rect` the reader paints over, so the covered
 *   area matches what the reader covers.
 *
 * Two layers: `pagePlan` is pure — page size, image placement and the wrapped text runs in PDF space —
 * and is unit-tested without a DOM; `buildPdf` embeds the plan with pdf-lib. `canvasToPng` is the only
 * browser-only helper and no DOM object is resolved at module scope, so the module imports in node.
 *
 * Font limitation (deliberate, reported, never silent): pdf-lib can only embed a custom TrueType face
 * after `@pdf-lib/fontkit` is registered, which would be a second dependency, and this project ships
 * no redistributable Unicode font file either. The build therefore uses the standard Helvetica face,
 * which is WinAnsi-only, and folds non-WinAnsi letters to their closest Latin form: "Tiếng Việt" is
 * printed as "Tieng Viet" rather than as tofu. Digits, Latin text and punctuation are left exactly as
 * they are. `FONT_LIMITATION` says this in words and `buildPdf` returns it, so the caller can warn.
 */

import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { Rect } from '../core/types';
import { fitText } from '../pdf/layout';

export type Measure = (text: string, size: number) => number;

export interface PdfImageSource {
  format: 'png' | 'jpeg';
  bytes: Uint8Array;
}

export interface PdfBlockSource {
  id: string;
  text: string;
  /** Block rect in reader space: origin at the page's top-left, y growing down, in points. */
  rect: Rect;
  fontSize: number;
  direction?: 'ltr' | 'rtl' | null;
  /** Glyph rotation in degrees, clockwise, as measured by the reader. */
  rotation?: number | null;
  /** Ink colour of the source block; falls back to the reader's default ink. */
  color?: string | null;
}

export interface PdfPageSource {
  number: number;
  /** Page size in points, taken from the source page viewport at scale 1. */
  width: number;
  height: number;
  image?: PdfImageSource | null;
  blocks?: readonly PdfBlockSource[];
}

/** A single drawn line. `x`/`y` are the baseline origin in PDF space: y-up, page points. */
export interface TextRun {
  text: string;
  x: number;
  y: number;
}

export interface PlannedBlock {
  id: string;
  /** Paper rectangle in PDF space that hides the source glyphs behind this block. */
  cover: Rect;
  runs: TextRun[];
  fontSize: number;
  lineHeight: number;
  rotation: number;
  direction: 'ltr' | 'rtl';
  /** True when the translated text did not fit and trailing lines were dropped. */
  truncated: boolean;
  /** True when WinAnsi folding changed at least one character. */
  folded: boolean;
  /** Characters that had no WinAnsi form and were removed. */
  dropped: number;
}

export type SkipReason = 'empty' | 'unrepresentable' | 'invalid';

export interface SkippedBlock {
  id: string;
  reason: SkipReason;
}

export interface PlannedPage {
  number: number;
  width: number;
  height: number;
  /** Full-bleed image placement in PDF space, or null when the page has no raster. */
  image: Rect | null;
  blocks: PlannedBlock[];
  skipped: SkippedBlock[];
}

export interface PagePlanOptions {
  /** Width of `text` at `size` in points. Defaults to a flat 0.5 em per character. */
  measure?: Measure;
  minimumFontSize?: number;
  /** Baseline offset from the top of a line box, as a fraction of the font size. */
  baselineRatio?: number;
}

export interface BuildPdfOptions {
  title?: string;
  measure?: Measure;
  minimumFontSize?: number;
  /** Producer line written into the PDF metadata. */
  producer?: string;
}

export interface BuildPdfResult {
  bytes: Uint8Array;
  pageCount: number;
  blockCount: number;
  imagePages: number;
  skipped: SkippedBlock[];
  /** Human-readable limits of this build, always including the font limitation. */
  limitations: string[];
  fontName: string;
}

export const FONT_NAME = 'Helvetica (WinAnsi)';
export const FONT_LIMITATION =
  'PDF export uses the built-in Helvetica face, which covers WinAnsi only. Vietnamese and other non-WinAnsi letters are folded to their closest Latin form ("Tiếng Việt" prints as "Tieng Viet") instead of being drawn as tofu. Digits, Latin text and punctuation are unchanged. Embedding a Unicode face needs @pdf-lib/fontkit plus a redistributable font file, and this export ships no extra dependency.';
export const BIDI_LIMITATION =
  'Right-to-left text is written in logical order: glyph shaping and bidi reordering are not applied by this writer.';
export const NO_CANVAS_MESSAGE = 'PDF export needs a canvas to read the page image; this environment has none.';
export const EMPTY_DOCUMENT_MESSAGE = 'PDF export needs at least one page.';

export const DEFAULT_BASELINE_RATIO = 0.8;
export const DEFAULT_MINIMUM_FONT_SIZE = 6;
export const DEFAULT_MEASURE_RATIO = 0.5;
export const READING_BAND_PT = 2;
export const PAPER_COLOR = '#ffffff';
export const DEFAULT_INK = '#202724';
const DEFAULT_PRODUCER = 'Mirror PDF export';
const EPSILON = 0.01;
const COORDINATE_PRECISION = 10_000;

/** Carries a stable `name` so the caller can classify the failure without matching message text. */
export class PdfExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfExportError';
  }
}

/**
 * Characters that WinAnsi cannot encode but whose intent is unambiguous. Applied before
 * decomposition, so typographic quotes and arrows degrade to the ASCII the reader expects.
 */
const FOLD_MAP: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"',
  '\u2013': '-', '\u2014': '-', '\u2012': '-', '\u2212': '-',
  '\u2026': '...', '\u2022': '*', '\u00b7': '.', '\u2032': "'", '\u2033': '"',
  '\u2192': '->', '\u2190': '<-', '\u2194': '<->', '\u21d2': '=>',
  '\u2264': '<=', '\u2265': '>=', '\u2260': '!=', '\u00d7': 'x', '\u00f7': '/',
  '\u0110': 'D', '\u0111': 'd', '\u01a0': 'O', '\u01a1': 'o', '\u01af': 'U', '\u01b0': 'u',
  '\u00a0': ' ', '\u2007': ' ', '\u202f': ' ', '\u2009': ' ', '\u200a': ' ', '\u200b': '', '\ufeff': '',
  '\u00ad': '', '\u2010': '-', '\u2011': '-',
};

/** Code points Windows-1252 actually maps: ASCII, the 0xA0-0xFF range and the 0x80-0x9F specials. */
function isWinAnsiCodePoint(code: number): boolean {
  if (code > 0x1f && code < 0x7f) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return code === 0x80 || (code >= 0x82 && code <= 0x8c) || code === 0x8e
    || (code >= 0x91 && code <= 0x9c) || (code >= 0x9e && code <= 0x9f);
}

const COMBINING_MARK = /^[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]$/u;

export interface FoldResult {
  text: string;
  /** True when at least one code point was replaced or removed. */
  changed: boolean;
  /** Code points that vanished entirely (no WinAnsi form and no decomposition base). */
  dropped: number;
}

/**
 * Rewrites text into the WinAnsi repertoire: decomposes accented letters and drops the marks, keeps
 * every character WinAnsi already has (so "café" stays "café"), and removes whatever is left. ASCII
 * digits are never touched — that is what "numbers must not be altered" means here.
 */
export function foldToWinAnsi(input: string): FoldResult {
  const source = typeof input === 'string' ? input : '';
  let text = '';
  let changed = false;
  let dropped = 0;
  for (const character of source) {
    const code = character.codePointAt(0) ?? 0;
    if (isWinAnsiCodePoint(code)) { text += character; continue; }
    const mapped = FOLD_MAP[character];
    if (mapped !== undefined) { text += mapped; changed = true; continue; }
    const decomposed = character.normalize('NFD');
    let kept = '';
    for (const part of decomposed) {
      const partCode = part.codePointAt(0) ?? 0;
      if (isWinAnsiCodePoint(partCode)) kept += part;
      // Combining marks and anything still unencodable are removed; `dropped` below records a
      // character that left nothing behind at all.
    }
    if (kept) { text += kept; changed = true; continue; }
    changed = true;
    dropped++;
  }
  return { text, changed, dropped };
}

/** True when every code point of `text` can be written with WinAnsi as it stands. */
export function isWinAnsiText(text: string): boolean {
  for (const character of text) if (!isWinAnsiCodePoint(character.codePointAt(0) ?? 0)) return false;
  return true;
}

const defaultMeasure: Measure = (text, size) => text.length * size * DEFAULT_MEASURE_RATIO;

function round(value: number): number {
  return Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new PdfExportError(`PDF export needs a positive page ${field}.`);
  return value;
}

function parseInk(color: string | null | undefined): { r: number; g: number; b: number } {
  const hex = typeof color === 'string' ? color.trim().replace(/^#/, '') : '';
  if (!/^[0-9a-f]{6}$/i.test(hex)) return parseInk(DEFAULT_INK);
  const value = Number.parseInt(hex, 16);
  return { r: ((value >> 16) & 0xff) / 255, g: ((value >> 8) & 0xff) / 255, b: (value & 0xff) / 255 };
}

/** Line breaks are normalised and per-line padding is dropped; digits keep their exact form. */
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

/**
 * Clamps a reader rect to the page. Source geometry occasionally reports a rect that starts a
 * fraction outside the page; covering what is on the page is better than covering nothing.
 */
function clampRect(rect: Rect, width: number, height: number): Rect {
  const left = Math.max(0, Math.min(rect.x, width));
  const top = Math.max(0, Math.min(rect.y, height));
  const right = Math.max(left, Math.min(rect.x + Math.max(0, rect.width), width));
  const bottom = Math.max(top, Math.min(rect.y + Math.max(0, rect.height), height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Reading order: top to bottom in bands of `READING_BAND_PT`, then left to right — right to left when
 * both neighbours are right-to-left. A band keeps a heading and the line under it from swapping when
 * their baselines disagree by a fraction of a point.
 */
export function compareReadingOrder(left: PdfBlockSource, right: PdfBlockSource): number {
  const delta = left.rect.y - right.rect.y;
  if (Math.abs(delta) > READING_BAND_PT) return delta;
  const rtl = (left.direction ?? 'ltr') === 'rtl' && (right.direction ?? 'ltr') === 'rtl';
  return rtl ? right.rect.x - left.rect.x : left.rect.x - right.rect.x;
}

/**
 * Pure per-page plan. No DOM, no pdf-lib: page size, image placement, and one entry per translated
 * block holding the paper cover and the wrapped runs, already converted into PDF space (y-up).
 */
export function pagePlan(page: PdfPageSource, opts: PagePlanOptions = {}): PlannedPage {
  const width = positive(page.width, 'width');
  const height = positive(page.height, 'height');
  const measure = opts.measure ?? defaultMeasure;
  const minimumFontSize = Math.max(1, finite(opts.minimumFontSize ?? DEFAULT_MINIMUM_FONT_SIZE, DEFAULT_MINIMUM_FONT_SIZE));
  const baselineRatio = Math.max(0, Math.min(1.2, finite(opts.baselineRatio ?? DEFAULT_BASELINE_RATIO, DEFAULT_BASELINE_RATIO)));

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

  const planned: PlannedBlock[] = [];
  for (const { block, index } of candidates.sort((left, right) => compareReadingOrder(left.block, right.block))) {
    const folded = foldToWinAnsi(block.text);
    const text = normalizeBlockText(folded.text);
    if (!text) {
      skipped.set(index, folded.dropped > 0 ? 'unrepresentable' : 'empty');
      continue;
    }
    const rect = clampRect(block.rect, width, height);
    if (rect.width <= 0 || rect.height <= 0) {
      skipped.set(index, 'invalid');
      continue;
    }
    const rotation = finite(block.rotation ?? 0, 0);
    const preferred = Math.max(1, finite(block.fontSize, 0) || Math.min(rect.height, 12));
    const fit = fitText(text, rect.width, rect.height, preferred, measure, minimumFontSize);
    const lineHeight = fit.lineHeight > 0 ? fit.lineHeight : fit.fontSize * 1.15;
    const cover: Rect = {
      x: round(rect.x),
      y: round(height - rect.y - rect.height),
      width: round(rect.width),
      height: round(rect.height),
    };
    const runs: TextRun[] = [];
    let truncated = false;
    for (let index = 0; index < fit.lines.length; index++) {
      const line = (fit.lines[index] ?? '').replace(/\s+$/, '');
      if (!line.trim()) continue;
      const offset = index * lineHeight + fit.fontSize * baselineRatio;
      // A line whose baseline falls below the rect would be printed over source glyphs the cover
      // does not reach, so it is dropped and the block is reported as truncated.
      if (offset > rect.height + EPSILON) { truncated = true; break; }
      // Rotated glyphs are rare and the reader flags them; the run origin turns around the block's
      // top-left corner so a sideways label still lands inside its own rect.
      const originY = height - rect.y - offset;
      const radians = (-rotation * Math.PI) / 180;
      const x = rotation === 0 ? rect.x : rect.x + offset * Math.sin(radians);
      const y = rotation === 0 ? originY : height - rect.y - offset * Math.cos(radians);
      runs.push({ text: line, x: round(x), y: round(y) });
    }
    if (!runs.length) {
      skipped.set(index, 'unrepresentable');
      continue;
    }
    planned.push({
      id: block.id,
      cover,
      runs,
      fontSize: round(fit.fontSize),
      lineHeight: round(lineHeight),
      rotation: round(rotation),
      direction: block.direction === 'rtl' ? 'rtl' : 'ltr',
      // `fitText` also reports a line wider than the rect; that text spills past the cover, which
      // counts as not fitting.
      truncated: truncated || fit.overflow,
      folded: folded.changed,
      dropped: folded.dropped,
    });
  }

  return {
    number: finite(page.number, 0),
    width: round(width),
    height: round(height),
    image: page.image && page.image.bytes.length > 0 ? { x: 0, y: 0, width: round(width), height: round(height) } : null,
    blocks: planned,
    // Skipped blocks are reported in source order, so a caller can line them up with its own list.
    skipped: [...skipped.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([index, reason]) => ({ id: source[index]?.id ?? '', reason })),
  };
}

/**
 * Writes the plan into a PDF. Covers are drawn for every block before any text, so an overlapping
 * cover can never paint over text that was already written.
 */
export async function buildPdf(pages: readonly PdfPageSource[], opts: BuildPdfOptions = {}): Promise<BuildPdfResult> {
  if (!pages.length) throw new PdfExportError(EMPTY_DOCUMENT_MESSAGE);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ink = parseInk(DEFAULT_INK);
  const paper = parseInk(PAPER_COLOR);
  const measure: Measure = opts.measure ?? ((text, size) => {
    try {
      return font.widthOfTextAtSize(text, size);
    } catch {
      return defaultMeasure(text, size);
    }
  });
  const limitations = new Set<string>([FONT_LIMITATION]);
  const skipped: SkippedBlock[] = [];
  let blockCount = 0;
  let imagePages = 0;
  let rightToLeft = false;

  for (const source of pages) {
    const plan = pagePlan(source, { measure, minimumFontSize: opts.minimumFontSize });
    const target = doc.addPage([plan.width, plan.height]);
    skipped.push(...plan.skipped);
    if (source.image && source.image.bytes.length > 0) {
      try {
        const embedded = source.image.format === 'jpeg' ? await doc.embedJpg(source.image.bytes) : await doc.embedPng(source.image.bytes);
        target.drawImage(embedded, { x: 0, y: 0, width: plan.width, height: plan.height });
        imagePages++;
      } catch {
        limitations.add(`Page ${plan.number}: the source image could not be embedded, so only the translated text is present.`);
      }
    }
    for (const block of plan.blocks) {
      target.drawRectangle({ x: block.cover.x, y: block.cover.y, width: block.cover.width, height: block.cover.height, color: rgb(paper.r, paper.g, paper.b) });
    }
    for (const block of plan.blocks) {
      if (block.direction === 'rtl') rightToLeft = true;
      for (const run of block.runs) {
        target.drawText(run.text, {
          x: run.x,
          y: run.y,
          size: block.fontSize,
          font,
          color: rgb(ink.r, ink.g, ink.b),
          ...(block.rotation === 0 ? {} : { rotate: degrees(-block.rotation) }),
        });
      }
      blockCount++;
    }
  }

  if (rightToLeft) limitations.add(BIDI_LIMITATION);
  const title = typeof opts.title === 'string' ? opts.title.trim() : '';
  if (title) doc.setTitle(title);
  doc.setProducer(opts.producer ?? DEFAULT_PRODUCER);
  doc.setCreator('Mirror');
  const bytes = await doc.save();
  return {
    bytes,
    pageCount: doc.getPageCount(),
    blockCount,
    imagePages,
    skipped,
    limitations: [...limitations],
    fontName: FONT_NAME,
  };
}

/**
 * Reads a rendered page canvas as PNG bytes for `buildPdf`. This is the only browser-only helper in
 * the module and it resolves `document`-free canvas APIs, so importing the module stays node-safe.
 */
export async function canvasToPng(canvas: HTMLCanvasElement): Promise<PdfImageSource> {
  if (!canvas || typeof canvas !== 'object') throw new PdfExportError(NO_CANVAS_MESSAGE);
  const blob = typeof canvas.toBlob === 'function'
    ? await new Promise<Blob | null>(resolve => canvas.toBlob(result => resolve(result), 'image/png'))
    : null;
  if (blob) return { format: 'png', bytes: new Uint8Array(await blob.arrayBuffer()) };
  if (typeof canvas.toDataURL === 'function' && typeof atob === 'function') {
    const dataUrl = canvas.toDataURL('image/png');
    const comma = dataUrl.indexOf(',');
    if (comma > 0) {
      const binary = atob(dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return { format: 'png', bytes };
    }
  }
  throw new PdfExportError(NO_CANVAS_MESSAGE);
}
