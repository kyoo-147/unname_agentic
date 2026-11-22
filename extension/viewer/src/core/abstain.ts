/**
 * Evidence sufficiency and abstention (backlog item I11).
 *
 * The last line of defence against an invented answer is knowing when not to answer at
 * all. This module takes the context `planContext` planned for one question and judges
 * whether it carries that question: {@link assessEvidence} returns a verdict with the
 * coverage it measured, the signals behind the verdict, and the question terms the
 * context never contains. {@link abstainMessage} is the sentence the reader sees when
 * the verdict is not `answer`. {@link guardAnswer} is the gate for the model's prose: an
 * answer that arrives without a citation while the evidence did not support one is
 * refused instead of shown.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network, no I/O. Equal
 *   question and context always produce an equal assessment.
 * - Nothing is assembled on either side of the judgement. Coverage is a count of
 *   folded question terms found in the context text; `missing` lists the terms that
 *   were not found; every reason names a signal the caller can re-measure.
 * - Terms are folded (case and diacritics removed) and function words dropped, so
 *   `hệ thống` meets `he thong` and `Đà Nẵng` meets `Da Nang`, the same normalisation
 *   `retrieval.ts` applies to its index. A run of Han characters is also cut into
 *   character bigrams: that script separates no words with spaces, and an exact-run
 *   match alone would abstain on every Chinese question that is not copied verbatim.
 * - Three signals decide the verdict, in this order: a question without content words
 *   or a context without text abstains outright; a numeric or yes/no question that did
 *   not get the kind of evidence it needs abstains; otherwise the share of the question
 *   the whole context covers (`coverage`) and the share its best single block covers
 *   decide between `answer` and `weak`.
 * - The verdict never claims the documents are wrong, only that they do not answer
 *   this question. `weak` is an answer shown with a caution; `abstain` is no answer at
 *   all.
 */

import { parseCitations } from './citations';
import type { ContextBlock } from './multi-document';

// --- Public shape ----------------------------------------------------------

/** What the planned evidence supports. */
export type EvidenceVerdict = 'answer' | 'weak' | 'abstain';

/**
 * One measured signal behind a verdict. The codes are stable and English: a reader sees
 * a localised sentence from {@link abstainMessage}, a log keeps the code.
 *
 * - `no-query-terms`: the question holds no content word, so nothing could have matched.
 * - `empty-context`: the planner found no excerpt for the question.
 * - `number-question-without-figure`: a quantity was asked for and the context carries
 *   no digit at all.
 * - `low-coverage`: fewer than {@link ABSTAIN_COVERAGE_FLOOR} of the question's terms
 *   appear in the context.
 * - `partial-coverage`: the context holds some of the terms, but fewer than
 *   {@link ANSWER_COVERAGE_FLOOR}.
 * - `fragmented-evidence`: the terms are there, but no single block holds
 *   {@link BEST_BLOCK_COVERAGE_FLOOR} of them, so no sentence in the context supports
 *   the question on its own.
 * - `polar-question-unconfirmed`: a yes/no question whose evidence is not strong enough
 *   to pick a side; a hedged yes is still a guess.
 */
export type AbstainReason =
  | 'no-query-terms'
  | 'empty-context'
  | 'number-question-without-figure'
  | 'low-coverage'
  | 'partial-coverage'
  | 'fragmented-evidence'
  | 'polar-question-unconfirmed';

/** What the evidence supports, and the numbers behind that judgement. */
export interface EvidenceAssessment {
  verdict: EvidenceVerdict;
  /**
   * Share of the question's distinct content terms the context contains, 0..1, rounded
   * to three decimals. `0` when the question has no content term or the context is
   * empty.
   */
  coverage: number;
  /** The signals behind the verdict, in the order the checks ran; empty for `answer`. */
  reasons: AbstainReason[];
  /** Question terms the context never contains, folded, in the order asked. */
  missing: string[];
}

// --- Thresholds ------------------------------------------------------------

/**
 * Share of the question's terms the context must carry before an answer is shown
 * without a caution. Three quarters: a four-term question may lack one term (a synonym
 * the tokenizer cannot fold), a three-term question may lack none. Lower would let a
 * half-matched context pass as an answer; higher would abstain on legitimate phrasing
 * changes.
 */
export const ANSWER_COVERAGE_FLOOR = 0.75;

