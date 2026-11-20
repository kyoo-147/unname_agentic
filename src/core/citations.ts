/**
 * Source citations for AI answers (backlog item I01).
 *
 * An answer about a document has to point at the region that supports it, not just at
 * a page. This module is the whole path from model prose to a highlightable region:
 * parse the markers an answer carries, drop them from the prose the reader shows,
 * match each one against the Document IR, and normalise the resulting rect for an
 * overlay.
 *
 * Recognised marker forms:
 * - `[p12]` (also `[P12]`) — page only.
 * - `[p12:r3]` — page plus the rank of the block on it, so the block id is `p12-r3`,
 *   the id shape `buildDocument` assigns.
 * - `(trang 12)` — the Vietnamese page form.
 * - `[#p12-r3]` — an explicit block id. The page is read from the id when the id
 *   encodes one (`p{page}-r{rank}`); otherwise the page is unknown until resolution,
 *   which is why {@link CitationMarker.page} can be `null`.
 * - `[[cite:{"page":12,"blockId":"p12-r3"}]]` — the JSON form. Quotes around the
 *   keys and the block id are optional, so `[[cite:{page: 12, blockId: p12-r3}]]`
 *   reads the same.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no I/O. The same answer
 *   and the same document always produce the same result.
 * - Parsing is syntax only. `[p0]` parses to page 0 and is left to
 *   {@link resolveCitations} to report; only a marker that carries neither a page nor
 *   a block is not a citation at all and stays in the prose.
 * - `cleaned` is the input unchanged when no marker matched. When markers were
 *   removed, only whitespace at the seams they left is touched, so no other character
 *   of the answer changes.
 * - Resolution never invents a region. A page-only citation resolves with
 *   `blockId: null` and no polygon; a citation the document cannot honour is reported
 *   in `unresolved` with a reason instead of being snapped onto something nearby.
 * - Coordinates are PDF points with the origin at the top-left corner and y growing
 *   downwards, matching `Polygon` in `src/core/ir.ts` and `Rect` in
 *   `src/core/types.ts`.
 */

import type { Block, DocumentIR, Page, PageRotation, Point, Polygon } from './ir';
import type { Rect } from './types';

/** `[[cite:{"page":12,"blockId":"p12-r3"}]]`; the payload cannot nest braces. */
const JSON_FORM = /\[\[cite:\s*(\{[^{}]{0,512}\})\s*\]\]/gu;

/** `[p12]` and `[p12:r3]`. */
const PAGE_FORM = /\[[pP](\d{1,6})(?::[rR](\d{1,6}))?\]/gu;

/** `[#p12-r3]` — a block id, restricted to the characters ids are built from. */
const BLOCK_FORM = /\[#([A-Za-z0-9._-]{1,128})\]/gu;

/** `(trang 12)`. */
const TRANG_FORM = /\(\s*trang\s+(\d{1,6})\s*\)/giu;

/** A block id that encodes its own page, as `buildDocument` writes them. */
const BLOCK_ID_PAGE = /^p(\d{1,9})-r\d{1,9}$/u;

/** The same two payload fields, read without strict JSON quotes. */
const RELAXED_PAGE = /["']?page["']?\s*:\s*["']?(\d{1,6})/iu;
const RELAXED_BLOCK = /["']?blockId["']?\s*:\s*["']?([A-Za-z0-9._-]{1,128})/iu;

/** Whitespace on either side of a removed marker, including line breaks. */
const TRAILING_SPACE = /[ \t\r\n]*$/u;
const LEADING_SPACE = /^[ \t\r\n]*/u;

/** A marker that closed a clause keeps its sentence end and loses the space before it. */
const CLOSING_PUNCTUATION = /^[.,;:!?)\]}\u2026\u3002\uFF0C\uFF01\uFF1F\u00BB]/u;

