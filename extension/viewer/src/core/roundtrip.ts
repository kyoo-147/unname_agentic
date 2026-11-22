/**
 * Round-trip proof for the Document IR (backlog item N01).
 *
 * Exporting a document is only half a promise; the other half is that the export can be read
 * back — by this app, and by whatever tool it was handed to — without silently losing or
 * reshaping what the reader saw. Prose cannot prove that, so this module measures it.
 *
 * Two entry points, deliberately kept apart:
 *
 * - {@link compareDocuments} answers "are these two documents the same, and if not, where
 *   exactly do they differ?". It walks both documents field by field and returns one record
 *   per difference, each with a path, the two values it found and a kind. It is the
 *   primitive; it knows nothing about codecs.
 * - {@link checkRoundTrip} runs one encode/decode pair over a document and reports what did
 *   not survive. A codec that cannot carry some field declares that up front (a
 *   {@link CodecLimitation}); a declared loss is expected and does not fail the round trip,
 *   while the same loss without a declaration is a difference. That is the whole point of the
 *   item: loss must be a statement, not a surprise.
 *
 * This is not `diff.ts`. `diffDocuments` answers an editorial question — what did an editor
 * change between two revisions — and deliberately tolerates reflow, case changes and
 * similarity so that a reader sees edits, not noise. This module answers a conformance
 * question — did the bytes that came back still carry every field we put in — and therefore
 * compares exactly by default and names the field that moved.
 *
 * Contract:
 *
 * - **Pure and deterministic.** No clock, no randomness, no DOM, no locale, no I/O, no
 *   dependency. The same inputs always produce the same differences, in the same order.
 * - **Nothing is repaired and nothing is accepted on faith.** Each difference carries the
 *   values that produced it, so a caller can log or show it without running the comparison
 *   again.
 * - **`equal` means "no difference this module knows how to see".** It is not a claim that
 *   two documents are byte-identical: key order and properties that are not part of the
 *   documented IR are not compared, because they are not what a round trip has to preserve.
 *   Every documented top-level field is compared — including annotations and export records —
 *   so no serialised content is outside the verdict.
 * - **Comparison does not validate.** A document with an orphan translation or an unknown page
 *   is compared, not refused; `validate` from `ir.ts` is the function for that question.
 *   Inputs are read defensively (a missing array is empty, a non-object entry is skipped), so
 *   a broken decode produces differences instead of a crash.
 * - **A duplicate key keeps its first occurrence.** Page indices, block ids, translation keys,
 *   provenance keys, annotation ids and export ids are identities; a document that repeats one
 *   is invalid and `validate` reports it, so the comparison does not try to choose.
 * - **Translations and provenance are keyed by block id**, matching `addTranslation` and
 *   `addProvenance`. A codec that renumbers block ids must renumber those references too;
 *   otherwise the rows are reported as added and missing even though their text survived. That
 *   is deliberate: a translation pointing at a block that no longer exists is a real loss, and
 *   silently re-attaching it by text would be this module guessing on the reader's behalf.
 * - **Paths name the before document wherever it has the record**, and the after document for
 *   records only it has. The exact grammar is documented on {@link DocumentDifference.path}.
 */

import type {
  Annotation,
  Block,
  DocumentIR,
  ExportRecord,
  Page,
  Point,
  Provenance,
  Translation,
} from './ir';

// --- Tolerance -------------------------------------------------------------

/**
 * Slack allowed on a measured number before it counts as different, in the units of the
 * measurement: page points, or a 0..1 confidence score.
 *
 * 0.01 is one hundredth of a PDF point — about a third of a printer dot at 300 dpi — and one
 * percent of a confidence score. It exists because formats that store a coordinate as an
 * integer (tenths of a point, a fixed-point matrix, a percentage) round by less than this, and
 * reporting every rounded coordinate as a loss would drown the real one. It is deliberately
 * tight: one whole point of page geometry is a visible shift, a rounding artefact is not.
 *
 * Applied to `Page.width`, `Page.height`, every `Block.polygon` coordinate and
 * `Block.confidence`. Everything else — page index, rotation, reading order, page count,
 * export byte length — is an integer or an identifier and is compared exactly, because a
 * tolerance there would hide a wrong value that is not a rounding.
 *
 * A caller can tighten or widen it; see {@link CompareOptions.tolerance}.
 */
export const ROUNDTRIP_DEFAULT_TOLERANCE = 0.01;

// --- Differences -----------------------------------------------------------

/**
 * How text is compared: block text, translation text and annotation text.
 *
 * - `exact` (the default): UTF-16 code unit for code unit. This is the strict answer, and the
 *   one a round-trip proof needs, because a codec that re-spaces a paragraph has changed what
 *   a copy from the page produces.
 * - `whitespace`: runs of whitespace collapse to one space and the ends are trimmed. Letter
 *   case, punctuation and Unicode composition are untouched. PDF extraction reflows a
 *   sentence across lines, so a codec that re-extracts text legitimately changes spacing
 *   without changing the words; folding case or codepoints as well would hide an edit a
 *   reader can see, so it does not.
 */
