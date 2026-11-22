import { RESEARCH_SCHEMA_VERSION, supportedEvidence, type EvidenceBlock, type EvidenceRef } from './types';

export interface CleanPaperBlock {
  id: string;
  paperId: string;
  page: number;
  type: NonNullable<EvidenceBlock['type']>;
  text: string;
  sourceText: string;
  section?: string;
  citations: string[];
  evidence: EvidenceRef;
}

export interface CleanPaper {
  version: number;
  paperId: string;
  blocks: CleanPaperBlock[];
  preserved: {
    formulas: string[];
    footnotes: string[];
    citations: string[];
  };
}

export interface ReflowOptions {
  maxCharsPerLine?: number;
  includeReferences?: boolean;
}

export interface ReflowedPaperBlock extends CleanPaperBlock {
  lines: string[];
}

export interface ReflowedPaper extends Omit<CleanPaper, 'blocks'> {
  blocks: ReflowedPaperBlock[];
  lineCount: number;
  safety: ReflowSafety;
}

export interface ReflowSafety {
  status: 'safe' | 'unsafe';
  warnings: string[];
  preservedFormulaIds: string[];
  preservedFootnoteIds: string[];
  preservedCitationTokens: string[];
}

export function cleanPaper(blocks: readonly EvidenceBlock[], paperId: string, options: { includeReferences?: boolean } = {}): CleanPaper {
  const ordered = [...blocks]
    .filter(block => block.paperId === paperId && (options.includeReferences === true || block.type !== 'reference'))
    .sort((left, right) => left.page - right.page || left.id.localeCompare(right.id));
  const cleaned = ordered.map(block => {
    const sourceText = block.text;
    const text = block.type === 'formula' ? sourceText : collapseWhitespace(sourceText);
    const citations = extractCitations(sourceText);
    const result: CleanPaperBlock = {
      id: block.id,
      paperId,
      page: block.page,
      type: block.type ?? 'other',
      text,
      sourceText,
      ...(block.section === undefined ? {} : { section: block.section }),
      citations,
      evidence: supportedEvidence(block),
    };
    return result;
  });
  return {
    version: RESEARCH_SCHEMA_VERSION,
    paperId,
    blocks: cleaned,
    preserved: {
      formulas: cleaned.filter(block => block.type === 'formula').map(block => block.sourceText),
      footnotes: cleaned.filter(block => block.type === 'footnote').map(block => block.sourceText),
      citations: [...new Set(cleaned.flatMap(block => block.citations))],
    },
  };
}

export function reflowPaper(paper: CleanPaper, options: ReflowOptions = {}): ReflowedPaper {
  const width = Number.isFinite(options.maxCharsPerLine) && (options.maxCharsPerLine ?? 0) > 0 ? Math.floor(options.maxCharsPerLine as number) : 88;
  const blocks = paper.blocks.map(block => ({ ...block, lines: block.type === 'formula' ? [block.sourceText] : wrapWithoutLoss(block.text, width) }));
  const safety = verifySafety(paper, blocks);
  return { version: RESEARCH_SCHEMA_VERSION, paperId: paper.paperId, blocks, preserved: clonePreserved(paper.preserved), lineCount: blocks.reduce((total, block) => total + block.lines.length, 0), safety };
}

export function reflowToMarkdown(paper: ReflowedPaper): string {
  const lines: string[] = [`# ${paper.paperId}`, ''];
  let lastSection: string | undefined;
  for (const block of paper.blocks) {
    if (block.section !== undefined && block.section !== lastSection) {
      if (lines.length > 2) lines.push('');
      lines.push(`## ${block.section}`, '');
      lastSection = block.section;
    }
    const prefix = block.type === 'formula' ? '$$' : block.type === 'footnote' ? '[^footnote]: ' : '';
    if (block.type === 'formula') {
      lines.push('$$', block.sourceText, '$$', '');
    } else {
      lines.push(`${prefix}${block.lines.join('\n')}`, '', `<!-- source page=${block.page} block=${block.id} evidence=${block.evidence.status} -->`);
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function toReflowJson(paper: CleanPaper | ReflowedPaper): string {
  return `${JSON.stringify(paper, null, 2)}\n`;
}

function wrapWithoutLoss(text: string, width: number): string[] {
  if (text.length === 0) return [''];
  const words = text.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      if (word.length <= width) current = word;
      else {
        for (let index = 0; index < word.length; index += width) lines.push(word.slice(index, index + width));
      }
      continue;
    }
    if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function extractCitations(value: string): string[] {
  const found: string[] = [];
  const patterns = [/@cite\{([^}]+)\}/giu, /\\cite\{([^}]+)\}/gu, /\[\s*(\d+(?:\s*[-,]\s*\d+)*)\s*\]/gu, /\(([^()]{2,80}?\b\d{4}[a-z]?)[^()]*\)/giu];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const citation = (match[0] ?? '').trim();
      if (citation && !found.includes(citation)) found.push(citation);
    }
  }
  return found;
}

function verifySafety(paper: CleanPaper, blocks: readonly ReflowedPaperBlock[]): ReflowSafety {
  const warnings: string[] = [];
  const byId = new Map(blocks.map(block => [block.id, block]));
  const preservedFormulaIds: string[] = [];
  const preservedFootnoteIds: string[] = [];
  const preservedCitationTokens = new Set<string>();
  for (const original of paper.blocks) {
    const result = byId.get(original.id);
    if (result === undefined) {
      warnings.push(`missing-block:${original.id}`);
      continue;
    }
    if (original.type === 'formula') {
      if (result.lines.length === 1 && result.lines[0] === original.sourceText) preservedFormulaIds.push(original.id);
      else warnings.push(`formula-changed:${original.id}`);
    }
    if (original.type === 'footnote') {
      const joined = result.lines.join(' ');
      if (joined.replace(/\s+/gu, ' ').trim() === original.text.replace(/\s+/gu, ' ').trim()) preservedFootnoteIds.push(original.id);
      else warnings.push(`footnote-changed:${original.id}`);
    }
    const joined = result.lines.join(' ');
    for (const citation of original.citations) {
      if (joined.includes(citation)) preservedCitationTokens.add(citation);
      else warnings.push(`citation-changed:${original.id}:${citation}`);
    }
  }
  return { status: warnings.length === 0 ? 'safe' : 'unsafe', warnings, preservedFormulaIds, preservedFootnoteIds, preservedCitationTokens: [...preservedCitationTokens] };
}
function clonePreserved(preserved: CleanPaper['preserved']): CleanPaper['preserved'] {
  return { formulas: [...preserved.formulas], footnotes: [...preserved.footnotes], citations: [...preserved.citations] };
}
