/**
 * Import format detection and import planning (backlog item E12).
 *
 * The reader grew up on PDF: the file picker in `src/main.ts` accepts `application/pdf`
 * and hands every byte straight to the PDF loader. That is honest for one format and
 * unhelpful for the rest — a reader who drops a DOCX gets a failed parse instead of
 * "this is a Word document, and here is what converting it would take". This module
 * supplies the two answers that sentence needs, and nothing else:
 *
 * - {@link sniffFormat} says what the bytes actually are, and how strongly it believes
 *   it. Magic bytes decide wherever the format has them; where it does not (a ZIP-based
 *   package), the little structure a byte scan can see decides, and the answer says so
 *   with a weaker confidence.
 * - {@link planImport} says what turning that format into Document IR blocks would take,
 *   step by step, naming the input and output of every step so a UI can show the chain —
 *   including the steps this build cannot run on its own.
 *
 * ## What "supported" means
 *
 * `supported` is true only for a format this build can turn into IR blocks with code it
 * ships: PDF through the reader, and a raster image through the bundled OCR engine
 * (`src/ocr/pipeline.ts`), which is fed an image and returns recognized words.
 *
 * Three consequences follow, and all three are deliberate:
 *
 * - A format that needs software the app does not ship is **not** supported, however well
 *   the plan describes it. A DOCX is not supported because the converter that reads it is
 *   LibreOffice, not this app.
 * - TIFF is not supported while PNG and JPEG are, because Chromium — the web build's
 *   renderer and Electron's — cannot decode TIFF at all. The plan therefore puts a
 *   conversion step in front of the OCR step, which PNG and JPEG do not need.
 * - `supported` is about the build, not the device. `planImport`'s per-step `available`
 *   is about the device: a PNG is supported even on a machine that reports no OCR engine,
 *   and the plan marks the recognition step unavailable there instead.
 *
 * `supported` also describes the *conversion* capability, not the file picker: the picker
 * still offers `application/pdf` only, so a supported format needs to be accepted there
 * before a user can drop it. This module was written against that state; changing the
 * picker is a separate change and must not make this table lie.
 *
 * ## What a byte scan can and cannot say about a ZIP
 *
 * DOCX, PPTX, XLSX and EPUB are all ZIP containers with no magic bytes of their own:
 * every one of them starts `PK\x03\x04`. Three signals are readable without inflating
 * anything, and they are used in this order:
 *
 * 1. **The stored `mimetype` entry.** EPUB requires a first entry named `mimetype`, stored
 *    uncompressed, whose content is `application/epub+zip`. That is a declaration in the
 *    clear, so EPUB detected this way is `certain`.
 * 2. **Part names.** ZIP stores entry names uncompressed even when the entry content is
 *    deflated, so `word/document.xml`, `ppt/presentation.xml` and `xl/workbook.xml` are
 *    visible in the local headers and in the central directory. No other format carries
 *    those names, but a name is structure rather than a signature, so an OOXML result is
 *    `likely`.
 * 3. **The OPC part manifest.** `[Content_Types].xml` is the first entry of every OOXML
 *    package by specification and proves an OPC package without saying which one. A
 *    package with the manifest and no readable part name is reported as `unknown` with
 *    that reason, never guessed into DOCX.
 *
 * Nothing here inflates a stream, so a DOCX whose entries are all empty still detects: the
 * names are in the headers. A file cut off before its first name cannot be named, and says
 * so.
 *
 * ## Purity
 *
 * Both functions are pure and deterministic: no clock, no randomness, no DOM, no network,
 * no I/O and no dependency. The same bytes and arguments always produce the same result,
 * which is what lets the tests pin every case and lets a UI preview a plan before a byte
 * of the file is parsed. `sniffFormat` never throws — a caller handling a user's dropped
 * file must not be able to crash on it.
 */

// --- Public shapes ---------------------------------------------------------

/**
 * What a file is, as far as this build can tell.
 *
 * - `pdf`: the reader's own format.
 * - `docx` / `pptx` / `xlsx`: an OOXML package, identified by the part names it carries.
 * - `epub`: a ZIP package that declares the EPUB media type or its container descriptor.
 * - `html`: the first bytes carry a document type declaration or an `<html` tag.
 * - `rtf`: the RTF control header. Recognized on purpose; no import chain is defined.
 * - `tiff` / `png` / `jpeg`: raster images, each with its own signature.
 * - `text`: plain text, recognized by extension plus a plausibility check.
 * - `unknown`: everything else, including a ZIP that is not a document package.
 */
export type ImportFormat =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'epub'
  | 'html'
  | 'rtf'
  | 'tiff'
  | 'png'
  | 'jpeg'
  | 'text'
  | 'unknown';

/** Every format this module can name, in a fixed order. */
export const IMPORT_FORMATS: readonly ImportFormat[] = [
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'epub',
  'html',
  'rtf',
  'tiff',
  'png',
  'jpeg',
  'text',
  'unknown',
];

