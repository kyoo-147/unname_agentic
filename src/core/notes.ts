/**
 * Study notes from a document (backlog item I14).
 *
 * A reader who has finished a section wants a short list of what it said, where the
 * terms were defined, and which formulas were shown — with a way back to the page.
 * This module builds that from the Document IR: sections taken from the outline
 * (`outline.ts`), points taken from the paragraphs, definitions read from
 * term-is sentences, and formulas recovered by `formulas.ts`. Every entry carries the
 * page and the block id it came from, so a click on a line lands on the line.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no locale. The same
 *   document and the same options always produce the same notes, entry for entry.
 * - Nothing is invented. Every title, point, term and formula is input text folded to
 *   single spaces (a formula's `latex` is the conversion `formulas.ts` writes). A block
 *   that cannot be placed in a section, a paragraph that yields no usable sentence, and
 *   a term that does not pass the definition rules simply do not appear.
 * - Sections follow `buildOutline`: one notes section per outline section, in
 *   pre-order. The IR block carries no heading level, so every heading opens a level-1
 *   section unless the caller passes `headingLevels`; content before the first heading
 *   becomes one section whose title falls back to {@link UNTITLED_SECTION_TITLE}.
 * - Points are paragraph sentences. The first sentence of a paragraph is always a
 *   point (`kind: 'lead'`); another sentence is kept only when it carries a digit
 *   (`kind: 'number'`) or a bold-like cue (`kind: 'emphasis'`): an emphasis label such
 *   as `Note:` / `Lưu ý:`, a run of three or more capitals, or `**…**` / `__…__`
 *   markers. Lead beats number beats emphasis when a sentence qualifies for several.
 *   A repeated sentence is one point per section, and each section is capped at
 *   `maxPointsPerSection` (default {@link DEFAULT_MAX_POINTS_PER_SECTION}), keeping the
 *   earliest points in reading order. A sentence that also reaches the definition list
 *   is not removed from the points: the points rule is unconditional, and the
 *   definition list is a second, card-shaped view of the same text.
 * - Definitions are term-is sentences in English (`X is/are …, X is defined as …,
 *   X refers to …, X means …`) and Vietnamese (`X là …, X được định nghĩa là …,
 *   X có nghĩa là …`). A term must be 1..{@link DEFINITION_MAX_TERM_WORDS} words,
 *   at most {@link DEFINITION_MAX_TERM_CHARS} characters, must not be a pronoun or
 *   demonstrative, and the generic `is/là` form needs at least
 *   {@link DEFINITION_MIN_BODY_WORDS} content words after the leading article. One
 *   definition per term: the first occurrence in reading order wins. This is pattern
 *   matching, not parsing: a sentence such as `The room is large and bright.` can
 *   still reach the list, which is why the term rules above are deliberately tight.
 * - Formulas come from `detectFormulas`, so both display equations and bare runs
 *   inside prose are captured. Identical LaTeX on the same page is captured once, at
 *   its first block, and the list is capped at `maxFormulas` (default
 *   {@link DEFAULT_MAX_FORMULAS}). A formula longer than `maxEntryChars` is dropped,
 *   never clipped: cutting LaTeX in half would silently change it.
 * - Length: no entry is longer than `maxEntryChars` (default
 *   {@link DEFAULT_MAX_ENTRY_CHARS}) characters, counted as Unicode code points.
 *   Point and definition text is clipped at a word boundary and marked with
 *   {@link TRUNCATION_MARK}; a term is clipped only when the caller sets a limit below
 *   {@link DEFINITION_MAX_TERM_CHARS}.
 * - An empty document, or a document without blocks, produces empty notes: no
 *   sections, no definitions, no formulas, and every summary count at 0.
 */

import { detectFormulas } from './formulas';
import type { Block, DocumentIR } from './ir';
import {
  buildOutline,
  SYNTHETIC_BLOCK_ID_PREFIX,
  type OutlineBlockInput,
  type TocEntry,
} from './outline';