export type TextComparison = 'exact' | 'whitespace';

/**
 * What happened to one slot.
 *
 * - `changed`: the slot exists on both sides with different values.
 * - `missing`: the before document has the record; the after document does not.
 * - `added`: the after document has the record; the before document does not.
 * - `moved`: the same content was found on both sides under a different identity — a block id
 *   re-derived from new geometry, or a block that changed page. `before` and `after` hold the
 *   two identities and the path is the before slot.
 */
export type DifferenceKind = 'changed' | 'missing' | 'added' | 'moved';

/**
 * Which documented field a difference is about.
 *
 * The list is closed on purpose: it is what a codec declares it cannot carry (see
 * {@link CodecLimitation}), so adding a value is a schema change rather than a string a
 * producer can invent. Groups follow the document: header, pages, blocks, translations,
 * provenance, annotations, exports.
 */
export type DifferenceArea =
  | 'schema-version'
  | 'document-identity'
  | 'document-language'
  | 'page-presence'
  | 'page-size'
  | 'page-rotation'
  | 'block-presence'
  | 'block-id'
  | 'block-page'
  | 'block-type'
  | 'block-polygon'
  | 'block-order'
  | 'block-text'
  | 'block-language'
  | 'block-confidence'
  | 'block-children'
  | 'translation-presence'
  | 'translation-text'
  | 'translation-version'
  | 'translation-qa'
  | 'provenance-presence'
  | 'provenance-link'
  | 'provenance-model'
  | 'annotation-presence'
  | 'annotation-content'
  | 'export-presence'
  | 'export-content';

/** Every kind, in the order a summary reports it. */
export const DIFFERENCE_KINDS: readonly DifferenceKind[] = ['changed', 'missing', 'added', 'moved'];

/** Every area, in the order a summary reports it. */
export const DIFFERENCE_AREAS: readonly DifferenceArea[] = [
  'schema-version',
  'document-identity',
  'document-language',
  'page-presence',
  'page-size',
  'page-rotation',
  'block-presence',
  'block-id',
  'block-page',
  'block-type',
  'block-polygon',
  'block-order',
  'block-text',
  'block-language',
  'block-confidence',
  'block-children',
  'translation-presence',
  'translation-text',
  'translation-version',
  'translation-qa',
  'provenance-presence',
  'provenance-link',
  'provenance-model',
  'annotation-presence',
  'annotation-content',
  'export-presence',
  'export-content',
];

/**
 * One place where two documents disagree.
 *
 * `path` is stable and machine-readable, built from the document's own identities rather than
 * array positions so that two documents with different array order can still be compared:
 *
 * - a document-level field is bare: `schemaVersion`, `documentId`, `language`;
 * - a page is `pages[<1-based page number>]` — the page's own `index`, not its array position —
 *   and its fields are `pages[3].width`;
 * - a block is `blocks[<id>]`, a translation `translations[<blockId>/<lang>/<engine>]`, a
 *   provenance row `provenance[<blockId>/<transform>]`, an annotation `annotations[<id>]` and
 *   an export `exports[<id>]`;
 * - a polygon corner is `blocks[<id>].polygon[<corner>].x`;
 * - a key containing anything outside `A-Z a-z 0-9 _ - /` is written as a quoted JSON string
 *   inside the brackets (`blocks["p 1"]`), so a path is never ambiguous.
 */
export interface DocumentDifference {
  path: string;
  /** The value in the before document, or null when the record is only in the after one. */
  before: unknown;
  /** The value in the after document, or null when the record is only in the before one. */
  after: unknown;
  kind: DifferenceKind;
  area: DifferenceArea;
}

/** How a comparison reads text and how far a number may drift before it counts as changed. */
export interface CompareOptions {
  /**
   * Slack for measured numbers, in their own units. Defaults to
   * {@link ROUNDTRIP_DEFAULT_TOLERANCE}; `0` compares every coordinate exactly.
   */
  tolerance?: number;
  /** Text rule; defaults to `exact`. See {@link TextComparison}. */
  text?: TextComparison;
}

/** How many slots of each group the comparison looked at — not how many differed. */
export interface ComparisonTotals {
  /** Page indices present on either side. */
  pages: number;
  /** Block pairs matched, whichever pass matched them. */
  blocks: number;
  /** Translation keys present on either side. */
  translations: number;
  /** Provenance keys present on either side. */
  provenance: number;
  /** Annotation ids present on either side. */
  annotations: number;
  /** Export-record ids present on either side. */
  exports: number;
}

