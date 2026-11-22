/**
 * Canonical Document IR (backlog item E04).
 *
 * The reader's block list is transient and page-local. Later E/F/G items (reading
 * order, block types, tables, formulas, captions, exports) need one stable document
 * shape they can all read, write and diff. This module owns that shape: the types,
 * the builder that derives ids and reading order, provenance, validation and a
 * canonical JSON serializer.
 *
 * Contract:
 * - Everything reachable from a `DocumentIR` is plain JSON data: no DOM types, no
 *   globals, no functions on the document, no `Date.now()` or `Math.random()` in ids.
 *   Two builds of the same input produce byte-identical JSON.
 * - Page numbers are 1-based (`Page.index`), matching `TextBlock.page` in
 *   `src/core/types.ts`. Polygon coordinates are page points with the origin at the
 *   top-left corner and y growing downwards, matching the reader's rects.
 * - `sourceSha256` names the original PDF bytes. No mutation in this module ever
 *   rewrites it: mutations copy the document and change only the array they own.
 */

import type { Rect } from './types';

/** Schema version written by this build. Anything else is refused, never guessed. */
export const DOCUMENT_IR_SCHEMA_VERSION = 1;

/** Slack allowed on a polygon point before it counts as outside its page, in points. */
export const POLYGON_BOUNDS_TOLERANCE = 0.5;

export type BlockType = 'heading' | 'paragraph' | 'list' | 'table' | 'figure' | 'formula' | 'footnote' | 'other';

export type PageRotation = 0 | 90 | 180 | 270;

export type QaStatus = 'unchecked' | 'pass' | 'warn' | 'fail';

/**
 * Pipeline stage that produced an artefact. `pdf-text` is text decoded from the
 * original content stream, `ocr` is recognised from pixels, `import` is anything
 * supplied by an external tool.
 */
export type TransformKind = 'pdf-text' | 'ocr' | 'import' | 'restructure' | 'translate' | 'export';

export type AnnotationKind = 'note' | 'highlight' | 'comment';

export type ExportFormat = 'pdf' | 'docx' | 'html' | 'markdown' | 'text';

export const BLOCK_TYPES: readonly BlockType[] = ['heading', 'paragraph', 'list', 'table', 'figure', 'formula', 'footnote', 'other'];
export const PAGE_ROTATIONS: readonly PageRotation[] = [0, 90, 180, 270];
export const QA_STATUSES: readonly QaStatus[] = ['unchecked', 'pass', 'warn', 'fail'];
export const TRANSFORMS: readonly TransformKind[] = ['pdf-text', 'ocr', 'import', 'restructure', 'translate', 'export'];
export const ANNOTATION_KINDS: readonly AnnotationKind[] = ['note', 'highlight', 'comment'];
export const EXPORT_FORMATS: readonly ExportFormat[] = ['pdf', 'docx', 'html', 'markdown', 'text'];

export interface Point {
  x: number;
  y: number;
}

/** Four corners in source order: top-left, top-right, bottom-right, bottom-left. */
export type Polygon = readonly [Point, Point, Point, Point];

export interface Page {
  /** 1-based page number; `Block.page` must match one of these. */
  index: number;
  width: number;
  height: number;
  rotation: PageRotation;
}

export interface Block {
  /** Derived from geometry, not from input order: `p{page}-r{rank within page}`. */
  id: string;
  type: BlockType;
  page: number;
  polygon: Polygon;
  /** 0-based position across the whole document. */
  readingOrder: number;
  /** Source text as extracted or recognised, before translation. */
  raw: string;
  language: string;
  /** 0..1; text decoded from the content stream is 1, OCR confidence is the engine's. */
  confidence: number;
  /** Ids of child blocks (table cells, caption lists); may point at blocks added later. */
  children: string[];
}

export interface Translation {
  blockId: string;
  lang: string;
  engine: string;
  modelVersion: string;
  promptVersion: string;
  text: string;
  qaStatus: QaStatus;
}

export interface Provenance {
  /** The block this record describes. */
  blockId: string;
  /** Source blocks this one was derived from; empty for blocks read from the page. */
  sourceBlockIds: string[];
  /** OCR engine name, or `null` when no OCR ran for this record. */
  ocrEngine: string | null;
  /** Model or provider identity, or `null` when a deterministic transform ran. */
  model: string | null;
  transform: TransformKind;
}

