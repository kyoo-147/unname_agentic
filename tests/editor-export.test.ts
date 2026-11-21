import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { diffVisualRects } from '../src/core/diff';
import { buildDocument } from '../src/core/ir';
import { extractTable } from '../src/core/tables';
import { checkPdfReaders } from '../src/export/reader-check';
import { redactPdfWithSanitizedRasters } from '../src/export/redaction';
import { PdfEditor } from '../src/export/editor';
import { exportFormulaLatex, exportTableCsv } from '../src/export/structured';
import { exportTableXlsx } from '../src/export/xlsx';
import { applyPdfFormPlan } from '../src/export/forms';
import { planFill } from '../src/core/forms';

async function sourcePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle('Source title');
  document.setAuthor('Source author');
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const label of ['Original one', 'Original two']) {
    const page = document.addPage([300, 400]);
    page.drawText(label, { x: 24, y: 350, size: 14, font });
  }
  return document.save();
}

describe('production editor export', () => {
  it('writes a real searchable PDF and preserves immutable source bytes', async () => {
    const source = await sourcePdf();
    const before = new Uint8Array(source);
    const editor = await PdfEditor.open(source);
    editor.addText(1, 'Edited text', { x: 24, y: 60, width: 150, height: 28 }, { paperColor: '#ffffff' });
    editor.addWatermark('DRAFT', { page: 2, rect: { x: 24, y: 80, width: 120, height: 30 } });
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    editor.addRectangle(1, { x: 20, y: 100, width: 80, height: 30 }, { filled: false });
    editor.addImage(1, png, 'png', { x: 200, y: 20, width: 20, height: 20 });
    editor.rotatePage(2, 90);
    const built = await editor.build();
    expect(Array.from(source)).toEqual(Array.from(before));
    expect(built.pageCount).toBe(2);
    expect(built.overlayCount).toBe(4);
    expect(built.editCount).toBe(0);
    const metadata = await PDFDocument.load(built.bytes, { updateMetadata: false });
    expect(metadata.getTitle()).toBe('Source title');
    const check = await checkPdfReaders(built.bytes);
    expect(check.pdfLib.ok).toBe(true);
    expect(check.pdfJs.ok).toBe(true);
    expect(check.searchable).toBe(true);
    expect(check.pdfJs.text).toContain('Edited text');
  });

  it('edits an IR block with source provenance and records overlay limits', async () => {
    const source = await sourcePdf();
    const ir = buildDocument({ sourceSha256: 'a'.repeat(64), documentId: 'source', blocks: [{ page: 1, text: 'Original one', rect: { x: 24, y: 36, width: 120, height: 18 } }] });
    const editor = PdfEditor.fromIr(source, ir);
    const block = ir.blocks[0]!;
    editor.editText(block.id, 'Changed one');
    const built = await editor.build();
    expect(editor.snapshot.edits[0]?.sourceText).toBe('Original one');
    expect(built.limitations.join(' ')).toContain('immutable source content');
    const check = await checkPdfReaders(built.bytes);
    expect(check.pdfJs.text).toContain('Changed one');
  });

  it('supports page reorder, deletion and split with actual page geometry', async () => {
    const editor = await PdfEditor.open(await sourcePdf());
    editor.reorderPages([1, 0]);
    const reordered = await editor.build();
    const reorderedCheck = await checkPdfReaders(reordered.bytes);
    expect(reorderedCheck.pdfJs.text.indexOf('Original two')).toBeLessThan(reorderedCheck.pdfJs.text.indexOf('Original one'));
    expect(reordered.preserved.outlines).toBe(false);
    editor.deletePages([2]);
    const onePage = await editor.build();
    expect(onePage.pageCount).toBe(1);
    const split = await PdfEditor.open(await sourcePdf());
    split.splitPage(1, 'vertical', 0.5);
    const splitResult = await split.build();
    expect(splitResult.pageCount).toBe(3);
    expect(splitResult.limitations.join(' ')).toContain('page tree');
    const reopened = await PDFDocument.load(splitResult.bytes);
    expect(reopened.getPage(0).getCropBox().width).toBe(150);
  });

  it('supports undo/redo and real form fill/flatten', async () => {
    const formDocument = await PDFDocument.create();
    const page = formDocument.addPage([300, 200]);
    const form = formDocument.getForm();
    const field = form.createTextField('name');
    field.addToPage(page, { x: 20, y: 100, width: 200, height: 24 });
    const source = await formDocument.save();
    const editor = await PdfEditor.open(source);
    editor.addText(1, 'first', { x: 20, y: 20, width: 100, height: 20 });
    editor.session.undo();
    expect(editor.snapshot.overlays).toHaveLength(0);
    editor.session.redo();
    expect(editor.snapshot.overlays).toHaveLength(1);
    const fillPlan = planFill([{ name: 'name', type: 'text', value: '', required: false, rect: { x: 20, y: 20, width: 200, height: 20 }, page: 1, readOnly: false }], { name: 'Ada' });
    const filled = await applyPdfFormPlan(source, fillPlan, { flatten: true });
    expect(filled.applied).toEqual(['name']);
    expect(filled.flattened).toBe(true);
    const reopened = await PDFDocument.load(filled.bytes);
    expect(reopened.getForm().getFields()).toHaveLength(0);
  });

  it('exports structured table/formula data and visual diff coordinates', () => {
    const table = extractTable([
      { text: 'Name', rect: { x: 0, y: 0, width: 50, height: 12 } },
      { text: 'Score', rect: { x: 100, y: 0, width: 50, height: 12 } },
      { text: 'Ada', rect: { x: 0, y: 20, width: 50, height: 12 } },
      { text: '10', rect: { x: 100, y: 20, width: 50, height: 12 } },
    ]);
    expect(exportTableCsv(table).text).toContain('Name,Score');
    expect(exportFormulaLatex('x^2 + α').text).toContain('x^{2}');
    const before = buildDocument({ sourceSha256: 'a'.repeat(64), blocks: [{ page: 1, text: 'before', rect: { x: 10, y: 10, width: 30, height: 10 } }] });
    const after = buildDocument({ sourceSha256: 'a'.repeat(64), blocks: [{ page: 1, text: 'after', rect: { x: 20, y: 20, width: 40, height: 10 } }] });
    expect(diffVisualRects(before, after).length).toBeGreaterThan(0);
  });
  it('requires sanitized rasters for a redacted image-only PDF', async () => {
    const source = await sourcePdf();
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    const result = await redactPdfWithSanitizedRasters(source, [
      { page: 1, bytes: png, format: 'png', width: 300, height: 400 },
      { page: 2, bytes: png, format: 'png', width: 300, height: 400 },
    ]);
    const check = await checkPdfReaders(result.bytes);
    expect(result.imageOnly).toBe(true);
    expect(check.pdfLib.ok).toBe(true);
    expect(check.searchable).toBe(false);
  });
});
