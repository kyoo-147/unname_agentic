/**
 * Query-driven, budget-bounded AgenticOCR state machine & crop cache (backlog F07).
 *
 * Clean-room design separating VLM reasoning, dual-resolution rasterization/cropping,
 * OCR extraction, LRU artifact caching, and polygon visual grounding:
 * - Turn 0 renders a compressed overview image (`maxOverviewLongestSide`) for cheap
 *   spatial localization while all subsequent crops cut from the full-resolution page.
 * - OCR crops optionally include white border padding (`ocrPaddingRatio`) and record
 *   the exact {@link CropTransform} so detected sub-elements project back to original
 *   page coordinates via 4-corner inverse transforms (`./visual-grounding`).
 * - Active VLM visual attachments are capped (`maxActiveCropImages`), demoting older
 *   turns into compact structured text reflection memory to avoid quadratic token growth.
 * - Explicit round, pixel, text-char, retry, timeout, and `AbortSignal` guards guarantee
 *   clean termination with partial grounded evidence instead of silent failure.
 */

import type { Rect } from './types';
import {
  bboxToQuad,
  clampAndOrderBBox,
  mapBBoxToOriginal,
  mergeOrDeduplicateRegions,
  planGridTiles,
  toPixelBox,
  validateNormalizedBBox,
  type CropPadding,
  type CropTransform,
  type NormalizedBBox,
  type Quad,
} from './visual-grounding';

// --- Public Types ----------------------------------------------------------

export type CropAngle = 0 | 90 | 180 | 270;
export type ZoomOcrMode = 'region' | 'text' | 'table' | 'equation' | 'image';
export type TargetResolution = 'normal' | 'high';
export type TileSweepGrid = '2x2' | '3x3';

export interface PageImageInput {
  pageId: string;
  /** 1-based page number matching `DocumentIR` and `TextBlock.page`. */
  pageIndex: number;
  width: number;
  height: number;
  sourceRef: string | Uint8Array;
}

export interface ImagePayload {
  id: string;
  width: number;
  height: number;
  byteLength: number;
  data: string | Uint8Array;
}

export interface CropRequest {
  page: PageImageInput;
  cropRectPx: Rect;
  angle: CropAngle;
  paddingPx: CropPadding;
  targetMaxLongestSide: number;
}

export interface CropRenderResult {
  ocrImage: ImagePayload;
  vlmImage: ImagePayload;
  transform: CropTransform;
}

export interface VisionCropper {
  renderOverview(page: PageImageInput, maxLongestSide: number, signal?: AbortSignal): Promise<ImagePayload>;
  cropAndTransform(request: CropRequest, signal?: AbortSignal): Promise<CropRenderResult>;
}

export interface OcrSubElement {
  text: string;
  localBBox?: NormalizedBBox;
  confidence?: number;
  kind?: 'text' | 'table' | 'equation' | 'region';
}

export interface OcrExtractRequest {
  image: ImagePayload;
  mode: Exclude<ZoomOcrMode, 'image'>;
  label?: string;
  signal?: AbortSignal;
}

export interface OcrExtractResult {
  text: string;
  elements?: OcrSubElement[];
  confidence?: number;
}

export interface OcrAdapter {
  extract(request: OcrExtractRequest): Promise<OcrExtractResult>;
}

export interface CandidateEvidence {
  content: string;
  bbox: NormalizedBBox;
  quad?: Quad;
  pageIndex: number;
  confidence?: number;
  label?: string;
}

export interface GroundedEvidence {
  content: string;
  bbox: NormalizedBBox;
  quad: Quad;
  pageIndex: number;
  confidence?: number;
  label?: string;
}

export type AgenticOcrAction =
  | {
      type: 'zoom_and_ocr';
      label: string;
      bbox: NormalizedBBox;
      angle?: CropAngle;
      mode: ZoomOcrMode;
      targetResolution?: TargetResolution;
    }
  | {
      type: 'tile_sweep';
      grid: TileSweepGrid;
    }
  | {
      type: 'stop_with_evidence';
      answerable: boolean;
      evidence: CandidateEvidence[];
    };

export interface VisualAttachment {
  id: string;
  role: 'overview' | 'crop' | 'tile';
  pageIndex: number;
  bbox: NormalizedBBox;
  image: ImagePayload;
}

export interface ReflectionMemoryEntry {
  round: number;
  action: 'zoom_and_ocr' | 'tile_sweep' | 'notice';
  bbox?: NormalizedBBox;
  angle?: CropAngle;
  mode?: ZoomOcrMode;
  extractedTextSummary: string;
  diagnosis: string;
}

export interface AgenticOcrTurnInput {
  round: number;
  maxRounds: number;
  windDown: boolean;
  query: string;
  pageIndex: number;
  images: readonly VisualAttachment[];
  memory: readonly ReflectionMemoryEntry[];
  systemNotice?: string;
  remainingBudget: {
    roundsLeft: number;
    pixelsLeft: number;
    textCharsLeft: number;
  };
  signal?: AbortSignal;
}

export interface AgenticOcrModel {
  judgeRelevance?(input: {
    query: string;
    overview: VisualAttachment;
    signal?: AbortSignal;
  }): Promise<{ relevant: boolean; reason?: string }>;

  nextStep(input: AgenticOcrTurnInput): Promise<AgenticOcrAction | string>;

  verifyEvidence?(input: {
    query: string;
    overview: VisualAttachment;
    evidence: readonly GroundedEvidence[];
    signal?: AbortSignal;
  }): Promise<{ verdict: 'accept' | 'reject'; reason?: string }>;
}

export interface AgenticOcrBudget {
  maxRounds: number;
  windDownAtRound: number;
  maxTotalPixels: number;
  maxOverviewLongestSide: number;
  maxCropLongestSide: number;
  maxHighResCropLongestSide: number;
  minCropLongestSide: number;
  maxTextChars: number;
  maxActiveCropImages: number;
  maxRetriesPerTool: number;
  timeoutMs?: number;
}

