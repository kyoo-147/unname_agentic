/**
 * Grounded study pack generator (backlog item J09).
 *
 * A reader studying a technical paper or textbook wants active study materials — cited
 * flashcards, multi-type review questions with verifiable answer keys, and a concept
 * map — without losing the trail back to the document. This module builds that pack
 * from a `DocumentIR`, layering on `notes.ts`, `outline.ts` and `formulas.ts`.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no locale, no network.
 *   Equal documents and options produce byte-identical packs, JSON, Markdown and Anki
 *   exports.
 * - Strictly grounded: every flashcard, review question answer key, concept map node
 *   and concept map edge carries exact source provenance `(documentId, page, blockId,
 *   excerpt)` where `fold(block.raw)` contains `fold(excerpt)`. Nothing is invented.
 * - Claim rejection: {@link verifyCitation}, {@link verifyAnswerKey},
 *   {@link filterGroundedQuestions} and {@link verifyStudyPack} reject missing
 *   citations, document/page/block mismatches, fabricated excerpts, fabricated numbers
 *   and claims not supported by their cited excerpts.
 * - Language-aware: supports both English and Vietnamese documents (including mixed
 *   bilingual documents) and preserves LaTeX formulas cleanly.
 * - Mermaid-safe: concept map node labels and edge labels are single-pass escaped for
 *   Mermaid `graph TD` syntax so quotes, brackets, braces, LaTeX backslashes, pipes,
 *   comments and Unicode render without syntax corruption.
 */

import { detectFormulas, segmentText, toLatex, type MathSegment } from './formulas';
import type { Block, DocumentIR } from './ir';
import {
  buildNotes,
  CSV_RECORD_SEPARATOR as NOTES_CSV_RECORD_SEPARATOR,
  type Notes,
  type NotesOptions,
  UNTITLED_SECTION_TITLE,
} from './notes';
import {
  buildOutline,
  sectionAt,
  SYNTHETIC_BLOCK_ID_PREFIX,
  type Outline,
  type OutlineBlockInput,
  type Section,
} from './outline';

// --- Public constants ------------------------------------------------------

/** Schema version written by {@link toJson} and required by {@link fromJson}. */
export const STUDY_PACK_VERSION = 1;

/** RFC 4180 record separator used by {@link toAnkiCsv}. */
export const CSV_RECORD_SEPARATOR = NOTES_CSV_RECORD_SEPARATOR;

/** Line separator used by {@link toAnkiTsv}. */
export const TSV_RECORD_SEPARATOR = '\n';

/** Default caps so giant documents remain bounded and predictable. */
export const DEFAULT_MAX_FLASHCARDS = 200;
export const DEFAULT_MAX_QUESTIONS = 100;
export const DEFAULT_MAX_CONCEPT_NODES = 40;
export const DEFAULT_MAX_EXCERPT_CHARS = 280;

/** Minimum share of an answer's content tokens that must appear in cited excerpts. */
export const CLAIM_SUPPORT_FLOOR = 0.75;

/** All review question categories produced by this module. */
export type QuestionKind = 'definition' | 'formula' | 'mechanism' | 'comparison';
export const QUESTION_KINDS: readonly QuestionKind[] = [
  'definition',
  'formula',
  'mechanism',
  'comparison',
];

export type FlashcardKind = 'definition' | 'formula' | 'point';
export const FLASHCARD_KINDS: readonly FlashcardKind[] = ['definition', 'formula', 'point'];

export type ConceptNodeKind = 'section' | 'term' | 'formula' | 'entity';
export const CONCEPT_NODE_KINDS: readonly ConceptNodeKind[] = [
  'section',
  'term',
  'formula',
  'entity',
];

export type ConceptRelation = 'contains' | 'defines' | 'uses' | 'causes' | 'compares';
export const CONCEPT_RELATIONS: readonly ConceptRelation[] = [
  'contains',
  'defines',
  'uses',
  'causes',
  'compares',
];

export type StudyPackLanguage = 'en' | 'vi' | 'auto';
export type ResolvedLanguage = 'en' | 'vi';

// --- Public interfaces -----------------------------------------------------

/** Exact provenance pointing back to one block and verbatim excerpt inside a document. */
export interface SourceCitation {
  documentId: string;
  /** 1-based page number. */
  page: number;
  blockId: string;
  /** Folded verbatim slice that appears inside the cited block's raw text. */
  excerpt: string;
}

/** One active-recall flashcard linked to its source block. */
export interface Flashcard {
  id: string;
  kind: FlashcardKind;
  front: string;
  back: string;
  /** Canonical LaTeX body (without delimiters), set on formula cards only. */
  latex?: string;
  /** Source math presentation kind, set on formula cards only. */
  mathKind?: 'inline-math' | 'display-math';
  sectionTitle: string;
  tags: string[];
  citation: SourceCitation;
}

/** Grounded answer key whose prose/formula is backed by exact document citations. */
export interface GroundedAnswerKey {
  answer: string;
  citations: SourceCitation[];
  /** Canonical LaTeX body when the question tests a formula. */
  latex?: string;
}

/** One review question with a verified grounded answer key. */
export interface StudyQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
  answerKey: GroundedAnswerKey;
  sectionTitle: string;
  grounded: true;
}

/** Machine-readable reasons a claim or citation failed grounding verification. */
export type GroundingFailureReason =
  | 'missing-citation'
  | 'document-mismatch'
  | 'unknown-block'
  | 'page-mismatch'
  | 'empty-excerpt'
  | 'excerpt-not-in-block'
  | 'unsupported-claim';

/** External or candidate question/claim submitted for grounding verification. */
export interface CandidateQuestionInput {
  id?: string;
  kind?: QuestionKind;
  prompt: string;
  answer: string;
  citations: readonly SourceCitation[];
  sectionTitle?: string;
  latex?: string;
}

/** A claim or question rejected for lacking valid source grounding. */
export interface RejectedClaim {
  id?: string;
  prompt?: string;
  answer: string;
  citations: SourceCitation[];
  reasons: GroundingFailureReason[];
}

/** Result of checking one answer key or claim against a `DocumentIR`. */
export interface GroundingVerification {
  supported: boolean;
  reasons: GroundingFailureReason[];
  validCitations: SourceCitation[];
  coverage: number;
}

/** One node in the concept map, always linked to its source `(page, blockId)`. */
export interface ConceptNode {
  id: string;
  label: string;
  kind: ConceptNodeKind;
  page: number;
  blockId: string;
  citation: SourceCitation;
}

/** One directed relationship edge between two concept nodes. */
export interface ConceptEdge {
  from: string;
  to: string;
  relation: ConceptRelation;
  label: string;
  citation: SourceCitation;
}

/** Graph representation + ready-to-render Mermaid `graph TD` string. */
export interface ConceptMap {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  mermaid: string;
}

export interface StudyPackSummary {
  flashcards: number;
  questions: number;
  conceptNodes: number;
  conceptEdges: number;
  rejectedClaims: number;
}

export interface StudyPack {
  version: number;
  documentId: string;
  language: ResolvedLanguage;
  notes: Notes;
  flashcards: Flashcard[];
  questions: StudyQuestion[];
  conceptMap: ConceptMap;
  rejectedClaims: RejectedClaim[];
  summary: StudyPackSummary;
}

export interface StudyPackOptions {
  language?: StudyPackLanguage;
  maxFlashcards?: number;
  maxQuestions?: number;
  maxConceptNodes?: number;
  maxExcerptChars?: number;
  includePointCards?: boolean;
  notesOptions?: NotesOptions;
  /** Optional external candidate questions/claims; unsupported ones are rejected. */
  candidateQuestions?: readonly CandidateQuestionInput[];
}

export interface AnkiTsvOptions {
  /** Prepends Anki `#separator:tab` directive lines when true (default false). */
  includeHeader?: boolean;
}

// --- Internal helpers & patterns -------------------------------------------

interface ReadOptions {
  language: StudyPackLanguage;
  maxFlashcards: number;
  maxQuestions: number;
  maxConceptNodes: number;
  maxExcerptChars: number;
  includePointCards: boolean;
  notesOptions: NotesOptions | undefined;
  candidateQuestions: readonly CandidateQuestionInput[];
}

interface OrderedBlock {
  block: Block;
  id: string;
  page: number;
  folded: string;
}

interface IndexedDocument {
  documentId: string;
  blocks: OrderedBlock[];
  byId: Map<string, OrderedBlock>;
  outline: Outline;
}

interface MechanismMatch {
  head: string;
  connector: string;
  tail: string;
  effectStyle: boolean;
  language: ResolvedLanguage;
}

interface ComparisonMatch {
  leftTopic: string;
  rightTopic: string;
  language: ResolvedLanguage;
}

const SENTENCE_END_CHARACTERS = '.!?…';

const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'e.g', 'i.e', 'a.k.a', 'u.s', 'u.k', 'cf', 'fig', 'figs', 'eq', 'eqs',
  'no', 'nos', 'vol', 'vols', 'sec', 'ch', 'p', 'pp', 'al', 'etc', 'vs',
  'dr', 'mr', 'mrs', 'ms', 'st', 'prof', 'inc', 'ltd', 'co', 'jr', 'sr',
  'approx', 'ref', 'refs',
]);

const VIETNAMESE_DIACRITICS =
  /[ăâđêôơưĂÂĐÊÔƠƯáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/u;

const VIETNAMESE_CUES =
  /(?:^|\s)(?:là|được|của|các|những|bằng cách|thông qua|so với|khác với|trong khi|dẫn đến|gây ra|vì vậy|công thức|định nghĩa)(?=\s|[.,;:!?)]|$)/iu;

const COMBINING_MARKS = /\p{M}+/gu;
const NON_WORD_CHAR = /[^\p{L}\p{N}]+/u;
const NUMBER_RUN = /\d+(?:[.,]\d+)?/gu;

