import { describe, expect, it } from 'vitest';
import {
  CONSENSUS_ENGINE_ORDER,
  compareOcrCandidates,
  computeScriptMatchScore,
  extractNumericTokens,
  fromPlanEngine,
  normalizedEditSimilarity,
  selectRegionConsensus,
  summarizeBatchConsensus,
  tokenAgreementScore,
  type OcrEngineCandidate,
} from '../viewer/src/core/ocr-consensus';

describe('normalizedEditSimilarity and tokenAgreementScore', () => {
  it('scores identical text after NFC and whitespace normalization as 1', () => {
    expect(normalizedEditSimilarity('  Hello\n  world ', 'Hello world')).toBe(1);
    expect(tokenAgreementScore('  Hello\n  world ', 'Hello world')).toBe(1);
  });

  it('penalizes character substitutions proportionally to max code-point length', () => {
    // 'kitten' -> 'sitting' has distance 3 over max length 7 => 4 / 7.
    expect(normalizedEditSimilarity('kitten', 'sitting')).toBeCloseTo(4 / 7, 6);
  });

  it('computes symmetric word-level agreement across substitutions and insertions', () => {
    expect(tokenAgreementScore('Total due 100 USD', 'Total due 200 USD')).toBeCloseTo(0.75, 6);
    expect(tokenAgreementScore('Total due 200 USD', 'Total due 100 USD')).toBeCloseTo(0.75, 6);
    expect(tokenAgreementScore('alpha beta', '')).toBe(0);
  });

  it('maps engine-plan engine identifiers to consensus engine identifiers', () => {
    expect(fromPlanEngine('windows')).toBe('windows-ocr');
    expect(fromPlanEngine('tesseract')).toBe('tesseract');
    expect(fromPlanEngine('browser')).toBe('cloud-vision');
  });
});

