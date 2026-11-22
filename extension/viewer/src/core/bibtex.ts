/**
 * Bibliographic records (backlog J01/J02).
 *
 * A paper carries its own bibliography: the .bib file shipped with a LaTeX source, or
 * the reference list printed on its pages. This module owns the record the reader keeps
 * between extraction and citation: a BibTeX reader that survives a broken entry, a
 * citation key derived from the record itself, a deduplicating merge that refuses to
 * lose a key, a canonical writer, and three citation styles.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no I/O. The same text always
 *   produces the same entries, the same keys and the same bytes.
 * - Parsing never throws on a bad entry. A malformed record is reported in `errors`
 *   with its 1-based line and skipped; the rest of the file still parses.
 * - Values keep their source text: inner braces and LaTeX escapes survive so a title
 *   can be written back unchanged. Only the delimiters and stray whitespace are
 *   dropped, and runs of whitespace inside a value collapse to one space.
 * - Field names are lowercased. `journaltitle` folds into `journal` and `date` into
 *   `year`, so later stages only ever read one spelling.
 */

/** Entry types this reader knows by name. Any other `@type{...}` record still parses. */
export const BIBTEX_ENTRY_TYPES = ['article', 'inproceedings', 'book', 'misc', 'techreport', 'phdthesis'] as const;

export type BibTeXEntryType = (typeof BIBTEX_ENTRY_TYPES)[number];

/** A record the reader can cite. */
export interface Entry {
  /** Lowercased entry type (`article`, `inproceedings`, ...). */
  type: string;
  /** Citation key, verbatim from the source. */
  key: string;
  /** Field values by lowercased name, with aliases folded; braces and escapes kept. */
  fields: Record<string, string>;
}

/** Why a record could not be read. */
export type BibTeXErrorCode =
  | 'missing-type'
  | 'missing-entry-delimiter'
  | 'unbalanced-entry'
  | 'missing-key'
  | 'malformed-field'
  | 'missing-value'
  | 'unterminated-value'
  | 'concatenation'
  | 'malformed-entry';

/** One record that was skipped, placed by the line its trouble starts on. */
export interface BibTeXError {
  code: BibTeXErrorCode;
  /** 1-based line in the parsed text. */
  line: number;
  /** English diagnostic for logs and tests; not UI copy. */
  message: string;
  /** Entry type when the record got far enough to have one. */
  entryType?: string;
  /** Citation key when the record got far enough to have one. */
  key?: string;
}

export interface BibTeXParse {
  /** Records in the order they appear; a skipped record contributes nothing. */
  entries: Entry[];
  /** Skipped records in the order they appear. An empty list means every record parsed. */
  errors: BibTeXError[];
}

/** Canonical field order for the writer; fields outside the list follow alphabetically. */
const FIELD_ORDER: readonly string[] = [
  'author',
  'editor',
  'title',
  'booktitle',
  'journal',
  'publisher',
  'institution',
  'school',
  'year',
  'volume',
  'number',
  'pages',
  'doi',
  'isbn',
  'issn',
  'url',
  'note',
  'abstract',
  'keywords',
];

/** Records that carry macros or free text and never become an entry. */
const DIRECTIVE_TYPES: readonly string[] = ['comment', 'preamble', 'string'];

/** Letters that Unicode normalisation does not decompose, so folding has to name them. */
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

/** Placeholder author for a record that names nobody, so a key is always produced. */
const ANON_AUTHOR = 'anon';

// --- Parsing ---------------------------------------------------------------

/**
 * Reads every BibTeX record in `text`.
 *
 * The six known types are read field by field; `@string`, `@preamble` and `@comment`
 * are skipped, so a macro definition never becomes an entry and a use of the macro
 * keeps its bare token as the field value (`journal = acm` reads as `acm`). Unknown
 * types such as `@incollection` are read the same way as the known ones, so a record
 * the reader has no special handling for is not silently dropped.
 *
 * A value may be braced, quoted, or bare. Braces nest and a backslash protects the
 * character after it, so `\{` is text rather than structure. `#` concatenation is
 * refused per record: the rest of the file still parses.
 */
