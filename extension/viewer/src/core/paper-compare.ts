/**
 * Cross-paper comparison (backlog item J07).
 *
 * A reader comparing papers asks the same three questions of every one of them — what did
 * they do, on what data, measured how — and an answer is only worth reading with the sentence
 * it came from. This module builds that comparison as a matrix: one row per paper, one column
 * per aspect, and one cell per pair holding the best matching sentence, the section it was
 * read from, and the score that chose it. A pair with no matching sentence is a gap carrying
 * the reason, never an empty cell.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no locale, no DOM, no network, no I/O.
 *   The same papers and aspects always produce an equal matrix and equal sentences, and every
 *   returned structure is plain JSON data.
 * - Evidence only. A cell's `text` is one sentence copied out of one of the paper's own
 *   sections, whitespace collapsed and nothing else altered; `section` is that section's name
 *   as the paper declared it. Nothing is paraphrased, summarised or borrowed from another
 *   paper, and a gap is never written as an empty quote or a zero score.
 * - The scoring is small and documented, so a reader can predict what wins:
 *   - {@link PAPER_KEYWORD_HIT_WEIGHT} per *distinct* aspect keyword found in the sentence, so
 *     a sentence naming two keywords beats one repeating a single keyword twice;
 *   - {@link PAPER_PREFERRED_SECTION_BONUS} when the sentence sits in a section the aspect's
 *     kind prefers — `Method` for methodology, `Data` for dataset, `Results` for metric;
 *   - a keyword hit is required. Section preference alone never produces a cell: a "Method"
 *     section that never mentions the aspect is silence, not evidence, and the score is
 *     therefore always at least {@link PAPER_KEYWORD_HIT_WEIGHT}.
 * - A keyword matches as a whole word, allowing a plural `s`/`es` and flexible separators
 *   inside a multi-word keyword, so `pre-trained` finds `pretrained`. There is no stemming:
 *   write the forms you want to find in `keywords`.
 * - Ties keep the earlier sentence in reading order — sections in declared order, sentences in
 *   text order — so a paper's best cell is stable and a later section never steals a tie.
 * - A sentence ends at `.`, `!`, `?`, `…`, the CJK enders, or a line break, with one guard: a
 *   full stop after a single letter or a listed abbreviation followed by lowercase text is not
 *   an end, so `e.g. bert` and `et al. we` stay one sentence. The punctuation that ended a
 *   sentence stays in the quote, so a cell reads as the paper wrote it; a line break does not.
 * - {@link summarise} builds its sentences only from cells the matrix already carries. It
 *   groups cells by their quoted *wording* (case, diacritics, spacing and edge punctuation
 *   folded), never by meaning: two papers agreeing here means they wrote the same sentence, not
 *   that they did the same thing. One witness is neither agreement nor disagreement.
 * - {@link toMarkdown} writes every quote with the section it came from and renders a gap as
 *   {@link PAPER_GAP_MARKER}, so no cell loses its provenance.
 * - A definition that cannot produce a comparison is refused instead of guessed: no usable
 *   papers, or no aspect with at least one usable keyword, yields a matrix with `refusal` set
 *   and no rows, aspects, cells or gaps. An aspect with no keyword is dropped from the columns
 *   rather than rendering a column that can never be filled. A paper with no sections is not a
 *   refusal: it is a row whose every pair is a gap.
 */

// --- Public shape ----------------------------------------------------------

/** What kind of information an aspect asks for; the kind also prefers a matching section. */
export type PaperAspectKind = 'methodology' | 'dataset' | 'metric' | 'other';

/** Every kind this module knows, in the order the documentation lists them. */
export const PAPER_ASPECT_KINDS: readonly PaperAspectKind[] = ['methodology', 'dataset', 'metric', 'other'];

/** Score one distinct keyword found in a sentence is worth. */
export const PAPER_KEYWORD_HIT_WEIGHT = 2;

/** Score added when the sentence sits in a section the aspect's kind prefers. */
export const PAPER_PREFERRED_SECTION_BONUS = 1;

/**
 * What a renderer writes for a paper the aspect never matched. The words matter: a dash and
 * "not mentioned" cannot be misread as an empty quote.
 */