/** Function words excluded when verifying claim token support against cited excerpts. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'but',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'with', 'by', 'from', 'as',
  'that', 'this', 'these', 'those', 'it', 'its', 'which', 'who', 'whom', 'how',
  'why', 'when', 'where', 'into', 'about', 'over', 'under', 'between', 'via',
  'can', 'could', 'should', 'would', 'will', 'may', 'might', 'must', 'only',
  'also', 'very', 'more', 'most', 'some', 'such', 'than', 'then', 'while',
  'whereas', 'per',
  'la', 'cua', 'cac', 'nhung', 'mot', 'co', 'cho', 'trong', 'voi', 've', 'khi',
  'thi', 'ma', 'nay', 'do', 'de', 'tu', 'den', 'theo', 'nhu', 'duoc', 'va',
  'hoac', 'nhung', 'nen', 'vi', 'boi', 'bang', 'qua', 'hon', 'nhat', 'tai',
  'giua', 'tren', 'duoi', 'chi', 'rat',
]);

const MECHANISM_PATTERNS: readonly {
  regex: RegExp;
  effectStyle: boolean;
  langHint?: ResolvedLanguage;
}[] = [
  { regex: /^(?<head>.+?)\s+(?<conn>by\s+[a-z]{3,}ing)\s+(?<tail>.+)$/iu, effectStyle: false, langHint: 'en' },
  { regex: /^(?<head>.+?)\s+(?<conn>by\s+means\s+of|through\s+the\s+process\s+of|through|via|using)\s+(?<tail>.+)$/iu, effectStyle: false, langHint: 'en' },
  { regex: /^(?<head>.+?)\s+(?<conn>because|since)\s+(?<tail>.+)$/iu, effectStyle: false, langHint: 'en' },
  { regex: /^(?<head>.+?)\s+(?<conn>causes|leads\s+to|results\s+in|triggers|enables|prevents|inhibits|produces|generates|drives)\s+(?<tail>.+)$/iu, effectStyle: true, langHint: 'en' },
  { regex: /^(?<head>.+?)\s+(?<conn>bằng\s+cách|thông\s+qua|nhờ\s+vào|nhờ|dựa\s+trên|dựa\s+vào|bởi\s+vì)\s+(?<tail>.+)$/iu, effectStyle: false, langHint: 'vi' },
  { regex: /^(?<head>.+?)\s+(?<conn>dẫn\s+đến|gây\s+ra|làm\s+cho|kích\s+hoạt|ức\s+chế|ngăn\s+chặn|tạo\s+ra)\s+(?<tail>.+)$/iu, effectStyle: true, langHint: 'vi' },
];

const COMPARISON_PATTERNS: readonly {
  regex: RegExp;
  langHint?: ResolvedLanguage;
  prefixSwap?: boolean;
}[] = [
  { regex: /^(?<left>.+?)[,;:]?\s+(?:whereas|while)\s+(?<right>.+)$/iu, langHint: 'en' },
  { regex: /^(?:unlike|in\s+contrast\s+to|compared\s+(?:to|with)|as\s+opposed\s+to)\s+(?<left>[^,;]+)[,;]\s*(?<right>.+)$/iu, langHint: 'en', prefixSwap: true },
  { regex: /^(?<left>.+?)\s+(?:compared\s+(?:to|with)|in\s+contrast\s+to|as\s+opposed\s+to|differs?\s+from|different\s+from|outperforms?|surpasses?|exceeds?|versus|vs\.?)\s+(?<right>.+)$/iu, langHint: 'en' },
  { regex: /^(?<left>.+?)\s+(?:more|less|higher|lower|faster|slower|greater|smaller|better|worse|stronger|weaker|larger|shorter|longer)\s+(?:[a-z]+\s+)?than\s+(?<right>.+)$/iu, langHint: 'en' },
  { regex: /^(?<left>.+?)[,;:]?\s+(?:trong\s+khi|ngược\s+lại|trái\s+lại)\s+(?<right>.+)$/iu, langHint: 'vi' },
  { regex: /^(?:khác\s+với|so\s+với|trái\s+với)\s+(?<left>[^,;]+)[,;]\s*(?<right>.+)$/iu, langHint: 'vi', prefixSwap: true },
  { regex: /^(?<left>.+?)\s+(?:so\s+với|khác\s+với|trái\s+với|vượt\s+trội\s+hơn)\s+(?<right>.+)$/iu, langHint: 'vi' },
  { regex: /^(?<left>.+?)\s+(?:cao|thấp|nhanh|chậm|lớn|nhỏ|tốt|kém|mạnh|yếu|nhiều|ít|dài|ngắn|chính\s+xác)\s+hơn\s+(?<right>.+)$/iu, langHint: 'vi' },
];

const COMPARISON_TOPIC_STOP: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'only', 'just', 'however',
  'therefore', 'thus', 'according', 'to', 'in', 'on', 'for', 'of', 'by', 'with',
  'các', 'những', 'một', 'này', 'đó', 'tuy', 'nhiên', 'chỉ', 'của', 'cho', 'về',
]);

const MERMAID_RESERVED_IDS: ReadonlySet<string> = new Set([
  'end', 'graph', 'flowchart', 'subgraph', 'style', 'class', 'classdef',
  'click', 'linkstyle', 'direction', 'call', 'href',
]);

const MERMAID_NODE_ESCAPES: Readonly<Record<string, string>> = {
  '#': '#35;',
  '"': '#quot;',
  '[': '#91;',
  ']': '#93;',
  '(': '#40;',
  ')': '#41;',
  '{': '#123;',
  '}': '#125;',
  '<': '#60;',
  '>': '#62;',
  ';': '#59;',
  '|': '#124;',
  '%': '#37;',
  '\\': '#92;',
  '`': '#96;',
};

const MARKDOWN_ESCAPED = /[\\`*_[\]]/gu;

// --- Public entry points ---------------------------------------------------

/**
 * Builds a complete, strictly grounded {@link StudyPack} from a `DocumentIR`.
 *
 * Reuses `buildNotes`, `buildOutline` and `detectFormulas` to emit:
 * - cited flashcards (definitions, formulas, and non-redundant key points),
 * - review questions (`definition`, `formula`, `mechanism`, `comparison`) with
 *   grounded answer keys citing `(documentId, page, blockId, excerpt)`,
 * - a concept map graph (`nodes`, `edges`, Mermaid `graph TD`),
 * - any external `candidateQuestions` that failed grounding verification in
 *   `rejectedClaims`.
 */
export function buildStudyPack(ir: DocumentIR, options: StudyPackOptions = {}): StudyPack {
  const settings = readOptions(options);
  const indexed = indexDocument(ir, settings.notesOptions?.headingLevels);
  const notes = buildNotes(ir, settings.notesOptions);
  const documentLanguage = resolvePackLanguage(ir, indexed.blocks, settings.language);

  const flashcards = buildFlashcards(indexed, notes, documentLanguage, settings, ir);
  const generatedQuestions = buildReviewQuestions(indexed, notes, documentLanguage, settings, ir);

  const candidateEvaluation = filterGroundedQuestions(settings.candidateQuestions, ir);
  const questions = [...generatedQuestions, ...candidateEvaluation.grounded].slice(
    0,
    settings.maxQuestions,
  );
  const rejectedClaims = candidateEvaluation.rejected;

  const conceptMap = buildConceptMap(indexed, notes, documentLanguage, settings, ir);

  return {
    version: STUDY_PACK_VERSION,
    documentId: indexed.documentId,
    language: documentLanguage,
    notes,
    flashcards,
    questions,
    conceptMap,
    rejectedClaims,
    summary: computeSummary(flashcards, questions, conceptMap, rejectedClaims),
  };
}

/**
 * Verifies one {@link SourceCitation} against `ir`.
 *
 * Checks non-empty document matching, known block lookup, exact page match,
 * non-empty excerpt and verbatim substring containment inside `fold(block.raw)`.
 */
export function verifyCitation(
  citation: SourceCitation,
  ir: DocumentIR,
): { valid: boolean; reason?: GroundingFailureReason } {
  if (!citation || typeof citation !== 'object') {
    return { valid: false, reason: 'missing-citation' };
  }
  const docId = typeof ir?.documentId === 'string' ? ir.documentId.trim() : '';
  const citedDoc = typeof citation.documentId === 'string' ? citation.documentId.trim() : '';
  if (citedDoc.length === 0 || (docId.length > 0 && citedDoc !== docId)) {
    return { valid: false, reason: 'document-mismatch' };
  }

  const blockId = typeof citation.blockId === 'string' ? citation.blockId : '';
  const blocks = Array.isArray(ir?.blocks) ? ir.blocks : [];
  const block = blocks.find(entry => entry && entry.id === blockId);
  if (!block) {
    return { valid: false, reason: 'unknown-block' };
  }

  const blockPage = pageOf(block);
  if (!Number.isInteger(citation.page) || citation.page !== blockPage) {
    return { valid: false, reason: 'page-mismatch' };
  }

  const excerpt = fold(citation.excerpt);
  if (excerpt.length === 0) {
    return { valid: false, reason: 'empty-excerpt' };
  }

  if (!fold(block.raw).includes(excerpt)) {
    return { valid: false, reason: 'excerpt-not-in-block' };
  }

  return { valid: true };
}

/**
 * Verifies an answer key (prose or LaTeX formula) against its citations and `ir`.
 *
 * Rejects empty citations, invalid citations, ungrounded numbers not present in
 * cited excerpts or derived LaTeX, and answers whose content-token coverage falls
 * below {@link CLAIM_SUPPORT_FLOOR}.
 */
