import { defineSchema, extractFields, type ExtractedField, type FieldBlock, type FieldExtractionResult, type FieldSchema } from './schema';
import type { TextBlock } from './types';

/** Where the current reader block came from. This slice never labels missing OCR as text. */
export type IntelligenceSourceKind = 'embedded-text' | 'local-ocr' | 'unknown';

export interface IntelligencePageSource {
  page: number;
  sourceKind: IntelligenceSourceKind;
  /** 0..1. Embedded PDF text is treated as directly decoded, not model confidence. */
  confidence: number;
  /** Human-readable local receipt for the current reader surface. */
  provenance: string;
}

export type IntelligenceEvidenceState = 'evidence' | 'low-confidence' | 'invalid';

export interface IntelligenceFieldEvidence extends ExtractedField {
  sourceKind: IntelligenceSourceKind;
  pageConfidence: number;
  provenance: string;
  state: IntelligenceEvidenceState;
}

export interface DocumentIntelligenceResult extends FieldExtractionResult {
  schema: FieldSchema[];
  evidence: IntelligenceFieldEvidence[];
}

/** A small, useful schema for a document that has caption-style lines. */
export const BUILT_IN_INTELLIGENCE_SCHEMA = [
  { id: 'numbers', label: 'Numbers must not change', type: 'text', required: true },
] as const;

/** Stable JSON shown in the editor, so the sample is also a copyable user schema. */
export const BUILT_IN_INTELLIGENCE_SCHEMA_JSON = JSON.stringify(BUILT_IN_INTELLIGENCE_SCHEMA, null, 2);

/**
 * Runs the existing local rule-based field extractor against the reader's current blocks.
 * It enriches the extractor's FieldBlock input with page source receipts, but does not
 * OCR, call a provider, or infer a value that is absent from the text layer.
 */
export function extractDocumentIntelligence(
  blocks: readonly TextBlock[],
  pages: readonly IntelligencePageSource[],
  schemaInput: unknown,
): DocumentIntelligenceResult {
  const schema = defineSchema(schemaInput);
  const pageByNumber = new Map(pages.map(page => [page.page, normalisePageSource(page)]));
  const fieldBlocks: FieldBlock[] = blocks.map(block => {
    const page = pageByNumber.get(block.page) ?? fallbackPageSource(block);
    return {
      id: block.id,
      page: block.page,
      text: block.text,
      rect: { ...block.rect },
      confidence: page.confidence,
    };
  });
  const extraction = extractFields(fieldBlocks, schema);
  const evidence = extraction.fields.map(field => {
    const page = pageByNumber.get(field.page) ?? fallbackPageSource({ id: field.blockId, page: field.page });
    const state: IntelligenceEvidenceState = !field.valid
      ? 'invalid'
      : field.confidence < 0.75
        ? 'low-confidence'
        : 'evidence';
    return {
      ...field,
      sourceKind: page.sourceKind,
      pageConfidence: page.confidence,
      provenance: page.provenance,
      state,
    };
  });
  return { ...extraction, schema, evidence };
}

function fallbackPageSource(block: Pick<TextBlock, 'id' | 'page'>): IntelligencePageSource {
  const sourceKind: IntelligenceSourceKind = block.id.startsWith('ocr-') ? 'local-ocr' : 'embedded-text';
  return sourceKind === 'local-ocr'
    ? { page: block.page, sourceKind, confidence: 0.5, provenance: 'Local OCR fallback; page confidence unavailable.' }
    : { page: block.page, sourceKind, confidence: 1, provenance: 'PDF text layer; decoded locally from the current document.' };
}

function normalisePageSource(page: IntelligencePageSource): IntelligencePageSource {
  const confidence = Number.isFinite(page.confidence) ? Math.max(0, Math.min(1, page.confidence)) : 0;
  const sourceKind = page.sourceKind === 'local-ocr' || page.sourceKind === 'embedded-text' ? page.sourceKind : 'unknown';
  const provenance = page.provenance.trim() || 'Provenance unavailable for this page.';
  return { page: Math.max(1, Math.trunc(page.page)), sourceKind, confidence, provenance };
}
