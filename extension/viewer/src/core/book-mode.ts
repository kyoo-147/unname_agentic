/**
 * Facing-page (book) layout planning (backlog item G02).
 *
 * A reader that shows a translated book has to answer three questions before it can paint
 * anything: which two pages face each other, which side of the opening each page sits on,
 * and which number each page prints at its foot. This module answers them with a plan
 * built from the page boxes the reader already holds, so the same document always opens
 * the same way.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no locale. The same pages and
 *   options always produce the same plan, whatever order the caller lists the pages in:
 *   pages are sorted by number, and a number that appears twice keeps its first occurrence.
 * - Nothing is drawn and nothing is measured. A plan holds page boxes, sides and folios
 *   only; a renderer decides how wide a pane is.
 * - Total, with the documented defaults: a page without a usable number is numbered by its
 *   input position, and a page without a positive size is read as US Letter, because plan
 *   inputs come from a reader that may not have measured every page yet. The one refused
 *   input is an unknown {@link SpreadOrder}, which is a programming error, not data.
 *
 * Parity: the first page of the sequence sits on the side {@link BookPlanOptions.startOnRight}
 * names — the right, the Western default where page 1 is a recto — and every following page
 * alternates. With pages numbered from 1, the usual case, odd pages therefore sit on the
 * right and even pages on the left, and the option flips that. The parity comes from the
 * page's *position*, not from its number, so a document whose pages start at 5 still opens on
 * the side the option names; this module never renumbers a page and never infers that page 7
 * must be a recto from its digits.
 *
 * Grouping: a left page opens a spread and a right page closes it. That single rule produces
 * every layout this module promises:
 * - page 1 on the right with no cover, so a spread closes with an empty left slot: the plan
 *   records a leading parity blank;
 * - a left page with no page after it, so the last spread closes with an empty right slot:
 *   the plan records a trailing parity blank;
 * - a cover, which is a leaf of its own: it opens and closes the first spread whatever side
 *   the binding puts it on, and the next page starts a fresh opening. The cover's empty side
 *   is the reverse of its own leaf, so it is *not* recorded as a blank: the document has no
 *   page there, and nothing has to be inserted.
 * A blank is therefore a page the plan had to invent to keep a page on the side parity
 * demands. A cover on the left (`startOnRight: false`) is possible, and it leaves the page
 * after it standing alone on the right until the parity meets a left page again; that is
 * what a mirrored binding looks like, not an accident.
 *
 * Folios: every placed page carries the number it prints and where it prints it. In a
 * two-page spread the folio sits on the outer edge — a left page's folio at its left edge, a
 * right page's at its right edge — which is the printed-book default `pairs.ts` already uses
 * for export furniture. A page that stands alone prints its folio centred, because it has no
 * facing page to balance. A cover prints no folio at all: its `number` is `null`.
 *
 * Documented limits, so nobody is surprised by a plan:
 * - The folio is the source page number. Front matter cannot be numbered i, ii, iii here,
 *   and a plan cannot offset the body numbering; a document that needs either needs a
 *   follow-up, not a silent adjustment.
 * - A blank has no width or height of its own: it is an empty slot, and the renderer sizes
 *   it from the page beside it. {@link BookBlank} therefore carries where it sits, not what
 *   it measures.
 * - `spreadOrder: 'reverse'` only changes the order the plan lists its spreads in, which is
 *   what a right-to-left filmstrip or a back-to-front browser needs. Geometry, folios and
 *   page membership do not change; `index` stays the position in the returned array, and
 *   `blanks` is remapped to match.
 */

/** US Letter width assumed for a page whose input carries no usable width, in points. */
export const DEFAULT_PAGE_WIDTH = 612;

/** US Letter height assumed for a page whose input carries no usable height, in points. */
export const DEFAULT_PAGE_HEIGHT = 792;

/** The side of an opening a page occupies. */
export type BookSide = 'left' | 'right';

/** What one opening of the plan shows: a cover, two facing pages, or one page alone. */
export type SpreadKind = 'cover' | 'spread' | 'single';

/** Where a page prints its folio. */
export type FolioPlacement = 'outer' | 'center';

/** The order the plan lists its spreads in. */
export type SpreadOrder = 'forward' | 'reverse';

/** Every spread order, in the order a picker should offer them. */
export const SPREAD_ORDERS: readonly SpreadOrder[] = ['forward', 'reverse'];

/** A page as the planner reads it: the box the reader measured, and its number. */
export interface BookPageInput {
  /** 1-based page number. A number repeated later in the list is ignored. */
  number: number;
  /** Page width in points; a missing or non-positive value falls back to US Letter. */
  width: number;
  /** Page height in points; a missing or non-positive value falls back to US Letter. */
  height: number;
}

