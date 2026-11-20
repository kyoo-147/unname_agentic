/**
 * Query rewriting: the reader's question, turned into the searches that retrieve
 * (backlog I06).
 *
 * Retrieval here is lexical — `retrieval.ts` scores BM25 over folded terms — so a
 * question typed the way a person talks retrieves worse than the same question written
 * the way the document writes it. This module closes that gap before a model is
 * involved. {@link rewriteQuery} returns one search string per intent, the content
 * terms behind them, the metadata filters the question implies, and the reasons for
 * every decision. {@link expandAcronyms} and {@link quotePhrases} are the two pieces a
 * caller may also want on their own.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network, no I/O. The
 *   same question and context always produce an equal plan, and neither argument is
 *   mutated.
 * - `queries` are the searches to run, in this order: one per intent group in the order
 *   asked, then one cross-language synonym variant per group that expanded (see
 *   {@link SYNONYM_PAIRS}), then the document title when the question is short
 *   ({@link SHORT_QUESTION_MAX_TERMS}). A question is split into intent groups at
 *   `and`, `và`, `&` and `;`, never inside a quoted span.
 * - A quoted span ({@link quotePhrases}) is never split and never rewritten: it keeps
 *   its own words and spelling and becomes a query of its own. The quote marks
 *   themselves are dropped, because they are not part of the passage text.
 * - Numbers are never removed, so `clause 4.2` and `2024` stay searchable. A page, year
 *   or section the question names is *also* extracted into `filters`; the words that
 *   name it stay in the query, because the passage usually repeats them.
 * - `keywords` are the distinct content terms of the queries that will run, folded by
 *   `retrieval.ts`'s own `tokenize`, so `index.postings.has(keyword)` answers "will this
 *   term hit the index". They are terms, not phrases: `hợp đồng` is `hop` and `dong`,
 *   because that is what BM25 stores. The title fallback contributes to `queries` only,
 *   never to `keywords`, so a keyword list always describes the question.
 * - `reasons` are stable English codes, in the order the decisions were made, the
 *   convention `abstain.ts` uses: a caller localises a sentence for the reader and logs
 *   the code.
 * - A question made only of question words yields no query at all and says so
 *   (`no-terms`). That is a result, not an error: searching for `what is` retrieves
 *   noise. `recentTerms` is the caller's escape hatch for a question that refers back
 *   (`what about that?`): it becomes the query when nothing else is left.
 * - Question *verbs* such as `say` and `mean` are deliberately kept. They are the
 *   question frame in `what does 4.2 say?`, but `mean` is a quantity in this reader's
 *   papers, so the list of question words stops at the pronouns and determiners.
 *
 * Language:
 * - The question's language is inferred from the question: a Vietnamese tone mark, the
 *   horn, `đ`, or a Vietnamese question or function word makes it Vietnamese;
 *   everything else is English.
 * - Stripping is language-specific on purpose. Folding makes Vietnamese `số` and
 *   English `so` the same string, and likewise `đỏ`/`do`, `ăn`/`an`, `nó`/`no`,
 *   `máy`/`may`. A blanket bilingual stop list would delete those Vietnamese content
 *   words, so only the question's own list is applied.
 * - `context.language` is the *document's* language. It decides whether the
 *   cross-language synonym variant is worth running: when the document and the question
 *   are in different languages the variant translates the question's terms. When the
 *   document's language is not declared, the variant is emitted only for a Vietnamese
 *   question — the reader asks in Vietnamese and the document is not assumed to be.
 */

import type { GlossaryEntry } from './glossary';
import { normalizeLanguageCode } from './language';
import { tokenize } from './retrieval';

// --- Public shape ----------------------------------------------------------

/** The reading session a question is asked in. Every field is optional. */
export interface QueryContext {
  /** Title of the document being read; used as a weak query for a short question. */
  documentTitle?: string;
  /**
   * The document's language (`vi`, `en`, or any other tag `language.ts` accepts; an
   * unrecognised tag is ignored). It decides whether a synonym variant is emitted; see
   * the module note on language.
   */
  language?: string;
  /**
   * Terms the reader used most recently, newest last. Used only when the question
   * itself leaves no content term, so `what about that?` still searches something.
   */
  recentTerms?: readonly string[];
}