export const PAPER_GAP_MARKER = '— (not mentioned)';

/** Label a renderer uses when a matched section carries no name of its own. */
export const PAPER_UNNAMED_SECTION = '(untitled section)';

/** One named part of a paper, as the paper's own text extraction produced it. */
export interface PaperSection {
  /** Section title, for example `Method` or `5. Results`. */
  name: string;
  /** The section's plain text. Sentences are read from this; nothing else is. */
  text: string;
}

/** One paper taking part in the comparison. */
export interface Paper {
  /** Unique id; a duplicate id is skipped after its first appearance. */
  id: string;
  /** Name shown as the row label. Falls back to the id when blank. */
  title: string;
  /** Publication year, shown as its own column. A non-finite year reads as 0. */
  year: number;
  /** The paper's sections. A paper with none is still a row, with gaps in every column. */
  sections: PaperSection[];
}

/** One aspect the papers are compared on. */
export interface PaperAspect {
  /** Unique id; a duplicate id is skipped after its first appearance. */
  id: string;
  /** Name shown as the column header. Falls back to the id when blank. */
  label: string;
  /**
   * Words and phrases that name the aspect. A sentence matches when it contains one as a
   * whole word, with an optional plural `s`/`es`. An aspect without a usable keyword is
   * dropped: it could never produce a cell.
   */
  keywords: string[];
  /** Which section the aspect prefers. An unrecognised kind reads as `other`. */
  kind: PaperAspectKind;
}

/** One paper as a row label. */
export interface PaperRow {
  paperId: string;
  title: string;
  year: number;
}

/** One aspect as a column header. */
export interface PaperAspectColumn {
  aspectId: string;
  label: string;
  kind: PaperAspectKind;
}

/** One piece of evidence: what one paper says about one aspect, and where it said it. */
export interface PaperCell {
  paperId: string;
  aspectId: string;
  /** The matched sentence, whitespace collapsed and otherwise unchanged. */
  text: string;
  /** The section it was read from, as the paper named it; `''` when the name was blank. */
  section: string;
  /** Ranking score that chose this sentence; only comparisons within one aspect matter. */
  score: number;
}

/** Why a pair has no cell. */
export type PaperGapReason =
  /** The paper declared no section with any text, so there was nothing to search. */
  | 'no-sections'
  /** The paper has text, but no sentence carried any of the aspect's keywords. */
  | 'no-match';

/** A pair the aspect says nothing about. A gap is evidence of absence, not an empty quote. */
export interface PaperGap {
  paperId: string;
  aspectId: string;
  reason: PaperGapReason;
}

/** Why a matrix was not built. */
export type PaperRefusal = 'no-papers' | 'no-aspects';

/** Papers as rows, aspects as columns, one sentence in every cell that has one. */
export interface PaperMatrix {
  /** Row labels in input order, after duplicates were dropped. */
  rows: PaperRow[];
  /** Column headers in input order, after unusable aspects were dropped. */
  aspects: PaperAspectColumn[];
  /** Evidence cells in row-major order: paper order, then aspect order. */
  cells: PaperCell[];
  /** Pairs without evidence, in the same row-major order. */
  gaps: PaperGap[];
  /** Set when nothing was compared; the rest of the matrix is then empty. */
  refusal: PaperRefusal | null;
}

/** What one aspect's cells say once they are read together. */
export interface PaperAspectSummary {
  aspectId: string;
  label: string;
  /** Titles of the papers that produced a cell, in matrix order. */
  quotedPapers: string[];
  /** Titles of the papers the matrix records a gap for, in matrix order. */
  unmentioned: string[];
  /**
   * One sentence naming the papers that wrote the same thing, or `null` when the readings
   * differ and when only one paper states the aspect at all.
   */
  consensus: string | null;
  /** One sentence naming the differing readings, or `null` when they agree. */
  divergence: string | null;
}

/** The comparison as prose, one entry per aspect, in column order. */
export interface PaperSummary {
  aspects: PaperAspectSummary[];
}

// --- Building --------------------------------------------------------------

