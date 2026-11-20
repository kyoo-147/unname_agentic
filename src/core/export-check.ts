/**
 * Pre-hand-over check of the PDF an export produces (backlog items H09 and H14).
 *
 * The reader's promise is "your PDF is ready". This module runs just before that
 * sentence: it reads the finished bytes and reports what would embarrass the reader
 * afterwards — a file cut off mid-download, a page count that does not match the document
 * it came from, a face that was referenced but not embedded, a scan with no text layer to
 * copy from, a translated block that still shows its source sentence, or a file so large
 * the target will not take it.
 *
 * Two entry points, deliberately kept apart:
 *
 * - {@link extractPdfFacts} reads what the bytes say cheaply: header version, `/Count`
 *   values, embedded-font and image markers, the trailer's `startxref`, and whether the
 *   objects are packed. It is a **heuristic**, not a parser; see its documentation before
 *   trusting a field.
 * - {@link checkExport} joins those facts with what the caller knows about the export
 *   (page count, fonts, text layer, source sentences a translation replaced) and returns
 *   problems and warnings.
 *
 * Contract:
 *
 * - **Pure and deterministic.** No clock, no randomness, no DOM, no network, no I/O, no
 *   dependency. The same bytes and the same expectations always produce the same report.
 * - **Problems block, warnings do not.** `ok` is true when there is no problem; warnings
 *   are sentences the reader should see without being stopped. A scan without a text
 *   layer is still a valid PDF, so it warns; a page count that contradicts the document
 *   means the wrong file is about to be handed over, so it fails.
 * - **Absence is not evidence.** A file whose page tree is packed into a compressed object
 *   stream states no page count a byte scan can read; that is left unconfirmed without a
 *   warning, because the format hides it on a healthy file. An uncompressed file that
 *   states no count at all does warn: there the silence is the file's.
 * - **Every finding carries a stable English code and one English sentence.** `code` is
 *   what a UI switches on and localises; `message` is the diagnostic sentence a log and a
 *   test read without a translation. Codes are documented on {@link ExportProblemCode}
 *   and {@link ExportWarningCode} and are never localised here.
 * - **Nothing is repaired.** The module never rewrites bytes, so a caller may show a
 *   warning and still hand the file over, or rebuild after a problem and check again.
 *
 * What it does not do: it does not parse the PDF, so it cannot prove a viewer will open
 * the file, that every object is reachable, or that the visible text is the translation.
 * An export that raises no problem here raises no objection this check knows how to
 * make — the independent validation H14 also asks for is a separate step.
 */

// --- Public shape ----------------------------------------------------------

/**
 * A finding that means the file should not be handed over as it stands.
 *
 * - `invalid-input`: the caller did not pass what the check needs (bytes, a whole page
 *   count, a font record, a usable size cap). The file itself is not accused.
 * - `missing-header`: the bytes do not start with `%PDF-`.
 * - `missing-eof`: the bytes do not end with `%%EOF`; the export was probably cut short.
 * - `page-count-mismatch`: the file never states the page count the caller believes, so
 *   the wrong document, or a partial one, is about to be delivered.
 * - `source-sentence-left`: a sentence of a replaced block is still in the extracted text;
 *   the translation did not replace that block.
 */
export type ExportProblemCode =
  | 'invalid-input'
  | 'missing-header'
  | 'missing-eof'
  | 'page-count-mismatch'
  | 'source-sentence-left';

/**
 * A finding the reader should know about without being stopped.
 *
 * - `page-count-unreadable`: the file states no page count and does not pack its objects
 *   either, so the count was not confirmed. (A file that *does* pack them hides the page
 *   tree by format and is left unconfirmed silently; see the contract above.)
 * - `font-not-embedded`: a face is referenced but its program is not in the file; the
 *   reader's machine substitutes a face and the layout can shift.
 * - `no-text-layer`: the export was expected to be searchable and is not; copy, search
 *   and selection will not work. On a scan this is the usual scoring failure.
 * - `oversized`: the file is above the size this app warns at, so a mail gateway or an
 *   upload form may refuse it.
 * - `source-text-unchecked`: source sentences were supplied but no extracted text was, so
 *   the leftover-source check could not run.
 */
