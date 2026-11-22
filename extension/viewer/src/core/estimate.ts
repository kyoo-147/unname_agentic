/**
 * Pre-flight estimate: how long a document will take, and what it will cost, before the
 * run starts (backlog F09/F11).
 *
 * A progress bar that appears once the work has begun answers nothing a reader can plan
 * around. This module answers the earlier question — "start it now, or leave it running
 * over lunch?" — from the shape of the document: page count, scanned page count, block
 * count and character count. It is pure: no clock, no network, no I/O, so a settings panel
 * can rebuild it on every keystroke and a test can assert exact seconds.
 *
 * ## The model
 *
 * Time is four stages, in pipeline order:
 *
 * | Stage | What it measures | Constant |
 * | --- | --- | --- |
 * | `extract` | reading the text layer of one digital page | {@link DEFAULT_EXTRACT_SECONDS_PER_PAGE} |
 * | `ocr` | recognising one scanned page | {@link DEFAULT_OCR_SECONDS_PER_PAGE} |
 * | `translate` | sending and receiving one block | {@link DEFAULT_TRANSLATE_SECONDS_PER_BLOCK} |
 * | `export` | writing one page of output | {@link DEFAULT_EXPORT_SECONDS_PER_PAGE} |
 *
 * `extract` covers only the pages that need no OCR (`pages - scannedPages`): a scanned
 * page has no text layer to read, and its rendering cost is counted inside the OCR stage.
 * The `ocr` stage is present only when at least one page is scanned, so a fully digital
 * document reports three stages rather than an OCR row of zero seconds. Every other stage
 * is always present, including a `translate` stage of zero seconds for a document with no
 * blocks, so a caller can render a stable set of rows.
 *
 * The stages sum to {@link JobEstimate.totalSeconds} exactly: the total is the sum of the
 * numbers reported in `stages`, not a separately rounded figure, so a UI that shows the
 * parts and a UI that shows the total cannot disagree.
 *
 * ## The constants are planning figures, not measurements
 *
 * Each default describes a mid-range laptop working one page at a time: the OCR figure is
 * a single-threaded `tesseract.js` pass over a 300 DPI page, the translation figure is a
 * provider round trip amortised over a batched request, and export is rendering one
 * translated page to PDF. A slow machine, a dense page or a bad scan can double a stage, so
 * the figure is deliberately not presented as a promise.
 *
 * They are measured constants in one respect only: each is a named number a reader can
 * check and a caller can replace. `metrics.ts` (backlog N07) is where they become measured
 * numbers — once `ocr.ms`, `translate.ms` and `export.ms` exist for a real corpus, the
 * default should be read from that snapshot instead of from this table. Until then the
 * constants stay overridable per call ({@link EstimateOptions}) and every number used is
 * repeated in {@link JobEstimate.assumptions}, so a reader can see which value produced the
 * estimate in front of them.
 *
 * ## Confidence
 *
 * Confidence describes how well the constants fit *this* document, not how noisy the
 * network is:
 *
 * - `high`: the stage's workload is counted exactly and the constant describes that
 *   workload. A digital document is this case.
 * - `medium`: part of the document is scanned, so the OCR constant applies only to those
 *   pages and scan quality is unknown.
 * - `low`: the constants fit poorly — at least half the document is scanned
 *   ({@link MOSTLY_SCANNED_SHARE}), or there are characters to translate and no block
 *   count to apply the per-block constant to.
 *
 * {@link JobEstimate.confidence} is the weakest stage's, because a chain of stages is only
 * as certain as its worst input.
 *
 * ## Cost
 *
 * {@link costEstimate} reuses `pricing.ts` and returns `null` when the provider has no
 * published price — never zero, never a guess, so a local model is reported as unknown
 * rather than free. A translation sends the source text and bills the produced text, so the
 * default direction is `both`: the source character count is used on both sides because
 * `pricing.ts` has one count and a target language may run longer or shorter. The figure is
 * a planning number from list prices, not a quote.
 *
 * ## Refusals
 *
 * `estimateJob` throws rather than returning a misleading number: a document with no pages
 * has no job to estimate ({@link RangeError}), `scannedPages` larger than `pages` is a
 * contradiction rather than an estimate ({@link RangeError}), a count that is negative or
 * not finite is a broken measurement ({@link RangeError}), and a missing input object is a
 * caller bug ({@link TypeError}). A rate of zero is allowed: a caller may deliberately
 * remove a stage.
 */

