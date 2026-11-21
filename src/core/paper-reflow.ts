/**
 * Clean single-column reading mode for academic papers (backlog item J08).
 *
 * Academic PDFs are laid out for two-column print: interleaved columns, running
 * headers and footers, floating captions, footnotes tucked into page bottoms,
 * and display equations mixed with prose. This module turns a {@link DocumentIR}
 * into a clean, single-column reflow stream ({@link ReflowPaperDocument}) that:
 *
 * - derives multi-column reading order via `reading-order.ts` and strips
 *   repeated headers/footers without dropping real headings or footnotes;
 * - keeps the section hierarchy via `outline.ts` and academic heading levels;
 * - preserves inline & display LaTeX formulas (`$...$`, `$$...$$`, numbered
 *   equations) via `formulas.ts`;
 * - binds figure and table captions to their targets via `captions.ts`;
 * - preserves footnote definitions and in-text anchor links without splitting
 *   paragraphs across page breaks;
 * - preserves numeric (`[1]`, `[1, 2]`) and author-year (`(Smith, 2024)`)
 *   citation markers;
 * - emits clean standalone HTML and Markdown views; and
 * - maintains a deterministic bidirectional lookup (`reflowId <-> { page, blockId, rect }`).
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no I/O, no locale.
 *   Shuffling `ir.blocks` or `ir.pages` produces an identical document.
 * - Coordinates use page points with top-left origin, matching `DocumentIR`.
 */

import { MAX_HEADING_LEVEL, type HeadingLevel, type SemanticBlockType } from './blocks';
import { linkCaptions, type CaptionInputBlock, type CaptionKind } from './captions';
import { segmentText, toLatex, type Segment } from './formulas';
import type { Block, BlockType, DocumentIR, Page, Point, Polygon } from './ir';
import { extractLinks, FOOTNOTE_PAGE_REACH, type Link, type LinkInputBlock } from './links';
import { buildOutline, type OutlineBlockInput, type Section, type TocEntry } from './outline';
import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  FOOTER_BAND_SHARE,
  HEADER_BAND_SHARE,
  orderBlocks,
  orderDocument,
  REPEATED_HEADER_REASON,
  REPEAT_PAGE_SHARE,
  SPANNING_WIDTH_RATIO,
  stripRepeats,
  type OrderedBlock,
  type PageBox,
  type ReadingColumn,
  type ReadingOrderBlock,
  type ReadingOrderPage,
} from './reading-order';
import type { Rect } from './types';

// --- Public types ----------------------------------------------------------

export type ReflowBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'formula'
  | 'figure'
  | 'table';

export type ReflowSegmentKind =
  | 'text'
  | 'inline-math'
  | 'display-math'
  | 'citation'
  | 'footnote-ref'
  | 'equation-ref'
  | 'cross-ref';

export type CitationStyle = 'numeric' | 'author-year';

export interface SourceLocation {
  page: number;
  blockId: string;
  rect: Rect;
}

export interface ReflowSourceMapping extends SourceLocation {
  reflowId: string;
}

export interface ReflowLookupQuery {
  page?: number;
  blockId?: string;
  rect?: Rect;
  x?: number;
  y?: number;
}

export interface ReflowSegment {
  kind: ReflowSegmentKind;
  value: string;
  latex?: string;
  targetReflowId?: string;
  label?: string;
  citationStyle?: CitationStyle;
  citationKeys?: string[];
}

export interface ReflowCaption {
  reflowId: string;
  kind: CaptionKind;
  number?: number;
  text: string;
  segments: ReflowSegment[];
  source: SourceLocation;
}

export interface ReflowFormulaDetail {
  latex: string;
  display: boolean;
  equationNumber?: string;
  equationNumberReflowId?: string;
  equationNumberSource?: SourceLocation;
}

export interface ReflowTableData {
  headers: string[];
  rows: string[][];
}

export interface ReflowBlock {
  reflowId: string;
  kind: ReflowBlockKind;
  /** 1-based position in the main reflow stream. */
  index: number;
  text: string;
  segments: ReflowSegment[];
  source: SourceLocation;
  headingLevel?: HeadingLevel;
  isTitle?: boolean;
  sectionId?: string;
  items?: string[];
  itemSegments?: ReflowSegment[][];
  formula?: ReflowFormulaDetail;
  caption?: ReflowCaption;
  table?: ReflowTableData;
}

export interface ReflowFootnote {
  reflowId: string;
  label: string;
  anchorId: string;
  text: string;
  segments: ReflowSegment[];
  source: SourceLocation;
  referencedBy: string[];
}

export interface ReflowCitation {
  marker: string;
  style: CitationStyle;
  keys: string[];
  reflowId: string;
  blockId: string;
  page: number;
  targetReflowId?: string;
}

export interface ReflowEquation {
  reflowId: string;
  latex: string;
  display: boolean;
  equationNumber?: string;
  source: SourceLocation;
}

export interface StrippedFurniture {
  blockId: string;
  page: number;
  rect: Rect;
  kind: 'header' | 'footer';
  text: string;
  reason: string;
}

export interface ReflowSectionNode {
  id: string;
  title: string;
  level: number;
  path: string;
  page: number;
  blockId: string;
  reflowId: string;
  children: ReflowSectionNode[];
}

export interface ReflowLookupIndex {
  byReflowId: Readonly<Record<string, SourceLocation>>;
  byBlockId: Readonly<Record<string, string>>;
  entries: readonly ReflowSourceMapping[];
}

export interface ReflowPaperDocument {
  documentId: string;
  revisionId: string;
  title: string;
  language: string;
  blocks: ReflowBlock[];
  sections: ReflowSectionNode[];
  footnotes: ReflowFootnote[];
  equations: ReflowEquation[];
  citations: ReflowCitation[];
  strippedFurniture: StrippedFurniture[];
  lookup: ReflowLookupIndex;
  html: string;
  markdown: string;
}

export interface ReflowPaperOptions {
  title?: string;
  lang?: string;
  stripRepeatedHeadersFooters?: boolean;
  minRepeatPageShare?: number;
  headerBand?: number;
  footerBand?: number;
  headingLevels?: Readonly<Record<string, HeadingLevel>>;
}

export interface ReflowHtmlOptions {
  standalone?: boolean;
  title?: string;
  lang?: string;
}

export interface ReflowMarkdownOptions {
  title?: string;
  includeBlockAnchors?: boolean;
}

// --- Constants & patterns --------------------------------------------------

const EPSILON = 1e-6;
const REFLOW_ID_PREFIX = 'reflow-';
const FOOTNOTE_REFLOW_PREFIX = 'reflow-fn-';

const CAPTION_LABEL_PREFIX = /^\s*(Figure|Fig\.?|Table|Algorithm|Hình|Bảng)\s*(?:số\s*)?(\d{1,4})(?!\d)/iu;
const CAPTION_STRICT_PUNCT = /^\s*(?:Figure|Fig\.?|Table|Algorithm|Hình|Bảng)\s*(?:số\s*)?\d{1,4}(?:\s*[.:—–-]|\s*$)/iu;

const EQUATION_TAG_ONLY = /^\((\d{1,3}(?:\.\d{1,3})*|[A-Z]\.\d{1,3}|[A-Z]\d{1,3})\)$/u;
const EQUATION_TRAILING_TAG = /^(.*?)\s+\((\d{1,3}(?:\.\d{1,3})*|[A-Z]\.\d{1,3}|[A-Z]\d{1,3})\)\s*$/u;
const EQUATION_DELIM_TRAILING_TAG = /^(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\])\s*\((\d{1,3}(?:\.\d{1,3})*|[A-Z]\.\d{1,3}|[A-Z]\d{1,3})\)\s*$/u;
const EQUATION_LEADING_TAG = /^\((\d{1,3}(?:\.\d{1,3})*|[A-Z]\.\d{1,3}|[A-Z]\d{1,3})\)\s+(.+)$/u;
const LATEX_TAG_COMMAND = /\\tag\{([^{}]+)\}/gu;
const TRAILING_MATH_OPERATOR = /[=+×÷±∓−*·⋅∗/^_([{,<≤≥∑∏∫√]$/u;
const LEADING_MATH_OPERATOR = /^[=+×÷±∓−*·⋅∗/^_),\]}>≤≥]/u;

const STANDALONE_DISPLAY_DOLLAR = /^\$\$([\s\S]+?)\$\$$/u;
const STANDALONE_DISPLAY_BRACKET = /^\\\[([\s\S]+?)\\\]$/u;

const NUMBERED_HEADING_PREFIX = /^(\d{1,3}(?:\.\d{1,3})*)\.?(?:\s+|$)/u;
const APPENDIX_HEADING_PREFIX = /^(?:Appendix\s+)?([A-Z])(?:\.(\d{1,3}(?:\.\d{1,3})*))?\.?(?:\s+|$)/u;
const ROMAN_HEADING_PREFIX = /^(?:[IVXLC]{1,6})\.\s+/u;

const TOP_LEVEL_PAPER_SECTIONS = new Set([
  'abstract',
  'introduction',
  'related work',
  'background',
  'methodology',
  'methods',
  'method',
  'experiments',
  'evaluation',
  'results',
  'discussion',
  'conclusion',
  'conclusions',
  'acknowledgments',
  'acknowledgements',
  'references',
  'bibliography',
  'works cited',
  'appendix',
]);

const REFERENCE_SECTION_TITLES = new Set([
  'references',
  'bibliography',
  'works cited',
  'literature cited',
]);

const NON_AUTHOR_WORDS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'figure', 'fig', 'table',
  'section', 'sec', 'chapter', 'ch', 'equation', 'eq', 'algorithm', 'theorem',
  'lemma', 'proposition', 'corollary', 'page', 'vol', 'no', 'in', 'on', 'at',
  'by', 'for', 'since', 'from', 'during', 'before', 'after', 'until', 'between',
  'circa', 'year', 'years', 'copyright',
]);

const NO_FOOTNOTE_ABBREVIATIONS = new Set([
  'fig', 'figs', 'eq', 'eqs', 'tab', 'sec', 'ch', 'vol', 'no', 'nos', 'p', 'pp', 'e.g', 'i.e',
]);

const SUPERSCRIPT_DIGITS: Readonly<Record<string, string>> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
};