/**
 * Formats this build converts to Document IR blocks with code it ships.
 *
 * `pdf` goes through the reader. `png` and `jpeg` are decodeable by the browser's image
 * decoder and readable by the bundled OCR engine, so the chain runs today.
 *
 * `tiff` is absent because no Chromium — the web renderer or Electron's — decodes it, and
 * `docx`, `pptx`, `xlsx`, `epub` and `html` are absent because their converters are
 * external programs. `rtf` and `unknown` have no chain at all. See the file comment.
 */
export const NATIVE_IMPORT_FORMATS: readonly ImportFormat[] = ['pdf', 'png', 'jpeg'];

/**
 * How strongly a sniff result should be believed.
 *
 * - `certain`: a signature identifies the format itself — a PDF header, a PNG signature,
 *   an EPUB `mimetype` declaration. There is no second reading of the bytes.
 * - `likely`: a container signature plus readable structure names the format. An OOXML
 *   part name is structure rather than a signature, which is the whole distinction.
 * - `guess`: only weak evidence, which in this build means a file extension or a bare
 *   `<html` tag with no doctype.
 * - `none`: nothing was identified.
 */
export type SniffConfidence = 'certain' | 'likely' | 'guess' | 'none';

/** One concrete reason a sniffer reached its answer. */
export type SniffEvidenceCode =
  | 'pdf-signature'
  | 'zip-signature'
  | 'epub-mimetype'
  | 'epub-container'
  | 'ooxml-content-types'
  | 'ooxml-word-parts'
  | 'ooxml-slide-parts'
  | 'ooxml-sheet-parts'
  | 'ooxml-unidentified'
  | 'zip-unidentified'
  | 'html-doctype'
  | 'html-tag'
  | 'html-extension'
  | 'rtf-signature'
  | 'tiff-little-endian'
  | 'tiff-big-endian'
  | 'png-signature'
  | 'jpeg-signature'
  | 'text-extension'
  | 'text-bytes'
  | 'binary-content'
  | 'empty-file'
  | 'no-signature';

/** One finding: a stable code for a UI or test, plus the English sentence a human reads. */
export interface SniffEvidence {
  readonly code: SniffEvidenceCode;
  readonly message: string;
}

/** What one file turned out to be. */
export interface SniffResult {
  readonly format: ImportFormat;
  readonly confidence: SniffConfidence;
  /** Reasons in the order they were found. Never empty. */
  readonly evidence: readonly SniffEvidence[];
  /** True when this build can convert the format itself; see {@link NATIVE_IMPORT_FORMATS}. */
  readonly supported: boolean;
}

/** What a chain needs that this build does not get for free. */
export type ImportNeed =
  /** An OCR engine, because the format carries pixels rather than text. */
  | 'ocr'
  /** An external program, because this build has no reader for the format. */
  | 'external-converter'
  /** A text importer, because a text file has no geometry to place blocks in. */
  | 'text-importer';

/** The kinds of step a chain is built from. */
export type ImportStepId =
  /** The reader: PDF bytes to pages, text and block geometry. */
  | 'read-pdf'
  /** The browser's image decoder: encoded image bytes to a raster page. */
  | 'decode-image'
  /** The OCR engine: raster pixels to blocks with recognized text. */
  | 'ocr-image'
  /** An external program: one document format to another. */
  | 'external-convert'
  /** A text importer that does not exist yet: characters to pages and blocks. */
  | 'text-to-ir';

/** Who runs a step: this app's reader, its OCR engine, or a program it does not ship. */
export type ImportActor = 'reader' | 'ocr' | 'external';

/** One step of an import chain, with the endpoints a UI needs to draw it. */
export interface ImportStep {
  readonly id: ImportStepId;
  readonly actor: ImportActor;
  /** What the step consumes, named in the plan's own words. */
  readonly input: string;
  /** What the step produces. */
  readonly output: string;
  /**
   * True when this build, on this device and with the given options, can run the step.
   * A chain with an unavailable step is a plan, not an import.
   */
  readonly available: boolean;
}

/** The plan for one format. */
export interface ImportPlan {
  /** The format the plan is for, echoed so a UI can render from one object. */
  readonly format: ImportFormat;
  /** True when this build converts the format itself; see {@link NATIVE_IMPORT_FORMATS}. */
  readonly supported: boolean;
  /**
   * Why there is no chain, as one English sentence; null whenever `steps` is non-empty.
   * An empty `steps` with a `reason` is the refusal this module exists to make explicit.
   */
  readonly reason: string | null;
  /** The chain, in order. Empty exactly when no chain is defined for the format. */
  readonly steps: readonly ImportStep[];
  /** External programs the chain needs, named closely enough for a UI to print. */
  readonly converters: readonly string[];
  /** Sentences a reader should see before starting the chain. */
  readonly warnings: readonly string[];
  /** Capabilities the chain needs; empty when the app needs nothing beyond itself. */
  readonly needs: readonly ImportNeed[];
}