export type ExportWarningCode =
  | 'page-count-unreadable'
  | 'font-not-embedded'
  | 'no-text-layer'
  | 'oversized'
  | 'source-text-unchecked';

/** One finding: a stable code plus the sentence a human reads. */
export interface ExportFinding<Code extends string> {
  code: Code;
  message: string;
}

export type ExportProblem = ExportFinding<ExportProblemCode>;
export type ExportWarning = ExportFinding<ExportWarningCode>;

/** The verdict for one export. `ok` is true when there is no problem; warnings do not block. */
export interface ExportReport {
  ok: boolean;
  problems: ExportProblem[];
  warnings: ExportWarning[];
}

/** One face the export draws with, as the exporter knows it. */
export interface ExportFont {
  /** PostScript name as it appears in the file, e.g. `ABCDEF+NotoSans-Regular`. */
  name: string;
  /**
   * True when the font program travels inside the PDF (`/FontFile2` for TrueType,
   * `/FontFile3` for CFF). Only `true` counts as embedded: a record that cannot say so is
   * treated as not embedded, because that is the direction that cannot hide a broken file.
   */
  embedded: boolean;
  /**
   * True when the face was subset to the glyphs used. A subset is fine — it is how a
   * Unicode export keeps its size — and never produces a finding on its own.
   */
  subset?: boolean;
}

/**
 * What the caller believes the finished export should be, beyond its bytes.
 *
 * Everything is optional: an export that promises nothing is still checked for its header,
 * its trailer, its page count and its size.
 */
export interface ExportExpectation {
  /** True when the export must be searchable and copyable (any text export, or a scan with OCR). */
  textLayer?: boolean;
  /**
   * Sample sentences from the source document that this export replaces with a
   * translation. Pass whole sentences, not words: a string shorter than
   * {@link MIN_SOURCE_SENTENCE_CHARS} is skipped because an ordinary word matches too
   * easily to be evidence of anything.
   */
  sourceSentences?: readonly string[];
  /**
   * The text extracted from the regions that should hold the translation. Required for
   * the leftover-source check; when it is missing the check reports
   * `source-text-unchecked` instead of passing silently.
   */
  extractedText?: string;
}

/** Everything one pre-hand-over check needs. */
export interface ExportRequest {
  /** The finished file, exactly the bytes that would be handed over. */
  bytes: Uint8Array;
  /** The page count the export was built with. */
  pages: number;
  /** The faces the export draws with. Pass `[]` for an export with no text. */
  fonts?: readonly ExportFont[];
  /** Whether the finished file carries a text layer. */
  hasTextLayer?: boolean;
  /** How many raster images the export draws; `0` for a text-only export. */
  images?: number;
  expected?: ExportExpectation;
  /**
   * The size this hand-over warns above, in bytes. Defaults to
   * {@link EXPORT_SIZE_WARNING_BYTES}; pass a lower cap when the transport refuses sooner
   * (an attachment limit, an extension bridge, a device share sheet).
   */
  maxBytes?: number;
}

// --- Constants -------------------------------------------------------------

/**
 * The size above which an export earns a warning: 50 MiB (52,428,800 bytes).
 *
 * Most mail gateways and web upload forms refuse a message somewhere around 25–50 MB, and
 * the app's own download path holds the whole file in memory as one blob. A reader who
 * has just been told the file is ready should hear about the limit before the first
 * attempt to share it, not after. It is a warning and not a failure: a 60 MB vector-heavy
 * document is a legitimate export, and only the reader can decide to accept it.
 */
export const EXPORT_SIZE_WARNING_BYTES = 50 * 1024 * 1024;

/**
 * Shortest source sentence the leftover check will look for, in characters.
 *
 * Eight is the point where a string stops being a word that appears by coincidence: a
 * four-letter word would match every translation, while "Figure 3 shows the pump" only
 * matches if the source block really survived. Shorter strings are skipped, not flagged.
 */
export const MIN_SOURCE_SENTENCE_CHARS = 8;

/** Characters of a source sentence quoted in a finding's message. */
const MESSAGE_EXCERPT_CHARS = 80;

/** Bytes of the file start searched for the `%PDF-` header and its version. */
const HEADER_WINDOW_BYTES = 1024;

