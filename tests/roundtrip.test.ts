import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  rectPolygon,
  type Block,
  type DocumentIR,
  type PageRotation,
  type Translation,
} from '../src/core/ir';
import {
  checkRoundTrip,
  compareDocuments,
  type CodecLimitation,
} from '../src/core/roundtrip';

const SOURCE_SHA256 = 'a'.repeat(64);

const INTRO = 'Introduction to the manual for the reader of the scanned report.';
const BODY = 'The reader opens a document and can read every page of the scan.';
const ANNEX = 'Appendix A lists every command the reader accepts in the terminal.';
const ADDED = 'Added paragraph the second export carries but the first does not.';

const TRANSLATION: Translation = {
  blockId: 'p1-r0',
  lang: 'vi',
  engine: 'stub',
  modelVersion: 'm1',
  promptVersion: 'p1',
  text: 'Ban dich cua phan gioi thieu.',
  qaStatus: 'pass',
};

/**
 * A two-page document with three blocks and one translation, built through `buildDocument` so
 * ids, reading order and provenance are the real ones. Blocks land on ids `p1-r0`, `p1-r1`
 * and `p2-r0` because of their vertical order on the page.
 */
function baseDocument(): DocumentIR {
  return buildDocument({
    sourceSha256: SOURCE_SHA256,
    pages: [
      { index: 1, width: 612, height: 792 },
      { index: 2, width: 612, height: 792 },
    ],
    blocks: [
      { page: 1, text: INTRO, rect: { x: 72, y: 96, width: 468, height: 16 } },
      { page: 1, text: BODY, rect: { x: 72, y: 136, width: 468, height: 16 } },
      { page: 2, text: ANNEX, rect: { x: 72, y: 96, width: 468, height: 16 } },
    ],
    translations: [TRANSLATION],
  });
}

/** A plain-data copy, so a test can rewrite one field without touching the fixture. */
function clone(document: DocumentIR): DocumentIR {
  return JSON.parse(JSON.stringify(document)) as DocumentIR;
}

/** The base document with page `index` resized; unspecified dimensions keep their value. */
function pageSized(index: number, size: { width?: number; height?: number }): DocumentIR {
  const copy = clone(baseDocument());
  copy.pages = copy.pages.map(page => (page.index === index ? { ...page, ...size } : page));
  return copy;
}

/** The base document with page `index` rotated. */
function pageRotated(index: number, rotation: PageRotation): DocumentIR {
  const copy = clone(baseDocument());
  copy.pages = copy.pages.map(page => (page.index === index ? { ...page, rotation } : page));
  return copy;
}

/** The base document with one block's fields rewritten. */
function blockRewritten(id: string, update: Partial<Block>): DocumentIR {
  const copy = clone(baseDocument());
  copy.blocks = copy.blocks.map(block => (block.id === id ? { ...block, ...update } : block));
  return copy;
}

const ZERO_POLYGON = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
];

/** A codec that keeps every field except polygons, which it zeroes on the way out. */
function polygonDroppingCodec(): {
  encode: (document: DocumentIR) => string;
  decode: (payload: string) => DocumentIR;
} {
  return {
    encode: document =>
      JSON.stringify({
        ...document,
        blocks: document.blocks.map(block => ({ ...block, polygon: ZERO_POLYGON })),
      }),
    decode: payload => JSON.parse(payload) as DocumentIR,
  };
}