export interface ComparisonSummary {
  /** Number of differences; always equal to `differences.length`. */
  total: number;
  byKind: Record<DifferenceKind, number>;
  /** Every area, including the ones with no difference, so a report always has one shape. */
  byArea: Record<DifferenceArea, number>;
  compared: ComparisonTotals;
}

export interface DocumentComparison {
  /** True when there is no difference. See the module contract for what this does and does not claim. */
  equal: boolean;
  /** Differences in the documented order; empty when `equal`. */
  differences: DocumentDifference[];
  summary: ComparisonSummary;
}

// --- Round trip ------------------------------------------------------------

/**
 * A loss a codec admits before the round trip runs.
 *
 * `area` names the {@link DifferenceArea} the codec knows it cannot carry, or `'all'` for a
 * codec that only keeps text (a plain-text export). `reason` is one English sentence for the
 * report, in the same spirit as an export warning: it is what a person reads to understand why
 * the document came back smaller. It is never localised here.
 */
export interface CodecLimitation {
  area: DifferenceArea | 'all';
  reason: string;
}

/** A declaration as reported: what the codec said, and how often it actually mattered. */
export interface RoundTripLimitation extends CodecLimitation {
  /** Differences this declaration explained; `0` when this document never exercised it. */
  explained: number;
}

export interface RoundTripOptions {
  /**
   * What the codec cannot carry. A difference covered by one of these does not fail the round
   * trip and is counted on the declaration instead; anything else is a difference.
   */
  limitations?: readonly CodecLimitation[];
  /** Comparison settings; defaults are the documented ones. */
  compare?: CompareOptions;
}

export interface RoundTripReport {
  /** True when no difference is left unexplained. A declared loss does not make it false. */
  ok: boolean;
  /** Differences no declaration accounted for. Empty when `ok`. */
  differences: DocumentDifference[];
  /** Every declaration, in the order it was given, with the count it explained. */
  limitations: RoundTripLimitation[];
}

// --- Comparison ------------------------------------------------------------

/**
 * Compares two documents field by field.
 *
 * Order is fixed and documented, which is what makes a report reproducible: the header first
 * (`schemaVersion`, then the document's identity fields, then its language), then pages in
 * ascending page order, then blocks, then translations, provenance, annotations and exports.
 * Inside a group, records are visited in the before document's array order — a missing record
 * where it would have been — and records only the after document has follow them, in the after
 * document's order. Fields inside a record are visited in the order `ir.ts` documents them.
 *
 * Options are validated, not guessed: a negative or non-finite `tolerance`, or a text mode
 * that is not `exact` or `whitespace`, throws a `RangeError` rather than quietly falling back,
 * because a comparison that runs with the wrong rule looks like a passing one.
 */
export function compareDocuments(
  before: DocumentIR,
  after: DocumentIR,
  options: CompareOptions = {},
): DocumentComparison {
  const settings = readCompareOptions(options);
  const collector = new DifferenceCollector(settings);

  compareDocumentHeader(collector, before, after);
  comparePages(collector, before, after);
  compareBlocks(collector, settings, before, after);
  compareTranslations(collector, before, after);
  compareProvenance(collector, before, after);
  compareAnnotations(collector, before, after);
  compareExports(collector, before, after);

  return {
    equal: collector.differences.length === 0,
    differences: collector.differences,
    summary: summarize(collector),
  };
}

// --- The round trip --------------------------------------------------------

/**
 * Runs one codec over a document and reports what did not survive.
 *
 * Order of work: `encode`, then `decode`, then {@link compareDocuments} against the original.
 * A difference covered by a declared limitation is counted on that limitation and kept out of
 * `differences`; everything else is a difference and makes `ok` false. The first declaration
 * that covers a difference explains it, so `'all'` placed before a specific area takes the
 * credit — declarations are honoured in the order they were given.
 *
 * A codec that throws is not converted into a difference: an exception is a bug in the codec,
 * not a finding about the bytes, and wrapping it into `ok: false` would leave the caller no way
 * to see it. Callers that must not throw should catch around this call.
 *
 * `Payload` is whatever `encode` produces and `decode` consumes — a string, bytes, a JSON
 * value. The pair belongs to the caller; this module never inspects it.
 */
export function checkRoundTrip<Payload>(
  ir: DocumentIR,
  encode: (document: DocumentIR) => Payload,
  decode: (payload: Payload) => DocumentIR,
  options: RoundTripOptions = {},
): RoundTripReport {
  if (typeof encode !== 'function' || typeof decode !== 'function') {
    throw new TypeError('checkRoundTrip needs `encode` and `decode` functions.');
  }

  const declared = readLimitations(options.limitations);
  const decoded = decode(encode(ir));
  const comparison = compareDocuments(ir, decoded, options.compare);

  const explained = declared.map(() => 0);
  const differences: DocumentDifference[] = [];
  for (const difference of comparison.differences) {
    const index = declared.findIndex(limitation => covers(limitation.area, difference.area));
    if (index === -1) {
      differences.push(difference);
      continue;
    }
    explained[index] = (explained[index] ?? 0) + 1;
  }

  return {
    ok: differences.length === 0,
    differences,
    limitations: declared.map((limitation, index) => ({
      ...limitation,
      explained: explained[index] ?? 0,
    })),
  };
}

