import { PDFDocument } from 'pdf-lib';

export interface PdfReaderCheck {
  pdfLib: { ok: boolean; pageCount: number; fieldNames: string[]; error?: string };
  pdfJs: { ok: boolean; pageCount: number; text: string; error?: string };
  searchable: boolean;
}

/** Reopens output bytes with both supported readers and checks that text is still extractable. */
export async function checkPdfReaders(bytes: Uint8Array): Promise<PdfReaderCheck> {
  const result: PdfReaderCheck = {
    pdfLib: { ok: false, pageCount: 0, fieldNames: [] },
    pdfJs: { ok: false, pageCount: 0, text: '' },
    searchable: false,
  };
  try {
    const document = await PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false });
    result.pdfLib.pageCount = document.getPageCount();
    result.pdfLib.fieldNames = document.getForm().getFields().map(field => field.getName());
    result.pdfLib.ok = result.pdfLib.pageCount > 0;
  } catch (error) {
    result.pdfLib.error = error instanceof Error ? error.message : String(error);
  }
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = pdfjs.getDocument({ data: new Uint8Array(bytes) });
    const document = await loading.promise;
    result.pdfJs.pageCount = document.numPages;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      result.pdfJs.text += content.items.map(item => 'str' in item && typeof item.str === 'string' ? item.str : '').join(' ');
    }
    result.pdfJs.ok = result.pdfJs.pageCount > 0;
    result.searchable = result.pdfJs.text.trim().length > 0;
    await document.cleanup();
    await document.destroy();
  } catch (error) {
    result.pdfJs.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}
