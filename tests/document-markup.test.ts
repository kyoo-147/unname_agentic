import { describe, expect, it } from 'vitest';
import { buildDocument } from '../src/core/ir';
import { extractDocumentMarkup } from '../src/core/document-markup';
import { mapPoint } from '../src/core/deskew';
import { dewarpForOcr, DewarpError, normalizeForOcr, type RgbaImage } from '../src/ocr/preprocess';

const HASH = 'c'.repeat(64);

function image(width = 100, height = 80): RgbaImage {
  return { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof DewarpError) return error.code;
    throw error;
  }
  throw new Error('expected a DewarpError');
}

describe('local OCR dewarp contract', () => {
  it('rejects malformed rasters, unsafe angles, and output budgets', () => {
    expect(codeOf(() => dewarpForOcr({ data: new Uint8ClampedArray(3), width: 1, height: 1 }, 2))).toBe('invalid-image');
    expect(codeOf(() => dewarpForOcr({ data: new Uint8ClampedArray(3), width: 1, height: 1 }, 2))).toBe('invalid-image');
    expect(normalizeForOcr({ data: new Uint8ClampedArray(3), width: 1, height: 1 }).dewarp).toMatchObject({ status: 'unknown' });
    expect(codeOf(() => dewarpForOcr(image(), Number.NaN))).toBe('invalid-angle');
    expect(codeOf(() => dewarpForOcr(image(), 90))).toBe('unsupported-angle');
    expect(codeOf(() => dewarpForOcr(image(), 2, { maxPixels: 1 }))).toBe('pixel-budget');
  });

  it('records the rotation-only correction and maps geometry back to source pixels', () => {
    const result = dewarpForOcr(image(), 2);
    expect(result.provenance).toMatchObject({
      status: 'applied',
      measuredSkewDeg: 2,
      correctionDeg: -2,
      sourceWidth: 100,
      sourceHeight: 80,
      mappedBackToSource: true,
    });
    const source = { x: 72, y: 31 };
    const dewarped = mapPoint(source, result.transform.sourceToOutput);
    const restored = mapPoint(dewarped, result.transform.outputToSource);
    expect(restored.x).toBeCloseTo(source.x, 8);
    expect(restored.y).toBeCloseTo(source.y, 8);
  });

  it('keeps an already-square page byte-identical and marks dewarp as not needed', () => {
    const source = image();
    const result = dewarpForOcr(source, 0);
    expect(result.image).toBe(source);
    expect(result.transform.sourceToOutput).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(result.provenance.status).toBe('not-needed');
  });
});

describe('document markup extraction', () => {
  it('classifies existing PDF text without inventing a provider result', () => {
    const document = buildDocument({
      documentId: 'markup-doc',
      revisionId: 'rev-1',
      sourceSha256: HASH,
      language: 'en',
      pages: [{ index: 1, width: 612, height: 792, rotation: 0 }],
      blocks: [
        { id: 'heading', page: 1, text: 'Results', rect: { x: 72, y: 80, width: 180, height: 22 }, confidence: 1, origin: 'pdf-text' },
        { id: 'body', page: 1, text: 'The local document remains available for review.', rect: { x: 72, y: 130, width: 360, height: 14 }, confidence: 1, origin: 'pdf-text' },
      ],
    });

    const result = extractDocumentMarkup(document);
    expect(result.status).toBe('supported');
    expect(result.nodes.map(node => node.type)).toEqual(['heading', 'paragraph']);
    expect(result.nodes.every(node => node.evidence.status === 'supported')).toBe(true);
    expect(result.markdown).toContain('# Results');
    expect(result.markdown).toContain('The local document remains available for review.');
  });

  it('preserves local OCR confidence and provenance in markup nodes', () => {
    const document = buildDocument({
      sourceSha256: HASH,
      pages: [{ index: 1, width: 400, height: 400, rotation: 0 }],
      blocks: [{ id: 'ocr-source', page: 1, text: '• Check the scan', rect: { x: 20, y: 20, width: 180, height: 16 }, confidence: 0.62, origin: 'ocr' }],
      ocrEngine: 'fake-local-ocr',
    });

    const result = extractDocumentMarkup(document);
    expect(result.status).toBe('supported');
    expect(result.nodes[0]).toMatchObject({
      type: 'list',
      confidence: 0.589,
      evidence: { status: 'supported', source: 'local-ocr' },
    });
  });

  it('returns UNVERIFIED semantics when text has no trusted OCR/provider receipt', () => {
    const blocks = [{
      id: 'imported',
      page: 1,
      text: 'Imported heading',
      rect: { x: 20, y: 20, width: 180, height: 20 },
      fontSize: 18,
      pageHeight: 400,
    }];
    const first = extractDocumentMarkup(blocks);
    const second = extractDocumentMarkup(blocks);

    expect(first).toEqual(second);
    expect(first.status).toBe('unverified');
    expect(first.nodes[0]?.evidence).toMatchObject({ status: 'unverified', source: 'unknown' });
  });

  it('returns UNKNOWN instead of empty fabricated markup when no text evidence exists', () => {
    expect(extractDocumentMarkup([])).toEqual({
      status: 'unknown',
      nodes: [],
      markdown: '',
      reasons: ['markup:unknown:no-text-blocks'],
    });
  });
});
