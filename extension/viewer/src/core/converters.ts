/**
 * Real format converters to canonical Document IR (backlog item E12).
 *
 * `import-formats.ts` identifies bytes and plans chains without decoding payloads.
 * This module implements pure-TypeScript converters that decode DOCX, PPTX, XLSX,
 * EPUB, HTML, PNG, JPEG, and TIFF byte streams into validated {@link DocumentIR}
 * records carrying real SHA-256 `sourceSha256`, extracted metadata, and `'import'`
 * provenance.
 *
 * Design notes:
 * - Zero top-level `node:*` imports so browser / extension Vite bundles succeed
 *   unchanged. When running under Node, DEFLATE entries automatically delegate to
 *   `process.getBuiltinModule('node:zlib').inflateRawSync`; in browser contexts or
 *   when explicitly selected, the built-in pure-TS RFC 1951 {@link inflateRawPure}
 *   decompressor runs synchronously, and callers may also supply `options.inflateRaw`.
 * - Pure and deterministic: no `Date.now()`, no `Math.random()`, no DOM, no I/O.
 * - Every returned `DocumentIR` passes {@link validate} from `./ir`.
 */

import { sniffFormat } from './import-formats';
import {
  buildDocument,
  validate,
  type BlockType,
  type BuildBlockInput,
  type BuildPageInput,
  type DocumentIR,
} from './ir';

// --- Public types & constants ----------------------------------------------

export type ConvertibleFormat = 'docx' | 'pptx' | 'xlsx' | 'epub' | 'html' | 'png' | 'jpeg' | 'tiff';
export type ImageFormat = 'png' | 'jpeg' | 'tiff';

export const CONVERTIBLE_FORMATS: readonly ConvertibleFormat[] = [
  'docx',
  'pptx',
  'xlsx',
  'epub',
  'html',
  'png',
  'jpeg',
  'tiff',
];

export type ConverterErrorCode =
  | 'invalid-input'
  | 'unsupported-format'
  | 'corrupted-archive'
  | 'unsupported-compression'
  | 'decompression-failed'
  | 'missing-part'
  | 'malformed-xml'
  | 'malformed-image';

export class ConverterError extends Error {
  readonly code: ConverterErrorCode;

  constructor(code: ConverterErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ConverterError';
    this.code = code;
  }
}

export type InflateRawFn = (compressed: Uint8Array) => Uint8Array;

export interface ConvertOptions {
  /** Optional filename hint used when auto-sniffing text/HTML fragments. */
  readonly filename?: string;
  /** Explicit format override; skips auto-sniffing. */
  readonly format?: ConvertibleFormat;
  /** Optional raw DEFLATE decompressor override. */
  readonly inflateRaw?: InflateRawFn;
  /** Optional documentId override passed to `buildDocument`. */
  readonly documentId?: string;
  /** Optional revisionId override passed to `buildDocument`. */
  readonly revisionId?: string;
  /** Fallback document language when the source omits one (defaults to `'und'`). */
  readonly defaultLanguage?: string;
}

export interface ConvertImageOptions extends ConvertOptions {
  readonly format?: ImageFormat;
}

export interface SourceMetadata {
  readonly format: ConvertibleFormat;
  readonly title?: string;
  readonly creator?: string;
  readonly author?: string;
  readonly language?: string;
  readonly subject?: string;
  readonly description?: string;
  readonly created?: string;
  readonly modified?: string;
  readonly imageWidth?: number;
  readonly imageHeight?: number;
  readonly slideCount?: number;
  readonly sheetNames?: readonly string[];
  readonly chapterCount?: number;
}

export interface ConversionResult {
  readonly format: ConvertibleFormat;
  readonly ir: DocumentIR;
  readonly metadata: SourceMetadata;
  readonly warnings: readonly string[];
}

export interface ImageDimensions {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
}

export interface ZipEntryRecord {
  readonly name: string;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly data: Uint8Array;
}

// --- Layout constants ------------------------------------------------------

const PAGE_WIDTH_PORTRAIT = 612;
const PAGE_HEIGHT_PORTRAIT = 792;
const PAGE_WIDTH_LANDSCAPE = 792;
const PAGE_HEIGHT_LANDSCAPE = 612;
const SLIDE_WIDTH_DEFAULT = 960;
const SLIDE_HEIGHT_DEFAULT = 540;
const MARGIN_X = 54;
const MARGIN_Y = 54;
const BLOCK_GAP = 10;
const EMU_PER_POINT = 12700;
const MAX_UNCOMPRESSED_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4096;
const MAX_ZIP_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_XML_CHARS = 16 * 1024 * 1024;

// --- Public entry points ---------------------------------------------------

/**
 * Auto-detects format (unless `options.format` is supplied) and converts bytes
 * into a validated canonical {@link DocumentIR}.
 */
export function convertDocument(bytes: Uint8Array, options: ConvertOptions = {}): ConversionResult {
  assertBytes(bytes);
  const format = resolveFormat(bytes, options);

  switch (format) {
    case 'docx':
      return convertDocx(bytes, options);
    case 'pptx':
      return convertPptx(bytes, options);
    case 'xlsx':
      return convertXlsx(bytes, options);
    case 'epub':
      return convertEpub(bytes, options);
    case 'html':
      return convertHtml(bytes, options);
    case 'png':
    case 'jpeg':
    case 'tiff':
      return convertImage(bytes, { ...options, format });
  }
}

export function convertDocx(bytes: Uint8Array, options: ConvertOptions = {}): ConversionResult {
  assertBytes(bytes);
  const archive = parseZip(bytes, { inflateRaw: options.inflateRaw });
  const docEntry = archive.get('word/document.xml');
  if (!docEntry) {
    throw new ConverterError('missing-part', 'DOCX archive is missing required part "word/document.xml".');
  }

  const docRoot = parseXmlDocument(decodeTextBytes(docEntry.data), 'word/document.xml');
  const coreEntry = archive.get('docProps/core.xml');
  const coreMeta = coreEntry ? parseCoreProperties(decodeTextBytes(coreEntry.data)) : {};
  const stylesEntry = archive.get('word/styles.xml');
  const headingStyles = stylesEntry ? parseDocxHeadingStyles(decodeTextBytes(stylesEntry.data)) : new Set<string>();
  const docLang = coreMeta.language ?? extractDocxLanguage(docRoot);

  const body = findFirstElement(docRoot, 'body') ?? docRoot;
  const extracted: FlowBlockSpec[] = [];
  const collectBodyBlocks = (container: XmlElement): void => {
    for (const child of container.children) {
      const local = localNameOf(child.tag);
      if (local === 'p') {
        const parsed = extractDocxParagraph(child, headingStyles);
        if (parsed) extracted.push(parsed);
      } else if (local === 'tbl') {
        const tableText = extractDocxTable(child);
        if (tableText.length > 0) extracted.push({ type: 'table', text: tableText });
      } else if (local === 'sdt' || local === 'sdtContent') {
        collectBodyBlocks(child);
      }
    }
  };
  collectBodyBlocks(body);

  const layout = paginateFlowBlocks(extracted, PAGE_WIDTH_PORTRAIT, PAGE_HEIGHT_PORTRAIT);
  const metadata: SourceMetadata = {
    format: 'docx',
    ...coreMeta,
    ...(docLang ? { language: docLang } : {}),
  };

  return finalizeResult('docx', bytes, layout.pages, layout.blocks, metadata, [], options);
}

export function convertPptx(bytes: Uint8Array, options: ConvertOptions = {}): ConversionResult {
  assertBytes(bytes);
  const archive = parseZip(bytes, { inflateRaw: options.inflateRaw });
  const slideEntries = [...archive.entries()]
    .map(([name, entry]) => ({ name, entry, number: parseSlideNumber(name) }))
    .filter((item): item is { name: string; entry: ZipEntryRecord; number: number } => item.number !== null)
    .sort((left, right) => left.number - right.number || left.name.localeCompare(right.name));

  if (slideEntries.length === 0) {
    throw new ConverterError('missing-part', 'PPTX archive contains no slide parts matching "ppt/slides/slide*.xml".');
  }

  const coreEntry = archive.get('docProps/core.xml');
  const coreMeta = coreEntry ? parseCoreProperties(decodeTextBytes(coreEntry.data)) : {};
  const presEntry = archive.get('ppt/presentation.xml');
  const slideSize = presEntry ? parsePptxSlideSize(decodeTextBytes(presEntry.data)) : { width: SLIDE_WIDTH_DEFAULT, height: SLIDE_HEIGHT_DEFAULT };

  const pages: BuildPageInput[] = [];
  const blocks: BuildBlockInput[] = [];

  slideEntries.forEach((slide, idx) => {
    const pageIndex = idx + 1;
    pages.push({ index: pageIndex, width: slideSize.width, height: slideSize.height, rotation: 0 });
    const slideRoot = parseXmlDocument(decodeTextBytes(slide.entry.data), slide.name);
    const spTree = findFirstElement(slideRoot, 'spTree') ?? slideRoot;
    const shapes = collectSlideShapes(spTree);

    let fallbackY = MARGIN_Y;
    const maxW = Math.max(1, slideSize.width - MARGIN_X * 2);
    for (const shape of shapes) {
      const rect = clampRectToPage(
        shape.rect ?? allocateFallbackRect(shape.text, shape.type, maxW, slideSize.height, fallbackY),
        slideSize.width,
        slideSize.height,
      );
      if (!shape.rect) {
        fallbackY = Math.min(slideSize.height - MARGIN_Y - 12, rect.y + rect.height + BLOCK_GAP);
      }
      blocks.push({
        page: pageIndex,
        text: shape.text,
        rect,
        type: shape.type,
        confidence: 1,
        origin: 'import',
      });
    }
  });

  const metadata: SourceMetadata = {
    format: 'pptx',
    ...coreMeta,
    slideCount: slideEntries.length,
  };

  return finalizeResult('pptx', bytes, pages, blocks, metadata, [], options);
}