/** True when a declaration covers an area: either the whole document or that exact field. */
function covers(declared: DifferenceArea | 'all', area: DifferenceArea): boolean {
  return declared === 'all' || declared === area;
}

// --- Header ----------------------------------------------------------------

function compareDocumentHeader(
  collector: DifferenceCollector,
  before: DocumentIR,
  after: DocumentIR,
): void {
  // The optional chains are the runtime guard for a `decode` that returned nothing usable:
  // the comparison would report the field as missing rather than throw on the way there.
  collector.exact('schemaVersion', 'schema-version', before?.schemaVersion, after?.schemaVersion);
  collector.exact('documentId', 'document-identity', before?.documentId, after?.documentId);
  collector.exact('revisionId', 'document-identity', before?.revisionId, after?.revisionId);
  collector.exact('sourceSha256', 'document-identity', before?.sourceSha256, after?.sourceSha256);
  collector.exact('language', 'document-language', before?.language, after?.language);
}

// --- Pages -----------------------------------------------------------------

/**
 * Pages are matched by their own 1-based index, not by array position, so two documents that
 * list their pages differently still compare page to page. A page count difference is the sum
 * of the presence differences this produces: every index present on one side and not the other
 * is one `missing` or one `added` record at `pages[<index>]`, which is more useful than a bare
 * number because it says which page disappeared.
 */
function comparePages(collector: DifferenceCollector, before: DocumentIR, after: DocumentIR): void {
  const beforePages = pagesByIndex(records<Page>(before?.pages));
  const afterPages = pagesByIndex(records<Page>(after?.pages));
  const indices = [...new Set([...beforePages.keys(), ...afterPages.keys()])].sort(
    (left, right) => left - right,
  );

  for (const index of indices) {
    const beforePage = beforePages.get(index);
    const afterPage = afterPages.get(index);
    if (!beforePage && !afterPage) continue;
    collector.compared.pages += 1;

    const path = `pages[${index}]`;
    if (!beforePage) {
      collector.added(path, 'page-presence', afterPage);
      continue;
    }
    if (!afterPage) {
      collector.missing(path, 'page-presence', beforePage);
      continue;
    }

    collector.measure(`${path}.width`, 'page-size', beforePage.width, afterPage.width);
    collector.measure(`${path}.height`, 'page-size', beforePage.height, afterPage.height);
    collector.exact(`${path}.rotation`, 'page-rotation', beforePage.rotation, afterPage.rotation);
  }
}

/** Pages keyed by their own 1-based index; a duplicate keeps the first occurrence. */
function pagesByIndex(pages: readonly Page[]): Map<number, Page> {
  const byIndex = new Map<number, Page>();
  for (const page of pages) {
    if (typeof page.index !== 'number' || !Number.isFinite(page.index)) continue;
    if (!byIndex.has(page.index)) byIndex.set(page.index, page);
  }
  return byIndex;
}

// --- Blocks ----------------------------------------------------------------

/** How a block pair was found: by its own id, or by its text in one or two passes. */
interface BlockMatch {
  after: Block;
  matchedBy: 'id' | 'page-text' | 'text';
}

function compareBlocks(
  collector: DifferenceCollector,
  settings: CompareSettings,
  before: DocumentIR,
  after: DocumentIR,
): void {
  const beforeBlocks = records<Block>(before?.blocks);
  const afterBlocks = records<Block>(after?.blocks);
  const matches = matchBlocks(beforeBlocks, afterBlocks, settings);
  const matchedAfter = new Set<Block>();
  for (const match of matches.values()) matchedAfter.add(match.after);

  // Blocks are visited in the before document's order, so a report reads like the document;
  // blocks only the after document has follow, in its order.
  for (const block of beforeBlocks) {
    const path = `blocks[${slotKey(blockIdOf(block))}]`;
    const match = matches.get(block);
    if (!match) {
      collector.missing(path, 'block-presence', block);
      continue;
    }

    collector.compared.blocks += 1;
    const pageReported = compareBlockIdentity(collector, path, block, match);
    compareBlockFields(collector, path, block, match.after, pageReported);
  }

  for (const block of afterBlocks) {
    if (matchedAfter.has(block)) continue;
    collector.added(`blocks[${slotKey(blockIdOf(block))}]`, 'block-presence', block);
  }
}

