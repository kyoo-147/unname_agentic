import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  type BlockType,
  type BuildBlockInput,
  type DocumentIR,
} from '../viewer/src/core/ir';
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
} from '../viewer/src/core/study-pack';

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

describe('buildStudyPack: Vietnamese and bilingual EN/VI study packs', () => {
  it('generates Vietnamese flashcards, 4-kind quiz questions, and concept map with exact citations', () => {
    const ir = docOf(
      [
        block(1, 'Sinh học thực vật', 'heading', 0),
        block(
          1,
          'Quang hợp là quá trình tổng hợp chất hữu cơ từ ánh sáng mặt trời. Diệp lục được định nghĩa là sắc tố xanh hấp thụ quang năng.',
          'paragraph',
          20,
        ),
        block(
          1,
          'Quang hợp tạo ra glucose bằng cách hấp thụ photon nhờ Diệp lục.',
          'paragraph',
          40,
        ),
        block(2, 'So sánh và Công thức', 'heading', 0),
        block(
          2,
          'Năng lượng photon tuân theo công thức E = h × f trong chân không.',
          'paragraph',
          20,
        ),
        block(
          2,
          'Hô hấp hiếu khí tạo ra 38 ATP, trong khi Lên men chỉ đạt 2 ATP trên mỗi phân tử glucose.',
          'paragraph',
          40,
        ),
        block(
          2,
          'Lưu ý: Oxy đóng vai trò chất nhận electron cuối cùng trong hô hấp hiếu khí.',
          'paragraph',
          60,
        ),
      ],
      'vi',
      'doc-vi-bio',
    );

    const pack = buildStudyPack(ir);

    expect(pack.language).toBe('vi');
    expect(pack.notes.definitions.map(d => d.term)).toEqual(['Quang hợp', 'Diệp lục']);

    const defCard = pack.flashcards.find(
      c => c.kind === 'definition' && c.front === 'Quang hợp là gì?',
    );
    expect(defCard).toBeDefined();
    expect(defCard?.back).toBe('quá trình tổng hợp chất hữu cơ từ ánh sáng mặt trời');
    expect(defCard?.citation.documentId).toBe('doc-vi-bio');
    expect(defCard?.citation.page).toBe(1);

    const kinds = new Set(pack.questions.map(q => q.kind));
    for (const kind of QUESTION_KINDS) {
      expect(kinds.has(kind)).toBe(true);
    }

    const mechQ = pack.questions.find(q => q.kind === 'mechanism');
    expect(mechQ?.prompt).toContain('Theo mục');
    expect(mechQ?.answerKey.answer).toContain('hấp thụ photon nhờ Diệp lục');

    const cmpQ = pack.questions.find(q => q.kind === 'comparison');
    expect(cmpQ?.prompt).toContain('được so sánh như thế nào');
    expect(cmpQ?.answerKey.answer).toContain('Hô hấp hiếu khí');
    expect(cmpQ?.answerKey.answer).toContain('Lên men');

    const formulaQ = pack.questions.find(q => q.kind === 'formula');
    expect(formulaQ?.answerKey.latex).toBe('E = h \\times f');

    expect(pack.conceptMap.mermaid).toContain('Quang hợp');
    expect(pack.conceptMap.mermaid).toContain('Diệp lục');
    expect(verifyStudyPack(pack, ir).valid).toBe(true);

    // Diacritic-folded grounding checks accept matching Vietnamese answer and reject wrong figure.
    const viCitation = defCard!.citation;
    expect(
      verifyAnswerKey(
        {
          answer: 'Quang hợp là quá trình tổng hợp chất hữu cơ từ ánh sáng mặt trời.',
          citations: [viCitation],
        },
        ir,
      ).supported,
    ).toBe(true);

    const cmpCitation = cmpQ!.answerKey.citations[0]!;
    expect(
      verifyAnswerKey(
        {
          answer: 'Hô hấp hiếu khí tạo ra 99 ATP trong mỗi chu trình.',
          citations: [cmpCitation],
        },
        ir,
      ),
    ).toMatchObject({ supported: false, reasons: ['unsupported-claim'] });
  });

  it('handles mixed English and Vietnamese sections inside one bilingual document', () => {
    const ir = docOf(
      [
        block(1, 'English Section', 'heading', 0),
        block(
          1,
          'Gradient descent is an optimization algorithm that minimizes loss. Momentum accelerates convergence by accumulating past gradients.',
          'paragraph',
          20,
        ),
        block(2, 'Phần tiếng Việt', 'heading', 0),
        block(
          2,
          'Hồi quy tuyến tính có nghĩa là mô hình hóa quan hệ tuyến tính giữa biến độc lập và biến phụ thuộc. Adam hội tụ nhanh hơn SGD khi dữ liệu thưa.',
          'paragraph',
          20,
        ),
      ],
      'en',
      'doc-bilingual',
    );

    const pack = buildStudyPack(ir);

    const enDef = pack.questions.find(
      q => q.kind === 'definition' && q.prompt === 'What is Gradient descent?',
    );
    const viDef = pack.questions.find(
      q => q.kind === 'definition' && q.prompt === 'Hồi quy tuyến tính là gì?',
    );
    expect(enDef).toBeDefined();
    expect(viDef).toBeDefined();

    const enMech = pack.questions.find(q => q.kind === 'mechanism');
    const viCmp = pack.questions.find(q => q.kind === 'comparison');
    expect(enMech?.prompt).toContain('According to "English Section"');
    expect(viCmp?.prompt).toContain('Trong mục "Phần tiếng Việt"');
    expect(verifyStudyPack(pack, ir).valid).toBe(true);
  });
});