describe('compareOcrCandidates', () => {
  it('lets 2-of-3 consensus beat a single overconfident outlier', () => {
    const candidates: OcrEngineCandidate[] = [
      { engine: 'windows-ocr', text: 'Invoice #1042', confidence: 0.72 },
      { engine: 'paddle-ocr', text: 'Invoice #1042', confidence: 0.76 },
      { engine: 'tesseract', text: 'Invoice #1048', confidence: 0.99 },
    ];

    const report = compareOcrCandidates(candidates, { expectedLanguage: 'en' });

    expect(report.winner?.normalizedText).toBe('Invoice #1042');
    expect(report.winner?.engine).toBe('paddle-ocr');
    expect(report.agreeingEngines).toEqual(['paddle-ocr', 'windows-ocr']);
    expect(report.agreementRatio).toBeCloseTo(2 / 3, 6);
    expect(report.ranked.map(entry => entry.engine)).toEqual(['paddle-ocr', 'windows-ocr', 'tesseract']);
  });

  it('normalizes 0..100 confidence values alongside 0..1 confidence values', () => {
    const candidates: OcrEngineCandidate[] = [
      { engine: 'tesseract', text: 'Quarterly Report', confidence: 91 },
      { engine: 'windows-ocr', text: 'Quarterly Report', confidence: 0.82 },
    ];

    const report = compareOcrCandidates(candidates, { expectedLanguage: 'en' });

    expect(report.winner?.engine).toBe('tesseract');
    expect(report.winner?.confidence).toBeCloseTo(0.91, 6);
    expect(report.agreementRatio).toBe(1);
  });

  it('rewards candidates matching the expected script over mismatched-script outliers', () => {
    const candidates: OcrEngineCandidate[] = [
      { engine: 'windows-ocr', text: 'Quarterly Report', confidence: 0.8 },
      { engine: 'cloud-vision', text: 'Квартальный отчет', confidence: 0.92 },
    ];

    const report = compareOcrCandidates(candidates, { expectedLanguage: 'en' });

    expect(report.winner?.engine).toBe('windows-ocr');
    expect(report.winner?.scriptMatchScore).toBe(1);
    expect(report.ranked[1]?.scriptMatchScore).toBe(0);
  });

  it('handles empty and failed candidates without crashing or selecting them as winner', () => {
    const candidates: OcrEngineCandidate[] = [
      { engine: 'windows-ocr', text: '', confidence: 0.95 },
      { engine: 'cloud-vision', text: 'ignored garbage', confidence: 0.99, status: 'failed', error: 'timeout' },
      { engine: 'paddle-ocr', text: 'Approved by board', confidence: 0.84 },
      { engine: 'tesseract', text: 'Approved by board', confidence: 0.81 },
    ];

    const report = compareOcrCandidates(candidates, { expectedLanguage: 'en' });

    expect(report.winner?.engine).toBe('paddle-ocr');
    expect(report.winner?.normalizedText).toBe('Approved by board');
    expect(report.validCandidateCount).toBe(2);
    expect(report.emptyCandidateCount).toBe(1);
    expect(report.failedCandidateCount).toBe(1);
    expect(report.totalCandidateCount).toBe(4);
    expect(report.agreementRatio).toBeCloseTo(2 / 4, 6);
    expect(report.nonFailedAgreementRatio).toBeCloseTo(2 / 3, 6);
  });

  it('returns null winner and zero agreement when all candidates are empty or failed', () => {
    const emptyOnly = compareOcrCandidates([
      { engine: 'windows-ocr', text: '   ', confidence: 0 },
      { engine: 'tesseract', text: '', confidence: 0.5 },
    ]);
    expect(emptyOnly.winner).toBeNull();
    expect(emptyOnly.agreementRatio).toBe(0);
    expect(emptyOnly.emptyCandidateCount).toBe(2);

    const failedOnly = compareOcrCandidates([
      { engine: 'cloud-vision', text: '', confidence: 0, status: 'failed', error: 'offline' },
    ]);
    expect(failedOnly.winner).toBeNull();
    expect(failedOnly.agreementRatio).toBe(0);
    expect(failedOnly.failedCandidateCount).toBe(1);
  });

  it('breaks complete ties deterministically regardless of input array order', () => {
    const base: OcrEngineCandidate[] = [
      { engine: 'cloud-vision', text: 'Section 4', confidence: 0.9, costUsd: 0 },
      { engine: 'tesseract', text: 'Section 4', confidence: 0.9, costUsd: 0 },
      { engine: 'paddle-ocr', text: 'Section 4', confidence: 0.9, costUsd: 0 },
      { engine: 'windows-ocr', text: 'Section 4', confidence: 0.9, costUsd: 0 },
    ];

    const forward = compareOcrCandidates(base);
    const reversed = compareOcrCandidates([...base].reverse());

    expect(forward.winner?.engine).toBe(CONSENSUS_ENGINE_ORDER[0]);
    expect(reversed.winner?.engine).toBe(CONSENSUS_ENGINE_ORDER[0]);
    expect(forward.ranked.map(c => c.engine)).toEqual([...CONSENSUS_ENGINE_ORDER]);
    expect(reversed.ranked.map(c => c.engine)).toEqual([...CONSENSUS_ENGINE_ORDER]);
  });
});