export function parseBibTeX(text: string): BibTeXParse {
  const source = typeof text === 'string' ? text : '';
  const entries: Entry[] = [];
  const errors: BibTeXError[] = [];

  let cursor = 0;
  while (cursor < source.length) {
    const at = source.indexOf('@', cursor);
    if (at === -1) break;
    let outcome: EntryOutcome;
    try {
      outcome = parseEntryAt(source, at);
    } catch {
      // A record this reader cannot even navigate is still one bad record, not a crash.
      outcome = {
        entry: null,
        error: {
          code: 'malformed-entry',
          line: lineAt(source, at),
          message: 'This record could not be read and was skipped.',
        },
        next: at + 1,
      };
    }
    if (outcome.entry !== null) entries.push(outcome.entry);
    if (outcome.error !== null) errors.push(outcome.error);
    cursor = outcome.next > at ? outcome.next : at + 1;
  }

  return { entries, errors };
}

interface EntryOutcome {
  entry: Entry | null;
  error: BibTeXError | null;
  /** Offset just past the record, or where scanning should resume after a bad one. */
  next: number;
}

interface BodyOutcome {
  entry: Entry | null;
  error: BibTeXError | null;
}

/**
 * Reads one `@type...` record starting at its `@`.
 *
 * The body is located by counting the matching delimiter, so field parsing never has
 * to decide where the record ends. That is also why an unclosed record is the only
 * error that needs resynchronisation: everything after it would otherwise be read as
 * its fields.
 */
function parseEntryAt(source: string, at: number): EntryOutcome {
  let pos = skipSpace(source, at + 1);
  const typeStart = pos;
  while (pos < source.length && isEntryTypeChar(source.charAt(pos))) pos++;
  const type = source.slice(typeStart, pos).toLowerCase();

  if (type.length === 0) {
    return {
      entry: null,
      error: {
        code: 'missing-type',
        line: lineAt(source, at),
        message: 'An @ must be followed by an entry type, for example @article{key, ...}.',
      },
      next: at + 1,
    };
  }

  pos = skipSpace(source, pos);
  const open = source.charAt(pos);
  if (open !== '{' && open !== '(') {
    return {
      entry: null,
      error: {
        code: 'missing-entry-delimiter',
        line: lineAt(source, pos),
        message: `@${type} is not followed by \`{\` or \`(\`.`,
        entryType: type,
      },
      next: pos,
    };
  }

  const close = open === '{' ? '}' : ')';
  const bodyStart = pos + 1;
  const bodyEnd = findBodyEnd(source, bodyStart, open, close);
  if (bodyEnd === -1) {
    return {
      entry: null,
      error: {
        code: 'unbalanced-entry',
        line: lineAt(source, at),
        message: `@${type} never closes its ${open === '{' ? 'brace' : 'parenthesis'}.`,
        entryType: type,
      },
      next: resyncAfter(source, at + 1),
    };
  }

  if (DIRECTIVE_TYPES.includes(type)) {
    return { entry: null, error: null, next: bodyEnd + 1 };
  }

  const outcome = readEntryBody(source, type, source.slice(bodyStart, bodyEnd), bodyStart);
  return { ...outcome, next: bodyEnd + 1 };
}

/**
 * Reads the key and fields inside one record body.
 *
 * `bodyOffset` is the absolute offset of the body, so every diagnostic keeps the line
 * number of the original text instead of a line inside a substring.
 */
