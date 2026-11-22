/**
 * Research library smart collections, tag manager, and confirmed duplicate merge (backlog J10).
 *
 * A research library grows out of PDFs, BibTeX imports, and metadata lookups: papers
 * pile up with slightly different author spellings, overlapping tags, and duplicate
 * preprints vs. published editions. This module owns the pure in-memory store for those
 * records: dynamic smart collections that update automatically as papers change, atomic
 * bulk tag management, duplicate candidate detection, an explicit two-step confirmed
 * merge workflow with conflict reporting, full rollback and audit history, and canonical
 * JSON persistence.
 *
 * Contract:
 * - Pure and deterministic: no DOM, no network, no I/O, no locale collation, and no
 *   clock beyond the injectable `now` callback (defaulting to ISO-8601 UTC strings).
 * - Defensive boundaries: callers always receive cloned records, so mutating a returned
 *   paper, collection, or snapshot never alters stored library state.
 * - Text comparison is Unicode code-unit deterministic. Author and title normalisation
 *   folds diacritics (via NFD) and non-decomposing Latin letters (`đ/Đ`, `ł/Ł`, `ø/Ø`,
 *   `ß`, `æ/Æ`, `œ/Œ`), and handles both `Family, Given` and `Given Family` forms.
 * - Two-step merge safety: {@link ResearchLibrary.planDuplicateMerge} previews the exact
 *   merged paper, diff summary, and field conflicts without mutating state.
 *   {@link ResearchLibrary.applyDuplicateMerge} refuses unless `{ confirmed: true }` is
 *   passed explicitly and verifies that the planned records have not changed since
 *   planning. Merges preserve all tags, topics, note IDs, annotation IDs, citation keys,
 *   and references without data loss, and record the exact pre-merge snapshots so
 *   {@link ResearchLibrary.rollbackMerge} can undo a merge cleanly.
 */

import { arxivId as parseArxivId, normalizeDoi as parseDoi } from './scholar';

// --- Constants & Public Types ----------------------------------------------

/** Schema version written by {@link ResearchLibrary.exportJson} and read on import. */
export const SMART_COLLECTIONS_SCHEMA_VERSION = 1;

/** Document `kind` written in canonical JSON exports. */
export const SMART_COLLECTIONS_EXPORT_KIND = 'mirror.research.library';

/** Reading progress states supported by the research library. */
export const READ_STATUSES = ['unread', 'reading', 'read', 'archived'] as const;

export type ReadStatus = (typeof READ_STATUSES)[number];

/** Why two papers were flagged as duplicate candidates. */
export type DuplicateMatchReason = 'doi' | 'arxiv' | 'title-author';

/** Deterministic sort orders accepted by collection and library queries. */
export const SORT_ORDERS = ['added-asc', 'year-desc', 'year-asc', 'title-asc', 'updated-desc', 'id-asc'] as const;

export type SortOrder = (typeof SORT_ORDERS)[number];

export type SmartCollectionErrorCode =
  | 'invalid-field'
  | 'invalid-query'
  | 'immutable-field'
  | 'duplicate-id'
  | 'unknown-id'
  | 'unknown-collection'
  | 'merge-not-confirmed'
  | 'stale-merge-plan'
  | 'merge-already-applied'
  | 'unknown-merge'
  | 'merge-already-rolled-back'
  | 'rollback-conflict'
  | 'malformed-json'
  | 'malformed-export'
  | 'unsupported-schema-version';

/** Typed refusal from {@link ResearchLibrary} operations. */
export class SmartCollectionError extends Error {
  readonly code: SmartCollectionErrorCode;
  readonly path: string;

  constructor(code: SmartCollectionErrorCode, message: string, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'SmartCollectionError';
    this.code = code;
    this.path = path;
  }
}

/** Parsed and folded representation of one author name. */
export interface NormalizedAuthor {
  /** Input trimmed, braces removed, internal whitespace collapsed. */
  raw: string;
  /** `Given Family` display order when comma-separated, else `raw`. */
  display: string;
  family: string;
  given: string;
  /** Diacritic- and case-folded full key (`given family`). */
  normalized: string;
  /** Diacritic- and case-folded family name key. */
  familyKey: string;
  /** Diacritic- and case-folded given name key. */
  givenKey: string;
}

/** Input accepted by {@link ResearchLibrary.registerPaper}. */
export interface RegisterPaperInput {
  id?: string;
  doi?: string;
  arxivId?: string;
  title: string;
  authors?: readonly string[];
  year?: number;
  venue?: string;
  abstract?: string;
  topics?: readonly string[];
  tags?: readonly string[];
  readStatus?: ReadStatus;
  noteIds?: readonly string[];
  annotationIds?: readonly string[];
  citationKeys?: readonly string[];
  references?: readonly string[];
  citationCount?: number;
}

/** Mutable fields accepted by {@link ResearchLibrary.updatePaper}; `id` and `createdAt` are forbidden. */
export interface UpdatePaperPatch {
  doi?: string | undefined;
  arxivId?: string | undefined;
  title?: string;
  authors?: readonly string[];
  year?: number | undefined;
  venue?: string | undefined;
  abstract?: string | undefined;
  topics?: readonly string[];
  tags?: readonly string[];
  readStatus?: ReadStatus;
  noteIds?: readonly string[];
  annotationIds?: readonly string[];
  citationKeys?: readonly string[];
  references?: readonly string[];
  citationCount?: number | undefined;
}

/** Canonical stored paper record. */
export interface LibraryPaper {
  id: string;
  doi?: string;
  arxivId?: string;
  title: string;
  authors: string[];
  normalizedAuthors: string[];
  year?: number;
  venue?: string;
  abstract?: string;
  topics: string[];
  tags: string[];
  readStatus: ReadStatus;
  noteIds: string[];
  annotationIds: string[];
  citationKeys: string[];
  references: string[];
  citationCount?: number;
  createdAt: string;
  updatedAt: string;
}

/** Dynamic predicate evaluated by smart collections and ad-hoc library queries. */
export interface SmartCollectionQuery {
  topic?: string | readonly string[];
  topicsAll?: readonly string[];
  author?: string | readonly string[];
  authorsAll?: readonly string[];
  yearMin?: number;
  yearMax?: number;
  venue?: string | readonly string[];
  tagsAll?: readonly string[];
  tagsAny?: readonly string[];
  readStatus?: ReadStatus | readonly ReadStatus[];
  text?: string;
  sortBy?: SortOrder;
}

export interface CreateCollectionInput {
  id?: string;
  name: string;
  description?: string;
  query: SmartCollectionQuery;
}

export interface UpdateCollectionPatch {
  name?: string;
  description?: string | undefined;
  query?: SmartCollectionQuery;
}

export interface SmartCollectionDefinition {
  id: string;
  name: string;
  description?: string;
  query: SmartCollectionQuery;
  createdAt: string;
  updatedAt: string;
}

export interface SmartCollectionSnapshot {
  collection: SmartCollectionDefinition;
  papers: LibraryPaper[];
  total: number;
}

/** Live handle returned by {@link ResearchLibrary.watchCollection}. */
export interface SmartCollectionView {
  readonly collectionId: string;
  snapshot(): SmartCollectionSnapshot;
  unsubscribe(): void;
}

export interface BulkTagResult {
  updatedPaperIds: string[];
  unchangedPaperIds: string[];
  tags: string[];
}