/**
 * Pairs blocks in three passes: same id, then same page and text, then same text alone.
 *
 * The later passes are what keep a codec that re-derives ids from geometry — or reflows a block
 * onto another page — from reading as one removal plus one addition. Pairs are consumed in
 * order, so identical text repeated on a page always pairs left to right and the result is
 * deterministic.
 */
function matchBlocks(
  beforeBlocks: readonly Block[],
  afterBlocks: readonly Block[],
  settings: CompareSettings,
): Map<Block, BlockMatch> {
  const matches = new Map<Block, BlockMatch>();
  const taken = new Set<Block>();

  const afterById = new Map<string, Block>();
  for (const block of afterBlocks) {
    const id = blockIdOf(block);
    if (!afterById.has(id)) afterById.set(id, block);
  }
  for (const block of beforeBlocks) {
    const partner = afterById.get(blockIdOf(block));
    if (!partner || taken.has(partner)) continue;
    matches.set(block, { after: partner, matchedBy: 'id' });
    taken.add(partner);
  }

  const byPageText = new Map<string, Block[]>();
  for (const block of afterBlocks) {
    if (taken.has(block)) continue;
    append(byPageText, pageTextKey(block, settings), block);
  }
  for (const block of beforeBlocks) {
    if (matches.has(block)) continue;
    const partner = firstFree(byPageText.get(pageTextKey(block, settings)), taken);
    if (!partner) continue;
    matches.set(block, { after: partner, matchedBy: 'page-text' });
    taken.add(partner);
  }

  const byText = new Map<string, Block[]>();
  for (const block of afterBlocks) {
    if (taken.has(block)) continue;
    append(byText, textKey(block.raw, settings), block);
  }
  for (const block of beforeBlocks) {
    if (matches.has(block)) continue;
    const partner = firstFree(byText.get(textKey(block.raw, settings)), taken);
    if (!partner) continue;
    matches.set(block, { after: partner, matchedBy: 'text' });
    taken.add(partner);
  }

  return matches;
}

/**
 * Reports a changed identity as a move, and says whether `page` was already reported.
 *
 * A pair matched by id has no identity change to report — its page is compared as an ordinary
 * field, so a codec that keeps `p1-r0` on page 2 is told the page changed rather than the block
 * moving. A pair matched by text has both an identity and possibly a location to report, and the
 * caller then skips the plain `page` field so the same fact is not counted twice.
 */
function compareBlockIdentity(
  collector: DifferenceCollector,
  path: string,
  beforeBlock: Block,
  match: BlockMatch,
): boolean {
  if (match.matchedBy === 'id') return false;

  const beforeId = blockIdOf(beforeBlock);
  const afterId = blockIdOf(match.after);
  if (beforeId !== afterId) {
    collector.moved(`${path}.id`, 'block-id', beforeId, afterId);
  }
  if (beforeBlock.page !== match.after.page) {
    collector.moved(`${path}.page`, 'block-page', beforeBlock.page, match.after.page);
    return true;
  }
  return false;
}

function compareBlockFields(
  collector: DifferenceCollector,
  path: string,
  beforeBlock: Block,
  afterBlock: Block,
  pageReported: boolean,
): void {
  collector.exact(`${path}.type`, 'block-type', beforeBlock.type, afterBlock.type);
  if (!pageReported) {
    collector.exact(`${path}.page`, 'block-page', beforeBlock.page, afterBlock.page);
  }
  comparePolygon(collector, `${path}.polygon`, beforeBlock.polygon, afterBlock.polygon);
  collector.exact(`${path}.readingOrder`, 'block-order', beforeBlock.readingOrder, afterBlock.readingOrder);
  collector.prose(`${path}.raw`, 'block-text', beforeBlock.raw, afterBlock.raw);
  collector.exact(`${path}.language`, 'block-language', beforeBlock.language, afterBlock.language);
  collector.measure(`${path}.confidence`, 'block-confidence', beforeBlock.confidence, afterBlock.confidence);
  compareIdList(collector, `${path}.children`, 'block-children', beforeBlock.children, afterBlock.children);
}

/**
 * Four corners, each coordinate compared under the tolerance; a shape mismatch is one finding.
 *
 * An identical reference on both sides is not a difference even when the value is not a valid
 * polygon: two malformed documents that say the same thing agree, and reporting that as a loss
 * would be noise about the fixture rather than about the codec.
 */
function comparePolygon(
  collector: DifferenceCollector,
  path: string,
  before: readonly Point[],
  after: readonly Point[],
): void {
  if (before === after) return;
  if (!Array.isArray(before) || !Array.isArray(after)) {
    collector.changed(path, 'block-polygon', before, after);
    return;
  }
  if (before.length !== after.length) {
    collector.changed(path, 'block-polygon', before, after);
    return;
  }

  for (let corner = 0; corner < before.length; corner += 1) {
    const beforePoint = before[corner];
    const afterPoint = after[corner];
    const cornerPath = `${path}[${corner}]`;
    if (!isPoint(beforePoint) || !isPoint(afterPoint)) {
      collector.changed(cornerPath, 'block-polygon', beforePoint, afterPoint);
      continue;
    }
    collector.measure(`${cornerPath}.x`, 'block-polygon', beforePoint.x, afterPoint.x);
    collector.measure(`${cornerPath}.y`, 'block-polygon', beforePoint.y, afterPoint.y);
  }
}

function isPoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as Point;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** An ordered id list (children, provenance sources) is one difference, not one per entry. */
function compareIdList(
  collector: DifferenceCollector,
  path: string,
  area: DifferenceArea,
  before: readonly string[],
  after: readonly string[],
): void {
  const beforeList = Array.isArray(before) ? before : [];
  const afterList = Array.isArray(after) ? after : [];
  if (sameStringList(beforeList, afterList)) return;
  collector.changed(path, area, before, after);
}

function sameStringList(before: readonly string[], after: readonly string[]): boolean {
  if (before.length !== after.length) return false;
  return before.every((value, index) => value === after[index]);
}

// --- Translations ----------------------------------------------------------

function compareTranslations(
  collector: DifferenceCollector,
  before: DocumentIR,
  after: DocumentIR,
): void {
  const beforeRows = records<Translation>(before?.translations);
  const afterRows = records<Translation>(after?.translations);
  const afterByKey = new Map<string, Translation>();
  for (const row of afterRows) {
    const key = translationKey(row);
    if (!afterByKey.has(key)) afterByKey.set(key, row);
  }

  const matched = new Set<string>();
  for (const row of beforeRows) {
    const key = translationKey(row);
    if (matched.has(key)) continue;
    matched.add(key);
    collector.compared.translations += 1;

    const partner = afterByKey.get(key);
    if (!partner) {
      collector.missing(translationPath(row), 'translation-presence', row);
      continue;
    }

    const path = translationPath(row);
    collector.exact(`${path}.modelVersion`, 'translation-version', row.modelVersion, partner.modelVersion);
    collector.exact(`${path}.promptVersion`, 'translation-version', row.promptVersion, partner.promptVersion);
    collector.prose(`${path}.text`, 'translation-text', row.text, partner.text);
    collector.exact(`${path}.qaStatus`, 'translation-qa', row.qaStatus, partner.qaStatus);
  }

  const reported = new Set<string>();
  for (const row of afterRows) {
    const key = translationKey(row);
    if (matched.has(key) || reported.has(key)) continue;
    reported.add(key);
    collector.compared.translations += 1;
    collector.added(translationPath(row), 'translation-presence', row);
  }
}

/** Same uniqueness rule as `addTranslation`: block, language and engine name one translation. */
function translationKey(row: Translation): string {
  return `${row.blockId}\u0000${row.lang}\u0000${row.engine}`;
}

function translationPath(row: Translation): string {
  return `translations[${slotKey(row.blockId)}/${slotKey(row.lang)}/${slotKey(row.engine)}]`;
}

// --- Provenance ------------------------------------------------------------

function compareProvenance(
  collector: DifferenceCollector,
  before: DocumentIR,
  after: DocumentIR,
): void {
  const beforeRows = records<Provenance>(before?.provenance);
  const afterRows = records<Provenance>(after?.provenance);
  const afterByKey = new Map<string, Provenance>();
  for (const row of afterRows) {
    const key = provenanceKey(row);
    if (!afterByKey.has(key)) afterByKey.set(key, row);
  }

  const matched = new Set<string>();
  for (const row of beforeRows) {
    const key = provenanceKey(row);
    if (matched.has(key)) continue;
    matched.add(key);
    collector.compared.provenance += 1;

    const partner = afterByKey.get(key);
    if (!partner) {
      collector.missing(provenancePath(row), 'provenance-presence', row);
      continue;
    }

    const path = provenancePath(row);
    compareIdList(collector, `${path}.sourceBlockIds`, 'provenance-link', row.sourceBlockIds, partner.sourceBlockIds);
    collector.exact(`${path}.ocrEngine`, 'provenance-model', row.ocrEngine, partner.ocrEngine);
    collector.exact(`${path}.model`, 'provenance-model', row.model, partner.model);
  }

  const reported = new Set<string>();
  for (const row of afterRows) {
    const key = provenanceKey(row);
    if (matched.has(key) || reported.has(key)) continue;
    reported.add(key);
    collector.compared.provenance += 1;
    collector.added(provenancePath(row), 'provenance-presence', row);
  }
}

/** Same uniqueness rule as `addProvenance`: block and transform name one row. */
function provenanceKey(row: Provenance): string {
  return `${row.blockId}\u0000${row.transform}`;
}

function provenancePath(row: Provenance): string {
  return `provenance[${slotKey(row.blockId)}/${slotKey(row.transform)}]`;
}

// --- Annotations and export records ----------------------------------------

