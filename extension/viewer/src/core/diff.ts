/**
 * Version-to-version document diff (backlog item H10).
 *
 * A reader that keeps two revisions of one document — a re-scan, a corrected OCR
 * pass, a re-export — wants to know what an editor actually changed, not a
 * character-level storm. This module answers that in two layers: {@link
 * diffDocuments} compares two `DocumentIR`s page by page and block by block and
 * classifies every change, and {@link diffWords} explains one edited block as word
 * runs a reader can render inline.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no locale, no I/O. Two
 *   equal input pairs always produce an equal diff, in the same order.
 * - Pages are aligned by index, never by content: page 3 of the old revision is
 *   compared with page 3 of the new one, and only the indices present on either side
 *   are listed. A page inserted before existing content therefore shifts every later
 *   block onto a different page number and is reported as a set of moves; content-based
 *   page alignment is deliberately not attempted here.
 * - Blocks are aligned inside one page by text, not by id or geometry, because block
 *   ids are positional (`p{page}-r{rank}`) and change whenever a paragraph is
 *   inserted. Two passes run per page: an exact pass over `matchKey` (the
 *   whitespace-collapsed, case-folded text key from `tm.ts`), then a similarity pass
 *   that reuses `scoreSimilarity` from `tm.ts` — the Jaccard index over word trigrams
 *   of those keys:
 *
 *       score("alpha beta gamma", "alpha beta delta") = 1/3
 *
 *   That is the same function the translation memory uses to decide that two
 *   segments are the same sentence, so "same block, edited" means the same thing in
 *   both places. Pairs are taken best-score-first, so a greedy choice can never
 *   steal the better partner of an earlier pair.
 * - A similarity pair needs {@link DIFF_CHANGE_MIN_SIMILARITY}. Two blocks sharing
 *   fewer than half of their word trigrams are reported as one `removed` plus one
 *   `added` block, not as one `changed` block: a two- or three-word block has too few
 *   trigrams to tell "edited" from "replaced", and saying nothing is safer than
 *   claiming an edit that did not happen. The same rule means a block whose text and
 *   page both changed is reported as removed plus added.
 * - Block text is compared with case and whitespace runs ignored, so OCR reflow and a
 *   case-only difference are `unchanged`. The text carried on a change record is
 *   always the verbatim `Block.raw`, so a reader can quote the page.
 * - A block that textually disappeared from one page and reappeared on another is
 *   `moved`. Moves are matched on the exact compared text (`matchKey`), never on
 *   similarity: a block that moved *and* was edited reads as removed plus added.
 * - A `moved` change belongs to the page the block arrived on (`page`) and names the
 *   page it left (`fromPage`), so each change is counted exactly once and
 *   {@link DiffSummary} equals the sum over `pages`.
 * - Blocks that only changed reading order inside one page are `unchanged`. Reflow
 *   jitter is exactly the noise this item is meant to suppress, and the IR does not
 *   promise a stable order for same-page blocks across revisions.
 * - Within a page, changes are listed top to bottom (`y`, then `x`) using the old
 *   box for `removed` and `changed` and the new box for `added` and `moved`, so the
 *   list reads in page order. Equal positions fall back to a fixed kind order and
 *   then to the block id.
 * - Every page index present on either side appears in `pages`, including pages
 *   without a single change, so a caller can see the whole document shape and the
 *   summary always adds up.
 */

import type { Block, DocumentIR } from './ir';
import { matchKey, scoreSimilarity } from './tm';

/**
 * Lowest word-trigram similarity at which two blocks on one page are read as the
 * same block, edited. Below it the pair is reported as removed plus added.
 */
export const DIFF_CHANGE_MIN_SIMILARITY = 0.5;

/**
 * Change runs shorter than this many characters are treated as scan noise: a lone
 * misread digit or letter is dropped from the run list instead of fragmenting it.
 */
export const DIFF_MIN_RUN_CHARS = 2;