const FOOTNOTE_LEADING_MARKER = /^\s*(?:\[(\^?\d{1,3})\]|\((\d{1,3})\)|\^(\d{1,3})|(\d{1,3})(?:[.:)\]]|\s+)|([*†‡])(?:\s+|$))/u;
const REFERENCE_LEADING_NUMBER = /^\s*(?:\[(\d{1,4})\]|(\d{1,4})\.)\s+/u;
const LIST_ITEM_PREFIX = /^\s*(?:[-•▪◦‣∙·*]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+/u;
const ORDERED_LIST_PREFIX = /^\s*\(?\d{1,3}[.)]\s+/u;

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// --- Internal working types ------------------------------------------------

interface WorkingOrderBlock extends ReadingOrderBlock {
  irBlock: Block;
  page: number;
  pageHeight: number;
  isCaptionCandidate: boolean;
}

interface WorkingCaption {
  irBlock: Block;
  rect: Rect;
  kind: CaptionKind;
  number?: number;
  text: string;
}

interface WorkingFootnote {
  reflowId: string;
  label: string;
  anchorId: string;
  rawBody: string;
  irBlock: Block;
  rect: Rect;
  referencedBy: Set<string>;
}

interface WorkingEquationTag {
  irBlock: Block;
  rect: Rect;
  number: string;
}

interface RawInlineSpan {
  start: number;
  end: number;
  priority: number;
  segment: ReflowSegment;
  footnoteRef?: WorkingFootnote;
  citation?: { style: CitationStyle; keys: string[]; targetReflowId?: string };
}

interface ReflowSlot {
  reflowId: string;
  irBlock: Block;
  rect: Rect;
  kind: ReflowBlockKind;
  headingLevel?: HeadingLevel;
  isTitle?: boolean;
  caption?: WorkingCaption;
  eqTag?: WorkingEquationTag;
  formulaRaw?: { latex: string; equationNumber?: string };
  table?: ReflowTableData;
}

// --- Public Entry Point ----------------------------------------------------

/**
 * Converts a multi-column academic paper {@link DocumentIR} into a clean
 * single-column reflow document with preserved formulas, footnotes, bound
 * captions, citations, HTML/Markdown views, and bidirectional coordinate lookup.
 */
export function reflowPaper(
  ir: DocumentIR,
  options: ReflowPaperOptions = {},
): ReflowPaperDocument {
  if (typeof ir !== 'object' || ir === null) {
    throw new TypeError('reflowPaper needs a DocumentIR object.');
  }

  const documentId = typeof ir.documentId === 'string' && ir.documentId.length > 0 ? ir.documentId : 'doc';
  const revisionId = typeof ir.revisionId === 'string' && ir.revisionId.length > 0 ? ir.revisionId : 'rev-1';
  const language = nonEmpty(options.lang) ?? (nonEmpty(ir.language) && ir.language !== 'und' ? ir.language : 'en');
  const rawBlocks = Array.isArray(ir.blocks) ? ir.blocks.filter(isValidBlock) : [];
  const pageDims = buildPageDimensions(ir.pages, rawBlocks);

  if (rawBlocks.length === 0) {
    const emptyDoc: ReflowPaperDocument = {
      documentId,
      revisionId,
      title: nonEmpty(options.title) ?? '',
      language,
      blocks: [],
      sections: [],
      footnotes: [],
      equations: [],
      citations: [],
      strippedFurniture: [],
      lookup: { byReflowId: {}, byBlockId: {}, entries: [] },
      html: '',
      markdown: '',
    };
    emptyDoc.markdown = toReflowMarkdown(emptyDoc);
    emptyDoc.html = toReflowHtml(emptyDoc);
    return emptyDoc;
  }

  // 1. Order pages & columns, then strip repeated running headers/footers.
  const orderedDoc = orderIrDocument(rawBlocks, pageDims);
  const stripEnabled = options.stripRepeatedHeadersFooters !== false;
  const { keptOrdered, strippedFurniture } = stripEnabled
    ? stripRunningFurniture(orderedDoc.ordered, options)
    : { keptOrdered: orderedDoc.ordered, strippedFurniture: [] as StrippedFurniture[] };

  // 2. Re-order each page cleanly after removing headers/footers, handling
  //    pages where wide spanning blocks exceed reading-order.ts's 40% share.
  const orderedAfterStrip = reorderSurvivingPages(keptOrdered, pageDims);

  // 3. Separate footnotes from main stream (keeping reading order).
  const mainWorking: WorkingOrderBlock[] = [];
  const footnoteBlocks: WorkingOrderBlock[] = [];
  for (const item of orderedAfterStrip) {
    if (item.irBlock.type === 'footnote') {
      footnoteBlocks.push(item);
    } else {
      mainWorking.push(item);
    }
  }

  // 4. Bind figure/table captions via captions.ts + explicit children.
  const { boundCaptions, consumedCaptionIds } = bindCaptions(mainWorking, pageDims);

  // 5. Merge adjacent equation number tags `(1)` into neighboring formula blocks.
  const { mergedTags, consumedTagIds } = bindEquationTags(mainWorking, consumedCaptionIds, pageDims);

  // 6. Build main stream slots & classify headings/formulas/tables.
  const mainItems = mainWorking.filter(
    item => !consumedCaptionIds.has(item.id) && !consumedTagIds.has(item.id),
  );
  const headingDecisions = assignPaperHeadingLevels(mainItems, options);
  const slots = buildReflowSlots(mainItems, boundCaptions, mergedTags, headingDecisions);

  // 7. Build footnote structures & unique anchor ids.
  const footnotes = buildFootnotes(footnoteBlocks);

  // 8. Build section tree (outline.ts) and map each block to its section.
  const { sectionTree, sectionByBlockId, referenceBlockIds } = buildSectionHierarchy(
    slots,
    headingDecisions,
  );

  // 9. Build bidirectional lookup table covering blocks, captions, tags, footnotes.
  const { lookup, byBlockIdMut } = buildLookupIndex(slots, footnotes);

  // 10. Build resolution tables for footnotes, equations, figures/tables, bibliography.
  const equationByNumber = buildEquationIndex(slots);
  const sectionByNumberPrefix = buildSectionNumberIndex(slots);
  const { bibByNumber, bibNumbers, bibAuthorYears } = buildBibliographyIndex(
    slots,
    referenceBlockIds,
  );
  const captionTargetLinks = buildCaptionCrossRefIndex(slots, footnotes);

  // 11. Segment inline text, resolve references & citations, assemble blocks.
  const citations: ReflowCitation[] = [];
  const equations: ReflowEquation[] = [];
  const blocks: ReflowBlock[] = [];

  for (let idx = 0; idx < slots.length; idx += 1) {
    const slot = slots[idx];
    if (!slot) continue;
    const isRefEntry = referenceBlockIds.has(slot.irBlock.id);
    const block = materializeBlock(
      slot,
      idx + 1,
      sectionByBlockId.get(slot.irBlock.id),
      {
        footnotes,
        equationByNumber,
        sectionByNumberPrefix,
        bibByNumber,
        bibNumbers,
        bibAuthorYears,
        captionTargetLinks,
        byBlockIdMut,
        isRefEntry,
      },
      citations,
      equations,
    );
    blocks.push(block);
  }

  // Segment footnote bodies (may themselves contain inline math or citations).
  const materializedFootnotes = footnotes.map(fn =>
    materializeFootnote(fn, {
      footnotes,
      equationByNumber,
      sectionByNumberPrefix,
      bibByNumber,
      bibNumbers,
      bibAuthorYears,
      captionTargetLinks,
      byBlockIdMut,
      isRefEntry: false,
    }),
  );

  const detectedTitle =
    nonEmpty(options.title) ??
    blocks.find(b => b.kind === 'heading' && b.isTitle)?.text ??
    blocks.find(b => b.kind === 'heading')?.text ??
    '';

  const doc: ReflowPaperDocument = {
    documentId,
    revisionId,
    title: detectedTitle,
    language,
    blocks,
    sections: sectionTree,
    footnotes: materializedFootnotes,
    equations,
    citations,
    strippedFurniture,
    lookup,
    html: '',
    markdown: '',
  };

  doc.markdown = toReflowMarkdown(doc);
  doc.html = toReflowHtml(doc);
  return doc;
}

// --- Lookup Helpers --------------------------------------------------------

/**
 * Looks up the original PDF `{ page, blockId, rect }` coordinate for a `reflowId`.
 * Returns `null` when the `reflowId` does not exist in the reflowed document.
 */
export function resolveSourceLocation(
  doc: ReflowPaperDocument,
  reflowId: string,
): SourceLocation | null {
  if (typeof doc !== 'object' || doc === null || typeof reflowId !== 'string' || reflowId.length === 0) {
    return null;
  }
  const hit = doc.lookup?.byReflowId?.[reflowId];
  if (!hit) return null;
  return { page: hit.page, blockId: hit.blockId, rect: { ...hit.rect } };
}

/**
 * Resolves a source `blockId`, `{ page, blockId }`, `{ page, rect }`, or `{ page, x, y }`
 * query back to its deterministic `reflowId`, or `null` if stripped / not found.
 */
export function resolveReflowId(
  doc: ReflowPaperDocument,
  query: string | ReflowLookupQuery,
): string | null {
  if (typeof doc !== 'object' || doc === null || !doc.lookup) return null;

  if (typeof query === 'string') {
    if (query.length === 0) return null;
    return doc.lookup.byBlockId[query] ?? null;
  }

  if (typeof query !== 'object' || query === null) return null;

  if (typeof query.blockId === 'string' && query.blockId.length > 0) {
    const reflowId = doc.lookup.byBlockId[query.blockId];
    if (reflowId === undefined) return null;
    if (typeof query.page === 'number') {
      const loc = doc.lookup.byReflowId[reflowId];
      if (!loc || loc.page !== query.page) return null;
    }
    return reflowId;
  }

  const page = typeof query.page === 'number' && Number.isInteger(query.page) ? query.page : null;
  if (page === null) return null;

  const pageEntries = doc.lookup.entries.filter(entry => entry.page === page);
  if (pageEntries.length === 0) return null;

  if (query.rect) {
    return matchEntryByRect(pageEntries, query.rect);
  }

  if (typeof query.x === 'number' && Number.isFinite(query.x) && typeof query.y === 'number' && Number.isFinite(query.y)) {
    return matchEntryByPoint(pageEntries, query.x, query.y);
  }

  return null;
}

function matchEntryByRect(entries: readonly ReflowSourceMapping[], rect: Rect): string | null {
  const target = normalizeRect(rect);
  let bestId: string | null = null;
  let bestScore = -1;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    if (rectsNearlyEqual(entry.rect, target)) return entry.reflowId;
    const area = intersectionArea(entry.rect, target);
    if (area <= 0) continue;
    const union = rectArea(entry.rect) + rectArea(target) - area;
    const iou = union > 0 ? area / union : 0;
    const dist = centerDistanceSq(entry.rect, target);
    if (
      iou > bestScore + EPSILON ||
      (Math.abs(iou - bestScore) <= EPSILON && (dist < bestDist - EPSILON || (Math.abs(dist - bestDist) <= EPSILON && compareLex(entry.reflowId, bestId ?? '') < 0)))
    ) {
      bestScore = iou;
      bestDist = dist;
      bestId = entry.reflowId;
    }
  }
  return bestId;
}

function matchEntryByPoint(entries: readonly ReflowSourceMapping[], x: number, y: number): string | null {
  let bestId: string | null = null;
  let bestArea = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    const r = entry.rect;
    const inside = x >= r.x - EPSILON && x <= r.x + r.width + EPSILON && y >= r.y - EPSILON && y <= r.y + r.height + EPSILON;
    if (!inside) continue;
    const area = rectArea(r);
    if (area < bestArea - EPSILON || (Math.abs(area - bestArea) <= EPSILON && compareLex(entry.reflowId, bestId ?? '') < 0)) {
      bestArea = area;
      bestId = entry.reflowId;
    }
  }
  return bestId;
}

// --- Rendering: Markdown & HTML --------------------------------------------

/**
 * Emits clean single-column Markdown preserving LaTeX formulas (`$...$`, `$$...$$`),
 * bound figure/table captions, footnote anchors (`[^1]`) & definitions, and citation markers.
 */
export function toReflowMarkdown(
  doc: ReflowPaperDocument,
  options: ReflowMarkdownOptions = {},
): string {
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const footnotes = Array.isArray(doc?.footnotes) ? doc.footnotes : [];
  const explicitTitle = nonEmpty(options.title);
  const includeAnchors = options.includeBlockAnchors === true;

  if (blocks.length === 0 && footnotes.length === 0) {
    return explicitTitle ? `# ${explicitTitle}\n` : '';
  }

  const hasTitleBlock = blocks.some(b => b.kind === 'heading' && b.isTitle === true);
  const footnoteByReflowId = new Map<string, ReflowFootnote>(footnotes.map(fn => [fn.reflowId, fn]));
  const markdownKeyByFnReflow = buildMarkdownFootnoteKeys(footnotes);
  const chunks: string[] = [];

  if (explicitTitle && !hasTitleBlock) {
    chunks.push(`# ${explicitTitle}`);
  }

  for (const block of blocks) {
    const anchor = includeAnchors ? `<a id="${escapeHtml(block.reflowId)}"></a>\n\n` : '';
    const rendered = renderMarkdownBlock(block, hasTitleBlock, explicitTitle, footnoteByReflowId, markdownKeyByFnReflow);
    if (rendered.length > 0) chunks.push(`${anchor}${rendered}`);
  }

  if (footnotes.length > 0) {
    const fnLines = footnotes.map(fn => {
      const key = markdownKeyByFnReflow.get(fn.reflowId) ?? fn.label;
      const body = renderMarkdownSegments(fn.segments, footnoteByReflowId, markdownKeyByFnReflow);
      return `[^${key}]: ${body}`;
    });
    chunks.push(fnLines.join('\n'));
  }

  return chunks.length > 0 ? `${chunks.join('\n\n')}\n` : '';
}

function renderMarkdownBlock(
  block: ReflowBlock,
  hasTitleBlock: boolean,
  explicitTitle: string | undefined,
  footnoteByReflowId: ReadonlyMap<string, ReflowFootnote>,
  markdownKeyByFnReflow: ReadonlyMap<string, string>,
): string {
  switch (block.kind) {
    case 'heading': {
      const text = block.isTitle && explicitTitle
        ? explicitTitle
        : renderMarkdownSegments(block.segments, footnoteByReflowId, markdownKeyByFnReflow);
      const level = block.isTitle
        ? 1
        : Math.min(6, (block.headingLevel ?? 1) + (hasTitleBlock || explicitTitle ? 1 : 0));
      return `${'#'.repeat(level)} ${text}`;
    }
    case 'paragraph':
      return renderMarkdownSegments(block.segments, footnoteByReflowId, markdownKeyByFnReflow);
    case 'list': {
      const itemSegs = block.itemSegments ?? [];
      if (itemSegs.length === 0) {
        return renderMarkdownSegments(block.segments, footnoteByReflowId, markdownKeyByFnReflow);
      }
      const rawLines = (block.items ?? []).map((item, idx) => {
        const segs = itemSegs[idx];
        const rendered = segs ? renderMarkdownSegments(segs, footnoteByReflowId, markdownKeyByFnReflow) : item;
        const ordered = ORDERED_LIST_PREFIX.test(item);
        const body = rendered.replace(LIST_ITEM_PREFIX, '').trim();
        return ordered ? `${idx + 1}. ${body}` : `- ${body}`;
      });
      return rawLines.join('\n');
    }
    case 'formula': {
      const latex = block.formula?.latex ?? block.text;
      const eqNum = block.formula?.equationNumber;
      return eqNum ? `$$${latex}$$ (${eqNum})` : `$$${latex}$$`;
    }
    case 'figure': {
      const desc = renderMarkdownSegments(block.segments, footnoteByReflowId, markdownKeyByFnReflow);
      const cap = block.caption
        ? renderMarkdownSegments(block.caption.segments, footnoteByReflowId, markdownKeyByFnReflow)
        : '';
      const lines: string[] = [];
      lines.push(desc.length > 0 ? `> **[Figure]** ${desc}` : '> **[Figure]**');
      if (cap.length > 0) lines.push('>', `> *${cap}*`);
      return lines.join('\n');
    }
    case 'table': {
      const parts: string[] = [];
      if (block.caption) {
        parts.push(`*${renderMarkdownSegments(block.caption.segments, footnoteByReflowId, markdownKeyByFnReflow)}*`);
      }
      if (block.table && block.table.headers.length > 0) {
        const headers = block.table.headers.map(h => h.replace(/\|/gu, '\\|'));
        const divider = headers.map(() => '---');
        const rows = block.table.rows.map(
          row => `| ${headers.map((_, col) => (row[col] ?? '').replace(/\|/gu, '\\|')).join(' | ')} |`,
        );
        parts.push([`| ${headers.join(' | ')} |`, `| ${divider.join(' | ')} |`, ...rows].join('\n'));
      } else if (block.text.length > 0) {
        parts.push(block.text);
      }
      return parts.join('\n\n');
    }
  }
}

