/**
 * DOI and metadata resolution (backlog J04).
 *
 * A paper arrives as a PDF with nothing but ink: no DOI, no venue, no author list.
 * This module is the part of resolution that can be trusted without a network — the
 * identifier a caller already holds, the two API requests that would settle the rest,
 * and the normalisation of the JSON those APIs answer with.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no I/O. Nothing here fetches a
 *   URL. A caller owns the request and hands the parsed body back to this module, so
 *   the same payload always produces the same record.
 * - Metadata only. No path here downloads a paper; the output is what a citation
 *   needs, and the caller decides what is lawful to fetch (backlog J04).
 * - An identifier is only returned when it validates. `normalizeDoi` and `arxivId`
 *   return `null` for text that names neither, and `buildLookup` refuses a query that
 *   is neither rather than building a request the API would answer with an error.
 * - A DOI's registration prefix (`10.NNNN`) is lowercased; the suffix keeps the case
 *   it arrived with, because DOIs are case-insensitive but the suffix is what a reader
 *   recognises. `normalizeDoi` also strips the resolver, the `doi:` label, brackets
 *   around the identifier and the punctuation a sentence leaves on its tail, so
 *   `(doi: 10.1000/ABC).` and `https://doi.org/10.1000/ABC` agree.
 * - Parsing never guesses. A field the payload does not carry stays `undefined`, a
 *   `null` and an empty string count as absent, and a field of the wrong type is a
 *   malformed payload: {@link ScholarError} names the JSON path (`message.title[0]`)
 *   instead of dropping the value. A value of the right type that does not validate —
 *   a DOI that is not a DOI, a year that is not a year — is dropped rather than
 *   repaired.
 * - Merging prefers whichever record carries a field and records, per field, which
 *   record that was. The left record wins a field both carry.
 */

import type { Entry } from './bibtex';
import { stableKey } from './bibtex';

/** The APIs whose payloads this module can read. */
export type PaperSource = 'crossref' | 'semanticscholar';

/** Which argument a merged field came from, used when a record names no source. */
export type MergeSide = 'left' | 'right';

/** Where a merged field came from: the API that supplied it, or its argument side. */
export type SourceLabel = PaperSource | MergeSide;

/**
 * Every bibliographic field a record can carry. `source` is provenance rather than a
 * bibliographic field and is not one of these; a merged record keys `sources` by these
 * names.
 */
export const PAPER_FIELDS = [
  'doi',
  'arxiv',
  'title',
  'authors',
  'venue',
  'year',
  'abstract',
  'citationCount',
  'references',
] as const;

export type PaperField = (typeof PAPER_FIELDS)[number];

/**
 * One work, as far as the metadata APIs agree on it.
 *
 * `title` and `authors` are always present: a work with no title cannot be cited, and
 * an empty author list is a fact about the record rather than a missing field. Every
 * other field is optional and stays `undefined` when the payload did not carry it.
 */
export interface PaperRecord {
  /** Canonical DOI (see `normalizeDoi`), without a resolver prefix. */
  doi?: string;
  /** arXiv id without the `arXiv:` label and without a version suffix. */
  arxiv?: string;
  title: string;
  /** Display names in payload order; `Given Family` when both parts are known. */
  authors: string[];
  /** Journal, proceedings or repository name the payload gives as the container. */
  venue?: string;
  /** Four-digit publication year. */
  year?: number;
  /** Abstract as plain text: markup removed, entities decoded, whitespace collapsed. */
  abstract?: string;
  /** Citation count the API reported, as of the response. */
  citationCount?: number;
  /** References the payload lists, as the most specific text each one carries. */
  references?: string[];
  /** API the record was parsed from; absent on a record a caller built by hand. */
  source?: PaperSource;
}

/** Two records folded into one, with the provenance of every field it carries. */
export interface MergedRecord extends PaperRecord {
  /** Per field, the label of the record the value came from. Absent fields have no entry. */
  sources: Partial<Record<PaperField, SourceLabel>>;
}

export type ScholarErrorCode =
  /** The query names neither a DOI nor an arXiv id, so there is nothing to look up. */
  | 'unidentifiable-query'
  /** The payload does not have the shape the API documents. */
  | 'malformed-payload';