/**
 * Largest token table `diffWords` will build. A block pair above it — a whole table
 * flattened into one block, typically — falls back to one delete run plus one insert
 * run instead of allocating a quadratic table. The prefix/suffix trim in `diffWords`
 * means the cap is measured on the differing middle only.
 */
export const DIFF_MAX_DP_CELLS = 1_000_000;

export type WordDiffKind = 'equal' | 'insert' | 'delete';

/** One run of a word-level diff. */
export interface WordDiffRun {
  kind: WordDiffKind;
  /**
   * Run text: its words joined by one space. There is never leading or trailing
   * whitespace, which is why a whitespace-only difference produces a single `equal`
   * run.
   */
  text: string;
}

export type BlockDiffKind = 'added' | 'removed' | 'changed' | 'moved';

/** A block that exists only in the newer revision. */
export interface AddedBlockDiff {
  kind: 'added';
  /** 1-based page the block is on in the newer revision. */
  page: number;
  afterBlockId: string;
  after: string;
}

/** A block that exists only in the older revision. */
export interface RemovedBlockDiff {
  kind: 'removed';
  /** 1-based page the block was on in the older revision. */
  page: number;
  beforeBlockId: string;
  before: string;
}

/** The same block on the same page, with edited text. */
export interface ChangedBlockDiff {
  kind: 'changed';
  page: number;
  beforeBlockId: string;
  afterBlockId: string;
  /** Verbatim old text. */
  before: string;
  /** Verbatim new text. */
  after: string;
  /** Word-trigram similarity of the two texts, 0..1, rounded to four decimals. */
  similarity: number;
  /** Word-level diff of `before` against `after`, noise collapsed. */
  words: WordDiffRun[];
}

/** The same text on a different page. */
export interface MovedBlockDiff {
  kind: 'moved';
  /** 1-based page the block arrived on. */
  page: number;
  beforeBlockId: string;
  afterBlockId: string;
  /** 1-based page the block left. */
  fromPage: number;
  /** Verbatim new text; equal to the old text up to case and whitespace. */
  text: string;
}

export type BlockDiff = AddedBlockDiff | RemovedBlockDiff | ChangedBlockDiff | MovedBlockDiff;

export type PageDiffStatus = 'both' | 'added' | 'removed';

/** One page of a document diff. */
export interface PageDiff {
  /** 1-based page number, from the union of both revisions' page lists. */
  page: number;
  /** Whether the page exists in both revisions, only the newer one, or only the older. */
  status: PageDiffStatus;
  /** Blocks that are byte-for-byte unchanged (up to case and whitespace) on this page. */
  unchanged: number;
  /** Changes on this page, in page order. */
  changes: BlockDiff[];
}

/** Totals over the whole diff; `unchanged` is the only count without a change record. */
export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  moved: number;
  unchanged: number;
}

export interface DocumentDiff {
  pages: PageDiff[];
  summary: DiffSummary;
}

/** A block reduced to what alignment and ordering need. */
interface BlockEntry {
  block: Block;
  /** Compared text key: whitespace collapsed, case folded. */
  key: string;
  page: number;
  readingOrder: number;
  /** Top edge of the block's polygon, in page points. */
  top: number;
  /** Left edge of the block's polygon, in page points. */
  left: number;
}

/** One revision's blocks, grouped by page. */
interface Side {
  byPage: Map<number, BlockEntry[]>;
  pages: Set<number>;
}

interface AlignedPair {
  before: BlockEntry;
  after: BlockEntry;
  /** True when the compared texts are equal, so the pair is unchanged. */
  same: boolean;
  similarity: number;
}

interface PageAlignment {
  pairs: AlignedPair[];
  /** Blocks on this page that found no partner on this page. */
  leftBefore: BlockEntry[];
  leftAfter: BlockEntry[];
}

interface ScoredPair {
  before: BlockEntry;
  after: BlockEntry;
  score: number;
}

interface MovedPair {
  before: BlockEntry;
  after: BlockEntry;
}

interface PositionedChange {
  change: BlockDiff;
  top: number;
  left: number;
  rank: number;
}

