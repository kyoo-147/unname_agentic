#!/usr/bin/env node
// Gate: user-facing English string literals in the native (GPUI) UI.
//
// The native shell renders text through `crate::i18n::tr3(zh, en, vi)` (or the
// older `tr(zh, en)`, `settings::text(..)`). A literal written straight into an
// element builder therefore ships as English no matter what the interface
// language is — that is exactly what C14 caught in the capture picker, and the
// point of this scan is to stop trusting a review and let the tree fail instead.
//
// WHAT IS SCANNED
//   Every `*.rs` file directly under `native-shell/src/` (the shell's UI
//   sources). The list is intentionally flat and fixed: nested modules such as
//   `pdf_reader/view.rs` are outside this first gate and are named here so the
//   omission is a decision, not an accident.
//
// WHAT COUNTS AS UI TEXT
//   A string literal that is a *direct argument* of an element-text builder:
//     .child("...")   .text("...")   .tip("...")
//     Text::new("...")   Label::new("...")
//     ui_text("...")   ui_para("...")   menu_label("...")
//     primary_button("id", "...")   secondary_button("id", "...")
//   and that reads as English prose: at least two words and a leading capital.
//
// WHAT IS NOT FLAGGED, AND WHY
//   - `tr3` / `tr3_fill` / `tr` / `settings::text(..)` arguments: already
//     translated. They are not arguments of a builder, so no context matches.
//   - `format!` strings, including ones passed to `tr3_fill`: the literal's
//     preceding token is `format!`, not a builder.
//   - logging and error reporting (`eprintln!`, `log::*`, `anyhow::bail!`,
//     `Err(..)`, `.map_err(..)`): never UI text, and never a builder argument.
//   - CSS class names, element ids, file extensions and icon names: lowercase
//     or hyphenated, and single-word strings fail the two-word rule.
//   - single capitalized labels ("Endpoint"): a word, not prose; the mission's
//     rule is two or more words.
//   - `#[cfg(test)]` regions are blanked before scanning, so test fixtures and
//     test-only labels cannot fail the gate.
//
// EXCEPTIONS
//   `scripts/ui-strings-allowlist.txt` holds accepted strings, one per line:
//       <path>:<literal>  # <reason>
//   The reason is mandatory — an entry without one is a configuration error, so
//   an exception cannot be added silently. A literal is matched on its decoded
//   value (the text as Rust will read it) and cannot itself contain " # "; a
//   trailing `#` comment line is documentation. Stale entries are reported as
//   warnings, not failures.
//
// USAGE
//   node scripts/check-ui-strings.mjs                 # scans the repository
//   node scripts/check-ui-strings.mjs --root <dir>    # scans <dir> instead
//   node scripts/check-ui-strings.mjs --json          # machine-readable report
//
// EXIT CODES
//   0 clean, 1 at least one un-allowlisted English UI literal, 2 setup error
//   (missing source directory, malformed allowlist, unreadable file).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE_DIR = 'native-shell/src';
const ALLOWLIST_FILE = 'scripts/ui-strings-allowlist.txt';

function fail(message) {
  console.error(`ui-strings: ${message}`);
  process.exit(2);
}

const options = { root: process.cwd(), json: false };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) fail('--root needs a directory');
      options.root = path.resolve(value);
      i += 1;
    } else fail(`unknown argument ${arg}`);
  }
}

/**
 * Decode the escapes a Rust string literal can carry. Good enough to compare a
 * literal against an allowlist entry and to print it as the UI will show it.
 */
function decodeLiteral(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === 'n') { out += '\n'; i += 1; }
    else if (next === 'r') { out += '\r'; i += 1; }
    else if (next === 't') { out += '\t'; i += 1; }
    else if (next === '0') { out += '\0'; i += 1; }
    else if (next === '\\') { out += '\\'; i += 1; }
    else if (next === '"') { out += '"'; i += 1; }
    else if (next === "'") { out += "'"; i += 1; }
    else if (next === 'x') { out += String.fromCharCode(Number.parseInt(raw.slice(i + 2, i + 4), 16)); i += 3; }
    else if (next === 'u' && raw[i + 2] === '{') {
      const close = raw.indexOf('}', i + 3);
      const code = Number.parseInt(raw.slice(i + 3, close), 16);
      out += String.fromCodePoint(Number.isFinite(code) ? code : 0xfffd);
      i = close;
    } else { out += ch; i += 1; }
  }
  return out;
}

/**
 * Walk the source once and yield string literals while marking which byte
 * positions are code. Comments and string bodies are not code; the marking is
 * what lets test-region stripping count braces without tripping over a `{` in a
 * string or a comment.
 */
