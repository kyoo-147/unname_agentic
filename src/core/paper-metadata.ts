/**
 * Academic paper metadata, identifier, reference extraction, and enrichment preview (backlog J01).
 *
 * Reads a `DocumentIR` (and optionally PDF `/Info` metadata from `metadata.ts`) to extract
 * bibliographic fields and the paper's reference list, builds Crossref / Semantic Scholar
 * lookups and merges API payloads through `scholar.ts`, requires an explicit review step before
 * anything enters a paper library, and emits canonical BibTeX through `bibtex.ts`.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network I/O.
 * - Nothing is invented: missing fields stay `undefined` (or `null` for `title`), and DOIs /
 *   arXiv ids appearing in the References section are kept on those references rather than
 *   attributed to the paper itself.
 * - Enrichment never silently overwrites local metadata or writes directly to the library: callers
 *   receive an explicit `EnrichmentPreview` diff and must pass `{ approved: true }` to commit.
 */

import { stableKeys, toBibTeX } from './bibtex';
import type { Entry } from './bibtex';
import type { Block, DocumentIR } from './ir';
import { deriveTitle, normaliseKeywords } from './metadata';
import type { DocumentMetadata, TitleBlock } from './metadata';
import {
  PAPER_FIELDS,
  arxivId,
  buildLookup,
  mergeRecords,
  normalizeDoi,
  parseCrossref,
  parseSemanticScholar,
  toBibTeXEntry,
} from './scholar';
import type { Lookup, MergedRecord, PaperField, PaperRecord, SourceLabel } from './scholar';

// --- Public types ----------------------------------------------------------

export type PaperMetadataErrorCode = 'review-not-approved' | 'missing-enrichment';

/** Typed error for workflow-gate violations in paper metadata import. */
export class PaperMetadataError extends Error {
  readonly code: PaperMetadataErrorCode;

  constructor(code: PaperMetadataErrorCode, message: string) {
    super(message);
    this.name = 'PaperMetadataError';
    this.code = code;
  }
}

/** One parsed entry from the paper's own bibliography / references section. */
export interface ExtractedReference {
  /** 0-based position in the extracted reference list. */
  index: number;
  /** Leading marker if numbered (`[1]`, `(1)`, `1.`), omitted for unnumbered entries. */
  marker?: string;
  /** Cleaned reference text as extracted from the document. */
  raw: string;
  /** Parsed work title, when structurally identifiable. */
  title?: string;
  /** Parsed author names, when structurally identifiable. */
  authors?: string[];
  /** Four-digit publication year, when present outside identifier tokens. */
  year?: number;
  /** Parsed venue / journal / proceedings string, when structurally identifiable. */
  venue?: string;
  /** Canonical DOI if the reference carries one. */
  doi?: string;
  /** Normalized arXiv id (without version) if the reference carries one. */
  arxiv?: string;
}

/** Bibliographic metadata extracted from a paper's `DocumentIR`. */
export interface ExtractedPaperMetadata {
  title: string | null;
  authors: string[];
  venue?: string;
  year?: number;
  doi?: string;
  arxiv?: string;
  abstract?: string;
  keywords: string[];
  references: ExtractedReference[];
}

export interface ExtractPaperMetadataOptions {
  /** Optional PDF `/Info` metadata from `readMetadata` used only as non-placeholder fallback. */
  pdfMetadata?: DocumentMetadata;
  /** Optional filename fallback passed through to `deriveTitle`. */
  filename?: string;
}

/** Lookup plan built via `scholar.ts` for a paper's unambiguous identifiers. */
export interface PaperLookupPlan {
  primary: Lookup | null;
  /** Separate arXiv lookup when both a non-arXiv DOI and an arXiv id are present. */
  fallbackArxiv?: Lookup;
  canLookup: boolean;
  reason?: string;
}

/** Lookup request paired with a reference entry's index. */
export interface ReferenceLookup {
  referenceIndex: number;
  lookup: Lookup;
}

/** External API payloads or pre-parsed `PaperRecord`s supplied to enrichment. */
export interface PaperEnrichmentInput {
  crossref?: unknown;
  semanticScholar?: unknown;
  crossrefRecord?: PaperRecord;
  semanticScholarRecord?: PaperRecord;
}

export type ReviewFieldStatus = 'unchanged' | 'added' | 'updated';
export type FieldSourceLabel = SourceLabel | 'local';
export type FieldChoice = 'local' | 'enriched';

/** One field's comparison between locally extracted metadata and API enrichment. */
export interface EnrichmentFieldChange<K extends PaperField = PaperField> {
  field: K;
  localValue: PaperRecord[K] | undefined;
  enrichedValue: PaperRecord[K] | undefined;
  proposedValue: PaperRecord[K] | undefined;
  source: FieldSourceLabel;
  status: ReviewFieldStatus;
  /** True when local extraction held a distinct non-empty value that enrichment proposes replacing. */
  hasConflict: boolean;
}

export interface EnrichmentSummary {
  added: number;
  updated: number;
  unchanged: number;
  conflicts: number;
}

/** Explicit diff preview shown to a reviewer before importing into the library. */
export interface EnrichmentPreview {
  extracted: ExtractedPaperMetadata;
  localRecord: PaperRecord;
  enrichedRecord: MergedRecord | null;
  proposed: PaperRecord;
  changes: EnrichmentFieldChange[];
  summary: EnrichmentSummary;
  requiresReview: boolean;
  bibtexPreview: string;
}