/** Word-level runs before they are joined into display strings. */
interface TokenRun {
  kind: WordDiffKind;
  tokens: string[];
}

/** Order used only when two changes share a position; documented, not meaningful. */
const KIND_RANK: Record<BlockDiffKind, number> = {
  changed: 0,
  moved: 1,
  removed: 2,
  added: 3,
};

/**
 * Compares two revisions of the same document.
 *
 * The result lists every page index present on either side, `summary` counts the
 * changes and the unchanged blocks, and nothing in the input is mutated. See the
 * module comment for the alignment rules and their limits.
 *
 * A missing `pages` or `blocks` array is read as empty rather than thrown on, so a
 * half-built document produces a diff instead of an exception; run `validate` from
 * `ir.ts` first when the document came from an untrusted source.
 */
export function diffDocuments(before: DocumentIR, after: DocumentIR): DocumentDiff {
  const left = readSide(before);
  const right = readSide(after);
  const pageNumbers = sortedPages(left.pages, right.pages);

  const pairsByPage = new Map<number, AlignedPair[]>();
  const leftOvers: BlockEntry[] = [];
  const rightOvers: BlockEntry[] = [];
  for (const page of pageNumbers) {
    const alignment = alignPage(left.byPage.get(page) ?? [], right.byPage.get(page) ?? []);
    pairsByPage.set(page, alignment.pairs);
    leftOvers.push(...alignment.leftBefore);
    rightOvers.push(...alignment.leftAfter);
  }

  // Everything still unpaired on both sides is either a move, a removal or an add.
  const moved = matchMoved(leftOvers, rightOvers);
  const movedByPage = new Map<number, MovedPair[]>();
  for (const pair of moved.moved) appendTo(movedByPage, pair.after.page, pair);
  const removedByPage = groupByPage(moved.leftRest);
  const addedByPage = groupByPage(moved.rightRest);

  const pages = pageNumbers.map(page => {
    const positioned: PositionedChange[] = [];
    let unchanged = 0;
    for (const pair of pairsByPage.get(page) ?? []) {
      if (pair.same) {
        unchanged += 1;
        continue;
      }
      positioned.push({
        change: changedDiff(pair),
        top: pair.before.top,
        left: pair.before.left,
        rank: KIND_RANK.changed,
      });
    }
    for (const pair of movedByPage.get(page) ?? []) {
      positioned.push({
        change: movedDiff(pair),
        top: pair.after.top,
        left: pair.after.left,
        rank: KIND_RANK.moved,
      });
    }
    for (const entry of removedByPage.get(page) ?? []) {
      positioned.push({
        change: { kind: 'removed', page, beforeBlockId: idOf(entry), before: textOf(entry) },
        top: entry.top,
        left: entry.left,
        rank: KIND_RANK.removed,
      });
    }
    for (const entry of addedByPage.get(page) ?? []) {
      positioned.push({
        change: { kind: 'added', page, afterBlockId: idOf(entry), after: textOf(entry) },
        top: entry.top,
        left: entry.left,
        rank: KIND_RANK.added,
      });
    }
    positioned.sort(comparePositioned);
    return {
      page,
      status: pageStatus(left.pages, right.pages, page),
      unchanged,
      changes: positioned.map(item => item.change),
    } satisfies PageDiff;
  });

  return { pages, summary: summarize(pages) };
}

/**
 * Diffs two texts word by word.
 *
 * Whitespace is normalised away first: words are runs separated by whitespace and
 * each run holds its words joined by one space, so a reflowed or re-spaced line
 * produces one `equal` run and no change at all.
 *
 * The word alignment is a longest-common-subsequence walk over the word tokens,
 * after the common prefix and suffix are trimmed off; ties prefer a delete over an
 * insert, so a replaced word always reads `delete` then `insert`. Runs are then
 * cleaned of scan noise: an `insert` or `delete` run shorter than
 * {@link DIFF_MIN_RUN_CHARS} characters is not a real edit, so an inserted fragment
 * is folded into the surrounding equal text (it is what the page now says) and a
 * deleted fragment is dropped (the page no longer has it). That is what keeps a
 * lone misread digit or letter from exploding the output.
 *
 * The runs are a reading aid, not a reversible encoding: because they are
 * whitespace-normalised, `equal + insert` reproduces `b` and `equal + delete`
 * reproduces `a` only up to spacing, and text folded away as noise is absent from
 * both. The verbatim strings are on the change record (`before`, `after`).
 */
