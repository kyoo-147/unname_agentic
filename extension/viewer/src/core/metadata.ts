/**
 * Document metadata: the title, authors, dates, language and producer a reader shows
 * above the first page (backlog item E14).
 *
 * A PDF states that information twice: in the document information dictionary
 * (`/Info`, an ordinary dictionary the trailer points at) and in the XMP packet. This
 * module reads the dictionary only, because it is what almost every producer writes and
 * what survives a round trip through older tools; the XMP packet is a separate job.
 *
 * Two entry points, kept apart on purpose:
 *
 * - {@link parseInfoDict} finds the dictionary in the bytes and decodes its fields. It is
 *   a **heuristic byte scan, not a PDF parser**: it does not follow the cross-reference
 *   table, does not inflate object streams and does not verify the file. See the limits
 *   below before trusting a field.
 * - {@link readMetadata} joins that decode with the catalog's `/Lang` and the
 *   normalisation in this module, so a caller gets one record plus the problems found on
 *   the way.
 *
 * Contract:
 *
 * - **Pure and deterministic.** No clock, no randomness, no DOM, no network, no I/O, no
 *   dependency. The same bytes always produce the same fields, the same `found` order and
 *   the same problems.
 * - **Nothing is invented.** A field the dictionary does not carry is absent, not empty
 *   and not defaulted. A date whose digits are missing keeps the precision it has
 *   (`2024` stays `2024`, it does not become 1 January). An author string this module
 *   cannot split honestly stays one author. A title the producer wrote as a placeholder
 *   is not presented as the document's title; the caller is told where the title came
 *   from instead (`DerivedTitle.source`).
 * - **A problem is a sentence, a code and nothing else.** Codes are stable and never
 *   localised; `message` is the English diagnostic a log and a test read. A problem never
 *   stops the read: whatever could be decoded is returned, which is what makes a damaged
 *   dictionary usable.
 * - **English/PDF facts only.** Text strings are decoded as PDFDocEncoding or, when the
 *   BOM says so, UTF-16BE (a UTF-16LE BOM is honoured too, because Windows producers write
 *   it). Nothing is transliterated and no locale is consulted.
 *
 * Documented limits of the byte scan:
 *
 * - The Info dictionary is found through the last `/Info n g R` in the file (an incremental
 *   update appends its trailer, so the last one is current), then through a scan for a
 *   dictionary that carries an information key. If neither finds a dictionary there are no
 *   fields and no problem: most PDFs that omit metadata are perfectly healthy.
 * - An Info dictionary packed into an object stream (`/Type /ObjStm`) is compressed; this
 *   module never inflates streams, so such a file reads as having no metadata.
 * - A scan candidate must carry at least one key that an outline item would not carry
 *   (`/Author`, `/Producer`, `/CreationDate`, ...). A dictionary with only `/Title` cannot
 *   be told apart from a bookmark, so the fallback refuses it rather than show a chapter
 *   title as the document title.
 * - A string that claims more precision than its bytes hold (an odd-length UTF-16 string, a
 *   literal string that runs to the end of the object) is decoded as far as it goes and
 *   reported.
 */

import type { SemanticBlockType } from './blocks';

// --- Public shape ----------------------------------------------------------

/** The information-dictionary keys a reader shows, in the order reports list them. */
export type InfoFieldKey =
  | 'Title'
  | 'Author'
  | 'Subject'
  | 'Keywords'
  | 'Creator'
  | 'Producer'
  | 'CreationDate'
  | 'ModDate';

/** Every field key, in the canonical order `found` uses. */
export const INFO_FIELD_KEYS: readonly InfoFieldKey[] = [
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
];

/** The fields that were decoded. A key that is absent was not carried, or was empty. */
export type InfoFields = Partial<Record<InfoFieldKey, string>>;

/**
 * One concrete problem with the metadata.
 *
 * - `invalid-input`: the caller did not pass bytes.
 * - `info-dict-malformed`: the trailer named an Info object that does not hold a readable
 *   dictionary, and the fallback scan found none either.
 * - `info-dict-unterminated`: the dictionary ran to the end of its object without `>>`.
 * - `string-unterminated`: a literal or hex string ran past the end of its region.
 * - `hex-string-invalid`: a hex string carried a character that is not a hex digit.
 * - `utf16-truncated`: a byte-order-marked UTF-16 string had an odd number of bytes.
 * - `value-not-a-string`: a known key's value was a name, number, array or reference.
 * - `duplicate-field`: a known key appeared twice; the later value won.
 * - `date-invalid`: a date field was carried but is not a possible date.
 * - `language-invalid`: `/Lang` was carried but is not a well-formed language tag.
 */
export type MetadataProblemCode =
  | 'invalid-input'
  | 'info-dict-malformed'
  | 'info-dict-unterminated'
  | 'string-unterminated'
  | 'hex-string-invalid'
  | 'utf16-truncated'
  | 'value-not-a-string'
  | 'duplicate-field'
  | 'date-invalid'
  | 'language-invalid';

/** One finding: a stable code plus the English sentence a human reads. */
export interface MetadataProblem {
  code: MetadataProblemCode;
  message: string;
}

/** What the Info dictionary carried. */
export interface InfoDictionary {
  /** Decoded, trimmed values. A key that is absent was not carried, was empty, or was not a string. */
  fields: InfoFields;
  /** The known keys the dictionary carried, in canonical order, whether or not they decoded. */
  found: InfoFieldKey[];
  problems: MetadataProblem[];
}

/** Why a raw date string was refused, when it was. */
export type DateProblemReason = 'empty' | 'shape' | 'range' | 'calendar' | 'timezone';