function readEntryBody(source: string, entryType: string, body: string, bodyOffset: number): BodyOutcome {
  const fail = (code: BibTeXErrorCode, at: number, message: string, key?: string): BodyOutcome => {
    const error: BibTeXError = { code, line: lineAt(source, bodyOffset + at), message, entryType };
    if (key !== undefined) error.key = key;
    return { entry: null, error };
  };

  let pos = skipSpace(body, 0);
  const keyStart = pos;
  while (pos < body.length) {
    const ch = body.charAt(pos);
    if (ch === ',' || isSpace(ch)) break;
    pos++;
  }
  const key = body.slice(keyStart, pos);
  pos = skipSpace(body, pos);

  if (key.length === 0) {
    return fail('missing-key', keyStart, `An @${entryType} record needs a citation key before its fields.`);
  }
  if (body.charAt(pos) === '=') {
    return fail('missing-key', keyStart, `An @${entryType} record needs a citation key; \`${key}\` is a field name.`);
  }
  if (pos < body.length && body.charAt(pos) !== ',') {
    return fail('malformed-field', pos, `Expected a comma after the key \`${key}\` of @${entryType}.`, key);
  }
  if (pos < body.length) pos++;

  const fields: Record<string, string> = {};
  for (;;) {
    pos = skipSpace(body, pos);
    while (body.charAt(pos) === ',') {
      pos++;
      pos = skipSpace(body, pos);
    }
    if (pos >= body.length) break;

    const nameStart = pos;
    while (pos < body.length && isFieldNameChar(body.charAt(pos))) pos++;
    const name = body.slice(nameStart, pos).toLowerCase();
    if (name.length === 0) {
      return fail('malformed-field', nameStart, `Expected a field name in @${entryType} \`${key}\`.`, key);
    }

    pos = skipSpace(body, pos);
    if (body.charAt(pos) !== '=') {
      return fail('malformed-field', nameStart, `Field \`${name}\` of @${entryType} \`${key}\` is not followed by \`=\`.`, key);
    }
    pos = skipSpace(body, pos + 1);

    if (body.charAt(pos) === '#') {
      return fail('concatenation', pos, concatenationMessage(name, entryType, key), key);
    }

    const value = readFieldValue(body, pos);
    if ('code' in value) {
      return fail(
        value.code,
        value.at,
        value.code === 'missing-value'
          ? `Field \`${name}\` of @${entryType} \`${key}\` has no value.`
          : `The value of \`${name}\` in @${entryType} \`${key}\` never closes.`,
        key,
      );
    }
    fields[name] = value.text;
    pos = skipSpace(body, value.end);

    if (body.charAt(pos) === '#') {
      return fail('concatenation', pos, concatenationMessage(name, entryType, key), key);
    }
    if (pos < body.length && body.charAt(pos) !== ',') {
      return fail('malformed-field', pos, `Unexpected text after the value of \`${name}\` in @${entryType} \`${key}\`.`, key);
    }
  }

  return { entry: { type: entryType, key, fields: normalizeFields(fields) }, error: null };
}

function concatenationMessage(name: string, entryType: string, key: string): string {
  return `Field \`${name}\` of @${entryType} \`${key}\` uses \`#\` concatenation, which this reader does not resolve.`;
}

interface ValueRead {
  text: string;
  /** Offset just past the value. */
  end: number;
}

interface ValueProblem {
  code: 'missing-value' | 'unterminated-value';
  /** Offset the problem starts at. */
  at: number;
}

/**
 * Reads one field value: `{...}`, `"..."`, or a bare token.
 *
 * A bare token is a number or a macro name. Macros are not expanded, so the token is
 * kept as written; `@string` definitions are skipped, which makes that the honest
 * reading of a record that used one.
 */
function readFieldValue(body: string, from: number): ValueRead | ValueProblem {
  const ch = body.charAt(from);

  if (ch === '{') {
    const end = scanBraced(body, from);
    if (end === -1) return { code: 'unterminated-value', at: from };
    return { text: normalizeText(body.slice(from + 1, end)), end: end + 1 };
  }

  if (ch === '"') {
    const end = scanQuoted(body, from);
    if (end === -1) return { code: 'unterminated-value', at: from };
    return { text: normalizeText(body.slice(from + 1, end)), end: end + 1 };
  }

  let pos = from;
  while (pos < body.length && isBareValueChar(body.charAt(pos))) pos++;
  if (pos === from) return { code: 'missing-value', at: from };
  return { text: body.slice(from, pos), end: pos };
}

