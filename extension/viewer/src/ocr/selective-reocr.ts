/**
 * Bounded selective re-OCR for uncertain regions (F04/F09).
 *
 * This module never retries a whole page because a model reported a warning. It
 * derives regions only from observed OCR word geometry, expands them by a small
 * bounded padding, merges overlaps deterministically, and abstains when dropped
 * words have no recoverable coordinates. The recognizer remains an injected
 * local/runtime adapter, so this file performs no network or model loading.
 */

import { rectPolygon, type Polygon } from '../core/ir';
import type { PlannedOcrTask } from '../core/mixed-ocr';
import type { Rect } from '../core/types';
import type { OcrBbox, OcrWord } from './engine';
import { mergeWordsToBlocks, normalizeBbox } from './geometry';
import type {
  OcrPageGeometry,
  OcrPageModelWithLines,
  OcrRecognitionRequest,
  OcrRecognizer,
} from './document-adapter';
import type { OcrPageModel } from './pipeline';
import { MAX_SCALED_PIXELS } from './preprocess';
import {
  abstentionEvent,
  traceEvent,
  type OcrAbstention,
  type OcrTraceEvent,
} from './trace';

const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_PADDING_RATIO = 0.08;
const DEFAULT_MAX_REGIONS = 8;
const DEFAULT_IOU_THRESHOLD = 0.35;
const DEFAULT_MIN_WORD_CONFIDENCE = 35;

export type SelectiveReOcrReason = 'low-confidence' | 'dropped-words';

export interface SelectiveReOcrOptions {
  /** Region confidence below this value is eligible for a retry. */
  confidenceThreshold?: number;
  /** Padding around observed boxes, clamped to [0, 0.25]. */
  paddingRatio?: number;
  /** Maximum number of crops in this bounded pass. */
  maxRegions?: number;
  /** Overlap at or above which two uncertain regions are merged. */
  mergeIouThreshold?: number;
  /** Passed to the injected recognizer and capped at the preprocessing limit. */
  maxPreprocessPixels?: number;
  /** Confidence filter requested from the recognizer. */
  minWordConfidence?: number;
  /** Language hints are passed unchanged to the recognizer. */
  languages?: readonly string[];
  engine?: string;
  /** The recognizer's trust boundary. Cloud execution must be opted into. */
  execution?: 'local' | 'cloud';
  /** Refuse a cloud recognizer even when the caller supplied one. */
  offlineOnly?: boolean;
}

export interface SelectiveOcrRegion {
  id: string;
  rect: Rect;
  polygon: Polygon;
  confidence: number;
  blockIds: string[];
  reasons: SelectiveReOcrReason[];
}

export interface SelectiveReOcrPlan {
  status: 'planned' | 'abstain';
  regions: SelectiveOcrRegion[];
  tasks: PlannedOcrTask[];
  abstention?: OcrAbstention;
  trace: OcrTraceEvent[];
}

export interface SelectiveReOcrInput {
  page: OcrPageGeometry;
  model: OcrPageModel;
  options?: SelectiveReOcrOptions;
}

export interface SelectiveReOcrResult {
  status: 'ok' | 'abstain';
  plan: SelectiveReOcrPlan;
  results: Array<{ regionId: string; task: PlannedOcrTask; model: OcrPageModel }>;
  abstention?: OcrAbstention;
  trace: OcrTraceEvent[];
}

export interface RunSelectiveReOcrInput extends SelectiveReOcrInput {
  signal?: AbortSignal;
  recognize: OcrRecognizer;
}

interface Candidate {
  rect: Rect;
  confidence: number;
  blockId: string;
  reasons: SelectiveReOcrReason[];
}

interface MergedCandidate {
  rect: Rect;
  confidence: number;
  blockIds: string[];
  reasons: SelectiveReOcrReason[];
}