/** A date string read as far as it is honest to read it. */
export interface NormalisedDate {
  /**
   * ISO-8601 at the precision the source states: `2024`, `2024-03`, `2024-03-05`,
   * `2024-03-05T14:30` or `2024-03-05T14:30:00+05:30`. `null` when the date was refused.
   */
  iso: string | null;
  /** The zone designator the source stated (`Z` or `±HH:MM`), or `null` when it stated none. */
  timezone: string | null;
  /** False when the date is impossible or unreadable; `iso` is then `null`. */
  valid: boolean;
  /** Why the date was refused; `null` when it was accepted. */
  reason: DateProblemReason | null;
}

/** The document as a reader presents it, with nothing guessed. */
export interface DocumentMetadata {
  title: string | null;
  authors: string[];
  subject: string | null;
  keywords: string[];
  creator: string | null;
  producer: string | null;
  /** Present when the dictionary carried `CreationDate`, even when the date is impossible. */
  creationDate: NormalisedDate | null;
  /** Present when the dictionary carried `ModDate`, even when the date is impossible. */
  modificationDate: NormalisedDate | null;
  /** The catalog's `/Lang`, canonicalised to BCP-47 case, or `null`. */
  language: string | null;
  /** The known keys the dictionary carried, in canonical order. */
  found: InfoFieldKey[];
}

/** {@link readMetadata}: the record and everything that went wrong producing it. */
export interface MetadataReport {
  metadata: DocumentMetadata;
  problems: MetadataProblem[];
}

/** {@link parseDocumentLanguage}: the tag and the problems met reading it. */
export interface DocumentLanguage {
  language: string | null;
  problems: MetadataProblem[];
}

/** Where a derived title came from, so a reader can say so instead of implying a title exists. */
export type TitleSource = 'metadata' | 'heading' | 'filename' | 'none';

/** {@link deriveTitle}. */
export interface DerivedTitle {
  title: string | null;
  source: TitleSource;
}

/** A block as `deriveTitle` needs it: only text and the semantic type. */
export interface TitleBlock {
  text: string;
  /** A heading is the only type used as a title fallback. */
  type?: SemanticBlockType;
}

/** {@link deriveTitle} options. */
export interface DeriveTitleOptions {
  /** File name or path the document came from; only the last segment and its stem are used. */
  filename?: string;
}

/** Nesting this module is willing to follow inside one dictionary before it gives up. */
const MAX_NESTING = 32;

/** Candidate dictionaries the fallback scan examines before it stops looking. */
const MAX_CANDIDATE_DICTIONARIES = 64;

/** When to break a string into a list of authors, the policy itself is documented below. */
const AUTHOR_HARD_SEPARATOR = /[;\r\n]+/u;

/** ` and ` / ` & ` between two name-like clauses, applied only when every clause is name-like. */
const AUTHOR_SOFT_SEPARATOR = /\s+(?:and|&)\s+/iu;

/** Words that end a clause naming an organisation rather than a person. */
const CORPORATE_TAIL_WORDS = new Set([
  'ab', 'academy', 'agency', 'ag', 'aps', 'as', 'association', 'bank', 'bureau',
  'bv', 'center', 'centre', 'co', 'college', 'commission', 'committee', 'company',
  'consortium', 'corp', 'corporation', 'council', 'department', 'dept', 'division',
  'enterprises', 'faculty', 'federation', 'foundation', 'gmbh', 'group', 'groupe',
  'holdings', 'hospital', 'inc', 'incorporated', 'institut', 'institute', 'kg', 'kk',
  'laboratories', 'laboratory', 'labs', 'limited', 'llc', 'llp', 'ltd', 'media',
  'ministry', 'network', 'nv', 'office', 'organization', 'organisation', 'oy', 'partners',
  'plc', 'press', 'program', 'programme', 'project', 'pte', 'pty', 'sa', 'sarl', 'sas',
  'school', 'services', 'society', 'solutions', 'spa', 'srl', 'studio', 'systems', 'team',
  'technologies', 'trust', 'ug', 'union', 'unit', 'university', 'ventures',
]);

/** Lower-case particles that may sit inside a person's name without being capitalised. */
const LOWERCASE_NAME_PARTICLES = new Set([
  'al', 'bin', 'da', 'das', 'de', 'del', 'della', 'der', 'di', 'dos', 'du', 'e', 'el',
  'ibn', 'la', 'le', 'op', 'ten', 'ter', 'van', 'von', 'y',
]);

/**
 * Titles producers fill in by default. Showing one as the document's title would be
 * presenting the producer's template as the document's own name.
 */
const PLACEHOLDER_TITLE_PATTERN = /^(?:untitled(?: document)?|no title|document|new document|title|unknown)$/u;

/** The producer template `Microsoft Word - <file name>`, in every case it is written. */
const PRODUCER_TEMPLATE_TITLE_PATTERN = /^microsoft (?:word|powerpoint|excel) - /iu;

/** A person's name clause is at most this many words: longer is prose, not a name. */
const MAX_NAME_WORDS = 6;

/** The PDFDocEncoding code points that differ from ISO Latin-1, from PDF 32000-1 Annex D. */
const PDF_DOC_ENCODING_OVERRIDES: Readonly<Record<number, string>> = {
  0x18: '\u02d8', 0x19: '\u02c7', 0x1a: '\u02c6', 0x1b: '\u02d9',
  0x1c: '\u02dd', 0x1d: '\u02db', 0x1e: '\u02da', 0x1f: '\u02dc',
  0x80: '\u2022', 0x81: '\u2020', 0x82: '\u2021', 0x83: '\u2026',
  0x84: '\u2014', 0x85: '\u2013', 0x86: '\u0192', 0x87: '\u2044',
  0x88: '\u2039', 0x89: '\u203a', 0x8a: '\u2212', 0x8b: '\u2030',
  0x8c: '\u201e', 0x8d: '\u201c', 0x8e: '\u201d', 0x8f: '\u2018',
  0x90: '\u2019', 0x91: '\u201a', 0x92: '\u2122', 0x93: '\ufb01',
  0x94: '\ufb02', 0x95: '\u0141', 0x96: '\u0152', 0x97: '\u0160',
  0x98: '\u0178', 0x99: '\u017d', 0x9a: '\u0131', 0x9b: '\u0142',
  0x9c: '\u0153', 0x9d: '\u0161', 0x9e: '\u017e', 0xa0: '\u20ac',
};