/**
 * A query or payload this module cannot use as written. `path` is the JSON path of the
 * offending member (`message.author[1].family`), or `query` for a lookup, and the
 * message repeats it.
 */
export class ScholarError extends Error {
  readonly code: ScholarErrorCode;
  readonly path: string;

  constructor(code: ScholarErrorCode, path: string, message: string) {
    super(message);
    this.name = 'ScholarError';
    this.code = code;
    this.path = path;
  }
}

// --- Identifiers -----------------------------------------------------------

/** Crossref's works endpoint; the DOI is the remaining path segment. */
const CROSSREF_WORKS = 'https://api.crossref.org/works';

/** Semantic Scholar's paper endpoint; `DOI:` or `ARXIV:` and the id complete it. */
const SEMANTIC_SCHOLAR_PAPER = 'https://api.semanticscholar.org/graph/v1/paper';

/**
 * The fields requested from Semantic Scholar.
 *
 * `externalIds` carries the DOI and the arXiv id the API knows beyond the one the
 * request was keyed by, and `references.title` is the only way to get reference text:
 * a bare `references` returns ids and counts with no titles.
 */
export const SEMANTIC_SCHOLAR_FIELDS =
  'title,authors,venue,year,abstract,citationCount,externalIds,references.title';

/**
 * One DOI candidate: `10.NNNN/suffix`, with the preceding character required so a
 * glued-on word or number cannot pass for a prefix (`x10.1000/a`, `110.1000/a`).
 */
const DOI_SCAN_SOURCE = String.raw`(?:^|[^\p{L}\p{N}_.])(10\.\d{4,9}\/[^\s]+)`;

/** A closing bracket that a sentence or a link left on the tail of a DOI. */
const CLOSING_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' };

/** Trailing punctuation that belongs to the sentence rather than to the DOI. */
const TRAILING_PUNCTUATION = /[.,;:'"`]/u;

/** arXiv's post-2015 id shape: `YYMM.NNNN` or `YYMM.NNNNN`, month 01-12. */
const ARXIV_NEW_SOURCE = String.raw`\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}`;

/** arXiv's pre-2015 id shape: `archive.CATEGORY/NNNNNNN`, e.g. `hep-th/9901001`. */
const ARXIV_OLD_SOURCE = String.raw`[a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7}`;

/** Either id shape, without a version suffix. */
const ARXIV_ID_SOURCE = String.raw`(?:${ARXIV_NEW_SOURCE}|${ARXIV_OLD_SOURCE})`;

/**
 * End of an id: not followed by more digits or by a letter, and not by a dotted
 * continuation. This is what keeps `arXiv:2401.123456` from reading as `2401.12345`
 * and `2401.12345v2x` from reading as `2401.12345`, while `...v3.pdf` still ends at
 * the id.
 */
const ARXIV_END_SOURCE = String.raw`(?![\p{L}\p{N}])(?!\.\d)`;

/** `arXiv:2401.12345v2` or `arxiv.org/abs/2401.12345`; the label is dropped. */
const ARXIV_NAMED = new RegExp(
  String.raw`(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/)(${ARXIV_ID_SOURCE})(?:v\d+)?${ARXIV_END_SOURCE}`,
  'iu',
);

/** A whole string that is nothing but an id, optionally versioned. */
const ARXIV_BARE = new RegExp(String.raw`^(${ARXIV_ID_SOURCE})(?:v\d+)?$`, 'u');

/** The DataCite DOI prefix arXiv assigns: `10.48550/arXiv.2401.12345`. */
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/iu;

/**
 * Canonical DOI for the first DOI-shaped run of text in `raw`, or `null`.
 *
 * Accepts a bare DOI, a `doi.org` or `dx.doi.org` URL (either scheme, any host case),
 * a `doi:` label, a DOI in brackets, and a DOI inside a sentence. The first candidate
 * that validates wins, so a sentence naming one DOI resolves to it; the tail
 * punctuation and any unbalanced closing bracket are removed before validation, and
 * the registration prefix is lowercased. The suffix is compared case-insensitively by
 * every resolver, so its case is left exactly as written.
 */
export function normalizeDoi(raw: string): string | null {
  const text = typeof raw === 'string' ? raw : '';
  if (text.length === 0) return null;

  // A `g` regex carries `lastIndex` state, so each scan gets its own instance.
  const scan = new RegExp(DOI_SCAN_SOURCE, 'gu');
  for (const match of text.matchAll(scan)) {
    const candidate = match[1];
    if (candidate === undefined) continue;
    const doi = canonicalDoi(candidate);
    if (doi !== null) return doi;
  }
  return null;
}

/** Re-validates one DOI candidate and lowercases its prefix. */
function canonicalDoi(candidate: string): string | null {
  const trimmed = trimDoiTail(candidate);
  const slash = trimmed.indexOf('/');
  if (slash === -1) return null;

  const prefix = trimmed.slice(0, slash);
  const suffix = trimmed.slice(slash + 1);
  if (!/^10\.\d{4,9}$/u.test(prefix)) return null;
  if (suffix.length === 0) return null;

  return `${prefix.toLowerCase()}/${suffix}`;
}

/**
 * Removes the punctuation a sentence, a bracket or a link left on a DOI's tail.
 *
 * Only a closing bracket the DOI does not itself open is removed, so a suffix that
 * legitimately carries one — `...(199706)...` in a SICI DOI — survives.
 */
function trimDoiTail(value: string): string {
  let text = value;
  for (;;) {
    const last = text.charAt(text.length - 1);
    if (last.length === 0) return text;

    if (TRAILING_PUNCTUATION.test(last)) {
      text = text.slice(0, -1);
      continue;
    }

    const opener = CLOSING_BRACKETS[last];
    if (opener === undefined) return text;
    if (countChar(text, opener) >= countChar(text, last)) return text;
    text = text.slice(0, -1);
  }
}

function countChar(text: string, char: string): number {
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) === char) total++;
  }
  return total;
}

