import { PDFDocument } from 'pdf-lib';

export interface SanitizedPageRaster {
  page: number;
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
  width?: number;
  height?: number;
}

export interface RedactedPdfResult {
  bytes: Uint8Array;
  pageCount: number;
  imageOnly: true;
  limitations: string[];
}

/**
 * Rebuild a PDF from renderer-produced sanitized page rasters. This is the safe byte-writing path
 * for redaction: the input PDF content streams are never copied, so hidden text and vector objects
 * cannot survive behind the black boxes. Callers must provide rasters after the redaction mask was
 * applied; a rectangle overlay alone is intentionally not accepted here.
 */
export async function redactPdfWithSanitizedRasters(
  sourceBytes: Uint8Array,
  rasters: readonly SanitizedPageRaster[],
  options: { title?: string; author?: string } = {},
): Promise<RedactedPdfResult> {
  const source = await PDFDocument.load(new Uint8Array(sourceBytes), { updateMetadata: false });
  if (rasters.length !== source.getPageCount()) throw new Error(`Expected one sanitized raster for each of ${source.getPageCount()} pages.`);
  const ordered = [...rasters].sort((left, right) => left.page - right.page);
  if (ordered.some((raster, index) => raster.page !== index + 1 || raster.bytes.length === 0)) throw new Error('Sanitized rasters must cover pages 1..N exactly and contain bytes.');
  const output = await PDFDocument.create();
  if (options.title !== undefined) output.setTitle(options.title);
  if (options.author !== undefined) output.setAuthor(options.author);
  output.setCreator('Mirror PDF redaction export');
  output.setProducer('Mirror PDF redaction export');
  for (const raster of ordered) {
    const sourcePage = source.getPage(raster.page - 1)!;
    const page = output.addPage([raster.width ?? sourcePage.getWidth(), raster.height ?? sourcePage.getHeight()]);
    const image = raster.format === 'png' ? await output.embedPng(raster.bytes) : await output.embedJpg(raster.bytes);
    page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  return {
    bytes: await output.save(),
    pageCount: output.getPageCount(),
    imageOnly: true,
    limitations: ['The redacted PDF is image-only. Text search, selectable text, interactive forms, annotations, outlines and accessibility tags are not preserved.'],
  };
}