import {
  CHARACTERS_PER_TOKEN,
  estimateCost as priceFromTable,
  estimateTokens,
  findModelPricing,
  formatUsd,
  type CostDirection,
  type ModelPricing,
} from './pricing';

// --- Constants --------------------------------------------------------------

/**
 * Seconds to read the text layer of one page that needs no OCR.
 *
 * One page of `pdf.js` text extraction with its operator list built: mostly page startup,
 * not text volume, which is why the constant is per page rather than per character.
 */
export const DEFAULT_EXTRACT_SECONDS_PER_PAGE = 0.1;

/**
 * Seconds to OCR one scanned page, preprocessing included.
 *
 * Single-threaded `tesseract.js` at 300 DPI, one language pack, a full-page pass. A second
 * language pack or a 600 DPI scan is where the 2× comes from, which is why a page count
 * that is mostly scans lowers confidence.
 */
export const DEFAULT_OCR_SECONDS_PER_PAGE = 3.5;

/**
 * Seconds to translate one block.
 *
 * A block is a paragraph or a table cell — the unit the translation queue sends. The figure
 * is a provider round trip amortised over a batched request, so it already assumes the
 * caller batches; a request per block would be an order of magnitude slower.
 */
export const DEFAULT_TRANSLATE_SECONDS_PER_BLOCK = 0.4;

/**
 * Seconds to write one page of output.
 *
 * Rendering a translated page (fonts embedded once, wrapped text, one page object) to PDF.
 */
export const DEFAULT_EXPORT_SECONDS_PER_PAGE = 0.2;

/**
 * Share of scanned pages at which a document counts as "mostly scanned".
 *
 * At or above this share the OCR stage's confidence is `low` and so is the job's: the
 * constant describes a typical scan, and most of the document is the case where a typical
 * scan is least likely to hold.
 */
export const MOSTLY_SCANNED_SHARE = 0.5;

/** Milliseconds in a second. Stage seconds are rounded to this scale, so they add up. */
const MILLISECONDS_PER_SECOND = 1000;

/** What a cost estimate prices when the caller does not say: both sides of a translation. */
const DEFAULT_COST_DIRECTION: CostDirection = 'both';

// --- Inputs -----------------------------------------------------------------

/**
 * The document's shape, which is all this module needs.
 *
 * Every field is a count the reader already has: `pages` from the PDF, `scannedPages` from
 * the page classifier, `blocks` from the extraction pass and `characters` from the text
 * totals. Nothing here reads the document.
 */
export interface JobEstimateInput {
  /** Pages in the document. A whole number of at least 1; zero pages is refused. */
  readonly pages: number;
  /** Source characters across the document, used for the cost estimate. */
  readonly characters: number;
  /** Pages that need OCR because they carry no text layer. Never more than `pages`. */
  readonly scannedPages: number;
  /** Blocks the translation queue will send. Zero is allowed, and noted when text exists. */
  readonly blocks: number;
  /**
   * Model id used to price the job, for example `gpt-4o-mini`. `pricing.ts` resolves it
   * case-insensitively; a name it does not carry yields no cost estimate rather than a
   * made-up price. Empty or missing is treated as "no provider to price".
   */
  readonly provider: string;
}

/** Knobs that replace a documented constant, never what the estimate claims to measure. */
export interface EstimateOptions {
  /** Overrides {@link DEFAULT_EXTRACT_SECONDS_PER_PAGE}. Zero is allowed. */
  readonly extractSecondsPerPage?: number;
  /** Overrides {@link DEFAULT_OCR_SECONDS_PER_PAGE}. Zero is allowed. */
  readonly ocrSecondsPerPage?: number;
  /** Overrides {@link DEFAULT_TRANSLATE_SECONDS_PER_BLOCK}. Zero is allowed. */
  readonly translateSecondsPerBlock?: number;
  /** Overrides {@link DEFAULT_EXPORT_SECONDS_PER_PAGE}. Zero is allowed. */
  readonly exportSecondsPerPage?: number;
  /**
   * Rate row or model id used for the cost instead of `input.provider`. An explicit `null`
   * suppresses the cost estimate, which is how a caller prices nothing on purpose.
   */
  readonly pricing?: PricingInput;
  /**
   * Which side of the request the characters are priced as. Defaults to `both`, because a
   * translation sends the source and bills the produced text.
   */
  readonly direction?: CostDirection;
}

