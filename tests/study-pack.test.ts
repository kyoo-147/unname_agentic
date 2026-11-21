import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  type BlockType,
  type BuildBlockInput,
  type DocumentIR,
} from '../src/core/ir';
import {
  buildStudyPack,
  CSV_RECORD_SEPARATOR,
  filterGroundedQuestions,
  fromJson,
  QUESTION_KINDS,
  STUDY_PACK_VERSION,
  toAnkiCsv,
  toAnkiTsv,
  toJson,
  toMarkdown,
  toMermaid,
  TSV_RECORD_SEPARATOR,
  verifyAnswerKey,
  verifyCitation,
  verifyStudyPack,
  type CandidateQuestionInput,
  type SourceCitation,
  type StudyPack,
} from '../src/core/study-pack';

const SOURCE_SHA256 = 'b'.repeat(64);

function block(page: number, text: string, type: BlockType, y: number): BuildBlockInput {
  return { page, text, type, rect: { x: 0, y, width: 420, height: 16 } };
}

function docOf(blocks: readonly BuildBlockInput[], language = 'en', documentId = 'doc-bio-101'): DocumentIR {
  return buildDocument({ blocks, sourceSha256: SOURCE_SHA256, language, documentId });
}

function blockByText(ir: DocumentIR, snippet: string) {
  const found = ir.blocks.find(entry => entry.raw.includes(snippet));
  if (!found) throw new Error(`No block containing ${JSON.stringify(snippet)}`);
  return found;
}

function foldSpace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function buildSampleBiologyAndPhysicsIr(): DocumentIR {
  return docOf([
    block(1, 'Cellular Energy', 'heading', 0),
    block(
      1,
      'Photosynthesis is the metabolic process that converts light energy into chemical energy in chloroplasts. Chlorophyll is defined as the green pigment that absorbs photons.',
      'paragraph',
      20,
    ),
    block(
      1,
      'Photosynthesis generates ATP and NADPH by capturing photons in Chlorophyll.',
      'paragraph',
      40,
    ),
    block(2, 'Thermodynamics and Comparison', 'heading', 0),
    block(2, 'The photon energy relation E = h f governs absorption.', 'paragraph', 20),
    block(
      2,
      'Aerobic respiration yields 38 ATP molecules per glucose, whereas Fermentation yields only 2 ATP molecules.',
      'paragraph',
      40,
    ),
    block(
      2,
      'Note: Oxygen acts as the final electron acceptor in aerobic respiration.',
      'paragraph',
      60,
    ),
  ]);
}