export function diffWords(a: string, b: string): WordDiffRun[] {
  const left = tokensOf(a);
  const right = tokensOf(b);

  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const runs: TokenRun[] = [];
  pushTokens(runs, 'equal', left.slice(0, prefix));
  const middleLeft = left.slice(prefix, left.length - suffix);
  const middleRight = right.slice(prefix, right.length - suffix);
  for (const run of lcsRuns(middleLeft, middleRight)) pushTokens(runs, run.kind, run.tokens);
  pushTokens(runs, 'equal', left.slice(left.length - suffix));

  return runsToWords(collapseNoise(runs));
}

// --- Alignment -------------------------------------------------------------

/** Reads one revision into per-page blocks, in reading order. */
function readSide(ir: DocumentIR): Side {
  const byPage = new Map<number, BlockEntry[]>();
  const pages = new Set<number>();

  const pageRecords = Array.isArray(ir?.pages) ? ir.pages : [];
  for (const page of pageRecords) {
    const index = page?.index;
    if (typeof index === 'number' && Number.isInteger(index) && index > 0) pages.add(index);
  }

  const blocks = Array.isArray(ir?.blocks) ? ir.blocks : [];
  blocks.forEach((block, position) => {
    if (typeof block !== 'object' || block === null) return;
    const entry = toEntry(block, position);
    pages.add(entry.page);
    appendTo(byPage, entry.page, entry);
  });
  for (const list of byPage.values()) list.sort(compareEntries);

  return { byPage, pages };
}

function toEntry(block: Block, position: number): BlockEntry {
  const page = Number.isInteger(block.page) && block.page > 0 ? block.page : 1;
  const corners = topLeftOf(block);
  return {
    block,
    key: matchKey(rawOf(block)),
    page,
    readingOrder: Number.isInteger(block.readingOrder) ? block.readingOrder : position,
    top: corners.top,
    left: corners.left,
  };
}

function topLeftOf(block: Block): { top: number; left: number } {
  let top = Number.POSITIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  const points = Array.isArray(block.polygon) ? block.polygon : [];
  for (const point of points) {
    const x = finiteOr(point?.x, Number.POSITIVE_INFINITY);
    const y = finiteOr(point?.y, Number.POSITIVE_INFINITY);
    if (y < top) top = y;
    if (x < left) left = x;
  }
  return {
    top: Number.isFinite(top) ? top : 0,
    left: Number.isFinite(left) ? left : 0,
  };
}

/**
 * Pairs the blocks of one page: exact text first, then similar text best-first.
 * Similarity pairs that miss `DIFF_CHANGE_MIN_SIMILARITY` are never created, so the
 * leftovers are exactly the removals and additions on this page.
 */
