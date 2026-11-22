/**
 * Document domain detection and domain guidance (backlog G03).
 *
 * A contract, a discharge summary, an earnings release, a migration guide and a paper
 * use "the same" words differently: a clause is not a paragraph, a dose is not a
 * figure, and a citation is not a URL. This module reads the text a document already
 * has and names the genre, then turns that genre into two things the reader can use:
 * instruction lines a translation prompt can append ({@link promptGuidance}) and seed
 * glossary pairs the reader can accept ({@link glossaryHints}).
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network, no I/O. Equal
 *   text always produces an equal detection.
 * - A domain's score is the sum of the weights of the keywords the text contains, at
 *   most {@link MAX_HITS_PER_KEYWORD} occurrences per keyword (see the weight table
 *   below). Scores are integers, one per scored domain; `general` has no score of its
 *   own.
 * - A verdict needs a document, not a heading. Below {@link MIN_DOMAIN_WORDS} words the
 *   text is too thin to carry a genre, and below {@link MIN_DOMAIN_SCORE} points no
 *   genre was measured strongly enough to name: both return `general` with the reason
 *   that explains why, rather than the least-bad guess.
 * - Ties break by {@link SCORED_DOMAINS} order, which is the order this module
 *   documents: legal, medical, financial, technical, academic.
 * - Text is folded (case, diacritics, `đ`, and dashes removed) before matching, so
 *   `Hợp đồng` and `hop dong`, `Điều 5` and `dieu 5`, `p-value` and `p value` are one
 *   term. A term written with Han, kana or hangul characters is matched as a plain
 *   substring, because those scripts mark no word boundaries.
 */

import type { GlossaryEntry } from './glossary';

// --- Public shape ----------------------------------------------------------

/** The five genres this module measures. */
export type ScoredDomain = 'legal' | 'medical' | 'financial' | 'technical' | 'academic';

/** What a document is, or `general` when no genre was measured. */
export type DocumentDomain = ScoredDomain | 'general';

/**
 * The scored domains, in the documented tie-break order. When two genres share the
 * highest score the earlier entry wins, so an ambiguously worded contract is called
 * legal before it is called financial.
 */
export const SCORED_DOMAINS: readonly ScoredDomain[] = ['legal', 'medical', 'financial', 'technical', 'academic'];

/** Every domain {@link promptGuidance} and {@link glossaryHints} accept. */
export const DOMAINS: readonly DocumentDomain[] = [...SCORED_DOMAINS, 'general'];

/**
 * Why a detection returned the domain it did. The codes are stable and English: a
 * caller logs the code and localises its own sentence.
 *
 * - `single-domain`: one genre scored and no other genre came near it.
 * - `mixed-domain`: a second genre scored at least {@link MIXED_DOMAIN_RATIO} of the
 *   winner's score, so the document speaks two genres and the named one is only the
 *   dominant.
 * - `tie-broken-by-order`: two genres scored exactly the same; the documented order of
 *   {@link SCORED_DOMAINS} picked one. A tie always also reports `mixed-domain`.
 * - `thin-text`: fewer than {@link MIN_DOMAIN_WORDS} words, so nothing is claimed.
 * - `weak-signal`: the best genre scored under {@link MIN_DOMAIN_SCORE} points, which
 *   is what one ambiguous syllable repeated comes to.
 * - `no-keywords`: no keyword of any genre appears in the text.
 */
export const DOMAIN_REASONS = {
  single: 'single-domain',
  mixed: 'mixed-domain',
  tie: 'tie-broken-by-order',
  thin: 'thin-text',
  weak: 'weak-signal',
  none: 'no-keywords',
} as const;

export type DomainReason = (typeof DOMAIN_REASONS)[keyof typeof DOMAIN_REASONS];

export interface DomainDetection {
  /** The genre the text is in, or `general` when the text does not carry one. */
  domain: DocumentDomain;
  /**
   * How strongly the winner is supported, 0..1, rounded to three decimals. Zero for
   * `general`: nothing was measured, so nothing is claimed.
   */
  confidence: number;
  /** Raw keyword weight per scored domain; all zero when no keyword appears. */
  scores: Record<ScoredDomain, number>;
  /** The signals behind the verdict, in a stable order. */
  reasons: DomainReason[];
}

/** True for every value {@link detectDomain} can return and both helpers accept. */
export function isDocumentDomain(value: unknown): value is DocumentDomain {
  return typeof value === 'string' && (DOMAINS as readonly string[]).includes(value);
}

// --- Thresholds ------------------------------------------------------------

/**
 * Words a text needs before a genre may be named. Two sentences of ordinary prose
 * carry about 20 words; below that, a single contract heading would classify a book on
 * its cover. A run of Han, kana or hangul characters counts one word per character,
 * because those scripts separate no words with spaces.
 */
export const MIN_DOMAIN_WORDS = 20;

/**
 * Weight a winner needs before it is a genre rather than a coincidence. Four points is
 * two standard keywords, or one strong keyword plus its supporting vocabulary. Below
 * it, `điều kiện` repeated three times — three points of legal weight — must not
 * relabel a text about the weather as a contract.
 */
export const MIN_DOMAIN_SCORE = 4;