/** Points kept per section when the caller does not say otherwise. */
export const DEFAULT_MAX_POINTS_PER_SECTION = 6;

/** Characters allowed per entry when the caller does not say otherwise. */
export const DEFAULT_MAX_ENTRY_CHARS = 280;

/** Formulas captured per document when the caller does not say otherwise. */
export const DEFAULT_MAX_FORMULAS = 200;

/** Longest term a definition may name, in characters. */
export const DEFINITION_MAX_TERM_CHARS = 64;

/** Most words a term a definition may name may hold. */
export const DEFINITION_MAX_TERM_WORDS = 6;

/**
 * Content words the generic `X is a …` / `X là …` form needs behind its leading
 * article. A shorter body is a description (`Mercury is a metal.`), not a definition
 * worth a card.
 */
export const DEFINITION_MIN_BODY_WORDS = 3;

/** Content words the explicit forms (`is defined as`, `có nghĩa là`, …) need. */
export const DEFINITION_MIN_EXPLICIT_BODY_WORDS = 1;

/** A longer sentence is prose with a verb in it, not a definition. */
export const MAX_DEFINITION_SENTENCE_CHARS = 600;

/** Title of the section that owns content before the first heading. */
export const UNTITLED_SECTION_TITLE = 'Overview';

/** Section anchors are this prefix plus the 1-based section number. */
export const ANCHOR_PREFIX = 'notes-h';

/** First heading of a rendered Markdown document. */
export const NOTES_MARKDOWN_TITLE = 'Study notes';

/** RFC 4180 record separator. */
export const CSV_RECORD_SEPARATOR = '\r\n';

/** Appended to a clipped entry so a reader can see the sentence was cut. */
export const TRUNCATION_MARK = '…';

/** Why one sentence became a point. */
export type NotePointKind = 'lead' | 'number' | 'emphasis';

/** One sentence of a section, with the page and block it was read from. */
export interface NotePoint {
  /** Folded sentence text, at most `maxEntryChars` code points. */
  text: string;
  /** 1-based page the block sits on. */
  page: number;
  /** Id of the block the sentence was read from. */
  blockId: string;
  kind: NotePointKind;
}

/** One notes section: an outline section and its points. */
export interface NoteSection {
  /** Heading text, or {@link UNTITLED_SECTION_TITLE} for the preamble section. */
  title: string;
  /** 1-based page the section starts on. */
  page: number;
  /** The section's jump target, exactly as `outline.ts` resolves it. */
  blockId: string;
  /** Points in reading order; empty when the section holds none. */
  points: NotePoint[];
}

/** One definition, as a term and the text that explained it. */
export interface NoteDefinition {
  term: string;
  text: string;
  page: number;
  blockId: string;
}

/** One formula, as the LaTeX of one math run. */
export interface NoteFormula {
  latex: string;
  page: number;
  blockId: string;
}

/** How many entries of each kind the notes hold. */
export interface NotesSummary {
  sections: number;
  points: number;
  definitions: number;
  formulas: number;
}

export interface Notes {
  /** Sections in pre-order, the same order a table of contents renders. */
  sections: NoteSection[];
  /** Definitions in reading order; one per term. */
  definitions: NoteDefinition[];
  /** Formulas in reading order; one per distinct LaTeX on a page. */
  formulas: NoteFormula[];
  summary: NotesSummary;
}

export interface NotesOptions {
  /** Points kept per section; 0 keeps none. Defaults to {@link DEFAULT_MAX_POINTS_PER_SECTION}. */
  maxPointsPerSection?: number;
  /** Characters allowed per entry; defaults to {@link DEFAULT_MAX_ENTRY_CHARS}. */
  maxEntryChars?: number;
  /** Formulas captured per document; 0 captures none. Defaults to {@link DEFAULT_MAX_FORMULAS}. */
  maxFormulas?: number;
  /**
   * Heading level per block id. The IR does not store one, so supply it when the
   * caller classified the blocks with `blocks.ts` and wants real nesting.
   */
  headingLevels?: Readonly<Record<string, number>>;
}

