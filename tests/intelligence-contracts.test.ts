import { describe, expect, it } from 'vitest';
import { BatchQueue, type BatchJob } from '../src/core/queue';
import { highlightShape, parseCitations, resolveCitations } from '../src/core/citations';
import { buildDocument, validate, type BuildBlockInput, type DocumentIR } from '../src/core/ir';
import { index, chunkDocument, search } from '../src/core/retrieval';
import { defineSchema, extractFields } from '../src/core/schema';
import { FakeEngine, type OcrResult, type OcrWord } from '../src/ocr/engine';
import { runOcr } from '../src/ocr/pipeline';
import { groupTextItems } from '../src/pdf/layout';
import type { PageModel, TextBlock } from '../src/core/types';

const SOURCE_SHA256 = 'b'.repeat(64);

function pdfPage(): PageModel {
  const blocks = groupTextItems(
    [
      { str: 'Invoice record', transform: [18, 0, 0, 18, 40, 760], width: 130, height: 18, fontName: 'heading' },
      { str: 'Invoice number: INV-2024-001', transform: [12, 0, 0, 12, 40, 710], width: 190, height: 12, fontName: 'body' },
      { str: 'Issued: 12/03/2024', transform: [12, 0, 0, 12, 40, 670], width: 120, height: 12, fontName: 'body' },
    ],
    [1, 0, 0, -1, 0, 800],
    1,
    { heading: { ascent: 1, descent: 0 }, body: { ascent: 1, descent: 0 } },
  );
  return { number: 1, width: 600, height: 800, blocks };
}

function image(width = 400, height = 300): ImageData {
  return {
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  } as ImageData;
}

function word(text: string, confidence: number, x: number, y: number, width = 100): OcrWord {
  return { text, confidence, bbox: { x0: x, y0: y, x1: x + width, y1: y + 20 } };
}

function ocrResult(): OcrResult {
  const words = [word('Status: Paid', 92, 40, 50)];
  return { text: 'Status: Paid', words, lines: [], width: 400, height: 300 };
}

function pdfInputs(page: PageModel): BuildBlockInput[] {
  return page.blocks.map(block => ({
    id: block.id,
    page: block.page,
    text: block.text,
    rect: block.rect,
    type: block.text === 'Invoice record' ? 'heading' : 'paragraph',
    origin: 'pdf-text',
    language: 'en',
  }));
}

function buildFixture(): Promise<{ ir: DocumentIR; ocrBlock: TextBlock }> {
  const page = pdfPage();
  const engine = new FakeEngine(ocrResult());
  return runOcr({ image: image(), engine, languages: ['eng'], page: 2, preprocess: false }).then(ocrPage => {
    const ocrBlock = ocrPage.blocks[0];
    if (!ocrBlock) throw new Error('OCR fixture did not produce a block');

    const ir = buildDocument({
      sourceSha256: SOURCE_SHA256,
      documentId: 'invoice-fixture',
      revisionId: 'rev-contract-1',
      language: 'en',
      pages: [
        { index: 1, width: page.width, height: page.height },
        { index: 2, width: ocrPage.width, height: ocrPage.height },
      ],
      blocks: [
        ...pdfInputs(page),
        {
          id: ocrBlock.id,
          page: ocrBlock.page,
          text: ocrBlock.text,
          rect: ocrBlock.rect,
          type: 'paragraph',
          origin: 'ocr',
          language: 'en',
          confidence: ocrPage.ocr.meanConfidence / 100,
        },
      ],
      ocrEngine: 'fake-ocr',
      model: 'ocr-fixture-v1',
    });
    return { ir, ocrBlock };
  });
}

function fieldBlocks(ir: DocumentIR) {
  return ir.blocks.map(block => ({
    id: block.id,
    page: block.page,
    raw: block.raw,
    polygon: block.polygon,
    confidence: block.confidence,
  }));
}