/** An aspect after validation, with one whole-word matcher per keyword. */
interface PreparedAspect {
  id: string;
  label: string;
  kind: PaperAspectKind;
  /** Matchers are built for folded text and must stay stateless: no `g`, no `y`. */
  matchers: readonly RegExp[];
}

/** One section reduced to the sentences a cell can quote. */
interface PreparedSection {
  name: string;
  sentences: readonly string[];
}

/** A paper after validation, ready to be searched. */
interface PreparedPaper {
  id: string;
  title: string;
  year: number;
  sections: readonly PreparedSection[];
  /** False when no section carried any text; every pair then becomes a `no-sections` gap. */
  hasText: boolean;
}

/** The sentence that won one pair, before it is given its ids. */
interface Candidate {
  text: string;
  section: string;
  score: number;
}

/**
 * Builds the comparison for `papers` and `aspects`.
 *
 * Papers and aspects keep their input order; a duplicate id is dropped after its first
 * appearance, and an aspect without a usable keyword is dropped instead of producing a column
 * that can never be filled. Each cell is the best scoring sentence of that paper for that
 * aspect, read by the rules at the top of this file; a pair with no matching sentence becomes
 * a gap with the reason, and never a zero.
 *
 * No usable paper, or no usable aspect, refuses the matrix: `refusal` names the reason and
 * `rows`, `aspects`, `cells` and `gaps` are all empty, because a comparison that did not
 * happen must not look like one that found nothing.
 */
export function comparePapers(
  papers: readonly Paper[],
  aspects: readonly PaperAspect[],
): PaperMatrix {
  const preparedPapers = preparePapers(papers);
  const preparedAspects = prepareAspects(aspects);
  if (preparedPapers.length === 0) return refusedMatrix('no-papers');
  if (preparedAspects.length === 0) return refusedMatrix('no-aspects');

  const cells: PaperCell[] = [];
  const gaps: PaperGap[] = [];

  for (const paper of preparedPapers) {
    for (const aspect of preparedAspects) {
      const candidate = bestCandidate(paper, aspect);
      if (candidate) {
        cells.push({
          paperId: paper.id,
          aspectId: aspect.id,
          text: candidate.text,
          section: candidate.section,
          score: candidate.score,
        });
        continue;
      }
      gaps.push({
        paperId: paper.id,
        aspectId: aspect.id,
        reason: paper.hasText ? 'no-match' : 'no-sections',
      });
    }
  }

  return {
    rows: preparedPapers.map(paper => ({
      paperId: paper.id,
      title: paper.title,
      year: paper.year,
    })),
    aspects: preparedAspects.map(aspect => ({
      aspectId: aspect.id,
      label: aspect.label,
      kind: aspect.kind,
    })),
    cells,
    gaps,
    refusal: null,
  };
}

function refusedMatrix(refusal: PaperRefusal): PaperMatrix {
  return { rows: [], aspects: [], cells: [], gaps: [], refusal };
}

/**
 * The best sentence of one paper for one aspect, or `null` when the paper never names it.
 *
 * Sections and sentences are walked in reading order and a candidate only replaces the
 * incumbent on a strictly higher score, which is what makes the earliest sentence win a tie.
 */
function bestCandidate(paper: PreparedPaper, aspect: PreparedAspect): Candidate | null {
  let best: Candidate | null = null;
  for (const section of paper.sections) {
    const preferred = prefersSection(aspect.kind, section.name);
    for (const sentence of section.sentences) {
      const hits = countKeywordHits(fold(sentence), aspect.matchers);
      if (hits === 0) continue;
      const score = hits * PAPER_KEYWORD_HIT_WEIGHT + (preferred ? PAPER_PREFERRED_SECTION_BONUS : 0);
      if (best === null || score > best.score) best = { text: sentence, section: section.name, score };
    }
  }
  return best;
}

/** How many distinct aspect keywords one folded sentence carries. */
function countKeywordHits(foldedSentence: string, matchers: readonly RegExp[]): number {
  let hits = 0;
  for (const matcher of matchers) {
    if (matcher.test(foldedSentence)) hits += 1;
  }
  return hits;
}

// --- Summary ---------------------------------------------------------------