/** Options after defaults and floors are applied. */
interface ReadOptions {
  maxPointsPerSection: number;
  maxEntryChars: number;
  maxFormulas: number;
  headingLevels: Readonly<Record<string, number>> | undefined;
}

/** One IR block with the id and page this module uses for it. */
interface OrderedBlock {
  block: Block;
  id: string;
  page: number;
}

/** A sentence that matched a definition pattern, before the entry rules run. */
interface DefinitionMatch {
  term: string;
  text: string;
}

/** Sentence-ending characters; `…` ends one too, since PDFs use it for ellipses. */
const SENTENCE_END_CHARACTERS = '.!?…';

/** Abbreviations whose trailing dot does not end a sentence. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'e.g',
  'i.e',
  'a.k.a',
  'u.s',
  'u.k',
  'cf',
  'fig',
  'figs',
  'eq',
  'eqs',
  'no',
  'nos',
  'vol',
  'vols',
  'sec',
  'ch',
  'p',
  'pp',
  'al',
  'etc',
  'vs',
  'dr',
  'mr',
  'mrs',
  'ms',
  'st',
  'prof',
  'inc',
  'ltd',
  'co',
  'jr',
  'sr',
  'approx',
  'ref',
  'refs',
]);

/** A bold-like emphasis label opening a sentence: `Note:`, `Lưu ý:`, `Warning —`. */
const EMPHASIS_LABEL_PATTERN =
  /^(?:note|nb|important|key|remember|warning|caution|attention|tip|lưu ý|ghi chú|quan trọng|chú ý|nhớ|cảnh báo)\s*[:\-–—]/iu;

/** A run of capitals, which is how a bold run often survives text extraction. */
const UPPERCASE_RUN_PATTERN = /(?<![\p{L}])\p{Lu}{3,}(?![\p{L}])/u;

/** Markdown bold markers, when the source text already carries them. */
const MARKDOWN_BOLD_PATTERN = /\*\*[^*\n]+\*\*|__[^_\n]+__/u;

/** A digit: the cue that makes a non-lead sentence worth keeping. */
const DIGIT_PATTERN = /\d/u;

/** A leading article, dropped from a term so `The cell` and `cell` are one term. */
const LEADING_ARTICLE = /^(?:the|a|an|một|các|những)\s+/iu;

/** Pronoun and demonstrative terms: a sentence starting with one is not a definition. */
const STOP_TERMS: ReadonlySet<string> = new Set([
  'this',
  'that',
  'these',
  'those',
  'it',
  'there',
  'they',
  'he',
  'she',
  'we',
  'you',
  'i',
  'one',
  'which',
  'what',
  'who',
  'someone',
  'something',
  'such',
  'each',
  'both',
  'all',
  'some',
  'many',
  'most',
  'none',
  'đây',
  'đó',
  'kia',
  'nó',
  'chúng',
  'họ',
  'điều này',
  'điều đó',
  'cái này',
  'cái đó',
  'tôi',
  'bạn',
  'chúng ta',
]);

/** `X is defined as …`, `X refers to …`, `X means …`. */
const EXPLICIT_PATTERNS: readonly RegExp[] = [
  /^(?<term>.+?)\s+(?:is|are)\s+(?:defined|known)\s+as\s+(?<body>.+)$/iu,
  /^(?<term>.+?)\s+refers?\s+to\s+(?<body>.+)$/iu,
  /^(?<term>.+?)\s+means?\s+(?<body>.+)$/iu,
  /^(?<term>.+?)\s+được\s+định\s+nghĩa\s+là\s+(?<body>.+)$/iu,
  /^(?<term>.+?)\s+(?:có\s+)?nghĩa\s+là\s+(?<body>.+)$/iu,
];

/**
 * `X is a …`, `X is the …`, `X là …`. The article stays in the body because the
 * definition reads better with it; it is dropped only for the word count.
 */