function alignPage(before: readonly BlockEntry[], after: readonly BlockEntry[]): PageAlignment {
  const pairedBefore = new Set<BlockEntry>();
  const pairedAfter = new Set<BlockEntry>();
  const pairs: AlignedPair[] = [];

  const afterByKey = new Map<string, BlockEntry[]>();
  for (const entry of after) appendTo(afterByKey, entry.key, entry);

  for (const entry of before) {
    const candidates = afterByKey.get(entry.key);
    if (!candidates) continue;
    let partner: BlockEntry | undefined;
    for (const candidate of candidates) {
      if (pairedAfter.has(candidate)) continue;
      partner = candidate;
      break;
    }
    if (!partner) continue;
    pairedBefore.add(entry);
    pairedAfter.add(partner);
    pairs.push({ before: entry, after: partner, same: true, similarity: 1 });
  }

  const spareBefore = before.filter(entry => !pairedBefore.has(entry));
  const spareAfter = after.filter(entry => !pairedAfter.has(entry));
  const scored: ScoredPair[] = [];
  for (const left of spareBefore) {
    for (const right of spareAfter) {
      const score = scoreSimilarity(textOf(left), textOf(right));
      if (score < DIFF_CHANGE_MIN_SIMILARITY) continue;
      scored.push({ before: left, after: right, score });
    }
  }
  scored.sort(compareScored);

  for (const candidate of scored) {
    if (pairedBefore.has(candidate.before) || pairedAfter.has(candidate.after)) continue;
    pairedBefore.add(candidate.before);
    pairedAfter.add(candidate.after);
    pairs.push({
      before: candidate.before,
      after: candidate.after,
      same: false,
      similarity: round4(candidate.score),
    });
  }

  return {
    pairs,
    leftBefore: before.filter(entry => !pairedBefore.has(entry)),
    leftAfter: after.filter(entry => !pairedAfter.has(entry)),
  };
}

/**
 * Pairs leftovers whose compared text is identical but whose pages differ. A target
 * on the same page is skipped: same-page identical text would already have been
 * paired by the exact pass.
 */
function matchMoved(
  leftOvers: readonly BlockEntry[],
  rightOvers: readonly BlockEntry[],
): { moved: MovedPair[]; leftRest: BlockEntry[]; rightRest: BlockEntry[] } {
  const rightByKey = new Map<string, BlockEntry[]>();
  for (const entry of rightOvers) appendTo(rightByKey, entry.key, entry);

  const taken = new Set<BlockEntry>();
  const moved: MovedPair[] = [];
  const leftRest: BlockEntry[] = [];
  for (const entry of leftOvers) {
    const target = firstOffPage(rightByKey.get(entry.key), entry.page, taken);
    if (!target) {
      leftRest.push(entry);
      continue;
    }
    taken.add(target);
    moved.push({ before: entry, after: target });
  }
  return { moved, leftRest, rightRest: rightOvers.filter(entry => !taken.has(entry)) };
}

function firstOffPage(
  candidates: readonly BlockEntry[] | undefined,
  page: number,
  taken: ReadonlySet<BlockEntry>,
): BlockEntry | undefined {
  if (!candidates) return undefined;
  for (const candidate of candidates) {
    if (candidate.page !== page && !taken.has(candidate)) return candidate;
  }
  return undefined;
}

// --- Change records --------------------------------------------------------

function changedDiff(pair: AlignedPair): ChangedBlockDiff {
  const before = textOf(pair.before);
  const after = textOf(pair.after);
  return {
    kind: 'changed',
    page: pair.after.page,
    beforeBlockId: idOf(pair.before),
    afterBlockId: idOf(pair.after),
    before,
    after,
    similarity: pair.similarity,
    words: diffWords(before, after),
  };
}

function movedDiff(pair: MovedPair): MovedBlockDiff {
  return {
    kind: 'moved',
    page: pair.after.page,
    beforeBlockId: idOf(pair.before),
    afterBlockId: idOf(pair.after),
    fromPage: pair.before.page,
    text: textOf(pair.after),
  };
}

function summarize(pages: readonly PageDiff[]): DiffSummary {
  const summary: DiffSummary = { added: 0, removed: 0, changed: 0, moved: 0, unchanged: 0 };
  for (const page of pages) {
    summary.unchanged += page.unchanged;
    for (const change of page.changes) {
      switch (change.kind) {
        case 'added':
          summary.added += 1;
          break;
        case 'removed':
          summary.removed += 1;
          break;
        case 'changed':
          summary.changed += 1;
          break;
        case 'moved':
          summary.moved += 1;
          break;
      }
    }
  }
  return summary;
}

// --- Word-level diff -------------------------------------------------------

function tokensOf(text: string): string[] {
  if (typeof text !== 'string') return [];
  const trimmed = text.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/u);
}

