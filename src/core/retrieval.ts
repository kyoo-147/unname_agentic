/**
 * Passage retrieval over the Document IR (backlog items I02 + I03).
 *
 * Two jobs, in the order a caller needs them:
 *
 * 1. {@link chunkDocument} cuts a document into passages that follow the shape the
 *    document itself declares. With headings, a passage is one outline section; without
 *    headings, one block. A table is always its own passage, carrying the CSV of its
 *    cells plus the caption that names it, so a table is never shredded across
 *    passages. Prose that overflows {@link CHUNK_MAX_CHARS} is split on sentence
 *    boundaries with a one-sentence overlap — and never inside a formula run, which
 *    `formulas.ts` marks for us.
 * 2. {@link index} plus {@link search}: an inverted index and Okapi BM25 (k1 1.5,
 *    b 0.75) with a small boost for query terms that appear in the heading path, so
 *    "optimization" finds the section titled "Optimization" even when the body never
 *    repeats the word.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no locale. The same
 *   document always produces the same passages, the same scores and the same order.
 * - A passage never crosses a section boundary and never holds half a table or half a
 *   formula. A heading block is not repeated in its passages' text: it lives in
 *   `headingPath`, which is why the heading boost exists.
 * - Ids are `{documentId}:c{n}`, with `n` counting passages in reading order. They are
 *   stable for a document and unique inside a multi-document index.
 * - Nothing is invented: a passage's `text` is its own blocks' text (a table's CSV is
 *   written from its own rows) and `headingPath` names the sections it sits in.
 * - `search` is lexical only. Embeddings and metadata filters are a later wave; this
 *   module deliberately has no vector store and no network access.
 */

import { linkCaptions, type CaptionInputBlock } from './captions';
import { segmentText } from './formulas';
import type { Block, DocumentIR, Point } from './ir';
import { buildOutline, type OutlineBlockInput, type Section } from './outline';
import { toCsv, type Table } from './tables';
import type { Rect } from './types';

// --- Public shape ----------------------------------------------------------

/** What a passage is: a whole section, one block, or one table. */
export type ChunkKind = 'section' | 'block' | 'table';

/** One retrievable passage of a document. */
export interface Chunk {
  /** `{documentId}:c{n}`, `n` counting passages in reading order. */
  id: string;
  /** Id of the document this passage came from. */
  documentId: string;
  /** 1-based page the passage starts on. */
  page: number;
  /** Ids of the blocks the passage is made of, in reading order. */
  blockIds: string[];
  /** The passage text: the blocks' own text, or a table's CSV plus its caption. */
  text: string;
  kind: ChunkKind;
  /**
   * Titles of the sections the passage sits in, outermost first, and never including
   * an untitled section. Empty for a document without headings.
   */
  headingPath: string[];
}

/** A posting list entry: one chunk's weighted frequency for one term. */
export interface Posting {
  /** 0-based position of the chunk in {@link RetrievalIndex.chunks}. */
  chunk: number;
  /** Body occurrences count 1 each, heading-path occurrences {@link HEADING_TERM_WEIGHT}. */
  frequency: number;
}

/**
 * The inverted index `index` builds.
 *
 * The maps, lengths and chunks are plain data; the object also carries a `search`
 * method bound to itself, so a caller can write `index(chunks).search(query, { limit })`
 * where that reads better. It is the same function as the module-level {@link search}.
 */
export interface RetrievalIndex {
  /** The indexed passages, in the order they were handed in. */
  chunks: readonly Chunk[];
  /** Term to its posting list, in ascending chunk order. */
  postings: ReadonlyMap<string, readonly Posting[]>;
  /** Term to the number of chunks that hold it. */
  documentFrequency: ReadonlyMap<string, number>;
  /** Weighted token count of each chunk, parallel to `chunks`. */
  lengths: readonly number[];
  /** Mean of `lengths`; 0 for an empty index, which makes `search` return nothing. */
  averageLength: number;
  /** Ranks this index against a query; delegates to the module-level {@link search}. */
  search(query: string, options?: SearchOptions): SearchHit[];
}

/** One ranked result. */
export interface SearchHit {
  chunk: Chunk;
  /** BM25 score, rounded to six decimals; only the order is meaningful. */
  score: number;
  /** Normalised query terms this passage matched, sorted, without duplicates. */
  matchedTerms: string[];
}

/** Whether a local embedding adapter can currently produce vectors. */
export type EmbeddingStatus =
  | { state: 'available'; model: string }
  | { state: 'unavailable'; reason: string }
  | { state: 'incompatible'; reason: string }
  | { state: 'unknown'; reason: string };