/** Plans only crops justified by low-confidence observed OCR geometry. */
export function planSelectiveReOcr(input: SelectiveReOcrInput): SelectiveReOcrPlan {
  validateInput(input.page, input.model);
  const options = resolveOptions(input.options);
  let trace: OcrTraceEvent[] = [];
  trace = traceEvent(trace, {
    stage: 'plan',
    status: 'started',
    message: 'Inspecting observed OCR geometry for bounded uncertain regions.',
    observed: true,
  });

  const words = collectWords(input.model);
  const blocks = mergeWordsToBlocks(words);
  const candidates: Candidate[] = [];
  const droppedReason: SelectiveReOcrReason[] = input.model.ocr.droppedWords > 0 ? ['dropped-words'] : [];

  blocks.forEach((block, index) => {
    const blockWords = words.filter(word => intersects(block.rect, word.bbox));
    const confidence = blockWords.length
      ? blockWords.reduce((sum, word) => sum + normalizeConfidence(word.confidence), 0) / blockWords.length
      : 0;
    if (confidence >= options.confidenceThreshold) return;
    candidates.push({
      rect: paddedRect(block.rect, options.paddingRatio, input.page),
      confidence: round(confidence),
      blockId: `ocr-block-${index + 1}`,
      reasons: ['low-confidence', ...droppedReason],
    });
  });

  if (!candidates.length) {
    const abstention: OcrAbstention = input.model.ocr.droppedWords > 0 && !words.length
      ? {
          code: 'no-region-geometry',
          message: 'OCR reported dropped words, but no retained word geometry identifies a safe crop.',
          observed: `droppedWords=${input.model.ocr.droppedWords}; retainedWords=0`,
        }
      : {
          code: 'no-uncertain-regions',
          message: 'No observed OCR block is below the selective re-OCR confidence threshold.',
          observed: `threshold=${options.confidenceThreshold}; blocks=${blocks.length}`,
        };
    trace = abstentionEvent(trace, abstention);
    return { status: 'abstain', regions: [], tasks: [], abstention, trace };
  }

  const merged = mergeCandidates(candidates, options.mergeIouThreshold)
    .sort(compareCandidates)
    .slice(0, options.maxRegions);
  const regions = merged.map((candidate, index) => {
    const id = `reocr-p${input.page.index}-r${index + 1}`;
    return {
      id,
      rect: candidate.rect,
      polygon: roundedPolygon(rectPolygon(candidate.rect)),
      confidence: candidate.confidence,
      blockIds: [...candidate.blockIds].sort(compareText),
      reasons: [...candidate.reasons].sort(compareText),
    };
  });
  const tasks = regions.map(region => ({
    id: region.id,
    regionId: region.id,
    origin: 'corrupted-digital' as const,
    rect: region.rect,
    polygon: region.polygon,
    rotation: 0,
    excludedRects: [],
    reasons: [...region.reasons],
  }));

  trace = traceEvent(trace, {
    stage: 'plan',
    status: 'completed',
    message: `Planned ${regions.length} bounded selective re-OCR region${regions.length === 1 ? '' : 's'}.`,
    observed: true,
  });
  return { status: 'planned', regions, tasks, trace };
}

/** Executes the plan without falling back to a whole-page retry. */
export async function runSelectiveReOcr(input: RunSelectiveReOcrInput): Promise<SelectiveReOcrResult> {
  const plan = planSelectiveReOcr(input);
  let trace = [...plan.trace];
  if (plan.status === 'abstain') {
    return { status: 'abstain', plan, results: [], abstention: plan.abstention, trace };
  }

  const options = resolveOptions(input.options);
  if (options.offlineOnly && options.execution === 'cloud') {
    const abstention: OcrAbstention = {
      code: 'offline-engine-unavailable',
      message: 'Offline-only mode refused the cloud OCR adapter; no request was sent.',
      observed: `engine=${options.engine}; execution=cloud; offlineOnly=true`,
    };
    trace = traceEvent(trace, {
      stage: 'route',
      status: 'skipped',
      message: abstention.message,
      engine: options.engine,
      observed: true,
    });
    trace = abstentionEvent(trace, abstention);
    return { status: 'abstain', plan, results: [], abstention, trace };
  }
  const results: Array<{ regionId: string; task: PlannedOcrTask; model: OcrPageModel }> = [];
  for (const task of plan.tasks) {
    throwIfAborted(input.signal);
    trace = traceEvent(trace, {
      stage: 'recognize',
      status: 'started',
      message: `Running OCR for observed uncertain region ${task.regionId}.`,
      engine: options.engine,
      regionId: task.regionId,
      observed: true,
    });
    const request: OcrRecognitionRequest = {
      page: input.page,
      region: task,
      signal: input.signal,
      languages: [...options.languages],
      preprocess: true,
      maxPreprocessPixels: options.maxPreprocessPixels,
      minConfidence: options.minWordConfidence,
    };
    try {
      const model = await input.recognize(request);
      throwIfAborted(input.signal);
      if (!hasUsableText(model)) {
        trace = traceEvent(trace, {
          stage: 'recognize',
          status: 'abstained',
          message: `OCR returned no usable text for region ${task.regionId}; no text was invented.`,
          engine: options.engine,
          regionId: task.regionId,
          observed: true,
        });
        continue;
      }
      results.push({ regionId: task.regionId, task, model });
      trace = traceEvent(trace, {
        stage: 'recognize',
        status: 'completed',
        message: `OCR returned observed text for region ${task.regionId}.`,
        engine: options.engine,
        regionId: task.regionId,
        observed: true,
      });
    } catch (error) {
      if (input.signal?.aborted || isAbortError(error)) {
        trace = traceEvent(trace, {
          stage: 'recognize',
          status: 'aborted',
          message: `Selective OCR aborted before region ${task.regionId} completed.`,
          engine: options.engine,
          regionId: task.regionId,
          observed: true,
        });
        throw asAbortError(error);
      }
      trace = traceEvent(trace, {
        stage: 'recognize',
        status: 'failed',
        message: `Selective OCR failed for region ${task.regionId}: ${error instanceof Error ? error.message : String(error)}.`,
        engine: options.engine,
        regionId: task.regionId,
        observed: true,
      });
    }
  }

  if (results.length > 0) {
    return { status: 'ok', plan, results, trace };
  }
  const abstention: OcrAbstention = {
    code: 'empty-recognition',
    message: 'Selective OCR produced no usable region text; the runtime abstains from fabricating a result.',
    observed: `plannedRegions=${plan.regions.length}; usableResults=0`,
  };
  trace = abstentionEvent(trace, abstention);
  return { status: 'abstain', plan, results, abstention, trace };
}