export interface Annotation {
  id: string;
  page: number;
  kind: AnnotationKind;
  text: string;
  /** ISO-8601 timestamp supplied by the caller; the IR never reads the clock itself. */
  createdAt: string;
}

export interface ExportRecord {
  id: string;
  format: ExportFormat;
  createdAt: string;
  byteLength: number;
  sha256: string;
}

export interface DocumentIR {
  schemaVersion: number;
  documentId: string;
  revisionId: string;
  sourceSha256: string;
  language: string;
  pages: Page[];
  blocks: Block[];
  translations: Translation[];
  provenance: Provenance[];
  annotations: Annotation[];
  exports: ExportRecord[];
}

export type IrErrorCode = 'unsupported-version' | 'malformed-json' | 'malformed-document';

export class IrError extends Error {
  readonly code: IrErrorCode;

  constructor(code: IrErrorCode, message: string) {
    super(message);
    this.name = 'IrError';
    this.code = code;
  }
}

/** One concrete reason a document cannot be trusted. */
export type IrProblemCode =
  | 'malformed-document'
  | 'unsupported-schema-version'
  | 'invalid-source-sha256'
  | 'duplicate-id'
  | 'block-page-unknown'
  | 'polygon-invalid'
  | 'polygon-out-of-bounds'
  | 'translation-orphan'
  | 'provenance-orphan'
  | 'child-orphan';

export interface IrProblem {
  code: IrProblemCode;
  /** Location inside the document, for example `blocks[2].polygon[1]`. */
  path: string;
  message: string;
}

/** A block as the reader currently holds it, before the IR assigns ids. */
export interface BuildBlockInput {
  /** Reader block id (for example `p3-r0`); used only as a reading-order tie-break. */
  id?: string;
  page: number;
  text: string;
  rect?: Rect;
  polygon?: readonly Point[];
  type?: BlockType;
  language?: string;
  confidence?: number;
  origin?: TransformKind;
  children?: readonly string[];
}

export interface BuildPageInput {
  index: number;
  width: number;
  height: number;
  rotation?: PageRotation;
}

export interface BuildDocumentInput {
  blocks: readonly BuildBlockInput[];
  pages?: readonly BuildPageInput[];
  sourceSha256: string;
  language?: string;
  documentId?: string;
  revisionId?: string;
  translations?: readonly Translation[];
  provenance?: readonly Provenance[];
  annotations?: readonly Annotation[];
  exports?: readonly ExportRecord[];
  /** OCR engine recorded on `ocr` provenance rows. */
  ocrEngine?: string | null;
  /** Model identity recorded on every provenance row. */
  model?: string | null;
}

/** Builds the four corners of a rect in the page coordinate space. */
export function rectPolygon(rect: Rect): Polygon {
  const x = finiteOr(rect.x, 0);
  const y = finiteOr(rect.y, 0);
  const right = x + Math.max(0, finiteOr(rect.width, 0));
  const bottom = y + Math.max(0, finiteOr(rect.height, 0));
  return [
    { x, y },
    { x: right, y },
    { x: right, y: bottom },
    { x, y: bottom },
  ];
}

/**
 * Turns the reader's current block list into a document.
 *
 * Reading order is row-major: page ascending, then the top edge with a 0.5 pt row
 * bucket so sub-point OCR noise does not reorder a line, then the left edge, then the
 * reader block id, then input index. Ids are `p{page}-r{rank}` where the rank is the
 * position within that page, so they match the reader's existing block ids and do not
 * depend on the order the caller happened to pass blocks in.
 */