/**
 * arXiv id named by `raw`, without the version suffix, or `null`.
 *
 * Accepts `arXiv:2401.12345v2`, an `arxiv.org/abs/...` or `arxiv.org/pdf/...` URL, and
 * a bare id. The pre-2015 shape (`hep-th/9901001`) is accepted too, because those are
 * exactly the papers whose metadata is hardest to find by hand. A bare id must be the
 * whole string: text around it needs the `arXiv:` label or a URL, so `PDF 2401.12345`
 * is not silently read as an id.
 */
export function arxivId(raw: string): string | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return null;

  const named = ARXIV_NAMED.exec(text);
  const fromNamed = named?.[1];
  if (fromNamed !== undefined) return fromNamed;

  const bare = ARXIV_BARE.exec(text);
  return bare?.[1] ?? null;
}

/** arXiv id a DataCite DOI stands for, when the DOI is the arXiv one. */
function arxivFromDoi(doi: string): string | undefined {
  const match = ARXIV_DOI.exec(doi);
  const suffix = match?.[1];
  return suffix === undefined ? undefined : arxivId(suffix) ?? undefined;
}

// --- Requests --------------------------------------------------------------

/**
 * The requests that would settle one paper's metadata.
 *
 * `crossref` is absent for an arXiv-only query: `10.48550/arXiv.<id>` is the DOI
 * arXiv assigns, but it is registered with DataCite, so `api.crossref.org` does not
 * answer for it and building the URL would produce a request guaranteed to fail.
 */
export interface Lookup {
  /** Which identifier the query produced. */
  kind: 'doi' | 'arxiv';
  /** Canonical DOI, when the query named one. */
  doi?: string;
  /** arXiv id, when the query named one. */
  arxiv?: string;
  /** Crossref works URL; absent when the query has no DOI. */
  crossref?: string;
  /** Semantic Scholar graph URL, keyed by whichever identifier the query produced. */
  semanticScholar: string;
}

/**
 * Builds the metadata requests for a query.
 *
 * A DOI is looked up by DOI at both APIs; an arXiv id is keyed `ARXIV:<id>` at
 * Semantic Scholar alone. Anything else is refused with `unidentifiable-query`: there
 * is no search-by-title path here, because a title search returns a ranked guess and
 * this module does not guess. Path characters that would truncate or split the URL
 * (a SICI DOI's `(`, `;`, `<`) are percent-encoded; `/` and `:` are kept, which is how
 * both APIs document their examples.
 */
