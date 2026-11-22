/**
 * Searchable-scan PDF writer (backlog F05).
 *
 * Why this module exists: OCR turns a scan into text, but exporting the scan as it stands keeps only
 * pixels — there is nothing to select, copy or search. OCRmyPDF solves this in `hocr_to_ocr_pdf`:
 * leave the raster untouched and lay an *invisible* text layer over every source box, so the page
 * still looks like the scan while a reader's text layer knows what each region says and where.
 *
 * Invisibility is PDF text render mode 3 (`Tr 3`), not `opacity: 0`. An opacity-zero fill still asks
 * the reader to paint transparent glyphs, and readers disagree about whether such a group belongs to
 * the text layer at all; mode 3 is defined as "neither fill nor stroke", so glyphs are never painted
 * while their advances still place real text at the right coordinates — exactly what copy, selection
 * and search consume. The operator is pushed as a raw content-stream operator because pdf-lib's
 * `drawText` has no render-mode option and drawing white text would smear over the scan in a dark
 * theme or on tinted paper.
 *
 * Two layers, same split as `./pdf`:
 * - `layoutTextRun` is pure: one block plus one page box give the run origin, size and text in PDF
 *   space, with the scaling rule written down below, so tests need no canvas.
 * - `buildSearchablePdf` embeds the scan and writes those runs with pdf-lib.
 *
 * A block is one run over one rect, and the caller owns line breaking. OCR already knows each line's
 * box; guessing a split here would place invisible text over the wrong glyphs, which is worse than a
 * coarse box. Pass one block per source line.
 *
 * Font limitation (deliberate, reported, never silent): this writer embeds a standard WinAnsi face.
 * Non-WinAnsi letters are folded to their closest Latin form. A Unicode face is available to the
 * translated-text export (`./fonts`), but routing this layer through it is a follow-up: the layout
 * would have to take the face's repertoire as an input instead of assuming WinAnsi. Mirror's own
 * search folds diacritics the same way (`foldSearchText`), so a folded layer still matches a
 * diacritic query inside the app even though another reader's search needs the folded spelling.
 */

import {
  PDFDocument,
  StandardFonts,
  TextRenderingMode,
  popGraphicsState,
  pushGraphicsState,
  setTextRenderingMode,
} from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import type { Rect } from '../core/types';
import { foldToWinAnsi } from './pdf';

/** A face as far as layout cares: it can tell how wide `text` is at `size` points. */
export interface RunFont {
  widthOfTextAtSize(text: string, size: number): number;
}

/** The page box a run is laid out in, in points. */
export interface RunPage {
  width: number;
  height: number;
}

/** A single run ready to be written: `x`/`y` are the baseline origin in PDF space (y up). */
export interface TextRunLayout {
  x: number;
  y: number;
  size: number;
  text: string;
}

export interface SearchableImageSource {
  format: 'png' | 'jpeg';
  bytes: Uint8Array;
}

export interface SearchablePageSource {
  /** 1-based page number; defaults to the page's position in `pages`. */
  number?: number;
  /** Page width in points. */
  width: number;
  /** Page height in points. */
  height: number;
  /** The scanned raster, drawn full-bleed so the export never loses the original image. */
  image?: SearchableImageSource | null;
}

export interface SearchableBlockSource {
  id?: string;
  /** 1-based page number the block sits on. */
  page: number;
  text: string;
  /** Block rect in reader space: origin at the page's top-left, y growing down, in points. */
  rect: Rect;
}

export type RunSkipReason = 'empty' | 'unrepresentable' | 'invalid' | 'no-page';

export interface SkippedRun {
  id: string;
  page: number;
  reason: RunSkipReason;
}

export interface BuildSearchablePdfInput {
  pages: readonly SearchablePageSource[];
  blocks: readonly SearchableBlockSource[];
  font?: StandardFonts;
  title?: string;
  producer?: string;
}

export interface BuildSearchablePdfResult {
  bytes: Uint8Array;
  pageCount: number;
  runCount: number;
  imagePages: number;
  /** Blocks that produced no run, in source order. */
  skipped: SkippedRun[];
  /** Runs still wider than their block after shrinking, so selection may pass the scan's edge. */
  overflowing: number;
  /** Human-readable limits of this build, always including the font limitation. */
  limitations: string[];
  fontName: string;
}

export const FONT_LIMITATION =
  'The searchable text layer uses a standard WinAnsi face. Non-WinAnsi letters are folded to their closest Latin form ("Tiếng Việt" is written as "Tieng Viet"), so the invisible layer can be selected and searched but not spelled exactly like the scan. Mirror\'s own search folds diacritics the same way, so a diacritic query still matches inside the app; another reader needs the folded spelling. Writing the exact spelling needs a Unicode face embedded in this layer.';