const GENERIC_PATTERNS: readonly RegExp[] = [
  /^(?<term>.+?)\s+(?:is|are)\s+(?<body>(?:a|an|the)\s+.+)$/iu,
  /^(?<term>.+?)\s+là\s+(?<body>.+)$/iu,
];

/** Characters a Markdown inline run must escape to stay text. */
const MARKDOWN_ESCAPED = /[\\`*_[\]]/gu;

/**
 * Builds study notes from a document.
 *
 * See the module contract for what is captured and how. The document is only read:
 * the returned notes are new arrays and new objects.
 */
export function buildNotes(ir: DocumentIR, options: NotesOptions = {}): Notes {
  const settings = readOptions(options);
  const blocks = orderedBlocks(ir);
  if (blocks.length === 0) return emptyNotes();

  const outline = buildOutline(blocks.map(row => toOutlineInput(row, settings)));
  const { sections, byId } = sectionShells(outline.toc);

  const sectionByBlock = new Map<string, string>();
  for (const member of outline.members) {
    if (!member) continue;
    if (typeof member.blockId !== 'string' || typeof member.sectionId !== 'string') continue;
    sectionByBlock.set(member.blockId, member.sectionId);
  }

  const definitions = readDefinitions(blocks, settings);
  readPoints(blocks, sectionByBlock, byId, settings);
  const formulas = readFormulas(blocks, settings);

  return {
    sections,
    definitions,
    formulas,
    summary: {
      sections: sections.length,
      points: sections.reduce((total, section) => total + section.points.length, 0),
      definitions: definitions.length,
      formulas: formulas.length,
    },
  };
}

/**
 * Anchor a Markdown renderer can jump to for the section at `index` (0-based, the
 * position in `Notes.sections`). The number is 1-based, matching the document order a
 * reader sees.
 */
export function sectionAnchor(index: number): string {
  const position = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  return `${ANCHOR_PREFIX}${position + 1}`;
}

/**
 * Writes the notes as Markdown: a contents list that links to one anchor per section,
 * then the sections with their points, then the definitions and the formulas.
 *
 * Every entry keeps its source: a point, definition or formula line ends with
 * `p.<page> · <blockId>`, and a section's own line reads `Page <n> · block <id>`. That
 * locator is what the reader resolves back to the document. Section titles and entry
 * text are escaped so a `*`, `_`, backtick or bracket cannot open formatting, and a
 * formula is written as inline code. Notes with nothing in them write the empty string.
 */
export function toMarkdown(notes: Notes): string {
  const sections = Array.isArray(notes?.sections) ? notes.sections : [];
  const definitions = Array.isArray(notes?.definitions) ? notes.definitions : [];
  const formulas = Array.isArray(notes?.formulas) ? notes.formulas : [];
  if (sections.length === 0 && definitions.length === 0 && formulas.length === 0) return '';

  const lines: string[] = [`# ${NOTES_MARKDOWN_TITLE}`, ''];

  if (sections.length > 0) {
    lines.push('## Contents', '');
    sections.forEach((section, index) => {
      lines.push(`- [${escapeInlineText(section.title)}](#${sectionAnchor(index)})`);
    });
    lines.push('', '## Notes', '');

    sections.forEach((section, index) => {
      lines.push(`<a id="${sectionAnchor(index)}"></a>`, '');
      lines.push(`### ${escapeInlineText(section.title)}`, '');
      lines.push(sourceLine(section.page, section.blockId), '');
      for (const point of section.points) {
        const label = sourceLabel(point.page, point.blockId);
        lines.push(`- ${escapeInlineText(point.text)} *(${label})*`);
      }
      lines.push('');
    });
  }

  if (definitions.length > 0) {
    lines.push('## Definitions', '');
    for (const definition of definitions) {
      const label = sourceLabel(definition.page, definition.blockId);
      lines.push(`- **${escapeInlineText(definition.term)}** — ${escapeInlineText(definition.text)} *(${label})*`);
    }
    lines.push('');
  }

  if (formulas.length > 0) {
    lines.push('## Formulas', '');
    for (const formula of formulas) {
      const label = sourceLabel(formula.page, formula.blockId);
      lines.push(`- ${inlineCode(formula.latex)} *(${label})*`);
    }
    lines.push('');
  }

  return renderLines(lines);
}