export interface AgenticOcrOptions {
  page: PageImageInput;
  query: string;
  cropper: VisionCropper;
  ocr: OcrAdapter;
  model: AgenticOcrModel;
  cache?: CropArtifactCache;
  budget?: Partial<AgenticOcrBudget>;
  ocrPaddingRatio?: number;
  dedupIouThreshold?: number;
  verify?: boolean;
  signal?: AbortSignal;
  now?: () => number;
}

export type AgenticOcrStatus = 'completed' | 'budget_exhausted' | 'irrelevant';

export interface AgenticOcrMetrics {
  roundsExecuted: number;
  totalPixelsUsed: number;
  totalTextChars: number;
  cropCalls: number;
  ocrCalls: number;
  cacheHits: number;
  cacheMisses: number;
  rejectedCalls: number;
  activeWindowCap: number;
}

export interface AgenticOcrResult {
  status: AgenticOcrStatus;
  answerable: boolean;
  verified: boolean;
  evidence: GroundedEvidence[];
  memory: ReflectionMemoryEntry[];
  metrics: AgenticOcrMetrics;
  reason?: string;
}

export type ActionParseErrorCode =
  | 'empty-payload'
  | 'simultaneous-actions'
  | 'malformed-json'
  | 'invalid-action';

export type ActionParseResult =
  | { ok: true; action: AgenticOcrAction }
  | { ok: false; code: ActionParseErrorCode; message: string };

export interface CropCacheKeyInput {
  pageId: string;
  bbox: NormalizedBBox;
  angle: CropAngle;
  padding: CropPadding;
  targetMaxPixels: number;
  mode: ZoomOcrMode;
  quantizeStep?: number;
}

export interface CropArtifactEntry {
  ocrImage: ImagePayload;
  vlmImage: ImagePayload;
  transform: CropTransform;
  ocrResult: OcrExtractResult;
}

export interface CropCacheStats {
  size: number;
  totalBytes: number;
  maxCacheBytes: number;
  maxEntries: number;
  hits: number;
  misses: number;
  evictions: number;
}

export class AgenticOcrError extends Error {
  readonly code: 'invalid-config' | 'invalid-page';

  constructor(code: 'invalid-config' | 'invalid-page', message: string) {
    super(message);
    this.name = 'AgenticOcrError';
    this.code = code;
  }
}

// --- Constants & Defaults --------------------------------------------------

export const DEFAULT_AGENTIC_OCR_BUDGET: AgenticOcrBudget = {
  maxRounds: 6,
  windDownAtRound: 5,
  maxTotalPixels: 4_000_000,
  maxOverviewLongestSide: 1024,
  maxCropLongestSide: 1536,
  maxHighResCropLongestSide: 2048,
  minCropLongestSide: 224,
  maxTextChars: 40_000,
  maxActiveCropImages: 3,
  maxRetriesPerTool: 2,
};

const DEFAULT_OCR_PADDING_RATIO = 0.15;
const DEFAULT_DEDUP_IOU_THRESHOLD = 0.5;
const MEMORY_SUMMARY_MAX_CHARS = 240;

const VALID_ANGLES = new Set<number>([0, 90, 180, 270]);
const VALID_MODES = new Set<string>(['region', 'text', 'table', 'equation', 'image']);
const VALID_GRIDS = new Set<string>(['2x2', '3x3']);

const PLACEHOLDER_TOKENS = new Set<string>([
  'na',
  'n/a',
  'none',
  'null',
  'undefined',
  'unknown',
  'tbd',
  'todo',
  'placeholder',
  '[placeholder]',
  '<evidence>',
  'no evidence',
  'not available',
  'see image',
  'see page',
  'omitted',
]);

// --- CropArtifactCache -----------------------------------------------------

/** Quantizes a normalized bbox onto a deterministic integer/step grid for cache hits. */
export function quantizeBBox(
  bbox: readonly [number, number, number, number],
  step: number = 1,
): NormalizedBBox {
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
  return clampAndOrderBBox(
    [
      Math.round(bbox[0] / safeStep) * safeStep,
      Math.round(bbox[1] / safeStep) * safeStep,
      Math.round(bbox[2] / safeStep) * safeStep,
      Math.round(bbox[3] / safeStep) * safeStep,
    ],
    1000,
    1,
  );
}

export function buildCropCacheKey(input: CropCacheKeyInput): string {
  const q = quantizeBBox(input.bbox, input.quantizeStep ?? 1);
  const p = input.padding;
  return [
    input.pageId,
    `${q[0]},${q[1]},${q[2]},${q[3]}`,
    String(input.angle),
    `${p.top},${p.right},${p.bottom},${p.left}`,
    String(Math.round(input.targetMaxPixels)),
    input.mode,
  ].join('|');
}

interface StoredCacheRecord {
  entry: CropArtifactEntry;
  byteLength: number;
}