/** One distinct wording an aspect was stated with, and the cells that state it. */
interface Reading {
  /** The first cell's exact text, which is what the summary quotes. */
  text: string;
  cells: PaperCell[];
}

/**
 * Reads the matrix back as prose: one entry per aspect, carrying the consensus sentence, the
 * divergence sentence, or neither.
 *
 * Every sentence is assembled from the matrix's own cells and rows — the quotes are cells'
 * `text`, the names are rows' `title` — so nothing is invented. Cells are grouped by their
 * quoted wording, folded for case, diacritics, spacing and edge punctuation: an aspect agrees
 * when at least two papers wrote that same sentence, and diverges when two or more distinct
 * wordings were found. A single witness is reported as neither, because one paper cannot agree
 * with itself, and a gap is listed rather than counted as disagreement.
 *
 * A refused or empty matrix produces an empty summary.
 */
export function summarise(matrix: PaperMatrix): PaperSummary {
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  const aspects = Array.isArray(matrix?.aspects) ? matrix.aspects : [];
  if (rows.length === 0 || aspects.length === 0) return { aspects: [] };

  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const gaps = Array.isArray(matrix?.gaps) ? matrix.gaps : [];
  const titleById = new Map<string, string>();
  const orderById = new Map<string, number>();
  rows.forEach((row, index) => {
    titleById.set(row.paperId, row.title);
    orderById.set(row.paperId, index);
  });

  const summaries: PaperAspectSummary[] = [];
  for (const aspect of aspects) {
    const aspectCells = cells
      .map((cell, position) => ({ cell, position }))
      .filter(entry => entry.cell?.aspectId === aspect.aspectId)
      .sort(
        (left, right) =>
          orderOf(orderById, left.cell.paperId) - orderOf(orderById, right.cell.paperId)
          || left.position - right.position,
      )
      .map(entry => entry.cell);
    const unmentioned = gaps
      .filter(gap => gap?.aspectId === aspect.aspectId)
      .map(gap => titleFor(titleById, gap.paperId));

    const quotedPapers = aspectCells.map(cell => titleFor(titleById, cell.paperId));
    const readings = groupReadings(aspectCells);
    const summary: PaperAspectSummary = {
      aspectId: aspect.aspectId,
      label: aspect.label,
      quotedPapers,
      unmentioned,
      consensus: null,
      divergence: null,
    };

    const reading = readings[0];
    if (readings.length === 1 && reading && reading.cells.length >= 2) {
      const speakers = listOf(reading.cells.map(cell => titleFor(titleById, cell.paperId)));
      const accounted = reading.cells.length + unmentioned.length;
      summary.consensus = asSentence(
        unmentioned.length === 0
          ? `All ${reading.cells.length} papers agree on ${aspect.label} — ${speakers}: “${reading.text}”`
          : `${reading.cells.length} of ${accounted} papers agree on ${aspect.label} — ${speakers}: “${reading.text}”; not mentioned by ${listOf(unmentioned)}`,
      );
    } else if (readings.length >= 2) {
      const tail = unmentioned.length > 0 ? `; not mentioned by ${listOf(unmentioned)}` : '';
      const clauses = readings.map(group => {
        const speakers = listOf(group.cells.map(cell => titleFor(titleById, cell.paperId)));
        return `${speakers}: “${group.text}”`;
      });
      summary.divergence = asSentence(`Papers disagree on ${aspect.label} — ${clauses.join('; ')}${tail}`);
    }

    summaries.push(summary);
  }

  return { aspects: summaries };
}

function groupReadings(cells: readonly PaperCell[]): Reading[] {
  const readings: Reading[] = [];
  const byKey = new Map<string, Reading>();
  for (const cell of cells) {
    const key = normaliseQuote(cell.text);
    const seen = byKey.get(key);
    if (seen) {
      seen.cells.push(cell);
      continue;
    }
    const reading: Reading = { text: cell.text, cells: [cell] };
    byKey.set(key, reading);
    readings.push(reading);
  }
  return readings;
}

// --- Rendering -------------------------------------------------------------