export interface RenameTagResult {
  from: string;
  to: string;
  updatedPaperIds: string[];
  deduplicatedPaperIds: string[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface DuplicateCandidate {
  pairId: string;
  survivorId: string;
  duplicateId: string;
  reasons: DuplicateMatchReason[];
  primaryReason: DuplicateMatchReason;
  confidence: number;
  differences: string[];
}

export interface MergeFieldConflict {
  field: 'title' | 'doi' | 'arxivId' | 'year' | 'venue' | 'abstract';
  survivorValue: string | number | undefined;
  duplicateId: string;
  duplicateValue: string | number | undefined;
}

export interface MergePlan {
  planId: string;
  createdAt: string;
  survivorId: string;
  duplicateIds: string[];
  matchReasons: DuplicateMatchReason[];
  preview: LibraryPaper;
  addedTags: string[];
  addedTopics: string[];
  addedNoteIds: string[];
  addedAnnotationIds: string[];
  addedCitationKeys: string[];
  addedReferences: string[];
  filledFields: string[];
  conflicts: MergeFieldConflict[];
  preMergeFingerprints: Record<string, string>;
}

export interface ApplyMergeOptions {
  confirmed: boolean;
  actor?: string;
  reason?: string;
}

export interface MergeAuditEntry {
  mergeId: string;
  planId: string;
  appliedAt: string;
  confirmed: true;
  actor?: string;
  reason?: string;
  matchReasons: DuplicateMatchReason[];
  survivorId: string;
  duplicateIds: string[];
  survivorBefore: LibraryPaper;
  duplicatesBefore: LibraryPaper[];
  survivorAfter: LibraryPaper;
  rolledBackAt?: string;
  rolledBackBy?: string;
  rollbackReason?: string;
}

export interface MergeResult {
  mergeId: string;
  planId: string;
  appliedAt: string;
  survivor: LibraryPaper;
  removedIds: string[];
  auditEntry: MergeAuditEntry;
}

export interface RollbackMergeOptions {
  actor?: string;
  reason?: string;
}

export interface RollbackResult {
  mergeId: string;
  rolledBackAt: string;
  restoredSurvivor: LibraryPaper;
  restoredDuplicates: LibraryPaper[];
  auditEntry: MergeAuditEntry;
}

export type LibraryAuditAction =
  | 'paper-registered'
  | 'paper-updated'
  | 'paper-removed'
  | 'collection-created'
  | 'collection-updated'
  | 'collection-removed'
  | 'tags-added'
  | 'tags-removed'
  | 'tag-renamed'
  | 'merge-applied'
  | 'merge-rolled-back';

export const LIBRARY_AUDIT_ACTIONS: readonly LibraryAuditAction[] = [
  'paper-registered',
  'paper-updated',
  'paper-removed',
  'collection-created',
  'collection-updated',
  'collection-removed',
  'tags-added',
  'tags-removed',
  'tag-renamed',
  'merge-applied',
  'merge-rolled-back',
];

export interface LibraryAuditEvent {
  id: string;
  at: string;
  action: LibraryAuditAction;
  targetIds: string[];
  actor?: string;
  details?: Record<string, unknown>;
}

export interface ImportLibraryOptions {
  mode?: 'merge' | 'replace';
}

export interface ImportLibraryResult {
  papersImported: number;
  collectionsImported: number;
  mergesImported: number;
  totalPapers: number;
  totalCollections: number;
}

export interface ResearchLibraryOptions {
  now?: () => string;
  papers?: readonly RegisterPaperInput[];
  collections?: readonly CreateCollectionInput[];
}

// --- Normalization Helpers -------------------------------------------------

/** Letters that Unicode NFD does not decompose; kept aligned with `bibtex.ts`. */
const FOLD_LETTERS: Record<string, string> = {
  đ: 'd',
  Đ: 'D',
  ø: 'o',
  Ø: 'O',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  ß: 'ss',
  ł: 'l',
  Ł: 'L',
  ð: 'd',
  Ð: 'D',
  þ: 'th',
  Þ: 'TH',
  ı: 'i',
};

const READ_PROGRESS_RANK: Record<ReadStatus, number> = {
  unread: 0,
  reading: 1,
  read: 2,
  archived: 0,
};

const REASON_CONFIDENCE: Record<DuplicateMatchReason, number> = {
  doi: 1.0,
  arxiv: 0.98,
  'title-author': 0.9,
};

const ARXIV_DATACITE_PREFIX = '10.48550/arxiv.';

/** Folds diacritics, special Latin letters, case, and punctuation into space-separated words. */
function foldWords(text: string): string {
  return text
    .replace(/[{}]/gu, '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[đĐøØæÆœŒßłŁðÐþÞı]/gu, letter => FOLD_LETTERS[letter] ?? letter)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tokenizeFolded(text: string): string[] {
  const folded = foldWords(text);
  return folded.length === 0 ? [] : folded.split(' ');
}

function collapseText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function stripBraces(text: string): string {
  return collapseText(text.replace(/[{}]/gu, ''));
}

/**
 * Parses and normalizes one author name across `Family, Given` and `Given Family` formats.
 * Handles diacritics and non-decomposing Latin characters such as Vietnamese `Đ/đ`,
 * Polish `Ł/ł`, Scandinavian `Ø/ø`, and German `ß`.
 */
export function normalizeAuthor(raw: string): NormalizedAuthor {
  const cleaned = stripBraces(typeof raw === 'string' ? raw : '');
  if (cleaned.length === 0) {
    return {
      raw: '',
      display: '',
      family: '',
      given: '',
      normalized: '',
      familyKey: '',
      givenKey: '',
    };
  }

  const comma = cleaned.indexOf(',');
  let family = '';
  let given = '';
  let display = cleaned;

  if (comma >= 0) {
    family = collapseText(cleaned.slice(0, comma));
    given = collapseText(cleaned.slice(comma + 1));
    display = given.length > 0 && family.length > 0 ? `${given} ${family}` : family || given;
  } else {
    const words = cleaned.split(' ').filter(w => w.length > 0);
    if (words.length === 1) {
      family = words[0] ?? '';
      given = '';
    } else {
      family = words[words.length - 1] ?? '';
      given = words.slice(0, -1).join(' ');
    }
    display = cleaned;
  }

  const familyKey = foldWords(family);
  const givenKey = foldWords(given);
  const normalized = [givenKey, familyKey].filter(part => part.length > 0).join(' ');

  return {
    raw: cleaned,
    display,
    family,
    given,
    normalized,
    familyKey,
    givenKey,
  };
}

/** Checks whether two author names refer to the same person across formats, diacritics, and initials. */
export function authorsMatch(leftRaw: string, rightRaw: string): boolean {
  const left = normalizeAuthor(leftRaw);
  const right = normalizeAuthor(rightRaw);
  if (left.normalized.length === 0 || right.normalized.length === 0) return false;
  if (left.normalized === right.normalized) return true;

  const leftAll = tokenizeFolded(left.display);
  const rightAll = tokenizeFolded(right.display);
  if (leftAll.length >= 2 && leftAll.length === rightAll.length) {
    const leftSorted = [...leftAll].sort().join('\u0000');
    const rightSorted = [...rightAll].sort().join('\u0000');
    if (leftSorted === rightSorted) return true;
  }

  if (left.familyKey.length === 0 || left.familyKey !== right.familyKey) return false;
  return givenTokensCompatible(splitSpaces(left.givenKey), splitSpaces(right.givenKey));
}

function givenTokensCompatible(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const minLen = Math.min(left.length, right.length);
  if (minLen >= 2 && left.length !== right.length) return false;

  for (let i = 0; i < minLen; i++) {
    const a = left[i];
    const b = right[i];
    if (a === undefined || b === undefined) return false;
    if (a === b) continue;
    if (a.length === 1 && b.startsWith(a)) continue;
    if (b.length === 1 && a.startsWith(b)) continue;
    return false;
  }
  return true;
}

/** Normalized title key used for duplicate candidate detection. */
export function normalizeTitleKey(title: string): string {
  return typeof title === 'string' ? foldWords(title) : '';
}

function splitSpaces(text: string): string[] {
  return text.length === 0 ? [] : text.split(' ').filter(t => t.length > 0);
}

function normalizeDoiValue(raw: string, path: string): string {
  const cleaned = collapseText(raw);
  const parsed = parseDoi(cleaned);
  if (parsed === null) {
    throw new SmartCollectionError('invalid-field', `invalid DOI "${cleaned}".`, path);
  }
  return parsed.toLowerCase();
}

function normalizeArxivValue(raw: string, path: string): string {
  const cleaned = collapseText(raw).replace(/[Vv](\d+)$/u, 'v$1');
  const parsed = parseArxivId(cleaned);
  if (parsed === null) {
    throw new SmartCollectionError('invalid-field', `invalid arXiv ID "${cleaned}".`, path);
  }
  return parsed;
}

function effectiveArxivKey(paper: LibraryPaper): string | undefined {
  if (paper.arxivId !== undefined) return paper.arxivId.toLowerCase();
  if (paper.doi !== undefined && paper.doi.startsWith(ARXIV_DATACITE_PREFIX)) {
    const suffix = paper.doi.slice(ARXIV_DATACITE_PREFIX.length);
    const parsed = parseArxivId(suffix);
    if (parsed !== null) return parsed.toLowerCase();
  }
  return undefined;
}

function isArxivDataciteDoi(doi: string | undefined): boolean {
  return doi !== undefined && doi.startsWith(ARXIV_DATACITE_PREFIX);
}

// --- Query Evaluation ------------------------------------------------------

/** Validates a smart collection query before storing or executing it. */
function validateQuery(query: unknown, path = 'query'): SmartCollectionQuery {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw new SmartCollectionError('invalid-query', 'query must be an object.', path);
  }
  const source = query as Record<string, unknown>;
  const normalized: SmartCollectionQuery = {};

  if (source.topic !== undefined) {
    const topic = readNonEmptyStringOrList(source.topic, `${path}.topic`);
    if (topic !== undefined) normalized.topic = topic;
  }
  if (source.topicsAll !== undefined) normalized.topicsAll = readStringArray(source.topicsAll, `${path}.topicsAll`);
  if (source.author !== undefined) {
    const author = readNonEmptyStringOrList(source.author, `${path}.author`);
    if (author !== undefined) normalized.author = author;
  }
  if (source.authorsAll !== undefined) normalized.authorsAll = readStringArray(source.authorsAll, `${path}.authorsAll`);
  if (source.venue !== undefined) {
    const venue = readNonEmptyStringOrList(source.venue, `${path}.venue`);
    if (venue !== undefined) normalized.venue = venue;
  }
  if (source.tagsAll !== undefined) normalized.tagsAll = readStringArray(source.tagsAll, `${path}.tagsAll`);
  if (source.tagsAny !== undefined) normalized.tagsAny = readStringArray(source.tagsAny, `${path}.tagsAny`);

  if (source.yearMin !== undefined) {
    normalized.yearMin = readYear(source.yearMin, `${path}.yearMin`, 'invalid-query');
  }
  if (source.yearMax !== undefined) {
    normalized.yearMax = readYear(source.yearMax, `${path}.yearMax`, 'invalid-query');
  }
  if (normalized.yearMin !== undefined && normalized.yearMax !== undefined && normalized.yearMin > normalized.yearMax) {
    throw new SmartCollectionError(
      'invalid-query',
      `yearMin (${normalized.yearMin}) cannot exceed yearMax (${normalized.yearMax}).`,
      `${path}.yearMin`,
    );
  }

  if (source.readStatus !== undefined) {
    if (Array.isArray(source.readStatus)) {
      normalized.readStatus = source.readStatus.map((item, idx) =>
        readReadStatus(item, `${path}.readStatus[${idx}]`, 'invalid-query'),
      );
    } else {
      normalized.readStatus = readReadStatus(source.readStatus, `${path}.readStatus`, 'invalid-query');
    }
  }

  if (source.text !== undefined) {
    if (typeof source.text !== 'string') {
      throw new SmartCollectionError('invalid-query', 'text must be a string.', `${path}.text`);
    }
    const trimmed = collapseText(source.text);
    if (trimmed.length > 0) normalized.text = trimmed;
  }

  if (source.sortBy !== undefined) {
    if (typeof source.sortBy !== 'string' || !(SORT_ORDERS as readonly string[]).includes(source.sortBy)) {
      throw new SmartCollectionError(
        'invalid-query',
        `sortBy must be one of ${SORT_ORDERS.join(' | ')}.`,
        `${path}.sortBy`,
      );
    }
    normalized.sortBy = source.sortBy as SortOrder;
  }

  return normalized;
}

/** Tests whether one paper matches a validated or raw {@link SmartCollectionQuery}. */
export function matchesPaperQuery(paper: LibraryPaper, query: SmartCollectionQuery): boolean {
  const checked = validateQuery(query);

  if (checked.yearMin !== undefined || checked.yearMax !== undefined) {
    if (paper.year === undefined) return false;
    if (checked.yearMin !== undefined && paper.year < checked.yearMin) return false;
    if (checked.yearMax !== undefined && paper.year > checked.yearMax) return false;
  }

  if (checked.readStatus !== undefined) {
    const allowed = Array.isArray(checked.readStatus) ? checked.readStatus : [checked.readStatus];
    if (!allowed.includes(paper.readStatus)) return false;
  }

  if (checked.topic !== undefined) {
    const candidates = toQueryList(checked.topic);
    if (candidates.length === 0) return false;
    const paperTopics = new Set(paper.topics.map(foldWords));
    if (!candidates.some(t => paperTopics.has(foldWords(t)))) return false;
  }

  if (checked.topicsAll !== undefined && checked.topicsAll.length > 0) {
    const paperTopics = new Set(paper.topics.map(foldWords));
    if (!checked.topicsAll.every(t => paperTopics.has(foldWords(t)))) return false;
  }

  if (checked.tagsAll !== undefined && checked.tagsAll.length > 0) {
    const paperTags = new Set(paper.tags.map(t => collapseText(t).toLowerCase()));
    if (!checked.tagsAll.every(t => paperTags.has(collapseText(t).toLowerCase()))) return false;
  }

  if (checked.tagsAny !== undefined) {
    if (checked.tagsAny.length === 0) return false;
    const paperTags = new Set(paper.tags.map(t => collapseText(t).toLowerCase()));
    if (!checked.tagsAny.some(t => paperTags.has(collapseText(t).toLowerCase()))) return false;
  }

  if (checked.venue !== undefined) {
    const venueQueries = toQueryList(checked.venue);
    if (venueQueries.length === 0) return false;
    if (paper.venue === undefined) return false;
    const paperVenue = foldWords(paper.venue);
    if (!venueQueries.some(v => paperVenue.includes(foldWords(v)))) return false;
  }

  if (checked.author !== undefined) {
    const authorQueries = toQueryList(checked.author);
    if (authorQueries.length === 0) return false;
    if (!authorQueries.some(q => paper.authors.some(a => authorMatchesQuery(a, q)))) return false;
  }

  if (checked.authorsAll !== undefined && checked.authorsAll.length > 0) {
    if (!checked.authorsAll.every(q => paper.authors.some(a => authorMatchesQuery(a, q)))) return false;
  }

  if (checked.text !== undefined) {
    const terms = tokenizeFolded(checked.text);
    if (terms.length > 0) {
      const haystack = paperSearchHaystack(paper);
      if (!terms.every(term => haystack.includes(term))) return false;
    }
  }

  return true;
}

function authorMatchesQuery(authorRaw: string, queryRaw: string): boolean {
  const queryTokens = tokenizeFolded(queryRaw);
  if (queryTokens.length === 0) return false;

  const parsedAuthor = normalizeAuthor(authorRaw);
  const authorTokens = tokenizeFolded(parsedAuthor.display);
  const rawTokens = tokenizeFolded(parsedAuthor.raw);
  const tokenPool = new Set([...authorTokens, ...rawTokens]);

  if (queryTokens.length === 1) {
    const single = queryTokens[0];
    return single !== undefined && tokenPool.has(single);
  }

  if (authorsMatch(authorRaw, queryRaw)) return true;
  return queryTokens.every(token => tokenPool.has(token));
}

function paperSearchHaystack(paper: LibraryPaper): string {
  const segments = [
    paper.title,
    ...paper.authors,
    ...paper.normalizedAuthors,
    paper.venue ?? '',
    paper.abstract ?? '',
    paper.doi ?? '',
    paper.arxivId ?? '',
    ...paper.topics,
    ...paper.tags,
    ...paper.citationKeys,
  ];
  return foldWords(segments.join(' '));
}

/** Filters and sorts papers deterministically according to `query`. */
export function filterPapers(papers: readonly LibraryPaper[], query: SmartCollectionQuery): LibraryPaper[] {
  const checked = validateQuery(query);
  const matching = papers.filter(paper => matchesPaperQuery(paper, checked)).map(clonePaper);
  return sortPapers(matching, checked.sortBy ?? 'added-asc');
}

function sortPapers(papers: LibraryPaper[], sortBy: SortOrder): LibraryPaper[] {
  if (sortBy === 'added-asc') return papers;
  return [...papers].sort((left, right) => {
    switch (sortBy) {
      case 'year-desc': {
        const ly = left.year ?? Number.NEGATIVE_INFINITY;
        const ry = right.year ?? Number.NEGATIVE_INFINITY;
        return ry - ly || compareText(left.title, right.title) || compareText(left.id, right.id);
      }
      case 'year-asc': {
        const ly = left.year ?? Number.POSITIVE_INFINITY;
        const ry = right.year ?? Number.POSITIVE_INFINITY;
        return ly - ry || compareText(left.title, right.title) || compareText(left.id, right.id);
      }
      case 'title-asc':
        return compareText(left.title.toLowerCase(), right.title.toLowerCase()) || compareText(left.id, right.id);
      case 'updated-desc':
        return compareText(right.updatedAt, left.updatedAt) || compareText(left.id, right.id);
      case 'id-asc':
      default:
        return compareText(left.id, right.id);
    }
  });
}

// --- Duplicate Detection ---------------------------------------------------

/** Scans `papers` for candidate duplicate pairs across DOI, arXiv ID, and normalized title + first author. */
export function detectDuplicateCandidates(papers: readonly LibraryPaper[]): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];

