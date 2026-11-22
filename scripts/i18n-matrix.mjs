#!/usr/bin/env node
/**
 * Locale matrix gate (backlog N03).
 *
 * `pnpm exec vitest run --config extension/vitest.config.ts extension/tests/i18n.test.ts`
 * proves the three dictionaries have the same keys.
 * A key count is not a translation: this script prints what the keys *contain* — the same
 * five checks `auditLocales` performs — so a reviewer can see a blank Chinese label or a
 * Vietnamese `{trang}` instead of trusting that equal counts mean equal text.
 *
 * Two deliberate constraints shape it:
 *
 * 1. **The dictionaries are read from the `extension/viewer/src/i18n.ts` text, not imported.** Importing
 *    them would mean running TypeScript, and this gate has to work with a plain `node
 *    scripts/i18n-matrix.mjs` in a checkout where only dependencies are installed. So the
 *    three object literals are lifted out of the source with the pattern in
 *    {@link DICTIONARY_BLOCK} below, and nothing is assumed: a block the pattern cannot
 *    find, an entry line it cannot parse, or a block with no entries at all stops the run
 *    with exit 2 and says exactly what it saw. A gate that silently compares two empty
 *    dictionaries would pass forever; this one refuses to.
 * 2. **The rules are not copied here.** The audit itself comes from
 *    `extension/viewer/src/core/i18n-audit.ts`, which Node executes directly with type stripping (the same
 *    technique `scripts/perf-budget.mjs` uses, and the reason this needs Node 22.18 or
 *    newer). One implementation means the script and the unit test cannot disagree about
 *    what "untranslated" or "placeholder mismatch" means.
 *
 * The extraction is line-oriented because the dictionaries are: one `key: 'value'` entry
 * per line, single- or double-quoted, with no line breaks inside a value — the glossary
 * placeholders that look multi-line carry a literal `\n` escape. Every non-blank line
 * inside a block must parse as one entry. That strictness is the honesty rule: a line the
 * parser skipped would be a key no comparison ever sees, which is exactly the silent
 * false pass this gate exists to prevent.
 *
 * Usage:
 *   node scripts/i18n-matrix.mjs            run the gate
 *   node scripts/i18n-matrix.mjs --help     this text
 *
 * Exit codes: 0 the audit passed, 1 the audit found a disagreement (details printed),
 * 2 the dictionaries could not be extracted or the audit module could not be loaded.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const i18nSource = path.join(root, 'extension', 'viewer', 'src', 'i18n.ts');
const auditSourcePath = path.join(root, 'extension', 'viewer', 'src', 'core', 'i18n-audit.ts');

/**
 * The documented pattern for a dictionary block.
 *
 * It matches the two spellings this repository has used and nothing else:
 *
 *   const en = {                     the reference, `as const`
 *   const vi: Dictionary = {         the two typed locales
 *
 * Anchored to the start of a line, so a nested `const` cannot match, and limited to the
 * three locale names, so `const dictionaries: Record<Locale, Dictionary> = {` — the map
 * that *holds* them — is never mistaken for one of them. The optional `\r` keeps the gate
 * working on a Windows checkout with CRLF line endings, and a leading byte-order mark is
 * stripped before matching, because an editor may add one and neither belongs to the code
 * being checked. Refusing those would fail a file that is fine.
 */
const DICTIONARY_BLOCK = /^const (vi|en|zh)(?::\s*Dictionary)? = \{\r?$/gm;

/** One entry line: `key: 'value',`, with either quote style and escapes inside. */
const ENTRY_LINE = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*$/;

/** Escapes a JavaScript string literal may carry. Anything else is reported, not guessed. */
const ESCAPES = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  0: '\0',
  '\\': '\\',
  "'": "'",
  '"': '"',
};

/** Locales in report order: the reference first, then the two compared against it. */
const LOCALES = ['en', 'vi', 'zh'];

/** The locales compared against the reference. */
const COMPARED_LOCALES = LOCALES.filter(locale => locale !== 'en');

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function usage() {
  console.error(`Usage: node scripts/i18n-matrix.mjs

Reads the three dictionaries out of extension/viewer/src/i18n.ts as text (they are never
imported), audits them with extension/viewer/src/core/i18n-audit.ts, and prints the
differences as a table.

The extraction pattern is the object literal line, exactly:
  const en = {                    the reference, declared "as const"
  const vi: Dictionary = {        the two typed locales
Every non-blank line inside a block must be one "key: 'value'" entry.

Exit codes: 0 the audit passed, 1 the audit found a disagreement, 2 the dictionaries could
not be extracted (a missing block, an unparsable entry, an empty block) or the audit module
could not be loaded.`);
}

/**
 * Reads the 1-based source line of an index. Only used for messages, so the cost is fine.
 */
function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Finds the `}` that closes the block opened at `openIndex`, skipping braces inside string
 * literals. Without the quote tracking, `searchResults: '{count} results'` would close the
 * block early at the placeholder's brace.
 */