/** Metadata a question asks for, to narrow a search that is already lexical. */
export interface QueryFilters {
  /** 1-based page named by `page 12`, `p. 12`, `trang 12` or `第12页`. */
  page?: number;
  /** Four-digit year named by the question, `1900`..`2099`. */
  year?: number;
  /** Section named by `section 3.2`, `mục 2`, `chương IV`, `§4`; digits and dots. */
  section?: string;
}

/**
 * One decision, as a stable English code.
 *
 * - `quoted-phrase-kept`: the question carries a quoted span, kept whole.
 * - `words-stripped`: at least one question word or function word was removed.
 * - `intent-split`: the question holds more than one intent group.
 * - `acronym-expanded`: the question already carries the `ACRONYM (Expansion)` form
 *   {@link expandAcronyms} writes, so its words are searched.
 * - `synonym-expanded`: a {@link SYNONYM_PAIRS} counterpart was added.
 * - `title-query-added`: the document title was added as a weak query.
 * - `recent-terms-used`: the question left nothing, and `recentTerms` became the query.
 * - `no-terms`: the question left nothing and there was no fallback.
 * - `page-filter`, `year-filter`, `section-filter`: `filters` carries that field.
 */
export type QueryReason =
  | 'quoted-phrase-kept'
  | 'words-stripped'
  | 'intent-split'
  | 'acronym-expanded'
  | 'synonym-expanded'
  | 'title-query-added'
  | 'recent-terms-used'
  | 'no-terms'
  | 'page-filter'
  | 'year-filter'
  | 'section-filter'
  | 'empty-question';

/** The searches to run, the terms behind them, the filters implied, and why. */
export interface QueryPlan {
  /** Searches in the order to run them; empty when the question carries no content. */
  queries: string[];
  /** Distinct content terms of `queries`, folded, in order of first appearance. */
  keywords: string[];
  /** Metadata filters the question names; `{}` when it names none. */
  filters: QueryFilters;
  /** The decisions behind the plan, in the order they were made. */
  reasons: QueryReason[];
}

/**
 * A caller-provided acronym map: a plain record, a `Map`, or the entries
 * `parseGlossary` returns. A source that is not acronym-shaped is ignored, so a
 * glossary of ordinary terms can be passed without harm.
 */
export type AcronymInput =
  | Readonly<Record<string, string>>
  | ReadonlyMap<string, string>
  | readonly GlossaryEntry[];

// --- Public constants ------------------------------------------------------

/**
 * A question with at most this many content terms is "short": it does not say what the
 * document is about, so the title is added as a weak second query.
 */
export const SHORT_QUESTION_MAX_TERMS = 3;

/** Most terms one intent group may produce from `recentTerms`, keeping the newest last. */
export const RECENT_TERM_LIMIT = 5;

/** Most intent groups one question may produce; the tail folds into the last group. */
export const MAX_INTENT_GROUPS = 4;

/**
 * The documented bilingual synonym table, `[Vietnamese, English]`.
 *
 * Small on purpose — a table nobody reads is a table nobody trusts — and ordered at use
 * time longest first, so `giá trị` is translated before `giá` gets a chance to turn
 * `giá trị` into `price trị`. Both directions are in the table: the rewrite adds the
 * counterpart of whichever side the question uses.
 */
export const SYNONYM_PAIRS: readonly (readonly [string, string])[] = [
  ['hợp đồng', 'contract'],
  ['điều khoản', 'clause'],
  ['giá trị', 'value'],
  ['giá', 'price'],
  ['thanh toán', 'payment'],
  ['trách nhiệm', 'liability'],
  ['bảo mật', 'confidentiality'],
  ['chấm dứt', 'termination'],
  ['tranh chấp', 'dispute'],
  ['bảo hành', 'warranty'],
  ['thời hạn', 'deadline'],
  ['phụ lục', 'appendix'],
  ['thuế', 'tax'],
  ['luật áp dụng', 'governing law'],
];

// --- Entry points ----------------------------------------------------------

/**
 * Turns one question into the searches to run.
 *
 * The steps, in order, each of which can leave a reason:
 * quoted spans are masked so nothing below can touch them; the question is split into
 * intent groups; question words and function words of the question's language are
 * removed from each group; each group becomes a query, plus a synonym variant when the
 * document is in another language; the title is added for a short question; `recentTerms`
 * covers a question that left nothing; finally the page, year and section filters are
 * read from the whole question.
 *
 * `queries[0]` is the best single search the module can produce for the question, so a
 * caller can run it alone when it has budget for one search.
 */