export function convertXlsx(bytes: Uint8Array, options: ConvertOptions = {}): ConversionResult {
  assertBytes(bytes);
  const archive = parseZip(bytes, { inflateRaw: options.inflateRaw });
  const workbookEntry = archive.get('xl/workbook.xml');
  if (!workbookEntry) {
    throw new ConverterError('missing-part', 'XLSX archive is missing required part "xl/workbook.xml".');
  }

  const coreEntry = archive.get('docProps/core.xml');
  const coreMeta = coreEntry ? parseCoreProperties(decodeTextBytes(coreEntry.data)) : {};

  const sharedEntry = archive.get('xl/sharedStrings.xml');
  const sharedStrings = sharedEntry ? parseSharedStrings(decodeTextBytes(sharedEntry.data)) : [];

  const relsEntry = archive.get('xl/_rels/workbook.xml.rels');
  const relTargets = relsEntry ? parseRelationships(decodeTextBytes(relsEntry.data)) : new Map<string, string>();

  const workbookRoot = parseXmlDocument(decodeTextBytes(workbookEntry.data), 'xl/workbook.xml');
  const sheetRefs = parseWorkbookSheets(workbookRoot, relTargets, archive);
  if (sheetRefs.length === 0) {
    throw new ConverterError('missing-part', 'XLSX workbook lists no readable worksheet parts.');
  }

  const pages: BuildPageInput[] = [];
  const blocks: BuildBlockInput[] = [];
  const sheetNames: string[] = [];

  sheetRefs.forEach((sheet, idx) => {
    const pageIndex = idx + 1;
    sheetNames.push(sheet.name);
    const sheetEntry = archive.get(sheet.path);
    if (!sheetEntry) {
      throw new ConverterError('missing-part', `XLSX archive is missing worksheet "${sheet.path}".`);
    }

    const sheetRoot = parseXmlDocument(decodeTextBytes(sheetEntry.data), sheet.path);
    const tableText = extractWorksheetTable(sheetRoot, sharedStrings);
    const width = PAGE_WIDTH_LANDSCAPE;
    const contentWidth = width - MARGIN_X * 2;
    let cursorY = MARGIN_Y;

    if (sheet.name.length > 0) {
      const titleHeight = 24;
      blocks.push({
        page: pageIndex,
        text: sheet.name,
        rect: { x: MARGIN_X, y: cursorY, width: contentWidth, height: titleHeight },
        type: 'heading',
        confidence: 1,
        origin: 'import',
      });
      cursorY += titleHeight + BLOCK_GAP;
    }

    if (tableText.length > 0) {
      const rows = tableText.split('\n').length;
      const tableHeight = Math.max(20, rows * 16 + 8);
      blocks.push({
        page: pageIndex,
        text: tableText,
        rect: { x: MARGIN_X, y: cursorY, width: contentWidth, height: tableHeight },
        type: 'table',
        confidence: 1,
        origin: 'import',
      });
      cursorY += tableHeight + MARGIN_Y;
    }

    pages.push({
      index: pageIndex,
      width,
      height: Math.max(PAGE_HEIGHT_LANDSCAPE, cursorY),
      rotation: 0,
    });
  });

  const metadata: SourceMetadata = {
    format: 'xlsx',
    ...coreMeta,
    sheetNames,
  };

  return finalizeResult('xlsx', bytes, pages, blocks, metadata, [], options);
}

export function convertEpub(bytes: Uint8Array, options: ConvertOptions = {}): ConversionResult {
  assertBytes(bytes);
  const archive = parseZip(bytes, { inflateRaw: options.inflateRaw });
  const containerEntry = archive.get('META-INF/container.xml');
  if (!containerEntry) {
    throw new ConverterError('missing-part', 'EPUB archive is missing required part "META-INF/container.xml".');
  }

  const containerRoot = parseXmlDocument(decodeTextBytes(containerEntry.data), 'META-INF/container.xml');
  const rootfile = findFirstElement(containerRoot, 'rootfile');
  const rawOpfPath = rootfile?.attrs.get('full-path')?.trim() ?? '';
  const opfPath = normalizeZipPath(rawOpfPath);
  if (opfPath.length === 0) {
    throw new ConverterError('missing-part', 'EPUB container.xml does not declare an OPF rootfile full-path.');
  }

  const opfEntry = archive.get(opfPath);
  if (!opfEntry) {
    throw new ConverterError('missing-part', `EPUB archive is missing OPF package "${opfPath}".`);
  }

  const opfRoot = parseXmlDocument(decodeTextBytes(opfEntry.data), opfPath);
  const opfMeta = parseOpfMetadata(opfRoot);
  const manifest = parseOpfManifest(opfRoot);
  const spineIds = parseOpfSpine(opfRoot);
  if (spineIds.length === 0) {
    throw new ConverterError('missing-part', 'EPUB OPF spine contains no chapter references.');
  }

  const opfDir = dirnameOf(opfPath);
  const chapterFlow: FlowBlockSpec[] = [];
  let chapterCount = 0;

  for (const idref of spineIds) {
    const item = manifest.get(idref);
    if (!item) {
      throw new ConverterError('missing-part', `EPUB spine itemref "${idref}" is missing from OPF manifest.`);
    }
    const chapterPath = resolveRelativeZipPath(opfDir, item.href);
    const chapterEntry = findZipEntryDecoded(archive, chapterPath);
    if (!chapterEntry) {
      throw new ConverterError('missing-part', `EPUB archive is missing chapter "${chapterPath}".`);
    }

    chapterCount += 1;
    const htmlParsed = extractHtmlContent(decodeTextBytes(chapterEntry.data));
    if (htmlParsed.blocks.length > 0) {
      htmlParsed.blocks.forEach((block, index) => {
        chapterFlow.push(index === 0 && chapterCount > 1 ? { ...block, pageBreakBefore: true } : block);
      });
    } else if (chapterCount > 1) {
      chapterFlow.push({ type: 'other', text: '', pageBreakBefore: true });
    }
  }

  const hasText = chapterFlow.some(block => block.text.length > 0);
  const layout = paginateFlowBlocks(hasText ? chapterFlow : [], PAGE_WIDTH_PORTRAIT, PAGE_HEIGHT_PORTRAIT);

  const metadata: SourceMetadata = {
    format: 'epub',
    ...opfMeta,
    chapterCount,
  };

  return finalizeResult('epub', bytes, layout.pages, layout.blocks, metadata, [], options);
}

export function convertHtml(bytes: Uint8Array, options: ConvertOptions = {}): ConversionResult {
  assertBytes(bytes);
  const text = decodeTextBytes(bytes);
  const parsed = extractHtmlContent(text);
  const layout = paginateFlowBlocks(parsed.blocks, PAGE_WIDTH_PORTRAIT, PAGE_HEIGHT_PORTRAIT);
  const metadata: SourceMetadata = {
    format: 'html',
    ...parsed.metadata,
  };

  return finalizeResult('html', bytes, layout.pages, layout.blocks, metadata, [], options);
}

export function convertImage(bytes: Uint8Array, options: ConvertImageOptions = {}): ConversionResult {
  assertBytes(bytes);
  const dims = parseImageDimensions(bytes, options.format);
  const pages: BuildPageInput[] = [{ index: 1, width: dims.width, height: dims.height, rotation: 0 }];
  const blocks: BuildBlockInput[] = [
    {
      page: 1,
      text: '',
      rect: { x: 0, y: 0, width: dims.width, height: dims.height },
      type: 'figure',
      confidence: 0,
      origin: 'import',
    },
  ];
  const metadata: SourceMetadata = {
    format: dims.format,
    imageWidth: dims.width,
    imageHeight: dims.height,
  };

  return finalizeResult(dims.format, bytes, pages, blocks, metadata, [], options);
}

// --- Finalization & format resolution --------------------------------------

function finalizeResult(
  format: ConvertibleFormat,
  bytes: Uint8Array,
  pages: readonly BuildPageInput[],
  blocks: readonly BuildBlockInput[],
  metadata: SourceMetadata,
  warnings: readonly string[],
  options: ConvertOptions,
): ConversionResult {
  const sourceSha256 = sha256HexBytes(bytes);
  const language = nonEmptyTrimmed(metadata.language) ?? nonEmptyTrimmed(options.defaultLanguage) ?? 'und';
  const ir = buildDocument({
    pages: pages.length > 0 ? pages : [{ index: 1, width: PAGE_WIDTH_PORTRAIT, height: PAGE_HEIGHT_PORTRAIT, rotation: 0 }],
    blocks,
    sourceSha256,
    language,
    documentId: options.documentId,
    revisionId: options.revisionId,
  });

  const problems = validate(ir);
  if (problems.length > 0) {
    throw new ConverterError(
      'malformed-xml',
      `Internal IR validation failed for ${format}: ${problems[0]?.message ?? 'unknown problem'}`,
    );
  }

  return {
    format,
    ir,
    metadata,
    warnings,
  };
}

function assertBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new ConverterError('invalid-input', 'Converter expects input bytes as a Uint8Array.');
  }
  if (bytes.length === 0) {
    throw new ConverterError('invalid-input', 'Input byte array is empty.');
  }
}

function resolveFormat(bytes: Uint8Array, options: ConvertOptions): ConvertibleFormat {
  if (options.format !== undefined) {
    if (!CONVERTIBLE_FORMATS.includes(options.format)) {
      throw new ConverterError('unsupported-format', `Format "${String(options.format)}" is not supported by E12 converters.`);
    }
    return options.format;
  }

  const sniffed = sniffFormat(bytes, options.filename ?? '');
  if ((CONVERTIBLE_FORMATS as readonly string[]).includes(sniffed.format)) {
    return sniffed.format as ConvertibleFormat;
  }
  if (hasUtf16Bom(bytes)) {
    if (sniffed.evidence.some(entry => entry.code === 'html-extension')) {
      return 'html';
    }
    const sampleEnd = Math.min(bytes.length, 1024) & ~1;
    const head = decodeTextBytes(bytes.subarray(0, sampleEnd));
    if (/<!doctype\s+html|<html[\s>]/iu.test(head)) {
      return 'html';
    }
  }
  if (sniffed.evidence.some(entry => entry.code === 'html-extension') && looksUtf8Text(bytes)) {
    return 'html';
  }
  throw new ConverterError(
    'unsupported-format',
    `Format "${sniffed.format}" cannot be converted directly by E12 format converters.`,
  );
}