/** Index of the `}` matching the `{` at `from`, or -1. A backslash protects its character. */
function scanBraced(body: string, from: number): number {
  let depth = 1;
  for (let i = from + 1; i < body.length; i++) {
    const ch = body.charAt(i);
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the closing `"` that is neither escaped nor inside braces, or -1. */
function scanQuoted(body: string, from: number): number {
  let depth = 0;
  for (let i = from + 1; i < body.length; i++) {
    const ch = body.charAt(i);
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && depth > 0) depth--;
    else if (ch === '"' && depth === 0) return i;
  }
  return -1;
}

/** Index of the delimiter that closes the record body, or -1 when it never closes. */
function findBodyEnd(source: string, from: number, open: string, close: string): number {
  let depth = 1;
  let braces = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source.charAt(i);
    if (ch === '\\') {
      i++;
      continue;
    }
    if (open === '(') {
      // Inside a braced value a parenthesis is text, so only count it outside braces.
      if (ch === '{') braces++;
      else if (ch === '}' && braces > 0) braces--;
      if (braces > 0) continue;
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Where to resume after a record that never closed.
 *
 * Only an `@` that starts a line can be trusted to begin the next record: one inside
 * the broken body could be a field value. When there is no such line the file ends.
 */
function resyncAfter(source: string, from: number): number {
  let pos = from;
  while (pos < source.length) {
    const at = source.indexOf('@', pos);
    if (at === -1) return source.length;
    const previous = at === 0 ? '\n' : source.charAt(at - 1);
    if (previous === '\n' || previous === '\r') return at;
    pos = at + 1;
  }
  return source.length;
}

/**
 * Folds the two aliases the reader accepts into one spelling.
 *
 * The canonical field wins when both are present, and the alias is dropped either way:
 * a later stage that reads `journal` or `year` cannot then see two answers. `date` is
 * folded to its four-digit year, which is what a citation needs.
 */
function normalizeFields(raw: Record<string, string>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) fields[name] = value;

  const journal = fields.journal;
  const journaltitle = fields.journaltitle;
  if (journaltitle !== undefined) {
    if (journal === undefined || journal.length === 0) fields.journal = journaltitle;
    delete fields.journaltitle;
  }

  const date = fields.date;
  if (date !== undefined) {
    const year = fields.year;
    if (year === undefined || year.length === 0) {
      const match = /\d{4}/u.exec(date);
      fields.year = match === null ? date : match[0];
    }
    delete fields.date;
  }

  return fields;
}

/** Collapses whitespace runs, so a value written over several lines reads as one line. */
function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

// --- Stable keys -----------------------------------------------------------

/**
 * Assigns a citation key to every entry, in input order.
 *
 * A key is `firstAuthorYearFirstWord` folded to lowercase alphanumerics:
 * `Nguyễn, Văn An` + `2021` + `Đổi mới` becomes `nguyen2021doi`. When two entries
 * share a base every member of that group gets a letter suffix in input order
 * (`nguyen2021doia`, `nguyen2021doib`), so the pair reads as a pair instead of one
 * record silently winning the name.
 */
export function stableKeys(entries: readonly Entry[]): string[] {
  const list = Array.isArray(entries) ? entries : [];
  const bases = list.map(baseKey);
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);

  const used = new Set<string>();
  return bases.map(base => {
    let assigned = base;
    // A group takes letters; a unique base still has to step aside when an earlier
    // group already took its exact spelling (`foo` -> `fooa` before a lone `fooa`).
    if ((counts.get(base) ?? 0) > 1 || used.has(base)) {
      let step = 0;
      do {
        assigned = `${base}${letterSuffix(step)}`;
        step++;
      } while (used.has(assigned));
    }
    used.add(assigned);
    return assigned;
  });
}

/**
 * Key for one entry: the base when it is unique, or its letter when it collides.
 *
 * `siblingsBefore` is the entries that would be assigned before this one, so
 * `stableKey(second, [first])` returns `...b` for a colliding pair. Without siblings
 * the base is returned, which is why a whole list should go through {@link stableKeys}.
 */
export function stableKey(entry: Entry, siblingsBefore: readonly Entry[] = []): string {
  const keys = stableKeys([...siblingsBefore, entry]);
  const assigned = keys[keys.length - 1];
  return assigned === undefined ? baseKey(entry) : assigned;
}

function baseKey(entry: Entry): string {
  const author = keyPart(firstAuthorFamily(entry)) || ANON_AUTHOR;
  const year = keyPart(yearOf(entry));
  const word = firstTitleWord(entry);
  const base = `${author}${year}${word}`;
  return base.length > 0 ? base : 'untitled';
}

/** `a`..`z`, then `aa`, `ab`, ... so an arbitrarily large group still gets distinct keys. */
function letterSuffix(step: number): string {
  let value = step;
  let suffix = '';
  do {
    suffix = `${String.fromCharCode(97 + (value % 26))}${suffix}`;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return suffix;
}

/** Family name of the first author, falling back to the first editor for edited books. */
function firstAuthorFamily(entry: Entry): string {
  const raw = entry.fields.author ?? entry.fields.editor ?? '';
  const first = splitAuthors(raw)[0];
  if (first === undefined) return '';
  return familyName(first);
}

function familyName(author: string): string {
  const text = plainText(author);
  const comma = topLevelComma(text);
  if (comma >= 0) return text.slice(0, comma).trim();
  const words = text.split(/\s+/u).filter(word => word.length > 0);
  return words[words.length - 1] ?? '';
}

/**
 * Splits an author field on the `and` separator.
 *
 * The separator only counts outside braces and with whitespace on both sides, so
 * `{Barnes and Noble}` stays one author and a surname containing `and` cannot split.
 */
function splitAuthors(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let pos = 0;

  while (pos < raw.length) {
    const ch = raw.charAt(pos);
    if (ch === '{') {
      depth++;
      pos++;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) depth--;
      pos++;
      continue;
    }
    if (depth === 0 && isSpace(ch)) {
      const separator = /^\s+and\s+/iu.exec(raw.slice(pos));
      if (separator !== null) {
        parts.push(raw.slice(start, pos));
        pos += separator[0].length;
        start = pos;
        continue;
      }
    }
    pos++;
  }
  parts.push(raw.slice(start));

  return parts.map(part => part.trim()).filter(part => part.length > 0);
}

/** First comma outside braces, or -1 when the author is written `First Last`. */
function topLevelComma(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '{') depth++;
    else if (ch === '}' && depth > 0) depth--;
    else if (ch === ',' && depth === 0) return i;
  }
  return -1;
}

