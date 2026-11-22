/**
 * Bilingual page-sequence planning (backlog items H01/H03).
 *
 * Why this module exists: a bilingual PDF is not one page with two columns; it is a
 * *sequence*. Someone has to decide which pages the document has, in what order, and what
 * furniture a printed page carries. `bilingual.ts` renders whatever pages a caller hands
 * it, and `pdf.ts` writes one output page per source page, so neither decides that
 * sequence. This planner does, and it does so purely: no DOM, no clock, no pdf-lib, no
 * locale. A caller can therefore test a whole book's pagination before writing a byte.
 *
 * Modes:
 * - `source` and `target` are pass-through: one planned page per source page, showing one
 *   side of it. The plan keeps the source page's order and count.
 * - `alternating` emits the source page and then its translation for every source page,
 *   so the page count doubles and a reader always finds the original opposite the
 *   translation, at the cost of twice the paper.
 * - `interleaved` keeps both panes on one page when the translation fits the pane the page
 *   can offer; otherwise that page falls back to the alternating pair and records why in
 *   its `fallback` field. The page count therefore depends on the text, not on the mode
 *   alone — which is exactly the trade the reader is being offered.
 *
 * Fit rule, in the units the estimator uses (half-em: a Latin character costs 1, an
 * ideograph, kana, hangul, full-width form or emoji costs 2, one space costs 1):
 * - one page's text area is `width - 2 * margin` by `height - 2 * margin - furnitureBand`;
 * - interleaved mode splits that height into two equal panes with `paneGutter` between them;
 * - `charsPerLine`, the character budget of a line, is
 *   floor(textWidth / (fontSize * charWidthRatio));
 * - `linesPerPane`, the line budget of a pane, is floor(paneHeight / (fontSize * lineHeightRatio));
 * - a page keeps both panes only when it has target text (a pane with nothing in it is not a
 *   pair), both budgets are at least one, and the estimated lines of the target text and of
 *   the source text each fit their pane. Blocks are estimated in order with one blank line
 *   between them, the same separation the text exports use.
 * The estimate is an estimate: it assumes a flat average advance, not a shaped font, and it
 * ignores hyphenation, floats and figures. A caller with a real measurer passes a
 * `charWidthRatio` measured for its face. The plan decides the *sequence*; the writer still
 * owns the last word on a pane that overflows while drawing.
 *
 * Furniture: every planned page carries a running head, a folio ("Page X of Y") and the
 * alignment a printed spread needs. Numbering runs continuously through the produced
 * document — X is the planned page's 1-based position, Y is the plan length — because that
 * is the number a reader turns to; the source page number travels in the running head
 * instead, so a translation page always says which original it belongs to. The folio sits
 * on the outer edge of the spread by default (odd pages recto, the right edge; even pages
 * verso, the left), which is why `align` alternates with the page and why a caller may
 * override it with `align: 'center'` for a single-sided print.
 *
 * Locale: this module owns no strings. `labels`, `headerTemplate`, `footerTemplate` and
 * `labelTemplate` are caller options, the same handoff `bilingual.ts` already makes with
 * its `pageLabel` callback, so the UI can pass its own translations without this module
 * depending on the i18n table.
 *
 * Contract:
 * - Deterministic and total: the same pages, mode and options always produce the same plan.
 *   A missing size or block list is read with the documented defaults rather than throwing,
 *   because plan inputs come from a reader that may not have measured every page yet. The
 *   one refused input is an unknown mode, which is a programming error rather than data.
 * - The input list is not trusted to be ordered: pages are sorted by page number and then by
 *   input position, so a caller can hand over whatever order its reader happens to hold.
 * - Nothing is written and nothing is cached. A caller re-plans after more translations
 *   arrive; the page count may change when a page starts or stops fitting.
 */

/** How a bilingual export lays its pages out. */
export type PairMode = 'source' | 'target' | 'alternating' | 'interleaved';