/**
 * Writes one question/answer row per definition and per formula, for an Anki import.
 *
 * A definition asks `What is <term>?` and answers with its text; a formula asks
 * `Write the formula on page <n> (<blockId>).` and answers with the LaTeX wrapped in
 * `\(…\)` so a MathJax-enabled card set renders it. Every field is quoted and inner
 * double quotes are doubled, exactly as RFC 4180 allows, so a term or answer may keep
 * its own commas, quotes and line breaks. Records are separated by CRLF; notes with
 * nothing to ask write the empty string.
 */
export function toAnkiCsv(notes: Notes): string {
  const definitions = Array.isArray(notes?.definitions) ? notes.definitions : [];
  const formulas = Array.isArray(notes?.formulas) ? notes.formulas : [];

  const rows: string[][] = [];
  for (const definition of definitions) {
    rows.push([`What is ${definition.term}?`, definition.text]);
  }
  for (const formula of formulas) {
    const question = `Write the formula on page ${formula.page} (${formula.blockId}).`;
    rows.push([question, `\\(${formula.latex}\\)`]);
  }
  if (rows.length === 0) return '';

  return rows.map(row => row.map(csvField).join(',')).join(CSV_RECORD_SEPARATOR);
}

// --- Reading the document --------------------------------------------------

/**
 * The document's blocks in reading order, each with the id this module refers to it by.
 *
 * Ordering matches `retrieval.ts`: reading order, then page, then id, then the input
 * position. A block without an id gets the outline's synthetic id, so a malformed
 * document still yields entries a caller can trace.
 */
function orderedBlocks(ir: DocumentIR): OrderedBlock[] {
  const raw = Array.isArray(ir?.blocks) ? ir.blocks : [];
  const rows = raw
    .map((block, position) => ({ block, position }))
    .filter(row => typeof row.block === 'object' && row.block !== null)
    .sort(
      (left, right) =>
        finiteOr(left.block.readingOrder, 0) - finiteOr(right.block.readingOrder, 0) ||
        finiteOr(left.block.page, 1) - finiteOr(right.block.page, 1) ||
        compareText(left.block.id, right.block.id) ||
        left.position - right.position,
    );

  return rows.map((row, position) => ({
    block: row.block,
    id: blockIdOf(row.block, position),
    page: pageOf(row.block),
  }));
}

function toOutlineInput(row: OrderedBlock, settings: ReadOptions): OutlineBlockInput {
  const input: OutlineBlockInput = {
    id: row.id,
    page: row.page,
    text: textOf(row.block),
    type: row.block.type,
  };
  const level = settings.headingLevels ? settings.headingLevels[row.id] : undefined;
  if (typeof level === 'number' && Number.isFinite(level)) input.headingLevel = level;
  return input;
}

/** One notes section per outline section, in pre-order, plus the lookup by section id. */
function sectionShells(toc: readonly TocEntry[]): { sections: NoteSection[]; byId: Map<string, NoteSection> } {
  const sections: NoteSection[] = [];
  const byId = new Map<string, NoteSection>();

  for (const entry of toc) {
    if (!entry) continue;
    const title = typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : UNTITLED_SECTION_TITLE;
    const section: NoteSection = {
      title,
      page: pageOfEntry(entry.page),
      blockId: typeof entry.blockId === 'string' ? entry.blockId : '',
      points: [],
    };
    sections.push(section);
    if (typeof entry.id === 'string') byId.set(entry.id, section);
  }
  return { sections, byId };
}

