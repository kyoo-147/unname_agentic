import { readFile } from 'node:fs/promises';
import { groupTextItems, type PdfTextItem } from '../../pdf/layout';
import { ingestDocument, type RuntimeDocument } from '../document-runtime';
import type { PageModel } from '../types';
import type { RuntimePageEvidence } from '../document-runtime';

export interface PdfImportOptions {
  readonly signal?: AbortSignal;
}

export interface PdfImportResult {
  readonly runtime: RuntimeDocument;
  readonly bytes: Uint8Array;
}

export async function importPdfFile(path: string, options: PdfImportOptions = {}): Promise<PdfImportResult> {
  throwIfAborted(options.signal);
  const bytes = new Uint8Array(await readFile(path));
  throwIfAborted(options.signal);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Keep machine-readable CLI output clean. PDF.js warnings are not document data and
  // belong in the process diagnostics stream, not stdout's JSON protocol.
  const loading = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0 });
  const pdf = await loading.promise;
  const pages: PageModel[] = [];
  const evidence: RuntimePageEvidence[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    throwIfAborted(options.signal);
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.flatMap(item => toTextItem(item));
    let hasImage = false;
    if (items.length <= 1) {
      const operatorList = await page.getOperatorList();
      const ops = pdfjs.OPS as unknown as Record<string, number>;
      const imageOperators = new Set([ops.paintImageXObject, ops.paintImageMaskXObject, ops.paintSolidColorImageMask]);
      hasImage = operatorList.fnArray.some((operator: number) => imageOperators.has(operator));
    }
    evidence.push({ page: number, glyphCount: items.reduce((count, item) => count + item.str.length, 0), images: hasImage ? [{ rect: { x: 0, y: 0, width: viewport.width, height: viewport.height } }] : [] });
    pages.push({
      number,
      width: viewport.width,
      height: viewport.height,
      blocks: groupTextItems(items, viewport.transform, number, content.styles as Record<string, { ascent?: number; descent?: number }>),
    });
  }
  const runtime = ingestDocument({ pages, sourceBytes: bytes, pageEvidence: evidence });
  return { runtime, bytes };
}

function toTextItem(value: unknown): PdfTextItem[] {
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  if (typeof item.str !== 'string' || !Array.isArray(item.transform)) return [];
  const transform = item.transform.filter((entry): entry is number => typeof entry === 'number');
  if (transform.length !== 6) return [];
  return [{
    str: item.str,
    transform,
    width: typeof item.width === 'number' ? item.width : 0,
    height: typeof item.height === 'number' ? item.height : 0,
    dir: typeof item.dir === 'string' ? item.dir : undefined,
    fontName: typeof item.fontName === 'string' ? item.fontName : undefined,
  }];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('automation was cancelled.');
}