/** What the caller knows about this device, which the plan cannot read for itself. */
export interface ImportOptions {
  /**
   * Whether an OCR engine is available here. Defaults to true: this build ships one, and
   * a caller that omits the option is describing the build rather than a broken device.
   */
  readonly ocrAvailable?: boolean;
  /**
   * Whether an office or image converter is installed. Defaults to false, because an
   * external program is absent until the caller says otherwise.
   */
  readonly converterAvailable?: boolean;
}

// --- Signature tables ------------------------------------------------------

/** Bytes read for the text-based checks: an HTML doctype or tag, and text plausibility. */
export const SNIFF_WINDOW_BYTES = 512;

/** Bytes of a ZIP local file header before its variable part. */
const ZIP_HEADER_BYTES = 30;

/** Bytes read per window while a package is scanned for part names. */
const PACKAGE_WINDOW_BYTES = 64 * 1024;

/** Bytes of a window repeated at the front of the next, longer than any name below. */
const PACKAGE_OVERLAP_BYTES = 64;

/** `%PDF-`, the PDF header. */
const PDF_SIGNATURE: readonly number[] = [0x25, 0x50, 0x44, 0x46, 0x2d];

/** `PK\x03\x04`, a ZIP local file header. */
const ZIP_SIGNATURE: readonly number[] = [0x50, 0x4b, 0x03, 0x04];

/** `{\rtf`, the RTF control header. */
const RTF_SIGNATURE: readonly number[] = [0x7b, 0x5c, 0x72, 0x74, 0x66];

/** `II*\0`, a little-endian TIFF image file header. */
const TIFF_LITTLE_SIGNATURE: readonly number[] = [0x49, 0x49, 0x2a, 0x00];

/** `MM\0*`, a big-endian TIFF image file header. */
const TIFF_BIG_SIGNATURE: readonly number[] = [0x4d, 0x4d, 0x00, 0x2a];

/** The eight-byte PNG signature, chosen to survive a text-mode transfer. */
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** `FF D8 FF`, the JPEG start-of-image marker and the first marker segment. */
const JPEG_SIGNATURE: readonly number[] = [0xff, 0xd8, 0xff];

/** The EPUB media type, which an EPUB declares in its first, stored `mimetype` entry. */
const EPUB_MIMETYPE = 'application/epub+zip';

/** The EPUB container descriptor; present in every EPUB, readable without inflating. */
const EPUB_CONTAINER_ENTRY = 'META-INF/container.xml';

/** The OPC part manifest, which every OOXML package carries as its first entry. */
const CONTENT_TYPES_ENTRY = '[Content_Types].xml';

/** The Word document part. */
const WORD_ENTRY = 'word/document.xml';

/** The PowerPoint presentation part. */
const SLIDE_ENTRY = 'ppt/presentation.xml';

/** The Excel workbook part. */
const SHEET_ENTRY = 'xl/workbook.xml';

/** An HTML document type declaration, lowercased before the test. */
const HTML_DOCTYPE_PATTERN = /<!doctype\s+html/u;

/** A bare `<html` tag, which is weaker evidence than a doctype. */
const HTML_TAG_PATTERN = /<html[\s>]/u;

/** Extensions this build reads as plain text. Deliberately short and documented. */
const TEXT_EXTENSIONS: readonly string[] = ['txt', 'text', 'log', 'md', 'markdown'];

/** Extensions that name HTML, used only to explain why a file could not be identified. */
const HTML_EXTENSIONS: readonly string[] = ['html', 'htm', 'xhtml'];

/** Control bytes a text file may contain: tab, line feed, form feed and carriage return. */
const TEXT_CONTROLS: readonly number[] = [0x09, 0x0a, 0x0c, 0x0d];

// --- Detection -------------------------------------------------------------

/**
 * Identifies a file from its bytes and, for plain text only, from its name.
 *
 * Order, and why: magic bytes first, strongest to weakest — the PDF header, the ZIP local
 * header (which opens every OOXML and EPUB package), then the single-format signatures.
 * Only when no signature matches is the content looked at as text, so an HTML document
 * saved as `.txt` is still HTML, and only when that fails does the extension decide. The
 * name is read last because a name is a claim, while a signature is a fact.
 *
 * Never throws: not for an empty file, not for four bytes of a signature, not for
 * something that is not a `Uint8Array` at all. A sniffer sits in front of a user's dropped
 * file, and a thrown exception there turns "I cannot read this" into "the app crashed".
 */
