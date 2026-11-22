import { OcrError } from './engine';
import type { PageKind } from '../core/classify';
import {
  buildDocument,
  rectPolygon,
  validate,
  type BuildBlockInput,
  type DocumentIR,
  type PageRotation,
  type Polygon,
} from '../core/ir';
import {
  mergeMixedPageBlocks,
  planMixedPageOcr,
  type CandidateImageRegionInput,
  type DigitalBlockInput,
  type MixedOcrOptions,
  type OcrRegionBlockInput,
  type PlannedOcrTask,
} from '../core/mixed-ocr';
import type { Rect } from '../core/types';
import type { OcrBbox, OcrLine, OcrWord } from './engine';
import { DEFAULT_OCR_LANGUAGES } from './engine';
import { mergeWordsToBlocks, normalizeBbox, type OcrBlock } from './geometry';
import type { OcrPageModel } from './pipeline';
import { MAX_SCALED_PIXELS } from './preprocess';

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const DEFAULT_REVIEW_CONFIDENCE = 0.75;
const DEFAULT_MIN_WORD_CONFIDENCE = 35;
const DEFAULT_MAX_CHARS = 1200;

export type OcrAdapterRoute = 'scanned' | 'hybrid';
export type OcrAdapterStatus = 'ok' | 'review' | 'skipped' | 'failed';
export type OcrFailureCode = 'invalid-input' | 'recognition-failed' | 'empty-result' | 'unavailable';
export type OcrReviewCode = 'low-confidence' | 'dropped-words' | 'empty-region';

export interface OcrPageGeometry {
  index: number;
  width: number;
  height: number;
  rotation?: PageRotation;
}

export interface OcrRecognitionRequest {
  page: OcrPageGeometry;
  region?: PlannedOcrTask;
  signal?: AbortSignal;
  languages: readonly string[];
  preprocess: true;
  maxPreprocessPixels: number;
  minConfidence: number;
}

export type OcrRecognizer = (request: OcrRecognitionRequest) => Promise<OcrPageModel>;

export type OcrPageModelWithLines = OcrPageModel & { lines?: readonly OcrLine[] };

export interface OcrAdapterOptions {
  engine: string;
  language?: string;
  ocrLanguages?: readonly string[];
  reviewConfidence?: number;
  minWordConfidence?: number;
  maxChars?: number;
  maxPreprocessPixels?: number;
  mixed?: MixedOcrOptions;
}

export interface OcrReviewFlag {
  code: OcrReviewCode;
  message: string;
  blockIds: string[];
  regionId?: string;
}

export interface OcrAdapterSuccess {
  status: 'ok' | 'review';
  route: OcrAdapterRoute;
  document: DocumentIR;
  flags: OcrReviewFlag[];
  regionsProcessed: number;
}

export interface OcrAdapterSkipped {
  status: 'skipped';
  route: PageKind;
  reason: 'digital-page' | 'no-ocr-regions';
  regionsProcessed: 0;
}

export interface OcrAdapterFailure {
  status: 'failed';
  route: OcrAdapterRoute;
  code: OcrFailureCode;
  message: string;
  flags: OcrReviewFlag[];
  regionsProcessed: number;
}

export type OcrAdapterOutcome = OcrAdapterSuccess | OcrAdapterSkipped | OcrAdapterFailure;

export interface OcrPageAdapterInput {
  model: OcrPageModel;
  page: OcrPageGeometry;
  sourceSha256: string;
  options: OcrAdapterOptions;
  region?: Rect;
  regionId?: string;
}

export interface OcrPageAdapterResult {
  blocks: BuildBlockInput[];
  language: string;
  flags: OcrReviewFlag[];
}

interface NormalizedOcrBlock {
  block: OcrBlock;
  confidence: number;
}

interface RegionAdaptation {
  blocks: OcrRegionBlockInput[];
  language: string;
  flags: OcrReviewFlag[];
}