  for (let i = 0; i < papers.length; i++) {
    const left = papers[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < papers.length; j++) {
      const right = papers[j];
      if (right === undefined) continue;
      const candidate = evaluateDuplicatePair(left, right);
      if (candidate !== null) candidates.push(candidate);
    }
  }

  return candidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      compareText(a.survivorId, b.survivorId) ||
      compareText(a.duplicateId, b.duplicateId),
  );
}

function evaluateDuplicatePair(left: LibraryPaper, right: LibraryPaper): DuplicateCandidate | null {
  const reasons: DuplicateMatchReason[] = [];

  if (left.doi !== undefined && right.doi !== undefined && left.doi.toLowerCase() === right.doi.toLowerCase()) {
    reasons.push('doi');
  }

  const leftArxiv = effectiveArxivKey(left);
  const rightArxiv = effectiveArxivKey(right);
  if (leftArxiv !== undefined && rightArxiv !== undefined && leftArxiv === rightArxiv) {
    reasons.push('arxiv');
  }

  const leftTitle = normalizeTitleKey(left.title);
  const rightTitle = normalizeTitleKey(right.title);
  const leftFirstAuthor = left.authors[0];
  const rightFirstAuthor = right.authors[0];

  const nonArxivDoiConflict =
    left.doi !== undefined &&
    right.doi !== undefined &&
    left.doi.toLowerCase() !== right.doi.toLowerCase() &&
    !isArxivDataciteDoi(left.doi) &&
    !isArxivDataciteDoi(right.doi);

  const arxivConflict = leftArxiv !== undefined && rightArxiv !== undefined && leftArxiv !== rightArxiv;

  if (
    !nonArxivDoiConflict &&
    !arxivConflict &&
    leftTitle.length > 0 &&
    leftTitle === rightTitle &&
    leftFirstAuthor !== undefined &&
    rightFirstAuthor !== undefined &&
    authorsMatch(leftFirstAuthor, rightFirstAuthor)
  ) {
    reasons.push('title-author');
  }

  if (reasons.length === 0) return null;

  const primaryReason = reasons[0] ?? 'title-author';
  const [survivor, duplicate] = pickSuggestedOrder(left, right);
  const pairId = [left.id, right.id].sort(compareText).join('::');

  return {
    pairId,
    survivorId: survivor.id,
    duplicateId: duplicate.id,
    reasons,
    primaryReason,
    confidence: REASON_CONFIDENCE[primaryReason],
    differences: collectPairDifferences(survivor, duplicate),
  };
}

function pickSuggestedOrder(left: LibraryPaper, right: LibraryPaper): [LibraryPaper, LibraryPaper] {
  const scoreDiff = completenessScore(right) - completenessScore(left);
  if (scoreDiff > 0) return [right, left];
  if (scoreDiff < 0) return [left, right];
  return [left, right];
}

function completenessScore(paper: LibraryPaper): number {
  let score = 0;
  if (paper.doi !== undefined) score += 4;
  if (paper.arxivId !== undefined) score += 3;
  if (paper.year !== undefined) score += 2;
  if (paper.venue !== undefined) score += 2;
  if (paper.abstract !== undefined) score += 2;
  score += Math.min(paper.authors.length, 3);
  score += paper.noteIds.length + paper.annotationIds.length + paper.citationKeys.length + paper.tags.length;
  score += READ_PROGRESS_RANK[paper.readStatus];
  return score;
}

function collectPairDifferences(left: LibraryPaper, right: LibraryPaper): string[] {
  const diffs: string[] = [];
  if (left.title !== right.title) diffs.push('title');
  if (left.doi !== right.doi) diffs.push('doi');
  if (left.arxivId !== right.arxivId) diffs.push('arxivId');
  if (left.year !== right.year) diffs.push('year');
  if (left.venue !== right.venue) diffs.push('venue');
  if (left.readStatus !== right.readStatus) diffs.push('readStatus');
  return diffs;
}

// --- ResearchLibrary Store -------------------------------------------------

interface ViewSubscription {
  collectionId: string;
  listener: ((snapshot: SmartCollectionSnapshot) => void) | undefined;
  lastDigest: string;
}

/**
 * In-memory research library managing papers, auto-updating smart collections,
 * bulk tag operations, confirmed duplicate merges with rollback, and JSON persistence.
 */
export class ResearchLibrary {
  private readonly papers: LibraryPaper[] = [];
  private readonly paperById = new Map<string, LibraryPaper>();
  private readonly collections: SmartCollectionDefinition[] = [];
  private readonly collectionById = new Map<string, SmartCollectionDefinition>();
  private readonly mergeHistory: MergeAuditEntry[] = [];
  private readonly mergeById = new Map<string, MergeAuditEntry>();
  private readonly appliedPlanIds = new Set<string>();
  private readonly auditLog: LibraryAuditEvent[] = [];
  private readonly subscriptions = new Set<ViewSubscription>();
  private readonly clock: () => string;

  private paperSeq = 0;
  private collectionSeq = 0;
  private planSeq = 0;
  private mergeSeq = 0;
  private eventSeq = 0;

  constructor(options: ResearchLibraryOptions = {}) {
    const settings: ResearchLibraryOptions = typeof options === 'object' && options !== null ? options : {};
    this.clock = typeof settings.now === 'function' ? settings.now : SYSTEM_CLOCK;

    for (const paper of Array.isArray(settings.papers) ? settings.papers : []) {
      this.registerPaper(paper);
    }
    for (const collection of Array.isArray(settings.collections) ? settings.collections : []) {
      this.createCollection(collection);
    }
  }

  // --- Paper Lifecycle ---

  /** Registers one paper in the library, normalizing identifiers, authors, topics, and tags. */
  registerPaper(input: RegisterPaperInput): LibraryPaper {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new SmartCollectionError('invalid-field', 'registerPaper needs a paper object.', 'paper');
    }

    const id = input.id === undefined ? this.nextPaperId() : requireText(input.id, 'id');
    if (this.paperById.has(id)) {
      throw new SmartCollectionError('duplicate-id', `paper "${id}" is already registered.`, 'id');
    }

    const title = collapseText(requireText(input.title, 'title'));
    const authors = cleanAuthorList(input.authors, 'authors');
    const normalizedAuthors = authors.map(a => normalizeAuthor(a).normalized);

    const doiRaw = optionalBlankableText(input.doi, 'doi');
    const doi = doiRaw === undefined ? undefined : normalizeDoiValue(doiRaw, 'doi');

    const arxivRaw = optionalBlankableText(input.arxivId, 'arxivId');
    const arxivId = arxivRaw === undefined ? undefined : normalizeArxivValue(arxivRaw, 'arxivId');

    const year = input.year === undefined ? undefined : readYear(input.year, 'year', 'invalid-field');
    const venue = optionalBlankableText(input.venue, 'venue');
    const abstract = optionalBlankableText(input.abstract, 'abstract');
    const topics = cleanCaseUniqueList(input.topics, 'topics');
    const tags = cleanCaseUniqueList(input.tags, 'tags');
    const readStatus =
      input.readStatus === undefined ? 'unread' : readReadStatus(input.readStatus, 'readStatus', 'invalid-field');
    const noteIds = cleanExactUniqueList(input.noteIds, 'noteIds');
    const annotationIds = cleanExactUniqueList(input.annotationIds, 'annotationIds');
    const citationKeys = cleanExactUniqueList(input.citationKeys, 'citationKeys');
    const references = cleanExactUniqueList(input.references, 'references');
    const citationCount =
      input.citationCount === undefined ? undefined : readCount(input.citationCount, 'citationCount');

    const stamp = this.stamp();
    const record: LibraryPaper = {
      id,
      title,
      authors,
      normalizedAuthors,
      topics,
      tags,
      readStatus,
      noteIds,
      annotationIds,
      citationKeys,
      references,
      createdAt: stamp,
      updatedAt: stamp,
    };
    if (doi !== undefined) record.doi = doi;
    if (arxivId !== undefined) record.arxivId = arxivId;
    if (year !== undefined) record.year = year;
    if (venue !== undefined) record.venue = venue;
    if (abstract !== undefined) record.abstract = abstract;
    if (citationCount !== undefined) record.citationCount = citationCount;