/** Replaceable local-only embedding seam. It never performs network I/O here. */
export interface EmbeddingAdapter {
  readonly status: EmbeddingStatus;
  embed(text: string): readonly number[] | null;
}

/** An embedding adapter that makes lexical fallback explicit instead of pretending it is vector search. */
export function unavailableEmbeddingAdapter(reason = 'no local embedding model configured'): EmbeddingAdapter {
  return {
    status: { state: 'unavailable', reason },
    embed: () => null,
  };
}

export type RetrievalMethod = 'lexical' | 'vector' | 'hybrid';

/** One result from the hybrid retriever with decomposable scores. */
export interface HybridSearchHit extends SearchHit {
  lexicalScore: number;
  vectorScore: number | null;
  fusedScore: number;
  retrievalMethod: RetrievalMethod;
  embeddingStatus: EmbeddingStatus;
}

export interface HybridSearchOptions extends SearchOptions {
  /** Optional local adapter. Omit it to make lexical-only operation explicit. */
  embedding?: EmbeddingAdapter;
  /** Relative contribution of the normalised lexical score. */
  lexicalWeight?: number;
  /** Relative contribution of the cosine vector score. */
  vectorWeight?: number;
  /** Metadata/policy filter applied before either scorer runs. */
  filter?: (chunk: Chunk) => boolean;
}

export interface SearchOptions {
  /** Most hits to return; defaults to {@link DEFAULT_SEARCH_LIMIT}, and 0 means none. */
  limit?: number;
}

// --- Public constants ------------------------------------------------------

/** Longest passage `chunkDocument` emits before it splits on sentence boundaries. */
export const CHUNK_MAX_CHARS = 1200;

/** Okapi BM25 term-frequency saturation. */
export const BM25_K1 = 1.5;

/** Okapi BM25 length-normalisation weight. */
export const BM25_B = 0.75;

/**
 * Weight of one heading-path occurrence relative to one body occurrence. Small on
 * purpose: a heading should tip a close ranking, not outweigh the body.
 */
export const HEADING_TERM_WEIGHT = 0.5;

/** Hits returned when a caller does not pass `limit`. */
export const DEFAULT_SEARCH_LIMIT = 10;

/** Characters that can end a sentence on their own. */
const SENTENCE_END = '.!?…。！？';

/**
 * Words whose full stop does not end a sentence. Lowercase, without the dot; an
 * initials dot (`J.`) is handled by the single-letter rule instead.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'al', 'approx', 'ca', 'cf', 'chap', 'dr', 'ed', 'eds', 'eq', 'eqs', 'fig', 'figs',
  'i.e', 'e.g', 'mr', 'mrs', 'ms', 'no', 'nos', 'p', 'pp', 'prof', 'ref', 'refs',
  'resp', 'sec', 'tab', 'vol', 'vs',
]);

/** Score precision written into {@link SearchHit.score}. */
const SCORE_DECIMALS = 6;

/** One sentence-sized piece of text, with the block it came from. */
interface Unit {
  text: string;
  blockId: string;
  page: number;
}

/** A passage before it gets an id, a kind and a heading path. */
interface Passage {
  text: string;
  blockIds: string[];
  page: number;
}

/** A section of the outline plus the heading path a passage inside it inherits. */
interface SectionPlan {
  id: string;
  headingPath: string[];
}

// --- Chunking --------------------------------------------------------------

/**
 * Cuts a document into retrieval passages.
 *
 * Structure first, windows second:
 * - A document with at least one `heading` block becomes one passage per outline
 *   section, built from the blocks whose innermost section that is. A section that
 *   holds no content of its own (only its title, or only subsections) produces no
 *   passage: its title still names the heading path of its children.
 * - A document without headings becomes one passage per block.
 * - A `table` block always becomes its own passage of kind `table`, holding the CSV
 *   of its rows and the caption that `captions.ts` links to it. The caption block is
 *   taken out of the prose passages so its words are counted once.
 * - A run of prose longer than {@link CHUNK_MAX_CHARS} is cut on sentence boundaries
 *   into several passages, each repeating the previous passage's last sentence as an
 *   overlap. Cut points inside a formula run are refused; a single run longer than the
 *   limit stays whole rather than being broken mid-formula.
 *
 * Passages are emitted in reading order, so their ids follow the reading order too.
 * The input document is not mutated.
 */