export function adaptOcrPageModel(input: OcrPageAdapterInput): OcrPageAdapterResult {
  validateAdapterInput(input.page, input.sourceSha256, input.options);
  const language = languageOf(input.model, input.options.language);
  const normalized = normalizeModelBlocks(input.model, input.options.maxChars ?? DEFAULT_MAX_CHARS);
  const target = input.region ?? { x: 0, y: 0, width: input.page.width, height: input.page.height };
  const blocks = normalized.map((entry, index) => {
    const rect = mapRectToPage(entry.block.rect, input.model.width, input.model.height, target, input.page);
    return {
      id: `ocr-p${input.page.index}-r${index + 1}`,
      page: input.page.index,
      text: entry.block.text,
      rect,
      polygon: roundedRectPolygon(rect),
      confidence: entry.confidence,
      language,
      origin: 'ocr' as const,
    } satisfies BuildBlockInput;
  });

  return {
    blocks,
    language,
    flags: reviewFlags(input.model, blocks.map(block => block.id), input.options, input.regionId),
  };
}

export function adaptOcrPageModelToDocument(input: OcrPageAdapterInput): DocumentIR {
  const adapted = adaptOcrPageModel(input);
  const document = buildDocument({
    blocks: adapted.blocks,
    pages: [{
      index: input.page.index,
      width: input.page.width,
      height: input.page.height,
      rotation: input.page.rotation ?? 0,
    }],
    sourceSha256: input.sourceSha256,
    language: adapted.language,
    ocrEngine: input.options.engine,
  });
  const problems = validate(document);
  if (problems.length > 0) {
    throw new OcrAdapterError('invalid-input', problems[0]?.message ?? 'OCR output produced an invalid Document IR.');
  }
  return document;
}

export interface RunOcrToDocumentInput {
  page: OcrPageGeometry;
  pageKind: PageKind;
  sourceSha256: string;
  digitalBlocks?: readonly DigitalBlockInput[];
  imageRegions?: readonly CandidateImageRegionInput[];
  signal?: AbortSignal;
  options: OcrAdapterOptions;
  recognize: OcrRecognizer;
}

export async function runOcrToDocumentIR(input: RunOcrToDocumentInput): Promise<OcrAdapterOutcome> {
  try {
    validateAdapterInput(input.page, input.sourceSha256, input.options);
    throwIfAborted(input.signal);

    if (input.pageKind === 'digital') {
      return { status: 'skipped', route: 'digital', reason: 'digital-page', regionsProcessed: 0 };
    }

    const plan = input.pageKind === 'scanned'
      ? undefined
      : planMixedPageOcr({
          page: input.page.index,
          width: input.page.width,
          height: input.page.height,
          digitalBlocks: input.digitalBlocks ?? [],
          imageRegions: input.imageRegions ?? [],
        }, input.options.mixed);

    if (plan && plan.ocrTasks.length === 0) {
      return { status: 'skipped', route: 'hybrid', reason: 'no-ocr-regions', regionsProcessed: 0 };
    }

    const route: OcrAdapterRoute = input.pageKind;
    const languages = input.options.ocrLanguages?.length
      ? [...input.options.ocrLanguages]
      : [...DEFAULT_OCR_LANGUAGES];
    const maxPreprocessPixels = boundedPreprocessPixels(input.options.maxPreprocessPixels);
    const minConfidence = boundedMinConfidence(input.options.minWordConfidence);
    const models: Array<{ model: OcrPageModel; task?: PlannedOcrTask }> = [];

    if (!plan) {
      const model = await recognize(input.recognize, {
        page: input.page,
        signal: input.signal,
        languages,
        preprocess: true,
        maxPreprocessPixels,
        minConfidence,
      });
      models.push({ model });
    } else {
      for (const task of plan.ocrTasks) {
        throwIfAborted(input.signal);
        const model = await recognize(input.recognize, {
          page: input.page,
          region: task,
          signal: input.signal,
          languages,
          preprocess: true,
          maxPreprocessPixels,
          minConfidence,
        });
        models.push({ model, task });
      }
    }

    throwIfAborted(input.signal);
    return route === 'scanned'
      ? finishScanned(input, models[0]?.model, models.length)
      : finishHybrid(input, plan!, models);
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) throw asAbortError(error);
    if (error instanceof OcrAdapterError) {
      return {
        status: 'failed',
        route: input.pageKind === 'hybrid' ? 'hybrid' : 'scanned',
        code: error.code,
        message: error.message,
        flags: [],
        regionsProcessed: 0,
      };
    }
    return {
      status: 'failed',
      route: input.pageKind === 'hybrid' ? 'hybrid' : 'scanned',
      code: error instanceof OcrError && error.code === 'unavailable' ? 'unavailable' : 'recognition-failed',
      message: error instanceof Error ? error.message : String(error),
      flags: [],
      regionsProcessed: 0,
    };
  }
}