/** Every mode, in the order a picker should offer them. */
export const PAIR_MODES: readonly PairMode[] = ['source', 'target', 'alternating', 'interleaved'];

/** What one planned page shows. */
export type PlannedPageKind = 'source' | 'target' | 'interleaved';

/** Every planned page kind. */
export const PLANNED_PAGE_KINDS: readonly PlannedPageKind[] = ['source', 'target', 'interleaved'];

/** Horizontal placement of the folio inside a page's furniture. */
export type FurnitureAlign = 'left' | 'center' | 'right';

/** `outer` is the printed-book default: the folio moves to the outer edge of the spread. */
export type FurniturePlacement = FurnitureAlign | 'outer';

/** Why a page that asked for one page had to become the alternating pair. */
export type FallbackReason = 'no-target' | 'target-overflow' | 'source-overflow' | 'no-room';

/** A block as planning needs it: the two texts it would print. */
export interface PairBlock {
  /** Original text, before translation. */
  source: string;
  /** Translated text; empty when this block has no translation yet. */
  target: string;
}

/** One source page as the planner reads it. */
export interface PairPage {
  /** 1-based source page number; a missing one is read as the page's input position. */
  pageNumber: number;
  /** Source page width in points; a missing one falls back to US Letter. */
  width: number;
  /** Source page height in points; a missing one falls back to US Letter. */
  height: number;
  /** The page's blocks, in reading order. */
  blocks: readonly PairBlock[];
}

/** The furniture of one planned page: what a printer puts outside the text area. */
export interface PageFurniture {
  /** Running head, placeholders already substituted. */
  header: string;
  /** Folio, placeholders already substituted. */
  footer: string;
  /** Where `footer` sits on the page. */
  align: FurnitureAlign;
}

/** One page of the planned sequence. */
export interface OutlinedPage {
  /** What this page shows. */
  kind: PlannedPageKind;
  /** 1-based source page this planned page belongs to. */
  sourcePage: number;
  /** 1-based position in the produced document; also the folio number. */
  index: number;
  /** Running head and folio for this page. */
  furniture: PageFurniture;
  /**
   * Set on both pages of a source page that had to fall back from one interleaved page to
   * the alternating pair, and absent otherwise. Both pages carry the reason so either one
   * can explain why it stands alone.
   */
  fallback?: FallbackReason;
}

/** Localized names of the three page kinds; omitted fields keep the English defaults. */
export interface FurnitureLabels {
  source?: string;
  target?: string;
  interleaved?: string;
}

/** Options shared by `furnitureFor` and `planPairs`. */
export interface FurnitureOptions {
  /** Document title placed before the kind label in the running head; empty by default. */
  title?: string;
  /**
   * 1-based position of this page in the produced document, i.e. the folio number.
   * Defaults to the position the page would have in a pure alternating plan, which is exact
   * for `source`, `target` and `alternating` plans; `planPairs` always passes it.
   */
  index?: number;
  /** Localized kind labels. */
  labels?: FurnitureLabels;
  /** Folio placement; `outer` (the default) picks the outer edge from the page parity. */
  align?: FurniturePlacement;
  /** Running-head template. Default `{title} · {label} · source {source}`. */
  headerTemplate?: string;
  /** Folio template. Default `Page {page} of {pages}`. */
  footerTemplate?: string;
}

/** Everything `planPairs` accepts: furniture strings plus the fit estimate's geometry. */
export interface PairPlanOptions extends FurnitureOptions {
  /** Body font size in points used by the fit estimate. Default 10. */
  bodyFontSize?: number;
  /** Average advance of one character as a fraction of the font size. Default 0.5. */
  charWidthRatio?: number;
  /** Line advance as a fraction of the font size. Default 1.35. */
  lineHeightRatio?: number;
  /** Margin reserved on each side of the page in points. Default 36 (half an inch). */
  margin?: number;
  /** Height reserved for the header and footer bands together, in points. Default 48. */
  furnitureBand?: number;
  /** Gap between the source and target panes of one interleaved page. Default 12. */
  paneGutter?: number;
}