function findBlockEnd(source, openIndex) {
  let depth = 0;
  let cursor = openIndex;
  let quote = null;
  while (cursor < source.length) {
    const character = source.charAt(cursor);
    if (quote !== null) {
      if (character === '\\') {
        cursor += 2;
        continue;
      }
      if (character === quote) quote = null;
      cursor += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      cursor += 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return -1;
}

/** Resolves the string escapes a literal may carry; returns null for one it does not know. */
function unescapeValue(raw) {
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw.charAt(index);
    if (character !== '\\') {
      out += character;
      continue;
    }
    const next = raw.charAt(index + 1);
    if (next === '' || !Object.hasOwn(ESCAPES, next)) return null;
    out += ESCAPES[next];
    index += 1;
  }
  return out;
}

/**
 * Parses one block body into `key -> value`, refusing anything it does not recognise.
 * `openingLine` is the 1-based line of the `{`, so a problem can name the source line.
 */
function parseBlock(body, openingLine) {
  const entries = new Map();
  const problems = [];
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    const match = ENTRY_LINE.exec(line);
    if (!match) {
      problems.push(`line ${openingLine + index}: not a "key: 'value'" entry: ${line.trim()}`);
      continue;
    }
    const key = match[1];
    if (key === undefined) {
      problems.push(`line ${openingLine + index}: entry without a key: ${line.trim()}`);
      continue;
    }
    const raw = match[2] ?? match[3] ?? '';
    const value = unescapeValue(raw);
    if (value === null) {
      problems.push(`line ${openingLine + index}: "${key}" carries an escape this parser does not know`);
      continue;
    }
    if (entries.has(key)) problems.push(`line ${openingLine + index}: duplicate key "${key}"`);
    entries.set(key, value);
  }
  return { entries, problems };
}