export const OVERFLOW_LIMITATION =
  'Some blocks could not shrink enough to fit their text: those runs are wider than the source box, so selecting them can extend past the scanned glyphs.';

export const EMPTY_DOCUMENT_MESSAGE = 'A searchable PDF needs at least one page.';
export const SYMBOL_FONT_MESSAGE =
  'The searchable text layer needs a text face with a WinAnsi encoding; Symbol and ZapfDingbats are glyph-only and cannot carry OCR text.';
export const DEFAULT_PRODUCER = 'Mirror searchable export';

/**
 * Ascent as a fraction of the font size: how far below the block's top edge the baseline sits. The
 * em box is treated as the glyph box (see the layout rule), so 0.8 puts the ascender at the top of
 * the source box and leaves the descender inside it.
 */
export const DEFAULT_BASELINE_RATIO = 0.8;

/** Ratio of the glyph box to the font size. One means the em box is the glyph box. */
export const DEFAULT_GLYPH_BOX_RATIO = 1;

/** Smallest size the writer will emit; a zero-size text object is not reliably selectable. */
export const MIN_FONT_SIZE = 1;

const EPSILON = 0.01;
const COORDINATE_PRECISION = 10_000;

/** Carries a stable `name` so the caller can classify the failure without matching message text. */
export class SearchablePdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchablePdfError';
  }
}

type BlockSkipReason = Exclude<RunSkipReason, 'no-page'>;

type RunPlan =
  | { ok: true; run: TextRunLayout; overflow: boolean }
  | { ok: false; reason: BlockSkipReason };

