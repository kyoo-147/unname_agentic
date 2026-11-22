/**
 * Page furniture: running headers, footers, page numbers and watermarks (backlog E09).
 *
 * A translated document must not repeat itself. A running head printed on fifteen pages
 * is the same sentence fifteen times, a folio is a number no translator should spend a
 * token on, and a `DRAFT` watermark is not content at all. This module reads the pages
 * the reader already extracted and says which blocks are furniture, so the translation
 * pipeline can skip them and the exporter can re-emit each page number where it belongs.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no locale. Pages are sorted
 *   by page number and blocks within a page by reading order (top edge in a 0.5 pt
 *   bucket, then left edge, then id), so the same page set produces the same verdicts
 *   and the same ids whatever order the caller hands it in.
 * - Geometry is in PDF points with the origin at the top-left corner and y growing
 *   downwards, matching `Rect` in `src/core/types.ts`.
 * - Nothing is over-claimed: every verdict carries a `confidence` in (0, 1] and the
 *   evidence that produced it (`reasons`, stable machine-readable codes — never
 *   user-facing prose). A block that only *looks* like furniture stays `content` and
 *   says why.
 * - Block text is never rewritten. The one derived string is `normalizedText`, used only
 *   for the repetition test.
 *
 * Rules, applied in this order:
 *
 * 1. **Empty text** is `content`: a rotated image has no text to translate, so rotation
 *    cannot make an empty block a watermark.
 * 2. **Watermark**: a block drawn at an oblique angle — further than
 *    {@link WATERMARK_MIN_OBLIQUE_DEGREES} from the nearest quarter turn — is a
 *    watermark. A scanner's one-degree skew is not oblique enough; a deliberate diagonal
 *    label is. Quarter turns (90/180/270) stay eligible for the other kinds, because a
 *    vertical running head in the margin is not a watermark.
 * 3. **Page number**: a block whose whole text is one lone-number shape from
 *    {@link pageNumberPattern} *and* that sits inside the top or bottom band. A lone `3`
 *    in the middle of the page is a list number, not a folio.
 * 4. **Header / footer**: a block inside the top / bottom band whose normalised text
 *    repeats on at least {@link REPEAT_MIN_PAGE_SHARE} of the pages. Both signals are
 *    required: a band alone is where a one-off footnote line lives, and repetition alone
 *    is how a shared paragraph or a mid-page copyright line would look.
 * 5. Everything else is `content`.
 *
 * Bands: a block is in the top band when its top edge is at most
 * {@link TOP_BAND_SHARE} of the page height, and in the bottom band when its bottom edge
 * is at least `1 - {@link BOTTOM_BAND_SHARE}` of it. A block tall enough to touch both
 * bands is treated as a header, because reading order starts at the top.
 *
 * Repetition: page text is normalised by folding whitespace and case and collapsing
 * every run of digits to `#`, so `Page 3 of 10` and `Page 4 of 10` are the same running
 * foot. A group counts as repeated when it appears on
 * `max({@link MIN_REPEAT_PAGES}, ceil(pages * {@link REPEAT_MIN_PAGE_SHARE}))` distinct
 * pages: a one-page document never repeats, two to three pages need two pages, four pages
 * need three, ten need six. The ceiling carries a {@link SHARE_EPSILON} slack so a page
 * count whose 60 % lands on a whole number is not pushed up by floating-point error.
 * Only groups that clear the threshold reach {@link FurnitureDetection.repeated}; a
 * group below it is not reported as repeated at all, and its members stand on their own
 * evidence (a band line that appears twice in four pages is `content` with
 * `content:band-only`). A repeated group whose members stayed `content` — a shared
 * mid-page copyright line — is still reported, with kind `content`, so repetition is
 * visible as evidence rather than silently dropped.
 *
 * Documented limits, so nobody is surprised by a verdict:
 * - A running foot printed *above* the bottom band (for example at 88 % of the page) is
 *   not furniture here: the bands are fixed at 8 %, and this build has no option to widen
 *   them, so such a line stays `content`. A document family that needs a wider band needs
 *   a follow-up, not a silent tolerance.
 * - A one-word footer that happens to spell a valid Roman numeral (`mix` = 1009) is read
 *   as a page number. The `page-number:pattern=roman` reason names the evidence, and the
 *   block's confidence is the lowest of the number shapes for exactly that reason.
 * - `#` is a shared placeholder: digits and a literal `#` group together, which keeps a
 *   dotted folio template (`Page #`) in the same group as its filled-in pages.
 * - Block ids are used as given; the caller is expected to pass the unique `Block.id`
 *   values from `ir.ts`. A block without an id gets `furniture-b{n}`, numbered in
 *   document order.
 */