/** Explicit reviewer decision required before committing an enrichment preview. */
export interface EnrichmentReviewDecision {
  approved: boolean;
  fieldChoices?: Partial<Record<PaperField, FieldChoice>>;
}

/** Finalized paper entry produced after explicit review approval. */
export interface ApprovedPaperImport {
  record: PaperRecord;
  entry: Entry;
  bibtex: string;
  keywords: string[];
  references: ExtractedReference[];
}

/** Pure in-memory paper library used for reviewed bibliographic imports. */
export interface PaperLibrary {
  list(): ApprovedPaperImport[];
  get(key: string): ApprovedPaperImport | undefined;
  has(key: string): boolean;
  add(item: ApprovedPaperImport): void;
}

// --- Constants -------------------------------------------------------------

const ARXIV_DOI_RE = /^10\.48550\/arxiv\.(.+)$/iu;

const REFERENCES_HEADING_RE =
  /^(?:\d+(?:\.\d+)*\.?\s+)?(?:references|bibliography|works\s+cited|literature\s+cited|cited\s+references)\s*[:.]?\s*$/iu;

const APPENDIX_HEADING_RE =
  /^(?:appendix(?:\s+[A-Z0-9]+)?|supplementary(?:\s+material)?|acknowledgements?|acknowledgments?|[A-Z]\.\s+\S)/iu;

const ABSTRACT_HEADING_RE = /^(?:abstract|summary)\s*[:.]?\s*$/iu;
const INLINE_ABSTRACT_RE = /^(?:abstract|summary)\s*[:.\u2014-]+\s*(.+)$/iu;
const KEYWORDS_LINE_RE = /^(?:keywords?|index\s+terms?|key\s+words?)\s*[:.\u2014-]+\s*(.+)$/iu;

const SECTION_NUMBER_HEADING_RE = /^(?:\d+(?:\.\d+)*\.?\s+|introduction\b|background\b|related\s+work\b)/iu;

const BANNER_LINE_RE =
  /^(?:arxiv\s*:|doi\s*:|https?:\/\/|preprint\b|published\s+(?:as|in)\b|accepted\s+(?:at|for)\b|proceedings\s+of\b|in\s+proceedings\b|\u00a9|copyright\b)/iu;

const AFFILIATION_HINT_RE =
  /(?:@|https?:\/\/|orcid|\buniversity\b|\binstitute\b|\bdepartment\b|\bdept\.?\b|\bfaculty\b|\bcollege\b|\bschool\b|\blaborator(?:y|ies)\b|\blabs?\b|\bcent(?:er|re)\b|\bcorrespondence\b|\bequal\s+contribution\b)/iu;

const VENUE_HINT_RE =
  /(?:proceedings\s+of|published\s+in|published\s+as|appears\s+in|accepted\s+(?:at|to|for)|journal\s+of|transactions\s+on|advances\s+in|conference\s+on|symposium\s+on|workshop\s+on|venue\s*:|\b(?:ieee|acm|springer|elsevier|neurips|nips|icml|iclr|acl|emnlp|naacl|cvpr|iccv|eccv|aaai|ijcai|kdd|sigir|www|chi|doceng)\b)/iu;

const REF_MARKER_START_RE = /^\s*(\[\d+\]|\(\d+\)|\d+\.)\s+(.+)$/u;

const NON_SENTENCE_ABBREV_RE =
  /(?:^|\s)(?:[A-Z]|Jr|Sr|Dr|Prof|Mr|Ms|et\s+al|pp|vol|no|eds?|proc|conf|trans|univ|dept|fig|eq)\.$/iu;

const YEAR_TOKEN_RE = /\b(19\d{2}|20\d{2})\b/gu;

// --- Extraction from DocumentIR --------------------------------------------

/**
 * Extracts structured academic metadata and parsed bibliography references from a `DocumentIR`.
 *
 * Scanning is bounded to front-matter / body blocks for the paper's own identifiers (`doi`, `arxiv`)
 * so cited works inside `References` never leak onto the host paper.
 */
export function extractPaperMetadata(
  ir: DocumentIR,
  options: ExtractPaperMetadataOptions = {},
): ExtractedPaperMetadata {
  const ordered = sortBlocks(ir.blocks);
  const referencesHeadingIndex = ordered.findIndex(block => isReferencesHeading(block));
  const frontAndBody = referencesHeadingIndex === -1 ? ordered : ordered.slice(0, referencesHeadingIndex);
  const firstPage = ir.pages[0]?.index ?? ordered[0]?.page ?? 1;
  const pageOneBlocks = frontAndBody.filter(block => block.page === firstPage);

  const { title, titleBlockIndex } = extractTitle(pageOneBlocks, frontAndBody, options);
  const authors = extractAuthors(pageOneBlocks, titleBlockIndex, options);
  const doi = extractPaperDoi(pageOneBlocks, frontAndBody, options.pdfMetadata);
  const arxiv = extractPaperArxiv(pageOneBlocks, frontAndBody, doi);
  const { venue, year } = extractVenueAndYear(pageOneBlocks, titleBlockIndex, doi, arxiv);
  const abstract = extractAbstract(frontAndBody);
  const keywords = extractKeywords(frontAndBody, options.pdfMetadata);
  const references =
    referencesHeadingIndex === -1 ? [] : extractReferences(ordered.slice(referencesHeadingIndex + 1));

  const result: ExtractedPaperMetadata = {
    title,
    authors,
    keywords,
    references,
  };
  if (venue !== undefined) result.venue = venue;
  if (year !== undefined) result.year = year;
  if (doi !== undefined) result.doi = doi;
  if (arxiv !== undefined) result.arxiv = arxiv;
  if (abstract !== undefined) result.abstract = abstract;
  return result;
}

