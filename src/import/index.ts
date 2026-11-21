import { convertDocument, type ConvertOptions, type ConversionResult } from '../core/converters';
import { sniffFormat, type ImportFormat } from '../core/import-formats';
import { type DocumentMetadata } from '../core/metadata';
import { type DocumentIR } from '../core/ir';
import { importPdfBytes, type PdfImportError, type PdfImportOptions, type PdfImportResult } from './pdf';
import { captureSource, toUint8Array, type ImmutableSource } from './source';

export type ImportErrorCode = 'invalid-input' | 'unsupported-format' | 'source-read-failed' | 'pdf-import-failed' | 'malformed-pdf' | 'password-required' | 'password-invalid' | 'pdf-read-failed' | 'converter-failed';

export class DocumentImportError extends Error {
  readonly code: ImportErrorCode;
  readonly format: ImportFormat | null;
  readonly causeError: unknown;

  constructor(code: ImportErrorCode, message: string, format: ImportFormat | null = null, causeError?: unknown) {
    super(message);
    this.name = 'DocumentImportError';
    this.code = code;
    this.format = format;
    this.causeError = causeError;
  }
}

export interface LocalImportOptions extends Omit<ConvertOptions, 'format'>, Omit<PdfImportOptions, 'signal'> {
  readonly format?: ImportFormat;
  readonly filename?: string;
  readonly signal?: AbortSignal;
}

export interface ImportedDocument {
  readonly source: ImmutableSource;
  readonly format: ImportFormat;
  readonly ir: DocumentIR;
  readonly runtime: PdfImportResult['runtime'] | null;
  readonly metadata: DocumentMetadata | ConversionResult['metadata'] | null;
  readonly diagnostics: readonly ImportDiagnostic[];
}

export type ImportDiagnosticSeverity = 'info' | 'warning';

export interface ImportDiagnostic {
  readonly code: string;
  readonly severity: ImportDiagnosticSeverity;
  readonly message: string;
}

export async function importDocument(value: Uint8Array | ArrayBuffer | Blob, options: LocalImportOptions = {}): Promise<ImportedDocument> {
  const bytes = await toUint8Array(value);
  return importDocumentBytes(bytes, options);
}

export async function importDocumentBytes(bytes: Uint8Array, options: LocalImportOptions = {}): Promise<ImportedDocument> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new DocumentImportError('invalid-input', 'Document import requires non-empty local bytes.');
  }
  throwIfAborted(options.signal);

  const sniffed = options.format && options.format !== 'unknown'
    ? { format: options.format }
    : sniffFormat(bytes, options.filename ?? '');
  const format = sniffed.format as ImportFormat;
  const source = captureSource(bytes, options.filename ?? '');

  if (format === 'pdf') {
    try {
      const result = await importPdfBytes(bytes, options);
      return freezeImported({
        source,
        format,
        ir: result.runtime.ir,
        runtime: result.runtime,
        metadata: result.metadata,
        diagnostics: pdfDiagnostics(result),
      });
    } catch (error) {
      if (error instanceof DocumentImportError) throw error;
      const pdfError = error as PdfImportError;
      const code = pdfError instanceof Error && ['malformed-pdf', 'password-required', 'password-invalid', 'pdf-read-failed'].includes(pdfError.code)
        ? pdfError.code
        : 'pdf-import-failed';
      throw new DocumentImportError(code, pdfError.message ?? String(error), format, error);
    }
  }

  if (!isConvertibleFormat(format)) {
    throw new DocumentImportError(
      'unsupported-format',
      `No local converter is available for detected format "${format}". The source bytes were not changed.`,
      format,
    );
  }

  try {
    const result = convertDocument(bytes, {
      ...options,
      format,
    });
    return freezeImported({
      source,
      format,
      ir: result.ir,
      runtime: null,
      metadata: result.metadata,
      diagnostics: converterDiagnostics(result),
    });
  } catch (error) {
    throw new DocumentImportError(
      'converter-failed',
      error instanceof Error ? error.message : String(error),
      format,
      error,
    );
  }
}

export interface LocalPathOptions extends LocalImportOptions {
  readonly readFile?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
}

export async function importLocalPath(path: string, options: LocalPathOptions = {}): Promise<ImportedDocument> {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new DocumentImportError('invalid-input', 'A non-empty local path is required.');
  }

  try {
    const readFile = options.readFile ?? defaultReadFile;
    const bytes = await readFile(path);
    return await importDocumentBytes(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
      ...options,
      filename: options.filename ?? basename(path),
    });
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    throw new DocumentImportError(
      'source-read-failed',
      `Could not read local document "${path}": ${error instanceof Error ? error.message : String(error)}`,
      null,
      error,
    );
  }
}

function pdfDiagnostics(result: PdfImportResult): ImportDiagnostic[] {
  return [
    ...result.health.problems.map(problem => ({ code: `pdf-${problem.code}`, severity: 'warning' as const, message: problem.message })),
    ...result.warnings.map(message => ({ code: 'pdf-import-warning', severity: 'warning' as const, message })),
    ...(result.runtime.pageClassifications.some(page => page.kind !== 'born-digital')
      ? [{ code: 'ocr-route-required', severity: 'info' as const, message: 'One or more PDF pages require the existing local OCR adapter; embedded text was not fabricated.' }]
      : []),
  ];
}

function converterDiagnostics(result: ConversionResult): ImportDiagnostic[] {
  const diagnostics: ImportDiagnostic[] = result.warnings.map(message => ({ code: 'converter-warning', severity: 'warning', message }));
  if (result.format === 'png' || result.format === 'jpeg' || result.format === 'tiff') {
    diagnostics.push({
      code: 'ocr-route-required',
      severity: 'info',
      message: 'The image adapter preserved the raster as a figure block. Text requires the existing local OCR contract, so no text was invented.',
    });
  }
  return diagnostics;
}

function isConvertibleFormat(format: ImportFormat): format is 'docx' | 'pptx' | 'xlsx' | 'epub' | 'html' | 'png' | 'jpeg' | 'tiff' {
  return format === 'docx' || format === 'pptx' || format === 'xlsx' || format === 'epub'
    || format === 'html' || format === 'png' || format === 'jpeg' || format === 'tiff';
}

async function defaultReadFile(path: string): Promise<Uint8Array> {
  const maybeProcess = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs = maybeProcess?.getBuiltinModule?.('node:fs/promises') as { readFile?: (path: string) => Promise<Uint8Array> } | undefined;
  if (!fs?.readFile) {
    throw new Error('The default local-path reader is only available in a Node runtime; pass readFile explicitly in a browser.');
  }
  return new Uint8Array(await fs.readFile(path));
}

function basename(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw Object.assign(new Error('Document import was aborted.'), { name: 'AbortError' });
}

function freezeImported(document: ImportedDocument): ImportedDocument {
  return deepFreeze(document);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Reflect.ownKeys(value as object).forEach(key => {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  });
  return Object.freeze(value);
}

export { captureSource, sourceBytes, toUint8Array, type ImmutableSource } from './source';
export { importPdfBytes, readPdfPages, PdfImportError, type PdfImportOptions, type PdfImportResult, type PdfPageReadResult } from './pdf';