export function verifyAnswerKey(
  answerKey: { answer: string; citations: readonly SourceCitation[]; latex?: string },
  ir: DocumentIR,
): GroundingVerification {
  const citations = Array.isArray(answerKey?.citations) ? answerKey.citations : [];
  if (citations.length === 0) {
    return { supported: false, reasons: ['missing-citation'], validCitations: [], coverage: 0 };
  }

  const reasons: GroundingFailureReason[] = [];
  const validCitations: SourceCitation[] = [];

  for (const citation of citations) {
    const check = verifyCitation(citation, ir);
    if (check.valid) {
      validCitations.push({
        documentId: citation.documentId.trim(),
        page: citation.page,
        blockId: citation.blockId,
        excerpt: fold(citation.excerpt),
      });
    } else if (check.reason) {
      pushUnique(reasons, check.reason);
    }
  }

  if (validCitations.length === 0) {
    return { supported: false, reasons, validCitations: [], coverage: 0 };
  }

  const answerText = typeof answerKey?.answer === 'string' ? fold(answerKey.answer) : '';
  if (answerText.length === 0) {
    pushUnique(reasons, 'unsupported-claim');
    return { supported: false, reasons, validCitations, coverage: 0 };
  }

  const evidenceStrings = buildEvidenceCorpus(validCitations);
  const combinedEvidence = evidenceStrings.join(' ');
  const evidenceTokens = contentTokenSet(combinedEvidence);
  const evidenceNumbers = numberSet(combinedEvidence);

  // If a LaTeX answer is provided (or matches a converted formula run in the excerpts),
  // exact LaTeX equality to a cited formula run proves grounding directly.
  const latexText = typeof answerKey?.latex === 'string' ? fold(answerKey.latex) : '';
  if (latexText.length > 0) {
    const derivedLatexes = collectDerivedLatexes(validCitations);
    if (!derivedLatexes.has(latexText)) {
      pushUnique(reasons, 'unsupported-claim');
    }
  }

  const answerNumbers = numberSet(answerText);
  for (const num of answerNumbers) {
    if (!evidenceNumbers.has(num)) {
      pushUnique(reasons, 'unsupported-claim');
      break;
    }
  }

  const answerTokens = [...contentTokenSet(answerText)];
  let coverage = 0;
  if (answerTokens.length === 0) {
    // Allow pure symbolic formulas when every symbol character appears in evidence.
    const rawMatched = symbolCharactersMatch(answerText, combinedEvidence);
    coverage = rawMatched ? 1 : 0;
    if (!rawMatched) pushUnique(reasons, 'unsupported-claim');
  } else {
    let matched = 0;
    for (const token of answerTokens) {
      if (evidenceTokens.has(token)) matched += 1;
    }
    coverage = roundRatio(matched, answerTokens.length);
    if (coverage < CLAIM_SUPPORT_FLOOR) {
      pushUnique(reasons, 'unsupported-claim');
    }
  }

  if (validCitations.length < citations.length) {
    return { supported: false, reasons, validCitations, coverage };
  }

  return {
    supported: reasons.length === 0,
    reasons,
    validCitations,
    coverage,
  };
}

/**
 * Filters candidate questions/claims against `ir`, separating verified grounded
 * questions from rejected unsupported claims.
 */
export function filterGroundedQuestions(
  candidates: readonly CandidateQuestionInput[],
  ir: DocumentIR,
): { grounded: StudyQuestion[]; rejected: RejectedClaim[] } {
  const list = Array.isArray(candidates) ? candidates : [];
  const grounded: StudyQuestion[] = [];
  const rejected: RejectedClaim[] = [];

  list.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return;
    const prompt = fold(candidate.prompt);
    const answer = fold(candidate.answer);
    const citations = Array.isArray(candidate.citations) ? [...candidate.citations] : [];

    const keyInput: { answer: string; citations: readonly SourceCitation[]; latex?: string } = {
      answer,
      citations,
    };
    if (typeof candidate.latex === 'string' && candidate.latex.trim().length > 0) {
      keyInput.latex = fold(candidate.latex);
    }

    const verification = verifyAnswerKey(keyInput, ir);
    if (!verification.supported || prompt.length === 0) {
      const reasons: GroundingFailureReason[] =
        verification.reasons.length > 0 ? verification.reasons : ['unsupported-claim'];
      const item: RejectedClaim = {
        answer,
        citations: citations.map(cloneCitation),
        reasons,
      };
      if (typeof candidate.id === 'string' && candidate.id.trim().length > 0) {
        item.id = candidate.id.trim();
      }
      if (prompt.length > 0) item.prompt = prompt;
      rejected.push(item);
      return;
    }

    const answerKey: GroundedAnswerKey = {
      answer,
      citations: verification.validCitations,
    };
    if (keyInput.latex !== undefined) answerKey.latex = keyInput.latex;

    grounded.push({
      id:
        typeof candidate.id === 'string' && candidate.id.trim().length > 0
          ? candidate.id.trim()
          : `q-ext-${index + 1}`,
      kind: isQuestionKind(candidate.kind) ? candidate.kind : 'definition',
      prompt,
      answerKey,
      sectionTitle:
        typeof candidate.sectionTitle === 'string' && fold(candidate.sectionTitle).length > 0
          ? fold(candidate.sectionTitle)
          : UNTITLED_SECTION_TITLE,
      grounded: true,
    });
  });

  return { grounded, rejected };
}

/**
 * Verifies every flashcard, review question, concept node and concept edge in a
 * {@link StudyPack} against `ir`.
 */
export function verifyStudyPack(
  pack: StudyPack,
  ir: DocumentIR,
): { valid: boolean; failures: RejectedClaim[] } {
  const failures: RejectedClaim[] = [];
  if (!pack || typeof pack !== 'object') {
    return {
      valid: false,
      failures: [{ answer: '', citations: [], reasons: ['missing-citation'] }],
    };
  }

  for (const card of pack.flashcards ?? []) {
    const check = verifyAnswerKey(
      { answer: card.back, citations: [card.citation], ...(card.latex ? { latex: card.latex } : {}) },
      ir,
    );
    if (!check.supported) {
      failures.push({
        id: card.id,
        prompt: card.front,
        answer: card.back,
        citations: [cloneCitation(card.citation)],
        reasons: check.reasons,
      });
    }
  }

  for (const question of pack.questions ?? []) {
    const check = verifyAnswerKey(question.answerKey, ir);
    if (!check.supported) {
      failures.push({
        id: question.id,
        prompt: question.prompt,
        answer: question.answerKey.answer,
        citations: question.answerKey.citations.map(cloneCitation),
        reasons: check.reasons,
      });
    }
  }

  for (const node of pack.conceptMap?.nodes ?? []) {
    const check = verifyCitation(node.citation, ir);
    const pageMatches = node.page === node.citation?.page && node.blockId === node.citation?.blockId;
    if (!check.valid || !pageMatches) {
      failures.push({
        id: node.id,
        prompt: node.label,
        answer: node.label,
        citations: node.citation ? [cloneCitation(node.citation)] : [],
        reasons: check.reason ? [check.reason] : ['page-mismatch'],
      });
    }
  }

  for (const edge of pack.conceptMap?.edges ?? []) {
    const check = verifyCitation(edge.citation, ir);
    if (!check.valid) {
      failures.push({
        id: `${edge.from}->${edge.to}`,
        answer: edge.label,
        citations: edge.citation ? [cloneCitation(edge.citation)] : [],
        reasons: check.reason ? [check.reason] : ['missing-citation'],
      });
    }
  }

  return { valid: failures.length === 0, failures };
}

// --- Serializers & Exporters -----------------------------------------------

/**
 * Exports cited flashcards as RFC 4180 CSV (`Front,Back,Source,Tags`), separated by
 * CRLF. Formula cards wrap LaTeX in `\(...\)` or `\[...\]` for Anki MathJax.
 */
export function toAnkiCsv(pack: StudyPack): string {
  const rows = ankiRows(pack);
  if (rows.length === 0) return '';
  return rows.map(row => row.map(csvField).join(',')).join(CSV_RECORD_SEPARATOR);
}

/**
 * Exports cited flashcards as tab-separated Anki import rows (`Front\tBack\tSource\tTags`).
 * Embedded tabs and newlines are normalized so every row stays strictly 4 columns.
 */
export function toAnkiTsv(pack: StudyPack, options: AnkiTsvOptions = {}): string {
  const rows = ankiRows(pack);
  if (rows.length === 0) return '';
  const body = rows.map(row => row.map(tsvField).join('\t')).join(TSV_RECORD_SEPARATOR);
  if (options?.includeHeader) {
    return `#separator:tab\n#html:false\n${body}`;
  }
  return body;
}

/**
 * Renders a concept map's nodes and edges as a valid, single-pass escaped Mermaid
 * `graph TD` string.
 */
export function toMermaid(conceptMap: Pick<ConceptMap, 'nodes' | 'edges'>): string {
  const nodes = Array.isArray(conceptMap?.nodes) ? conceptMap.nodes : [];
  const edges = Array.isArray(conceptMap?.edges) ? conceptMap.edges : [];
  if (nodes.length === 0) return 'graph TD';

  const lines: string[] = ['graph TD'];
  const idMap = new Map<string, string>();
  const usedIds = new Set<string>();

  nodes.forEach((node, index) => {
    const safeId = allocateMermaidId(node.id, index, usedIds);
    idMap.set(node.id, safeId);
    lines.push(`  ${safeId}["${escapeMermaidNodeLabel(node.label)}"]`);
  });

  for (const edge of edges) {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (!from || !to || from === to) continue;
    const edgeLabel = escapeMermaidEdgeLabel(edge.label || edge.relation);
    lines.push(`  ${from} -->|${edgeLabel}| ${to}`);
  }

  return lines.join('\n');
}

/**
 * Renders a {@link StudyPack} as deterministic Markdown with cited flashcards,
 * grounded review questions, a fenced Mermaid `graph TD` concept map, and a
 * concept source index. Empty packs write the empty string.
 */
export function toMarkdown(pack: StudyPack): string {
  if (!pack || typeof pack !== 'object') return '';
  const flashcards = Array.isArray(pack.flashcards) ? pack.flashcards : [];
  const questions = Array.isArray(pack.questions) ? pack.questions : [];
  const nodes = Array.isArray(pack.conceptMap?.nodes) ? pack.conceptMap.nodes : [];
  if (flashcards.length === 0 && questions.length === 0 && nodes.length === 0) return '';

  const lines: string[] = [
    '# Study pack',
    '',
    `Document: \`${pack.documentId}\` · Language: \`${pack.language}\``,
    '',
  ];

  if (flashcards.length > 0) {
    lines.push('## Flashcards', '');
    for (const card of flashcards) {
      const answerPart =
        card.kind === 'formula' && card.latex
          ? inlineCode(card.latex)
          : escapeInlineText(card.back);
      const source = citationLabel(card.citation);
      lines.push(
        `- **[${card.kind}]** ${escapeInlineText(card.front)} — ${answerPart} *(${escapeInlineText(source)})*`,
      );
    }
    lines.push('');
  }

  if (questions.length > 0) {
    lines.push('## Review Questions', '');
    questions.forEach((question, index) => {
      lines.push(`### ${index + 1}. [${question.kind}] ${escapeInlineText(question.prompt)}`, '');
      const answerPart = question.answerKey.latex
        ? inlineCode(question.answerKey.latex)
        : escapeInlineText(question.answerKey.answer);
      lines.push(`- **Answer:** ${answerPart}`);
      for (const citation of question.answerKey.citations) {
        lines.push(
          `- **Source:** ${escapeInlineText(citationLabel(citation))} — "${escapeInlineText(citation.excerpt)}"`,
        );
      }
      lines.push('');
    });
  }

  if (nodes.length > 0) {
    const mermaid =
      typeof pack.conceptMap?.mermaid === 'string' && pack.conceptMap.mermaid.startsWith('graph TD')
        ? pack.conceptMap.mermaid
        : toMermaid(pack.conceptMap);
    lines.push('## Concept Map', '', '```mermaid', mermaid, '```', '');
    lines.push('### Concept Sources', '');
    for (const node of nodes) {
      lines.push(
        `- **${escapeInlineText(node.label)}** (${node.kind}) — *(${escapeInlineText(citationLabel(node.citation))})*`,
      );
    }
    lines.push('');
  }

  return renderLines(lines);
}