export class OcrAdapterError extends Error {
  readonly code: OcrFailureCode;

  constructor(code: OcrFailureCode, message: string) {
    super(message);
    this.name = 'OcrAdapterError';
    this.code = code;
  }
}

function finishScanned(
  input: RunOcrToDocumentInput,
  model: OcrPageModel | undefined,
  regionsProcessed: number,
): OcrAdapterOutcome {
  if (!model) {
    return { status: 'failed', route: 'scanned', code: 'empty-result', message: 'OCR produced no page result.', flags: [], regionsProcessed };
  }
  const adapted = adaptOcrPageModel({
    model,
    page: input.page,
    sourceSha256: input.sourceSha256,
    options: input.options,
  });
  if (!adapted.blocks.length) {
    return { status: 'failed', route: 'scanned', code: 'empty-result', message: 'OCR recognized no usable text blocks.', flags: adapted.flags, regionsProcessed };
  }
  const document = adaptOcrPageModelToDocument({
    model,
    page: input.page,
    sourceSha256: input.sourceSha256,
    options: input.options,
  });
  return success('scanned', document, adapted.flags, regionsProcessed);
}

function finishHybrid(
  input: RunOcrToDocumentInput,
  plan: ReturnType<typeof planMixedPageOcr>,
  models: Array<{ model: OcrPageModel; task?: PlannedOcrTask }>,
): OcrAdapterOutcome {
  const ocrBlocks: OcrRegionBlockInput[] = [];
  const flags: OcrReviewFlag[] = [];
  const languageByBlock = new Map<string, string>();

  models.forEach(({ model, task }, regionIndex) => {
    const target = task?.rect ?? { x: 0, y: 0, width: input.page.width, height: input.page.height };
    const adapted = adaptOcrPageModel({
      model,
      page: input.page,
      sourceSha256: input.sourceSha256,
      options: input.options,
      region: target,
      regionId: task?.regionId,
    });
    flags.push(...adapted.flags);
    adapted.blocks.forEach((block, blockIndex) => {
      const id = `ocr-region-p${input.page.index}-${regionIndex + 1}-r${blockIndex + 1}`;
      ocrBlocks.push({
        id,
        regionId: task?.regionId,
        rect: block.rect,
        polygon: block.polygon,
        text: block.text,
        confidence: block.confidence,
      });
      languageByBlock.set(id, adapted.language);
    });
  });

  const merged = mergeMixedPageBlocks({
    page: input.page.index,
    width: input.page.width,
    height: input.page.height,
    digitalBlocks: input.digitalBlocks ?? [],
    ocrBlocks,
  }, input.options.mixed);

  if (!merged.blocks.length) {
    return {
      status: 'failed',
      route: 'hybrid',
      code: 'empty-result',
      message: 'Hybrid OCR produced no usable digital or OCR blocks.',
      flags,
      regionsProcessed: models.length,
    };
  }

  const defaultLanguage = input.options.language ?? 'und';
  const blocks: BuildBlockInput[] = merged.blocks.map(block => ({
    id: block.id,
    page: block.page,
    text: block.text,
    rect: block.rect,
    polygon: block.polygon,
    confidence: block.confidence,
    language: block.source === 'ocr-region' ? languageByBlock.get(block.id) ?? defaultLanguage : defaultLanguage,
    origin: block.source === 'ocr-region' ? 'ocr' : 'pdf-text',
  }));
  const document = buildDocument({
    blocks,
    pages: [{ index: input.page.index, width: input.page.width, height: input.page.height, rotation: input.page.rotation ?? 0 }],
    sourceSha256: input.sourceSha256,
    language: defaultLanguage,
    ocrEngine: input.options.engine,
  });
  const problems = validate(document);
  if (problems.length > 0) {
    return { status: 'failed', route: 'hybrid', code: 'invalid-input', message: problems[0]?.message ?? 'Hybrid OCR produced an invalid Document IR.', flags, regionsProcessed: models.length };
  }
  return success('hybrid', document, flags, models.length);
}