function resolveOptions(input: SelectiveReOcrOptions | undefined): Required<Pick<SelectiveReOcrOptions, 'confidenceThreshold' | 'paddingRatio' | 'maxRegions' | 'mergeIouThreshold' | 'maxPreprocessPixels' | 'minWordConfidence' | 'languages' | 'engine' | 'execution' | 'offlineOnly'>> {
  const confidenceThreshold = input?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const paddingRatio = input?.paddingRatio ?? DEFAULT_PADDING_RATIO;
  const maxRegions = input?.maxRegions ?? DEFAULT_MAX_REGIONS;
  const mergeIouThreshold = input?.mergeIouThreshold ?? DEFAULT_IOU_THRESHOLD;
  const maxPreprocessPixels = input?.maxPreprocessPixels ?? MAX_SCALED_PIXELS;
  const minWordConfidence = input?.minWordConfidence ?? DEFAULT_MIN_WORD_CONFIDENCE;
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new RangeError('selective re-OCR confidenceThreshold must be between 0 and 1.');
  }
  if (!Number.isFinite(paddingRatio) || paddingRatio < 0 || paddingRatio > 0.25) {
    throw new RangeError('selective re-OCR paddingRatio must be between 0 and 0.25.');
  }
  if (!Number.isInteger(maxRegions) || maxRegions < 1) throw new RangeError('selective re-OCR maxRegions must be >= 1.');
  if (!Number.isFinite(mergeIouThreshold) || mergeIouThreshold < 0 || mergeIouThreshold > 1) {
    throw new RangeError('selective re-OCR mergeIouThreshold must be between 0 and 1.');
  }
  if (!Number.isFinite(maxPreprocessPixels) || maxPreprocessPixels <= 0) throw new RangeError('selective re-OCR maxPreprocessPixels must be positive.');
  if (!Number.isFinite(minWordConfidence) || minWordConfidence < 0 || minWordConfidence > 100) throw new RangeError('selective re-OCR minWordConfidence must be between 0 and 100.');
  return {
    confidenceThreshold,
    paddingRatio,
    maxRegions,
    mergeIouThreshold,
    maxPreprocessPixels: Math.min(MAX_SCALED_PIXELS, Math.floor(maxPreprocessPixels)),
    minWordConfidence,
    languages: [...(input?.languages ?? [])],
    engine: input?.engine ?? 'unknown-local-ocr',
    execution: input?.execution ?? 'local',
    offlineOnly: input?.offlineOnly ?? true,
  };
}