const FIELD_BY_LOWER_NAME: ReadonlyMap<string, InfoFieldKey> = new Map(
  INFO_FIELD_KEYS.map((key): [string, InfoFieldKey] => [key.toLowerCase(), key]),
);

// --- The Info dictionary ---------------------------------------------------

/**
 * Reads the document information dictionary out of the bytes.
 *
 * The scan is linear and heuristic; the module header lists what it cannot see. Values
 * are decoded (PDFDocEncoding, or UTF-16 when a BOM says so), unescaped, trimmed, and an
 * empty value is not a field. Every field problem is reported, and a damaged dictionary
 * still returns the fields that were readable before the damage.
 */
export function parseInfoDict(bytes: Uint8Array): InfoDictionary {
  if (!bytes || typeof bytes.length !== 'number') {
    return {
      fields: {},
      found: [],
      problems: [problem('invalid-input', 'parseInfoDict needs the PDF bytes as a Uint8Array.')],
    };
  }
  if (bytes.length === 0) return { fields: {}, found: [], problems: [] };

  const text = asLatin1(bytes);
  const reference = lastInfoReference(text);
  const referenced = reference ? readInfoObject(text, reference) : null;

  let dictionary = referenced;
  if (!dictionary || knownKeyCount(dictionary.entries) === 0) {
    // Either the trailer named nothing readable, or it named a dictionary with no
    // information key at all. Both are worth a second look before claiming no metadata.
    const scanned = firstInfoDictionary(text);
    if (scanned) dictionary = scanned;
  }

  if (!dictionary) {
    return {
      fields: {},
      found: [],
      problems: reference
        ? [problem('info-dict-malformed', `The trailer points at object ${reference.object} ${reference.generation}, which does not hold a readable dictionary.`)]
        : [],
    };
  }

  const problems = [...dictionary.problems];
  const decoded = decodeEntries(dictionary.entries, problems);
  return { fields: decoded.fields, found: decoded.found, problems };
}

/**
 * Reads the catalog's `/Lang` out of the bytes.
 *
 * `/Lang` is a catalog entry, not an Info field, so it is read separately. Only the first
 * well-formed tag is accepted; a file whose `/Lang` is malformed reports one problem
 * instead of guessing a language.
 */