/** A model id, or a rate row the caller already holds, or nothing to price. */
export type PricingInput = string | ModelPricing | null | undefined;

// --- Result shapes ----------------------------------------------------------

/** The pipeline step a stage time belongs to. */
export type EstimateStageName = 'extract' | 'ocr' | 'translate' | 'export';

/** How well the constants fit the stage's workload. Ordered `low` < `medium` < `high`. */
export type EstimateConfidence = 'low' | 'medium' | 'high';

/** One stage of the job: what it is called, how long it takes, and how well that holds. */
export interface EstimateStage {
  readonly name: EstimateStageName;
  /** Estimated seconds, rounded to milliseconds. Zero when the stage has no work. */
  readonly seconds: number;
  readonly confidence: EstimateConfidence;
}

/**
 * What the job costs, from published list prices.
 *
 * `unit` is what the amount covers: one whole job, not one page or one request. A caller
 * that shows a rate ("$0.15 per million tokens") must take that from `pricing.ts`; this
 * number is the total for the document.
 */
export interface EstimateCost {
  /** Estimated list cost in `currency`. A planning figure, not a quote. */
  readonly amount: number;
  readonly currency: 'USD';
  readonly unit: 'job';
}

/** Everything a caller needs to show the estimate before starting the run. */
export interface JobEstimate {
  /** Stages in pipeline order: `extract`, `ocr` when scanned pages exist, `translate`, `export`. */
  readonly stages: readonly EstimateStage[];
  /** Sum of `stages[].seconds`, exactly, so the parts and the total agree. */
  readonly totalSeconds: number;
  /** The estimated cost, or `null` when the provider has no published price. */
  readonly cost: EstimateCost | null;
  /** The weakest stage's confidence: a chain is only as certain as its worst input. */
  readonly confidence: EstimateConfidence;
  /**
   * The constants this estimate used, in English, one per line, in pipeline order. These
   * are diagnostic strings rather than localised copy: `formatEstimate` is the sentence a
   * reader sees. An overridden constant says `(override)`; a default says `(default)`.
   */
  readonly assumptions: readonly string[];
}

// --- Reader-facing copy -----------------------------------------------------

/** The three languages this module carries a sentence for; the same union as `src/i18n.ts`. */
export type EstimateLanguage = 'vi' | 'en' | 'zh';

/** Every language {@link formatEstimate} carries a sentence for. */
export const ESTIMATE_LANGUAGES: readonly EstimateLanguage[] = ['vi', 'en', 'zh'];

/** Language used when the caller passes none, matching `DEFAULT_LOCALE` in `src/i18n.ts`. */
export const DEFAULT_ESTIMATE_LANGUAGE: EstimateLanguage = 'vi';

/** Which caveat a low-confidence estimate carries. */
type ConfidenceNote = 'scanned' | 'blocks';

const ESTIMATE_TEMPLATES: Readonly<Record<EstimateLanguage, (duration: string, cost: string) => string>> = {
  en: (duration, cost) => `Roughly ${duration}, ${cost}.`,
  vi: (duration, cost) => `Khoảng ${duration}, ${cost}.`,
  zh: (duration, cost) => `约 ${duration}，${cost}。`,
};

const KNOWN_COST: Readonly<Record<EstimateLanguage, string>> = {
  en: 'about {amount}',
  vi: 'chi phí {amount}',
  zh: '费用约 {amount}',
};

const UNKNOWN_COST: Readonly<Record<EstimateLanguage, string>> = {
  en: 'cost not estimated',
  vi: 'chưa ước tính được chi phí',
  zh: '费用未知',
};

