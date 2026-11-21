import { describe, expect, it } from 'vitest';
import {
  CONSENSUS_ENGINE_ORDER,
  compareOcrCandidates,
  extractNumericTokens,
  fromPlanEngine,
  normalizedEditSimilarity,
  selectRegionConsensus,
  summarizeBatchConsensus,
  tokenAgreementScore,
  type OcrEngineCandidate,
} from '../src/core/ocr-consensus';

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
