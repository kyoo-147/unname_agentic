import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ESTIMATE_LANGUAGE,
  DEFAULT_EXPORT_SECONDS_PER_PAGE,
  DEFAULT_EXTRACT_SECONDS_PER_PAGE,
  DEFAULT_OCR_SECONDS_PER_PAGE,
  DEFAULT_TRANSLATE_SECONDS_PER_BLOCK,
  ESTIMATE_LANGUAGES,
  costEstimate,
  estimateJob,
  formatDuration,
  formatEstimate,
  type EstimateLanguage,
  type EstimateStage,
  type JobEstimate,
  type JobEstimateInput,
} from '../viewer/src/core/estimate';
import { estimateCost as priceFromTable, type ModelPricing } from '../viewer/src/core/pricing';

// 12 pages, 240 blocks, 54,000 source characters: about one paragraph per block, which is
// also the shape docs/performance.md's synthetic corpus has.
const DIGITAL: JobEstimateInput = {
  pages: 12,
  characters: 54_000,
  scannedPages: 0,
  blocks: 240,
  provider: 'gpt-4o-mini',
};

// The same document, but three quarters of it is a scan: past MOSTLY_SCANNED_SHARE, so the
// OCR stage and the job's confidence both drop.
const SCANNED: JobEstimateInput = { ...DIGITAL, scannedPages: 9 };

// Two scanned pages out of twelve: OCR is needed, but it is the minority.
const MOSTLY_DIGITAL: JobEstimateInput = { ...DIGITAL, scannedPages: 2 };

function stageSeconds(estimate: JobEstimate, name: string): number {
  return estimate.stages.find(stage => stage.name === name)?.seconds ?? Number.NaN;
}

function stageConfidence(estimate: JobEstimate, name: string): string | undefined {
  return estimate.stages.find(stage => stage.name === name)?.confidence;
}

function assumptionsOf(estimate: JobEstimate): string {
  return estimate.assumptions.join('\n');
}