function sortBlocks(blocks: readonly Block[]): Block[] {
  return [...blocks].sort((a, b) => a.page - b.page || a.readingOrder - b.readingOrder);
}

function isReferencesHeading(block: Block): boolean {
  const text = collapseSpace(block.raw);
  if (block.type === 'heading') return REFERENCES_HEADING_RE.test(text);
  return /^(?:references|bibliography)\s*$/iu.test(text);
}

function extractTitle(
  pageOneBlocks: readonly Block[],
  frontAndBody: readonly Block[],
  options: ExtractPaperMetadataOptions,
): { title: string | null; titleBlockIndex: number } {
  for (let i = 0; i < pageOneBlocks.length; i++) {
    const block = pageOneBlocks[i];
    if (block === undefined || block.type !== 'heading') continue;
    const text = collapseSpace(block.raw);
    if (text.length === 0) continue;
    if (
      ABSTRACT_HEADING_RE.test(text) ||
      SECTION_NUMBER_HEADING_RE.test(text) ||
      BANNER_LINE_RE.test(text)
    ) {
      continue;
    }
    return { title: text, titleBlockIndex: i };
  }

  const titleBlocks: TitleBlock[] = frontAndBody.map(block => ({
    text: block.raw,
    type: block.type === 'heading' ? 'heading' : 'paragraph',
  }));
  const derived = deriveTitle(options.pdfMetadata, titleBlocks, {
    filename: options.filename,
  });
  return { title: derived.title, titleBlockIndex: -1 };
}

function extractAuthors(
  pageOneBlocks: readonly Block[],
  titleBlockIndex: number,
  options: ExtractPaperMetadataOptions,
): string[] {
  const start = titleBlockIndex >= 0 ? titleBlockIndex + 1 : 0;
  const collected: string[] = [];

  for (let i = start; i < pageOneBlocks.length; i++) {
    const block = pageOneBlocks[i];
    if (block === undefined) continue;
    const text = collapseSpace(block.raw);
    if (text.length === 0) continue;

    if (
      ABSTRACT_HEADING_RE.test(text) ||
      INLINE_ABSTRACT_RE.test(text) ||
      KEYWORDS_LINE_RE.test(text) ||
      (block.type === 'heading' && SECTION_NUMBER_HEADING_RE.test(text))
    ) {
      break;
    }

    if (block.type === 'footnote' || block.type === 'other') continue;
    if (BANNER_LINE_RE.test(text) || VENUE_HINT_RE.test(text)) continue;

    for (const line of block.raw.split(/\r?\n/u)) {
      const cleanedLine = collapseSpace(line);
      if (cleanedLine.length === 0) continue;
      if (AFFILIATION_HINT_RE.test(cleanedLine) || BANNER_LINE_RE.test(cleanedLine)) continue;
      const parsed = parseAuthorLine(cleanedLine);
      collected.push(...parsed);
    }

    if (collected.length > 0 && i > start + 2) break;
  }

  if (collected.length > 0) return collected;
  return [...(options.pdfMetadata?.authors ?? [])];
}

function parseAuthorLine(line: string): string[] {
  const withoutMarkers = stripAffiliationMarkers(line);
  const authors: string[] = [];

  for (const segment of withoutMarkers.split(/;+/u)) {
    const clause = collapseSpace(segment);
    if (clause.length === 0 || AFFILIATION_HINT_RE.test(clause)) continue;

    if (clause.includes(',')) {
      const commaParts = clause
        .split(/,(?!\s*(?:Jr|Sr|II|III|IV)\b\.?)/iu)
        .map(part => collapseSpace(part).replace(/^(?:and|&)\s+/iu, '').trim())
        .filter(part => part.length > 0);

      // A single "Family, Given" clause keeps its comma; a list of "Given Family" names splits.
      const isInvertedSingle =
        commaParts.length === 2 &&
        wordCount(commaParts[0] ?? '') === 1 &&
        wordCount(commaParts[1] ?? '') >= 1 &&
        wordCount(commaParts[1] ?? '') <= 3 &&
        !/\b(?:and|&)\b/iu.test(clause);

      if (isInvertedSingle) {
        authors.push(clause);
        continue;
      }

      if (commaParts.length >= 2 && commaParts.every(part => wordCount(part) >= 2)) {
        for (const part of commaParts) {
          for (const sub of part.split(/\s+(?:and|&)\s+/iu)) {
            const name = collapseSpace(sub);
            if (isLikelyAuthorName(name)) authors.push(name);
          }
        }
        continue;
      }
    }

    for (const sub of clause.split(/\s+(?:and|&)\s+/iu)) {
      const name = collapseSpace(sub);
      if (isLikelyAuthorName(name)) authors.push(name);
    }
  }

  return authors;
}

