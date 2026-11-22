import type { CitationMarker } from '../citations';
import type { EvidenceBlock } from './types';

export type ResearchCitationStatus = 'supported' | 'unverified' | 'unknown';

export interface ResearchCitationSupport {
  status: ResearchCitationStatus;
  paperId: string;
  block?: EvidenceBlock;
  reason?: string;
}

/** Resolves a citation only inside the explicitly selected paper's evidence. */
export function resolveResearchCitationSupport(
  citation: CitationMarker,
  paperId: string,
  blocks: readonly EvidenceBlock[],
): ResearchCitationSupport {
  const paperBlocks = blocks.filter(block => block.paperId === paperId);
  if (citation.blockId) {
    const block = paperBlocks.find(candidate => candidate.id === citation.blockId);
    if (block && (citation.page === null || citation.page === block.page)) {
      return { status: 'supported', paperId, block };
    }
  }

  if (citation.page !== null && paperBlocks.some(block => block.page === citation.page)) {
    return {
      status: 'unverified',
      paperId,
      reason: 'A page has local evidence, but this exact block citation was not verified for the selected paper.',
    };
  }

  return {
    status: 'unknown',
    paperId,
    reason: citation.blockId
      ? `No exact block ${citation.blockId} was verified in the selected paper.`
      : 'No local evidence was supplied for the cited page in the selected paper.',
  };
}