/**
 * Share below which the context does not even earn a weak answer. One third: the
 * context has to speak to more than one stray word of the question before anything is
 * shown.
 */
export const ABSTAIN_COVERAGE_FLOOR = 0.34;

/**
 * Share of the question's terms one block must carry for its words to support a
 * sentence. Half: the best block has to hold at least half of what was asked, which is
 * what separates an answer from terms scattered across unrelated blocks.
 */
export const BEST_BLOCK_COVERAGE_FLOOR = 0.5;

// --- Assessment ------------------------------------------------------------

/**
 * Judges whether `context` — the blocks `planContext` planned for `question` — carries
 * enough of the question to answer it.
 *
 * The checks, in order, and the reason each records:
 * 1. the question has no content term (`no-query-terms`);
 * 2. no block carries any text (`empty-context`);
 * 3. the context covers less than {@link ABSTAIN_COVERAGE_FLOOR} of the terms
 *    (`low-coverage`);
 * 4. the context holds the words of a quantity question but no digit at all
 *    (`number-question-without-figure`);
 * 5. the evidence is not strong enough and the question is yes/no, where a hedge would
 *    be a guess, so the verdict is `abstain` rather than `weak`
 *    (`polar-question-unconfirmed`, plus the coverage reasons that apply);
 * 6. coverage or block support falls short of an answer (`partial-coverage`,
 *    `fragmented-evidence`) — `weak`;
 * 7. otherwise `answer`, with the terms the context happened to lack listed in
 *    `missing`.
 *
 * A question of only function words outranks an empty context in that order: the
 * question is the reason nothing could match, and saying so is more useful than
 * blaming the planner.
 */
export function assessEvidence(question: string, context: readonly ContextBlock[]): EvidenceAssessment {
  const terms = questionTerms(question);
  if (terms.length === 0) {
    return { verdict: 'abstain', coverage: 0, reasons: ['no-query-terms'], missing: [] };
  }

  const blocks = usableBlocks(context);
  if (blocks.length === 0) {
    return { verdict: 'abstain', coverage: 0, reasons: ['empty-context'], missing: [...terms] };
  }

  const text = blocks.map(block => block.excerpt).join('\n');
  const contextTerms = termSet(text);
  const missing: string[] = [];
  let matched = 0;
  for (const term of terms) {
    if (contextTerms.has(term)) matched += 1;
    else missing.push(term);
  }
  const coverage = ratio(matched, terms.length);

  let best = 0;
  for (const block of blocks) {
    const blockTerms = termSet(block.excerpt);
    let hit = 0;
    for (const term of terms) {
      if (blockTerms.has(term)) hit += 1;
    }
    best = Math.max(best, ratio(hit, terms.length));
  }

  // Words without the figure they asked for: checked only once the context is known to
  // carry the question at all, so a context that never mentions it reports the coverage
  // gap rather than a gap that would also be there.
  if (coverage < ABSTAIN_COVERAGE_FLOOR) {
    return { verdict: 'abstain', coverage, reasons: ['low-coverage'], missing };
  }

  if (isNumericQuestion(question) && !DIGIT.test(text)) {
    return { verdict: 'abstain', coverage, reasons: ['number-question-without-figure'], missing };
  }

  const supported = coverage >= ANSWER_COVERAGE_FLOOR && best >= BEST_BLOCK_COVERAGE_FLOOR;
  if (!supported) {
    const polar = isPolarQuestion(question);
    const reasons: AbstainReason[] = [];
    if (polar) reasons.push('polar-question-unconfirmed');
    if (coverage < ANSWER_COVERAGE_FLOOR) reasons.push('partial-coverage');
    if (best < BEST_BLOCK_COVERAGE_FLOOR) reasons.push('fragmented-evidence');
    // A yes/no question is either answered or not: a hedge leaves the reader without an
    // answer while looking like one, so its weak case abstains.
    const verdict: EvidenceVerdict = polar ? 'abstain' : 'weak';
    return { verdict, coverage, reasons, missing };
  }

  return { verdict: 'answer', coverage, reasons: [], missing };
}

// --- Reader-facing sentence ------------------------------------------------

/** The three languages the reader speaks; the same union as `Locale` in `src/i18n.ts`. */
export type AbstainLanguage = 'vi' | 'en' | 'zh';

/** Every language {@link abstainMessage} carries a sentence for. */
export const ABSTAIN_LANGUAGES: readonly AbstainLanguage[] = ['vi', 'en', 'zh'];

