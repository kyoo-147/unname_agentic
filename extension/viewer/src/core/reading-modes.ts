/**
 * Reading-mode geometry (backlog item L06).
 *
 * A page and its translation can share the viewport in four ways. This module is the
 * planner half: it turns a viewport, a page aspect and a small options bag into pane
 * rectangles and a scroll model. Nothing here draws, measures text or touches the DOM,
 * so the same inputs always produce the same layout.
 *
 * Modes:
 * - `side-by-side` splits the width into two equal panes with a 1 px gutter: the
 *   original on the left, the translation on the right. Scroll is linked.
 * - `overlay` keeps one full-size pane and puts the translation pane exactly on top of
 *   it, at `overlayOpacity`. Scroll is linked, so both panes follow the same page.
 * - `interleaved` stacks paired bands of equal height (`role: 'paired'`): each band
 *   carries one fragment of the original and its translation. Scroll is linked.
 * - `reflow` gives the translation the full width minus a source thumbnail rail of
 *   `DEFAULT_RAIL_WIDTH` px, clamped so a narrow viewport keeps at least 1 px of column.
 *   The rail follows the page; the column re-flows text, so its scroll is independent.
 *
 * Fill contract: for every mode and every positive viewport, the non-overlay panes tile
 * the viewport exactly — no pane leaves it, no two panes overlap, and the panes plus the
 * only gap the layout allows (side-by-side mode's 1 px gutter) account for every pixel.
 * Overlay mode has two coincident full-size panes instead, which is what "on top" means.
 * The guarantee holds across the documented page-aspect band (0.4..3.0); a page outside
 * it still tiles exactly, because the aspect only calibrates the band count and never the
 * pane geometry.
 *
 * Position contract: a reading position is `{ page, progress }` with `progress` running
 * 0..1 through one page, independent of the mode that shows it. Every mode scrolls one
 * page by `pageExtent` pixels, and `pageToOffset` / `offsetToPage` convert between that
 * position and a scroll offset. A mode change therefore keeps the page and the progress
 * and only moves the offset; an offset survives the round trip through `offsetToPage` and
 * `pageToOffset`, and so does a position inside a page (progress 1 is the next page's
 * top, which is the same place).
 *
 * Errors are typed: an unknown mode, a viewport without a positive size, or an aspect
 * that is not a positive number raises {@link ReadingModeError} rather than producing a
 * layout that quietly overflows. Reading positions are clamped instead of refused: they
 * come from scroll arithmetic, where a value a fraction out of range is normal.
 */

import type { Rect } from './types';

/** How the original and the translation share the viewport. */
export type ReadingMode = 'side-by-side' | 'overlay' | 'interleaved' | 'reflow';

/** Every mode, in the order a switcher should offer them. */
export const READING_MODES: readonly ReadingMode[] = ['side-by-side', 'overlay', 'interleaved', 'reflow'];

/** What a pane shows. `paired` is one interleaved band: a fragment and its translation. */
export type PaneRole = 'source' | 'translation' | 'paired';

/** The area a layout has to fill, in pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** One pane of the layout, in viewport pixels with the origin at the top-left corner. */
export interface Pane extends Rect {
  role: PaneRole;
}

/** A pane drawn above `panes`, with the little the compositor needs beyond its rect. */
export interface Overlay extends Rect {
  role: PaneRole;
  /** 1 covers what is underneath; lower values let the original show through. */
  opacity: number;
  /** Paint order: higher values are painted later, on top of lower ones. */
  z: number;
}

/** Whether two panes move together (`linked`) or each keeps its own offset. */
export type ReadingScroll = 'linked' | 'independent';

/** Everything a renderer needs to place one mode. */
export interface ReadingLayout {
  mode: ReadingMode;
  /** Panes in paint order; the ones that tile the viewport, or the pair that coincides. */
  panes: Pane[];
  scroll: ReadingScroll;
  /** Compositing entries; empty unless a pane is drawn on top of another. */
  overlays: Overlay[];
}

/** Options that change a layout without changing its contract; all have defaults. */
export interface ReadingLayoutOptions {
  /** Width of the source thumbnail rail in reflow mode, in pixels. Default 96. */
  railWidth?: number;
  /** Side the rail sits on in reflow mode. Default `left`. */
  railSide?: 'left' | 'right';
  /** Most bands interleaved mode may stack; clamped to 1..8. Default 4. */
  maxBands?: number;
  /** Gutter between the side-by-side panes, in pixels. Default 1. */
  gutter?: number;
  /** Opacity of the translation pane in overlay mode, 0..1. Default 1. */
  overlayOpacity?: number;
}