    this.papers.push(record);
    this.paperById.set(id, record);
    this.recordAudit('paper-registered', [id], undefined, { title: record.title });
    this.notifyCollections();
    return clonePaper(record);
  }

  /** Returns one paper by id, or `undefined` if absent. */
  getPaper(id: string): LibraryPaper | undefined {
    if (typeof id !== 'string') return undefined;
    const found = this.paperById.get(id.trim());
    return found === undefined ? undefined : clonePaper(found);
  }

  /** Returns all papers in the requested order (defaulting to insertion order). */
  listPapers(sortBy: SortOrder = 'added-asc'): LibraryPaper[] {
    if (!(SORT_ORDERS as readonly string[]).includes(sortBy)) {
      throw new SmartCollectionError('invalid-field', `sortBy must be one of ${SORT_ORDERS.join(' | ')}.`, 'sortBy');
    }
    return sortPapers(this.papers.map(clonePaper), sortBy);
  }

  /** Updates mutable fields of an existing paper, rejecting `id` and `createdAt` patches. */
  updatePaper(id: string, patch: UpdatePaperPatch): LibraryPaper {
    const key = requireText(id, 'id');
    const current = this.paperById.get(key);
    if (current === undefined) {
      throw new SmartCollectionError('unknown-id', `paper "${key}" is not in the library.`, 'id');
    }

    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new SmartCollectionError('invalid-field', 'updatePaper needs a patch object.', 'patch');
    }
    const source = patch as Record<string, unknown>;
    for (const immutable of ['id', 'createdAt'] as const) {
      if (hasOwn(source, immutable)) {
        throw new SmartCollectionError('immutable-field', `${immutable} cannot be modified.`, immutable);
      }
    }

    const next = clonePaper(current);
    if (hasOwn(source, 'title')) next.title = collapseText(requireText(source.title, 'title'));
    if (hasOwn(source, 'authors')) {
      next.authors = cleanAuthorList(source.authors as readonly string[] | undefined, 'authors');
      next.normalizedAuthors = next.authors.map(a => normalizeAuthor(a).normalized);
    }
    if (hasOwn(source, 'doi')) {
      const doiRaw = optionalBlankableText(source.doi, 'doi');
      if (doiRaw === undefined) delete next.doi;
      else next.doi = normalizeDoiValue(doiRaw, 'doi');
    }
    if (hasOwn(source, 'arxivId')) {
      const arxivRaw = optionalBlankableText(source.arxivId, 'arxivId');
      if (arxivRaw === undefined) delete next.arxivId;
      else next.arxivId = normalizeArxivValue(arxivRaw, 'arxivId');
    }
    if (hasOwn(source, 'year')) {
      if (source.year === undefined || source.year === null) delete next.year;
      else next.year = readYear(source.year, 'year', 'invalid-field');
    }
    if (hasOwn(source, 'venue')) {
      const venue = optionalBlankableText(source.venue, 'venue');
      if (venue === undefined) delete next.venue;
      else next.venue = venue;
    }
    if (hasOwn(source, 'abstract')) {
      const abstract = optionalBlankableText(source.abstract, 'abstract');
      if (abstract === undefined) delete next.abstract;
      else next.abstract = abstract;
    }
    if (hasOwn(source, 'topics')) next.topics = cleanCaseUniqueList(source.topics as readonly string[] | undefined, 'topics');
    if (hasOwn(source, 'tags')) next.tags = cleanCaseUniqueList(source.tags as readonly string[] | undefined, 'tags');
    if (hasOwn(source, 'readStatus')) next.readStatus = readReadStatus(source.readStatus, 'readStatus', 'invalid-field');
    if (hasOwn(source, 'noteIds')) next.noteIds = cleanExactUniqueList(source.noteIds as readonly string[] | undefined, 'noteIds');
    if (hasOwn(source, 'annotationIds')) {
      next.annotationIds = cleanExactUniqueList(source.annotationIds as readonly string[] | undefined, 'annotationIds');
    }
    if (hasOwn(source, 'citationKeys')) {
      next.citationKeys = cleanExactUniqueList(source.citationKeys as readonly string[] | undefined, 'citationKeys');
    }
    if (hasOwn(source, 'references')) {
      next.references = cleanExactUniqueList(source.references as readonly string[] | undefined, 'references');
    }
    if (hasOwn(source, 'citationCount')) {
      if (source.citationCount === undefined || source.citationCount === null) delete next.citationCount;
      else next.citationCount = readCount(source.citationCount, 'citationCount');
    }

    next.updatedAt = this.stamp();
    this.replacePaperRecord(current, next);
    this.recordAudit('paper-updated', [next.id]);
    this.notifyCollections();
    return clonePaper(next);
  }

  /** Removes a paper by id; returns `false` if it was not present. */
  removePaper(id: string): boolean {
    const key = requireText(id, 'id');
    const current = this.paperById.get(key);
    if (current === undefined) return false;

    this.paperById.delete(key);
    const index = this.papers.indexOf(current);
    if (index >= 0) this.papers.splice(index, 1);
    this.recordAudit('paper-removed', [key]);
    this.notifyCollections();
    return true;
  }

  // --- Smart Collections & Auto-Updating Views ---

  /** Runs an ad-hoc smart collection query against all current papers. */
  query(query: SmartCollectionQuery): LibraryPaper[] {
    return filterPapers(this.papers, query);
  }

  /** Registers a persistent dynamic smart collection backed by a query predicate. */
  createCollection(input: CreateCollectionInput): SmartCollectionDefinition {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new SmartCollectionError('invalid-field', 'createCollection needs a collection object.', 'collection');
    }

    const id = input.id === undefined ? this.nextCollectionId() : requireText(input.id, 'id');
    if (this.collectionById.has(id)) {
      throw new SmartCollectionError('duplicate-id', `collection "${id}" already exists.`, 'id');
    }

    const name = collapseText(requireText(input.name, 'name'));
    const description = optionalBlankableText(input.description, 'description');
    const query = validateQuery(input.query, 'query');
    const stamp = this.stamp();

    const collection: SmartCollectionDefinition = {
      id,
      name,
      query,
      createdAt: stamp,
      updatedAt: stamp,
    };
    if (description !== undefined) collection.description = description;

    this.collections.push(collection);
    this.collectionById.set(id, collection);
    this.recordAudit('collection-created', [id], undefined, { name });
    return cloneCollection(collection);
  }

  /** Returns one smart collection definition by id, or `undefined`. */
  getCollection(id: string): SmartCollectionDefinition | undefined {
    if (typeof id !== 'string') return undefined;
    const found = this.collectionById.get(id.trim());
    return found === undefined ? undefined : cloneCollection(found);
  }

  /** Lists all saved smart collection definitions in insertion order. */
  listCollections(): SmartCollectionDefinition[] {
    return this.collections.map(cloneCollection);
  }

  /** Updates a smart collection's name, description, or query and notifies watchers. */
  updateCollection(id: string, patch: UpdateCollectionPatch): SmartCollectionDefinition {
    const key = requireText(id, 'id');
    const current = this.collectionById.get(key);
    if (current === undefined) {
      throw new SmartCollectionError('unknown-collection', `collection "${key}" does not exist.`, 'id');
    }
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new SmartCollectionError('invalid-field', 'updateCollection needs a patch object.', 'patch');
    }
    const source = patch as Record<string, unknown>;
    if (hasOwn(source, 'id') || hasOwn(source, 'createdAt')) {
      throw new SmartCollectionError('immutable-field', 'id and createdAt are immutable.', 'id');
    }

    const next = cloneCollection(current);
    if (hasOwn(source, 'name')) next.name = collapseText(requireText(source.name, 'name'));
    if (hasOwn(source, 'description')) {
      const desc = optionalBlankableText(source.description, 'description');
      if (desc === undefined) delete next.description;
      else next.description = desc;
    }
    if (hasOwn(source, 'query')) next.query = validateQuery(source.query, 'query');
    next.updatedAt = this.stamp();

    const index = this.collections.indexOf(current);
    if (index >= 0) this.collections[index] = next;
    else this.collections.push(next);
    this.collectionById.set(key, next);
    this.recordAudit('collection-updated', [key]);
    this.notifyCollections(key);
    return cloneCollection(next);
  }

  /** Removes a smart collection and detaches any active watchers on it. */
  removeCollection(id: string): boolean {
    const key = requireText(id, 'id');
    const current = this.collectionById.get(key);
    if (current === undefined) return false;

    this.collectionById.delete(key);
    const index = this.collections.indexOf(current);
    if (index >= 0) this.collections.splice(index, 1);

    for (const sub of this.subscriptions) {
      if (sub.collectionId === key) this.subscriptions.delete(sub);
    }
    this.recordAudit('collection-removed', [key]);
    return true;
  }

  /** Dynamically evaluates a smart collection against current library state. */
  evaluateCollection(id: string): SmartCollectionSnapshot {
    const key = requireText(id, 'id');
    const collection = this.collectionById.get(key);
    if (collection === undefined) {
      throw new SmartCollectionError('unknown-collection', `collection "${key}" does not exist.`, 'id');
    }
    const papers = filterPapers(this.papers, collection.query);
    return {
      collection: cloneCollection(collection),
      papers,
      total: papers.length,
    };
  }

  /**
   * Creates a live auto-updating view for `collectionId`.
   * The optional `listener` runs whenever matching papers or collection definitions change.
   */
  watchCollection(
    collectionId: string,
    listener?: (snapshot: SmartCollectionSnapshot) => void,
  ): SmartCollectionView {
    const key = requireText(collectionId, 'id');
    const initial = this.evaluateCollection(key);
    const subscription: ViewSubscription = {
      collectionId: key,
      listener,
      lastDigest: snapshotDigest(initial),
    };
    this.subscriptions.add(subscription);

    return {
      collectionId: key,
      snapshot: () => this.evaluateCollection(key),
      unsubscribe: () => {
        this.subscriptions.delete(subscription);
      },
    };
  }

  // --- Bulk Tag Management ---

  /**
   * Atomically adds `tags` to every paper in `paperIds`, skipping case-insensitive duplicates.
   * Validates all paper ids and tags before modifying any record.
   */
  bulkAddTags(paperIds: readonly string[], tags: readonly string[]): BulkTagResult {
    const targets = resolveTargetPapers(paperIds, this.paperById, 'paperIds');
    const incoming = cleanCaseUniqueList(tags, 'tags');
    if (incoming.length === 0) {
      throw new SmartCollectionError('invalid-field', 'bulkAddTags needs at least one tag.', 'tags');
    }

    const updatedPaperIds: string[] = [];
    const unchangedPaperIds: string[] = [];
    const stamp = this.stamp();

    for (const current of targets) {
      const existingKeys = new Set(current.tags.map(t => t.toLowerCase()));
      const additions = incoming.filter(tag => !existingKeys.has(tag.toLowerCase()));
      if (additions.length === 0) {
        unchangedPaperIds.push(current.id);
        continue;
      }
      const next = clonePaper(current);
      next.tags = [...current.tags, ...additions];
      next.updatedAt = stamp;
      this.replacePaperRecord(current, next);
      updatedPaperIds.push(current.id);
    }

    if (updatedPaperIds.length > 0) {
      this.recordAudit('tags-added', updatedPaperIds, undefined, { tags: incoming });
      this.notifyCollections();
    }

    return { updatedPaperIds, unchangedPaperIds, tags: incoming };
  }

  /**
   * Atomically removes `tags` (matched case-insensitively) from every paper in `paperIds`.
   */
  bulkRemoveTags(paperIds: readonly string[], tags: readonly string[]): BulkTagResult {
    const targets = resolveTargetPapers(paperIds, this.paperById, 'paperIds');
    const outgoing = cleanCaseUniqueList(tags, 'tags');
    if (outgoing.length === 0) {
      throw new SmartCollectionError('invalid-field', 'bulkRemoveTags needs at least one tag.', 'tags');
    }

    const removeKeys = new Set(outgoing.map(t => t.toLowerCase()));
    const updatedPaperIds: string[] = [];
    const unchangedPaperIds: string[] = [];
    const stamp = this.stamp();

    for (const current of targets) {
      const kept = current.tags.filter(tag => !removeKeys.has(tag.toLowerCase()));
      if (kept.length === current.tags.length) {
        unchangedPaperIds.push(current.id);
        continue;
      }
      const next = clonePaper(current);
      next.tags = kept;
      next.updatedAt = stamp;
      this.replacePaperRecord(current, next);
      updatedPaperIds.push(current.id);
    }

    if (updatedPaperIds.length > 0) {
      this.recordAudit('tags-removed', updatedPaperIds, undefined, { tags: outgoing });
      this.notifyCollections();
    }

    return { updatedPaperIds, unchangedPaperIds, tags: outgoing };
  }

  /**
   * Renames `fromTag` to `toTag` across the library (or scoped `options.paperIds`),
   * deduplicating cleanly if a paper already carries `toTag`.
   */
  renameTag(fromTag: string, toTag: string, options: { paperIds?: readonly string[] } = {}): RenameTagResult {
    const from = collapseText(requireText(fromTag, 'fromTag'));
    const to = collapseText(requireText(toTag, 'toTag'));
    const fromKey = from.toLowerCase();
    const toKey = to.toLowerCase();

    const targets =
      options?.paperIds !== undefined
        ? resolveTargetPapers(options.paperIds, this.paperById, 'paperIds')
        : [...this.papers];

    const updatedPaperIds: string[] = [];
    const deduplicatedPaperIds: string[] = [];
    const stamp = this.stamp();

    for (const current of targets) {
      const hasFrom = current.tags.some(t => t.toLowerCase() === fromKey);
      if (!hasFrom) continue;

      const hadTo = fromKey !== toKey && current.tags.some(t => t.toLowerCase() === toKey);
      const nextTags: string[] = [];
      const seen = new Set<string>();
      for (const tag of current.tags) {
        const mapped = tag.toLowerCase() === fromKey ? to : tag;
        const mappedKey = mapped.toLowerCase();
        if (seen.has(mappedKey)) continue;
        seen.add(mappedKey);
        nextTags.push(mapped);
      }

      if (sameStringList(current.tags, nextTags)) continue;

      const next = clonePaper(current);
      next.tags = nextTags;
      next.updatedAt = stamp;
      this.replacePaperRecord(current, next);
      updatedPaperIds.push(current.id);
      if (hadTo) deduplicatedPaperIds.push(current.id);
    }

    if (updatedPaperIds.length > 0) {
      this.recordAudit('tag-renamed', updatedPaperIds, undefined, { from, to });
      this.notifyCollections();
    }

    return { from, to, updatedPaperIds, deduplicatedPaperIds };
  }

  /** Lists all tags present in the library with occurrence counts, sorted deterministically. */
  listTags(): TagCount[] {
    const byKey = new Map<string, { tag: string; count: number }>();
    for (const paper of this.papers) {
      for (const tag of paper.tags) {
        const key = tag.toLowerCase();
        const entry = byKey.get(key);
        if (entry === undefined) byKey.set(key, { tag, count: 1 });
        else entry.count += 1;
      }
    }
    return [...byKey.values()].sort((a, b) => compareText(a.tag.toLowerCase(), b.tag.toLowerCase()));
  }

  // --- Duplicate Detection, Confirmed Merge, Audit & Rollback ---

  /** Finds all candidate duplicate paper pairs in the library. */
  findDuplicateCandidates(): DuplicateCandidate[] {
    return detectDuplicateCandidates(this.papers);
  }

  /** Finds candidate duplicates involving `paperId`. */
  findDuplicatesFor(paperId: string): DuplicateCandidate[] {
    const key = requireText(paperId, 'paperId');
    if (!this.paperById.has(key)) {
      throw new SmartCollectionError('unknown-id', `paper "${key}" is not in the library.`, 'paperId');
    }
    return this.findDuplicateCandidates().filter(c => c.survivorId === key || c.duplicateId === key);
  }

  /**
   * Step 1 of duplicate merge: computes a non-mutating merge plan showing the preview
   * paper, added tags/notes/annotations/citations, filled scalar fields, and conflicts.
   */
  planDuplicateMerge(survivorId: string, duplicateIds: string | readonly string[]): MergePlan {
    const survivorKey = requireText(survivorId, 'survivorId');
    const survivor = this.paperById.get(survivorKey);
    if (survivor === undefined) {
      throw new SmartCollectionError('unknown-id', `survivor paper "${survivorKey}" is not in the library.`, 'survivorId');
    }

    const rawDuplicates = typeof duplicateIds === 'string' ? [duplicateIds] : duplicateIds;
    if (!Array.isArray(rawDuplicates) || rawDuplicates.length === 0) {
      throw new SmartCollectionError('invalid-field', 'planDuplicateMerge needs at least one duplicate id.', 'duplicateIds');
    }

    const dupKeys: string[] = [];
    const duplicates: LibraryPaper[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < rawDuplicates.length; i++) {
      const dupKey = requireText(rawDuplicates[i], `duplicateIds[${i}]`);
      if (dupKey === survivorKey) {
        throw new SmartCollectionError('invalid-field', `cannot merge paper "${survivorKey}" into itself.`, `duplicateIds[${i}]`);
      }
      const dupPaper = this.paperById.get(dupKey);
      if (dupPaper === undefined) {
        throw new SmartCollectionError('unknown-id', `duplicate paper "${dupKey}" is not in the library.`, `duplicateIds[${i}]`);
      }
      if (!seen.has(dupKey)) {
        seen.add(dupKey);
        dupKeys.push(dupKey);
        duplicates.push(dupPaper);
      }
    }

    const stamp = this.stamp();
    const planId = this.nextPlanId();
    const built = buildMergedPreview(survivor, duplicates, stamp);

    const matchReasons = new Set<DuplicateMatchReason>();
    for (const dup of duplicates) {
      const candidate = evaluateDuplicatePair(survivor, dup);
      if (candidate !== null) {
        for (const reason of candidate.reasons) matchReasons.add(reason);
      }
    }

    const preMergeFingerprints: Record<string, string> = {
      [survivor.id]: paperFingerprint(survivor),
    };
    for (const dup of duplicates) {
      preMergeFingerprints[dup.id] = paperFingerprint(dup);
    }

    return {
      planId,
      createdAt: stamp,
      survivorId: survivor.id,
      duplicateIds: dupKeys,
      matchReasons: [...matchReasons],
      preview: built.preview,
      addedTags: built.addedTags,
      addedTopics: built.addedTopics,
      addedNoteIds: built.addedNoteIds,
      addedAnnotationIds: built.addedAnnotationIds,
      addedCitationKeys: built.addedCitationKeys,
      addedReferences: built.addedReferences,
      filledFields: built.filledFields,
      conflicts: built.conflicts,
      preMergeFingerprints,
    };
  }

  /**
   * Step 2 of duplicate merge: applies `plan` ONLY when `{ confirmed: true }` is passed.
   * Refuses unconfirmed calls, already-applied plans, and stale plans whose records changed.
   */
  applyDuplicateMerge(plan: MergePlan, options: ApplyMergeOptions): MergeResult {
    if (options?.confirmed !== true) {
      throw new SmartCollectionError(
        'merge-not-confirmed',
        'Duplicate merge requires explicit confirmation ({ confirmed: true }).',
        'confirmed',
      );
    }

    if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
      throw new SmartCollectionError('invalid-field', 'applyDuplicateMerge needs a MergePlan.', 'plan');
    }
    const planId = requireText(plan.planId, 'plan.planId');
    if (this.appliedPlanIds.has(planId)) {
      throw new SmartCollectionError('merge-already-applied', `merge plan "${planId}" was already applied.`, 'plan.planId');
    }

    const survivorKey = requireText(plan.survivorId, 'plan.survivorId');
    const survivor = this.paperById.get(survivorKey);
    if (survivor === undefined) {
      throw new SmartCollectionError('unknown-id', `survivor paper "${survivorKey}" is no longer in the library.`, 'plan.survivorId');
    }

    if (!Array.isArray(plan.duplicateIds) || plan.duplicateIds.length === 0) {
      throw new SmartCollectionError('invalid-field', 'plan.duplicateIds must be a non-empty array.', 'plan.duplicateIds');
    }

    const duplicates: LibraryPaper[] = [];
    for (let i = 0; i < plan.duplicateIds.length; i++) {
      const dupKey = requireText(plan.duplicateIds[i], `plan.duplicateIds[${i}]`);
      const dup = this.paperById.get(dupKey);
      if (dup === undefined) {
        throw new SmartCollectionError('unknown-id', `duplicate paper "${dupKey}" is no longer in the library.`, `plan.duplicateIds[${i}]`);
      }
      duplicates.push(dup);
    }

    const expectedSurvivorFp = plan.preMergeFingerprints?.[survivor.id];
    if (expectedSurvivorFp !== paperFingerprint(survivor)) {
      throw new SmartCollectionError(
        'stale-merge-plan',
        `survivor paper "${survivor.id}" changed after merge plan "${planId}" was created.`,
        'plan.survivorId',
      );
    }
    for (const dup of duplicates) {
      if (plan.preMergeFingerprints?.[dup.id] !== paperFingerprint(dup)) {
        throw new SmartCollectionError(
          'stale-merge-plan',
          `duplicate paper "${dup.id}" changed after merge plan "${planId}" was created.`,
          'plan.duplicateIds',
        );
      }
    }

    const actor = optionalBlankableText(options.actor, 'actor');
    const reason = optionalBlankableText(options.reason, 'reason');
    const appliedAt = this.stamp();
    const mergeId = this.nextMergeId();

    const survivorBefore = clonePaper(survivor);
    const duplicatesBefore = duplicates.map(clonePaper);
    const { preview } = buildMergedPreview(survivor, duplicates, appliedAt);

    this.replacePaperRecord(survivor, preview);
    for (const dup of duplicates) {
      this.paperById.delete(dup.id);
      const index = this.papers.indexOf(dup);
      if (index >= 0) this.papers.splice(index, 1);
    }

    const auditEntry: MergeAuditEntry = {
      mergeId,
      planId,
      appliedAt,
      confirmed: true,
      matchReasons: [...plan.matchReasons],
      survivorId: survivor.id,
      duplicateIds: duplicates.map(d => d.id),
      survivorBefore,
      duplicatesBefore,
      survivorAfter: clonePaper(preview),
    };
    if (actor !== undefined) auditEntry.actor = actor;
    if (reason !== undefined) auditEntry.reason = reason;

    this.mergeHistory.push(auditEntry);
    this.mergeById.set(mergeId, auditEntry);
    this.appliedPlanIds.add(planId);

    this.recordAudit('merge-applied', [survivor.id, ...auditEntry.duplicateIds], actor, {
      mergeId,
      planId,
      reason,
      matchReasons: auditEntry.matchReasons,
    });
    this.notifyCollections();

    return {
      mergeId,
      planId,
      appliedAt,
      survivor: clonePaper(preview),
      removedIds: [...auditEntry.duplicateIds],
      auditEntry: cloneMergeAuditEntry(auditEntry),
    };
  }

  /**
   * Reverts a previously confirmed merge by restoring the survivor and all duplicate
   * papers to their exact pre-merge snapshots while preserving the audit trail.
   */
  rollbackMerge(mergeId: string, options: RollbackMergeOptions = {}): RollbackResult {
    const key = requireText(mergeId, 'mergeId');
    const entry = this.mergeById.get(key);
    if (entry === undefined) {
      throw new SmartCollectionError('unknown-merge', `merge "${key}" does not exist.`, 'mergeId');
    }
    if (entry.rolledBackAt !== undefined) {
      throw new SmartCollectionError(
        'merge-already-rolled-back',
        `merge "${key}" was already rolled back at ${entry.rolledBackAt}.`,
        'mergeId',
      );
    }

    const entryIndex = this.mergeHistory.indexOf(entry);
    const touchedIds = new Set([entry.survivorId, ...entry.duplicateIds]);
    for (let i = entryIndex + 1; i < this.mergeHistory.length; i++) {
      const later = this.mergeHistory[i];
      if (later === undefined || later.rolledBackAt !== undefined) continue;
      if (touchedIds.has(later.survivorId) || later.duplicateIds.some(id => touchedIds.has(id))) {
        throw new SmartCollectionError(
          'rollback-conflict',
          `cannot roll back "${key}" before newer active merge "${later.mergeId}" is rolled back.`,
          'mergeId',
        );
      }
    }

    for (const dup of entry.duplicatesBefore) {
      if (this.paperById.has(dup.id)) {
        throw new SmartCollectionError(
          'rollback-conflict',
          `cannot restore duplicate paper "${dup.id}" because an active paper with that id exists.`,
          'mergeId',
        );
      }
    }

    const actor = optionalBlankableText(options?.actor, 'actor');
    const reason = optionalBlankableText(options?.reason, 'reason');
    const rolledBackAt = this.stamp();

    const restoredSurvivor = clonePaper(entry.survivorBefore);
    const existingSurvivor = this.paperById.get(entry.survivorId);
    if (existingSurvivor !== undefined) {
      this.replacePaperRecord(existingSurvivor, restoredSurvivor);
    } else {
      this.papers.push(restoredSurvivor);
      this.paperById.set(restoredSurvivor.id, restoredSurvivor);
    }

    const restoredDuplicates: LibraryPaper[] = [];
    for (const dup of entry.duplicatesBefore) {
      const copy = clonePaper(dup);
      this.papers.push(copy);
      this.paperById.set(copy.id, copy);
      restoredDuplicates.push(clonePaper(copy));
    }

    entry.rolledBackAt = rolledBackAt;
    if (actor !== undefined) entry.rolledBackBy = actor;
    if (reason !== undefined) entry.rollbackReason = reason;

    this.recordAudit('merge-rolled-back', [entry.survivorId, ...entry.duplicateIds], actor, {
      mergeId: entry.mergeId,
      reason,
    });
    this.notifyCollections();

    return {
      mergeId: entry.mergeId,
      rolledBackAt,
      restoredSurvivor: clonePaper(restoredSurvivor),
      restoredDuplicates,
      auditEntry: cloneMergeAuditEntry(entry),
    };
  }

  /** Returns copies of all merge audit entries in chronological order. */
  getMergeHistory(): MergeAuditEntry[] {
    return this.mergeHistory.map(cloneMergeAuditEntry);
  }

  /** Returns copies of all library audit events in chronological order. */
  getAuditLog(): LibraryAuditEvent[] {
    return this.auditLog.map(cloneAuditEvent);
  }

  // --- JSON Persistence ---

  /** Writes the entire library (papers, smart collections, merge history, and audit log) as canonical JSON. */
  exportJson(): string {
    const doc = {
      schemaVersion: SMART_COLLECTIONS_SCHEMA_VERSION,
      kind: SMART_COLLECTIONS_EXPORT_KIND,
      papers: [...this.papers].sort((a, b) => compareText(a.id, b.id)).map(serializePaper),
      collections: [...this.collections].sort((a, b) => compareText(a.id, b.id)).map(serializeCollection),
      mergeHistory: this.mergeHistory.map(serializeMergeAuditEntry),
      auditLog: this.auditLog.map(serializeAuditEvent),
    };
    return JSON.stringify(doc, null, 2);
  }

  /** Validates and imports an exported library JSON document atomically. */
  importJson(json: string, options: ImportLibraryOptions = {}): ImportLibraryResult {
    const mode = options?.mode ?? 'merge';
    if (mode !== 'merge' && mode !== 'replace') {
      throw new SmartCollectionError('invalid-field', 'mode must be "merge" or "replace".', 'mode');
    }

    const parsed = readLibraryDocument(json);

    if (mode === 'merge') {
      const seenPapers = new Set<string>();
      for (const [i, paper] of parsed.papers.entries()) {
        if (seenPapers.has(paper.id) || this.paperById.has(paper.id)) {
          throw new SmartCollectionError('duplicate-id', `paper "${paper.id}" already exists.`, `papers[${i}].id`);
        }
        seenPapers.add(paper.id);
      }
      const seenCollections = new Set<string>();
      for (const [i, col] of parsed.collections.entries()) {
        if (seenCollections.has(col.id) || this.collectionById.has(col.id)) {
          throw new SmartCollectionError('duplicate-id', `collection "${col.id}" already exists.`, `collections[${i}].id`);
        }
        seenCollections.add(col.id);
      }
      const seenMerges = new Set<string>();
      for (const [i, entry] of parsed.mergeHistory.entries()) {
        if (seenMerges.has(entry.mergeId) || this.mergeById.has(entry.mergeId)) {
          throw new SmartCollectionError('duplicate-id', `merge "${entry.mergeId}" already exists.`, `mergeHistory[${i}].mergeId`);
        }
        seenMerges.add(entry.mergeId);
      }
    } else {
      this.papers.length = 0;
      this.paperById.clear();
      this.collections.length = 0;
      this.collectionById.clear();
      this.mergeHistory.length = 0;
      this.mergeById.clear();
      this.appliedPlanIds.clear();
      this.auditLog.length = 0;
      this.paperSeq = 0;
      this.collectionSeq = 0;
      this.planSeq = 0;
      this.mergeSeq = 0;
      this.eventSeq = 0;
    }

    for (const paper of parsed.papers) {
      this.papers.push(paper);
      this.paperById.set(paper.id, paper);
      this.advanceSequence('p', paper.id);
    }
    for (const col of parsed.collections) {
      this.collections.push(col);
      this.collectionById.set(col.id, col);
      this.advanceSequence('col-', col.id);
    }
    for (const entry of parsed.mergeHistory) {
      this.mergeHistory.push(entry);
      this.mergeById.set(entry.mergeId, entry);
      this.appliedPlanIds.add(entry.planId);
      this.advanceSequence('merge-', entry.mergeId);
      this.advanceSequence('merge-plan-', entry.planId);
    }
    for (const event of parsed.auditLog) {
      this.auditLog.push(event);
      this.advanceSequence('evt-', event.id);
    }

    this.notifyCollections();

    return {
      papersImported: parsed.papers.length,
      collectionsImported: parsed.collections.length,
      mergesImported: parsed.mergeHistory.length,
      totalPapers: this.papers.length,
      totalCollections: this.collections.length,
    };
  }

  /** Constructs a new {@link ResearchLibrary} from an exported JSON document. */
  static fromJson(json: string, options: Pick<ResearchLibraryOptions, 'now'> = {}): ResearchLibrary {
    const library = new ResearchLibrary(options);
    library.importJson(json, { mode: 'replace' });
    return library;
  }

  // --- Internal Plumbing ---

  private replacePaperRecord(current: LibraryPaper, next: LibraryPaper): void {
    const index = this.papers.indexOf(current);
    if (index >= 0) this.papers[index] = next;
    else this.papers.push(next);
    this.paperById.set(next.id, next);
  }

  private notifyCollections(onlyCollectionId?: string): void {
    for (const sub of this.subscriptions) {
      if (onlyCollectionId !== undefined && sub.collectionId !== onlyCollectionId) continue;
      if (!this.collectionById.has(sub.collectionId)) continue;
      const snapshot = this.evaluateCollection(sub.collectionId);
      const digest = snapshotDigest(snapshot);
      if (digest === sub.lastDigest) continue;
      sub.lastDigest = digest;
      sub.listener?.(snapshot);
    }
  }

  private recordAudit(
    action: LibraryAuditAction,
    targetIds: string[],
    actor?: string,
    details?: Record<string, unknown>,
  ): void {
    const event: LibraryAuditEvent = {
      id: this.nextEventId(),
      at: this.stamp(),
      action,
      targetIds: [...targetIds],
    };
    if (actor !== undefined) event.actor = actor;
    if (details !== undefined) {
      const cleanedDetails = compactRecord(details);
      if (cleanedDetails !== undefined) event.details = cleanedDetails;
    }
    this.auditLog.push(event);
  }

  private advanceSequence(prefix: string, id: string): void {
    if (!id.startsWith(prefix)) return;
    const tail = id.slice(prefix.length);
    if (!/^\d+$/u.test(tail)) return;
    const num = Number.parseInt(tail, 10);
    if (prefix === 'p' && num > this.paperSeq) this.paperSeq = num;
    else if (prefix === 'col-' && num > this.collectionSeq) this.collectionSeq = num;
    else if (prefix === 'merge-plan-' && num > this.planSeq) this.planSeq = num;
    else if (prefix === 'merge-' && num > this.mergeSeq) this.mergeSeq = num;
    else if (prefix === 'evt-' && num > this.eventSeq) this.eventSeq = num;
  }

  private nextPaperId(): string {
    let candidate = '';
    do {
      this.paperSeq += 1;
      candidate = `p${this.paperSeq}`;
    } while (this.paperById.has(candidate));
    return candidate;
  }

  private nextCollectionId(): string {
    let candidate = '';
    do {
      this.collectionSeq += 1;
      candidate = `col-${this.collectionSeq}`;
    } while (this.collectionById.has(candidate));
    return candidate;
  }

  private nextPlanId(): string {
    let candidate = '';
    do {
      this.planSeq += 1;
      candidate = `merge-plan-${this.planSeq}`;
    } while (this.appliedPlanIds.has(candidate));
    return candidate;
  }

  private nextMergeId(): string {
    let candidate = '';
    do {
      this.mergeSeq += 1;
      candidate = `merge-${this.mergeSeq}`;
    } while (this.mergeById.has(candidate));
    return candidate;
  }

  private nextEventId(): string {
    this.eventSeq += 1;
    return `evt-${this.eventSeq}`;
  }

  private stamp(): string {
    const value = this.clock();
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new SmartCollectionError('invalid-field', 'clock must return a non-empty ISO-8601 string.', 'now');
    }
    return value.trim();
  }
}