describe('buildStudyPack: LaTeX cards and formula grounding', () => {
  it('distinguishes inline and display LaTeX cards and formats Anki MathJax delimiters', () => {
    const ir = docOf(
      [
        block(1, 'Equations', 'heading', 0),
        block(1, 'The inline ratio $a/b$ normalizes weights.', 'paragraph', 20),
        block(1, 'The quadratic root is \\(√(a^2 + b^2)\\) in Euclidean space.', 'paragraph', 40),
        block(2, 'Energy Law', 'heading', 0),
        block(2, '$$E = mc^2$$', 'formula', 20),
        block(2, 'Greek phase shift \\[α + β ≤ γ\\] holds for angles.', 'paragraph', 40),
      ],
      'en',
      'doc-latex',
    );

    const pack = buildStudyPack(ir, { includePointCards: false });
    const formulaCards = pack.flashcards.filter(c => c.kind === 'formula');

    expect(formulaCards).toHaveLength(4);
    expect(formulaCards.map(c => c.latex)).toEqual([
      '\\frac{a}{b}',
      '\\sqrt{a^{2} + b^{2}}',
      'E = mc^{2}',
      '\\alpha + \\beta \\le \\gamma',
    ]);
    expect(formulaCards.map(c => c.mathKind)).toEqual([
      'inline-math',
      'inline-math',
      'display-math',
      'display-math',
    ]);

    const tsv = toAnkiTsv(pack);
    const tsvRows = tsv.split(TSV_RECORD_SEPARATOR);
    expect(tsvRows).toHaveLength(4);
    expect(tsvRows[0]).toContain('\\(\\frac{a}{b}\\)');
    expect(tsvRows[1]).toContain('\\(\\sqrt{a^{2} + b^{2}}\\)');
    expect(tsvRows[2]).toContain('\\[E = mc^{2}\\]');
    expect(tsvRows[3]).toContain('\\[\\alpha + \\beta \\le \\gamma\\]');

    const csv = toAnkiCsv(pack);
    expect(csv).toContain('"\\[E = mc^{2}\\]"');
    expect(csv).toContain('"\\(\\frac{a}{b}\\)"');

    // Formula prompts must never leak the formula answer itself.
    for (const q of pack.questions.filter(item => item.kind === 'formula')) {
      expect(q.prompt).not.toContain(q.answerKey.answer);
      expect(verifyAnswerKey(q.answerKey, ir).supported).toBe(true);
    }

    // Subtle formula alteration with identical variables/digits must still be rejected.
    const energyBlock = blockByText(ir, '$$E = mc^2$$');
    expect(
      verifyAnswerKey(
        {
          answer: 'E = m^{2} c',
          latex: 'E = m^{2} c',
          citations: [
            {
              documentId: 'doc-latex',
              page: 2,
              blockId: energyBlock.id,
              excerpt: '$$E = mc^2$$',
            },
          ],
        },
        ir,
      ),
    ).toMatchObject({ supported: false, reasons: ['unsupported-claim'] });
  });
});