export function rewriteQuery(question: string, context: QueryContext = {}): QueryPlan {
  const text = normalizeSpace(question);
  if (text.length === 0) {
    return { queries: [], keywords: [], filters: {}, reasons: ['empty-question'] };
  }

  const language = detectQuestionLanguage(text);
  const spans = quotedSpans(text);
  const masked = maskQuotes(text, spans);
  const groups = splitIntents(masked);

  const questionPhrases = language === 'vi' ? QUESTION_PHRASES_VI : QUESTION_PHRASES_EN;
  const stops = language === 'vi' ? STOP_WORDS_VI : STOP_WORDS_EN;
  const variantsWanted = variantWorthwhile(language, context.language);

  const queries: string[] = [];
  const variants: string[] = [];
  const seen = new Set<string>();
  let stripped = false;
  let expanded = false;

  for (const group of groups) {
    let current = group;
    for (const phrase of questionPhrases) {
      const removed = rewriteStandalone(current, phrase, ' ');
      if (removed.count === 0) continue;
      current = removed.text;
      stripped = true;
    }
    const words = removeStopwords(current, stops);
    if (words.count > 0) {
      current = words.text;
      stripped = true;
    }

    let variant: string | null = null;
    if (variantsWanted) {
      let candidate = current;
      let changed = false;
      for (const [source, target] of SYNONYM_PAIRS_SORTED) {
        const forward = rewriteStandalone(candidate, source, target);
        if (forward.count > 0) {
          candidate = forward.text;
          changed = true;
          continue;
        }
        const backward = rewriteStandalone(candidate, target, source);
        if (backward.count > 0) {
          candidate = backward.text;
          changed = true;
        }
      }
      if (changed) {
        expanded = true;
        variant = tidyQuery(unmask(candidate, spans));
      }
    }

    const query = tidyQuery(unmask(current, spans));
    if (query.length > 0 && !seen.has(fold(query))) {
      seen.add(fold(query));
      queries.push(query);
    }
    if (variant !== null && variant.length > 0 && !seen.has(fold(variant))) {
      seen.add(fold(variant));
      variants.push(variant);
    }
  }

  const primaryTerms = contentTerms(queries, stops);
  queries.push(...variants);
  const keywords = contentTerms(queries, stops);
  const short = queries.length > 0 && primaryTerms.length <= SHORT_QUESTION_MAX_TERMS;

  const reasons: QueryReason[] = [];
  if (spans.length > 0) reasons.push('quoted-phrase-kept');
  if (stripped) reasons.push('words-stripped');
  if (groups.length > 1) reasons.push('intent-split');
  if (ACRONYM_EXPANSION.test(text)) reasons.push('acronym-expanded');
  if (expanded) reasons.push('synonym-expanded');

  if (queries.length === 0) {
    const recent = recentQuery(context.recentTerms, stops);
    if (recent !== null) {
      queries.push(recent.query);
      for (const term of recent.terms) {
        if (!keywords.includes(term)) keywords.push(term);
      }
      reasons.push('recent-terms-used');
    } else {
      reasons.push('no-terms');
    }
  } else if (short) {
    const title = tidyQuery(normalizeSpace(context.documentTitle));
    if (title.length > 0 && !seen.has(fold(title))) {
      seen.add(fold(title));
      queries.push(title);
      reasons.push('title-query-added');
    }
  }

  const filters = readFilters(text);
  if (filters.page !== undefined) reasons.push('page-filter');
  if (filters.year !== undefined) reasons.push('year-filter');
  if (filters.section !== undefined) reasons.push('section-filter');

  return { queries, keywords, filters, reasons };
}

/**
 * Writes the expansion of every acronym in `question` next to it, in the
 * `ACRONYM (Expansion)` form.
 *
 * The acronym is matched folded and standalone, so `Rag` is `RAG` and `RAGS` is not.
 * Only the first occurrence of each acronym is expanded, and nothing is expanded when
 * the expansion is already spelled out somewhere in the question — the point is to add
 * words the document may use, never to repeat them. A glossary source that is not
 * acronym-shaped (it has lowercase letters, or one capital) is left alone: `hợp đồng`
 * belongs in {@link SYNONYM_PAIRS}, not here.
 */