function hasUtf16Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  );
}

function looksUtf8Text(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 512);
  for (let i = 0; i < limit; i += 1) {
    const b = bytes[i]!;
    if (b === 0x00) return false;
  }
  return true;
}

// --- Pure-TS ZIP parser & RFC 1951 DEFLATE inflate -------------------------

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32Bytes(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16leAt(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8)) >>> 0;
}

function u32leAt(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function resolveDefaultInflateRaw(): InflateRawFn {
  const maybeProcess = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const zlib = maybeProcess?.getBuiltinModule?.('node:zlib') as
    | { inflateRawSync?: (buf: Uint8Array) => Uint8Array }
    | undefined;
  if (zlib && typeof zlib.inflateRawSync === 'function') {
    const nodeInflate = zlib.inflateRawSync;
    return (compressed: Uint8Array) => new Uint8Array(nodeInflate(compressed));
  }
  return inflateRawPure;
}

/**
 * Parses a ZIP archive via its End of Central Directory and Central Directory records,
 * reading entry payloads from each entry's local header and verifying CRC-32 checksums.
 */
export function parseZip(
  bytes: Uint8Array,
  options: { readonly inflateRaw?: InflateRawFn } = {},
): Map<string, ZipEntryRecord> {
  assertBytes(bytes);
  if (bytes.length < 22) {
    throw new ConverterError('corrupted-archive', 'ZIP archive is too short to contain an End of Central Directory record.');
  }

  const eocdOffset = findEocdOffset(bytes);
  if (eocdOffset < 0) {
    throw new ConverterError('corrupted-archive', 'ZIP End of Central Directory signature not found.');
  }

  const diskNumber = u16leAt(bytes, eocdOffset + 4);
  const cdStartDisk = u16leAt(bytes, eocdOffset + 6);
  const entriesOnDisk = u16leAt(bytes, eocdOffset + 8);
  const totalEntries = u16leAt(bytes, eocdOffset + 10);
  const cdSize = u32leAt(bytes, eocdOffset + 12);
  const cdOffset = u32leAt(bytes, eocdOffset + 16);

  if (diskNumber !== 0 || cdStartDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ConverterError('corrupted-archive', 'Multi-disk ZIP archives are not supported.');
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ConverterError('corrupted-archive', 'ZIP64 archives are not supported.');
  }
  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new ConverterError('corrupted-archive', `ZIP archive contains ${totalEntries} entries, above the ${MAX_ZIP_ENTRIES}-entry limit.`);
  }
  if (cdOffset > eocdOffset || cdOffset + cdSize > eocdOffset) {
    throw new ConverterError('corrupted-archive', 'ZIP central directory bounds extend past End of Central Directory.');
  }

  const inflate = options.inflateRaw ?? resolveDefaultInflateRaw();
  const entries = new Map<string, ZipEntryRecord>();
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
  const cdEnd = cdOffset + cdSize;
  let cursor = cdOffset;
  let totalUncompressedBytes = 0;

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > cdEnd) {
      throw new ConverterError('corrupted-archive', `ZIP central directory entry ${i} is truncated.`);
    }
    if (u32leAt(bytes, cursor) !== 0x02014b50) {
      throw new ConverterError('corrupted-archive', `Invalid ZIP central directory signature at offset ${cursor}.`);
    }

    const flags = u16leAt(bytes, cursor + 8);
    const method = u16leAt(bytes, cursor + 10);
    const expectedCrc = u32leAt(bytes, cursor + 16);
    const compressedSize = u32leAt(bytes, cursor + 20);
    const uncompressedSize = u32leAt(bytes, cursor + 24);
    const nameLen = u16leAt(bytes, cursor + 28);
    const extraLen = u16leAt(bytes, cursor + 30);
    const commentLen = u16leAt(bytes, cursor + 32);
    const localHeaderOffset = u32leAt(bytes, cursor + 42);

    const recordEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (recordEnd > cdEnd) {
      throw new ConverterError('corrupted-archive', `ZIP central directory entry ${i} overflows central directory.`);
    }

    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLen);
    const name = decodeZipFilename(nameBytes, (flags & 0x0800) !== 0, utf8Decoder);
    cursor = recordEnd;

    if ((flags & 0x0001) !== 0) {
      throw new ConverterError('unsupported-compression', `Encrypted ZIP entry "${name}" is not supported.`);
    }
    if (uncompressedSize > MAX_UNCOMPRESSED_ENTRY_BYTES) {
      throw new ConverterError('corrupted-archive', `ZIP entry "${name}" exceeds maximum uncompressed size limit.`);
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new ConverterError('corrupted-archive', `ZIP archive exceeds the ${MAX_ZIP_UNCOMPRESSED_BYTES}-byte total uncompressed size limit.`);
    }
    if (localHeaderOffset + 30 > cdOffset) {
      throw new ConverterError('corrupted-archive', `ZIP local header offset out of bounds for "${name}".`);
    }
    if (u32leAt(bytes, localHeaderOffset) !== 0x04034b50) {
      throw new ConverterError('corrupted-archive', `Invalid ZIP local header signature for "${name}".`);
    }

    const localNameLen = u16leAt(bytes, localHeaderOffset + 26);
    const localExtraLen = u16leAt(bytes, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > cdOffset || dataEnd > cdOffset) {
      throw new ConverterError('corrupted-archive', `ZIP entry data extends past central directory for "${name}".`);
    }

    if (name.endsWith('/') && uncompressedSize === 0) {
      continue;
    }

    const compressedSlice = bytes.subarray(dataStart, dataEnd);
    const data = decompressZipEntry(name, method, compressedSlice, compressedSize, uncompressedSize, inflate);
    if (data.length !== uncompressedSize) {
      throw new ConverterError(
        'corrupted-archive',
        `ZIP entry "${name}" uncompressed length ${data.length} does not match header size ${uncompressedSize}.`,
      );
    }
    const actualCrc = crc32Bytes(data);
    if (actualCrc !== expectedCrc) {
      throw new ConverterError(
        'corrupted-archive',
        `ZIP CRC-32 mismatch for "${name}": expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}.`,
      );
    }

    entries.set(normalizeZipPath(name), {
      name: normalizeZipPath(name),
      method,
      crc32: actualCrc,
      compressedSize,
      uncompressedSize,
      data,
    });
  }

  return entries;
}

function findEocdOffset(bytes: Uint8Array): number {
  const minOffset = Math.max(0, bytes.length - 22 - 65535);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      const commentLength = u16leAt(bytes, offset + 20);
      if (offset + 22 + commentLength === bytes.length) {
        return offset;
      }
    }
  }
  return -1;
}

function decodeZipFilename(bytes: Uint8Array, isUtf8: boolean, utf8Decoder: TextDecoder): string {
  if (isUtf8) return utf8Decoder.decode(bytes);
  let ascii = true;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i]! >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return utf8Decoder.decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]!);
    return out;
  }
}

