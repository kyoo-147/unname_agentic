import { getDocument, OPS, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { diagnose, inspectPdf, type PdfDiagnosis, type PdfInspection } from '../core/pdf-health';
import { ingestDocument, type IngestDocumentInput, type RuntimeDocument } from '../core/document-runtime';
import type { RuntimePageEvidence } from '../core/document-runtime';
import { readMetadata, type DocumentMetadata, type MetadataProblem } from '../core/metadata';
import type { PageModel } from '../core/types';
import { groupTextItems, type PdfTextItem } from '../pdf/layout';

export type PdfImportErrorCode =
  | 'invalid-input'
  | 'malformed-pdf'
  | 'password-required'
  | 'password-invalid'
  | 'pdf-read-failed';

export class PdfImportError extends Error {
  readonly code: PdfImportErrorCode;
  readonly inspection: PdfInspection | null;

  constructor(code: PdfImportErrorCode, message: string, inspection: PdfInspection | null = null, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PdfImportError';
    this.code = code;
    this.inspection = inspection;
  }
}

export interface PdfPageReadResult {
  readonly pages: readonly PageModel[];
  readonly evidence: readonly RuntimePageEvidence[];
  readonly textExtraction: 'text' | 'none';
}

export interface PdfImportOptions {
  readonly password?: string;
  readonly documentId?: string;
  readonly revisionId?: string;
  readonly language?: string;
  readonly standardFontDataUrl?: string;
  readonly signal?: AbortSignal;
}

export interface PdfImportResult {
  readonly runtime: RuntimeDocument;
  readonly metadata: DocumentMetadata;
  readonly health: PdfInspection;
  readonly diagnosis: PdfDiagnosis;
  readonly warnings: readonly string[];
}

export async function importPdfBytes(bytes: Uint8Array, options: PdfImportOptions = {}): Promise<PdfImportResult> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new PdfImportError('invalid-input', 'PDF import requires non-empty Uint8Array bytes.');
  }
  throwIfAborted(options.signal);

  const health = inspectPdf(bytes);
  if (health.encrypted && !options.password) {
    throw new PdfImportError('password-required', 'The PDF is encrypted and requires a password before local extraction.', health);
  }
  if (!health.healthy) {
    const diagnosis = diagnose(health);
    throw new PdfImportError('malformed-pdf', `${diagnosis.recommendation} (${health.problems.map(problem => problem.code).join(', ')}).`, health);
  }

  const metadataReport = readMetadata(bytes);
  let readResult: PdfPageReadResult;
  try {
    readResult = await readPdfPages(bytes, options);
  } catch (error) {
    if (error instanceof PdfImportError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code: PdfImportErrorCode = /password|encrypted/iu.test(message) ? 'password-invalid' : 'pdf-read-failed';
    throw new PdfImportError(code, `PDF.js could not read the local PDF: ${message}`, health, { cause: error });
  }

  const diagnosis = diagnose(health, { textExtraction: readResult.textExtraction });
  const runtime = ingestDocument({
    pages: readResult.pages,
    pageEvidence: readResult.evidence,
    sourceBytes: bytes,
    documentId: options.documentId,
    revisionId: options.revisionId,
    language: options.language ?? metadataReport.metadata.language ?? undefined,
  });

  const warnings = [
    ...metadataReport.problems.map(problem => problem.message),
    ...(diagnosis.action === 'ocr' ? ['The PDF opened locally but has no extractable text; scanned pages require the existing local OCR contract.'] : []),
    ...(readResult.pages.some(page => page.blocks.some(block => block.text.includes('\ufffd')))
      ? ['PDF text extraction contained replacement characters; inspect the source font or encoding before trusting affected blocks.']
      : []),
  ];

  return { runtime, metadata: metadataReport.metadata, health, diagnosis, warnings };
}

export async function readPdfPages(bytes: Uint8Array, options: PdfImportOptions = {}): Promise<PdfPageReadResult> {
  throwIfAborted(options.signal);
  const loadingParameters = {
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    password: options.password,
    ...(options.standardFontDataUrl ? { standardFontDataUrl: options.standardFontDataUrl } : {}),
  };
  const loadingTask = getDocument(loadingParameters);

  let document: PDFDocumentProxy;
  try {
    document = await loadingTask.promise;
  } catch (error) {
    try { await loadingTask.destroy(); } catch { /* preserve the original PDF.js error */ }
    throw error;
  }

  try {
    const pages: PageModel[] = [];
    const evidence: RuntimePageEvidence[] = [];
    let textBlocks = 0;

    for (let number = 1; number <= document.numPages; number += 1) {
      throwIfAborted(options.signal);
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.flatMap(item => toPdfTextItem(item));
      const blocks = groupTextItems(items, viewport.transform, number, content.styles as Record<string, { ascent?: number; descent?: number }>);
      const model: PageModel = {
        number,
        width: viewport.width,
        height: viewport.height,
        blocks,
      };
      pages.push(model);
      textBlocks += blocks.length;

      const operators = await page.getOperatorList();
      const hasImageOperator = operators.fnArray.some(operation => IMAGE_OPERATIONS.has(operation));
      evidence.push({
        page: number,
        glyphCount: items.reduce((sum, item) => sum + Array.from(item.str).length, 0),
        // PDF.js exposes image operators but not their placement until rendering. A
        // page-sized evidence box is intentionally used only as a conservative signal:
        // no text plus a paint-image operator is a scan candidate, while dense text keeps
        // the page digital under the existing classifier.
        images: hasImageOperator ? [{ rect: { x: 0, y: 0, width: viewport.width, height: viewport.height } }] : [],
      });
    }

    return {
      pages,
      evidence,
      textExtraction: textBlocks > 0 ? 'text' : 'none',
    };
  } finally {
    await document.destroy();
  }
}

export function metadataToImportDiagnostics(problems: readonly MetadataProblem[]): readonly string[] {
  return problems.map(problem => problem.message);
}

function toPdfTextItem(value: unknown): PdfTextItem[] {
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  if (typeof item.str !== 'string' || !Array.isArray(item.transform)) return [];
  const transform = item.transform.filter((entry): entry is number => typeof entry === 'number');
  if (transform.length < 6) return [];
  return [{
    str: item.str,
    transform,
    width: typeof item.width === 'number' ? item.width : 0,
    height: typeof item.height === 'number' ? item.height : 0,
    dir: typeof item.dir === 'string' ? item.dir : undefined,
    fontName: typeof item.fontName === 'string' ? item.fontName : undefined,
  }];
}

const IMAGE_OPERATIONS = new Set<number>([
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat,
  OPS.paintImageMaskXObjectRepeat,
  OPS.paintSolidColorImageMask,
]);

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw Object.assign(new Error('PDF import was aborted.'), { name: 'AbortError' });
}