export function buildLookup(query: string): Lookup {
  const text = typeof query === 'string' ? query.trim() : '';
  const doi = normalizeDoi(text);
  if (doi !== null) {
    const lookup: Lookup = {
      kind: 'doi',
      doi,
      crossref: `${CROSSREF_WORKS}/${encodeIdentifier(doi)}`,
      semanticScholar: `${SEMANTIC_SCHOLAR_PAPER}/DOI:${encodeIdentifier(doi)}?fields=${SEMANTIC_SCHOLAR_FIELDS}`,
    };
    const arxiv = arxivFromDoi(doi);
    if (arxiv !== undefined) lookup.arxiv = arxiv;
    return lookup;
  }

  const arxiv = arxivId(text);
  if (arxiv !== null) {
    return {
      kind: 'arxiv',
      arxiv,
      semanticScholar: `${SEMANTIC_SCHOLAR_PAPER}/ARXIV:${encodeIdentifier(arxiv)}?fields=${SEMANTIC_SCHOLAR_FIELDS}`,
    };
  }

  const shown = text.length === 0 ? 'An empty query' : `\`${preview(text)}\``;
  throw new ScholarError(
    'unidentifiable-query',
    'query',
    `${shown} is neither a DOI nor an arXiv id, so there is nothing to look up.`,
  );
}

/** Characters that may appear unescaped in the path segment of a metadata request. */
const URL_SAFE_IDENTIFIER = /[A-Za-z0-9\-._~/:]/u;

/**
 * The five characters `encodeURIComponent` leaves alone for historical reasons. A
 * path segment a server will parse should not rely on that, so they are escaped too.
 */