function decompressZipEntry(
  name: string,
  method: number,
  compressed: Uint8Array,
  compressedSize: number,
  uncompressedSize: number,
  inflate: InflateRawFn,
): Uint8Array {
  if (method === 0) {
    if (compressedSize !== uncompressedSize) {
      throw new ConverterError(
        'corrupted-archive',
        `Stored ZIP entry "${name}" has mismatched sizes (${compressedSize} vs ${uncompressedSize}).`,
      );
    }
    return new Uint8Array(compressed);
  }
  if (method === 8) {
    try {
      return inflate(compressed);
    } catch (error) {
      if (error instanceof ConverterError) throw error;
      throw new ConverterError(
        'decompression-failed',
        `Failed to inflate ZIP entry "${name}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  throw new ConverterError('unsupported-compression', `Unsupported ZIP compression method ${method} for "${name}".`);
}

// --- Pure-TS RFC 1951 DEFLATE decompressor ---------------------------------

const MAX_HUFFMAN_BITS = 15;
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15] as const;
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
] as const;
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
] as const;
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
] as const;
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
] as const;

interface HuffmanTree {
  readonly counts: Uint16Array;
  readonly symbols: Uint16Array;
}

const FIXED_LIT_TREE = buildFixedLitTree();
const FIXED_DIST_TREE = buildFixedDistTree();

function buildFixedLitTree(): HuffmanTree {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  return buildHuffmanTree(lengths, 288);
}

function buildFixedDistTree(): HuffmanTree {
  const lengths = new Uint8Array(32);
  lengths.fill(5);
  return buildHuffmanTree(lengths, 32);
}

function buildHuffmanTree(lengths: Uint8Array, symbolCount: number): HuffmanTree {
  const counts = new Uint16Array(MAX_HUFFMAN_BITS + 1);
  for (let i = 0; i < symbolCount; i += 1) {
    const len = lengths[i]!;
    if (len > MAX_HUFFMAN_BITS) {
      throw new ConverterError('decompression-failed', 'DEFLATE Huffman code length exceeds 15 bits.');
    }
    counts[len] = (counts[len]! + 1) & 0xffff;
  }

  let left = 1;
  for (let len = 1; len <= MAX_HUFFMAN_BITS; len += 1) {
    left <<= 1;
    left -= counts[len]!;
    if (left < 0) {
      throw new ConverterError('decompression-failed', 'Oversubscribed Huffman tree in DEFLATE stream.');
    }
  }

  const offsets = new Uint16Array(MAX_HUFFMAN_BITS + 1);
  for (let len = 1; len < MAX_HUFFMAN_BITS; len += 1) {
    offsets[len + 1] = offsets[len]! + counts[len]!;
  }

  const symbols = new Uint16Array(symbolCount);
  for (let sym = 0; sym < symbolCount; sym += 1) {
    const len = lengths[sym]!;
    if (len !== 0) {
      const pos = offsets[len]!;
      offsets[len] = pos + 1;
      symbols[pos] = sym;
    }
  }

  return { counts, symbols };
}

class BitReader {
  private byteOffset = 0;
  private bitBuffer = 0;
  private bitCount = 0;

  constructor(private readonly input: Uint8Array) {}

  readBit(): number {
    if (this.bitCount === 0) {
      if (this.byteOffset >= this.input.length) {
        throw new ConverterError('decompression-failed', 'Unexpected end of DEFLATE bitstream.');
      }
      this.bitBuffer = this.input[this.byteOffset]!;
      this.byteOffset += 1;
      this.bitCount = 8;
    }
    const bit = this.bitBuffer & 1;
    this.bitBuffer >>>= 1;
    this.bitCount -= 1;
    return bit;
  }

  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      value |= this.readBit() << i;
    }
    return value >>> 0;
  }

  alignToByte(): void {
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  readU16Aligned(): number {
    if (this.byteOffset + 2 > this.input.length) {
      throw new ConverterError('decompression-failed', 'Truncated stored block header in DEFLATE stream.');
    }
    const value = this.input[this.byteOffset]! | (this.input[this.byteOffset + 1]! << 8);
    this.byteOffset += 2;
    return value >>> 0;
  }

  readBytesAligned(length: number): Uint8Array {
    if (this.byteOffset + length > this.input.length) {
      throw new ConverterError('decompression-failed', 'Truncated stored block payload in DEFLATE stream.');
    }
    const slice = this.input.subarray(this.byteOffset, this.byteOffset + length);
    this.byteOffset += length;
    return slice;
  }

  decodeSymbol(tree: HuffmanTree): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAX_HUFFMAN_BITS; len += 1) {
      code |= this.readBit();
      const count = tree.counts[len]!;
      if (code - count < first) {
        return tree.symbols[index + (code - first)]!;
      }
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new ConverterError('decompression-failed', 'Invalid Huffman symbol in DEFLATE stream.');
  }
}

/**
 * Pure-TypeScript RFC 1951 raw DEFLATE decompressor (stored, fixed, and dynamic Huffman).
 */
export function inflateRawPure(compressed: Uint8Array): Uint8Array {
  if (!(compressed instanceof Uint8Array)) {
    throw new ConverterError('decompression-failed', 'inflateRawPure expects a Uint8Array.');
  }
  const reader = new BitReader(compressed);
  let output = new Uint8Array(Math.max(1024, compressed.length * 3));
  let outPos = 0;

  const ensureCapacity = (needed: number): void => {
    if (outPos + needed <= output.length) return;
    if (outPos + needed > MAX_UNCOMPRESSED_ENTRY_BYTES) {
      throw new ConverterError('decompression-failed', 'DEFLATE output exceeds maximum size limit.');
    }
    let nextLen = Math.max(output.length * 2, outPos + needed);
    if (nextLen > MAX_UNCOMPRESSED_ENTRY_BYTES) nextLen = MAX_UNCOMPRESSED_ENTRY_BYTES;
    const grown = new Uint8Array(nextLen);
    grown.set(output.subarray(0, outPos));
    output = grown;
  };

  let isFinal = 0;
  while (isFinal === 0) {
    isFinal = reader.readBit();
    const blockType = reader.readBits(2);

    if (blockType === 0) {
      reader.alignToByte();
      const len = reader.readU16Aligned();
      const nlen = reader.readU16Aligned();
      if (((len ^ nlen) & 0xffff) !== 0xffff) {
        throw new ConverterError('decompression-failed', 'Corrupted stored DEFLATE block length.');
      }
      const chunk = reader.readBytesAligned(len);
      ensureCapacity(len);
      output.set(chunk, outPos);
      outPos += len;
      continue;
    }

    if (blockType === 3) {
      throw new ConverterError('decompression-failed', 'Reserved DEFLATE block type 3.');
    }

    let litTree: HuffmanTree;
    let distTree: HuffmanTree;
    if (blockType === 1) {
      litTree = FIXED_LIT_TREE;
      distTree = FIXED_DIST_TREE;
    } else {
      const hlit = reader.readBits(5) + 257;
      const hdist = reader.readBits(5) + 1;
      const hclen = reader.readBits(4) + 4;
      if (hlit > 286 || hdist > 32) {
        throw new ConverterError('decompression-failed', 'Invalid dynamic Huffman alphabet header.');
      }

      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i += 1) {
        codeLengths[CODE_LENGTH_ORDER[i]!] = reader.readBits(3);
      }
      const codeTree = buildHuffmanTree(codeLengths, 19);

      const total = hlit + hdist;
      const lengths = new Uint8Array(total);
      let idx = 0;
      while (idx < total) {
        const sym = reader.decodeSymbol(codeTree);
        if (sym < 16) {
          lengths[idx] = sym;
          idx += 1;
        } else {
          let repeat = 0;
          let value = 0;
          if (sym === 16) {
            if (idx === 0) {
              throw new ConverterError('decompression-failed', 'Invalid repeat-previous code at start of DEFLATE tree.');
            }
            value = lengths[idx - 1]!;
            repeat = 3 + reader.readBits(2);
          } else if (sym === 17) {
            repeat = 3 + reader.readBits(3);
          } else {
            repeat = 11 + reader.readBits(7);
          }
          if (idx + repeat > total) {
            throw new ConverterError('decompression-failed', 'DEFLATE code-length repeat overflows table.');
          }
          lengths.fill(value, idx, idx + repeat);
          idx += repeat;
        }
      }

      if (lengths[256] === 0) {
        throw new ConverterError('decompression-failed', 'Dynamic DEFLATE block omits end-of-block symbol.');
      }
      litTree = buildHuffmanTree(lengths.subarray(0, hlit), hlit);
      distTree = buildHuffmanTree(lengths.subarray(hlit), hdist);
    }

    for (;;) {
      const sym = reader.decodeSymbol(litTree);
      if (sym < 256) {
        ensureCapacity(1);
        output[outPos] = sym;
        outPos += 1;
      } else if (sym === 256) {
        break;
      } else {
        const lenIndex = sym - 257;
        if (lenIndex >= LENGTH_BASE.length) {
          throw new ConverterError('decompression-failed', `Invalid DEFLATE length symbol ${sym}.`);
        }
        const length = LENGTH_BASE[lenIndex]! + reader.readBits(LENGTH_EXTRA[lenIndex]!);
        const distSym = reader.decodeSymbol(distTree);
        if (distSym >= DIST_BASE.length) {
          throw new ConverterError('decompression-failed', `Invalid DEFLATE distance symbol ${distSym}.`);
        }
        const distance = DIST_BASE[distSym]! + reader.readBits(DIST_EXTRA[distSym]!);
        if (distance === 0 || distance > outPos) {
          throw new ConverterError('decompression-failed', `Invalid DEFLATE back-reference distance ${distance}.`);
        }
        ensureCapacity(length);
        for (let k = 0; k < length; k += 1) {
          output[outPos] = output[outPos - distance]!;
          outPos += 1;
        }
      }
    }
  }

  return output.subarray(0, outPos);
}

// --- Pure-TS SHA-256 over Uint8Array ---------------------------------------

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const SHA256_ROUNDS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * Computes lowercase FIPS 180-4 hex SHA-256 directly over raw input bytes.
 */
export function sha256HexBytes(bytes: Uint8Array): string {
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000), false);
  view.setUint32(padded.length - 4, bits >>> 0, false);

  const schedule = new Uint32Array(64);
  let h0: number = SHA256_INITIAL[0];
  let h1: number = SHA256_INITIAL[1];
  let h2: number = SHA256_INITIAL[2];
  let h3: number = SHA256_INITIAL[3];
  let h4: number = SHA256_INITIAL[4];
  let h5: number = SHA256_INITIAL[5];
  let h6: number = SHA256_INITIAL[6];
  let h7: number = SHA256_INITIAL[7];

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) schedule[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const w15 = schedule[i - 15]!;
      const w2 = schedule[i - 2]!;
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      schedule[i] = (schedule[i - 16]! + s0 + schedule[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + SHA256_ROUNDS[i]! + schedule[i]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map(word => word.toString(16).padStart(8, '0')).join('');
}

// --- Text decoding & entity decoding ---------------------------------------

function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return stripBom(new TextDecoder('utf-16le').decode(bytes.subarray(2)));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return stripBom(new TextDecoder('utf-16be').decode(bytes.subarray(2)));
  }
  return stripBom(new TextDecoder('utf-8').decode(bytes));
}

function stripBom(text: string): string {
  return text.startsWith('\ufeff') ? text.slice(1) : text;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200c',
  zwj: '\u200d',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  bull: '\u2022',
  middot: '\u00b7',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  sect: '\u00a7',
  para: '\u00b6',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  minus: '\u2212',
  frac14: '\u00bc',
  frac12: '\u00bd',
  frac34: '\u00be',
  iexcl: '\u00a1',
  iquest: '\u00bf',
  prime: '\u2032',
  Prime: '\u2033',
  le: '\u2264',
  ge: '\u2265',
  ne: '\u2260',
  approx: '\u2248',
  equiv: '\u2261',
  infin: '\u221e',
  larr: '\u2190',
  uarr: '\u2191',
  rarr: '\u2192',
  darr: '\u2193',
  harr: '\u2194',
  Agrave: '\u00c0',
  Aacute: '\u00c1',
  Acirc: '\u00c2',
  Atilde: '\u00c3',
  Auml: '\u00c4',
  Aring: '\u00c5',
  AElig: '\u00c6',
  Ccedil: '\u00c7',
  Egrave: '\u00c8',
  Eacute: '\u00c9',
  Ecirc: '\u00ca',
  Euml: '\u00cb',
  Igrave: '\u00cc',
  Iacute: '\u00cd',
  Icirc: '\u00ce',
  Iuml: '\u00cf',
  Ntilde: '\u00d1',
  Ograve: '\u00d2',
  Oacute: '\u00d3',
  Ocirc: '\u00d4',
  Ouml: '\u00d6',
  Ugrave: '\u00d9',
  Uacute: '\u00da',
  Ucirc: '\u00db',
  Uuml: '\u00dc',
  agrave: '\u00e0',
  aacute: '\u00e1',
  acirc: '\u00e2',
  atilde: '\u00e3',
  auml: '\u00e4',
  aring: '\u00e5',
  aelig: '\u00e6',
  ccedil: '\u00e7',
  egrave: '\u00e8',
  eacute: '\u00e9',
  ecirc: '\u00ea',
  euml: '\u00eb',
  igrave: '\u00ec',
  iacute: '\u00ed',
  icirc: '\u00ee',
  iuml: '\u00ef',
  ntilde: '\u00f1',
  ograve: '\u00f2',
  oacute: '\u00f3',
  ocirc: '\u00f4',
  otilde: '\u00f5',
  ouml: '\u00f6',
  ugrave: '\u00f9',
  uacute: '\u00fa',
  ucirc: '\u00fb',
  uuml: '\u00fc',
  yacute: '\u00fd',
  yuml: '\u00ff',
  szlig: '\u00df',
  OElig: '\u0152',
  oelig: '\u0153',
};

const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g;

/**
 * Decodes XML/HTML named and numeric character references in a single pass
 * so double-escaped text like `&amp;lt;` decodes once to `&lt;`.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return codePointToString(code);
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return codePointToString(code);
    }
    return NAMED_ENTITIES[entity] ?? full;
  });
}

function codePointToString(code: number): string {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return '\ufffd';
  }
  return String.fromCodePoint(code);
}

// --- Lightweight XML & HTML tree parser ------------------------------------

interface XmlElement {
  readonly tag: string;
  readonly attrs: Map<string, string>;
  readonly children: XmlElement[];
  readonly nodes: Array<XmlElement | string>;
}

function createElement(tag: string, attrs = new Map<string, string>()): XmlElement {
  return { tag, attrs, children: [], nodes: [] };
}

function localNameOf(tag: string): string {
  const colon = tag.indexOf(':');
  return colon === -1 ? tag : tag.slice(colon + 1);
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(raw)) !== null) {
    const key = match[1];
    if (!key) continue;
    const rawValue = match[2] ?? match[3] ?? match[4] ?? '';
    attrs.set(key, decodeHtmlEntities(rawValue));
  }
  return attrs;
}

function parseXmlDocument(xml: string, partName: string): XmlElement {
  if (xml.length > MAX_XML_CHARS) {
    throw new ConverterError('malformed-xml', `XML part "${partName}" exceeds the ${MAX_XML_CHARS}-character safety limit.`);
  }
  const root = createElement('#root');
  const stack: XmlElement[] = [root];
  let index = 0;

  while (index < xml.length) {
    const lt = xml.indexOf('<', index);
    if (lt === -1) {
      appendTextNode(stack[stack.length - 1]!, decodeHtmlEntities(xml.slice(index)));
      break;
    }

    if (lt > index) {
      appendTextNode(stack[stack.length - 1]!, decodeHtmlEntities(xml.slice(index, lt)));
    }

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) {
        throw new ConverterError('malformed-xml', `Unterminated XML comment in "${partName}".`);
      }
      index = end + 3;
      continue;
    }

    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) {
        throw new ConverterError('malformed-xml', `Unterminated CDATA section in "${partName}".`);
      }
      appendTextNode(stack[stack.length - 1]!, xml.slice(lt + 9, end));
      index = end + 3;
      continue;
    }

    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) {
        throw new ConverterError('malformed-xml', `Unterminated processing instruction in "${partName}".`);
      }
      index = end + 2;
      continue;
    }

    if (xml.startsWith('<!', lt)) {
      const end = skipDoctypeOrDeclaration(xml, lt);
      if (end === -1) {
        throw new ConverterError('malformed-xml', `Unterminated declaration in "${partName}".`);
      }
      index = end;
      continue;
    }

    const gt = findTagEnd(xml, lt + 1);
    if (gt === -1) {
      throw new ConverterError('malformed-xml', `Unterminated XML tag in "${partName}".`);
    }

    const inside = xml.slice(lt + 1, gt).trim();
    index = gt + 1;

    if (inside.length === 0) {
      throw new ConverterError('malformed-xml', `Empty XML tag "<>" in "${partName}".`);
    }

    if (inside.startsWith('/')) {
      const closeName = inside.slice(1).trim();
      const top = stack[stack.length - 1];
      if (!top || stack.length <= 1 || top.tag !== closeName) {
        throw new ConverterError('malformed-xml', `Mismatched XML closing tag "</${closeName}>" in "${partName}".`);
      }
      stack.pop();
      continue;
    }

    const selfClosing = inside.endsWith('/');
    const body = selfClosing ? inside.slice(0, -1).trim() : inside;
    const spaceMatch = /\s/.exec(body);
    const tagName = spaceMatch ? body.slice(0, spaceMatch.index) : body;
    const attrText = spaceMatch ? body.slice(spaceMatch.index + 1) : '';
    if (tagName.length === 0) {
      throw new ConverterError('malformed-xml', `Invalid XML start tag in "${partName}".`);
    }

    const element = createElement(tagName, parseAttributes(attrText));
    const parent = stack[stack.length - 1]!;
    parent.children.push(element);
    parent.nodes.push(element);
    if (!selfClosing) {
      stack.push(element);
    }
  }

  if (stack.length !== 1) {
    const unclosed = stack[stack.length - 1]?.tag ?? 'unknown';
    throw new ConverterError('malformed-xml', `Unclosed XML tag "<${unclosed}>" in "${partName}".`);
  }
  if (root.children.length === 0) {
    throw new ConverterError('malformed-xml', `XML part "${partName}" has no root element.`);
  }
  return root.children[0]!;
}

const HTML_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const HTML_RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template']);

function parseHtmlDocument(html: string): XmlElement {
  const root = createElement('#document');
  const stack: XmlElement[] = [root];
  let index = 0;

  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) {
      appendTextNode(stack[stack.length - 1]!, decodeHtmlEntities(html.slice(index)));
      break;
    }

    if (lt > index) {
      appendTextNode(stack[stack.length - 1]!, decodeHtmlEntities(html.slice(index, lt)));
    }

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }

    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = skipDoctypeOrDeclaration(html, lt);
      index = end === -1 ? html.length : end;
      continue;
    }

    const gt = findTagEnd(html, lt + 1);
    if (gt === -1) {
      appendTextNode(stack[stack.length - 1]!, decodeHtmlEntities(html.slice(lt)));
      break;
    }

    const inside = html.slice(lt + 1, gt).trim();
    index = gt + 1;
    if (inside.length === 0) continue;

    if (inside.startsWith('/')) {
      const closeTag = inside.slice(1).trim().toLowerCase();
      for (let pos = stack.length - 1; pos >= 1; pos -= 1) {
        if (stack[pos]!.tag === closeTag) {
          stack.length = pos;
          break;
        }
      }
      continue;
    }

    const selfClosing = inside.endsWith('/');
    const body = selfClosing ? inside.slice(0, -1).trim() : inside;
    const spaceMatch = /\s/.exec(body);
    const rawTag = spaceMatch ? body.slice(0, spaceMatch.index) : body;
    const tag = rawTag.toLowerCase();
    if (tag.length === 0 || !/^[a-z][a-z0-9:-]*$/i.test(tag)) {
      appendTextNode(stack[stack.length - 1]!, `<${inside}>`);
      continue;
    }

    const attrText = spaceMatch ? body.slice(spaceMatch.index + 1) : '';
    const attrs = parseAttributes(attrText);

    if (HTML_RAW_TEXT_TAGS.has(tag) && !selfClosing) {
      const closeIdx = findRawCloseTag(html, index, tag);
      index = closeIdx === -1 ? html.length : closeIdx;
      continue;
    }

    const element = createElement(tag, attrs);
    const parent = stack[stack.length - 1]!;
    parent.children.push(element);
    parent.nodes.push(element);

    if (!selfClosing && !HTML_VOID_TAGS.has(tag)) {
      stack.push(element);
    }
  }

  return root;
}

function findRawCloseTag(html: string, start: number, tag: string): number {
  const lower = html.slice(start).toLowerCase();
  const needle = `</${tag}`;
  let searchFrom = 0;
  while (searchFrom < lower.length) {
    const pos = lower.indexOf(needle, searchFrom);
    if (pos === -1) return -1;
    const after = lower[pos + needle.length];
    if (after === '>' || (after !== undefined && /\s/.test(after))) {
      const gt = lower.indexOf('>', pos + needle.length);
      return gt === -1 ? -1 : start + gt + 1;
    }
    searchFrom = pos + needle.length;
  }
  return -1;
}

function appendTextNode(parent: XmlElement, text: string): void {
  if (text.length === 0) return;
  parent.nodes.push(text);
}

function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function skipDoctypeOrDeclaration(source: string, lt: number): number {
  let bracketDepth = 0;
  let quote: string | null = null;
  for (let i = lt + 2; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      bracketDepth += 1;
    } else if (ch === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (ch === '>' && bracketDepth === 0) {
      return i + 1;
    }
  }
  return -1;
}

function findFirstElement(root: XmlElement, localName: string): XmlElement | null {
  if (localNameOf(root.tag).toLowerCase() === localName.toLowerCase()) return root;
  for (const child of root.children) {
    const found = findFirstElement(child, localName);
    if (found) return found;
  }
  return null;
}

function findAllElements(root: XmlElement, localName: string): XmlElement[] {
  const out: XmlElement[] = [];
  const target = localName.toLowerCase();
  const visit = (node: XmlElement): void => {
    if (localNameOf(node.tag).toLowerCase() === target) out.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

function elementText(element: XmlElement): string {
  let out = '';
  for (const node of element.nodes) {
    out += typeof node === 'string' ? node : elementText(node);
  }
  return out;
}

function attrByLocalName(element: XmlElement, localName: string): string | undefined {
  const target = localName.toLowerCase();
  for (const [key, value] of element.attrs) {
    if (localNameOf(key).toLowerCase() === target) return value;
  }
  return undefined;
}

// --- OOXML shared metadata -------------------------------------------------

interface CoreMetadataFields {
  readonly title?: string;
  readonly creator?: string;
  readonly author?: string;
  readonly language?: string;
  readonly subject?: string;
  readonly description?: string;
  readonly created?: string;
  readonly modified?: string;
}

function parseCoreProperties(xml: string): CoreMetadataFields {
  const root = parseXmlDocument(xml, 'docProps/core.xml');
  const title = nonEmptyTrimmed(firstElementText(root, 'title'));
  const creator = nonEmptyTrimmed(firstElementText(root, 'creator'));
  const language = nonEmptyTrimmed(firstElementText(root, 'language'));
  const subject = nonEmptyTrimmed(firstElementText(root, 'subject'));
  const description = nonEmptyTrimmed(firstElementText(root, 'description'));
  const created = nonEmptyTrimmed(firstElementText(root, 'created'));
  const modified = nonEmptyTrimmed(firstElementText(root, 'modified'));

  return {
    ...(title ? { title } : {}),
    ...(creator ? { creator, author: creator } : {}),
    ...(language ? { language } : {}),
    ...(subject ? { subject } : {}),
    ...(description ? { description } : {}),
    ...(created ? { created } : {}),
    ...(modified ? { modified } : {}),
  };
}

function firstElementText(root: XmlElement, localName: string): string | undefined {
  const el = findFirstElement(root, localName);
  return el ? elementText(el) : undefined;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// --- DOCX helpers ----------------------------------------------------------

function parseDocxHeadingStyles(stylesXml: string): Set<string> {
  const headingIds = new Set<string>();
  const root = parseXmlDocument(stylesXml, 'word/styles.xml');
  for (const style of findAllElements(root, 'style')) {
    const id = attrByLocalName(style, 'styleId');
    const nameEl = findFirstElement(style, 'name');
    const nameVal = nameEl ? attrByLocalName(nameEl, 'val') : undefined;
    if (id && nameVal && /^(?:heading\s*[1-6]|title|subtitle)$/iu.test(nameVal.trim())) {
      headingIds.add(id);
    }
  }
  return headingIds;
}

function extractDocxLanguage(docRoot: XmlElement): string | undefined {
  const langEl = findFirstElement(docRoot, 'lang');
  return langEl ? nonEmptyTrimmed(attrByLocalName(langEl, 'val')) : undefined;
}

function extractDocxParagraph(paragraph: XmlElement, headingStyles: ReadonlySet<string>): FlowBlockSpec | null {
  const pPr = paragraph.children.find(child => localNameOf(child.tag) === 'pPr');
  const styleEl = pPr ? findFirstElement(pPr, 'pStyle') : null;
  const styleId = styleEl ? attrByLocalName(styleEl, 'val') : undefined;
  const hasNumPr = pPr ? findFirstElement(pPr, 'numPr') !== null : false;

  const pageBreakEl = pPr ? findFirstElement(pPr, 'pageBreakBefore') : null;
  const pageBreakAttr = pageBreakEl ? attrByLocalName(pageBreakEl, 'val') : undefined;
  let pageBreakBefore = pageBreakEl !== null && pageBreakAttr !== '0' && pageBreakAttr !== 'false';

  let type: BlockType = 'paragraph';
  if (styleId && isHeadingStyleId(styleId, headingStyles)) {
    type = 'heading';
  } else if (hasNumPr || (styleId && /^list/iu.test(styleId))) {
    type = 'list';
  }

  let text = '';
  const collectRuns = (node: XmlElement): void => {
    for (const child of node.children) {
      const local = localNameOf(child.tag);
      if (local === 'pPr' || local === 'rPr' || local === 'del' || local === 'proofErr') continue;
      if (local === 't') {
        text += elementText(child);
      } else if (local === 'tab') {
        text += '\t';
      } else if (local === 'br') {
        const brType = attrByLocalName(child, 'type');
        if (brType === 'page') {
          pageBreakBefore = true;
        } else {
          text += '\n';
        }
      } else if (local === 'cr') {
        text += '\n';
      } else {
        collectRuns(child);
      }
    }
  };
  collectRuns(paragraph);

  const normalized = text.trim();
  if (normalized.length === 0) {
    return pageBreakBefore ? { type: 'other', text: '', pageBreakBefore: true } : null;
  }
  return { type, text: normalized, pageBreakBefore };
}

function isHeadingStyleId(styleId: string, headingStyles: ReadonlySet<string>): boolean {
  if (headingStyles.has(styleId)) return true;
  return /^(?:heading\s*[1-6]|h[1-6]|title|subtitle)$/iu.test(styleId.trim());
}

function extractDocxTable(table: XmlElement): string {
  const rows: string[] = [];
  for (const child of table.children) {
    if (localNameOf(child.tag) !== 'tr') continue;
    const cells: string[] = [];
    for (const cell of child.children) {
      if (localNameOf(cell.tag) !== 'tc') continue;
      const cellParagraphs: string[] = [];
      for (const p of cell.children) {
        if (localNameOf(p.tag) !== 'p') continue;
        const extracted = extractDocxParagraph(p, new Set<string>());
        if (extracted && extracted.text.length > 0) cellParagraphs.push(extracted.text);
      }
      cells.push(cellParagraphs.join(' '));
    }
    if (cells.length > 0) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

// --- PPTX helpers ----------------------------------------------------------

function parseSlideNumber(entryName: string): number | null {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(entryName);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

function parsePptxSlideSize(presXml: string): { readonly width: number; readonly height: number } {
  const root = parseXmlDocument(presXml, 'ppt/presentation.xml');
  const sldSz = findFirstElement(root, 'sldSz');
  if (!sldSz) return { width: SLIDE_WIDTH_DEFAULT, height: SLIDE_HEIGHT_DEFAULT };
  const cx = Number.parseFloat(sldSz.attrs.get('cx') ?? '');
  const cy = Number.parseFloat(sldSz.attrs.get('cy') ?? '');
  if (Number.isFinite(cx) && cx > 0 && Number.isFinite(cy) && cy > 0) {
    return {
      width: Math.max(1, Math.round((cx / EMU_PER_POINT) * 100) / 100),
      height: Math.max(1, Math.round((cy / EMU_PER_POINT) * 100) / 100),
    };
  }
  return { width: SLIDE_WIDTH_DEFAULT, height: SLIDE_HEIGHT_DEFAULT };
}

interface SlideShape {
  readonly type: BlockType;
  readonly text: string;
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

function collectSlideShapes(container: XmlElement): SlideShape[] {
  const shapes: SlideShape[] = [];
  for (const child of container.children) {
    const local = localNameOf(child.tag);
    if (local === 'sp') {
      const text = extractDrawingText(child);
      if (text.length === 0) continue;
      const ph = findFirstElement(child, 'ph');
      const phType = ph?.attrs.get('type')?.toLowerCase();
      const type: BlockType = phType === 'title' || phType === 'ctrtitle' || phType === 'subtitle' ? 'heading' : 'paragraph';
      const rect = extractShapeRect(child);
      shapes.push(rect ? { type, text, rect } : { type, text });
    } else if (local === 'graphicFrame') {
      const tbl = findFirstElement(child, 'tbl');
      if (tbl) {
        const text = extractDrawingTable(tbl);
        if (text.length > 0) shapes.push({ type: 'table', text });
      }
    } else if (local === 'grpSp') {
      shapes.push(...collectSlideShapes(child));
    }
  }
  return shapes;
}

function extractDrawingText(shape: XmlElement): string {
  const txBody = findFirstElement(shape, 'txBody') ?? shape;
  const paragraphs: string[] = [];
  for (const p of findAllElements(txBody, 'p')) {
    let line = '';
    const walk = (node: XmlElement): void => {
      for (const child of node.children) {
        const local = localNameOf(child.tag);
        if (local === 't') {
          line += elementText(child);
        } else if (local === 'br') {
          line += '\n';
        } else if (local === 'tab') {
          line += '\t';
        } else {
          walk(child);
        }
      }
    };
    walk(p);
    const trimmed = line.trim();
    if (trimmed.length > 0) paragraphs.push(trimmed);
  }
  return paragraphs.join('\n');
}

function extractDrawingTable(tbl: XmlElement): string {
  const rows: string[] = [];
  for (const tr of tbl.children) {
    if (localNameOf(tr.tag) !== 'tr') continue;
    const cells: string[] = [];
    for (const tc of tr.children) {
      if (localNameOf(tc.tag) !== 'tc') continue;
      cells.push(extractDrawingText(tc).replace(/\n+/g, ' '));
    }
    if (cells.length > 0) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

function extractShapeRect(
  shape: XmlElement,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined {
  const spPr = shape.children.find(child => localNameOf(child.tag) === 'spPr');
  const xfrm = spPr ? findFirstElement(spPr, 'xfrm') : null;
  if (!xfrm) return undefined;
  const off = findFirstElement(xfrm, 'off');
  const ext = findFirstElement(xfrm, 'ext');
  if (!off || !ext) return undefined;
  const x = Number.parseFloat(off.attrs.get('x') ?? '');
  const y = Number.parseFloat(off.attrs.get('y') ?? '');
  const cx = Number.parseFloat(ext.attrs.get('cx') ?? '');
  const cy = Number.parseFloat(ext.attrs.get('cy') ?? '');
  if (![x, y, cx, cy].every(Number.isFinite) || cx <= 0 || cy <= 0) return undefined;
  return {
    x: x / EMU_PER_POINT,
    y: y / EMU_PER_POINT,
    width: cx / EMU_PER_POINT,
    height: cy / EMU_PER_POINT,
  };
}

function clampRectToPage(
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  pageWidth: number,
  pageHeight: number,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const x = Math.max(0, Math.min(pageWidth - 1, rect.x));
  const y = Math.max(0, Math.min(pageHeight - 1, rect.y));
  const width = Math.max(1, Math.min(pageWidth - x, rect.width));
  const height = Math.max(1, Math.min(pageHeight - y, rect.height));
  return { x, y, width, height };
}

function allocateFallbackRect(
  text: string,
  type: BlockType,
  contentWidth: number,
  pageHeight: number,
  cursorY: number,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const lines = Math.max(1, text.split('\n').length);
  const lineH = type === 'heading' ? 24 : 16;
  const desiredHeight = Math.max(20, lines * lineH + 8);
  const y = Math.max(0, Math.min(pageHeight - 2, cursorY));
  const maxAvailable = Math.max(1, pageHeight - MARGIN_Y - y);
  return {
    x: MARGIN_X,
    y,
    width: contentWidth,
    height: Math.min(desiredHeight, maxAvailable),
  };
}

// --- XLSX helpers ----------------------------------------------------------

function parseSharedStrings(xml: string): string[] {
  const root = parseXmlDocument(xml, 'xl/sharedStrings.xml');
  const strings: string[] = [];
  for (const si of root.children) {
    if (localNameOf(si.tag) !== 'si') continue;
    strings.push(extractSpreadsheetRichText(si));
  }
  return strings;
}

function extractSpreadsheetRichText(container: XmlElement): string {
  let out = '';
  for (const child of container.children) {
    const local = localNameOf(child.tag);
    if (local === 'rPh' || local === 'phoneticPr') continue;
    if (local === 't') {
      out += elementText(child);
    } else {
      out += extractSpreadsheetRichText(child);
    }
  }
  return out;
}

function parseRelationships(relsXml: string): Map<string, string> {
  const root = parseXmlDocument(relsXml, 'xl/_rels/workbook.xml.rels');
  const map = new Map<string, string>();
  for (const rel of root.children) {
    if (localNameOf(rel.tag) !== 'Relationship') continue;
    const id = rel.attrs.get('Id');
    const target = rel.attrs.get('Target');
    if (id && target) {
      map.set(id, resolveRelativeZipPath('xl', target));
    }
  }
  return map;
}

interface WorkbookSheetRef {
  readonly name: string;
  readonly path: string;
}

function parseWorkbookSheets(
  workbookRoot: XmlElement,
  rels: ReadonlyMap<string, string>,
  archive: ReadonlyMap<string, ZipEntryRecord>,
): WorkbookSheetRef[] {
  const sheetsEl = findFirstElement(workbookRoot, 'sheets');
  const refs: WorkbookSheetRef[] = [];
  if (sheetsEl) {
    let idx = 0;
    for (const sheet of sheetsEl.children) {
      if (localNameOf(sheet.tag) !== 'sheet') continue;
      idx += 1;
      const name = sheet.attrs.get('name') ?? `Sheet${idx}`;
      const rId = attrByLocalName(sheet, 'id');
      const mapped = rId ? rels.get(rId) : undefined;
      const fallback = `xl/worksheets/sheet${idx}.xml`;
      refs.push({ name, path: mapped ?? fallback });
    }
  }

  if (refs.length > 0) return refs;

  return [...archive.keys()]
    .map(name => ({ name, match: /^xl\/worksheets\/sheet(\d+)\.xml$/i.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
    .sort((a, b) => Number.parseInt(a.match[1]!, 10) - Number.parseInt(b.match[1]!, 10))
    .map((item, idx) => ({ name: `Sheet${idx + 1}`, path: item.name }));
}

function extractWorksheetTable(sheetRoot: XmlElement, sharedStrings: readonly string[]): string {
  const sheetData = findFirstElement(sheetRoot, 'sheetData');
  if (!sheetData) return '';

  const rowLines: string[] = [];
  for (const row of sheetData.children) {
    if (localNameOf(row.tag) !== 'row') continue;
    const cellsByCol = new Map<number, string>();
    let seqCol = 0;
    let maxCol = -1;

    for (const cell of row.children) {
      if (localNameOf(cell.tag) !== 'c') continue;
      const ref = cell.attrs.get('r');
      const col = ref ? parseColumnIndex(ref) : seqCol;
      seqCol = col + 1;
      const value = extractCellValue(cell, sharedStrings);
      if (value.length > 0) {
        cellsByCol.set(col, value);
        if (col > maxCol) maxCol = col;
      }
    }

    if (maxCol < 0) continue;
    const rowCells: string[] = [];
    for (let c = 0; c <= maxCol; c += 1) {
      rowCells.push(cellsByCol.get(c) ?? '');
    }
    rowLines.push(rowCells.join('\t'));
  }

  return rowLines.join('\n');
}

function parseColumnIndex(cellRef: string): number {
  const lettersMatch = /^[A-Za-z]+/.exec(cellRef);
  if (!lettersMatch) return 0;
  const letters = lettersMatch[0].toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i += 1) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return Math.max(0, col - 1);
}

function extractCellValue(cell: XmlElement, sharedStrings: readonly string[]): string {
  const cellType = cell.attrs.get('t') ?? 'n';
  if (cellType === 'inlineStr') {
    const isEl = findFirstElement(cell, 'is');
    return isEl ? extractSpreadsheetRichText(isEl).trim() : '';
  }

  const vEl = findFirstElement(cell, 'v');
  const rawVal = vEl ? elementText(vEl).trim() : '';
  if (rawVal.length === 0) return '';

  if (cellType === 's') {
    const idx = Number.parseInt(rawVal, 10);
    return Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? (sharedStrings[idx] ?? '') : '';
  }
  if (cellType === 'b') {
    return rawVal === '1' ? 'TRUE' : 'FALSE';
  }
  return rawVal;
}

// --- EPUB helpers ----------------------------------------------------------

function parseOpfMetadata(opfRoot: XmlElement): CoreMetadataFields {
  const metadataEl = findFirstElement(opfRoot, 'metadata') ?? opfRoot;
  const title = nonEmptyTrimmed(firstElementText(metadataEl, 'title'));
  const author = nonEmptyTrimmed(firstElementText(metadataEl, 'creator'));
  const language = nonEmptyTrimmed(firstElementText(metadataEl, 'language'));
  const subject = nonEmptyTrimmed(firstElementText(metadataEl, 'subject'));
  const description = nonEmptyTrimmed(firstElementText(metadataEl, 'description'));

  return {
    ...(title ? { title } : {}),
    ...(author ? { author, creator: author } : {}),
    ...(language ? { language } : {}),
    ...(subject ? { subject } : {}),
    ...(description ? { description } : {}),
  };
}

function parseOpfManifest(opfRoot: XmlElement): Map<string, { readonly href: string; readonly mediaType: string }> {
  const manifestEl = findFirstElement(opfRoot, 'manifest');
  const map = new Map<string, { readonly href: string; readonly mediaType: string }>();
  if (!manifestEl) return map;
  for (const item of manifestEl.children) {
    if (localNameOf(item.tag) !== 'item') continue;
    const id = item.attrs.get('id');
    const href = item.attrs.get('href');
    if (id && href) {
      map.set(id, { href, mediaType: item.attrs.get('media-type') ?? '' });
    }
  }
  return map;
}

function parseOpfSpine(opfRoot: XmlElement): string[] {
  const spineEl = findFirstElement(opfRoot, 'spine');
  if (!spineEl) return [];
  const ids: string[] = [];
  for (const itemref of spineEl.children) {
    if (localNameOf(itemref.tag) !== 'itemref') continue;
    const idref = itemref.attrs.get('idref');
    if (idref) ids.push(idref);
  }
  return ids;
}

function normalizeZipPath(path: string): string {
  const cleaned = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments: string[] = [];
  for (const part of cleaned.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join('/');
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function resolveRelativeZipPath(baseDir: string, target: string): string {
  const cleanTarget = target.split('#')[0]?.split('?')[0] ?? target;
  if (cleanTarget.startsWith('/')) return normalizeZipPath(cleanTarget);
  return normalizeZipPath(baseDir.length > 0 ? `${baseDir}/${cleanTarget}` : cleanTarget);
}

function findZipEntryDecoded(archive: ReadonlyMap<string, ZipEntryRecord>, path: string): ZipEntryRecord | undefined {
  const direct = archive.get(path);
  if (direct) return direct;
  try {
    return archive.get(decodeURIComponent(path));
  } catch {
    return undefined;
  }
}

// --- HTML / XHTML extraction -----------------------------------------------

interface ExtractedHtmlContent {
  readonly metadata: CoreMetadataFields;
  readonly blocks: FlowBlockSpec[];
}

function extractHtmlContent(html: string): ExtractedHtmlContent {
  const root = parseHtmlDocument(html);
  const htmlEl = findFirstElement(root, 'html');
  const htmlLang = htmlEl ? nonEmptyTrimmed(htmlEl.attrs.get('lang') ?? attrByLocalName(htmlEl, 'lang')) : undefined;

  const titleEl = findFirstElement(root, 'title');
  const title = nonEmptyTrimmed(titleEl ? normalizeInlineWhitespace(elementText(titleEl)) : undefined);

  let author: string | undefined;
  let description: string | undefined;
  let subject: string | undefined;
  let metaLang: string | undefined;

  for (const meta of findAllElements(root, 'meta')) {
    const key = (meta.attrs.get('name') ?? meta.attrs.get('property') ?? '').trim().toLowerCase();
    const content = nonEmptyTrimmed(meta.attrs.get('content'));
    if (!key || !content) continue;
    if (key === 'author' || key === 'dc.creator') author ??= content;
    else if (key === 'description' || key === 'og:description') description ??= content;
    else if (key === 'keywords' || key === 'subject') subject ??= content;
    else if (key === 'language' || key === 'dc.language') metaLang ??= content;
  }

  const language = htmlLang ?? metaLang;
  const bodyEl = findFirstElement(root, 'body') ?? root;
  const blocks: FlowBlockSpec[] = [];
  collectHtmlBlocks(bodyEl, blocks);

  return {
    metadata: {
      ...(title ? { title } : {}),
      ...(author ? { author, creator: author } : {}),
      ...(language ? { language } : {}),
      ...(description ? { description } : {}),
      ...(subject ? { subject } : {}),
    },
    blocks,
  };
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const HTML_BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'table', 'blockquote', 'pre']);

function collectHtmlBlocks(node: XmlElement, out: FlowBlockSpec[]): void {
  for (const child of node.children) {
    const tag = child.tag;
    if (tag === 'head') continue;
    if (HEADING_TAGS.has(tag)) {
      const text = extractHtmlInlineText(child);
      if (text.length > 0) out.push({ type: 'heading', text });
      continue;
    }
    if (tag === 'p') {
      const text = extractHtmlInlineText(child);
      if (text.length > 0) out.push({ type: 'paragraph', text });
      continue;
    }
    if (tag === 'li') {
      const text = extractHtmlInlineText(child);
      if (text.length > 0) out.push({ type: 'list', text });
      continue;
    }
    if (tag === 'table') {
      const text = extractHtmlTable(child);
      if (text.length > 0) out.push({ type: 'table', text });
      continue;
    }
    if (tag === 'blockquote' || tag === 'pre') {
      if (hasDescendantBlockTags(child)) {
        collectHtmlBlocks(child, out);
      } else {
        const text = tag === 'pre' ? elementText(child).trim() : extractHtmlInlineText(child);
        if (text.length > 0) out.push({ type: 'paragraph', text });
      }
      continue;
    }

    collectHtmlBlocks(child, out);
  }
}

function hasDescendantBlockTags(element: XmlElement): boolean {
  for (const child of element.children) {
    if (HTML_BLOCK_TAGS.has(child.tag) || hasDescendantBlockTags(child)) return true;
  }
  return false;
}

function extractHtmlInlineText(element: XmlElement): string {
  let raw = '';
  const walk = (node: XmlElement): void => {
    for (const item of node.nodes) {
      if (typeof item === 'string') {
        raw += item;
      } else if (item.tag === 'br') {
        raw += '\n';
      } else {
        walk(item);
      }
    }
  };
  walk(element);
  return normalizeInlineWhitespace(raw);
}

function extractHtmlTable(table: XmlElement): string {
  const rows: string[] = [];
  for (const tr of findAllElements(table, 'tr')) {
    const cells: string[] = [];
    for (const cell of tr.children) {
      if (cell.tag === 'td' || cell.tag === 'th') {
        cells.push(extractHtmlInlineText(cell));
      }
    }
    if (cells.length > 0) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

function normalizeInlineWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && idx < arr.length - 1))
    .join('\n')
    .trim();
}

// --- Flow pagination -------------------------------------------------------

interface FlowBlockSpec {
  readonly type: BlockType;
  readonly text: string;
  readonly pageBreakBefore?: boolean;
}

interface PaginatedLayout {
  readonly pages: BuildPageInput[];
  readonly blocks: BuildBlockInput[];
}

function paginateFlowBlocks(
  specs: readonly FlowBlockSpec[],
  pageWidth: number,
  pageHeight: number,
): PaginatedLayout {
  const contentWidth = Math.max(1, pageWidth - MARGIN_X * 2);
  const maxContentHeight = Math.max(20, pageHeight - MARGIN_Y * 2);
  let currentPage = 1;
  let cursorY = MARGIN_Y;
  let pageHasBlocks = false;
  const blocks: BuildBlockInput[] = [];

  for (const spec of specs) {
    if (spec.pageBreakBefore && pageHasBlocks) {
      currentPage += 1;
      cursorY = MARGIN_Y;
      pageHasBlocks = false;
    }

    if (spec.text.length === 0) continue;

    const fontSize = spec.type === 'heading' ? 16 : spec.type === 'table' ? 10 : 11;
    const charsPerLine = Math.max(20, Math.floor(contentWidth / (fontSize * 0.52)));
    const lines = spec.text
      .split('\n')
      .reduce((count, line) => count + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
    const height = Math.min(maxContentHeight, Math.max(fontSize * 1.4, lines * (fontSize * 1.35) + 4));

    if (cursorY + height > pageHeight - MARGIN_Y && pageHasBlocks) {
      currentPage += 1;
      cursorY = MARGIN_Y;
      pageHasBlocks = false;
    }

    blocks.push({
      page: currentPage,
      text: spec.text,
      rect: { x: MARGIN_X, y: cursorY, width: contentWidth, height },
      type: spec.type,
      confidence: 1,
      origin: 'import',
    });

    cursorY += height + BLOCK_GAP;
    pageHasBlocks = true;
  }

  const pageCount = Math.max(1, currentPage);
  const pages: BuildPageInput[] = [];
  for (let p = 1; p <= pageCount; p += 1) {
    pages.push({ index: p, width: pageWidth, height: pageHeight, rotation: 0 });
  }
  return { pages, blocks };
}

// --- Image binary header dimension parsers ---------------------------------

/**
 * Parses pixel width and height directly from PNG IHDR, JPEG SOF0..SOF15,
 * or little/big-endian TIFF IFD tags (ImageWidth 256 / ImageLength 257).
 */
export function parseImageDimensions(bytes: Uint8Array, explicitFormat?: ImageFormat): ImageDimensions {
  assertBytes(bytes);
  const format = explicitFormat ?? detectImageFormat(bytes);

  switch (format) {
    case 'png':
      return parsePngDimensions(bytes);
    case 'jpeg':
      return parseJpegDimensions(bytes);
    case 'tiff':
      return parseTiffDimensions(bytes);
  }
}

function detectImageFormat(bytes: Uint8Array): ImageFormat {
  const sniffed = sniffFormat(bytes);
  if (sniffed.format === 'png' || sniffed.format === 'jpeg' || sniffed.format === 'tiff') {
    return sniffed.format;
  }
  throw new ConverterError('malformed-image', 'Bytes do not match PNG, JPEG, or TIFF header signatures.');
}

function parsePngDimensions(bytes: Uint8Array): ImageDimensions {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    throw new ConverterError('malformed-image', 'PNG file is truncated or missing PNG signature.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrLength = view.getUint32(8, false);
  const isIhdr = bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
  if (!isIhdr || ihdrLength < 13) {
    throw new ConverterError('malformed-image', 'PNG file does not begin with a valid IHDR chunk.');
  }

  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) {
    throw new ConverterError('malformed-image', `Invalid PNG dimensions (${width}x${height}).`);
  }

  return { format: 'png', width, height };
}

function parseJpegDimensions(bytes: Uint8Array): ImageDimensions {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new ConverterError('malformed-image', 'JPEG file is truncated or missing SOI marker.');
  }

  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) break;

    const marker = bytes[offset]!;
    offset += 1;

    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    if (offset + 2 > bytes.length) {
      throw new ConverterError('malformed-image', 'Truncated JPEG marker segment.');
    }
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw new ConverterError('malformed-image', 'Invalid JPEG marker segment length.');
    }

    if (isJpegSofMarker(marker)) {
      if (segmentLength < 7 || offset + 7 > bytes.length) {
        throw new ConverterError('malformed-image', 'Truncated JPEG SOF frame header.');
      }
      // SOF layout after 2-byte length: precision (1), height (2), width (2)
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      if (width === 0 || height === 0) {
        throw new ConverterError('malformed-image', `Invalid JPEG dimensions (${width}x${height}).`);
      }
      return { format: 'jpeg', width, height };
    }

    offset += segmentLength;
  }

  throw new ConverterError('malformed-image', 'JPEG file contains no Start-of-Frame (SOF) marker with dimensions.');
}

function isJpegSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function parseTiffDimensions(bytes: Uint8Array): ImageDimensions {
  if (bytes.length < 8) {
    throw new ConverterError('malformed-image', 'TIFF file is shorter than 8-byte header.');
  }

  let littleEndian: boolean;
  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) {
    littleEndian = true;
  } else if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a) {
    littleEndian = false;
  } else {
    throw new ConverterError('malformed-image', 'TIFF file has an invalid byte-order or magic header.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifdOffset = view.getUint32(4, littleEndian);
  if (ifdOffset < 8 || ifdOffset + 2 > bytes.length) {
    throw new ConverterError('malformed-image', 'TIFF first IFD offset is out of bounds.');
  }

  const entryCount = view.getUint16(ifdOffset, littleEndian);
  if (ifdOffset + 2 + entryCount * 12 > bytes.length) {
    throw new ConverterError('malformed-image', 'TIFF IFD directory extends past end of file.');
  }

  let width: number | undefined;
  let height: number | undefined;

  for (let i = 0; i < entryCount; i += 1) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(entryOffset, littleEndian);
    const fieldType = view.getUint16(entryOffset + 2, littleEndian);
    const count = view.getUint32(entryOffset + 4, littleEndian);

    if ((tag === 256 || tag === 257) && count === 1) {
      const value = readTiffScalarValue(bytes, view, entryOffset + 8, fieldType, littleEndian);
      if (value !== undefined) {
        if (tag === 256) width = value;
        else height = value;
      }
    }
  }

  if (!width || !height || width <= 0 || height <= 0) {
    throw new ConverterError('malformed-image', 'TIFF IFD is missing valid ImageWidth (256) or ImageLength (257) tags.');
  }

  return { format: 'tiff', width, height };
}

function readTiffScalarValue(
  bytes: Uint8Array,
  view: DataView,
  valueOffset: number,
  fieldType: number,
  littleEndian: boolean,
): number | undefined {
  if (fieldType === 1) return bytes[valueOffset]; // BYTE
  if (fieldType === 3) return view.getUint16(valueOffset, littleEndian); // SHORT (left-justified in 4-byte field)
  if (fieldType === 4) return view.getUint32(valueOffset, littleEndian); // LONG
  return undefined;
}