import type { Rect } from './types';

/** What a block turned out to be. */
export type FurnitureKind = 'header' | 'footer' | 'page-number' | 'watermark' | 'content';

/** Every kind, in the order reports list them. */
export const FURNITURE_KINDS: readonly FurnitureKind[] = ['header', 'footer', 'page-number', 'watermark', 'content'];

/** Kinds that may be kept out of translation, in the order audit tools list them. */
export const EXCLUDABLE_KINDS: readonly FurnitureKind[] = ['header', 'footer', 'page-number', 'watermark'];

/** Share of the page height that counts as the top band. */
export const TOP_BAND_SHARE = 0.08;

/** Share of the page height that counts as the bottom band. */
export const BOTTOM_BAND_SHARE = 0.08;

/** Share of the pages a normalised text must appear on to be running furniture. */
export const REPEAT_MIN_PAGE_SHARE = 0.6;

/** Floor for the repetition threshold: a one-page document never repeats anything. */
export const MIN_REPEAT_PAGES = 2;

/** Longest text read as a lone page number, in characters. */
export const MAX_PAGE_NUMBER_CHARS = 16;

/** Longest well-formed Roman numeral the pattern accepts (`MMMMCMXCIX` is ten). */
export const MAX_ROMAN_CHARS = 10;

/** Rotation, in degrees, a block must be away from a quarter turn to be a watermark. */
export const WATERMARK_MIN_OBLIQUE_DEGREES = 15;

/** A repeated band block taller than this share of the page loses confidence. */
export const TALL_BAND_BLOCK_SHARE = 0.15;

/** Prefix of the ids invented for blocks the caller gave no id. */
export const SYNTHETIC_BLOCK_ID_PREFIX = 'furniture-b';

/** Page width assumed when neither the page nor its blocks say otherwise, in points. */
export const DEFAULT_PAGE_WIDTH = 612;

/** Page height assumed when neither the page nor its blocks say otherwise, in points. */
export const DEFAULT_PAGE_HEIGHT = 792;

/** Slack on the repetition share, so 60 % of five pages is three and not four. */
export const SHARE_EPSILON = 1e-9;

/** A block as the reader holds it: text, the rect it occupies and its rotation. */
export interface FurnitureBlockInput {
  /** Reader block id (for example `p3-r0`); a block without one gets a synthetic id. */
  id?: string;
  text: string;
  rect: Rect;
  /** Clockwise rotation in degrees as the reader reports it; 0 or omitted means upright. */
  rotation?: number;
}

/** One page of the document, as `src/core/types.ts` describes it. */
export interface FurniturePageInput {
  /** 1-based page number. A page number repeated later in the list is ignored. */
  number: number;
  width: number;
  height: number;
  blocks: readonly FurnitureBlockInput[];
}

/** A block with its verdict. */
export interface FurnitureBlock {
  /** Input block id, or the synthesised id when the caller supplied none. */
  id: string;
  /** 1-based page the block sits on. */
  page: number;
  kind: FurnitureKind;
  /** The block's text as given; never rewritten. */
  text: string;
  /** The rect as given, with non-finite corner values repaired to 0. */
  rect: Rect;
  /** Text the repetition test compares: folded, lowercased, digit runs collapsed to `#`. */
  normalizedText: string;
  /** Rotation normalised into [0, 360). */
  rotation: number;
  /** How strongly the evidence supports `kind`, in (0, 1]. */
  confidence: number;
  /** Stable machine-readable evidence, for example `band:top=0.03`. */
  reasons: string[];
}

/** One text that repeats across pages, with where it was found. */
export interface RepeatedGroup {
  /** Normalised text every member shares; digits and `#` are one placeholder. */
  normalizedText: string;
  /** Most common member text, folded to one line; deterministic on ties (smallest wins). */
  text: string;
  /** Kind most of the members were classified as; `content` for a repeated body line. */
  kind: FurnitureKind;
  /** Distinct 1-based pages the group appears on, ascending. */
  pages: number[];
  /** Member block ids, in document order. */
  blockIds: string[];
  /** Share of the document's pages the group covers, 0..1. */
  share: number;
}

