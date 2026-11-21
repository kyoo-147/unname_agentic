/**
 * Deterministic document-intelligence runtime seam.
 *
 * This module is deliberately an ingestion and storage boundary, not an OCR
 * engine. It accepts the PDF layer's extracted page models, records the source
 * bytes by hash, and exposes immutable IR revisions to OCR, RAG and automation
 * callers. No text or model result is invented here.
 */

import {
  buildDocument,
  deserialize,
  serialize,
  validate,
  type DocumentIR,
  type IrProblem,
} from './ir';
import {
  classifyPage,
  type ClassifyImage,
  type ClassifyReason,
  type PageStats,
} from './classify';
import { sha256Hex } from './ocr-corrections';
import type { PageModel, Rect, TextBlock } from './types';

/** Version of the runtime envelope, separate from the nested Document IR version. */
export const DOCUMENT_RUNTIME_SCHEMA_VERSION = 1;

export type RuntimePageKind = 'born-digital' | 'scanned' | 'hybrid';

export interface RuntimePageClassification {
  page: number;
  kind: RuntimePageKind;
  reasons: readonly ClassifyReason[];
  stats: PageStats;
}

/** Optional PDF evidence used to distinguish pixels from an embedded text layer. */
export interface RuntimePageEvidence {
  page: number;
  images?: readonly ClassifyImage[];
  glyphCount?: number;
}

export interface IngestDocumentInput {
  pages: readonly PageModel[];
  sourceBytes: Uint8Array;
  /** When supplied, the bytes must hash to this value. */
  expectedSha256?: string;
  documentId?: string;
  revisionId?: string;
  language?: string;
  pageEvidence?: readonly RuntimePageEvidence[];
}

/** Canonical, JSON-safe runtime envelope around one DocumentIR revision. */
export interface RuntimeDocument {
  runtimeSchemaVersion: number;
  ir: DocumentIR;
  pageClassifications: readonly RuntimePageClassification[];
  source: {
    sha256: string;
    byteLength: number;
  };
}

export type RuntimeProblemCode =
  | 'malformed-runtime'
  | 'unsupported-runtime-version'
  | 'source-hash-mismatch'
  | 'source-metadata-mismatch'
  | 'page-classification-mismatch'
  | IrProblem['code'];

export interface RuntimeProblem {
  code: RuntimeProblemCode;
  path: string;
  message: string;
}

export type DocumentRuntimeErrorCode =
  | 'invalid-input'
  | 'source-hash-mismatch'
  | 'malformed-json'
  | 'unsupported-version'
  | 'malformed-runtime'
  | 'revision-conflict';

export class DocumentRuntimeError extends Error {
  readonly code: DocumentRuntimeErrorCode;
  readonly path?: string;

  constructor(code: DocumentRuntimeErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'DocumentRuntimeError';
    this.code = code;
    this.path = path;
  }
}

/**
 * Builds a runtime document from PDF page models and the original source bytes.
 *
 * Page models are treated as extracted PDF text (`pdf-text`). A scanned or hybrid
 * decision is only made when raster evidence is supplied through `pageEvidence`;
 * an empty text layer alone is not promoted to fabricated OCR output.
 */
export function ingestDocument(input: IngestDocumentInput): RuntimeDocument {
  validateIngestInput(input);
  const sourceSha256 = sha256Hex(input.sourceBytes);
  const expectedSha256 = input.expectedSha256?.toLowerCase();
  if (expectedSha256 !== undefined && expectedSha256 !== sourceSha256) {
    throw new DocumentRuntimeError(
      'source-hash-mismatch',
      `source bytes hash to ${sourceSha256}, not expected ${input.expectedSha256}.`,
      'expectedSha256',
    );
  }

  const evidenceByPage = evidenceMap(input.pageEvidence ?? [], input.pages);
  const ir = buildDocument({
    blocks: input.pages.flatMap(page => page.blocks.map(toBuildBlock)),
    pages: input.pages.map(page => ({
      index: page.number,
      width: page.width,
      height: page.height,
      rotation: 0,
    })),
    sourceSha256,
    documentId: input.documentId,
    revisionId: input.revisionId,
    language: input.language,
  });

  const pageClassifications = input.pages
    .map(page => classifyRuntimePage(page, evidenceByPage.get(page.number)))
    .sort((left, right) => left.page - right.page);

  const runtime: RuntimeDocument = {
    runtimeSchemaVersion: DOCUMENT_RUNTIME_SCHEMA_VERSION,
    ir,
    pageClassifications,
    source: { sha256: sourceSha256, byteLength: input.sourceBytes.byteLength },
  };
  assertValidRuntime(runtime);
  return freezeRuntime(runtime);
}