/** Width of the source thumbnail rail in reflow mode, in pixels. */
export const DEFAULT_RAIL_WIDTH = 96;

/** Gutter between the two panes of side-by-side mode, in pixels. */
export const DEFAULT_GUTTER = 1;

/** Most paired bands interleaved mode stacks, whatever the viewport allows. */
export const DEFAULT_MAX_BANDS = 4;

/** Opacity of the translation pane drawn over the source in overlay mode. */
export const DEFAULT_OVERLAY_OPACITY = 1;

/** Narrowest page aspect the band count is calibrated for (width / height). */
export const MIN_PAGE_ASPECT = 0.4;

/** Widest page aspect the band count is calibrated for (width / height). */
export const MAX_PAGE_ASPECT = 3;

/** Hard ceiling on paired bands, so a bad option cannot ask for thousands of panes. */
const MAX_BANDS = 8;

/** Why a layout was refused. */
export type ReadingModeErrorCode = 'unknown-mode' | 'invalid-viewport' | 'invalid-page-aspect';

/** A layout request the planner will not answer with geometry. */
export class ReadingModeError extends Error {
  readonly code: ReadingModeErrorCode;

  constructor(code: ReadingModeErrorCode, message: string) {
    super(message);
    this.name = 'ReadingModeError';
    this.code = code;
  }
}

/** Narrows a runtime value to a {@link ReadingMode}. */
export function isReadingMode(value: unknown): value is ReadingMode {
  return value === 'side-by-side' || value === 'overlay' || value === 'interleaved' || value === 'reflow';
}

/**
 * Places one mode in the viewport.
 *
 * `pageAspect` is the page's width divided by its height: 0.7 for A4 portrait, 1 for a
 * square page, 2.4 for a wide one. It does not change the pane geometry, which always
 * tiles the viewport; it sets how many paired bands interleaved mode stacks and how far
 * one page scrolls in every mode.
 *
 * Throws {@link ReadingModeError} when the mode is not one of {@link READING_MODES}, the
 * viewport has no positive width or height, or the aspect is not a positive number.
 */
export function layoutFor(
  mode: ReadingMode,
  viewport: Viewport,
  pageAspect: number,
  options: ReadingLayoutOptions = {},
): ReadingLayout {
  const known = requireMode(mode);
  const { width, height } = requireViewport(viewport);
  const aspect = requireAspect(pageAspect);
  const settings: ReadingLayoutOptions = options ?? {};

  switch (known) {
    case 'side-by-side':
      return sideBySide(width, height, settings);
    case 'overlay':
      return overlay(width, height, settings);
    case 'interleaved':
      return interleaved(width, height, aspect, settings);
    case 'reflow':
      return reflow(width, height, settings);
  }
}

/**
 * Pixels of scroll one page occupies in `layout`.
 *
 * A linked mode shows the page at the pane's width, so one page scrolls as far as that
 * page is tall at that width. Interleaved mode re-flows fragments into bands, so one
 * page pair advances exactly the bands the viewport shows. Returns 0 for a layout with
 * no pane that can carry a page.
 */
export function pageExtent(layout: ReadingLayout, pageAspect: number): number {
  const aspect = requireAspect(pageAspect);
  const panes: readonly Pane[] = Array.isArray(layout?.panes) ? layout.panes : [];

  if (layout?.mode === 'interleaved') {
    return panes.reduce((total, pane) => total + Math.max(0, pane.height), 0);
  }

  const role: PaneRole = layout?.mode === 'reflow' ? 'translation' : 'source';
  const pane =
    panes.find(candidate => candidate.role === role) ??
    panes.find(candidate => candidate.role === 'translation');
  return pane !== undefined && pane.width > 0 ? pane.width / aspect : 0;
}

/** A place in a document, independent of the mode that is showing it. */
export interface ReadingPosition {
  /** 1-based page. */
  page: number;
  /** Fraction through the page: 0 at its top, 1 at its bottom. */
  progress: number;
}

/** The viewport and page a position is being translated into. */
export interface ReadingGeometry {
  viewport: Viewport;
  pageAspect: number;
  layout?: ReadingLayoutOptions;
}

