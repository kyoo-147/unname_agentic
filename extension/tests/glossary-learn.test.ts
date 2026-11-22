import { describe, expect, it } from 'vitest';
import { GLOSSARY_MAX_ENTRIES, parseGlossary } from '../viewer/src/core/glossary';
import {
  DEFAULT_MIN_CONFIDENCE,
  GlossaryLearnError,
  mergeWithGlossary,
  proposeTerms,
  toGlossaryText,
} from '../viewer/src/core/glossary-learn';
import type { TermPair, TermProposal } from '../viewer/src/core/glossary-learn';

function pair(source: string, target: string, sourceLang = 'en', targetLang = 'vi'): TermPair {
  return { source, target, sourceLang, targetLang };
}

/** The same acronym, kept untranslated, twice. */
const GPU_PAIRS = [
  pair('The GPU handles matrix work.', 'Bộ xử lý GPU đảm nhận công việc ma trận.'),
  pair('A fast GPU shortens training.', 'Một GPU nhanh rút ngắn quá trình huấn luyện.'),
];

/** A product name, kept untranslated, mid-sentence twice. */
const PRODUCT_PAIRS = [
  pair('The MirrorPDF viewer keeps the layout intact.', 'Trình xem MirrorPDF giữ nguyên bố cục.'),
  pair('Our MirrorPDF exports a searchable copy.', 'Công cụ MirrorPDF của chúng tôi xuất một bản sao có thể tìm kiếm.'),
];

/** A term that was translated, in pairs of four tokens on each side that share no word. */
const TRANSLATED_PAIRS = [
  pair('Each Gateway forwards frames.', 'Jedes Übergang leitet Pakete.', 'en', 'de'),
  pair('One Gateway drops packets.', 'Ein Übergang verliert Rahmen.', 'en', 'de'),
];

function firstProposal(pairs: readonly TermPair[]): TermProposal {
  const { proposals } = proposeTerms(pairs);
  expect(proposals.length).toBeGreaterThan(0);
  return proposals[0]!;
}