// --- Merge Computation -----------------------------------------------------

interface BuiltMerge {
  preview: LibraryPaper;
  addedTags: string[];
  addedTopics: string[];
  addedNoteIds: string[];
  addedAnnotationIds: string[];
  addedCitationKeys: string[];
  addedReferences: string[];
  filledFields: string[];
  conflicts: MergeFieldConflict[];
}

function buildMergedPreview(survivor: LibraryPaper, duplicates: readonly LibraryPaper[], stamp: string): BuiltMerge {
  const preview = clonePaper(survivor);
  preview.updatedAt = stamp;

  const filledFields: string[] = [];
  const conflicts: MergeFieldConflict[] = [];

  const scalarFields = ['doi', 'arxivId', 'year', 'venue', 'abstract'] as const;
  for (const field of scalarFields) {
    for (const dup of duplicates) {
      const survVal = preview[field];
      const dupVal = dup[field];
      if (survVal === undefined && dupVal !== undefined) {
        (preview as unknown as Record<string, unknown>)[field] = dupVal;
        if (!filledFields.includes(field)) filledFields.push(field);
      } else if (survVal !== undefined && dupVal !== undefined && survVal !== dupVal) {
        conflicts.push({
          field,
          survivorValue: survVal,
          duplicateId: dup.id,
          duplicateValue: dupVal,
        });
      }
    }
  }

  for (const dup of duplicates) {
    if (preview.title !== dup.title) {
      conflicts.push({
        field: 'title',
        survivorValue: preview.title,
        duplicateId: dup.id,
        duplicateValue: dup.title,
      });
    }
    if (dup.citationCount !== undefined) {
      if (preview.citationCount === undefined) {
        preview.citationCount = dup.citationCount;
        filledFields.push('citationCount');
      } else if (dup.citationCount > preview.citationCount) {
        preview.citationCount = dup.citationCount;
      }
    }
    if (preview.authors.length === 0 && dup.authors.length > 0) {
      preview.authors = [...dup.authors];
      preview.normalizedAuthors = [...dup.normalizedAuthors];
      if (!filledFields.includes('authors')) filledFields.push('authors');
    }
    if (READ_PROGRESS_RANK[dup.readStatus] > READ_PROGRESS_RANK[preview.readStatus]) {
      preview.readStatus = dup.readStatus;
    }
  }

  const addedTags = unionCaseInsensitive(preview.tags, duplicates.flatMap(d => d.tags));
  const addedTopics = unionCaseInsensitive(preview.topics, duplicates.flatMap(d => d.topics));
  const addedNoteIds = unionExact(preview.noteIds, duplicates.flatMap(d => d.noteIds));
  const addedAnnotationIds = unionExact(preview.annotationIds, duplicates.flatMap(d => d.annotationIds));
  const addedCitationKeys = unionExact(preview.citationKeys, duplicates.flatMap(d => d.citationKeys));
  const addedReferences = unionExact(preview.references, duplicates.flatMap(d => d.references));

  return {
    preview,
    addedTags,
    addedTopics,
    addedNoteIds,
    addedAnnotationIds,
    addedCitationKeys,
    addedReferences,
    filledFields,
    conflicts,
  };
}