function lex(text) {
  const literals = [];
  const isCode = new Uint8Array(text.length).fill(1);
  const lineAt = offset => text.slice(0, offset).split('\n').length;

  const mark = (from, to) => { for (let k = from; k < to && k < text.length; k += 1) isCode[k] = 0; };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '/' && next === '/') {
      const start = i;
      while (i < text.length && text[i] !== '\n') i += 1;
      mark(start, i);
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      let depth = 0;
      while (i < text.length) {
        if (text[i] === '/' && text[i + 1] === '*') { depth += 1; i += 2; continue; }
        if (text[i] === '*' && text[i + 1] === '/') { depth -= 1; i += 2; if (depth === 0) break; continue; }
        i += 1;
      }
      mark(start, i);
      continue;
    }

    // Raw string: r"..", r#".."#, r##".."##, and the byte forms br".."/br#".."#.
    const rawPrefix = /^(?:br|r)(#*)"/.exec(text.slice(i, i + 8));
    if (rawPrefix && (ch === 'r' || (ch === 'b' && next === 'r'))) {
      const hashes = rawPrefix[1];
      const start = i;
      const bodyStart = i + rawPrefix[0].length;
      const terminator = `"${hashes}`;
      const close = text.indexOf(terminator, bodyStart);
      const bodyEnd = close === -1 ? text.length : close;
      literals.push({
        value: text.slice(bodyStart, bodyEnd),
        start,
        line: lineAt(start),
      });
      i = close === -1 ? text.length : close + terminator.length;
      mark(start, i);
      continue;
    }

    // Byte string: b"..", same escapes as a normal literal.
    if (ch === 'b' && next === '"') {
      i += 1;
      continue; // the plain-string branch below handles it from the quote
    }

    if (ch === '"') {
      const start = i;
      let body = '';
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { body += text.slice(i, i + 2); i += 2; continue; }
        if (text[i] === '"') break;
        body += text[i];
        i += 1;
      }
      const end = Math.min(i + 1, text.length);
      literals.push({ value: decodeLiteral(body), start, line: lineAt(start) });
      i = end;
      mark(start, end);
      continue;
    }

    // A char literal is code; a lifetime is not a string at all.
    if (ch === "'") {
      const charLiteral = /^'(?:\\.|[^'\\])'/.exec(text.slice(i, i + 6));
      if (charLiteral) {
        i += charLiteral[0].length;
        continue;
      }
      i += 1;
      continue;
    }

    i += 1;
  }
  return { literals, isCode };
}

/** Blank every `#[cfg(test)]` item, so test-only labels cannot fail the gate. */
function maskTestRegions(text, isCode) {
  const masked = new Uint8Array(text.length);
  let index = text.indexOf('#[cfg(test)]');
  while (index !== -1) {
    if (!isCode[index]) { index = text.indexOf('#[cfg(test)]', index + 1); continue; }

    // An item either opens a brace (fn, mod, impl) or ends at a semicolon
    // (`use`, a const). Whichever comes first in code decides how far to mask,
    // so a brace far below cannot swallow production code.
    let firstBrace = -1;
    let firstSemicolon = -1;
    for (let j = index; j < text.length; j += 1) {
      if (!isCode[j]) continue;
      if (text[j] === '{') { firstBrace = j; break; }
      if (text[j] === ';') { firstSemicolon = j; break; }
    }

    let close = text.length - 1;
    if (firstSemicolon !== -1 && (firstBrace === -1 || firstSemicolon < firstBrace)) {
      close = firstSemicolon;
    } else if (firstBrace !== -1) {
      let depth = 0;
      close = firstBrace;
      for (let j = firstBrace; j < text.length; j += 1) {
        if (!isCode[j]) continue;
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') {
          depth -= 1;
          if (depth === 0) { close = j; break; }
        }
      }
    }

    for (let k = index; k <= close; k += 1) masked[k] = 1;
    index = text.indexOf('#[cfg(test)]', close + 1);
  }
  return masked;
}