export function chunkDocument(ir: DocumentIR): Chunk[] {
  const documentId = nonEmpty(ir?.documentId) ?? 'document';
  const blocks = orderedBlocks(ir);
  if (blocks.length === 0) return [];

  const byId = new Map<string, Block>();
  for (const block of blocks) byId.set(block.id, block);

  const captionByTable = tableCaptions(ir, blocks);
  const tablePassages = new Map<string, Passage>();
  const consumedCaptions = new Set<string>();

  for (const block of blocks) {
    if (block.type !== 'table') continue;
    const captionBlock = captionByTable.get(block.id);
    const caption = captionBlock ? foldText(captionBlock.raw) : '';
    const blockIds = captionBlock
      ? [block.id, captionBlock.id].sort((left, right) => compareReadingOrder(byId.get(left), byId.get(right)))
      : [block.id];
    tablePassages.set(block.id, { text: tablePassageText(block, caption), blockIds, page: block.page });
    if (captionBlock) consumedCaptions.add(captionBlock.id);
  }

  const chunks: Chunk[] = [];
  let sequence = 0;
  const emit = (kind: ChunkKind, passage: Passage, headingPath: readonly string[]): void => {
    sequence += 1;
    chunks.push({
      id: `${documentId}:c${sequence}`,
      documentId,
      page: passage.page,
      blockIds: [...passage.blockIds],
      text: passage.text,
      kind,
      headingPath: [...headingPath],
    });
  };

  if (blocks.some(block => block.type === 'heading')) {
    const plans = sectionPlans(blocks);
    const direct = new Map<string, Block[]>();
    for (const block of blocks) {
      const sectionId = plans.byBlock.get(block.id);
      if (sectionId === undefined) continue;
      const list = direct.get(sectionId);
      if (list) list.push(block);
      else direct.set(sectionId, [block]);
    }

    for (const plan of plans.order) {
      let buffer: Block[] = [];
      const flush = (): void => {
        // A heading is not prose: its text is already in `headingPath`.
        const prose = buffer.filter(block => block.type !== 'heading');
        buffer = [];
        for (const passage of prosePassages(prose)) emit('section', passage, plan.headingPath);
      };

      for (const block of direct.get(plan.id) ?? []) {
        if (consumedCaptions.has(block.id)) continue;
        const table = tablePassages.get(block.id);
        if (table) {
          flush();
          emit('table', table, plan.headingPath);
          continue;
        }
        buffer.push(block);
      }
      flush();
    }
  } else {
    for (const block of blocks) {
      if (consumedCaptions.has(block.id)) continue;
      const table = tablePassages.get(block.id);
      if (table) {
        emit('table', table, []);
        continue;
      }
      for (const passage of prosePassages([block])) emit('block', passage, []);
    }
  }

  return chunks;
}

/**
 * Builds the prose passages of one run of blocks.
 *
 * When the whole run fits, its text is exactly the blocks' text joined by line breaks,
 * so a short passage reads the way the page does. A run that overflows is cut into
 * sentence units and packed into windows of at most {@link CHUNK_MAX_CHARS}; windows
 * join their units with a single space, their `blockIds` name only the blocks that
 * actually contributed, and each window starts with the previous window's last
 * sentence as its overlap.
 */
function prosePassages(blocks: readonly Block[]): Passage[] {
  const entries: Array<{ id: string; page: number; text: string }> = [];
  for (const block of blocks) {
    const text = typeof block.raw === 'string' ? block.raw.trim() : '';
    if (text.length === 0) continue;
    entries.push({ id: block.id, page: block.page, text });
  }
  const first = entries[0];
  if (!first) return [];

  const joined = entries.map(entry => entry.text).join('\n');
  if (joined.length <= CHUNK_MAX_CHARS) {
    return [{ text: joined, blockIds: entries.map(entry => entry.id), page: first.page }];
  }

  const units: Unit[] = [];
  for (const entry of entries) {
    for (const text of textUnits(entry.text)) {
      units.push({ text, blockId: entry.id, page: entry.page });
    }
  }

  const passages: Passage[] = [];
  for (const window of packWindows(units, CHUNK_MAX_CHARS)) {
    const head = window[0];
    if (!head) continue;
    const blockIds: string[] = [];
    for (const unit of window) {
      if (!blockIds.includes(unit.blockId)) blockIds.push(unit.blockId);
    }
    passages.push({
      text: window.map(unit => unit.text).join(' '),
      blockIds,
      page: head.page,
    });
  }
  return passages;
}