/**
 * Serializes a {@link StudyPack} as deterministic canonical JSON with fixed field
 * order and recomputed summary counts.
 */
export function toJson(pack: StudyPack): string {
  const flashcards = (Array.isArray(pack?.flashcards) ? pack.flashcards : []).map(canonicalFlashcard);
  const questions = (Array.isArray(pack?.questions) ? pack.questions : []).map(canonicalQuestion);
  const nodes = (Array.isArray(pack?.conceptMap?.nodes) ? pack.conceptMap.nodes : []).map(
    canonicalNode,
  );
  const edges = (Array.isArray(pack?.conceptMap?.edges) ? pack.conceptMap.edges : []).map(
    canonicalEdge,
  );
  const mermaid = toMermaid({ nodes, edges });
  const rejectedClaims = (Array.isArray(pack?.rejectedClaims) ? pack.rejectedClaims : []).map(
    canonicalRejected,
  );
  const notes = canonicalNotes(pack?.notes);

  const payload: StudyPack = {
    version: STUDY_PACK_VERSION,
    documentId: typeof pack?.documentId === 'string' ? pack.documentId : '',
    language: pack?.language === 'vi' ? 'vi' : 'en',
    notes,
    flashcards,
    questions,
    conceptMap: { nodes, edges, mermaid },
    rejectedClaims,
    summary: computeSummary(flashcards, questions, { nodes, edges, mermaid }, rejectedClaims),
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Reads back JSON produced by {@link toJson}, validating version and structure and
 * recomputing summary counts. Throws on invalid JSON or unsupported version.
 */
export function fromJson(text: string): StudyPack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof text === 'string' ? text : '');
  } catch {
    throw new Error('Study pack JSON is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Study pack JSON must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== STUDY_PACK_VERSION) {
    throw new Error(`Study pack JSON must declare version ${STUDY_PACK_VERSION}.`);
  }
  if (typeof record.documentId !== 'string') {
    throw new Error('Study pack JSON must carry a documentId string.');
  }
  if (record.language !== 'en' && record.language !== 'vi') {
    throw new Error('Study pack JSON must declare language "en" or "vi".');
  }
  if (!Array.isArray(record.flashcards) || !Array.isArray(record.questions)) {
    throw new Error('Study pack JSON must carry flashcards and questions arrays.');
  }
  if (
    record.conceptMap === null ||
    typeof record.conceptMap !== 'object' ||
    Array.isArray(record.conceptMap)
  ) {
    throw new Error('Study pack JSON must carry a conceptMap object.');
  }
  const mapRecord = record.conceptMap as Record<string, unknown>;
  if (!Array.isArray(mapRecord.nodes) || !Array.isArray(mapRecord.edges)) {
    throw new Error('Study pack conceptMap must carry nodes and edges arrays.');
  }

  const notes = readJsonNotes(record.notes);
  const flashcards = record.flashcards.map(readJsonFlashcard);
  const questions = record.questions.map(readJsonQuestion);
  const nodes = mapRecord.nodes.map(readJsonNode);
  const edges = mapRecord.edges.map(readJsonEdge);
  const mermaid =
    typeof mapRecord.mermaid === 'string' && mapRecord.mermaid.startsWith('graph TD')
      ? mapRecord.mermaid
      : toMermaid({ nodes, edges });
  const rejectedClaims = Array.isArray(record.rejectedClaims)
    ? record.rejectedClaims.map(readJsonRejected)
    : [];
  const conceptMap: ConceptMap = { nodes, edges, mermaid };

  return {
    version: STUDY_PACK_VERSION,
    documentId: record.documentId,
    language: record.language,
    notes,
    flashcards,
    questions,
    conceptMap,
    rejectedClaims,
    summary: computeSummary(flashcards, questions, conceptMap, rejectedClaims),
  };
}

// --- Document indexing & flashcard/question generation ---------------------

function indexDocument(
  ir: DocumentIR,
  headingLevels?: Readonly<Record<string, number>>,
): IndexedDocument {
  const documentId = typeof ir?.documentId === 'string' ? ir.documentId.trim() : '';
  const rawBlocks = Array.isArray(ir?.blocks) ? ir.blocks : [];
  const sorted = rawBlocks
    .map((block, position) => ({ block, position }))
    .filter(row => typeof row.block === 'object' && row.block !== null)
    .sort(
      (left, right) =>
        finiteOr(left.block.readingOrder, 0) - finiteOr(right.block.readingOrder, 0) ||
        finiteOr(left.block.page, 1) - finiteOr(right.block.page, 1) ||
        compareText(left.block.id, right.block.id) ||
        left.position - right.position,
    );

  const blocks: OrderedBlock[] = sorted.map((row, position) => ({
    block: row.block,
    id: blockIdOf(row.block, position),
    page: pageOf(row.block),
    folded: fold(row.block.raw),
  }));

  const byId = new Map<string, OrderedBlock>();
  for (const row of blocks) byId.set(row.id, row);

  const outlineInput: OutlineBlockInput[] = blocks.map(row => {
    const input: OutlineBlockInput = {
      id: row.id,
      page: row.page,
      text: typeof row.block.raw === 'string' ? row.block.raw : '',
      type: row.block.type,
    };
    const level = headingLevels ? headingLevels[row.id] : undefined;
    if (typeof level === 'number' && Number.isFinite(level)) input.headingLevel = level;
    return input;
  });
  const outline = buildOutline(outlineInput);

  return { documentId, blocks, byId, outline };
}

function sectionTitleFor(indexed: IndexedDocument, page: number, blockId: string): string {
  const section = sectionAt(indexed.outline, page, blockId);
  if (!section || section.title.length === 0) return UNTITLED_SECTION_TITLE;
  return section.title;
}

function buildFlashcards(
  indexed: IndexedDocument,
  notes: Notes,
  docLanguage: ResolvedLanguage,
  settings: ReadOptions,
  ir: DocumentIR,
): Flashcard[] {
  const cards: Flashcard[] = [];
  if (settings.maxFlashcards === 0) return cards;

  const coveredSentences = new Set<string>();
  const seenFronts = new Set<string>();
  const formulaHits = indexFormulaSegments(indexed.blocks);

  const tryPush = (card: Flashcard): void => {
    if (cards.length >= settings.maxFlashcards) return;
    if (!verifyCitation(card.citation, ir).valid) return;
    const frontKey = foldKey(card.front);
    if (seenFronts.has(frontKey)) return;
    seenFronts.add(frontKey);
    cards.push(card);
  };

  for (const definition of notes.definitions) {
    const block = indexed.byId.get(definition.blockId);
    if (!block) continue;
    const sentence = findMatchingSentence(
      block.folded,
      [definition.term, definition.text],
      settings.maxExcerptChars,
    );
    coveredSentences.add(foldKey(sentence));
    const lang = itemLanguage(sentence, block.block.language, docLanguage, settings.language);
    const sectionTitle = sectionTitleFor(indexed, definition.page, definition.blockId);
    const front =
      lang === 'vi' ? `${definition.term} là gì?` : `What is ${definition.term}?`;

    tryPush({
      id: `fc-def-${cards.length + 1}`,
      kind: 'definition',
      front,
      back: definition.text,
      sectionTitle,
      tags: buildCardTags('definition', sectionTitle, definition.page),
      citation: {
        documentId: indexed.documentId,
        page: definition.page,
        blockId: definition.blockId,
        excerpt: sentence,
      },
    });
  }

  for (const formula of notes.formulas) {
    const block = indexed.byId.get(formula.blockId);
    if (!block) continue;
    const matchedSegment = formulaHits.get(`${formula.blockId}\u0000${formula.latex}`);
    const searchNeedles = matchedSegment ? [matchedSegment.value] : [formula.latex];
    const sentence = findMatchingSentence(block.folded, searchNeedles, settings.maxExcerptChars);
    coveredSentences.add(foldKey(sentence));

    const lang = itemLanguage(sentence, block.block.language, docLanguage, settings.language);
    const sectionTitle = sectionTitleFor(indexed, formula.page, formula.blockId);
    const front = buildFormulaPrompt(
      sentence,
      matchedSegment?.value ?? '',
      sectionTitle,
      formula.page,
      formula.blockId,
      lang,
    );

    tryPush({
      id: `fc-frm-${cards.length + 1}`,
      kind: 'formula',
      front,
      back: formula.latex,
      latex: formula.latex,
      mathKind: matchedSegment?.kind ?? 'inline-math',
      sectionTitle,
      tags: buildCardTags('formula', sectionTitle, formula.page),
      citation: {
        documentId: indexed.documentId,
        page: formula.page,
        blockId: formula.blockId,
        excerpt: sentence,
      },
    });
  }

  if (settings.includePointCards) {
    for (const section of notes.sections) {
      for (const point of section.points) {
        if (cards.length >= settings.maxFlashcards) break;
        const block = indexed.byId.get(point.blockId);
        if (!block) continue;
        const rawPrefix = point.text.endsWith('…') ? point.text.slice(0, -1) : point.text;
        const sentence = findMatchingSentence(block.folded, [rawPrefix], settings.maxExcerptChars);
        const sentenceKey = foldKey(sentence);
        if (coveredSentences.has(sentenceKey)) continue;
        coveredSentences.add(sentenceKey);

        const lang = itemLanguage(sentence, block.block.language, docLanguage, settings.language);
        const front = buildPointPrompt(section.title, point.kind, point.page, point.blockId, lang);

        tryPush({
          id: `fc-pt-${cards.length + 1}`,
          kind: 'point',
          front,
          back: point.text,
          sectionTitle: section.title,
          tags: buildCardTags('point', section.title, point.page),
          citation: {
            documentId: indexed.documentId,
            page: point.page,
            blockId: point.blockId,
            excerpt: sentence,
          },
        });
      }
    }
  }

  return cards;
}