/** Note codes {@link FurnitureDetection.reasons} can carry. */
export type FurnitureReasonCode = 'no-pages' | 'no-blocks' | 'repeated-furniture' | 'repeated-content' | 'band-only';

/** One audit note about a document-level decision. */
export interface FurnitureReason {
  code: FurnitureReasonCode;
  /** 1-based page the note points at; `null` for a note about the whole document. */
  page: number | null;
  /** Block the note points at; `null` for a note about the whole document. */
  blockId: string | null;
  /** Share of pages covered, 0..1; only on repetition notes. */
  share?: number;
  /** Normalised text the note is about; only on repetition notes. */
  normalizedText?: string;
}

/** Everything {@link detectFurniture} found. */
export interface FurnitureDetection {
  /** Every block with its verdict, in document order. */
  classified: FurnitureBlock[];
  /** Text groups that repeat across pages, most widespread first. */
  repeated: RepeatedGroup[];
  /** Document-level audit notes: repetition, one-off band lines, empty input. */
  reasons: FurnitureReason[];
}

/** The shapes {@link pageNumberPattern} can recognise. */
export type PageNumberPatternKind = 'arabic' | 'roman' | 'dash' | 'page-label' | 'page-of-total';

/** Anything that can be read as a classified furniture list. */
export type FurnitureClassification = FurnitureDetection | readonly FurnitureBlock[];

/** Options for {@link excludeFromTranslation}. */
export interface FurnitureExclusionOptions {
  /**
   * Keep page-number blocks out of the skip list so the exporter can re-emit them.
   * Defaults to `true`: a numeral is not language, so translating it is waste, but a
   * page number still belongs on the output page. With `false` the numbers are skipped
   * like any other furniture and {@link FurnitureExclusion.pageNumbers} is empty.
   */
  keepPageNumbers?: boolean;
}

/** One page number kept for re-emission. */
export interface PageNumberSlot {
  /** 1-based source page the number was read from. */
  page: number;
  /** Block the number was read from. */
  blockId: string;
  /** The number folded to one line; this is the text to re-emit on the output page. */
  text: string;
}

/** What {@link excludeFromTranslation} decided. */
export interface FurnitureExclusion {
  /** Block ids to keep out of translation, in document order. */
  skip: string[];
  /**
   * Page numbers kept instead of skipped, ascending by page and then by reading order.
   * One entry per number: a page that carries two numbers lists both, because the source
   * did. The exporter writes each entry's `text` on the matching output page.
   */
  pageNumbers: PageNumberSlot[];
  /** Kinds that contributed to `skip`, unique, in {@link EXCLUDABLE_KINDS} order. */
  skippedKinds: FurnitureKind[];
  /** Whether page numbers are re-emitted or skipped, for the audit line. */
  pageNumberPolicy: 'reemit' | 'skip';
}

/** Counts per kind plus the audit line, from {@link reportFurniture}. */
export interface FurnitureReport {
  /** One entry per kind, zero included; keys are in {@link FURNITURE_KINDS} order. */
  counts: Record<FurnitureKind, number>;
  /** Blocks counted; always the sum of {@link FurnitureReport.counts}. */
  total: number;
  /** Blocks that are not `content`, i.e. what translation can skip. */
  furniture: number;
  /**
   * Locale-independent audit line, for example
   * `furniture header=3 footer=0 page-number=3 watermark=0 content=3 total=9`.
   * It is a log/QA string, not user-facing prose: a UI that shows it to a user must
   * localise the labels itself.
   */
  line: string;
}

/** A block after defaults and ordering, before classification. */
interface WorkingBlock {
  /** Empty when the caller supplied none; filled with a synthetic id after sorting. */
  id: string;
  page: number;
  pageHeight: number;
  text: string;
  normalizedText: string;
  rect: Rect;
  rotation: number;
  /** Position within the page as given, the last sort tie-break. */
  inputIndex: number;
}

/** A page after defaults, before its blocks are sorted. */
interface ReadPage {
  number: number;
  width: number;
  height: number;
  blocks: readonly FurnitureBlockInput[];
}