/** Everything `pageLabels` accepts. */
export interface PageLabelOptions {
  /** Document title; only used when the template asks for `{title}`. */
  title?: string;
  /** Localized kind labels. */
  labels?: FurnitureLabels;
  /** Entry template. Default `{index}. {label} · source {source}`. */
  labelTemplate?: string;
}

/** The result of the documented fit rule for one source page. */
export interface InterleaveFit {
  /** True when both panes fit and the page has target text to show. */
  fits: boolean;
  /** Why the page cannot be interleaved, or `null` when it can. */
  reason: FallbackReason | null;
  /** Character budget of one line, in half-em units. */
  charsPerLine: number;
  /** Line budget of one pane. */
  linesPerPane: number;
  /** Estimated lines the source text needs; 0 when there is no source text. */
  sourceLines: number;
  /** Estimated lines the target text needs; 0 when there is no translation. */
  targetLines: number;
}

/** Why a plan request was refused. */
export type PairPlanErrorCode = 'unknown-mode' | 'unknown-kind';

/** A plan request the planner will not answer. */
export class PairPlanError extends Error {
  readonly code: PairPlanErrorCode;

  constructor(code: PairPlanErrorCode, message: string) {
    super(message);
    this.name = 'PairPlanError';
    this.code = code;
  }
}

/** Page width in points used when a caller supplies none. */
export const DEFAULT_PAGE_WIDTH_PT = 612;

/** Page height in points used when a caller supplies none. */
export const DEFAULT_PAGE_HEIGHT_PT = 792;

/** Body font size in points assumed by the fit estimate. */
export const DEFAULT_BODY_FONT_SIZE_PT = 10;

/** Average advance of one character, as a fraction of the font size. */
export const DEFAULT_CHAR_WIDTH_RATIO = 0.5;

/** Line advance, as a fraction of the font size. */
export const DEFAULT_LINE_HEIGHT_RATIO = 1.35;

/** Margin reserved on each side of the page, in points. */
export const DEFAULT_PAGE_MARGIN_PT = 36;

/** Height reserved for the header and footer bands together, in points. */
export const DEFAULT_FURNITURE_BAND_PT = 48;

/** Gap between the two panes of an interleaved page, in points. */
export const DEFAULT_PANE_GUTTER_PT = 12;

/** Blank lines charged between two consecutive blocks of one pane. */
export const BLOCK_GAP_LINES = 1;

/** Cost of one full-width character, in half-em units. */
export const WIDE_CHAR_COST = 2;

/** Cost of one half-width character, in half-em units. */
export const NARROW_CHAR_COST = 1;

/** Running head used when the caller supplies no template. */
export const DEFAULT_HEADER_TEMPLATE = '{title} · {label} · source {source}';

/** Folio template used when the caller supplies none. */
export const DEFAULT_FOOTER_TEMPLATE = 'Page {page} of {pages}';

/** Table-of-contents label used when the caller supplies no template. */
export const DEFAULT_LABEL_TEMPLATE = '{index}. {label} · source {source}';

/** Kind labels used when the caller supplies none. */
export const DEFAULT_KIND_LABELS: Readonly<Record<PlannedPageKind, string>> = {
  source: 'Original',
  target: 'Translation',
  interleaved: 'Original + translation',
};

/**
 * Characters that take two half-em units: hangul, CJK radicals and ideographs, kana,
 * full-width forms, CJK compatibility forms, and emoji.
 */
const WIDE_CHARACTER = /[\u1100-\u115f\u2e80-\ua4cf\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}]/u;

/** Separator the templates and the collapsed furniture use between their pieces. */
const PIECE_SEPARATOR = ' · ';

/** Narrows a runtime value to a {@link PairMode}. */
export function isPairMode(value: unknown): value is PairMode {
  return value === 'source' || value === 'target' || value === 'alternating' || value === 'interleaved';
}