const CONFIDENCE_NOTES: Readonly<Record<ConfidenceNote, Readonly<Record<EstimateLanguage, string>>>> = {
  scanned: {
    en: ' Low confidence: most of this document is scanned.',
    vi: ' Độ tin cậy thấp: phần lớn tài liệu là bản scan.',
    zh: ' 置信度低：文档大部分是扫描页。',
  },
  blocks: {
    en: ' Low confidence: the block count is missing, so the translation time is a floor.',
    vi: ' Độ tin cậy thấp: thiếu số khối, nên thời gian dịch chỉ là mức sàn.',
    zh: ' 置信度低：缺少块数量，翻译时间只是下限。',
  },
};

/** Units of a duration in each language; short forms, because the sentence carries the rest. */
const DURATION_UNITS: Readonly<
  Record<EstimateLanguage, Readonly<{ hour: string; minute: string; second: string; lessThanOne: string }>>
> = {
  en: { hour: 'h', minute: 'min', second: 's', lessThanOne: '<1 s' },
  vi: { hour: 'giờ', minute: 'phút', second: 'giây', lessThanOne: '<1 giây' },
  zh: { hour: '小时', minute: '分', second: '秒', lessThanOne: '<1 秒' },
};

// --- Estimate ---------------------------------------------------------------

/**
 * Estimates the wall time and the cost of running one document through the pipeline.
 *
 * The stages are always in pipeline order, and `totalSeconds` is their exact sum. `cost` is
 * `null` when the provider has no published price, which is a real answer: the time estimate
 * still holds and only the money is unknown. See the file comment for the confidence rules
 * and the refusals.
 */
export function estimateJob(input: JobEstimateInput, options: EstimateOptions = {}): JobEstimate {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('estimateJob needs the document shape: pages, characters, scannedPages and blocks.');
  }
  const opts: EstimateOptions = options ?? {};
  const pages = readPages(input.pages);
  const scannedPages = readCount(input.scannedPages, 'scannedPages');
  if (scannedPages > pages) {
    throw new RangeError(`scannedPages (${scannedPages}) cannot exceed pages (${pages}).`);
  }
  const characters = readCount(input.characters, 'characters');
  const blocks = readCount(input.blocks, 'blocks');
  const provider = typeof input.provider === 'string' ? input.provider : '';

  const extractRate = readRate(opts.extractSecondsPerPage, DEFAULT_EXTRACT_SECONDS_PER_PAGE, 'extractSecondsPerPage');
  const ocrRate = readRate(opts.ocrSecondsPerPage, DEFAULT_OCR_SECONDS_PER_PAGE, 'ocrSecondsPerPage');
  const translateRate = readRate(
    opts.translateSecondsPerBlock,
    DEFAULT_TRANSLATE_SECONDS_PER_BLOCK,
    'translateSecondsPerBlock',
  );
  const exportRate = readRate(opts.exportSecondsPerPage, DEFAULT_EXPORT_SECONDS_PER_PAGE, 'exportSecondsPerPage');

  const digitalPages = pages - scannedPages;
  const scannedShare = scannedPages / pages;
  // Characters without blocks means nobody counted the translation units, so the per-block
  // constant cannot be applied to the work that exists.
  const missingBlocks = blocks === 0 && characters > 0;

  const stages: EstimateStage[] = [
    { name: 'extract', seconds: secondsOf(digitalPages * extractRate), confidence: 'high' },
  ];
  if (scannedPages > 0) {
    stages.push({
      name: 'ocr',
      seconds: secondsOf(scannedPages * ocrRate),
      confidence: scannedShare >= MOSTLY_SCANNED_SHARE ? 'low' : 'medium',
    });
  }
  stages.push({ name: 'translate', seconds: secondsOf(blocks * translateRate), confidence: missingBlocks ? 'low' : 'high' });
  stages.push({ name: 'export', seconds: secondsOf(pages * exportRate), confidence: 'high' });

  const direction = readDirection(opts.direction);
  const pricingInput: PricingInput = opts.pricing !== undefined ? opts.pricing : provider;
  const cost = costEstimate(characters, pricingInput, direction);

  return {
    stages,
    totalSeconds: stages.reduce((sum, stage) => sum + stage.seconds, 0),
    cost,
    confidence: weakestOf(stages),
    assumptions: buildAssumptions({
      pages,
      scannedPages,
      digitalPages,
      characters,
      blocks,
      extractRate,
      ocrRate,
      translateRate,
      exportRate,
      options: opts,
      pricingInput,
      direction,
      cost,
      missingBlocks,
    }),
  };
}