/** What a mode switch does to the scroll offset. */
export interface ModeChange {
  /** Mode being left. */
  from: ReadingMode;
  /** Mode being entered. */
  to: ReadingMode;
  /** Page that stayed current; a mode switch never moves it. */
  page: number;
  /** Fraction through the page, preserved by the switch. */
  progress: number;
  /** Offset the position had in the mode being left, in pixels. */
  fromOffset: number;
  /** Offset that keeps the same place in the mode being entered, in pixels. */
  offset: number;
  /** Offset of the top of `page` in the mode being entered, in pixels. */
  pageTop: number;
}

/**
 * Converts a reading position into the scroll offset it sits at in `layout`.
 *
 * `page` is truncated to an integer and raised to at least 1; `progress` is clamped to
 * 0..1, so a position that drifted a fraction out of range from scroll arithmetic still
 * produces an offset.
 */
export function pageToOffset(layout: ReadingLayout, pageAspect: number, position: ReadingPosition): number {
  const extent = pageExtent(layout, pageAspect);
  const { page, progress } = normalisePosition(position);
  return (page - 1) * extent + progress * extent;
}

/**
 * Converts a scroll offset back into the reading position it sits at in `layout`.
 *
 * `offset` is clamped to at least 0. A negative or unusable offset reports the top of
 * page 1; a layout that cannot scroll one page also reports the top of page 1. The page
 * boundary is a plain floor, so every offset `pageToOffset` produced comes back
 * unchanged, including one that lands exactly on a page top.
 */
export function offsetToPage(layout: ReadingLayout, pageAspect: number, offset: number): ReadingPosition {
  const extent = pageExtent(layout, pageAspect);
  const value = finiteOrNull(offset);
  const scroll = value === null ? 0 : Math.max(0, value);
  if (!(extent > 0)) return { page: 1, progress: 0 };

  const page = Math.floor(scroll / extent) + 1;
  const progress = clampUnit((scroll - (page - 1) * extent) / extent);
  return { page, progress };
}

/**
 * Translates a reading position from one mode into the scroll offsets of another.
 *
 * The page and the progress are the invariant: they describe the place in the document,
 * and a switch keeps both, so a reader never loses the line they were on. What changes
 * is the offset, because each mode gives one page a different number of pixels of
 * scroll — `offsetToPage(result.offset)` on the new layout returns the same position.
 *
 * Throws {@link ReadingModeError} for an unknown mode and for a geometry that cannot be
 * laid out, exactly as {@link layoutFor} does.
 */
export function positionAfterModeChange(
  from: ReadingMode,
  to: ReadingMode,
  state: ReadingPosition,
  geometry: ReadingGeometry,
): ModeChange {
  const fromMode = requireMode(from);
  const toMode = requireMode(to);
  const viewport = geometry?.viewport;
  const pageAspect = geometry?.pageAspect;
  const options = geometry?.layout;
  const position = normalisePosition(state);

  const fromLayout = layoutFor(fromMode, viewport, pageAspect, options);
  const toLayout = layoutFor(toMode, viewport, pageAspect, options);
  const toExtent = pageExtent(toLayout, pageAspect);

  return {
    from: fromMode,
    to: toMode,
    page: position.page,
    progress: position.progress,
    fromOffset: pageToOffset(fromLayout, pageAspect, position),
    offset: pageToOffset(toLayout, pageAspect, position),
    pageTop: (position.page - 1) * toExtent,
  };
}

// --- Mode builders ---------------------------------------------------------

/** Two equal panes with a gutter between them; the right pane takes the rounding slack. */
function sideBySide(width: number, height: number, options: ReadingLayoutOptions): ReadingLayout {
  const requested = numberOr(options.gutter, DEFAULT_GUTTER);
  const gutter = Math.min(Math.max(requested, 0), Math.max(0, width - 1));
  const paneWidth = (width - gutter) / 2;
  const translationX = paneWidth + gutter;

  return {
    mode: 'side-by-side',
    panes: [
      { role: 'source', x: 0, y: 0, width: paneWidth, height },
      { role: 'translation', x: translationX, y: 0, width: width - translationX, height },
    ],
    scroll: 'linked',
    overlays: [],
  };
}