/**
 * Splits one block of text into sentence units.
 *
 * A block that already fits is returned whole. Otherwise the text is cut after
 * sentence-ending punctuation that is followed by whitespace, and after every line
 * break. A cut is refused when it would fall inside a formula run, which
 * `segmentText` marks per line exactly as `formulas.ts` does; it is also refused after
 * a known abbreviation or an initials dot, so `Fig. 3` does not end a sentence. A unit
 * that is still longer than the limit is cut again at unprotected spaces, and a unit
 * with no legal cut stays whole: protecting the formula wins over the size limit.
 */
function textUnits(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= CHUNK_MAX_CHARS) return [trimmed];

  const protectedAt = maskFormulas(trimmed);
  const units: string[] = [];
  for (const range of sentenceRanges(trimmed, protectedAt)) {
    for (const piece of splitLongRange(trimmed, protectedAt, range[0], range[1])) {
      const value = trimmed.slice(piece[0], piece[1]).trim();
      if (value.length > 0) units.push(value);
    }
  }
  return units;
}

/**
 * Marks every character that belongs to a math run, using `formulas.ts`'s own
 * segmentation. Lines are segmented one at a time, which is the granularity that
 * module works at, so a display block spanning several lines is protected per line.
 */
function maskFormulas(text: string): boolean[] {
  const protectedAt = new Array<boolean>(text.length).fill(false);
  let offset = 0;

  for (const part of text.split(/(\r\n|\r|\n)/u)) {
    if (part === '\r\n' || part === '\r' || part === '\n') {
      offset += part.length;
      continue;
    }
    let cursor = offset;
    for (const segment of segmentText(part)) {
      if (segment.kind !== 'text') {
        for (let index = 0; index < segment.value.length; index += 1) {
          const at = cursor + index;
          if (at >= 0 && at < protectedAt.length) protectedAt[at] = true;
        }
      }
      cursor += segment.value.length;
    }
    // The segmentation is lossless, so the next line starts exactly after this one;
    // forcing the offset keeps a surprise from desynchronising the whole mask.
    offset += part.length;
  }
  return protectedAt;
}

/** Half-open ranges of `text`, one per sentence or line. */
function sentenceRanges(text: string, protectedAt: readonly boolean[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (protectedAt[index] === true) continue;
    const character = text.charAt(index);
    if (character === '\n' || character === '\r') {
      ranges.push([start, index + 1]);
      start = index + 1;
      continue;
    }
    if (!SENTENCE_END.includes(character)) continue;

    const next = text.charAt(index + 1);
    if (next !== '' && !/\s/u.test(next)) continue;
    // The break would land inside the formula that starts right after the punctuation.
    if (protectedAt[index + 1] === true) continue;
    if (endsWithAbbreviation(text, index)) continue;

    ranges.push([start, index + 1]);
    start = index + 1;
  }

  ranges.push([start, text.length]);
  return ranges;
}

/** True when the dot at `index` closes a known abbreviation or an initials letter. */
function endsWithAbbreviation(text: string, index: number): boolean {
  const match = text.slice(0, index).match(/([\p{L}.]+)$/u);
  const word = match?.[1];
  if (word === undefined) return false;
  const bare = word.replace(/\.+$/u, '').toLowerCase();
  if (bare.length === 0) return false;
  if (bare.length === 1 && /\p{L}/u.test(bare)) return true;
  return ABBREVIATIONS.has(bare);
}

/** Cuts an over-long range at spaces that no formula needs, keeping the rest whole. */
function splitLongRange(
  text: string,
  protectedAt: readonly boolean[],
  start: number,
  end: number,
): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  let cursor = start;

  while (end - cursor > CHUNK_MAX_CHARS) {
    let cut = -1;
    for (let index = Math.min(cursor + CHUNK_MAX_CHARS, end - 1); index > cursor; index -= 1) {
      if (!isFreeSpace(text, protectedAt, index)) continue;
      cut = index;
      break;
    }
    if (cut <= cursor) break;
    pieces.push([cursor, cut]);
    cursor = cut + 1;
  }

  pieces.push([cursor, end]);
  return pieces;
}

/** True when a space can carry a cut without touching a formula run. */
function isFreeSpace(text: string, protectedAt: readonly boolean[], index: number): boolean {
  if (!/\s/u.test(text.charAt(index))) return false;
  return protectedAt[index] !== true && protectedAt[index - 1] !== true && protectedAt[index + 1] !== true;
}

/**
 * Packs units into windows of at most `limit` characters joined by single spaces,
 * repeating the last sentence of a window as the first of the next one. The overlap is
 * dropped for a boundary where it would not fit together with the incoming unit, so a
 * window never exists only to carry a duplicate, and an oversized unit still ends up
 * alone rather than split.
 */
