import { describe, expect, it } from 'vitest';
import {
  applyCanonical,
  checkConsistency,
  suggestCanonical,
  type ConsistencyReport,
  type Inconsistency,
  type TranslationPair,
} from '../viewer/src/core/consistency';

/** Two spellings of "Neural Network" the fixture documents below disagree on. */
const NEURAL_A = 'Mạng Nơ-Ron';
const NEURAL_B = 'Mạng Thần Kinh';

function block(blockId: string, page: number, source: string, target: string): TranslationPair {
  return { blockId, page, source, target };
}

function only(report: ConsistencyReport): Inconsistency {
  expect(report.inconsistencies).toHaveLength(1);
  const found = report.inconsistencies[0];
  if (!found) throw new Error('expected one inconsistency');
  return found;
}

describe('checkConsistency variants', () => {
  it('flags the same term translated two ways', () => {
    const report = checkConsistency([
      block('p1-r0', 1, 'The Neural Network learns quickly.', `${NEURAL_A} học nhanh.`),
      block('p1-r1', 1, 'The Neural Network needs data.', `${NEURAL_B} cần dữ liệu.`),
    ]);

    // A wording disagreement is a judgement call, not a defect.
    expect(report.ok).toBe(true);
    const finding = only(report);
    expect(finding.source).toBe('Neural Network');
    expect(finding.kind).toBe('phrase');
    expect(finding.severity).toBe('warn');
    const variants = new Map(finding.variants.map(variant => [variant.target, variant]));
    expect(variants.get(NEURAL_A)).toEqual({ target: NEURAL_A, blockIds: ['p1-r0'], count: 1 });
    expect(variants.get(NEURAL_B)).toEqual({ target: NEURAL_B, blockIds: ['p1-r1'], count: 1 });
  });

  it('flags acronym spellings of one term', () => {
    const report = checkConsistency([
      block('p1-r0', 1, 'The API returns JSON.', 'API trả về JSON.'),
      block('p2-r0', 2, 'Use the API key.', 'Dùng khóa A.P.I. để gọi.'),
    ]);

    const finding = only(report);
    expect(finding.source).toBe('API');
    expect(finding.kind).toBe('acronym');
    expect(finding.severity).toBe('warn');
    expect([...finding.variants.map(variant => variant.target)].sort()).toEqual(['A.P.I.', 'API']);
    expect(finding.variants.every(variant => variant.count === 1)).toBe(true);
  });

  it('never reports a term that appears in one block', () => {
    const report = checkConsistency([
      block('p1-r0', 1, 'The Neural Network learns quickly.', `${NEURAL_A} học nhanh.`),
      block('p1-r1', 1, 'The Data Pipeline runs nightly.', 'Luồng Dữ Liệu chạy hằng đêm.'),
    ]);
    expect(report.inconsistencies).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('keeps quiet about a glossary miss on a single occurrence', () => {
    // One observation is not a disagreement; qa.ts owns the per-pair check.
    const report = checkConsistency(
      [block('p1-r0', 1, 'The Data Pipeline runs nightly.', 'Luồng Dữ Liệu chạy hằng đêm.')],
      { glossary: [{ source: 'Data Pipeline', target: 'Đường Ống Dữ Liệu' }] },
    );
    expect(report.inconsistencies).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('reports a consistent document as ok', () => {
    const report = checkConsistency([
      block('p1-r0', 1, 'The Neural Network learns quickly.', `${NEURAL_A} học nhanh.`),
      block('p1-r1', 1, 'The Neural Network needs data.', `${NEURAL_A} cần dữ liệu.`),
    ]);
    expect(report).toEqual({ inconsistencies: [], ok: true });
  });
});

describe('checkConsistency glossary', () => {
  const pairs = [
    block('p1-r0', 1, 'The Neural Network learns quickly.', `${NEURAL_A} học nhanh.`),
    block('p1-r1', 1, 'The Neural Network needs data.', `${NEURAL_B} cần dữ liệu.`),
  ];

  it('turns a violated glossary term into an error', () => {
    const report = checkConsistency(pairs, { glossary: { 'Neural Network': NEURAL_A } });

    expect(report.ok).toBe(false);
    const finding = only(report);
    expect(finding.source).toBe('Neural Network');
    expect(finding.kind).toBe('glossary');
    expect(finding.severity).toBe('error');
    expect(finding.glossaryTarget).toBe(NEURAL_A);
    expect(finding.violatingBlockIds).toEqual(['p1-r1']);
    expect(finding.variants[0]).toEqual({ target: NEURAL_A, blockIds: ['p1-r0'], count: 1 });
    expect(finding.variants.find(variant => variant.target === NEURAL_B)).toEqual({
      target: NEURAL_B,
      blockIds: ['p1-r1'],
      count: 1,
    });
  });

  it('lists the mandated spelling even when the document never uses it', () => {
    const report = checkConsistency(pairs, { glossary: [{ source: 'Neural Network', target: 'Mạng Thần Kinh Đồng Bộ' }] });
    const finding = only(report);

    expect(finding.severity).toBe('error');
    expect(finding.violatingBlockIds).toEqual(['p1-r0', 'p1-r1']);
    expect(finding.variants[0]).toEqual({ target: 'Mạng Thần Kinh Đồng Bộ', blockIds: [], count: 0 });
  });

  it('orders errors before warnings', () => {
    const report = checkConsistency(
      [
        ...pairs,
        block('p2-r0', 2, 'The Data Pipeline runs nightly.', 'Luồng Dữ Liệu chạy hằng đêm.'),
        block('p2-r1', 2, 'The Data Pipeline is slow.', 'Đường Ống Dữ Liệu rất chậm.'),
      ],
      { glossary: [{ source: 'Neural Network', target: NEURAL_A }] },
    );

    expect(report.inconsistencies.map(finding => [finding.source, finding.severity])).toEqual([
      ['Neural Network', 'error'],
      ['Data Pipeline', 'warn'],
    ]);
    expect(report.ok).toBe(false);
  });
});

describe('suggestCanonical', () => {
  it('picks the spelling the most blocks use', () => {
    const finding = only(
      checkConsistency([
        block('p1-r0', 1, 'The Neural Network learns quickly.', `${NEURAL_A} học nhanh.`),
        block('p1-r1', 1, 'The Neural Network needs data.', `${NEURAL_A} cần dữ liệu.`),
        block('p2-r0', 2, 'The Neural Network is large.', `${NEURAL_B} rất lớn.`),
      ]),
    );

    // The majority spelling is also the shorter one, so length cannot be why it wins.
    expect(finding.variants[0]).toEqual({ target: NEURAL_A, blockIds: ['p1-r0', 'p1-r1'], count: 2 });
    expect(suggestCanonical(finding)).toEqual({ target: NEURAL_A, blockIds: ['p1-r0', 'p1-r1'], count: 2 });
  });

  it('breaks a tie on the longest spelling', () => {
    const finding = only(
      checkConsistency([
        block('p1-r0', 1, 'The Neural Network learns quickly.', `${NEURAL_A} học nhanh.`),
        block('p1-r1', 1, 'The Neural Network needs data.', `${NEURAL_B} cần dữ liệu.`),
      ]),
    );

    expect(NEURAL_B.length).toBeGreaterThan(NEURAL_A.length);
    expect(suggestCanonical(finding)?.target).toBe(NEURAL_B);
  });

  it('offers the glossary target ahead of a larger majority', () => {
    const finding = only(
      checkConsistency(
        [
          block('p1-r0', 1, 'The Neural Network learns quickly.', `${NEURAL_A} học nhanh.`),
          block('p1-r1', 1, 'The Neural Network needs data.', `${NEURAL_A} cần dữ liệu.`),
          block('p2-r0', 2, 'The Neural Network is large.', `${NEURAL_B} rất lớn.`),
        ],
        { glossary: [{ source: 'Neural Network', target: NEURAL_B }] },
      ),
    );

    // The requirement is the default even though the document uses the other spelling twice.
    expect(finding.severity).toBe('error');
    expect(finding.variants.find(variant => variant.target === NEURAL_A)?.count).toBe(2);
    expect(suggestCanonical(finding)?.target).toBe(NEURAL_B);
  });
});

describe('applyCanonical', () => {
  const pairs = [
    block('p1-r0', 1, 'The Neural Network learns quickly.', `${NEURAL_A} học nhanh.`),
    block('p1-r1', 1, 'The Neural Network needs data.', `${NEURAL_A} cần dữ liệu.`),
    block('p2-r0', 2, 'The Neural Network is large.', `${NEURAL_B} rất lớn.`),
  ];

  it('rewrites only the blocks that disagree with the accepted spelling', () => {
    const result = applyCanonical(pairs, [{ source: 'Neural Network', target: NEURAL_A }]);

    expect(result.changed).toEqual([
      {
        blockId: 'p2-r0',
        page: 2,
        before: `${NEURAL_B} rất lớn.`,
        after: `${NEURAL_A} rất lớn.`,
        replacements: [{ source: 'Neural Network', from: NEURAL_B, to: NEURAL_A, count: 1 }],
      },
    ]);
    expect(result.translations[0]).toBe(pairs[0]);
    expect(result.translations[1]).toBe(pairs[1]);
    expect(result.translations[2]?.target).toBe(`${NEURAL_A} rất lớn.`);
    // The input list is never mutated.
    expect(pairs[2]?.target).toBe(`${NEURAL_B} rất lớn.`);
  });

  it('rewrites every occurrence of the rejected spelling in one block', () => {
    const input = [
      block('p1-r0', 1, 'The Neural Network learns quickly.', `${NEURAL_A} và ${NEURAL_A} nữa.`),
      block('p1-r1', 1, 'The Neural Network needs data.', `${NEURAL_B} cần dữ liệu.`),
    ];
    const result = applyCanonical(input, [{ source: 'Neural Network', target: NEURAL_B }]);

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.replacements[0]).toEqual({
      source: 'Neural Network',
      from: NEURAL_A,
      to: NEURAL_B,
      count: 2,
    });
    expect(result.translations[0]?.target).toBe(`${NEURAL_B} và ${NEURAL_B} nữa.`);
    expect(result.translations[1]).toBe(input[1]);
  });

  it('ignores a blank target and an unknown source term', () => {
    const result = applyCanonical(pairs, [
      { source: 'Neural Network', target: '   ' },
      { source: 'Nothing Here', target: 'Không Có Gì' },
    ]);

    expect(result.changed).toEqual([]);
    expect(result.translations).toEqual(pairs);
  });

  it('treats a case-only difference as already canonical', () => {
    const input = [block('p1-r0', 1, 'The Neural Network learns.', `${NEURAL_A} học nhanh.`)];
    const result = applyCanonical(input, [{ source: 'Neural Network', target: NEURAL_A.toLowerCase() }]);

    expect(result.changed).toEqual([]);
    expect(result.translations[0]).toBe(input[0]);
  });
});
