/**
 * "Will this PDF open?" — the check that runs before the reader waits (backlog E13).
 *
 * A file the reader has just chosen can be a 200-page report that renders in half a second,
 * or a download that stopped at 60 per cent and will never render at all. Today the reader
 * finds out the hard way, after the wait. This module answers the question from the bytes
 * alone, in one pass, before a parser is started: are the landmarks a viewer looks for
 * actually there, and if one is missing, what should the person holding the file do next?
 *
 * Two entry points, kept apart on purpose:
 *
 * - {@link inspectPdf} reads the bytes: header version, `startxref` pointer, trailer,
 *   object count, `/Encrypt`, the end marker, whether the cross-reference table is a stream,
 *   and the signs of incremental updates. Every finding carries a stable code and one
 *   English sentence; the report also carries `healthy` and a `confidence` that says how
 *   much the scan could see.
 * - {@link diagnose} turns that report into one decision — `ok`, `warning` or `broken` —
 *   plus one recommendation that names the fallback: repair, another engine, OCR, or the
 *   password. It never re-reads bytes, so a UI can re-diagnose without repeating the scan.
 *
 * Contract:
 *
 * - **Pure and deterministic.** No clock, no randomness, no DOM, no network, no I/O, no
 *   dependency. The same bytes always produce the same report, field for field.
 * - **Heuristic, never a parser.** There is no object walk, no stream decoding, no
 *   decompression and no offset validation. `objects` counts `N G obj` definitions, so an
 *   object packed into an object stream is invisible and the count is a **floor**, not a
 *   total — `confidence` says so. Nothing here proves a viewer will open the file, only
 *   that the landmarks a viewer looks for are where a scan can see them.
 * - **A fault is graded by what it costs.** An error (`empty-file`, `missing-header`,
 *   `truncated`, `no-objects`) means the document cannot be read as it stands, so `healthy`
 *   is false. A warning (`missing-startxref`, `missing-trailer`, `missing-eof`,
 *   `encrypted`) means the file is worth opening, possibly after one extra step, so
 *   `healthy` stays true. `healthy` therefore reads as "nothing here says this will fail",
 *   not as a promise.
 * - **Absence is evidence only where the format requires presence.** A PDF 1.5 file whose
 *   cross-reference table is a stream has no `trailer` keyword at all: that absence is the
 *   format speaking, so it is not reported. A file that lost its trailer, its `startxref`
 *   and its `%%EOF` together is not modern, it is truncated.
 * - **Codes are the contract; sentences are the diagnostics.** `code` is what a UI switches
 *   on and localises. `message`, `recommendation` and `level` are English text a log and a
 *   test read without a translation, so they change only together with their tests.
 * - **Nothing is repaired.** No byte is rewritten. A caller may show a warning and open the
 *   file anyway, or repair a copy and inspect that copy again.
 *
 * What it does not do: it does not extract text, so it cannot say whether a scan needs OCR.
 * That is why {@link diagnose} takes an optional {@link PdfHealthContext} whose
 * `textExtraction` field is the caller's own result — the reader knows what extraction
 * returned; the bytes do not.
 */

// --- Public shape ----------------------------------------------------------

/**
 * What a finding costs the reader.
 *
 * - `error`: the document cannot be opened as it stands. {@link PdfInspection.healthy} is
 *   false whenever one of these is present.
 * - `warning`: the document is worth opening, but one extra step or one lenient viewer may
 *   be needed. `healthy` stays true.
 */
export type PdfProblemSeverity = 'warning' | 'error';

/**
 * Every fault {@link inspectPdf} can report. Codes are stable and never localised here.
 *
 * - `empty-file`: there are no bytes to inspect. Nothing can open an empty file.
 * - `missing-header`: no `%PDF-` in the first {@link HEADER_WINDOW_BYTES} bytes, where
 *   viewers look for it. The file is not a PDF, or its beginning was lost.
 * - `truncated`: the trailer, the `startxref` pointer and the end marker are all gone
 *   together, which is what a cut-off download looks like. The cross-reference structure
 *   cannot be recovered without a repair tool.
 * - `missing-startxref`: the file has no cross-reference pointer. Most viewers rebuild the
 *   table by scanning objects, so this is a warning rather than a failure.
 * - `missing-trailer`: the file has no `trailer` dictionary and no cross-reference stream
 *   either. A viewer has to find the catalog another way.
 * - `missing-eof`: the bytes do not end with `%%EOF`; the file may have been cut short or
 *   had bytes appended.
 * - `no-objects`: the scan found no `N G obj` definition, so there is no content to read.
 * - `encrypted`: `/Encrypt` is present, so opening the file needs its password.
 */