const COMPONENT_LEFTOVERS = /[!'()*]/gu;

/** Percent-encodes everything a URL path cannot carry, keeping `/` and `:` readable. */
function encodeIdentifier(value: string): string {
  let encoded = '';
  for (const character of value) {
    encoded += URL_SAFE_IDENTIFIER.test(character) ? character : escapeCharacter(character);
  }
  return encoded;
}

/** Percent-encodes one character, including the ones `encodeURIComponent` leaves bare. */
function escapeCharacter(character: string): string {
  let escaped: string;
  try {
    escaped = encodeURIComponent(character);
  } catch {
    // A lone surrogate cannot survive UTF-8; U+FFFD is the honest replacement and
    // keeps a malformed string from throwing out of URL construction.
    return '%EF%BF%BD';
  }
  return escaped.replace(COMPONENT_LEFTOVERS, match => {
    const code = match.charCodeAt(0);
    return `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
  });
}

/** A short, single-line form of a query for an error message. */
function preview(text: string): string {
  const flattened = text.replace(/\s+/gu, ' ').trim();
  return flattened.length > 60 ? `${flattened.slice(0, 57)}...` : flattened;
}

// --- Crossref --------------------------------------------------------------

/**
 * Reads one Crossref `/works/{doi}` response.
 *
 * The payload is the whole HTTP body: the work sits under `message`, and a body
 * without that object is malformed rather than an empty record. `title` is required —
 * a work with no title at all cannot be cited — while every other field is read when
 * the payload carries it and left `undefined` when it does not.
 *
 * Only `issued` is read for the year, `container-title` for the venue, and `author`
 * for the names; readings that this module would have to reconcile (`published-print`,
 * `editor`, `publisher`) are deliberately not consulted, so a record never claims more
 * than one field of the payload says.
 *
 * @throws {ScholarError} `malformed-payload`, naming the JSON path, when the body is
 * not an object, has no `message` object, has no title, or carries a member of the
 * wrong type.
 */
export function parseCrossref(json: unknown): PaperRecord {
  const response = asObject(json, '');
  const message = readObject(response, 'message', 'message');
  if (message === undefined) {
    throw new ScholarError(
      'malformed-payload',
      'message',
      'A Crossref response carries the work at `message`, and this payload has no such object.',
    );
  }

  const title = readFirstText(message, 'title', 'message.title');
  if (title === undefined) {
    throw new ScholarError(
      'malformed-payload',
      'message.title',
      'A Crossref work without a title at `message.title` cannot be cited.',
    );
  }

  const record: PaperRecord = {
    title,
    authors: crossrefAuthors(message),
    source: 'crossref',
  };

  const rawDoi = readText(message, 'DOI', 'message.DOI');
  if (rawDoi !== undefined) {
    const doi = normalizeDoi(rawDoi);
    if (doi !== null) {
      record.doi = doi;
      const arxiv = arxivFromDoi(doi);
      if (arxiv !== undefined) record.arxiv = arxiv;
    }
  }

  const venue = readFirstText(message, 'container-title', 'message.container-title');
  if (venue !== undefined) record.venue = venue;

  const year = crossrefYear(message);
  if (year !== undefined) record.year = year;

  const abstract = readText(message, 'abstract', 'message.abstract');
  if (abstract !== undefined) record.abstract = abstract;

  const citationCount = readCount(message, 'is-referenced-by-count', 'message.is-referenced-by-count');
  if (citationCount !== undefined) record.citationCount = citationCount;

  const references = crossrefReferences(message);
  if (references !== undefined) record.references = references;

  return record;
}

/** Display names from Crossref `author`, in payload order. */
function crossrefAuthors(message: JsonObject): string[] {
  const list = readArray(message, 'author', 'message.author');
  if (list === undefined) return [];

  const authors: string[] = [];
  list.forEach((item, index) => {
    if (item === undefined || item === null) return;
    const path = `message.author[${index}]`;
    const author = asObject(item, path);

    const family = readText(author, 'family', `${path}.family`);
    const given = readText(author, 'given', `${path}.given`);
    const name = readText(author, 'name', `${path}.name`);

    let display: string | undefined;
    if (family !== undefined) display = given === undefined ? family : `${given} ${family}`;
    else display = name;
    if (display !== undefined) authors.push(display);
  });
  return authors;
}

/** Year from Crossref `issued.date-parts`, the date the work was published. */
function crossrefYear(message: JsonObject): number | undefined {
  const issued = readObject(message, 'issued', 'message.issued');
  if (issued === undefined) return undefined;

  const parts = readArray(issued, 'date-parts', 'message.issued.date-parts');
  const first = parts?.[0];
  if (first === undefined || first === null) return undefined;
  if (!Array.isArray(first)) {
    throw new ScholarError(
      'malformed-payload',
      'message.issued.date-parts[0]',
      `A Crossref date is an array of parts, and \`message.issued.date-parts[0]\` is ${typeName(first)}.`,
    );
  }

  const value = first[0];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new ScholarError(
      'malformed-payload',
      'message.issued.date-parts[0][0]',
      `A year is a number, and \`message.issued.date-parts[0][0]\` is ${typeName(value)}.`,
    );
  }
  return wholeYear(value);
}

/** Reference text from Crossref `reference`, one string per entry that names anything. */
function crossrefReferences(message: JsonObject): string[] | undefined {
  const list = readArray(message, 'reference', 'message.reference');
  if (list === undefined) return undefined;

  const references: string[] = [];
  list.forEach((item, index) => {
    if (item === undefined || item === null) return;
    const path = `message.reference[${index}]`;

    if (typeof item === 'string') {
      const text = cleanText(item);
      if (text.length > 0) references.push(text);
      return;
    }

    const reference = asObject(item, path);
    const unstructured = readText(reference, 'unstructured', `${path}.unstructured`);
    if (unstructured !== undefined) {
      references.push(unstructured);
      return;
    }

    const title =
      readText(reference, 'article-title', `${path}.article-title`) ??
      readText(reference, 'volume-title', `${path}.volume-title`);
    if (title !== undefined) {
      references.push(title);
      return;
    }

    const rawDoi = readText(reference, 'DOI', `${path}.DOI`);
    if (rawDoi !== undefined) references.push(normalizeDoi(rawDoi) ?? rawDoi);
  });

  return references.length > 0 ? references : undefined;
}

// --- Semantic Scholar ------------------------------------------------------