export function sniffFormat(bytes: Uint8Array, filename = ''): SniffResult {
  if (!(bytes instanceof Uint8Array)) {
    return sniffResult('unknown', 'none', [
      evidence('no-signature', 'sniffFormat needs the file bytes as a Uint8Array; nothing was identified.'),
    ]);
  }

  if (bytes.length === 0) {
    return sniffResult('unknown', 'none', [
      evidence('empty-file', 'The file is empty, so there are no bytes to identify it by.'),
    ]);
  }

  if (startsWithBytes(bytes, PDF_SIGNATURE)) {
    return sniffResult('pdf', 'certain', [
      evidence('pdf-signature', 'The file starts with "%PDF-", the PDF header.'),
    ]);
  }

  if (startsWithBytes(bytes, ZIP_SIGNATURE)) return sniffPackage(bytes);

  if (startsWithBytes(bytes, RTF_SIGNATURE)) {
    return sniffResult('rtf', 'certain', [
      evidence('rtf-signature', 'The file starts with the RTF control header "{\\rtf".'),
    ]);
  }

  if (startsWithBytes(bytes, TIFF_LITTLE_SIGNATURE)) {
    return sniffResult('tiff', 'certain', [
      evidence('tiff-little-endian', 'The file starts with the little-endian TIFF header "II*".'),
    ]);
  }

  if (startsWithBytes(bytes, TIFF_BIG_SIGNATURE)) {
    return sniffResult('tiff', 'certain', [
      evidence('tiff-big-endian', 'The file starts with the big-endian TIFF header "MM".'),
    ]);
  }

  if (startsWithBytes(bytes, PNG_SIGNATURE)) {
    return sniffResult('png', 'certain', [
      evidence('png-signature', 'The file starts with the eight-byte PNG signature.'),
    ]);
  }

  if (startsWithBytes(bytes, JPEG_SIGNATURE)) {
    return sniffResult('jpeg', 'certain', [
      evidence('jpeg-signature', 'The file starts with the JPEG start-of-image marker.'),
    ]);
  }

  const head = latin1(bytes, 0, SNIFF_WINDOW_BYTES);
  const textLike = looksLikeText(head);
  if (textLike) {
    const html = sniffHtml(head);
    if (html !== null) return html;
  }

  return sniffText(head, textLike, filename);
}

/**
 * Names a ZIP package from the structure a byte scan can read.
 *
 * The stored `mimetype` entry is checked before anything else because it is a declaration
 * in the clear: a package that says it is an EPUB is an EPUB, whatever else it holds. The
 * part names come next, and the OPC manifest last, because the manifest proves a package is
 * OPC without saying which kind — an honest `unknown` rather than a guess.
 */
function sniffPackage(bytes: Uint8Array): SniffResult {
  const packageEvidence = evidence('zip-signature', 'The file starts with a ZIP local file header, so it is a ZIP-based package.');
  const head = readLocalHeader(bytes);

  if (head.name === 'mimetype' && head.method === 0 && head.dataStart !== null) {
    const declared = latin1(bytes, head.dataStart, EPUB_MIMETYPE.length);
    if (declared === EPUB_MIMETYPE) {
      return sniffResult('epub', 'certain', [
        packageEvidence,
        evidence('epub-mimetype', `The first entry is a stored "mimetype" file that declares "${EPUB_MIMETYPE}".`),
      ]);
    }
  }

  const parts = scanPackageParts(bytes);

  if (parts.epubMimetype) {
    return sniffResult('epub', 'likely', [
      packageEvidence,
      evidence('epub-mimetype', `The package contains the EPUB media type "${EPUB_MIMETYPE}", but not as a stored first entry.`),
    ]);
  }

  if (parts.epubContainer) {
    return sniffResult('epub', 'likely', [
      packageEvidence,
      evidence('epub-container', `The package holds "${EPUB_CONTAINER_ENTRY}", the EPUB container descriptor.`),
    ]);
  }

  const contentTypes = head.name === CONTENT_TYPES_ENTRY || parts.contentTypes;
  const manifestEvidence = contentTypes
    ? [evidence('ooxml-content-types', `The package holds "${CONTENT_TYPES_ENTRY}", the OOXML part manifest.`)]
    : [];

  if (parts.word) {
    return sniffResult('docx', 'likely', [
      packageEvidence,
      ...manifestEvidence,
      evidence('ooxml-word-parts', `The package holds "${WORD_ENTRY}", the Word document part.`),
    ]);
  }

  if (parts.powerpoint) {
    return sniffResult('pptx', 'likely', [
      packageEvidence,
      ...manifestEvidence,
      evidence('ooxml-slide-parts', `The package holds "${SLIDE_ENTRY}", the PowerPoint presentation part.`),
    ]);
  }

  if (parts.excel) {
    return sniffResult('xlsx', 'likely', [
      packageEvidence,
      ...manifestEvidence,
      evidence('ooxml-sheet-parts', `The package holds "${SHEET_ENTRY}", the Excel workbook part.`),
    ]);
  }

  if (contentTypes) {
    return sniffResult('unknown', 'none', [
      packageEvidence,
      ...manifestEvidence,
      evidence('ooxml-unidentified', 'No Word, PowerPoint or Excel part name is readable, so the package cannot be named.'),
    ]);
  }

  return sniffResult('unknown', 'none', [
    packageEvidence,
    evidence('zip-unidentified', 'The ZIP package holds none of the document part names this build recognizes.'),
  ]);
}