describe('numeric-token disagreement flagging and cost accounting', () => {
  it('flags numeric-token conflicts even when surrounding prose agrees', () => {
    const tokens = extractNumericTokens('Total due: $1,250.00 on 2026-11-21');
    expect(tokens).toEqual(['1,250.00', '2026', '11', '21']);

    const result = selectRegionConsensus({
      regionId: 'r-total',
      page: 1,
      rect: { x: 10, y: 20, width: 200, height: 30 },
      expectedLanguage: 'en',
      candidates: [
        { engine: 'windows-ocr', text: 'The total invoice amount payable today is $1,250.00', confidence: 0.85 },
        { engine: 'paddle-ocr', text: 'The total invoice amount payable today is $1,250.00', confidence: 0.88 },
        { engine: 'cloud-vision', text: 'The total invoice amount payable today is $1,280.00', confidence: 0.99 },
      ],
    });

    expect(result.winningEngine).toBe('paddle-ocr');
    expect(result.selectedText).toBe('The total invoice amount payable today is $1,250.00');
    expect(result.hasNumericDisagreement).toBe(true);
    expect(result.numericDisagreement.conflictingTokens).toEqual(['1,250.00', '1,280.00']);
    expect(result.agreementRatio).toBeCloseTo(2 / 3, 6);
  });

  it('accounts per-region default and explicit engine costs and summarizes a batch', () => {
    const r1 = selectRegionConsensus({
      regionId: 'p1-b1',
      page: 1,
      candidates: [
        { engine: 'windows-ocr', text: 'Introduction', confidence: 0.9 },
        { engine: 'paddle-ocr', text: 'Introduction', confidence: 0.89 },
        { engine: 'cloud-vision', text: 'Introduction', confidence: 0.95 },
      ],
    });
    expect(r1.winningEngine).toBe('cloud-vision');
    expect(r1.totalCostUsd).toBeCloseTo(0.0015, 8);
    expect(r1.winnerCostUsd).toBeCloseTo(0.0015, 8);
    expect(r1.costByEngine['cloud-vision']).toBeCloseTo(0.0015, 8);

    const r2 = selectRegionConsensus({
      regionId: 'p1-b2',
      page: 1,
      candidates: [
        { engine: 'windows-ocr', text: 'Net 30 days', confidence: 0.7 },
        { engine: 'tesseract', text: 'Net 30 days', confidence: 0.72 },
        { engine: 'cloud-vision', text: 'Net 80 days', confidence: 0.99, costUsd: 0.002 },
      ],
    });
    expect(r2.winningEngine).toBe('tesseract');
    expect(r2.totalCostUsd).toBeCloseTo(0.002, 8);

    const r3 = selectRegionConsensus({
      regionId: 'p1-b3',
      page: 1,
      candidates: [
        { engine: 'windows-ocr', text: '', confidence: 0, status: 'failed', error: 'crash' },
        { engine: 'tesseract', text: '', confidence: 0 },
      ],
    });
    expect(r3.outcome).toBe('empty');
    expect(r3.winningEngine).toBeNull();
    expect(r3.totalCostUsd).toBe(0);

    const batch = summarizeBatchConsensus([r1, r2, r3]);
    expect(batch.regionCount).toBe(3);
    expect(batch.resolvedCount).toBe(2);
    expect(batch.emptyCount).toBe(1);
    expect(batch.failedCount).toBe(0);
    expect(batch.winnerCounts).toEqual({
      'windows-ocr': 0,
      'paddle-ocr': 0,
      tesseract: 1,
      'cloud-vision': 1,
    });
    expect(batch.totalCostUsd).toBeCloseTo(0.0035, 8);
    expect(batch.costByEngine['cloud-vision']).toBeCloseTo(0.0035, 8);
    expect(batch.disagreementRegions).toEqual(['p1-b2', 'p1-b3']);
    expect(batch.numericConflictRegions).toEqual(['p1-b2']);
  });
});

describe('Vietnamese diacritics and script edge cases', () => {
  it('treats NFD and NFC Vietnamese strings as exact consensus matches', () => {
    const nfc = 'Tiếng Việt Nam';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);

    const result = selectRegionConsensus({
      regionId: 'vi-nfd',
      expectedLanguage: 'vi-VN',
      candidates: [
        { engine: 'windows-ocr', text: nfc, confidence: 0.78 },
        { engine: 'paddle-ocr', text: nfd, confidence: 0.8 },
        { engine: 'tesseract', text: 'Tieng Viet Nam', confidence: 0.99 },
      ],
    });

    expect(result.winningEngine).toBe('paddle-ocr');
    expect(result.selectedText).toBe(nfc);
    expect(result.agreementRatio).toBeCloseTo(2 / 3, 6);
    expect(result.agreeingEngines).toEqual(['paddle-ocr', 'windows-ocr']);
  });

  it('prefers diacritic-preserving Vietnamese output over a higher-confidence ASCII strip', () => {
    const result = selectRegionConsensus({
      regionId: 'vi-strip',
      expectedLanguage: 'vie',
      candidates: [
        { engine: 'paddle-ocr', text: 'Quyết định số 12', confidence: 0.85 },
        { engine: 'windows-ocr', text: 'Quyet dinh so 12', confidence: 0.96 },
      ],
    });

    expect(result.winningEngine).toBe('paddle-ocr');
    expect(result.selectedText).toBe('Quyết định số 12');
    expect(result.candidates[0]?.scriptMatchScore).toBe(1);
    expect(result.candidates[1]?.scriptMatchScore).toBe(0.5);
  });

  it('rejects single-diacritic hallucination in a multi-word Vietnamese sentence via 2-of-3 consensus', () => {
    const expected = 'Cộng hòa xã hội chủ nghĩa';
    const corrupted = 'Cộng hoa xã hội chủ nghĩa';

    const result = selectRegionConsensus({
      regionId: 'vi-tone',
      expectedLanguage: 'vi',
      candidates: [
        { engine: 'windows-ocr', text: expected, confidence: 0.76 },
        { engine: 'cloud-vision', text: expected, confidence: 0.79 },
        { engine: 'tesseract', text: corrupted, confidence: 0.99 },
      ],
    });

    expect(result.winningEngine).toBe('cloud-vision');
    expect(result.selectedText).toBe(expected);
    expect(result.agreementRatio).toBeCloseTo(2 / 3, 6);
  });

  it('does not penalize pure-numeric regions or mixed Han/Kana Japanese text for script match', () => {
    expect(computeScriptMatchScore('2026-11-21', { expectedLanguage: 'vi' })).toBe(1);
    expect(computeScriptMatchScore('日本語テキスト', { expectedLanguage: 'ja' })).toBe(1);
    expect(computeScriptMatchScore('漢字のみ', { expectedLanguage: 'ja' })).toBe(1);
    expect(computeScriptMatchScore('English only', { expectedLanguage: 'ja' })).toBe(0);
  });
});