function validateInput(page: OcrPageGeometry, model: OcrPageModel): void {
  if (!page || !Number.isInteger(page.index) || page.index < 1 || !(page.width > 0) || !(page.height > 0)) {
    throw new RangeError('selective re-OCR requires positive page geometry.');
  }
  if (!model || !(model.width > 0) || !(model.height > 0) || !model.ocr) {
    throw new RangeError('selective re-OCR requires an OCR page model with dimensions and metadata.');
  }
}

function collectWords(model: OcrPageModel): OcrWord[] {
  const lines = (model as OcrPageModelWithLines).lines ?? [];
  const source = model.words.length
    ? model.words
    : lines.flatMap(line => line.words.length ? line.words : [{ text: line.text, confidence: line.confidence, bbox: line.bbox }]);
  const words: OcrWord[] = [];
  const seen = new Set<string>();
  for (const word of source) {
    const bbox = normalizeBbox(word.bbox, model.width, model.height);
    const text = word.text.replace(/\s+/gu, ' ').trim();
    if (!bbox || !text) continue;
    const key = `${text}\u0000${bbox.x0}\u0000${bbox.y0}\u0000${bbox.x1}\u0000${bbox.y1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    words.push({ text, confidence: Number.isFinite(word.confidence) ? word.confidence : 0, bbox });
  }
  return words;
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value)) / 100;
}

function paddedRect(rect: Rect, ratio: number, page: OcrPageGeometry): Rect {
  const padX = rect.width * ratio;
  const padY = rect.height * ratio;
  const left = Math.max(0, rect.x - padX);
  const top = Math.max(0, rect.y - padY);
  const right = Math.min(page.width, rect.x + rect.width + padX);
  const bottom = Math.min(page.height, rect.y + rect.height + padY);
  return { x: round(left), y: round(top), width: round(Math.max(0, right - left)), height: round(Math.max(0, bottom - top)) };
}

function mergeCandidates(candidates: readonly Candidate[], threshold: number): MergedCandidate[] {
  const merged: MergedCandidate[] = [];
  for (const candidate of [...candidates].sort(compareCandidates)) {
    const target = merged.find(entry => rectIou(entry.rect, candidate.rect) >= threshold);
    if (!target) {
      merged.push({ rect: candidate.rect, confidence: candidate.confidence, blockIds: [candidate.blockId], reasons: [...candidate.reasons] });
      continue;
    }
    target.rect = unionRect(target.rect, candidate.rect);
    target.confidence = Math.min(target.confidence, candidate.confidence);
    target.blockIds.push(candidate.blockId);
    target.reasons = [...new Set([...target.reasons, ...candidate.reasons])];
  }
  return merged;
}

function compareCandidates(a: { confidence: number; rect: Rect; blockIds?: string[]; blockId?: string }, b: { confidence: number; rect: Rect; blockIds?: string[]; blockId?: string }): number {
  return a.confidence - b.confidence
    || a.rect.y - b.rect.y
    || a.rect.x - b.rect.x
    || (a.blockIds?.[0] ?? a.blockId ?? '').localeCompare(b.blockIds?.[0] ?? b.blockId ?? '');
}

function rectIou(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = right > left && bottom > top ? (right - left) * (bottom - top) : 0;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function unionRect(a: Rect, b: Rect): Rect {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) };
}

function roundedPolygon(polygon: Polygon): Polygon {
  const [topLeft, topRight, bottomRight, bottomLeft] = polygon;
  return [
    { x: round(topLeft.x), y: round(topLeft.y) },
    { x: round(topRight.x), y: round(topRight.y) },
    { x: round(bottomRight.x), y: round(bottomRight.y) },
    { x: round(bottomLeft.x), y: round(bottomLeft.y) },
  ];
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function intersects(rect: Rect, bbox: OcrBbox): boolean {
  return Math.min(rect.x + rect.width, bbox.x1) > Math.max(rect.x, bbox.x0)
    && Math.min(rect.y + rect.height, bbox.y1) > Math.max(rect.y, bbox.y0);
}

function hasUsableText(model: OcrPageModel): boolean {
  return model.words.some(word => word.text.trim().length > 0)
    || (model as OcrPageModelWithLines).lines?.some(line => line.text.trim().length > 0) === true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw asAbortError();
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError');
}

function asAbortError(error?: unknown): Error {
  if (isAbortError(error)) return error as Error;
  return typeof DOMException === 'function'
    ? new DOMException('Selective OCR was aborted.', 'AbortError')
    : Object.assign(new Error('Selective OCR was aborted.'), { name: 'AbortError' });
}