/** Where a block sits relative to the two bands. */
interface BandReading {
  top: boolean;
  bottom: boolean;
  /** Top edge as a share of the page height. */
  topEdge: number;
  /** Bottom edge as a share of the page height. */
  bottomEdge: number;
}

/** How often a normalised text appears, while the document is being read. */
interface GroupAccumulator {
  pages: Set<number>;
  blockIds: string[];
  /** Folded member text to how many members carry it. */
  texts: Map<string, number>;
}

/** How a block's group fared against the repetition threshold. */
interface Repetition {
  repeated: boolean;
  pagesInGroup: number;
  pageCount: number;
}

/** Confidence a watermark starts from before repetition evidence. */
const WATERMARK_BASE_CONFIDENCE = 0.85;
/** Bonus for a watermark that appears on more than one page. */
const WATERMARK_SHARED_BONUS = 0.05;
/** Confidence a repeated header or footer starts from. */
const BAND_BASE_CONFIDENCE = 0.75;
/** How much of the remaining confidence the group's page share adds. */
const REPETITION_WEIGHT = 0.2;
/** Confidence a band block loses when it is taller than {@link TALL_BAND_BLOCK_SHARE}. */
const TALL_BAND_PENALTY = 0.15;
/** Confidence of a `content` verdict that is the default reading. */
const CONTENT_CONFIDENCE = 0.6;
/** Confidence of a `content` verdict for a band block that did not repeat. */
const BAND_ONLY_CONFIDENCE = 0.4;
/** Confidence of an empty block: there is nothing else it could be. */
const EMPTY_CONFIDENCE = 0.2;

/** Confidence per page-number shape; `roman` is lowest because a word can spell one. */
const PAGE_NUMBER_CONFIDENCE: Record<PageNumberPatternKind, number> = {
  arabic: 0.9,
  roman: 0.85,
  dash: 0.9,
  'page-label': 0.92,
  'page-of-total': 0.95,
};

/** Tie-break when a repeated group holds more than one kind: the more specific wins. */
const KIND_PRIORITY: readonly FurnitureKind[] = ['watermark', 'page-number', 'header', 'footer', 'content'];

/** `Page 3 of 10`, `p. 3/10`. */
const LONE_PAGE_OF_TOTAL = /^(?:page|p\.|pg\.|pp\.)\s*\d{1,4}\s*(?:of|\/)\s*\d{1,4}$/iu;

/** `3 of 10`, `3/10`. */
const BARE_PAGE_OF_TOTAL = /^\d{1,4}\s*(?:of|\/)\s*\d{1,4}$/iu;

/** `- 3 -`, `— 3 —`. */
const LONE_DASH_NUMBER = /^[-–—−]\s*\d{1,4}\s*[-–—−]$/u;

/** `3`, `[3]`, `(3)`, `3.` */
const LONE_ARABIC_NUMBER = /^(?:\d{1,4}|\(\s*\d{1,4}\s*\)|\[\s*\d{1,4}\s*\]|\d{1,4}\s*\.)$/u;

/** `Page 3`, `p. 3`. */
const LONE_PAGE_LABEL = /^(?:page|p\.|pg\.)\s*\d{1,4}$/iu;

/** A well-formed Roman numeral after upper-casing; it rejects `Chapter 3`. */
const ROMAN_NUMERAL = /^M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/u;

/**
 * Recognises the lone-number shapes a folio can take.
 *
 * Returns `null` for anything that is not a single short line, so a paragraph that
 * mentions `Page 3 of 10` inside a sentence is never a folio. The caller still has to
 * check the block sits in a page band; the text alone is not enough.
 */
export function pageNumberPattern(text: string): PageNumberPatternKind | null {
  const line = singleLine(text);
  if (line === null || line.length > MAX_PAGE_NUMBER_CHARS) return null;
  if (LONE_PAGE_OF_TOTAL.test(line) || BARE_PAGE_OF_TOTAL.test(line)) return 'page-of-total';
  if (LONE_DASH_NUMBER.test(line)) return 'dash';
  if (LONE_ARABIC_NUMBER.test(line)) return 'arabic';
  if (LONE_PAGE_LABEL.test(line)) return 'page-label';
  if (isRomanNumeral(line)) return 'roman';
  return null;
}