/**
 * Writes the matrix as a GitHub-flavoured Markdown table: a "Paper" column, a "Year" column,
 * and one column per aspect whose every cell carries the quote and the section it came from.
 * A pair without evidence is written as {@link PAPER_GAP_MARKER} rather than an empty cell.
 *
 * Pipes are escaped and a cell's own line breaks become `<br>`, so a quote cannot end its row
 * early. A refused or empty matrix writes an empty string: there is nothing to show and no
 * header worth inventing.
 */
export function toMarkdown(matrix: PaperMatrix): string {
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  const aspects = Array.isArray(matrix?.aspects) ? matrix.aspects : [];
  if (rows.length === 0 || aspects.length === 0) return '';

  const index = cellIndex(Array.isArray(matrix?.cells) ? matrix.cells : []);
  const lines: string[] = [];
  lines.push(markdownRow(['Paper', 'Year', ...aspects.map(aspect => aspect.label)]));
  lines.push(`| ${Array.from({ length: aspects.length + 2 }, () => '---').join(' | ')} |`);

  for (const row of rows) {
    const fields = aspects.map(aspect => {
      const cell = index.get(cellKey(row.paperId, aspect.aspectId));
      return cell ? cellText(cell) : PAPER_GAP_MARKER;
    });
    const year = Number.isInteger(row.year) && row.year > 0 ? String(row.year) : '';
    lines.push(markdownRow([row.title, year, ...fields]));
  }
  return lines.join('\n');
}

/** What one rendered cell says: the quote, then the section that holds it. */
function cellText(cell: PaperCell): string {
  const section = collapseSpace(cell.section);
  return `“${collapseSpace(cell.text)}” — ${section.length > 0 ? section : PAPER_UNNAMED_SECTION}`;
}

function cellIndex(cells: readonly PaperCell[]): Map<string, PaperCell> {
  const index = new Map<string, PaperCell>();
  for (const cell of cells) {
    if (!cell) continue;
    const key = cellKey(cell.paperId, cell.aspectId);
    if (!index.has(key)) index.set(key, cell);
  }
  return index;
}

function cellKey(paperId: string, aspectId: string): string {
  return `${paperId}\u0000${aspectId}`;
}

function markdownRow(cells: readonly string[]): string {
  return `| ${cells.map(markdownCell).join(' | ')} |`;
}

function markdownCell(value: string): string {
  const text = typeof value === 'string' ? value : '';
  return text.replace(/\r\n|\r|\n/gu, '<br>').replace(/\|/gu, '\\|');
}

// --- Inputs ----------------------------------------------------------------

/**
 * Papers that can be compared: objects with a non-blank unique id. A paper with no usable
 * section is kept, because its silence is a result — it becomes gaps, not a missing row.
 */
function preparePapers(papers: readonly Paper[] | undefined): PreparedPaper[] {
  if (!Array.isArray(papers)) return [];
  const seen = new Set<string>();
  const prepared: PreparedPaper[] = [];
  for (const paper of papers) {
    if (!paper || typeof paper !== 'object') continue;
    const id = typeof paper.id === 'string' ? paper.id.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const title = typeof paper.title === 'string' ? paper.title.trim() : '';
    const sections = prepareSections(paper.sections);
    prepared.push({
      id,
      title: title.length > 0 ? title : id,
      year: readYear(paper.year),
      sections,
      hasText: sections.some(section => section.sentences.length > 0),
    });
  }
  return prepared;
}

function prepareSections(sections: readonly PaperSection[] | undefined): PreparedSection[] {
  if (!Array.isArray(sections)) return [];
  const prepared: PreparedSection[] = [];
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const sentences = splitSentences(section.text);
    // A section with no sentence has nothing a cell could quote.
    if (sentences.length === 0) continue;
    prepared.push({
      name: typeof section.name === 'string' ? collapseSpace(section.name) : '',
      sentences,
    });
  }
  return prepared;
}

/**
 * Aspects that can produce a column: a non-blank unique id and at least one usable keyword.
 * An aspect whose keywords all fold away is dropped rather than rendering a column of gaps
 * that would read as every paper's silence.
 */