function readDefinitions(blocks: readonly OrderedBlock[], settings: ReadOptions): NoteDefinition[] {
  const definitions: NoteDefinition[] = [];
  const seen = new Set<string>();
  const termLimit = Math.min(DEFINITION_MAX_TERM_CHARS, settings.maxEntryChars);

  for (const row of blocks) {
    if (row.block.type !== 'paragraph') continue;
    for (const sentence of splitSentences(textOf(row.block))) {
      const match = parseDefinition(sentence);
      if (!match) continue;
      const key = fold(match.term);
      if (key.length === 0 || seen.has(key)) continue;

      const term = clipText(match.term, termLimit);
      const text = clipText(match.text, settings.maxEntryChars);
      if (term.length === 0 || text.length === 0) continue;

      seen.add(key);
      definitions.push({ term, text, page: row.page, blockId: row.id });
    }
  }
  return definitions;
}

/** Fills each section's points, in reading order, capped and de-duplicated per section. */
function readPoints(
  blocks: readonly OrderedBlock[],
  sectionByBlock: ReadonlyMap<string, string>,
  byId: ReadonlyMap<string, NoteSection>,
  settings: ReadOptions,
): void {
  if (settings.maxPointsPerSection === 0) return;
  const seenBySection = new Map<string, Set<string>>();

  for (const row of blocks) {
    if (row.block.type !== 'paragraph') continue;
    const sectionId = sectionByBlock.get(row.id);
    if (sectionId === undefined) continue;
    const section = byId.get(sectionId);
    if (!section) continue;
    if (section.points.length >= settings.maxPointsPerSection) continue;

    let seen = seenBySection.get(sectionId);
    if (!seen) {
      seen = new Set<string>();
      seenBySection.set(sectionId, seen);
    }

    const sentences = splitSentences(textOf(row.block));
    for (let index = 0; index < sentences.length; index += 1) {
      const sentence = sentences[index];
      if (sentence === undefined) continue;
      const kind = pointKind(sentence, index === 0);
      if (kind === undefined) continue;

      const text = clipText(sentence, settings.maxEntryChars);
      if (text.length === 0 || seen.has(text)) continue;

      seen.add(text);
      section.points.push({ text, page: row.page, blockId: row.id, kind });
      if (section.points.length >= settings.maxPointsPerSection) break;
    }
  }
}