function packWindows(units: readonly Unit[], limit: number): Unit[][] {
  const windows: Unit[][] = [];
  let current: Unit[] = [];
  let length = 0;

  for (const unit of units) {
    if (current.length > 0 && length + 1 + unit.text.length > limit) {
      const overlap = current[current.length - 1];
      windows.push(current);
      current = [];
      length = 0;
      if (overlap !== undefined && overlap.text.length + 1 + unit.text.length <= limit) {
        current = [overlap];
        length = overlap.text.length;
      }
    }
    length = current.length === 0 ? unit.text.length : length + 1 + unit.text.length;
    current.push(unit);
  }

  if (current.length > 0) windows.push(current);
  return windows;
}

// --- Tables ----------------------------------------------------------------

/** Where each table's caption lives, keyed by table block id. */
function tableCaptions(ir: DocumentIR, blocks: readonly Block[]): Map<string, Block> {
  const captions = new Map<string, Block>();
  if (blocks.every(block => block.type !== 'table')) return captions;

  const byId = new Map<string, Block>();
  for (const block of blocks) byId.set(block.id, block);

  const heights = new Map<number, number>();
  for (const page of Array.isArray(ir?.pages) ? ir.pages : []) {
    if (!page || !Number.isFinite(page.height) || page.height <= 0) continue;
    heights.set(page.index, page.height);
  }

  const inputs: CaptionInputBlock[] = blocks.map(block => {
    const input: CaptionInputBlock = {
      id: block.id,
      type: block.type,
      page: block.page,
      text: block.raw,
      rect: polygonRect(block.polygon),
    };
    const height = heights.get(block.page);
    if (height !== undefined) input.pageHeight = height;
    return input;
  });

  for (const link of linkCaptions(inputs).links) {
    if (link.kind !== 'table') continue;
    const caption = byId.get(link.captionId);
    if (caption) captions.set(link.targetId, caption);
  }
  return captions;
}

/**
 * Writes a table block as the passage text a reader can quote: the caption that names
 * it, then the CSV of its rows.
 */
function tablePassageText(block: Block, caption: string): string {
  const csv = tableCsv(block);
  const body = csv.length > 0 ? csv : foldText(block.raw);
  return caption.length > 0 ? `${caption}\n${body}` : body;
}

/**
 * Reads a table block's own column structure and writes it back as CSV.
 *
 * The block was already classified as a table from exactly this evidence — lines that
 * break into the same number of cells — so re-reading its lines is the structure the
 * block implies. Cells keep their values; nothing is filled in beyond the empty slots
 * `toCsv` pads. A block with fewer than two rows or two columns has no table structure
 * to write, and `tablePassageText` falls back to its folded text.
 */
function tableCsv(block: Block): string {
  const raw = typeof block.raw === 'string' ? block.raw : '';
  const rows: string[][] = [];
  for (const line of raw.split(/\r\n|\r|\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const cells = trimmed
      .split(/\t+| {2,}/u)
      .map(cell => cell.trim())
      .filter(cell => cell.length > 0);
    if (cells.length > 0) rows.push(cells);
  }

  const header = rows[0];
  if (!header || rows.length < 2) return '';
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (width < 2) return '';

  const table: Table = {
    headers: padRow(header, width),
    rows: rows.slice(1).map(row => padRow(row, width)),
    rowCount: rows.length,
    columnCount: width,
    spans: [],
    // The column structure is the block's own; that the first row is a header is an
    // assumption, so the confidence stays below certainty.
    confidence: 0.5,
    reasons: ['assumed-header'],
  };
  return toCsv(table);
}

function padRow(cells: readonly string[], width: number): string[] {
  const row: string[] = [];
  for (let index = 0; index < width; index += 1) row.push(cells[index] ?? '');
  return row;
}

// --- Indexing --------------------------------------------------------------

/**
 * Builds the inverted index `search` scores against.
 *
 * Terms come from the passage text and from its heading path. A body occurrence counts
 * 1; a heading-path occurrence counts {@link HEADING_TERM_WEIGHT}, which is why a term
 * that appears only in a heading can still retrieve the section. The chunk length used
 * for normalisation counts both, so two passages of the same prose have the same
 * length whatever their titles say.
 *
 * An empty or malformed chunk list produces an empty index rather than throwing.
 */
export function index(chunks: readonly Chunk[]): RetrievalIndex {
  const list: Chunk[] = [];
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (typeof chunk === 'object' && chunk !== null) list.push(chunk);
  }

  const postings = new Map<string, Posting[]>();
  const lengths: number[] = [];
  let total = 0;

  list.forEach((chunk, position) => {
    const counts = new Map<string, number>();
    const body = tokenize(typeof chunk.text === 'string' ? chunk.text : '');
    for (const term of body) counts.set(term, (counts.get(term) ?? 0) + 1);

    const heading = headingTerms(chunk);
    for (const term of heading) counts.set(term, (counts.get(term) ?? 0) + HEADING_TERM_WEIGHT);

    const length = body.length + heading.length;
    lengths.push(length);
    total += length;

    for (const [term, frequency] of counts) {
      const list2 = postings.get(term);
      if (list2) list2.push({ chunk: position, frequency });
      else postings.set(term, [{ chunk: position, frequency }]);
    }
  });

  const documentFrequency = new Map<string, number>();
  for (const [term, list3] of postings) documentFrequency.set(term, list3.length);

  const built: RetrievalIndex = {
    chunks: list,
    postings,
    documentFrequency,
    lengths,
    averageLength: list.length > 0 ? total / list.length : 0,
    search: (query, options) => search(built, query, options),
  };
  return built;
}