function prepareAspects(aspects: readonly PaperAspect[] | undefined): PreparedAspect[] {
  if (!Array.isArray(aspects)) return [];
  const seen = new Set<string>();
  const prepared: PreparedAspect[] = [];
  for (const aspect of aspects) {
    if (!aspect || typeof aspect !== 'object') continue;
    const id = typeof aspect.id === 'string' ? aspect.id.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    const matchers = keywordMatchers(aspect.keywords);
    if (matchers.length === 0) continue;
    seen.add(id);
    const label = typeof aspect.label === 'string' ? aspect.label.trim() : '';
    prepared.push({
      id,
      label: label.length > 0 ? label : id,
      kind: readKind(aspect.kind),
      matchers,
    });
  }
  return prepared;
}

function keywordMatchers(keywords: readonly string[] | undefined): RegExp[] {
  if (!Array.isArray(keywords)) return [];
  const matchers: RegExp[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    const matcher = keywordMatcher(keyword);
    if (!matcher || seen.has(matcher.source)) continue;
    seen.add(matcher.source);
    matchers.push(matcher);
  }
  return matchers;
}

/** Separator allowed between the words of one keyword: space, no-break space, dash, apostrophe. */
const KEYWORD_SEPARATOR = '[\\s\\u00A0\\u202F\\u2009\\p{Pd}\\u2019\']*';

/**
 * One keyword as a stateless matcher over folded text.
 *
 * The keyword is folded and split on anything that is not a letter or a digit, so `pre-trained`
 * becomes `pre` + `trained` and the separator between them is optional: it finds `pre-trained`,
 * `pretrained` and `pre trained`. Both ends are whole-word boundaries, and a plural `s`/`es` is
 * allowed at the end, so `dataset` finds `datasets` while `data` does not find the `data` in
 * `database`.
 */