/** A page as the plan places it. */
export interface BookPage {
  /** 1-based page number the page was planned with. */
  number: number;
  /** Page width in points, with the default applied. */
  width: number;
  /** Page height in points, with the default applied. */
  height: number;
}

/** The folio one placed page prints. */
export interface BookFolio {
  /** 1-based page the folio belongs to. */
  page: number;
  /** The number the page shows, or `null` when it shows none (a cover). */
  number: number | null;
  /** Where the number sits on the page. */
  placement: FolioPlacement;
  /** Side of the spread the page occupies. */
  side: BookSide;
}

/** One opening: the pages a reader sees together, or the single page of a cover. */
export interface BookSpread {
  /** Position of this spread in {@link BookPlan.spreads}, 0-based. */
  index: number;
  /** Page in the left slot, or `null` for the cover's reverse or a parity blank. */
  left: BookPage | null;
  /** Page in the right slot, or `null` for a parity blank. */
  right: BookPage | null;
  /** `cover` for the cover's own opening, `spread` for two pages, `single` for one. */
  kind: SpreadKind;
  /** Folios of the pages this spread holds, left to right; blanks contribute none. */
  folios: BookFolio[];
}

/** An empty slot the plan invented to keep a page on the side parity demands. */
export interface BookBlank {
  /** Slot the blank fills. A left blank leads its spread; a right blank trails it. */
  side: BookSide;
  /** Position of the spread the blank belongs to, 0-based, in {@link BookPlan.spreads}. */
  spread: number;
}

/** Everything {@link planBook} decided. */
export interface BookPlan {
  /** Every spread, in {@link BookPlanOptions.spreadOrder} order. */
  spreads: BookSpread[];
  /** Parity blanks, ascending by spread and then left before right. */
  blanks: BookBlank[];
}

/** Options for {@link planBook}; every field has a documented default. */
export interface BookPlanOptions {
  /**
   * Treat the first page as a cover, i.e. a leaf of its own rather than a page facing a
   * neighbour. Default `false`: page 1 is a normal page that still opens on its parity side.
   */
  firstPageIsCover?: boolean;
  /**
   * Put the first page of the sequence on the right, the Western default where page 1 is a
   * recto. Set `false` for a mirrored binding, where the first page sits on the left.
   * Default `true`.
   */
  startOnRight?: boolean;
  /**
   * Order of the returned {@link BookPlan.spreads}. `forward` starts with the first spread
   * of the document, `reverse` with the last, which is the order a right-to-left filmstrip
   * or a back-to-front browser reads in. Default `forward`.
   */
  spreadOrder?: SpreadOrder;
}

/** Where one page sits: the spread that holds it and its side of that spread. */
export interface PageLocation {
  /** The spread holding the page, as it appears in {@link BookPlan.spreads}. */
  spread: BookSpread;
  /** Position of that spread in {@link BookPlan.spreads}, 0-based. */
  index: number;
  /** Side of the spread the page occupies. */
  side: BookSide;
}

/** One pane a reader should paint. */
export interface BookPane {
  /** Side of the spread the pane occupies. */
  side: BookSide;
  /** The page the pane shows. */
  page: BookPage;
  /** True for the pane holding the page the reader is on. */
  current: boolean;
  /** True for the pane facing the current page. */
  facing: boolean;
}

/** What a reader should paint for one spread. */
export interface BookVisibility {
  /** Panes to paint, left to right. A blank slot contributes no pane. */
  panes: BookPane[];
  /**
   * The pane holding the current page, or `null` when the caller's page is not in this
   * spread. The object is the same one that appears in {@link BookVisibility.panes}.
   */
  current: BookPane | null;
  /**
   * The pane facing the current page, or `null` when the current page stands alone (a
   * cover, a blank slot) or the caller's page is not in this spread.
   */
  facing: BookPane | null;
}

/** Why a plan was refused. */
export type BookModeErrorCode = 'unknown-spread-order';

/** A plan request this module will not answer. */
export class BookModeError extends Error {
  readonly code: BookModeErrorCode;

  constructor(code: BookModeErrorCode, message: string) {
    super(message);
    this.name = 'BookModeError';
    this.code = code;
  }
}

/** Narrows a runtime value to a {@link SpreadOrder}. */
export function isSpreadOrder(value: unknown): value is SpreadOrder {
  return value === 'forward' || value === 'reverse';
}

/** Options after defaults, so the builders never re-read an option. */
interface ResolvedOptions {
  firstPageIsCover: boolean;
  startOnRight: boolean;
  spreadOrder: SpreadOrder;
}