function compareAnnotations(
  collector: DifferenceCollector,
  before: DocumentIR,
  after: DocumentIR,
): void {
  const beforeRows = records<Annotation>(before?.annotations);
  const afterRows = records<Annotation>(after?.annotations);
  const afterById = new Map<string, Annotation>();
  for (const row of afterRows) {
    const id = rowId(row);
    if (!afterById.has(id)) afterById.set(id, row);
  }

  const matched = new Set<string>();
  for (const row of beforeRows) {
    const id = rowId(row);
    if (matched.has(id)) continue;
    matched.add(id);
    collector.compared.annotations += 1;

    const path = `annotations[${slotKey(id)}]`;
    const partner = afterById.get(id);
    if (!partner) {
      collector.missing(path, 'annotation-presence', row);
      continue;
    }

    collector.exact(`${path}.page`, 'annotation-content', row.page, partner.page);
    collector.exact(`${path}.kind`, 'annotation-content', row.kind, partner.kind);
    collector.prose(`${path}.text`, 'annotation-content', row.text, partner.text);
    collector.exact(`${path}.createdAt`, 'annotation-content', row.createdAt, partner.createdAt);
  }

  const reported = new Set<string>();
  for (const row of afterRows) {
    const id = rowId(row);
    if (matched.has(id) || reported.has(id)) continue;
    reported.add(id);
    collector.compared.annotations += 1;
    collector.added(`annotations[${slotKey(id)}]`, 'annotation-presence', row);
  }
}

function compareExports(collector: DifferenceCollector, before: DocumentIR, after: DocumentIR): void {
  const beforeRows = records<ExportRecord>(before?.exports);
  const afterRows = records<ExportRecord>(after?.exports);
  const afterById = new Map<string, ExportRecord>();
  for (const row of afterRows) {
    const id = rowId(row);
    if (!afterById.has(id)) afterById.set(id, row);
  }

  const matched = new Set<string>();
  for (const row of beforeRows) {
    const id = rowId(row);
    if (matched.has(id)) continue;
    matched.add(id);
    collector.compared.exports += 1;

    const path = `exports[${slotKey(id)}]`;
    const partner = afterById.get(id);
    if (!partner) {
      collector.missing(path, 'export-presence', row);
      continue;
    }

    collector.exact(`${path}.format`, 'export-content', row.format, partner.format);
    collector.exact(`${path}.createdAt`, 'export-content', row.createdAt, partner.createdAt);
    collector.exact(`${path}.byteLength`, 'export-content', row.byteLength, partner.byteLength);
    collector.exact(`${path}.sha256`, 'export-content', row.sha256, partner.sha256);
  }

  const reported = new Set<string>();
  for (const row of afterRows) {
    const id = rowId(row);
    if (matched.has(id) || reported.has(id)) continue;
    reported.add(id);
    collector.compared.exports += 1;
    collector.added(`exports[${slotKey(id)}]`, 'export-presence', row);
  }
}

// --- Recording -------------------------------------------------------------

interface CompareSettings {
  tolerance: number;
  text: TextComparison;
}

/**
 * Collects differences in the order they are found and counts the slots that were compared.
 *
 * A class rather than a bag of functions because every group needs the same two settings and
 * the same growing list; threading those through six nearly identical signatures would be the
 * same coupling with more punctuation.
 */
class DifferenceCollector {
  private readonly settings: CompareSettings;
  readonly differences: DocumentDifference[] = [];
  readonly compared: ComparisonTotals = {
    pages: 0,
    blocks: 0,
    translations: 0,
    provenance: 0,
    annotations: 0,
    exports: 0,
  };

  constructor(settings: CompareSettings) {
    this.settings = settings;
  }

  /** Records a difference when two values are not identical. */
  exact(path: string, area: DifferenceArea, before: unknown, after: unknown): void {
    if (before === after) return;
    this.changed(path, area, before, after);
  }

  /** Records a difference when two numbers are further apart than the tolerance. */
  measure(path: string, area: DifferenceArea, before: number, after: number): void {
    if (before === after) return;
    if (Math.abs(before - after) <= this.settings.tolerance) return;
    this.changed(path, area, before, after);
  }

  /** Records a difference when two texts differ under the configured rule. */
  prose(path: string, area: DifferenceArea, before: unknown, after: unknown): void {
    if (sameText(before, after, this.settings.text)) return;
    this.changed(path, area, before, after);
  }

  changed(path: string, area: DifferenceArea, before: unknown, after: unknown): void {
    this.differences.push({ path, before, after, kind: 'changed', area });
  }

  missing(path: string, area: DifferenceArea, before: unknown): void {
    this.differences.push({ path, before, after: null, kind: 'missing', area });
  }

  added(path: string, area: DifferenceArea, after: unknown): void {
    this.differences.push({ path, before: null, after, kind: 'added', area });
  }