export function parseDocumentLanguage(bytes: Uint8Array): DocumentLanguage {
  if (!bytes || typeof bytes.length !== 'number') {
    return { language: null, problems: [problem('invalid-input', 'parseDocumentLanguage needs the PDF bytes as a Uint8Array.')] };
  }
  if (bytes.length === 0) return { language: null, problems: [] };

  const text = asLatin1(bytes);
  const pattern = /\/Lang(?![A-Za-z0-9#])/gu;
  const problems: MetadataProblem[] = [];
  let sawLang = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = skipSpaceAndComments(text, match.index + match[0].length, text.length);
    if (start >= text.length) continue;
    const code = text.charCodeAt(start);
    let raw: string | null = null;
    if (code === 0x28) {
      const literal = readLiteralString(text, start, text.length);
      raw = decodeTextBytes(literal.bytes, problems);
    } else if (code === 0x3c) {
      const hex = readHexString(text, start, text.length);
      raw = decodeTextBytes(hex.bytes, problems);
    } else if (code === 0x2f) {
      raw = readName(text, start, text.length).name;
    }
    if (raw === null) continue;
    sawLang = true;
    const tag = normaliseLanguageTag(raw);
    if (tag !== null) return { language: tag, problems };
  }

  if (sawLang) {
    problems.push(problem('language-invalid', 'The catalog carries a /Lang value that is not a well-formed language tag.'));
  }
  return { language: null, problems };
}

/**
 * Reads and normalises everything this module knows how to read.
 *
 * Dates are parsed with {@link normaliseDate} and kept next to the problems that explain
 * them: a field that is present but impossible is reported as a problem and returned with
 * `valid: false`, rather than silently dropped or silently repaired.
 */
export function readMetadata(bytes: Uint8Array): MetadataReport {
  const info = parseInfoDict(bytes);
  const language = parseDocumentLanguage(bytes);
  const problems = [...info.problems, ...language.problems];

  const creationDate = dateField(info.fields.CreationDate, 'CreationDate', problems);
  const modificationDate = dateField(info.fields.ModDate, 'ModDate', problems);

  const metadata: DocumentMetadata = {
    title: info.fields.Title ?? null,
    authors: info.fields.Author === undefined ? [] : normaliseAuthor(info.fields.Author),
    subject: info.fields.Subject ?? null,
    keywords: info.fields.Keywords === undefined ? [] : normaliseKeywords(info.fields.Keywords),
    creator: info.fields.Creator ?? null,
    producer: info.fields.Producer ?? null,
    creationDate,
    modificationDate,
    language: language.language,
    found: info.found,
  };
  return { metadata, problems };
}

// --- Normalisation ---------------------------------------------------------

/**
 * Parses a PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`) as far as the source states it.
 *
 * Accepted: the `D:` prefix or a bare date; year, month, day, hour, minute and second in
 * that order, stopping between them; `Z`, `+HH`, `+HH'mm'`, `+HH:mm` or `+HHmm` for the zone.
 * Refused, with a reason and `valid: false`: an empty string, a two-digit year, a digit
 * group that ends mid-field, a month or day outside the calendar (31 April, 29 February in
 * a common year), a time outside 00:00:00–23:59:59, and a zone outside ±23:59.
 *
 * The returned `iso` is ISO-8601 at the precision that was stated: a year-only source is
 * `2024`, not `2024-01-01T00:00:00Z`. Nothing is filled in, which is why a reader that
 * needs a full instant has to decide what missing precision means. The zone is appended to
 * `iso` only when a time is present, because ISO-8601 has no way to attach a zone to a bare
 * date; `timezone` still reports what the source said.
 */
export function normaliseDate(raw: string): NormalisedDate {
  const refuse = (reason: DateProblemReason): NormalisedDate => ({ iso: null, timezone: null, valid: false, reason });
  if (typeof raw !== 'string') return refuse('shape');

  let text = raw.trim();
  if (text.length === 0) return refuse('empty');
  if (/^D:/iu.test(text)) text = text.slice(2);

  let digits = 0;
  while (digits < text.length && digits < 14 && isDigit(text.charCodeAt(digits))) digits += 1;
  if (digits < 4 || digits % 2 !== 0) return refuse('shape');

  const part = (offset: number): number | null => {
    if (digits < offset + 2) return null;
    return Number(text.slice(offset, offset + 2));
  };

  const year = Number(text.slice(0, 4));
  const month = part(4);
  const day = part(6);
  const hour = part(8);
  const minute = part(10);
  const second = part(12);

  const zone = readDateZone(text.slice(digits).trim());
  if (zone === 'invalid') return refuse('timezone');

  if (month !== null && (month < 1 || month > 12)) return refuse('range');
  if (day !== null) {
    const days = daysInMonth(year, month ?? 1);
    if (day < 1 || day > days) return refuse('calendar');
  }
  if (hour !== null && hour > 23) return refuse('range');
  if (minute !== null && minute > 59) return refuse('range');
  if (second !== null && second > 59) return refuse('range');

  let iso = pad4(year);
  if (month !== null) iso += `-${pad2(month)}`;
  if (day !== null) iso += `-${pad2(day)}`;
  if (hour !== null) {
    iso += `T${pad2(hour)}`;
    if (minute !== null) iso += `:${pad2(minute)}`;
    if (second !== null) iso += `:${pad2(second)}`;
    if (zone !== null) iso += zone;
  }
  return { iso, timezone: zone, valid: true, reason: null };
}

/**
 * Splits an author string into the people or organisations it names.
 *
 * Policy, and why it is not simply "split on every comma":
 *
 * - `;` and a line break are separators the format's users treat as structural, so they
 *   always split.
 * - ` and `, ` & ` and `,` are ambiguous: `Smith, John` is one inverted name, `Acme, Inc.`
 *   is one company, and `Research and Development Corporation` is one organisation whose
 *   name contains a separator word. They split only when **every** clause they would
 *   produce looks like a person's name: {@link MAX_NAME_WORDS} words or fewer, at least two
 *   of them, no digits, no word shouted in capitals, and a last word that is not an
 *   organisation designator (Inc, Ltd, University, Department, ...). When that test fails
 *   the clause stays one author, which is the direction that loses information rather than
 *   inventing a person.
 * - Nothing else splits, and nothing is deduplicated or reordered: an author list is
 *   reported as its source states it.
 */
export function normaliseAuthor(raw: string): string[] {
  if (typeof raw !== 'string') return [];
  const authors: string[] = [];
  for (const segment of raw.split(AUTHOR_HARD_SEPARATOR)) {
    const clause = collapse(segment);
    if (clause.length === 0) continue;
    for (const author of splitSoftSeparators(clause)) {
      if (author.length > 0) authors.push(author);
    }
  }
  return authors;
}

/**
 * Splits a keyword string into its terms.
 *
 * Keywords are conventionally comma-separated; this build also accepts `;` and a line
 * break, because producers write all three. Terms are trimmed and empty terms dropped;
 * nothing else is applied, since a keyword may legitimately contain punctuation.
 */
export function normaliseKeywords(raw: string): string[] {
  if (typeof raw !== 'string') return [];
  const keywords: string[] = [];
  for (const part of raw.split(/[,;\r\n]+/u)) {
    const keyword = collapse(part);
    if (keyword.length > 0) keywords.push(keyword);
  }
  return keywords;
}

/**
 * Canonicalises a language tag to BCP-47 conventional case (`en-GB`, `zh-Hant-TW`).
 *
 * `_` is accepted as a subtag separator and rewritten to `-`, because several producers
 * write `en_US`. A value that is not a tag — an empty string, a free-text language name,
 * a subtag that is too long — returns `null`; no language is guessed from a country name.
 */
export function normaliseLanguageTag(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/_/gu, '-');
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u.test(trimmed)) return null;

  const parts = trimmed.split('-');
  const primary = (parts[0] ?? '').toLowerCase();
  const subtags = parts.slice(1);
  const normalised: string[] = [primary];
  subtags.forEach((subtag, index) => {
    if (index === 0) {
      if (subtag.length === 4 && /^[A-Za-z]+$/u.test(subtag)) {
        normalised.push(subtag.charAt(0).toUpperCase() + subtag.slice(1).toLowerCase());
        return;
      }
      if (/^(?:[A-Za-z]{2}|\d{3})$/u.test(subtag)) {
        normalised.push(subtag.toUpperCase());
        return;
      }
      normalised.push(subtag.toLowerCase());
      return;
    }
    if (index === 1 && /^(?:[A-Za-z]{2}|\d{3})$/u.test(subtag)) {
      normalised.push(subtag.toUpperCase());
      return;
    }
    normalised.push(subtag.toLowerCase());
  });
  return normalised.join('-');
}

/**
 * Chooses the title a reader shows, in the order it can be trusted.
 *
 * 1. The Info dictionary's `/Title`, unless it is the producer's template (`Untitled`,
 *    `Microsoft Word - report.doc`) — that is the producer's name for the file, not the
 *    document's.
 * 2. The first heading in `blocks`, which the caller passes in reading order. This is the
 *    only block type used: a first paragraph is prose, not a title.
 * 3. The file name's stem, with one extension removed. A stem that contains no space at all
 *    is a slug, so `_` and `-` become spaces (`annual-report-2024` → `annual report 2024`);
 *    a stem that already has spaces is left exactly as it is.
 * 4. Nothing: `title` is `null` and `source` says so, so a caller can render "Untitled"
 *    itself rather than be handed an invented name.
 */