/** Narrows a runtime value to a {@link PlannedPageKind}. */
export function isPlannedPageKind(value: unknown): value is PlannedPageKind {
  return value === 'source' || value === 'target' || value === 'interleaved';
}

/**
 * Plans the page sequence for a bilingual export.
 *
 * The returned plan is the document a writer should produce, page by page: `index` is the
 * page's position in it, `sourcePage` the original page it came from, `kind` what it shows
 * and `furniture` its running head and folio. Pages are ordered by source page number, so an
 * unsorted input still produces a readable book.
 *
 * An empty page list produces an empty plan for every mode. A page with no blocks still gets
 * a page and its furniture, because pagination is a property of the source document, not of
 * its text.
 *
 * Throws {@link PairPlanError} with code `unknown-mode` when the mode is not one of
 * {@link PAIR_MODES}; everything else is read with the documented defaults.
 */
export function planPairs(
  pages: readonly PairPage[],
  mode: PairMode,
  options: PairPlanOptions = {},
): OutlinedPage[] {
  const known = requireMode(mode);
  const settings: PairPlanOptions = options ?? {};
  const ordered = readPages(pages);
  const entries: { kind: PlannedPageKind; sourcePage: number; fallback?: FallbackReason }[] = [];

  for (const page of ordered) {
    if (known === 'source' || known === 'target') {
      entries.push({ kind: known, sourcePage: page.pageNumber });
      continue;
    }

    if (known === 'alternating') {
      entries.push({ kind: 'source', sourcePage: page.pageNumber });
      entries.push({ kind: 'target', sourcePage: page.pageNumber });
      continue;
    }

    const fit = interleaveFit(page, settings);
    if (fit.fits) {
      entries.push({ kind: 'interleaved', sourcePage: page.pageNumber });
      continue;
    }
    // A page that cannot keep both panes becomes exactly the pair alternating mode would emit,
    // so a mixed book still reads as "original, then its translation" wherever it had to split.
    const reason: FallbackReason = fit.reason ?? 'target-overflow';
    entries.push({ kind: 'source', sourcePage: page.pageNumber, fallback: reason });
    entries.push({ kind: 'target', sourcePage: page.pageNumber, fallback: reason });
  }

  const total = entries.length;
  return entries.map((entry, position) => {
    const index = position + 1;
    const furniture = furnitureFor(entry.kind, entry.sourcePage, total, { ...settings, index });
    const planned: OutlinedPage = { kind: entry.kind, sourcePage: entry.sourcePage, index, furniture };
    if (entry.fallback !== undefined) planned.fallback = entry.fallback;
    return planned;
  });
}

/**
 * Builds the running head and folio of one planned page.
 *
 * `total` is the number of pages in the produced document and `sourcePage` the original page
 * this one belongs to. Placeholders are substituted here, not by the caller:
 * `{title}`, `{label}`, `{source}`, `{page}` and `{pages}` for both templates, plus `{index}`
 * as an alias of `{page}`. Empty pieces are dropped from a `·`-separated template, so a page
 * without a title gets `Original · source 2` instead of a leading separator; an unknown
 * placeholder is left as written rather than silently removed.
 *
 * `total` is raised to `index` when a caller passes fewer pages than the folio claims, so
 * "Page 7 of 3" cannot be produced. `align` follows the printed-spread convention unless the
 * caller asks for a fixed edge: odd pages are recto and put the folio on the right, even
 * pages are verso and put it on the left.
 *
 * Throws {@link PairPlanError} with code `unknown-kind` for a kind this planner does not emit.
 */
