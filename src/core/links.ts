/**
 * Internal links: footnotes, figure and table references, and section references
 * (backlog item E10).
 *
 * A re-parse gives every block a new id, and an export flattens the document into
 * another format. Both lose the connections a reader relies on: the superscript `[1]`
 * that points at a footnote, `Figure 3` that points at the picture on page 5, `see
 * section 2.1` that points at a heading. This module recovers those connections from
 * the block list, keeps them addressable by block id, lets a caller renumber them
 * after a merge and writes them as Markdown anchors.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no I/O, no locale. The
 *   same blocks always produce the same links, in the same order.
 * - The input order *is* reading order, matching `DocumentIR.blocks` and
 *   `classifyBlocks`; geometry is not consulted, so the caller must not shuffle the
 *   list. A reference is matched across pages by its number, and page distance only
 *   decides between candidates that carry the same number.
 * - Nothing is guessed. A reference no block can honour is reported in `unresolved`
 *   with a machine-readable reason and the reference that was looked up; a tie
 *   between equally near candidates is reported as a tie, never resolved by picking
 *   one.
 * - `page` on a link is the page the *reference* is read on, not the page of its
 *   target: that is the coordinate a reader needs in order to scroll to the link.
 * - A block that *labels* something never *refers* to it. A heading, figure, table,
 *   caption, formula or footnote block produces no references of its own, so a
 *   caption can never link to itself.
 *
 * Recognised references, in the order they are scanned out of one block:
 * - Footnote markers: `[1]` (also `[^1]`) anywhere in prose; a trailing number
 *   attached to the sentence (`…as shown earlier.3`, `…as shown earlier. 3`, and
 *   `claim3` with the digits glued to a lowercase word); and a block whose whole text
 *   is a bare number (`1`, `[1]`, `^1`) — the superscript that survived extraction as
 *   a block of its own.
 * - Figure and table references: `Figure 3`, `Fig. 4`, `Table 2` and the Vietnamese
 *   `Hình 3`, `Bảng 2` (also `Bảng số 2`).
 * - Section references: `section 2.1`, `sec. 2`, `chapter 3`, `§ 2.1` and the
 *   Vietnamese `mục 2.1`, `chương 2`, `phần 2`.
 *
 * What is deliberately not evidence:
 * - A trailing number behind a bare space is not a marker. `in 3 items` is prose, and
 *   the `3` of `Figure 3` belongs to the figure reference that was already scanned
 *   out of the same text.
 * - A decimal or a comma-separated enumeration at the end of a block (`3.5`, `1, 2,
 *   3`) is one number, not a marker.
 * - A bare number block that resolves to nothing is dropped instead of reported: one
 *   lone digit on a page is too weak an observation to call a dangling link, while a
 *   bracketed marker is unambiguous evidence and is always reported.
 *
 * Footnote numbering: a footnote block's number is the number at the start of its own
 * text (`1 …`, `[1] …`, `(1) …`), and otherwise its 1-based ordinal among footnote
 * blocks in reading order — the number a document without printed labels implies.
 * Footnotes are often numbered per page, so the same number may exist on several
 * pages; a marker reaches its own page and one either side (`FOOTNOTE_PAGE_REACH`)
 * and resolves to the nearest candidate.
 *
 * Figure and table numbering follows `captions.ts`: a figure or table block keeps the
 * number of its own leading label and otherwise takes its ordinal among blocks of its
 * kind, and a separate `caption` block is identified by its own label. A reference
 * resolves to the block that *carries* the caption — `linkCaptions` (E08) is what
 * connects that caption to the pixels.
 *
 * Section numbering follows `outline.ts`: a section reference is matched against the
 * `path` that `flattenOutline` assigns (`1`, `1.2`, `2.1.3`). A document whose blocks
 * carry no heading levels still produces a flat outline of `1`, `2`, `3`, so a dotted
 * reference can only resolve when the caller passes the outline it built with real
 * levels through `options.outline`.
 */

import { MAX_HEADING_LEVEL, SEMANTIC_BLOCK_TYPES, type SemanticBlockType } from './blocks';
import type { BlockType, DocumentIR } from './ir';
import { buildOutline, flattenOutline, type Outline, type TocEntry } from './outline';

/** Kind of thing a reference points at. */
export type LinkKind = 'footnote' | 'figure' | 'table' | 'section';