function readFormulas(blocks: readonly OrderedBlock[], settings: ReadOptions): NoteFormula[] {
  const formulas: NoteFormula[] = [];
  if (settings.maxFormulas === 0) return formulas;

  const hits = detectFormulas(blocks.map(row => ({ id: row.id, raw: textOf(row.block) })));
  const seen = new Set<string>();

  for (const hit of hits) {
    const row = blocks[hit.index];
    if (!row) continue;
    for (const formula of hit.formulas) {
      if (formulas.length >= settings.maxFormulas) return formulas;
      const latex = typeof formula.latex === 'string' ? formula.latex.trim() : '';
      if (latex.length === 0) continue;
      // Clipping a formula would silently change it, so an over-long one is left out.
      if (characterCount(latex) > settings.maxEntryChars) continue;

      const key = `${row.page}\u0000${latex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      formulas.push({ latex, page: row.page, blockId: row.id });
    }
  }
  return formulas;
}

// --- Sentences and definitions ---------------------------------------------

/**
 * Splits folded text into sentences at `.`, `!`, `?` and `…` when the run is followed
 * by whitespace or the end of the text.
 *
 * A single dot is not an end when it follows a digit (so `3.5` stays one sentence),
 * when it is followed by a letter (so `e.g.` inside a token is not split), when the
 * word before it is an abbreviation (`Fig.`, `p.`, `e.g`), or when it follows a single
 * capital letter (`J. Smith`). A text with no sentence end is one sentence.
 */
function splitSentences(value: string): string[] {
  const text = fold(value);
  if (text.length === 0) return [];

  const sentences: string[] = [];
  let start = 0;
  let index = 0;

  while (index < text.length) {
    const character = text.charAt(index);
    if (!SENTENCE_END_CHARACTERS.includes(character)) {
      index += 1;
      continue;
    }

    let end = index;
    while (end + 1 < text.length && SENTENCE_END_CHARACTERS.includes(text.charAt(end + 1))) end += 1;

    const next = text.charAt(end + 1);
    if (next !== '' && !/\s/u.test(next)) {
      index = end + 1;
      continue;
    }
    if (end === index && character === '.' && isGuardedDot(text, index)) {
      index = end + 1;
      continue;
    }

    const sentence = text.slice(start, end + 1).trim();
    if (sentence.length > 0) sentences.push(sentence);
    start = end + 1;
    index = end + 1;
  }

  const tail = text.slice(start).trim();
  if (tail.length > 0) sentences.push(tail);
  return sentences;
}

/** True when the dot at `at` sits inside a number, a token or an abbreviation. */
function isGuardedDot(text: string, at: number): boolean {
  const previous = text.charAt(at - 1);
  if (DIGIT_PATTERN.test(previous)) return true;
  if (/\p{L}/u.test(text.charAt(at + 1))) return true;
  const word = wordEndingAt(text, at);
  if (word.length === 1 && /\p{Lu}/u.test(previous)) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

/** The letters, digits and dots immediately before `at`, without leading dots. */
function wordEndingAt(text: string, at: number): string {
  let start = at;
  while (start > 0 && /[\p{L}.\p{N}]/u.test(text.charAt(start - 1))) start -= 1;
  return text.slice(start, at).replace(/^\.+/u, '');
}

/** Reads a sentence as a definition, or returns null when it is not one. */
function parseDefinition(sentence: string): DefinitionMatch | null {
  const text = fold(sentence);
  if (text.length === 0 || text.length > MAX_DEFINITION_SENTENCE_CHARS) return null;
  if (text.endsWith('?')) return null;

  const explicit = matchDefinition(text, EXPLICIT_PATTERNS, DEFINITION_MIN_EXPLICIT_BODY_WORDS);
  if (explicit) return explicit;
  return matchDefinition(text, GENERIC_PATTERNS, DEFINITION_MIN_BODY_WORDS);
}

function matchDefinition(
  text: string,
  patterns: readonly RegExp[],
  minBodyWords: number,
): DefinitionMatch | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;

    const term = cleanTerm(match.groups?.['term']);
    const body = cleanBody(match.groups?.['body']);
    if (!isUsableTerm(term)) continue;
    if (countWords(body.replace(LEADING_ARTICLE, '')) < minBodyWords) continue;
    return { term, text: body };
  }
  return null;
}

function cleanTerm(value: unknown): string {
  if (typeof value !== 'string') return '';
  return fold(value)
    .replace(/^["'“”‘’«»(\[]+/u, '')
    .replace(/["'“”‘’«»)\]]+$/u, '')
    .replace(LEADING_ARTICLE, '')
    .replace(/[\s,;:.]+$/u, '')
    .trim();
}

function cleanBody(value: unknown): string {
  if (typeof value !== 'string') return '';
  return fold(value)
    .replace(/^["'“”‘’«»]+/u, '')
    .replace(/["'“”‘’«»]+$/u, '')
    .replace(/[.;:,]+$/u, '')
    .trim();
}

function isUsableTerm(term: string): boolean {
  if (term.length < 2 || term.length > DEFINITION_MAX_TERM_CHARS) return false;
  const words = wordList(term);
  if (words.length === 0 || words.length > DEFINITION_MAX_TERM_WORDS) return false;
  if (STOP_TERMS.has(fold(term))) return false;
  if (!/[\p{L}\p{N}]/u.test(term)) return false;
  return !/[.!?…]/u.test(term);
}

// --- Points ----------------------------------------------------------------

function pointKind(sentence: string, isLead: boolean): NotePointKind | undefined {
  if (isLead) return 'lead';
  if (DIGIT_PATTERN.test(sentence)) return 'number';
  if (hasEmphasisCue(sentence)) return 'emphasis';
  return undefined;
}

function hasEmphasisCue(sentence: string): boolean {
  return (
    EMPHASIS_LABEL_PATTERN.test(sentence) ||
    UPPERCASE_RUN_PATTERN.test(sentence) ||
    MARKDOWN_BOLD_PATTERN.test(sentence)
  );
}

// --- Rendering -------------------------------------------------------------

/** `p.1 · p1-r2`, the locator a reader resolves back to the document. */
function sourceLabel(page: number, blockId: string): string {
  return `p.${page} · ${blockId}`;
}

/** The locator line under a section title. */
function sourceLine(page: number, blockId: string): string {
  return `Page ${page} · block ${blockId}`;
}

function escapeInlineText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(MARKDOWN_ESCAPED, character => `\\${character}`);
}

/** Inline code that still holds when the value contains a backtick. */
function inlineCode(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  const fence = text.includes('`') ? '``' : '`';
  const padded = fence === '``' ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

/** RFC 4180 field: always quoted, inner quotes doubled. */
function csvField(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  return `"${text.replace(/"/gu, '""')}"`;
}