/**
 * Ranks the passages of `target` against `query`.
 *
 * Score is Okapi BM25: `idf(t) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * |D| / avgdl))`
 * summed over the distinct query terms, with the Lucene-style
 * `ln(1 + (N - df + 0.5) / (df + 0.5))` that never goes negative. Ordering is by score,
 * then page, then chunk id, so two equal-scoring passages always come back in the same
 * order. `limit` caps the result and an empty query, an empty index or a passage with no
 * terms returns an empty list.
 */
export function search(target: RetrievalIndex, query: string, options: SearchOptions = {}): SearchHit[] {
  if (!target || !Array.isArray(target.chunks) || target.chunks.length === 0) return [];
  const averageLength = target.averageLength;
  if (!(averageLength > 0)) return [];

  const terms = uniqueTerms(tokenize(typeof query === 'string' ? query : ''));
  if (terms.length === 0) return [];

  const limit = readLimit(options?.limit);
  if (limit === 0) return [];

  const total = target.chunks.length;
  const scored = new Map<number, { score: number; matched: string[] }>();

  for (const term of terms) {
    const list = target.postings.get(term);
    if (!list || list.length === 0) continue;
    const idf = Math.log(1 + (total - list.length + 0.5) / (list.length + 0.5));

    for (const posting of list) {
      const length = target.lengths[posting.chunk] ?? 0;
      const denominator = posting.frequency + BM25_K1 * (1 - BM25_B + BM25_B * (length / averageLength));
      if (!(denominator > 0)) continue;
      const contribution = idf * ((posting.frequency * (BM25_K1 + 1)) / denominator);
      const entry = scored.get(posting.chunk);
      if (entry) {
        entry.score += contribution;
        entry.matched.push(term);
      } else {
        scored.set(posting.chunk, { score: contribution, matched: [term] });
      }
    }
  }

  const hits: SearchHit[] = [];
  for (const [position, entry] of scored) {
    const chunk = target.chunks[position];
    if (!chunk) continue;
    hits.push({
      chunk,
      score: round(entry.score, SCORE_DECIMALS),
      matchedTerms: [...entry.matched].sort(compareText),
    });
  }

  hits.sort(
    (left, right) =>
      right.score - left.score ||
      finiteOr(left.chunk.page, 1) - finiteOr(right.chunk.page, 1) ||
      compareText(left.chunk.id, right.chunk.id),
  );
  return hits.slice(0, limit);
}

/**
 * Runs lexical BM25 and an optional local vector adapter, retaining both scores.
 *
 * Vector availability is explicit. When the adapter is unavailable, incompatible or
 * unknown, this function returns lexical results with `vectorScore: null` and
 * `retrievalMethod: 'lexical'`. A lexical result is never relabelled as an embedding result.
 */