/**
 * Reads HTML evidence from the first {@link SNIFF_WINDOW_BYTES} bytes already decoded.
 *
 * A doctype means the document says what it is, so `likely`; a bare `<html` tag is a
 * fragment of markup that could be an example on a text page, so `guess`. XML leading
 * inline (`<?xml …`) costs nothing: the tag test is not anchored.
 */
function sniffHtml(head: string): SniffResult | null {
  const lower = head.toLowerCase();

  if (HTML_DOCTYPE_PATTERN.test(lower)) {
    return sniffResult('html', 'likely', [
      evidence('html-doctype', `The first ${SNIFF_WINDOW_BYTES} bytes contain an HTML document type declaration.`),
    ]);
  }

  if (HTML_TAG_PATTERN.test(lower)) {
    return sniffResult('html', 'guess', [
      evidence('html-tag', `The first ${SNIFF_WINDOW_BYTES} bytes contain an "<html" tag and no doctype.`),
    ]);
  }

  return null;
}

/**
 * Decides plain text from its extension and its bytes.
 *
 * The extension is a claim, so it only decides together with bytes that could be text: no
 * NUL and no control character other than tab, line feed, form feed and carriage return.
 * A `.txt` full of control bytes is reported as `unknown` with `binary-content`, because
 * calling it text would make the importer misread it silently.
 *
 * A UTF-16 byte-order mark passes the plausibility test on its own — the file *is* text —
 * even though every following byte is half a NUL. Reading it as Latin-1 would be wrong,
 * which is why the finding says the mark was what decided.
 */
function sniffText(head: string, textLike: boolean, filename: string): SniffResult {
  const extension = extensionOf(filename);
  const named = extension !== '' && TEXT_EXTENSIONS.includes(extension);

  if (named && textLike) {
    return sniffResult('text', 'guess', [
      evidence('text-extension', `The file name ends in ".${extension}", which this build reads as plain text.`),
      evidence('text-bytes', 'The opening bytes carry no control characters, which fits a text file.'),
    ]);
  }

  if (named) {
    return sniffResult('unknown', 'none', [
      evidence('text-extension', `The file name ends in ".${extension}", which this build reads as plain text.`),
      evidence('binary-content', 'The opening bytes carry control characters, so the content is not the plain text the name promises.'),
    ]);
  }

  if (extension !== '' && HTML_EXTENSIONS.includes(extension)) {
    return sniffResult('unknown', 'none', [
      evidence('html-extension', `The file name ends in ".${extension}", but no doctype or "<html" tag appears in the first ${SNIFF_WINDOW_BYTES} bytes.`),
    ]);
  }

  return sniffResult('unknown', 'none', [
    evidence('no-signature', 'No signature this build reads appears at the start of the file, and the file name does not name a text format.'),
  ]);
}

/** Assembles a result, deriving `supported` from the one list that defines it. */
function sniffResult(
  format: ImportFormat,
  confidence: SniffConfidence,
  rows: readonly SniffEvidence[],
): SniffResult {
  return {
    format,
    confidence,
    evidence: [...rows],
    supported: NATIVE_IMPORT_FORMATS.includes(format),
  };
}

/** One finding, written the short way at each call site. */
function evidence(code: SniffEvidenceCode, message: string): SniffEvidence {
  return { code, message };
}

/**
 * True when a text file may hold these bytes.
 *
 * Only the first {@link SNIFF_WINDOW_BYTES} are looked at, which is the same window the
 * HTML check uses: a file whose first half kilobyte is clean text is text for the purpose
 * of choosing an importer, and scanning a whole file here would cost more than the answer
 * is worth.
 */
function looksLikeText(head: string): boolean {
  // A byte-order mark is itself the claim that the file is text.
  if (head.startsWith('\u00ef\u00bb\u00bf') || head.startsWith('\u00ff\u00fe') || head.startsWith('\u00fe\u00ff')) {
    return true;
  }

  for (let index = 0; index < head.length; index += 1) {
    const code = head.charCodeAt(index);
    if (code === 0x00 || code === 0x7f) return false;
    if (code < 0x20 && !TEXT_CONTROLS.includes(code)) return false;
  }

  return true;
}