/**
 * Longest-common-subsequence runs over two token lists. The caller has already
 * trimmed the common prefix and suffix; what is left is the differing middle.
 */
function lcsRuns(left: readonly string[], right: readonly string[]): TokenRun[] {
  if (left.length === 0) return right.length === 0 ? [] : [{ kind: 'insert', tokens: [...right] }];
  if (right.length === 0) return [{ kind: 'delete', tokens: [...left] }];
  if (left.length * right.length > DIFF_MAX_DP_CELLS) {
    return [
      { kind: 'delete', tokens: [...left] },
      { kind: 'insert', tokens: [...right] },
    ];
  }

  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const cell = i * width + j;
      if (left[i] === right[j]) {
        table[cell] = (table[(i + 1) * width + j + 1] ?? 0) + 1;
      } else {
        table[cell] = Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
      }
    }
  }

  const runs: TokenRun[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const leftToken = left[i];
    const rightToken = right[j];
    if (leftToken !== undefined && leftToken === rightToken) {
      pushTokens(runs, 'equal', [leftToken]);
      i += 1;
      continue;
    }
    // A tie deletes first, so a replacement always reads delete then insert.
    if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      if (leftToken !== undefined) pushTokens(runs, 'delete', [leftToken]);
      i += 1;
      continue;
    }
    if (rightToken !== undefined) pushTokens(runs, 'insert', [rightToken]);
    j += 1;
  }
  while (i < left.length) {
    const token = left[i];
    if (token !== undefined) pushTokens(runs, 'delete', [token]);
    i += 1;
  }
  while (j < right.length) {
    const token = right[j];
    if (token !== undefined) pushTokens(runs, 'insert', [token]);
    j += 1;
  }
  return runs;
}

/** Drops change runs that are too short to be an edit rather than a misread. */
function collapseNoise(runs: readonly TokenRun[]): TokenRun[] {
  const kept: TokenRun[] = [];
  for (const run of runs) {
    if (run.kind === 'equal' || charCount(run.tokens.join(' ')) >= DIFF_MIN_RUN_CHARS) {
      pushTokens(kept, run.kind, run.tokens);
      continue;
    }
    // The fragment exists only on the new side, so it is what the page now says.
    if (run.kind === 'insert') pushTokens(kept, 'equal', run.tokens);
    // A short delete is dropped: the new text no longer has it.
  }
  return kept;
}

/** Joins token runs into display strings, merging adjacent runs of one kind. */
function runsToWords(runs: readonly TokenRun[]): WordDiffRun[] {
  const words: WordDiffRun[] = [];
  for (const run of runs) {
    const text = run.tokens.join(' ');
    if (text.length === 0) continue;
    const last = words[words.length - 1];
    if (last && last.kind === run.kind) {
      words[words.length - 1] = { kind: last.kind, text: `${last.text} ${text}` };
      continue;
    }
    words.push({ kind: run.kind, text });
  }
  return words;
}

/** Appends tokens to the last run when it has the same kind, so runs never repeat. */
function pushTokens(runs: TokenRun[], kind: WordDiffKind, tokens: readonly string[]): void {
  if (tokens.length === 0) return;
  const last = runs[runs.length - 1];
  if (last && last.kind === kind) {
    last.tokens.push(...tokens);
    return;
  }
  runs.push({ kind, tokens: [...tokens] });
}

// --- Ordering and small helpers -------------------------------------------

function compareEntries(left: BlockEntry, right: BlockEntry): number {
  if (left.readingOrder !== right.readingOrder) return left.readingOrder - right.readingOrder;
  if (left.top !== right.top) return left.top - right.top;
  if (left.left !== right.left) return left.left - right.left;
  const leftId = idOf(left);
  const rightId = idOf(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function compareScored(left: ScoredPair, right: ScoredPair): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.before.readingOrder !== right.before.readingOrder) {
    return left.before.readingOrder - right.before.readingOrder;
  }
  return left.after.readingOrder - right.after.readingOrder;
}