async function flushQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('document intelligence composition contracts', () => {
  it('composes PDF geometry, IR, OCR provenance, retrieval, citation highlight, schema extraction and automation status', async () => {
    const { ir } = await buildFixture();

    // PDF page model -> canonical DocumentIR, preserving page geometry and validity.
    expect(ir.blocks.map(block => block.raw)).toEqual([
      'Invoice record',
      'Invoice number: INV-2024-001',
      'Issued: 12/03/2024',
      'Status: Paid',
    ]);
    expect(validate(ir)).toEqual([]);

    // OCR output -> IR provenance, with the engine/model identity attached to the OCR block.
    const ocrBlock = ir.blocks.find(block => block.raw === 'Status: Paid');
    expect(ocrBlock).toMatchObject({ id: 'p2-r0', page: 2, confidence: 0.92 });
    expect(ir.provenance.find(row => row.blockId === ocrBlock?.id)).toEqual({
      blockId: 'p2-r0',
      sourceBlockIds: [],
      ocrEngine: 'fake-ocr',
      model: 'ocr-fixture-v1',
      transform: 'ocr',
    });

    // IR -> retrieval context, retaining the identity needed to ground an answer.
    const context = search(index(chunkDocument(ir)), 'status paid')[0];
    expect(context).toBeDefined();
    expect(context?.chunk).toMatchObject({
      id: 'invoice-fixture:c1',
      documentId: 'invoice-fixture',
      blockIds: ['p1-r1', 'p1-r2', 'p2-r0'],
      headingPath: ['Invoice record'],
    });
    expect(context?.chunk.text).toContain('Status: Paid');

    // Retrieval-grounded answer -> citation marker -> exact IR block -> normalized highlight.
    const answer = `The invoice is paid [p2:r0].`;
    const parsed = parseCitations(answer);
    expect(parsed.cleaned).toBe('The invoice is paid.');
    const resolution = resolveCitations(parsed.citations, ir);
    expect(resolution.unresolved).toEqual([]);
    const resolved = resolution.resolved[0];
    expect(resolved).toMatchObject({ page: 2, blockId: 'p2-r0', rect: { x: 40, y: 50, width: 100, height: 20 } });
    const highlight = highlightShape(resolved!.rect!, resolved!);
    expect(highlight.unit).toEqual({ x: 0.1, y: 0.166667, width: 0.25, height: 0.066666 });

    // The same IR blocks -> schema extraction, with location and validation intact.
    const schema = defineSchema([
      { id: 'invoice', label: 'Invoice number', type: 'identifier', required: true },
      { id: 'status', label: 'Status', type: 'enum', required: true, enumValues: ['Paid', 'Unpaid'] },
    ]);
    const extracted = extractFields(fieldBlocks(ir), schema);
    expect(extracted.missing).toEqual([]);
    expect(extracted.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'invoice', value: 'INV-2024-001', blockId: 'p1-r1', valid: true }),
      expect.objectContaining({
        id: 'status',
        value: 'Paid',
        page: 2,
        blockId: 'p2-r0',
        rect: { x: 40, y: 50, width: 100, height: 20 },
        confidence: 0.828,
        valid: true,
        problems: [],
      }),
    ]));

    // Extracted field -> automation queue, with a truthful terminal status.
    const statusField = extracted.fields.find(field => field.id === 'status');
    if (!statusField) throw new Error('schema fixture did not produce the status field');
    const applied: string[] = [];
    const queue = new BatchQueue<{ fieldId: string; value: string }>({
      concurrency: 1,
      run: async (job: BatchJob<{ fieldId: string; value: string }>) => {
        applied.push(`${job.payload.fieldId}=${job.payload.value}`);
      },
    });
    queue.add({ id: 'automation:status', payload: { fieldId: statusField.id, value: statusField.value } });
    queue.start();
    await flushQueue();

    expect(applied).toEqual(['status=Paid']);
    expect(queue.status()).toEqual({
      state: 'done',
      totals: { jobs: 1, done: 1, failed: 0, cancelled: 0, pending: 0 },
      current: [],
    });
    expect(queue.progress()).toBe(100);
  });

  it('rebuilds the same composition deterministically without detaching evidence', async () => {
    const first = await buildFixture();
    const second = await buildFixture();

    expect(first.ir).toEqual(second.ir);
    const firstContext = search(index(chunkDocument(first.ir)), 'status paid')[0];
    const secondContext = search(index(chunkDocument(second.ir)), 'status paid')[0];
    expect(firstContext).toEqual(secondContext);
    expect(resolveCitations(parseCitations('Paid [p2:r0]').citations, first.ir)).toEqual(
      resolveCitations(parseCitations('Paid [p2:r0]').citations, second.ir),
    );
  });
});
