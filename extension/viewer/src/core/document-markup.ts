import { classifyBlocks, type BlockInput, type HeadingLevel, type SemanticBlockType } from './blocks';
import type { DocumentIR, Provenance } from './ir';
import type { Rect } from './types';

/** Evidence state for markup, kept separate from the semantic type guess. */
export type DocumentMarkupEvidenceStatus = 'supported' | 'unverified' | 'unknown';
export type DocumentMarkupSource = 'embedded-text' | 'local-ocr' | 'unknown';
export type DocumentMarkupStatus = DocumentMarkupEvidenceStatus;

export interface DocumentMarkupEvidence {
  status: DocumentMarkupEvidenceStatus;
  source: DocumentMarkupSource;
  page: number;
  blockId: string;
  quote: string;
  reason?: string;
  documentId?: string;
  sourceSha256?: string;
  revisionId?: string;
}

export interface DocumentMarkupNode {
  id: string;
  page: number;
  text: string;
  rect: Rect;
  type: SemanticBlockType;
  confidence: number;
  reasons: string[];
  headingLevel?: HeadingLevel;
  evidence: DocumentMarkupEvidence;
}

export interface DocumentMarkupResult {
  status: DocumentMarkupStatus;
  nodes: DocumentMarkupNode[];
  markdown: string;
  reasons: string[];
}

export type DocumentMarkupBlockInput = BlockInput & { confidence?: number };
export type DocumentMarkupInput = DocumentIR | readonly DocumentMarkupBlockInput[];

/**
 * Extracts deterministic semantic markup from the existing document blocks.
 * This is not an OCR engine: it only classifies text and geometry already
 * present in the input, and it never supplies text for an absent or empty block.
 */
export function extractDocumentMarkup(input: DocumentMarkupInput): DocumentMarkupResult {
  const source = sourceDocument(input);
  const blocks = source ? blocksFromDocument(source) : Array.isArray(input) ? [...input] : [];
  const classified = classifyBlocks(blocks);
  const sourceById = source ? provenanceByBlock(source.provenance) : new Map<string, Provenance>();
  const sourceConfidence = new Map<string, number>(blocks.map(block => [block.id ?? '', confidenceOf(block.confidence, 1)] as const));

  const nodes = classified
    .filter(block => block.text.trim().length > 0)
    .map((block, index) => {
      const id = block.id ?? `p${block.page ?? 1}-r${index}`;
      const provenance = sourceById.get(id);
      const evidence = evidenceForBlock({
        id,
        page: block.page ?? 1,
        text: block.text,
        provenance,
        document: source,
      });
      return {
        id,
        page: block.page ?? 1,
        text: block.text,
        rect: { ...block.rect },
        type: block.type,
        confidence: round4(confidenceOf(sourceConfidence.get(id)) * block.confidence),
        reasons: [...block.reasons],
        ...(block.headingLevel === undefined ? {} : { headingLevel: block.headingLevel }),
        evidence,
      } satisfies DocumentMarkupNode;
    });

  const status = resultStatus(nodes);
  return {
    status,
    nodes,
    markdown: renderDocumentMarkup(nodes),
    reasons: nodes.length === 0
      ? ['markup:unknown:no-text-blocks']
      : [`markup:${status}:nodes=${nodes.length}`],
  };
}

/** Alias for callers that already use the shorter markup vocabulary. */
export const extractMarkup = extractDocumentMarkup;

/** Renders extracted nodes without changing their text or claiming new evidence. */
export function renderDocumentMarkup(nodes: readonly DocumentMarkupNode[]): string {
  return nodes
    .map(node => {
      const text = node.text.trim();
      if (!text) return '';
      if (node.type === 'heading') return `${'#'.repeat(node.headingLevel ?? 1)} ${text}`;
      if (node.type === 'list' && !/^(?:[-*•▪◦‣∙·]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+/u.test(text)) return `- ${text}`;
      if (node.type === 'caption') return `> ${text}`;
      if (node.type === 'formula') return `$$${text}$$`;
      return text;
    })
    .filter(Boolean)
    .join('\n\n');
}

function sourceDocument(input: DocumentMarkupInput): DocumentIR | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const candidate = input as Partial<DocumentIR>;
  return candidate.schemaVersion === 1 && Array.isArray(candidate.blocks) && Array.isArray(candidate.pages)
    ? input as DocumentIR
    : undefined;
}

function blocksFromDocument(document: DocumentIR): DocumentMarkupBlockInput[] {
  const pageHeights = new Map<number, number>(document.pages.map(page => [page.index, page.height] as const));
  return document.blocks.map(block => {
    const rect = rectFromPolygon(block.polygon);
    return {
      id: block.id,
      page: block.page,
      pageHeight: pageHeights.get(block.page),
      text: block.raw,
      rect,
      fontSize: Math.max(1, rect.height),
      confidence: block.confidence,
    };
  });
}

function provenanceByBlock(rows: readonly Provenance[]): Map<string, Provenance> {
  const result = new Map<string, Provenance>();
  for (const row of rows) {
    if (!result.has(row.blockId)) result.set(row.blockId, row);
  }
  return result;
}

function evidenceForBlock(input: {
  id: string;
  page: number;
  text: string;
  provenance: Provenance | undefined;
  document: DocumentIR | undefined;
}): DocumentMarkupEvidence {
  const base = {
    page: input.page,
    blockId: input.id,
    quote: input.text,
    ...(input.document ? {
      documentId: input.document.documentId,
      sourceSha256: input.document.sourceSha256,
      revisionId: input.document.revisionId,
    } : {}),
  };
  if (input.provenance?.transform === 'pdf-text') {
    return { ...base, status: 'supported', source: 'embedded-text' };
  }
  if (input.provenance?.transform === 'ocr' && input.provenance.ocrEngine) {
    return { ...base, status: 'supported', source: 'local-ocr' };
  }
  return {
    ...base,
    status: 'unverified',
    source: 'unknown',
    reason: 'Markup type is inferred from local text and geometry without a trusted OCR/provider receipt.',
  };
}

function resultStatus(nodes: readonly DocumentMarkupNode[]): DocumentMarkupStatus {
  if (nodes.length === 0) return 'unknown';
  if (nodes.some(node => node.evidence.status === 'unknown')) return 'unknown';
  if (nodes.some(node => node.evidence.status === 'unverified')) return 'unverified';
  return 'supported';
}

function rectFromPolygon(polygon: readonly { x: number; y: number }[]): Rect {
  const points = polygon.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(0, Math.max(...xs) - left), height: Math.max(0, Math.max(...ys) - top) };
}

function confidenceOf(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
