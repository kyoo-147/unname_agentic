import { describe, expect, it } from 'vitest';
import { groupTextItems } from '../pdf/layout';
import {
  DOCUMENT_IR_SCHEMA_VERSION,
  IrError,
  addProvenance,
  addTranslation,
  buildDocument,
  deserialize,
  serialize,
  validate,
  type BuildDocumentInput,
  type DocumentIR,
  type Polygon,
  type Translation,
} from './ir';

// The IR is the key every later E/F/G item stores its output under: if ids or bytes
// move between two builds of the same page, translations and exports silently detach.
// The scheme itself is pinned here.

const SHA = '3f786850e387550fdab836ed7e6dc881de23001b2b1a2a9b3b7f7b0d0e6a1c44';

function sampleInput(): BuildDocumentInput {
  return {
    sourceSha256: SHA,
    language: 'en',
    pages: [
      { index: 1, width: 400, height: 600 },
      { index: 2, width: 400, height: 600 },
    ],
    blocks: [
      { page: 1, id: 'p1-r0', text: 'Title', rect: { x: 40, y: 40, width: 200, height: 20 }, type: 'heading' },
      { page: 1, id: 'p1-r1', text: 'Body', rect: { x: 40, y: 80, width: 300, height: 12 } },
      { page: 2, id: 'p2-r0', text: 'Second page', rect: { x: 40, y: 40, width: 200, height: 12 } },
    ],
  };
}

function sampleDocument(): DocumentIR {
  return buildDocument(sampleInput());
}

function vietnamese(ir: DocumentIR, blockId: string, text: string): Translation {
  return {
    blockId,
    lang: 'vi',
    engine: 'local',
    modelVersion: 'qwen3:4b',
    promptVersion: 'mirror-v1',
    text,
    qaStatus: 'unchecked',
  };
}

function codesOf(ir: DocumentIR): string[] {
  return validate(ir).map(problem => problem.code);
}

function thrownCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof IrError ? error.code : 'not-an-ir-error';
  }
  return 'no-error';
}