export function expandAcronyms(question: string, glossary: AcronymInput): string {
  const text = normalizeSpace(question);
  if (text.length === 0) return '';

  let current = text;
  for (const [acronym, expansion] of acronymPairs(glossary)) {
    const needle = fold(acronym);
    const spelled = fold(expansion).replace(/\s+/gu, ' ').trim();
    if (needle.length === 0 || spelled.length === 0) continue;

    const { folded, starts } = foldWithMap(current);
    if (folded.includes(spelled)) continue;

    const at = findStandalone(folded, needle);
    if (at === null) continue;
    const end = starts[at + needle.length];
    if (end === undefined) continue;
    if (current.slice(end).trimStart().startsWith('(')) continue;

    current = `${current.slice(0, end)} (${normalizeSpace(expansion)})${current.slice(end)}`;
  }
  return current;
}

/**
 * The quoted spans of a question, in order, without their quote marks.
 *
 * Double quotes (straight and curly), single quotes (straight and curly), guillemets and
 * corner brackets are all read. A single quote only opens a span when it does not sit
 * inside a word, so `don't` is an apostrophe and not the start of a quotation. Spans do
 * not nest; a span with no closing mark is ignored rather than swallowing the rest of
 * the question.
 */
export function quotePhrases(question: string): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();
  for (const span of quotedSpans(normalizeSpace(question))) {
    const key = fold(span.text);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    phrases.push(span.text);
  }
  return phrases;
}

// --- Question words and function words -------------------------------------

/**
 * Vietnamese phrasings that ask something rather than name it, sorted longest first at
 * load so `là bao nhiêu` is removed before `bao nhiêu`, and `bao nhiêu` before `gì`.
 * Bare `ai`, `sao` and `đâu` are deliberately absent: `AI` is the acronym this reader's
 * documents are about, `sao` is a star, and `đâu` folds onto `đau` and `dấu`.
 */
const QUESTION_PHRASES_VI: readonly string[] = [
  'là bao nhiêu', 'như thế nào', 'cho biết', 'là gì', 'bao nhiêu', 'như nào', 'thế nào',
  'ra sao', 'bao lâu', 'bao giờ', 'ở đâu', 'khi nào', 'tại sao', 'vì sao', 'cái gì',
  'cho hỏi', 'xin hỏi', 'có phải', 'phải không', 'đúng không', 'được không', 'là chi',
  'bao nhiu', 'gì', 'nào',
].sort((left, right) => right.length - left.length);

/** English phrasings that ask something rather than name it, longest first. */
const QUESTION_PHRASES_EN: readonly string[] = [
  'what is', 'what are', 'what does', 'what do', 'how many', 'how much', 'how long',
  'how often', 'is there', 'are there', 'tell me', 'please', 'which', 'whose', 'whom',
  'who', 'when', 'where', 'why', 'how', 'what',
].sort((left, right) => right.length - left.length);

/** English function words, folded. */
const FUNCTION_WORDS_EN: readonly string[] = [
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'but', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'with', 'by', 'from', 'as', 'that', 'this', 'these',
  'those', 'it', 'its', 'does', 'do', 'did', 'has', 'have', 'had', 'can', 'could',
  'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'not', 'no', 'yes',
  'there', 'their', 'then', 'than', 'so', 'if', 'into', 'about', 'over', 'under',
  'between', 'vs', 'per', 'via', 'we', 'you', 'they', 'he', 'she', 'i', 'me', 'my',
  'our', 'your', 'his', 'her', 'them', 'us', 'any', 'all', 'each', 'more', 'most',
  'some', 'such', 'very', 'just', 'also', 'however', 'therefore', 'thus', 'while',
  'during', 'after', 'before', 'again', 'once', 'here', 'both', 'few', 'other', 'own',
  'same', 'too', 'only', 'against', 'because', 'until', 'upon', 'within', 'without',
  'across', 'along', 'around', 'behind', 'below', 'beside', 'beyond', 'much', 'many',
  'whether', 'ever', 'explain', 'describe', 'summarize', 'summarise',
];