/** Bytes decoded per scan window. Kept small so a scan never materialises the whole file. */
const SCAN_CHUNK_BYTES = 32 * 1024;

/** Bytes of a window's tail repeated at the front of the next, so a match cannot straddle two windows unseen. */
const SCAN_OVERLAP_BYTES = 64;

/** Pieces of a window decoded per `String.fromCharCode` call, under the argument-count limit. */
const DECODE_CHUNK_BYTES = 32 * 1024;

// --- Facts from the bytes --------------------------------------------------

/**
 * What a byte scan of a finished PDF can say, and no more.
 *
 * Heuristic, not a parser — read this before trusting a field:
 *
 * - **Nothing here parses the file.** There is no cross-reference walk, no object graph,
 *   no stream decoding and no decompression. Every field comes from a scan with one small
 *   regular expression, which is cheap enough to run on a finished file and needs no PDF
 *   library. That is the whole point: this check must not be able to fail on a file the
 *   exporter just wrote.
 * - **`Count` is a heuristic for the page count.** In a well-formed file the page-tree
 *   root states the total in `/Count`; the same key also appears on nested page-tree nodes
 *   (where it is a subtree total) and on outline items (where it is the number of visible
 *   children, negative when collapsed). {@link PdfFacts.countCandidates} keeps every
 *   distinct non-negative value seen and {@link PdfFacts.pageCount} takes the largest, so a
 *   caller can see that the file spoke with more than one voice. Negative values are
 *   skipped: an outline's `-3` never means a page count.
 * - **A compressed page tree says nothing.** When the page dictionary lives inside an
 *   object stream the raw bytes hold no `/Count`, and the honest answer is
 *   `countCandidates: []` — not a guess. That is the normal case for this app's own
 *   writer: pdf-lib's `save()` packs non-stream objects by default, so a finished export
 *   reports `hasObjectStream: true` and no page count. {@link checkExport} leaves the
 *   count unconfirmed rather than warning, because that is the file format and not a
 *   fault; write with `save({ useObjectStreams: false })` when the count must be
 *   verifiable by a byte scan.
 * - **The font and image flags are file-wide, not per page.** `hasEmbeddedFont` says the
 *   file embeds at least one TrueType or CFF program somewhere; it does not say that every
 *   face is embedded. Per-font truth belongs to the exporter, which is why
 *   {@link checkExport} takes the font list from the caller instead.
 */
export interface PdfFacts {
  /**
   * Header version, `"1.7"` style, read from a `%PDF-x.y` in the first
   * {@link HEADER_WINDOW_BYTES} bytes; null when no header appears in that window.
   */
  version: string | null;
  /**
   * The largest `/Count` value found, as a page-count guess; null when the bytes state
   * none. See the interface documentation for why this is a guess.
   */
  pageCount: number | null;
  /**
   * Every distinct non-negative `/Count` value found, ascending. One entry is a file that
   * speaks clearly; several entries are a file this scan cannot choose for.
   */
  countCandidates: number[];
  /** True when `/FontFile2` (TrueType) or `/FontFile3` (CFF/OpenType) appears anywhere. */
  hasEmbeddedFont: boolean;
  /** True when `/Subtype /Image` appears anywhere: the file draws at least one raster image. */
  hasImage: boolean;
  /** True when the bytes contain the trailer keyword `startxref`. */
  hasStartXref: boolean;
  /**
   * True when the file packs non-stream objects into an object stream (`/Type /ObjStm`).
   *
   * This is what explains a missing page count on a healthy file: the page dictionary is
   * inside a Flate-compressed object stream, which a byte scan deliberately does not
   * decode. It is also how {@link checkExport} tells "the format hides the count" from
   * "this file states no count at all".
   */
  hasObjectStream: boolean;
  /** True when the file starts with `%PDF-`. */
  hasHeader: boolean;
  /** True when the file ends with `%%EOF`, ignoring trailing whitespace and NUL padding. */
  hasEofMarker: boolean;
  /**
   * Always true. Present so a caller cannot carry a `PdfFacts` around without the type
   * reminding it that no parser produced these numbers.
   */
  heuristic: true;
}