function unionCaseInsensitive(target: string[], incoming: readonly string[]): string[] {
  const seen = new Set(target.map(item => item.toLowerCase()));
  const added: string[] = [];
  for (const item of incoming) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(item);
    added.push(item);
  }
  return added;
}

function unionExact(target: string[], incoming: readonly string[]): string[] {
  const seen = new Set(target);
  const added: string[] = [];
  for (const item of incoming) {
    if (seen.has(item)) continue;
    seen.add(item);
    target.push(item);
    added.push(item);
  }
  return added;
}

function paperFingerprint(paper: LibraryPaper): string {
  return JSON.stringify(serializePaper(paper));
}

function snapshotDigest(snapshot: SmartCollectionSnapshot): string {
  return JSON.stringify({
    collection: serializeCollection(snapshot.collection),
    papers: snapshot.papers.map(serializePaper),
  });
}

// --- JSON Serialization & Validation ---------------------------------------

interface ParsedLibraryDocument {
  papers: LibraryPaper[];
  collections: SmartCollectionDefinition[];
  mergeHistory: MergeAuditEntry[];
  auditLog: LibraryAuditEvent[];
}

function readLibraryDocument(json: string): ParsedLibraryDocument {
  if (typeof json !== 'string') {
    throw new SmartCollectionError('malformed-json', 'importJson needs a JSON string.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    throw new SmartCollectionError('malformed-json', `the text is not valid JSON (${detail}).`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SmartCollectionError('malformed-export', 'a library export must be a JSON object.');
  }

  const doc = parsed as Record<string, unknown>;
  if (doc.schemaVersion !== SMART_COLLECTIONS_SCHEMA_VERSION) {
    throw new SmartCollectionError(
      'unsupported-schema-version',
      `schemaVersion ${String(doc.schemaVersion)} is not supported.`,
      'schemaVersion',
    );
  }
  if (doc.kind !== SMART_COLLECTIONS_EXPORT_KIND) {
    throw new SmartCollectionError('malformed-export', `kind must be "${SMART_COLLECTIONS_EXPORT_KIND}".`, 'kind');
  }
  if (!Array.isArray(doc.papers)) {
    throw new SmartCollectionError('malformed-export', 'papers must be an array.', 'papers');
  }
  if (!Array.isArray(doc.collections)) {
    throw new SmartCollectionError('malformed-export', 'collections must be an array.', 'collections');
  }
  if (!Array.isArray(doc.mergeHistory)) {
    throw new SmartCollectionError('malformed-export', 'mergeHistory must be an array.', 'mergeHistory');
  }
  if (!Array.isArray(doc.auditLog)) {
    throw new SmartCollectionError('malformed-export', 'auditLog must be an array.', 'auditLog');
  }

  return {
    papers: doc.papers.map((item, idx) => readStoredPaper(item, `papers[${idx}]`)),
    collections: doc.collections.map((item, idx) => readStoredCollection(item, `collections[${idx}]`)),
    mergeHistory: doc.mergeHistory.map((item, idx) => readStoredMergeAudit(item, `mergeHistory[${idx}]`)),
    auditLog: doc.auditLog.map((item, idx) => readStoredAuditEvent(item, `auditLog[${idx}]`)),
  };
}

function readStoredPaper(value: unknown, path: string): LibraryPaper {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SmartCollectionError('malformed-export', 'paper must be a JSON object.', path);
  }
  const r = value as Record<string, unknown>;
  const authors = cleanAuthorList(r.authors as readonly string[] | undefined, `${path}.authors`);
  const paper: LibraryPaper = {
    id: requireText(r.id, `${path}.id`),
    title: collapseText(requireText(r.title, `${path}.title`)),
    authors,
    normalizedAuthors: authors.map(a => normalizeAuthor(a).normalized),
    topics: cleanCaseUniqueList(r.topics as readonly string[] | undefined, `${path}.topics`),
    tags: cleanCaseUniqueList(r.tags as readonly string[] | undefined, `${path}.tags`),
    readStatus: readReadStatus(r.readStatus ?? 'unread', `${path}.readStatus`, 'malformed-export'),
    noteIds: cleanExactUniqueList(r.noteIds as readonly string[] | undefined, `${path}.noteIds`),
    annotationIds: cleanExactUniqueList(r.annotationIds as readonly string[] | undefined, `${path}.annotationIds`),
    citationKeys: cleanExactUniqueList(r.citationKeys as readonly string[] | undefined, `${path}.citationKeys`),
    references: cleanExactUniqueList(r.references as readonly string[] | undefined, `${path}.references`),
    createdAt: requireText(r.createdAt, `${path}.createdAt`),
    updatedAt: requireText(r.updatedAt, `${path}.updatedAt`),
  };
  if (r.doi !== undefined) paper.doi = normalizeDoiValue(requireText(r.doi, `${path}.doi`), `${path}.doi`);
  if (r.arxivId !== undefined) paper.arxivId = normalizeArxivValue(requireText(r.arxivId, `${path}.arxivId`), `${path}.arxivId`);
  if (r.year !== undefined) paper.year = readYear(r.year, `${path}.year`, 'malformed-export');
  if (r.venue !== undefined) paper.venue = collapseText(requireText(r.venue, `${path}.venue`));
  if (r.abstract !== undefined) paper.abstract = collapseText(requireText(r.abstract, `${path}.abstract`));
  if (r.citationCount !== undefined) paper.citationCount = readCount(r.citationCount, `${path}.citationCount`);
  return paper;
}