export type PdfProblemCode =
  | 'empty-file'
  | 'missing-header'
  | 'truncated'
  | 'missing-startxref'
  | 'missing-trailer'
  | 'missing-eof'
  | 'no-objects'
  | 'encrypted';

/** One finding: a stable code, what it costs, and the sentence a human reads. */
export interface PdfProblem {
  readonly code: PdfProblemCode;
  readonly severity: PdfProblemSeverity;
  /** One English sentence. Shown in a log or a diagnostic panel, not localised here. */
  readonly message: string;
}

/**
 * How much the scan could see, not how good the document is.
 *
 * - `high`: every landmark is present, no finding, and no object stream or incremental
 *   update hides part of the file from a byte scan.
 * - `medium`: the structure is visible but the scan is known to be partial — an xref
 *   stream or an object stream packs objects out of sight, the file carries incremental
 *   updates, or a warning was raised.
 * - `low`: the file is empty, is not a PDF, is truncated, or defines no objects, so the
 *   report describes very little.
 */
export type PdfConfidence = 'high' | 'medium' | 'low';

/**
 * What one byte scan found, and what a caller may and may not conclude from it.
 *
 * The first six fields are the answer the UI needs; the rest are the facts behind it, so a
 * diagnostic panel can show *why* a file was judged healthy or not without rescanning.
 */
export interface PdfInspection {
  /** True when no finding has `severity: 'error'`. A warning never clears it. */
  readonly healthy: boolean;
  /** Header version as `"1.7"` style, or null when no parseable header was seen. */
  readonly version: string | null;
  /** True when `/Encrypt` appears: the document needs its password before it can open. */
  readonly encrypted: boolean;
  /**
   * Number of `N G obj` definitions found. A floor, not a total: objects packed into an
   * object stream are invisible to a byte scan, and an incrementally updated object counts
   * once per definition.
   */
  readonly objects: number;
  /** Every finding, in a stable order. Empty means the scan raised no objection. */
  readonly problems: readonly PdfProblem[];
  /** How much of the document the scan could see. See {@link PdfConfidence}. */
  readonly confidence: PdfConfidence;
  /** Size of the inspected buffer in bytes. */
  readonly size: number;
  /** True when the `startxref` pointer appears anywhere in the file. */
  readonly hasStartXref: boolean;
  /** True when a `trailer << … >>` dictionary appears. A 1.5+ xref stream has none. */
  readonly hasTrailer: boolean;
  /** True when the last non-padding byte ends the `%%EOF` marker. */
  readonly hasEof: boolean;
  /** True when the file carries a cross-reference stream (`/Type /XRef`, PDF 1.5+). */
  readonly xrefStream: boolean;
  /** True when the file packs objects into object streams (`/Type /ObjStm`). */
  readonly objectStream: boolean;
  /** Number of `%%EOF` markers seen: one per saved revision, so one on a freshly written file. */
  readonly revisions: number;
  /**
   * True when the bytes show signs of an incremental update: more than one `%%EOF`, more
   * than one `startxref`, or a `/Prev` entry pointing at an earlier revision.
   */
  readonly incremental: boolean;
}

/** What the reader should expect, in one word. */
export type PdfHealthLevel = 'ok' | 'warning' | 'broken';

/**
 * The fallback {@link diagnose} recommends, as a stable code.
 *
 * - `open`: nothing stands in the way.
 * - `open-with-fallback-engine`: open it as is; if the viewer refuses, a different engine
 *   can rebuild the cross-reference table.
 * - `repair`: the structure is damaged; repair a copy with a PDF repair tool.
 * - `ask-password`: the file is encrypted; the password has to come from the sender.
 * - `ocr`: the file opens but yields no text; the pages are probably scans.
 * - `redownload`: there are no bytes; the copy itself is the problem.
 */