  moved(path: string, area: DifferenceArea, before: unknown, after: unknown): void {
    this.differences.push({ path, before, after, kind: 'moved', area });
  }
}

function summarize(collector: DifferenceCollector): ComparisonSummary {
  const byKind: Record<DifferenceKind, number> = { changed: 0, missing: 0, added: 0, moved: 0 };
  const byArea = emptyAreaCounts();
  for (const difference of collector.differences) {
    byKind[difference.kind] = (byKind[difference.kind] ?? 0) + 1;
    byArea[difference.area] = (byArea[difference.area] ?? 0) + 1;
  }
  return {
    total: collector.differences.length,
    byKind,
    byArea,
    compared: { ...collector.compared },
  };
}

function emptyAreaCounts(): Record<DifferenceArea, number> {
  const counts = {} as Record<DifferenceArea, number>;
  for (const area of DIFFERENCE_AREAS) counts[area] = 0;
  return counts;
}

// --- Reading inputs --------------------------------------------------------

/**
 * The object entries of an array field, or nothing.
 *
 * This is the whole guard between a comparison and a decode that returned garbage: a missing
 * array is empty and a primitive entry is skipped, so the report describes the loss instead of
 * the comparison crashing on it.
 */
function records<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is T => typeof entry === 'object' && entry !== null);
}

function blockIdOf(block: Block): string {
  return typeof block.id === 'string' ? block.id : '';
}

function rowId(row: { id?: unknown }): string {
  return typeof row.id === 'string' ? row.id : '';
}

function readCompareOptions(options: CompareOptions): CompareSettings {
  const tolerance = options?.tolerance ?? ROUNDTRIP_DEFAULT_TOLERANCE;
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError(
      `compareDocuments needs \`tolerance\` as a finite number of units, zero or more; it received ${String(tolerance)}.`,
    );
  }

  const text = options?.text ?? 'exact';
  if (text !== 'exact' && text !== 'whitespace') {
    throw new RangeError(
      `compareDocuments needs \`text\` to be "exact" or "whitespace"; it received ${String(text)}.`,
    );
  }

  return { tolerance, text };
}

/**
 * Reads the codec's declarations.
 *
 * A typo in an area name would otherwise explain nothing and look like a codec that silently
 * lost data, so an unknown area is refused instead of being kept. An empty reason is refused
 * too: a declaration a person cannot read is not a declaration.
 */
function readLimitations(value: readonly CodecLimitation[] | undefined): CodecLimitation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError('checkRoundTrip needs `limitations` as an array of { area, reason }.');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(
        `checkRoundTrip could not read the limitation at position ${index}; pass { area, reason }.`,
      );
    }

    const area: unknown = (entry as { area?: unknown }).area;
    if (area !== 'all' && !(DIFFERENCE_AREAS as readonly string[]).includes(String(area))) {
      throw new TypeError(
        `checkRoundTrip limitation at position ${index} names an unknown area ${String(area)}; ` +
          `use one of ${DIFFERENCE_AREAS.join(', ')} or "all".`,
      );
    }

    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (reason.length === 0) {
      throw new TypeError(
        `checkRoundTrip limitation at position ${index} needs a non-empty reason: it is what a reader sees.`,
      );
    }

    return { area: area as DifferenceArea | 'all', reason };
  });
}

// --- Small helpers ---------------------------------------------------------

/** Blocks pair on the same page and the same compared text. */
function pageTextKey(block: Block, settings: CompareSettings): string {
  return `${pageOf(block)}\u0000${textKey(block.raw, settings)}`;
}

function pageOf(block: Block): number {
  return Number.isInteger(block.page) && block.page > 0 ? block.page : 1;
}

/** The text a block is matched on: raw for `exact`, whitespace-folded for `whitespace`. */
function textKey(raw: unknown, settings: CompareSettings): string {
  const text = typeof raw === 'string' ? raw : '';
  return settings.text === 'whitespace' ? collapseWhitespace(text) : text;
}

function sameText(before: unknown, after: unknown, mode: TextComparison): boolean {
  if (typeof before !== 'string' || typeof after !== 'string') return before === after;
  return mode === 'whitespace'
    ? collapseWhitespace(before) === collapseWhitespace(after)
    : before === after;
}

/** Whitespace runs to one space, ends trimmed. Case and codepoints are left alone. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** A key safe to write inside `[...]` as it is; anything else is JSON-quoted. */
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_/-]+$/u;

function slotKey(key: string): string {
  return SAFE_KEY_PATTERN.test(key) ? key : JSON.stringify(key);
}

function firstFree(candidates: readonly Block[] | undefined, taken: ReadonlySet<Block>): Block | undefined {
  if (!candidates) return undefined;
  for (const candidate of candidates) {
    if (!taken.has(candidate)) return candidate;
  }
  return undefined;
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