/** One full-size pane with the translation drawn exactly over it. */
function overlay(width: number, height: number, options: ReadingLayoutOptions): ReadingLayout {
  const opacity = clampUnit(numberOr(options.overlayOpacity, DEFAULT_OVERLAY_OPACITY));

  return {
    mode: 'overlay',
    panes: [
      { role: 'source', x: 0, y: 0, width, height },
      { role: 'translation', x: 0, y: 0, width, height },
    ],
    scroll: 'linked',
    overlays: [{ role: 'translation', x: 0, y: 0, width, height, opacity, z: 1 }],
  };
}

/** Equal bands stacked down the viewport; the last band ends exactly at the bottom. */
function interleaved(
  width: number,
  height: number,
  aspect: number,
  options: ReadingLayoutOptions,
): ReadingLayout {
  const count = bandCount(width, height, aspect, options);
  const panes: Pane[] = [];

  for (let index = 0; index < count; index += 1) {
    const top = index === 0 ? 0 : (height * index) / count;
    const bottom = index === count - 1 ? height : (height * (index + 1)) / count;
    panes.push({ role: 'paired', x: 0, y: top, width, height: bottom - top });
  }

  return { mode: 'interleaved', panes, scroll: 'linked', overlays: [] };
}

/**
 * How many paired bands fit one screen: one page height at the viewport's width, turned
 * into a count and clamped. A portrait page is taller than a screen, so it stacks one
 * band; a wide page fits two or more.
 */
function bandCount(width: number, height: number, aspect: number, options: ReadingLayoutOptions): number {
  const ceiling = Math.min(
    Math.max(Math.trunc(numberOr(options.maxBands, DEFAULT_MAX_BANDS)), 1),
    MAX_BANDS,
  );
  const pageHeight = width / clampAspect(aspect);
  const fits = pageHeight > 0 ? Math.round(height / pageHeight) : 1;
  return Math.min(Math.max(fits, 1), ceiling);
}

/** The translation column takes everything except the source thumbnail rail. */
function reflow(width: number, height: number, options: ReadingLayoutOptions): ReadingLayout {
  const rail = railWidth(width, numberOr(options.railWidth, DEFAULT_RAIL_WIDTH));
  const railAtRight = options.railSide === 'right';

  return {
    mode: 'reflow',
    panes: [
      { role: 'source', x: railAtRight ? width - rail : 0, y: 0, width: rail, height },
      { role: 'translation', x: railAtRight ? 0 : rail, y: 0, width: width - rail, height },
    ],
    scroll: 'independent',
    overlays: [],
  };
}

/**
 * Keeps the rail inside the viewport, so the translation column always keeps at least
 * one pixel. A viewport narrower than two pixels has no room for two roles, so it is
 * split evenly rather than collapsing the column to nothing.
 */
function railWidth(width: number, requested: number): number {
  if (width <= 2) return width / 2;
  return Math.min(Math.max(requested, 1), width - 1);
}

// --- Validation and arithmetic --------------------------------------------

function requireMode(mode: ReadingMode): ReadingMode {
  if (!isReadingMode(mode)) {
    throw new ReadingModeError('unknown-mode', `Unknown reading mode: ${String(mode)}.`);
  }
  return mode;
}

function requireViewport(viewport: Viewport): { width: number; height: number } {
  const width = finiteOrNull(viewport?.width);
  const height = finiteOrNull(viewport?.height);
  if (width === null || height === null || width <= 0 || height <= 0) {
    throw new ReadingModeError(
      'invalid-viewport',
      'A reading layout needs a viewport with a positive width and height.',
    );
  }
  return { width, height };
}

function requireAspect(pageAspect: number): number {
  const aspect = finiteOrNull(pageAspect);
  if (aspect === null || aspect <= 0) {
    throw new ReadingModeError(
      'invalid-page-aspect',
      'A reading layout needs a positive finite page aspect.',
    );
  }
  return aspect;
}

/** Rounds a reading position into range: at least page 1, progress inside 0..1. */
function normalisePosition(position: ReadingPosition): ReadingPosition {
  const page = finiteOrNull(position?.page);
  const progress = finiteOrNull(position?.progress);
  return {
    page: page === null ? 1 : Math.max(1, Math.trunc(page)),
    progress: progress === null ? 0 : clampUnit(progress),
  };
}

function clampAspect(aspect: number): number {
  return Math.min(Math.max(aspect, MIN_PAGE_ASPECT), MAX_PAGE_ASPECT);
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = finiteOrNull(value);
  return parsed === null ? fallback : parsed;
}