// --- Cost -------------------------------------------------------------------

/**
 * Prices `characters` at the provider's published rates, or returns `null` when it has none.
 *
 * A string is resolved through `pricing.findModelPricing` and then priced by
 * `pricing.estimateCost` itself, so there is one implementation of the arithmetic. A
 * `ModelPricing` row is used as given, which is how a caller prices a provider the snapshot
 * table does not carry; the formula is the table's and `pricing.estimateTokens` does the
 * character-to-token conversion.
 *
 * `null` means "no published price", never free and never zero: a local model has no
 * per-token price to invent. The returned amount covers one job.
 */
export function costEstimate(
  characters: number,
  pricing: PricingInput,
  direction: CostDirection = DEFAULT_COST_DIRECTION,
): EstimateCost | null {
  const count = readCount(characters, 'characters');

  if (typeof pricing === 'string') {
    const priced = priceFromTable({ characters: count, model: pricing, direction });
    return priced === null ? null : { amount: priced.usd, currency: 'USD', unit: 'job' };
  }

  const row = readPricingRow(pricing);
  if (row === undefined) return null;
  // The same arithmetic `pricing.ts` runs, including its reading of an unknown direction as
  // `both`, so a row and a table entry with equal rates produce equal numbers.
  const tokens = estimateTokens(count);
  const inputTokens = direction === 'output' ? 0 : tokens;
  const outputTokens = direction === 'input' ? 0 : tokens;
  const amount = (inputTokens * row.inputUsdPerMillion + outputTokens * row.outputUsdPerMillion) / 1_000_000;
  return { amount, currency: 'USD', unit: 'job' };
}

// --- Formatting -------------------------------------------------------------

/**
 * A duration as the short form a sentence can carry: `4 min 20 s`, `45 s`, `1 h 5 min`.
 *
 * Rounded to the nearest second first, because sub-second precision in a planning figure is
 * noise. Above an hour the seconds are dropped rather than shown as `1 h 5 min 3 s`: the
 * estimate is not accurate to three seconds once it runs past an hour. A duration under a
 * second reads `<1 s` rather than `0 s`, which would look like no work at all.
 */
export function formatDuration(seconds: number, language: EstimateLanguage = DEFAULT_ESTIMATE_LANGUAGE): string {
  const lang = readLanguage(language);
  const units = DURATION_UNITS[lang];
  const rounded = Math.round(readSeconds(seconds));
  if (rounded < 1) return units.lessThanOne;

  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const rest = rounded % 60;
  if (hours > 0) return minutes > 0 ? `${hours} ${units.hour} ${minutes} ${units.minute}` : `${hours} ${units.hour}`;
  if (minutes > 0) return rest > 0 ? `${minutes} ${units.minute} ${rest} ${units.second}` : `${minutes} ${units.minute}`;
  return `${rest} ${units.second}`;
}

/**
 * One sentence for the reader: roughly how long, and what it costs.
 *
 * The cost clause says `cost not estimated` when {@link JobEstimate.cost} is `null`, so an
 * unknown price is not shown as free. A `low` confidence estimate appends its caveat — that
 * most of the document is scanned, or that no block count was available — because a number
 * this module calls uncertain must not be presented as if it were not. An unknown language
 * falls back to {@link DEFAULT_ESTIMATE_LANGUAGE} rather than to blank copy.
 */
export function formatEstimate(
  estimate: JobEstimate,
  language: EstimateLanguage = DEFAULT_ESTIMATE_LANGUAGE,
): string {
  const lang = readLanguage(language);
  const result = readEstimate(estimate);
  const duration = formatDuration(result.totalSeconds, lang);
  const cost =
    result.cost === null
      ? UNKNOWN_COST[lang]
      : KNOWN_COST[lang].replace('{amount}', formatUsd(result.cost.amount));
  const note = result.note === null ? '' : CONFIDENCE_NOTES[result.note][lang];
  return ESTIMATE_TEMPLATES[lang](duration, cost) + note;
}

// --- Assumptions ------------------------------------------------------------

