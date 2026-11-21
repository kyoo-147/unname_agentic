import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { readMetadata } from '../src/core/metadata';
import { buildOutline } from '../src/core/outline';
import {
  applyPdfMetadata,
  copyPdfMetadata,
  copyPdfOutlines,
  extractPdfMetadata,
  extractPdfOutlines,
  outlineFromSections,
  preserveAcroForm,
  preservePdfBytes,
  preservePdfDocument,
  writePdfOutlines,
  type PdfOutlineNode,
} from '../src/export/pdf-preserve';

async function loadPdfJs(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  return {
    task,
    doc: await task.promise,
  };
}

async function createSampleSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let pageNumber = 1; pageNumber <= 4; pageNumber += 1) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Source Page ${pageNumber}`, { x: 72, y: 720, size: 16, font });
  }

  doc.setTitle('Tài liệu kỹ thuật — Bản gốc');
  doc.setAuthor('Nguyễn An');
  doc.setSubject('Architecture and Data Flows');
  doc.setKeywords(['architecture', 'pdf', 'preservation']);
  doc.setCreator('Original Authoring Suite');
  doc.setProducer('Original PDF Producer');
  doc.setCreationDate(new Date('2024-03-15T10:20:30Z'));
  doc.setModificationDate(new Date('2024-04-01T08:00:00Z'));
  doc.setLanguage('vi-VN');

  const form = doc.getForm();
  const applicant = form.createTextField('applicant.fullName');
  applicant.addToPage(doc.getPage(0), { x: 72, y: 640, width: 220, height: 24 });
  applicant.setText('Tran Binh');

  const approved = form.createCheckBox('approved');
  approved.addToPage(doc.getPage(1), { x: 72, y: 600, width: 18, height: 18 });
  approved.check();

  const tier = form.createDropdown('tier');
  tier.setOptions(['basic', 'pro', 'enterprise']);
  tier.addToPage(doc.getPage(1), { x: 72, y: 540, width: 160, height: 24 });
  tier.select('pro');

  const format = form.createRadioGroup('outputFormat');
  format.addOptionToPage('pdf', doc.getPage(3), { x: 72, y: 500, width: 16, height: 16 });
  format.addOptionToPage('html', doc.getPage(3), { x: 140, y: 500, width: 16, height: 16 });
  format.select('pdf');

  const outlines: PdfOutlineNode[] = [
    {
      title: 'Chương 1: Giới thiệu',
      page: 1,
      bold: true,
      children: [
        { title: '1.1 Phạm vi', page: 2 },
        {
          title: '1.2 Kiến trúc',
          page: 2,
          open: false,
          children: [{ title: '1.2.1 Chi tiết ẩn', page: 3 }],
        },
      ],
    },
    {
      title: 'Chương 2: Kết luận',
      page: 4,
      italic: true,
      color: [0.1, 0.3, 0.7],
    },
  ];
  writePdfOutlines(doc, outlines);

  return doc.save({ updateFieldAppearances: true });
}

describe('H09 PDF metadata writing and preservation', () => {
  it('writes Title, Author, Subject, Keywords, Creator, Producer, CreationDate, and /Lang verified by pdf-lib and pdfjs-dist', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const createdAt = new Date('2025-01-10T12:30:45Z');
    const modifiedAt = new Date('2025-02-20T09:15:00Z');

    applyPdfMetadata(doc, {
      title: 'Báo cáo tổng kết — Năm 2025',
      author: 'Lê Minh',
      subject: 'Financial Summary',
      keywords: ['finance', 'annual', 'bilingual'],
      creator: 'Mirror Translator',
      producer: 'Mirror Export Engine',
      creationDate: createdAt,
      modificationDate: modifiedAt,
      lang: 'vi',
    });

    const bytes = await doc.save({ useObjectStreams: false });

    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(reloaded.getTitle()).toBe('Báo cáo tổng kết — Năm 2025');
    expect(reloaded.getAuthor()).toBe('Lê Minh');
    expect(reloaded.getSubject()).toBe('Financial Summary');
    expect(reloaded.getKeywords()).toBe('finance annual bilingual');
    expect(reloaded.getCreator()).toBe('Mirror Translator');
    expect(reloaded.getProducer()).toBe('Mirror Export Engine');
    expect(reloaded.getCreationDate()?.toISOString()).toBe('2025-01-10T12:30:45.000Z');
    expect(reloaded.getModificationDate()?.toISOString()).toBe('2025-02-20T09:15:00.000Z');
    const langObj = reloaded.catalog.lookup(PDFName.of('Lang'));
    expect(langObj).toBeInstanceOf(PDFString);
    expect((langObj as PDFString).decodeText()).toBe('vi');

    const { task, doc: pdfjs } = await loadPdfJs(bytes);
    try {
      const meta = await pdfjs.getMetadata();
      const info = meta.info as Record<string, unknown>;
      expect(info['Title']).toBe('Báo cáo tổng kết — Năm 2025');
      expect(info['Author']).toBe('Lê Minh');
      expect(info['Subject']).toBe('Financial Summary');
      expect(info['Keywords']).toBe('finance annual bilingual');
      expect(info['Creator']).toBe('Mirror Translator');
      expect(info['Producer']).toBe('Mirror Export Engine');
      expect(info['CreationDate']).toBe('D:20250110123045Z');
      expect(info['Language']).toBe('vi');
    } finally {
      await task.destroy();
    }

    const coreMeta = readMetadata(bytes);
    expect(coreMeta.metadata.title).toBe('Báo cáo tổng kết — Năm 2025');
    expect(coreMeta.metadata.language).toBe('vi');
    expect(coreMeta.metadata.creationDate?.iso).toBe('2025-01-10T12:30:45Z');
  });

  it('copies metadata from source PDF bytes while applying selective overrides without losing CreationDate or /Lang', async () => {
    const srcBytes = await createSampleSourcePdf();
    const target = await PDFDocument.create();
    target.addPage([612, 792]);

    await copyPdfMetadata(srcBytes, target, {
      title: 'Tài liệu kỹ thuật — Bản dịch tiếng Việt',
      producer: 'Mirror Export',
    });

    const saved = await target.save();
    const extracted = await extractPdfMetadata(saved);
    expect(extracted.title).toBe('Tài liệu kỹ thuật — Bản dịch tiếng Việt');
    expect(extracted.author).toBe('Nguyễn An');
    expect(extracted.subject).toBe('Architecture and Data Flows');
    expect(extracted.keywords).toBe('architecture pdf preservation');
    expect(extracted.creator).toBe('Original Authoring Suite');
    expect(extracted.producer).toBe('Mirror Export');
    expect(extracted.creationDate?.toISOString()).toBe('2024-03-15T10:20:30.000Z');
    expect(extracted.lang).toBe('vi-VN');
  });
});

describe('H09 hierarchical /Outlines bookmark tree building and preservation', () => {
  it('writes low-level /Outlines PDFDict/PDFArray hierarchy including collapsed /Count and verifies via pdf-lib and pdfjs-dist getOutline()', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);

    const result = writePdfOutlines(doc, [
      {
        title: 'Phần I — Mở đầu',
        page: 1,
        bold: true,
        children: [
          { title: 'Mục 1.1', page: 2 },
          {
            title: 'Mục 1.2 (thu gọn)',
            page: 3,
            open: false,
            children: [{ title: 'Mục 1.2.1 ẩn', page: 3 }],
          },
        ],
      },
      {
        title: 'Phần II — Phụ lục',
        page: 4,
        italic: true,
        color: [0.2, 0.4, 0.8],
      },
    ]);

    expect(result).toEqual({
      written: 5,
      rootCount: 2,
      dropped: 0,
      warnings: [],
    });

    const bytes = await doc.save();

    // Verify low-level PDFDict/PDFArray structure via pdf-lib
    const reloaded = await PDFDocument.load(bytes);
    const outlinesDict = reloaded.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    expect(outlinesDict.get(PDFName.of('Type'))).toBe(PDFName.of('Outlines'));
    // Visible items: Phần I + Mục 1.1 + Mục 1.2 (collapsed, child hidden) + Phần II = 4
    expect((outlinesDict.lookup(PDFName.of('Count')) as PDFNumber).asNumber()).toBe(4);

    const firstRef = outlinesDict.get(PDFName.of('First'));
    expect(firstRef).toBeInstanceOf(PDFRef);
    const firstItem = outlinesDict.lookup(PDFName.of('First'), PDFDict);
    expect((firstItem.lookup(PDFName.of('Title')) as PDFHexString).decodeText()).toBe('Phần I — Mở đầu');
    expect((firstItem.lookup(PDFName.of('Count')) as PDFNumber).asNumber()).toBe(2);

    const destArray = firstItem.lookup(PDFName.of('Dest'), PDFArray);
    expect(destArray.get(0)).toBe(reloaded.getPage(0).ref);
    expect(destArray.get(1)).toBe(PDFName.of('Fit'));

    const secondChild = firstItem.lookup(PDFName.of('Last'), PDFDict);
    expect((secondChild.lookup(PDFName.of('Count')) as PDFNumber).asNumber()).toBe(-1);

    // Verify with pdfjs-dist getOutline()
    const { task, doc: pdfjs } = await loadPdfJs(bytes);
    try {
      const outline = await pdfjs.getOutline();
      expect(outline).toHaveLength(2);
      expect(outline[0]?.title).toBe('Phần I — Mở đầu');
      expect(outline[0]?.bold).toBe(true);
      expect(outline[0]?.items).toHaveLength(2);
      expect(outline[0]?.items[0]?.title).toBe('Mục 1.1');
      expect(outline[0]?.items[1]?.title).toBe('Mục 1.2 (thu gọn)');
      expect(outline[0]?.items[1]?.items).toHaveLength(1);
      expect(outline[0]?.items[1]?.items[0]?.title).toBe('Mục 1.2.1 ẩn');
      expect(outline[1]?.title).toBe('Phần II — Phụ lục');
      expect(outline[1]?.italic).toBe(true);

      const p1 = await pdfjs.getPageIndex((outline[0]?.dest as unknown[])[0] as { num: number; gen: number });
      const p2 = await pdfjs.getPageIndex((outline[0]?.items[0]?.dest as unknown[])[0] as { num: number; gen: number });
      const p3 = await pdfjs.getPageIndex((outline[0]?.items[1]?.items[0]?.dest as unknown[])[0] as { num: number; gen: number });
      const p4 = await pdfjs.getPageIndex((outline[1]?.dest as unknown[])[0] as { num: number; gen: number });
      expect([p1, p2, p3, p4]).toEqual([0, 1, 2, 3]);
    } finally {
      await task.destroy();
    }
  });

  it('builds PDF /Outlines from core buildOutline() sections and extracts them cleanly', async () => {
    const coreOutline = buildOutline([
      { id: 'b0', page: 1, text: 'Preamble text', type: 'paragraph' },
      { id: 'b1', page: 1, text: '1 Overview', type: 'heading', headingLevel: 1 },
      { id: 'b2', page: 2, text: '1.1 Details', type: 'heading', headingLevel: 2 },
      { id: 'b3', page: 3, text: '2 Conclusion', type: 'heading', headingLevel: 1 },
    ]);

    const nodes = outlineFromSections(coreOutline);
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    writePdfOutlines(doc, nodes);

    const bytes = await doc.save();
    const reloaded = await PDFDocument.load(bytes);
    const extracted = extractPdfOutlines(reloaded);
    expect(extracted).toHaveLength(2);
    expect(extracted[0]).toMatchObject({ title: '1 Overview', page: 1 });
    expect(extracted[0]?.children).toHaveLength(1);
    expect(extracted[0]?.children?.[0]).toMatchObject({ title: '1.1 Details', page: 2 });
    expect(extracted[1]).toMatchObject({ title: '2 Conclusion', page: 3 });
  });

  it('copies and remaps outlines when target PDF only keeps a subset of pages', async () => {
    const srcBytes = await createSampleSourcePdf();
    const srcDoc = await PDFDocument.load(srcBytes, { updateMetadata: false });
    const targetDoc = await PDFDocument.create();
    const copiedPages = await targetDoc.copyPages(srcDoc, [1, 3]);
    for (const page of copiedPages) targetDoc.addPage(page);

    // Source page 2 -> Target page 1, Source page 4 -> Target page 2
    const report = copyPdfOutlines(srcDoc, targetDoc, {
      pageMap: { 2: 1, 4: 2 },
    });

    expect(report.dropped).toBe(2); // "Chương 1" (p1) & "1.2.1 Chi tiết ẩn" (p3) removed or remapped cleanly
    expect(report.written).toBeGreaterThanOrEqual(3);

    const saved = await targetDoc.save();
    const { task, doc: pdfjs } = await loadPdfJs(saved);
    try {
      const outline = await pdfjs.getOutline();
      expect(outline.length).toBeGreaterThanOrEqual(2);
      const lastItem = outline[outline.length - 1]!;
      expect(lastItem.title).toBe('Chương 2: Kết luận');
      const targetIdx = await pdfjs.getPageIndex((lastItem.dest as unknown[])[0] as { num: number; gen: number });
      expect(targetIdx).toBe(1);
    } finally {
      await task.destroy();
    }
  });
});

describe('H09 AcroForm preservation and unified preservePdfBytes', () => {
  it('preserves AcroForm fields, values, options, and page widget refs across copyPages without duplicate widgets', async () => {
    const srcBytes = await createSampleSourcePdf();
    const srcDoc = await PDFDocument.load(srcBytes, { updateMetadata: false });
    const targetDoc = await PDFDocument.create();
    const copiedPages = await targetDoc.copyPages(srcDoc, [0, 1, 2, 3]);
    for (const page of copiedPages) targetDoc.addPage(page);

    const acroResult = preserveAcroForm(srcDoc, targetDoc);
    expect(acroResult.preserved).toBe(true);
    expect(acroResult.fieldCount).toBe(4);
    expect(acroResult.widgetCount).toBe(5); // 1 text + 1 checkbox + 1 dropdown + 2 radio options

    const bytes = await targetDoc.save();
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    const form = reloaded.getForm();
    expect(form.getFields()).toHaveLength(4);
    expect(form.getTextField('applicant.fullName').getText()).toBe('Tran Binh');
    expect(form.getCheckBox('approved').isChecked()).toBe(true);
    expect(form.getDropdown('tier').getSelected()).toEqual(['pro']);
    expect(form.getRadioGroup('outputFormat').getSelected()).toBe('pdf');

    // No duplicate widget annotations on page 2 (1 checkbox + 1 dropdown = 2 widgets)
    const annotsP2 = reloaded.getPage(1).node.Annots();
    expect(annotsP2?.size()).toBe(2);

    const { task, doc: pdfjs } = await loadPdfJs(bytes);
    try {
      const fieldObjects = await pdfjs.getFieldObjects() as Record<string, Array<Record<string, unknown>>> | null;
      expect(fieldObjects).not.toBeNull();
      const widgetOf = (name: string) =>
        fieldObjects?.[name]?.find(entry => entry['type'] !== '');
      expect(widgetOf('applicant.fullName')).toMatchObject({ type: 'text', value: 'Tran Binh' });
      expect(widgetOf('tier')).toMatchObject({ type: 'combobox', value: 'pro' });
    } finally {
      await task.destroy();
    }
  });

  it('preserves AcroForm onto newly constructed target pages with page subset remapping', async () => {
    const srcBytes = await createSampleSourcePdf();
    const srcDoc = await PDFDocument.load(srcBytes, { updateMetadata: false });
    const targetDoc = await PDFDocument.create();
    targetDoc.addPage([612, 792]); // maps to source page 2
    targetDoc.addPage([612, 792]); // maps to source page 4

    const result = await preservePdfDocument(srcDoc, targetDoc, {
      pageMap: { 2: 1, 4: 2 },
      metadata: { title: 'Subset Export' },
    });

    expect(result.acroForm.preserved).toBe(true);
    expect(result.acroForm.fieldCount).toBe(3); // applicant on p1 excluded; approved, tier, outputFormat kept
    expect(result.acroForm.skippedFields).toContain('applicant.fullName');

    const saved = await targetDoc.save();
    const reloaded = await PDFDocument.load(saved, { updateMetadata: false });
    const form = reloaded.getForm();
    expect(form.getFields().map(f => f.getName()).sort()).toEqual(['approved', 'outputFormat', 'tier']);
    expect(form.getCheckBox('approved').isChecked()).toBe(true);
    expect(form.getDropdown('tier').getSelected()).toEqual(['pro']);
    expect(form.getRadioGroup('outputFormat').getSelected()).toBe('pdf');

    // Verify widget /P points to targetDoc's actual page 2 ref
    const radioWidgets = form.getRadioGroup('outputFormat').acroField.getWidgets();
    expect(radioWidgets).toHaveLength(2);
    for (const widget of radioWidgets) {
      expect(widget.P()).toBe(reloaded.getPage(1).ref);
    }
  });

  it('preservePdfBytes preserves metadata, outlines, and AcroForm end-to-end across raw PDF buffers', async () => {
    const srcBytes = await createSampleSourcePdf();
    const blankTarget = await PDFDocument.create();
    for (let i = 0; i < 4; i += 1) blankTarget.addPage([612, 792]);
    const targetBytes = await blankTarget.save();

    const preserved = await preservePdfBytes(srcBytes, targetBytes, {
      metadata: { producer: 'Mirror H09 Pipeline' },
    });

    expect(preserved.metadata.title).toBe('Tài liệu kỹ thuật — Bản gốc');
    expect(preserved.metadata.producer).toBe('Mirror H09 Pipeline');
    expect(preserved.outlines.written).toBe(5);
    expect(preserved.acroForm.fieldCount).toBe(4);

    const { task, doc: pdfjs } = await loadPdfJs(preserved.bytes);
    try {
      const meta = await pdfjs.getMetadata();
      const info = meta.info as Record<string, unknown>;
      expect(info['Title']).toBe('Tài liệu kỹ thuật — Bản gốc');
      expect(info['Author']).toBe('Nguyễn An');
      expect(info['Language']).toBe('vi-VN');
      expect(info['Producer']).toBe('Mirror H09 Pipeline');

      const outline = await pdfjs.getOutline();
      expect(outline).toHaveLength(2);
      expect(outline[0]?.title).toBe('Chương 1: Giới thiệu');
      expect(outline[1]?.title).toBe('Chương 2: Kết luận');

      const fields = await pdfjs.getFieldObjects() as Record<string, Array<Record<string, unknown>>> | null;
      const widgetOf = (name: string) =>
        fields?.[name]?.find(entry => entry['type'] !== '');
      expect(widgetOf('applicant.fullName')).toMatchObject({ type: 'text', value: 'Tran Binh' });
      expect(widgetOf('approved')).toMatchObject({ type: 'checkbox', value: 'Yes' });
      expect(widgetOf('tier')).toMatchObject({ type: 'combobox', value: 'pro' });
    } finally {
      await task.destroy();
    }
  });

  it('round-trips /XYZ destinations, deletes stale /Outlines when given empty array, and warns on XFA/merged widgets', async () => {
    const doc = await PDFDocument.create();
    const p1 = doc.addPage([612, 792]);

    writePdfOutlines(doc, [{ title: 'Top Anchor', page: 1, fit: 'XYZ', left: 72, top: 700, zoom: 1.5 }]);
    const extracted = extractPdfOutlines(doc);
    expect(extracted[0]).toMatchObject({ title: 'Top Anchor', page: 1, fit: 'XYZ', left: 72, top: 700, zoom: 1.5 });

    const emptyResult = writePdfOutlines(doc, []);
    expect(emptyResult.written).toBe(0);
    expect(doc.catalog.get(PDFName.of('Outlines'))).toBeUndefined();

    // Merged field+widget dictionary (no /Kids) + synthetic /XFA entry
    const mergedRef = doc.context.nextRef();
    doc.context.assign(
      mergedRef,
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        T: PDFString.of('mergedField'),
        V: PDFString.of('Merged Value'),
        Rect: [72, 600, 220, 624],
        P: p1.ref,
      }),
    );
    const acro = doc.catalog.getOrCreateAcroForm();
    acro.addField(mergedRef);
    acro.dict.set(PDFName.of('XFA'), PDFString.of('<xdp/>'));
    p1.node.addAnnot(mergedRef);

    const target = await PDFDocument.create();
    target.addPage([612, 792]);
    const acroRes = preserveAcroForm(doc, target);
    expect(acroRes.preserved).toBe(true);
    expect(acroRes.fieldCount).toBe(1);
    expect(acroRes.widgetCount).toBe(1);
    expect(acroRes.warnings.some(w => w.includes('XFA'))).toBe(true);

    const saved = await target.save();
    const reloaded = await PDFDocument.load(saved);
    expect(reloaded.getForm().getTextField('mergedField').getText()).toBe('Merged Value');
    expect(reloaded.catalog.getAcroForm()?.dict.has(PDFName.of('XFA'))).toBe(false);
    expect(reloaded.getForm().hasXFA()).toBe(false);
  });
});
