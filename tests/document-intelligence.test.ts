import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_INTELLIGENCE_SCHEMA,
  extractDocumentIntelligence,
  type IntelligencePageSource,
} from '../src/core/document-intelligence';
import type { TextBlock } from '../src/core/types';

function block(id: string, page: number, text: string): TextBlock {
  return {
    id,
    page,
    text,
    rect: { x: 10, y: 20, width: 240, height: 18 },
    fontSize: 12,
    fontFamily: 'sans-serif',
    color: '#202724',
    direction: 'ltr',
    rotation: 0,
  };
}

const embedded: IntelligencePageSource = {
  page: 1,
  sourceKind: 'embedded-text',
  confidence: 1,
  provenance: 'PDF text layer; decoded locally.',
};

const ocr: IntelligencePageSource = {
  page: 2,
  sourceKind: 'local-ocr',
  confidence: 0.52,
  provenance: 'Local OCR fallback; Tesseract mean confidence 52%.',
};

describe('document intelligence', () => {
  it('extracts local evidence and carries page provenance into the result', () => {
    const result = extractDocumentIntelligence([
      block('p1-r0', 1, 'A vector chart.'),
      block('p1-r1', 1, 'Numbers must not change: 42, 2026.'),
    ], [embedded], BUILT_IN_INTELLIGENCE_SCHEMA);

    expect(result.missing).toEqual([]);
    expect(result.evidence).toMatchObject([
      {
        id: 'numbers',
        value: '42, 2026.',
        blockId: 'p1-r1',
        state: 'evidence',
      },
    ]);
  });

  it('marks OCR-backed values low confidence without hiding their source', () => {
    const result = extractDocumentIntelligence([
      block('ocr-p2-1', 2, 'Generated locally: verification.'),
    ], [ocr], [{ id: 'source', label: 'Generated locally', type: 'text', required: true }]);

    expect(result.evidence[0]).toMatchObject({
      sourceKind: 'local-ocr',
      pageConfidence: 0.52,
      provenance: ocr.provenance,
      state: 'low-confidence',
    });
    expect(result.evidence[0]?.confidence).toBeCloseTo(0.468, 3);
  });

  it('returns required gaps instead of inventing values', () => {
    const result = extractDocumentIntelligence(
      [block('p1-r0', 1, 'A paragraph without the requested label.')],
      [embedded],
      [{ id: 'invoice', label: 'Invoice number', type: 'identifier', required: true }],
    );

    expect(result.evidence).toEqual([]);
    expect(result.missing).toEqual([{ id: 'invoice', label: 'Invoice number' }]);
  });
});