/** Vietnamese function words, folded; single tokens only, `removeStopwords` walks words. */
const FUNCTION_WORDS_VI: readonly string[] = [
  'và', 'của', 'các', 'những', 'một', 'là', 'có', 'cho', 'trong', 'với', 'về', 'khi',
  'thì', 'mà', 'này', 'đó', 'để', 'từ', 'đến', 'theo', 'như', 'được', 'không', 'người',
  'ra', 'vào', 'lên', 'xuống', 'đã', 'đang', 'sẽ', 'bị', 'do', 'nên', 'nhưng', 'hoặc',
  'cũng', 'rất', 'hơn', 'nhất', 'tại', 'bằng', 'vì', 'nếu', 'sau', 'trước', 'giữa',
  'trên', 'dưới', 'lại', 'đi', 'rằng', 'vẫn', 'còn', 'phải', 'đây', 'kia', 'ấy', 'họ',
  'chúng', 'tôi', 'bạn', 'anh', 'chị', 'em', 'ông', 'bà', 'liệu', 'hãy', 'nhé', 'vậy',
  'nhỉ', 'à', 'ừ', 'ạ', 'giúp',
];

/**
 * Connectives that join two intents. Folded, and shared by both languages whatever the
 * question's language is: neither can be a content word in the other one.
 */
const INTENT_CONNECTORS: readonly string[] = ['and', 'va', '&', ';'];

/** Words that never survive into a keyword list, built from the lists above. */
const STOP_WORDS_EN: ReadonlySet<string> = buildStopWords(QUESTION_PHRASES_EN, FUNCTION_WORDS_EN);
const STOP_WORDS_VI: ReadonlySet<string> = buildStopWords(QUESTION_PHRASES_VI, FUNCTION_WORDS_VI);

/** The synonym table, longest first, so a shorter term never pre-empts a longer one. */
const SYNONYM_PAIRS_SORTED: readonly (readonly [string, string])[] = [...SYNONYM_PAIRS].sort(
  (left, right) => longestSide(right) - longestSide(left),
);

/** `ACRONYM (Expansion)`: the shape {@link expandAcronyms} writes and we recognise. */
const ACRONYM_EXPANSION = /\p{Lu}{2,}[\p{N}\p{Ll}-]*\s*\([^)]{2,}\)/u;

/** The five Vietnamese tone marks, the horn, and `đ`; English uses none of them. */
const VIETNAMESE_DIACRITIC = /[\u0300\u0301\u0303\u0309\u0323\u031b]|[đĐ]/u;

/** Question or function words that only Vietnamese uses, folded. */
const VIETNAMESE_MARKERS: readonly string[] = [
  'la gi', 'bao nhieu', 'nhu the nao', 'the nao', 'tai sao', 'o dau', 'khi nao', 'cua',
  'khong', 'nhung', 'duoc', 'trong',
];

const PAGE_PATTERN = /(?:\bpages?|\bp\.|\btrang|第)\s*(\d{1,4})/iu;
const YEAR_PATTERN = /(?:^|[^\p{L}\p{N}])((?:19|20)\d{2})(?![\p{L}\p{N}])/u;
/**
 * A section or clause reference. The lookbehind instead of `\b` because `\b` is defined
 * on ASCII word characters, so `\bđiều` could never match — `đ` is not one of them.
 * `clause` and `điều` count as sections: that is how a contract numbers its parts.
 */
const SECTION_PATTERN =
  /(?<![\p{L}\p{N}])(?:section|sec|clause|mục|phần|chương|chapter|điều|§)\.?\s*([0-9]+(?:[.,][0-9]+)*|[IVXLCDM]+)/iu;

/** Quote pairs, open then close. A pair whose two marks are equal closes on the next one. */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ['“', '”'],
  ['‘', '’'],
  ['«', '»'],
  ["'", "'"],
  ['「', '」'],
];

/** Markers that stand in for a quoted span while the rest of the question is rewritten. */
const MASK_PATTERN = /\uE000(\d+)\uE001/gu;
const MASK_OPEN = '\uE000';
const MASK_CLOSE = '\uE001';

/** Longest acronym {@link expandAcronyms} accepts, in characters. */
const ACRONYM_MAX_CHARS = 16;

// --- Filters ---------------------------------------------------------------

/** Reads the page, year and section a question names; the first of each is used. */
function readFilters(text: string): QueryFilters {
  const filters: QueryFilters = {};
  const page = firstNumber(PAGE_PATTERN, text);
  if (page !== null) filters.page = page;

  const year = firstNumber(YEAR_PATTERN, text);
  // A page reference wins a number collision: `page 1900` names a page, not a year.
  if (year !== null && year !== page) filters.year = year;

  const section = SECTION_PATTERN.exec(text)?.[1];
  if (section !== undefined) {
    const normalized = normalizeSection(section);
    if (normalized.length > 0) filters.section = normalized;
  }
  return filters;
}