/** Title text without braces, used to pick the first word of a key. */
function firstTitleWord(entry: Entry): string {
  const title = entry.fields.title ?? '';
  for (const word of foldText(title).split(/\s+/u)) {
    const cleaned = alphanumeric(word);
    if (cleaned.length > 0) return cleaned;
  }
  return '';
}

/** The four-digit year a record means, or an empty string. `date` is already folded. */
function yearOf(entry: Entry): string {
  const year = /\d{4}/u.exec(entry.fields.year ?? '');
  if (year !== null) return year[0] ?? '';
  const date = /\d{4}/u.exec(entry.fields.date ?? '');
  return date === null ? '' : date[0] ?? '';
}

/**
 * Folds text for comparison: LaTeX commands dropped, accents decomposed and removed,
 * letters Unicode does not decompose mapped by hand, and everything lowercased.
 */
function foldText(text: string): string {
  return text
    .replace(/\\[A-Za-z]+\s?/gu, ' ')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[đĐøØæÆœŒßłŁðÐþÞı]/gu, letter => FOLD_LETTERS[letter] ?? letter)
    .toLowerCase();
}

function alphanumeric(text: string): string {
  return text.replace(/[^a-z0-9]/gu, '');
}

function keyPart(text: string): string {
  return alphanumeric(foldText(text));
}

/** Display text without brace protection and with whitespace collapsed. */
function plainText(text: string): string {
  return text.replace(/[{}]/gu, '').replace(/\s+/gu, ' ').trim();
}

// --- Deduplication ---------------------------------------------------------

/** One fold: which key survived and which keys it absorbed. */
export interface DedupeMerge {
  reason: 'doi' | 'title-year';
  keptKey: string;
  droppedKeys: string[];
}

/** Two records claiming one DOI under different keys; the merge is refused. */
export interface DedupeConflict {
  doi: string;
  /** Key that owns the DOI: the first record to carry it. */
  winner: string;
  /** Key that kept its own separate entry because merging would lose it. */
  rejected: string;
  /** English diagnostic for logs and tests; not UI copy. */
  message: string;
}

export interface DedupeResult {
  /** Surviving records in first-seen order, with fields merged into the winner. */
  entries: Entry[];
  /** Folds performed, grouped by reason and winning key. */
  merged: DedupeMerge[];
  /** Same DOI under two keys, where dropping either key would break a citation. */
  conflicts: DedupeConflict[];
}

/**
 * Merges duplicate records by DOI, then by title and year.
 *
 * DOI is authoritative: two records with the same DOI are one work, and their fields
 * are unioned with the first record winning any field both carry. When the same DOI
 * arrives under a different citation key the merge is refused instead, because one of
 * the two keys is very likely cited in the text; both records stay, and the conflict
 * names the key that owns the DOI.
 *
 * Title and year is the fallback for records without a DOI. A collision there is only
 * merged when the two records do not name two different DOIs, so two unrelated works
 * that happen to share a title and year stay apart.
 *
 * Input records are not modified: survivors are copies.
 */
