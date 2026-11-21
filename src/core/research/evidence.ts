import { RESEARCH_SCHEMA_VERSION, supportedEvidence, unknownEvidence, unverifiedEvidence, type EvidenceBlock, type EvidenceRef, type EvidenceStatus } from './types';

export type ResearchAspectKind = 'methodology' | 'dataset' | 'metric' | 'limitation' | 'other';

export interface ResearchAspect {
  id: string;
  label: string;
  keywords: string[];
  kind?: ResearchAspectKind;
}

export interface ResearchMatrixPaper {
  paperId: string;
  title: string;
  blocks: EvidenceBlock[];
  metadata?: Partial<Record<string, string>>;
}

export interface ResearchMatrixCell {
  paperId: string;
  aspectId: string;
  text: string;
  section?: string;
  evidence: EvidenceRef;
}

export interface ResearchMatrixGap {
  paperId: string;
  aspectId: string;
  status: 'unknown' | 'unverified';
  reason: string;
}

export interface ResearchMatrix {
  version: number;
  rows: Array<{ paperId: string; title: string }>;
  columns: Array<{ aspectId: string; label: string; kind: ResearchAspectKind }>;
  cells: ResearchMatrixCell[];
  gaps: ResearchMatrixGap[];
}

export function buildResearchMatrix(papers: readonly ResearchMatrixPaper[], aspects: readonly ResearchAspect[]): ResearchMatrix {
  const usablePapers = uniqueById(papers);
  const usableAspects = uniqueAspects(aspects);
  const cells: ResearchMatrixCell[] = [];
  const gaps: ResearchMatrixGap[] = [];

  for (const paper of usablePapers) {
    const blocks = [...paper.blocks].filter(block => block.paperId === paper.paperId && block.text.trim().length > 0).sort(compareBlocks);
    for (const aspect of usableAspects) {
      const match = firstEvidence(blocks, aspect.keywords);
      if (match !== undefined) {
        cells.push({ paperId: paper.paperId, aspectId: aspect.id, text: match.text, ...(match.section ? { section: match.section } : {}), evidence: supportedEvidence(match) });
        continue;
      }
      const metadata = paper.metadata?.[aspect.id];
      if (typeof metadata === 'string' && metadata.trim().length > 0) {
        cells.push({ paperId: paper.paperId, aspectId: aspect.id, text: metadata.trim(), evidence: unverifiedEvidence('Metadata value has no exact local page/block evidence.') });
      } else {
        gaps.push({ paperId: paper.paperId, aspectId: aspect.id, status: blocks.length > 0 ? 'unknown' : 'unverified', reason: blocks.length > 0 ? 'No matching passage was found.' : 'No local evidence blocks were supplied.' });
      }
    }
  }

  return {
    version: RESEARCH_SCHEMA_VERSION,
    rows: usablePapers.map(paper => ({ paperId: paper.paperId, title: paper.title })),
    columns: usableAspects.map(aspect => ({ aspectId: aspect.id, label: aspect.label, kind: aspect.kind ?? 'other' })),
    cells,
    gaps,
  };
}

export function toResearchMatrixJson(matrix: ResearchMatrix): string {
  return `${JSON.stringify(normalizeMatrix(matrix), null, 2)}\n`;
}

export function fromResearchMatrixJson(text: string): ResearchMatrix {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Research matrix is not valid JSON.');
  }
  if (!isRecord(value) || value.version !== RESEARCH_SCHEMA_VERSION || !Array.isArray(value.rows) || !Array.isArray(value.columns) || !Array.isArray(value.cells) || !Array.isArray(value.gaps)) {
    throw new Error(`Research matrix must declare version ${RESEARCH_SCHEMA_VERSION} and all arrays.`);
  }
  return normalizeMatrix(value as unknown as ResearchMatrix);
}