function renderMarkdownSegments(
  segments: readonly ReflowSegment[],
  footnoteByReflowId: ReadonlyMap<string, ReflowFootnote>,
  markdownKeyByFnReflow: ReadonlyMap<string, string>,
): string {
  let out = '';
  for (const seg of segments) {
    switch (seg.kind) {
      case 'inline-math':
        out += `$${seg.latex ?? seg.value}$`;
        break;
      case 'display-math':
        out += `\n\n$$${seg.latex ?? seg.value}$$\n\n`;
        break;
      case 'footnote-ref': {
        const key = seg.targetReflowId
          ? (markdownKeyByFnReflow.get(seg.targetReflowId) ?? footnoteByReflowId.get(seg.targetReflowId)?.label ?? seg.label ?? '1')
          : (seg.label ?? '1');
        out += `[^${key}]`;
        break;
      }
      default:
        out += seg.value;
        break;
    }
  }
  return out.replace(/\n{3,}/gu, '\n\n').trim();
}

const REFLOW_HTML_STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  max-width: 46rem;
  padding: 2.5rem 1.5rem 4rem;
  font-family: Georgia, "Noto Serif", Cambria, "Times New Roman", serif;
  font-size: 1.05rem;
  line-height: 1.7;
  color: #1f2328;
  background: #ffffff;
}
h1, h2, h3, h4 {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
  line-height: 1.3;
  margin-top: 1.6em;
  margin-bottom: 0.5em;
}
h1.paper-title { margin-top: 0; font-size: 1.75rem; }
p { margin: 0 0 1rem; }
.math-block {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin: 1.25rem 0;
  padding: 0.75rem 1rem;
  background: #f8f9fa;
  border-radius: 4px;
}
.math-block .math.display { flex: 1; text-align: center; }
.equation-number { color: #57606a; font-variant-numeric: tabular-nums; }
figure.reflow-figure {
  margin: 1.5rem 0;
  padding: 1rem;
  border: 1px solid #d8dee4;
  border-radius: 6px;
}
figcaption { margin-top: 0.75rem; font-size: 0.92rem; color: #424a53; }
table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; font-size: 0.94rem; }
th, td { border: 1px solid #d0d7de; padding: 0.45rem 0.65rem; text-align: left; }
th { background: #f6f8fa; font-weight: 600; }
cite.reflow-citation { font-style: normal; color: #0969da; }
sup.footnote-ref a { text-decoration: none; color: #0969da; }
section.footnotes {
  margin-top: 2.5rem;
  padding-top: 1rem;
  border-top: 1px solid #d0d7de;
  font-size: 0.9rem;
}
`.trim();

/**
 * Emits clean single-column HTML5 with semantic headings, math spans,
 * `<figure>`/`<figcaption>` bindings, `<cite>` markers, footnote anchors/backlinks,
 * and `data-reflow-id` / `data-source-*` attributes for bidirectional lookup.
 */
export function toReflowHtml(
  doc: ReflowPaperDocument,
  options: ReflowHtmlOptions = {},
): string {
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const footnotes = Array.isArray(doc?.footnotes) ? doc.footnotes : [];
  const lang = nonEmpty(options.lang) ?? (nonEmpty(doc?.language) || 'en');
  const explicitTitle = nonEmpty(options.title);
  const title = explicitTitle ?? (doc?.title ?? '');
  const hasTitleBlock = blocks.some(b => b.kind === 'heading' && b.isTitle === true);

  const footnoteByReflowId = new Map<string, ReflowFootnote>(footnotes.map(fn => [fn.reflowId, fn]));
  const backrefCounter = new Map<string, number>();

  const bodyParts: string[] = [];
  if (explicitTitle && !hasTitleBlock) {
    bodyParts.push(`<h1 class="paper-title">${escapeHtml(explicitTitle)}</h1>`);
  }

  for (const block of blocks) {
    bodyParts.push(renderHtmlBlock(block, hasTitleBlock || Boolean(explicitTitle), explicitTitle, footnoteByReflowId, backrefCounter));
  }

  if (footnotes.length > 0) {
    const items = footnotes.map(fn => {
      const rendered = renderHtmlSegments(fn.segments, footnoteByReflowId, backrefCounter);
      const firstCallerAnchor = fn.referencedBy.length > 0 ? `#fnref-${escapeHtml(fn.anchorId)}-1` : '';
      const backref = firstCallerAnchor
        ? ` <a href="${firstCallerAnchor}" class="footnote-backref" aria-label="Back to reference">↩</a>`
        : '';
      return `    <li id="${escapeHtml(fn.anchorId)}"${sourceAttrs(fn.reflowId, fn.source)}>${rendered}${backref}</li>`;
    });
    bodyParts.push(
      ['<section class="footnotes" aria-label="Footnotes">', '  <ol>', ...items, '  </ol>', '</section>'].join('\n'),
    );
  }

  const article = `<article class="reflow-paper">\n${bodyParts.join('\n')}\n</article>`;
  if (options.standalone === false) return article;

  return [
    '<!DOCTYPE html>',
    `<html lang="${escapeHtml(lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    REFLOW_HTML_STYLES,
    '</style>',
    '</head>',
    '<body>',
    article,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function renderHtmlBlock(
  block: ReflowBlock,
  hasTitleHeader: boolean,
  explicitTitle: string | undefined,
  footnoteByReflowId: ReadonlyMap<string, ReflowFootnote>,
  backrefCounter: Map<string, number>,
): string {
  const attrs = `id="${escapeHtml(block.reflowId)}"${sourceAttrs(block.reflowId, block.source)}`;
  switch (block.kind) {
    case 'heading': {
      const level = block.isTitle
        ? 1
        : Math.min(6, (block.headingLevel ?? 1) + (hasTitleHeader ? 1 : 0));
      const tag = `h${level}`;
      const cls = block.isTitle ? ' class="paper-title"' : '';
      const content = block.isTitle && explicitTitle
        ? escapeHtml(explicitTitle)
        : renderHtmlSegments(block.segments, footnoteByReflowId, backrefCounter);
      return `<${tag} ${attrs}${cls}>${content}</${tag}>`;
    }
    case 'paragraph':
      return `<p ${attrs}>${renderHtmlSegments(block.segments, footnoteByReflowId, backrefCounter)}</p>`;
    case 'list': {
      const items = block.items ?? [];
      const itemSegs = block.itemSegments ?? [];
      const ordered = items.length > 0 && items.every(item => ORDERED_LIST_PREFIX.test(item));
      const listTag = ordered ? 'ol' : 'ul';
      const li = items.map((item, idx) => {
        const segs = itemSegs[idx];
        const html = segs
          ? renderHtmlSegments(stripListPrefixFromSegments(segs), footnoteByReflowId, backrefCounter)
          : escapeHtml(item.replace(LIST_ITEM_PREFIX, '').trim());
        return `  <li>${html}</li>`;
      });
      return `<${listTag} ${attrs}>\n${li.join('\n')}\n</${listTag}>`;
    }
    case 'formula': {
      const latex = block.formula?.latex ?? block.text;
      const eqNum = block.formula?.equationNumber;
      const numSpan = eqNum
        ? `<span class="equation-number"${block.formula?.equationNumberReflowId ? ` data-reflow-id="${escapeHtml(block.formula.equationNumberReflowId)}"` : ''}>(${escapeHtml(eqNum)})</span>`
        : '';
      return `<div class="math-block" ${attrs}><span class="math display" data-latex="${escapeHtml(latex)}">$$${escapeHtml(latex)}$$</span>${numSpan}</div>`;
    }
    case 'figure': {
      const desc = renderHtmlSegments(block.segments, footnoteByReflowId, backrefCounter);
      const cap = block.caption
        ? `  <figcaption id="${escapeHtml(block.caption.reflowId)}"${sourceAttrs(block.caption.reflowId, block.caption.source)}>${renderHtmlSegments(block.caption.segments, footnoteByReflowId, backrefCounter)}</figcaption>`
        : '';
      const body = desc.length > 0 ? `  <div class="figure-placeholder">${desc}</div>` : '  <div class="figure-placeholder">Figure</div>';
      return ['<figure class="reflow-figure" ' + attrs + '>', body, cap, '</figure>']
        .filter(line => line.length > 0)
        .join('\n');
    }
    case 'table': {
      const cap = block.caption
        ? `  <figcaption id="${escapeHtml(block.caption.reflowId)}"${sourceAttrs(block.caption.reflowId, block.caption.source)}>${renderHtmlSegments(block.caption.segments, footnoteByReflowId, backrefCounter)}</figcaption>`
        : '';
      let tableHtml: string;
      if (block.table && block.table.headers.length > 0) {
        const ths = block.table.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
        const trs = block.table.rows
          .map(row => `    <tr>${block.table!.headers.map((_, col) => `<td>${escapeHtml(row[col] ?? '')}</td>`).join('')}</tr>`)
          .join('\n');
        tableHtml = [
          '  <table>',
          `    <thead><tr>${ths}</tr></thead>`,
          '    <tbody>',
          trs,
          '    </tbody>',
          '  </table>',
        ].join('\n');
      } else {
        tableHtml = `  <pre class="reflow-table-raw">${escapeHtml(block.text)}</pre>`;
      }
      return ['<figure class="reflow-figure reflow-table" ' + attrs + '>', cap, tableHtml, '</figure>']
        .filter(line => line.length > 0)
        .join('\n');
    }
  }
}

function renderHtmlSegments(
  segments: readonly ReflowSegment[],
  footnoteByReflowId: ReadonlyMap<string, ReflowFootnote>,
  backrefCounter: Map<string, number>,
): string {
  let out = '';
  for (const seg of segments) {
    switch (seg.kind) {
      case 'inline-math': {
        const latex = seg.latex ?? seg.value;
        out += `<span class="math inline" data-latex="${escapeHtml(latex)}">$${escapeHtml(latex)}$</span>`;
        break;
      }
      case 'display-math': {
        const latex = seg.latex ?? seg.value;
        out += `<span class="math display" data-latex="${escapeHtml(latex)}">$$${escapeHtml(latex)}$$</span>`;
        break;
      }
      case 'footnote-ref': {
        const target = seg.targetReflowId ? footnoteByReflowId.get(seg.targetReflowId) : undefined;
        const anchorId = target?.anchorId ?? `fn-${seg.label ?? '1'}`;
        const count = (backrefCounter.get(anchorId) ?? 0) + 1;
        backrefCounter.set(anchorId, count);
        const refId = `fnref-${anchorId}-${count}`;
        const label = target?.label ?? seg.label ?? '1';
        const targetAttr = seg.targetReflowId ? ` data-target-reflow-id="${escapeHtml(seg.targetReflowId)}"` : '';
        out += `<sup class="footnote-ref"><a id="${escapeHtml(refId)}" href="#${escapeHtml(anchorId)}"${targetAttr}>${escapeHtml(label)}</a></sup>`;
        break;
      }
      case 'citation': {
        const styleAttr = seg.citationStyle ? ` data-citation-style="${escapeHtml(seg.citationStyle)}"` : '';
        const targetAttr = seg.targetReflowId ? ` data-target-reflow-id="${escapeHtml(seg.targetReflowId)}"` : '';
        out += `<cite class="reflow-citation"${styleAttr}${targetAttr}>${escapeHtml(seg.value)}</cite>`;
        break;
      }
      case 'equation-ref': {
        if (seg.targetReflowId) {
          out += `<a class="equation-ref" href="#${escapeHtml(seg.targetReflowId)}" data-target-reflow-id="${escapeHtml(seg.targetReflowId)}">${escapeHtml(seg.value)}</a>`;
        } else {
          out += escapeHtml(seg.value);
        }
        break;
      }
      case 'cross-ref': {
        if (seg.targetReflowId) {
          out += `<a class="cross-ref" href="#${escapeHtml(seg.targetReflowId)}" data-target-reflow-id="${escapeHtml(seg.targetReflowId)}">${escapeHtml(seg.value)}</a>`;
        } else {
          out += escapeHtml(seg.value);
        }
        break;
      }
      default:
        out += escapeHtml(seg.value);
        break;
    }
  }
  return out;
}

function sourceAttrs(reflowId: string, source: SourceLocation): string {
  return ` data-reflow-id="${escapeHtml(reflowId)}" data-source-page="${source.page}" data-source-block-id="${escapeHtml(source.blockId)}"`;
}

// --- Stage helpers: Reading order & furniture stripping --------------------

function buildPageDimensions(
  pages: readonly Page[] | undefined,
  blocks: readonly Block[],
): Map<number, PageBox> {
  const dims = new Map<number, PageBox>();
  for (const page of Array.isArray(pages) ? pages : []) {
    if (!page || !Number.isInteger(page.index) || page.index < 1) continue;
    dims.set(page.index, {
      width: positiveOr(page.width, DEFAULT_PAGE_WIDTH),
      height: positiveOr(page.height, DEFAULT_PAGE_HEIGHT),
    });
  }
  for (const block of blocks) {
    if (dims.has(block.page)) continue;
    const rect = polygonToRect(block.polygon);
    dims.set(block.page, {
      width: Math.max(DEFAULT_PAGE_WIDTH, Math.ceil(rect.x + rect.width)),
      height: Math.max(DEFAULT_PAGE_HEIGHT, Math.ceil(rect.y + rect.height)),
    });
  }
  return dims;
}

function orderIrDocument(
  blocks: readonly Block[],
  pageDims: ReadonlyMap<number, PageBox>,
) {
  const byPage = new Map<number, WorkingOrderBlock[]>();
  for (const block of blocks) {
    const page = Number.isInteger(block.page) && block.page >= 1 ? block.page : 1;
    const boxDims = pageDims.get(page) ?? { width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT };
    const working: WorkingOrderBlock = {
      id: block.id,
      rect: polygonToRect(block.polygon),
      text: block.raw,
      irBlock: block,
      page,
      pageHeight: boxDims.height,
      isCaptionCandidate: isLikelyCaption(block),
    };
    const group = byPage.get(page);
    if (group) group.push(working);
    else byPage.set(page, [working]);
  }

  const pages: ReadingOrderPage<WorkingOrderBlock>[] = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, pageBlocks]) => {
      const boxDims = pageDims.get(page) ?? { width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT };
      return {
        page,
        width: boxDims.width,
        height: boxDims.height,
        blocks: pageBlocks,
      };
    });

  return orderDocument(pages);
}

function stripRunningFurniture(
  ordered: readonly OrderedBlock<WorkingOrderBlock>[],
  options: ReflowPaperOptions,
): { keptOrdered: OrderedBlock<WorkingOrderBlock>[]; strippedFurniture: StrippedFurniture[] } {
  // Semantic blocks (headings, footnotes, formulas, figures, tables, lists) must not be
  // stripped as running headers/footers; blanking their text for stripRepeats keeps page counts exact.
  const masked = ordered.map(entry => {
    const type = entry.block.irBlock.type;
    if (type === 'other' || type === 'paragraph') return entry;
    return { ...entry, block: { ...entry.block, text: '' } };
  });

  const stripOpts: {
    minPageShare?: number;
    headerBand?: number;
    footerBand?: number;
  } = {
    minPageShare: options.minRepeatPageShare ?? REPEAT_PAGE_SHARE,
    headerBand: options.headerBand ?? HEADER_BAND_SHARE,
    footerBand: options.footerBand ?? FOOTER_BAND_SHARE,
  };

  const result = stripRepeats(masked, stripOpts);
  const removedIds = new Set(result.removed.map(item => item.block.id));

  const keptOrdered: OrderedBlock<WorkingOrderBlock>[] = [];
  for (const entry of ordered) {
    if (!removedIds.has(entry.block.id)) keptOrdered.push(entry);
  }

  const strippedFurniture: StrippedFurniture[] = result.removed.map(item => ({
    blockId: item.block.id,
    page: item.page,
    rect: { ...item.block.rect },
    kind: item.reason === REPEATED_HEADER_REASON ? 'header' : 'footer',
    text: collapseSpaces(item.block.text),
    reason: item.reason,
  }));

  return { keptOrdered, strippedFurniture };
}

function reorderSurvivingPages(
  kept: readonly OrderedBlock<WorkingOrderBlock>[],
  pageDims: ReadonlyMap<number, PageBox>,
): WorkingOrderBlock[] {
  const byPage = new Map<number, WorkingOrderBlock[]>();
  for (const entry of kept) {
    const group = byPage.get(entry.page);
    if (group) group.push(entry.block);
    else byPage.set(entry.page, [entry.block]);
  }

  const orderedAll: WorkingOrderBlock[] = [];
  const pageNumbers = [...byPage.keys()].sort((a, b) => a - b);
  for (const page of pageNumbers) {
    const blocks = byPage.get(page) ?? [];
    const boxDims = pageDims.get(page) ?? { width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT };
    orderedAll.push(...orderPageWithSpanningFallback(blocks, boxDims));
  }
  return orderedAll;
}

interface PageColumnPartition {
  columns: ReadingColumn[];
  spanning: WorkingOrderBlock[];
  narrow: WorkingOrderBlock[];
  directOrdered: WorkingOrderBlock[];
  usedFallback: boolean;
}

function detectPageColumns(
  blocks: readonly WorkingOrderBlock[],
  pageBox: PageBox,
): PageColumnPartition {
  const initial = orderBlocks(blocks, pageBox);
  if (initial.columns.length >= 2 || blocks.length < 3) {
    return {
      columns: initial.columns,
      spanning: [],
      narrow: [...blocks],
      directOrdered: initial.ordered,
      usedFallback: false,
    };
  }

  const area = computeTextArea(blocks, pageBox.width);
  const spanningThreshold = SPANNING_WIDTH_RATIO * (area.right - area.left);
  const spanning: WorkingOrderBlock[] = [];
  const narrow: WorkingOrderBlock[] = [];

  for (const block of blocks) {
    if (spanningThreshold > 0 && block.rect.width + EPSILON >= spanningThreshold) {
      spanning.push(block);
    } else {
      narrow.push(block);
    }
  }

  if (spanning.length === 0 || narrow.length < 2) {
    return {
      columns: initial.columns,
      spanning: [],
      narrow: [...blocks],
      directOrdered: initial.ordered,
      usedFallback: false,
    };
  }

  const narrowLayout = orderBlocks(narrow, pageBox);
  if (narrowLayout.columns.length < 2 || !columnsOverlapVertically(narrowLayout.columns, narrow)) {
    return {
      columns: initial.columns,
      spanning: [],
      narrow: [...blocks],
      directOrdered: initial.ordered,
      usedFallback: false,
    };
  }

  return {
    columns: narrowLayout.columns,
    spanning,
    narrow,
    directOrdered: initial.ordered,
    usedFallback: true,
  };
}

/**
 * Uses `orderBlocks` directly; if spanning blocks (>80% width) exceed 40% of a page
 * and suppress multi-column detection (common on academic page 1 with Title + Authors + Abstract),
 * detects columns among the non-spanning blocks when those columns overlap vertically.
 */
function orderPageWithSpanningFallback(
  blocks: readonly WorkingOrderBlock[],
  pageBox: PageBox,
): WorkingOrderBlock[] {
  const partition = detectPageColumns(blocks, pageBox);
  if (!partition.usedFallback) return partition.directOrdered;

  // Sort spanning blocks top-to-bottom and slice narrow blocks into bands around them.
  const sortedSpans = [...partition.spanning].sort(compareBlockTopLeft);
  const columnOf = new Map<string, number>();
  partition.columns.forEach(col => {
    for (const id of col.blockIds) columnOf.set(id, col.index);
  });

  const bands: WorkingOrderBlock[][] = Array.from({ length: sortedSpans.length + 1 }, () => []);
  for (const item of partition.narrow) {
    const centerY = item.rect.y + item.rect.height / 2;
    let band = 0;
    for (const span of sortedSpans) {
      if (span.rect.y + span.rect.height / 2 < centerY) band += 1;
    }
    bands[band]?.push(item);
  }

  const result: WorkingOrderBlock[] = [];
  for (let bandIdx = 0; bandIdx < bands.length; bandIdx += 1) {
    const group = bands[bandIdx];
    if (group && group.length > 0) {
      group.sort((left, right) => {
        const colL = columnOf.get(left.id) ?? 0;
        const colR = columnOf.get(right.id) ?? 0;
        if (colL !== colR) return colL - colR;
        return compareBlockTopLeft(left, right);
      });
      result.push(...group);
    }
    const span = sortedSpans[bandIdx];
    if (span) result.push(span);
  }
  return result;
}

function columnsOverlapVertically(
  columns: readonly ReadingColumn[],
  blocks: readonly WorkingOrderBlock[],
): boolean {
  if (columns.length < 2) return false;
  const byId = new Map(blocks.map(b => [b.id, b]));
  const ranges = columns.map(col => {
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const id of col.blockIds) {
      const b = byId.get(id);
      if (!b) continue;
      minY = Math.min(minY, b.rect.y);
      maxY = Math.max(maxY, b.rect.y + b.rect.height);
    }
    return { minY, maxY };
  });

  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = i + 1; j < ranges.length; j += 1) {
      const a = ranges[i];
      const b = ranges[j];
      if (!a || !b || !Number.isFinite(a.minY) || !Number.isFinite(b.minY)) continue;
      if (Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > EPSILON) return true;
    }
  }
  return false;
}

// --- Stage helpers: Captions & equation tags -------------------------------

function bindCaptions(
  blocks: readonly WorkingOrderBlock[],
  pageDims: ReadonlyMap<number, PageBox>,
): { boundCaptions: Map<string, WorkingCaption>; consumedCaptionIds: Set<string> } {
  const boundCaptions = new Map<string, WorkingCaption>();
  const consumedCaptionIds = new Set<string>();
  const byId = new Map(blocks.map(b => [b.id, b]));

  // 1. Honor explicit IR children on figure/table blocks first when child is caption-like.
  for (const item of blocks) {
    const t = item.irBlock.type;
    if (t !== 'figure' && t !== 'table') continue;
    for (const childId of item.irBlock.children) {
      const child = byId.get(childId);
      if (!child || child.page !== item.page || consumedCaptionIds.has(child.id)) continue;
      if (child.irBlock.type !== 'other' && child.irBlock.type !== 'paragraph') continue;
      const parsed = parseCaptionLabel(child.text);
      boundCaptions.set(item.id, {
        irBlock: child.irBlock,
        rect: child.rect,
        kind: parsed?.kind ?? (t === 'table' ? 'table' : 'figure'),
        ...(parsed?.number !== undefined ? { number: parsed.number } : {}),
        text: collapseSpaces(child.text),
      });
      consumedCaptionIds.add(child.id);
      break;
    }
  }

  // 2. Delegate geometric/column-aware caption linking to captions.ts.
  const captionInput: CaptionInputBlock[] = [];
  for (const item of blocks) {
    if (consumedCaptionIds.has(item.id)) continue;
    const t = item.irBlock.type;
    if (t === 'figure' || t === 'table') {
      if (boundCaptions.has(item.id)) continue;
      captionInput.push({
        id: item.id,
        type: t,
        page: item.page,
        text: item.text,
        rect: item.rect,
        pageHeight: pageDims.get(item.page)?.height ?? DEFAULT_PAGE_HEIGHT,
      });
      continue;
    }
    if (item.isCaptionCandidate) {
      captionInput.push({
        id: item.id,
        type: 'caption',
        page: item.page,
        text: item.text,
        rect: item.rect,
        pageHeight: pageDims.get(item.page)?.height ?? DEFAULT_PAGE_HEIGHT,
      });
    }
  }

  const linked = linkCaptions(captionInput);
  for (const link of linked.links) {
    const cap = byId.get(link.captionId);
    const target = byId.get(link.targetId);
    if (!cap || !target || boundCaptions.has(target.id) || consumedCaptionIds.has(cap.id)) continue;
    const parsed = parseCaptionLabel(cap.text);
    boundCaptions.set(target.id, {
      irBlock: cap.irBlock,
      rect: cap.rect,
      kind: link.kind,
      ...(parsed?.number !== undefined ? { number: parsed.number } : {}),
      text: collapseSpaces(cap.text),
    });
    consumedCaptionIds.add(cap.id);
  }

  return { boundCaptions, consumedCaptionIds };
}

function bindEquationTags(
  blocks: readonly WorkingOrderBlock[],
  consumedCaptionIds: ReadonlySet<string>,
  pageDims: ReadonlyMap<number, PageBox>,
): { mergedTags: Map<string, WorkingEquationTag>; consumedTagIds: Set<string> } {
  const mergedTags = new Map<string, WorkingEquationTag>();
  const consumedTagIds = new Set<string>();

  const byPage = new Map<number, WorkingOrderBlock[]>();
  for (const b of blocks) {
    if (consumedCaptionIds.has(b.id)) continue;
    const list = byPage.get(b.page);
    if (list) list.push(b);
    else byPage.set(b.page, [b]);
  }

  for (const [pageNum, pageBlocks] of byPage.entries()) {
    const pageBox = pageDims.get(pageNum) ?? { width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT };
    const { columnOf, boundaries } = columnMembershipOfPage(pageBlocks, pageBox);

    for (const eq of pageBlocks) {
      if (!isStandaloneFormulaBlock(eq.irBlock)) continue;
      const own = extractFormulaBodyAndNumber(eq.text);
      if (own.equationNumber !== undefined) continue;

      const eqCol = columnOf.get(eq.id) ?? null;
      const eqStraddles = boundaries.some(
        boundary => eq.rect.x < boundary - EPSILON && eq.rect.x + eq.rect.width > boundary + EPSILON,
      );
      const eqCenterY = eq.rect.y + eq.rect.height / 2;
      const rowTol = Math.max(eq.rect.height * 0.8, 14);
      let candidate: { block: WorkingOrderBlock; number: string; gap: number } | null = null;

      for (const other of pageBlocks) {
        if (other.id === eq.id || consumedTagIds.has(other.id)) continue;
        if (other.irBlock.type !== 'other' && other.irBlock.type !== 'paragraph') continue;
        const match = EQUATION_TAG_ONLY.exec(collapseSpaces(other.text));
        const num = match?.[1];
        if (!num) continue;

        // If the page is multi-column and the formula sits inside one column without straddling
        // a gutter, never steal an equation tag sitting inside another column across a gutter.
        const otherCol = columnOf.get(other.id) ?? null;
        if (!eqStraddles && eqCol !== null && otherCol !== null && eqCol !== otherCol) continue;

        const otherCenterY = other.rect.y + other.rect.height / 2;
        if (Math.abs(otherCenterY - eqCenterY) > rowTol) continue;

        // Must sit to the right (or left) of the formula with no intervening prose block on the same row.
        const gapRight = other.rect.x - (eq.rect.x + eq.rect.width);
        const gapLeft = eq.rect.x - (other.rect.x + other.rect.width);
        const gap = gapRight >= -4 ? Math.max(0, gapRight) : gapLeft >= -4 ? Math.max(0, gapLeft) : -1;
        if (gap < 0) continue;

        const minX = Math.min(eq.rect.x + eq.rect.width, other.rect.x + other.rect.width);
        const maxX = Math.max(eq.rect.x, other.rect.x);
        const blocked = pageBlocks.some(mid => {
          if (mid.id === eq.id || mid.id === other.id) return false;
          const midCenterY = mid.rect.y + mid.rect.height / 2;
          if (Math.abs(midCenterY - eqCenterY) > rowTol) return false;
          return mid.rect.x + mid.rect.width > minX + EPSILON && mid.rect.x < maxX - EPSILON;
        });
        if (blocked) continue;

        if (!candidate || gap < candidate.gap) {
          candidate = { block: other, number: num, gap };
        }
      }

      if (candidate) {
        mergedTags.set(eq.id, {
          irBlock: candidate.block.irBlock,
          rect: candidate.block.rect,
          number: candidate.number,
        });
        consumedTagIds.add(candidate.block.id);
      }
    }
  }

  return { mergedTags, consumedTagIds };
}

function columnMembershipOfPage(
  pageBlocks: readonly WorkingOrderBlock[],
  pageBox: PageBox,
): { columnOf: Map<string, number | null>; boundaries: number[] } {
  const columnOf = new Map<string, number | null>();
  const partition = detectPageColumns(pageBlocks, pageBox);
  if (partition.columns.length < 2) return { columnOf, boundaries: [] };

  for (const col of partition.columns) {
    for (const id of col.blockIds) columnOf.set(id, col.index);
  }
  return {
    columnOf,
    boundaries: partition.columns.slice(0, -1).map(col => col.right),
  };
}

// --- Stage helpers: Heading levels, slots, outline, footnotes --------------

interface HeadingDecision {
  level: HeadingLevel;
  isTitle: boolean;
}

function assignPaperHeadingLevels(
  items: readonly WorkingOrderBlock[],
  options: ReflowPaperOptions,
): Map<string, HeadingDecision> {
  const headings = items.filter(item => item.irBlock.type === 'heading');
  const decisions = new Map<string, HeadingDecision>();
  if (headings.length === 0) return decisions;

  const first = headings[0];
  let titleBlockId: string | null = null;
  if (first && options.headingLevels?.[first.id] === undefined && headings.length > 1) {
    const text = collapseSpaces(first.text);
    const hasNumberPrefix =
      NUMBERED_HEADING_PREFIX.test(text) ||
      ROMAN_HEADING_PREFIX.test(text) ||
      APPENDIX_HEADING_PREFIX.test(text);
    const isReservedSection = TOP_LEVEL_PAPER_SECTIONS.has(text.toLowerCase());
    const hasSectionHeadingsAfter = headings.slice(1).some(h => {
      const t = collapseSpaces(h.text);
      return (
        NUMBERED_HEADING_PREFIX.test(t) ||
        ROMAN_HEADING_PREFIX.test(t) ||
        TOP_LEVEL_PAPER_SECTIONS.has(t.toLowerCase())
      );
    });
    if (first.page === 1 && !hasNumberPrefix && !isReservedSection && hasSectionHeadingsAfter) {
      titleBlockId = first.id;
    }
  }

  // Compute approximate line heights for unnumbered headings so unnumbered subheadings cluster cleanly.
  const unnumberedHeights: number[] = [];
  for (const h of headings) {
    if (h.id === titleBlockId) continue;
    const explicit = options.headingLevels?.[h.id];
    if (explicit !== undefined) continue;
    const text = collapseSpaces(h.text);
    if (inferNumberedHeadingLevel(text) !== null) continue;
    if (TOP_LEVEL_PAPER_SECTIONS.has(text.toLowerCase())) continue;
    unnumberedHeights.push(approxLineHeight(h));
  }
  const heightTiers = clusterSizeTiers(unnumberedHeights);

  for (const h of headings) {
    const explicit = options.headingLevels?.[h.id];
    if (explicit !== undefined) {
      decisions.set(h.id, { level: clampHeadingLevel(explicit), isTitle: h.id === titleBlockId });
      continue;
    }
    if (h.id === titleBlockId) {
      decisions.set(h.id, { level: 1, isTitle: true });
      continue;
    }
    const text = collapseSpaces(h.text);
    const numbered = inferNumberedHeadingLevel(text);
    if (numbered !== null) {
      decisions.set(h.id, { level: numbered, isTitle: false });
      continue;
    }
    if (TOP_LEVEL_PAPER_SECTIONS.has(text.toLowerCase())) {
      decisions.set(h.id, { level: 1, isTitle: false });
      continue;
    }
    const tierLevel = tierLevelFor(approxLineHeight(h), heightTiers);
    decisions.set(h.id, { level: tierLevel, isTitle: false });
  }

  return decisions;
}

function inferNumberedHeadingLevel(text: string): HeadingLevel | null {
  const numMatch = NUMBERED_HEADING_PREFIX.exec(text);
  if (numMatch?.[1]) {
    const depth = numMatch[1].split('.').length;
    return clampHeadingLevel(depth);
  }
  if (ROMAN_HEADING_PREFIX.test(text)) return 1;
  const appMatch = APPENDIX_HEADING_PREFIX.exec(text);
  if (appMatch) {
    const sub = appMatch[2];
    if (!sub) return 1;
    return clampHeadingLevel(1 + sub.split('.').length);
  }
  return null;
}

function buildReflowSlots(
  items: readonly WorkingOrderBlock[],
  boundCaptions: ReadonlyMap<string, WorkingCaption>,
  mergedTags: ReadonlyMap<string, WorkingEquationTag>,
  headingDecisions: ReadonlyMap<string, HeadingDecision>,
): ReflowSlot[] {
  const slots: ReflowSlot[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    const reflowId = `${REFLOW_ID_PREFIX}${i + 1}`;
    const type = item.irBlock.type;

    if (type === 'heading') {
      const decision = headingDecisions.get(item.id);
      slots.push({
        reflowId,
        irBlock: item.irBlock,
        rect: item.rect,
        kind: 'heading',
        headingLevel: decision?.level ?? 1,
        isTitle: decision?.isTitle ?? false,
      });
      continue;
    }

    if (type === 'formula' || isStandaloneDisplayMathText(item.text)) {
      const parsed = extractFormulaBodyAndNumber(item.text);
      const tag = mergedTags.get(item.id);
      slots.push({
        reflowId,
        irBlock: item.irBlock,
        rect: item.rect,
        kind: 'formula',
        formulaRaw: {
          latex: toLatex(parsed.body),
          ...(parsed.equationNumber !== undefined
            ? { equationNumber: parsed.equationNumber }
            : tag !== undefined
              ? { equationNumber: tag.number }
              : {}),
        },
        ...(tag !== undefined ? { eqTag: tag } : {}),
      });
      continue;
    }

    if (type === 'figure') {
      const cap = boundCaptions.get(item.id);
      slots.push({
        reflowId,
        irBlock: item.irBlock,
        rect: item.rect,
        kind: 'figure',
        ...(cap !== undefined ? { caption: cap } : {}),
      });
      continue;
    }

    if (type === 'table') {
      const cap = boundCaptions.get(item.id);
      const table = parseTableData(item.text);
      slots.push({
        reflowId,
        irBlock: item.irBlock,
        rect: item.rect,
        kind: 'table',
        ...(cap !== undefined ? { caption: cap } : {}),
        ...(table !== undefined ? { table } : {}),
      });
      continue;
    }

    if (type === 'list') {
      slots.push({
        reflowId,
        irBlock: item.irBlock,
        rect: item.rect,
        kind: 'list',
      });
      continue;
    }

    slots.push({
      reflowId,
      irBlock: item.irBlock,
      rect: item.rect,
      kind: 'paragraph',
    });
  }

  return slots;
}

function buildFootnotes(blocks: readonly WorkingOrderBlock[]): WorkingFootnote[] {
  const seenLabels = new Map<string, number>();
  const footnotes: WorkingFootnote[] = [];

  blocks.forEach((item, index) => {
    const parsed = parseFootnoteDefinition(item.text, index + 1);
    const seen = (seenLabels.get(parsed.label) ?? 0) + 1;
    seenLabels.set(parsed.label, seen);

    const safeLabel = parsed.label.replace(/[^A-Za-z0-9_-]/gu, '') || `sym${index + 1}`;
    const anchorId = seen === 1 ? `fn-${safeLabel}` : `fn-${safeLabel}-p${item.page}`;
    footnotes.push({
      reflowId: `${FOOTNOTE_REFLOW_PREFIX}${index + 1}`,
      label: parsed.label,
      anchorId,
      rawBody: parsed.body,
      irBlock: item.irBlock,
      rect: item.rect,
      referencedBy: new Set<string>(),
    });
  });

  return footnotes;
}

function buildSectionHierarchy(
  slots: readonly ReflowSlot[],
  headingDecisions: ReadonlyMap<string, HeadingDecision>,
): {
  sectionTree: ReflowSectionNode[];
  sectionByBlockId: Map<string, string>;
  referenceBlockIds: Set<string>;
} {
  const hasSeparateTitle = slots.some(s => s.kind === 'heading' && s.isTitle === true);
  const reflowIdByBlockId = new Map<string, string>();
  const outlineInputs: OutlineBlockInput[] = [];

  for (const slot of slots) {
    reflowIdByBlockId.set(slot.irBlock.id, slot.reflowId);
    if (hasSeparateTitle && slot.kind === 'heading' && slot.isTitle) continue;
    const isHeading = slot.kind === 'heading';
    outlineInputs.push({
      id: slot.irBlock.id,
      page: slot.irBlock.page,
      text: slot.irBlock.raw,
      type: isHeading ? 'heading' : toSemanticType(slot.irBlock.type),
      ...(isHeading ? { headingLevel: headingDecisions.get(slot.irBlock.id)?.level ?? 1 } : {}),
    });
  }

  const outline = buildOutline(outlineInputs);
  const tocById = new Map<string, TocEntry>(outline.toc.map(entry => [entry.id, entry]));
  const sectionByBlockId = new Map<string, string>();
  for (const member of outline.members) {
    sectionByBlockId.set(member.blockId, member.sectionId);
  }

  const convertSection = (sec: Section): ReflowSectionNode => {
    const toc = tocById.get(sec.id);
    return {
      id: sec.id,
      title: sec.title,
      level: sec.level,
      path: toc?.path ?? '',
      page: sec.page,
      blockId: sec.blockId,
      reflowId: reflowIdByBlockId.get(sec.blockId) ?? '',
      children: sec.children.map(convertSection),
    };
  };

  const sectionTree = outline.sections.map(convertSection);
  const referenceSectionIds = new Set<string>();
  for (const toc of outline.toc) {
    if (REFERENCE_SECTION_TITLES.has(toc.title.toLowerCase())) {
      referenceSectionIds.add(toc.id);
    }
  }

  const referenceBlockIds = new Set<string>();
  for (const member of outline.members) {
    if (referenceSectionIds.has(member.sectionId)) {
      referenceBlockIds.add(member.blockId);
    }
  }

  return { sectionTree, sectionByBlockId, referenceBlockIds };
}

function buildLookupIndex(
  slots: readonly ReflowSlot[],
  footnotes: readonly WorkingFootnote[],
): { lookup: ReflowLookupIndex; byBlockIdMut: Record<string, string> } {
  const byReflowId: Record<string, SourceLocation> = {};
  const byBlockId: Record<string, string> = {};
  const entries: ReflowSourceMapping[] = [];

  const register = (reflowId: string, irBlock: Block, rect: Rect): void => {
    const loc: SourceLocation = {
      page: irBlock.page,
      blockId: irBlock.id,
      rect: { ...rect },
    };
    byReflowId[reflowId] = loc;
    byBlockId[irBlock.id] = reflowId;
    entries.push({ reflowId, ...loc });
  };

  for (const slot of slots) {
    register(slot.reflowId, slot.irBlock, slot.rect);
    if (slot.caption) {
      register(`${slot.reflowId}-caption`, slot.caption.irBlock, slot.caption.rect);
    }
    if (slot.eqTag) {
      register(`${slot.reflowId}-tag`, slot.eqTag.irBlock, slot.eqTag.rect);
    }
  }

  for (const fn of footnotes) {
    register(fn.reflowId, fn.irBlock, fn.rect);
  }

  return {
    lookup: { byReflowId, byBlockId, entries },
    byBlockIdMut: byBlockId,
  };
}

// --- Stage helpers: Resolution indexes & inline segmentation ---------------

function buildEquationIndex(slots: readonly ReflowSlot[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const slot of slots) {
    const num = slot.formulaRaw?.equationNumber;
    if (num && !map.has(num)) map.set(num, slot.reflowId);
  }
  return map;
}

interface BibliographyAuthorYear {
  surname: string;
  year: string;
  reflowId: string;
}

function buildBibliographyIndex(
  slots: readonly ReflowSlot[],
  referenceBlockIds: ReadonlySet<string>,
): {
  bibByNumber: Map<string, string>;
  bibNumbers: Set<string>;
  bibAuthorYears: BibliographyAuthorYear[];
} {
  const bibByNumber = new Map<string, string>();
  const bibNumbers = new Set<string>();
  const bibAuthorYears: BibliographyAuthorYear[] = [];

  for (const slot of slots) {
    if (!referenceBlockIds.has(slot.irBlock.id) || slot.kind === 'heading') continue;
    const text = collapseSpaces(slot.irBlock.raw);
    const numMatch = REFERENCE_LEADING_NUMBER.exec(text);
    const num = numMatch?.[1] ?? numMatch?.[2];
    if (num) {
      bibNumbers.add(num);
      if (!bibByNumber.has(num)) bibByNumber.set(num, slot.reflowId);
    }
    const yearMatch = /\b((?:19|20)\d{2}[a-z]?)\b/u.exec(text);
    const bodyAfterNum = numMatch ? text.slice(numMatch[0].length) : text;
    const surnameMatch = /^([\p{Lu}][\p{L}'’-]{1,40})/u.exec(bodyAfterNum);
    if (yearMatch?.[1] && surnameMatch?.[1]) {
      bibAuthorYears.push({
        surname: surnameMatch[1].toLowerCase(),
        year: yearMatch[1].toLowerCase(),
        reflowId: slot.reflowId,
      });
    }
  }

  return { bibByNumber, bibNumbers, bibAuthorYears };
}

function buildSectionNumberIndex(slots: readonly ReflowSlot[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const slot of slots) {
    if (slot.kind !== 'heading' || slot.isTitle) continue;
    const text = collapseSpaces(slot.irBlock.raw);
    const numMatch = NUMBERED_HEADING_PREFIX.exec(text);
    if (numMatch?.[1] && !map.has(numMatch[1])) {
      map.set(numMatch[1], slot.reflowId);
      continue;
    }
    const appMatch = APPENDIX_HEADING_PREFIX.exec(text);
    if (appMatch?.[1]) {
      const key = appMatch[2] ? `${appMatch[1]}.${appMatch[2]}` : appMatch[1];
      if (!map.has(key)) map.set(key, slot.reflowId);
    }
  }
  return map;
}

function buildCaptionCrossRefIndex(
  slots: readonly ReflowSlot[],
  footnotes: readonly WorkingFootnote[],
): Map<string, readonly Link[]> {
  const linkInputs: LinkInputBlock[] = [];
  for (const slot of slots) {
    const raw =
      (slot.kind === 'figure' || slot.kind === 'table') && slot.caption
        ? `${slot.caption.text}\n${slot.irBlock.raw}`
        : slot.irBlock.raw;
    linkInputs.push({
      id: slot.irBlock.id,
      type: slot.kind === 'table' || slot.kind === 'figure' || slot.kind === 'heading' || slot.kind === 'formula'
        ? slot.kind
        : 'paragraph',
      page: slot.irBlock.page,
      raw,
      ...(slot.headingLevel !== undefined ? { headingLevel: slot.headingLevel } : {}),
    });
  }
  for (const fn of footnotes) {
    linkInputs.push({
      id: fn.irBlock.id,
      type: 'footnote',
      page: fn.irBlock.page,
      raw: fn.irBlock.raw,
    });
  }

  const extracted = extractLinks(linkInputs);
  const bySource = new Map<string, Link[]>();
  for (const link of extracted.links) {
    const group = bySource.get(link.fromBlockId);
    if (group) group.push(link);
    else bySource.set(link.fromBlockId, [link]);
  }
  return bySource;
}

interface ResolutionContext {
  footnotes: readonly WorkingFootnote[];
  equationByNumber: ReadonlyMap<string, string>;
  sectionByNumberPrefix: ReadonlyMap<string, string>;
  bibByNumber: ReadonlyMap<string, string>;
  bibNumbers: ReadonlySet<string>;
  bibAuthorYears: readonly BibliographyAuthorYear[];
  captionTargetLinks: ReadonlyMap<string, readonly Link[]>;
  byBlockIdMut: Readonly<Record<string, string>>;
  isRefEntry: boolean;
}

function materializeBlock(
  slot: ReflowSlot,
  index: number,
  sectionId: string | undefined,
  ctx: ResolutionContext,
  citationsOut: ReflowCitation[],
  equationsOut: ReflowEquation[],
): ReflowBlock {
  const source: SourceLocation = {
    page: slot.irBlock.page,
    blockId: slot.irBlock.id,
    rect: { ...slot.rect },
  };

  if (slot.kind === 'formula' && slot.formulaRaw) {
    const formula: ReflowFormulaDetail = {
      latex: slot.formulaRaw.latex,
      display: true,
      ...(slot.formulaRaw.equationNumber !== undefined ? { equationNumber: slot.formulaRaw.equationNumber } : {}),
      ...(slot.eqTag
        ? {
            equationNumberReflowId: `${slot.reflowId}-tag`,
            equationNumberSource: {
              page: slot.eqTag.irBlock.page,
              blockId: slot.eqTag.irBlock.id,
              rect: { ...slot.eqTag.rect },
            },
          }
        : {}),
    };
    const text = formula.equationNumber ? `$$${formula.latex}$$ (${formula.equationNumber})` : `$$${formula.latex}$$`;
    equationsOut.push({
      reflowId: slot.reflowId,
      latex: formula.latex,
      display: true,
      ...(formula.equationNumber !== undefined ? { equationNumber: formula.equationNumber } : {}),
      source,
    });
    return {
      reflowId: slot.reflowId,
      kind: 'formula',
      index,
      text,
      segments: [{ kind: 'display-math', value: slot.irBlock.raw, latex: formula.latex }],
      source,
      ...(sectionId !== undefined ? { sectionId } : {}),
      formula,
    };
  }

  if (slot.kind === 'list') {
    const rawLines = slot.irBlock.raw.split(/\r?\n/u).map(line => collapseSpaces(line)).filter(line => line.length > 0);
    const items = rawLines.length > 0 ? rawLines : [collapseSpaces(slot.irBlock.raw)];
    const itemSegments: ReflowSegment[][] = [];
    const allSegments: ReflowSegment[] = [];
    for (const item of items) {
      const segs = segmentInlineContent(item, slot.reflowId, source, ctx, citationsOut, equationsOut);
      itemSegments.push(segs);
      if (allSegments.length > 0) allSegments.push({ kind: 'text', value: '\n' });
      allSegments.push(...segs);
    }
    return {
      reflowId: slot.reflowId,
      kind: 'list',
      index,
      text: items.map((_, idx) => segmentsToNormalizedText(itemSegments[idx] ?? [])).join('\n'),
      segments: allSegments,
      source,
      ...(sectionId !== undefined ? { sectionId } : {}),
      items,
      itemSegments,
    };
  }

  if (slot.kind === 'figure' || slot.kind === 'table') {
    const cleanText = slot.kind === 'table' ? slot.irBlock.raw.trim() : collapseSpaces(slot.irBlock.raw);
    const segments = slot.kind === 'figure'
      ? segmentInlineContent(cleanText, slot.reflowId, source, ctx, citationsOut, equationsOut)
      : [{ kind: 'text' as const, value: cleanText }];
    let caption: ReflowCaption | undefined;
    if (slot.caption) {
      const capReflowId = `${slot.reflowId}-caption`;
      const capSource: SourceLocation = {
        page: slot.caption.irBlock.page,
        blockId: slot.caption.irBlock.id,
        rect: { ...slot.caption.rect },
      };
      const capSegments = segmentInlineContent(
        slot.caption.text,
        capReflowId,
        capSource,
        { ...ctx, isRefEntry: false },
        citationsOut,
        equationsOut,
      );
      caption = {
        reflowId: capReflowId,
        kind: slot.caption.kind,
        ...(slot.caption.number !== undefined ? { number: slot.caption.number } : {}),
        text: segmentsToNormalizedText(capSegments),
        segments: capSegments,
        source: capSource,
      };
    }

    return {
      reflowId: slot.reflowId,
      kind: slot.kind,
      index,
      text: slot.kind === 'figure' ? segmentsToNormalizedText(segments) : cleanText,
      segments,
      source,
      ...(sectionId !== undefined ? { sectionId } : {}),
      ...(caption !== undefined ? { caption } : {}),
      ...(slot.table !== undefined ? { table: slot.table } : {}),
    };
  }

  const normalizedInput = collapseSpaces(slot.irBlock.raw);
  const segments = segmentInlineContent(normalizedInput, slot.reflowId, source, ctx, citationsOut, equationsOut);
  const text = segmentsToNormalizedText(segments);

  return {
    reflowId: slot.reflowId,
    kind: slot.kind,
    index,
    text,
    segments,
    source,
    ...(slot.headingLevel !== undefined ? { headingLevel: slot.headingLevel } : {}),
    ...(slot.isTitle === true ? { isTitle: true } : {}),
    ...(sectionId !== undefined ? { sectionId } : {}),
  };
}

function materializeFootnote(
  fn: WorkingFootnote,
  ctx: ResolutionContext,
): ReflowFootnote {
  const source: SourceLocation = {
    page: fn.irBlock.page,
    blockId: fn.irBlock.id,
    rect: { ...fn.rect },
  };
  const dummyCitations: ReflowCitation[] = [];
  const dummyEquations: ReflowEquation[] = [];
  const segments = segmentInlineContent(
    collapseSpaces(fn.rawBody),
    fn.reflowId,
    source,
    ctx,
    dummyCitations,
    dummyEquations,
  );
  return {
    reflowId: fn.reflowId,
    label: fn.label,
    anchorId: fn.anchorId,
    text: segmentsToNormalizedText(segments),
    segments,
    source,
    referencedBy: [...fn.referencedBy],
  };
}

function segmentInlineContent(
  text: string,
  reflowId: string,
  source: SourceLocation,
  ctx: ResolutionContext,
  citationsOut: ReflowCitation[],
  equationsOut: ReflowEquation[],
): ReflowSegment[] {
  if (text.length === 0) return [];
  const mathSegs = segmentMathRuns(text);
  const out: ReflowSegment[] = [];

  for (const seg of mathSegs) {
    if (seg.kind === 'inline-math') {
      out.push({ kind: 'inline-math', value: seg.value, latex: seg.latex ?? seg.value });
      continue;
    }
    if (seg.kind === 'display-math') {
      const parsed = extractFormulaBodyAndNumber(seg.value);
      const latex = toLatex(parsed.body);
      out.push({ kind: 'display-math', value: seg.value, latex });
      equationsOut.push({
        reflowId,
        latex,
        display: true,
        ...(parsed.equationNumber !== undefined ? { equationNumber: parsed.equationNumber } : {}),
        source,
      });
      continue;
    }

    const spans = scanProseSpans(seg.value, source.blockId, source.page, ctx);
    let cursor = 0;
    for (const span of spans) {
      if (span.start > cursor) {
        out.push({ kind: 'text', value: seg.value.slice(cursor, span.start) });
      }
      out.push(span.segment);
      if (span.footnoteRef) {
        span.footnoteRef.referencedBy.add(reflowId);
      }
      if (span.citation) {
        citationsOut.push({
          marker: span.segment.value,
          style: span.citation.style,
          keys: span.citation.keys,
          reflowId,
          blockId: source.blockId,
          page: source.page,
          ...(span.citation.targetReflowId !== undefined
            ? { targetReflowId: span.citation.targetReflowId }
            : {}),
        });
      }
      cursor = span.end;
    }
    if (cursor < seg.value.length) {
      out.push({ kind: 'text', value: seg.value.slice(cursor) });
    }
  }

  return out;
}

/**
 * Delegates math segmentation to `formulas.ts`'s `segmentText`, and additionally
 * captures `$...$` inline formulas whose body starts with a LaTeX command (`$\\alpha$`,
 * `$\\beta > 0$`), which `formulas.ts` treats conservatively to guard `\\$`.
 */
function segmentMathRuns(text: string): Segment[] {
  const initial = segmentText(text);
  const out: Segment[] = [];
  for (const seg of initial) {
    if (seg.kind !== 'text') {
      out.push(seg);
      continue;
    }
    const expanded = seg.value.includes('$\\') ? splitBackslashInlineMath(seg.value) : [seg];
    for (const sub of expanded) {
      if (sub.kind !== 'text') {
        out.push(sub);
        continue;
      }
      out.push(...recoverClauseEndBareMath(sub.value));
    }
  }
  return out;
}

const MATH_OP_HINT = /[=+×÷±∓−∑∏∫∬√∞∂∇→←↔⇒⇔∈∉⊂⊃∪∩∀∃¬∧∨≤≥≠≈≡∼<>^_·⋅∗]/u;

/**
 * `formulas.ts` tokenizes on `\S+`, so a bare formula at the end of a sentence or
 * clause (`when α ≤ β.`) has `.` glued onto `β` and stays plain text. Splitting off
 * trailing clause punctuation recovers that trailing bare formula cleanly.
 */
function recoverClauseEndBareMath(text: string): Segment[] {
  if (!MATH_OP_HINT.test(text)) return [{ kind: 'text', value: text }];
  const out: Segment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(/([.,;:!?…]+)(?=\s|$)/gu)) {
    const punct = match[1] ?? '';
    const punctStart = match.index ?? 0;
    const chunk = text.slice(cursor, punctStart);
    if (!MATH_OP_HINT.test(chunk)) continue;
    const reseg = segmentText(chunk);
    const last = reseg[reseg.length - 1];
    if (last && last.kind !== 'text') {
      out.push(...reseg, { kind: 'text', value: punct });
      cursor = punctStart + punct.length;
    }
  }

  if (cursor === 0) return [{ kind: 'text', value: text }];
  if (cursor < text.length) out.push(...segmentText(text.slice(cursor)));
  return out;
}

function splitBackslashInlineMath(text: string): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) !== '$' || (index > 0 && text.charAt(index - 1) === '\\')) {
      index += 1;
      continue;
    }
    if (text.charAt(index + 1) !== '\\' || text.charAt(index + 2) === '$' || /\s/u.test(text.charAt(index + 2))) {
      index += 1;
      continue;
    }
    let close = -1;
    for (let pos = index + 2; pos < text.length; pos += 1) {
      if (text.charAt(pos) !== '$') continue;
      if (text.charAt(pos + 1) === '$') break;
      if (/[\s\\$]/u.test(text.charAt(pos - 1))) break;
      close = pos;
      break;
    }
    if (close === -1) {
      index += 1;
      continue;
    }
    if (index > cursor) out.push(...segmentText(text.slice(cursor, index)));
    const body = text.slice(index + 1, close);
    out.push({ kind: 'inline-math', value: text.slice(index, close + 1), latex: toLatex(body) });
    cursor = close + 1;
    index = cursor;
  }
  if (cursor < text.length) out.push(...segmentText(text.slice(cursor)));
  return out;
}

function scanProseSpans(
  prose: string,
  blockId: string,
  page: number,
  ctx: ResolutionContext,
): RawInlineSpan[] {
  const candidates: RawInlineSpan[] = [
    ...scanFootnoteSpans(prose, page, ctx),
    ...scanEquationRefSpans(prose, ctx),
    ...scanCrossRefSpans(prose, blockId, ctx),
    ...(ctx.isRefEntry ? [] : scanCitationSpans(prose, page, ctx)),
  ];
  return dropOverlappingSpans(candidates);
}

function scanFootnoteSpans(
  prose: string,
  page: number,
  ctx: ResolutionContext,
): RawInlineSpan[] {
  const candidates: RawInlineSpan[] = [];

  for (const match of prose.matchAll(/\[\^(\d{1,3})\]/gu)) {
    const start = match.index ?? 0;
    const label = match[1] ?? '';
    if (!label) continue;
    const target = resolveNearestFootnote(ctx.footnotes, label, page);
    candidates.push({
      start,
      end: start + match[0].length,
      priority: 1,
      segment: {
        kind: 'footnote-ref',
        value: match[0],
        label,
        ...(target ? { targetReflowId: target.reflowId } : {}),
      },
      ...(target ? { footnoteRef: target } : {}),
    });
  }

  for (const match of prose.matchAll(/(?<=\S)([⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3})(?!\p{L})/gu)) {
    const start = match.index ?? 0;
    const rawSup = match[1] ?? '';
    const label = Array.from(rawSup).map(ch => SUPERSCRIPT_DIGITS[ch] ?? '').join('');
    if (!label) continue;
    const target = resolveNearestFootnote(ctx.footnotes, label, page);
    if (!target) continue;
    candidates.push({
      start,
      end: start + rawSup.length,
      priority: 2,
      segment: {
        kind: 'footnote-ref',
        value: rawSup,
        label,
        targetReflowId: target.reflowId,
      },
      footnoteRef: target,
    });
  }

  for (const match of prose.matchAll(/(?<=\S)\^(\d{1,3})(?![\p{L}\p{N}])/gu)) {
    const start = match.index ?? 0;
    const label = match[1] ?? '';
    const target = label ? resolveNearestFootnote(ctx.footnotes, label, page) : undefined;
    if (!target) continue;
    candidates.push({
      start,
      end: start + match[0].length,
      priority: 2,
      segment: {
        kind: 'footnote-ref',
        value: match[0],
        label,
        targetReflowId: target.reflowId,
      },
      footnoteRef: target,
    });
  }

  for (const match of prose.matchAll(/([\p{Ll}"'”’\])])([.!?…]["'”’)]?)(\d{1,2})(?=\s|$)/gu)) {
    const fullStart = match.index ?? 0;
    const lead = match[1] ?? '';
    const punct = match[2] ?? '';
    const label = match[3] ?? '';
    if (!label) continue;
    const wordBefore = /([\p{L}\p{N}.'’-]+)$/u.exec(prose.slice(0, fullStart + lead.length))?.[1] ?? '';
    if (NO_FOOTNOTE_ABBREVIATIONS.has(wordBefore.toLowerCase().replace(/\.+$/u, ''))) continue;
    if (/\d$/u.test(wordBefore)) continue;
    const target = resolveNearestFootnote(ctx.footnotes, label, page);
    if (!target) continue;
    const start = fullStart + lead.length + punct.length;
    candidates.push({
      start,
      end: start + label.length,
      priority: 3,
      segment: {
        kind: 'footnote-ref',
        value: label,
        label,
        targetReflowId: target.reflowId,
      },
      footnoteRef: target,
    });
  }

  for (const match of prose.matchAll(/(?<=\p{L})([*†‡])/gu)) {
    const start = match.index ?? 0;
    const sym = match[1] ?? '';
    const target = sym ? resolveNearestFootnote(ctx.footnotes, sym, page) : undefined;
    if (!target) continue;
    candidates.push({
      start,
      end: start + sym.length,
      priority: 3,
      segment: {
        kind: 'footnote-ref',
        value: sym,
        label: sym,
        targetReflowId: target.reflowId,
      },
      footnoteRef: target,
    });
  }

  return candidates;
}

function scanEquationRefSpans(prose: string, ctx: ResolutionContext): RawInlineSpan[] {
  const candidates: RawInlineSpan[] = [];
  for (const match of prose.matchAll(/\b(?:Equations?|Eqs?\.?)\s*\((\d{1,3}(?:\.\d{1,3})*|[A-Z]\.\d{1,3})\)/gu)) {
    const start = match.index ?? 0;
    const eqNum = match[1] ?? '';
    const targetReflowId = ctx.equationByNumber.get(eqNum);
    if (!targetReflowId) continue;
    candidates.push({
      start,
      end: start + match[0].length,
      priority: 2,
      segment: {
        kind: 'equation-ref',
        value: match[0],
        label: eqNum,
        targetReflowId,
      },
    });
  }
  return candidates;
}

function scanCrossRefSpans(
  prose: string,
  blockId: string,
  ctx: ResolutionContext,
): RawInlineSpan[] {
  const candidates: RawInlineSpan[] = [];
  const matchedSectionStarts = new Set<number>();

  // 1. Explicit numbered section cross-references (`Section 2.1`, `Sec. 1`, `§ 2.1`)
  for (const match of prose.matchAll(/(?:\b(?:sections?|sec\.?|chapters?|ch\.?|mục|chương|phần)\s*|\u00A7\s*)(\d{1,3}(?:\.\d{1,3})*|[A-Z](?:\.\d{1,3})+)/giu)) {
    const start = match.index ?? 0;
    const path = match[1] ?? '';
    const targetReflowId = ctx.sectionByNumberPrefix.get(path);
    if (!targetReflowId) continue;
    matchedSectionStarts.add(start);
    candidates.push({
      start,
      end: start + match[0].length,
      priority: 2,
      segment: {
        kind: 'cross-ref',
        value: match[0],
        label: match[0],
        targetReflowId,
      },
    });
  }

  // 2. Figure, Table, and unnumbered section links resolved by `links.ts`
  const links = ctx.captionTargetLinks.get(blockId) ?? [];
  for (const link of links) {
    if (link.kind !== 'figure' && link.kind !== 'table' && link.kind !== 'section') continue;
    if (!link.targetBlockId) continue;
    const targetReflowId = ctx.byBlockIdMut[link.targetBlockId];
    if (!targetReflowId) continue;
    let searchFrom = 0;
    while (searchFrom < prose.length) {
      const idx = prose.indexOf(link.label, searchFrom);
      if (idx === -1) break;
      if (link.kind === 'section' && matchedSectionStarts.has(idx)) {
        searchFrom = idx + link.label.length;
        continue;
      }
      candidates.push({
        start: idx,
        end: idx + link.label.length,
        priority: 3,
        segment: {
          kind: 'cross-ref',
          value: link.label,
          label: link.label,
          targetReflowId,
        },
      });
      searchFrom = idx + link.label.length;
    }
  }
  return candidates;
}

function scanCitationSpans(
  prose: string,
  page: number,
  ctx: ResolutionContext,
): RawInlineSpan[] {
  const candidates: RawInlineSpan[] = [];

  for (const match of prose.matchAll(/\[(\s*\d{1,4}(?:\s*[,;–—-]\s*\d{1,4})*\s*)\]/gu)) {
    const start = match.index ?? 0;
    const inner = (match[1] ?? '').trim();
    const isSingleNumber = /^\d{1,3}$/u.test(inner);
    if (isSingleNumber && !ctx.bibNumbers.has(inner)) {
      const fnTarget = resolveNearestFootnote(ctx.footnotes, inner, page);
      if (fnTarget) {
        candidates.push({
          start,
          end: start + match[0].length,
          priority: 4,
          segment: {
            kind: 'footnote-ref',
            value: match[0],
            label: inner,
            targetReflowId: fnTarget.reflowId,
          },
          footnoteRef: fnTarget,
        });
        continue;
      }
    }

    const keys = expandNumericCitationKeys(inner);
    const targetReflowId = keys.length === 1 && keys[0] ? ctx.bibByNumber.get(keys[0]) : undefined;
    candidates.push({
      start,
      end: start + match[0].length,
      priority: 4,
      segment: {
        kind: 'citation',
        value: match[0],
        citationStyle: 'numeric',
        citationKeys: keys,
        ...(targetReflowId !== undefined ? { targetReflowId } : {}),
      },
      citation: { style: 'numeric', keys, ...(targetReflowId !== undefined ? { targetReflowId } : {}) },
    });
  }

  const parenCitePattern =
    /\(\s*(?:(?:see|cf\.?|e\.g\.,?|i\.e\.?,?)\s+)?([\p{Lu}][\p{L}'’-]+(?:\s+(?:et\s+al\.?|(?:and|&)\s+[\p{Lu}][\p{L}'’-]+))?(?:,\s*|\s+)(?:19|20)\d{2}[a-z]?(?:\s*,\s*p{1,2}\.?\s*\d+(?:[-–]\d+)?)?(?:\s*;\s*(?:(?:see|cf\.?|e\.g\.,?|i\.e\.?,?)\s+)?[\p{Lu}][\p{L}'’-]+(?:\s+(?:et\s+al\.?|(?:and|&)\s+[\p{Lu}][\p{L}'’-]+))?(?:,\s*|\s+)(?:19|20)\d{2}[a-z]?(?:\s*,\s*p{1,2}\.?\s*\d+(?:[-–]\d+)?)?)*)\s*\)/gu;
  for (const match of prose.matchAll(parenCitePattern)) {
    const start = match.index ?? 0;
    const body = match[1] ?? '';
    const firstWord = /^([\p{Lu}][\p{L}'’-]+)/u.exec(body)?.[1] ?? '';
    if (NON_AUTHOR_WORDS.has(firstWord.toLowerCase())) continue;
    const keys = splitAuthorYearKeys(body);
    const targetReflowId = keys.length === 1 && keys[0]
      ? resolveAuthorYearTarget(keys[0], ctx.bibAuthorYears)
      : undefined;
    candidates.push({
      start,
      end: start + match[0].length,
      priority: 3,
      segment: {
        kind: 'citation',
        value: match[0],
        citationStyle: 'author-year',
        citationKeys: keys,
        ...(targetReflowId !== undefined ? { targetReflowId } : {}),
      },
      citation: { style: 'author-year', keys, ...(targetReflowId !== undefined ? { targetReflowId } : {}) },
    });
  }

  const narrativePattern =
    /(?<![\p{L}\p{N}])([\p{Lu}][\p{L}'’-]+(?:\s+(?:et\s+al\.?|(?:and|&)\s+[\p{Lu}][\p{L}'’-]+))?)\s*\(((?:19|20)\d{2}[a-z]?)\)/gu;
  for (const match of prose.matchAll(narrativePattern)) {
    const start = match.index ?? 0;
    const author = match[1] ?? '';
    const year = match[2] ?? '';
    const firstWord = /^([\p{Lu}][\p{L}'’-]+)/u.exec(author)?.[1] ?? '';
    if (NON_AUTHOR_WORDS.has(firstWord.toLowerCase())) continue;
    const key = `${author}, ${year}`;
    const targetReflowId = resolveAuthorYearTarget(key, ctx.bibAuthorYears);
    candidates.push({
      start,
      end: start + match[0].length,
      priority: 4,
      segment: {
        kind: 'citation',
        value: match[0],
        citationStyle: 'author-year',
        citationKeys: [key],
        ...(targetReflowId !== undefined ? { targetReflowId } : {}),
      },
      citation: {
        style: 'author-year',
        keys: [key],
        ...(targetReflowId !== undefined ? { targetReflowId } : {}),
      },
    });
  }

  return candidates;
}

function dropOverlappingSpans(candidates: RawInlineSpan[]): RawInlineSpan[] {
  candidates.sort(
    (a, b) =>
      a.start - b.start ||
      a.priority - b.priority ||
      (b.end - b.start) - (a.end - a.start),
  );
  const kept: RawInlineSpan[] = [];
  let cursor = 0;
  for (const item of candidates) {
    if (item.start < cursor) continue;
    kept.push(item);
    cursor = item.end;
  }
  return kept;
}

// --- Parsing & formatting helpers ------------------------------------------

function resolveNearestFootnote(
  footnotes: readonly WorkingFootnote[],
  label: string,
  page: number,
): WorkingFootnote | undefined {
  const matching = footnotes.filter(fn => fn.label === label);
  if (matching.length === 0) return undefined;
  const reachable = matching.filter(fn => Math.abs(fn.irBlock.page - page) <= FOOTNOTE_PAGE_REACH);
  const pool = reachable.length > 0 ? reachable : matching;
  let best: WorkingFootnote | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of pool) {
    const dist = Math.abs(candidate.irBlock.page - page);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

function parseFootnoteDefinition(raw: string, ordinal: number): { label: string; body: string } {
  const text = collapseSpaces(raw);
  const match = FOOTNOTE_LEADING_MARKER.exec(text);
  if (match) {
    const labelRaw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '';
    const label = labelRaw.replace(/^\^/u, '');
    const body = text.slice(match[0].length).trim();
    if (label.length > 0) {
      return { label, body: body.length > 0 ? body : text };
    }
  }
  return { label: String(ordinal), body: text };
}

function extractFormulaBodyAndNumber(raw: string): { body: string; equationNumber?: string } {
  let body = collapseSpaces(raw);
  let equationNumber: string | undefined;

  // Check `\tag{...}` first.
  body = body.replace(LATEX_TAG_COMMAND, (_m: string, tag: string) => {
    const trimmed = tag.trim();
    if (trimmed.length > 0 && equationNumber === undefined) equationNumber = trimmed;
    return '';
  }).trim();

  // Check delimited equation followed by `(1)`: `$$...$$ (1)` or `\[...\] (1)`
  const delimTag = EQUATION_DELIM_TRAILING_TAG.exec(body);
  if (delimTag?.[1] && delimTag[2]) {
    body = delimTag[1].trim();
    equationNumber ??= delimTag[2];
  } else {
    const trailing = EQUATION_TRAILING_TAG.exec(body);
    if (trailing?.[1] && trailing[2]) {
      const candidateBody = trailing[1].trim();
      if (candidateBody.length > 0 && !TRAILING_MATH_OPERATOR.test(candidateBody)) {
        body = candidateBody;
        equationNumber ??= trailing[2];
      }
    } else {
      const leading = EQUATION_LEADING_TAG.exec(body);
      if (leading?.[1] && leading[2]) {
        const candidateBody = leading[2].trim();
        if (candidateBody.length > 0 && !LEADING_MATH_OPERATOR.test(candidateBody)) {
          body = candidateBody;
          equationNumber ??= leading[1];
        }
      }
    }
  }

  // Strip outer math delimiters if they enclose the whole body.
  const dollarDisplay = STANDALONE_DISPLAY_DOLLAR.exec(body);
  if (dollarDisplay?.[1] !== undefined) body = dollarDisplay[1].trim();
  else {
    const bracketDisplay = STANDALONE_DISPLAY_BRACKET.exec(body);
    if (bracketDisplay?.[1] !== undefined) body = bracketDisplay[1].trim();
  }

  return {
    body,
    ...(equationNumber !== undefined ? { equationNumber } : {}),
  };
}

function isStandaloneFormulaBlock(block: Block): boolean {
  return block.type === 'formula' || isStandaloneDisplayMathText(block.raw);
}

function isStandaloneDisplayMathText(raw: string): boolean {
  const trimmed = collapseSpaces(raw);
  const withoutTag = EQUATION_DELIM_TRAILING_TAG.exec(trimmed)?.[1]?.trim() ?? trimmed;
  return STANDALONE_DISPLAY_DOLLAR.test(withoutTag) || STANDALONE_DISPLAY_BRACKET.test(withoutTag);
}

function parseCaptionLabel(text: string): { kind: CaptionKind; number: number } | undefined {
  const match = CAPTION_LABEL_PREFIX.exec(firstLine(text));
  if (!match?.[1] || !match[2]) return undefined;
  const word = match[1].toLowerCase();
  const number = Number.parseInt(match[2], 10);
  if (!Number.isInteger(number)) return undefined;
  const kind: CaptionKind = word.startsWith('table') || word.startsWith('bảng') ? 'table' : 'figure';
  return { kind, number };
}

function isLikelyCaption(block: Block): boolean {
  if (block.type !== 'other' && block.type !== 'paragraph') return false;
  const line = firstLine(block.raw);
  if (!CAPTION_LABEL_PREFIX.test(line)) return false;
  if (block.type === 'other') return true;
  return CAPTION_STRICT_PUNCT.test(line);
}

function parseTableData(raw: string): ReflowTableData | undefined {
  const lines = raw.split(/\r?\n/u).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return undefined;

  const splitLine = (line: string): string[] => {
    if (line.includes('|')) {
      return line.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(c => c.trim());
    }
    return line.split(/\t+| {2,}/u).map(c => c.trim()).filter(c => c.length > 0);
  };

  const parsed = lines.map(splitLine);
  const firstRow = parsed[0];
  if (!firstRow || firstRow.length < 2) return undefined;
  const colCount = firstRow.length;

  // Skip markdown separator row `| --- | --- |` if present.
  const bodyRows = parsed.slice(1).filter(row => !row.every(cell => /^:?-{2,}:?$/u.test(cell)));
  if (bodyRows.length === 0) return undefined;
  if (!bodyRows.every(row => row.length >= 2 && row.length <= colCount + 1)) return undefined;

  return {
    headers: firstRow,
    rows: bodyRows.map(row => firstRow.map((_, idx) => row[idx] ?? '')),
  };
}

function expandNumericCitationKeys(inner: string): string[] {
  const keys: string[] = [];
  for (const part of inner.split(/[,;]/u)) {
    const trimmed = part.trim();
    const range = /^(\d{1,4})\s*[–—-]\s*(\d{1,4})$/u.exec(trimmed);
    if (range?.[1] && range[2]) {
      const start = Number.parseInt(range[1], 10);
      const end = Number.parseInt(range[2], 10);
      if (Number.isInteger(start) && Number.isInteger(end) && end >= start && end - start <= 50) {
        for (let n = start; n <= end; n += 1) keys.push(String(n));
        continue;
      }
    }
    if (trimmed.length > 0) keys.push(trimmed);
  }
  return keys;
}

function splitAuthorYearKeys(body: string): string[] {
  return body
    .split(/\s*;\s*/u)
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

function resolveAuthorYearTarget(
  key: string,
  entries: readonly BibliographyAuthorYear[],
): string | undefined {
  const surnameMatch = /^([\p{Lu}][\p{L}'’-]+)/u.exec(key);
  const yearMatch = /\b((?:19|20)\d{2}[a-z]?)\b/u.exec(key);
  if (!surnameMatch?.[1] || !yearMatch?.[1]) return undefined;
  const surname = surnameMatch[1].toLowerCase();
  const year = yearMatch[1].toLowerCase();
  const hits = entries.filter(e => e.surname === surname && e.year === year);
  return hits.length === 1 ? hits[0]?.reflowId : undefined;
}

function segmentsToNormalizedText(segments: readonly ReflowSegment[]): string {
  let out = '';
  for (const seg of segments) {
    if (seg.kind === 'inline-math') out += `$${seg.latex ?? seg.value}$`;
    else if (seg.kind === 'display-math') out += `$$${seg.latex ?? seg.value}$$`;
    else out += seg.value;
  }
  return out.trim();
}

function stripListPrefixFromSegments(segments: readonly ReflowSegment[]): ReflowSegment[] {
  const first = segments[0];
  if (!first || first.kind !== 'text') return [...segments];
  const stripped = first.value.replace(LIST_ITEM_PREFIX, '');
  return [{ ...first, value: stripped }, ...segments.slice(1)];
}

function buildMarkdownFootnoteKeys(footnotes: readonly WorkingFootnote[] | readonly ReflowFootnote[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const fn of footnotes) {
    counts.set(fn.label, (counts.get(fn.label) ?? 0) + 1);
  }
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const fn of footnotes) {
    const dup = (counts.get(fn.label) ?? 0) > 1;
    let key = dup ? `${fn.label}-p${'irBlock' in fn ? fn.irBlock.page : fn.source.page}` : fn.label;
    while (used.has(key)) key = `${key}-dup`;
    used.add(key);
    map.set(fn.reflowId, key);
  }
  return map;
}

// --- Small pure helpers ----------------------------------------------------

function polygonToRect(polygon: Polygon | undefined): Rect {
  const points: readonly Point[] | undefined = polygon;
  if (!Array.isArray(points) || points.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const xs = points.map(p => finiteOr(p?.x, 0));
  const ys = points.map(p => finiteOr(p?.y, 0));
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(0, Math.max(...xs) - minX),
    height: Math.max(0, Math.max(...ys) - minY),
  };
}

function computeTextArea(blocks: readonly WorkingOrderBlock[], pageWidth: number): { left: number; right: number } {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const b of blocks) {
    if (b.rect.width <= 0) continue;
    left = Math.min(left, b.rect.x);
    right = Math.max(right, b.rect.x + b.rect.width);
  }
  if (!Number.isFinite(left) || !Number.isFinite(right)) return { left: 0, right: pageWidth };
  return {
    left: Math.max(0, Math.min(left, pageWidth)),
    right: Math.max(0, Math.min(right, pageWidth)),
  };
}

function compareBlockTopLeft(left: WorkingOrderBlock, right: WorkingOrderBlock): number {
  if (left.rect.y !== right.rect.y) return left.rect.y - right.rect.y;
  if (left.rect.x !== right.rect.x) return left.rect.x - right.rect.x;
  return compareLex(left.id, right.id);
}

function approxLineHeight(item: WorkingOrderBlock): number {
  const lines = Math.max(1, item.text.split(/\r?\n/u).filter(l => l.trim().length > 0).length);
  return item.rect.height > 0 ? item.rect.height / lines : 12;
}

function clusterSizeTiers(heights: readonly number[]): number[] {
  const sorted = [...new Set(heights.filter(h => Number.isFinite(h) && h > 0))].sort((a, b) => b - a);
  const tiers: number[] = [];
  for (const h of sorted) {
    const last = tiers[tiers.length - 1];
    if (last !== undefined && Math.abs(last - h) <= Math.max(0.5, last * 0.08)) continue;
    tiers.push(h);
  }
  return tiers;
}

function tierLevelFor(height: number, tiers: readonly number[]): HeadingLevel {
  for (let i = 0; i < tiers.length; i += 1) {
    const anchor = tiers[i];
    if (anchor === undefined) continue;
    if (Math.abs(anchor - height) <= Math.max(0.5, anchor * 0.08)) {
      return clampHeadingLevel(i + 1);
    }
  }
  return 1;
}

function clampHeadingLevel(level: number): HeadingLevel {
  const clamped = Math.min(MAX_HEADING_LEVEL, Math.max(1, Math.round(level)));
  return clamped as HeadingLevel;
}

function toSemanticType(type: BlockType): SemanticBlockType {
  switch (type) {
    case 'heading':
    case 'paragraph':
    case 'list':
    case 'table':
    case 'figure':
    case 'formula':
    case 'footnote':
    case 'other':
      return type;
  }
}

function isValidBlock(value: unknown): value is Block {
  return typeof value === 'object' && value !== null && typeof (value as Block).id === 'string';
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

function collapseSpaces(text: string): string {
  return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, ch => HTML_ENTITIES[ch] ?? ch);
}

function normalizeRect(rect: Rect): Rect {
  return {
    x: finiteOr(rect.x, 0),
    y: finiteOr(rect.y, 0),
    width: Math.max(0, finiteOr(rect.width, 0)),
    height: Math.max(0, finiteOr(rect.height, 0)),
  };
}

function rectsNearlyEqual(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= EPSILON &&
    Math.abs(a.y - b.y) <= EPSILON &&
    Math.abs(a.width - b.width) <= EPSILON &&
    Math.abs(a.height - b.height) <= EPSILON
  );
}

function intersectionArea(a: Rect, b: Rect): number {
  const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return xOverlap * yOverlap;
}

function rectArea(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function centerDistanceSq(a: Rect, b: Rect): number {
  const dx = (a.x + a.width / 2) - (b.x + b.width / 2);
  const dy = (a.y + a.height / 2) - (b.y + b.height / 2);
  return dx * dx + dy * dy;
}

function compareLex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