export function dedupe(entries: readonly Entry[]): DedupeResult {
  const list = Array.isArray(entries) ? entries : [];
  const survivors: Entry[] = [];
  const byDoi = new Map<string, Entry>();
  const byTitleYear = new Map<string, Entry>();
  const merged: DedupeMerge[] = [];
  const conflicts: DedupeConflict[] = [];

  const recordMerge = (reason: DedupeMerge['reason'], keptKey: string, droppedKey: string): void => {
    if (keptKey === droppedKey) return;
    const found = merged.find(item => item.reason === reason && item.keptKey === keptKey);
    if (found === undefined) merged.push({ reason, keptKey, droppedKeys: [droppedKey] });
    else if (!found.droppedKeys.includes(droppedKey)) found.droppedKeys.push(droppedKey);
  };

  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const copy: Entry = { type: entry.type, key: entry.key, fields: { ...entry.fields } };
    const doi = normalizeDoi(copy.fields.doi ?? '');
    const titleYear = titleYearKey(copy);

    if (doi.length > 0) {
      const owner = byDoi.get(doi);
      if (owner !== undefined) {
        if (owner.key === copy.key) {
          // The same key cannot be cited twice differently: this is one record repeated.
          mergeFields(owner, copy);
          continue;
        }
        conflicts.push({
          doi,
          winner: owner.key,
          rejected: copy.key,
          message: `DOI ${doi} is claimed by \`${owner.key}\`; \`${copy.key}\` keeps its own entry.`,
        });
        survivors.push(copy);
        if (titleYear.length > 0 && !byTitleYear.has(titleYear)) byTitleYear.set(titleYear, copy);
        continue;
      }
    }

    if (titleYear.length > 0) {
      const owner = byTitleYear.get(titleYear);
      if (owner !== undefined && doDisagree(owner, copy)) {
        // Two different DOIs mean two different works that share a title and year.
      } else if (owner !== undefined) {
        mergeFields(owner, copy);
        recordMerge('title-year', owner.key, copy.key);
        continue;
      }
    }

    survivors.push(copy);
    if (doi.length > 0) byDoi.set(doi, copy);
    if (titleYear.length > 0) byTitleYear.set(titleYear, copy);
  }

  return { entries: survivors, merged, conflicts };
}

/** Fills every field the winner does not already carry. */
function mergeFields(target: Entry, source: Entry): void {
  for (const [name, value] of Object.entries(source.fields)) {
    const current = target.fields[name];
    if ((current === undefined || current.length === 0) && value.length > 0) target.fields[name] = value;
  }
}

/** True when both records name a DOI and the two differ. */
function doDisagree(left: Entry, right: Entry): boolean {
  const leftDoi = normalizeDoi(left.fields.doi ?? '');
  const rightDoi = normalizeDoi(right.fields.doi ?? '');
  return leftDoi.length > 0 && rightDoi.length > 0 && leftDoi !== rightDoi;
}

/** Folded title plus year, empty unless both parts exist. */
function titleYearKey(entry: Entry): string {
  const title = keyPart(entry.fields.title ?? '');
  const year = yearOf(entry);
  if (title.length === 0 || year.length === 0) return '';
  return `${title}\u0000${year}`;
}

/** DOI as an identity, without resolver prefixes or case noise. */
function normalizeDoi(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '')
    .toLowerCase();
}

// --- Writing ---------------------------------------------------------------

/**
 * Writes records as canonical BibTeX.
 *
 * The output is a fixed function of the input: type and fields are ordered the same
 * way every time, two spaces indent a field, every field ends with a comma (which the
 * reader accepts after the last one) and a blank line separates records. Values are
 * braced, with only the braces that could not balance escaped, so a value the reader
 * produced writes back to the same value.
 */
export function toBibTeX(entries: readonly Entry[]): string {
  const list = Array.isArray(entries) ? entries : [];
  const blocks = list.filter(entry => entry !== null && typeof entry === 'object').map(writeEntry);
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}

function writeEntry(entry: Entry): string {
  const rawType = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
  const type = rawType.length > 0 ? rawType : 'misc';
  const rawKey = typeof entry.key === 'string' ? entry.key.trim() : '';
  const key = rawKey.length > 0 ? rawKey : 'untitled';
  const fields = entry.fields ?? {};
  const lines = orderedFieldNames(fields).map(name => `  ${name} = {${writeValue(fields[name] ?? '')}},`);
  return [`@${type}{${key},`, ...lines, '}'].join('\n');
}