function buildReviewQuestions(
  indexed: IndexedDocument,
  notes: Notes,
  docLanguage: ResolvedLanguage,
  settings: ReadOptions,
  ir: DocumentIR,
): StudyQuestion[] {
  const questions: StudyQuestion[] = [];
  if (settings.maxQuestions === 0) return questions;

  const seen = new Set<string>();
  const formulaHits = indexFormulaSegments(indexed.blocks);

  const tryPush = (candidate: Omit<StudyQuestion, 'id' | 'grounded'>, prefix: string): void => {
    if (questions.length >= settings.maxQuestions) return;
    const dedupeKey = `${candidate.kind}\u0000${foldKey(candidate.prompt)}\u0000${foldKey(candidate.answerKey.answer)}`;
    if (seen.has(dedupeKey)) return;
    if (!verifyAnswerKey(candidate.answerKey, ir).supported) return;
    seen.add(dedupeKey);
    questions.push({
      id: `q-${prefix}-${questions.length + 1}`,
      ...candidate,
      grounded: true,
    });
  };

  for (const definition of notes.definitions) {
    const block = indexed.byId.get(definition.blockId);
    if (!block) continue;
    const sentence = findMatchingSentence(
      block.folded,
      [definition.term, definition.text],
      settings.maxExcerptChars,
    );
    const lang = itemLanguage(sentence, block.block.language, docLanguage, settings.language);
    const sectionTitle = sectionTitleFor(indexed, definition.page, definition.blockId);
    const prompt =
      lang === 'vi' ? `${definition.term} là gì?` : `What is ${definition.term}?`;

    tryPush(
      {
        kind: 'definition',
        prompt,
        sectionTitle,
        answerKey: {
          answer: definition.text,
          citations: [
            {
              documentId: indexed.documentId,
              page: definition.page,
              blockId: definition.blockId,
              excerpt: sentence,
            },
          ],
        },
      },
      'def',
    );
  }

  for (const formula of notes.formulas) {
    const block = indexed.byId.get(formula.blockId);
    if (!block) continue;
    const matchedSegment = formulaHits.get(`${formula.blockId}\u0000${formula.latex}`);
    const sentence = findMatchingSentence(
      block.folded,
      matchedSegment ? [matchedSegment.value] : [formula.latex],
      settings.maxExcerptChars,
    );
    const lang = itemLanguage(sentence, block.block.language, docLanguage, settings.language);
    const sectionTitle = sectionTitleFor(indexed, formula.page, formula.blockId);
    const prompt = buildFormulaPrompt(
      sentence,
      matchedSegment?.value ?? '',
      sectionTitle,
      formula.page,
      formula.blockId,
      lang,
    );

    tryPush(
      {
        kind: 'formula',
        prompt,
        sectionTitle,
        answerKey: {
          answer: formula.latex,
          latex: formula.latex,
          citations: [
            {
              documentId: indexed.documentId,
              page: formula.page,
              blockId: formula.blockId,
              excerpt: sentence,
            },
          ],
        },
      },
      'frm',
    );
  }

  for (const row of indexed.blocks) {
    if (row.block.type !== 'paragraph' && row.block.type !== 'list') continue;
    const sectionTitle = sectionTitleFor(indexed, row.page, row.id);
    const sentences = splitSentences(row.folded);

    for (const sentence of sentences) {
      const excerpt = sliceExcerpt(sentence, settings.maxExcerptChars);
      const lang = itemLanguage(sentence, row.block.language, docLanguage, settings.language);
      const citation: SourceCitation = {
        documentId: indexed.documentId,
        page: row.page,
        blockId: row.id,
        excerpt,
      };

      const mechanism = parseMechanism(sentence, lang);
      if (mechanism) {
        const prompt = buildMechanismPrompt(mechanism, sectionTitle, row.page);
        tryPush(
          {
            kind: 'mechanism',
            prompt,
            sectionTitle,
            answerKey: { answer: sentence, citations: [citation] },
          },
          'mech',
        );
      }

      const comparison = parseComparison(sentence, lang);
      if (comparison) {
        const prompt = buildComparisonPrompt(comparison, sectionTitle, row.page);
        tryPush(
          {
            kind: 'comparison',
            prompt,
            sectionTitle,
            answerKey: { answer: sentence, citations: [citation] },
          },
          'cmp',
        );
      }
    }
  }

  return questions;
}

// --- Concept map construction ----------------------------------------------

function buildConceptMap(
  indexed: IndexedDocument,
  notes: Notes,
  docLanguage: ResolvedLanguage,
  settings: ReadOptions,
  ir: DocumentIR,
): ConceptMap {
  if (indexed.blocks.length === 0 || settings.maxConceptNodes === 0) {
    return { nodes: [], edges: [], mermaid: 'graph TD' };
  }

  const nodes: ConceptNode[] = [];
  const nodeByKey = new Map<string, ConceptNode>();
  const sectionNodeByTitleKey = new Map<string, ConceptNode>();
  const edges: ConceptEdge[] = [];
  const edgeKeys = new Set<string>();

  const ensureNode = (
    label: string,
    kind: ConceptNodeKind,
    page: number,
    blockId: string,
    excerptHint?: string,
  ): ConceptNode | null => {
    const cleanLabel = fold(label);
    if (cleanLabel.length === 0) return null;
    const key = foldKey(cleanLabel);
    const existing = nodeByKey.get(key);
    if (existing) return existing;
    if (nodes.length >= settings.maxConceptNodes) return null;

    const block = indexed.byId.get(blockId);
    if (!block) return null;
    const excerpt = findMatchingSentence(
      block.folded,
      excerptHint ? [excerptHint, cleanLabel] : [cleanLabel],
      settings.maxExcerptChars,
    );
    const citation: SourceCitation = {
      documentId: indexed.documentId,
      page,
      blockId,
      excerpt,
    };
    if (!verifyCitation(citation, ir).valid) return null;

    const node: ConceptNode = {
      id: `n${nodes.length + 1}`,
      label: cleanLabel,
      kind,
      page,
      blockId,
      citation,
    };
    nodes.push(node);
    nodeByKey.set(key, node);
    return node;
  };

  const addEdge = (
    from: ConceptNode | null,
    to: ConceptNode | null,
    relation: ConceptRelation,
    label: string,
    citation: SourceCitation,
  ): void => {
    if (!from || !to || from.id === to.id) return;
    const key = `${from.id}\u0000${to.id}\u0000${relation}`;
    if (edgeKeys.has(key)) return;
    if (!verifyCitation(citation, ir).valid) return;
    edgeKeys.add(key);
    edges.push({ from: from.id, to: to.id, relation, label, citation });
  };

  // 1. Sections (outline headings and hierarchy)
  for (const section of notes.sections) {
    const node = ensureNode(section.title, 'section', section.page, section.blockId);
    if (node) sectionNodeByTitleKey.set(foldKey(section.title), node);
  }

  const walkHierarchy = (siblings: readonly Section[], parentNode: ConceptNode | null): void => {
    for (const section of siblings) {
      const title = section.title.length > 0 ? section.title : UNTITLED_SECTION_TITLE;
      const currentNode = sectionNodeByTitleKey.get(foldKey(title)) ?? null;
      if (parentNode && currentNode) {
        addEdge(parentNode, currentNode, 'contains', 'contains', currentNode.citation);
      }
      walkHierarchy(section.children, currentNode);
    }
  };
  walkHierarchy(indexed.outline.sections, null);

  // 2. Defined terms
  const termNodes: { node: ConceptNode; text: string }[] = [];
  for (const def of notes.definitions) {
    const sectionTitle = sectionTitleFor(indexed, def.page, def.blockId);
    const sectionNode = sectionNodeByTitleKey.get(foldKey(sectionTitle)) ?? null;
    const termNode = ensureNode(def.term, 'term', def.page, def.blockId, def.text);
    if (termNode) {
      termNodes.push({ node: termNode, text: def.text });
      addEdge(sectionNode, termNode, 'defines', 'defines', termNode.citation);
    }
  }

  // 3. Formulas
  const formulaHits = indexFormulaSegments(indexed.blocks);
  for (const formula of notes.formulas) {
    if (formula.latex.length > 60) continue;
    const seg = formulaHits.get(`${formula.blockId}\u0000${formula.latex}`);
    const sectionTitle = sectionTitleFor(indexed, formula.page, formula.blockId);
    const sectionNode = sectionNodeByTitleKey.get(foldKey(sectionTitle)) ?? null;
    const formulaNode = ensureNode(
      formula.latex,
      'formula',
      formula.page,
      formula.blockId,
      seg?.value ?? formula.latex,
    );
    if (formulaNode) {
      addEdge(sectionNode, formulaNode, 'uses', 'uses', formulaNode.citation);
    }
  }

  // 4. Entities and semantic links from mechanism & comparison sentences
  for (const row of indexed.blocks) {
    if (row.block.type !== 'paragraph' && row.block.type !== 'list') continue;
    const sectionTitle = sectionTitleFor(indexed, row.page, row.id);
    const sectionNode = sectionNodeByTitleKey.get(foldKey(sectionTitle)) ?? null;

    for (const sentence of splitSentences(row.folded)) {
      const lang = itemLanguage(sentence, row.block.language, docLanguage, settings.language);
      const citation: SourceCitation = {
        documentId: indexed.documentId,
        page: row.page,
        blockId: row.id,
        excerpt: sliceExcerpt(sentence, settings.maxExcerptChars),
      };

      const comparison = parseComparison(sentence, lang);
      if (comparison) {
        const leftNode = findOrCreateConceptNode(
          comparison.leftTopic,
          row.page,
          row.id,
          sentence,
          nodeByKey,
          ensureNode,
        );
        const rightNode = findOrCreateConceptNode(
          comparison.rightTopic,
          row.page,
          row.id,
          sentence,
          nodeByKey,
          ensureNode,
        );
        if (leftNode && leftNode.kind === 'entity') {
          addEdge(sectionNode, leftNode, 'contains', 'contains', leftNode.citation);
        }
        if (rightNode && rightNode.kind === 'entity') {
          addEdge(sectionNode, rightNode, 'contains', 'contains', rightNode.citation);
        }
        addEdge(leftNode, rightNode, 'compares', 'compares', citation);
      }

      const mechanism = parseMechanism(sentence, lang);
      if (mechanism) {
        const matched = findNodesMentionedInOrder(sentence, nodes);
        const headNode =
          matched.find(n => foldKey(mechanism.head).includes(foldKey(n.label))) ?? matched[0] ?? null;
        const tailNode =
          matched.find(
            n => n.id !== headNode?.id && foldKey(mechanism.tail).includes(foldKey(n.label)),
          ) ??
          matched[1] ??
          null;
        addEdge(headNode, tailNode, 'causes', 'causes', citation);
      }
    }
  }

  // 5. Cross-term definition references (when term A's definition mentions term B)
  for (const entry of termNodes) {
    const bodyFolded = ` ${foldKey(entry.text)} `;
    for (const target of nodes) {
      if (target.id === entry.node.id || target.kind === 'section' || target.kind === 'formula') {
        continue;
      }
      const targetKey = foldKey(target.label);
      if (targetKey.length < 2) continue;
      if (bodyFolded.includes(` ${targetKey} `)) {
        addEdge(entry.node, target, 'uses', 'uses', entry.node.citation);
      }
    }
  }

  const mermaid = toMermaid({ nodes, edges });
  return { nodes, edges, mermaid };
}