export function furnitureFor(
  kind: PlannedPageKind,
  sourcePage: number,
  total: number,
  options: FurnitureOptions = {},
): PageFurniture {
  const known = requireKind(kind);
  const settings: FurnitureOptions = options ?? {};
  const source = positiveInteger(sourcePage) ?? 1;
  const index = positiveInteger(settings.index) ?? defaultIndex(known, source);
  const pages = Math.max(index, positiveInteger(total) ?? 1);
  const labels = readLabels(settings.labels);
  const vars: Record<string, string> = {
    title: clean(settings.title),
    label: labels[known],
    source: String(source),
    page: String(index),
    pages: String(pages),
    index: String(index),
  };
  const placement = settings.align === 'left' || settings.align === 'center' || settings.align === 'right'
    ? settings.align
    : outerAlign(index);

  return {
    header: renderTemplate(readTemplate(settings.headerTemplate, DEFAULT_HEADER_TEMPLATE), vars),
    footer: renderTemplate(readTemplate(settings.footerTemplate, DEFAULT_FOOTER_TEMPLATE), vars),
    align: placement,
  };
}

/**
 * Returns the label a reader sees for each planned page, in plan order, for a table of
 * contents: one entry per page, so `labels.length === plan.length`.
 *
 * The default template is `{index}. {label} · source {source}`. As with the furniture, the
 * caller supplies localized labels and may rewrite the template; `{pages}` and `{title}` are
 * available for a caller that wants them.
 */
export function pageLabels(plan: readonly OutlinedPage[], options: PageLabelOptions = {}): string[] {
  const pages: readonly OutlinedPage[] = Array.isArray(plan) ? plan : [];
  const settings: PageLabelOptions = options ?? {};
  const template = readTemplate(settings.labelTemplate, DEFAULT_LABEL_TEMPLATE);
  const labels = readLabels(settings.labels);
  const title = clean(settings.title);
  const total = pages.length;

  return pages.map((page, position) => {
    const index = positiveInteger(page?.index) ?? position + 1;
    const source = positiveInteger(page?.sourcePage) ?? index;
    const kind = isPlannedPageKind(page?.kind) ? page.kind : 'source';
    return renderTemplate(template, {
      title,
      label: labels[kind],
      source: String(source),
      page: String(index),
      pages: String(total),
      index: String(index),
    });
  });
}

/**
 * Applies the documented fit rule to one source page and reports what it decided.
 *
 * A page keeps both panes (`fits: true`) when it has target text, the page leaves room for
 * at least one line of at least one character, and both the target and the source text fit
 * their pane. The reasons are checked in that order: `no-target`, `no-room`,
 * `target-overflow`, `source-overflow`. The numbers reported are the ones the decision used,
 * so a caller can show "needs 31 lines, the pane holds 24" instead of a bare refusal.
 */
export function interleaveFit(page: PairPage, options: PairPlanOptions = {}): InterleaveFit {
  const read = readPage(page, 0);
  const settings = readFitOptions(options ?? {});
  const margin = Math.min(settings.margin, read.width / 2, read.height / 2);
  const textWidth = Math.max(0, read.width - 2 * margin);
  const band = Math.min(settings.furnitureBand, Math.max(0, read.height - 2 * margin));
  const textHeight = Math.max(0, read.height - 2 * margin - band);
  const gutter = Math.min(settings.paneGutter, textHeight);
  const paneHeight = Math.max(0, (textHeight - gutter) / 2);
  const charWidth = settings.bodyFontSize * settings.charWidthRatio;
  const lineHeight = settings.bodyFontSize * settings.lineHeightRatio;
  const charsPerLine = charWidth > 0 ? Math.floor(textWidth / charWidth) : 0;
  const linesPerPane = lineHeight > 0 ? Math.floor(paneHeight / lineHeight) : 0;

  const empty: InterleaveFit = {
    fits: false,
    reason: null,
    charsPerLine: Math.max(0, charsPerLine),
    linesPerPane: Math.max(0, linesPerPane),
    sourceLines: 0,
    targetLines: 0,
  };

  const hasTarget = read.blocks.some(block => clean(block.target).length > 0);
  if (!hasTarget) return { ...empty, reason: 'no-target' };
  if (charsPerLine < 1 || linesPerPane < 1) return { ...empty, reason: 'no-room' };

  const targetLines = paneLines(read.blocks, 'target', charsPerLine);
  const sourceLines = paneLines(read.blocks, 'source', charsPerLine);
  if (targetLines > linesPerPane) return { ...empty, targetLines, sourceLines, reason: 'target-overflow' };
  if (sourceLines > linesPerPane) return { ...empty, targetLines, sourceLines, reason: 'source-overflow' };
  return { fits: true, reason: null, charsPerLine, linesPerPane, sourceLines, targetLines };
}