/** Extracts the three dictionary blocks, or explains everything that stopped extraction. */
function extractDictionaries(source) {
  const found = new Map();
  const problems = [];
  for (const match of source.matchAll(DICTIONARY_BLOCK)) {
    const locale = match[1];
    const start = match.index ?? 0;
    // The offset is taken from the brace itself, never from the end of the match: with
    // CRLF line endings the match also covers the `\r`, and counting back from its end
    // would hand `findBlockEnd` a position one character past the block it must scan.
    const openIndex = start + match[0].indexOf('{');
    const openingLine = lineAt(source, openIndex);
    const end = findBlockEnd(source, openIndex);
    if (end < 0) {
      problems.push(`the block for "${locale}" at line ${openingLine} never closes`);
      continue;
    }
    if (found.has(locale)) {
      problems.push(`the pattern matched more than one block for "${locale}" (again at line ${openingLine})`);
      continue;
    }
    const parsed = parseBlock(source.slice(openIndex + 1, end), openingLine);
    problems.push(...parsed.problems);
    found.set(locale, {
      locale,
      openingLine,
      header: match[0].replace(/\s*\{\s*$/u, ''),
      entries: parsed.entries,
    });
  }
  return { found, problems };
}

/** Fixed-width table: first column left-aligned, the rest right-aligned. */
function formatTable(header, rows) {
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map(cells => cells[index].length)));
  const line = cells => cells.map((cell, index) => (index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]))).join('  ');
  return [line(header), widths.map(width => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

/** Renders placeholder names the way the dictionary spells them. */
function renderPlaceholders(names) {
  return names.length === 0 ? '(none)' : names.map(name => `{${name}}`).join(' ');
}

function countBy(list, locale) {
  return list.filter(entry => entry.locale === locale).length;
}

/**
 * Names the locale a mismatch belongs to.
 *
 * The audit record does not carry a locale — the reference side is always English, and
 * `actual` identifies the other side. This looks that side up in the dictionaries the
 * script already extracted, so a table row can say `vi` or `zh` instead of forcing the
 * reader to diff two token lists. It resolves by evidence (an exact match against a real
 * value), never by guessing; an unresolvable entry is printed as `?`.
 */
function localesWithActual(actual, key, dictionaries) {
  return COMPARED_LOCALES.filter(locale => {
    const value = dictionaries.get(locale)?.entries.get(key);
    if (value === undefined) return false;
    const names = auditModule.extractPlaceholders(value);
    return names.length === actual.length && names.every((name, index) => name === actual[index]);
  });
}

/** Loads the audit rules from the shipped module; a failure here is exit 2, never a pass. */
async function loadAudit() {
  try {
    return await import(pathToFileURL(auditSourcePath).href);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`cannot load ${relative(auditSourcePath)}: ${reason}\n`
      + 'The gate executes the shipped TypeScript directly, which needs Node 22.18 or newer '
      + `(type stripping). This is Node ${process.version}.`, 2);
    return null;
  }
}

// --- Main ------------------------------------------------------------------

if (process.argv.slice(2).length > 0) {
  if (process.argv[2] === '--help' || process.argv[2] === '-h') {
    usage();
    process.exit(0);
  }
  console.error(`Unknown argument: ${process.argv[2]}`);
  usage();
  process.exit(2);
}

let source;
try {
  source = readFileSync(i18nSource, 'utf8').replace(/^\uFEFF/u, '');
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  fail(`cannot read ${relative(i18nSource)}: ${reason}`, 2);
}

const auditModule = await loadAudit();
const { found, problems } = extractDictionaries(source);

for (const locale of LOCALES) {
  const block = found.get(locale);
  if (block === undefined) {
    problems.push(`no dictionary block for "${locale}": the line "const ${locale} = {" or ` +
      `"const ${locale}: Dictionary = {" was not found`);
  } else if (block.entries.size === 0) {
    problems.push(`the block for "${locale}" at line ${block.openingLine} parsed to zero entries`);
  }
}

if (problems.length > 0) {
  console.error(`locale-matrix: cannot extract three dictionaries from ${relative(i18nSource)}`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('Nothing was compared. Fix the extraction (or the file), then run the gate again.');
  process.exit(2);
}

const dictionaries = {
  vi: Object.fromEntries(found.get('vi').entries),
  en: Object.fromEntries(found.get('en').entries),
  zh: Object.fromEntries(found.get('zh').entries),
};

const audit = auditModule.auditLocales(dictionaries);
const referenceKeys = Object.keys(dictionaries.en).length;

console.log('Locale matrix — three dictionaries read from extension/viewer/src/i18n.ts as text');
console.log('');
for (const locale of LOCALES) {
  const block = found.get(locale);
  const note = locale === 'en' ? 'reference' : 'compared';
  console.log(`  ${locale}  line ${String(block.openingLine).padStart(3)}  ${note.padEnd(9)}  ${String(block.entries.size).padStart(3)} entries  ${block.header}`);
}
console.log('');

const failures = locale => countBy(audit.missing, locale)
  + countBy(audit.extra, locale)
  + countBy(audit.placeholderMismatch, locale)
  + countBy(audit.emptyValues, locale)
  + countBy(audit.untranslated, locale);

const row = locale => {
  const reference = locale === 'en';
  return [
    locale,
    String(found.get(locale).entries.size),
    reference ? '-' : String(countBy(audit.missing, locale)),
    reference ? '-' : String(countBy(audit.extra, locale)),
    reference ? '-' : String(countBy(audit.placeholderMismatch, locale)),
    String(countBy(audit.emptyValues, locale)),
    reference ? '-' : String(countBy(audit.untranslated, locale)),
    failures(locale) === 0 ? 'ok' : 'FAIL',
  ];
};

console.log(formatTable(
  ['locale', 'keys', 'missing', 'extra', 'placeholder', 'empty', 'untranslated', 'result'],
  LOCALES.map(row),
));

if (!audit.ok) {
  console.log('');
  if (audit.missing.length > 0) {
    console.log(`missing keys (${audit.missing.length}) — a locale lacks a reference key`);
    for (const entry of audit.missing) console.log(`  ${entry.locale}  ${entry.key}`);
  }
  if (audit.extra.length > 0) {
    console.log(`extra keys (${audit.extra.length}) — no reference key, so t() cannot reach it`);
    for (const entry of audit.extra) console.log(`  ${entry.locale}  ${entry.key}`);
  }
  if (audit.placeholderMismatch.length > 0) {
    console.log(`placeholder mismatches (${audit.placeholderMismatch.length}) — names t() would not substitute`);
    const rows = audit.placeholderMismatch.map(entry => {
      const locales = localesWithActual(entry.actual, entry.key, found);
      return [
        locales.length === 0 ? '?' : locales.join(','),
        entry.key,
        renderPlaceholders(entry.expected),
        renderPlaceholders(entry.actual),
      ];
    });
    console.log(formatTable(['locale', 'key', 'expected (en)', 'actual'], rows).split('\n').map(line => `  ${line}`).join('\n'));
  }
  if (audit.emptyValues.length > 0) {
    console.log(`empty values (${audit.emptyValues.length}) — renders as a blank label`);
    for (const entry of audit.emptyValues) console.log(`  ${entry.locale}  ${entry.key}`);
  }
  if (audit.untranslated.length > 0) {
    console.log(`untranslated (${audit.untranslated.length}) — identical to English and longer than ${auditModule.UNTRANSLATED_MAX_SAFE_LENGTH} characters`);
    for (const entry of audit.untranslated) console.log(`  ${entry.locale}  ${entry.key}`);
  }
}

console.log('');
const values = Object.keys(dictionaries.vi).length + referenceKeys + Object.keys(dictionaries.zh).length;
if (audit.ok) {
  console.log(`PASS: 3 locales, ${referenceKeys} reference keys, ${values} values compared, placeholders included.`);
  console.log('A clean matrix means nothing obvious is wrong; it is not a proofread.');
  process.exit(0);
}
const total = audit.missing.length + audit.extra.length + audit.placeholderMismatch.length + audit.emptyValues.length + audit.untranslated.length;
console.log(`FAILED: ${audit.missing.length} missing, ${audit.extra.length} extra, ${audit.placeholderMismatch.length} placeholder, ${audit.emptyValues.length} empty, ${audit.untranslated.length} untranslated (${total} total).`);
process.exit(1);