/** Semantic reader modes consumed by desktop and browser hosts. */
export type ReaderMode = 'original' | 'translation' | 'bilingual' | 'interleave';
export const READER_MODES: readonly ReaderMode[] = ['original', 'translation', 'bilingual', 'interleave'];

export type ReaderModeAvailability = 'available' | 'missing-source' | 'missing-translation' | 'unsupported';

export interface ReaderContentState {
  readonly sourceAvailable: boolean;
  readonly translation: 'available' | 'missing' | 'unsupported';
  readonly interleaveSupported?: boolean;
}

export interface ReaderModeResolution {
  readonly requested: ReaderMode;
  readonly available: boolean;
  readonly status: ReaderModeAvailability;
  readonly reason?: string;
}

export interface ReaderPosition {
  readonly page: number;
  readonly progress: number;
  /** Stable block/anchor id, retained when a host can provide one. */
  readonly anchorId?: string;
}

export interface ReaderModeState {
  readonly documentId: string;
  readonly sourceSha256: string;
  readonly generation: number;
  readonly mode: ReaderMode;
  readonly position: ReaderPosition;
}

export function isReaderMode(value: unknown): value is ReaderMode {
  return value === 'original' || value === 'translation' || value === 'bilingual' || value === 'interleave';
}

/** Resolves availability without falling back to a different reading mode. */
export function resolveReaderMode(mode: ReaderMode, content: ReaderContentState): ReaderModeResolution {
  if (!isReaderMode(mode)) return { requested: mode, available: false, status: 'unsupported', reason: 'Unknown reading mode.' };
  if (!content.sourceAvailable) return { requested: mode, available: false, status: 'missing-source', reason: 'The original document is unavailable.' };
  if (mode === 'original') return { requested: mode, available: true, status: 'available' };
  if (content.translation === 'unsupported') return { requested: mode, available: false, status: 'unsupported', reason: 'This content cannot be rendered in translation mode.' };
  if (content.translation !== 'available') return { requested: mode, available: false, status: 'missing-translation', reason: 'A translation is not available yet.' };
  if (mode === 'interleave' && content.interleaveSupported === false) return { requested: mode, available: false, status: 'unsupported', reason: 'Interleave is not supported for this content.' };
  return { requested: mode, available: true, status: 'available' };
}

/** Keeps page, in-page progress and an optional stable anchor across a mode change. */
export function preserveReadingPosition(position: ReaderPosition): ReaderPosition {
  const page = Number.isFinite(position?.page) ? Math.max(1, Math.trunc(position.page)) : 1;
  const progress = Number.isFinite(position?.progress) ? Math.min(1, Math.max(0, position.progress)) : 0;
  const anchorId = typeof position?.anchorId === 'string' && position.anchorId.trim() ? position.anchorId.trim() : undefined;
  return { page, progress, ...(anchorId ? { anchorId } : {}) };
}

/** Maps semantic modes to the existing geometry planner without pretending they are equivalent content. */
export function geometryModeForReaderMode(mode: ReaderMode): ReadingMode {
  switch (mode) {
    case 'original':
    case 'translation':
      return 'reflow';
    case 'bilingual':
      return 'side-by-side';
    case 'interleave':
      return 'interleaved';
  }
}

export interface ReaderModeChange {
  readonly state: ReaderModeState;
  readonly resolution: ReaderModeResolution;
  readonly changed: boolean;
}

/** Small host-neutral state machine used by the desktop bridge and reader adapters. */
export class ReaderModeSession {
  private current: ReaderModeState;

  constructor(initial: ReaderModeState, private readonly content: ReaderContentState) {
    if (!isReaderMode(initial.mode)) throw new ReadingModeError('unknown-mode', `Unknown reading mode: ${String(initial.mode)}.`);
    this.current = Object.freeze({ ...initial, position: preserveReadingPosition(initial.position) });
  }

  snapshot(): ReaderModeState { return this.current; }

  setPosition(position: ReaderPosition): ReaderModeState {
    this.current = Object.freeze({ ...this.current, position: preserveReadingPosition(position) });
    return this.current;
  }

  setMode(mode: ReaderMode): ReaderModeChange {
    const resolution = resolveReaderMode(mode, this.content);
    if (!resolution.available) return { state: this.current, resolution, changed: false };
    const changed = mode !== this.current.mode;
    if (changed) this.current = Object.freeze({ ...this.current, mode, position: preserveReadingPosition(this.current.position) });
    return { state: this.current, resolution, changed };
  }
}