/** A spread while the plan is being built, before kind and folios are known. */
interface WorkingSpread {
  left: BookPage | null;
  right: BookPage | null;
  /** True when this spread is the cover's own opening. */
  cover: boolean;
}

/**
 * Plans the facing-page layout of a document.
 *
 * Pages are sorted by number and a repeated number keeps its first occurrence. The first
 * page sits on the side {@link BookPlanOptions.startOnRight} names, every following page
 * alternates, and a left page opens a spread while a right page closes it; see the module
 * comment for the rule and what it implies for covers and blanks.
 *
 * Throws {@link BookModeError} for an unknown `spreadOrder`. Every other input is read with
 * the documented defaults rather than refused, because a plan request comes from a reader
 * that may not have measured the document yet.
 */
export function planBook(pages: readonly BookPageInput[], options: BookPlanOptions = {}): BookPlan {
  const settings = resolveOptions(options);
  const working = buildSpreads(readPages(pages), settings);
  const blanks = parityBlanks(working);
  const spreads = working.map((spread, index) => toSpread(spread, index));

  if (settings.spreadOrder === 'forward') return { spreads, blanks };

  const last = spreads.length - 1;
  return {
    spreads: [...spreads].reverse().map((spread, index) => ({ ...spread, index })),
    blanks: blanks
      .map(blank => ({ ...blank, spread: last - blank.spread }))
      .sort((left, right) => left.spread - right.spread || sideRank(left.side) - sideRank(right.side)),
  };
}

/**
 * Finds the spread holding a page and the side it sits on.
 *
 * Returns `null` when the page is not in the plan, and for a page number that is not a
 * positive integer (0, 1.5, `NaN`): a page the plan never placed cannot be located, and
 * guessing the nearest spread would put two unrelated pages side by side.
 */
export function spreadFor(plan: BookPlan, pageNumber: number): PageLocation | null {
  const wanted = pageNumberOf(pageNumber);
  if (wanted === null) return null;

  const spreads = Array.isArray(plan?.spreads) ? plan.spreads : [];
  for (let index = 0; index < spreads.length; index += 1) {
    const spread = spreads[index];
    if (spread === undefined) continue;
    if (placedPage(spread.left)?.number === wanted) return { spread, index, side: 'left' };
    if (placedPage(spread.right)?.number === wanted) return { spread, index, side: 'right' };
  }
  return null;
}

/**
 * Reports which panes a reader should paint for one spread on one page.
 *
 * The current page and its facing page are shown together, so a UI never puts two unrelated
 * pages side by side: a spread paints both of its pages, while a cover or a page with a blank
 * slot beside it paints one. A page that is not in this spread — a stale reading position, or
 * the wrong spread — leaves `current` and `facing` null while `panes` still lists the spread
 * the caller passed, so the caller can see the mismatch instead of being handed an invented
 * pair.
 */
export function visibilityFor(spread: BookSpread, currentPage: number): BookVisibility {
  const wanted = pageNumberOf(currentPage);
  const left = placedPage(spread?.left);
  const right = placedPage(spread?.right);
  const panes: BookPane[] = [];

  if (left !== null) panes.push({ side: 'left', page: left, current: wanted === left.number, facing: false });
  if (right !== null) panes.push({ side: 'right', page: right, current: wanted === right.number, facing: false });

  const current = panes.find(pane => pane.current) ?? null;
  // Only two facing pages are a pair. A cover, and a page with a blank slot beside it, leave
  // the current page standing alone: nothing faces it.
  const facing = current !== null && panes.length === 2
    ? panes.find(pane => pane !== current) ?? null
    : null;
  if (facing !== null) facing.facing = true;

  return { panes, current, facing };
}

// --- Building the plan -----------------------------------------------------

function resolveOptions(options: BookPlanOptions | undefined): ResolvedOptions {
  const record: BookPlanOptions = options ?? {};
  const spreadOrder = record.spreadOrder ?? 'forward';
  if (!isSpreadOrder(spreadOrder)) {
    throw new BookModeError(
      'unknown-spread-order',
      `Unknown spread order: ${String(spreadOrder)}. Use one of ${SPREAD_ORDERS.join(' | ')}.`,
    );
  }
  return {
    firstPageIsCover: record.firstPageIsCover === true,
    startOnRight: record.startOnRight !== false,
    spreadOrder,
  };
}

/**
 * Reads the page list: numbers repaired, duplicates dropped, sorted ascending.
 *
 * A page without a usable number is numbered by its input position, matching
 * `detectFurniture` and `orderDocument`, so an unnumbered list still opens in the order the
 * reader handed it over.
 */