function findOrCreateConceptNode(
  topic: string,
  page: number,
  blockId: string,
  sentence: string,
  nodeByKey: ReadonlyMap<string, ConceptNode>,
  ensureNode: (
    label: string,
    kind: ConceptNodeKind,
    page: number,
    blockId: string,
    excerptHint?: string,
  ) => ConceptNode | null,
): ConceptNode | null {
  const clean = cleanConceptLabel(topic);
  if (clean.length < 2) return null;
  const existing = nodeByKey.get(foldKey(clean));
  if (existing) return existing;

  // Prefer matching an already-known concept contained within the topic phrase.
  const topicFolded = ` ${foldKey(clean)} `;
  for (const [key, node] of nodeByKey) {
    if (key.length >= 2 && node.kind !== 'section' && topicFolded.includes(` ${key} `)) {
      return node;
    }
  }
  return ensureNode(clean, 'entity', page, blockId, sentence);
}

function findNodesMentionedInOrder(
  sentence: string,
  nodes: readonly ConceptNode[],
): ConceptNode[] {
  const padded = ` ${foldKey(sentence)} `;
  const hits: { node: ConceptNode; pos: number }[] = [];
  for (const node of nodes) {
    if (node.kind === 'section' || node.kind === 'formula') continue;
    const needle = ` ${foldKey(node.label)} `;
    if (needle.length < 4) continue;
    const pos = padded.indexOf(needle);
    if (pos !== -1) hits.push({ node, pos });
  }
  hits.sort((left, right) => left.pos - right.pos);
  return hits.map(hit => hit.node);
}

// --- Prompt builders & NLP extractors --------------------------------------

function indexFormulaSegments(blocks: readonly OrderedBlock[]): Map<string, MathSegment> {
  const hits = detectFormulas(blocks.map(row => ({ id: row.id, raw: row.block.raw })));
  const map = new Map<string, MathSegment>();
  for (const hit of hits) {
    const row = blocks[hit.index];
    if (!row) continue;
    for (const formula of hit.formulas) {
      const key = `${row.id}\u0000${formula.latex.trim()}`;
      if (!map.has(key)) map.set(key, formula);
    }
  }
  return map;
}

function buildFormulaPrompt(
  sentence: string,
  rawFormula: string,
  sectionTitle: string,
  page: number,
  blockId: string,
  lang: ResolvedLanguage,
): string {
  if (rawFormula.length > 0 && sentence.includes(rawFormula)) {
    const masked = fold(sentence.replace(rawFormula, '___'));
    const outsideWords = masked.replace('___', '').split(/\s+/u).filter(w => /[\p{L}\p{N}]/u.test(w));
    if (outsideWords.length >= 2 && masked.length <= 180) {
      return lang === 'vi'
        ? `Hoàn thành công thức (${sectionTitle}, tr.${page}): ${masked}`
        : `Complete the formula (${sectionTitle}, p.${page}): ${masked}`;
    }
  }
  return lang === 'vi'
    ? `Viết công thức trong mục "${sectionTitle}" (tr.${page} · ${blockId}).`
    : `Write the formula from "${sectionTitle}" (p.${page} · ${blockId}).`;
}

function buildPointPrompt(
  sectionTitle: string,
  kind: 'lead' | 'number' | 'emphasis',
  page: number,
  blockId: string,
  lang: ResolvedLanguage,
): string {
  if (lang === 'vi') {
    const label =
      kind === 'emphasis' ? 'lưu ý quan trọng' : kind === 'number' ? 'số liệu chính' : 'ý chính';
    return `Nêu ${label} trong mục "${sectionTitle}" (tr.${page} · ${blockId}).`;
  }
  const label =
    kind === 'emphasis' ? 'important note' : kind === 'number' ? 'key figure' : 'key point';
  return `What ${label} is stated in "${sectionTitle}" (p.${page} · ${blockId})?`;
}

function parseMechanism(sentence: string, lang: ResolvedLanguage): MechanismMatch | null {
  const text = fold(sentence);
  if (text.length < 15 || text.length > 600 || text.endsWith('?')) return null;

  for (const spec of MECHANISM_PATTERNS) {
    const match = spec.regex.exec(text);
    if (!match) continue;
    const head = fold(match.groups?.['head']);
    const connector = fold(match.groups?.['conn']);
    const tail = fold(match.groups?.['tail']).replace(/[.;:!?]+$/u, '').trim();
    if (wordCount(head) < 2 || wordCount(tail) < 2) continue;
    // Reject non-mechanism prepositional years/names like "by 2020" or "since 1995".
    if (/^(?:19|20)\d{2}\b/u.test(tail)) continue;
    return {
      head,
      connector,
      tail,
      effectStyle: spec.effectStyle,
      language: spec.langHint ?? lang,
    };
  }
  return null;
}

function buildMechanismPrompt(
  match: MechanismMatch,
  sectionTitle: string,
  page: number,
): string {
  if (match.language === 'vi') {
    if (match.effectStyle) {
      return `Theo mục "${sectionTitle}" (tr.${page}), "${match.head}" tạo ra tác động gì?`;
    }
    return `Theo mục "${sectionTitle}" (tr.${page}), cơ chế nào giải thích cho "${match.head}"?`;
  }
  if (match.effectStyle) {
    return `According to "${sectionTitle}" (p.${page}), what outcome results from "${match.head}"?`;
  }
  return `According to "${sectionTitle}" (p.${page}), how does "${match.head}" work?`;
}

function parseComparison(sentence: string, lang: ResolvedLanguage): ComparisonMatch | null {
  const text = fold(sentence);
  if (text.length < 15 || text.length > 600 || text.endsWith('?')) return null;

  for (const spec of COMPARISON_PATTERNS) {
    const match = spec.regex.exec(text);
    if (!match) continue;
    const leftRaw = fold(match.groups?.['left']);
    const rightRaw = fold(match.groups?.['right']);
    if (wordCount(leftRaw) < 1 || wordCount(rightRaw) < 1) continue;

    const leftTopic = extractComparisonTopic(leftRaw);
    const rightTopic = extractComparisonTopic(rightRaw);
    if (leftTopic.length < 2 || rightTopic.length < 2) continue;
    if (foldKey(leftTopic) === foldKey(rightTopic)) continue;

    return {
      leftTopic: spec.prefixSwap ? rightTopic : leftTopic,
      rightTopic: spec.prefixSwap ? leftTopic : rightTopic,
      language: spec.langHint ?? lang,
    };
  }
  return null;
}

const COMPARISON_TOPIC_VERBS: ReadonlySet<string> = new Set([
  'yield', 'yields', 'achieve', 'achieves', 'run', 'runs', 'is', 'are', 'was',
  'were', 'has', 'have', 'had', 'model', 'models', 'capture', 'captures',
  'process', 'processes', 'rely', 'relies', 'use', 'uses', 'provide', 'provides',
  'require', 'requires', 'consume', 'consumes', 'take', 'takes', 'support',
  'supports', 'handle', 'handles', 'work', 'works', 'operate', 'operates',
  'dat', 'co', 'la', 'chay', 'dung', 'can', 'cho',
]);

const COMPARISON_TOPIC_BIGRAM_VERBS: ReadonlySet<string> = new Set([
  'su dung', 'xu ly', 'hoat dong', 'tao ra', 'mang lai', 'tieu thu',
]);

function extractComparisonTopic(clause: string): string {
  const cleaned = cleanConceptLabel(clause);
  const tokens = cleaned.split(/\s+/u).filter(t => t.length > 0);
  while (tokens.length > 0) {
    const first = tokens[0];
    if (!first) break;
    if (COMPARISON_TOPIC_STOP.has(foldKey(first))) tokens.shift();
    else break;
  }

  const picked: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || picked.length >= 4) break;
    // Stop before numbers or clause verbs so answers don't leak into the topic label.
    if (picked.length >= 1 && /^\d/u.test(token)) break;
    const stripped = token.replace(/[,.;:!?]+$/u, '');
    const foldedToken = foldKey(stripped);
    if (picked.length >= 1 && COMPARISON_TOPIC_VERBS.has(foldedToken)) break;
    const next = tokens[i + 1]?.replace(/[,.;:!?]+$/u, '') ?? '';
    if (
      picked.length >= 1 &&
      next.length > 0 &&
      COMPARISON_TOPIC_BIGRAM_VERBS.has(`${foldedToken} ${foldKey(next)}`)
    ) {
      break;
    }
    picked.push(stripped);
  }
  return picked.join(' ').trim();
}