function comparePositioned(left: PositionedChange, right: PositionedChange): number {
  if (left.top !== right.top) return left.top - right.top;
  if (left.left !== right.left) return left.left - right.left;
  if (left.rank !== right.rank) return left.rank - right.rank;
  const leftId = changeId(left.change);
  const rightId = changeId(right.change);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function changeId(change: BlockDiff): string {
  return change.kind === 'added' ? change.afterBlockId : change.beforeBlockId;
}

function pageStatus(
  leftPages: ReadonlySet<number>,
  rightPages: ReadonlySet<number>,
  page: number,
): PageDiffStatus {
  const inLeft = leftPages.has(page);
  const inRight = rightPages.has(page);
  if (inLeft && inRight) return 'both';
  return inLeft ? 'removed' : 'added';
}

function sortedPages(left: ReadonlySet<number>, right: ReadonlySet<number>): number[] {
  const all = new Set<number>();
  for (const page of left) all.add(page);
  for (const page of right) all.add(page);
  return [...all].sort((a, b) => a - b);
}

function groupByPage(entries: readonly BlockEntry[]): Map<number, BlockEntry[]> {
  const byPage = new Map<number, BlockEntry[]>();
  for (const entry of entries) appendTo(byPage, entry.page, entry);
  return byPage;
}

function appendTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function textOf(entry: BlockEntry): string {
  return rawOf(entry.block);
}

function rawOf(block: Block): string {
  const raw = block.raw;
  return typeof raw === 'string' ? raw : '';
}

function idOf(entry: BlockEntry): string {
  const id = entry.block.id;
  return typeof id === 'string' ? id : '';
}

function charCount(text: string): number {
  return Array.from(text).length;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A page-space rectangle suitable for rendering a visual diff overlay. */
export interface VisualDiffRect {
  page: number;
  kind: 'added' | 'removed' | 'changed' | 'moved';
  rect: { x: number; y: number; width: number; height: number };
  color: '#2e7d32' | '#c62828' | '#ef6c00' | '#1565c0';
  blockId: string;
}

function blockBounds(block: Block): { x: number; y: number; width: number; height: number } {
  const xs = block.polygon.map(point => point.x);
  const ys = block.polygon.map(point => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(0, Math.max(...xs) - x), height: Math.max(0, Math.max(...ys) - y) };
}

/**
 * Converts a semantic document diff into deterministic page-space rectangles. A changed block
 * emits both old and new geometry, so a renderer can show exactly what disappeared and appeared.
 */
export function diffVisualRects(before: DocumentIR, after: DocumentIR): VisualDiffRect[] {
  const result: VisualDiffRect[] = [];
  for (const page of diffDocuments(before, after).pages) {
    for (const change of page.changes) {
      if (change.kind === 'added') {
        const block = after.blocks.find(entry => entry.id === change.afterBlockId);
        if (block) result.push({ page: change.page, kind: 'added', rect: blockBounds(block), color: '#2e7d32', blockId: block.id });
      } else if (change.kind === 'removed') {
        const block = before.blocks.find(entry => entry.id === change.beforeBlockId);
        if (block) result.push({ page: change.page, kind: 'removed', rect: blockBounds(block), color: '#c62828', blockId: block.id });
      } else if (change.kind === 'changed') {
        const oldBlock = before.blocks.find(entry => entry.id === change.beforeBlockId);
        const newBlock = after.blocks.find(entry => entry.id === change.afterBlockId);
        if (oldBlock) result.push({ page: change.page, kind: 'changed', rect: blockBounds(oldBlock), color: '#ef6c00', blockId: oldBlock.id });
        if (newBlock) result.push({ page: change.page, kind: 'changed', rect: blockBounds(newBlock), color: '#ef6c00', blockId: newBlock.id });
      } else {
        const block = after.blocks.find(entry => entry.id === change.afterBlockId);
        if (block) result.push({ page: change.page, kind: 'moved', rect: blockBounds(block), color: '#1565c0', blockId: block.id });
      }
    }
  }
  return result;
}