/** The lowercased extension of a file name, or an empty string when it has none. */
function extensionOf(filename: string): string {
  if (typeof filename !== 'string') return '';
  const base = filename.split(/[\\/]/u).pop() ?? '';
  const dot = base.lastIndexOf('.');
  // A leading dot marks a hidden file (`.gitignore`), not an extension.
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

// --- Planning --------------------------------------------------------------

/**
 * Plans how a format becomes Document IR blocks, and says what it cannot do.
 *
 * The chain is honest by construction: every step names its input and output, every step
 * says whether this build can run it, and a format with no chain at all returns no steps
 * with one sentence saying why. Nothing is inferred from the extension here — the caller
 * passes what {@link sniffFormat} returned.
 *
 * `options` describes the device, not the build: `ocrAvailable` defaults to true because
 * the app ships an OCR engine, while `converterAvailable` defaults to false because an
 * external program is absent until someone installs it. A plan whose steps are all
 * available is the only one that should be started without telling the reader anything.
 */
export function planImport(format: ImportFormat, options: ImportOptions = {}): ImportPlan {
  const target = isImportFormat(format) ? format : 'unknown';
  const settings = typeof options === 'object' && options !== null ? options : {};
  const ocrAvailable = settings.ocrAvailable !== false;
  const converterAvailable = settings.converterAvailable === true;

  switch (target) {
    case 'pdf':
      return pdfPlan(ocrAvailable);

    case 'png':
    case 'jpeg':
      return imagePlan(target, ocrAvailable);

    case 'tiff':
      return tiffPlan(ocrAvailable, converterAvailable);

    case 'docx':
    case 'pptx':
    case 'xlsx':
      return officePlan(target, converterAvailable);

    case 'epub':
      return epubPlan(converterAvailable);

    case 'html':
      return htmlPlan(converterAvailable);

    case 'text':
      return textPlan();

    case 'rtf':
      return makePlan('rtf', { reason: RTF_REFUSAL });

    case 'unknown':
    default:
      return makePlan('unknown', { reason: UNKNOWN_REFUSAL });
  }
}

/** Why RTF is refused rather than planned through the office converter. */
const RTF_REFUSAL =
  'RTF is recognized but no import chain is defined for it: the converter that reads DOCX could read it too, ' +
  'but until a convert-and-verify path exists for the output, this build refuses the file instead of opening it badly.';

/** Why an unidentifiable file has no plan. */
const UNKNOWN_REFUSAL =
  'The bytes match no format this build recognizes, so there is nothing to convert and no plan to show.';

/** A PDF needs nothing but the reader; only a scan asks for OCR, and the reader decides per page. */
function pdfPlan(ocrAvailable: boolean): ImportPlan {
  return makePlan('pdf', {
    steps: [step('read-pdf', 'reader', 'PDF bytes', 'pages, text runs and block geometry as Document IR', true)],
    needs: [],
    warnings: ocrAvailable
      ? []
      : ['No OCR engine is available on this device, so any scanned page inside this PDF will stay pixels.'],
  });
}

/** A PNG or JPEG is decoded by the browser and recognized by the bundled OCR engine. */
function imagePlan(format: 'png' | 'jpeg', ocrAvailable: boolean): ImportPlan {
  const label = format === 'png' ? 'PNG image' : 'JPEG image';
  return makePlan(format, {
    steps: [decodeStep(label), ocrStep(ocrAvailable)],
    needs: ['ocr'],
    warnings: [
      'The text is recognized from pixels, so its blocks carry OCR confidence and their reading order is estimated from the image.',
      ...(ocrAvailable ? [] : [OCR_MISSING]),
    ],
  });
}

/** Chromium decodes neither TIFF, so a conversion comes before the OCR step. */
function tiffPlan(ocrAvailable: boolean, converterAvailable: boolean): ImportPlan {
  return makePlan('tiff', {
    steps: [
      step('external-convert', 'external', 'TIFF image', 'PNG image', converterAvailable),
      decodeStep('PNG image'),
      ocrStep(ocrAvailable),
    ],
    converters: [IMAGE_CONVERTER],
    needs: ['external-converter', 'ocr'],
    warnings: [
      'No browser engine in this build decodes TIFF, so it must be converted to PNG or JPEG before OCR can read it.',
      ...(converterAvailable ? [] : [`No image converter is installed, so this plan cannot run until ${IMAGE_CONVERTER} is available.`]),
      ...(ocrAvailable ? [] : [OCR_MISSING]),
    ],
  });
}

/** A DOCX, PPTX or XLSX needs a converter that renders it the way its author saw it. */
function officePlan(format: 'docx' | 'pptx' | 'xlsx', converterAvailable: boolean): ImportPlan {
  const office = OFFICE_FORMATS[format];
  return makePlan(format, {
    steps: [
      step('external-convert', 'external', office.label, 'PDF', converterAvailable),
      readPdfStep(),
    ],
    converters: [OFFICE_CONVERTER],
    needs: ['external-converter'],
    warnings: [
      office.warning,
      ...(converterAvailable ? [] : [missingConverter(OFFICE_CONVERTER)]),
    ],
  });
}

/** An EPUB has no fixed pages; the converter decides where the pages break. */
function epubPlan(converterAvailable: boolean): ImportPlan {
  return makePlan('epub', {
    steps: [
      step('external-convert', 'external', 'EPUB package', 'PDF', converterAvailable),
      readPdfStep(),
    ],
    converters: [EPUB_CONVERTER],
    needs: ['external-converter'],
    warnings: [
      'An EPUB reflows to the reading device, so the converter decides where pages break and citations can land on pages the book never had.',
      ...(converterAvailable ? [] : [missingConverter(EPUB_CONVERTER)]),
    ],
  });
}

/** HTML prints to PDF through a browser engine, which is what preserves its CSS. */
function htmlPlan(converterAvailable: boolean): ImportPlan {
  return makePlan('html', {
    steps: [
      step('external-convert', 'external', 'HTML document', 'PDF', converterAvailable),
      readPdfStep(),
    ],
    converters: [HTML_CONVERTER],
    needs: ['external-converter'],
    warnings: [
      'A remote page depends on the fonts and stylesheets it can load; without them it prints unstyled, and a page that scrolls forever prints its first screen.',
      ...(converterAvailable ? [] : [missingConverter(HTML_CONVERTER)]),
    ],
  });
}

/** Plain text has characters but no geometry, and no importer in this build. */
function textPlan(): ImportPlan {
  return makePlan('text', {
    steps: [
      step('text-to-ir', 'reader', 'plain text', 'pages and blocks with synthesized geometry', false),
    ],
    needs: ['text-importer'],
    warnings: [
      'This build has no text importer: a text file has no page geometry, so blocks would have to be placed by a layout rule that does not exist yet.',
    ],
  });
}

/** The three OOXML formats, each with the label and the loss its conversion causes. */
const OFFICE_FORMATS: Record<'docx' | 'pptx' | 'xlsx', { readonly label: string; readonly warning: string }> = {
  docx: {
    label: 'DOCX document',
    warning:
      'The converter re-flows the document, so positioned frames, multi-column text and footnotes can move on the page.',
  },
  pptx: {
    label: 'PPTX presentation',
    warning:
      'Each slide becomes one page; speaker notes, transitions and animations do not survive the conversion.',
  },
  xlsx: {
    label: 'XLSX workbook',
    warning:
      'The converter prints each sheet under its own print settings, so a tall sheet is split across pages the workbook did not have.',
  },
};

/** The office suite that renders OOXML closest to how its author saw it. */
const OFFICE_CONVERTER = 'LibreOffice (soffice --headless --convert-to pdf)';

/** The image converter used only by the TIFF chain. */
const IMAGE_CONVERTER = 'ImageMagick (magick convert)';

/** The EPUB converter: page-based output from a reflowable format. */
const EPUB_CONVERTER = 'Calibre (ebook-convert)';

/** The HTML converter: a browser engine, so the page prints the way it renders. */
const HTML_CONVERTER = 'Chromium headless (--print-to-pdf)';

/** The sentence for a device with no OCR engine. */
const OCR_MISSING = 'No OCR engine is available on this device, so the pixels cannot become text here.';

/** The reader's own step, shared by every chain that ends in a PDF. */
function readPdfStep(): ImportStep {
  return step('read-pdf', 'reader', 'PDF', 'pages, text runs and block geometry as Document IR', true);
}

/** The browser's image decoder, which needs nothing from the device. */
function decodeStep(input: string): ImportStep {
  return step('decode-image', 'reader', input, 'one raster page', true);
}

/** The OCR engine, which needs an engine to be installed. */
function ocrStep(ocrAvailable: boolean): ImportStep {
  return step('ocr-image', 'ocr', 'raster page pixels', 'blocks with recognized text, in reading order', ocrAvailable);
}

/** One step, written the short way at each call site. */
function step(id: ImportStepId, actor: ImportActor, input: string, output: string, available: boolean): ImportStep {
  return { id, actor, input, output, available };
}

/** The warning for a chain whose converter is not installed. */
function missingConverter(converter: string): string {
  return `No converter is installed, so this plan cannot run until ${converter} is available.`;
}

/**
 * Assembles a plan and derives `supported` from {@link NATIVE_IMPORT_FORMATS}.
 *
 * `reason` and `steps` are kept mutually exclusive here rather than at each call site: the
 * invariant "no chain, but a sentence saying why" is the whole point of the refusal, and
 * one place to enforce it is one place to trust.
 */
function makePlan(
  format: ImportFormat,
  parts: {
    readonly steps?: readonly ImportStep[];
    readonly converters?: readonly string[];
    readonly warnings?: readonly string[];
    readonly needs?: readonly ImportNeed[];
    readonly reason?: string | null;
  },
): ImportPlan {
  const steps = parts.steps ?? [];
  return {
    format,
    supported: NATIVE_IMPORT_FORMATS.includes(format),
    reason: steps.length === 0 ? parts.reason ?? UNKNOWN_REFUSAL : null,
    steps: [...steps],
    converters: [...(parts.converters ?? [])],
    warnings: [...(parts.warnings ?? [])],
    needs: [...(parts.needs ?? [])],
  };
}

/** True when a value is one of {@link IMPORT_FORMATS}, for a caller that has only a string. */
function isImportFormat(value: unknown): value is ImportFormat {
  return typeof value === 'string' && (IMPORT_FORMATS as readonly string[]).includes(value);
}

// --- Byte reading ----------------------------------------------------------

/** True when `bytes` begins with every byte of `signature`. */
function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false;
  }
  return true;
}