function stripAffiliationMarkers(text: string): string {
  return text.replace(
    /([A-Za-zÀ-ÖØ-öø-ÿ.])(?:[0-9]+(?:,[0-9]+)*[*†‡§¶]*|[*†‡§¶]+)(?=\s*(?:[,;]|\band\b|&|$))/gu,
    '$1',
  );
}

function isLikelyAuthorName(name: string): boolean {
  if (name.length === 0 || AFFILIATION_HINT_RE.test(name)) return false;
  if (/\d/u.test(name)) return false;
  const words = wordCount(name);
  return words >= 1 && words <= 6;
}

function extractPaperDoi(
  pageOneBlocks: readonly Block[],
  frontAndBody: readonly Block[],
  pdfMetadata?: DocumentMetadata,
): string | undefined {
  for (const block of pageOneBlocks) {
    if (/\bdoi\b|doi\.org/iu.test(block.raw)) {
      const found = normalizeDoi(block.raw);
      if (found !== null) return found;
    }
  }
  for (const block of pageOneBlocks) {
    const found = normalizeDoi(block.raw);
    if (found !== null) return found;
  }
  if (pdfMetadata?.subject !== null && pdfMetadata?.subject !== undefined) {
    const fromSubject = normalizeDoi(pdfMetadata.subject);
    if (fromSubject !== null) return fromSubject;
  }
  for (const block of frontAndBody) {
    if (/\bdoi\b|doi\.org/iu.test(block.raw)) {
      const found = normalizeDoi(block.raw);
      if (found !== null) return found;
    }
  }
  return undefined;
}

function extractPaperArxiv(
  pageOneBlocks: readonly Block[],
  frontAndBody: readonly Block[],
  doi: string | undefined,
): string | undefined {
  for (const block of pageOneBlocks) {
    const found = arxivId(block.raw);
    if (found !== null) return found;
  }
  if (doi !== undefined) {
    const match = ARXIV_DOI_RE.exec(doi);
    const suffix = match?.[1];
    if (suffix !== undefined) {
      const fromDoi = arxivId(suffix);
      if (fromDoi !== null) return fromDoi;
    }
  }
  for (const block of frontAndBody) {
    if (/arxiv/iu.test(block.raw)) {
      const found = arxivId(block.raw);
      if (found !== null) return found;
    }
  }
  return undefined;
}

function extractVenueAndYear(
  pageOneBlocks: readonly Block[],
  titleBlockIndex: number,
  doi: string | undefined,
  arxiv: string | undefined,
): { venue?: string; year?: number } {
  let venue: string | undefined;
  let year: number | undefined;

  for (let i = 0; i < pageOneBlocks.length; i++) {
    if (i === titleBlockIndex) continue;
    const block = pageOneBlocks[i];
    if (block === undefined) continue;
    const text = collapseSpace(block.raw);
    if (text.length === 0) continue;

    if (venue === undefined && VENUE_HINT_RE.test(text) && !ABSTRACT_HEADING_RE.test(text)) {
      const cleanedVenue = cleanVenueLine(text);
      if (cleanedVenue.length > 0) venue = cleanedVenue;
    }

    if (year === undefined) {
      const foundYear = extractYearOutsideIdentifiers(text, doi, arxiv);
      if (foundYear !== undefined) year = foundYear;
    }
  }

  const out: { venue?: string; year?: number } = {};
  if (venue !== undefined) out.venue = venue;
  if (year !== undefined) out.year = year;
  return out;
}

function cleanVenueLine(text: string): string {
  const withoutIds = text
    .replace(/\bdoi\s*:\s*\S+/giu, '')
    .replace(/https?:\/\/\S+/giu, '')
    .replace(/\barxiv\s*:\s*\S+/giu, '');
  const withoutLead = withoutIds.replace(
    /^(?:published\s+(?:as\s+a\s+conference\s+paper\s+at|in)|appears\s+in|accepted\s+(?:at|for)|in|venue\s*:)\s+/iu,
    '',
  );
  return collapseSpace(withoutLead).replace(/[.,;:\s]+$/u, '');
}

function extractYearOutsideIdentifiers(
  text: string,
  doi: string | undefined,
  arxiv: string | undefined,
): number | undefined {
  let scrubbed = text
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/10\.\d{4,9}\/\S+/gu, ' ')
    .replace(/\barxiv\s*:\s*\S+/giu, ' ');
  if (doi !== undefined) scrubbed = scrubbed.replaceAll(doi, ' ');
  if (arxiv !== undefined) scrubbed = scrubbed.replaceAll(arxiv, ' ');

  const match = new RegExp(YEAR_TOKEN_RE.source, 'u').exec(scrubbed);
  if (match?.[1] === undefined) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2099 ? parsed : undefined;
}

function extractAbstract(frontAndBody: readonly Block[]): string | undefined {
  const parts: string[] = [];
  let capturing = false;

  for (const block of frontAndBody) {
    const text = collapseSpace(block.raw);
    if (text.length === 0) continue;

    if (!capturing) {
      if (ABSTRACT_HEADING_RE.test(text)) {
        capturing = true;
        continue;
      }
      const inline = INLINE_ABSTRACT_RE.exec(text);
      if (inline?.[1] !== undefined) {
        const body = collapseSpace(inline[1]);
        if (body.length > 0) parts.push(body);
        capturing = true;
      }
      continue;
    }

    if (
      block.type === 'heading' ||
      KEYWORDS_LINE_RE.test(text) ||
      SECTION_NUMBER_HEADING_RE.test(text)
    ) {
      break;
    }
    if (block.type === 'footnote' || block.type === 'other') continue;
    parts.push(text);
  }

  if (parts.length === 0) return undefined;
  return collapseSpace(parts.join(' '));
}