describe('estimateJob', () => {
  it('estimates a digital document without an OCR stage', () => {
    const estimate = estimateJob(DIGITAL);

    expect(estimate.stages.map(stage => stage.name)).toEqual(['extract', 'translate', 'export']);
    expect(estimate.stages.some(stage => stage.name === 'ocr')).toBe(false);
    expect(estimate.confidence).toBe('high');

    // Extract and export are per page; translation is per block.
    expect(stageSeconds(estimate, 'extract')).toBeCloseTo(12 * DEFAULT_EXTRACT_SECONDS_PER_PAGE, 9);
    expect(stageSeconds(estimate, 'translate')).toBeCloseTo(240 * DEFAULT_TRANSLATE_SECONDS_PER_BLOCK, 9);
    expect(stageSeconds(estimate, 'export')).toBeCloseTo(12 * DEFAULT_EXPORT_SECONDS_PER_PAGE, 9);

    // 1.2 s + 96 s + 2.4 s, and the OCR assumption has no business appearing.
    expect(estimate.totalSeconds).toBeCloseTo(99.6, 9);
    expect(assumptionsOf(estimate)).not.toContain('OCR');
  });

  it('adds an OCR stage for scanned pages and lowers confidence', () => {
    const digital = estimateJob(DIGITAL);
    const scanned = estimateJob(SCANNED);

    expect(scanned.stages.map(stage => stage.name)).toEqual(['extract', 'ocr', 'translate', 'export']);
    expect(stageSeconds(scanned, 'ocr')).toBeCloseTo(9 * DEFAULT_OCR_SECONDS_PER_PAGE, 9);
    // Only the three digital pages carry a text layer, so extraction covers those.
    expect(stageSeconds(scanned, 'extract')).toBeCloseTo(3 * DEFAULT_EXTRACT_SECONDS_PER_PAGE, 9);

    // Three quarters scanned is past the threshold: the OCR stage and the job are low.
    expect(stageConfidence(scanned, 'ocr')).toBe('low');
    expect(scanned.confidence).toBe('low');
    expect(scanned.totalSeconds).toBeGreaterThan(digital.totalSeconds);
  });

  it('reports medium confidence when the scanned pages are the minority', () => {
    const estimate = estimateJob(MOSTLY_DIGITAL);

    expect(stageConfidence(estimate, 'ocr')).toBe('medium');
    expect(stageConfidence(estimate, 'extract')).toBe('high');
    expect(estimate.confidence).toBe('medium');
    // 1 s extract + 7 s OCR + 96 s translate + 2.4 s export.
    expect(estimate.totalSeconds).toBeCloseTo(106.4, 9);
  });

  it('reports the total as the sum of the stages, exactly', () => {
    for (const input of [DIGITAL, SCANNED, MOSTLY_DIGITAL]) {
      const estimate = estimateJob(input);
      const sum = estimate.stages.reduce((total, stage) => total + stage.seconds, 0);

      // Not "close to": the total is defined as this sum, so the parts and the total agree.
      expect(estimate.totalSeconds).toBe(sum);
    }
  });

  it('lowers translation confidence and says so when text has no block count', () => {
    const estimate = estimateJob({ ...DIGITAL, blocks: 0 });

    expect(stageSeconds(estimate, 'translate')).toBe(0);
    expect(stageConfidence(estimate, 'translate')).toBe('low');
    expect(estimate.confidence).toBe('low');
    expect(assumptionsOf(estimate)).toContain('the per-block constant cannot be applied');
  });

  it('does not call a document with no text at all low confidence', () => {
    // Nothing to translate is a complete answer, not a missing measurement.
    const estimate = estimateJob({ pages: 1, characters: 0, scannedPages: 0, blocks: 0, provider: 'gpt-4o-mini' });

    expect(estimate.stages.map(stage => stage.name)).toEqual(['extract', 'translate', 'export']);
    expect(stageSeconds(estimate, 'translate')).toBe(0);
    expect(estimate.confidence).toBe('high');
    expect(estimate.totalSeconds).toBeCloseTo(
      DEFAULT_EXTRACT_SECONDS_PER_PAGE + DEFAULT_EXPORT_SECONDS_PER_PAGE,
      9,
    );
    expect(estimate.cost?.amount).toBe(0);
  });

  it('honours overridden constants per stage', () => {
    const estimate = estimateJob(DIGITAL, {
      extractSecondsPerPage: 0.2,
      translateSecondsPerBlock: 0.8,
      exportSecondsPerPage: 0.5,
    });

    expect(stageSeconds(estimate, 'extract')).toBeCloseTo(12 * 0.2, 9);
    expect(stageSeconds(estimate, 'translate')).toBeCloseTo(240 * 0.8, 9);
    expect(stageSeconds(estimate, 'export')).toBeCloseTo(12 * 0.5, 9);

    const ocr = estimateJob(SCANNED, { ocrSecondsPerPage: 9 });
    expect(stageSeconds(ocr, 'ocr')).toBeCloseTo(81, 9);
    expect(assumptionsOf(ocr)).toContain('OCR: 9 s per scanned page (override); 9 of 12 pages scanned.');
  });

  it('allows a zero rate, which removes a stage without hiding it', () => {
    const estimate = estimateJob(SCANNED, { ocrSecondsPerPage: 0, translateSecondsPerBlock: 0 });

    expect(stageSeconds(estimate, 'ocr')).toBe(0);
    expect(stageSeconds(estimate, 'translate')).toBe(0);
    expect(estimate.stages.map(stage => stage.name)).toEqual(['extract', 'ocr', 'translate', 'export']);
  });

  it('refuses a document with no pages', () => {
    expect(() => estimateJob({ ...DIGITAL, pages: 0 })).toThrow(RangeError);
    expect(() => estimateJob({ ...DIGITAL, pages: 0 })).toThrow(/at least one whole page/);
    expect(() => estimateJob({ ...DIGITAL, pages: -3 })).toThrow(RangeError);
    // Half a page is not a page count a document can have.
    expect(() => estimateJob({ ...DIGITAL, pages: 2.5 })).toThrow(RangeError);
  });

  it('refuses contradictory or broken counts', () => {
    expect(() => estimateJob({ ...DIGITAL, scannedPages: 13 })).toThrow(RangeError);
    expect(() => estimateJob({ ...DIGITAL, scannedPages: 13 })).toThrow(/cannot exceed pages/);
    expect(() => estimateJob({ ...DIGITAL, characters: -1 })).toThrow(RangeError);
    expect(() => estimateJob({ ...DIGITAL, blocks: Number.NaN })).toThrow(RangeError);
    expect(() => estimateJob({ ...DIGITAL, scannedPages: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => estimateJob(DIGITAL, { translateSecondsPerBlock: -0.1 })).toThrow(RangeError);
    expect(() => estimateJob(DIGITAL, { direction: 'sideways' as never })).toThrow(RangeError);
    expect(() => estimateJob(null as unknown as JobEstimateInput)).toThrow(TypeError);
  });
});

describe('costEstimate', () => {
  it('prices a known model with pricing.ts arithmetic', () => {
    const published = priceFromTable({ characters: 54_000, model: 'gpt-4o-mini', direction: 'both' });
    const cost = costEstimate(54_000, 'gpt-4o-mini');

    expect(published).not.toBeNull();
    expect(cost?.amount).toBe(published?.usd);
    // 13,500 tokens on both sides at $0.15 / $0.60 per million: $0.010125.
    expect(cost?.amount).toBeCloseTo(0.010125, 12);
    expect(cost?.currency).toBe('USD');
    // The amount covers the whole job, not one request.
    expect(cost?.unit).toBe('job');
  });

  it('returns null when the provider has no published price', () => {
    expect(costEstimate(54_000, 'qwen3:4b')).toBeNull();
    expect(costEstimate(54_000, 'not-a-model')).toBeNull();
    expect(costEstimate(54_000, null)).toBeNull();
    expect(costEstimate(54_000, undefined)).toBeNull();
    // An empty id is not a model, and pricing nothing is the honest answer.
    expect(costEstimate(54_000, '')).toBeNull();
  });

  it('accepts a rate row for a provider the table does not carry', () => {
    const row: ModelPricing = { model: 'house-model', inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 };
    const estimate = costEstimate(54_000, row);
    const reference = priceFromTable({ characters: 54_000, model: 'gpt-4o', direction: 'both' });

    // The same rates as gpt-4o's published row, so the same arithmetic has to agree.
    expect(estimate?.amount).toBe(reference?.usd);
    expect(estimate?.currency).toBe('USD');
    // A row the caller cannot price is not priced by guessing.
    expect(costEstimate(54_000, { ...row, inputUsdPerMillion: -1 })).toBeNull();
    expect(costEstimate(54_000, { ...row, model: '' })).toBeNull();
  });

  it('prices the side of the request the caller asks for', () => {
    // 4,000 characters is 1,000 tokens: $0.00015 in, $0.0006 out, $0.00075 both.
    expect(costEstimate(4_000, 'gpt-4o-mini', 'input')?.amount).toBeCloseTo(0.00015, 12);
    expect(costEstimate(4_000, 'gpt-4o-mini', 'output')?.amount).toBeCloseTo(0.0006, 12);
    expect(costEstimate(4_000, 'gpt-4o-mini', 'both')?.amount).toBeCloseTo(0.00075, 12);
  });

  it('refuses a character count that is not a measurement', () => {
    expect(() => costEstimate(-1, 'gpt-4o-mini')).toThrow(RangeError);
    expect(() => costEstimate(Number.NaN, 'gpt-4o-mini')).toThrow(RangeError);
  });
});

describe('estimateJob cost', () => {
  it('carries the cost of the whole document into the estimate', () => {
    const estimate = estimateJob(DIGITAL);
    const published = priceFromTable({ characters: 54_000, model: 'gpt-4o-mini', direction: 'both' });

    expect(estimate.cost?.amount).toBe(published?.usd);
    expect(estimate.cost?.unit).toBe('job');
  });

  it('reports no cost, rather than zero, for a provider without a price', () => {
    expect(estimateJob({ ...DIGITAL, provider: 'qwen3:4b' }).cost).toBeNull();
    expect(estimateJob({ ...DIGITAL, provider: '' }).cost).toBeNull();
    // An explicit null is how a caller prices nothing on purpose.
    expect(estimateJob(DIGITAL, { pricing: null }).cost).toBeNull();
  });

  it('uses a supplied rate row and direction over the provider in the input', () => {
    const row: ModelPricing = { model: 'house-model', inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 };
    const estimate = estimateJob(DIGITAL, { pricing: row });
    const reference = priceFromTable({ characters: 54_000, model: 'gpt-4o', direction: 'both' });

    expect(estimate.cost?.amount).toBe(reference?.usd);
    // The row wins over the known provider in `input.provider`.
    expect(estimate.cost?.amount).not.toBe(estimateJob(DIGITAL).cost?.amount);

    const inputOnly = estimateJob(DIGITAL, { direction: 'input' });
    expect(inputOnly.cost?.amount).toBeCloseTo(0.002025, 12);
  });
});

describe('assumptions', () => {
  it('lists every constant the estimate used, with the counts', () => {
    const text = assumptionsOf(estimateJob(SCANNED));

    expect(text).toContain(`Text extraction: ${DEFAULT_EXTRACT_SECONDS_PER_PAGE} s per digital page (default); 3 of 12 pages digital.`);
    expect(text).toContain(`OCR: ${DEFAULT_OCR_SECONDS_PER_PAGE} s per scanned page (default); 9 of 12 pages scanned.`);
    expect(text).toContain(`Translation: ${DEFAULT_TRANSLATE_SECONDS_PER_BLOCK} s per block (default); 240 blocks.`);
    expect(text).toContain(`Export: ${DEFAULT_EXPORT_SECONDS_PER_PAGE} s per page (default); 12 pages.`);
    expect(text).toContain('gpt-4o-mini list price');
    expect(text).toContain('4 characters per token');
    expect(text).toContain('input and output both counted');
    expect(text).toContain('54000 characters');
  });

  it('names the price basis and the side of the request that was priced', () => {
    const inputOnly = estimateJob(DIGITAL, { direction: 'input' });

    expect(assumptionsOf(inputOnly)).toContain('input only');
    expect(assumptionsOf(estimateJob(DIGITAL))).toContain('input and output both counted');
  });

  it('marks an override as an override', () => {
    const text = assumptionsOf(estimateJob(SCANNED, { ocrSecondsPerPage: 9 }));

    expect(text).toContain('OCR: 9 s per scanned page (override); 9 of 12 pages scanned.');
    expect(text).toContain('Text extraction: 0.1 s per digital page (default)');
  });

  it('says why there is no cost instead of leaving the line out', () => {
    const unknown = assumptionsOf(estimateJob({ ...DIGITAL, provider: 'qwen3:4b' }));

    expect(unknown).toContain('no published price for "qwen3:4b"');
    expect(unknown).toContain('covers time only');

    const missing = assumptionsOf(estimateJob({ ...DIGITAL, provider: '' }));
    expect(missing).toContain('no provider or rate row was supplied');
  });

  it('names the canonical table entry for a model id in any case', () => {
    const text = assumptionsOf(estimateJob({ ...DIGITAL, provider: 'GPT-4O-MINI' }));

    expect(text).toContain('Cost: gpt-4o-mini list price');
  });
});

describe('formatEstimate', () => {
  it('formats one sentence in English, Vietnamese and Chinese', () => {
    const estimate = estimateJob(DIGITAL);

    // 99.6 s rounds to 1 min 40 s; 13,500 tokens both ways is $0.010125, printed as $0.01.
    expect(formatEstimate(estimate, 'en')).toBe('Roughly 1 min 40 s, about $0.01.');
    expect(formatEstimate(estimate, 'vi')).toBe('Khoảng 1 phút 40 giây, chi phí $0.01.');
    expect(formatEstimate(estimate, 'zh')).toBe('约 1 分 40 秒，费用约 $0.01。');
    expect(ESTIMATE_LANGUAGES).toEqual(['vi', 'en', 'zh']);
  });

  it('says the cost is not estimated when the provider has no price', () => {
    const estimate = estimateJob({ ...DIGITAL, provider: 'qwen3:4b' });

    expect(formatEstimate(estimate, 'en')).toBe('Roughly 1 min 40 s, cost not estimated.');
    expect(formatEstimate(estimate, 'vi')).toBe('Khoảng 1 phút 40 giây, chưa ước tính được chi phí.');
    expect(formatEstimate(estimate, 'zh')).toBe('约 1 分 40 秒，费用未知。');
  });

  it('warns that a mostly scanned document is a low-confidence estimate', () => {
    // 130.2 s rounds to 2 min 10 s.
    const scanned = formatEstimate(estimateJob(SCANNED), 'en');
    expect(scanned).toBe('Roughly 2 min 10 s, about $0.01. Low confidence: most of this document is scanned.');

    expect(formatEstimate(estimateJob(SCANNED), 'vi')).toContain('Độ tin cậy thấp: phần lớn tài liệu là bản scan.');
    expect(formatEstimate(estimateJob(SCANNED), 'zh')).toContain('置信度低：文档大部分是扫描页。');
    // A digital document carries no caveat at all.
    expect(formatEstimate(estimateJob(DIGITAL), 'en')).not.toContain('Low confidence');
  });

  it('names the missing block count when that is why confidence is low', () => {
    const text = formatEstimate(estimateJob({ ...DIGITAL, blocks: 0 }), 'en');

    expect(text).toBe(
      'Roughly 4 s, about $0.01. Low confidence: the block count is missing, so the translation time is a floor.',
    );
    expect(text).not.toContain('scanned');
  });

  it('defaults to Vietnamese and falls back to it for a language it has no copy for', () => {
    const estimate = estimateJob(DIGITAL);

    expect(DEFAULT_ESTIMATE_LANGUAGE).toBe('vi');
    expect(formatEstimate(estimate)).toBe(formatEstimate(estimate, 'vi'));
    expect(formatEstimate(estimate, 'fr' as unknown as EstimateLanguage)).toBe(formatEstimate(estimate, 'vi'));
  });

  it('refuses a value that is not an estimate', () => {
    expect(() => formatEstimate(null as unknown as JobEstimate)).toThrow(TypeError);
    expect(() =>
      formatEstimate({ stages: [], totalSeconds: Number.NaN, cost: null } as unknown as JobEstimate),
    ).toThrow(TypeError);
    // Missing stages: nothing describes what the number is made of.
    expect(() =>
      formatEstimate({ totalSeconds: 10, cost: null } as unknown as JobEstimate),
    ).toThrow(TypeError);
    expect(() =>
      formatEstimate({
        stages: [],
        totalSeconds: 10,
        cost: { amount: Number.NaN, currency: 'USD', unit: 'job' },
      } as unknown as JobEstimate),
    ).toThrow(TypeError);
  });
});

describe('formatDuration', () => {
  it('prints minutes and seconds, dropping a zero part', () => {
    expect(formatDuration(260, 'en')).toBe('4 min 20 s');
    expect(formatDuration(120, 'en')).toBe('2 min');
    expect(formatDuration(90, 'en')).toBe('1 min 30 s');
    expect(formatDuration(45, 'en')).toBe('45 s');
    // Planning precision: the seconds round first.
    expect(formatDuration(99.6, 'en')).toBe('1 min 40 s');
  });

  it('prints hours without seconds', () => {
    expect(formatDuration(3600, 'en')).toBe('1 h');
    expect(formatDuration(3900, 'en')).toBe('1 h 5 min');
    expect(formatDuration(7260, 'en')).toBe('2 h 1 min');
  });

  it('uses the units of the requested language', () => {
    expect(formatDuration(260, 'vi')).toBe('4 phút 20 giây');
    expect(formatDuration(45, 'vi')).toBe('45 giây');
    expect(formatDuration(260, 'zh')).toBe('4 分 20 秒');
    expect(formatDuration(45, 'zh')).toBe('45 秒');
    expect(formatDuration(3900, 'vi')).toBe('1 giờ 5 phút');
    expect(formatDuration(3900, 'zh')).toBe('1 小时 5 分');
  });

  it('never reports zero for a duration under a second', () => {
    expect(formatDuration(0, 'en')).toBe('<1 s');
    expect(formatDuration(0.4, 'en')).toBe('<1 s');
    expect(formatDuration(0.4, 'vi')).toBe('<1 giây');
    expect(formatDuration(0.4, 'zh')).toBe('<1 秒');
  });

  it('refuses a duration that is not a measurement', () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
    expect(() => formatDuration(Number.NaN)).toThrow(RangeError);
    expect(() => formatDuration(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
