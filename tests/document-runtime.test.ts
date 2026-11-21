import { describe, expect, it } from 'vitest';
import {
  DocumentRuntimeError,
  deserializeRuntimeDocument,
  ImmutableRevisionStore,
  ingestDocument,
  serializeRuntimeDocument,
  sourceSha256,
  validateRuntimeDocument,
  type RuntimeDocument,
} from '../src/core/document-runtime';
import type { PageModel, TextBlock } from '../src/core/types';

const bytes = new TextEncoder().encode('%PDF-runtime-fixture%');

function block(page: number, id: string, text: string, x: number, y: number, width = 40, height = 10): TextBlock {
  return {
    id,
    page,
    text,
    rect: { x, y, width, height },
    fontSize: 10,
    fontFamily: 'fixture',
    color: '#000000',
    direction: 'ltr',
    rotation: 0,
  };
}

function fixturePages(): PageModel[] {
  return [
    {
      number: 1,
      width: 100,
      height: 100,
      blocks: [
        block(1, 'second', 'second line', 10, 20),
        block(1, 'first', 'first line', 10, 5),
      ],
    },
    { number: 2, width: 100, height: 100, blocks: [] },
    {
      number: 3,
      width: 100,
      height: 100,
      blocks: [block(3, 'caption', 'caption', 5, 5, 10, 10)],
    },
  ];
}

function ingest(revisionId = 'rev-1'): RuntimeDocument {
  return ingestDocument({
    pages: fixturePages(),
    sourceBytes: bytes,
    expectedSha256: sourceSha256(bytes),
    documentId: 'doc-fixture',
    revisionId,
    language: 'en',
    pageEvidence: [
      { page: 2, images: [{ rect: { x: 0, y: 0, width: 100, height: 100 } }], glyphCount: 0 },
      { page: 3, images: [{ rect: { x: 0, y: 0, width: 70, height: 100 } }], glyphCount: 7 },
    ],
  });
}

describe('document runtime seam', () => {
  it('ingests deterministic IR, preserves geometry and routes page kinds', () => {
    const runtime = ingest();

    expect(runtime.ir.sourceSha256).toBe(sourceSha256(bytes));
    expect(runtime.ir.pages.map(page => page.index)).toEqual([1, 2, 3]);
    expect(runtime.ir.blocks.map(block => block.raw)).toEqual(['first line', 'second line', 'caption']);
    expect(runtime.ir.blocks[0]?.readingOrder).toBe(0);
    expect(runtime.ir.blocks[0]?.polygon).toEqual([
      { x: 10, y: 5 },
      { x: 50, y: 5 },
      { x: 50, y: 15 },
      { x: 10, y: 15 },
    ]);
    expect(runtime.pageClassifications.map(page => page.kind)).toEqual(['born-digital', 'scanned', 'hybrid']);
    expect(runtime.ir.provenance.every(row => row.transform === 'pdf-text' && row.ocrEngine === null)).toBe(true);
  });

  it('rejects a source hash mismatch before building a revision', () => {
    expect(() => ingestDocument({
      pages: [fixturePages()[0]!],
      sourceBytes: bytes,
      expectedSha256: '0'.repeat(64),
    })).toThrowError(expect.objectContaining({ code: 'source-hash-mismatch' } satisfies Partial<DocumentRuntimeError>));
  });

  it('rejects malformed page models instead of normalising them into fake evidence', () => {
    expect(() => ingestDocument({
      pages: [{ number: 1, width: -1, height: 100, blocks: [] }],
      sourceBytes: bytes,
    })).toThrowError(expect.objectContaining({ code: 'invalid-input' } satisfies Partial<DocumentRuntimeError>));
  });

  it('round-trips the canonical runtime envelope byte-for-byte', () => {
    const runtime = ingest();
    const json = serializeRuntimeDocument(runtime);
    const restored = deserializeRuntimeDocument(json);

    expect(serializeRuntimeDocument(restored)).toBe(json);
    expect(validateRuntimeDocument(restored)).toEqual([]);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.ir.blocks)).toBe(true);
  });

  it('keeps revisions and returned documents immutable by value', () => {
    const first = ingest('rev-1');
    const second = ingest('rev-2');
    const empty = ImmutableRevisionStore.empty();
    const store1 = empty.put(first);
    const store2 = store1.put(second);

    expect(empty.latest('doc-fixture')).toBeUndefined();
    expect(store1.latest('doc-fixture')?.ir.revisionId).toBe('rev-1');
    expect(store2.latest('doc-fixture')?.ir.revisionId).toBe('rev-2');
    expect(store1.revisions('doc-fixture')).toEqual([{ documentId: 'doc-fixture', revisionId: 'rev-1' }]);
    expect(store2.revisions('doc-fixture')).toEqual([
      { documentId: 'doc-fixture', revisionId: 'rev-1' },
      { documentId: 'doc-fixture', revisionId: 'rev-2' },
    ]);

    expect(() => {
      (first.ir.blocks[0] as { raw: string }).raw = 'mutated';
    }).toThrow();
    expect(store1.latest('doc-fixture')?.ir.blocks[0]?.raw).toBe('first line');
  });
});