describe('compareDocuments', () => {
  it('reports two documents built from the same input as equal', () => {
    const comparison = compareDocuments(baseDocument(), baseDocument());

    expect(comparison.equal).toBe(true);
    expect(comparison.differences).toEqual([]);
    expect(comparison.summary.total).toBe(0);
    expect(comparison.summary.byKind).toEqual({ changed: 0, missing: 0, added: 0, moved: 0 });
    expect(comparison.summary.compared).toEqual({
      pages: 2,
      blocks: 3,
      translations: 1,
      provenance: 3,
      annotations: 0,
      exports: 0,
    });
  });

  it('reports a page size change only when it exceeds the tolerance', () => {
    const within = compareDocuments(baseDocument(), pageSized(2, { height: 792.005 }));
    expect(within.equal).toBe(true);
    expect(within.differences).toEqual([]);

    const beyond = compareDocuments(baseDocument(), pageSized(2, { height: 792.02 }));
    expect(beyond.equal).toBe(false);
    expect(beyond.differences).toEqual([
      { path: 'pages[2].height', before: 792, after: 792.02, kind: 'changed', area: 'page-size' },
    ]);
    expect(beyond.summary.byArea['page-size']).toBe(1);

    const strict = compareDocuments(baseDocument(), pageSized(2, { height: 792.005 }), {
      tolerance: 0.001,
    });
    expect(strict.differences.map(difference => difference.path)).toEqual(['pages[2].height']);
  });

  it('refuses an unusable tolerance instead of guessing one', () => {
    expect(() => compareDocuments(baseDocument(), baseDocument(), { tolerance: -1 })).toThrow(
      RangeError,
    );
  });

  it('reports a page the second document does not have', () => {
    const copy = clone(baseDocument());
    copy.pages = copy.pages.filter(page => page.index !== 2);

    const comparison = compareDocuments(baseDocument(), copy);

    expect(comparison.differences).toEqual([
      {
        path: 'pages[2]',
        before: { index: 2, width: 612, height: 792, rotation: 0 },
        after: null,
        kind: 'missing',
        area: 'page-presence',
      },
    ]);
    expect(comparison.summary.byArea['page-presence']).toBe(1);
  });

  it('reports a page rotation as an exact change', () => {
    const comparison = compareDocuments(baseDocument(), pageRotated(2, 90));

    expect(comparison.differences).toEqual([
      { path: 'pages[2].rotation', before: 0, after: 90, kind: 'changed', area: 'page-rotation' },
    ]);
  });

  it('reports a translation the second document does not have', () => {
    const copy = clone(baseDocument());
    copy.translations = [];

    const comparison = compareDocuments(baseDocument(), copy);

    expect(comparison.differences).toEqual([
      {
        path: 'translations[p1-r0/vi/stub]',
        before: TRANSLATION,
        after: null,
        kind: 'missing',
        area: 'translation-presence',
      },
    ]);
    expect(comparison.summary.byKind.missing).toBe(1);
    expect(comparison.summary.compared.translations).toBe(1);
  });

  it('reports a block the second document added', () => {
    const copy = clone(baseDocument());
    const anchor = copy.blocks.find(block => block.id === 'p2-r0');
    if (!anchor) throw new Error('the fixture needs a block with id p2-r0');
    copy.blocks = [
      ...copy.blocks,
      {
        ...anchor,
        id: 'p2-r1',
        polygon: rectPolygon({ x: 72, y: 176, width: 468, height: 16 }),
        readingOrder: anchor.readingOrder + 1,
        raw: ADDED,
      },
    ];

    const comparison = compareDocuments(baseDocument(), copy);

    expect(comparison.differences).toHaveLength(1);
    const [added] = comparison.differences;
    expect(added?.path).toBe('blocks[p2-r1]');
    expect(added?.kind).toBe('added');
    expect(added?.area).toBe('block-presence');
    expect(added?.before).toBeNull();
    expect((added?.after as Block).raw).toBe(ADDED);
    expect(comparison.summary.byKind).toEqual({ changed: 0, missing: 0, added: 1, moved: 0 });
  });

  it('matches a block whose id changed by its page and text, not as a removal plus an addition', () => {
    const comparison = compareDocuments(baseDocument(), blockRewritten('p1-r1', { id: 'p1-r7' }));

    expect(comparison.differences).toEqual([
      { path: 'blocks[p1-r1].id', before: 'p1-r1', after: 'p1-r7', kind: 'moved', area: 'block-id' },
    ]);
    expect(comparison.summary.byArea['block-presence']).toBe(0);
    expect(comparison.summary.compared.blocks).toBe(3);
  });

  it('matches a block that changed page and id by its text alone', () => {
    const comparison = compareDocuments(
      baseDocument(),
      blockRewritten('p2-r0', { id: 'p2-r9', page: 1 }),
    );

    expect(comparison.differences).toEqual([
      { path: 'blocks[p2-r0].id', before: 'p2-r0', after: 'p2-r9', kind: 'moved', area: 'block-id' },
      { path: 'blocks[p2-r0].page', before: 2, after: 1, kind: 'moved', area: 'block-page' },
    ]);
    expect(comparison.summary.byArea['block-presence']).toBe(0);
  });

  it('reports a page change on a block that kept its id as a changed field, not a move', () => {
    const comparison = compareDocuments(baseDocument(), blockRewritten('p2-r0', { page: 1 }));

    expect(comparison.differences).toEqual([
      { path: 'blocks[p2-r0].page', before: 2, after: 1, kind: 'changed', area: 'block-page' },
    ]);
  });

  it('reports a reflowed block in exact mode and accepts it in whitespace mode', () => {
    const reflowed = blockRewritten('p1-r0', {
      raw: 'Introduction to the  manual\nfor the reader of  the scanned report.',
    });

    const exact = compareDocuments(baseDocument(), reflowed);
    expect(exact.differences.map(difference => difference.path)).toEqual(['blocks[p1-r0].raw']);
    expect(exact.differences[0]?.area).toBe('block-text');

    const relaxed = compareDocuments(baseDocument(), reflowed, { text: 'whitespace' });
    expect(relaxed.equal).toBe(true);
    expect(relaxed.differences).toEqual([]);

    // A case change is not whitespace, so the relaxed mode still reports it.
    const recased = blockRewritten('p1-r0', { raw: INTRO.toUpperCase() });
    const strictCase = compareDocuments(baseDocument(), recased, { text: 'whitespace' });
    expect(strictCase.differences.map(difference => difference.path)).toEqual(['blocks[p1-r0].raw']);
  });

  it('reports two empty documents as equal', () => {
    const empty = (): DocumentIR => buildDocument({ blocks: [], sourceSha256: SOURCE_SHA256 });

    const comparison = compareDocuments(empty(), empty());

    expect(comparison.equal).toBe(true);
    expect(comparison.differences).toEqual([]);
    expect(comparison.summary.total).toBe(0);
    expect(comparison.summary.compared).toEqual({
      pages: 0,
      blocks: 0,
      translations: 0,
      provenance: 0,
      annotations: 0,
      exports: 0,
    });
  });

  it('lists differences in a fixed order across groups and within a record', () => {
    const before = baseDocument();
    const after = clone(baseDocument());
    after.pages = after.pages.map(page => (page.index === 1 ? { ...page, height: 793 } : page));
    after.blocks = after.blocks.map(block =>
      block.id === 'p1-r0' ? { ...block, raw: 'Rewritten introduction for the same page.' } : block,
    );
    after.translations = [];
    const anchor = after.blocks.find(block => block.id === 'p2-r0');
    if (!anchor) throw new Error('the fixture needs a block with id p2-r0');
    after.blocks = [
      ...after.blocks,
      {
        ...anchor,
        id: 'p2-r1',
        polygon: rectPolygon({ x: 72, y: 176, width: 468, height: 16 }),
        readingOrder: anchor.readingOrder + 1,
        raw: ADDED,
      },
    ];

    const comparison = compareDocuments(before, after);

    expect(comparison.differences.map(difference => difference.path)).toEqual([
      'pages[1].height',
      'blocks[p1-r0].raw',
      'blocks[p2-r1]',
      'translations[p1-r0/vi/stub]',
    ]);
    expect(comparison.differences.map(difference => difference.kind)).toEqual([
      'changed',
      'changed',
      'added',
      'missing',
    ]);
    expect(compareDocuments(before, after)).toEqual(comparison);
  });
});