/**
 * Reads the cheap, reliable-looking facts out of finished PDF bytes.
 *
 * A byte scan with no dependency, no decompression and no object model — see
 * {@link PdfFacts} for what that costs and what it must not be used to claim. For any
 * `Uint8Array` it never throws: a file whose header, trailer or page tree it cannot see
 * yields nulls, empty candidates and false flags, which is exactly the report
 * {@link checkExport} needs.
 */
export function extractPdfFacts(bytes: Uint8Array): PdfFacts {
  const header = readHeader(bytes);
  const markers = scanMarkers(bytes);
  const countCandidates = [...markers.counts].sort((left, right) => left - right);
  const largestCount = countCandidates[countCandidates.length - 1];

  return {
    version: header.version,
    pageCount: largestCount ?? null,
    countCandidates,
    hasEmbeddedFont: markers.hasEmbeddedFont,
    hasImage: markers.hasImage,
    hasStartXref: markers.hasStartXref,
    hasObjectStream: markers.hasObjectStream,
    hasHeader: header.hasHeader,
    hasEofMarker: hasEofMarker(bytes),
    heuristic: true,
  };
}

// --- The check -------------------------------------------------------------

/**
 * Checks the finished export against what the caller believes it is.
 *
 * Order of checks, and why: the header and the trailer first, because a file without them
 * is not a PDF at all and every later claim about it is noise; then the page count, the
 * strongest sign that the wrong file is being delivered; then the fonts and the text
 * layer, which are quality rather than identity; then the leftover-source check, which is
 * the one check that needs the caller to say what a translation replaced; then the size,
 * which is about the transport rather than the document.
 *
 * `ok` is true when no check produced a problem. Warnings are returned either way and
 * never flip it: the file is still a PDF, still opens, and only the reader can decide
 * whether a missing text layer or a 60 MB size matters for this hand-over.
 */
export function checkExport(request: ExportRequest): ExportReport {
  const problems: ExportProblem[] = [];
  const warnings: ExportWarning[] = [];

  if (typeof request !== 'object' || request === null) {
    return {
      ok: false,
      problems: [
        {
          code: 'invalid-input',
          message: 'checkExport needs a request object with the finished file in `bytes`.',
        },
      ],
      warnings,
    };
  }

  const bytes: unknown = request.bytes;
  if (!(bytes instanceof Uint8Array)) {
    return {
      ok: false,
      problems: [
        {
          code: 'invalid-input',
          message: `checkExport needs the finished file as a Uint8Array; it received ${describeValue(bytes)}.`,
        },
      ],
      warnings,
    };
  }

  const facts = extractPdfFacts(bytes);

  if (!facts.hasHeader) {
    problems.push({
      code: 'missing-header',
      message: 'The file does not begin with "%PDF-"; it is not a PDF, or its first bytes were lost.',
    });
  }

  if (!facts.hasEofMarker) {
    problems.push({
      code: 'missing-eof',
      message:
        'The file does not end with "%%EOF"; the export looks truncated and many readers will refuse it.',
    });
  }

  checkPageCount(facts, request.pages, problems, warnings);
  checkFonts(request.fonts, problems, warnings);
  checkTextLayer(request, warnings);
  checkLeftoverSource(request.expected, problems, warnings);
  checkSize(bytes.byteLength, request.maxBytes, problems, warnings);

  return { ok: problems.length === 0, problems, warnings };
}

// --- Individual checks -----------------------------------------------------

/**
 * Compares the page count the caller believes with the one the bytes state.
 *
 * Three outcomes, deliberately different:
 *
 * - the file names the expected count among its `/Count` values: passes. One expected
 *   number is enough — a file that also mentions a subtree total or an outline count is
 *   not lying, and choosing between values is guesswork;
 * - the file names other counts only: fails. This is the case the check exists for;
 * - the file names none: nothing is proven. A file that packs its objects (see
 *   {@link PdfFacts.hasObjectStream}) is *known* to hide the page tree from a byte scan,
 *   so the count is simply unconfirmed and no warning is raised — warning the reader about
 *   a limitation of this check on a healthy file is noise. A file with no packed objects
 *   and no `/Count` at all is odd enough to warn about.
 */