export type PdfHealthAction =
  | 'open'
  | 'open-with-fallback-engine'
  | 'repair'
  | 'ask-password'
  | 'ocr'
  | 'redownload';

/** The decision for one inspection: how bad it is, and the one step that helps most. */
export interface PdfDiagnosis {
  readonly level: PdfHealthLevel;
  readonly action: PdfHealthAction;
  /** One English sentence naming the fallback. Shown to the reader verbatim. */
  readonly recommendation: string;
}

/**
 * What the caller knows that the bytes cannot say.
 *
 * `textExtraction` is the result of the reader's own extraction attempt: `'text'` produced
 * something, `'none'` produced nothing (the usual signature of a scan), `'unknown'` or an
 * omitted field means extraction has not run. Without it, {@link diagnose} cannot tell a
 * scanned page from a searchable one and never recommends OCR on a guess.
 */
export interface PdfHealthContext {
  readonly textExtraction?: 'text' | 'none' | 'unknown';
}

// --- Scan parameters -------------------------------------------------------

/** Bytes of the file start searched for the `%PDF-` header, where viewers look for it. */
const HEADER_WINDOW_BYTES = 1024;

/** Bytes decoded per scan window. Kept small so a scan never materialises the whole file. */
const SCAN_CHUNK_BYTES = 32 * 1024;

/**
 * Bytes of a window's tail repeated at the front of the next, so a match cannot straddle a
 * seam unseen. Every pattern below is shorter than this, which is what makes the overlap
 * sufficient rather than merely helpful.
 */
const SCAN_OVERLAP_BYTES = 64;

/** Pieces of a window decoded per `String.fromCharCode` call, under the argument-count limit. */
const DECODE_CHUNK_BYTES = 32 * 1024;

/**
 * An object definition: `12 0 obj`.
 *
 * The digit caps are the format's: PDF object numbers are at most ten digits and generation
 * numbers at most five. Capping them keeps a pathological run of digits from being a match,
 * and keeps the pattern inside the window overlap. The trailing lookahead rejects a word
 * that merely starts with `obj`.
 */
const OBJECT_MARKER = /\d{1,10}\s+\d{1,5}\s+obj(?![A-Za-z])/gu;

/** The trailer pointer to the cross-reference table. */
const START_XREF_KEYWORD = /startxref/gu;

/** The classic trailer dictionary. A cross-reference stream replaces it in PDF 1.5+. */
const TRAILER_DICTIONARY = /trailer\s*<{2}/gu;

/** The end-of-file marker, one per saved revision. */
const EOF_MARKER = /%%EOF/gu;

/**
 * The key that makes a document need a password.
 *
 * The four patterns below are deliberately **not** global: their callers use `test`, which
 * on a global regex advances `lastIndex` and would make the next window start searching
 * from a stale offset. The counted patterns above are global because their callers use
 * `matchAll`, which requires it.
 */
const ENCRYPT_KEY = /\/Encrypt\b/u;

/** A cross-reference stream, the PDF 1.5+ replacement for the xref table and trailer. */
const XREF_STREAM = /\/Type\s*\/XRef(?![A-Za-z])/u;

/** An object stream, which hides its packed objects from a byte scan. */
const OBJECT_STREAM = /\/Type\s*\/ObjStm(?![A-Za-z])/u;

/** The entry in an updated trailer that points at the previous revision. */
const PREVIOUS_REVISION_KEY = /\/Prev\s+\d/u;

// --- Inspection ------------------------------------------------------------

/**
 * Reads the cheap landmarks out of PDF bytes and says whether they look like a document a
 * viewer can open.
 *
 * One pass, no dependency, no decompression and no object model — see the module comment
 * for what that costs and what it must not be used to claim. It never throws on bytes: an
 * empty buffer, a text file and a cut-off download all come back as a report with findings
 * and `healthy: false`, which is exactly what {@link diagnose} needs.
 *
 * The scan stops early in two cases, because the remaining work would describe something
 * other than the file the caller asked about:
 *
 * - **No bytes.** The report is `empty-file` and every fact is its zero.
 * - **No header.** The report is `missing-header` and every fact is its zero, because a
 *   file with no PDF header in its opening window is not one and its object markers mean
 *   nothing.
 */