describe('checkRoundTrip', () => {
  const encodeLossless = (document: DocumentIR): string => JSON.stringify(document);
  const decodeLossless = (payload: string): DocumentIR => JSON.parse(payload) as DocumentIR;

  const POLYGON_LIMITATION: CodecLimitation = {
    area: 'block-polygon',
    reason: 'This codec cannot carry polygons; it rebuilds them from the text box.',
  };

  it('accepts a lossless codec and reports no limitations', () => {
    expect(checkRoundTrip(baseDocument(), encodeLossless, decodeLossless)).toEqual({
      ok: true,
      differences: [],
      limitations: [],
    });
  });

  it('does not report a loss the codec declared in advance', () => {
    const codec = polygonDroppingCodec();
    const report = checkRoundTrip(baseDocument(), codec.encode, codec.decode, {
      limitations: [POLYGON_LIMITATION],
    });

    expect(report.ok).toBe(true);
    expect(report.differences).toEqual([]);
    expect(report.limitations).toEqual([{ ...POLYGON_LIMITATION, explained: 24 }]);
  });

  it('reports the same loss when the codec stays silent about it', () => {
    const codec = polygonDroppingCodec();
    const report = checkRoundTrip(baseDocument(), codec.encode, codec.decode);

    expect(report.ok).toBe(false);
    expect(report.limitations).toEqual([]);
    expect(report.differences).toHaveLength(24);
    expect(report.differences.every(difference => difference.area === 'block-polygon')).toBe(true);
    expect(report.differences[0]).toEqual({
      path: 'blocks[p1-r0].polygon[0].x',
      before: 72,
      after: 0,
      kind: 'changed',
      area: 'block-polygon',
    });
  });

  it('leaves a loss the codec did not declare as a difference', () => {
    const encode = (document: DocumentIR): string =>
      JSON.stringify({
        ...document,
        translations: [],
        blocks: document.blocks.map(block => ({ ...block, polygon: ZERO_POLYGON })),
      });
    const decode = (payload: string): DocumentIR => JSON.parse(payload) as DocumentIR;

    const report = checkRoundTrip(baseDocument(), encode, decode, {
      limitations: [POLYGON_LIMITATION],
    });

    expect(report.ok).toBe(false);
    expect(report.differences.map(difference => difference.area)).toEqual(['translation-presence']);
    expect(report.limitations).toEqual([{ ...POLYGON_LIMITATION, explained: 24 }]);
  });
});