/**
 * Occurrences of one keyword that count. A genre term repeated through a document is
 * evidence; one word repeated ten times is not ten times the evidence, and the
 * Vietnamese syllables this table shares with ordinary prose (`điều`, `khoản`, `liều`)
 * are exactly the ones likely to repeat for no genre reason.
 */
export const MAX_HITS_PER_KEYWORD = 3;

/**
 * Winner score at which the genre evidence is trusted completely. A weight-3 keyword
 * plus two weight-2 keywords, or four weight-2 keywords, is a paragraph that clearly
 * belongs to the genre; longer or denser text does not raise confidence past this
 * point, because keywords never prove a genre.
 */
export const FULL_EVIDENCE_SCORE = 8;

/**
 * Runner-up share of the winner that makes a document mixed rather than single. A
 * quarter: a contract with a revenue clause speaks two genres, while one stray term in
 * a long document does not.
 */
export const MIXED_DOMAIN_RATIO = 0.25;

/**
 * Ceiling for a keyword detection. Even a document made of nothing but genre terms
 * only says how it is written, not what it argues, so the detector never claims
 * certainty. Matches the ceiling `detectLanguage` applies to its own share-based
 * confidence.
 */
export const MAX_CONFIDENCE = 0.95;

/** Decimals `confidence` is reported with, so two runs print the same number. */
const CONFIDENCE_DECIMALS = 3;

// --- Keyword weights -------------------------------------------------------

/**
 * A term that only appears in its genre, or that marks it so plainly that one hit is
 * worth three weak ones: `whereas`, `EBITDA`, `p-value`, `endpoint`.
 */
export const WEIGHT_STRONG = 3;

/**
 * Ordinary genre vocabulary: `contract`, `patient`, `revenue`, `module`, `abstract`.
 * Two of these already justify a verdict.
 */
export const WEIGHT_STANDARD = 2;

/**
 * A term that supports a genre without proving it: a word shared with everyday prose
 * (`điều`, `liều`, `hàm`) or a secondary one (`breach`, `timeout`, `citation`). The cap
 * on repeated hits keeps the first kind from deciding a document on its own.
 */
export const WEIGHT_WEAK = 1;

// --- Normalisation ---------------------------------------------------------

const COMBINING_MARKS = /\p{M}+/gu;

/**
 * Hyphens and the Unicode dashes fold to a space, so `p-value`, `p value` and
 * `p–value`, or `mô-đun` and `mô đun`, are one term. Folding happens before matching,
 * which is why the keyword tables may spell their terms naturally.
 */
const DASHES = /[-\u2010-\u2015\u2212]+/gu;

/** A script without spaces: a run of these characters is not one word. */
const UNSPACED_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const UNSPACED_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

const WORD_RUN = /[\p{L}\p{N}]+/gu;

/**
 * Folds case, diacritics and dashes: `Hà Nội` and `Ha Noi` meet on one term, `đ` — which
 * does not decompose — folds to `d` explicitly (as `abstain.ts` and `retrieval.ts` do),
 * and `p-value` folds to `p value`.
 */