export function deriveTitle(
  metadata: DocumentMetadata | null | undefined,
  blocks?: readonly TitleBlock[],
  options?: DeriveTitleOptions,
): DerivedTitle {
  const fromMetadata = collapse(metadata?.title ?? '');
  if (fromMetadata.length > 0 && !isPlaceholderTitle(fromMetadata)) {
    return { title: fromMetadata, source: 'metadata' };
  }

  for (const block of blocks ?? []) {
    if (!block || block.type !== 'heading') continue;
    const text = collapse(block.text);
    if (text.length > 0) return { title: text, source: 'heading' };
  }

  const stem = filenameStem(options?.filename ?? '');
  if (stem.length > 0) return { title: stem, source: 'filename' };
  return { title: null, source: 'none' };
}

// --- Field decoding --------------------------------------------------------

interface DecodedEntries {
  fields: InfoFields;
  found: InfoFieldKey[];
}

/** Turns raw dictionary entries into the eight fields, reporting what did not decode. */
function decodeEntries(entries: readonly RawEntry[], problems: MetadataProblem[]): DecodedEntries {
  const carried = new Set<InfoFieldKey>();
  const values = new Map<InfoFieldKey, string>();

  for (const entry of entries) {
    const key = asInfoFieldKey(entry.key);
    if (key === undefined) continue;
    carried.add(key);

    if (entry.value.kind !== 'string') {
      problems.push(problem('value-not-a-string', `/${key} is not a text string; it is ignored.`));
      continue;
    }
    if (values.has(key)) {
      problems.push(problem('duplicate-field', `/${key} appears more than once; the later value is used.`));
    }
    values.set(key, decodeTextBytes(entry.value.bytes, problems));
  }

  const fields: InfoFields = {};
  for (const key of INFO_FIELD_KEYS) {
    const value = values.get(key);
    const trimmed = value === undefined ? '' : trimNuls(value).trim();
    if (trimmed.length > 0) fields[key] = trimmed;
  }
  return { fields, found: INFO_FIELD_KEYS.filter(key => carried.has(key)) };
}

/**
 * Decodes a text string's bytes: UTF-16 when a BOM leads, PDFDocEncoding otherwise.
 *
 * The BOM is part of the string, not of its text, so it is never returned. A UTF-16 string
 * with an odd byte count keeps its whole pairs and reports the dropped byte.
 */
function decodeTextBytes(bytes: readonly number[], problems: MetadataProblem[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return trimNuls(decodeUtf16(bytes, 2, true, problems));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return trimNuls(decodeUtf16(bytes, 2, false, problems));
  }
  let text = '';
  for (const byte of bytes) text += pdfDocChar(byte & 0xff);
  return trimNuls(text);
}

function decodeUtf16(bytes: readonly number[], start: number, bigEndian: boolean, problems: MetadataProblem[]): string {
  let text = '';
  let index = start;
  for (; index + 1 < bytes.length; index += 2) {
    const high = bytes[index] ?? 0;
    const low = bytes[index + 1] ?? 0;
    text += String.fromCharCode(bigEndian ? (high << 8) | low : (low << 8) | high);
  }
  if (index < bytes.length) {
    problems.push(problem('utf16-truncated', 'A UTF-16 text string had an odd number of bytes; the last byte was dropped.'));
  }
  return text;
}

/** One PDFDocEncoding byte as a character; a byte the encoding leaves undefined becomes U+FFFD. */
function pdfDocChar(byte: number): string {
  const override = PDF_DOC_ENCODING_OVERRIDES[byte];
  if (override !== undefined) return override;
  if (byte === 0x09 || byte === 0x0a || byte === 0x0d) return String.fromCharCode(byte);
  if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte);
  if (byte >= 0xa1) return String.fromCharCode(byte);
  return '\ufffd';
}

// --- Finding the dictionary ------------------------------------------------

interface InfoReference {
  object: number;
  generation: number;
}

/** The Info dictionary as raw entries, before the known keys are picked out. */
interface RawEntry {
  key: string;
  value: RawValue;
}

type RawValue = { kind: 'string'; bytes: number[] } | { kind: 'other' };

interface DictionaryRead {
  entries: RawEntry[];
  problems: MetadataProblem[];
}

/**
 * The last `/Info n g R` in the file. An incremental update appends its trailer, so the
 * last reference is the current one.
 */
function lastInfoReference(text: string): InfoReference | null {
  const pattern = /\/Info\s+(\d+)\s+(\d+)\s+R(?![A-Za-z0-9])/gu;
  let last: InfoReference | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const object = Number(match[1]);
    const generation = Number(match[2]);
    if (Number.isInteger(object) && Number.isInteger(generation)) last = { object, generation };
  }
  return last;
}

/** Reads the object a trailer's `/Info` entry names, or `null` when it is not there. */
function readInfoObject(text: string, reference: InfoReference): DictionaryRead | null {
  const pattern = new RegExp(`\\b${reference.object}\\s+${reference.generation}\\s+obj\\b`, 'gu');
  let open = -1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const after = match.index + match[0].length;
    const found = text.indexOf('<<', after);
    if (found !== -1) open = found;
  }
  if (open === -1) return null;
  return readDictionary(text, open, dictionaryEnd(text, open));
}

/**
 * The fallback: the first dictionary that carries a key an outline item would not.
 *
 * Each key occurrence is traced back to the nearest `<<`, so an outline's `/Title` lands in
 * the bookmark's dictionary and is recognised as one. `/Title` alone is never enough.
 */