describe('buildStudyPack: cited flashcards and Anki export', () => {
  it('builds cited definition, formula, and key-point flashcards rooted in notes.ts', () => {
    const ir = buildSampleBiologyAndPhysicsIr();
    const pack = buildStudyPack(ir);

    expect(pack.version).toBe(STUDY_PACK_VERSION);
    expect(pack.documentId).toBe('doc-bio-101');
    expect(pack.notes.definitions.map(d => d.term)).toEqual(['Photosynthesis', 'Chlorophyll']);
    expect(pack.notes.formulas.map(f => f.latex)).toEqual(['E = h f']);

    const defCard = pack.flashcards.find(
      card => card.kind === 'definition' && card.front.includes('Photosynthesis'),
    );
    expect(defCard).toBeDefined();
    expect(defCard?.back).toBe(
      'the metabolic process that converts light energy into chemical energy in chloroplasts',
    );
    const photoBlock = blockByText(ir, 'Photosynthesis is the metabolic process');
    expect(defCard?.citation).toEqual({
      documentId: 'doc-bio-101',
      page: 1,
      blockId: photoBlock.id,
      excerpt:
        'Photosynthesis is the metabolic process that converts light energy into chemical energy in chloroplasts.',
    });

    const formulaCard = pack.flashcards.find(card => card.kind === 'formula');
    expect(formulaCard).toBeDefined();
    expect(formulaCard?.latex).toBe('E = h f');
    const energyBlock = blockByText(ir, 'E = h f');
    expect(formulaCard?.citation).toEqual({
      documentId: 'doc-bio-101',
      page: 2,
      blockId: energyBlock.id,
      excerpt: 'The photon energy relation E = h f governs absorption.',
    });

    const pointCard = pack.flashcards.find(
      card => card.kind === 'point' && card.back.includes('Oxygen acts as the final electron acceptor'),
    );
    expect(pointCard).toBeDefined();
    expect(pointCard?.citation.page).toBe(2);
    expect(pointCard?.citation.blockId).toBe(blockByText(ir, 'Oxygen acts as').id);

    for (const card of pack.flashcards) {
      expect(verifyCitation(card.citation, ir).valid).toBe(true);
    }
  });

  it('exports cited flashcards to RFC 4180 Anki CSV and tab-safe Anki TSV', () => {
    const ir = docOf([
      block(1, 'Terms', 'heading', 0),
      block(1, 'Catalysis is the "core" process, speeding up\treactions.', 'paragraph', 20),
      block(2, 'Physics', 'heading', 0),
      block(2, 'The rest energy is E = mc^2 in relativity.', 'paragraph', 20),
    ]);

    const pack = buildStudyPack(ir, { includePointCards: false });
    const csv = toAnkiCsv(pack);
    const csvRows = csv.split(CSV_RECORD_SEPARATOR);

    expect(csvRows).toHaveLength(2);
    expect(csvRows[0]).toContain('"What is Catalysis?"');
    expect(csvRows[0]).toContain('"the ""core"" process, speeding up reactions"');
    expect(csvRows[0]).toContain('doc-bio-101');
    expect(csvRows[0]).toContain('p.1 · p1-r1');
    expect(csvRows[1]).toContain('"\\(E = mc^{2}\\)"');
    expect(csvRows[1]).toContain('p.2 · p2-r1');

    const tsv = toAnkiTsv(pack);
    const tsvRows = tsv.split(TSV_RECORD_SEPARATOR);
    expect(tsvRows).toHaveLength(2);
    for (const row of tsvRows) {
      const cols = row.split('\t');
      expect(cols).toHaveLength(4);
      expect(cols[2]).toContain('doc-bio-101');
    }
    expect(tsvRows[0]).toContain('What is Catalysis?');
    expect(tsvRows[1]).toContain('\\(E = mc^{2}\\)');
  });
});