/** Returns the actual SHA-256 of bytes without retaining the bytes. */
export function sourceSha256(sourceBytes: Uint8Array): string {
  if (!(sourceBytes instanceof Uint8Array)) {
    throw new DocumentRuntimeError('invalid-input', 'sourceBytes must be a Uint8Array.', 'sourceBytes');
  }
  return sha256Hex(sourceBytes);
}

/** Returns structural problems without throwing. An empty list means valid. */
export function validateRuntimeDocument(runtime: RuntimeDocument): RuntimeProblem[] {
  if (!runtime || typeof runtime !== 'object') {
    return [{ code: 'malformed-runtime', path: '', message: 'runtime document must be an object.' }];
  }
  const problems: RuntimeProblem[] = [];
  if (runtime.runtimeSchemaVersion !== DOCUMENT_RUNTIME_SCHEMA_VERSION) {
    problems.push({
      code: 'unsupported-runtime-version',
      path: 'runtimeSchemaVersion',
      message: `runtime schema version ${String(runtime.runtimeSchemaVersion)} is not supported; this build reads version ${DOCUMENT_RUNTIME_SCHEMA_VERSION}.`,
    });
  }

  const ir = runtime.ir;
  for (const problem of validate(ir)) problems.push(problem);

  if (!runtime.source || typeof runtime.source !== 'object') {
    problems.push({ code: 'source-metadata-mismatch', path: 'source', message: 'source metadata is required.' });
  } else {
    if (runtime.source.sha256 !== ir?.sourceSha256) {
      problems.push({
        code: 'source-metadata-mismatch',
        path: 'source.sha256',
        message: 'source.sha256 must equal ir.sourceSha256.',
      });
    }
    if (!Number.isInteger(runtime.source.byteLength) || runtime.source.byteLength < 0) {
      problems.push({
        code: 'source-metadata-mismatch',
        path: 'source.byteLength',
        message: 'source.byteLength must be a non-negative integer.',
      });
    }
  }

  const classifications = Array.isArray(runtime.pageClassifications) ? runtime.pageClassifications : [];
  const pages = Array.isArray(ir?.pages) ? ir.pages : [];
  if (classifications.length !== pages.length) {
    problems.push({
      code: 'page-classification-mismatch',
      path: 'pageClassifications',
      message: 'one page classification is required for every IR page.',
    });
  }
  const pageIndexes = new Set(pages.map(page => page.index));
  const seen = new Set<number>();
  classifications.forEach((classification, index) => {
    const path = `pageClassifications[${index}]`;
    if (!classification || typeof classification !== 'object' || !Number.isInteger(classification.page)) {
      problems.push({ code: 'page-classification-mismatch', path, message: 'classification needs an integer page.' });
      return;
    }
    if (!pageIndexes.has(classification.page)) {
      problems.push({ code: 'page-classification-mismatch', path: `${path}.page`, message: `page ${classification.page} is not present in ir.pages.` });
    }
    if (seen.has(classification.page)) {
      problems.push({ code: 'page-classification-mismatch', path: `${path}.page`, message: `page ${classification.page} is classified more than once.` });
    }
    seen.add(classification.page);
    if (!['born-digital', 'scanned', 'hybrid'].includes(classification.kind)) {
      problems.push({ code: 'page-classification-mismatch', path: `${path}.kind`, message: `unsupported page kind ${String(classification.kind)}.` });
    }
  });

  return problems;
}