function firstInfoDictionary(text: string): DictionaryRead | null {
  const pattern = /\/(?:Title|Author|Subject|Keywords|Creator|Producer|CreationDate|ModDate)(?![A-Za-z0-9])/giu;
  const examined = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const open = text.lastIndexOf('<<', match.index);
    if (open === -1 || examined.has(open)) continue;
    if (examined.size >= MAX_CANDIDATE_DICTIONARIES) return null;
    examined.add(open);
    const read = readDictionary(text, open, dictionaryEnd(text, open));
    if (read.entries.some(entry => isCharacteristicInfoKey(entry.key))) return read;
  }
  return null;
}

/** End of the object holding a dictionary: its `endobj`, or the end of the file. */
function dictionaryEnd(text: string, open: number): number {
  const endobj = text.indexOf('endobj', open);
  return endobj === -1 ? text.length : endobj;
}

function knownKeyCount(entries: readonly RawEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (asInfoFieldKey(entry.key) !== undefined) count += 1;
  }
  return count;
}

/** A key that belongs to an Info dictionary and not to a bookmark. */
function isCharacteristicInfoKey(name: string): boolean {
  const key = asInfoFieldKey(name);
  return key !== undefined && key !== 'Title';
}

/** Info keys are matched case-insensitively: `/title` comes from tools that lower-case names. */
function asInfoFieldKey(name: string): InfoFieldKey | undefined {
  return FIELD_BY_LOWER_NAME.get(name.toLowerCase());
}

// --- Reading a dictionary --------------------------------------------------

/**
 * Reads a dictionary's top-level entries between `open` and `end`.
 *
 * A damaged dictionary is not an error here: whatever parses is returned, and every
 * surprise becomes a problem. A key whose value is a string carries the string's bytes;
 * every other value is recorded as `other` so the key still counts as carried.
 */
function readDictionary(text: string, open: number, end: number): DictionaryRead {
  const entries: RawEntry[] = [];
  const problems: MetadataProblem[] = [];
  let closed = false;
  let scrambled = false;
  let index = open + 2;

  while (index < end) {
    const before = index;
    index = skipSpaceAndComments(text, index, end);
    if (index >= end) break;

    const code = text.charCodeAt(index);
    const following = index + 1 < end ? text.charCodeAt(index + 1) : -1;
    if (code === 0x3e && following === 0x3e) {
      closed = true;
      index += 2;
      break;
    }

    if (code !== 0x2f) {
      if (!scrambled) {
        problems.push(problem('info-dict-malformed', 'The dictionary is not a sequence of /Key value pairs; parsing resynchronised.'));
        scrambled = true;
      }
      index = skipValue(text, index, end);
    } else {
      const name = readName(text, index, end);
      const value = readValue(text, name.next, end);
      problems.push(...value.problems);
      entries.push({ key: name.name, value: value.value });
      index = value.next;
    }
    // Every branch must move forward; a malformed byte that does not would loop forever.
    if (index <= before) index = before + 1;
  }

  if (!closed) {
    problems.push(problem('info-dict-unterminated', 'The dictionary ended without its closing >>.'));
  }
  return { entries, problems };
}

interface ParsedValue {
  value: RawValue;
  next: number;
  problems: MetadataProblem[];
}

/** Reads one value at `index`, returning the bytes when it is a text string. */
function readValue(text: string, index: number, end: number): ParsedValue {
  const start = skipSpaceAndComments(text, index, end);
  if (start >= end) return { value: { kind: 'other' }, next: end, problems: [] };

  const code = text.charCodeAt(start);
  const following = start + 1 < end ? text.charCodeAt(start + 1) : -1;
  if (code === 0x28) {
    const literal = readLiteralString(text, start, end);
    return {
      value: { kind: 'string', bytes: literal.bytes },
      next: literal.next,
      problems: literal.terminated ? [] : [problem('string-unterminated', 'A literal string ran past the end of its dictionary region.')],
    };
  }
  if (code === 0x3c && following !== 0x3c) {
    const hex = readHexString(text, start, end);
    const problems: MetadataProblem[] = [];
    if (!hex.terminated) problems.push(problem('string-unterminated', 'A hex string ran past the end of its dictionary region.'));
    if (hex.invalid) problems.push(problem('hex-string-invalid', 'A hex string carried a character that is not a hex digit; it was skipped.'));
    return { value: { kind: 'string', bytes: hex.bytes }, next: hex.next, problems };
  }
  return { value: { kind: 'other' }, next: skipValue(text, start, end), problems: [] };
}

/** Skips one value of any type, returning the index after it. */
function skipValue(text: string, index: number, end: number): number {
  const start = skipSpaceAndComments(text, index, end);
  if (start >= end) return end;
  const code = text.charCodeAt(start);
  const following = start + 1 < end ? text.charCodeAt(start + 1) : -1;
  if (code === 0x28) return readLiteralString(text, start, end).next;
  if (code === 0x3c && following === 0x3c) return skipDictionary(text, start, end, 0);
  if (code === 0x3c) return readHexString(text, start, end).next;
  if (code === 0x5b) return skipArray(text, start, end, 0);
  if (code === 0x2f) return readName(text, start, end).next;
  return skipWord(text, start, end);
}

/**
 * Reads a literal string `( ... )`, unescaping it.
 *
 * Balanced unescaped parentheses are part of the string, as the format says they are:
 * `(A (B) C)` is one string holding `A (B) C`. An end of line inside the string is a
 * single LF, and a line continuation contributes nothing.
 */
function readLiteralString(text: string, open: number, end: number): { bytes: number[]; next: number; terminated: boolean } {
  const bytes: number[] = [];
  let depth = 1;
  let index = open + 1;

  while (index < end) {
    const code = text.charCodeAt(index);
    if (code === 0x5c) {
      const escaped = readEscape(text, index, end);
      for (const byte of escaped.bytes) bytes.push(byte);
      index = escaped.next;
      continue;
    }
    if (code === 0x28) {
      depth += 1;
      bytes.push(code);
      index += 1;
      continue;
    }
    if (code === 0x29) {
      depth -= 1;
      index += 1;
      if (depth === 0) return { bytes, next: index, terminated: true };
      bytes.push(code);
      continue;
    }
    if (code === 0x0d) {
      index += 1;
      if (index < end && text.charCodeAt(index) === 0x0a) index += 1;
      bytes.push(0x0a);
      continue;
    }
    bytes.push(code & 0xff);
    index += 1;
  }
  return { bytes, next: end, terminated: false };
}