function extractKeywords(
  frontAndBody: readonly Block[],
  pdfMetadata?: DocumentMetadata,
): string[] {
  for (const block of frontAndBody) {
    const text = collapseSpace(block.raw);
    const match = KEYWORDS_LINE_RE.exec(text);
    if (match?.[1] !== undefined) {
      const parsed = normaliseKeywords(match[1]);
      if (parsed.length > 0) return parsed;
    }
  }
  return [...(pdfMetadata?.keywords ?? [])];
}

// --- Bibliography / reference parser ---------------------------------------

function extractReferences(blocksAfterHeading: readonly Block[]): ExtractedReference[] {
  const rawItems: Array<{ marker?: string; raw: string }> = [];

  for (const block of blocksAfterHeading) {
    const collapsed = collapseSpace(block.raw);
    if (collapsed.length === 0) continue;
    if (block.type === 'heading' && APPENDIX_HEADING_RE.test(collapsed)) break;
    if (/^\d{1,4}$/u.test(collapsed)) continue;

    const lines = block.raw
      .split(/\r?\n/u)
      .map(line => collapseSpace(line))
      .filter(line => line.length > 0);

    const hasLineMarkers = lines.length > 1 && lines.some(line => REF_MARKER_START_RE.test(line));
    if (hasLineMarkers) {
      for (const line of lines) {
        const markerMatch = REF_MARKER_START_RE.exec(line);
        if (markerMatch?.[1] !== undefined && markerMatch[2] !== undefined) {
          rawItems.push({ marker: markerMatch[1], raw: markerMatch[2] });
        } else if (rawItems.length > 0) {
          const prev = rawItems[rawItems.length - 1];
          if (prev !== undefined) prev.raw = collapseSpace(`${prev.raw} ${line}`);
        } else {
          rawItems.push({ raw: line });
        }
      }
      continue;
    }

    const blockMarker = REF_MARKER_START_RE.exec(collapsed);
    if (blockMarker?.[1] !== undefined && blockMarker[2] !== undefined) {
      rawItems.push({ marker: blockMarker[1], raw: blockMarker[2] });
    } else {
      rawItems.push({ raw: collapsed });
    }
  }

  return rawItems.map((item, index) => parseSingleReference(index, item.raw, item.marker));
}

function parseSingleReference(
  index: number,
  raw: string,
  marker: string | undefined,
): ExtractedReference {
  const doi = normalizeDoi(raw) ?? undefined;
  let arxiv = arxivId(raw) ?? undefined;
  if (arxiv === undefined && doi !== undefined) {
    const match = ARXIV_DOI_RE.exec(doi);
    if (match?.[1] !== undefined) arxiv = arxivId(match[1]) ?? undefined;
  }

  const year = extractReferenceYear(raw, doi, arxiv);
  const scrubbed = scrubReferenceIdentifiers(raw);
  const parsedParts = splitReferenceParts(scrubbed);

  const ref: ExtractedReference = { index, raw };
  if (marker !== undefined) ref.marker = marker;
  if (parsedParts.title !== undefined) ref.title = parsedParts.title;
  if (parsedParts.authors !== undefined && parsedParts.authors.length > 0) {
    ref.authors = parsedParts.authors;
  }
  if (year !== undefined) ref.year = year;
  if (parsedParts.venue !== undefined) ref.venue = parsedParts.venue;
  if (doi !== undefined) ref.doi = doi;
  if (arxiv !== undefined) ref.arxiv = arxiv;
  return ref;
}

function extractReferenceYear(
  raw: string,
  doi: string | undefined,
  arxiv: string | undefined,
): number | undefined {
  const parenYear = /\(\s*(19\d{2}|20\d{2})[a-z]?\s*\)/u.exec(raw);
  if (parenYear?.[1] !== undefined) return Number(parenYear[1]);
  return extractYearOutsideIdentifiers(raw, doi, arxiv);
}

function scrubReferenceIdentifiers(raw: string): string {
  return collapseSpace(
    raw
      .replace(/https?:\/\/\S+/giu, ' ')
      .replace(/\bdoi\s*:\s*\S+/giu, ' ')
      .replace(/\barxiv\s*:\s*\S+/giu, ' '),
  ).replace(/[.,;\s]+$/u, '');
}