/**
 * Classifies every block of a document.
 *
 * The pages are read in ascending page order and each page's blocks in reading order, so
 * the result does not depend on the caller's array order. A page entry whose number
 * appears twice keeps its first occurrence. Empty input returns no blocks and a single
 * `no-pages` reason.
 */
export function detectFurniture(pages: readonly FurniturePageInput[]): FurnitureDetection {
  const readPages = readPageList(pages);
  const pageCount = readPages.length;
  const rows = readBlockRows(readPages);
  const requiredPages = repeatThreshold(pageCount);

  const groups = countGroups(rows);
  const repeatedTexts = new Set<string>();
  for (const [normalizedText, group] of groups) {
    if (group.pages.size >= requiredPages) repeatedTexts.add(normalizedText);
  }

  const classified: FurnitureBlock[] = [];
  const kindCounts = new Map<string, Map<FurnitureKind, number>>();
  const bandOnly: FurnitureReason[] = [];

  for (const row of rows) {
    const group = row.normalizedText.length > 0 ? groups.get(row.normalizedText) : undefined;
    const repetition: Repetition = {
      repeated: repeatedTexts.has(row.normalizedText),
      pagesInGroup: group?.pages.size ?? 1,
      pageCount,
    };
    const block = classifyRow(row, repetition);
    classified.push(block);
    if (group) bumpKind(kindCounts, row.normalizedText, block.kind);

    const bands = bandReading(row.rect, row.pageHeight);
    if (block.kind === 'content' && (bands.top || bands.bottom) && row.normalizedText.length > 0) {
      bandOnly.push({ code: 'band-only', page: block.page, blockId: block.id });
    }
  }

  const repeated = buildRepeatedGroups(groups, kindCounts, requiredPages, pageCount);
  const reasons = buildReasons(pageCount, rows.length, repeated, bandOnly);

  return { classified, repeated, reasons };
}

/**
 * Splits a classified document into the block ids to skip and the page numbers to keep.
 *
 * Headers, footers and watermarks are always skipped: copying a running head onto every
 * output page is exactly the duplication this module exists to prevent. Page numbers are
 * skipped too unless {@link FurnitureExclusionOptions.keepPageNumbers} is on (the
 * default), in which case they are listed in `pageNumbers` so the exporter can re-emit
 * each one on its output page. Content is never returned.
 *
 * Accepts either the whole detection or its bare `classified` array.
 */
export function excludeFromTranslation(
  classified: FurnitureClassification,
  options: FurnitureExclusionOptions = {},
): FurnitureExclusion {
  const rows = rowsOf(classified);
  const keepPageNumbers = options?.keepPageNumbers !== false;
  const skip: string[] = [];
  const pageNumbers: PageNumberSlot[] = [];
  const skipped = new Set<FurnitureKind>();

  for (const row of rows) {
    if (!isFurnitureKind(row?.kind)) continue;
    if (row.kind === 'content') continue;

    if (row.kind === 'page-number' && keepPageNumbers) {
      pageNumbers.push({ page: row.page, blockId: row.id, text: foldText(row.text) });
      continue;
    }
    skip.push(row.id);
    skipped.add(row.kind);
  }

  return {
    skip,
    pageNumbers,
    skippedKinds: EXCLUDABLE_KINDS.filter(kind => skipped.has(kind)),
    pageNumberPolicy: keepPageNumbers ? 'reemit' : 'skip',
  };
}

/**
 * Summarises a classified document for an audit line.
 *
 * Every kind is counted, zero included, and `line` is a locale-independent string
 * suitable for a log or a QA report. Accepts either the whole detection or its bare
 * `classified` array.
 */
export function reportFurniture(classified: FurnitureClassification): FurnitureReport {
  const rows = rowsOf(classified);
  const counts: Record<FurnitureKind, number> = {
    header: 0,
    footer: 0,
    'page-number': 0,
    watermark: 0,
    content: 0,
  };
  let total = 0;

  for (const row of rows) {
    if (!isFurnitureKind(row?.kind)) continue;
    counts[row.kind] += 1;
    total += 1;
  }

  const line = [
    'furniture',
    ...FURNITURE_KINDS.map(kind => `${kind}=${counts[kind]}`),
    `total=${total}`,
  ].join(' ');

  return { counts, total, furniture: total - counts.content, line };
}

/** True for every kind that is furniture rather than document content. */
export function isFurniture(kind: FurnitureKind): boolean {
  return kind !== 'content';
}