function checkPageCount(
  facts: PdfFacts,
  pages: unknown,
  problems: ExportProblem[],
  warnings: ExportWarning[],
): void {
  if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 0) {
    problems.push({
      code: 'invalid-input',
      message: `checkExport needs the page count the export was built with; it received ${describeValue(pages)}.`,
    });
    return;
  }

  // A file with no PDF header has already failed, and its page count is moot.
  if (!facts.hasHeader) return;

  if (facts.countCandidates.length === 0) {
    if (!facts.hasObjectStream) {
      warnings.push({
        code: 'page-count-unreadable',
        message:
          'The file states no page count this check could read, so the page count was not confirmed.',
      });
    }
    return;
  }

  if (facts.countCandidates.includes(pages)) return;

  problems.push({
    code: 'page-count-mismatch',
    message: pageMismatchMessage(facts.countCandidates, pages),
  });
}

/**
 * Warns once per face the file only references.
 *
 * One warning per font, naming it, because the writer needs to know which face to embed;
 * a single "some fonts are missing" sentence sends them looking. Duplicate names are
 * folded, so a face used on twenty pages warns once.
 */
function checkFonts(fonts: unknown, problems: ExportProblem[], warnings: ExportWarning[]): void {
  if (fonts === undefined) return;

  if (!Array.isArray(fonts)) {
    problems.push({
      code: 'invalid-input',
      message: 'checkExport needs `fonts` as an array of { name, embedded } records.',
    });
    return;
  }

  const seen = new Set<string>();
  for (let index = 0; index < fonts.length; index += 1) {
    const record: unknown = fonts[index];
    if (typeof record !== 'object' || record === null) {
      problems.push({
        code: 'invalid-input',
        message: `checkExport could not read the font record at position ${index}; pass { name, embedded }.`,
      });
      continue;
    }

    const candidate = record as { name?: unknown; embedded?: unknown };
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (name === '') {
      problems.push({
        code: 'invalid-input',
        message: `checkExport needs a font name at position ${index}; pass { name, embedded }.`,
      });
      continue;
    }

    if (seen.has(name)) continue;
    seen.add(name);

    if (candidate.embedded !== true) {
      warnings.push({
        code: 'font-not-embedded',
        message:
          `The font "${name}" is not embedded; a machine without it substitutes another face, ` +
          'so the text can shift on the page.',
      });
    }
  }
}

/**
 * Warns when the export was expected to be searchable and carries no text layer.
 *
 * Expected and absent is the whole condition. An export that never promised a text layer
 * (a picture-only archive, for example) is not warned at, and an export that has one is
 * not checked further: whether that text is correct or complete is a different question.
 */
function checkTextLayer(request: ExportRequest, warnings: ExportWarning[]): void {
  if (request.expected?.textLayer !== true) return;
  if (request.hasTextLayer === true) return;

  const images = readImageCount(request.images);
  warnings.push({
    code: 'no-text-layer',
    message:
      images > 0
        ? `This export is a scan with ${countOf(images, 'image')} and no text layer; ` +
          'copy, search and selection will not work on it.'
        : 'This export has no text layer; copy, search and selection will not work on it.',
  });
}

/**
 * Errors when a sentence of a replaced block survives in the exported text.
 *
 * The caller supplies the sentence sample and the text extracted from the export; the
 * match requires the whole sentence, in order. Only whitespace is folded — extraction
 * routinely breaks a sentence across lines, and folding spaces is not the same as
 * matching words — so a sentence that was replaced cannot come back by accident, and one
 * that survived is not excused by a line wrap.
 *
 * No extracted text and sentences supplied is reported as unconfirmed rather than passed:
 * a check that did not run must not look like a check that succeeded.
 */
function checkLeftoverSource(
  expected: ExportExpectation | undefined,
  problems: ExportProblem[],
  warnings: ExportWarning[],
): void {
  const sentences = readSourceSentences(expected?.sourceSentences);
  if (sentences.length === 0) return;

  const extracted = expected?.extractedText;
  if (typeof extracted !== 'string') {
    warnings.push({
      code: 'source-text-unchecked',
      message:
        'No text was extracted from the export, so the check for leftover source sentences did not run.',
    });
    return;
  }

  const haystack = normalizeWhitespace(extracted);
  for (const sentence of sentences) {
    if (Array.from(sentence).length < MIN_SOURCE_SENTENCE_CHARS) continue;
    if (!haystack.includes(sentence)) continue;
    problems.push({
      code: 'source-sentence-left',
      message:
        `The replaced block still shows its source sentence "${excerpt(sentence)}"; ` +
        'the translation did not replace it.',
    });
  }
}