/** Known fields in canonical order, then any others alphabetically. */
function orderedFieldNames(fields: Record<string, string>): string[] {
  const names = Object.keys(fields);
  const known = FIELD_ORDER.filter(name => names.includes(name));
  const rest = names.filter(name => !FIELD_ORDER.includes(name)).sort();
  return [...known, ...rest];
}

function writeValue(value: string): string {
  return terminateTrailingEscape(escapeUnbalancedBraces(normalizeText(value)));
}

/**
 * Escapes only the braces that cannot balance.
 *
 * A value the reader produced already balances, so a title that protects its
 * capitalisation (`The {TeX}book`) is written back with those braces intact. A value
 * from a quoted field may carry a lone brace; escaping that one keeps the record
 * parseable, at the cost of the value gaining a backslash on that character.
 */
function escapeUnbalancedBraces(value: string): string {
  const unmatchedOpen = new Set<number>();
  const unmatchedClose = new Set<number>();
  const open: number[] = [];

  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') open.push(i);
    else if (ch === '}') {
      if (open.length === 0) unmatchedClose.add(i);
      else open.pop();
    }
  }
  for (const index of open) unmatchedOpen.add(index);

  if (unmatchedOpen.size === 0 && unmatchedClose.size === 0) return value;

  let result = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch === '\\') {
      result += `${ch}${value.charAt(i + 1)}`;
      i++;
      continue;
    }
    if (unmatchedOpen.has(i)) result += `\\${ch}`;
    else if (unmatchedClose.has(i)) result += `\\${ch}`;
    else result += ch;
  }
  return result;
}

/**
 * Makes a trailing backslash escape itself.
 *
 * A value ending in `\` would otherwise escape the brace the writer puts after it and
 * leave the record unclosed. The value gains one backslash; nothing else can make an
 * odd trailing backslash unambiguous in braced BibTeX.
 */
function terminateTrailingEscape(value: string): string {
  let backslashes = 0;
  for (let i = value.length - 1; i >= 0 && value.charAt(i) === '\\'; i--) backslashes++;
  return backslashes % 2 === 1 ? `${value}\\` : value;
}

// --- Citations -------------------------------------------------------------

export type CitationStyle = 'numeric' | 'author-year' | 'apa';

export interface CitationOptions {
  /** 1-based position in the reference list, printed by `numeric`; defaults to 1. */
  number?: number;
}

/**
 * Formats one record as a citation.
 *
 * `numeric` prints the reference-list number the caller supplies, `author-year` prints
 * `(Family, 2021)` with `&` for two authors and `et al.` beyond that, and `apa` prints
 * an APA-ish reference-line sentence built only from fields the record carries. All
 * three read the same folded fields, so a `journaltitle` and a `date` need no special
 * handling at the call site.
 */
export function formatCitation(entry: Entry, style: CitationStyle, options: CitationOptions = {}): string {
  switch (style) {
    case 'numeric':
      return `[${citationNumber(options?.number)}]`;
    case 'apa':
      return formatApa(entry);
    case 'author-year':
    default:
      return formatAuthorYear(entry);
  }
}

function citationNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 1;
}

function formatAuthorYear(entry: Entry): string {
  const names = authorNames(entry);
  const first = names[0];
  const second = names[1];
  let label: string;
  if (first === undefined) label = 'Anon.';
  else if (second === undefined) label = first;
  else if (names.length === 2) label = `${first} & ${second}`;
  else label = `${first} et al.`;
  return `(${label}, ${yearOf(entry) || 'n.d.'})`;
}

function authorNames(entry: Entry): string[] {
  const raw = entry.fields.author ?? entry.fields.editor ?? '';
  return splitAuthors(raw)
    .map(familyName)
    .filter(name => name.length > 0);
}

function formatApa(entry: Entry): string {
  const authors = apaAuthorList(entry);
  const year = yearOf(entry) || 'n.d.';
  const title = plainText(entry.fields.title ?? '') || 'Untitled';
  const head = authors.length > 0 ? `${authors} (${year}).` : `(${year}).`;
  const segments: string[] = [`${head} ${endSentence(title)}`];

  const venue = apaVenue(entry);
  if (venue.length > 0) segments.push(venue);

  const doi = normalizeDoi(entry.fields.doi ?? '');
  if (doi.length > 0) segments.push(`https://doi.org/${doi}`);
  else {
    const url = (entry.fields.url ?? '').trim();
    if (url.length > 0) segments.push(url);
  }

  return segments.join(' ');
}