const UI_TEXT_BUILDERS = [
  /\.child\(\s*$/,
  /\.text\(\s*$/,
  /\.tip\(\s*$/,
  /(?:^|[^\w:])(?:Text|Label)::new\(\s*$/,
  /\b(?:ui_text|ui_para|menu_label)\(\s*$/,
  /\b(?:primary_button|secondary_button)\(\s*"[^"]*"\s*,\s*$/,
];

/** The English look: leading capital, two or more words, only Latin punctuation. */
function looksLikeEnglishProse(value) {
  if (!/^[A-Z]/.test(value)) return false;
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  return /^[\x20-\x7E…·—–‘’“”]+$/.test(value);
}

/** The literal is the direct argument of an element-text builder. */
function isElementText(text, literalStart) {
  const before = text.slice(Math.max(0, literalStart - 200), literalStart);
  return UI_TEXT_BUILDERS.some(pattern => pattern.test(before));
}

function parseAllowlist(file) {
  const entries = new Map();
  const reasons = new Map();
  if (!existsSync(file)) return { entries, reasons };
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const where = `${ALLOWLIST_FILE}:${index + 1}`;
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const split = line.indexOf(' # ');
    if (split === -1) fail(`${where}: every entry needs a reason, as "<path>:<literal>  # <reason>"`);
    const location = line.slice(0, split).trim();
    const reason = line.slice(split + 3).trim();
    if (!reason) fail(`${where}: the reason after "#" is empty`);
    const colon = location.indexOf(':');
    if (colon === -1) fail(`${where}: expected "<path>:<literal>"`);
    const pathPart = location.slice(0, colon).trim();
    const literal = location.slice(colon + 1).trim();
    if (!pathPart || !literal) fail(`${where}: both the path and the literal are required`);
    entries.set(`${pathPart}:${literal}`, true);
    reasons.set(`${pathPart}:${literal}`, reason);
  });
  return { entries, reasons };
}

const sourceDirectory = path.join(options.root, SOURCE_DIR);
if (!existsSync(sourceDirectory)) fail(`no ${SOURCE_DIR} under ${options.root}`);

let files;
try {
  files = readdirSync(sourceDirectory).filter(name => name.endsWith('.rs')).sort();
} catch (error) {
  fail(`cannot list ${SOURCE_DIR}: ${error.message}`);
}
if (files.length === 0) fail(`${SOURCE_DIR} holds no Rust files`);

const allowlistPath = path.join(options.root, ALLOWLIST_FILE);
const allowlist = parseAllowlist(allowlistPath);

const findings = [];
let literalCount = 0;
for (const name of files) {
  const absolute = path.join(sourceDirectory, name);
  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    fail(`cannot read ${absolute}: ${error.message}`);
  }
  const { literals, isCode } = lex(text);
  const masked = maskTestRegions(text, isCode);
  const relative = `${SOURCE_DIR}/${name}`;
  literalCount += literals.length;
  for (const literal of literals) {
    if (masked[literal.start]) continue;
    if (!looksLikeEnglishProse(literal.value)) continue;
    if (!isElementText(text, literal.start)) continue;
    const key = `${relative}:${literal.value}`;
    findings.push({ file: relative, line: literal.line, literal: literal.value, reason: allowlist.reasons.get(key) ?? null });
  }
}

const violations = findings.filter(finding => !finding.reason);
const allowlisted = findings.filter(finding => finding.reason);
const used = new Set(findings.map(finding => `${finding.file}:${finding.literal}`));
const unusedAllowlist = [...allowlist.entries.keys()].filter(key => !used.has(key));

const summary = `ui-strings: ${files.length} file(s) scanned, ${literalCount} string literal(s), `
  + `${findings.length} user-facing English literal(s), ${allowlisted.length} allowlisted, ${violations.length} to fix`;

if (options.json) {
  console.log(JSON.stringify({
    ok: violations.length === 0,
    root: options.root,
    sourceDirectory: SOURCE_DIR,
    allowlist: existsSync(allowlistPath) ? ALLOWLIST_FILE : null,
    scannedFiles: files.map(name => `${SOURCE_DIR}/${name}`),
    files: files.length,
    literals: literalCount,
    findings,
    violations,
    unusedAllowlist,
    summary,
  }, null, 2));
} else {
  for (const finding of allowlisted) {
    console.log(`  allowed  ${finding.file}:${finding.line}  "${finding.literal}"  — ${finding.reason}`);
  }
  for (const violation of violations) {
    console.log(`  ENGLISH  ${violation.file}:${violation.line}  "${violation.literal}"`);
  }
  for (const unused of unusedAllowlist) {
    console.warn(`ui-strings: warning: allowlist entry matches nothing: ${unused}`);
  }
  if (violations.length) {
    console.log(summary);
    console.error(`ui-strings: route each literal above through crate::i18n::tr3(zh, en, vi), `
      + `or add a documented exception to ${ALLOWLIST_FILE}`);
  } else {
    console.log(summary);
  }
}

process.exit(violations.length === 0 ? 0 : 1);