export function inspectPdf(bytes: Uint8Array): PdfInspection {
  const size = byteLengthOf(bytes);

  if (size === 0) {
    return blankInspection(size, [finding('empty-file')], 'low');
  }

  const header = readHeader(bytes);
  if (!header.hasHeader) {
    return blankInspection(size, [finding('missing-header')], 'low');
  }

  const scan = scanBytes(bytes);
  const problems = describeProblems(scan);

  return {
    healthy: problems.every(problem => problem.severity !== 'error'),
    version: header.version,
    encrypted: scan.encrypted,
    objects: scan.objects,
    problems,
    confidence: confidenceOf(scan, problems),
    size,
    hasStartXref: scan.hasStartXref,
    hasTrailer: scan.hasTrailer,
    hasEof: scan.hasEof,
    xrefStream: scan.xrefStream,
    objectStream: scan.objectStream,
    revisions: scan.revisions,
    incremental: scan.incremental,
  };
}

/**
 * The report for bytes the scan cannot describe, with every scanned fact at its zero.
 *
 * `healthy` is derived from the findings here too, rather than fixed: the two callers today
 * both pass an error, but a rule stated twice is a rule that drifts the first time one call
 * site changes.
 */
function blankInspection(size: number, problems: readonly PdfProblem[], confidence: PdfConfidence): PdfInspection {
  return {
    healthy: problems.every(problem => problem.severity !== 'error'),
    version: null,
    encrypted: false,
    objects: 0,
    problems,
    confidence,
    size,
    hasStartXref: false,
    hasTrailer: false,
    hasEof: false,
    xrefStream: false,
    objectStream: false,
    revisions: 0,
    incremental: false,
  };
}

// --- The diagnosis ---------------------------------------------------------

/**
 * Turns an inspection into one decision for the reader: how bad it is, and the single step
 * that helps most.
 *
 * Precedence, and why: fixing the structure comes before unlocking it, so a damaged file
 * asks for repair even when it is also encrypted (the recommendation then adds that the
 * password will still be needed). The password comes before everything that assumes an
 * open document, because a locked file yields no text and no scan to OCR. A damaged tail
 * comes before OCR for the same reason: there is no page to recognise until the file opens.
 * OCR is only ever recommended on the caller's own `textExtraction: 'none'`, never on a
 * guess, because a healthy PDF that simply has no text proves nothing about the bytes.
 *
 * Pure: the same inspection and context always produce the same diagnosis, so a UI may
 * re-diagnose on every keystroke of a filter box without touching the file.
 */
export function diagnose(inspection: PdfInspection, context: PdfHealthContext = {}): PdfDiagnosis {
  if (typeof inspection !== 'object' || inspection === null) {
    return {
      level: 'broken',
      action: 'redownload',
      recommendation: 'diagnose needs the inspection `inspectPdf` returned; run it on the file bytes first.',
    };
  }

  const action = actionOf(inspection, context);
  return {
    level: levelOf(inspection),
    action,
    recommendation: recommendationOf(action, inspection),
  };
}

/** `broken` when any error was found, `warning` when only warnings were, `ok` otherwise. */
function levelOf(inspection: PdfInspection): PdfHealthLevel {
  if (inspection.problems.some(problem => problem.severity === 'error')) return 'broken';
  if (inspection.problems.length > 0) return 'warning';
  return 'ok';
}

/** The fallback to recommend, by the precedence documented on {@link diagnose}. */
function actionOf(inspection: PdfInspection, context: PdfHealthContext): PdfHealthAction {
  const codes = new Set(inspection.problems.map(problem => problem.code));

  if (codes.has('empty-file')) return 'redownload';
  if (codes.has('missing-header') || codes.has('truncated') || codes.has('no-objects')) return 'repair';
  if (inspection.encrypted) return 'ask-password';
  if (codes.has('missing-startxref') || codes.has('missing-trailer') || codes.has('missing-eof')) {
    return 'open-with-fallback-engine';
  }
  if (context.textExtraction === 'none') return 'ocr';
  return 'open';
}

const OPEN_RECOMMENDATION =
  'The file looks complete: header, cross-reference pointer, trailer and end marker are all present. ' +
  'Open it normally.';

const REDOWNLOAD_RECOMMENDATION =
  'The file is empty, so there is nothing to open. Download or copy it again, and check that the new ' +
  'copy has bytes in it.';