/** Joins lines with single blank lines between blocks, no trailing blank line. */
function renderLines(lines: readonly string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\s+$/u, '');
    if (text.length === 0) {
      if (out.length > 0 && out[out.length - 1] === '') continue;
      out.push('');
      continue;
    }
    out.push(text);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

// --- Text helpers ----------------------------------------------------------

/** Collapses runs of whitespace to single spaces and trims. */
function fold(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function wordList(value: string): string[] {
  return fold(value).split(' ').filter(word => word.length > 0);
}

function countWords(value: string): number {
  return wordList(value).length;
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

/**
 * Shortens folded text to `limit` code points, cutting at a word boundary and marking
 * the cut with {@link TRUNCATION_MARK}. The mark counts towards the limit, so the
 * result is never longer than asked for; text already within the limit is unchanged.
 */
function clipText(value: string, limit: number): string {
  const text = fold(value);
  if (text.length === 0 || limit <= 0) return '';
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  if (limit === 1) return TRUNCATION_MARK;

  const head = characters.slice(0, limit - 1).join('');
  const atWord = head.replace(/\s+\S*$/u, '');
  const trimmed = (atWord.length > 0 ? atWord : head).replace(/[\s,;:.!?…\-–—]+$/u, '');
  const kept = trimmed.length > 0 ? trimmed : head.trim();
  if (kept.length === 0) return TRUNCATION_MARK;
  return `${kept}${TRUNCATION_MARK}`;
}

// --- Document plumbing -----------------------------------------------------

function readOptions(options: NotesOptions | undefined): ReadOptions {
  const value = typeof options === 'object' && options !== null ? options : {};
  return {
    maxPointsPerSection: countOr(value.maxPointsPerSection, DEFAULT_MAX_POINTS_PER_SECTION),
    maxEntryChars: countOr(value.maxEntryChars, DEFAULT_MAX_ENTRY_CHARS),
    maxFormulas: countOr(value.maxFormulas, DEFAULT_MAX_FORMULAS),
    headingLevels:
      typeof value.headingLevels === 'object' && value.headingLevels !== null
        ? value.headingLevels
        : undefined,
  };
}

/** A whole count from the caller, or the default for a missing or nonsensical one. */
function countOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const count = Math.floor(value);
  return count < 0 ? fallback : count;
}

function emptyNotes(): Notes {
  return {
    sections: [],
    definitions: [],
    formulas: [],
    summary: { sections: 0, points: 0, definitions: 0, formulas: 0 },
  };
}

function blockIdOf(block: Block, position: number): string {
  const id = block.id;
  return typeof id === 'string' && id.length > 0 ? id : `${SYNTHETIC_BLOCK_ID_PREFIX}${position}`;
}

function pageOf(block: Block): number {
  const page = block.page;
  return typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : 1;
}

function pageOfEntry(page: unknown): number {
  return typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : 1;
}

function textOf(block: Block): string {
  return typeof block.raw === 'string' ? block.raw : '';
}

function compareText(left: unknown, right: unknown): number {
  const first = typeof left === 'string' ? left : '';
  const second = typeof right === 'string' ? right : '';
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