// --- Reading the input -----------------------------------------------------

function readPageList(pages: readonly FurniturePageInput[]): ReadPage[] {
  const items = Array.isArray(pages) ? pages : [];
  const byNumber = new Map<number, ReadPage>();

  items.forEach((page, index) => {
    const record = page as FurniturePageInput | undefined;
    const number = pageNumberOf(record?.number, index + 1);
    if (byNumber.has(number)) return;

    const blocks = Array.isArray(record?.blocks) ? record.blocks : [];
    const size = pageSize(record, blocks);
    byNumber.set(number, { number, width: size.width, height: size.height, blocks });
  });

  return [...byNumber.values()].sort((left, right) => left.number - right.number);
}

/**
 * Reads a page's size, falling back to the union of its blocks and finally to a US Letter
 * page, so a page that never reported a size still has bands instead of dividing by zero.
 */
function pageSize(page: FurniturePageInput | undefined, blocks: readonly FurnitureBlockInput[]): { width: number; height: number } {
  let right = 0;
  let bottom = 0;
  for (const block of blocks) {
    const rect = readRect(block?.rect);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return {
    width: positiveOr(page?.width, right > 0 ? Math.ceil(right) : DEFAULT_PAGE_WIDTH),
    height: positiveOr(page?.height, bottom > 0 ? Math.ceil(bottom) : DEFAULT_PAGE_HEIGHT),
  };
}

function readBlockRows(pages: readonly ReadPage[]): WorkingBlock[] {
  const rows: WorkingBlock[] = [];
  for (const page of pages) {
    const pageBlocks = page.blocks.map((block, index) => toWorkingBlock(block, page, index));
    pageBlocks.sort(compareRows);
    rows.push(...pageBlocks);
  }

  // Synthetic ids are assigned after sorting, so they do not depend on the order the
  // caller listed the blocks in.
  let synthetic = 0;
  for (const row of rows) {
    if (row.id.length > 0) continue;
    row.id = `${SYNTHETIC_BLOCK_ID_PREFIX}${synthetic}`;
    synthetic += 1;
  }
  return rows;
}

function toWorkingBlock(block: FurnitureBlockInput | undefined, page: ReadPage, index: number): WorkingBlock {
  const source = block as FurnitureBlockInput | undefined;
  const rawId = source?.id;
  return {
    id: typeof rawId === 'string' && rawId.length > 0 ? rawId : '',
    page: page.number,
    pageHeight: page.height,
    text: typeof source?.text === 'string' ? source.text : '',
    normalizedText: normalizeText(source?.text),
    rect: readRect(source?.rect),
    rotation: normalizeRotation(source?.rotation),
    inputIndex: index,
  };
}

/** Reading order within one page; the 0.5 pt row bucket matches `classifyBlocks`. */
function compareRows(left: WorkingBlock, right: WorkingBlock): number {
  const leftRow = Math.round(left.rect.y * 2) / 2;
  const rightRow = Math.round(right.rect.y * 2) / 2;
  if (leftRow !== rightRow) return leftRow - rightRow;
  if (left.rect.x !== right.rect.x) return left.rect.x - right.rect.x;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return left.inputIndex - right.inputIndex;
}

function countGroups(rows: readonly WorkingBlock[]): Map<string, GroupAccumulator> {
  const groups = new Map<string, GroupAccumulator>();
  for (const row of rows) {
    if (row.normalizedText.length === 0) continue;
    let group = groups.get(row.normalizedText);
    if (!group) {
      group = { pages: new Set<number>(), blockIds: [], texts: new Map<string, number>() };
      groups.set(row.normalizedText, group);
    }
    group.pages.add(row.page);
    group.blockIds.push(row.id);
    const text = foldText(row.text);
    group.texts.set(text, (group.texts.get(text) ?? 0) + 1);
  }
  return groups;
}

function bumpKind(kinds: Map<string, Map<FurnitureKind, number>>, normalizedText: string, kind: FurnitureKind): void {
  let counts = kinds.get(normalizedText);
  if (!counts) {
    counts = new Map<FurnitureKind, number>();
    kinds.set(normalizedText, counts);
  }
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}

// --- Classification --------------------------------------------------------

function classifyRow(row: WorkingBlock, repetition: Repetition): FurnitureBlock {
  const text = foldText(row.text);
  if (text.length === 0) {
    return toBlock(row, 'content', EMPTY_CONFIDENCE, ['content:empty-text'], repetition);
  }

  const bands = bandReading(row.rect, row.pageHeight);
  const bandEvidence = bandReasons(bands);

  // Rotation first: a deliberate diagonal is the strongest signal on the page, and a
  // watermark is not a running head even when it sits in the top band.
  const oblique = obliqueDegrees(row.rotation);
  if (oblique >= WATERMARK_MIN_OBLIQUE_DEGREES) {
    const confidence = WATERMARK_BASE_CONFIDENCE + (repetition.repeated ? WATERMARK_SHARED_BONUS : 0);
    return toBlock(
      row,
      'watermark',
      confidence,
      [`watermark:rotation=${fmt(row.rotation)}`, `watermark:oblique=${fmt(oblique)}`],
      repetition,
    );
  }

  // A lone number only counts as a folio inside a band; in the middle of the page it is a
  // list number or a table value.
  const pattern = pageNumberPattern(text);
  if (pattern !== null && (bands.top || bands.bottom)) {
    return toBlock(
      row,
      'page-number',
      PAGE_NUMBER_CONFIDENCE[pattern],
      [`page-number:pattern=${pattern}`, ...bandEvidence],
      repetition,
    );
  }

  const tall = row.rect.height > row.pageHeight * TALL_BAND_BLOCK_SHARE;
  if (repetition.repeated && (bands.top || bands.bottom)) {
    const kind: FurnitureKind = bands.top ? 'header' : 'footer';
    const confidence = clamp01(
      BAND_BASE_CONFIDENCE + REPETITION_WEIGHT * pageShare(repetition) - (tall ? TALL_BAND_PENALTY : 0),
    );
    const reasons = [...bandEvidence];
    if (tall) reasons.push(`band:tall=${fmt(row.rect.height / row.pageHeight)}`);
    return toBlock(row, kind, confidence, reasons, repetition);
  }

  if (bands.top || bands.bottom) {
    return toBlock(row, 'content', BAND_ONLY_CONFIDENCE, ['content:band-only', ...bandEvidence], repetition);
  }
  return toBlock(row, 'content', CONTENT_CONFIDENCE, ['content:outside-bands'], repetition);
}

function toBlock(
  row: WorkingBlock,
  kind: FurnitureKind,
  confidence: number,
  reasons: string[],
  repetition: Repetition,
): FurnitureBlock {
  const evidence = [...reasons];
  if (row.normalizedText.length > 0) {
    evidence.push(`shared-pages=${repetition.pagesInGroup}/${repetition.pageCount}`);
  }
  return {
    id: row.id,
    page: row.page,
    kind,
    text: row.text,
    rect: { ...row.rect },
    normalizedText: row.normalizedText,
    rotation: row.rotation,
    confidence: round4(clamp01(confidence)),
    reasons: evidence,
  };
}

function bandReading(rect: Rect, pageHeight: number): BandReading {
  const height = pageHeight > 0 ? pageHeight : DEFAULT_PAGE_HEIGHT;
  const topEdge = rect.y / height;
  const bottomEdge = (rect.y + rect.height) / height;
  return {
    top: topEdge <= TOP_BAND_SHARE,
    bottom: bottomEdge >= 1 - BOTTOM_BAND_SHARE,
    topEdge,
    bottomEdge,
  };
}

function bandReasons(bands: BandReading): string[] {
  const reasons: string[] = [];
  if (bands.top) reasons.push(`band:top=${fmt(bands.topEdge)}`);
  if (bands.bottom) reasons.push(`band:bottom=${fmt(bands.bottomEdge)}`);
  return reasons;
}

function pageShare(repetition: Repetition): number {
  return repetition.pageCount > 0 ? clamp01(repetition.pagesInGroup / repetition.pageCount) : 0;
}

function repeatThreshold(pageCount: number): number {
  return Math.max(MIN_REPEAT_PAGES, Math.ceil(pageCount * REPEAT_MIN_PAGE_SHARE - SHARE_EPSILON));
}

// --- Repetition and audit notes -------------------------------------------

function buildRepeatedGroups(
  groups: ReadonlyMap<string, GroupAccumulator>,
  kinds: ReadonlyMap<string, ReadonlyMap<FurnitureKind, number>>,
  requiredPages: number,
  pageCount: number,
): RepeatedGroup[] {
  const repeated: RepeatedGroup[] = [];

  for (const [normalizedText, group] of groups) {
    if (group.pages.size < requiredPages) continue;
    const pages = [...group.pages].sort((left, right) => left - right);
    repeated.push({
      normalizedText,
      text: commonestText(group.texts),
      kind: dominantKind(kinds.get(normalizedText)),
      pages,
      blockIds: [...group.blockIds],
      share: pageCount > 0 ? round4(pages.length / pageCount) : 0,
    });
  }

  repeated.sort((left, right) => right.pages.length - left.pages.length || compareText(left.normalizedText, right.normalizedText));
  return repeated;
}

function buildReasons(
  pageCount: number,
  blockCount: number,
  repeated: readonly RepeatedGroup[],
  bandOnly: readonly FurnitureReason[],
): FurnitureReason[] {
  const reasons: FurnitureReason[] = [];
  if (pageCount === 0) {
    reasons.push({ code: 'no-pages', page: null, blockId: null });
    return reasons;
  }
  if (blockCount === 0) {
    reasons.push({ code: 'no-blocks', page: null, blockId: null });
    return reasons;
  }

  for (const group of repeated) {
    reasons.push({
      code: isFurniture(group.kind) ? 'repeated-furniture' : 'repeated-content',
      page: group.pages[0] ?? null,
      blockId: group.blockIds[0] ?? null,
      share: group.share,
      normalizedText: group.normalizedText,
    });
  }
  reasons.push(...bandOnly);
  return reasons;
}

function commonestText(texts: ReadonlyMap<string, number>): string {
  const entries = [...texts.entries()].sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]));
  return entries[0]?.[0] ?? '';
}