const REPAIR_RECOMMENDATION =
  'The file is damaged rather than merely unusual. Repair a copy with a PDF repair tool and open the ' +
  'repaired copy; download the file again if the repair fails.';

const PASSWORD_RECOMMENDATION =
  'The file is encrypted, so it cannot open without its password. Ask whoever sent it for the open ' +
  "password, then enter it in the viewer's password prompt.";

const OCR_RECOMMENDATION =
  'The file opens, but text extraction produced nothing, which is the signature of a scan. Run OCR ' +
  'over the pages so the text can be searched, selected and translated.';

/** The generic engine sentence, used when a warning has no more specific one. */
const ENGINE_RECOMMENDATION =
  'The file is unusual enough that a strict viewer may refuse it. Open it as it is; if your viewer ' +
  'refuses, open the copy with a different PDF engine, which rebuilds the cross-reference table.';

/**
 * The sentence for each recoverable tail fault.
 *
 * Each one names the same fallback — another engine — and says what that engine does
 * differently, because "try another viewer" without the reason reads as a shrug.
 */
const FALLBACK_BY_PROBLEM: Partial<Record<PdfProblemCode, string>> = {
  'missing-startxref':
    'The file has no cross-reference pointer, which most viewers rebuild silently. Open it as it is; ' +
    'if your viewer refuses, open the copy with a different PDF engine, which rebuilds the table by ' +
    'scanning the objects.',
  'missing-trailer':
    'The file has no trailer dictionary, so a viewer has to find the document catalog another way. ' +
    'Open it as it is; if your viewer refuses, open the copy with a different PDF engine.',
  'missing-eof':
    'The file does not end with its end marker, so its tail may be incomplete. Open it as it is; if ' +
    'your viewer complains, open the copy with a different PDF engine.',
};

/** One sentence for the action, tailored to the finding that caused it where that helps. */
function recommendationOf(action: PdfHealthAction, inspection: PdfInspection): string {
  switch (action) {
    case 'redownload':
      return REDOWNLOAD_RECOMMENDATION;
    case 'repair':
      return inspection.encrypted
        ? `${REPAIR_RECOMMENDATION} It is also encrypted, so its password will be needed once it opens.`
        : REPAIR_RECOMMENDATION;
    case 'ask-password':
      return PASSWORD_RECOMMENDATION;
    case 'ocr':
      return OCR_RECOMMENDATION;
    case 'open-with-fallback-engine':
      return firstFallbackSentence(inspection) ?? ENGINE_RECOMMENDATION;
    case 'open':
      return OPEN_RECOMMENDATION;
  }
}

/** The sentence for the first tail fault in finding order, or null when none is specific. */
function firstFallbackSentence(inspection: PdfInspection): string | null {
  for (const problem of inspection.problems) {
    const sentence = FALLBACK_BY_PROBLEM[problem.code];
    if (sentence !== undefined) return sentence;
  }
  return null;
}

// --- Findings --------------------------------------------------------------

interface ProblemSpec {
  readonly severity: PdfProblemSeverity;
  readonly message: string;
}

/**
 * The message and cost of every code, in one table.
 *
 * One table rather than a switch in two places: the severity decides `healthy` and the level,
 * so a code whose severity is written in one branch and whose message is written in another
 * is a trap waiting for the first edit.
 */
const PROBLEM_SPECS: Record<PdfProblemCode, ProblemSpec> = {
  'empty-file': {
    severity: 'error',
    message: 'The file has no bytes at all; nothing can be opened from an empty file.',
  },
  'missing-header': {
    severity: 'error',
    message:
      `The first ${HEADER_WINDOW_BYTES} bytes do not contain a "%PDF-" header, so the file is not a PDF ` +
      'or its beginning was lost.',
  },
  truncated: {
    severity: 'error',
    message:
      'The file ends before its trailer and cross-reference table, so it was cut short while being ' +
      'written or while it was being transferred.',
  },
  'missing-startxref': {
    severity: 'warning',
    message:
      'The file has no "startxref" pointer, so a viewer has to rebuild the cross-reference table ' +
      'before it can open the document.',
  },
  'missing-trailer': {
    severity: 'warning',
    message:
      'The file has no "trailer" dictionary and no cross-reference stream, so a viewer cannot find ' +
      'the document catalog from it.',
  },
  'missing-eof': {
    severity: 'warning',
    message:
      'The file does not end with "%%EOF", so it may have been cut short or had bytes appended after it.',
  },
  'no-objects': {
    severity: 'error',
    message: 'The file defines no indirect objects, so there is no document content for a viewer to read.',
  },
  encrypted: {
    severity: 'warning',
    message: 'The file contains an "/Encrypt" dictionary, so opening it needs the document password.',
  },
};