/**
 * Reads one Semantic Scholar `/graph/v1/paper/{id}` response.
 *
 * Semantic Scholar fills an unknown member with `null` instead of omitting it, so
 * `null` is read as absent everywhere. `title` is required; `authors` is read as the
 * list of names the API gives, and a reference without a title contributes nothing
 * because the request asks for `references.title` and that is all it can carry.
 *
 * @throws {ScholarError} `malformed-payload`, naming the JSON path, when the body is
 * not an object, has no title, or carries a member of the wrong type.
 */
export function parseSemanticScholar(json: unknown): PaperRecord {
  const response = asObject(json, '');

  const title = readText(response, 'title', 'title');
  if (title === undefined) {
    throw new ScholarError(
      'malformed-payload',
      'title',
      'A Semantic Scholar paper without a title at `title` cannot be cited.',
    );
  }

  const record: PaperRecord = {
    title,
    authors: semanticScholarAuthors(response),
    source: 'semanticscholar',
  };

  const venue = readText(response, 'venue', 'venue');
  if (venue !== undefined) record.venue = venue;

  const year = readCount(response, 'year', 'year');
  if (year !== undefined) {
    const whole = wholeYear(year);
    if (whole !== undefined) record.year = whole;
  }

  const abstract = readText(response, 'abstract', 'abstract');
  if (abstract !== undefined) record.abstract = abstract;

  const citationCount = readCount(response, 'citationCount', 'citationCount');
  if (citationCount !== undefined) record.citationCount = citationCount;

  const external = readObject(response, 'externalIds', 'externalIds');
  if (external !== undefined) {
    const rawDoi = readText(external, 'DOI', 'externalIds.DOI');
    if (rawDoi !== undefined) {
      const doi = normalizeDoi(rawDoi);
      if (doi !== null) record.doi = doi;
    }

    const rawArxiv = readText(external, 'ArXiv', 'externalIds.ArXiv');
    if (rawArxiv !== undefined) {
      const arxiv = arxivId(rawArxiv);
      if (arxiv !== null) record.arxiv = arxiv;
    }
  }

  const references = semanticScholarReferences(response);
  if (references !== undefined) record.references = references;

  return record;
}

/** Author names from Semantic Scholar `authors`, in payload order. */
function semanticScholarAuthors(response: JsonObject): string[] {
  const list = readArray(response, 'authors', 'authors');
  if (list === undefined) return [];

  const authors: string[] = [];
  list.forEach((item, index) => {
    if (item === undefined || item === null) return;
    const path = `authors[${index}]`;
    const author = asObject(item, path);
    const name = readText(author, 'name', `${path}.name`);
    if (name !== undefined) authors.push(name);
  });
  return authors;
}

/** Reference titles from Semantic Scholar `references`; an entry with no title is skipped. */
function semanticScholarReferences(response: JsonObject): string[] | undefined {
  const list = readArray(response, 'references', 'references');
  if (list === undefined) return undefined;

  const references: string[] = [];
  list.forEach((item, index) => {
    if (item === undefined || item === null) return;
    const path = `references[${index}]`;
    const reference = asObject(item, path);
    const title = readText(reference, 'title', `${path}.title`);
    if (title !== undefined) references.push(title);
  });

  return references.length > 0 ? references : undefined;
}

// --- Merging ---------------------------------------------------------------

/**
 * Folds two records into one, preferring whichever carries a field.
 *
 * Every field of the merged record is recorded in `sources` under the label of the
 * record it came from: the record's own `source` when it has one, otherwise `left` or
 * `right`. A field both records carry takes the left value; a field that is empty
 * (`''`, `[]`, `null`) counts as absent, so a Semantic Scholar record that reports no
 * venue never wins a field that Crossref filled. A field neither record carries stays
 * `undefined` and gets no entry in `sources`.
 *
 * Input records are not modified, and arrays are copied, so merging never aliases the
 * lists it read.
 */