/** Content-addressed LRU cache bounded by total byte weight and entry count. */
export class CropArtifactCache {
  private readonly maxCacheBytes: number;
  private readonly maxEntries: number;
  private readonly quantizeStep: number;
  private readonly store = new Map<string, StoredCacheRecord>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: { maxCacheBytes?: number; maxEntries?: number; quantizeStep?: number } = {}) {
    this.maxCacheBytes = options.maxCacheBytes ?? 16 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 256;
    this.quantizeStep = options.quantizeStep ?? 1;
  }

  get step(): number {
    return this.quantizeStep;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  get(key: string): CropArtifactEntry | undefined {
    const existing = this.store.get(key);
    if (existing === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, existing);
    this.hits += 1;
    return existing.entry;
  }

  set(key: string, entry: CropArtifactEntry): boolean {
    const byteLength = estimateEntryBytes(entry);
    if (byteLength > this.maxCacheBytes || this.maxEntries <= 0) {
      return false;
    }

    const previous = this.store.get(key);
    if (previous !== undefined) {
      this.totalBytes -= previous.byteLength;
      this.store.delete(key);
    }

    while (
      this.store.size > 0 &&
      (this.totalBytes + byteLength > this.maxCacheBytes || this.store.size >= this.maxEntries)
    ) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.store.get(oldestKey);
      this.store.delete(oldestKey);
      if (oldest !== undefined) {
        this.totalBytes -= oldest.byteLength;
      }
      this.evictions += 1;
    }

    this.store.set(key, { entry, byteLength });
    this.totalBytes += byteLength;
    return true;
  }

  delete(key: string): boolean {
    const existing = this.store.get(key);
    if (existing === undefined) return false;
    this.store.delete(key);
    this.totalBytes -= existing.byteLength;
    return true;
  }

  clear(): void {
    this.store.clear();
    this.totalBytes = 0;
  }

  stats(): CropCacheStats {
    return {
      size: this.store.size,
      totalBytes: this.totalBytes,
      maxCacheBytes: this.maxCacheBytes,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}

// --- Action Parsing & Evidence Validation ----------------------------------

export function isPlaceholderEvidence(text: string): boolean {
  if (typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  const normalized = trimmed.toLowerCase();
  if (PLACEHOLDER_TOKENS.has(normalized)) return true;
  // Punctuation-only markers such as "..." or "---" carry no document content.
  if (/^[\s.,:;!?_\-–—~*`'"]+$/u.test(trimmed)) return true;
  return false;
}

/**
 * Parses either a native structured tool object or a fenced/tagged string response.
 * Rejects simultaneous tool-call + final-answer turns and discards trailing
 * hallucinated blocks after the primary action payload.
 */
export function parseActionPayload(raw: unknown): ActionParseResult {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return validateActionObject(raw);
  }
  if (typeof raw !== 'string') {
    return { ok: false, code: 'empty-payload', message: 'Action payload must be an object or non-empty string.' };
  }

  const text = raw.trim();
  if (text.length === 0) {
    return { ok: false, code: 'empty-payload', message: 'Action payload string is empty.' };
  }

  const tagMatches = Array.from(text.matchAll(/<(tool_call|action|final_answer)>([\s\S]*?)<\/\1>/giu));
  if (tagMatches.length > 0) {
    const hasToolTag = tagMatches.some(m => {
      const name = m[1]?.toLowerCase();
      return name === 'tool_call' || name === 'action';
    });
    const hasFinalTag = tagMatches.some(m => m[1]?.toLowerCase() === 'final_answer');
    if (hasToolTag && hasFinalTag) {
      return {
        ok: false,
        code: 'simultaneous-actions',
        message: 'Turn must not mix tool_call and final_answer in the same response.',
      };
    }

    const firstBody = tagMatches[0]?.[2]?.trim() ?? '';
    return parseJsonAction(firstBody);
  }

  const fenceMatches = Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu));
  if (fenceMatches.length > 0) {
    if (hasConflictingFencedActions(fenceMatches)) {
      return {
        ok: false,
        code: 'simultaneous-actions',
        message: 'Turn must not emit both a tool action and stop_with_evidence.',
      };
    }
    const firstFence = fenceMatches[0]?.[1]?.trim() ?? '';
    return parseJsonAction(firstFence);
  }

  const jsonSlice = extractFirstJsonObject(text);
  if (jsonSlice === null) {
    return { ok: false, code: 'malformed-json', message: 'No JSON object found in action payload.' };
  }
  return parseJsonAction(jsonSlice);
}

/** Converts normalized evidence coordinates to pixel `Rect` matching `./types`. */
export function evidenceToRect(evidence: GroundedEvidence, pageWidth: number, pageHeight: number): Rect {
  return toPixelBox(evidence.bbox, pageWidth, pageHeight);
}

// --- Main State Machine ----------------------------------------------------

export async function runAgenticOcr(options: AgenticOcrOptions): Promise<AgenticOcrResult> {
  const signal = options.signal;
  throwIfAborted(signal);

  const budget = resolveBudget(options.budget);
  validatePageInput(options.page);
  const now = options.now ?? Date.now;
  const startTimeMs = now();
  const paddingRatio = options.ocrPaddingRatio ?? DEFAULT_OCR_PADDING_RATIO;
  const dedupIou = options.dedupIouThreshold ?? DEFAULT_DEDUP_IOU_THRESHOLD;
  const verifyEnabled = options.verify ?? options.model.verifyEvidence !== undefined;

  const memory: ReflectionMemoryEntry[] = [];
  const accumulatedEvidence: GroundedEvidence[] = [];
  let activeCrops: VisualAttachment[] = [];
  const seenToolKeys = new Set<string>();
  const seenTileGrids = new Set<TileSweepGrid>();

  let totalPixelsUsed = 0;
  let totalTextChars = 0;
  let cropCalls = 0;
  let ocrCalls = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let rejectedCalls = 0;
  let roundsExecuted = 0;
  let consecutiveFailures = 0;
  let systemNotice: string | undefined;

  const snapshotMetrics = (): AgenticOcrMetrics => ({
    roundsExecuted,
    totalPixelsUsed,
    totalTextChars,
    cropCalls,
    ocrCalls,
    cacheHits,
    cacheMisses,
    rejectedCalls,
    activeWindowCap: budget.maxActiveCropImages,
  });

  const exhausted = (reason: string): AgenticOcrResult =>
    finishBudgetExhausted(reason, accumulatedEvidence, memory, snapshotMetrics(), dedupIou);

  const rejectTurn = (
    round: number,
    notice: string,
    limitReason: string,
    meta?: { bbox?: NormalizedBBox; angle?: CropAngle; mode?: ZoomOcrMode },
  ): AgenticOcrResult | null => {
    rejectedCalls += 1;
    consecutiveFailures += 1;
    systemNotice = notice;
    memory.push({
      round,
      action: 'notice',
      ...(meta?.bbox !== undefined ? { bbox: meta.bbox } : {}),
      ...(meta?.angle !== undefined ? { angle: meta.angle } : {}),
      ...(meta?.mode !== undefined ? { mode: meta.mode } : {}),
      extractedTextSummary: '',
      diagnosis: notice,
    });
    return consecutiveFailures > budget.maxRetriesPerTool ? exhausted(limitReason) : null;
  };

  const applyCropOutcome = (
    round: number,
    actionKind: 'zoom_and_ocr' | 'tile_sweep',
    bbox: NormalizedBBox,
    angle: CropAngle,
    mode: ZoomOcrMode,
    outcome: Extract<SingleCropOutcome, { ok: true }>,
    diagnosis: string,
  ): void => {
    totalPixelsUsed += outcome.pixelsAdded;
    totalTextChars += outcome.textCharsAdded;
    cropCalls += outcome.cropCalls;
    ocrCalls += outcome.ocrCalls;
    cacheHits += outcome.cacheHits;
    cacheMisses += outcome.cacheMisses;
    accumulatedEvidence.push(...outcome.grounded);
    activeCrops = appendActiveCrop(activeCrops, outcome.attachment, budget.maxActiveCropImages);
    memory.push({
      round,
      action: actionKind,
      bbox,
      angle,
      mode,
      extractedTextSummary: summarizeText(outcome.ocrText),
      diagnosis,
    });
  };

  const overviewTargetSide = computeOverviewTargetSide(budget);
  const overviewImage = await raceWithAbort(
    options.cropper.renderOverview(options.page, overviewTargetSide, signal),
    signal,
  );
  throwIfAborted(signal);
  totalPixelsUsed += imagePixels(overviewImage);

  const overviewAttachment: VisualAttachment = {
    id: overviewImage.id,
    role: 'overview',
    pageIndex: options.page.pageIndex,
    bbox: [0, 0, 1000, 1000],
    image: overviewImage,
  };

  if (options.model.judgeRelevance !== undefined) {
    const verdict = await raceWithAbort(
      options.model.judgeRelevance({
        query: options.query,
        overview: overviewAttachment,
        signal,
      }),
      signal,
    );
    throwIfAborted(signal);
    if (!verdict.relevant) {
      return {
        status: 'irrelevant',
        answerable: false,
        verified: false,
        evidence: [],
        memory,
        metrics: snapshotMetrics(),
        ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      };
    }
  }

  const minReadablePixels = Math.min(
    budget.maxTotalPixels,
    budget.minCropLongestSide * Math.min(budget.minCropLongestSide, 128),
  );

  for (let round = 1; round <= budget.maxRounds; round += 1) {
    throwIfAborted(signal);
    if (isTimedOut(budget, startTimeMs, now)) {
      return exhausted('timeout');
    }

    const pixelsLeft = Math.max(0, budget.maxTotalPixels - totalPixelsUsed);
    const textCharsLeft = Math.max(0, budget.maxTextChars - totalTextChars);
    const windDown =
      round >= budget.windDownAtRound ||
      pixelsLeft < minReadablePixels ||
      textCharsLeft <= 0;

    if (windDown && systemNotice === undefined) {
      systemNotice =
        'Budget wind-down active: zoom_and_ocr and tile_sweep are disabled. Emit stop_with_evidence now.';
    }

    const turnInput: AgenticOcrTurnInput = {
      round,
      maxRounds: budget.maxRounds,
      windDown,
      query: options.query,
      pageIndex: options.page.pageIndex,
      images: [overviewAttachment, ...activeCrops],
      memory: memory.map(entry => ({ ...entry })),
      ...(systemNotice !== undefined ? { systemNotice } : {}),
      remainingBudget: {
        roundsLeft: budget.maxRounds - round + 1,
        pixelsLeft,
        textCharsLeft,
      },
      ...(signal !== undefined ? { signal } : {}),
    };

    const rawAction = await raceWithAbort(options.model.nextStep(turnInput), signal);
    throwIfAborted(signal);
    roundsExecuted += 1;
    systemNotice = undefined;

    const parsed = parseActionPayload(rawAction);
    if (!parsed.ok) {
      const stop = rejectTurn(round, `Invalid action (${parsed.code}): ${parsed.message}`, 'retry-limit-reached');
      if (stop !== null) return stop;
      continue;
    }

    const action = parsed.action;

    if (action.type === 'stop_with_evidence') {
      const check = validateFinalEvidence(action, options.page.pageIndex);
      if (!check.ok) {
        const stop = rejectTurn(round, check.message, 'invalid-evidence-limit');
        if (stop !== null) return stop;
        continue;
      }

      consecutiveFailures = 0;
      const deduped = mergeOrDeduplicateRegions(check.evidence, dedupIou);
      let verified = false;

      if (verifyEnabled && action.answerable && options.model.verifyEvidence !== undefined) {
        const verifyVerdict = await raceWithAbort(
          options.model.verifyEvidence({
            query: options.query,
            overview: overviewAttachment,
            evidence: deduped,
            signal,
          }),
          signal,
        );
        throwIfAborted(signal);

        if (verifyVerdict.verdict === 'reject') {
          const reason = verifyVerdict.reason ?? 'Verification rejected candidate evidence; inspect further.';
          systemNotice = `Verification rejected evidence: ${reason}`;
          memory.push({
            round,
            action: 'notice',
            extractedTextSummary: '',
            diagnosis: systemNotice,
          });
          if (round >= budget.maxRounds) {
            return exhausted('verification-rejected');
          }
          continue;
        }
        verified = true;
      }

      return {
        status: 'completed',
        answerable: action.answerable,
        verified,
        evidence: deduped,
        memory,
        metrics: snapshotMetrics(),
      };
    }

    if (windDown) {
      const stop = rejectTurn(
        round,
        'Cannot execute zoom_and_ocr or tile_sweep during wind-down; call stop_with_evidence.',
        'wind-down-exhausted',
      );
      if (stop !== null) return stop;
      continue;
    }

    if (action.type === 'zoom_and_ocr') {
      const angle: CropAngle = action.angle ?? 0;
      const quantStep = options.cache?.step ?? 1;
      const qBox = quantizeBBox(action.bbox, quantStep);
      const dedupKey = `${qBox[0]},${qBox[1]},${qBox[2]},${qBox[3]}|${angle}|${action.mode}`;

      if (seenToolKeys.has(dedupKey)) {
        const stop = rejectTurn(
          round,
          `Duplicate call rejected: region already inspected (${dedupKey}). Refine bbox or finalize.`,
          'duplicate-call-limit',
          { bbox: action.bbox, angle, mode: action.mode },
        );
        if (stop !== null) return stop;
        continue;
      }

      seenToolKeys.add(dedupKey);
      consecutiveFailures = 0;

      const execOutcome = await executeSingleCrop({
        page: options.page,
        bbox: action.bbox,
        angle,
        mode: action.mode,
        label: action.label,
        role: 'crop',
        targetResolution: action.targetResolution ?? 'normal',
        paddingRatio,
        pixelsLeft: Math.max(0, budget.maxTotalPixels - totalPixelsUsed),
        textCharsLeft: Math.max(0, budget.maxTextChars - totalTextChars),
        budget,
        cropper: options.cropper,
        ocr: options.ocr,
        cache: options.cache,
        signal,
      });
      throwIfAborted(signal);

      if (!execOutcome.ok) {
        rejectedCalls += 1;
        systemNotice = execOutcome.reason;
        memory.push({
          round,
          action: 'notice',
          bbox: action.bbox,
          angle,
          mode: action.mode,
          extractedTextSummary: '',
          diagnosis: execOutcome.reason,
        });
        continue;
      }

      applyCropOutcome(
        round,
        'zoom_and_ocr',
        action.bbox,
        angle,
        action.mode,
        execOutcome,
        execOutcome.fromCache ? 'cache-hit' : `extracted-${action.mode}`,
      );
      continue;
    }

    // tile_sweep fallback
    if (seenTileGrids.has(action.grid)) {
      const stop = rejectTurn(
        round,
        `Duplicate tile_sweep rejected: grid ${action.grid} already inspected.`,
        'duplicate-sweep-limit',
      );
      if (stop !== null) return stop;
      continue;
    }

    seenTileGrids.add(action.grid);
    consecutiveFailures = 0;

    const dim = action.grid === '3x3' ? 3 : 2;
    const tiles = planGridTiles(
      { width: options.page.width, height: options.page.height },
      dim,
      dim,
    );

    for (let i = 0; i < tiles.length; i += 1) {
      throwIfAborted(signal);
      const tileBox = tiles[i];
      if (tileBox === undefined) continue;
      const totalPixelsLeft = Math.max(0, budget.maxTotalPixels - totalPixelsUsed);
      const remainingTiles = tiles.length - i;
      // Apportion remaining pixel budget evenly across remaining grid tiles so early
      // quadrants cannot starve later quadrants of the page.
      const tilePixelsBudget = Math.floor(totalPixelsLeft / remainingTiles);

      const execOutcome = await executeSingleCrop({
        page: options.page,
        bbox: tileBox,
        angle: 0,
        mode: 'region',
        label: `tile-${action.grid}-${i + 1}`,
        role: 'tile',
        targetResolution: 'normal',
        paddingRatio,
        pixelsLeft: tilePixelsBudget,
        textCharsLeft: Math.max(0, budget.maxTextChars - totalTextChars),
        budget,
        cropper: options.cropper,
        ocr: options.ocr,
        cache: options.cache,
        signal,
      });
      throwIfAborted(signal);

      if (!execOutcome.ok) {
        systemNotice = execOutcome.reason;
        break;
      }

      applyCropOutcome(
        round,
        'tile_sweep',
        tileBox,
        0,
        'region',
        execOutcome,
        execOutcome.fromCache ? `tile-${i + 1}-cache-hit` : `tile-${i + 1}-extracted`,
      );
    }
  }

  return exhausted('max-rounds-reached');
}

// --- Crop Execution & Grounding Helpers ------------------------------------

interface SingleCropParams {
  page: PageImageInput;
  bbox: NormalizedBBox;
  angle: CropAngle;
  mode: ZoomOcrMode;
  label: string;
  role: 'crop' | 'tile';
  targetResolution: TargetResolution;
  paddingRatio: number;
  pixelsLeft: number;
  textCharsLeft: number;
  budget: AgenticOcrBudget;
  cropper: VisionCropper;
  ocr: OcrAdapter;
  cache?: CropArtifactCache;
  signal?: AbortSignal;
}

type SingleCropOutcome =
  | {
      ok: true;
      attachment: VisualAttachment;
      ocrText: string;
      grounded: GroundedEvidence[];
      pixelsAdded: number;
      textCharsAdded: number;
      cropCalls: number;
      ocrCalls: number;
      cacheHits: number;
      cacheMisses: number;
      fromCache: boolean;
    }
  | { ok: false; reason: string };

async function executeSingleCrop(params: SingleCropParams): Promise<SingleCropOutcome> {
  const cropRectPx = toPixelBox(params.bbox, params.page.width, params.page.height);
  const padding = computePaddingPx(cropRectPx, params.mode, params.paddingRatio);
  const desiredLongestSide =
    params.targetResolution === 'high'
      ? params.budget.maxHighResCropLongestSide
      : params.budget.maxCropLongestSide;

  const paddedW = (params.angle === 90 || params.angle === 270 ? cropRectPx.height : cropRectPx.width) + padding.left + padding.right;
  const paddedH = (params.angle === 90 || params.angle === 270 ? cropRectPx.width : cropRectPx.height) + padding.top + padding.bottom;
  const targetMaxLongestSide = computeAdaptiveLongestSide(
    paddedW,
    paddedH,
    desiredLongestSide,
    params.budget.minCropLongestSide,
    params.pixelsLeft,
  );

  if (targetMaxLongestSide === null) {
    return { ok: false, reason: 'Pixel budget exhausted before crop could fit readable minimum edge.' };
  }

  const cacheKey = buildCropCacheKey({
    pageId: params.page.pageId,
    bbox: params.bbox,
    angle: params.angle,
    padding,
    targetMaxPixels: targetMaxLongestSide,
    mode: params.mode,
    quantizeStep: params.cache?.step,
  });

  const cached = params.cache?.get(cacheKey);
  if (cached !== undefined) {
    const vlmPixels = imagePixels(cached.vlmImage);
    const boundedText = boundTextChars(cached.ocrResult.text, params.textCharsLeft);
    const grounded = projectOcrEvidence(cached.ocrResult, cached.transform, params.bbox, params.page.pageIndex, params.label);
    return {
      ok: true,
      attachment: {
        id: cached.vlmImage.id,
        role: params.role,
        pageIndex: params.page.pageIndex,
        bbox: params.bbox,
        image: cached.vlmImage,
      },
      ocrText: boundedText,
      grounded,
      pixelsAdded: vlmPixels,
      textCharsAdded: boundedText.length,
      cropCalls: 0,
      ocrCalls: 0,
      cacheHits: 1,
      cacheMisses: 0,
      fromCache: true,
    };
  }

  const rendered = await raceWithAbort(
    params.cropper.cropAndTransform(
      {
        page: params.page,
        cropRectPx,
        angle: params.angle,
        paddingPx: padding,
        targetMaxLongestSide,
      },
      params.signal,
    ),
    params.signal,
  );
  throwIfAborted(params.signal);

  const ocrResult: OcrExtractResult =
    params.mode === 'image'
      ? { text: '' }
      : await raceWithAbort(
          params.ocr.extract({
            image: rendered.ocrImage,
            mode: params.mode,
            label: params.label,
            signal: params.signal,
          }),
          params.signal,
        );
  throwIfAborted(params.signal);

  params.cache?.set(cacheKey, {
    ocrImage: rendered.ocrImage,
    vlmImage: rendered.vlmImage,
    transform: rendered.transform,
    ocrResult,
  });

  const vlmPixels = imagePixels(rendered.vlmImage);
  const boundedText = boundTextChars(ocrResult.text, params.textCharsLeft);
  const grounded = projectOcrEvidence(ocrResult, rendered.transform, params.bbox, params.page.pageIndex, params.label);

  return {
    ok: true,
    attachment: {
      id: rendered.vlmImage.id,
      role: params.role,
      pageIndex: params.page.pageIndex,
      bbox: params.bbox,
      image: rendered.vlmImage,
    },
    ocrText: boundedText,
    grounded,
    pixelsAdded: vlmPixels,
    textCharsAdded: boundedText.length,
    cropCalls: 1,
    ocrCalls: params.mode === 'image' ? 0 : 1,
    cacheHits: 0,
    cacheMisses: params.cache !== undefined ? 1 : 0,
    fromCache: false,
  };
}

function projectOcrEvidence(
  ocrResult: OcrExtractResult,
  transform: CropTransform,
  cropBBox: NormalizedBBox,
  pageIndex: number,
  label: string,
): GroundedEvidence[] {
  const results: GroundedEvidence[] = [];
  if (Array.isArray(ocrResult.elements) && ocrResult.elements.length > 0) {
    for (const element of ocrResult.elements) {
      if (isPlaceholderEvidence(element.text)) continue;
      if (element.localBBox !== undefined) {
        const mapped = mapBBoxToOriginal(element.localBBox, transform);
        results.push({
          content: element.text.trim(),
          bbox: mapped.bbox,
          quad: mapped.quad,
          pageIndex,
          ...(element.confidence !== undefined ? { confidence: element.confidence } : {}),
          label,
        });
      } else {
        results.push({
          content: element.text.trim(),
          bbox: cropBBox,
          quad: bboxToQuad(cropBBox),
          pageIndex,
          ...(element.confidence !== undefined ? { confidence: element.confidence } : {}),
          label,
        });
      }
    }
    return results;
  }

  if (!isPlaceholderEvidence(ocrResult.text)) {
    results.push({
      content: ocrResult.text.trim(),
      bbox: cropBBox,
      quad: bboxToQuad(cropBBox),
      pageIndex,
      ...(ocrResult.confidence !== undefined ? { confidence: ocrResult.confidence } : {}),
      label,
    });
  }
  return results;
}

function computeAdaptiveLongestSide(
  rawWidth: number,
  rawHeight: number,
  desiredLongestSide: number,
  minCropLongestSide: number,
  pixelsLeft: number,
): number | null {
  if (pixelsLeft <= 0) return null;
  const rawLongest = Math.max(1, rawWidth, rawHeight);
  const effectiveDesired = Math.min(desiredLongestSide, Math.ceil(rawLongest));
  const scale = effectiveDesired / rawLongest;
  const expectedW = Math.max(1, Math.round(rawWidth * scale));
  const expectedH = Math.max(1, Math.round(rawHeight * scale));
  const desiredPixels = expectedW * expectedH;

  if (desiredPixels <= pixelsLeft) {
    return desiredLongestSide;
  }

  // Area scales quadratically with side length, so compress linear scale by 1 / sqrt(factor).
  const factor = desiredPixels / pixelsLeft;
  let scaledSide = Math.floor(effectiveDesired / Math.sqrt(factor));
  while (scaledSide >= minCropLongestSide) {
    const s = scaledSide / rawLongest;
    const w = Math.max(1, Math.round(rawWidth * s));
    const h = Math.max(1, Math.round(rawHeight * s));
    if (w * h <= pixelsLeft) return scaledSide;
    scaledSide -= 1;
  }
  return null;
}

function computeOverviewTargetSide(budget: AgenticOcrBudget): number {
  const maxOverviewArea = budget.maxOverviewLongestSide * budget.maxOverviewLongestSide;
  if (maxOverviewArea <= budget.maxTotalPixels) {
    return budget.maxOverviewLongestSide;
  }
  const factor = maxOverviewArea / Math.max(1, budget.maxTotalPixels);
  return Math.max(64, Math.floor(budget.maxOverviewLongestSide / Math.sqrt(factor)));
}

function computePaddingPx(cropRectPx: Rect, mode: ZoomOcrMode, ratio: number): CropPadding {
  if (mode === 'image' || ratio <= 0) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  const padX = Math.max(1, Math.round(cropRectPx.width * ratio));
  const padY = Math.max(1, Math.round(cropRectPx.height * ratio));
  return { top: padY, right: padX, bottom: padY, left: padX };
}

function appendActiveCrop(
  active: VisualAttachment[],
  next: VisualAttachment,
  cap: number,
): VisualAttachment[] {
  if (cap <= 0) return [];
  const combined = [...active, next];
  return combined.length > cap ? combined.slice(-cap) : combined;
}

// --- Parsing & Validation Internals ----------------------------------------

function hasConflictingFencedActions(matches: readonly RegExpMatchArray[]): boolean {
  if (matches.length < 2) return false;
  let sawTool = false;
  let sawStop = false;
  for (const match of matches) {
    const body = match[1]?.trim() ?? '';
    const parsed = parseJsonAction(body);
    if (!parsed.ok) continue;
    if (parsed.action.type === 'stop_with_evidence') sawStop = true;
    else sawTool = true;
    if (sawTool && sawStop) return true;
  }
  return false;
}

function parseJsonAction(jsonText: string): ActionParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(jsonText);
  } catch (err) {
    return {
      ok: false,
      code: 'malformed-json',
      message: `Failed to parse action JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return validateActionObject(decoded);
}

function validateActionObject(raw: unknown): ActionParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'invalid-action', message: 'Action must be a JSON object.' };
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type;

  if (type === 'zoom_and_ocr') {
    if (typeof obj.label !== 'string' || obj.label.trim().length === 0) {
      return { ok: false, code: 'invalid-action', message: 'zoom_and_ocr requires a non-empty string label.' };
    }
    const bboxCheck = validateNormalizedBBox(obj.bbox);
    if (!bboxCheck.ok) {
      return { ok: false, code: 'invalid-action', message: `zoom_and_ocr invalid bbox: ${bboxCheck.message}` };
    }
    if (typeof obj.mode !== 'string' || !VALID_MODES.has(obj.mode)) {
      return { ok: false, code: 'invalid-action', message: `zoom_and_ocr invalid mode: ${String(obj.mode)}.` };
    }
    let angle: CropAngle | undefined;
    if (obj.angle !== undefined) {
      if (typeof obj.angle !== 'number' || !VALID_ANGLES.has(obj.angle)) {
        return { ok: false, code: 'invalid-action', message: `zoom_and_ocr angle must be 0, 90, 180, or 270.` };
      }
      angle = obj.angle as CropAngle;
    }
    let targetResolution: TargetResolution | undefined;
    if (obj.targetResolution !== undefined) {
      if (obj.targetResolution !== 'normal' && obj.targetResolution !== 'high') {
        return { ok: false, code: 'invalid-action', message: 'zoom_and_ocr targetResolution must be normal or high.' };
      }
      targetResolution = obj.targetResolution;
    }
    return {
      ok: true,
      action: {
        type: 'zoom_and_ocr',
        label: obj.label.trim(),
        bbox: bboxCheck.bbox,
        ...(angle !== undefined ? { angle } : {}),
        mode: obj.mode as ZoomOcrMode,
        ...(targetResolution !== undefined ? { targetResolution } : {}),
      },
    };
  }

  if (type === 'tile_sweep') {
    const grid = obj.grid ?? '2x2';
    if (typeof grid !== 'string' || !VALID_GRIDS.has(grid)) {
      return { ok: false, code: 'invalid-action', message: 'tile_sweep grid must be 2x2 or 3x3.' };
    }
    return { ok: true, action: { type: 'tile_sweep', grid: grid as TileSweepGrid } };
  }

  if (type === 'stop_with_evidence') {
    if (typeof obj.answerable !== 'boolean') {
      return { ok: false, code: 'invalid-action', message: 'stop_with_evidence requires boolean answerable.' };
    }
    if (!Array.isArray(obj.evidence)) {
      return { ok: false, code: 'invalid-action', message: 'stop_with_evidence requires an evidence array.' };
    }
    const items: CandidateEvidence[] = [];
    for (const rawItem of obj.evidence) {
      if (rawItem === null || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        return { ok: false, code: 'invalid-action', message: 'Each evidence item must be an object.' };
      }
      const item = rawItem as Record<string, unknown>;
      if (typeof item.content !== 'string') {
        return { ok: false, code: 'invalid-action', message: 'Evidence content must be a string.' };
      }
      const bboxCheck = validateNormalizedBBox(item.bbox);
      if (!bboxCheck.ok) {
        return { ok: false, code: 'invalid-action', message: `Evidence invalid bbox: ${bboxCheck.message}` };
      }
      if (typeof item.pageIndex !== 'number' || !Number.isInteger(item.pageIndex) || item.pageIndex < 1) {
        return { ok: false, code: 'invalid-action', message: 'Evidence pageIndex must be an integer >= 1.' };
      }
      items.push({
        content: item.content,
        bbox: bboxCheck.bbox,
        ...(Array.isArray(item.quad) && item.quad.length === 4 ? { quad: item.quad as Quad } : {}),
        pageIndex: item.pageIndex,
        ...(typeof item.confidence === 'number' && Number.isFinite(item.confidence)
          ? { confidence: item.confidence }
          : {}),
        ...(typeof item.label === 'string' ? { label: item.label } : {}),
      });
    }
    return {
      ok: true,
      action: {
        type: 'stop_with_evidence',
        answerable: obj.answerable,
        evidence: items,
      },
    };
  }

  return { ok: false, code: 'invalid-action', message: `Unknown action type: ${String(type)}.` };
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) continue;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function validateFinalEvidence(
  action: Extract<AgenticOcrAction, { type: 'stop_with_evidence' }>,
  defaultPageIndex: number,
): { ok: true; evidence: GroundedEvidence[] } | { ok: false; message: string } {
  if (action.answerable && action.evidence.length === 0) {
    return {
      ok: false,
      message: 'Empty evidence rejected: answerable=true requires at least one grounded evidence item.',
    };
  }

  const grounded: GroundedEvidence[] = [];
  for (const item of action.evidence) {
    if (isPlaceholderEvidence(item.content)) {
      return {
        ok: false,
        message: 'Placeholder or empty evidence rejected: supply real quoted text or set answerable=false.',
      };
    }
    grounded.push({
      content: item.content.trim(),
      bbox: item.bbox,
      quad: item.quad ?? bboxToQuad(item.bbox),
      pageIndex: item.pageIndex || defaultPageIndex,
      ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
      ...(item.label !== undefined ? { label: item.label } : {}),
    });
  }
  return { ok: true, evidence: grounded };
}

// --- Budget, Abort & Utility Helpers ---------------------------------------

function resolveBudget(partial?: Partial<AgenticOcrBudget>): AgenticOcrBudget {
  const maxRounds = partial?.maxRounds ?? DEFAULT_AGENTIC_OCR_BUDGET.maxRounds;
  const windDownAtRound = Math.min(
    maxRounds,
    partial?.windDownAtRound ?? Math.max(1, maxRounds - 1),
  );
  const merged: AgenticOcrBudget = {
    maxRounds,
    windDownAtRound,
    maxTotalPixels: partial?.maxTotalPixels ?? DEFAULT_AGENTIC_OCR_BUDGET.maxTotalPixels,
    maxOverviewLongestSide: partial?.maxOverviewLongestSide ?? DEFAULT_AGENTIC_OCR_BUDGET.maxOverviewLongestSide,
    maxCropLongestSide: partial?.maxCropLongestSide ?? DEFAULT_AGENTIC_OCR_BUDGET.maxCropLongestSide,
    maxHighResCropLongestSide:
      partial?.maxHighResCropLongestSide ?? DEFAULT_AGENTIC_OCR_BUDGET.maxHighResCropLongestSide,
    minCropLongestSide: partial?.minCropLongestSide ?? DEFAULT_AGENTIC_OCR_BUDGET.minCropLongestSide,
    maxTextChars: partial?.maxTextChars ?? DEFAULT_AGENTIC_OCR_BUDGET.maxTextChars,
    maxActiveCropImages: partial?.maxActiveCropImages ?? DEFAULT_AGENTIC_OCR_BUDGET.maxActiveCropImages,
    maxRetriesPerTool: partial?.maxRetriesPerTool ?? DEFAULT_AGENTIC_OCR_BUDGET.maxRetriesPerTool,
    ...(partial?.timeoutMs !== undefined ? { timeoutMs: partial.timeoutMs } : {}),
  };

  if (!Number.isInteger(merged.maxRounds) || merged.maxRounds < 1) {
    throw new AgenticOcrError('invalid-config', 'budget.maxRounds must be an integer >= 1.');
  }
  if (!Number.isInteger(merged.windDownAtRound) || merged.windDownAtRound < 1) {
    throw new AgenticOcrError('invalid-config', 'budget.windDownAtRound must be an integer >= 1.');
  }
  if (!Number.isFinite(merged.maxTotalPixels) || merged.maxTotalPixels <= 0) {
    throw new AgenticOcrError('invalid-config', 'budget.maxTotalPixels must be > 0.');
  }
  if (!Number.isFinite(merged.minCropLongestSide) || merged.minCropLongestSide <= 0) {
    throw new AgenticOcrError('invalid-config', 'budget.minCropLongestSide must be > 0.');
  }
  if (!Number.isInteger(merged.maxActiveCropImages) || merged.maxActiveCropImages < 0) {
    throw new AgenticOcrError('invalid-config', 'budget.maxActiveCropImages must be an integer >= 0.');
  }
  return merged;
}

function validatePageInput(page: PageImageInput): void {
  if (!page.pageId || !Number.isInteger(page.pageIndex) || page.pageIndex < 1) {
    throw new AgenticOcrError('invalid-page', 'page.pageId must be non-empty and page.pageIndex must be >= 1.');
  }
  if (!Number.isFinite(page.width) || page.width <= 0 || !Number.isFinite(page.height) || page.height <= 0) {
    throw new AgenticOcrError('invalid-page', 'page.width and page.height must be positive finite numbers.');
  }
}

function finishBudgetExhausted(
  reason: string,
  accumulated: readonly GroundedEvidence[],
  memory: ReflectionMemoryEntry[],
  metrics: AgenticOcrMetrics,
  dedupIou: number,
): AgenticOcrResult {
  const deduped = mergeOrDeduplicateRegions(accumulated, dedupIou);
  return {
    status: 'budget_exhausted',
    answerable: deduped.length > 0,
    verified: false,
    evidence: deduped,
    memory,
    metrics: buildMetrics(metrics),
    reason,
  };
}

function buildMetrics(metrics: AgenticOcrMetrics): AgenticOcrMetrics {
  return { ...metrics };
}

function isTimedOut(budget: AgenticOcrBudget, startMs: number, now: () => number): boolean {
  return budget.timeoutMs !== undefined && now() - startMs >= budget.timeoutMs;
}

function imagePixels(image: ImagePayload): number {
  return Math.max(0, Math.round(image.width) * Math.round(image.height));
}

function estimateEntryBytes(entry: CropArtifactEntry): number {
  return (
    Math.max(0, entry.ocrImage.byteLength) +
    Math.max(0, entry.vlmImage.byteLength) +
    entry.ocrResult.text.length * 2
  );
}

function boundTextChars(text: string, charsLeft: number): string {
  if (charsLeft <= 0) return '';
  return text.length > charsLeft ? text.slice(0, charsLeft) : text;
}

function summarizeText(text: string): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  if (compact.length <= MEMORY_SUMMARY_MAX_CHARS) return compact;
  return `${compact.slice(0, MEMORY_SUMMARY_MAX_CHARS - 3)}...`;
}

function createAbortError(cause?: unknown): Error {
  const error = new Error('AgenticOCR execution was aborted.', cause === undefined ? undefined : { cause });
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(createAbortError(signal.reason));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError(signal.reason));
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      err => {
        cleanup();
        reject(err);
      },
    );
  });
}
