import { supportedEvidence, unknownEvidence, type EvidenceBlock, type EvidenceRef } from './types';

export type KnowledgeCardKind = 'formula' | 'term';

export interface KnowledgeCard {
  id: string;
  paperId: string;
  kind: KnowledgeCardKind;
  label: string;
  content: string;
  evidence: EvidenceRef;
}

export interface KnowledgeCardOptions {
  terms?: readonly string[];
}

/** Builds cards only from supplied paper text or explicitly supplied terms. */
export function buildKnowledgeCards(blocks: readonly EvidenceBlock[], paperId: string, options: KnowledgeCardOptions = {}): KnowledgeCard[] {
  const ordered = [...blocks]
    .filter(block => block.paperId === paperId && block.text.trim().length > 0)
    .sort((left, right) => left.page - right.page || left.id.localeCompare(right.id));
  const cards: KnowledgeCard[] = [];
  for (const block of ordered) {
    if (block.type !== 'formula') continue;
    cards.push({ id: `formula-${cards.length + 1}`, paperId, kind: 'formula', label: 'Formula', content: block.text, evidence: supportedEvidence(block) });
  }
  for (const term of uniqueTerms(options.terms ?? [])) {
    const block = ordered.find(candidate => wholeWord(candidate.text, term));
    if (block === undefined) {
      cards.push({ id: `term-${cards.length + 1}`, paperId, kind: 'term', label: term, content: 'UNKNOWN', evidence: unknownEvidence(`The supplied term was not found in the local paper blocks: ${term}`) });
      continue;
    }
    cards.push({ id: `term-${cards.length + 1}`, paperId, kind: 'term', label: term, content: sentenceContaining(block.text, term), evidence: supportedEvidence(block) });
  }
  return cards;
}

function uniqueTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of terms) {
    const value = typeof term === 'string' ? term.trim() : '';
    const key = value.toLocaleLowerCase();
    if (value.length > 0 && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function wholeWord(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/[- ]+/gu, '[\\s-]+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, 'iu').test(text);
}

function sentenceContaining(text: string, term: string): string {
  for (const sentence of text.split(/(?<=[.!?。！？])\s+/u)) if (wholeWord(sentence, term)) return sentence.trim();
  return text.trim();
}