/** Warns when the file is above the hand-over size, or when the cap is unusable. */
function checkSize(
  size: number,
  maxBytes: unknown,
  problems: ExportProblem[],
  warnings: ExportWarning[],
): void {
  const cap = readSizeCap(maxBytes);
  if (cap === null) {
    problems.push({
      code: 'invalid-input',
      message: `checkExport needs \`maxBytes\` as a positive number of bytes; it received ${describeValue(maxBytes)}.`,
    });
    return;
  }

  if (size <= cap) return;

  warnings.push({
    code: 'oversized',
    message:
      `The export is ${formatBytes(size)}, above the ${formatBytes(cap)} limit this app warns at; ` +
      'some mail gateways and upload forms will refuse it.',
  });
}

// --- Byte reading ----------------------------------------------------------

/**
 * Decodes bytes one character per byte, in pieces.
 *
 * Latin-1 is enough for everything this module looks for: PDF keywords, `/Count`, and the
 * delimiters around them are ASCII, and a byte above 0x7f outside a string literal cannot
 * start a keyword. Decoding per window keeps a 50 MB file from becoming a 50 MB string.
 */
function decodeLatin1(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += DECODE_CHUNK_BYTES) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + DECODE_CHUNK_BYTES));
  }
  return text;
}

/**
 * Visits the bytes as overlapping latin-1 windows.
 *
 * The overlap is what keeps a keyword from hiding on a window boundary; a pattern longer
 * than the overlap would need a larger one, which is why the callers' patterns stay short.
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

/** `/FontFile2` (TrueType) or `/FontFile3` (CFF/OpenType): an embedded font program. */
const FONT_PROGRAM_PATTERN = /\/FontFile[23]/u;

/** A raster image XObject. */
const IMAGE_PATTERN = /\/Subtype\s*\/Image/u;

/** The trailer keyword that points at the cross-reference table. */
const START_XREF_PATTERN = /startxref/u;

/** The object stream that hides the page tree from a byte scan. */
const OBJECT_STREAM_PATTERN = /\/Type\s*\/ObjStm/u;

/** What one pass over the bytes found. */
interface MarkerScan {
  hasEmbeddedFont: boolean;
  hasImage: boolean;
  hasStartXref: boolean;
  hasObjectStream: boolean;
  /** Distinct non-negative `/Count` values, not yet sorted. */
  counts: Set<number>;
}

/**
 * One pass over the file collecting every marker {@link extractPdfFacts} reports.
 *
 * One pass and not five: each window is decoded once and the patterns that are still
 * unanswered are tested against it, so a 50 MB file is decoded once rather than once per
 * field. A match that straddles a window seam is found in the next window because of the
 * overlap, and a value seen twice in that overlap is harmless — the counts are collected in
 * a set and the flags are booleans.
 *
 * `/Count -n` is deliberately unmatched: in an outline it means "collapsed", and letting a
 * negative number into a page count would make a collapsed bookmark tree look like a
 * zero-page document.
 */
function scanMarkers(bytes: Uint8Array): MarkerScan {
  const scan: MarkerScan = {
    hasEmbeddedFont: false,
    hasImage: false,
    hasStartXref: false,
    hasObjectStream: false,
    counts: new Set<number>(),
  };

  scanWindows(bytes, text => {
    if (!scan.hasEmbeddedFont) scan.hasEmbeddedFont = FONT_PROGRAM_PATTERN.test(text);
    if (!scan.hasImage) scan.hasImage = IMAGE_PATTERN.test(text);
    if (!scan.hasStartXref) scan.hasStartXref = START_XREF_PATTERN.test(text);
    if (!scan.hasObjectStream) scan.hasObjectStream = OBJECT_STREAM_PATTERN.test(text);

    for (const match of text.matchAll(/\/Count\s+(\d+)/gu)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const value = Number(raw);
      if (Number.isSafeInteger(value)) scan.counts.add(value);
    }
  });

  return scan;
}