function fold(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/đ/gu, 'd')
    .replace(DASHES, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Counts words the way a reader does: Latin, Cyrillic and the other spaced scripts by
 * runs of letters and digits, Han, kana and hangul one per character. Only used for the
 * thin-text floor, so it stays approximate by design.
 */
function countWords(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const unspaced = text.match(UNSPACED_RUN)?.length ?? 0;
  const spaced = text.replace(UNSPACED_RUN, ' ').match(WORD_RUN)?.length ?? 0;
  return unspaced + spaced;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface KeywordSource {
  /** The term as it is normally written; matching folds it first. */
  readonly term: string;
  readonly weight: number;
}

interface CompiledKeyword {
  /** The folded term, kept for substring counting and for debugging. */
  readonly term: string;
  readonly weight: number;
  /** Boundary-delimited Latin matcher, or `null` for an unspaced term. */
  readonly pattern: RegExp | null;
}

/**
 * Compiles one keyword. A spaced term is matched on word boundaries with an optional
 * plural `s` (`clause` meets `clauses`, `liability` does not meet `liabilities` — that
 * form is listed separately). An unspaced term has no boundaries to match: it is looked
 * for as a plain substring, because `本合同` is where the Chinese word `合同` lives.
 */
function compileKeyword(term: string, weight: number): CompiledKeyword {
  const folded = fold(term);
  if (UNSPACED_CHARACTER.test(folded)) return { term: folded, weight, pattern: null };
  const body = folded.split(' ').map(escapeRegExp).join('\\s+');
  return {
    term: folded,
    weight,
    pattern: new RegExp(String.raw`(?<![\p{L}\p{N}])${body}s?(?![\p{L}\p{N}])`, 'gu'),
  };
}

/**
 * Weight of one keyword in the folded text, with its occurrences capped at
 * {@link MAX_HITS_PER_KEYWORD}.
 */
function keywordScore(foldedText: string, keyword: CompiledKeyword): number {
  if (foldedText.length === 0) return 0;
  const hits = keyword.pattern ? (foldedText.match(keyword.pattern)?.length ?? 0) : countNonOverlapping(foldedText, keyword.term);
  return Math.min(hits, MAX_HITS_PER_KEYWORD) * keyword.weight;
}

/** Occurrences of `needle` in `haystack`, counted left to right without overlap. */
function countNonOverlapping(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + needle.length;
  }
}

function scoreDomain(foldedText: string, domain: ScoredDomain): number {
  let score = 0;
  for (const keyword of KEYWORDS[domain]) score += keywordScore(foldedText, keyword);
  return score;
}

// --- Keyword tables --------------------------------------------------------

/**
 * The documented keyword weights, per genre and per language this product reads.
 *
 * Weight tiers are {@link WEIGHT_STRONG}, {@link WEIGHT_STANDARD} and
 * {@link WEIGHT_WEAK}. Vietnamese terms are written with their diacritics and match
 * after folding, so an unaccented copy of the same text still scores. Chinese head
 * terms are included because `zh` is a supported language and those documents carry no
 * spaces for a boundary matcher to use.
 *
 * The table deliberately holds no phrase next to its own head word (`điều khoản`
 * beside `điều`, `patient record` beside `patient`): a nested pair would score the same
 * characters twice and inflate a genre that is only mentioned once. A syllable that
 * heads terms in two genres (`điều` in medical `điều trị`) still feeds each genre's own
 * score, because the domains are scored independently; the weak weight and the hit cap
 * keep that from deciding a document.
 */
const KEYWORD_SOURCES: Readonly<Record<ScoredDomain, readonly KeywordSource[]>> = {
  legal: [
    // Article vocabulary. `điều` and `khoản` also head ordinary Vietnamese sentences
    // (điều kiện, khoản tiền), so they are weak: they support a verdict, never decide it.
    { term: 'điều', weight: WEIGHT_WEAK },
    { term: 'khoản', weight: WEIGHT_WEAK },
    // Contract vocabulary.
    { term: 'hợp đồng', weight: WEIGHT_STRONG },
    { term: 'bên A', weight: WEIGHT_STRONG },
    { term: 'bên B', weight: WEIGHT_STRONG },
    { term: 'nghĩa vụ', weight: WEIGHT_WEAK },
    { term: 'vi phạm', weight: WEIGHT_WEAK },
    { term: 'bồi thường', weight: WEIGHT_STANDARD },
    // English contract boilerplate.
    { term: 'whereas', weight: WEIGHT_STRONG },
    { term: 'hereinafter', weight: WEIGHT_STRONG },
    { term: 'contract', weight: WEIGHT_STANDARD },
    { term: 'agreement', weight: WEIGHT_STANDARD },
    { term: 'clause', weight: WEIGHT_STANDARD },
    { term: 'party', weight: WEIGHT_STANDARD },
    { term: 'parties', weight: WEIGHT_STANDARD },
    { term: 'provision', weight: WEIGHT_WEAK },
    { term: 'governing law', weight: WEIGHT_STRONG },
    { term: 'indemnity', weight: WEIGHT_STANDARD },
    { term: 'breach', weight: WEIGHT_WEAK },
    { term: 'obligation', weight: WEIGHT_WEAK },
    // Chinese head terms.
    { term: '合同', weight: WEIGHT_STRONG },
    { term: '甲方', weight: WEIGHT_STRONG },
    { term: '乙方', weight: WEIGHT_STRONG },
    { term: '条款', weight: WEIGHT_STANDARD },
    { term: '违约', weight: WEIGHT_STANDARD },
    { term: '鉴于', weight: WEIGHT_STANDARD },
  ],
  medical: [
    // `liều` folds together with `liệu` (whether), so it is weak on its own.
    { term: 'liều', weight: WEIGHT_WEAK },
    { term: 'bệnh nhân', weight: WEIGHT_STRONG },
    { term: 'chẩn đoán', weight: WEIGHT_STRONG },
    { term: 'điều trị', weight: WEIGHT_STANDARD },
    { term: 'triệu chứng', weight: WEIGHT_STANDARD },
    { term: 'xét nghiệm', weight: WEIGHT_STANDARD },
    { term: 'bệnh viện', weight: WEIGHT_WEAK },
    { term: 'thuốc', weight: WEIGHT_WEAK },
    { term: 'patient', weight: WEIGHT_STANDARD },
    { term: 'dosage', weight: WEIGHT_STANDARD },
    { term: 'diagnosis', weight: WEIGHT_STANDARD },
    { term: 'treatment', weight: WEIGHT_STANDARD },
    { term: 'dose', weight: WEIGHT_STANDARD },
    { term: 'symptom', weight: WEIGHT_STANDARD },
    { term: 'prescription', weight: WEIGHT_STANDARD },
    { term: 'clinical trial', weight: WEIGHT_STRONG },
    { term: 'adverse event', weight: WEIGHT_STANDARD },
    { term: 'contraindication', weight: WEIGHT_STRONG },
    { term: 'side effect', weight: WEIGHT_STANDARD },
    { term: '患者', weight: WEIGHT_STRONG },
    { term: '剂量', weight: WEIGHT_STRONG },
    { term: '诊断', weight: WEIGHT_STANDARD },
    { term: '治疗', weight: WEIGHT_STANDARD },
    { term: '症状', weight: WEIGHT_WEAK },
    { term: '临床试验', weight: WEIGHT_STANDARD },
  ],
  financial: [
    { term: 'doanh thu', weight: WEIGHT_STRONG },
    { term: 'lợi nhuận', weight: WEIGHT_STANDARD },
    { term: 'cổ phiếu', weight: WEIGHT_STRONG },
    { term: 'cổ tức', weight: WEIGHT_STANDARD },
    { term: 'tài sản', weight: WEIGHT_STANDARD },
    { term: 'nợ phải trả', weight: WEIGHT_STANDARD },
    { term: 'dòng tiền', weight: WEIGHT_STANDARD },
    { term: 'bảng cân đối kế toán', weight: WEIGHT_STANDARD },
    { term: 'năm tài chính', weight: WEIGHT_STANDARD },
    { term: 'doanh nghiệp', weight: WEIGHT_WEAK },
    { term: 'revenue', weight: WEIGHT_STANDARD },
    { term: 'profit', weight: WEIGHT_STANDARD },
    { term: 'ebitda', weight: WEIGHT_STRONG },
    { term: 'share', weight: WEIGHT_STANDARD },
    { term: 'dividend', weight: WEIGHT_STANDARD },
    { term: 'cash flow', weight: WEIGHT_STANDARD },
    { term: 'balance sheet', weight: WEIGHT_STANDARD },
    { term: 'fiscal year', weight: WEIGHT_STANDARD },
    { term: 'asset', weight: WEIGHT_STANDARD },
    { term: 'liability', weight: WEIGHT_STANDARD },
    // The plural of liability ends in `ies`, so the optional `s` above never reaches it.
    { term: 'liabilities', weight: WEIGHT_STANDARD },
    { term: 'income statement', weight: WEIGHT_STANDARD },
    { term: '收入', weight: WEIGHT_STANDARD },
    { term: '利润', weight: WEIGHT_STANDARD },
    { term: '股票', weight: WEIGHT_STRONG },
    { term: '资产', weight: WEIGHT_STANDARD },
    { term: '负债', weight: WEIGHT_STANDARD },
    { term: '现金流', weight: WEIGHT_STANDARD },
  ],
  technical: [
    // `hàm` folds together with `hầm` (tunnel), so it is weak on its own.
    { term: 'hàm', weight: WEIGHT_WEAK },
    { term: 'điểm cuối', weight: WEIGHT_STANDARD },
    { term: 'mô-đun', weight: WEIGHT_STANDARD },
    { term: 'cấu hình', weight: WEIGHT_WEAK },
    { term: 'triển khai', weight: WEIGHT_WEAK },
    { term: 'cơ sở dữ liệu', weight: WEIGHT_STANDARD },
    { term: 'xác thực', weight: WEIGHT_WEAK },
    { term: 'phụ thuộc', weight: WEIGHT_WEAK },
    { term: 'api', weight: WEIGHT_STRONG },
    { term: 'endpoint', weight: WEIGHT_STRONG },
    { term: 'function', weight: WEIGHT_STANDARD },
    { term: 'module', weight: WEIGHT_STANDARD },
    { term: 'request', weight: WEIGHT_STANDARD },
    { term: 'response', weight: WEIGHT_STANDARD },
    { term: 'repository', weight: WEIGHT_WEAK },
    { term: 'dependency', weight: WEIGHT_STANDARD },
    { term: 'deployment', weight: WEIGHT_STANDARD },
    { term: 'configuration', weight: WEIGHT_WEAK },
    { term: 'database', weight: WEIGHT_STANDARD },
    { term: 'authentication', weight: WEIGHT_WEAK },
    { term: 'timeout', weight: WEIGHT_WEAK },
    { term: '接口', weight: WEIGHT_STRONG },
    { term: '函数', weight: WEIGHT_STANDARD },
    { term: '模块', weight: WEIGHT_STANDARD },
    { term: '部署', weight: WEIGHT_WEAK },
    { term: '配置', weight: WEIGHT_STANDARD },
    { term: '数据库', weight: WEIGHT_STANDARD },
  ],
  academic: [
    { term: 'tóm tắt', weight: WEIGHT_WEAK },
    { term: 'nghiên cứu', weight: WEIGHT_WEAK },
    { term: 'phương pháp', weight: WEIGHT_WEAK },
    { term: 'giả thuyết', weight: WEIGHT_STANDARD },
    { term: 'trích dẫn', weight: WEIGHT_WEAK },
    { term: 'bình duyệt', weight: WEIGHT_STANDARD },
    { term: 'cỡ mẫu', weight: WEIGHT_STANDARD },
    { term: 'ý nghĩa thống kê', weight: WEIGHT_STANDARD },
    { term: 'bộ dữ liệu', weight: WEIGHT_WEAK },
    { term: 'tái lập', weight: WEIGHT_WEAK },
    { term: 'abstract', weight: WEIGHT_STRONG },
    { term: 'methodology', weight: WEIGHT_STRONG },
    { term: 'et al', weight: WEIGHT_STRONG },
    { term: 'p-value', weight: WEIGHT_STRONG },
    { term: 'hypothesis', weight: WEIGHT_STANDARD },
    { term: 'literature review', weight: WEIGHT_STANDARD },
    { term: 'peer review', weight: WEIGHT_STANDARD },
    { term: 'sample size', weight: WEIGHT_STANDARD },
    { term: 'significance', weight: WEIGHT_STANDARD },
    { term: 'citation', weight: WEIGHT_WEAK },
    { term: 'dataset', weight: WEIGHT_WEAK },
    { term: 'reproducibility', weight: WEIGHT_WEAK },
    { term: '摘要', weight: WEIGHT_STRONG },
    { term: '假设', weight: WEIGHT_STANDARD },
    { term: '显著性', weight: WEIGHT_STANDARD },
    { term: '文献综述', weight: WEIGHT_STANDARD },
    { term: '样本量', weight: WEIGHT_STANDARD },
    { term: '可复现性', weight: WEIGHT_WEAK },
  ],
};

const KEYWORDS: Readonly<Record<ScoredDomain, readonly CompiledKeyword[]>> = {
  legal: KEYWORD_SOURCES.legal.map(entry => compileKeyword(entry.term, entry.weight)),
  medical: KEYWORD_SOURCES.medical.map(entry => compileKeyword(entry.term, entry.weight)),
  financial: KEYWORD_SOURCES.financial.map(entry => compileKeyword(entry.term, entry.weight)),
  technical: KEYWORD_SOURCES.technical.map(entry => compileKeyword(entry.term, entry.weight)),
  academic: KEYWORD_SOURCES.academic.map(entry => compileKeyword(entry.term, entry.weight)),
};

// --- Detection -------------------------------------------------------------

/** One ranked domain: its score and its place in the documented order. */
interface RankedDomain {
  domain: ScoredDomain;
  order: number;
  score: number;
}

/**
 * Names the genre of `text`.
 *
 * The checks, in order, and the result each produces:
 * 1. fewer than {@link MIN_DOMAIN_WORDS} words -> `general`, `thin-text` (the scores
 *    are still reported: a contract heading is legal evidence, just not a document);
 * 2. no keyword of any genre -> `general`, `no-keywords`;
 * 3. best score under {@link MIN_DOMAIN_SCORE} -> `general`, `weak-signal`;
 * 4. otherwise the best-scoring genre, with `tie-broken-by-order` when another genre
 *    scored the same, and `mixed-domain` when another genre scored at least
 *    {@link MIXED_DOMAIN_RATIO} of it (or `single-domain` when neither applies).
 *
 * Confidence is the winner's share of the document's genre evidence, scaled by how much
 * absolute evidence there is and capped at {@link MAX_CONFIDENCE}:
 * `min(MAX_CONFIDENCE, winner / total * min(1, winner / FULL_EVIDENCE_SCORE))`. A
 * document that mixes two genres therefore reports the dominant one with a lower
 * confidence than the same text alone would.
 */
export function detectDomain(text: string): DomainDetection {
  const source = typeof text === 'string' ? text : '';
  const folded = fold(source);
  const scores: Record<ScoredDomain, number> = {
    legal: 0,
    medical: 0,
    financial: 0,
    technical: 0,
    academic: 0,
  };
  for (const domain of SCORED_DOMAINS) scores[domain] = scoreDomain(folded, domain);

  if (countWords(source) < MIN_DOMAIN_WORDS) {
    return { domain: 'general', confidence: 0, scores, reasons: [DOMAIN_REASONS.thin] };
  }

  // Sorted by score, then by the documented domain order: a tie keeps the earlier one.
  const ranked: RankedDomain[] = SCORED_DOMAINS.map((domain, order) => ({ domain, order, score: scores[domain] }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const winner = ranked[0];
  if (!winner) return { domain: 'general', confidence: 0, scores, reasons: [DOMAIN_REASONS.none] };
  if (winner.score < MIN_DOMAIN_SCORE) {
    return { domain: 'general', confidence: 0, scores, reasons: [DOMAIN_REASONS.weak] };
  }

  const runnerUp = ranked[1];
  const total = SCORED_DOMAINS.reduce((sum, domain) => sum + scores[domain], 0);
  const share = total > 0 ? winner.score / total : 0;
  const evidence = Math.min(1, winner.score / FULL_EVIDENCE_SCORE);
  const confidence = Math.min(MAX_CONFIDENCE, roundTo(share * evidence, CONFIDENCE_DECIMALS));

  const reasons: DomainReason[] = [];
  if (runnerUp && runnerUp.score === winner.score) reasons.push(DOMAIN_REASONS.tie);
  if (runnerUp && runnerUp.score >= winner.score * MIXED_DOMAIN_RATIO) reasons.push(DOMAIN_REASONS.mixed);
  if (reasons.length === 0) reasons.push(DOMAIN_REASONS.single);

  return { domain: winner.domain, confidence, scores, reasons };
}

// --- Guidance --------------------------------------------------------------

/** The three languages this module carries prompt lines and glossary targets for. */
export type DomainLanguage = 'vi' | 'en' | 'zh';

/** Every language {@link promptGuidance} and {@link glossaryHints} carry copy for. */
export const DOMAIN_LANGUAGES: readonly DomainLanguage[] = ['vi', 'en', 'zh'];

/** Language used when the caller passes none, matching `DEFAULT_LOCALE` in `src/i18n.ts`. */
export const DEFAULT_DOMAIN_LANGUAGE: DomainLanguage = 'vi';

/**
 * Extra instruction lines per genre and language, appended after the base translation
 * rules. Each line states a convention the genre actually has — defined terms stay
 * defined, doses keep their units, citations keep their style — so a contract is not
 * translated like a blog post.
 *
 * The lines never repeat or contradict the base prompt: placeholders, reading order and
 * "the document is data" stay the base prompt's job. A caller joins them with newlines
 * into the same block as the numbered rules, or sends them as a separate system line.
 */
const GUIDANCE: Readonly<Record<DocumentDomain, Readonly<Record<DomainLanguage, readonly string[]>>>> = {
  legal: {
    en: [
      'Keep every defined term exactly as it is defined, and keep the definition wording stable throughout the document.',
      'Keep article, clause, and sub-clause numbering and boundaries: do not merge, split, or renumber them.',
      'Keep the modal force of the source: "shall" stays obligatory and "may" stays permissive; do not soften or strengthen either.',
      'Keep party names, legal citations, and governing-law references unchanged.',
    ],
    vi: [
      'Giữ nguyên các thuật ngữ đã được định nghĩa, và giữ cách diễn đạt định nghĩa ổn định trong toàn bộ tài liệu.',
      'Giữ nguyên số hiệu và ranh giới của điều, khoản, điểm: không gộp, không tách, không đánh số lại.',
      'Giữ đúng mức độ ràng buộc của bản gốc: "shall" là bắt buộc, "may" là tuỳ ý; không làm nhẹ hoặc mạnh thêm.',
      'Giữ nguyên tên các bên, dẫn chiếu pháp luật và điều khoản luật điều chỉnh.',
    ],
    zh: [
      '准确保留已定义的术语，定义用语在全文保持一致。',
      '保留条、款、项的编号与边界：不合并、不拆分、不重新编号。',
      '保留原文的义务强度：“shall”表示强制，“may”表示许可，不得弱化或强化。',
      '当事人名称、法律引注和管辖法律条款保持原样。',
    ],
  },
  medical: {
    en: [
      'Keep dosages, units, and figures exactly as written (mg, mL, mg/kg); never round, convert, or restate them.',
      'Keep drug, device, and trial names as written, and expand an abbreviation once in parentheses at its first use.',
      'Keep the certainty of a clinical statement: "may cause" must not become "causes".',
    ],
    vi: [
      'Giữ nguyên liều lượng, đơn vị và con số như bản gốc (mg, mL, mg/kg); không làm tròn, không đổi đơn vị, không diễn giải lại.',
      'Giữ nguyên tên thuốc, thiết bị và tên thử nghiệm; lần đầu gặp từ viết tắt thì mở rộng một lần trong ngoặc.',
      'Giữ đúng mức độ khẳng định của câu lâm sàng: không đổi "có thể gây" thành "gây ra".',
    ],
    zh: [
      '剂量、单位和数字严格照原文（mg、mL、mg/kg），不得四舍五入、换算单位或改写。',
      '药物、器械和试验名称保持原样；缩写首次出现时在括号内展开一次。',
      '保留临床陈述的确定性：不得把“可能引起”改成“引起”。',
    ],
  },
  financial: {
    en: [
      'Keep currency codes, amounts, and period labels exactly as written, including forms such as Q1 FY2024.',
      'Do not recompute, round, or re-derive any figure, percentage, or ratio.',
      'Use one fixed translation per accounting term, and expand an acronym once at its first use.',
    ],
    vi: [
      'Giữ nguyên mã tiền tệ, số tiền và kỳ báo cáo như bản gốc, kể cả các dạng như Q1 FY2024.',
      'Không tính lại, không làm tròn và không suy ra bất kỳ con số, tỷ lệ hay phần trăm nào.',
      'Dùng một cách dịch cố định cho mỗi thuật ngữ kế toán; lần đầu gặp từ viết tắt thì mở rộng một lần.',
    ],
    zh: [
      '货币代码、金额和报告期保持原样，包括 Q1 FY2024 这类写法。',
      '不得重新计算、取整或推导任何数字、比例或百分比。',
      '会计术语使用固定译法；缩写首次出现时展开一次。',
    ],
  },
  technical: {
    en: [
      'Keep identifiers, code, API names, endpoints, version numbers, and command-line flags unchanged.',
      'Keep function, module, and type names verbatim even when they appear inside a sentence.',
      'Expand an acronym once at its first use and keep the original form in parentheses.',
    ],
    vi: [
      'Giữ nguyên định danh, mã, tên API, endpoint, số phiên bản và cờ dòng lệnh.',
      'Giữ nguyên tên hàm, mô-đun và kiểu dữ liệu ngay cả khi chúng nằm trong câu văn.',
      'Lần đầu gặp từ viết tắt thì mở rộng một lần và để nguyên dạng gốc trong ngoặc.',
    ],
    zh: [
      '标识符、代码、API 名称、端点、版本号和命令行参数保持原样。',
      '函数名、模块名和类型名即使在正文中也保持原样。',
      '缩写首次出现时展开一次，并在括号内保留原形。',
    ],
  },
  academic: {
    en: [
      'Preserve the citation style and every citation marker exactly as written.',
      'Keep "et al.", statistical notation (p, n, ±, CI), and significance wording unchanged.',
      'Keep the abstract and section structure intact; do not merge sentences across a heading.',
      'Expand an acronym once at its first use and keep the source-language expansion in parentheses.',
    ],
    vi: [
      'Giữ đúng kiểu trích dẫn và mọi dấu trích dẫn như bản gốc.',
      'Giữ nguyên "et al.", ký hiệu thống kê (p, n, ±, CI) và cách diễn đạt mức ý nghĩa.',
      'Giữ nguyên cấu trúc tóm tắt và các mục; không gộp câu qua ranh giới tiêu đề.',
      'Lần đầu gặp từ viết tắt thì mở rộng một lần và giữ dạng gốc trong ngoặc.',
    ],
    zh: [
      '引用格式和所有引用标记严格照原文保留。',
      '保留“et al.”、统计符号（p、n、±、CI）和显著性表述。',
      '保留摘要与章节结构；不要在标题之间合并句子。',
      '缩写首次出现时展开一次，并在括号内保留原文全称。',
    ],
  },
  general: {
    en: [
      'Keep the terminology consistent: use one translation for one source term throughout the document.',
      'Keep numbers, units, and symbols unchanged, and expand an acronym once at its first use.',
    ],
    vi: [
      'Giữ thuật ngữ nhất quán: mỗi thuật ngữ gốc chỉ dùng một cách dịch trong toàn bộ tài liệu.',
      'Giữ nguyên số, đơn vị và ký hiệu; lần đầu gặp từ viết tắt thì viết đầy đủ một lần.',
    ],
    zh: [
      '全文术语保持一致：同一个原文术语只使用一种译法。',
      '数字、单位和符号保持不变；缩写首次出现时展开一次。',
    ],
  },
};

/**
 * Extra instruction lines for translating a document of `domain` into `language`.
 *
 * The lines are plain sentences, one convention each, and the array is a fresh copy so
 * a caller may concatenate or sort it. An unknown domain is refused with a
 * `RangeError`: there is no generic guidance to fall back to, and silently returning
 * `general`'s lines would hide the caller's bug. An unknown language falls back to
 * {@link DEFAULT_DOMAIN_LANGUAGE}, as `abstainMessage` does: guidance in the app's
 * default language still helps, while blank guidance does not.
 */
export function promptGuidance(
  domain: DocumentDomain,
  language: DomainLanguage = DEFAULT_DOMAIN_LANGUAGE,
): string[] {
  assertDomain(domain, 'promptGuidance');
  return [...GUIDANCE[domain][readLanguage(language)]];
}

// --- Glossary hints --------------------------------------------------------

/** One seed term in every language this module speaks. */
interface HintRow {
  readonly en: string;
  readonly vi: string;
  readonly zh: string;
}

/** Fewest seed pairs a domain table may hold. */
export const HINT_MIN_PAIRS = 10;

/** Most seed pairs a domain table may hold. */
export const HINT_MAX_PAIRS = 20;

/**
 * Seed glossary pairs per genre, 10 to 20 rows each.
 *
 * A hint is what the reader would otherwise type into the glossary field themselves:
 * one `source = target` line per row, already checked for tone and for the genre's
 * usual wording. The rows keep a genre's load-bearing terms — `whereas`, `dosage`,
 * accounting vocabulary such as `EBITDA`, `endpoint`, `p-value` — rather than every word
 * the genre knows, because a glossary that defines everything is a dictionary.
 *
 * Direction: the source side is the language the document is likely written in —
 * English for a Vietnamese or Chinese target, Vietnamese for an English target — and
 * the target side is `language`. Those are the two flows the product actually carries:
 * an English contract read in Vietnamese, and a Vietnamese contract read in English.
 *
 * Every row holds the term in all three languages, so one table serves all of
 * {@link DOMAIN_LANGUAGES} and no row is machine-translated on the fly.
 */
const HINTS: Readonly<Record<DocumentDomain, readonly HintRow[]>> = {
  legal: [
    { en: 'contract', vi: 'hợp đồng', zh: '合同' },
    { en: 'party', vi: 'bên', zh: '一方' },
    { en: 'Party A', vi: 'Bên A', zh: '甲方' },
    { en: 'Party B', vi: 'Bên B', zh: '乙方' },
    { en: 'clause', vi: 'điều khoản', zh: '条款' },
    { en: 'article', vi: 'điều', zh: '条' },
    { en: 'provision', vi: 'quy định', zh: '规定' },
    { en: 'whereas', vi: 'xét rằng', zh: '鉴于' },
    { en: 'hereinafter', vi: 'dưới đây', zh: '以下简称' },
    { en: 'governing law', vi: 'luật điều chỉnh', zh: '管辖法律' },
    { en: 'breach', vi: 'vi phạm', zh: '违约' },
    { en: 'indemnity', vi: 'bồi thường', zh: '赔偿' },
  ],
  medical: [
    { en: 'patient', vi: 'bệnh nhân', zh: '患者' },
    { en: 'diagnosis', vi: 'chẩn đoán', zh: '诊断' },
    { en: 'treatment', vi: 'điều trị', zh: '治疗' },
    { en: 'dosage', vi: 'liều lượng', zh: '剂量' },
    { en: 'symptom', vi: 'triệu chứng', zh: '症状' },
    { en: 'clinical trial', vi: 'thử nghiệm lâm sàng', zh: '临床试验' },
    { en: 'adverse event', vi: 'biến cố bất lợi', zh: '不良事件' },
    { en: 'prescription', vi: 'đơn thuốc', zh: '处方' },
    { en: 'indication', vi: 'chỉ định', zh: '适应症' },
    { en: 'contraindication', vi: 'chống chỉ định', zh: '禁忌症' },
    { en: 'side effect', vi: 'tác dụng phụ', zh: '副作用' },
    { en: 'blood pressure', vi: 'huyết áp', zh: '血压' },
  ],
  financial: [
    { en: 'revenue', vi: 'doanh thu', zh: '收入' },
    { en: 'profit', vi: 'lợi nhuận', zh: '利润' },
    { en: 'share', vi: 'cổ phiếu', zh: '股票' },
    { en: 'equity', vi: 'vốn chủ sở hữu', zh: '权益' },
    { en: 'cash flow', vi: 'dòng tiền', zh: '现金流' },
    { en: 'balance sheet', vi: 'bảng cân đối kế toán', zh: '资产负债表' },
    { en: 'fiscal year', vi: 'năm tài chính', zh: '财年' },
    { en: 'liability', vi: 'nợ phải trả', zh: '负债' },
    { en: 'asset', vi: 'tài sản', zh: '资产' },
    { en: 'dividend', vi: 'cổ tức', zh: '股息' },
    { en: 'gross margin', vi: 'biên lợi nhuận gộp', zh: '毛利率' },
    { en: 'operating income', vi: 'lợi nhuận hoạt động', zh: '营业利润' },
  ],
  technical: [
    { en: 'endpoint', vi: 'điểm cuối', zh: '端点' },
    { en: 'function', vi: 'hàm', zh: '函数' },
    { en: 'module', vi: 'mô-đun', zh: '模块' },
    { en: 'request', vi: 'yêu cầu', zh: '请求' },
    { en: 'response', vi: 'phản hồi', zh: '响应' },
    { en: 'repository', vi: 'kho mã nguồn', zh: '代码仓库' },
    { en: 'dependency', vi: 'phụ thuộc', zh: '依赖' },
    { en: 'deployment', vi: 'triển khai', zh: '部署' },
    { en: 'configuration', vi: 'cấu hình', zh: '配置' },
    { en: 'database', vi: 'cơ sở dữ liệu', zh: '数据库' },
    { en: 'authentication', vi: 'xác thực', zh: '身份验证' },
    { en: 'timeout', vi: 'hết thời gian chờ', zh: '超时' },
  ],
  academic: [
    { en: 'abstract', vi: 'tóm tắt', zh: '摘要' },
    { en: 'methodology', vi: 'phương pháp nghiên cứu', zh: '研究方法' },
    { en: 'hypothesis', vi: 'giả thuyết', zh: '假设' },
    { en: 'literature review', vi: 'tổng quan tài liệu', zh: '文献综述' },
    { en: 'sample size', vi: 'cỡ mẫu', zh: '样本量' },
    { en: 'significance', vi: 'ý nghĩa thống kê', zh: '显著性' },
    { en: 'p-value', vi: 'giá trị p', zh: 'p 值' },
    { en: 'et al.', vi: 'và cộng sự', zh: '等' },
    { en: 'citation', vi: 'trích dẫn', zh: '引用' },
    { en: 'peer review', vi: 'bình duyệt', zh: '同行评审' },
    { en: 'dataset', vi: 'bộ dữ liệu', zh: '数据集' },
    { en: 'reproducibility', vi: 'khả năng tái lập', zh: '可复现性' },
  ],
  general: [
    { en: 'document', vi: 'tài liệu', zh: '文档' },
    { en: 'section', vi: 'phần', zh: '章节' },
    { en: 'paragraph', vi: 'đoạn văn', zh: '段落' },
    { en: 'figure', vi: 'hình', zh: '图' },
    { en: 'table', vi: 'bảng', zh: '表' },
    { en: 'appendix', vi: 'phụ lục', zh: '附录' },
    { en: 'summary', vi: 'tóm tắt', zh: '摘要' },
    { en: 'reference', vi: 'tài liệu tham khảo', zh: '参考文献' },
    { en: 'note', vi: 'ghi chú', zh: '备注' },
    { en: 'unit', vi: 'đơn vị', zh: '单位' },
  ],
};

/**
 * Seed glossary pairs for a document of `domain` whose target language is `language`,
 * ready to be accepted into `parseGlossary`/`glossaryToPrompt` or shown as a list.
 *
 * The array is a fresh copy with fresh objects, so a caller may edit an accepted pair
 * without changing the table. An unknown domain is refused with a `RangeError`, the
 * same way {@link promptGuidance} refuses it: there are no seeds for a genre this
 * module does not know. An unknown language falls back to
 * {@link DEFAULT_DOMAIN_LANGUAGE}.
 */
export function glossaryHints(
  domain: DocumentDomain,
  language: DomainLanguage = DEFAULT_DOMAIN_LANGUAGE,
): GlossaryEntry[] {
  assertDomain(domain, 'glossaryHints');
  const target = readLanguage(language);
  return HINTS[domain].map(row =>
    target === 'en'
      ? { source: row.vi, target: row.en }
      : { source: row.en, target: row[target] },
  );
}

// --- Small helpers ---------------------------------------------------------

/** Reads a language this module carries copy for, falling back to the default. */
function readLanguage(value: unknown): DomainLanguage {
  return value === 'vi' || value === 'en' || value === 'zh' ? value : DEFAULT_DOMAIN_LANGUAGE;
}

/** Refuses a domain this module has no table for, naming the operation that asked. */
function assertDomain(value: unknown, operation: string): asserts value is DocumentDomain {
  if (isDocumentDomain(value)) return;
  throw new RangeError(`${operation}: unknown domain ${describeValue(value)}.`);
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