export function hybridSearch(
  target: RetrievalIndex,
  query: string,
  options: HybridSearchOptions = {},
): HybridSearchHit[] {
  if (!target || !Array.isArray(target.chunks) || target.chunks.length === 0) return [];
  const filter = typeof options.filter === 'function' ? options.filter : () => true;
  const candidates = target.chunks.filter(filter);
  if (candidates.length === 0) return [];

  const candidateIds = new Set(candidates.map(chunk => chunk.id));
  const lexical = search(target, query, { limit: target.chunks.length })
    .filter(hit => candidateIds.has(hit.chunk.id));
  const lexicalById = new Map(lexical.map(hit => [hit.chunk.id, hit]));

  const adapter = options.embedding;
  let embeddingStatus = normalizeEmbeddingStatus(adapter?.status, adapter === undefined
    ? { state: 'unavailable', reason: 'no local embedding adapter supplied' }
    : { state: 'unknown', reason: 'local embedding adapter status was not available' });
  const vectorById = new Map<string, number>();
  let queryVector: readonly number[] | null = null;
  if (adapter && embeddingStatus.state === 'available') {
    queryVector = safeEmbedding(adapter, query);
    if (queryVector === null) {
      embeddingStatus = { state: 'unknown', reason: 'local embedding adapter returned no valid query vector' };
    } else {
      let incompatible = false;
      let unknown = false;
      for (const chunk of candidates) {
        const vector = safeEmbedding(adapter, chunk.text);
        if (vector === null) {
          unknown = true;
          continue;
        }
        if (vector.length !== queryVector.length) {
          incompatible = true;
          continue;
        }
        const similarity = cosineSimilarity(queryVector, vector);
        if (similarity !== null) vectorById.set(chunk.id, similarity);
      }
      if (incompatible) {
        embeddingStatus = { state: 'incompatible', reason: 'local embedding vectors have incompatible dimensions' };
        vectorById.clear();
      } else if (unknown) {
        embeddingStatus = { state: 'unknown', reason: 'local embedding adapter returned an invalid chunk vector' };
        vectorById.clear();
      }
    }
  }

  const lexicalMax = Math.max(...lexical.map(hit => hit.score), 0);
  const vectorMax = Math.max(...vectorById.values(), 0);
  const lexicalWeight = nonNegative(options.lexicalWeight, 0.5);
  const vectorWeight = nonNegative(options.vectorWeight, 0.5);
  const totalWeight = lexicalWeight + vectorWeight;
  const lw = totalWeight > 0 ? lexicalWeight / totalWeight : 0.5;
  const vw = totalWeight > 0 ? vectorWeight / totalWeight : 0.5;
  const hits: HybridSearchHit[] = [];

  for (const chunk of candidates) {
    const lexicalHit = lexicalById.get(chunk.id);
    const lexicalScore = lexicalHit?.score ?? 0;
    const vectorRaw = vectorById.get(chunk.id);
    const vectorScore = vectorRaw === undefined ? null : round((vectorRaw + 1) / 2, SCORE_DECIMALS);
    const lexicalNormal = lexicalMax > 0 ? lexicalScore / lexicalMax : 0;
    const vectorNormal = vectorMax > 0 && vectorRaw !== undefined ? vectorRaw / vectorMax : 0;
    const hasVector = vectorScore !== null;
    const method: RetrievalMethod = hasVector && lexicalHit ? 'hybrid' : hasVector ? 'vector' : 'lexical';
    const fusedScore = round(hasVector ? lw * lexicalNormal + vw * vectorNormal : lexicalNormal, SCORE_DECIMALS);
    if (lexicalHit === undefined && !hasVector) continue;
    hits.push({
      chunk,
      score: fusedScore,
      lexicalScore,
      vectorScore,
      fusedScore,
      retrievalMethod: method,
      embeddingStatus,
      matchedTerms: lexicalHit?.matchedTerms ?? [],
    });
  }

  const limit = readLimit(options.limit);
  hits.sort(
    (left, right) => right.fusedScore - left.fusedScore
      || right.lexicalScore - left.lexicalScore
      || finiteOr(left.chunk.page, 1) - finiteOr(right.chunk.page, 1)
      || compareText(left.chunk.id, right.chunk.id),
  );
  return hits.slice(0, limit);
}

function safeEmbedding(adapter: EmbeddingAdapter, text: string): readonly number[] | null {
  try {
    const vector = adapter.embed(text);
    if (!Array.isArray(vector) || vector.length === 0 || vector.some(value => !Number.isFinite(value))) return null;
    return vector;
  } catch {
    return null;
  }
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length === 0) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator > 0 ? dot / denominator : null;
}