export function matrixToMarkdown(matrix: ResearchMatrix): string {
  const normalized = normalizeMatrix(matrix);
  if (normalized.rows.length === 0 || normalized.columns.length === 0) return '';
  const cellByKey = new Map(normalized.cells.map(cell => [`${cell.paperId}\u0000${cell.aspectId}`, cell]));
  const gapByKey = new Map(normalized.gaps.map(gap => [`${gap.paperId}\u0000${gap.aspectId}`, gap]));
  const lines = [
    `| Paper | ${normalized.columns.map(column => escapeCell(column.label)).join(' | ')} |`,
    `| --- | ${normalized.columns.map(() => '---').join(' | ')} |`,
  ];
  for (const row of normalized.rows) {
    const values = normalized.columns.map(column => {
      const key = `${row.paperId}\u0000${column.aspectId}`;
      const cell = cellByKey.get(key);
      if (cell) return escapeCell(`${cell.text} [${cell.evidence.status}${anchorLabel(cell.evidence)}]`);
      const gap = gapByKey.get(key);
      return escapeCell(gap ? `${gap.status.toUpperCase()}: ${gap.reason}` : 'UNKNOWN');
    });
    lines.push(`| ${escapeCell(row.title)} | ${values.join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

function firstEvidence(blocks: readonly EvidenceBlock[], keywords: readonly string[]): EvidenceBlock | undefined {
  const usable = keywords.map(keyword => keyword.trim().toLocaleLowerCase()).filter(Boolean);
  if (usable.length === 0) return undefined;
  for (const block of blocks) {
    const text = block.text;
    const folded = text.toLocaleLowerCase();
    if (usable.some(keyword => wholeWord(folded, keyword))) return block;
  }
  return undefined;
}

function wholeWord(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/[- ]+/gu, '[\\s-]+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:s|es)?(?:$|[^\\p{L}\\p{N}_])`, 'iu').test(text);
}

function compareBlocks(left: EvidenceBlock, right: EvidenceBlock): number {
  return left.page - right.page || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function uniqueById(papers: readonly ResearchMatrixPaper[]): ResearchMatrixPaper[] {
  const seen = new Set<string>();
  return papers.filter(paper => {
    if (!paper || typeof paper.paperId !== 'string' || paper.paperId.trim().length === 0 || seen.has(paper.paperId)) return false;
    seen.add(paper.paperId);
    return true;
  });
}

function uniqueAspects(aspects: readonly ResearchAspect[]): ResearchAspect[] {
  const seen = new Set<string>();
  return aspects.filter(aspect => {
    if (!aspect || typeof aspect.id !== 'string' || aspect.id.trim().length === 0 || seen.has(aspect.id) || !aspect.keywords.some(keyword => keyword.trim().length > 0)) return false;
    seen.add(aspect.id);
    return true;
  });
}

function normalizeMatrix(matrix: ResearchMatrix): ResearchMatrix {
  return {
    version: RESEARCH_SCHEMA_VERSION,
    rows: matrix.rows.map(row => ({ paperId: row.paperId, title: row.title })),
    columns: matrix.columns.map(column => ({ aspectId: column.aspectId, label: column.label, kind: column.kind })),
    cells: matrix.cells.map(cell => ({ ...cell, evidence: cloneEvidence(cell.evidence) })),
    gaps: matrix.gaps.map(gap => ({ ...gap })),
  };
}

function cloneEvidence(evidence: EvidenceRef): EvidenceRef {
  return {
    status: evidence.status,
    ...(evidence.reason === undefined ? {} : { reason: evidence.reason }),
    ...(evidence.anchor === undefined ? {} : { anchor: { ...evidence.anchor, ...(evidence.anchor.polygon ? { polygon: evidence.anchor.polygon.map(point => ({ ...point })) } : {}) } }),
  };
}

function anchorLabel(evidence: EvidenceRef): string {
  if (evidence.anchor === undefined) return '';
  const page = evidence.anchor.page === undefined ? '?' : String(evidence.anchor.page);
  const block = evidence.anchor.blockId === undefined ? '?' : evidence.anchor.blockId;
  return ` p.${page}/${block}`;
}

function escapeCell(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