/** One finding, built from {@link PROBLEM_SPECS} so code, cost and sentence cannot drift. */
function finding(code: PdfProblemCode): PdfProblem {
  const spec: ProblemSpec = PROBLEM_SPECS[code];
  return { code, severity: spec.severity, message: spec.message };
}

/**
 * Every finding this scan justifies, in a fixed order.
 *
 * The tail is judged as a whole first: a file missing its trailer, its `startxref` and its
 * `%%EOF` has one fault (truncation), not three, and reporting three would bury the cause.
 * Once the tail is only partly damaged, the pointer is reported first and the trailer check
 * yields to it — a missing pointer already explains why a viewer cannot find the table, so
 * adding "and there is no trailer either" would be noise. The end marker is reported last.
 *
 * The trailer check defers to the xref stream: PDF 1.5 replaced the trailer dictionary with
 * a cross-reference stream, so a file with `/Type /XRef` is expected to have no `trailer`
 * keyword and accusing it would fail every modern file this app did not write.
 */
function describeProblems(scan: ByteScan): PdfProblem[] {
  const problems: PdfProblem[] = [];
  const lostTail = !scan.hasEof && !scan.hasStartXref && !scan.hasTrailer;

  if (lostTail) {
    problems.push(finding('truncated'));
  } else {
    if (!scan.hasStartXref) {
      problems.push(finding('missing-startxref'));
    } else if (!scan.hasTrailer && !scan.xrefStream) {
      problems.push(finding('missing-trailer'));
    }
    if (!scan.hasEof) problems.push(finding('missing-eof'));
  }

  if (scan.objects === 0) problems.push(finding('no-objects'));
  if (scan.encrypted) problems.push(finding('encrypted'));

  return problems;
}

/**
 * How much the scan could see.
 *
 * A lost tail or a file with no object at all means the report describes very little, so
 * `low`. Anything that hides objects from the scan — a packed object stream, a cross-reference
 * stream, an incremental update — or any finding at all means the report is honest but
 * partial, so `medium`. `high` is reserved for a file whose whole structure was visible.
 */
function confidenceOf(scan: ByteScan, problems: readonly PdfProblem[]): PdfConfidence {
  if (problems.some(problem => problem.code === 'truncated' || problem.code === 'no-objects')) return 'low';
  if (problems.length > 0 || scan.xrefStream || scan.objectStream || scan.incremental) return 'medium';
  return 'high';
}

// --- Byte reading ----------------------------------------------------------

/** What one pass over the bytes found. See {@link scanBytes}. */
interface ByteScan {
  objects: number;
  hasStartXref: boolean;
  hasTrailer: boolean;
  hasEof: boolean;
  encrypted: boolean;
  xrefStream: boolean;
  objectStream: boolean;
  revisions: number;
  incremental: boolean;
}

/**
 * One pass over the file collecting every fact {@link PdfInspection} reports.
 *
 * Two details make the pass trustworthy at the seams:
 *
 * - **Matches are counted by absolute position, not by occurrence.** A match that falls
 *   inside the overlap is seen by two windows; its start position is the same in both, so a
 *   `Set` counts it once. Counting occurrences instead would inflate the object count on
 *   every window boundary.
 * - **The boolean checks stop at the first hit.** Once `/Encrypt` is found there is nothing
 *   left to learn from scanning for it, which keeps a large file from paying for a match it
 *   already has.
 */
