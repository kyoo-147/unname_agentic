import { RESEARCH_SCHEMA_VERSION, supportedEvidence, type EvidenceBlock, type EvidenceRef } from './types';

export interface StudyFlashcard {
  id: string;
  question: string;
  answer: string;
  evidence: EvidenceRef;
}

export interface StudyQuestion {
  id: string;
  prompt: string;
  expectedEvidence: EvidenceRef;
}

export interface ConceptNode {
  id: string;
  label: string;
  evidence: EvidenceRef;
}

export interface ConceptEdge {
  from: string;
  to: string;
  relation: 'sequence' | 'same-section';
}

export interface StudyPack {
  version: number;
  packId: string;
  paperId: string;
  title: string;
  derivedFrom: string[];
  flashcards: StudyFlashcard[];
  questions: StudyQuestion[];
  conceptMap: { nodes: ConceptNode[]; edges: ConceptEdge[] };
}

export interface StudyPackInput {
  packId: string;
  paperId: string;
  title: string;
  blocks: readonly EvidenceBlock[];
  maxCards?: number;
}

export function buildStudyPack(input: StudyPackInput): StudyPack {
  const blocks = [...input.blocks]
    .filter(block => block.paperId === input.paperId && block.text.trim().length > 0)
    .sort((left, right) => left.page - right.page || left.id.localeCompare(right.id));
  const limit = Number.isFinite(input.maxCards) && (input.maxCards ?? 0) >= 0 ? Math.floor(input.maxCards as number) : 20;
  const selected = blocks.slice(0, limit);
  const flashcards = selected.map((block, index) => ({
    id: `card-${index + 1}`,
    question: block.section ? `What does the paper state in ${block.section}?` : 'What does this passage state?',
    answer: block.text,
    evidence: supportedEvidence(block),
  }));
  const questions = selected.map((block, index) => ({
    id: `question-${index + 1}`,
    prompt: block.section ? `Locate the evidence for the claim in ${block.section}.` : 'Locate the evidence for this passage.',
    expectedEvidence: supportedEvidence(block),
  }));
  const nodes = selected.map((block, index) => ({
    id: `concept-${index + 1}`,
    label: block.section ?? firstWords(block.text, 8),
    evidence: supportedEvidence(block),
  }));
  const edges: ConceptEdge[] = [];
  for (let index = 1; index < selected.length; index += 1) {
    const previous = selected[index - 1];
    const current = selected[index];
    if (previous && current) edges.push({ from: `concept-${index}`, to: `concept-${index + 1}`, relation: previous.section && previous.section === current.section ? 'same-section' : 'sequence' });
  }
  return {
    version: RESEARCH_SCHEMA_VERSION,
    packId: input.packId,
    paperId: input.paperId,
    title: input.title,
    derivedFrom: selected.map(block => block.id),
    flashcards,
    questions,
    conceptMap: { nodes, edges },
  };
}

export function toStudyPackJson(pack: StudyPack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

export function fromStudyPackJson(text: string): StudyPack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Study pack is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.version !== RESEARCH_SCHEMA_VERSION || typeof parsed.packId !== 'string' || typeof parsed.paperId !== 'string' || !Array.isArray(parsed.flashcards) || !Array.isArray(parsed.questions) || !isRecord(parsed.conceptMap)) throw new Error(`Study pack must declare version ${RESEARCH_SCHEMA_VERSION}.`);
  return JSON.parse(JSON.stringify(parsed)) as StudyPack;
}

function firstWords(text: string, count: number): string {
  return text.trim().split(/\s+/u).slice(0, count).join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