export function mergeRecords(left: PaperRecord, right: PaperRecord): MergedRecord {
  const sources: Partial<Record<PaperField, SourceLabel>> = {};
  const merged: MergedRecord = { title: '', authors: [], sources };

  const take = <T>(field: PaperField, leftValue: T | undefined, rightValue: T | undefined): T | undefined => {
    if (present(leftValue)) {
      sources[field] = labelOf(left, 'left');
      return leftValue;
    }
    if (present(rightValue)) {
      sources[field] = labelOf(right, 'right');
      return rightValue;
    }
    return undefined;
  };

  merged.title = take('title', left.title, right.title) ?? '';
  merged.authors = [...(take('authors', left.authors, right.authors) ?? [])];

  const doi = take('doi', left.doi, right.doi);
  if (doi !== undefined) merged.doi = doi;

  const arxiv = take('arxiv', left.arxiv, right.arxiv);
  if (arxiv !== undefined) merged.arxiv = arxiv;

  const venue = take('venue', left.venue, right.venue);
  if (venue !== undefined) merged.venue = venue;

  const year = take('year', left.year, right.year);
  if (year !== undefined) merged.year = year;

  const abstract = take('abstract', left.abstract, right.abstract);
  if (abstract !== undefined) merged.abstract = abstract;

  const citationCount = take('citationCount', left.citationCount, right.citationCount);
  if (citationCount !== undefined) merged.citationCount = citationCount;

  const references = take('references', left.references, right.references);
  if (references !== undefined) merged.references = [...references];

  return merged;
}

/** Label recorded for a record: its own source, or its side of the merge. */
function labelOf(record: PaperRecord, side: MergeSide): SourceLabel {
  const source = record?.source;
  return source === 'crossref' || source === 'semanticscholar' ? source : side;
}

/** True when a value carries information rather than an empty slot. */
function present<T>(value: T | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

// --- BibTeX ----------------------------------------------------------------

/**
 * Turns a record into the entry `bibtex.ts` writes.
 *
 * The only fields written are the ones a citation renders plus the identifiers:
 * author, title, journal (from the venue), year, doi, the arXiv `eprint`, and the
 * abstract. The entry type is `article` when the record names a venue and `misc`
 * otherwise — `PaperRecord` carries no work type, and a record with a container is
 * the case BibTeX's `article` describes.
 *
 * The key comes from `stableKey`, so the same record always yields the same key. Two
 * records that share an author, a year and a first title word share it too; a caller
 * assembling a bibliography passes the entries through `stableKeys` to get the letter
 * suffixes that keep them apart.
 */
export function toBibTeXEntry(record: PaperRecord): Entry {
  const fields: Record<string, string> = {};
  const authors = Array.isArray(record.authors) ? record.authors : [];

  if (authors.length > 0) fields.author = authors.join(' and ');

  const title = typeof record.title === 'string' ? record.title : '';
  if (title.length > 0) fields.title = title;
  if (record.venue !== undefined && record.venue.length > 0) fields.journal = record.venue;
  if (record.year !== undefined) fields.year = String(record.year);
  if (record.doi !== undefined) fields.doi = record.doi;

  if (record.arxiv !== undefined) {
    fields.eprint = record.arxiv;
    fields.archiveprefix = 'arXiv';
  }
  if (record.abstract !== undefined) fields.abstract = record.abstract;

  const entry: Entry = {
    type: record.venue !== undefined && record.venue.length > 0 ? 'article' : 'misc',
    key: '',
    fields,
  };
  entry.key = stableKey(entry);
  return entry;
}

// --- Payload reading -------------------------------------------------------

/** A JSON object being read; the payloads are untrusted, so members stay `unknown`. */
type JsonObject = Record<string, unknown>;

/** Reads a member that must be an object, or `undefined` when the payload omits it. */
function readObject(container: JsonObject, key: string, path: string): JsonObject | undefined {
  const value = container[key];
  if (value === undefined || value === null) return undefined;
  return asObject(value, path);
}

function asObject(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScholarError(
      'malformed-payload',
      path,
      `Expected a JSON object at ${where(path)}, found ${typeName(value)}.`,
    );
  }
  return value as JsonObject;
}

/** Reads a member that must be an array, or `undefined` when the payload omits it. */
function readArray(container: JsonObject, key: string, path: string): unknown[] | undefined {
  const value = container[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ScholarError(
      'malformed-payload',
      path,
      `Expected a JSON array at ${where(path)}, found ${typeName(value)}.`,
    );
  }
  return value;
}