function splitReferenceParts(text: string): {
  authors?: string[];
  title?: string;
  venue?: string;
} {
  // Quoted title form: `A. Author and B. Author, "Title," Venue, 2019`
  const quoted = /["\u201c]([^"\u201d]{3,300})["\u201d]/u.exec(text);
  if (quoted?.[1] !== undefined && quoted.index !== undefined) {
    const before = collapseSpace(text.slice(0, quoted.index)).replace(/[,.\s]+$/u, '');
    const title = collapseSpace(quoted[1]).replace(/[,.\s]+$/u, '');
    const after = collapseSpace(text.slice(quoted.index + quoted[0].length))
      .replace(/^[,.\s]+/u, '')
      .replace(/^(?:in\s+)/iu, '')
      .replace(/,?\s*\b(?:19|20)\d{2}\b\.?$/u, '')
      .trim();
    const result: { authors?: string[]; title?: string; venue?: string } = { title };
    const authors = parseReferenceAuthors(before);
    if (authors.length > 0) result.authors = authors;
    if (after.length > 0) result.venue = after;
    return result;
  }

  // Author (Year). Title. Venue form
  const authorYear = /\(\s*(?:19|20)\d{2}[a-z]?\s*\)\.?\s*/u.exec(text);
  if (authorYear !== null && authorYear.index > 0) {
    const before = collapseSpace(text.slice(0, authorYear.index)).replace(/[,.\s]+$/u, '');
    const rest = collapseSpace(text.slice(authorYear.index + authorYear[0].length));
    const sentences = splitCitationSentences(rest);
    const title = sentences[0];
    const venue = sentences.slice(1).join('. ').trim();
    const result: { authors?: string[]; title?: string; venue?: string } = {};
    const authors = parseReferenceAuthors(before);
    if (authors.length > 0) result.authors = authors;
    if (title !== undefined && title.length > 0) result.title = title;
    if (venue.length > 0) result.venue = venue;
    return result;
  }

  // Sentence-delimited fallback: Authors. Title. Venue.
  const sentences = splitCitationSentences(text);
  if (sentences.length >= 2) {
    const result: { authors?: string[]; title?: string; venue?: string } = {};
    const authors = parseReferenceAuthors(sentences[0] ?? '');
    if (authors.length > 0) result.authors = authors;
    if (sentences[1] !== undefined && sentences[1].length > 0) result.title = sentences[1];
    const venue = sentences
      .slice(2)
      .join('. ')
      .replace(/,?\s*\b(?:19|20)\d{2}\b\.?$/u, '')
      .trim();
    if (venue.length > 0) result.venue = venue;
    return result;
  }

  return {};
}

function splitCitationSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch !== '.' && ch !== '?' && ch !== '!') continue;
    const next = text.charAt(i + 1);
    if (next.length > 0 && !/\s/u.test(next)) continue;

    const candidate = text.slice(start, i + 1).trim();
    if (ch === '.' && NON_SENTENCE_ABBREV_RE.test(candidate)) continue;

    const clean = candidate.replace(/\.$/u, '').trim();
    if (clean.length > 0) sentences.push(clean);
    start = i + 1;
  }

  const tail = text.slice(start).replace(/\.$/u, '').trim();
  if (tail.length > 0) sentences.push(tail);
  return sentences;
}

function parseReferenceAuthors(raw: string): string[] {
  const cleaned = collapseSpace(raw);
  if (cleaned.length === 0) return [];
  if (cleaned.includes(';')) {
    return cleaned.split(/;+/u).map(part => collapseSpace(part)).filter(Boolean);
  }
  const byAnd = cleaned
    .split(/\s*(?:,\s*(?:and|&)|(?:\s+(?:and|&)\s+))\s*/iu)
    .map(part => collapseSpace(part))
    .filter(Boolean);
  if (byAnd.length > 1) return byAnd;
  return [cleaned];
}

// --- Lookup construction ---------------------------------------------------

/**
 * Builds Crossref / Semantic Scholar lookup URLs through `scholar.ts` without guessing from titles.
 */
export function buildPaperLookups(
  paper: Partial<ExtractedPaperMetadata> | ExtractedReference,
): PaperLookupPlan {
  const doi = paper.doi !== undefined ? normalizeDoi(paper.doi) : null;
  const arxiv = paper.arxiv !== undefined ? arxivId(paper.arxiv) : null;

  if (doi !== null) {
    const primary = buildLookup(doi);
    const plan: PaperLookupPlan = {
      primary,
      canLookup: true,
    };
    if (arxiv !== null && primary.arxiv !== arxiv) {
      plan.fallbackArxiv = buildLookup(arxiv);
    }
    return plan;
  }

  if (arxiv !== null) {
    return {
      primary: buildLookup(arxiv),
      canLookup: true,
    };
  }

  return {
    primary: null,
    canLookup: false,
    reason: 'No DOI or arXiv identifier was extracted; ambiguous title-only search is disabled.',
  };
}

/** Builds `scholar.ts` lookups for every extracted reference carrying a DOI or arXiv id. */
export function buildReferenceLookups(
  references: readonly ExtractedReference[],
): ReferenceLookup[] {
  const lookups: ReferenceLookup[] = [];
  for (const ref of references) {
    const plan = buildPaperLookups(ref);
    if (plan.primary !== null) {
      lookups.push({ referenceIndex: ref.index, lookup: plan.primary });
    }
  }
  return lookups;
}

// --- Enrichment preview & review gate --------------------------------------

/** Converts locally extracted paper metadata into `scholar.ts`'s `PaperRecord`. */
export function extractedToPaperRecord(extracted: ExtractedPaperMetadata): PaperRecord {
  const record: PaperRecord = {
    title: extracted.title ?? 'Untitled',
    authors: [...extracted.authors],
  };
  if (extracted.doi !== undefined) record.doi = extracted.doi;
  if (extracted.arxiv !== undefined) record.arxiv = extracted.arxiv;
  if (extracted.venue !== undefined) record.venue = extracted.venue;
  if (extracted.year !== undefined) record.year = extracted.year;
  if (extracted.abstract !== undefined) record.abstract = extracted.abstract;
  if (extracted.references.length > 0) {
    record.references = extracted.references.map(ref => ref.title ?? ref.raw);
  }
  return record;
}