export function buildDocument(items: BuildDocumentInput): DocumentIR {
  if (typeof items !== 'object' || items === null || !Array.isArray(items.blocks)) {
    throw new IrError('malformed-document', 'buildDocument needs an object with a blocks array.');
  }
  const documentLanguage = nonEmpty(items.language) ?? 'und';
  const sourceSha256 = typeof items.sourceSha256 === 'string' ? items.sourceSha256 : '';
  const rows = items.blocks.map((block, index) => toWorkingRow(block, index, documentLanguage));
  rows.sort(compareRows);

  const pages = orderedPages(items.pages, rows);
  const ocrEngine = items.ocrEngine ?? null;
  const model = items.model ?? null;

  const blocks: Block[] = [];
  const generated: Provenance[] = [];
  const rankByPage = new Map<number, number>();
  rows.forEach((row, readingOrder) => {
    const rank = rankByPage.get(row.page) ?? 0;
    rankByPage.set(row.page, rank + 1);
    const id = `p${row.page}-r${rank}`;
    blocks.push({
      id,
      type: row.type,
      page: row.page,
      polygon: row.polygon,
      readingOrder,
      raw: row.raw,
      language: row.language,
      confidence: row.confidence,
      children: row.children,
    });
    generated.push({
      blockId: id,
      sourceBlockIds: [],
      ocrEngine: row.origin === 'ocr' ? ocrEngine : null,
      model,
      transform: row.origin,
    });
  });

  // Extraction rows first, then the caller's rows: one row per block and transform,
  // so a caller row replaces the generated one instead of duplicating it.
  const provenance = new Map<string, Provenance>();
  for (const row of generated) provenance.set(provenanceKey(row), row);
  for (const row of items.provenance ?? []) provenance.set(provenanceKey(row), row);

  return {
    schemaVersion: DOCUMENT_IR_SCHEMA_VERSION,
    documentId: nonEmpty(items.documentId) ?? `doc-${sourceSha256.slice(0, 16)}`,
    revisionId: nonEmpty(items.revisionId) ?? 'rev-1',
    sourceSha256,
    language: documentLanguage,
    pages,
    blocks,
    translations: [...(items.translations ?? [])],
    provenance: [...provenance.values()],
    annotations: [...(items.annotations ?? [])],
    exports: [...(items.exports ?? [])],
  };
}

/**
 * Adds or replaces a translation. An entry is the same translation when block, target
 * language and engine match; a different engine is a separate entry so two engines can
 * be compared on one block. The returned document is a copy: `sourceSha256`, the
 * document id, the revision id and every block are shared, not rewritten.
 */
export function addTranslation(ir: DocumentIR, translation: Translation): DocumentIR {
  const index = ir.translations.findIndex(
    entry => entry.blockId === translation.blockId && entry.lang === translation.lang && entry.engine === translation.engine,
  );
  const translations = index === -1 ? [...ir.translations, translation] : ir.translations.map((entry, at) => (at === index ? translation : entry));
  return { ...ir, translations };
}

/**
 * Adds or replaces a provenance row. Rows are unique per block and transform, so a
 * block keeps its extraction row when a later stage adds a translation row.
 */
export function addProvenance(ir: DocumentIR, provenance: Provenance): DocumentIR {
  const index = ir.provenance.findIndex(entry => provenanceKey(entry) === provenanceKey(provenance));
  const rows = index === -1 ? [...ir.provenance, provenance] : ir.provenance.map((entry, at) => (at === index ? provenance : entry));
  return { ...ir, provenance: rows };
}