function firstNumber(pattern: RegExp, text: string): number | null {
  const match = pattern.exec(text);
  if (match === null) return null;
  const value = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(value) ? value : null;
}

/** `3,2` is the same section as `3.2`; a Roman numeral is upper-cased. */
function normalizeSection(value: string): string {
  const trimmed = value.replace(/,/gu, '.').trim();
  return /^[ivxlcdm]+$/iu.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

// --- Masking and splitting -------------------------------------------------

interface QuotedSpan {
  /** Offset of the opening mark. */
  start: number;
  /** Offset just past the closing mark. */
  end: number;
  /** The span's text, trimmed and without its marks. */
  text: string;
}

function quotedSpans(text: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  let index = 0;
  while (index < text.length) {
    const pair = QUOTE_PAIRS.find(([open]) => text.startsWith(open, index));
    if (pair === undefined) {
      index += 1;
      continue;
    }
    const [open, close] = pair;
    if (!canOpenQuote(text, index)) {
      index += open.length;
      continue;
    }
    const closeAt = text.indexOf(close, index + open.length);
    if (closeAt < 0) {
      index += open.length;
      continue;
    }
    const inner = text.slice(index + open.length, closeAt).trim();
    const end = closeAt + close.length;
    if (inner.length > 0) spans.push({ start: index, end, text: inner });
    index = end;
  }
  return spans;
}

/** A quote cannot open inside a word, which is what makes `don't` an apostrophe. */
function canOpenQuote(text: string, index: number): boolean {
  if (index === 0) return true;
  return !isWordChar(text.charAt(index - 1));
}

function maskQuotes(text: string, spans: readonly QuotedSpan[]): string {
  let masked = '';
  let cursor = 0;
  spans.forEach((span, position) => {
    masked += text.slice(cursor, span.start) + `${MASK_OPEN}${position}${MASK_CLOSE}`;
    cursor = span.end;
  });
  return masked + text.slice(cursor);
}

function unmask(text: string, spans: readonly QuotedSpan[]): string {
  return text.replace(MASK_PATTERN, (whole, marker: string) => {
    const span = spans[Number(marker)];
    return span === undefined ? whole : span.text;
  });
}

/**
 * Cuts a masked question at `and`, `và`, `&` and `;`.
 *
 * Only whole words count, so `Anderson` is not two intents; `&` and `;` carry their own
 * boundary and need no whitespace around them. Past {@link MAX_INTENT_GROUPS} the tail
 * joins the last group: a question with a dozen `and`s must not become a dozen weak
 * searches competing for the same passages.
 */
function splitIntents(text: string): string[] {
  const { folded, starts } = foldWithMap(text);
  const cuts: Array<[number, number]> = [];
  let index = 0;

  while (index < folded.length) {
    let hit = '';
    for (const connector of INTENT_CONNECTORS) {
      if (!folded.startsWith(connector, index)) continue;
      const end = index + connector.length;
      const free = connector === '&' || connector === ';';
      if (!free && (!startsWord(folded, index) || !endsWord(folded, end))) continue;
      hit = connector;
      break;
    }
    if (hit.length === 0) {
      index += 1;
      continue;
    }
    cuts.push([starts[index] ?? 0, starts[index + hit.length] ?? text.length]);
    index += hit.length;
  }

  if (cuts.length === 0) return [text];

  const segments: string[] = [];
  let cursor = 0;
  for (const [start, end] of cuts) {
    if (start < cursor) continue;
    segments.push(text.slice(cursor, start));
    cursor = end;
  }
  segments.push(text.slice(cursor));

  const groups = segments.map(segment => normalizeSpace(segment)).filter(segment => segment.length > 0);
  if (groups.length <= 1) return [text];
  if (groups.length <= MAX_INTENT_GROUPS) return groups;

  const head = groups.slice(0, MAX_INTENT_GROUPS - 1);
  const tail = groups.slice(MAX_INTENT_GROUPS - 1).join(' ');
  return [...head, tail];
}

// --- Language --------------------------------------------------------------

/**
 * Vietnamese when the question carries a Vietnamese diacritic or a Vietnamese question
 * or function word; English otherwise.
 *
 * English has no diacritics, which makes a tone mark or the horn decisive; `đ` does not
 * decompose, so it is checked on the original text.
 */
function detectQuestionLanguage(question: string): 'vi' | 'en' {
  if (VIETNAMESE_DIACRITIC.test(question.normalize('NFD'))) return 'vi';
  const folded = fold(question);
  for (const marker of VIETNAMESE_MARKERS) {
    if (hasStandalone(folded, marker)) return 'vi';
  }
  return 'en';
}

/**
 * Whether a synonym variant of the question is worth a second search: only when the
 * document is declared to be in the other language, and, when it is not declared at all,
 * only for a Vietnamese question.
 */
function variantWorthwhile(questionLanguage: 'vi' | 'en', declared: string | undefined): boolean {
  const documentLanguage = declaredLanguage(declared);
  if (documentLanguage === null) return questionLanguage === 'vi';
  return documentLanguage !== questionLanguage;
}

function declaredLanguage(value: string | undefined): 'vi' | 'en' | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const code = normalizeLanguageCode(value);
  return code === 'vi' || code === 'en' ? code : null;
}