/** Everything {@link buildAssumptions} describes; internal, so it is not part of the API. */
interface AssumptionContext {
  readonly pages: number;
  readonly scannedPages: number;
  readonly digitalPages: number;
  readonly characters: number;
  readonly blocks: number;
  readonly extractRate: number;
  readonly ocrRate: number;
  readonly translateRate: number;
  readonly exportRate: number;
  readonly options: EstimateOptions;
  readonly pricingInput: PricingInput;
  readonly direction: CostDirection;
  readonly cost: EstimateCost | null;
  readonly missingBlocks: boolean;
}

/**
 * The constants this estimate used, in pipeline order.
 *
 * Each line names the rate, whether it is the default or an override, and the count it was
 * multiplied by, which is what makes the total reproducible from the list. The cost line
 * names the rate basis; when there is no price it says so instead of omitting the line, so
 * "no money" and "no number" are visibly different.
 */
function buildAssumptions(context: AssumptionContext): string[] {
  const { pages, scannedPages, digitalPages, characters, blocks } = context;
  const lines: string[] = [
    `Text extraction: ${number(context.extractRate)} s per digital page (${sourceOf(context.options.extractSecondsPerPage)}); ${digitalPages} of ${countOf(pages, 'page')} digital.`,
  ];

  if (scannedPages > 0) {
    lines.push(
      `OCR: ${number(context.ocrRate)} s per scanned page (${sourceOf(context.options.ocrSecondsPerPage)}); ${scannedPages} of ${countOf(pages, 'page')} scanned.`,
    );
  }

  lines.push(
    `Translation: ${number(context.translateRate)} s per block (${sourceOf(context.options.translateSecondsPerBlock)}); ${countOf(blocks, 'block')}.`,
  );
  if (context.missingBlocks) {
    lines.push(
      'Translation blocks were not counted, so the per-block constant cannot be applied; the stage is a floor, not an estimate.',
    );
  }

  lines.push(
    `Export: ${number(context.exportRate)} s per page (${sourceOf(context.options.exportSecondsPerPage)}); ${countOf(pages, 'page')}.`,
  );
  lines.push(costAssumption(context));

  return lines;
}

/** The cost line: the rate basis when there is one, and the reason when there is not. */
function costAssumption(context: AssumptionContext): string {
  const label = pricingLabel(context.pricingInput);
  if (label === null) {
    return 'Cost: no provider or rate row was supplied; this estimate covers time only.';
  }

  if (context.cost === null) {
    return `Cost: no published price for "${label}"; this estimate covers time only.`;
  }

  // A model id resolves to the table's canonical spelling, so the line names the row that
  // was used rather than whatever case the caller typed.
  const canonical = typeof context.pricingInput === 'string' ? (findModelPricing(context.pricingInput)?.model ?? label) : label;
  return `Cost: ${canonical} list price, ${CHARACTERS_PER_TOKEN} characters per token, ${directionPhrase(context.direction)}; ${countOf(context.characters, 'character')}.`;
}

// --- Helpers ----------------------------------------------------------------

/** Rounds a stage time to milliseconds, so the reported stages add up to the reported total. */
function secondsOf(seconds: number): number {
  return Math.round(seconds * MILLISECONDS_PER_SECOND) / MILLISECONDS_PER_SECOND;
}

const CONFIDENCE_RANK: Readonly<Record<EstimateConfidence, number>> = { low: 0, medium: 1, high: 2 };

function weakestOf(stages: readonly EstimateStage[]): EstimateConfidence {
  let weakest: EstimateConfidence = 'high';
  for (const stage of stages) {
    if (CONFIDENCE_RANK[stage.confidence] < CONFIDENCE_RANK[weakest]) weakest = stage.confidence;
  }
  return weakest;
}

/** `default` or `override`, for the assumption line that names where a rate came from. */
function sourceOf(raw: unknown): 'default' | 'override' {
  return raw === undefined ? 'default' : 'override';
}

function directionPhrase(direction: CostDirection): string {
  if (direction === 'input') return 'input only';
  if (direction === 'output') return 'output only';
  return 'input and output both counted';
}