/** Reads a string member, trimmed; `null`, absent and empty all read as `undefined`. */
function readString(container: JsonObject, key: string, path: string): string | undefined {
  const value = container[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ScholarError(
      'malformed-payload',
      path,
      `Expected a string at ${where(path)}, found ${typeName(value)}.`,
    );
  }
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

/** Reads a text member and normalises it: markup removed, entities decoded, collapsed. */
function readText(container: JsonObject, key: string, path: string): string | undefined {
  const raw = readString(container, key, path);
  if (raw === undefined) return undefined;
  const text = cleanText(raw);
  return text.length > 0 ? text : undefined;
}

/**
 * Reads a member that holds text either as a string or as the array of strings
 * Crossref uses for `title` and `container-title`; the first non-empty element wins.
 */
function readFirstText(container: JsonObject, key: string, path: string): string | undefined {
  const value = container[key];
  if (value === undefined || value === null) return undefined;

  if (typeof value === 'string') {
    const text = cleanText(value);
    return text.length > 0 ? text : undefined;
  }
  if (!Array.isArray(value)) {
    throw new ScholarError(
      'malformed-payload',
      path,
      `Expected text or an array of text at ${where(path)}, found ${typeName(value)}.`,
    );
  }

  for (const [index, item] of value.entries()) {
    if (item === undefined || item === null) continue;
    if (typeof item !== 'string') {
      throw new ScholarError(
        'malformed-payload',
        `${path}[${index}]`,
        `Expected a string at \`${path}[${index}]\`, found ${typeName(item)}.`,
      );
    }
    const text = cleanText(item);
    if (text.length > 0) return text;
  }
  return undefined;
}

/** Reads a member that must be a number, accepting the numeric string some feeds send. */
function readNumber(container: JsonObject, key: string, path: string): number | undefined {
  const value = container[key];
  if (value === undefined || value === null) return undefined;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ScholarError(
        'malformed-payload',
        path,
        `Expected a finite number at ${where(path)}, found ${String(value)}.`,
      );
    }
    return value;
  }
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value.trim())) return Number(value.trim());

  throw new ScholarError(
    'malformed-payload',
    path,
    `Expected a number at ${where(path)}, found ${typeName(value)}.`,
  );
}

/** Reads a non-negative integer count, dropping a value that is not a count. */
function readCount(container: JsonObject, key: string, path: string): number | undefined {
  const value = readNumber(container, key, path);
  if (value === undefined) return undefined;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A four-digit publication year from a number or a numeric string. */
function wholeYear(value: number | string): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= 9999 ? value : undefined;
  }
  const text = value.trim();
  return /^\d{4}$/u.test(text) ? Number(text) : undefined;
}

// --- Text ------------------------------------------------------------------

/** A JATS abstract often starts with its own `Abstract` heading; it is not content. */
const JATS_TITLE = /<jats:title>[\s\S]{0,300}?<\/jats:title>/giu;

/** Markup in an otherwise plain value; Crossref sends JATS and inline HTML. */
const TAG = /<[^<>]{0,200}>/gu;

/** Markup entities Crossref and Semantic Scholar send. */
const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/gu;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * A payload string as readable text: the abstract's own heading and every tag
 * removed, entities decoded and runs of whitespace collapsed to one space.
 *
 * Tag removal runs before decoding, so an encoded `&lt;i&gt;` in a title stays the
 * literal text it was written to be. A math comparison such as `x < y` is not markup
 * (there is no closing `>` on the same run) and is left alone.
 */
function cleanText(value: string): string {
  const stripped = value.replace(JATS_TITLE, ' ').replace(TAG, ' ');
  return decodeEntities(stripped).replace(/\s+/gu, ' ').trim();
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole: string, body: string) => {
    if (body.length > 1 && (body.charAt(0) === '#')) {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const codePoint = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      const decoded = codePointText(codePoint);
      return decoded ?? whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** The character a code point names, or `null` when it names none. */
function codePointText(codePoint: number): string | null {
  if (!Number.isInteger(codePoint)) return null;
  if (codePoint < 0 || codePoint > 0x10ffff) return null;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}

/** How a value is referred to in a diagnostic. */
function typeName(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'boolean') return 'a boolean';
  return typeof value;
}

/** A JSON path as a sentence fragment; the response root has no name. */
function where(path: string): string {
  return path.length === 0 ? 'the response root' : `\`${path}\``;
}