/**
 * Parses and merges Crossref / Semantic Scholar payloads via `scholar.ts` and constructs an
 * explicit field-by-field review preview before any library import is permitted.
 */
export function buildEnrichmentPreview(
  extracted: ExtractedPaperMetadata,
  enrichment: PaperEnrichmentInput,
): EnrichmentPreview {
  const crossrefRecord =
    enrichment.crossrefRecord ??
    (enrichment.crossref !== undefined ? parseCrossref(enrichment.crossref) : undefined);
  const semanticScholarRecord =
    enrichment.semanticScholarRecord ??
    (enrichment.semanticScholar !== undefined
      ? parseSemanticScholar(enrichment.semanticScholar)
      : undefined);

  const enrichedRecord = mergeExternalRecords(crossrefRecord, semanticScholarRecord);
  const localRecord = extractedToPaperRecord(extracted);
  const proposed = buildProposedRecord(localRecord, enrichedRecord);
  const changes = computeFieldChanges(extracted, localRecord, enrichedRecord, proposed);

  const summary: EnrichmentSummary = {
    added: changes.filter(item => item.status === 'added').length,
    updated: changes.filter(item => item.status === 'updated').length,
    unchanged: changes.filter(item => item.status === 'unchanged').length,
    conflicts: changes.filter(item => item.hasConflict).length,
  };

  return {
    extracted,
    localRecord,
    enrichedRecord,
    proposed,
    changes,
    summary,
    requiresReview: true,
    bibtexPreview: paperToBibTeX(proposed, extracted.keywords),
  };
}

function mergeExternalRecords(
  crossrefRecord: PaperRecord | undefined,
  semanticScholarRecord: PaperRecord | undefined,
): MergedRecord | null {
  if (crossrefRecord !== undefined && semanticScholarRecord !== undefined) {
    return mergeRecords(crossrefRecord, semanticScholarRecord);
  }
  const single = crossrefRecord ?? semanticScholarRecord;
  if (single === undefined) return null;
  return mergeRecords(single, { title: '', authors: [] });
}

function buildProposedRecord(
  localRecord: PaperRecord,
  enrichedRecord: MergedRecord | null,
): PaperRecord {
  if (enrichedRecord === null) {
    return { ...localRecord, authors: [...localRecord.authors] };
  }
  const merged = mergeRecords(enrichedRecord, localRecord);
  const proposed: PaperRecord = {
    title: merged.title,
    authors: [...merged.authors],
  };
  if (merged.doi !== undefined) proposed.doi = merged.doi;
  if (merged.arxiv !== undefined) proposed.arxiv = merged.arxiv;
  if (merged.venue !== undefined) proposed.venue = merged.venue;
  if (merged.year !== undefined) proposed.year = merged.year;
  if (merged.abstract !== undefined) proposed.abstract = merged.abstract;
  if (merged.citationCount !== undefined) proposed.citationCount = merged.citationCount;
  if (merged.references !== undefined) proposed.references = [...merged.references];
  return proposed;
}

function computeFieldChanges(
  extracted: ExtractedPaperMetadata,
  localRecord: PaperRecord,
  enrichedRecord: MergedRecord | null,
  proposed: PaperRecord,
): EnrichmentFieldChange[] {
  return PAPER_FIELDS.map(field => {
    const localValue = localFieldValue(extracted, localRecord, field);
    const enrichedValue = enrichedRecord?.[field];
    const proposedValue = proposed[field];
    const source: FieldSourceLabel =
      enrichedValue !== undefined && hasFieldValue(enrichedValue)
        ? (enrichedRecord?.sources[field] ?? 'left')
        : 'local';

    let status: ReviewFieldStatus = 'unchanged';
    let hasConflict = false;
    if (enrichedValue !== undefined && hasFieldValue(enrichedValue)) {
      if (!hasFieldValue(localValue)) {
        status = 'added';
      } else if (!valuesEqual(localValue, enrichedValue)) {
        status = 'updated';
        hasConflict = true;
      }
    }

    return {
      field,
      localValue,
      enrichedValue,
      proposedValue,
      source,
      status,
      hasConflict,
    };
  });
}

function localFieldValue<K extends PaperField>(
  extracted: ExtractedPaperMetadata,
  localRecord: PaperRecord,
  field: K,
): PaperRecord[K] | undefined {
  // Keep null/missing title distinguishable from the placeholder 'Untitled' on PaperRecord.
  if (field === 'title' && extracted.title === null) return undefined;
  return localRecord[field];
}

function hasFieldValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, idx) => item === right[idx]);
  }
  return left === right;
}

/**
 * Applies a reviewer's approval and optional per-field overrides to an `EnrichmentPreview`.
 *
 * Refuses with `PaperMetadataError('review-not-approved')` unless `decision.approved === true`.
 */