describe('buildStudyPack: Mermaid escaping, nested outline edges, and error guards', () => {
  it('escapes quotes, brackets, braces, pipes, LaTeX backslashes, backticks, and comments in Mermaid graph TD', () => {
    const ir = docOf(
      [
        block(1, 'Section "One" [A] (B) | %% #1 <tag>; `code`', 'heading', 0),
        block(
          1,
          'Matrix [M] is defined as the array of {x, y} with "quotes" and <T> | pipes; %% comment.',
          'paragraph',
          20,
        ),
        block(1, 'Compute $$\\frac{a}{b}$$ for normalization.', 'paragraph', 40),
      ],
      'en',
      'doc-escape',
    );

    const pack = buildStudyPack(ir);
    const { mermaid } = pack.conceptMap;
    const lines = mermaid.split('\n');

    expect(lines[0]).toBe('graph TD');
    expect(mermaid).not.toContain('%%');
    expect(mermaid).not.toContain('```');
    expect(mermaid).toContain('#quot;');
    expect(mermaid).toContain('#91;');
    expect(mermaid).toContain('#93;');
    expect(mermaid).toContain('#40;');
    expect(mermaid).toContain('#41;');
    expect(mermaid).toContain('#123;');
    expect(mermaid).toContain('#125;');
    expect(mermaid).toContain('#60;');
    expect(mermaid).toContain('#62;');
    expect(mermaid).toContain('#124;');
    expect(mermaid).toContain('#59;');
    expect(mermaid).toContain('#37;');
    expect(mermaid).toContain('#35;');
    expect(mermaid).toContain('#92;');
    expect(mermaid).toContain('#96;');

    for (const line of lines.slice(1)) {
      const isNodeLine = /^  [A-Za-z][A-Za-z0-9_]*\["[^"\n]*"\]$/u.test(line);
      const isEdgeLine = /^  [A-Za-z][A-Za-z0-9_]* -->\|[^|\n]+\| [A-Za-z][A-Za-z0-9_]*$/u.test(line);
      expect(isNodeLine || isEdgeLine).toBe(true);
    }

    // Fenced mermaid inside Markdown cannot be closed early by backticks inside labels.
    const md = toMarkdown(pack);
    const mermaidFences = md.match(/```/gu) ?? [];
    expect(mermaidFences).toHaveLength(2);
  });

  it('sanitizes reserved or unsafe node IDs in toMermaid and preserves hierarchy edges', () => {
    const ir = docOf(
      [
        block(1, 'Chapter 1', 'heading', 0),
        block(1, 'Subsection A', 'heading', 20),
        block(1, 'Entropy is defined as the measure of disorder in a system.', 'paragraph', 40),
      ],
      'en',
      'doc-hierarchy',
    );

    const chapBlock = blockByText(ir, 'Chapter 1');
    const subBlock = blockByText(ir, 'Subsection A');
    const pack = buildStudyPack(ir, {
      notesOptions: {
        headingLevels: { [chapBlock.id]: 1, [subBlock.id]: 2 },
      },
    });

    const chapNode = pack.conceptMap.nodes.find(n => n.label === 'Chapter 1');
    const subNode = pack.conceptMap.nodes.find(n => n.label === 'Subsection A');
    expect(chapNode).toBeDefined();
    expect(subNode).toBeDefined();
    expect(pack.conceptMap.edges).toContainEqual(
      expect.objectContaining({
        from: chapNode!.id,
        to: subNode!.id,
        relation: 'contains',
      }),
    );

    const customMermaid = toMermaid({
      nodes: [
        {
          id: 'end',
          label: 'Alpha "1"\nLine 2',
          kind: 'term',
          page: 1,
          blockId: subBlock.id,
          citation: subNode!.citation,
        },
        {
          id: 'bad id!',
          label: 'Beta | Gamma',
          kind: 'term',
          page: 1,
          blockId: subBlock.id,
          citation: subNode!.citation,
        },
      ],
      edges: [
        {
          from: 'end',
          to: 'bad id!',
          relation: 'compares',
          label: 'a | b',
          citation: subNode!.citation,
        },
      ],
    });

    const lines = customMermaid.split('\n');
    expect(lines[0]).toBe('graph TD');
    expect(lines[1]).toBe('  n1["Alpha #quot;1#quot; Line 2"]');
    expect(lines[2]).toBe('  n2["Beta #124; Gamma"]');
    expect(lines[3]).toBe('  n1 -->|a #124; b| n2');
  });

  it('respects excerpt caps without breaking block substring grounding and rejects malformed JSON', () => {
    const longSentence =
      'Optimization converges rapidly across convex objectives while preserving stability and numerical precision under strict memory constraints.';
    const ir = docOf(
      [
        block(1, 'Optimization', 'heading', 0),
        block(1, longSentence, 'paragraph', 20),
      ],
      'en',
      'doc-caps',
    );

    const pack = buildStudyPack(ir, { maxExcerptChars: 60, maxFlashcards: 1, maxQuestions: 1 });
    expect(pack.flashcards.length).toBeLessThanOrEqual(1);
    expect(pack.questions.length).toBeLessThanOrEqual(1);
    for (const card of pack.flashcards) {
      expect(Array.from(card.citation.excerpt).length).toBeLessThanOrEqual(60);
      expect(verifyCitation(card.citation, ir).valid).toBe(true);
    }

    expect(() => fromJson('not-json')).toThrow();
    expect(() => fromJson('[]')).toThrow();
    expect(() => fromJson(JSON.stringify({ version: 99 }))).toThrow();
  });
});