/** A marker inside brackets hugs what opened them instead of leaving `( text`. */
const OPENING_PUNCTUATION = /[(\[{«\u201C\u2018]$/u;

/** Unit coordinates are rounded to this many decimals, so two runs print the same numbers. */
const UNIT_SCALE = 1e6;

/** A citation as it appears in an answer, before it is matched against a document. */
export interface CitationMarker {
  /**
   * 1-based page number the marker names, or `null` for a block-only marker whose id
   * does not encode a page (`[#rough-draft]`). Parsing does not check the number
   * against a document; {@link resolveCitations} does.
   */
  page: number | null;
  /**
   * Block id the marker names. `[p12:r3]` yields `p12-r3`, the id shape
   * `buildDocument` assigns, so a rank is usable without a lookup.
   */
  blockId?: string;
  /** The marker exactly as it appeared, so a UI can show what it replaced. */
  raw: string;
  /** 0-based ordinal in order of first appearance; equal to the array position. */
  index: number;
  /** How many times the answer cited this same target; the first occurrence is 1. */
  count: number;
}

export interface CitationParse {
  /** Unique targets in order of first appearance; repeats are folded into `count`. */
  citations: CitationMarker[];
  /** The answer with every recognised marker removed. */
  cleaned: string;
}

/** One raw match before duplicates are folded, in the original text's coordinates. */
interface RawMatch {
  start: number;
  end: number;
  page: number | null;
  blockId: string | null;
}

/** Which side of a removed marker loses its whitespace. */
type Seam = 'none' | 'before' | 'after';

/**
 * Reads the citation markers out of an answer.
 *
 * Recognised markers are removed from `cleaned` and folded into `citations`; two
 * markers that name the same page and the same block (in any syntax) are one entry
 * whose `count` says how often the answer cited it, in the position it first appears.
 * Anything else is left untouched, so prose with no markers comes back unchanged.
 */
export function parseCitations(answer: string): CitationParse {
  const text = typeof answer === 'string' ? answer : '';
  const matches = scanMarkers(text);
  if (matches.length === 0) return { citations: [], cleaned: text };

  const citations: CitationMarker[] = [];
  const byTarget = new Map<string, CitationMarker>();
  for (const match of matches) {
    const key = targetKey(match.page, match.blockId);
    const seen = byTarget.get(key);
    if (seen) {
      seen.count += 1;
      continue;
    }
    const citation: CitationMarker = {
      page: match.page,
      raw: text.slice(match.start, match.end),
      index: citations.length,
      count: 1,
    };
    if (match.blockId !== null) citation.blockId = match.blockId;
    byTarget.set(key, citation);
    citations.push(citation);
  }

  return { citations, cleaned: removeMarkers(text, matches) };
}

/** Why a citation could not be placed on the document. */
export type CitationProblem = 'page-out-of-range' | 'unknown-block' | 'page-mismatch' | 'no-page';

export interface UnresolvedCitation {
  /** The marker that could not be placed, unchanged. */
  citation: CitationMarker;
  reason: CitationProblem;
  /** English diagnostic for logs and tests; not UI copy. */
  message: string;
}

/** The page shape a highlight needs: the coordinate space its polygons live in. */
export interface PageSize {
  width: number;
  height: number;
  /**
   * Carried so an IR `Page` or a {@link ResolvedCitation} can be passed straight in.
   * Normalisation does not apply it: `Page.width` and `Page.height` already describe
   * the page as the reader draws it, so a quarter-turned page reports its displayed
   * size and its polygons are in that same space.
   */
  rotation?: PageRotation;
}

/** A citation that landed on a real page or block of the document. */
export interface ResolvedCitation extends PageSize {
  /** Ordinal of the marker this came from; matches {@link CitationMarker.index}. */
  index: number;
  /** 1-based page to show: the block's page, or the cited page for a page-only one. */
  page: number;
  /** Block id, or `null` when the citation named only a page. */
  blockId: string | null;
  /** The block's polygon in page points; `null` for a page-only citation. */
  polygon: Polygon | null;
  /** Bounding box of `polygon`, ready to pass to {@link highlightShape}. */
  rect: Rect | null;
  /** The marker exactly as it appeared. */
  raw: string;
  /** How many times the answer cited this same target. */
  count: number;
}

export interface CitationResolution {
  /** Placed citations, in the order of the input. */
  resolved: ResolvedCitation[];
  /** Citations the document cannot honour, in the order of the input. */
  unresolved: UnresolvedCitation[];
}

/**
 * Maps parsed citations onto a document.
 *
 * A citation naming a block resolves to that block, its polygon and its page; a
 * citation naming only a page resolves to the page with `blockId: null`, so a caller
 * can still scroll there. Everything else is reported in `unresolved` with a reason:
 * a page the document does not have, a block id it does not contain, a marker whose
 * page and block disagree, or a marker with no target at all.
 */
export function resolveCitations(
  citations: readonly CitationMarker[],
  ir: DocumentIR,
): CitationResolution {
  const resolved: ResolvedCitation[] = [];
  const unresolved: UnresolvedCitation[] = [];
  const pages = new Map<number, Page>();
  for (const page of Array.isArray(ir?.pages) ? ir.pages : []) {
    if (page && Number.isInteger(page.index)) pages.set(page.index, page);
  }
  const blocks = new Map<string, Block>();
  for (const block of Array.isArray(ir?.blocks) ? ir.blocks : []) {
    if (block && typeof block.id === 'string') blocks.set(block.id, block);
  }

  const entries: readonly CitationMarker[] = Array.isArray(citations) ? citations : [];
  entries.forEach((citation, position) => {
    if (!citation || typeof citation !== 'object') return;
    const blockId = typeof citation.blockId === 'string' && citation.blockId.length > 0 ? citation.blockId : null;
    const citedPage = typeof citation.page === 'number' && Number.isInteger(citation.page) ? citation.page : null;
    const index = typeof citation.index === 'number' ? citation.index : position;
    const count = typeof citation.count === 'number' && citation.count > 0 ? citation.count : 1;
    const raw = typeof citation.raw === 'string' ? citation.raw : '';

    if (blockId !== null) {
      const block = blocks.get(blockId);
      if (!block) {
        unresolved.push({
          citation,
          reason: 'unknown-block',
          message: `${describe(raw)} names block ${blockId}, which is not in the document.`,
        });
        return;
      }
      const page = pages.get(block.page);
      if (!page) {
        unresolved.push({
          citation,
          reason: 'page-out-of-range',
          message: `${describe(raw)} points at block ${blockId} on page ${block.page}, which is not in the document.`,
        });
        return;
      }
      if (citedPage !== null && citedPage !== block.page) {
        unresolved.push({
          citation,
          reason: 'page-mismatch',
          message: `${describe(raw)} names page ${citedPage}, but block ${blockId} is on page ${block.page}.`,
        });
        return;
      }
      const polygon = readPolygon(block.polygon);
      resolved.push({
        index,
        page: block.page,
        width: page.width,
        height: page.height,
        rotation: page.rotation,
        blockId,
        polygon,
        rect: polygon === null ? null : polygonRect(polygon),
        raw,
        count,
      });
      return;
    }

    if (citedPage === null) {
      unresolved.push({
        citation,
        reason: 'no-page',
        message: `${describe(raw)} names neither a page nor a block.`,
      });
      return;
    }
    const page = pages.get(citedPage);
    if (!page) {
      unresolved.push({
        citation,
        reason: 'page-out-of-range',
        message: `${describe(raw)} names page ${citedPage}, which is not in the document.`,
      });
      return;
    }
    resolved.push({
      index,
      page: citedPage,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
      blockId: null,
      polygon: null,
      rect: null,
      raw,
      count,
    });
  });

  return { resolved, unresolved };
}

/** Everything an overlay needs for one highlight, in page points and in page fractions. */
export interface HighlightShape {
  /** The rect after clamping to the page, in points; negative extents collapse to 0. */
  rect: Rect;
  /** `rect` as fractions of the page, 0..1, ready for `left: x * 100%`. */
  unit: Rect;
  /** Page-space corners in points: top-left, top-right, bottom-right, bottom-left. */
  polygon: Polygon;
  /** The same corners as page fractions, for a normalised canvas transform. */
  unitPolygon: Polygon;
}

/**
 * Turns a page-space rect into the numbers an overlay draws from.
 *
 * The rect is clamped to the page first, so unit values never leave 0..1 and a block
 * polygon that overhangs its page by a fraction of a point cannot push a CSS box off
 * the page. The four corners come back in both spaces in source order, matching
 * `Polygon` in the IR, so a canvas can transform points and a CSS overlay can use the
 * bounding fractions without re-deriving either.
 *
 * Rotation needs no handling here: IR polygons are already in the page's own
 * coordinate space, whose extent is `width` x `height` whatever the rotation.
 */
export function highlightShape(rect: Rect, page: PageSize): HighlightShape {
  const pageWidth = positiveOr(page?.width, 0);
  const pageHeight = positiveOr(page?.height, 0);
  const x = finiteOr(rect?.x, 0);
  const y = finiteOr(rect?.y, 0);
  const width = Math.max(0, finiteOr(rect?.width, 0));
  const height = Math.max(0, finiteOr(rect?.height, 0));

  const left = clamp(x, pageWidth);
  const top = clamp(y, pageHeight);
  const right = clamp(x + width, pageWidth);
  const bottom = clamp(y + height, pageHeight);

  const unitLeft = unitOf(left, pageWidth);
  const unitTop = unitOf(top, pageHeight);
  const unitRight = unitOf(right, pageWidth);
  const unitBottom = unitOf(bottom, pageHeight);

  return {
    rect: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
    unit: {
      x: unitLeft,
      y: unitTop,
      width: roundUnit(unitRight - unitLeft),
      height: roundUnit(unitBottom - unitTop),
    },
    polygon: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ],
    unitPolygon: [
      { x: unitLeft, y: unitTop },
      { x: unitRight, y: unitTop },
      { x: unitRight, y: unitBottom },
      { x: unitLeft, y: unitBottom },
    ],
  };
}

// --- Scanning --------------------------------------------------------------

function scanMarkers(text: string): RawMatch[] {
  const found: RawMatch[] = [];

  for (const match of text.matchAll(JSON_FORM)) {
    const start = match.index;
    const source = match[1];
    if (start === undefined || source === undefined) continue;
    const payload = readCitePayload(source);
    if (payload === null) continue;
    found.push({ start, end: start + match[0].length, page: payload.page, blockId: payload.blockId });
  }

  for (const match of text.matchAll(PAGE_FORM)) {
    const start = match.index;
    const page = toInteger(match[1]);
    if (start === undefined || page === null) continue;
    const rank = toInteger(match[2]);
    found.push({
      start,
      end: start + match[0].length,
      page,
      blockId: rank === null ? null : `p${page}-r${rank}`,
    });
  }

  for (const match of text.matchAll(BLOCK_FORM)) {
    const start = match.index;
    const blockId = match[1];
    if (start === undefined || blockId === undefined || blockId.length === 0) continue;
    found.push({
      start,
      end: start + match[0].length,
      page: pageOfBlockId(blockId),
      blockId,
    });
  }

  for (const match of text.matchAll(TRANG_FORM)) {
    const start = match.index;
    const page = toInteger(match[1]);
    if (start === undefined || page === null) continue;
    found.push({ start, end: start + match[0].length, page, blockId: null });
  }

  return dropOverlaps(found);
}

/**
 * Keeps one marker where two patterns cover the same characters: the leftmost wins and,
 * at the same start, the longer one does. The forms do not normally overlap, but a
 * hand-written payload inside the JSON form could contain something that looks like
 * one, and a character may only be removed once.
 */
function dropOverlaps(matches: RawMatch[]): RawMatch[] {
  const ordered = matches.sort(
    (left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start),
  );
  const kept: RawMatch[] = [];
  let consumed = 0;
  for (const match of ordered) {
    if (match.start < consumed) continue;
    kept.push(match);
    consumed = match.end;
  }
  return kept;
}

/**
 * Reads the JSON payload of `[[cite:...]]`. Strict JSON is tried first; when the keys
 * or the block id went unquoted, the two fields are read directly. A payload with
 * neither field is not a citation, so the text is left in the prose rather than
 * silently deleted.
 */
function readCitePayload(source: string): { page: number | null; blockId: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const page = asPageNumber(record.page);
      const blockId = asBlockId(record.blockId);
      if (page !== null || blockId !== null) return { page, blockId };
    }
  } catch {
    // Not strict JSON: the relaxed reader below still reads the same two fields.
  }

  const page = toInteger(RELAXED_PAGE.exec(source)?.[1]);
  const blockId = asBlockId(RELAXED_BLOCK.exec(source)?.[1]);
  return page === null && blockId === null ? null : { page, blockId };
}

function asPageNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string' && /^\d{1,9}$/u.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function asBlockId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The page a block id encodes (`p12-r3` -> 12), or `null` when it does not encode one. */
function pageOfBlockId(blockId: string): number | null {
  return toInteger(BLOCK_ID_PAGE.exec(blockId)?.[1]);
}

function toInteger(raw: string | undefined): number | null {
  if (raw === undefined || raw.length === 0) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

// --- Removing markers ------------------------------------------------------

/**
 * Removes every marker plus the whitespace each removal stranded.
 *
 * One sequential pass, so each seam sees the prose that actually survived before it:
 * a marker that closed a sentence takes the space in front of it, a marker inside
 * brackets takes the space after it, a marker on its own line keeps one line break, and
 * two markers written back to back cannot join the words around them. Nothing outside
 * the seams changes, so prose with no markers is returned unchanged.
 */
function removeMarkers(text: string, matches: readonly RawMatch[]): string {
  let cleaned = '';
  let cursor = 0;
  // Set when the seam decided the run after the marker is padding and has to go.
  let skipLeading = false;

  for (const match of matches) {
    let segment = text.slice(cursor, match.start);
    if (skipLeading) {
      const trimmed = segment.replace(LEADING_SPACE, '');
      // A segment of nothing but that run leaves the flag standing for the next one.
      skipLeading = trimmed.length === 0;
      segment = trimmed;
    }

    const head = cleaned + segment;
    const after = text.slice(match.end);
    const afterRun = leadingRun(after);
    const following = after.slice(afterRun.length);
    const beforeRun = trailingRun(head);

    const seam = seamFor(head, beforeRun, afterRun, following);
    skipLeading = seam === 'after';
    cleaned = seam === 'before' ? head.slice(0, head.length - beforeRun.length) : head;
    cursor = match.end;
  }

  let tail = text.slice(cursor);
  if (skipLeading) tail = tail.replace(LEADING_SPACE, '');
  return cleaned + tail;
}

/**
 * Which whitespace run a removed marker orphans: the one in front of it (`before`), the
 * one behind it (`after`), or neither.
 *
 * `head` is the prose that survived up to the marker, `following` is the text after the
 * whitespace that trails it. A line break is worth keeping, so the run without one goes.
 */
function seamFor(head: string, beforeRun: string, afterRun: string, following: string): Seam {
  if (head.length === 0) return 'after';
  if (beforeRun.length === 0 && afterRun.length === 0) return 'none';
  if (beforeRun.length === 0) {
    // Padding only behind the marker. It goes when what precedes opened a bracket that
    // would otherwise read as "( text"; after a word the space separates two words.
    return OPENING_PUNCTUATION.test(head) ? 'after' : 'none';
  }
  if (afterRun.length === 0) {
    const closes = following.length === 0 || CLOSING_PUNCTUATION.test(following);
    return closes ? 'before' : 'none';
  }
  if (beforeRun.includes('\n')) return 'after';
  if (afterRun.includes('\n')) return 'before';
  return 'after';
}

function trailingRun(text: string): string {
  return TRAILING_SPACE.exec(text)?.[0] ?? '';
}

function leadingRun(text: string): string {
  return LEADING_SPACE.exec(text)?.[0] ?? '';
}

// --- Resolution helpers ----------------------------------------------------

function targetKey(page: number | null, blockId: string | null): string {
  return `${page === null ? '' : page}\u0000${blockId ?? ''}`;
}

function describe(raw: string): string {
  return raw.length > 0 ? `citation ${raw}` : 'citation';
}

/**
 * Copies the four corners of a block polygon, or `null` when the polygon is not the
 * four finite points the IR promises. A block without a usable polygon still resolves
 * by id; it simply has no region to draw.
 */
function readPolygon(polygon: readonly Point[] | undefined): Polygon | null {
  if (!Array.isArray(polygon) || polygon.length !== 4) return null;
  const [first, second, third, fourth] = polygon;
  if (!hasCoordinates(first) || !hasCoordinates(second) || !hasCoordinates(third) || !hasCoordinates(fourth)) {
    return null;
  }
  return [copyPoint(first), copyPoint(second), copyPoint(third), copyPoint(fourth)];
}

function hasCoordinates(point: Point | undefined): point is Point {
  return point !== undefined && point !== null && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function copyPoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function polygonRect(polygon: Polygon): Rect {
  const xs = polygon.map(point => point.x);
  const ys = polygon.map(point => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

// --- Geometry helpers ------------------------------------------------------

/** Keeps a coordinate inside `0..size`; a page without a size collapses everything to 0. */
function clamp(value: number, size: number): number {
  return Math.min(Math.max(value, 0), Math.max(0, size));
}

function unitOf(value: number, size: number): number {
  return size > 0 ? roundUnit(value / size) : 0;
}

function roundUnit(value: number): number {
  return Number.isFinite(value) ? Math.round(value * UNIT_SCALE) / UNIT_SCALE : 0;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