/**
 * Decodes a slice one character per byte.
 *
 * Latin-1 is enough for everything read here: signatures are bytes, and the entry names and
 * media type searched for in a package are ASCII. Clamped rather than trusted, so a
 * truncated file cannot loop past its end.
 */
function latin1(bytes: Uint8Array, start: number, length: number): string {
  const from = Math.max(0, start);
  const to = Math.min(bytes.length, from + Math.max(0, length));
  let text = '';
  for (let index = from; index < to; index += 1) text += String.fromCharCode(bytes[index] ?? 0);
  return text;
}

/** A little-endian 16-bit integer at `offset`; unreadable bytes read as zero. */
function u16le(bytes: Uint8Array, offset: number): number {
  const low = bytes[offset] ?? 0;
  const high = bytes[offset + 1] ?? 0;
  return low | (high << 8);
}

/** The fixed part of the first ZIP local file header, or nulls when the file is too short. */
interface LocalHeader {
  /** The first entry's name, or null when the header is cut off or empty. */
  readonly name: string | null;
  /** The first entry's compression method; 0 means stored, so its bytes are readable. */
  readonly method: number | null;
  /** Where the first entry's content starts, or null when the header is cut off. */
  readonly dataStart: number | null;
}

/**
 * Reads the first local file header of a ZIP.
 *
 * Local header layout, little-endian: signature (4), version (2), flags (2), method (2),
 * time (2), date (2), CRC (4), compressed size (4), uncompressed size (4), name length (2),
 * extra length (2), then the name, the extra field and the content.
 *
 * A short file yields nulls instead of throwing. Entry sizes are deliberately not used to
 * walk the archive: a streamed ZIP writes zero there and puts the real sizes in a data
 * descriptor after the content, so walking would misread the second entry.
 */