// --- Term handling ---------------------------------------------------------

/** Removes every standalone occurrence of one question phrase, folded. */
function rewriteStandalone(text: string, needle: string, replacement: string): { text: string; count: number } {
  const target = fold(needle).replace(/\s+/gu, ' ').trim();
  if (target.length === 0 || text.length === 0) return { text, count: 0 };

  const { folded, starts } = foldWithMap(text);
  const ranges: Array<[number, number]> = [];
  for (const [start, end] of standaloneRanges(folded, target)) {
    ranges.push([starts[start] ?? 0, starts[end] ?? text.length]);
  }
  return spliceOut(text, ranges, replacement);
}

/**
 * Removes the function words of one language in a single pass over the folded text.
 *
 * One pass rather than one pass per word: the word list is long and the question is
 * short, and the token boundaries are already walked once here. Punctuation between
 * tokens is preserved, which keeps `4.2` and `R-D` readable in the query.
 */
function removeStopwords(text: string, stops: ReadonlySet<string>): { text: string; count: number } {
  if (text.length === 0) return { text, count: 0 };
  const { folded, starts } = foldWithMap(text);
  const ranges: Array<[number, number]> = [];
  let index = 0;

  while (index < folded.length) {
    if (!isWordChar(folded.charAt(index))) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < folded.length && isWordChar(folded.charAt(end))) end += 1;
    if (stops.has(folded.slice(index, end))) {
      ranges.push([starts[index] ?? 0, starts[end] ?? text.length]);
    }
    index = end;
  }
  return spliceOut(text, ranges, ' ');
}

/** Distinct content terms of `sources`, folded, in order of first appearance. */
function contentTerms(sources: readonly string[], stops: ReadonlySet<string>): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const term of tokenize(source)) {
      if (term.length === 0 || seen.has(term) || stops.has(term)) continue;
      seen.add(term);
      terms.push(term);
    }
  }
  return terms;
}

/** The newest terms of a question that left nothing, as a query and as keywords. */
function recentQuery(
  recentTerms: readonly string[] | undefined,
  stops: ReadonlySet<string>,
): { query: string; terms: string[] } | null {
  if (!Array.isArray(recentTerms) || recentTerms.length === 0) return null;
  const words: string[] = [];
  for (const term of recentTerms) {
    const word = normalizeSpace(term);
    if (word.length > 0 && !words.includes(word)) words.push(word);
  }
  if (words.length === 0) return null;

  const recent = words.slice(-RECENT_TERM_LIMIT);
  const terms = contentTerms(recent, stops);
  if (terms.length === 0) return null;
  return { query: recent.join(' '), terms };
}

// --- Small helpers ---------------------------------------------------------

/** Lowercases, decomposes and drops combining marks, and folds `đ` to `d`. */
function fold(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/gu, 'd');
}

/**
 * Folds a text while remembering where each folded character came from.
 *
 * `starts[i]` is the offset in the original string of the character that produced
 * folded code unit `i`; `starts[folded.length]` is the original length, so a matched
 * folded range converts to an original range with two lookups. Folding can change the
 * length (a diacritic disappears), which is why the map exists at all, and one entry is
 * pushed per code unit rather than per character, so a character outside the basic
 * plane still maps back to the offsets that surround it.
 */
function foldWithMap(text: string): { folded: string; starts: number[] } {
  let folded = '';
  const starts: number[] = [];
  let index = 0;

  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const piece = foldCharacter(character);
    for (let unit = 0; unit < piece.length; unit += 1) starts.push(index);
    folded += piece;
    index += character.length;
  }
  starts.push(text.length);
  return { folded, starts };
}