function cleanConceptLabel(value: string): string {
  return fold(value)
    .replace(/^["'“”‘’(\[]+/u, '')
    .replace(/["'“”‘’)\],.;:!?]+$/u, '')
    .trim();
}

function buildComparisonPrompt(
  match: ComparisonMatch,
  sectionTitle: string,
  page: number,
): string {
  if (match.language === 'vi') {
    return `Trong mục "${sectionTitle}" (tr.${page}), "${match.leftTopic}" và "${match.rightTopic}" được so sánh như thế nào?`;
  }
  return `In "${sectionTitle}" (p.${page}), how do "${match.leftTopic}" and "${match.rightTopic}" compare?`;
}

// --- Grounding & corpus helpers --------------------------------------------

function buildEvidenceCorpus(citations: readonly SourceCitation[]): string[] {
  const parts: string[] = [];
  for (const citation of citations) {
    parts.push(citation.excerpt);
    for (const seg of segmentText(citation.excerpt)) {
      if (seg.kind !== 'text' && seg.latex) parts.push(seg.latex);
    }
  }
  return parts;
}

function collectDerivedLatexes(citations: readonly SourceCitation[]): Set<string> {
  const set = new Set<string>();
  for (const citation of citations) {
    for (const seg of segmentText(citation.excerpt)) {
      if (seg.kind !== 'text' && seg.latex) set.add(fold(seg.latex));
    }
    // Also support blocks whose entire excerpt is bare LaTeX
    const trimmed = fold(citation.excerpt);
    if (trimmed.length > 0) set.add(fold(toLatex(trimmed)));
  }
  return set;
}

function contentTokenSet(text: string): Set<string> {
  const normalized = foldDiacritics(text)
    .replace(/\\/gu, ' ')
    .replace(/[{}^_]/gu, ' ');
  const tokens = normalized.split(NON_WORD_CHAR);
  const set = new Set<string>();
  for (const token of tokens) {
    if (token.length === 0) continue;
    if (STOPWORDS.has(token)) continue;
    set.add(token);
  }
  return set;
}

function numberSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const match of text.matchAll(NUMBER_RUN)) {
    set.add(match[0].replace(/,/gu, '.'));
  }
  return set;
}

function symbolCharactersMatch(answer: string, evidence: string): boolean {
  const answerChars = Array.from(answer.replace(/\s+/gu, ''));
  if (answerChars.length === 0) return false;
  const evidenceChars = new Set(Array.from(evidence.replace(/\s+/gu, '')));
  return answerChars.every(ch => evidenceChars.has(ch));
}

function buildCardTags(kind: FlashcardKind, sectionTitle: string, page: number): string[] {
  const tags = ['study-pack', kind];
  const secSlug = slugTag(sectionTitle);
  if (secSlug.length > 0) tags.push(secSlug);
  tags.push(`p${page}`);
  return tags;
}

function slugTag(value: string): string {
  return foldDiacritics(value)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40);
}

// --- Sentence splitting & excerpt extraction -------------------------------

function splitSentences(value: string): string[] {
  const text = fold(value);
  if (text.length === 0) return [];

  const sentences: string[] = [];
  let start = 0;
  let index = 0;

  while (index < text.length) {
    const ch = text.charAt(index);
    if (!SENTENCE_END_CHARACTERS.includes(ch)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end + 1 < text.length && SENTENCE_END_CHARACTERS.includes(text.charAt(end + 1))) {
      end += 1;
    }
    const next = text.charAt(end + 1);
    if (next !== '' && !/\s/u.test(next)) {
      index = end + 1;
      continue;
    }
    if (end === index && ch === '.' && isGuardedDot(text, index)) {
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

function isGuardedDot(text: string, at: number): boolean {
  const prev = text.charAt(at - 1);
  if (/\d/u.test(prev)) return true;
  if (/\p{L}/u.test(text.charAt(at + 1))) return true;
  let start = at;
  while (start > 0 && /[\p{L}.\p{N}]/u.test(text.charAt(start - 1))) start -= 1;
  const word = text.slice(start, at).replace(/^\.+/u, '');
  if (word.length === 1 && /\p{Lu}/u.test(prev)) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Picks the sentence in `foldedBlock` containing `needles`, trimmed cleanly to
 * `maxChars` without inserting ellipsis so `foldedBlock.includes(excerpt)` stays true.
 */
function findMatchingSentence(
  foldedBlock: string,
  needles: readonly string[],
  maxChars: number,
): string {
  const sentences = splitSentences(foldedBlock);
  const validNeedles = needles.map(n => fold(n)).filter(n => n.length > 0);

  for (const sentence of sentences) {
    if (validNeedles.every(needle => sentence.includes(needle))) {
      return sliceExcerptAround(sentence, validNeedles[0] ?? '', maxChars);
    }
  }
  for (const needle of validNeedles) {
    for (const sentence of sentences) {
      if (sentence.includes(needle)) {
        return sliceExcerptAround(sentence, needle, maxChars);
      }
    }
  }
  const fallback = sentences[0] ?? foldedBlock;
  return sliceExcerpt(fallback, maxChars);
}

function sliceExcerpt(sentence: string, maxChars: number): string {
  return sliceExcerptAround(sentence, '', maxChars);
}

function sliceExcerptAround(sentence: string, needle: string, maxChars: number): string {
  const text = fold(sentence);
  if (text.length === 0 || maxChars <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;

  const needleIndex = needle.length > 0 ? text.indexOf(needle) : 0;
  let charStart = 0;
  if (needleIndex > 0) {
    const prefixChars = Array.from(text.slice(0, needleIndex)).length;
    const needleChars = Array.from(needle).length;
    if (prefixChars + needleChars > maxChars) {
      charStart = Math.max(0, prefixChars - Math.floor((maxChars - needleChars) / 2));
    }
  }

  let window = chars.slice(charStart, charStart + maxChars).join('');
  if (charStart > 0) {
    const firstSpace = window.indexOf(' ');
    if (firstSpace > 0 && firstSpace < Math.floor(window.length / 3)) {
      window = window.slice(firstSpace + 1);
    }
  }
  if (charStart + maxChars < chars.length) {
    const lastSpace = window.lastIndexOf(' ');
    if (lastSpace > Math.floor(window.length / 2)) {
      window = window.slice(0, lastSpace);
    }
  }
  return window.trim();
}

// --- Anki & Mermaid & Markdown helpers -------------------------------------

function ankiRows(pack: StudyPack): string[][] {
  const cards = Array.isArray(pack?.flashcards) ? pack.flashcards : [];
  return cards.map(card => {
    const back =
      card.kind === 'formula' && card.latex
        ? card.mathKind === 'display-math'
          ? `\\[${card.latex}\\]`
          : `\\(${card.latex}\\)`
        : card.back;
    const source = citationLabel(card.citation);
    const tags = Array.isArray(card.tags) ? card.tags.join(' ') : '';
    return [card.front, back, source, tags];
  });
}

function citationLabel(citation: SourceCitation): string {
  return `${citation.documentId} · p.${citation.page} · ${citation.blockId}`;
}

function csvField(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  return `"${text.replace(/"/gu, '""')}"`;
}

function tsvField(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  return text.replace(/[\t\r\n]+/gu, ' ').trim();
}

function allocateMermaidId(rawId: string, index: number, used: Set<string>): string {
  const candidate =
    typeof rawId === 'string' &&
    /^[A-Za-z][A-Za-z0-9_]*$/u.test(rawId) &&
    !MERMAID_RESERVED_IDS.has(rawId.toLowerCase()) &&
    !used.has(rawId)
      ? rawId
      : `n${index + 1}`;
  let resolved = candidate;
  let suffix = 1;
  while (used.has(resolved) || MERMAID_RESERVED_IDS.has(resolved.toLowerCase())) {
    resolved = `n${index + 1}_${suffix}`;
    suffix += 1;
  }
  used.add(resolved);
  return resolved;
}

function escapeMermaidNodeLabel(value: string): string {
  const collapsed = fold(value);
  let out = '';
  for (const ch of collapsed) {
    out += MERMAID_NODE_ESCAPES[ch] ?? ch;
  }
  return out;
}

function escapeMermaidEdgeLabel(value: string): string {
  return escapeMermaidNodeLabel(value);
}

function escapeInlineText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(MARKDOWN_ESCAPED, character => `\\${character}`);
}

function inlineCode(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  const fence = text.includes('`') ? '``' : '`';
  const padded = fence === '``' ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

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

// --- JSON canonicalization & parsing ---------------------------------------

function canonicalNotes(notes: Notes | undefined): Notes {
  const sections = (Array.isArray(notes?.sections) ? notes.sections : []).map(sec => ({
    title: typeof sec.title === 'string' ? sec.title : '',
    page: pageInt(sec.page),
    blockId: typeof sec.blockId === 'string' ? sec.blockId : '',
    points: (Array.isArray(sec.points) ? sec.points : []).map(pt => ({
      text: typeof pt.text === 'string' ? pt.text : '',
      page: pageInt(pt.page),
      blockId: typeof pt.blockId === 'string' ? pt.blockId : '',
      kind: pt.kind,
    })),
  }));
  const definitions = (Array.isArray(notes?.definitions) ? notes.definitions : []).map(def => ({
    term: typeof def.term === 'string' ? def.term : '',
    text: typeof def.text === 'string' ? def.text : '',
    page: pageInt(def.page),
    blockId: typeof def.blockId === 'string' ? def.blockId : '',
  }));
  const formulas = (Array.isArray(notes?.formulas) ? notes.formulas : []).map(frm => ({
    latex: typeof frm.latex === 'string' ? frm.latex : '',
    page: pageInt(frm.page),
    blockId: typeof frm.blockId === 'string' ? frm.blockId : '',
  }));
  return {
    sections,
    definitions,
    formulas,
    summary: {
      sections: sections.length,
      points: sections.reduce((sum, s) => sum + s.points.length, 0),
      definitions: definitions.length,
      formulas: formulas.length,
    },
  };
}

function canonicalFlashcard(card: Flashcard): Flashcard {
  const out: Flashcard = {
    id: card.id,
    kind: card.kind,
    front: card.front,
    back: card.back,
    sectionTitle: card.sectionTitle,
    tags: [...card.tags],
    citation: cloneCitation(card.citation),
  };
  if (card.latex !== undefined) out.latex = card.latex;
  if (card.mathKind !== undefined) out.mathKind = card.mathKind;
  return out;
}

function canonicalQuestion(question: StudyQuestion): StudyQuestion {
  const answerKey: GroundedAnswerKey = {
    answer: question.answerKey.answer,
    citations: question.answerKey.citations.map(cloneCitation),
  };
  if (question.answerKey.latex !== undefined) answerKey.latex = question.answerKey.latex;
  return {
    id: question.id,
    kind: question.kind,
    prompt: question.prompt,
    answerKey,
    sectionTitle: question.sectionTitle,
    grounded: true,
  };
}

function canonicalNode(node: ConceptNode): ConceptNode {
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    page: pageInt(node.page),
    blockId: node.blockId,
    citation: cloneCitation(node.citation),
  };
}

function canonicalEdge(edge: ConceptEdge): ConceptEdge {
  return {
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    label: edge.label,
    citation: cloneCitation(edge.citation),
  };
}

function canonicalRejected(claim: RejectedClaim): RejectedClaim {
  const out: RejectedClaim = {
    answer: claim.answer,
    citations: claim.citations.map(cloneCitation),
    reasons: [...claim.reasons],
  };
  if (claim.id !== undefined) out.id = claim.id;
  if (claim.prompt !== undefined) out.prompt = claim.prompt;
  return out;
}

function readJsonNotes(value: unknown): Notes {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Study pack JSON must carry a notes object.');
  }
  return canonicalNotes(value as Notes);
}

function readJsonCitation(value: unknown, path: string): SourceCitation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Study pack JSON ${path} must be a citation object.`);
  }
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.documentId !== 'string' ||
    typeof rec.page !== 'number' ||
    !Number.isInteger(rec.page) ||
    typeof rec.blockId !== 'string' ||
    typeof rec.excerpt !== 'string'
  ) {
    throw new Error(`Study pack JSON ${path} has invalid citation fields.`);
  }
  return {
    documentId: rec.documentId,
    page: rec.page,
    blockId: rec.blockId,
    excerpt: rec.excerpt,
  };
}

function readJsonFlashcard(value: unknown, index: number): Flashcard {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Study pack JSON flashcards[${index}] must be an object.`);
  }
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.id !== 'string' ||
    !FLASHCARD_KINDS.includes(rec.kind as FlashcardKind) ||
    typeof rec.front !== 'string' ||
    typeof rec.back !== 'string' ||
    typeof rec.sectionTitle !== 'string' ||
    !Array.isArray(rec.tags)
  ) {
    throw new Error(`Study pack JSON flashcards[${index}] has invalid fields.`);
  }
  const card: Flashcard = {
    id: rec.id,
    kind: rec.kind as FlashcardKind,
    front: rec.front,
    back: rec.back,
    sectionTitle: rec.sectionTitle,
    tags: rec.tags.filter((t): t is string => typeof t === 'string'),
    citation: readJsonCitation(rec.citation, `flashcards[${index}].citation`),
  };
  if (typeof rec.latex === 'string') card.latex = rec.latex;
  if (rec.mathKind === 'inline-math' || rec.mathKind === 'display-math') {
    card.mathKind = rec.mathKind;
  }
  return card;
}