/** The caption-targeted kinds: the only ones a `Figure`/`Table` reference names. */
type CaptionTargetKind = Extract<LinkKind, 'figure' | 'table'>;

/** Why a reference could not be turned into a link. */
export type UnresolvedLinkReason =
  /** No footnote block carries the marker's number. */
  | 'no-footnote'
  /** The number exists, but only beyond {@link FOOTNOTE_PAGE_REACH} pages. */
  | 'footnote-out-of-reach'
  /** More than one footnote with that number is equally near. */
  | 'ambiguous-footnote'
  /** No figure or table block carries the referenced number. */
  | 'no-caption'
  /** More than one caption with that number is equally near. */
  | 'ambiguous-caption'
  /** The outline has no section with that number path. */
  | 'no-section'
  /** More than one section carries that number path. */
  | 'ambiguous-section';

/** Nearby pages a footnote marker reaches: its own page, or one either side. */
export const FOOTNOTE_PAGE_REACH = 1;

/**
 * One reference that resolved. `label` is the reference exactly as it was read
 * (`[1]`, `Figure 3`, `section 2.1`), which is both what a UI can show and what
 * {@link linkReference} normalises back to a renumbering key.
 */
export interface Link {
  /** Id of the block the reference starts from. */
  fromBlockId: string;
  kind: LinkKind;
  /** Block to jump to; set on every kind that resolves to a block. */
  targetBlockId?: string;
  /** Section to jump to; set on `section` links, alongside the section's jump block. */
  targetSectionId?: string;
  /** The reference as written, for example `[1]`, `Figure 3`, `section 2.1`. */
  label: string;
  /** 1-based page the reference is read on. */
  page: number;
}

/** One reference that could not be resolved, with the evidence for that verdict. */
export interface UnresolvedLink {
  fromBlockId: string;
  kind: LinkKind;
  label: string;
  page: number;
  reason: UnresolvedLinkReason;
  /** Normalised reference that was looked up: `footnote:1`, `figure:3`, `section:2.1`. */
  reference: string;
  /**
   * Ids of the candidates that tied, in reading order. Empty when nothing carried the
   * number (`no-footnote`, `no-caption`, `no-section`), so a UI can tell "nothing
   * here" from "more than one thing here".
   */
  candidateIds: string[];
}

export interface ExtractLinksResult {
  /** Resolved references, ordered by source block and then by position in its text. */
  links: Link[];
  /** References that resolved to nothing or to a tie, in the same order. */
  unresolved: UnresolvedLink[];
}

export interface ExtractLinksOptions {
  /**
   * Outline used to resolve section references. When omitted, one is built from the
   * blocks themselves, so heading levels have to be on the blocks for a dotted
   * reference (`2.1`) to exist at all.
   */
  outline?: Outline;
}

/**
 * A block as this module reads it. `ClassifiedBlock` from `src/core/blocks.ts` and
 * `DocumentIR.blocks` both fit this shape, so either can be passed straight in.
 */
export interface LinkInputBlock {
  /** Reader block id; when absent this module derives `p{page}-r{rank}`. */
  id?: string;
  /** Semantic type from `blocks.ts`, or the IR's block type. */
  type?: SemanticBlockType | BlockType;
  /** 1-based page number; a missing or invalid page is treated as page 1. */
  page?: number;
  /** Source text. When absent, `raw` (the IR field name for the same text) is read. */
  text?: string;
  /** IR field name for the block's source text; ignored when `text` is present. */
  raw?: string;
  /** Heading level 1..3 when the caller has one; a heading without one is level 1. */
  headingLevel?: number;
}

/**
 * Rename map applied by {@link renumberLinks}. Every entry maps an id (or reference
 * key) in the old document to the id it has after the merge or renumbering.
 */
export interface LinkRenumberMap {
  /** Old block id -> new block id, applied to the source and the target of a link. */
  blocks?: Readonly<Record<string, string>>;
  /** Old section id -> new section id. */
  sections?: Readonly<Record<string, string>>;
  /** Old reference key (`figure:3`, `footnote:1`, `section:2.1`) -> new key. */
  references?: Readonly<Record<string, string>>;
}