function success(route: OcrAdapterRoute, document: DocumentIR, flags: OcrReviewFlag[], regionsProcessed: number): OcrAdapterSuccess {
  return { status: flags.length ? 'review' : 'ok', route, document, flags, regionsProcessed };
}

function normalizeModelBlocks(model: OcrPageModel, maxChars: number): NormalizedOcrBlock[] {
  const words = collectWords(model);
  if (!words.length) return [];
  const blocks = mergeWordsToBlocks(words, { maxChars });
  return blocks.map(block => ({ block, confidence: confidenceForBlock(block, words) }));
}

function collectWords(model: OcrPageModel): OcrWord[] {
  const lines = (model as OcrPageModelWithLines).lines ?? [];
  const source = model.words.length
    ? model.words
    : lines.flatMap(line => line.words.length ? line.words : [{ text: line.text, confidence: line.confidence, bbox: line.bbox }]);
  const seen = new Set<string>();
  const words: OcrWord[] = [];
  for (const word of source) {
    const bbox = normalizeBbox(word.bbox, model.width, model.height);
    const text = word.text.replace(/\s+/g, ' ').trim();
    if (!bbox || !text) continue;
    const confidence = Number.isFinite(word.confidence) ? Math.max(0, Math.min(100, word.confidence)) : 0;
    const key = `${text}\u0000${bbox.x0}\u0000${bbox.y0}\u0000${bbox.x1}\u0000${bbox.y1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    words.push({ text, confidence, bbox });
  }
  return words;
}

function confidenceForBlock(block: OcrBlock, words: readonly OcrWord[]): number {
  const matched = words.filter(word => intersects(block.rect, word.bbox));
  const values = matched.length ? matched.map(word => word.confidence) : [0];
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.round((average / 100) * 1000) / 1000;
}

function mapRectToPage(rect: Rect, sourceWidth: number, sourceHeight: number, target: Rect, page: OcrPageGeometry): Rect {
  const sx = target.width / Math.max(1, sourceWidth);
  const sy = target.height / Math.max(1, sourceHeight);
  const x = target.x + rect.x * sx;
  const y = target.y + rect.y * sy;
  const right = x + rect.width * sx;
  const bottom = y + rect.height * sy;
  const left = Math.max(0, Math.min(page.width, x));
  const top = Math.max(0, Math.min(page.height, y));
  const clampedRight = Math.max(left, Math.min(page.width, right));
  const clampedBottom = Math.max(top, Math.min(page.height, bottom));
  return {
    x: roundCoord(left),
    y: roundCoord(top),
    width: roundCoord(clampedRight - left),
    height: roundCoord(clampedBottom - top),
  };
}

function roundCoord(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundedRectPolygon(rect: Rect): Polygon {
  const [topLeft, topRight, bottomRight, bottomLeft] = rectPolygon(rect);
  return [
    { x: roundCoord(topLeft.x), y: roundCoord(topLeft.y) },
    { x: roundCoord(topRight.x), y: roundCoord(topRight.y) },
    { x: roundCoord(bottomRight.x), y: roundCoord(bottomRight.y) },
    { x: roundCoord(bottomLeft.x), y: roundCoord(bottomLeft.y) },
  ];
}

function reviewFlags(model: OcrPageModel, blockIds: string[], options: OcrAdapterOptions, regionId?: string): OcrReviewFlag[] {
  const flags: OcrReviewFlag[] = [];
  const threshold = boundedReviewConfidence(options.reviewConfidence);
  const mean = model.ocr.meanConfidence / 100;
  if (mean < threshold && blockIds.length) {
    flags.push({
      code: 'low-confidence',
      message: `OCR mean confidence ${model.ocr.meanConfidence.toFixed(1)}% is below ${(threshold * 100).toFixed(1)}%.`,
      blockIds: [...blockIds],
      ...(regionId ? { regionId } : {}),
    });
  }
  if (model.ocr.droppedWords > 0) {
    flags.push({
      code: 'dropped-words',
      message: `OCR dropped ${model.ocr.droppedWords} word${model.ocr.droppedWords === 1 ? '' : 's'} below the recognition threshold.`,
      blockIds: [...blockIds],
      ...(regionId ? { regionId } : {}),
    });
  }
  if (!blockIds.length) {
    flags.push({
      code: 'empty-region',
      message: regionId ? `OCR recognized no usable text in region ${regionId}.` : 'OCR recognized no usable text on the page.',
      blockIds: [],
      ...(regionId ? { regionId } : {}),
    });
  }
  return flags;
}

function languageOf(model: OcrPageModel, fallback?: string): string {
  return model.ocr.sourceLanguage.code || fallback || 'und';
}

function validateAdapterInput(page: OcrPageGeometry, sourceSha256: string, options: OcrAdapterOptions): void {
  if (!page || !Number.isInteger(page.index) || page.index < 1 || !(page.width > 0) || !(page.height > 0)) {
    throw new OcrAdapterError('invalid-input', 'OCR page geometry must have a positive 1-based index and dimensions.');
  }
  if (!SHA256_PATTERN.test(sourceSha256)) {
    throw new OcrAdapterError('invalid-input', 'OCR adapter requires the source PDF SHA-256.');
  }
  if (!options || !options.engine.trim()) {
    throw new OcrAdapterError('invalid-input', 'OCR adapter requires an engine identity.');
  }
}

function boundedPreprocessPixels(value: number | undefined): number {
  if (value === undefined) return MAX_SCALED_PIXELS;
  if (!Number.isFinite(value) || value <= 0) throw new OcrAdapterError('invalid-input', 'maxPreprocessPixels must be positive and finite.');
  return Math.min(MAX_SCALED_PIXELS, Math.floor(value));
}

function boundedReviewConfidence(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REVIEW_CONFIDENCE;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new OcrAdapterError('invalid-input', 'reviewConfidence must be between 0 and 1.');
  return value;
}

function boundedMinConfidence(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MIN_WORD_CONFIDENCE;
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new OcrAdapterError('invalid-input', 'minWordConfidence must be between 0 and 100.');
  return value;
}

async function recognize(recognizer: OcrRecognizer, request: OcrRecognitionRequest): Promise<OcrPageModel> {
  throwIfAborted(request.signal);
  try {
    const model = await recognizer(request);
    throwIfAborted(request.signal);
    return model;
  } catch (error) {
    if (request.signal?.aborted || isAbortError(error)) throw asAbortError(error);
    if (error instanceof OcrAdapterError) throw error;
    throw new OcrAdapterError('recognition-failed', error instanceof Error ? error.message : String(error));
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw asAbortError();
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError');
}

function asAbortError(error?: unknown): Error {
  if (isAbortError(error)) return error as Error;
  return typeof DOMException === 'function'
    ? new DOMException('OCR was aborted.', 'AbortError')
    : Object.assign(new Error('OCR was aborted.'), { name: 'AbortError' });
}

function intersects(rect: Rect, bbox: OcrBbox): boolean {
  return Math.min(rect.x + rect.width, bbox.x1) > Math.max(rect.x, bbox.x0)
    && Math.min(rect.y + rect.height, bbox.y1) > Math.max(rect.y, bbox.y0);
}