/** One backslash escape inside a literal string. */
function readEscape(text: string, index: number, end: number): { bytes: number[]; next: number } {
  const next = index + 1;
  if (next >= end) return { bytes: [], next: end };
  const code = text.charCodeAt(next);

  switch (code) {
    case 0x6e: return { bytes: [0x0a], next: next + 1 };
    case 0x72: return { bytes: [0x0d], next: next + 1 };
    case 0x74: return { bytes: [0x09], next: next + 1 };
    case 0x62: return { bytes: [0x08], next: next + 1 };
    case 0x66: return { bytes: [0x0c], next: next + 1 };
    case 0x28:
    case 0x29:
    case 0x5c: return { bytes: [code], next: next + 1 };
    case 0x0d: {
      // A backslash before an end of line continues the string on the next line.
      let cursor = next + 1;
      if (cursor < end && text.charCodeAt(cursor) === 0x0a) cursor += 1;
      return { bytes: [], next: cursor };
    }
    case 0x0a: return { bytes: [], next: next + 1 };
    default: break;
  }

  if (code >= 0x30 && code <= 0x37) {
    // An octal escape carries one byte, written with one to three digits.
    let cursor = next;
    let value = 0;
    let used = 0;
    while (used < 3 && cursor < end) {
      const digit = text.charCodeAt(cursor) - 0x30;
      if (digit < 0 || digit > 7) break;
      value = value * 8 + digit;
      cursor += 1;
      used += 1;
    }
    return { bytes: [value & 0xff], next: cursor };
  }

  return { bytes: [code & 0xff], next: next + 1 };
}

/**
 * Reads a hex string `< ... >`.
 *
 * Whitespace inside is ignored, a missing final digit is a zero as the format specifies,
 * and a character that is not a hex digit is skipped and reported rather than silently
 * shifting every following byte.
 */
function readHexString(text: string, open: number, end: number): { bytes: number[]; next: number; terminated: boolean; invalid: boolean } {
  const bytes: number[] = [];
  let pending = -1;
  let invalid = false;
  let terminated = false;
  let index = open + 1;

  while (index < end) {
    const code = text.charCodeAt(index);
    index += 1;
    if (code === 0x3e) {
      terminated = true;
      break;
    }
    if (isWhitespace(code)) continue;
    const value = hexDigit(code);
    if (value < 0) {
      invalid = true;
      continue;
    }
    if (pending < 0) {
      pending = value;
      continue;
    }
    bytes.push((pending << 4) | value);
    pending = -1;
  }
  if (pending >= 0) bytes.push(pending << 4);
  return { bytes, next: index, terminated, invalid };
}

/** Reads a `/Name`, decoding `#xx` escapes. */
function readName(text: string, index: number, end: number): { name: string; next: number } {
  let name = '';
  let cursor = index + 1;
  while (cursor < end) {
    const code = text.charCodeAt(cursor);
    if (isWhitespace(code) || isDelimiter(code)) break;
    if (code === 0x23 && cursor + 2 < end) {
      const high = hexDigit(text.charCodeAt(cursor + 1));
      const low = hexDigit(text.charCodeAt(cursor + 2));
      if (high >= 0 && low >= 0) {
        name += String.fromCharCode((high << 4) | low);
        cursor += 3;
        continue;
      }
    }
    name += String.fromCharCode(code);
    cursor += 1;
  }
  return { name, next: cursor };
}

/** Skips a `<< ... >>` dictionary, following nested strings and arrays. */
function skipDictionary(text: string, open: number, end: number, depth: number): number {
  if (depth > MAX_NESTING) return end;
  let level = 1;
  let index = open + 2;
  while (index < end) {
    index = skipSpaceAndComments(text, index, end);
    if (index >= end) return end;
    const code = text.charCodeAt(index);
    const following = index + 1 < end ? text.charCodeAt(index + 1) : -1;
    if (code === 0x3c && following === 0x3c) {
      level += 1;
      index += 2;
      continue;
    }
    if (code === 0x3e && following === 0x3e) {
      level -= 1;
      index += 2;
      if (level === 0) return index;
      continue;
    }
    if (code === 0x28) {
      index = readLiteralString(text, index, end).next;
      continue;
    }
    if (code === 0x3c) {
      index = readHexString(text, index, end).next;
      continue;
    }
    if (code === 0x5b) {
      index = skipArray(text, index, end, depth + 1);
      continue;
    }
    index += 1;
  }
  return end;
}

/** Skips a `[ ... ]` array, following nested strings and dictionaries. */
function skipArray(text: string, open: number, end: number, depth: number): number {
  if (depth > MAX_NESTING) return end;
  let level = 1;
  let index = open + 1;
  while (index < end) {
    index = skipSpaceAndComments(text, index, end);
    if (index >= end) return end;
    const code = text.charCodeAt(index);
    if (code === 0x5b) {
      level += 1;
      index += 1;
      continue;
    }
    if (code === 0x5d) {
      level -= 1;
      index += 1;
      if (level === 0) return index;
      continue;
    }
    if (code === 0x28) {
      index = readLiteralString(text, index, end).next;
      continue;
    }
    if (code === 0x3c) {
      const following = index + 1 < end ? text.charCodeAt(index + 1) : -1;
      if (following === 0x3c) {
        index = skipDictionary(text, index, end, depth + 1);
        continue;
      }
      index = readHexString(text, index, end).next;
      continue;
    }
    if (code === 0x2f) {
      index = readName(text, index, end).next;
      continue;
    }
    index += 1;
  }
  return end;
}