export function applyEnrichmentReview(
  preview: EnrichmentPreview,
  decision: EnrichmentReviewDecision,
): ApprovedPaperImport {
  if (decision?.approved !== true) {
    throw new PaperMetadataError(
      'review-not-approved',
      'Enrichment preview must be explicitly approved before importing into the library.',
    );
  }

  const choices = decision.fieldChoices ?? {};
  const pickedTitle = pickFieldValue(preview, choices, 'title');
  const pickedAuthors = pickFieldValue(preview, choices, 'authors');

  const resolved: PaperRecord = {
    title: typeof pickedTitle === 'string' && pickedTitle.length > 0 ? pickedTitle : preview.proposed.title,
    authors: Array.isArray(pickedAuthors) ? [...pickedAuthors] : [...preview.proposed.authors],
  };

  assignOptionalField(resolved, 'doi', pickFieldValue(preview, choices, 'doi'));
  assignOptionalField(resolved, 'arxiv', pickFieldValue(preview, choices, 'arxiv'));
  assignOptionalField(resolved, 'venue', pickFieldValue(preview, choices, 'venue'));
  assignOptionalField(resolved, 'year', pickFieldValue(preview, choices, 'year'));
  assignOptionalField(resolved, 'abstract', pickFieldValue(preview, choices, 'abstract'));
  assignOptionalField(resolved, 'citationCount', pickFieldValue(preview, choices, 'citationCount'));

  const pickedRefs = pickFieldValue(preview, choices, 'references');
  if (Array.isArray(pickedRefs)) resolved.references = [...pickedRefs];

  const entry = toBibTeXEntry(resolved);
  if (preview.extracted.keywords.length > 0 && entry.fields.keywords === undefined) {
    entry.fields.keywords = preview.extracted.keywords.join(', ');
  }

  return {
    record: resolved,
    entry,
    bibtex: toBibTeX([entry]),
    keywords: [...preview.extracted.keywords],
    references: [...preview.extracted.references],
  };
}

function pickFieldValue<K extends PaperField>(
  preview: EnrichmentPreview,
  choices: Partial<Record<PaperField, FieldChoice>>,
  field: K,
): PaperRecord[K] | undefined {
  const choice = choices[field];
  if (choice === undefined) return preview.proposed[field];
  const change = preview.changes.find(item => item.field === field);
  return (choice === 'local' ? change?.localValue : change?.enrichedValue) as
    | PaperRecord[K]
    | undefined;
}

function assignOptionalField<K extends 'doi' | 'arxiv' | 'venue' | 'year' | 'abstract' | 'citationCount'>(
  target: PaperRecord,
  key: K,
  value: PaperRecord[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

/** Creates an isolated, deterministic in-memory library of reviewed papers. */
export function createPaperLibrary(): PaperLibrary {
  const entries = new Map<string, ApprovedPaperImport>();
  return {
    list(): ApprovedPaperImport[] {
      return [...entries.values()];
    },
    get(key: string): ApprovedPaperImport | undefined {
      return entries.get(key);
    },
    has(key: string): boolean {
      return entries.has(key);
    },
    add(item: ApprovedPaperImport): void {
      entries.set(item.entry.key, item);
    },
  };
}

/**
 * Imports an enrichment preview into `library` only after verifying explicit reviewer approval.
 */
export function importReviewedPaper(
  library: PaperLibrary,
  preview: EnrichmentPreview,
  decision: EnrichmentReviewDecision,
): ApprovedPaperImport {
  const approved = applyEnrichmentReview(preview, decision);
  library.add(approved);
  return approved;
}

// --- BibTeX helpers --------------------------------------------------------

/** Emits canonical BibTeX for an `ExtractedPaperMetadata` or `PaperRecord`. */
export function paperToBibTeX(
  paper: ExtractedPaperMetadata | PaperRecord,
  keywords?: readonly string[],
): string {
  const record = isExtractedPaper(paper) ? extractedToPaperRecord(paper) : paper;
  const entry = toBibTeXEntry(record);
  const kw = keywords ?? (isExtractedPaper(paper) ? paper.keywords : undefined);
  if (kw !== undefined && kw.length > 0 && entry.fields.keywords === undefined) {
    entry.fields.keywords = kw.join(', ');
  }
  return toBibTeX([entry]);
}

function isExtractedPaper(
  value: ExtractedPaperMetadata | PaperRecord,
): value is ExtractedPaperMetadata {
  return 'keywords' in value;
}

/** Converts parsed bibliography references into key-disambiguated canonical BibTeX. */
export function referencesToBibTeX(references: readonly ExtractedReference[]): string {
  const rawEntries: Entry[] = references.map(ref => {
    const record: PaperRecord = {
      title: ref.title ?? ref.raw,
      authors: ref.authors ?? [],
    };
    if (ref.venue !== undefined) record.venue = ref.venue;
    if (ref.year !== undefined) record.year = ref.year;
    if (ref.doi !== undefined) record.doi = ref.doi;
    if (ref.arxiv !== undefined) record.arxiv = ref.arxiv;
    return toBibTeXEntry(record);
  });

  const keys = stableKeys(rawEntries);
  const entries = rawEntries.map((entry, idx) => ({
    ...entry,
    key: keys[idx] ?? entry.key,
  }));
  return toBibTeX(entries);
}

// --- Small text helpers ----------------------------------------------------

function collapseSpace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function wordCount(text: string): number {
  const trimmed = collapseSpace(text);
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/u).length;
}