/** Language used when the caller passes none, matching `DEFAULT_LOCALE` in `src/i18n.ts`. */
export const DEFAULT_ABSTAIN_LANGUAGE: AbstainLanguage = 'vi';

const ABSTAIN_MESSAGES: Readonly<Record<AbstainLanguage, Readonly<Record<'weak' | 'abstain', string>>>> = {
  en: {
    weak: 'The documents mention only part of this question. Read the cited pages before relying on the answer.',
    abstain:
      'The documents do not contain enough evidence to answer this question. No answer was generated, because an answer without evidence would be a guess.',
  },
  vi: {
    weak: 'Tài liệu chỉ nhắc tới một phần câu hỏi này. Hãy đọc các trang được trích dẫn trước khi dựa vào câu trả lời.',
    abstain:
      'Tài liệu không có đủ căn cứ để trả lời câu hỏi này. Không tạo câu trả lời, vì một câu trả lời không có căn cứ chỉ là phỏng đoán.',
  },
  zh: {
    weak: '文档只涉及这个问题的部分内容。在采信答案前，请先阅读所引用的页面。',
    abstain: '文档中没有足够的依据来回答这个问题。因此不生成答案，因为没有依据的答案只是猜测。',
  },
};

/**
 * The sentence to show the reader for an assessment verdict, in the reader's language.
 *
 * `answer` yields the empty string: an answer that the evidence supports needs no notice
 * beside it. `weak` cautions and points at the cited pages; `abstain` states that no
 * answer was produced and why. An unknown language falls back to
 * {@link DEFAULT_ABSTAIN_LANGUAGE} rather than to blank copy: a missing warning is
 * worse than one written in the app's default language.
 */
export function abstainMessage(
  verdict: EvidenceVerdict,
  language: AbstainLanguage = DEFAULT_ABSTAIN_LANGUAGE,
): string {
  if (verdict !== 'weak' && verdict !== 'abstain') return '';
  return ABSTAIN_MESSAGES[readLanguage(language)][verdict];
}

// --- Answer guard ----------------------------------------------------------

/** Why {@link guardAnswer} refused an answer. */
export type AnswerGuardRefusal = 'uncited-answer-without-evidence';

/** What {@link guardAnswer} decided about one model answer. */
export type AnswerGuard =
  | { ok: true; answer: string }
  | { ok: false; reason: AnswerGuardRefusal };

/** `[[doc:<id> page <n>]]`, the marker `formatPrompt` teaches and `parseAnswer` resolves. */
const DOCUMENT_MARKER = /\[\[\s*doc\s*:[^[\]\n]{1,300}\]\]/u;

/**
 * Decides whether a model answer may be shown for the assessment that was made.
 *
 * An `answer` verdict lets the prose through. So does `weak`: the answer is shown with
 * the caution {@link abstainMessage} provides. An `abstain` verdict lets the prose
 * through only when it points at evidence — a citation the reader can resolve and check
 * — or when coverage is at least {@link ANSWER_COVERAGE_FLOOR}, which means the
 * abstention came from a signal other than missing words (a numeric question without a
 * figure, say) and coverage alone cannot prove the model invented anything.
 *
 * What remains is the case worth refusing: the verdict said the evidence does not
 * answer the question, coverage is low, and the model answered anyway with no citation
 * at all. `reason` is the stable code a caller can log; the sentence for the reader is
 * `abstainMessage('abstain', language)`.
 */
export function guardAnswer(answer: string, assessment: EvidenceAssessment): AnswerGuard {
  const text = typeof answer === 'string' ? answer : '';
  const verdict = assessment?.verdict;
  if (verdict !== 'abstain') return { ok: true, answer: text };
  if (carriesCitation(text)) return { ok: true, answer: text };

  const coverage = readCoverage(assessment?.coverage);
  if (coverage >= ANSWER_COVERAGE_FLOOR) return { ok: true, answer: text };
  return { ok: false, reason: 'uncited-answer-without-evidence' };
}

// --- Normalisation ---------------------------------------------------------

const COMBINING_MARKS = /\p{M}+/gu;
const WORD_BREAKS = /[^\p{L}\p{N}]+/u;
const HAN = /\p{Script=Han}/u;
const DIGIT = /\p{Nd}/u;