describe('buildStudyPack: review questions and grounded answer keys', () => {
  it('generates definition, formula, mechanism, and comparison questions with exact citations', () => {
    const ir = buildSampleBiologyAndPhysicsIr();
    const pack = buildStudyPack(ir);

    const kinds = new Set(pack.questions.map(q => q.kind));
    for (const kind of QUESTION_KINDS) {
      expect(kinds.has(kind)).toBe(true);
    }

    const formulaQ = pack.questions.find(q => q.kind === 'formula');
    expect(formulaQ).toBeDefined();
    expect(formulaQ?.prompt).not.toContain('E = h f');
    expect(formulaQ?.answerKey.answer).toBe('E = h f');
    expect(formulaQ?.answerKey.latex).toBe('E = h f');

    const mechQ = pack.questions.find(q => q.kind === 'mechanism');
    expect(mechQ).toBeDefined();
    expect(mechQ?.answerKey.answer).toContain('capturing photons in Chlorophyll');

    const compQ = pack.questions.find(q => q.kind === 'comparison');
    expect(compQ).toBeDefined();
    expect(compQ?.answerKey.answer).toContain('Aerobic respiration');
    expect(compQ?.answerKey.answer).toContain('Fermentation');

    for (const question of pack.questions) {
      expect(question.grounded).toBe(true);
      expect(question.answerKey.citations.length).toBeGreaterThan(0);
      for (const citation of question.answerKey.citations) {
        expect(citation.documentId).toBe('doc-bio-101');
        expect(citation.page).toBeGreaterThanOrEqual(1);
        expect(citation.blockId.length).toBeGreaterThan(0);
        const sourceBlock = ir.blocks.find(b => b.id === citation.blockId);
        expect(sourceBlock).toBeDefined();
        expect(sourceBlock?.page).toBe(citation.page);
        expect(foldSpace(sourceBlock?.raw ?? '')).toContain(foldSpace(citation.excerpt));
      }
      expect(verifyAnswerKey(question.answerKey, ir).supported).toBe(true);
    }
  });

  it('rejects unsupported claims across citation mismatches and fabricated facts', () => {
    const ir = buildSampleBiologyAndPhysicsIr();
    const photoBlock = blockByText(ir, 'Photosynthesis is the metabolic process');
    const respBlock = blockByText(ir, 'Aerobic respiration yields 38 ATP');

    const validCitation: SourceCitation = {
      documentId: 'doc-bio-101',
      page: 1,
      blockId: photoBlock.id,
      excerpt:
        'Photosynthesis is the metabolic process that converts light energy into chemical energy in chloroplasts.',
    };

    expect(verifyAnswerKey({ answer: 'Unfounded claim', citations: [] }, ir)).toMatchObject({
      supported: false,
      reasons: ['missing-citation'],
    });

    expect(
      verifyAnswerKey(
        {
          answer: 'Photosynthesis converts light energy into chemical energy.',
          citations: [{ ...validCitation, documentId: 'wrong-doc' }],
        },
        ir,
      ),
    ).toMatchObject({
      supported: false,
      reasons: ['document-mismatch'],
    });

    expect(
      verifyAnswerKey(
        {
          answer: 'Photosynthesis converts light energy into chemical energy.',
          citations: [{ ...validCitation, blockId: 'p99-r0' }],
        },
        ir,
      ),
    ).toMatchObject({
      supported: false,
      reasons: ['unknown-block'],
    });

    expect(
      verifyAnswerKey(
        {
          answer: 'Photosynthesis converts light energy into chemical energy.',
          citations: [{ ...validCitation, page: 2 }],
        },
        ir,
      ),
    ).toMatchObject({
      supported: false,
      reasons: ['page-mismatch'],
    });

    expect(
      verifyAnswerKey(
        {
          answer: 'Quantum tunneling breaks cryptography.',
          citations: [{ ...validCitation, excerpt: 'Quantum tunneling breaks cryptography.' }],
        },
        ir,
      ),
    ).toMatchObject({
      supported: false,
      reasons: ['excerpt-not-in-block'],
    });

    expect(
      verifyAnswerKey(
        {
          answer: 'Quantum computing factors integers in polynomial time.',
          citations: [validCitation],
        },
        ir,
      ),
    ).toMatchObject({
      supported: false,
      reasons: ['unsupported-claim'],
    });

    expect(
      verifyAnswerKey(
        {
          answer: 'Aerobic respiration yields 99 ATP molecules per glucose.',
          citations: [
            {
              documentId: 'doc-bio-101',
              page: 2,
              blockId: respBlock.id,
              excerpt:
                'Aerobic respiration yields 38 ATP molecules per glucose, whereas Fermentation yields only 2 ATP molecules.',
            },
          ],
        },
        ir,
      ),
    ).toMatchObject({
      supported: false,
      reasons: ['unsupported-claim'],
    });

    const candidates: CandidateQuestionInput[] = [
      {
        id: 'cand-good',
        kind: 'definition',
        prompt: 'What does Photosynthesis convert?',
        answer: 'Photosynthesis converts light energy into chemical energy in chloroplasts.',
        citations: [validCitation],
      },
      {
        id: 'cand-bad',
        kind: 'mechanism',
        prompt: 'How many ATP?',
        answer: 'Aerobic respiration yields 999 ATP molecules.',
        citations: [validCitation],
      },
    ];

    const filtered = filterGroundedQuestions(candidates, ir);
    expect(filtered.grounded.map(q => q.id)).toEqual(['cand-good']);
    expect(filtered.rejected).toHaveLength(1);
    expect(filtered.rejected[0]?.id).toBe('cand-bad');
    expect(filtered.rejected[0]?.reasons).toContain('unsupported-claim');

    const packWithCandidates = buildStudyPack(ir, { candidateQuestions: candidates });
    expect(packWithCandidates.rejectedClaims).toHaveLength(1);
    expect(packWithCandidates.summary.rejectedClaims).toBe(1);
    expect(packWithCandidates.questions.some(q => q.id === 'cand-good')).toBe(true);
    expect(packWithCandidates.questions.some(q => q.id === 'cand-bad')).toBe(false);
    expect(verifyStudyPack(packWithCandidates, ir).valid).toBe(true);
  });
});