function readPages(pages: readonly BookPageInput[]): BookPage[] {
  const items = Array.isArray(pages) ? pages : [];
  const byNumber = new Map<number, BookPage>();

  items.forEach((page, index) => {
    const source = page as BookPageInput | undefined;
    const number = pageNumberOf(source?.number) ?? index + 1;
    if (byNumber.has(number)) return;
    byNumber.set(number, {
      number,
      width: positiveOr(source?.width, DEFAULT_PAGE_WIDTH),
      height: positiveOr(source?.height, DEFAULT_PAGE_HEIGHT),
    });
  });

  return [...byNumber.values()].sort((left, right) => left.number - right.number);
}

/**
 * Lays the pages out in alternating slots and cuts the slot sequence into spreads.
 *
 * A right page closes the open spread, a left page opens one, and the cover closes its own
 * spread whatever side it is on. Only the first spread, the spread right after a cover that
 * sits on the left, and the last spread can therefore be incomplete — so the blank rule can
 * read the empty side directly instead of searching for it.
 */
function buildSpreads(pages: readonly BookPage[], settings: ResolvedOptions): WorkingSpread[] {
  const spreads: WorkingSpread[] = [];
  let open: WorkingSpread = { left: null, right: null, cover: false };
  let side: BookSide = settings.startOnRight ? 'right' : 'left';

  const close = (): void => {
    spreads.push(open);
    open = { left: null, right: null, cover: false };
  };

  pages.forEach((page, position) => {
    if (position === 0 && settings.firstPageIsCover) {
      // The cover is a leaf of its own: it opens and closes the first spread whatever side
      // the binding puts it on, so the next page always starts a fresh opening.
      const cover: WorkingSpread = { left: null, right: null, cover: true };
      if (side === 'left') cover.left = page;
      else cover.right = page;
      spreads.push(cover);
      side = flipSide(side);
      return;
    }

    if (side === 'left') {
      // A left page always finds an empty spread: the page before it was a right page, and
      // a right page closes its spread, so nothing can be overwritten here.
      open.left = page;
    } else {
      open.right = page;
      close();
    }
    side = flipSide(side);
  });

  if (open.left !== null || open.right !== null) spreads.push(open);
  return spreads;
}

/** Turns a working spread into its public form, with kind and folios. */
function toSpread(spread: WorkingSpread, index: number): BookSpread {
  const kind = kindOf(spread);
  return {
    index,
    left: spread.left,
    right: spread.right,
    kind,
    folios: foliosOf(spread.left, spread.right, kind),
  };
}

function kindOf(spread: WorkingSpread): SpreadKind {
  if (spread.cover) return 'cover';
  return spread.left !== null && spread.right !== null ? 'spread' : 'single';
}

/**
 * Builds the folios of one spread, left to right.
 *
 * A cover prints no number; a page in a two-page spread prints its folio on the outer edge,
 * where a printed book expects it; a page standing alone prints it centred, since there is no
 * facing page to balance.
 */
function foliosOf(left: BookPage | null, right: BookPage | null, kind: SpreadKind): BookFolio[] {
  const placement: FolioPlacement = kind === 'spread' ? 'outer' : 'center';
  const folios: BookFolio[] = [];
  for (const [side, page] of [['left', left], ['right', right]] as const) {
    if (page === null) continue;
    folios.push({
      page: page.number,
      number: kind === 'cover' ? null : page.number,
      placement,
      side,
    });
  }
  return folios;
}

/**
 * Lists the empty slots the plan invented, in spread order.
 *
 * A cover is skipped on purpose: its unoccupied side is the reverse of its own leaf, not a
 * page the document has to insert. Everything else is a parity blank.
 */
function parityBlanks(spreads: readonly WorkingSpread[]): BookBlank[] {
  const blanks: BookBlank[] = [];
  spreads.forEach((spread, index) => {
    if (spread.cover) return;
    if (spread.left === null) blanks.push({ side: 'left', spread: index });
    if (spread.right === null) blanks.push({ side: 'right', spread: index });
  });
  return blanks;
}

// --- Small helpers ---------------------------------------------------------

function flipSide(side: BookSide): BookSide {
  return side === 'left' ? 'right' : 'left';
}

/** Sort rank of a blank's side: a leading blank lists before a trailing one. */
function sideRank(side: BookSide): number {
  return side === 'left' ? 0 : 1;
}

/** A page as a spread holds it, or `null` for a slot that is empty or unusable. */
function placedPage(value: unknown): BookPage | null {
  const page = value as BookPage | null | undefined;
  if (page === null || page === undefined || typeof page !== 'object') return null;
  const number = pageNumberOf(page.number);
  if (number === null) return null;
  return page;
}

/** A positive integer page number, or `null` when the value cannot name a page. */
function pageNumberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
