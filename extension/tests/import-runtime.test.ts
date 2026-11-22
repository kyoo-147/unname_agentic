import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DocumentImportError,
  importDocument,
  importDocumentBytes,
  importLocalPath,
} from '../viewer/src/import';
import { sourceBytes } from '../viewer/src/import/source';
import { PdfImportError, importPdfBytes } from '../viewer/src/import/pdf';
import { sourceSha256 } from '../viewer/src/core/document-runtime';

const samplePath = resolve('extension/viewer/public/sample.pdf');

function bytes(values: readonly number[]): Uint8Array {
  return new Uint8Array(values);
}

function htmlFixture(): Uint8Array {
  return new TextEncoder().encode('<!doctype html><html lang="en"><head><title>Local page</title></head><body><h1>Heading</h1><p>Real local HTML content.</p></body></html>');
}

describe('production local document import', () => {
  it('reads a real local PDF path through PDF.js into immutable versioned IR', async () => {
    const imported = await importLocalPath(samplePath, { documentId: 'sample', revisionId: 'rev-1' });

    expect(imported.format).toBe('pdf');
    expect(imported.runtime?.runtimeSchemaVersion).toBe(1);
    expect(imported.ir.schemaVersion).toBe(1);
    expect(imported.ir.pages).toHaveLength(4);
    expect(imported.ir.blocks.length).toBeGreaterThan(0);
    expect(imported.ir.sourceSha256).toBe(imported.source.sha256);
    expect(imported.source.byteLength).toBe(imported.source.bytes.length);
    expect(imported.source.bytes).toEqual(Array.from(sourceBytes(imported.source)));
    expect(imported.source.sha256).toBe(sourceSha256(sourceBytes(imported.source)));
    expect(Object.isFrozen(imported.source)).toBe(true);
    expect(Object.isFrozen(imported.source.bytes)).toBe(true);
    expect(Object.isFrozen(imported.ir)).toBe(true);

    expect(() => {
      (imported.source.bytes as number[])[0] = 0;
    }).toThrow();
  });

  it('accepts a Blob while retaining the exact source bytes and hash', async () => {
    const original = await readFile(samplePath);
    const imported = await importDocument(new Blob([original]), { filename: 'sample.pdf' });

    expect(imported.source.byteLength).toBe(original.byteLength);
    expect(sourceBytes(imported.source)).toEqual(new Uint8Array(original));
    expect(imported.ir.sourceSha256).toBe(sourceSha256(new Uint8Array(original)));
  });

  it('imports HTML locally without treating markup as a PDF', async () => {
    const imported = await importDocumentBytes(htmlFixture(), { filename: 'notes.html' });

    expect(imported.format).toBe('html');
    expect(imported.runtime).toBeNull();
    expect(imported.metadata).toMatchObject({ format: 'html', title: 'Local page', language: 'en' });
    expect(imported.ir.blocks.map(block => block.raw)).toEqual(['Heading', 'Real local HTML content.']);
    expect(imported.ir.provenance.every(row => row.transform === 'import')).toBe(true);
  });

  it('preserves image input as a figure and routes text to the existing OCR contract', async () => {
    const png = bytes([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x20,
      0x08, 0x02, 0x00, 0x00, 0x00,
    ]);
    const imported = await importDocumentBytes(png, { filename: 'scan.png' });

    expect(imported.format).toBe('png');
    expect(imported.ir.blocks[0]).toMatchObject({ type: 'figure', raw: '', confidence: 0 });
    expect(imported.diagnostics.some(row => row.code === 'ocr-route-required')).toBe(true);
  });

  it('returns typed unsupported and malformed states without inventing content', async () => {
    await expect(importDocumentBytes(new TextEncoder().encode('plain text'), { filename: 'notes.txt' }))
      .rejects.toMatchObject({ code: 'unsupported-format', format: 'text' } satisfies Partial<DocumentImportError>);

    await expect(importPdfBytes(new TextEncoder().encode('%PDF-1.4\ntrailer\n<< /Encrypt 2 0 R >>\n%%EOF\n')))
      .rejects.toMatchObject({ code: 'password-required' } satisfies Partial<PdfImportError>);
  });
});