/**
 * Estimates how many lines a text needs in a column of `charsPerLine` half-em units.
 *
 * Paragraphs break on newlines; a blank paragraph costs nothing. Words are placed greedily
 * with one unit for the space between them, and a token wider than the column is broken into
 * whole lines plus a remainder, which is what a writer does with a URL or a long CJK run.
 * A budget below 1 is read as 1: a column too narrow for one character still puts one
 * character on a line, so the result is always a real line count and never `Infinity`.
 */
export function estimateLines(text: string, charsPerLine: number): number {
  const budget = Number.isFinite(charsPerLine) ? Math.max(1, Math.floor(charsPerLine)) : 1;
  const source = typeof text === 'string' ? text : '';
  const paragraphs = source.replace(/\r\n?/g, '\n').split('\n');
  let lines = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.trim().length === 0) continue;
    lines += paragraphLines(paragraph, budget);
  }
  return lines;
}

// --- Planning internals ----------------------------------------------------

/** A page after defaults, with the input position kept for the sort tie-break. */
interface ReadPage {
  pageNumber: number;
  width: number;
  height: number;
  blocks: PairBlock[];
  order: number;
}

/** The fit estimate's resolved geometry. */
interface FitSettings {
  bodyFontSize: number;
  charWidthRatio: number;
  lineHeightRatio: number;
  margin: number;
  furnitureBand: number;
  paneGutter: number;
}

function readPages(pages: unknown): ReadPage[] {
  const list: readonly unknown[] = Array.isArray(pages) ? pages : [];
  const rows: ReadPage[] = [];
  list.forEach((value, position) => {
    if (typeof value !== 'object' || value === null) return;
    rows.push(readPage(value, position));
  });
  // Source page order is the book's order: page number first, input position as the tie-break
  // for a duplicate page number, so the sort is total and the plan is deterministic.
  rows.sort((left, right) => left.pageNumber - right.pageNumber || left.order - right.order);
  return rows;
}

function readPage(value: unknown, position: number): ReadPage {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    pageNumber: positiveInteger(record.pageNumber) ?? position + 1,
    width: positiveNumber(record.width) ?? DEFAULT_PAGE_WIDTH_PT,
    height: positiveNumber(record.height) ?? DEFAULT_PAGE_HEIGHT_PT,
    blocks: readBlocks(record.blocks),
    order: position,
  };
}

function readBlocks(value: unknown): PairBlock[] {
  const list: readonly unknown[] = Array.isArray(value) ? value : [];
  const blocks: PairBlock[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    blocks.push({
      source: typeof record.source === 'string' ? record.source : '',
      target: typeof record.target === 'string' ? record.target : '',
    });
  }
  return blocks;
}

function readFitOptions(options: PairPlanOptions): FitSettings {
  return {
    bodyFontSize: clamp(options.bodyFontSize, DEFAULT_BODY_FONT_SIZE_PT, 1, 96),
    charWidthRatio: clamp(options.charWidthRatio, DEFAULT_CHAR_WIDTH_RATIO, 0.1, 2),
    lineHeightRatio: clamp(options.lineHeightRatio, DEFAULT_LINE_HEIGHT_RATIO, 0.8, 3),
    margin: clamp(options.margin, DEFAULT_PAGE_MARGIN_PT, 0, 200),
    furnitureBand: clamp(options.furnitureBand, DEFAULT_FURNITURE_BAND_PT, 0, 400),
    paneGutter: clamp(options.paneGutter, DEFAULT_PANE_GUTTER_PT, 0, 400),
  };
}