function provenanceKey(row: Provenance): string {
  return `${row.blockId}\u0000${row.transform}`;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Returns every concrete problem found in a document, in a fixed order: version,
 * source hash, pages, blocks, translations, provenance. An empty list means the
 * document is internally consistent; it is not a claim about translation quality.
 */
export function validate(ir: DocumentIR): IrProblem[] {
  if (!ir || typeof ir !== 'object') {
    return [{ code: 'malformed-document', path: '', message: 'validate needs a Document IR object.' }];
  }
  const problems: IrProblem[] = [];

  if (ir.schemaVersion !== DOCUMENT_IR_SCHEMA_VERSION) {
    problems.push({
      code: 'unsupported-schema-version',
      path: 'schemaVersion',
      message: `schemaVersion ${String(ir.schemaVersion)} is not supported; this build reads version ${DOCUMENT_IR_SCHEMA_VERSION}.`,
    });
  }

  if (typeof ir.sourceSha256 !== 'string' || !SHA256_PATTERN.test(ir.sourceSha256)) {
    problems.push({
      code: 'invalid-source-sha256',
      path: 'sourceSha256',
      message: 'sourceSha256 must be the hex SHA-256 of the original PDF bytes.',
    });
  }

  const pages = Array.isArray(ir.pages) ? ir.pages : [];
  const blocks = Array.isArray(ir.blocks) ? ir.blocks : [];
  const translations = Array.isArray(ir.translations) ? ir.translations : [];
  const provenance = Array.isArray(ir.provenance) ? ir.provenance : [];

  const pageByIndex = new Map<number, Page>();
  pages.forEach((page, index) => {
    const path = `pages[${index}]`;
    if (pageByIndex.has(page.index)) {
      problems.push({ code: 'duplicate-id', path: `${path}.index`, message: `page index ${page.index} appears more than once.` });
    } else {
      pageByIndex.set(page.index, page);
    }
  });

  const blockIds = new Set<string>();
  blocks.forEach((block, index) => {
    if (blockIds.has(block.id)) {
      problems.push({ code: 'duplicate-id', path: `blocks[${index}].id`, message: `block id ${block.id} appears more than once.` });
    } else {
      blockIds.add(block.id);
    }
  });

  blocks.forEach((block, index) => {
    const path = `blocks[${index}]`;
    const page = pageByIndex.get(block.page);
    if (!page) {
      problems.push({ code: 'block-page-unknown', path: `${path}.page`, message: `block ${block.id} points at page ${String(block.page)}, which is not in pages.` });
      return;
    }

    const polygon = Array.isArray(block.polygon) ? block.polygon : [];
    if (polygon.length !== 4) {
      problems.push({ code: 'polygon-invalid', path: `${path}.polygon`, message: `block ${block.id} needs exactly 4 polygon points, found ${polygon.length}.` });
      return;
    }
    polygon.forEach((point, corner) => {
      const pointPath = `${path}.polygon[${corner}]`;
      if (typeof point !== 'object' || point === null || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        problems.push({ code: 'polygon-invalid', path: pointPath, message: `block ${block.id} has a polygon point without finite x and y.` });
        return;
      }
      const outside = point.x < -POLYGON_BOUNDS_TOLERANCE
        || point.y < -POLYGON_BOUNDS_TOLERANCE
        || point.x > page.width + POLYGON_BOUNDS_TOLERANCE
        || point.y > page.height + POLYGON_BOUNDS_TOLERANCE;
      if (outside) {
        problems.push({
          code: 'polygon-out-of-bounds',
          path: pointPath,
          message: `block ${block.id} has a corner at (${point.x}, ${point.y}) outside page ${page.index} (${page.width}x${page.height}).`,
        });
      }
    });

    const children = Array.isArray(block.children) ? block.children : [];
    children.forEach((child, position) => {
      if (!blockIds.has(child)) {
        problems.push({ code: 'child-orphan', path: `${path}.children[${position}]`, message: `block ${block.id} lists child ${child}, which is not in blocks.` });
      }
    });
  });

  translations.forEach((translation, index) => {
    if (!blockIds.has(translation.blockId)) {
      problems.push({
        code: 'translation-orphan',
        path: `translations[${index}].blockId`,
        message: `translation for ${translation.blockId} (${translation.lang}) points at a block that is not in blocks.`,
      });
    }
  });

  provenance.forEach((row, index) => {
    if (!blockIds.has(row.blockId)) {
      problems.push({ code: 'provenance-orphan', path: `provenance[${index}].blockId`, message: `provenance points at block ${row.blockId}, which is not in blocks.` });
    }
    const sources = Array.isArray(row.sourceBlockIds) ? row.sourceBlockIds : [];
    sources.forEach((source, position) => {
      if (!blockIds.has(source)) {
        problems.push({ code: 'provenance-orphan', path: `provenance[${index}].sourceBlockIds[${position}]`, message: `provenance for ${row.blockId} cites source block ${source}, which is not in blocks.` });
      }
    });
  });

  return problems;
}

/**
 * Writes a document as canonical JSON: documented fields only, always in the same key
 * order, no whitespace. Two equal documents always produce the same string, so exports
 * and tests can compare bytes instead of deep structures.
 */
export function serialize(ir: DocumentIR): string {
  if (ir.schemaVersion !== DOCUMENT_IR_SCHEMA_VERSION) {
    throw new IrError(
      'unsupported-version',
      `Document IR schema version ${String(ir.schemaVersion)} cannot be written; this build writes version ${DOCUMENT_IR_SCHEMA_VERSION}.`,
    );
  }
  return JSON.stringify(canonicalDocument(ir));
}

/**
 * Reads canonical JSON back into a document. An unknown schema version is refused with
 * an `IrError` whose code is `unsupported-version`; a value that is not the documented
 * v1 shape is refused with `malformed-document`. Structural rules are not checked here:
 * call `validate` after reading a document from an untrusted source.
 */
export function deserialize(json: string): DocumentIR {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new IrError('malformed-json', `Document IR JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return readDocument(parsed);
}

interface WorkingRow {
  sourceIndex: number;
  sourceId: string;
  page: number;
  rowKey: number;
  left: number;
  polygon: Polygon;
  raw: string;
  type: BlockType;
  language: string;
  confidence: number;
  origin: TransformKind;
  children: string[];
}

function toWorkingRow(block: BuildBlockInput, sourceIndex: number, documentLanguage: string): WorkingRow {
  if (typeof block !== 'object' || block === null) {
    throw new IrError('malformed-document', `blocks[${sourceIndex}] must be an object.`);
  }
  const page = Number.isInteger(block.page) && block.page > 0 ? block.page : 1;
  const polygon = readBlockPolygon(block, sourceIndex);
  const bounds = polygonBounds(polygon);
  return {
    sourceIndex,
    sourceId: typeof block.id === 'string' ? block.id : '',
    page,
    rowKey: Math.round(bounds.minY * 2) / 2,
    left: bounds.minX,
    polygon,
    raw: typeof block.text === 'string' ? block.text : '',
    type: isBlockType(block.type) ? block.type : 'other',
    language: nonEmpty(block.language) ?? documentLanguage,
    confidence: confidenceOf(block.confidence),
    origin: isTransform(block.origin) ? block.origin : 'pdf-text',
    children: Array.isArray(block.children) ? block.children.filter((child): child is string => typeof child === 'string') : [],
  };
}

function readBlockPolygon(block: BuildBlockInput, sourceIndex: number): Polygon {
  if (Array.isArray(block.polygon)) {
    if (block.polygon.length !== 4) {
      throw new IrError('malformed-document', `blocks[${sourceIndex}].polygon must have exactly 4 points.`);
    }
    const [first, second, third, fourth] = block.polygon;
    return [toPoint(first), toPoint(second), toPoint(third), toPoint(fourth)];
  }
  if (block.rect) return rectPolygon(block.rect);
  throw new IrError('malformed-document', `blocks[${sourceIndex}] needs a rect or a 4-point polygon.`);
}

function toPoint(point: Point | undefined): Point {
  return { x: finiteOr(point?.x, 0), y: finiteOr(point?.y, 0) };
}

function compareRows(left: WorkingRow, right: WorkingRow): number {
  if (left.page !== right.page) return left.page - right.page;
  if (left.rowKey !== right.rowKey) return left.rowKey - right.rowKey;
  if (left.left !== right.left) return left.left - right.left;
  if (left.sourceId !== right.sourceId) return left.sourceId < right.sourceId ? -1 : 1;
  return left.sourceIndex - right.sourceIndex;
}

function orderedPages(input: readonly BuildPageInput[] | undefined, rows: readonly WorkingRow[]): Page[] {
  const pages = new Map<number, Page>();
  for (const page of input ?? []) {
    if (!page || !Number.isInteger(page.index) || page.index < 1) continue;
    pages.set(page.index, {
      index: page.index,
      width: positiveOr(page.width, 1),
      height: positiveOr(page.height, 1),
      rotation: isRotation(page.rotation) ? page.rotation : 0,
    });
  }
  // A page the caller did not describe is sized to the union of its blocks, not to
  // the first one: a later, wider block would otherwise fall outside its own page.
  const derived = new Map<number, Bounds>();
  for (const row of rows) {
    if (pages.has(row.page)) continue;
    const bounds = polygonBounds(row.polygon);
    const previous = derived.get(row.page);
    derived.set(
      row.page,
      previous
        ? {
            minX: Math.min(previous.minX, bounds.minX),
            minY: Math.min(previous.minY, bounds.minY),
            maxX: Math.max(previous.maxX, bounds.maxX),
            maxY: Math.max(previous.maxY, bounds.maxY),
          }
        : bounds,
    );
  }
  for (const [index, bounds] of derived) {
    pages.set(index, {
      index,
      width: Math.max(1, Math.ceil(bounds.maxX)),
      height: Math.max(1, Math.ceil(bounds.maxY)),
      rotation: 0,
    });
  }
  return [...pages.values()].sort((left, right) => left.index - right.index);
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function polygonBounds(polygon: readonly Point[]): Bounds {
  const xs = polygon.map(point => point.x);
  const ys = polygon.map(point => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function canonicalDocument(ir: DocumentIR): Record<string, unknown> {
  return {
    schemaVersion: DOCUMENT_IR_SCHEMA_VERSION,
    documentId: ir.documentId,
    revisionId: ir.revisionId,
    sourceSha256: ir.sourceSha256,
    language: ir.language,
    pages: ir.pages.map(page => ({
      index: page.index,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
    })),
    blocks: ir.blocks.map(block => ({
      id: block.id,
      type: block.type,
      page: block.page,
      polygon: block.polygon.map(point => ({ x: point.x, y: point.y })),
      readingOrder: block.readingOrder,
      raw: block.raw,
      language: block.language,
      confidence: block.confidence,
      children: [...block.children],
    })),
    translations: ir.translations.map(translation => ({
      blockId: translation.blockId,
      lang: translation.lang,
      engine: translation.engine,
      modelVersion: translation.modelVersion,
      promptVersion: translation.promptVersion,
      text: translation.text,
      qaStatus: translation.qaStatus,
    })),
    provenance: ir.provenance.map(row => ({
      blockId: row.blockId,
      sourceBlockIds: [...row.sourceBlockIds],
      ocrEngine: row.ocrEngine,
      model: row.model,
      transform: row.transform,
    })),
    annotations: ir.annotations.map(annotation => ({
      id: annotation.id,
      page: annotation.page,
      kind: annotation.kind,
      text: annotation.text,
      createdAt: annotation.createdAt,
    })),
    exports: ir.exports.map(entry => ({
      id: entry.id,
      format: entry.format,
      createdAt: entry.createdAt,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
    })),
  };
}

function readDocument(value: unknown): DocumentIR {
  const record = readObject(value, 'document');
  const version = readInteger(record.schemaVersion, 'schemaVersion');
  if (version !== DOCUMENT_IR_SCHEMA_VERSION) {
    throw new IrError(
      'unsupported-version',
      `Document IR schema version ${version} is not supported; this build reads version ${DOCUMENT_IR_SCHEMA_VERSION}.`,
    );
  }
  return {
    schemaVersion: DOCUMENT_IR_SCHEMA_VERSION,
    documentId: readString(record.documentId, 'documentId'),
    revisionId: readString(record.revisionId, 'revisionId'),
    sourceSha256: readString(record.sourceSha256, 'sourceSha256'),
    language: readString(record.language, 'language'),
    pages: readArray(record.pages, 'pages').map(readPage),
    blocks: readArray(record.blocks, 'blocks').map(readBlock),
    translations: readArray(record.translations, 'translations').map(readTranslation),
    provenance: readArray(record.provenance, 'provenance').map(readProvenance),
    annotations: readArray(record.annotations, 'annotations').map(readAnnotation),
    exports: readArray(record.exports, 'exports').map(readExportRecord),
  };
}

function readPage(value: unknown, index: number): Page {
  const path = `pages[${index}]`;
  const record = readObject(value, path);
  return {
    index: readInteger(record.index, `${path}.index`),
    width: readNumber(record.width, `${path}.width`),
    height: readNumber(record.height, `${path}.height`),
    rotation: readRotation(record.rotation, `${path}.rotation`),
  };
}

function readRotation(value: unknown, path: string): PageRotation {
  const number = readNumber(value, path);
  if (!isRotation(number)) fail(path, 'must be one of 0 | 90 | 180 | 270.');
  return number;
}

function readBlock(value: unknown, index: number): Block {
  const path = `blocks[${index}]`;
  const record = readObject(value, path);
  const polygon = readArray(record.polygon, `${path}.polygon`);
  if (polygon.length !== 4) {
    throw new IrError('malformed-document', `${path}.polygon: must have exactly 4 points, found ${polygon.length}.`);
  }
  const [first, second, third, fourth] = polygon;
  return {
    id: readString(record.id, `${path}.id`),
    type: readEnum(record.type, `${path}.type`, BLOCK_TYPES),
    page: readInteger(record.page, `${path}.page`),
    polygon: [
      readPoint(first, `${path}.polygon[0]`),
      readPoint(second, `${path}.polygon[1]`),
      readPoint(third, `${path}.polygon[2]`),
      readPoint(fourth, `${path}.polygon[3]`),
    ],
    readingOrder: readInteger(record.readingOrder, `${path}.readingOrder`),
    raw: readString(record.raw, `${path}.raw`),
    language: readString(record.language, `${path}.language`),
    confidence: readNumber(record.confidence, `${path}.confidence`),
    children: readStringArray(record.children, `${path}.children`),
  };
}

function readPoint(value: unknown, path: string): Point {
  const record = readObject(value, path);
  return { x: readNumber(record.x, `${path}.x`), y: readNumber(record.y, `${path}.y`) };
}

function readTranslation(value: unknown, index: number): Translation {
  const path = `translations[${index}]`;
  const record = readObject(value, path);
  return {
    blockId: readString(record.blockId, `${path}.blockId`),
    lang: readString(record.lang, `${path}.lang`),
    engine: readString(record.engine, `${path}.engine`),
    modelVersion: readString(record.modelVersion, `${path}.modelVersion`),
    promptVersion: readString(record.promptVersion, `${path}.promptVersion`),
    text: readString(record.text, `${path}.text`),
    qaStatus: readEnum(record.qaStatus, `${path}.qaStatus`, QA_STATUSES),
  };
}

function readProvenance(value: unknown, index: number): Provenance {
  const path = `provenance[${index}]`;
  const record = readObject(value, path);
  return {
    blockId: readString(record.blockId, `${path}.blockId`),
    sourceBlockIds: readStringArray(record.sourceBlockIds, `${path}.sourceBlockIds`),
    ocrEngine: readNullableString(record.ocrEngine, `${path}.ocrEngine`),
    model: readNullableString(record.model, `${path}.model`),
    transform: readEnum(record.transform, `${path}.transform`, TRANSFORMS),
  };
}

function readAnnotation(value: unknown, index: number): Annotation {
  const path = `annotations[${index}]`;
  const record = readObject(value, path);
  return {
    id: readString(record.id, `${path}.id`),
    page: readInteger(record.page, `${path}.page`),
    kind: readEnum(record.kind, `${path}.kind`, ANNOTATION_KINDS),
    text: readString(record.text, `${path}.text`),
    createdAt: readString(record.createdAt, `${path}.createdAt`),
  };
}

function readExportRecord(value: unknown, index: number): ExportRecord {
  const path = `exports[${index}]`;
  const record = readObject(value, path);
  return {
    id: readString(record.id, `${path}.id`),
    format: readEnum(record.format, `${path}.format`, EXPORT_FORMATS),
    createdAt: readString(record.createdAt, `${path}.createdAt`),
    byteLength: readNumber(record.byteLength, `${path}.byteLength`),
    sha256: readString(record.sha256, `${path}.sha256`),
  };
}

function fail(path: string, message: string): never {
  throw new IrError('malformed-document', `${path || 'document'}: ${message}`);
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be a JSON object.');
  return value as Record<string, unknown>;
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array.');
  return value;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a string.');
  return value;
}

function readNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return readString(value, path);
}

function readNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number.');
  return value;
}

function readInteger(value: unknown, path: string): number {
  const number = readNumber(value, path);
  if (!Number.isInteger(number)) fail(path, 'must be an integer.');
  return number;
}

function readStringArray(value: unknown, path: string): string[] {
  return readArray(value, path).map((item, index) => readString(item, `${path}[${index}]`));
}

function readEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const text = readString(value, path);
  if (!(allowed as readonly string[]).includes(text)) fail(path, `must be one of ${allowed.join(' | ')}.`);
  return text as T;
}

function isBlockType(value: unknown): value is BlockType {
  return typeof value === 'string' && (BLOCK_TYPES as readonly string[]).includes(value);
}

function isTransform(value: unknown): value is TransformKind {
  return typeof value === 'string' && (TRANSFORMS as readonly string[]).includes(value);
}

function isRotation(value: unknown): value is PageRotation {
  return typeof value === 'number' && (PAGE_ROTATIONS as readonly number[]).includes(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function confidenceOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