describe('proposeTerms', () => {
  it('proposes an acronym with every occurrence and its evidence', () => {
    const result = proposeTerms(GPU_PAIRS);

    expect(result.rejected).toEqual([]);
    expect(result.proposals).toHaveLength(1);
    const [proposal] = result.proposals;
    expect(proposal!.source).toBe('GPU');
    expect(proposal!.target).toBe('GPU');
    expect(proposal!.occurrences).toBe(2);
    expect(proposal!.confidence).toBeGreaterThanOrEqual(DEFAULT_MIN_CONFIDENCE);
    expect(proposal!.evidence).toHaveLength(2);
  });

  it('proposes a capitalised product name that appears mid-sentence', () => {
    const proposal = firstProposal(PRODUCT_PAIRS);

    expect(proposal.source).toBe('MirrorPDF');
    expect(proposal.target).toBe('MirrorPDF');
    expect(proposal.occurrences).toBe(2);
    expect(proposal.confidence).toBeGreaterThanOrEqual(DEFAULT_MIN_CONFIDENCE);
  });

  it('aligns a short pair by position when no word is shared', () => {
    const result = proposeTerms(TRANSLATED_PAIRS);

    expect(result.rejected).toEqual([]);
    expect(result.proposals).toHaveLength(1);
    const [proposal] = result.proposals;
    expect(proposal!.source).toBe('Gateway');
    // The counterpart is the token at the proportional index, not a copy of the term.
    expect(proposal!.target).toBe('Übergang');
    expect(proposal!.occurrences).toBe(2);
  });

  it('rejects a one-off term at the occurrence floor', () => {
    const result = proposeTerms([
      pair('Only one entry mentions Kestrel here.', 'Chỉ một mục nhắc đến Kestrel ở đây.'),
    ]);

    expect(result.proposals).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    const [rejected] = result.rejected;
    expect(rejected!.source).toBe('Kestrel');
    expect(rejected!.code).toBe('below-occurrence-floor');
    expect(rejected!.occurrences).toBe(1);
    expect(rejected!.message).toContain('Kestrel');
  });

  it('applies the occurrence and confidence floors from its options', () => {
    const higherFloor = proposeTerms(GPU_PAIRS, { minOccurrences: 3 });
    expect(higherFloor.proposals).toEqual([]);
    expect(higherFloor.rejected.map(entry => entry.code)).toEqual(['below-occurrence-floor']);

    const strictConfidence = proposeTerms(GPU_PAIRS, { minConfidence: 0.99 });
    expect(strictConfidence.proposals).toEqual([]);
    expect(strictConfidence.rejected.map(entry => entry.code)).toEqual(['below-confidence']);
    expect(strictConfidence.rejected[0]!.confidence).toBeLessThan(0.99);
  });

  it('keeps excerpts inside the pair they came from', () => {
    const proposal = firstProposal(GPU_PAIRS);

    proposal.evidence.forEach((evidence, index) => {
      const source = GPU_PAIRS[index]!;
      expect(source.source).toContain(evidence.sourceExcerpt);
      expect(source.target).toContain(evidence.targetExcerpt);
      expect(evidence.sourceExcerpt).toContain('GPU');
      expect(evidence.targetExcerpt).toContain('GPU');
    });
  });

  it('cuts a long excerpt down to the window around the term', () => {
    const longPairs = [
      pair(
        'In the first campaign the fabrication team measured Zephyr reliability across twelve production lines and wrote every failure down.',
        'Trong chiến dịch đầu tiên, nhóm chế tạo đã đo độ tin cậy của Zephyr trên mười hai dây chuyền và ghi lại mọi hỏng hóc, kể cả những lần đo phải lặp lại sau khi hiệu chuẩn thiết bị đo.',
      ),
      pair(
        'Later the same team compared Zephyr throughput with the older tooling and published the numbers in the internal review of the quarter.',
        'Sau đó cùng nhóm đã so sánh thông lượng của Zephyr với công cụ cũ và công bố các con số trong buổi đánh giá nội bộ của quý đó, kèm theo biên bản đo chi tiết.',
      ),
    ];
    const proposal = firstProposal(longPairs);

    expect(proposal.source).toBe('Zephyr');
    proposal.evidence.forEach((evidence, index) => {
      const source = longPairs[index]!;
      expect(evidence.sourceExcerpt.length).toBeLessThan(source.source.length);
      expect(evidence.targetExcerpt.length).toBeLessThan(source.target.length);
      expect(source.source).toContain(evidence.sourceExcerpt);
      expect(source.target).toContain(evidence.targetExcerpt);
      expect(evidence.sourceExcerpt).toContain('Zephyr');
      expect(evidence.targetExcerpt).toContain('Zephyr');
    });
  });

  it('keeps only the requested number of excerpts', () => {
    const proposal = firstProposal(GPU_PAIRS.slice(0, 2));
    expect(proposeTerms(GPU_PAIRS, { maxEvidence: 1 }).proposals[0]!.evidence).toHaveLength(1);
    expect(proposal.evidence.length).toBe(2);
  });

  it('round-trips its proposals through parseGlossary', () => {
    const result = proposeTerms([...GPU_PAIRS, ...PRODUCT_PAIRS, ...TRANSLATED_PAIRS]);
    const text = toGlossaryText(result.proposals);

    expect(text.split('\n').filter(line => line.length > 0)).toHaveLength(result.proposals.length);
    for (const line of text.split('\n')) if (line) expect(line).toContain(' = ');

    const parsed = parseGlossary(text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.entries).toEqual(result.proposals.map(entry => ({ source: entry.source, target: entry.target })));
  });

  it('returns nothing for empty input', () => {
    expect(proposeTerms([])).toEqual({ proposals: [], rejected: [] });
    expect(mergeWithGlossary([], [])).toEqual({ entries: [], added: [], refused: [] });
    expect(toGlossaryText([])).toBe('');
  });

  it('refuses a malformed pair or option with the failing path', () => {
    const capture = (run: () => unknown): GlossaryLearnError => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(GlossaryLearnError);
        return error as GlossaryLearnError;
      }
      throw new Error('the call was expected to throw');
    };

    const option = capture(() => proposeTerms([], { minOccurrences: 0 }));
    expect(option.code).toBe('invalid-option');
    expect(option.path).toBe('options.minOccurrences');

    const malformed = capture(() =>
      proposeTerms([{ source: 1, target: 'x', sourceLang: 'en', targetLang: 'vi' } as unknown as TermPair]),
    );
    expect(malformed.code).toBe('invalid-pair');
    expect(malformed.path).toBe('pairs[0].source');
  });
});