/** Estimated lines of one pane's field across the page's blocks, gaps included. */
function paneLines(blocks: readonly PairBlock[], field: 'source' | 'target', charsPerLine: number): number {
  let lines = 0;
  let written = 0;
  for (const block of blocks) {
    const text = clean(block[field]);
    if (text.length === 0) continue;
    if (written > 0) lines += BLOCK_GAP_LINES;
    lines += estimateLines(text, charsPerLine);
    written += 1;
  }
  return lines;
}

function paragraphLines(text: string, budget: number): number {
  const atoms: number[] = [];
  for (const word of text.trim().split(/\s+/u)) {
    if (word.length === 0) continue;
    if (atoms.length > 0) atoms.push(NARROW_CHAR_COST);
    const cost = textCost(word);
    if (cost <= budget) {
      atoms.push(cost);
      continue;
    }
    // A token wider than the column breaks into whole lines plus a remainder.
    let remaining = cost;
    while (remaining > budget) {
      atoms.push(budget);
      remaining -= budget;
    }
    if (remaining > 0) atoms.push(remaining);
  }

  let lines = 1;
  let used = 0;
  for (const atom of atoms) {
    if (used > 0 && used + atom > budget) {
      lines += 1;
      used = 0;
    }
    used += atom;
  }
  return lines;
}

function textCost(text: string): number {
  let cost = 0;
  for (const character of text) {
    cost += WIDE_CHARACTER.test(character) ? WIDE_CHAR_COST : NARROW_CHAR_COST;
  }
  return cost;
}

function readLabels(labels: FurnitureLabels | undefined): Record<PlannedPageKind, string> {
  const source = typeof labels?.source === 'string' ? labels.source.trim() : '';
  const target = typeof labels?.target === 'string' ? labels.target.trim() : '';
  const interleaved = typeof labels?.interleaved === 'string' ? labels.interleaved.trim() : '';
  return {
    source: source || DEFAULT_KIND_LABELS.source,
    target: target || DEFAULT_KIND_LABELS.target,
    interleaved: interleaved || DEFAULT_KIND_LABELS.interleaved,
  };
}

function readTemplate(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : fallback;
}

/**
 * Substitutes placeholders, then drops the pieces an empty placeholder left behind. The
 * separator is the one the defaults use, so a caller that writes its own `·` template gets
 * the same collapsing; a template without the separator is returned as written.
 */
function renderTemplate(template: string, vars: Record<string, string>): string {
  const filled = template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? vars[name] ?? '' : match,
  );
  if (!filled.includes(PIECE_SEPARATOR)) return filled.trim();
  return filled
    .split(PIECE_SEPARATOR)
    .map(piece => piece.trim())
    .filter(piece => piece.length > 0)
    .join(PIECE_SEPARATOR);
}

/** Folio number a page would have in a pure alternating plan, used when none is passed. */
function defaultIndex(kind: PlannedPageKind, sourcePage: number): number {
  if (kind === 'target') return sourcePage * 2;
  if (kind === 'source') return sourcePage * 2 - 1;
  return sourcePage;
}

/** Odd pages are recto (folio right), even pages verso (folio left). */
function outerAlign(index: number): FurnitureAlign {
  return index % 2 === 1 ? 'right' : 'left';
}

function requireMode(mode: PairMode): PairMode {
  if (!isPairMode(mode)) {
    throw new PairPlanError('unknown-mode', `Unknown pair mode: ${String(mode)}.`);
  }
  return mode;
}

function requireKind(kind: PlannedPageKind): PlannedPageKind {
  if (!isPlannedPageKind(kind)) {
    throw new PairPlanError('unknown-kind', `Unknown planned page kind: ${String(kind)}.`);
  }
  return kind;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
  // Zero is meaningful for the geometry options (a bleed layout has no margin), so only a
  // missing, non-finite or negative value falls back to the default.
  const number = finiteNumber(value);
  if (number === null || number < 0) return fallback;
  return Math.min(Math.max(number, minimum), maximum);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