/** Most bigrams one Han run contributes; a longer run is a phrase, not a term. */
const HAN_BIGRAM_LIMIT = 24;

/** Score precision of `coverage`: three decimals, so two runs print the same number. */
const COVERAGE_DECIMALS = 1000;

/**
 * English and Vietnamese function words, in their folded spelling, plus the Vietnamese
 * particles that only carry grammar. A term that survives this list is what the context
 * has to contain to count towards coverage.
 */
const STOPWORD_SOURCES: readonly string[] = [
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'but', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'with', 'by', 'from', 'as', 'that', 'this', 'these',
  'those', 'it', 'its', 'what', 'which', 'who', 'whom', 'whose', 'how', 'why', 'when', 'where',
  'does', 'do', 'did', 'has', 'have', 'had', 'can', 'could', 'should', 'would', 'will',
  'shall', 'may', 'might', 'must', 'not', 'no', 'yes', 'there', 'their', 'then', 'than', 'so',
  'if', 'into', 'about', 'over', 'under', 'between', 'vs', 'per', 'via', 'we', 'you', 'they',
  'he', 'she', 'i', 'me', 'my', 'our', 'your', 'his', 'her', 'them', 'us', 'any', 'all',
  'each', 'more', 'most', 'some', 'such', 'very', 'just', 'also', 'however', 'therefore',
  'thus', 'while', 'during', 'after', 'before', 'again', 'once', 'here', 'both', 'few',
  'other', 'own', 'same', 'too', 'only', 'against', 'because', 'until', 'upon', 'within',
  'without', 'across', 'along', 'around', 'behind', 'below', 'beside', 'beyond', 'much',
  'many', 'whether', 'ever',
  'và', 'của', 'các', 'những', 'một', 'là', 'có', 'cho', 'trong', 'với', 'về', 'khi', 'thì',
  'mà', 'này', 'đó', 'để', 'từ', 'đến', 'theo', 'như', 'được', 'không', 'người', 'gì', 'nào',
  'bao', 'nhiêu', 'ra', 'vào', 'lên', 'xuống', 'đã', 'đang', 'sẽ', 'bị', 'do', 'nên', 'nhưng',
  'hoặc', 'cũng', 'rất', 'hơn', 'nhất', 'tại', 'bằng', 'vì', 'nếu', 'sau', 'trước', 'giữa',
  'trên', 'dưới', 'lại', 'đi', 'rằng', 'vẫn', 'còn', 'phải', 'đây', 'kia', 'ấy', 'họ',
  'chúng', 'tôi', 'bạn', 'anh', 'chị', 'em', 'ông', 'bà', 'liệu', 'hãy', 'nhé', 'vậy',
];

const STOPWORDS: ReadonlySet<string> = new Set(
  STOPWORD_SOURCES.map(word => fold(word)).filter(term => term.length > 0),
);

/**
 * Phrasings that ask for a quantity: a number, a percentage, a duration, a price.
 * Applied to the folded question, so the Vietnamese forms need no accents here. A false
 * positive only makes the check stricter, which is the safe direction for this module.
 */
const NUMERIC_QUESTION_PATTERNS: readonly RegExp[] = [
  /\bhow\s+(?:many|much|long|often|far|big|large|tall|heavy|expensive|fast|old)\b/u,
  /\bwhat\s+(?:percentage|percent|number|amount|total|share|ratio|price|cost|size|length)\b/u,
  /\bnumber\s+of\b/u,
  /\bbao\s+(?:nhieu|lau|xa|gio)\b/u,
  /\bso\s+luong\b/u,
  /\btong\s+cong\b/u,
  /\bphan\s+tram\b/u,
  /\bty\s+le\b/u,
  /\bmay\s+(?:trang|nguoi|loai|ky|thang|nam|phan|diem|lan|buoc|dai|rong|cao|nang|tien|gio)\b/u,
  /多少|多久|多大|多长|百分之|几\s*(?:个|页|年|月|天|条|次|位|种)/u,
];

/**
 * Phrasings that ask a yes/no question: an auxiliary verb in front, the Vietnamese
 * `có … không` frame, or the Chinese sentence-final `吗` and `是否` forms.
 */