/** A caption reference: `Figure 3`, `Fig. 4`, `Table 2`, `Hình 3`, `Bảng 2`, `Bảng số 2`. */
const CAPTION_REFERENCE = /(?<![\p{L}\p{N}])(Figure|Fig\.?|Hình|Table|Bảng)\s*(?:số\s*)?(\d{1,3})(?!\d)/giu;

/** A section reference: a keyword or `§` followed by a dotted number. */
const SECTION_REFERENCE =
  /(?:\b(?:sections?|sec\.?|chapters?|ch\.?|mục|chương|phần)\s*|\u00A7\s*)(\d{1,3}(?:\.\d{1,3})*)/giu;

/** A bracketed footnote marker: `[1]`, `[^1]`. */
const BRACKET_MARKER = /\[\^?(\d{1,3})\]/gu;

/** A block whose whole text is a bare marker: `1`, `[1]`, `(1)`, `^1`. */
const BARE_MARKER = /^[\[(]?\^?(\d{1,3})[\])]?$/u;

/** A marker attached to the end of the text, kept together with the character before it. */
const TRAILING_MARKER = /([.,;:!?\u2026"')\]]\s*|[\p{Ll}])(\d{1,3})\s*$/u;

/** A decimal at the end of the text: `3.5` and `1,5` are numbers, not markers. */
const DECIMAL_TAIL = /\d[.,]\d{1,3}\s*$/u;

/** A comma-separated enumeration at the end of the text: `1, 2, 3` is a list of numbers. */
const ENUMERATION_TAIL = /\d\s*,\s*\d{1,3}\s*$/u;

/** A caption label at the start of a caption, figure or table block. */
const CAPTION_LABEL = /^\s*(Figure|Fig\.?|Hình|Table|Bảng)\s*(?:số\s*)?(\d{1,3})(?!\d)/iu;

/** A footnote's own number at the start of its text: `1 …`, `1. …`, `[1] …`, `(1) …`. */
const FOOTNOTE_LABEL = /^\s*[\[(]?\s*\^?(\d{1,3})\s*(?:[.:)\]–—-]|\s|$)/u;

/** A reference key: kind, a colon, then the number text. */
const REFERENCE_KEY = /^(footnote|figure|table|section):(.+)$/u;

/** A dotted section path inside a label. */
const SECTION_PATH = /\d{1,3}(?:\.\d{1,3})*/u;

/** An integer inside a label. */
const NUMBER_TEXT = /\d{1,3}/u;

/** Fixed order for occurrences that start at the same character. */
const KIND_ORDER: Record<LinkKind, number> = { footnote: 0, figure: 1, table: 2, section: 3 };

/** Block types that carry a label of their own and therefore never refer to anything. */
const LABELLING_TYPES: ReadonlySet<SemanticBlockType> = new Set<SemanticBlockType>([
  'heading',
  'figure',
  'table',
  'caption',
  'formula',
  'footnote',
]);

/** One reference found at a position inside one block's text. */
interface Occurrence {
  /** Offset of the reference inside the block's text. */
  start: number;
  kind: LinkKind;
  label: string;
  /** Digits (or dotted digits for a section) to look up. */
  numberText: string;
  /**
   * Weak evidence: counted when it resolves, dropped when it does not. Only a bare
   * number block is weak, because a lone digit is not proof of a footnote.
   */
  weak: boolean;
}

/** A half-open character range inside a block's text. */
interface Span {
  start: number;
  end: number;
}

/** A block after defaults are applied. */
interface PreparedBlock {
  id: string;
  type: SemanticBlockType;
  page: number;
  text: string;
  headingLevel: number;
}

/** A footnote block and the number it answers to. */
interface FootnoteRecord {
  id: string;
  page: number;
  number: number;
}

/** A caption-carrying block and the number it answers to. */
interface CaptionRecord {
  id: string;
  page: number;
  kind: CaptionTargetKind;
  number: number;
}

/** Anything that can be ranked by page distance. */
interface PageCandidate {
  id: string;
  page: number;
}

/** Everything the resolvers need, computed once per document. */
interface Context {
  footnotes: FootnoteRecord[];
  captions: CaptionRecord[];
  sections: TocEntry[];
}

/** A reference that resolved, or one that did not. Exactly one field is set. */
interface Outcome {
  link?: Link;
  unresolved?: UnresolvedLink;
}

/**
 * Recovers every footnote, figure, table and section reference in `blocks`.
 *
 * Blocks are walked in reading order; within a block, references are ordered by their
 * position in the text, and a repeated reference is folded into the first one. Every
 * reference produces exactly one entry in `links` or in `unresolved`. The input array
 * and its blocks are only read.
 */
export function extractLinks(
  blocks: readonly LinkInputBlock[],
  options: ExtractLinksOptions = {},
): ExtractLinksResult {
  const prepared = prepare(blocks);
  const supplied = typeof options === 'object' && options !== null ? options.outline : undefined;
  const context: Context = {
    footnotes: footnoteRecords(prepared),
    captions: captionRecords(prepared),
    sections: sectionEntries(supplied ?? outlineOf(prepared)),
  };

  const links: Link[] = [];
  const unresolved: UnresolvedLink[] = [];

  for (const block of prepared) {
    if (LABELLING_TYPES.has(block.type)) continue;
    for (const occurrence of occurrencesOf(block)) {
      const outcome = resolve(occurrence, block, context);
      if (outcome.link !== undefined) {
        links.push(outcome.link);
      } else if (!occurrence.weak && outcome.unresolved !== undefined) {
        unresolved.push(outcome.unresolved);
      }
    }
  }

  return { links, unresolved };
}

/**
 * Rewrites the ids and reference labels a set of links names, for a document that was
 * merged or renumbered.
 *
 * `mapping.blocks` and `mapping.sections` are renames, applied to every id the link
 * names (the source block included). An id with no entry is left alone: the map only
 * rewrites what it names, it never filters. `mapping.references` renumbers the printed
 * reference: the key is the normalised form of the label (`figure:3`, `footnote:1`,
 * `section:2.1`) and the number inside the label is replaced, so `Figure 3` becomes
 * `Figure 5`. A reference entry whose new key changes the kind is ignored, because the
 * label and the target would then disagree about what is being pointed at.
 *
 * The input array and its links are not mutated; a new array of new objects is
 * returned, and every link keeps its position.
 */
export function renumberLinks(links: readonly Link[], mapping: LinkRenumberMap = {}): Link[] {
  const map: LinkRenumberMap = typeof mapping === 'object' && mapping !== null ? mapping : {};
  const blockMap = toMap(map.blocks);
  const sectionMap = toMap(map.sections);
  const referenceMap = toMap(map.references);
  const renamed: Link[] = [];

  for (const link of Array.isArray(links) ? links : []) {
    if (typeof link !== 'object' || link === null) continue;
    const next: Link = { ...link };
    next.fromBlockId = rename(next.fromBlockId, blockMap);
    if (typeof link.targetBlockId === 'string') next.targetBlockId = rename(link.targetBlockId, blockMap);
    if (typeof link.targetSectionId === 'string') next.targetSectionId = rename(link.targetSectionId, sectionMap);

    const reference = linkReference(link);
    const replacement = reference.length > 0 ? referenceMap.get(reference) : undefined;
    if (replacement !== undefined) {
      const parsed = parseReference(replacement);
      if (parsed !== null && parsed.kind === link.kind) next.label = relabel(link, parsed.numberText);
    }

    renamed.push(next);
  }

  return renamed;
}

/**
 * The normalised key of a link's reference: `footnote:1` for `[1]`, `figure:3` for
 * `Figure 3`, `section:2.1` for `section 2.1`. This is the key
 * {@link renumberLinks} remaps. A label without the expected number yields the empty
 * string, which never matches a mapping entry.
 */
export function linkReference(link: Link): string {
  if (typeof link !== 'object' || link === null) return '';
  const label = typeof link.label === 'string' ? link.label : '';
  if (link.kind === 'section') {
    const path = firstMatch(SECTION_PATH, label);
    return path === null ? '' : `section:${path}`;
  }
  const number = firstMatch(NUMBER_TEXT, label);
  return number === null ? '' : `${link.kind}:${number}`;
}

/**
 * Writes a Markdown fragment that keeps each link reachable: one bullet per link,
 * `- [label](#block-id)`.
 *
 * The anchor is the target *block* id, because that is the only address that survives
 * a Markdown export: the exporter emits `<a id="p3-r1"></a>` before that block and the
 * link then resolves in any Markdown reader. A link with no block target is skipped
 * (there is nothing to anchor to), and a section anchor lives on the section's jump
 * block for the same reason. Bracket characters in the label are escaped, so `[1]`
 * cannot be read as a nested link.
 *
 * Lines follow the order of the source blocks in `ir` (its `readingOrder`), so the
 * fragment is stable across runs; a source block `ir` does not contain is written
 * last. The result has no trailing newline and is the empty string when nothing was
 * written.
 */
export function toMarkdownLinks(links: readonly Link[], ir: DocumentIR): string {
  const order = readingOrderOf(ir);
  const rows: MarkdownRow[] = [];

  (Array.isArray(links) ? links : []).forEach((link, index) => {
    if (typeof link !== 'object' || link === null) return;
    const target = typeof link.targetBlockId === 'string' ? link.targetBlockId : '';
    if (target.length === 0) return;
    const known = order.get(link.fromBlockId);
    rows.push({ link, href: target, index, order: known ?? 0, sorted: known !== undefined });
  });

  rows.sort(compareMarkdownRows);
  return rows.map(row => `- [${escapeMarkdownText(row.link.label)}](#${anchorOf(row.href)})`).join('\n');
}

/** One rendered Markdown row, with the reading-order key it sorts by. */
interface MarkdownRow {
  link: Link;
  href: string;
  index: number;
  order: number;
  /** False when `ir` does not know the source block; those rows go last. */
  sorted: boolean;
}

// --- Resolution ------------------------------------------------------------

function resolve(occurrence: Occurrence, block: PreparedBlock, context: Context): Outcome {
  if (occurrence.kind === 'footnote') return resolveFootnote(occurrence, block, context);
  if (occurrence.kind === 'section') return resolveSection(occurrence, block, context);
  return resolveCaption(occurrence, block, context);
}

function resolveFootnote(occurrence: Occurrence, block: PreparedBlock, context: Context): Outcome {
  const number = toNumber(occurrence.numberText);
  const matching = number === null ? [] : context.footnotes.filter(candidate => candidate.number === number);
  if (matching.length === 0) {
    return { unresolved: unresolvedLink(block, occurrence, 'no-footnote', []) };
  }

  const reachable = matching.filter(candidate => Math.abs(candidate.page - block.page) <= FOOTNOTE_PAGE_REACH);
  if (reachable.length === 0) {
    return {
      unresolved: unresolvedLink(block, occurrence, 'footnote-out-of-reach', matching.map(candidate => candidate.id)),
    };
  }

  const closest = closestByPage(reachable, block.page);
  const target = closest[0];
  if (closest.length > 1 || target === undefined) {
    return {
      unresolved: unresolvedLink(block, occurrence, 'ambiguous-footnote', closest.map(candidate => candidate.id)),
    };
  }

  return {
    link: {
      fromBlockId: block.id,
      kind: 'footnote',
      targetBlockId: target.id,
      label: occurrence.label,
      page: block.page,
    },
  };
}

function resolveCaption(occurrence: Occurrence, block: PreparedBlock, context: Context): Outcome {
  const kind = occurrence.kind as CaptionTargetKind;
  const number = toNumber(occurrence.numberText);
  const matching =
    number === null
      ? []
      : context.captions.filter(candidate => candidate.kind === kind && candidate.number === number);
  if (matching.length === 0) {
    return { unresolved: unresolvedLink(block, occurrence, 'no-caption', []) };
  }

  // A figure number is normally unique in the document, so a caption on another page
  // is the right answer; page distance only settles duplicated numbering.
  const closest = closestByPage(matching, block.page);
  const target = closest[0];
  if (closest.length > 1 || target === undefined) {
    return { unresolved: unresolvedLink(block, occurrence, 'ambiguous-caption', closest.map(candidate => candidate.id)) };
  }

  return {
    link: {
      fromBlockId: block.id,
      kind,
      targetBlockId: target.id,
      label: occurrence.label,
      page: block.page,
    },
  };
}

function resolveSection(occurrence: Occurrence, block: PreparedBlock, context: Context): Outcome {
  const matching = context.sections.filter(entry => entry.path === occurrence.numberText);
  if (matching.length === 0) {
    return { unresolved: unresolvedLink(block, occurrence, 'no-section', []) };
  }

  const target = matching[0];
  if (matching.length > 1 || target === undefined) {
    return { unresolved: unresolvedLink(block, occurrence, 'ambiguous-section', matching.map(entry => entry.id)) };
  }

  const link: Link = {
    fromBlockId: block.id,
    kind: 'section',
    targetSectionId: target.id,
    label: occurrence.label,
    page: block.page,
  };
  if (typeof target.blockId === 'string' && target.blockId.length > 0) link.targetBlockId = target.blockId;
  return { link };
}

function unresolvedLink(
  block: PreparedBlock,
  occurrence: Occurrence,
  reason: UnresolvedLinkReason,
  candidateIds: readonly string[],
): UnresolvedLink {
  return {
    fromBlockId: block.id,
    kind: occurrence.kind,
    label: occurrence.label,
    page: block.page,
    reason,
    reference: `${occurrence.kind}:${occurrence.numberText}`,
    candidateIds: [...candidateIds],
  };
}

/** The candidates at the smallest page distance from `page`, in reading order. */
function closestByPage<T extends PageCandidate>(candidates: readonly T[], page: number): T[] {
  let closest = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    closest = Math.min(closest, Math.abs(candidate.page - page));
  }
  return candidates.filter(candidate => Math.abs(candidate.page - page) === closest);
}

// --- Scanning --------------------------------------------------------------

/** Every reference in one block, ordered by position and folded by target. */
function occurrencesOf(block: PreparedBlock): Occurrence[] {
  const text = block.text;
  if (text.trim().length === 0) return [];

  // A superscript that survived extraction as its own block: the whole text is a
  // marker. It is weak evidence, so it only counts when it resolves.
  const bare = BARE_MARKER.exec(text.trim());
  if (bare !== null) {
    const digits = bare[1] ?? '';
    if (digits.length > 0) {
      return [{ start: 0, kind: 'footnote', label: text.trim(), numberText: digits, weak: true }];
    }
  }

  const occurrences: Occurrence[] = [];
  const spans: Span[] = [];

  for (const match of text.matchAll(CAPTION_REFERENCE)) {
    const kind = captionKindOf(match[1] ?? '');
    const number = match[2] ?? '';
    if (kind === null || number.length === 0) continue;
    const start = match.index ?? 0;
    occurrences.push({ start, kind, label: match[0], numberText: number, weak: false });
    spans.push({ start, end: start + match[0].length });
  }

  for (const match of text.matchAll(SECTION_REFERENCE)) {
    const path = match[1] ?? '';
    if (path.length === 0) continue;
    const start = match.index ?? 0;
    occurrences.push({ start, kind: 'section', label: match[0], numberText: path, weak: false });
    spans.push({ start, end: start + match[0].length });
  }

  for (const match of text.matchAll(BRACKET_MARKER)) {
    const number = match[1] ?? '';
    if (number.length === 0) continue;
    const start = match.index ?? 0;
    occurrences.push({ start, kind: 'footnote', label: match[0], numberText: number, weak: false });
    spans.push({ start, end: start + match[0].length });
  }

  const trailing = trailingMarker(text, spans);
  if (trailing !== null) occurrences.push(trailing);

  occurrences.sort(compareOccurrences);
  return foldRepeats(occurrences);
}

/**
 * Reads the trailing superscript form, if the end of the text really is one. A
 * reference already scanned out of the same text owns its digits, so `Figure 3` never
 * also produces a footnote marker.
 */
function trailingMarker(text: string, spans: readonly Span[]): Occurrence | null {
  const match = TRAILING_MARKER.exec(text);
  if (match === null) return null;

  const prefix = match[1] ?? '';
  const digits = match[2] ?? '';
  if (digits.length === 0) return null;

  const start = (match.index ?? 0) + prefix.length;
  const end = start + digits.length;

  // `3.5` and `1,000` are one number: the separator belongs to the number, not to a
  // sentence that the marker follows.
  const before = text.slice(Math.max(0, start - 1), start);
  if (isDigit(before) && (prefix.startsWith('.') || prefix.startsWith(','))) return null;
  if (DECIMAL_TAIL.test(text) || ENUMERATION_TAIL.test(text)) return null;
  if (spans.some(span => start < span.end && end > span.start)) return null;

  return { start, kind: 'footnote', label: digits, numberText: digits, weak: false };
}

function compareOccurrences(left: Occurrence, right: Occurrence): number {
  if (left.start !== right.start) return left.start - right.start;
  if (KIND_ORDER[left.kind] !== KIND_ORDER[right.kind]) {
    return KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
  }
  if (left.numberText !== right.numberText) return left.numberText < right.numberText ? -1 : 1;
  return 0;
}

/** Keeps the first occurrence of each target, so a repeated reference is one link. */
function foldRepeats(occurrences: readonly Occurrence[]): Occurrence[] {
  const seen = new Set<string>();
  const kept: Occurrence[] = [];
  for (const occurrence of occurrences) {
    const key = `${occurrence.kind}:${occurrence.numberText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(occurrence);
  }
  return kept;
}

// --- Records ---------------------------------------------------------------

function prepare(blocks: readonly LinkInputBlock[] | undefined): PreparedBlock[] {
  const list = Array.isArray(blocks) ? blocks : [];
  const prepared: PreparedBlock[] = [];
  const rankByPage = new Map<number, number>();

  for (const block of list) {
    if (typeof block !== 'object' || block === null) continue;
    const page = pageOf(block);
    const rank = rankByPage.get(page) ?? 0;
    rankByPage.set(page, rank + 1);
    prepared.push({
      id: nonEmpty(block.id) ?? `p${page}-r${rank}`,
      type: normalizeType(block.type),
      page,
      text: textOf(block),
      headingLevel: headingLevelOf(block.headingLevel),
    });
  }

  return prepared;
}

function footnoteRecords(blocks: readonly PreparedBlock[]): FootnoteRecord[] {
  const records: FootnoteRecord[] = [];
  for (const block of blocks) {
    if (block.type !== 'footnote') continue;
    const ordinal = records.length + 1;
    const label = leadingNumber(block.text);
    records.push({ id: block.id, page: block.page, number: label ?? ordinal });
  }
  return records;
}

function captionRecords(blocks: readonly PreparedBlock[]): CaptionRecord[] {
  const records: CaptionRecord[] = [];
  const ordinals: Record<CaptionTargetKind, number> = { figure: 0, table: 0 };

  for (const block of blocks) {
    if (block.type === 'figure' || block.type === 'table') {
      const kind = block.type;
      ordinals[kind] += 1;
      const label = captionLabelOf(block.text);
      const number = label !== undefined && label.kind === kind ? label.number : ordinals[kind];
      records.push({ id: block.id, page: block.page, kind, number });
      continue;
    }
    if (block.type !== 'caption') continue;
    // A `caption` block has no kind of its own, so only its own label can place it.
    const label = captionLabelOf(block.text);
    if (label === undefined) continue;
    records.push({ id: block.id, page: block.page, kind: label.kind, number: label.number });
  }

  return records;
}

/** The outline a caller did not supply, built from the blocks themselves. */
function outlineOf(blocks: readonly PreparedBlock[]): Outline {
  return buildOutline(
    blocks.map(block => ({
      id: block.id,
      page: block.page,
      text: block.text,
      type: block.type,
      headingLevel: block.headingLevel,
    })),
  );
}

function sectionEntries(outline: Outline | undefined): TocEntry[] {
  if (typeof outline !== 'object' || outline === null) return [];
  const entries = Array.isArray(outline.toc) && outline.toc.length > 0 ? outline.toc : flattenOutline(outline);
  return entries.filter(
    entry =>
      typeof entry === 'object' && entry !== null && typeof entry.path === 'string' && entry.path.length > 0,
  );
}

// --- Small readers ---------------------------------------------------------

/** Reads the number and kind out of a leading caption label, if there is one. */
function captionLabelOf(text: string): { kind: CaptionTargetKind; number: number } | undefined {
  const match = CAPTION_LABEL.exec(firstLine(text));
  if (match === null) return undefined;
  const kind = captionKindOf(match[1] ?? '');
  const number = toNumber(match[2] ?? '');
  if (kind === null || number === null) return undefined;
  return { kind, number };
}

function captionKindOf(word: string): CaptionTargetKind | null {
  const normalized = word.toLowerCase();
  if (normalized.startsWith('table') || normalized.startsWith('bảng')) return 'table';
  if (normalized.startsWith('fig') || normalized.startsWith('hình')) return 'figure';
  return null;
}

/** A footnote's own number from the start of its text, if it carries one. */
function leadingNumber(text: string): number | undefined {
  const match = FOOTNOTE_LABEL.exec(firstLine(text));
  if (match === null) return undefined;
  return toNumber(match[1] ?? '') ?? undefined;
}

function firstLine(text: string): string {
  if (typeof text !== 'string') return '';
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

function textOf(block: LinkInputBlock): string {
  if (typeof block.text === 'string') return block.text;
  return typeof block.raw === 'string' ? block.raw : '';
}

function normalizeType(value: SemanticBlockType | BlockType | undefined): SemanticBlockType {
  return typeof value === 'string' && (SEMANTIC_BLOCK_TYPES as readonly string[]).includes(value)
    ? (value as SemanticBlockType)
    : 'other';
}

function pageOf(block: LinkInputBlock): number {
  const page = block.page;
  return typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : 1;
}

/** Clamps a requested heading level the same way `outline.ts` does. */
function headingLevelOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(MAX_HEADING_LEVEL, Math.max(1, Math.round(value)));
}

function toNumber(text: string): number | null {
  if (!/^\d{1,3}$/u.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return Number.isInteger(value) ? value : null;
}

// --- Renumbering -----------------------------------------------------------

function toMap(source: Readonly<Record<string, string>> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof source !== 'object' || source === null) return map;
  for (const [key, value] of Object.entries(source)) {
    if (key.length === 0) continue;
    if (typeof value !== 'string' || value.length === 0) continue;
    map.set(key, value);
  }
  return map;
}

function rename(id: string, map: ReadonlyMap<string, string>): string {
  return map.get(id) ?? id;
}

function parseReference(key: string): { kind: LinkKind; numberText: string } | null {
  const match = REFERENCE_KEY.exec(key);
  if (match === null) return null;
  const kind = match[1] as LinkKind;
  const numberText = match[2] ?? '';
  if (numberText.length === 0) return null;
  const valid =
    kind === 'section' ? /^\d{1,3}(?:\.\d{1,3})*$/u.test(numberText) : /^\d{1,3}$/u.test(numberText);
  return valid ? { kind, numberText } : null;
}

/** Replaces the old number inside the label with the new one. */
function relabel(link: Link, numberText: string): string {
  const label = typeof link.label === 'string' ? link.label : '';
  const pattern = link.kind === 'section' ? SECTION_PATH : NUMBER_TEXT;
  const previous = firstMatch(pattern, label);
  if (previous === null) return label;
  const at = label.indexOf(previous);
  if (at === -1) return label;
  return `${label.slice(0, at)}${numberText}${label.slice(at + previous.length)}`;
}

// --- Markdown --------------------------------------------------------------

function readingOrderOf(ir: DocumentIR | undefined): Map<string, number> {
  const order = new Map<string, number>();
  if (typeof ir !== 'object' || ir === null) return order;
  const blocks = Array.isArray(ir.blocks) ? ir.blocks : [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    if (typeof block.id !== 'string' || order.has(block.id)) continue;
    order.set(block.id, typeof block.readingOrder === 'number' ? block.readingOrder : order.size);
  }
  return order;
}

function compareMarkdownRows(left: MarkdownRow, right: MarkdownRow): number {
  if (left.sorted !== right.sorted) return left.sorted ? -1 : 1;
  if (left.order !== right.order) return left.order - right.order;
  if (left.link.page !== right.link.page) return left.link.page - right.link.page;
  if (left.link.fromBlockId !== right.link.fromBlockId) {
    return left.link.fromBlockId < right.link.fromBlockId ? -1 : 1;
  }
  return left.index - right.index;
}

/** Escapes the characters that would otherwise open a nested link. */
function escapeMarkdownText(text: string): string {
  return typeof text === 'string' ? text.replace(/[\\[\]]/gu, character => `\\${character}`) : '';
}

/**
 * Keeps an ASCII block id verbatim, since that is what the exporter writes into its
 * `<a id>`; anything else is percent-encoded so it cannot end the link destination.
 */
function anchorOf(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/gu, character => encodeURIComponent(character));
}

// --- Primitives ------------------------------------------------------------

function firstMatch(pattern: RegExp, text: string): string | null {
  const match = pattern.exec(text);
  return match === null ? null : match[0];
}

function isDigit(value: string): boolean {
  return value.length === 1 && value >= '0' && value <= '9';
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