/** Where a cost's rate came from, or `null` when there is nothing to name. */
function pricingLabel(pricing: PricingInput): string | null {
  if (typeof pricing === 'string') return pricing.trim().length > 0 ? pricing.trim() : null;
  if (pricing !== null && pricing !== undefined && typeof pricing === 'object') {
    const model = pricing.model;
    if (typeof model === 'string' && model.trim().length > 0) return model.trim();
  }
  return null;
}

/** A usable rate row, or `undefined` when the caller's object cannot be priced. */
function readPricingRow(pricing: PricingInput): ModelPricing | undefined {
  if (pricing === null || pricing === undefined || typeof pricing !== 'object') return undefined;
  const { model, inputUsdPerMillion, outputUsdPerMillion } = pricing;
  if (typeof model !== 'string' || model.trim().length === 0) return undefined;
  if (!isRate(inputUsdPerMillion) || !isRate(outputUsdPerMillion)) return undefined;
  return { model, inputUsdPerMillion, outputUsdPerMillion };
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A page count that describes a document: a whole number of at least one. */
function readPages(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`estimateJob needs at least one whole page, got ${describeValue(value)}.`);
  }
  return value;
}

/** A workload count: finite and non-negative, floored to a whole count. */
function readCount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number, got ${describeValue(value)}.`);
  }
  return Math.floor(value);
}

/** A stage rate: finite and non-negative. Zero is a valid way to remove a stage. */
function readRate(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  throw new RangeError(`${name} must be a finite non-negative number of seconds, got ${describeValue(value)}.`);
}

/** A cost direction, or the default when the caller did not choose one. */
function readDirection(value: unknown): CostDirection {
  if (value === undefined) return DEFAULT_COST_DIRECTION;
  if (value === 'input' || value === 'output' || value === 'both') return value;
  throw new RangeError(`direction must be "input", "output" or "both", got ${describeValue(value)}.`);
}

/** Seconds of a duration: finite and non-negative. */
function readSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`formatDuration needs a finite non-negative number of seconds, got ${describeValue(value)}.`);
  }
  return value;
}

/** What {@link readEstimate} trusts after checking it: the total, the cost, and the caveat. */
interface ReadEstimate {
  readonly totalSeconds: number;
  readonly cost: EstimateCost | null;
  readonly note: ConfidenceNote | null;
}

/** Validates an estimate before formatting it, so a hand-built object cannot print `NaN`. */
function readEstimate(value: JobEstimate | null | undefined): ReadEstimate {
  if (value === null || value === undefined || typeof value !== 'object') {
    throw new TypeError('formatEstimate needs the estimate estimateJob returned.');
  }
  const { stages, totalSeconds, cost, confidence } = value;
  if (!Array.isArray(stages)) {
    throw new TypeError('formatEstimate needs the stages array estimateJob returned.');
  }
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    throw new TypeError('formatEstimate needs a finite non-negative totalSeconds.');
  }
  return {
    totalSeconds,
    cost: readCost(cost),
    note: confidence === 'low' ? noteFor(stages) : null,
  };
}

/** A cost object that can be printed, or `null` when there is no price. */
function readCost(value: unknown): EstimateCost | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') {
    throw new TypeError('formatEstimate needs cost to be null or the object estimateJob returned.');
  }
  const amount = (value as { amount?: unknown }).amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new TypeError('formatEstimate needs a finite non-negative cost amount.');
  }
  return value as EstimateCost;
}

/** Why a low-confidence estimate is low: the scanned share, or the missing block count. */
function noteFor(stages: readonly EstimateStage[]): ConfidenceNote {
  for (const stage of stages) {
    if (stage !== null && typeof stage === 'object' && stage.name === 'ocr' && stage.confidence === 'low') {
      return 'scanned';
    }
  }
  return 'blocks';
}

/** Reads a language this module carries copy for, falling back to the default. */
function readLanguage(value: unknown): EstimateLanguage {
  return value === 'vi' || value === 'en' || value === 'zh' ? value : DEFAULT_ESTIMATE_LANGUAGE;
}

/** A rate as an assumption line prints it: no locale, no thousands separators, byte-stable. */
function number(value: number): string {
  return String(value);
}

/** `1 page` / `2 pages`; `block` and `character` take their own plural. */
function countOf(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function describeValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  return typeof value;
}