/** Header presence and version, read from the first {@link HEADER_WINDOW_BYTES}. */
function readHeader(bytes: Uint8Array): { hasHeader: boolean; version: string | null } {
  const head = decodeLatin1(bytes.subarray(0, Math.min(bytes.length, HEADER_WINDOW_BYTES)));
  const hasHeader = head.startsWith('%PDF-');
  const match = /%PDF-(\d+)\.(\d+)/u.exec(head);
  if (match === null) return { hasHeader, version: null };

  const [, major, minor] = match;
  if (major === undefined || minor === undefined) return { hasHeader, version: null };
  return { hasHeader, version: `${major}.${minor}` };
}

/**
 * True when the file's last non-padding byte is the `%%EOF` marker.
 *
 * Trailing whitespace and NUL bytes are skipped: incremental updates and some writers
 * leave padding after the last marker, and both are still a complete file. Nothing else is
 * tolerated — the point of the check is that the tail is intact.
 */
function hasEofMarker(bytes: Uint8Array): boolean {
  let end = bytes.length;
  while (end > 0) {
    const byte = bytes[end - 1];
    const isPadding =
      byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
    if (!isPadding) break;
    end -= 1;
  }

  if (end < 5) return false;
  return decodeLatin1(bytes.subarray(end - 5, end)) === '%%EOF';
}

// --- Message building ------------------------------------------------------

/**
 * The sentence for a page-count mismatch, in the file's own terms.
 *
 * One stated count is quoted as a number; several are listed, because "the file says 3
 * pages" would be a lie about a file that also says 40.
 */
function pageMismatchMessage(candidates: readonly number[], pages: number): string {
  const first = candidates[0] ?? 0;
  const reported =
    candidates.length === 1
      ? `The file reports ${countOf(first, 'page')}`
      : `The file reports page counts of ${joinNumbers(candidates)}`;
  return `${reported}, but the export was built with ${countOf(pages, 'page')}.`;
}

/** `1 page`, `0 pages`, `12 pages`. */
function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** `3`, `3 and 5`, `3, 4 and 5`. */
function joinNumbers(values: readonly number[]): string {
  const head = values.slice(0, -1);
  const last = values[values.length - 1];
  if (last === undefined) return '';
  return head.length === 0 ? String(last) : `${head.join(', ')} and ${last}`;
}

/**
 * A byte count a person can read at a glance.
 *
 * Adaptive on purpose: the default cap reports in megabytes, while a caller with a strict
 * transport can pass a cap in the hundreds of bytes and still get a sentence that names a
 * size a reader recognises instead of "0.0 MB".
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** The leading part of a sentence, measured in characters rather than UTF-16 units. */
function excerpt(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= MESSAGE_EXCERPT_CHARS) return text;
  return `${characters.slice(0, MESSAGE_EXCERPT_CHARS - 1).join('')}…`;
}

/**
 * Whitespace folded to one space, ends trimmed.
 *
 * Used on both sides of the leftover-source comparison. A PDF extractor breaks a sentence
 * at a line wrap, and comparing raw text would then miss the very leftover the check
 * exists to find; folding spaces does not weaken the match to words, because the rest of
 * the sentence still has to arrive whole and in order.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

// --- Request reading -------------------------------------------------------

/** The source sentence sample, flattened and deduplicated; unreadable entries are skipped. */
function readSourceSentences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const sentences: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const flat = normalizeWhitespace(entry);
    if (flat.length === 0 || sentences.includes(flat)) continue;
    sentences.push(flat);
  }
  return sentences;
}

/** A raster-image count; an unreadable value means "no image", which only softens wording. */
function readImageCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** The size cap, or null when the caller passed something unusable. */
function readSizeCap(value: unknown): number | null {
  if (value === undefined) return EXPORT_SIZE_WARNING_BYTES;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** A short stand-in for a value a message has to name, safe for any input. */
function describeValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(excerpt(value));
  if (value === undefined) return 'undefined';
  return typeof value;
}