function readJsonQuestion(value: unknown, index: number): StudyQuestion {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Study pack JSON questions[${index}] must be an object.`);
  }
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.id !== 'string' ||
    !isQuestionKind(rec.kind) ||
    typeof rec.prompt !== 'string' ||
    typeof rec.sectionTitle !== 'string' ||
    rec.grounded !== true ||
    rec.answerKey === null ||
    typeof rec.answerKey !== 'object' ||
    Array.isArray(rec.answerKey)
  ) {
    throw new Error(`Study pack JSON questions[${index}] has invalid fields.`);
  }
  const keyRec = rec.answerKey as Record<string, unknown>;
  if (typeof keyRec.answer !== 'string' || !Array.isArray(keyRec.citations)) {
    throw new Error(`Study pack JSON questions[${index}].answerKey has invalid fields.`);
  }
  const answerKey: GroundedAnswerKey = {
    answer: keyRec.answer,
    citations: keyRec.citations.map((c, ci) =>
      readJsonCitation(c, `questions[${index}].answerKey.citations[${ci}]`),
    ),
  };
  if (typeof keyRec.latex === 'string') answerKey.latex = keyRec.latex;
  return {
    id: rec.id,
    kind: rec.kind,
    prompt: rec.prompt,
    answerKey,
    sectionTitle: rec.sectionTitle,
    grounded: true,
  };
}

function readJsonNode(value: unknown, index: number): ConceptNode {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Study pack JSON conceptMap.nodes[${index}] must be an object.`);
  }
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.id !== 'string' ||
    typeof rec.label !== 'string' ||
    !CONCEPT_NODE_KINDS.includes(rec.kind as ConceptNodeKind) ||
    typeof rec.page !== 'number' ||
    !Number.isInteger(rec.page) ||
    typeof rec.blockId !== 'string'
  ) {
    throw new Error(`Study pack JSON conceptMap.nodes[${index}] has invalid fields.`);
  }
  return {
    id: rec.id,
    label: rec.label,
    kind: rec.kind as ConceptNodeKind,
    page: rec.page,
    blockId: rec.blockId,
    citation: readJsonCitation(rec.citation, `conceptMap.nodes[${index}].citation`),
  };
}

function readJsonEdge(value: unknown, index: number): ConceptEdge {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Study pack JSON conceptMap.edges[${index}] must be an object.`);
  }
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.from !== 'string' ||
    typeof rec.to !== 'string' ||
    !CONCEPT_RELATIONS.includes(rec.relation as ConceptRelation) ||
    typeof rec.label !== 'string'
  ) {
    throw new Error(`Study pack JSON conceptMap.edges[${index}] has invalid fields.`);
  }
  return {
    from: rec.from,
    to: rec.to,
    relation: rec.relation as ConceptRelation,
    label: rec.label,
    citation: readJsonCitation(rec.citation, `conceptMap.edges[${index}].citation`),
  };
}

function readJsonRejected(value: unknown, index: number): RejectedClaim {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Study pack JSON rejectedClaims[${index}] must be an object.`);
  }
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.answer !== 'string' ||
    !Array.isArray(rec.citations) ||
    !Array.isArray(rec.reasons)
  ) {
    throw new Error(`Study pack JSON rejectedClaims[${index}] has invalid fields.`);
  }
  const out: RejectedClaim = {
    answer: rec.answer,
    citations: rec.citations.map((c, ci) =>
      readJsonCitation(c, `rejectedClaims[${index}].citations[${ci}]`),
    ),
    reasons: rec.reasons.filter((r): r is GroundingFailureReason => typeof r === 'string'),
  };
  if (typeof rec.id === 'string') out.id = rec.id;
  if (typeof rec.prompt === 'string') out.prompt = rec.prompt;
  return out;
}

// --- Language, options, and small utilities --------------------------------

function resolvePackLanguage(
  ir: DocumentIR,
  blocks: readonly OrderedBlock[],
  requested: StudyPackLanguage,
): ResolvedLanguage {
  if (requested === 'en' || requested === 'vi') return requested;
  let viHits = 0;
  let totalBlocks = 0;
  for (const row of blocks) {
    if (row.folded.length === 0) continue;
    totalBlocks += 1;
    if (hasVietnameseText(row.folded) || row.block.language.toLowerCase().startsWith('vi')) {
      viHits += 1;
    }
  }
  if (totalBlocks > 0 && viHits * 2 >= totalBlocks) return 'vi';
  if (typeof ir?.language === 'string' && ir.language.toLowerCase().startsWith('vi')) return 'vi';
  return 'en';
}

function itemLanguage(
  sentence: string,
  blockLang: string,
  docLanguage: ResolvedLanguage,
  requested: StudyPackLanguage,
): ResolvedLanguage {
  if (requested === 'en' || requested === 'vi') return requested;
  if (hasVietnameseText(sentence)) return 'vi';
  const normalizedBlockLang = typeof blockLang === 'string' ? blockLang.toLowerCase() : '';
  if (normalizedBlockLang.startsWith('vi')) return 'vi';
  if (normalizedBlockLang.startsWith('en')) return 'en';
  return docLanguage;
}

function hasVietnameseText(text: string): boolean {
  return VIETNAMESE_DIACRITICS.test(text) || VIETNAMESE_CUES.test(text);
}

function readOptions(options: StudyPackOptions | undefined): ReadOptions {
  const value = typeof options === 'object' && options !== null ? options : {};
  const language: StudyPackLanguage =
    value.language === 'en' || value.language === 'vi' || value.language === 'auto'
      ? value.language
      : 'auto';
  return {
    language,
    maxFlashcards: countOr(value.maxFlashcards, DEFAULT_MAX_FLASHCARDS),
    maxQuestions: countOr(value.maxQuestions, DEFAULT_MAX_QUESTIONS),
    maxConceptNodes: countOr(value.maxConceptNodes, DEFAULT_MAX_CONCEPT_NODES),
    maxExcerptChars: positiveCountOr(value.maxExcerptChars, DEFAULT_MAX_EXCERPT_CHARS),
    includePointCards: value.includePointCards !== false,
    notesOptions: value.notesOptions,
    candidateQuestions: Array.isArray(value.candidateQuestions) ? value.candidateQuestions : [],
  };
}

function computeSummary(
  flashcards: readonly Flashcard[],
  questions: readonly StudyQuestion[],
  conceptMap: ConceptMap,
  rejectedClaims: readonly RejectedClaim[],
): StudyPackSummary {
  return {
    flashcards: flashcards.length,
    questions: questions.length,
    conceptNodes: conceptMap.nodes.length,
    conceptEdges: conceptMap.edges.length,
    rejectedClaims: rejectedClaims.length,
  };
}

function isQuestionKind(value: unknown): value is QuestionKind {
  return typeof value === 'string' && (QUESTION_KINDS as readonly string[]).includes(value);
}

function cloneCitation(citation: SourceCitation): SourceCitation {
  return {
    documentId: citation.documentId,
    page: citation.page,
    blockId: citation.blockId,
    excerpt: citation.excerpt,
  };
}

function fold(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function foldDiacritics(value: string): string {
  return fold(value)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/[đĐ]/gu, 'd')
    .toLowerCase();
}

function foldKey(value: string): string {
  return foldDiacritics(value).replace(/\s+/gu, ' ').trim();
}

function wordCount(value: string): number {
  const text = fold(value);
  return text.length === 0 ? 0 : text.split(' ').length;
}

function countOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const count = Math.floor(value);
  return count < 0 ? fallback : count;
}

function positiveCountOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const count = Math.floor(value);
  return count < 1 ? fallback : count;
}

function blockIdOf(block: Block, position: number): string {
  return typeof block.id === 'string' && block.id.length > 0
    ? block.id
    : `${SYNTHETIC_BLOCK_ID_PREFIX}${position}`;
}

function pageOf(block: Block): number {
  return typeof block.page === 'number' && Number.isInteger(block.page) && block.page > 0
    ? block.page
    : 1;
}

function pageInt(page: unknown): number {
  return typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : 1;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function compareText(left: unknown, right: unknown): number {
  const first = typeof left === 'string' ? left : '';
  const second = typeof right === 'string' ? right : '';
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

function pushUnique<T>(list: T[], item: T): void {
  if (!list.includes(item)) list.push(item);
}

function roundRatio(num: number, den: number): number {
  if (den <= 0) return 0;
  return Math.round((num / den) * 1000) / 1000;
}