describe('numeric conflict edge cases', () => {
  it('flags decimal separator mismatches, dropped digits, and negative sign conflicts', () => {
    const sepConflict = selectRegionConsensus({
      regionId: 'num-sep',
      candidates: [
        { engine: 'windows-ocr', text: 'Rate: 1.25%', confidence: 0.9 },
        { engine: 'paddle-ocr', text: 'Rate: 1,25%', confidence: 0.88 },
      ],
    });
    expect(sepConflict.hasNumericDisagreement).toBe(true);
    expect(sepConflict.numericDisagreement.conflictingTokens).toEqual(['1.25', '1,25']);
    expect(sepConflict.agreementRatio).toBeCloseTo(0.5, 6);

    const droppedNumber = selectRegionConsensus({
      regionId: 'num-drop',
      candidates: [
        { engine: 'windows-ocr', text: 'Page 2 of 5', confidence: 0.9 },
        { engine: 'tesseract', text: 'Page 2 of', confidence: 0.85 },
      ],
    });
    expect(droppedNumber.hasNumericDisagreement).toBe(true);
    expect(droppedNumber.numericDisagreement.conflictingTokens).toEqual(['5']);

    const signConflict = selectRegionConsensus({
      regionId: 'num-sign',
      candidates: [
        { engine: 'windows-ocr', text: 'Delta: -15°C', confidence: 0.9 },
        { engine: 'paddle-ocr', text: 'Delta: 15°C', confidence: 0.87 },
      ],
    });
    expect(signConflict.hasNumericDisagreement).toBe(true);
    expect(signConflict.numericDisagreement.conflictingTokens).toEqual(['-15', '15']);
  });

  it('normalizes Unicode minus signs and currency spacing without false conflicts', () => {
    const result = selectRegionConsensus({
      regionId: 'num-norm',
      candidates: [
        { engine: 'windows-ocr', text: 'Balance: $ 1,250.00 (adj −15)', confidence: 0.9 },
        { engine: 'paddle-ocr', text: 'Balance: $1,250.00 (adj -15)', confidence: 0.88 },
      ],
    });

    expect(result.hasNumericDisagreement).toBe(false);
    expect(result.numericDisagreement.conflictingTokens).toEqual([]);
  });

  it('isolates only the conflicting component inside multi-number dates', () => {
    const result = selectRegionConsensus({
      regionId: 'num-date',
      candidates: [
        { engine: 'windows-ocr', text: 'Ngày 21/11/2026', confidence: 0.9 },
        { engine: 'paddle-ocr', text: 'Ngày 24/11/2026', confidence: 0.84 },
      ],
    });

    expect(result.hasNumericDisagreement).toBe(true);
    expect(result.numericDisagreement.conflictingTokens).toEqual(['21', '24']);
  });
});