/** Writes the runtime envelope in a stable, compact JSON form. */
export function serializeRuntimeDocument(runtime: RuntimeDocument): string {
  assertValidRuntime(runtime);
  return JSON.stringify({
    runtimeSchemaVersion: DOCUMENT_RUNTIME_SCHEMA_VERSION,
    source: {
      sha256: runtime.source.sha256,
      byteLength: runtime.source.byteLength,
    },
    ir: JSON.parse(serialize(runtime.ir)) as Record<string, unknown>,
    pageClassifications: runtime.pageClassifications.map(classification => ({
      page: classification.page,
      kind: classification.kind,
      reasons: [...classification.reasons],
      stats: {
        textItemCount: classification.stats.textItemCount,
        glyphCount: classification.stats.glyphCount,
        textCoverage: classification.stats.textCoverage,
        imageCount: classification.stats.imageCount,
        largestImageRatio: classification.stats.largestImageRatio,
      },
    })),
  });
}

/** Reads, validates and freezes a canonical runtime JSON envelope. */
export function deserializeRuntimeDocument(json: string): RuntimeDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new DocumentRuntimeError(
      'malformed-json',
      `Document runtime JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new DocumentRuntimeError('malformed-runtime', 'Document runtime JSON must contain an object.');
  }
  if (parsed.runtimeSchemaVersion !== DOCUMENT_RUNTIME_SCHEMA_VERSION) {
    throw new DocumentRuntimeError(
      'unsupported-version',
      `runtime schema version ${String(parsed.runtimeSchemaVersion)} is not supported; this build reads version ${DOCUMENT_RUNTIME_SCHEMA_VERSION}.`,
      'runtimeSchemaVersion',
    );
  }

  let ir: DocumentIR;
  try {
    ir = deserialize(JSON.stringify(parsed.ir));
  } catch (error) {
    throw new DocumentRuntimeError(
      'malformed-runtime',
      `nested Document IR could not be read: ${error instanceof Error ? error.message : String(error)}`,
      'ir',
    );
  }
  const runtime: RuntimeDocument = {
    runtimeSchemaVersion: DOCUMENT_RUNTIME_SCHEMA_VERSION,
    ir,
    pageClassifications: readClassifications(parsed.pageClassifications),
    source: readSource(parsed.source),
  };
  assertValidRuntime(runtime);
  return freezeRuntime(runtime);
}

export interface RevisionRef {
  documentId: string;
  revisionId: string;
}

/**
 * Persistent-by-value revision store. `put` returns a new store; an existing
 * store and every document returned from it remain unchanged and deeply frozen.
 */
export class ImmutableRevisionStore {
  private constructor(
    private readonly revisionsByDocument: ReadonlyMap<string, ReadonlyMap<string, RuntimeDocument>>,
    private readonly latestByDocument: ReadonlyMap<string, string>,
  ) {}

  static empty(): ImmutableRevisionStore {
    return new ImmutableRevisionStore(new Map(), new Map());
  }

  put(runtime: RuntimeDocument): ImmutableRevisionStore {
    assertValidRuntime(runtime);
    const documentId = runtime.ir.documentId;
    const revisionId = runtime.ir.revisionId;
    const existing = this.revisionsByDocument.get(documentId)?.get(revisionId);
    if (existing) {
      if (serializeRuntimeDocument(existing) === serializeRuntimeDocument(runtime)) return this;
      throw new DocumentRuntimeError(
        'revision-conflict',
        `revision ${documentId}/${revisionId} already exists with different content.`,
      );
    }

    const revisions = new Map(this.revisionsByDocument);
    const documentRevisions = new Map(revisions.get(documentId) ?? []);
    documentRevisions.set(revisionId, freezeRuntime(runtime));
    revisions.set(documentId, documentRevisions);
    const latest = new Map(this.latestByDocument);
    latest.set(documentId, revisionId);
    return new ImmutableRevisionStore(revisions, latest);
  }

  get(documentId: string, revisionId: string): RuntimeDocument | undefined {
    return this.revisionsByDocument.get(documentId)?.get(revisionId);
  }

  /** Alias for callers that use the store as a read-only document repository. */
  read(documentId: string, revisionId: string): RuntimeDocument | undefined {
    return this.get(documentId, revisionId);
  }

  latest(documentId: string): RuntimeDocument | undefined {
    const revisionId = this.latestByDocument.get(documentId);
    return revisionId === undefined ? undefined : this.get(documentId, revisionId);
  }

  revisions(documentId: string): readonly RevisionRef[] {
    const revisions = this.revisionsByDocument.get(documentId);
    if (!revisions) return [];
    return Object.freeze([...revisions.keys()].map(revisionId => Object.freeze({ documentId, revisionId })));
  }
}

export function createRevisionStore(): ImmutableRevisionStore {
  return ImmutableRevisionStore.empty();
}

function validateIngestInput(input: IngestDocumentInput): void {
  if (!input || typeof input !== 'object') {
    throw new DocumentRuntimeError('invalid-input', 'ingestDocument needs an input object.');
  }
  if (!(input.sourceBytes instanceof Uint8Array)) {
    throw new DocumentRuntimeError('invalid-input', 'sourceBytes must be a Uint8Array.', 'sourceBytes');
  }
  if (input.pages.length === 0) {
    throw new DocumentRuntimeError('invalid-input', 'pages must be a non-empty array.', 'pages');
  }
  if (input.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/iu.test(input.expectedSha256)) {
    throw new DocumentRuntimeError('invalid-input', 'expectedSha256 must be a 64-character hexadecimal SHA-256.', 'expectedSha256');
  }

  const pageNumbers = new Set<number>();
  input.pages.forEach((page, index) => {
    const path = `pages[${index}]`;
    if (!page || typeof page !== 'object') throw new DocumentRuntimeError('invalid-input', `${path} must be an object.`, path);
    if (!Number.isInteger(page.number) || page.number < 1) throw new DocumentRuntimeError('invalid-input', `${path}.number must be a positive integer.`, `${path}.number`);
    if (pageNumbers.has(page.number)) throw new DocumentRuntimeError('invalid-input', `duplicate page number ${page.number}.`, `${path}.number`);
    pageNumbers.add(page.number);
    if (!positiveFinite(page.width) || !positiveFinite(page.height)) {
      throw new DocumentRuntimeError('invalid-input', `${path} width and height must be positive finite numbers.`, path);
    }
    if (!page.blocks) throw new DocumentRuntimeError('invalid-input', `${path}.blocks must be an array.`, `${path}.blocks`);
    page.blocks.forEach((block, blockIndex) => validateTextBlock(block, `${path}.blocks[${blockIndex}]`, page.number));
  });
}

function validateTextBlock(block: TextBlock, path: string, pageNumber: number): void {
  if (!block || typeof block !== 'object') throw new DocumentRuntimeError('invalid-input', `${path} must be an object.`, path);
  if (block.page !== pageNumber) throw new DocumentRuntimeError('invalid-input', `${path}.page must match its PageModel page.`, `${path}.page`);
  if (typeof block.text !== 'string') throw new DocumentRuntimeError('invalid-input', `${path}.text must be a string.`, `${path}.text`);
  if (!block.rect || !finiteRect(block.rect) || block.rect.width < 0 || block.rect.height < 0) {
    throw new DocumentRuntimeError('invalid-input', `${path}.rect must contain finite coordinates and non-negative dimensions.`, `${path}.rect`);
  }
}

function evidenceMap(evidence: readonly RuntimePageEvidence[], pages: readonly PageModel[]): Map<number, RuntimePageEvidence> {
  const pageNumbers = new Set(pages.map(page => page.number));
  const result = new Map<number, RuntimePageEvidence>();
  evidence.forEach((entry, index) => {
    const path = `pageEvidence[${index}]`;
    if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.page) || !pageNumbers.has(entry.page)) {
      throw new DocumentRuntimeError('invalid-input', `${path}.page must name an ingested page.`, `${path}.page`);
    }
    if (result.has(entry.page)) throw new DocumentRuntimeError('invalid-input', `duplicate evidence for page ${entry.page}.`, `${path}.page`);
    const glyphCount = entry.glyphCount ?? 0;
    if (!Number.isInteger(glyphCount) || glyphCount < 0) throw new DocumentRuntimeError('invalid-input', `${path}.glyphCount must be a non-negative integer.`, `${path}.glyphCount`);
    const images = entry.images ?? [];
    if (!Array.isArray(images)) throw new DocumentRuntimeError('invalid-input', `${path}.images must be an array.`, `${path}.images`);
    images.forEach((image, imageIndex) => {
      if (!image || typeof image !== 'object' || !finiteRect(image.rect) || image.rect.width < 0 || image.rect.height < 0) {
        throw new DocumentRuntimeError('invalid-input', `${path}.images[${imageIndex}].rect is invalid.`, `${path}.images[${imageIndex}].rect`);
      }
    });
    result.set(entry.page, { page: entry.page, images: [...images], glyphCount });
  });
  return result;
}

function classifyRuntimePage(page: PageModel, evidence: RuntimePageEvidence | undefined): RuntimePageClassification {
  const classification = classifyPage({
    textItems: page.blocks.map(block => ({ text: block.text, rect: block.rect })),
    images: evidence?.images ?? [],
    pageArea: page.width * page.height,
    glyphCount: evidence?.glyphCount ?? page.blocks.reduce((sum, block) => sum + Array.from(block.text).length, 0),
  });
  return {
    page: page.number,
    kind: classification.kind === 'digital' ? 'born-digital' : classification.kind,
    reasons: [...classification.reasons],
    stats: { ...classification.stats },
  };
}

function toBuildBlock(block: TextBlock) {
  return {
    id: block.id,
    page: block.page,
    text: block.text,
    rect: { ...block.rect },
    language: block.direction === 'rtl' ? 'und-rtl' : undefined,
    confidence: 1,
    origin: 'pdf-text' as const,
  };
}

function readSource(value: unknown): { sha256: string; byteLength: number } {
  if (!isRecord(value) || typeof value.sha256 !== 'string' || !Number.isInteger(value.byteLength) || value.byteLength < 0) {
    throw new DocumentRuntimeError('malformed-runtime', 'source must contain sha256 and a non-negative byteLength.', 'source');
  }
  return { sha256: value.sha256, byteLength: value.byteLength };
}

function readClassifications(value: unknown): RuntimePageClassification[] {
  if (!Array.isArray(value)) throw new DocumentRuntimeError('malformed-runtime', 'pageClassifications must be an array.', 'pageClassifications');
  return value.map((entry, index) => {
    const path = `pageClassifications[${index}]`;
    if (!isRecord(entry) || !Number.isInteger(entry.page) || typeof entry.kind !== 'string' || !isRecord(entry.stats) || !Array.isArray(entry.reasons)) {
      throw new DocumentRuntimeError('malformed-runtime', `${path} has an invalid shape.`, path);
    }
    if (!['born-digital', 'scanned', 'hybrid'].includes(entry.kind)) {
      throw new DocumentRuntimeError('malformed-runtime', `${path}.kind is unsupported.`, `${path}.kind`);
    }
    const stats = entry.stats;
    const numericStats = ['textItemCount', 'glyphCount', 'textCoverage', 'imageCount', 'largestImageRatio'];
    if (numericStats.some(key => typeof stats[key] !== 'number' || !Number.isFinite(stats[key]))) {
      throw new DocumentRuntimeError('malformed-runtime', `${path}.stats has invalid numeric fields.`, `${path}.stats`);
    }
    return {
      page: entry.page,
      kind: entry.kind as RuntimePageKind,
      reasons: entry.reasons.map(reason => String(reason)) as ClassifyReason[],
      stats: {
        textItemCount: stats.textItemCount as number,
        glyphCount: stats.glyphCount as number,
        textCoverage: stats.textCoverage as number,
        imageCount: stats.imageCount as number,
        largestImageRatio: stats.largestImageRatio as number,
      },
    };
  });
}

function assertValidRuntime(runtime: RuntimeDocument): void {
  const problems = validateRuntimeDocument(runtime);
  if (problems.length > 0) {
    const first = problems[0]!;
    throw new DocumentRuntimeError('malformed-runtime', first.message, first.path);
  }
}

function freezeRuntime(runtime: RuntimeDocument): RuntimeDocument {
  return deepFreeze(runtime);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Reflect.ownKeys(value as object).forEach(key => {
    const child = (value as Record<PropertyKey, unknown>)[key];
    deepFreeze(child);
  });
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finiteRect(rect: Rect): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height);
}