function keywordMatcher(keyword: unknown): RegExp | null {
  if (typeof keyword !== 'string') return null;
  const words = fold(keyword).split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 0);
  if (words.length === 0) return null;
  const body = words.map(escapePattern).join(KEYWORD_SEPARATOR);
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:s|es)?(?![\\p{L}\\p{N}])`, 'u');
  } catch {
    return null;
  }
}

/** Escapes every regular-expression metacharacter in one literal word. */
function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** An unrecognised kind reads as `other`, which prefers no section, never a guessed one. */
function readKind(value: unknown): PaperAspectKind {
  return PAPER_ASPECT_KINDS.find(kind => kind === value) ?? 'other';
}

function readYear(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

// --- Section preference ----------------------------------------------------

/**
 * Words that make a section the natural home of one kind of aspect. Matched as folded
 * substrings of the folded section name, so `Materials and Methods`, `method`, `Methodology`
 * and `4.2 Proposed approach` all prefer a methodology aspect, and `Data set`, `Datasets`,
 * `Participants` and `Experimental setup` all prefer a dataset aspect.
 *
 * These are only a bonus: a section name never makes a sentence match on its own.
 */
const PREFERRED_SECTION_WORDS: Readonly<Record<PaperAspectKind, readonly string[]>> = {
  methodology: ['method', 'approach', 'procedure', 'protocol'],
  dataset: ['data', 'corpus', 'participant', 'subject', 'sample', 'material', 'collection', 'setup'],
  metric: ['result', 'evaluation', 'evaluate', 'metric', 'experiment', 'finding', 'performance', 'measure'],
  other: [],
};

function prefersSection(kind: PaperAspectKind, sectionName: string): boolean {
  const words = PREFERRED_SECTION_WORDS[kind];
  if (words.length === 0) return false;
  const folded = fold(sectionName);
  if (folded.length === 0) return false;
  return words.some(word => folded.includes(word));
}

// --- Sentences -------------------------------------------------------------

/** A sentence end: a run of enders followed by space or the end of the text, or a line break. */
const SENTENCE_BREAK = /[.!?…。！？]+(?=\s|$)|\n+/gu;

/**
 * Words whose full stop does not end a sentence, lowercase and without the dot. An initials dot
 * (`J.`) is covered by the single-letter rule instead.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'al', 'approx', 'ca', 'cf', 'e.g', 'eq', 'eqs', 'fig', 'figs', 'i.e', 'no', 'ref', 'refs',
  'sec', 'tab', 'vs',
]);

/**
 * Cuts section text into sentences, whitespace collapsed, empty pieces dropped.
 *
 * A full stop after a single letter or a listed abbreviation does not end a sentence when the
 * text continues in lowercase, which keeps `e.g. bert` and `García et al. we train` whole. The
 * guard never merges two real sentences, because the next one starts with a capital.
 */
function splitSentences(text: unknown): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const sentences: string[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_BREAK)) {
    const index = match.index ?? 0;
    const run = match[0];
    const end = index + run.length;
    const newline = run.startsWith('\n');
    if (!newline && isAbbreviationStop(run, text, index, end)) continue;
    // A punctuation run belongs to the sentence it ends, so a quote keeps the paper's own full
    // stop; a line break belongs to neither side and is dropped.
    pushSentence(sentences, text.slice(start, newline ? index : end));
    start = end;
  }
  pushSentence(sentences, text.slice(start));
  return sentences;
}

/**
 * True when a break should be skipped because what it follows is an abbreviation: the run is
 * dots only, the token before it is a single letter or a listed abbreviation, and the text after
 * it resumes in lowercase.
 */
function isAbbreviationStop(run: string, text: string, index: number, end: number): boolean {
  if (!/^\.+$/u.test(run)) return false;
  const word = /([\p{L}][\p{L}\p{M}.'’-]*)$/u.exec(text.slice(0, index))?.[1] ?? '';
  if (word.length === 0) return false;
  const token = word.toLowerCase().replace(/\.+$/u, '');
  if (token.length !== 1 && !ABBREVIATIONS.has(token)) return false;
  const rest = text.slice(end).replace(/^\s+/u, '');
  const next = rest.charAt(0);
  // A digit is equal to both its cases, so only a lowercase letter counts as a continuation.
  return next.length > 0 && next === next.toLowerCase() && next !== next.toUpperCase();
}

function pushSentence(sentences: string[], raw: string): void {
  const text = collapseSpace(raw);
  if (text.length > 0) sentences.push(text);
}

// --- Text folding ----------------------------------------------------------

const COMBINING_MARKS = /\p{M}+/gu;

/** Punctuation a quote may pick up at its edges; it is not part of the wording. */
const EDGE_PUNCTUATION = /^[\s.,;:!?\u2026'"“”‘’()[\]{}]+|[\s.,;:!?\u2026'"“”‘’()[\]{}]+$/gu;

/** Sentence-ending punctuation, optionally closed by a quote or bracket. */
const ENDS_SENTENCE = /[.!?…。！？]["'”’)]?$/u;

/**
 * Folds text for matching: compatibility forms normalised, diacritics dropped, case lowered,
 * `đ` written as `d`. `Hà Nội` and `Ha Noi` therefore meet, and so do `Đà Nẵng` and `Da Nang`.
 */
function fold(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/đ/gu, 'd');
}

/**
 * The key two quotes are grouped by: folded, whitespace collapsed, and edge punctuation removed
 * so `We use BERT.` and `We use BERT` are one wording. A quote that is nothing but punctuation
 * keeps its collapsed form rather than folding away to an empty key.
 */
function normaliseQuote(text: unknown): string {
  const folded = collapseSpace(fold(text));
  if (folded.length === 0) return '';
  const trimmed = folded.replace(EDGE_PUNCTUATION, '');
  return trimmed.length > 0 ? trimmed : folded;
}

// --- Sentences built from cells -------------------------------------------

/**
 * Ends one assembled sentence. A quote already ending its sentence keeps its own punctuation,
 * so a rendered line never reads `.”..`; anything else gets a full stop.
 */
function asSentence(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  return ENDS_SENTENCE.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Joins names for prose. One name is written alone; several are comma-separated. */
function listOf(values: readonly string[]): string {
  return values.join(', ');
}

function titleFor(titleById: ReadonlyMap<string, string>, paperId: string): string {
  const title = titleById.get(paperId);
  return typeof title === 'string' && title.length > 0 ? title : paperId;
}

function orderOf(orderById: ReadonlyMap<string, number>, paperId: string): number {
  return orderById.get(paperId) ?? Number.MAX_SAFE_INTEGER;
}

// --- Small helpers ---------------------------------------------------------

function collapseSpace(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}