function foldCharacter(character: string): string {
  return character
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/gu, 'd');
}

/** Folded `[start, end)` pairs of every standalone occurrence of `target`. */
function standaloneRanges(folded: string, target: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let from = 0;
  while (from <= folded.length - target.length) {
    const at = folded.indexOf(target, from);
    if (at < 0) break;
    const end = at + target.length;
    if (startsWord(folded, at) && endsWord(folded, end)) {
      ranges.push([at, end]);
      from = end;
      continue;
    }
    from = at + 1;
  }
  return ranges;
}

function findStandalone(folded: string, target: string): number | null {
  const ranges = standaloneRanges(folded, target);
  const first = ranges[0];
  return first === undefined ? null : first[0];
}

function hasStandalone(folded: string, target: string): boolean {
  return findStandalone(folded, target) !== null;
}

/** Replaces the given original ranges with `replacement` and folds the spacing back. */
function spliceOut(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  replacement: string,
): { text: string; count: number } {
  let output = '';
  let cursor = 0;
  let count = 0;
  for (const [start, end] of ranges) {
    if (start < cursor || end <= start) continue;
    output += text.slice(cursor, start) + replacement;
    cursor = end;
    count += 1;
  }
  if (count === 0) return { text, count: 0 };
  output += text.slice(cursor);
  return { text: normalizeSpace(output), count };
}

/** Collapses whitespace runs and trims; the one-line form every value is stored in. */
function normalizeSpace(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

/** Trims the punctuation a removed word leaves behind at the edges of a query. */
function tidyQuery(text: string): string {
  return normalizeSpace(text)
    .replace(/\s+([,;:.!?…])/gu, '$1')
    .replace(/^[,;:.!?…\s]+/u, '')
    .replace(/[,;:.!?…\s]+$/u, '')
    .trim();
}

function buildStopWords(phrases: readonly string[], words: readonly string[]): ReadonlySet<string> {
  const stops = new Set<string>();
  for (const word of words) {
    const folded = fold(word).trim();
    if (folded.length > 0) stops.add(folded);
  }
  for (const phrase of phrases) {
    for (const term of tokenize(phrase)) stops.add(term);
  }
  for (const connector of INTENT_CONNECTORS) stops.add(connector);
  return stops;
}

function longestSide(pair: readonly [string, string]): number {
  return Math.max(fold(pair[0]).length, fold(pair[1]).length);
}

function isWordChar(character: string): boolean {
  return character.length > 0 && /[\p{L}\p{N}]/u.test(character);
}

/** True when no word character precedes `index`, so a match there starts a word. */
function startsWord(folded: string, index: number): boolean {
  return index <= 0 || !isWordChar(folded.charAt(index - 1));
}

/** True when no word character sits at `index`, so a match ending there ends a word. */
function endsWord(folded: string, index: number): boolean {
  return index >= folded.length || !isWordChar(folded.charAt(index));
}

function isAcronym(value: string): boolean {
  if (value.length < 2 || value.length > ACRONYM_MAX_CHARS) return false;
  if (/\p{Ll}/u.test(value)) return false;
  const capitals = value.match(/\p{Lu}/gu);
  return (capitals?.length ?? 0) >= 2;
}

/** `[acronym, expansion]` pairs of any accepted glossary shape, longest acronym first. */
function acronymPairs(glossary: AcronymInput | undefined): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  if (!glossary) return pairs;

  const push = (source: unknown, target: unknown): void => {
    if (typeof source !== 'string' || typeof target !== 'string') return;
    const acronym = normalizeSpace(source);
    const expansion = normalizeSpace(target);
    if (!isAcronym(acronym) || expansion.length === 0) return;
    pairs.push([acronym, expansion]);
  };

  const input = glossary as unknown;
  if (Array.isArray(input)) {
    for (const entry of input as readonly GlossaryEntry[]) push(entry?.source, entry?.target);
  } else if (input instanceof Map) {
    for (const [source, target] of input as ReadonlyMap<string, string>) push(source, target);
  } else if (typeof input === 'object') {
    for (const [source, target] of Object.entries(input as Record<string, unknown>)) push(source, target);
  }

  pairs.sort((left, right) => right[0].length - left[0].length);
  return pairs;
}