/** Skips a bare word: a number, a reference's `R`, `true`, or noise. */
function skipWord(text: string, index: number, end: number): number {
  let cursor = index;
  while (cursor < end) {
    const code = text.charCodeAt(cursor);
    if (isWhitespace(code) || isDelimiter(code)) break;
    cursor += 1;
  }
  return cursor > index ? cursor : Math.min(end, index + 1);
}

// --- Dates and prose helpers ----------------------------------------------

/** A zone designator, or `null` when the source stated none, or `'invalid'`. */
function readDateZone(zone: string): string | null | 'invalid' {
  if (zone.length === 0) return null;
  if (/^[Zz]$/u.test(zone)) return 'Z';

  const match = /^([+-])(\d{2})(?:(?::|')?(\d{2}))?'?$/u.exec(zone);
  if (!match) return 'invalid';
  const sign = match[1] ?? '+';
  const hours = Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return 'invalid';
  if (hours > 23 || minutes > 59) return 'invalid';
  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

/** Days in a month, honouring the Gregorian leap rule. */
function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 0;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Splits one author clause on the soft separators, but only when every piece it would
 * produce is a person's name. Otherwise the clause is one author.
 */
function splitSoftSeparators(clause: string): string[] {
  const byAnd = clause.split(AUTHOR_SOFT_SEPARATOR).map(collapse).filter(piece => piece.length > 0);
  if (byAnd.length >= 2 && byAnd.every(looksLikePersonName)) return byAnd;

  const byComma = clause.split(',').map(collapse).filter(piece => piece.length > 0);
  if (byComma.length >= 2 && byComma.every(looksLikePersonName)) return byComma;

  return [clause];
}

/**
 * Whether a clause looks like a person's name rather than an organisation or a sentence:
 * two to {@link MAX_NAME_WORDS} words, no digits, every word capitalised or a lowercase
 * particle, and a last word that is not an organisation designator.
 */
function looksLikePersonName(clause: string): boolean {
  const words = clause.split(/\s+/u).filter(word => word.length > 0);
  if (words.length < 2 || words.length > MAX_NAME_WORDS) return false;
  if (/\d/u.test(clause)) return false;
  if (isCorporateName(words)) return false;

  return words.every((word, index) => {
    const cleaned = word.replace(/[.,'’()-]+$/gu, '');
    if (cleaned.length === 0) return false;
    const first = cleaned.charAt(0);
    if (first !== first.toUpperCase()) {
      return index > 0 && LOWERCASE_NAME_PARTICLES.has(cleaned.toLowerCase());
    }
    // A word shouted in capitals is a headline or an acronym, not a name's given name.
    return !(cleaned.length > 1 && cleaned === cleaned.toUpperCase());
  });
}

/** Whether the clause's last word is an organisation designator. */
function isCorporateName(words: readonly string[]): boolean {
  const last = words[words.length - 1];
  if (last === undefined) return false;
  const cleaned = last.replace(/[.,]+$/u, '').toLowerCase();
  return CORPORATE_TAIL_WORDS.has(cleaned);
}

function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLE_PATTERN.test(title.toLowerCase()) || PRODUCER_TEMPLATE_TITLE_PATTERN.test(title);
}

/** The final segment of a path, one extension removed, with a slug turned into words. */
function filenameStem(filename: string): string {
  const trimmed = filename.trim();
  if (trimmed.length === 0) return '';
  const parts = trimmed.split(/[\\/]+/u);
  let stem = parts[parts.length - 1] ?? '';

  const dot = stem.lastIndexOf('.');
  if (dot > 0 && stem.length - dot <= 9) stem = stem.slice(0, dot);
  stem = stem.trim();

  // A stem with no space at all was written as a slug, so its separators are word breaks;
  // a stem that has spaces is a written title and is left untouched.
  if (stem.length > 0 && !/\s/u.test(stem)) stem = stem.replace(/[_-]+/gu, ' ');
  return collapse(stem);
}

// --- Small helpers ---------------------------------------------------------

function problem(code: MetadataProblemCode, message: string): MetadataProblem {
  return { code, message };
}

/** Reads a date field, reporting it when the raw text is present but not a possible date. */
function dateField(raw: string | undefined, field: 'CreationDate' | 'ModDate', problems: MetadataProblem[]): NormalisedDate | null {
  if (raw === undefined) return null;
  const date = normaliseDate(raw);
  if (!date.valid) {
    problems.push(problem('date-invalid', `/${field} "${raw}" is not a possible date (${date.reason ?? 'shape'}).`));
  }
  return date;
}

/** One byte per character: the scan works on bytes but reads them as PDF syntax. */
function asLatin1(bytes: Uint8Array): string {
  const chunk = 8192;
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return text;
}

function skipSpaceAndComments(text: string, index: number, end: number): number {
  let cursor = index;
  while (cursor < end) {
    const code = text.charCodeAt(cursor);
    if (isWhitespace(code)) {
      cursor += 1;
      continue;
    }
    if (code === 0x25) {
      cursor += 1;
      while (cursor < end) {
        const inner = text.charCodeAt(cursor);
        if (inner === 0x0a || inner === 0x0d) break;
        cursor += 1;
      }
      continue;
    }
    break;
  }
  return cursor;
}

function isWhitespace(code: number): boolean {
  return code === 0x00 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

function isDelimiter(code: number): boolean {
  return (
    code === 0x28 || code === 0x29 || code === 0x3c || code === 0x3e ||
    code === 0x5b || code === 0x5d || code === 0x7b || code === 0x7d ||
    code === 0x2f || code === 0x25
  );
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

/** Drops the trailing NUL characters some producers append to a UTF-16 value. */
function trimNuls(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x00) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

/** Collapses every whitespace run to one space and trims. */
function collapse(text: string): string {
  return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function pad4(value: number): string {
  return String(value).padStart(4, '0');
}