describe('mergeWithGlossary', () => {
  it('refuses a proposal that conflicts with an existing term', () => {
    const glossary = [{ source: 'gpu', target: 'GPU' }];
    const proposal: TermProposal = {
      source: 'GPU',
      target: 'bộ vi xử lý đồ họa',
      occurrences: 3,
      confidence: 0.9,
      evidence: [{ sourceExcerpt: 'The GPU runs.', targetExcerpt: 'GPU chạy.' }],
    };

    const merged = mergeWithGlossary(glossary, [proposal]);

    expect(merged.entries).toEqual([{ source: 'gpu', target: 'GPU' }]);
    expect(merged.added).toEqual([]);
    expect(merged.refused).toHaveLength(1);
    const [refusal] = merged.refused;
    expect(refusal!.code).toBe('conflicting-target');
    expect(refusal!.source).toBe('GPU');
    expect(refusal!.target).toBe('bộ vi xử lý đồ họa');
    expect(refusal!.existing).toEqual({ source: 'gpu', target: 'GPU' });
    // The caller's glossary is untouched.
    expect(glossary).toEqual([{ source: 'gpu', target: 'GPU' }]);
  });

  it('adds an accepted proposal after the existing entries', () => {
    const merged = mergeWithGlossary(
      [{ source: 'GPU', target: 'bộ xử lý đồ họa' }],
      [{ source: 'MirrorPDF', target: 'MirrorPDF' }],
    );

    expect(merged.added).toEqual([{ source: 'MirrorPDF', target: 'MirrorPDF' }]);
    expect(merged.refused).toEqual([]);
    expect(merged.entries).toEqual([
      { source: 'GPU', target: 'bộ xử lý đồ họa' },
      { source: 'MirrorPDF', target: 'MirrorPDF' },
    ]);
  });

  it('refuses a proposal that repeats an existing target', () => {
    const merged = mergeWithGlossary([{ source: 'GPU', target: 'GPU' }], [{ source: 'gpu', target: 'gpu' }]);

    expect(merged.added).toEqual([]);
    expect(merged.refused[0]!.code).toBe('duplicate');
    expect(merged.entries).toEqual([{ source: 'GPU', target: 'GPU' }]);
  });

  it('refuses a term the glossary format cannot carry', () => {
    const merged = mergeWithGlossary([], [{ source: 'A = B', target: 'X' }]);

    expect(merged.entries).toEqual([]);
    expect(merged.refused[0]!.code).toBe('not-serialisable');
    expect(toGlossaryText([{ source: 'A = B', target: 'X' }, { source: 'GPU', target: 'GPU' }])).toBe('GPU = GPU\n');
  });

  it('stops at the glossary entry limit', () => {
    const full = Array.from({ length: GLOSSARY_MAX_ENTRIES }, (_, index) => ({
      source: `term ${index}`,
      target: `value ${index}`,
    }));

    const merged = mergeWithGlossary(full, [{ source: 'MirrorPDF', target: 'MirrorPDF' }]);

    expect(merged.added).toEqual([]);
    expect(merged.refused[0]!.code).toBe('entry-limit');
    expect(merged.entries).toHaveLength(GLOSSARY_MAX_ENTRIES);
    expect(parseGlossary(toGlossaryText(merged.entries)).entries).toHaveLength(GLOSSARY_MAX_ENTRIES);
  });
});