describe('buildStudyPack: concept map, Mermaid graph TD, and deterministic serialization', () => {
  it('links every concept node to its source (page, blockId) and emits valid Mermaid graph TD', () => {
    const ir = buildSampleBiologyAndPhysicsIr();
    const pack = buildStudyPack(ir);
    const { conceptMap } = pack;

    expect(conceptMap.nodes.length).toBeGreaterThanOrEqual(4);
    expect(conceptMap.edges.length).toBeGreaterThanOrEqual(3);

    const knownBlocks = new Map(ir.blocks.map(b => [b.id, b]));
    const nodeIds = new Set(conceptMap.nodes.map(node => node.id));
    for (const node of conceptMap.nodes) {
      const sourceBlock = knownBlocks.get(node.blockId);
      expect(sourceBlock).toBeDefined();
      expect(sourceBlock?.page).toBe(node.page);
      expect(node.citation.page).toBe(node.page);
      expect(node.citation.blockId).toBe(node.blockId);
      expect(node.citation.documentId).toBe('doc-bio-101');
      expect(foldSpace(sourceBlock?.raw ?? '')).toContain(foldSpace(node.citation.excerpt));
    }

    for (const edge of conceptMap.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
      expect(verifyCitation(edge.citation, ir).valid).toBe(true);
    }

    const lines = conceptMap.mermaid.split('\n');
    expect(lines[0]).toBe('graph TD');
    expect(conceptMap.mermaid).toContain('Photosynthesis');
    expect(conceptMap.mermaid).toContain('Chlorophyll');
    for (const line of lines.slice(1)) {
      const isNodeLine = /^  [A-Za-z][A-Za-z0-9_]*\["[^"\n]*"\]$/u.test(line);
      const isEdgeLine = /^  [A-Za-z][A-Za-z0-9_]* -->\|[^|\n]+\| [A-Za-z][A-Za-z0-9_]*$/u.test(line);
      expect(isNodeLine || isEdgeLine).toBe(true);
    }

    expect(toMermaid(conceptMap)).toBe(conceptMap.mermaid);
  });

  it('produces deterministic JSON round-trip and Markdown with source links', () => {
    const ir = buildSampleBiologyAndPhysicsIr();
    const first = buildStudyPack(ir);
    const second = buildStudyPack(ir);

    const json1 = toJson(first);
    const json2 = toJson(second);
    expect(json1).toBe(json2);

    const roundTripped: StudyPack = fromJson(json1);
    expect(roundTripped).toEqual(first);
    expect(toJson(roundTripped)).toBe(json1);

    const md1 = toMarkdown(first);
    const md2 = toMarkdown(second);
    expect(md1).toBe(md2);
    expect(md1).toContain('# Study pack');
    expect(md1).toContain('## Flashcards');
    expect(md1).toContain('## Review Questions');
    expect(md1).toContain('## Concept Map');
    expect(md1).toContain('```mermaid\ngraph TD');
    expect(md1).toContain('p.1 · p1-r1');
    expect(md1).toContain('p.2 · p2-r1');
    expect(md1.endsWith('\n')).toBe(false);
  });

  it('handles an empty document cleanly without fabricating items', () => {
    const emptyIr = docOf([], 'en', 'doc-empty');
    const pack = buildStudyPack(emptyIr);

    expect(pack.flashcards).toEqual([]);
    expect(pack.questions).toEqual([]);
    expect(pack.conceptMap).toEqual({ nodes: [], edges: [], mermaid: 'graph TD' });
    expect(pack.rejectedClaims).toEqual([]);
    expect(pack.summary).toEqual({
      flashcards: 0,
      questions: 0,
      conceptNodes: 0,
      conceptEdges: 0,
      rejectedClaims: 0,
    });
    expect(toAnkiCsv(pack)).toBe('');
    expect(toAnkiTsv(pack)).toBe('');
    expect(toMarkdown(pack)).toBe('');
    expect(fromJson(toJson(pack))).toEqual(pack);
  });
});