/** `Family, I. I.` list with APA's ampersand; `(Ed.)` when the record has no author. */
function apaAuthorList(entry: Entry): string {
  const author = (entry.fields.author ?? '').trim();
  const editorsOnly = author.length === 0;
  const raw = editorsOnly ? entry.fields.editor ?? '' : author;
  const authors = splitAuthors(raw)
    .map(apaAuthor)
    .filter(name => name.length > 0);
  if (authors.length === 0) return '';

  const first = authors[0] ?? '';
  const last = authors[authors.length - 1] ?? '';
  let list: string;
  if (authors.length === 1) list = first;
  else if (authors.length === 2) list = `${first}, & ${last}`;
  else list = `${authors.slice(0, -1).join(', ')}, & ${last}`;

  return editorsOnly ? `${list} (Ed.)` : list;
}

function apaAuthor(author: string): string {
  const text = plainText(author);
  const comma = topLevelComma(text);
  const family = comma >= 0 ? text.slice(0, comma).trim() : lastWord(text);
  const given = comma >= 0 ? text.slice(comma + 1).trim() : '';
  const initials = initialsOf(given);
  if (family.length === 0) return initials;
  return initials.length > 0 ? `${family}, ${initials}` : family;
}

function initialsOf(given: string): string {
  return given
    .split(/[\s.]+/u)
    .filter(part => part.length > 0)
    .map(part => `${part.charAt(0).toUpperCase()}.`)
    .join(' ');
}

function lastWord(text: string): string {
  const words = text.split(/\s+/u).filter(word => word.length > 0);
  return words[words.length - 1] ?? '';
}

/** Journal, book title, publisher or institution, whichever the record carries. */
function apaVenue(entry: Entry): string {
  const pages = apaPages(entry.fields.pages ?? '');
  const journal = plainText(entry.fields.journal ?? '');
  if (journal.length > 0) {
    const volume = (entry.fields.volume ?? '').trim();
    const number = (entry.fields.number ?? '').trim();
    let venue = journal;
    if (volume.length > 0) venue += `, ${volume}${number.length > 0 ? `(${number})` : ''}`;
    if (pages.length > 0) venue += `, ${pages}`;
    return endSentence(venue);
  }

  const booktitle = plainText(entry.fields.booktitle ?? '');
  if (booktitle.length > 0) {
    return endSentence(`In ${booktitle}${pages.length > 0 ? `, ${pages}` : ''}`);
  }

  const publisher = plainText(entry.fields.publisher ?? '');
  if (publisher.length > 0) return endSentence(publisher);

  const institution = plainText(entry.fields.institution ?? entry.fields.school ?? '');
  if (institution.length > 0) {
    const number = (entry.fields.number ?? '').trim();
    return endSentence(`${institution}${number.length > 0 ? ` (${number})` : ''}`);
  }

  return '';
}

/** Page range with an en dash, which is what APA prints. */
function apaPages(value: string): string {
  return value.trim().replace(/\s*(?:--|-|\u2013)\s*/gu, '\u2013');
}

function endSentence(text: string): string {
  return /[.?!]$/u.test(text) ? text : `${text}.`;
}

// --- Characters ------------------------------------------------------------

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function skipSpace(text: string, from: number): number {
  let pos = from;
  while (pos < text.length && isSpace(text.charAt(pos))) pos++;
  return pos;
}

function isEntryTypeChar(ch: string): boolean {
  return isLetter(ch) || isDigit(ch) || ch === '_' || ch === '-' || ch === ':';
}

function isFieldNameChar(ch: string): boolean {
  return isLetter(ch) || isDigit(ch) || ch === '_' || ch === '-' || ch === ':';
}

function isBareValueChar(ch: string): boolean {
  return isLetter(ch) || isDigit(ch) || ch === '.' || ch === '_' || ch === '-' || ch === ':' || ch === '/' || ch === '+';
}

function isLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** 1-based line of an offset; records are small enough that a scan per error is cheap. */
function lineAt(text: string, offset: number): number {
  const end = Math.min(Math.max(0, offset), text.length);
  let line = 1;
  for (let i = 0; i < end; i++) {
    if (text.charAt(i) === '\n') line++;
  }
  return line;
}