describe('document IR', () => {
  it('builds a clean document with derived pages, ids and reading order', () => {
    const ir = sampleDocument();
    expect(validate(ir)).toEqual([]);
    expect(ir.schemaVersion).toBe(DOCUMENT_IR_SCHEMA_VERSION);
    expect(ir.sourceSha256).toBe(SHA);
    expect(ir.documentId).toBe(`doc-${SHA.slice(0, 16)}`);
    expect(ir.revisionId).toBe('rev-1');
    expect(ir.language).toBe('en');
    expect(ir.pages.map(page => page.index)).toEqual([1, 2]);
    expect(ir.blocks.map(block => block.id)).toEqual(['p1-r0', 'p1-r1', 'p2-r0']);
    expect(ir.blocks.map(block => block.readingOrder)).toEqual([0, 1, 2]);
    expect(ir.blocks.map(block => block.raw)).toEqual(['Title', 'Body', 'Second page']);
    expect(ir.blocks[0]).toMatchObject({ type: 'heading', page: 1, language: 'en', confidence: 1, children: [] });
    expect(ir.blocks[0]!.polygon).toEqual([
      { x: 40, y: 40 },
      { x: 240, y: 40 },
      { x: 240, y: 60 },
      { x: 40, y: 60 },
    ]);
    expect(ir.provenance).toEqual([
      { blockId: 'p1-r0', sourceBlockIds: [], ocrEngine: null, model: null, transform: 'pdf-text' },
      { blockId: 'p1-r1', sourceBlockIds: [], ocrEngine: null, model: null, transform: 'pdf-text' },
      { blockId: 'p2-r0', sourceBlockIds: [], ocrEngine: null, model: null, transform: 'pdf-text' },
    ]);
    expect(ir.translations).toEqual([]);
    expect(ir.annotations).toEqual([]);
    expect(ir.exports).toEqual([]);
  });

  it('builds straight from the reader block list without an explicit page list', () => {
    const viewport = [1, 0, 0, -1, 0, 800];
    const blocks = groupTextItems(
      [
        { str: 'Title', transform: [18, 0, 0, 18, 40, 760], width: 60, height: 18 },
        { str: 'Body line', transform: [10, 0, 0, 10, 40, 730], width: 90, height: 10 },
      ],
      viewport,
      3,
    );
    const ir = buildDocument({ blocks, sourceSha256: SHA, language: 'en' });
    expect(validate(ir)).toEqual([]);
    expect(ir.blocks.map(block => block.id)).toEqual(['p3-r0', 'p3-r1']);
    expect(ir.blocks.map(block => block.raw)).toEqual(['Title', 'Body line']);
    expect(ir.pages).toHaveLength(1);
    expect(ir.pages[0]!.index).toBe(3);
    const rightEdge = Math.max(...ir.blocks.flatMap(block => block.polygon.map(point => point.x)));
    expect(ir.pages[0]!.width).toBeGreaterThanOrEqual(rightEdge);
  });

  it('orders blocks row-major across pages, not in input order', () => {
    const input = sampleInput();
    const ir = buildDocument({ ...input, blocks: [input.blocks[2]!, input.blocks[1]!, input.blocks[0]!] });
    expect(ir.blocks.map(block => block.id)).toEqual(['p1-r0', 'p1-r1', 'p2-r0']);
    expect(ir.blocks.map(block => block.raw)).toEqual(['Title', 'Body', 'Second page']);
  });

  it('reports duplicate block ids', () => {
    const ir = sampleDocument();
    ir.blocks[1]!.id = ir.blocks[0]!.id;
    const duplicates = validate(ir).filter(problem => problem.code === 'duplicate-id');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.path).toBe('blocks[1].id');
    expect(duplicates[0]!.message).toContain(ir.blocks[0]!.id);
  });

  it('reports a polygon outside its page', () => {
    const ir = sampleDocument();
    ir.blocks[0]!.polygon = [
      { x: 40, y: 40 },
      { x: 440, y: 40 },
      { x: 440, y: 60 },
      { x: 40, y: 60 },
    ];
    const outside = validate(ir).filter(problem => problem.code === 'polygon-out-of-bounds');
    expect(outside.map(problem => problem.path)).toEqual(['blocks[0].polygon[1]', 'blocks[0].polygon[2]']);
    expect(outside[0]!.message).toContain('page 1');
  });

  it('accepts a polygon that exactly touches the page edge', () => {
    const ir = sampleDocument();
    ir.blocks[0]!.polygon = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 600 },
      { x: 0, y: 600 },
    ];
    expect(validate(ir)).toEqual([]);
  });

  it('reports a polygon that is not four points', () => {
    const ir = sampleDocument();
    ir.blocks[0]!.polygon = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ] as unknown as Polygon;
    expect(codesOf(ir)).toEqual(['polygon-invalid']);
  });

  it('reports a translation that points at a missing block', () => {
    const ir = addTranslation(sampleDocument(), vietnamese(sampleDocument(), 'p9-r0', 'Xin chào'));
    expect(codesOf(ir)).toEqual(['translation-orphan']);
    expect(validate(ir)[0]!.path).toBe('translations[0].blockId');
  });

  it('reports a missing or malformed source hash', () => {
    const missing = sampleDocument();
    missing.sourceSha256 = '';
    expect(codesOf(missing)).toEqual(['invalid-source-sha256']);
    const malformed = sampleDocument();
    malformed.sourceSha256 = 'not-a-sha256';
    expect(codesOf(malformed)).toEqual(['invalid-source-sha256']);
  });

  it('reports an unsupported schema version and refuses to read or write it', () => {
    const ir = sampleDocument();
    ir.schemaVersion = 99;
    expect(codesOf(ir)).toEqual(['unsupported-schema-version']);
    expect(thrownCode(() => serialize(ir))).toBe('unsupported-version');

    const json = serialize(sampleDocument()).replace('"schemaVersion":1', '"schemaVersion":99');
    expect(() => deserialize(json)).toThrow(/schema version 99/);
    expect(thrownCode(() => deserialize(json))).toBe('unsupported-version');
  });

  it('reports a block whose page is not in pages', () => {
    const ir = sampleDocument();
    ir.pages = [ir.pages[0]!];
    const problems = validate(ir).filter(problem => problem.code === 'block-page-unknown');
    expect(problems).toHaveLength(1);
    expect(problems[0]!.path).toBe('blocks[2].page');
  });

  it('records one provenance row per block and transform, keeping OCR identity', () => {
    const input = sampleInput();
    const blocks = [{ ...input.blocks[0]!, origin: 'ocr' as const, confidence: 0.87 }, input.blocks[1]!, input.blocks[2]!];
    const ocrDocument = buildDocument({ ...input, blocks, ocrEngine: 'tesseract', model: 'qwen3:4b' });
    expect(validate(ocrDocument)).toEqual([]);
    expect(ocrDocument.blocks[0]!.confidence).toBe(0.87);
    expect(ocrDocument.provenance[0]).toEqual({
      blockId: 'p1-r0',
      sourceBlockIds: [],
      ocrEngine: 'tesseract',
      model: 'qwen3:4b',
      transform: 'ocr',
    });
    expect(ocrDocument.provenance[1]!.ocrEngine).toBeNull();

    const overridden = buildDocument({
      ...input,
      blocks,
      ocrEngine: 'tesseract',
      provenance: [{ blockId: 'p1-r0', sourceBlockIds: [], ocrEngine: null, model: 'mirror-merge-v1', transform: 'ocr' }],
    });
    expect(overridden.provenance).toHaveLength(3);
    expect(overridden.provenance[0]!.model).toBe('mirror-merge-v1');
    expect(overridden.provenance[0]!.ocrEngine).toBeNull();
    expect(validate(overridden)).toEqual([]);
  });

  it('reports provenance that points at missing blocks', () => {
    const ir = addProvenance(sampleDocument(), {
      blockId: 'p9-r0',
      sourceBlockIds: ['p8-r0'],
      ocrEngine: 'tesseract',
      model: null,
      transform: 'ocr',
    });
    const orphans = validate(ir).filter(problem => problem.code === 'provenance-orphan');
    expect(orphans.map(problem => problem.path)).toEqual(['provenance[3].blockId', 'provenance[3].sourceBlockIds[0]']);
  });

  it('accepts provenance that cites a real source block', () => {
    const ir = addProvenance(sampleDocument(), {
      blockId: 'p1-r1',
      sourceBlockIds: ['p1-r0'],
      ocrEngine: null,
      model: 'mirror-merge-v1',
      transform: 'restructure',
    });
    expect(validate(ir)).toEqual([]);
    expect(ir.provenance).toHaveLength(4);
  });

  it('reports a child that points at a missing block', () => {
    const ir = sampleDocument();
    ir.blocks[0]!.children = ['p9-r0'];
    expect(codesOf(ir)).toEqual(['child-orphan']);
    expect(validate(ir)[0]!.path).toBe('blocks[0].children[0]');
  });

  it('round-trips a v1 document byte for byte with stable key order', () => {
    const ir = sampleDocument();
    const once = serialize(ir);
    expect(once).not.toContain('\n');
    const reread = deserialize(once);
    expect(reread).toEqual(ir);
    expect(serialize(reread)).toBe(once);

    const raw = JSON.parse(once) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual([
      'schemaVersion',
      'documentId',
      'revisionId',
      'sourceSha256',
      'language',
      'pages',
      'blocks',
      'translations',
      'provenance',
      'annotations',
      'exports',
    ]);
    expect(Object.keys((raw.blocks as Array<Record<string, unknown>>)[0]!)).toEqual([
      'id',
      'type',
      'page',
      'polygon',
      'readingOrder',
      'raw',
      'language',
      'confidence',
      'children',
    ]);
  });

  it('derives the same ids from the same input twice, in any input order', () => {
    const first = sampleDocument();
    const second = sampleDocument();
    expect(second.blocks.map(block => block.id)).toEqual(first.blocks.map(block => block.id));
    expect(serialize(second)).toBe(serialize(first));

    const input = sampleInput();
    const shuffled = buildDocument({ ...input, blocks: [...input.blocks].reverse() });
    expect(shuffled.blocks.map(block => block.id)).toEqual(first.blocks.map(block => block.id));
    expect(serialize(shuffled)).toBe(serialize(first));
  });

  it('mutations copy the document without rewriting the source hash', () => {
    const original = sampleDocument();
    const translated = addTranslation(original, vietnamese(original, 'p1-r0', 'Tiêu đề'));

    expect(translated.sourceSha256).toBe(SHA);
    expect(translated.schemaVersion).toBe(DOCUMENT_IR_SCHEMA_VERSION);
    expect(translated.documentId).toBe(original.documentId);
    expect(translated.revisionId).toBe(original.revisionId);
    expect(translated.blocks).toEqual(original.blocks);
    expect(original.translations).toEqual([]);
    expect(validate(translated)).toEqual([]);

    const replaced = addTranslation(translated, vietnamese(translated, 'p1-r0', 'Tiêu đề mới'));
    expect(replaced.translations).toHaveLength(1);
    expect(replaced.translations[0]!.text).toBe('Tiêu đề mới');
    expect(replaced.sourceSha256).toBe(SHA);

    const otherEngine = addTranslation(replaced, { ...vietnamese(replaced, 'p1-r0', 'Tiêu đề'), engine: 'deepl' });
    expect(otherEngine.translations).toHaveLength(2);
    expect(otherEngine.translations.map(entry => entry.engine)).toEqual(['local', 'deepl']);
    expect(otherEngine.sourceSha256).toBe(SHA);

    const withProvenance = addProvenance(otherEngine, {
      blockId: 'p1-r0',
      sourceBlockIds: ['p1-r0'],
      ocrEngine: null,
      model: 'qwen3:4b',
      transform: 'translate',
    });
    expect(withProvenance.sourceSha256).toBe(SHA);
    expect(withProvenance.provenance).toHaveLength(4);
    expect(validate(withProvenance)).toEqual([]);
  });

  it('keeps annotations and export records through a round trip', () => {
    const ir = buildDocument({
      ...sampleInput(),
      annotations: [{ id: 'a1', page: 1, kind: 'note', text: 'Check this heading', createdAt: '2026-11-20T00:00:00Z' }],
      exports: [{ id: 'e1', format: 'pdf', createdAt: '2026-11-20T00:00:00Z', byteLength: 1024, sha256: SHA }],
    });
    expect(validate(ir)).toEqual([]);
    const reread = deserialize(serialize(ir));
    expect(reread.annotations).toEqual(ir.annotations);
    expect(reread.exports).toEqual(ir.exports);
  });

  it('reports a document that is not an object', () => {
    expect(validate(null as unknown as DocumentIR).map(problem => problem.code)).toEqual(['malformed-document']);
  });

  it('refuses JSON that is not a document', () => {
    expect(() => deserialize('{')).toThrow(/not valid JSON/);
    expect(thrownCode(() => deserialize('[]'))).toBe('malformed-document');
    expect(thrownCode(() => deserialize(JSON.stringify({ schemaVersion: 1, documentId: 'd' })))).toBe('malformed-document');
    expect(() => deserialize(JSON.stringify({ schemaVersion: 1, documentId: 'd' }))).toThrow(/revisionId/);
    expect(thrownCode(() => deserialize(JSON.stringify({ ...JSON.parse(serialize(sampleDocument())), blocks: null })))).toBe('malformed-document');
  });
});