function readStoredCollection(value: unknown, path: string): SmartCollectionDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SmartCollectionError('malformed-export', 'collection must be a JSON object.', path);
  }
  const r = value as Record<string, unknown>;
  const col: SmartCollectionDefinition = {
    id: requireText(r.id, `${path}.id`),
    name: collapseText(requireText(r.name, `${path}.name`)),
    query: validateQuery(r.query, `${path}.query`),
    createdAt: requireText(r.createdAt, `${path}.createdAt`),
    updatedAt: requireText(r.updatedAt, `${path}.updatedAt`),
  };
  if (r.description !== undefined) col.description = collapseText(requireText(r.description, `${path}.description`));
  return col;
}

function readStoredMergeAudit(value: unknown, path: string): MergeAuditEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SmartCollectionError('malformed-export', 'mergeHistory item must be a JSON object.', path);
  }
  const r = value as Record<string, unknown>;
  if (r.confirmed !== true) {
    throw new SmartCollectionError('malformed-export', 'mergeHistory entry must have confirmed: true.', `${path}.confirmed`);
  }
  if (!Array.isArray(r.duplicatesBefore)) {
    throw new SmartCollectionError('malformed-export', 'duplicatesBefore must be an array.', `${path}.duplicatesBefore`);
  }

  const reasonsRaw = Array.isArray(r.matchReasons) ? r.matchReasons : [];
  const matchReasons: DuplicateMatchReason[] = reasonsRaw.map((item, idx) => {
    if (item !== 'doi' && item !== 'arxiv' && item !== 'title-author') {
      throw new SmartCollectionError('malformed-export', 'invalid matchReason.', `${path}.matchReasons[${idx}]`);
    }
    return item;
  });

  const entry: MergeAuditEntry = {
    mergeId: requireText(r.mergeId, `${path}.mergeId`),
    planId: requireText(r.planId, `${path}.planId`),
    appliedAt: requireText(r.appliedAt, `${path}.appliedAt`),
    confirmed: true,
    matchReasons,
    survivorId: requireText(r.survivorId, `${path}.survivorId`),
    duplicateIds: cleanExactUniqueList(r.duplicateIds as readonly string[] | undefined, `${path}.duplicateIds`),
    survivorBefore: readStoredPaper(r.survivorBefore, `${path}.survivorBefore`),
    duplicatesBefore: r.duplicatesBefore.map((d, idx) => readStoredPaper(d, `${path}.duplicatesBefore[${idx}]`)),
    survivorAfter: readStoredPaper(r.survivorAfter, `${path}.survivorAfter`),
  };
  if (r.actor !== undefined) entry.actor = collapseText(requireText(r.actor, `${path}.actor`));
  if (r.reason !== undefined) entry.reason = collapseText(requireText(r.reason, `${path}.reason`));
  if (r.rolledBackAt !== undefined) entry.rolledBackAt = requireText(r.rolledBackAt, `${path}.rolledBackAt`);
  if (r.rolledBackBy !== undefined) entry.rolledBackBy = collapseText(requireText(r.rolledBackBy, `${path}.rolledBackBy`));
  if (r.rollbackReason !== undefined) {
    entry.rollbackReason = collapseText(requireText(r.rollbackReason, `${path}.rollbackReason`));
  }
  return entry;
}