const POLAR_QUESTION_PATTERNS: readonly RegExp[] = [
  /^(?:is|are|am|was|were|do|does|did|can|could|should|would|will|shall|has|have|had|must|may|might)\b/u,
  // `co` is `có` after folding, so the boundary must be a space or the end: `co-author`
  // is a compound, not a Vietnamese yes/no frame.
  /^(?:co|lieu)(?:\s|$)/u,
  /\bkhong$/u,
  /是否|能否|可否|是不是|有没有/u,
  /吗$/u,
];

/**
 * Folds case and diacritics: `Hà Nội` and `Ha Noi` meet on one term, and `đ` — which
 * does not decompose — folds to `d` explicitly, as `retrieval.ts` does.
 */
function fold(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/đ/gu, 'd');
}

/**
 * Splits text into folded terms. Latin and Vietnamese words are whole tokens of two or
 * more characters; a run of Han characters is the run itself plus its character
 * bigrams, because that script marks no word boundaries, and a bigram is the smallest
 * unit two spellings of the same phrase are likely to share.
 */
function tokenize(value: string): string[] {
  const folded = fold(value);
  if (folded.length === 0) return [];
  const tokens: string[] = [];
  for (const part of folded.split(WORD_BREAKS)) {
    if (part.length === 0) continue;
    if (HAN.test(part)) {
      pushHanTerms(part, tokens);
      continue;
    }
    if (part.length < 2) continue;
    tokens.push(part);
  }
  return tokens;
}

function pushHanTerms(run: string, out: string[]): void {
  const characters = [...run];
  const only = characters[0];
  if (characters.length === 1) {
    if (only !== undefined) out.push(only);
    return;
  }
  out.push(run);
  const last = Math.min(characters.length - 1, HAN_BIGRAM_LIMIT);
  for (let index = 0; index < last; index += 1) {
    const head = characters[index];
    const tail = characters[index + 1];
    if (head === undefined || tail === undefined) continue;
    out.push(`${head}${tail}`);
  }
}

/** Distinct content terms of the question, folded and in the order they were asked. */
function questionTerms(question: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenize(question)) {
    if (token.length === 0 || STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

/** Distinct terms of one text, used for the context and for each block. */
function termSet(text: string): Set<string> {
  const terms = new Set<string>();
  for (const token of tokenize(text)) terms.add(token);
  return terms;
}

/** The question folded to one line with its closing punctuation, ASCII or CJK, trimmed. */
function questionShape(question: string): string {
  return fold(question)
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\s?!.,;:…。，、？！；：]+$/u, '')
    .trim();
}

function isNumericQuestion(question: string): boolean {
  const shape = questionShape(question);
  if (shape.length === 0) return false;
  return NUMERIC_QUESTION_PATTERNS.some(pattern => pattern.test(shape));
}

function isPolarQuestion(question: string): boolean {
  const shape = questionShape(question);
  if (shape.length === 0) return false;
  return POLAR_QUESTION_PATTERNS.some(pattern => pattern.test(shape));
}

// --- Small helpers ---------------------------------------------------------

/** The blocks that carry text; a block with a blank excerpt cannot support anything. */
function usableBlocks(context: readonly ContextBlock[] | undefined): ContextBlock[] {
  if (!Array.isArray(context)) return [];
  const blocks: ContextBlock[] = [];
  for (const block of context) {
    if (block === null || typeof block !== 'object') continue;
    const excerpt = typeof block.excerpt === 'string' ? block.excerpt : '';
    if (excerpt.trim().length === 0) continue;
    blocks.push(block);
  }
  return blocks;
}

function ratio(part: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.round((part / total) * COVERAGE_DECIMALS) / COVERAGE_DECIMALS;
}

function readCoverage(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Reads a language this module carries copy for, falling back to the default. */
function readLanguage(value: unknown): AbstainLanguage {
  return value === 'vi' || value === 'en' || value === 'zh' ? value : DEFAULT_ABSTAIN_LANGUAGE;
}

/**
 * True when the answer points at evidence: either the document marker the multi-document
 * prompt teaches, or any marker `citations.ts` recognises (`[p12]`, `[p12:r3]`,
 * `[#p12-r3]`, `(trang 12)`, `[[cite:…]]`). The marker is not resolved here — that is
 * the caller's citation path — only noticed, because a model that cites an unsupported
 * page has at least claimed a source the reader can check.
 */
function carriesCitation(answer: string): boolean {
  if (typeof answer !== 'string' || answer.length === 0) return false;
  if (DOCUMENT_MARKER.test(answer)) return true;
  return parseCitations(answer).citations.length > 0;
}