function normalizeEmbeddingStatus(
  value: unknown,
  fallback: EmbeddingStatus,
): EmbeddingStatus {
  if (typeof value !== 'object' || value === null) return fallback;
  const state = (value as { state?: unknown }).state;
  if (state === 'available') {
    const model = (value as { model?: unknown }).model;
    return typeof model === 'string' && model.trim().length > 0
      ? { state: 'available', model: model.trim() }
      : { state: 'unknown', reason: 'local embedding adapter omitted its model identity' };
  }
  if (state === 'unavailable' || state === 'incompatible' || state === 'unknown') {
    const reason = (value as { reason?: unknown }).reason;
    return typeof reason === 'string' && reason.trim().length > 0
      ? { state, reason: reason.trim() }
      : { state: 'unknown', reason: 'local embedding adapter omitted its status reason' };
  }
  return { state: 'unknown', reason: 'local embedding adapter returned an unknown status' };
}
function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

// --- Normalisation ---------------------------------------------------------

/**
 * Splits text into normalised terms.
 *
 * Lowercased, stripped of punctuation, digits kept, and folded so Vietnamese
 * diacritics do not stop a match: `hệ thống` and `he thong` tokenise alike, and `đ`
 * folds to `d` (it does not decompose under NFD). Characters of every script that are
 * letters or numbers survive, so CJK text still tokenises instead of vanishing.
 */
export function tokenize(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  return foldDiacritics(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(term => term.length > 0);
}

/** Lowercases and removes combining marks, so an accent-less query still matches. */
function foldDiacritics(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/gu, 'd');
}

function headingTerms(chunk: Chunk): string[] {
  const path = Array.isArray(chunk.headingPath) ? chunk.headingPath : [];
  const terms: string[] = [];
  for (const title of path) {
    if (typeof title !== 'string') continue;
    for (const term of tokenize(title)) terms.push(term);
  }
  return terms;
}

function uniqueTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms) {
    if (seen.has(term)) continue;
    seen.add(term);
    unique.push(term);
  }
  return unique;
}

function readLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT;
  const limit = Math.floor(value);
  return limit < 0 ? DEFAULT_SEARCH_LIMIT : limit;
}

// --- Document plumbing -----------------------------------------------------

/** The document's blocks in reading order, with a total order for equal ranks. */
function orderedBlocks(ir: DocumentIR): Block[] {
  const blocks: Block[] = [];
  for (const block of Array.isArray(ir?.blocks) ? ir.blocks : []) {
    if (typeof block === 'object' && block !== null) blocks.push(block);
  }
  return blocks.sort(
    (left, right) =>
      finiteOr(left.readingOrder, 0) - finiteOr(right.readingOrder, 0) ||
      finiteOr(left.page, 1) - finiteOr(right.page, 1) ||
      compareText(left.id ?? '', right.id ?? ''),
  );
}

function compareReadingOrder(left: Block | undefined, right: Block | undefined): number {
  return (
    finiteOr(left?.readingOrder, 0) - finiteOr(right?.readingOrder, 0) ||
    finiteOr(left?.page, 1) - finiteOr(right?.page, 1) ||
    compareText(left?.id ?? '', right?.id ?? '')
  );
}

/** Section order (pre-order) and the section each block belongs to. */
function sectionPlans(blocks: readonly Block[]): { order: SectionPlan[]; byBlock: Map<string, string> } {
  const inputs: OutlineBlockInput[] = blocks.map(block => ({
    id: block.id,
    page: block.page,
    text: block.raw,
    type: block.type,
  }));
  const outline = buildOutline(inputs);

  const order: SectionPlan[] = [];
  const walk = (sections: readonly Section[], parentPath: readonly string[]): void => {
    for (const section of sections) {
      if (!section || typeof section !== 'object') continue;
      const title = typeof section.title === 'string' ? section.title : '';
      const headingPath = title.length > 0 ? [...parentPath, title] : [...parentPath];
      order.push({ id: section.id, headingPath });
      walk(Array.isArray(section.children) ? section.children : [], headingPath);
    }
  };
  walk(outline.sections, []);

  const byBlock = new Map<string, string>();
  for (const member of outline.members) {
    if (!member || typeof member.blockId !== 'string') continue;
    byBlock.set(member.blockId, member.sectionId);
  }
  return { order, byBlock };
}

function polygonRect(polygon: readonly Point[] | undefined): Rect {
  const points = Array.isArray(polygon) ? polygon : [];
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const x = finiteOr(point?.x, 0);
    const y = finiteOr(point?.y, 0);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    x: Number.isFinite(minX) ? minX : 0,
    y: Number.isFinite(minY) ? minY : 0,
    width: Number.isFinite(maxX - minX) ? maxX - minX : 0,
    height: Number.isFinite(maxY - minY) ? maxY - minY : 0,
  };
}

// --- Small helpers ---------------------------------------------------------

/** Collapses whitespace runs and trims; used for one-line values such as a caption. */
function foldText(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