function readStoredAuditEvent(value: unknown, path: string): LibraryAuditEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SmartCollectionError('malformed-export', 'auditLog item must be a JSON object.', path);
  }
  const r = value as Record<string, unknown>;
  const action = requireText(r.action, `${path}.action`);
  if (!(LIBRARY_AUDIT_ACTIONS as readonly string[]).includes(action)) {
    throw new SmartCollectionError('malformed-export', `unknown audit action "${action}".`, `${path}.action`);
  }
  const event: LibraryAuditEvent = {
    id: requireText(r.id, `${path}.id`),
    at: requireText(r.at, `${path}.at`),
    action: action as LibraryAuditAction,
    targetIds: readStringArray(r.targetIds ?? [], `${path}.targetIds`),
  };
  if (r.actor !== undefined) event.actor = collapseText(requireText(r.actor, `${path}.actor`));
  if (r.details !== undefined) {
    if (typeof r.details !== 'object' || r.details === null || Array.isArray(r.details)) {
      throw new SmartCollectionError('malformed-export', 'details must be an object.', `${path}.details`);
    }
    event.details = { ...(r.details as Record<string, unknown>) };
  }
  return event;
}

function serializePaper(paper: LibraryPaper): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: paper.id,
    title: paper.title,
  };
  if (paper.doi !== undefined) out.doi = paper.doi;
  if (paper.arxivId !== undefined) out.arxivId = paper.arxivId;
  out.authors = [...paper.authors];
  out.normalizedAuthors = [...paper.normalizedAuthors];
  if (paper.year !== undefined) out.year = paper.year;
  if (paper.venue !== undefined) out.venue = paper.venue;
  if (paper.abstract !== undefined) out.abstract = paper.abstract;
  out.topics = [...paper.topics];
  out.tags = [...paper.tags];
  out.readStatus = paper.readStatus;
  out.noteIds = [...paper.noteIds];
  out.annotationIds = [...paper.annotationIds];
  out.citationKeys = [...paper.citationKeys];
  out.references = [...paper.references];
  if (paper.citationCount !== undefined) out.citationCount = paper.citationCount;
  out.createdAt = paper.createdAt;
  out.updatedAt = paper.updatedAt;
  return out;
}

function serializeCollection(col: SmartCollectionDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: col.id,
    name: col.name,
  };
  if (col.description !== undefined) out.description = col.description;
  out.query = cloneQuery(col.query);
  out.createdAt = col.createdAt;
  out.updatedAt = col.updatedAt;
  return out;
}

function serializeMergeAuditEntry(entry: MergeAuditEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    mergeId: entry.mergeId,
    planId: entry.planId,
    appliedAt: entry.appliedAt,
    confirmed: entry.confirmed,
  };
  if (entry.actor !== undefined) out.actor = entry.actor;
  if (entry.reason !== undefined) out.reason = entry.reason;
  out.matchReasons = [...entry.matchReasons];
  out.survivorId = entry.survivorId;
  out.duplicateIds = [...entry.duplicateIds];
  out.survivorBefore = serializePaper(entry.survivorBefore);
  out.duplicatesBefore = entry.duplicatesBefore.map(serializePaper);
  out.survivorAfter = serializePaper(entry.survivorAfter);
  if (entry.rolledBackAt !== undefined) out.rolledBackAt = entry.rolledBackAt;
  if (entry.rolledBackBy !== undefined) out.rolledBackBy = entry.rolledBackBy;
  if (entry.rollbackReason !== undefined) out.rollbackReason = entry.rollbackReason;
  return out;
}

function serializeAuditEvent(event: LibraryAuditEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: event.id,
    at: event.at,
    action: event.action,
    targetIds: [...event.targetIds],
  };
  if (event.actor !== undefined) out.actor = event.actor;
  if (event.details !== undefined) out.details = { ...event.details };
  return out;
}

// --- Field Readers & Clone Utilities ---------------------------------------

function resolveTargetPapers(
  paperIds: readonly string[],
  paperById: Map<string, LibraryPaper>,
  path: string,
): LibraryPaper[] {
  if (!Array.isArray(paperIds) || paperIds.length === 0) {
    throw new SmartCollectionError('invalid-field', `${path} must be a non-empty array of paper ids.`, path);
  }
  const seen = new Set<string>();
  const resolved: LibraryPaper[] = [];
  for (let i = 0; i < paperIds.length; i++) {
    const key = requireText(paperIds[i], `${path}[${i}]`);
    const found = paperById.get(key);
    if (found === undefined) {
      throw new SmartCollectionError('unknown-id', `paper "${key}" is not in the library.`, `${path}[${i}]`);
    }
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push(found);
    }
  }
  return resolved;
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new SmartCollectionError('invalid-field', `${path} must be a string.`, path);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new SmartCollectionError('invalid-field', `${path} must not be blank.`, path);
  }
  return trimmed;
}

function optionalBlankableText(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new SmartCollectionError('invalid-field', `${path} must be a string when present.`, path);
  }
  const collapsed = collapseText(value);
  return collapsed.length === 0 ? undefined : collapsed;
}

function readYear(value: unknown, path: string, code: SmartCollectionErrorCode): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 9999) {
    throw new SmartCollectionError(code, `${path} must be a 1..9999 integer year.`, path);
  }
  return value;
}

function readCount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SmartCollectionError('invalid-field', `${path} must be a non-negative integer.`, path);
  }
  return value;
}

function readReadStatus(value: unknown, path: string, code: SmartCollectionErrorCode): ReadStatus {
  if (typeof value !== 'string' || !(READ_STATUSES as readonly string[]).includes(value)) {
    throw new SmartCollectionError(code, `${path} must be one of ${READ_STATUSES.join(' | ')}.`, path);
  }
  return value as ReadStatus;
}

function readNonEmptyStringOrList(value: unknown, path: string): string | string[] | undefined {
  if (typeof value === 'string') {
    const cleaned = collapseText(value);
    return cleaned.length > 0 ? cleaned : undefined;
  }
  return readStringArray(value, path);
}

function readStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new SmartCollectionError('invalid-query', `${path} must be an array of strings.`, path);
  }
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== 'string') {
      throw new SmartCollectionError('invalid-query', `${path}[${i}] must be a string.`, `${path}[${i}]`);
    }
    const cleaned = collapseText(item);
    if (cleaned.length > 0) result.push(cleaned);
  }
  return result;
}

function toQueryList(value: string | readonly string[]): string[] {
  if (typeof value === 'string') {
    const cleaned = collapseText(value);
    return cleaned.length > 0 ? [cleaned] : [];
  }
  return value.map(collapseText).filter(item => item.length > 0);
}

function cleanAuthorList(value: readonly string[] | undefined, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SmartCollectionError('invalid-field', `${path} must be an array of author names.`, path);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (typeof raw !== 'string') {
      throw new SmartCollectionError('invalid-field', `${path}[${i}] must be a string.`, `${path}[${i}]`);
    }
    const cleaned = stripBraces(raw);
    if (cleaned.length === 0) continue;
    const key = normalizeAuthor(cleaned).normalized;
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function cleanCaseUniqueList(value: readonly string[] | undefined, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SmartCollectionError('invalid-field', `${path} must be an array of strings.`, path);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (typeof raw !== 'string') {
      throw new SmartCollectionError('invalid-field', `${path}[${i}] must be a string.`, `${path}[${i}]`);
    }
    const cleaned = collapseText(raw);
    if (cleaned.length === 0) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function cleanExactUniqueList(value: readonly string[] | undefined, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SmartCollectionError('invalid-field', `${path} must be an array of strings.`, path);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (typeof raw !== 'string') {
      throw new SmartCollectionError('invalid-field', `${path}[${i}] must be a string.`, `${path}[${i}]`);
    }
    const cleaned = raw.trim();
    if (cleaned.length === 0 || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result;
}

function clonePaper(paper: LibraryPaper): LibraryPaper {
  return {
    ...paper,
    authors: [...paper.authors],
    normalizedAuthors: [...paper.normalizedAuthors],
    topics: [...paper.topics],
    tags: [...paper.tags],
    noteIds: [...paper.noteIds],
    annotationIds: [...paper.annotationIds],
    citationKeys: [...paper.citationKeys],
    references: [...paper.references],
  };
}

function cloneQuery(query: SmartCollectionQuery): SmartCollectionQuery {
  const out: SmartCollectionQuery = {};
  if (query.topic !== undefined) out.topic = Array.isArray(query.topic) ? [...query.topic] : query.topic;
  if (query.topicsAll !== undefined) out.topicsAll = [...query.topicsAll];
  if (query.author !== undefined) out.author = Array.isArray(query.author) ? [...query.author] : query.author;
  if (query.authorsAll !== undefined) out.authorsAll = [...query.authorsAll];
  if (query.yearMin !== undefined) out.yearMin = query.yearMin;
  if (query.yearMax !== undefined) out.yearMax = query.yearMax;
  if (query.venue !== undefined) out.venue = Array.isArray(query.venue) ? [...query.venue] : query.venue;
  if (query.tagsAll !== undefined) out.tagsAll = [...query.tagsAll];
  if (query.tagsAny !== undefined) out.tagsAny = [...query.tagsAny];
  if (query.readStatus !== undefined) {
    out.readStatus = Array.isArray(query.readStatus) ? [...query.readStatus] : query.readStatus;
  }
  if (query.text !== undefined) out.text = query.text;
  if (query.sortBy !== undefined) out.sortBy = query.sortBy;
  return out;
}

function cloneCollection(col: SmartCollectionDefinition): SmartCollectionDefinition {
  return {
    ...col,
    query: cloneQuery(col.query),
  };
}

function cloneMergeAuditEntry(entry: MergeAuditEntry): MergeAuditEntry {
  return {
    ...entry,
    matchReasons: [...entry.matchReasons],
    duplicateIds: [...entry.duplicateIds],
    survivorBefore: clonePaper(entry.survivorBefore),
    duplicatesBefore: entry.duplicatesBefore.map(clonePaper),
    survivorAfter: clonePaper(entry.survivorAfter),
  };
}

function cloneAuditEvent(event: LibraryAuditEvent): LibraryAuditEvent {
  return {
    ...event,
    targetIds: [...event.targetIds],
    ...(event.details === undefined ? {} : { details: { ...event.details } }),
  };
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let hasAny = false;
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue;
    out[k] = v;
    hasAny = true;
  }
  return hasAny ? out : undefined;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const SYSTEM_CLOCK = (): string => new Date().toISOString();