describe('tie-break, batch thresholds, and validation edge cases', () => {
  it('breaks equal score and confidence ties by lower cost before engine priority', () => {
    const result = selectRegionConsensus({
      regionId: 'tie-cost',
      candidates: [
        { engine: 'windows-ocr', text: 'Contract Clause A', confidence: 0.9, costUsd: 0.002 },
        { engine: 'cloud-vision', text: 'Contract Clause A', confidence: 0.9, costUsd: 0 },
      ],
    });

    expect(result.winningEngine).toBe('cloud-vision');
    expect(result.winnerCostUsd).toBe(0);
  });

  it('breaks total-score ties by higher consensus score over raw confidence', () => {
    const report = compareOcrCandidates(
      [
        { engine: 'windows-ocr', text: 'AAA', confidence: 0.6 },
        { engine: 'paddle-ocr', text: 'AAA', confidence: 0.6 },
        { engine: 'tesseract', text: 'ZZZ', confidence: 0.9 },
      ],
      { weights: { consensus: 0.5, confidence: 0.5, scriptMatch: 0 } },
    );

    // For two 2/3 exact matches vs one 1/3 outlier (0 similarity):
    // 2/3 consensus = 0.4*(2/3)+0.3*(2/3)+0.3*(0.5) = 0.616667 -> 0.5*0.616667 + 0.5*0.6 = 0.608333
    // 1/3 outlier   = 0.4*(1/3)+0.3*(1/3)+0.3*(0)   = 0.233333 -> 0.5*0.233333 + 0.5*0.983333333333 = 0.608333
    const exactTie = compareOcrCandidates(
      [
        { engine: 'windows-ocr', text: 'AAA', confidence: 0.6 },
        { engine: 'paddle-ocr', text: 'AAA', confidence: 0.6 },
        { engine: 'tesseract', text: 'ZZZ', confidence: 0.983333333333 },
      ],
      { weights: { consensus: 0.5, confidence: 0.5, scriptMatch: 0 } },
    );

    expect(exactTie.winner?.engine).toBe('windows-ocr');
    expect(exactTie.winner?.totalScore).toBeCloseTo(exactTie.ranked[2]!.totalScore, 9);
    expect(exactTie.winner?.consensusScore).toBeGreaterThan(exactTie.ranked[2]!.consensusScore);
    expect(report.winner?.engine).toBe('windows-ocr');
  });

  it('handles empty batches, all-failed regions, and custom minAgreementRatio thresholds', () => {
    expect(summarizeBatchConsensus([])).toEqual({
      regionCount: 0,
      resolvedCount: 0,
      emptyCount: 0,
      failedCount: 0,
      winnerCounts: {
        'windows-ocr': 0,
        'paddle-ocr': 0,
        tesseract: 0,
        'cloud-vision': 0,
      },
      totalCostUsd: 0,
      costByEngine: {
        'windows-ocr': 0,
        'paddle-ocr': 0,
        tesseract: 0,
        'cloud-vision': 0,
      },
      meanAgreementRatio: 0,
      disagreementRegions: [],
      numericConflictRegions: [],
    });

    const failedRegion = selectRegionConsensus({
      regionId: 'r-fail',
      candidates: [
        { engine: 'windows-ocr', text: '', confidence: 0, status: 'failed', error: 'timeout' },
        { engine: 'cloud-vision', text: '', confidence: 0, status: 'failed', error: '503', costUsd: 0.001 },
      ],
    });
    expect(failedRegion.outcome).toBe('failed');
    expect(failedRegion.winningEngine).toBeNull();
    expect(failedRegion.totalCostUsd).toBeCloseTo(0.001, 8);

    const partialRegion = selectRegionConsensus({
      regionId: 'r-partial',
      candidates: [
        { engine: 'windows-ocr', text: 'Header', confidence: 0.9 },
        { engine: 'paddle-ocr', text: 'Header', confidence: 0.85 },
        { engine: 'tesseract', text: 'Headr', confidence: 0.7 },
      ],
    });

    const relaxed = summarizeBatchConsensus([failedRegion, partialRegion], { minAgreementRatio: 0.6 });
    expect(relaxed.failedCount).toBe(1);
    expect(relaxed.disagreementRegions).toEqual(['r-fail']);
  });

  it('rejects invalid weights, thresholds, negative costs, and bad batch thresholds', () => {
    expect(() =>
      compareOcrCandidates([{ engine: 'windows-ocr', text: 'a', confidence: 0.9 }], {
        weights: { consensus: 0, confidence: 0, scriptMatch: 0 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      compareOcrCandidates([{ engine: 'windows-ocr', text: 'a', confidence: 0.9 }], {
        agreementThreshold: 1.5,
      }),
    ).toThrow(RangeError);
    expect(() =>
      compareOcrCandidates([{ engine: 'windows-ocr', text: 'a', confidence: 0.9, costUsd: -0.01 }]),
    ).toThrow(RangeError);
    expect(() => summarizeBatchConsensus([], { minAgreementRatio: -0.1 })).toThrow(RangeError);
  });
});