function dominantKind(counts: ReadonlyMap<FurnitureKind, number> | undefined): FurnitureKind {
  if (!counts) return 'content';
  let best: FurnitureKind = 'content';
  let bestCount = -1;
  for (const kind of KIND_PRIORITY) {
    const count = counts.get(kind) ?? 0;
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

// --- Small helpers ---------------------------------------------------------

function rowsOf(classified: FurnitureClassification | undefined): readonly FurnitureBlock[] {
  if (!classified) return [];
  if (isDetection(classified)) return classified.classified;
  return Array.isArray(classified) ? classified : [];
}

function isDetection(value: FurnitureClassification): value is FurnitureDetection {
  return !Array.isArray(value) && Array.isArray((value as FurnitureDetection).classified);
}

function isFurnitureKind(value: unknown): value is FurnitureKind {
  return typeof value === 'string' && (FURNITURE_KINDS as readonly string[]).includes(value);
}

/** Folds whitespace, case and every digit run to `#`; the key the repetition test uses. */
function normalizeText(text: unknown): string {
  const folded = foldText(text);
  return folded.toLowerCase().replace(/\d+/gu, '#');
}

function foldText(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
}

/** The single non-empty line of a block, or `null` when the text is multi-line. */
function singleLine(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const lines = text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0);
  return lines.length === 1 ? (lines[0] ?? null) : null;
}

/**
 * True for a well-formed Roman numeral, all upper- or all lower-case.
 *
 * Mixed case (`Mix`) is rejected, and the numeral has to fit the canonical subtractive
 * grammar, so `Chapter 3` never reaches here and most words do not either.
 */
function isRomanNumeral(text: string): boolean {
  if (text.length === 0 || text.length > MAX_ROMAN_CHARS) return false;
  if (text !== text.toUpperCase() && text !== text.toLowerCase()) return false;
  return ROMAN_NUMERAL.test(text.toUpperCase());
}

function readRect(value: unknown): Rect {
  const rect = value as Rect | undefined;
  return {
    x: finiteOr(rect?.x, 0),
    y: finiteOr(rect?.y, 0),
    width: Math.max(0, finiteOr(rect?.width, 0)),
    height: Math.max(0, finiteOr(rect?.height, 0)),
  };
}

function normalizeRotation(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}

/** Distance from the nearest quarter turn, in degrees: 45 for a diagonal label, 4 for skew. */
function obliqueDegrees(rotation: number): number {
  const quarter = rotation % 90;
  return Math.min(quarter, 90 - quarter);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function pageNumberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Two decimals, locale-independent, so reason strings are stable across machines. */
function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