function scanBytes(bytes: Uint8Array): ByteScan {
  const objectStarts = new Set<number>();
  const startXrefStarts = new Set<number>();
  const trailerStarts = new Set<number>();
  const eofStarts = new Set<number>();

  let encrypted = false;
  let xrefStream = false;
  let objectStream = false;
  let hasPrevious = false;

  scanWindows(bytes, (text, windowStart) => {
    for (const match of text.matchAll(OBJECT_MARKER)) objectStarts.add(windowStart + (match.index ?? 0));
    for (const match of text.matchAll(START_XREF_KEYWORD)) startXrefStarts.add(windowStart + (match.index ?? 0));
    for (const match of text.matchAll(TRAILER_DICTIONARY)) trailerStarts.add(windowStart + (match.index ?? 0));
    for (const match of text.matchAll(EOF_MARKER)) eofStarts.add(windowStart + (match.index ?? 0));

    if (!encrypted) encrypted = ENCRYPT_KEY.test(text);
    if (!xrefStream) xrefStream = XREF_STREAM.test(text);
    if (!objectStream) objectStream = OBJECT_STREAM.test(text);
    if (!hasPrevious) hasPrevious = PREVIOUS_REVISION_KEY.test(text);
  });

  return {
    objects: objectStarts.size,
    hasStartXref: startXrefStarts.size > 0,
    hasTrailer: trailerStarts.size > 0,
    hasEof: endsWithEof(bytes),
    encrypted,
    xrefStream,
    objectStream,
    revisions: eofStarts.size,
    incremental: eofStarts.size > 1 || startXrefStarts.size > 1 || hasPrevious,
  };
}

/** Header presence and version, read from the first {@link HEADER_WINDOW_BYTES}. */
function readHeader(bytes: Uint8Array): { hasHeader: boolean; version: string | null } {
  const head = decodeLatin1(bytes.subarray(0, Math.min(bytes.length, HEADER_WINDOW_BYTES)));
  const versionMatch = /%PDF-(\d+)\.(\d+)/u.exec(head);
  if (versionMatch === null) return { hasHeader: false, version: null };

  const major = versionMatch[1];
  const minor = versionMatch[2];
  if (major === undefined || minor === undefined) return { hasHeader: true, version: null };
  return { hasHeader: true, version: `${major}.${minor}` };
}

/**
 * True when the file's last non-padding byte ends the `%%EOF` marker.
 *
 * Trailing whitespace and NUL bytes are skipped: incremental updates and some writers pad
 * after the last marker and both are still complete files. Nothing else is tolerated — the
 * point of the check is that the tail is intact.
 */
function endsWithEof(bytes: Uint8Array): boolean {
  let end = bytes.length;
  while (end > 0 && isPaddingByte(bytes[end - 1])) end -= 1;

  if (end < 5) return false;
  return decodeLatin1(bytes.subarray(end - 5, end)) === '%%EOF';
}

/** Bytes a PDF writer may leave after the last marker without damaging the file. */
function isPaddingByte(byte: number | undefined): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

/**
 * Decodes bytes one character per byte, in pieces.
 *
 * Latin-1 is enough for everything this module looks for: PDF keywords and the delimiters
 * around them are ASCII, and a byte above 0x7f cannot start one. Decoding per window keeps
 * a 50 MB file from becoming a 50 MB string.
 */
function decodeLatin1(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += DECODE_CHUNK_BYTES) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + DECODE_CHUNK_BYTES));
  }
  return text;
}

/**
 * Visits the bytes as overlapping latin-1 windows, with each window's offset in the file.
 *
 * The offset is what lets the caller count by position rather than by occurrence. The
 * overlap is what keeps a keyword from hiding on a window boundary; every pattern above is
 * shorter than the overlap.
 */
function scanWindows(bytes: Uint8Array, visit: (text: string, start: number) => void): void {
  if (bytes.length === 0) return;

  let start = 0;
  for (;;) {
    const end = Math.min(start + SCAN_CHUNK_BYTES, bytes.length);
    visit(decodeLatin1(bytes.subarray(start, end)), start);
    if (end >= bytes.length) return;
    start = end - SCAN_OVERLAP_BYTES;
  }
}

/**
 * Length of the buffer, or zero for anything that is not a byte container.
 *
 * The guard is for a JS caller that hands over `undefined` from a failed download: the
 * report is then `empty-file`, which is true, rather than a thrown `TypeError` in a check
 * whose whole purpose is to avoid a crash before the reader opens the file.
 */
function byteLengthOf(bytes: Uint8Array): number {
  return typeof bytes === 'object' && bytes !== null && typeof bytes.length === 'number' ? bytes.length : 0;
}