function readLocalHeader(bytes: Uint8Array): LocalHeader {
  if (bytes.length < ZIP_HEADER_BYTES) {
    return { name: null, method: null, dataStart: null };
  }

  const method = u16le(bytes, 8);
  const nameLength = u16le(bytes, 26);
  const extraLength = u16le(bytes, 28);
  const nameStart = ZIP_HEADER_BYTES;
  const nameEnd = Math.min(bytes.length, nameStart + nameLength);
  const name = latin1(bytes, nameStart, nameEnd - nameStart);
  const dataStart = nameStart + nameLength + extraLength;

  return {
    name: name.length > 0 ? name : null,
    method,
    dataStart: dataStart <= bytes.length ? dataStart : null,
  };
}

/** What a single pass over a package found among its entry names. */
interface PackageParts {
  epubMimetype: boolean;
  epubContainer: boolean;
  contentTypes: boolean;
  word: boolean;
  powerpoint: boolean;
  excel: boolean;
}

/** Every name the package scan looks for, with the flag it sets. */
const PACKAGE_NEEDLES: readonly { readonly key: keyof PackageParts; readonly needle: string }[] = [
  { key: 'epubMimetype', needle: EPUB_MIMETYPE },
  { key: 'epubContainer', needle: EPUB_CONTAINER_ENTRY },
  { key: 'contentTypes', needle: CONTENT_TYPES_ENTRY },
  { key: 'word', needle: WORD_ENTRY },
  { key: 'powerpoint', needle: SLIDE_ENTRY },
  { key: 'excel', needle: SHEET_ENTRY },
];

/**
 * Finds the entry names a ZIP package carries, in one pass.
 *
 * One pass and not six: names live in the local headers at the front and again in the
 * central directory at the back, so the whole file is the right search space, and decoding
 * it once per needle would cost six times as much for the same answer. A window overlap
 * longer than the longest needle keeps a name from hiding on a seam.
 *
 * The scan stops as soon as every needle is found, which is the usual case within the first
 * window of a real package.
 */
function scanPackageParts(bytes: Uint8Array): PackageParts {
  const parts: PackageParts = {
    epubMimetype: false,
    epubContainer: false,
    contentTypes: false,
    word: false,
    powerpoint: false,
    excel: false,
  };

  let remaining = PACKAGE_NEEDLES.length;

  for (let start = 0; start < bytes.length; start += PACKAGE_WINDOW_BYTES - PACKAGE_OVERLAP_BYTES) {
    const end = Math.min(start + PACKAGE_WINDOW_BYTES, bytes.length);
    const window = latin1(bytes, start, end - start);

    for (const { key, needle } of PACKAGE_NEEDLES) {
      if (parts[key]) continue;
      if (!window.includes(needle)) continue;
      parts[key] = true;
      remaining -= 1;
    }

    if (remaining === 0 || end >= bytes.length) break;
  }

  return parts;
}