function round(value: number): number {
  return Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Line breaks and padding collapse to single spaces: the layer holds one run per line. */
function normalizeRunText(text: string): string {
  return (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim();
}

/**
 * Clamps a reader rect to the page. OCR geometry occasionally reports a box that starts a fraction
 * outside the page; keeping the visible part is better than dropping the whole line.
 */
function clampBlockRect(rect: Rect, page: RunPage): Rect | null {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  const left = clamp(rect.x, 0, page.width);
  const top = clamp(rect.y, 0, page.height);
  const right = clamp(rect.x + Math.max(0, rect.width), left, page.width);
  const bottom = clamp(rect.y + Math.max(0, rect.height), top, page.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function measureWidth(font: RunFont, text: string, size: number): number {
  const width = font.widthOfTextAtSize(text, size);
  return Number.isFinite(width) && width > 0 ? width : 0;
}

/**
 * Layout rule, in order:
 *
 * 1. Glyph height is the anchor. The em box is treated as the glyph box, so the starting size is
 *    `rect.height / DEFAULT_GLYPH_BOX_RATIO` points — a 12pt-tall OCR line gets 12pt glyphs. The
 *    reader-space top becomes `page.height - rect.y` in PDF space.
 * 2. Width is fitted next, never height. Advance width grows linearly with the size, so one
 *    proportional step (`rect.width / width`) lands the run exactly on the block's right edge. The
 *    size only shrinks, never grows: matching the scan's glyph height matters more than filling the
 *    box, because a run that is too tall is harder to select than one that stops short.
 * 3. The baseline is `DEFAULT_BASELINE_RATIO * size` below the block's top edge and `x` is the
 *    block's left edge. With no width shrink the glyph box fills the block exactly; after a shrink
 *    the glyph box hangs from the block's top edge, which keeps the run on the line OCR measured.
 *
 * Returns null when the block cannot produce a run at all (empty text, nothing encodable, or a rect
 * that is not on the page). A block that only shrinks to `MIN_FONT_SIZE` still returns a run and is
 * reported as overflowing by `buildSearchablePdf`.
 */
function planRun(block: { text: string; rect: Rect }, page: RunPage, font: RunFont): RunPlan {
  const usablePage = Number.isFinite(page.width) && page.width > 0
    && Number.isFinite(page.height) && page.height > 0;
  if (!usablePage) return { ok: false, reason: 'invalid' };

  const text = normalizeRunText(block.text);
  if (!text) return { ok: false, reason: 'empty' };
  const folded = foldToWinAnsi(text).text.trim();
  if (!folded) return { ok: false, reason: 'unrepresentable' };

  const box = clampBlockRect(block.rect, page);
  if (!box) return { ok: false, reason: 'invalid' };

  let size = box.height / DEFAULT_GLYPH_BOX_RATIO;
  let width = measureWidth(font, folded, size);
  if (width > box.width) size = Math.max(MIN_FONT_SIZE, size * (box.width / width));
  width = measureWidth(font, folded, size);

  return {
    ok: true,
    run: {
      x: round(box.x),
      y: round(page.height - box.y - size * DEFAULT_BASELINE_RATIO),
      size: round(size),
      text: folded,
    },
    overflow: width > box.width + EPSILON,
  };
}

/** Pure layout for one block: the run origin, font size and text in PDF space, or null. */
export function layoutTextRun(block: { text: string; rect: Rect }, page: RunPage, font: RunFont): TextRunLayout | null {
  const plan = planRun(block, page, font);
  return plan.ok ? plan.run : null;
}

/**
 * Writes one run in text render mode 3. `q`/`Q` bracket it so the invisible text state never leaks
 * into operators the caller pushes onto the same page afterwards.
 *
 * The page's font must already be set with `page.setFont`. Passing `font` per call would make
 * pdf-lib register a fresh `/Font` resource entry for every run (it restores the previous font after
 * each `drawText`, and each registration takes a new name), so a 200-line page would carry 400
 * identical font entries that a reader has to resolve.
 */
function drawInvisibleRun(page: PDFPage, run: TextRunLayout): void {
  page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
  page.drawText(run.text, { x: run.x, y: run.y, size: run.size });
  page.pushOperators(popGraphicsState());
}

function pageNumberOf(source: SearchablePageSource, index: number): number {
  const number = source.number;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : index + 1;
}

function positive(value: number, field: 'width' | 'height'): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SearchablePdfError(`A searchable PDF page needs a positive ${field}.`);
  }
  return value;
}

function blockId(block: SearchableBlockSource, index: number): string {
  return typeof block.id === 'string' && block.id.length > 0 ? block.id : `block-${index}`;
}

/**
 * Builds a PDF that keeps each scan as a full-bleed image and adds the OCR text as an invisible layer
 * positioned over the source boxes.
 */
export async function buildSearchablePdf(input: BuildSearchablePdfInput): Promise<BuildSearchablePdfResult> {
  const pages = input.pages;
  if (!pages.length) throw new SearchablePdfError(EMPTY_DOCUMENT_MESSAGE);
  const face = input.font ?? StandardFonts.Helvetica;
  if (face === StandardFonts.Symbol || face === StandardFonts.ZapfDingbats) {
    throw new SearchablePdfError(SYMBOL_FONT_MESSAGE);
  }

  const blocks = input.blocks;
  const pageByNumber = new Map<number, number>();
  pages.forEach((source, index) => {
    const number = pageNumberOf(source, index);
    if (!pageByNumber.has(number)) pageByNumber.set(number, index);
  });

  // Skips are keyed by source index so the reported order matches the caller's list, not the order
  // pages happen to be written in.
  const skippedInfo = new Map<number, { id: string; page: number; reason: RunSkipReason }>();
  const byPage = new Map<number, { block: SearchableBlockSource; index: number }[]>();
  blocks.forEach((block, index) => {
    const id = blockId(block, index);
    if (!pageByNumber.has(block.page)) {
      skippedInfo.set(index, { id, page: block.page, reason: 'no-page' });
      return;
    }
    const queue = byPage.get(block.page);
    if (queue) queue.push({ block, index });
    else byPage.set(block.page, [{ block, index }]);
  });

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(face);
  const limitations = new Set<string>([FONT_LIMITATION]);
  let runCount = 0;
  let imagePages = 0;
  let overflowing = 0;

  for (let index = 0; index < pages.length; index++) {
    const source = pages[index]!;
    const width = positive(source.width, 'width');
    const height = positive(source.height, 'height');
    const number = pageNumberOf(source, index);
    const target = doc.addPage([width, height]);
    target.setFont(font);

    // The raster goes down first; the invisible layer then describes what is already on the page.
    if (source.image && source.image.bytes.length > 0) {
      try {
        const embedded = source.image.format === 'jpeg'
          ? await doc.embedJpg(source.image.bytes)
          : await doc.embedPng(source.image.bytes);
        target.drawImage(embedded, { x: 0, y: 0, width, height });
        imagePages++;
      } catch {
        limitations.add(`Page ${number}: the scan could not be embedded, so the page carries only the invisible text layer.`);
      }
    }

    for (const entry of byPage.get(number) ?? []) {
      const plan = planRun(entry.block, { width, height }, font);
      if (!plan.ok) {
        skippedInfo.set(entry.index, { id: blockId(entry.block, entry.index), page: number, reason: plan.reason });
        continue;
      }
      drawInvisibleRun(target, plan.run);
      runCount++;
      if (plan.overflow) overflowing++;
    }
  }

  if (overflowing > 0) limitations.add(OVERFLOW_LIMITATION);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title) doc.setTitle(title);
  doc.setProducer(input.producer ?? DEFAULT_PRODUCER);
  doc.setCreator('Mirror');
  const bytes = await doc.save();

  const skipped: SkippedRun[] = [...skippedInfo.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, entry]) => entry);

  return {
    bytes,
    pageCount: doc.getPageCount(),
    runCount,
    imagePages,
    skipped,
    overflowing,
    limitations: [...limitations],
    fontName: face,
  };
}
