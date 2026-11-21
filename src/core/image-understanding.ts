/**
 * Visual understanding for charts, diagrams, flowcharts, and technical figures (backlog item F12).
 *
 * A page crop is only pixels and a bounding box until a pipeline classifies what kind
 * of visual artefact it holds, binds it to its caption block, extracts structured
 * components (axes, series, nodes, edges, labels), and verifies every claimed number
 * against labels and axis ticks actually observed in the figure.
 *
 * Contract:
 * - Pure and deterministic: no clock, randomness, DOM, canvas, network, or I/O. Equal
 *   inputs always yield identical output.
 * - Composes directly with `src/core/captions.ts` (`linkCaptions`) for geometry- and
 *   column-aware caption binding, and with `src/core/multimodal.ts` (`planVisionRequest`
 *   and `parseVisionAnswer`) for pixel-budgeted vision planning and answer parsing.
 * - Never invents unreadable values. Low-resolution, low-DPI, low-contrast, blurry,
 *   low-OCR-confidence, or explicitly illegible regions abstain cleanly with
 *   `status: 'abstain'`, `description: null`, empty extracted structures, and explicit
 *   machine-readable `abstentionReasons`, while preserving source-image and caption
 *   bindings. Partially unreadable values are preserved as `null` with `illegible: true`.
 * - Grounding rejects unverified numeric claims. Any number appearing in `series`,
 *   `numbers`, `trend`, or `description` that is not present in the figure's observed
 *   labels, axis ticks, or OCR text is recorded in `grounding.rejectedClaims` and excluded
 *   from verified outputs.
 * - Coordinates are in page points with origin at top-left and y growing downwards,
 *   matching `Rect` in `src/core/types.ts`. Page numbers are 1-based.
 */

import { DEFAULT_PAGE_HEIGHT } from './blocks';
import { linkCaptions, type CaptionInputBlock, type CaptionLink } from './captions';
import {
  VISION_DEFAULT_SCALE,
  VisionAnswerError,
  parseVisionAnswer,
  planVisionRequest,
  type VisionContext,
  type VisionKind,
  type VisionNumber,
  type VisionRequestPlan,
} from './multimodal';
import type { Rect } from './types';

// --- Constants --------------------------------------------------------------

/** All visual region categories understood by F12. */
export const VISUAL_REGION_KINDS = [
  'chart',
  'diagram',
  'flowchart',
  'technical-drawing',
  'table-image',
  'photo',
] as const;

export type VisualRegionKind = (typeof VISUAL_REGION_KINDS)[number];

/** Minimum longest edge in pixels required before a crop is considered legible. */
export const MIN_READABLE_LONG_EDGE_PX = 96;

/** Minimum shortest edge in pixels required before a crop is considered legible. */
export const MIN_READABLE_SHORT_EDGE_PX = 48;

/** Minimum source scan/render resolution in DPI required for legible labels. */
export const MIN_READABLE_DPI = 72;

/** Minimum luma standard-deviation contrast required for readable strokes. */
export const MIN_READABLE_CONTRAST = 8;

/** Maximum normalized blur score (0..1) allowed before abstaining on blur. */
export const MAX_READABLE_BLUR_SCORE = 0.7;

/** Minimum OCR confidence (0..1) required to trust extracted figure text. */
export const MIN_READABLE_OCR_CONFIDENCE = 0.35;

/** Minimum model confidence (0..1) required when the vision answer states one. */
export const MIN_VISION_CONFIDENCE = 0.25;

/** Output contract version for auditability. */
export const IMAGE_UNDERSTANDING_VERSION = 'image-understanding-1';

// --- Public input types -----------------------------------------------------

export type VisualLabelRole =
  | 'title'
  | 'axis-label'
  | 'tick'
  | 'legend'
  | 'data-label'
  | 'node'
  | 'edge'
  | 'dimension'
  | 'callout'
  | 'header'
  | 'cell'
  | 'other';

export interface VisualLabel {
  readonly id?: string;
  readonly text: string;
  readonly role?: VisualLabelRole;
  readonly bbox?: Rect;
  readonly confidence?: number;
  readonly illegible?: boolean;
}

export interface VisualQualityMetrics {
  readonly contrast?: number;
  readonly blurScore?: number;
  readonly ocrConfidence?: number;
  readonly legible?: boolean;
  readonly illegibleReason?: string;
}

export interface VisualGeometryCues {
  readonly hasAxes?: boolean;
  readonly hasGridLines?: boolean;
  readonly hasLegend?: boolean;
  readonly tickCount?: number;
  readonly seriesCount?: number;
  readonly arrowCount?: number;
  readonly nodeBoxCount?: number;
  readonly hasDecisionDiamond?: boolean;
  readonly hasDimensionLines?: boolean;
  readonly hasCallouts?: boolean;
  readonly hasGridCells?: boolean;
  readonly rowCount?: number;
  readonly colCount?: number;
  readonly isPhotographic?: boolean;
  readonly strokeCount?: number;
}

export type AxisOrientation = 'x' | 'y' | 'y2' | 'z' | 'radial';
export type AxisScale = 'linear' | 'log' | 'categorical' | 'time' | 'unknown';

export interface ChartAxisInput {
  readonly id?: string;
  readonly orientation: AxisOrientation;
  readonly label?: string;
  readonly unit?: string;
  readonly scale?: AxisScale;
  readonly ticks?: readonly (string | number)[];
}

export interface VisualRegionInput {
  readonly imageId: string;
  readonly page: number;
  readonly bbox: Rect;
  readonly pageHeight?: number;
  readonly sourceBlockId?: string;
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly dpi?: number;
  readonly declaredKind?: VisualRegionKind;
  readonly caption?: string;
  readonly captionBlockId?: string;
  readonly nearbyText?: string;
  readonly ocrText?: string;
  readonly labels?: readonly (VisualLabel | string)[];
  readonly axes?: readonly ChartAxisInput[];
  readonly quality?: VisualQualityMetrics;
  readonly cues?: VisualGeometryCues;
}

// --- Structured extraction shapes -------------------------------------------

export interface ChartAxis {
  readonly id: string;
  readonly orientation: AxisOrientation;
  readonly label: string;
  readonly unit: string;
  readonly scale: AxisScale;
  readonly ticks: readonly (string | number)[];
  readonly range: { readonly min: number | null; readonly max: number | null };
}

export interface ChartPointInput {
  readonly x: string | number;
  readonly y: number | string | null;
  readonly label?: string;
  readonly illegible?: boolean;
}

export interface ChartPoint {
  readonly x: string | number;
  readonly y: number | null;
  readonly label?: string;
  readonly illegible: boolean;
  readonly grounded: boolean;
}

export interface ChartSeriesInput {
  readonly id?: string;
  readonly name: string;
  readonly unit?: string;
  readonly axisId?: string;
  readonly points: readonly ChartPointInput[];
  readonly trend?: string;
}

export interface ChartSeries {
  readonly id: string;
  readonly name: string;
  readonly unit: string;
  readonly axisId?: string;
  readonly points: readonly ChartPoint[];
  readonly trend: string;
}

export type VisualNodeKind =
  | 'start'
  | 'end'
  | 'process'
  | 'decision'
  | 'io'
  | 'subgraph'
  | 'component'
  | 'part'
  | 'annotation'
  | 'unknown';

export interface VisualNodeInput {
  readonly id: string;
  readonly label: string;
  readonly kind?: VisualNodeKind;
  readonly bbox?: Rect;
  readonly illegible?: boolean;
}

export interface VisualNode {
  readonly id: string;
  readonly label: string;
  readonly kind: VisualNodeKind;
  readonly bbox?: Rect;
  readonly illegible: boolean;
}

export interface VisualEdgeInput {
  readonly id?: string;
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly condition?: string;
  readonly directed?: boolean;
  readonly dashed?: boolean;
}

export interface VisualEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly condition?: string;
  readonly directed: boolean;
  readonly dashed: boolean;
}

export interface FlowchartTopology {
  readonly entryNodeIds: readonly string[];
  readonly terminalNodeIds: readonly string[];
  readonly decisionNodeIds: readonly string[];
  readonly branchCount: number;
  readonly hasCycles: boolean;
  readonly backEdges: readonly VisualEdge[];
  readonly orderedNodeIds: readonly string[];
  readonly disconnectedNodeIds: readonly string[];
  readonly danglingEdges: readonly VisualEdge[];
}

// --- Response & output types ------------------------------------------------

export interface VisualStructuredResponse {
  readonly description?: string;
  readonly kind?: VisualRegionKind;
  readonly axes?: readonly ChartAxisInput[];
  readonly series?: readonly ChartSeriesInput[];
  readonly nodes?: readonly VisualNodeInput[];
  readonly edges?: readonly VisualEdgeInput[];
  readonly labels?: readonly (VisualLabel | string)[];
  readonly numbers?: readonly VisionNumber[];
  readonly units?: string;
  readonly trend?: string;
  readonly expression?: string;
  readonly confidence?: number | null;
  readonly illegibleFields?: readonly string[];
  readonly raw?: string;
}

export type VisualResponseInput = string | VisualStructuredResponse;

export interface VisualRegionClassification {
  readonly kind: VisualRegionKind;
  readonly confidence: number;
  readonly reasons: readonly string[];
}

export interface VisualCaptionBinding {
  readonly sourceImageId: string;
  readonly sourceBlockId: string | null;
  readonly captionBlockId: string | null;
  readonly captionText: string | null;
  readonly confidence: number | null;
  readonly reason: string | null;
  readonly alternativeCaptionId?: string;
}

export type VisualAbstentionReason =
  | 'invalid-region'
  | 'low-resolution'
  | 'low-dpi'
  | 'low-contrast'
  | 'blurry-image'
  | 'low-ocr-confidence'
  | 'illegible-content'
  | 'empty-vision-answer'
  | 'missing-description'
  | 'low-vision-confidence'
  | 'unverified-numeric-claim';

export interface VisualReadabilityAssessment {
  readonly readable: boolean;
  readonly reasons: readonly VisualAbstentionReason[];
  readonly effectiveWidthPx: number;
  readonly effectiveHeightPx: number;
  readonly effectiveDpi: number | null;
}

export type VisualClaimSource = 'description' | 'trend' | 'series' | 'numbers';
export type RejectedNumericClaimReason = 'not-in-figure-labels-or-ticks';

export interface VerifiedNumericClaim {
  readonly value: number;
  readonly raw: string;
  readonly source: VisualClaimSource;
  readonly label?: string;
  readonly seriesId?: string;
}

export interface RejectedNumericClaim {
  readonly value: number;
  readonly raw: string;
  readonly source: VisualClaimSource;
  readonly reason: RejectedNumericClaimReason;
  readonly label?: string;
  readonly seriesId?: string;
}

export interface VisualGroundingInput {
  readonly description?: string;
  readonly trend?: string;
  readonly series?: readonly (ChartSeriesInput | ChartSeries)[];
  readonly numbers?: readonly VisionNumber[];
}

export interface VisualFigureEvidence {
  readonly labels?: readonly (VisualLabel | string)[];
  readonly axes?: readonly (ChartAxisInput | ChartAxis)[];
  readonly ocrText?: string;
}

export interface VisualGroundingReport {
  readonly passed: boolean;
  readonly figureNumbers: readonly number[];
  readonly verifiedClaims: readonly VerifiedNumericClaim[];
  readonly rejectedClaims: readonly RejectedNumericClaim[];
  readonly verifiedNumbers: readonly number[];
  readonly rejectedNumbers: readonly number[];
}

export type VisualUnderstandingStatus = 'understood' | 'partial' | 'abstain';

export interface UnderstandVisualOptions {
  readonly blocks?: readonly CaptionInputBlock[];
  readonly context?: VisionContext;
  readonly strictGrounding?: boolean;
}

export interface VisualUnderstandingPlan {
  readonly sourceImageId: string;
  readonly page: number;
  readonly bbox: Rect;
  readonly kind: VisualRegionKind;
  readonly visionKind: VisionKind;
  readonly classification: VisualRegionClassification;
  readonly readability: VisualReadabilityAssessment;
  readonly captionBinding: VisualCaptionBinding;
  readonly abstained: boolean;
  readonly abstentionReasons: readonly VisualAbstentionReason[];
  readonly visionRequest: VisionRequestPlan | null;
}

export interface VisualUnderstandingResult {
  readonly version: string;
  readonly sourceImageId: string;
  readonly sourceBlockId: string | null;
  readonly page: number;
  readonly bbox: Rect;
  readonly kind: VisualRegionKind;
  readonly visionKind: VisionKind;
  readonly classification: VisualRegionClassification;
  readonly status: VisualUnderstandingStatus;
  readonly abstained: boolean;
  readonly abstentionReasons: readonly VisualAbstentionReason[];
  readonly captionBlockId: string | null;
  readonly captionText: string | null;
  readonly captionConfidence: number | null;
  readonly captionReason: string | null;
  readonly description: string | null;
  readonly axes: readonly ChartAxis[];
  readonly series: readonly ChartSeries[];
  readonly nodes: readonly VisualNode[];
  readonly edges: readonly VisualEdge[];
  readonly labels: readonly VisualLabel[];
  readonly numbers: readonly VisionNumber[];
  readonly units: string;
  readonly trend: string;
  readonly expression: string;
  readonly topology: FlowchartTopology | null;
  readonly unreadableFields: readonly string[];
  readonly grounding: VisualGroundingReport;
  readonly confidence: number | null;
  readonly readability: VisualReadabilityAssessment;
  readonly visionRequest: VisionRequestPlan | null;
}

// --- Constants & Patterns ---------------------------------------------------

const KIND_PRIORITY: readonly VisualRegionKind[] = [
  'chart',
  'flowchart',
  'technical-drawing',
  'table-image',
  'diagram',
  'photo',
];

/** Builds a Unicode word-bounded regex so non-ASCII terms (e.g. Vietnamese) match cleanly. */
function unicodeTermPattern(body: string, flags = 'iu'): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, flags);
}

const CHART_PATTERN = unicodeTermPattern(
  'chart|plot|graph|histogram|scatter|bar\\s+chart|line\\s+chart|pie\\s+chart|box\\s+plot|heatmap|x-axis|y-axis|axis|axes|legend|biểu\\s+đồ|đồ\\s+thị',
);
const FLOWCHART_PATTERN = unicodeTermPattern(
  'flowchart|flow\\s+chart|workflow|decision\\s+tree|process\\s+flow|state\\s+machine|lưu\\s+đồ|sơ\\s+đồ\\s+khối',
);
const TECHNICAL_PATTERN = unicodeTermPattern(
  'schematic|blueprint|cad|cross-section|cross\\s+section|orthographic|isometric|elevation|wiring|circuit|pinout|tolerance|diameter|radius|shaft|mechanical|assembly|exploded\\s+view|bản\\s+vẽ|mặt\\s+cắt|sơ\\s+đồ\\s+mạch|kỹ\\s+thuật|scale\\s+1:\\d+',
);
const TECHNICAL_SYMBOL_PATTERN = /[Ø⌀±°]/u;
const TABLE_IMAGE_PATTERN = unicodeTermPattern('table|tabular|spreadsheet|matrix|bảng');
const DIAGRAM_PATTERN = unicodeTermPattern(
  'diagram|architecture|block\\s+diagram|topology|sequence|er\\s+diagram|uml|system\\s+overview|component|pipeline|sơ\\s+đồ|kiến\\s+trúc',
);
const PHOTO_PATTERN = unicodeTermPattern(
  'photo|photograph|micrograph|sem|tem|mri|ct\\s+scan|x-ray|radiograph|screenshot|specimen|portrait|ảnh|chụp',
);

const ILLEGIBLE_TOKEN_PATTERN =
  /^(?:\?+|\[?(?:unreadable|illegible|blurry|obscured|unknown|n\/a|na|none|not\s+stated|not\s+readable)\]?)$/iu;
const WHOLE_FIGURE_ILLEGIBLE_PATTERN = unicodeTermPattern(
  'too\\s+blurry|too\\s+pixelated|completely\\s+(?:blurred|blurry|unreadable|illegible)|cannot\\s+read\\s+(?:the\\s+|this\\s+)?(?:image|figure|chart|diagram|flowchart|drawing|table)|(?:the\\s+)?(?:image|figure|chart|diagram|flowchart|drawing|table|axes(?:\\s+and\\s+values)?)\\s+(?:is|are)\\s+(?:too\\s+blurry|unreadable|illegible|not\\s+legible|not\\s+readable)|mờ\\s+không\\s+đọc\\s+được|không\\s+thể\\s+đọc\\s+(?:hình|biểu\\s+đồ|sơ\\s+đồ)',
);

/** Caption and ordinal tokens in prose that do not represent figure measurements. */
const PROSE_REFERENCE_PATTERN = unicodeTermPattern(
  '(?:Figure|Fig\\.?|Table|Algorithm|Chart|Diagram|Equation|Eq\\.?|Step|Hình|Bảng|Biểu\\s+đồ|Sơ\\s+đồ)\\s+\\d+(?:\\.\\d+)*',
  'giu',
);
const ORDINAL_TOKEN_PATTERN = /\b\d+(?:st|nd|rd|th)\b/giu;
const DIMENSION_TAG_PATTERN = /\b\d+[dD]\b/gu;
const COMPOUND_MODIFIER_PATTERN =
  /\b\d+-(?:step|stage|way|node|layer|tier|part|phase|column|row|series|bit|byte|fold)\b/giu;

/** Number token allowing leading diameter signs (`Ø24`, `⌀24`), thousands groups, decimals, and `%`. */
const NUMBER_TOKEN_PATTERN =
  /(?:(?<![\p{L}\p{N}])|(?<=[Ø⌀]))(?:[-−–]?\d{1,3}(?:[,\u00A0\u202F\u2009]\d{3})+(?:\.\d+)?%?|[-−–]?\d+(?:[.,]\d+)?%?)/gu;

const ABSENCE_WORD_PATTERN =
  /^(?:none|n\/a|na|nil|not\s+stated|not\s+specified|not\s+given|not\s+available|unknown|unreadable|illegible|not\s+readable|not\s+visible|not\s+applicable|\?+)$/iu;

const FLOAT_EPSILON = 1e-9;

// --- Public Functions -------------------------------------------------------

/** Maps a granular F12 visual kind to the `VisionKind` expected by `multimodal.ts`. */
export function toVisionKind(kind: VisualRegionKind): VisionKind {
  return kind === 'chart' ? 'chart' : 'figure';
}

/**
 * Classifies a visual crop into one of the six F12 categories using declared hints,
 * structural geometry cues, and text cues from captions, labels, and OCR.
 */
export function classifyVisualRegion(region: VisualRegionInput): VisualRegionClassification {
  assertRegionObject(region, 'classifyVisualRegion');
  const scores = emptyKindScores();
  const reasons: string[] = [];

  if (region.declaredKind !== undefined && isVisualRegionKind(region.declaredKind)) {
    scores[region.declaredKind] += 4;
    reasons.push(`declared=${region.declaredKind}`);
  }

  scoreGeometryCues(region, scores, reasons);
  scoreTextCues(region, scores, reasons);

  let winner: VisualRegionKind = 'diagram';
  let bestScore = -1;
  let runnerUpScore = 0;

  for (const kind of KIND_PRIORITY) {
    const score = scores[kind];
    if (score > bestScore) {
      runnerUpScore = bestScore > 0 ? bestScore : runnerUpScore;
      bestScore = score;
      winner = kind;
    } else if (score > runnerUpScore) {
      runnerUpScore = score;
    }
  }

  if (bestScore <= 0) {
    reasons.push('fallback=diagram');
    return { kind: 'diagram', confidence: 0.25, reasons };
  }

  const totalPositive = KIND_PRIORITY.reduce((sum, kind) => sum + Math.max(0, scores[kind]), 0);
  const margin = bestScore - runnerUpScore;
  const share = totalPositive > 0 ? bestScore / totalPositive : 0;
  const rawConfidence = Math.min(0.99, Math.max(0.3, 0.45 * share + 0.55 * Math.min(1, bestScore / 4) + margin * 0.03));

  return {
    kind: winner,
    confidence: round4(rawConfidence),
    reasons,
  };
}

/**
 * Evaluates whether a visual region has enough geometric area, pixel density, DPI,
 * contrast, sharpness, and OCR legibility to support reliable structured extraction.
 */
export function assessVisualReadability(region: VisualRegionInput): VisualReadabilityAssessment {
  assertRegionObject(region, 'assessVisualReadability');
  const reasons: VisualAbstentionReason[] = [];

  if (!isPositiveRect(region.bbox)) {
    return {
      readable: false,
      reasons: ['invalid-region'],
      effectiveWidthPx: 0,
      effectiveHeightPx: 0,
      effectiveDpi: positiveOrNull(region.dpi),
    };
  }

  const explicitDpi = positiveOrNull(region.dpi);
  const pixelScale = explicitDpi !== null ? explicitDpi / 72 : VISION_DEFAULT_SCALE;
  const effectiveWidthPx = positiveOrNull(region.widthPx) ?? Math.round(region.bbox.width * pixelScale);
  const effectiveHeightPx = positiveOrNull(region.heightPx) ?? Math.round(region.bbox.height * pixelScale);

  const longEdge = Math.max(effectiveWidthPx, effectiveHeightPx);
  const shortEdge = Math.min(effectiveWidthPx, effectiveHeightPx);
  if (longEdge < MIN_READABLE_LONG_EDGE_PX || shortEdge < MIN_READABLE_SHORT_EDGE_PX) {
    reasons.push('low-resolution');
  }

  if (explicitDpi !== null && explicitDpi < MIN_READABLE_DPI) {
    reasons.push('low-dpi');
  }

  const quality = region.quality;
  if (quality !== undefined && quality !== null) {
    if (quality.legible === false) reasons.push('illegible-content');
    if (isFiniteNumber(quality.contrast) && quality.contrast < MIN_READABLE_CONTRAST) {
      reasons.push('low-contrast');
    }
    if (isFiniteNumber(quality.blurScore) && quality.blurScore > MAX_READABLE_BLUR_SCORE) {
      reasons.push('blurry-image');
    }
    if (isFiniteNumber(quality.ocrConfidence) && quality.ocrConfidence < MIN_READABLE_OCR_CONFIDENCE) {
      reasons.push('low-ocr-confidence');
    }
  }

  return {
    readable: reasons.length === 0,
    reasons,
    effectiveWidthPx,
    effectiveHeightPx,
    effectiveDpi: explicitDpi,
  };
}

/**
 * Binds multiple visual regions to document caption blocks via `linkCaptions`,
 * keeping multi-figure ordinal numbering and two-column overlap rules intact.
 */
export function bindVisualCaptions(
  regions: readonly VisualRegionInput[],
  blocks: readonly CaptionInputBlock[],
): Map<string, VisualCaptionBinding> {
  const safeRegions = Array.isArray(regions) ? regions : [];
  const safeBlocks = Array.isArray(blocks) ? blocks : [];
  const bindings = new Map<string, VisualCaptionBinding>();
  if (safeRegions.length === 0) return bindings;

  if (safeBlocks.length === 0) {
    for (const region of safeRegions) {
      bindings.set(region.imageId, fallbackCaptionBinding(region));
    }
    return bindings;
  }

  const resolvedIds = resolveBlockIds(safeBlocks);
  const blockTextById = new Map<string, string>();
  for (let i = 0; i < safeBlocks.length; i++) {
    const block = safeBlocks[i];
    const resolvedId = resolvedIds[i];
    if (block !== undefined && resolvedId !== undefined) {
      blockTextById.set(resolvedId, typeof block.text === 'string' ? block.text : '');
    }
  }

  const targetIdByImageId = new Map<string, string>();
  const matchedExistingIdByImageId = new Map<string, string | null>();
  const syntheticCandidates: CaptionInputBlock[] = [];
  const claimedExistingIds = new Set<string>();

  for (let i = 0; i < safeRegions.length; i++) {
    const region = safeRegions[i];
    if (region === undefined) continue;
    const classification = classifyVisualRegion(region);
    const preferredType = classification.kind === 'table-image' ? 'table' : 'figure';
    const existingId = findMatchingCandidateBlockId(region, safeBlocks, resolvedIds, claimedExistingIds);

    if (existingId !== null) {
      claimedExistingIds.add(existingId);
      targetIdByImageId.set(region.imageId, existingId);
      matchedExistingIdByImageId.set(region.imageId, existingId);
      continue;
    }

    const syntheticId = `__iu-target-${i}-${region.imageId}`;
    targetIdByImageId.set(region.imageId, syntheticId);
    matchedExistingIdByImageId.set(region.imageId, null);
    syntheticCandidates.push({
      id: syntheticId,
      type: preferredType,
      page: pageOf(region.page),
      text: textOf(region.ocrText),
      rect: sanitizeRect(region.bbox),
      pageHeight: positiveOrNull(region.pageHeight) ?? DEFAULT_PAGE_HEIGHT,
    });
  }

  const combinedBlocks = syntheticCandidates.length > 0 ? [...safeBlocks, ...syntheticCandidates] : safeBlocks;
  const linkResult = linkCaptions(combinedBlocks);
  const linkByTargetId = new Map<string, CaptionLink>();

  for (const link of linkResult.links) {
    const existing = linkByTargetId.get(link.targetId);
    if (existing === undefined || link.confidence > existing.confidence) {
      linkByTargetId.set(link.targetId, link);
    }
  }

  for (const region of safeRegions) {
    const targetId = targetIdByImageId.get(region.imageId);
    const link = targetId !== undefined ? linkByTargetId.get(targetId) : undefined;
    const matchedBlockId = matchedExistingIdByImageId.get(region.imageId) ?? null;

    if (link === undefined) {
      bindings.set(region.imageId, {
        sourceImageId: region.imageId,
        sourceBlockId: matchedBlockId ?? (nonEmptyText(region.sourceBlockId) ?? null),
        captionBlockId: null,
        captionText: null,
        confidence: null,
        reason: null,
      });
      continue;
    }

    const binding: VisualCaptionBinding = {
      sourceImageId: region.imageId,
      sourceBlockId: matchedBlockId ?? (nonEmptyText(region.sourceBlockId) ?? null),
      captionBlockId: link.captionId,
      captionText: blockTextById.get(link.captionId) ?? null,
      confidence: link.confidence,
      reason: link.reason,
      ...(link.alternativeId !== undefined ? { alternativeCaptionId: link.alternativeId } : {}),
    };
    bindings.set(region.imageId, binding);
  }

  return bindings;
}

/** Binds one visual region to its matching caption block via `linkCaptions`. */
export function bindVisualCaption(
  region: VisualRegionInput,
  blocks: readonly CaptionInputBlock[],
): VisualCaptionBinding {
  assertRegionObject(region, 'bindVisualCaption');
  return bindVisualCaptions([region], blocks).get(region.imageId) ?? fallbackCaptionBinding(region);
}

/**
 * Plans a multimodal vision request for a visual region after checking readability,
 * classifying the visual kind, and binding any document caption.
 */
export function planVisualUnderstanding(
  region: VisualRegionInput,
  options: UnderstandVisualOptions = {},
): VisualUnderstandingPlan {
  assertRegionObject(region, 'planVisualUnderstanding');
  const page = pageOf(region.page);
  const bbox = sanitizeRect(region.bbox);
  const classification = classifyVisualRegion(region);
  const visionKind = toVisionKind(classification.kind);
  const readability = assessVisualReadability(region);
  const captionBinding =
    options.blocks !== undefined
      ? bindVisualCaption(region, options.blocks)
      : fallbackCaptionBinding(region);

  if (!readability.readable) {
    return {
      sourceImageId: region.imageId,
      page,
      bbox,
      kind: classification.kind,
      visionKind,
      classification,
      readability,
      captionBinding,
      abstained: true,
      abstentionReasons: [...readability.reasons],
      visionRequest: null,
    };
  }

  const visionRequest = planVisionRequest(
    {
      kind: visionKind,
      page,
      rect: bbox,
      ...(captionBinding.captionText !== null ? { caption: captionBinding.captionText } : {}),
      ...(nonEmptyText(region.nearbyText) !== undefined ? { nearbyText: region.nearbyText } : {}),
    },
    options.context ?? {},
  );

  return {
    sourceImageId: region.imageId,
    page,
    bbox,
    kind: classification.kind,
    visionKind,
    classification,
    readability,
    captionBinding,
    abstained: false,
    abstentionReasons: [],
    visionRequest,
  };
}

/**
 * Computes deterministic flowchart/diagram topology: entry nodes, terminal nodes,
 * decision branches, cycle detection with back-edges, topological execution order,
 * disconnected nodes, and dangling edges.
 */
export function analyzeFlowchartTopology(
  nodesInput: readonly VisualNodeInput[],
  edgesInput: readonly VisualEdgeInput[],
): FlowchartTopology {
  const nodes = normalizeNodes(nodesInput);
  const edges = normalizeEdges(edgesInput);
  const nodeIds = new Set(nodes.map(node => node.id));

  const validEdges: VisualEdge[] = [];
  const danglingEdges: VisualEdge[] = [];
  for (const edge of edges) {
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
      validEdges.push(edge);
    } else {
      danglingEdges.push(edge);
    }
  }

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const outgoing = new Map<string, VisualEdge[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    outDegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of validEdges) {
    outgoing.get(edge.from)?.push(edge);
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const disconnectedNodeIds: string[] = [];
  const connectedIds = new Set<string>();
  for (const node of nodes) {
    const inCount = inDegree.get(node.id) ?? 0;
    const outCount = outDegree.get(node.id) ?? 0;
    if (inCount === 0 && outCount === 0) {
      if (nodes.length > 1 || validEdges.length > 0 || node.kind !== 'start') {
        disconnectedNodeIds.push(node.id);
      } else {
        connectedIds.add(node.id);
      }
    } else {
      connectedIds.add(node.id);
    }
  }

  const entryNodeIds: string[] = [];
  const terminalNodeIds: string[] = [];
  const decisionNodeIds: string[] = [];
  let branchCount = 0;

  for (const node of nodes) {
    const inCount = inDegree.get(node.id) ?? 0;
    const outCount = outDegree.get(node.id) ?? 0;
    const connected = connectedIds.has(node.id);

    if (node.kind === 'start' || (connected && inCount === 0 && outCount > 0)) {
      entryNodeIds.push(node.id);
    }
    if (node.kind === 'end' || (connected && outCount === 0 && inCount > 0)) {
      terminalNodeIds.push(node.id);
    }
    if (node.kind === 'decision' || outCount >= 2) {
      decisionNodeIds.push(node.id);
      branchCount += outCount;
    }
  }

  if (entryNodeIds.length === 0 && connectedIds.size > 0) {
    const firstConnected = nodes.find(node => connectedIds.has(node.id));
    if (firstConnected !== undefined) entryNodeIds.push(firstConnected.id);
  }

  const backEdges = detectBackEdges(nodes, entryNodeIds, connectedIds, outgoing);
  const backEdgeSet = new Set(backEdges);
  const orderedNodeIds = topologicalOrder(nodes, connectedIds, validEdges, backEdgeSet);

  return {
    entryNodeIds,
    terminalNodeIds,
    decisionNodeIds,
    branchCount,
    hasCycles: backEdges.length > 0,
    backEdges,
    orderedNodeIds,
    disconnectedNodeIds,
    danglingEdges,
  };
}

/**
 * Verifies every numeric claim in `description`, `trend`, `series`, and `numbers`
 * against numbers visibly present in figure `labels`, `axes[].ticks`, and `ocrText`.
 */
export function verifyVisualGrounding(
  claims: VisualGroundingInput,
  evidence: VisualFigureEvidence,
): VisualGroundingReport {
  const figureNumberList = collectFigureNumbers(evidence);
  const figureNumberSet = new Set<number>(figureNumberList);

  const verifiedClaims: VerifiedNumericClaim[] = [];
  const rejectedClaims: RejectedNumericClaim[] = [];

  for (const series of claims.series ?? []) {
    const seriesId = series.id ?? series.name;
    for (const point of series.points) {
      if (point.illegible === true || point.y === null) continue;
      const numeric = parseSeriesPointNumber(point.y);
      if (numeric === null) continue;
      const raw = String(point.y);
      if (hasGroundedNumber(figureNumberSet, numeric)) {
        verifiedClaims.push({
          value: numeric,
          raw,
          source: 'series',
          label: String(point.x),
          seriesId,
        });
      } else {
        rejectedClaims.push({
          value: numeric,
          raw,
          source: 'series',
          reason: 'not-in-figure-labels-or-ticks',
          label: String(point.x),
          seriesId,
        });
      }
    }
  }

  for (const entry of claims.numbers ?? []) {
    if (!Number.isFinite(entry.value)) continue;
    const value = normalizeZero(entry.value);
    if (hasGroundedNumber(figureNumberSet, value)) {
      verifiedClaims.push({
        value,
        raw: String(entry.value),
        source: 'numbers',
        label: entry.label,
      });
    } else {
      rejectedClaims.push({
        value,
        raw: String(entry.value),
        source: 'numbers',
        reason: 'not-in-figure-labels-or-ticks',
        label: entry.label,
      });
    }
  }

  checkProseNumericClaims(claims.description, 'description', figureNumberSet, verifiedClaims, rejectedClaims);
  checkProseNumericClaims(claims.trend, 'trend', figureNumberSet, verifiedClaims, rejectedClaims);

  return {
    passed: rejectedClaims.length === 0,
    figureNumbers: figureNumberList,
    verifiedClaims,
    rejectedClaims,
    verifiedNumbers: uniqueNumbers(verifiedClaims.map(claim => claim.value)),
    rejectedNumbers: uniqueNumbers(rejectedClaims.map(claim => claim.value)),
  };
}

/**
 * Understands one visual region: classifies its kind, checks readability/resolution,
 * binds it to its source image ID, bounding box, and caption block, extracts structured
 * chart/diagram/flowchart/drawing elements, and grounds all numeric claims.
 */
export function understandVisualRegion(
  region: VisualRegionInput,
  response?: VisualResponseInput,
  options: UnderstandVisualOptions = {},
): VisualUnderstandingResult {
  assertRegionObject(region, 'understandVisualRegion');
  const binding =
    options.blocks !== undefined
      ? bindVisualCaption(region, options.blocks)
      : fallbackCaptionBinding(region);
  return buildUnderstandingResult(region, response, options, binding);
}

/**
 * Batch version of {@link understandVisualRegion} that binds captions across all regions
 * on the document together so multi-figure ordinal numbering stays accurate.
 */
export function understandVisualRegions(
  entries: readonly { readonly region: VisualRegionInput; readonly response?: VisualResponseInput }[],
  options: UnderstandVisualOptions = {},
): VisualUnderstandingResult[] {
  const safeEntries = Array.isArray(entries) ? entries : [];
  if (safeEntries.length === 0) return [];
  const regions = safeEntries.map(entry => entry.region);
  const bindings =
    options.blocks !== undefined
      ? bindVisualCaptions(regions, options.blocks)
      : new Map<string, VisualCaptionBinding>(
          regions.map(region => [region.imageId, fallbackCaptionBinding(region)]),
        );

  return safeEntries.map(entry =>
    buildUnderstandingResult(
      entry.region,
      entry.response,
      options,
      bindings.get(entry.region.imageId) ?? fallbackCaptionBinding(entry.region),
    ),
  );
}

// --- Core Pipeline ----------------------------------------------------------

function buildUnderstandingResult(
  region: VisualRegionInput,
  response: VisualResponseInput | undefined,
  options: UnderstandVisualOptions,
  binding: VisualCaptionBinding,
): VisualUnderstandingResult {
  assertRegionObject(region, 'understandVisualRegion');
  const page = pageOf(region.page);
  const bbox = sanitizeRect(region.bbox);
  const readability = assessVisualReadability(region);
  const parsed = parseResponseInput(response);

  const regionForClassification = enrichRegionForClassification(region, binding, parsed);
  const classification = classifyVisualRegion(regionForClassification);
  const visionKind = toVisionKind(classification.kind);

  const visionRequest = readability.readable
    ? planVisionRequest(
        {
          kind: visionKind,
          page,
          rect: bbox,
          ...(binding.captionText !== null ? { caption: binding.captionText } : {}),
          ...(nonEmptyText(region.nearbyText) !== undefined ? { nearbyText: region.nearbyText } : {}),
        },
        options.context ?? {},
      )
    : null;

  if (!readability.readable) {
    return createAbstainedResult(
      region,
      page,
      bbox,
      classification,
      visionKind,
      binding,
      readability,
      visionRequest,
      readability.reasons,
      null,
    );
  }

  if (parsed !== null && parsed.abstainReason !== null) {
    return createAbstainedResult(
      region,
      page,
      bbox,
      classification,
      visionKind,
      binding,
      readability,
      visionRequest,
      [parsed.abstainReason],
      parsed.confidence,
    );
  }

  const normalizedLabels = normalizeLabels(mergeLabelInputs(region.labels, parsed?.labels));
  const normalizedAxes = normalizeAxes(mergeAxisInputs(region.axes, parsed?.axes));

  // Authoritative figure evidence: when `region` supplies observed labels/ocrText/axes,
  // untrusted response labels/axes cannot fabricate self-grounding numbers.
  const hasObservedRegionLabels =
    (region.labels !== undefined && region.labels.length > 0) ||
    (nonEmptyText(region.ocrText) !== undefined);
  const hasObservedRegionAxes = region.axes !== undefined && region.axes.length > 0;

  const evidence: VisualFigureEvidence = {
    labels: hasObservedRegionLabels ? region.labels : normalizedLabels,
    axes: hasObservedRegionAxes ? region.axes : normalizedAxes,
    ...(nonEmptyText(region.ocrText) !== undefined ? { ocrText: region.ocrText } : {}),
  };

  const rawSeries = parsed?.series ?? [];
  const rawNumbers = parsed?.numbers ?? [];
  const groundingNumbers =
    parsed !== null && parsed.extraNumbersForGrounding.length > 0
      ? [...rawNumbers, ...parsed.extraNumbersForGrounding]
      : rawNumbers;
  const description = parsed?.description ?? null;
  const trend = parsed?.trend ?? '';

  const grounding = verifyVisualGrounding(
    {
      ...(description !== null ? { description } : {}),
      ...(trend.length > 0 ? { trend } : {}),
      series: rawSeries,
      numbers: groundingNumbers,
    },
    evidence,
  );

  const unreadableFields: string[] = [...(parsed?.illegibleFields ?? [])];
  for (const label of normalizedLabels) {
    if (label.illegible) unreadableFields.push(`label:${label.text}`);
  }

  const groundedSeries = sanitizeSeriesWithGrounding(rawSeries, grounding, unreadableFields);
  const groundedNumbers = filterGroundedNumbers(rawNumbers, grounding);
  const normalizedNodes = normalizeNodes(parsed?.nodes ?? [], unreadableFields);
  const normalizedEdges = normalizeEdges(parsed?.edges ?? []);

  const topology =
    classification.kind === 'flowchart' ||
    (classification.kind === 'diagram' && (normalizedNodes.length > 0 || normalizedEdges.length > 0))
      ? analyzeFlowchartTopology(normalizedNodes, normalizedEdges)
      : null;

  const uniqueUnreadable = uniqueStrings(unreadableFields);

  if (
    options.strictGrounding === true &&
    grounding.rejectedClaims.some(claim => claim.source === 'description')
  ) {
    return createAbstainedResult(
      region,
      page,
      bbox,
      classification,
      visionKind,
      binding,
      readability,
      visionRequest,
      ['unverified-numeric-claim'],
      parsed?.confidence ?? null,
      grounding,
    );
  }

  const status: VisualUnderstandingStatus =
    description === null || !grounding.passed || uniqueUnreadable.length > 0 ? 'partial' : 'understood';

  return {
    version: IMAGE_UNDERSTANDING_VERSION,
    sourceImageId: region.imageId,
    sourceBlockId: binding.sourceBlockId,
    page,
    bbox,
    kind: classification.kind,
    visionKind,
    classification,
    status,
    abstained: false,
    abstentionReasons: [],
    captionBlockId: binding.captionBlockId,
    captionText: binding.captionText,
    captionConfidence: binding.confidence,
    captionReason: binding.reason,
    description,
    axes: normalizedAxes,
    series: groundedSeries,
    nodes: normalizedNodes,
    edges: normalizedEdges,
    labels: normalizedLabels,
    numbers: groundedNumbers,
    units: deriveUnits(parsed?.units ?? '', normalizedAxes, groundedSeries),
    trend,
    expression: parsed?.expression ?? '',
    topology,
    unreadableFields: uniqueUnreadable,
    grounding,
    confidence: parsed?.confidence ?? null,
    readability,
    visionRequest,
  };
}

function createAbstainedResult(
  region: VisualRegionInput,
  page: number,
  bbox: Rect,
  classification: VisualRegionClassification,
  visionKind: VisionKind,
  binding: VisualCaptionBinding,
  readability: VisualReadabilityAssessment,
  visionRequest: VisionRequestPlan | null,
  reasons: readonly VisualAbstentionReason[],
  confidence: number | null,
  grounding?: VisualGroundingReport,
): VisualUnderstandingResult {
  const emptyGrounding: VisualGroundingReport = grounding ?? {
    passed: true,
    figureNumbers: [],
    verifiedClaims: [],
    rejectedClaims: [],
    verifiedNumbers: [],
    rejectedNumbers: [],
  };

  return {
    version: IMAGE_UNDERSTANDING_VERSION,
    sourceImageId: region.imageId,
    sourceBlockId: binding.sourceBlockId,
    page,
    bbox,
    kind: classification.kind,
    visionKind,
    classification,
    status: 'abstain',
    abstained: true,
    abstentionReasons: [...reasons],
    captionBlockId: binding.captionBlockId,
    captionText: binding.captionText,
    captionConfidence: binding.confidence,
    captionReason: binding.reason,
    description: null,
    axes: [],
    series: [],
    nodes: [],
    edges: [],
    labels: [],
    numbers: [],
    units: '',
    trend: '',
    expression: '',
    topology: null,
    unreadableFields: [],
    grounding: emptyGrounding,
    confidence,
    readability,
    visionRequest,
  };
}

// --- Response Parsing -------------------------------------------------------

interface ParsedResponseData {
  kind?: VisualRegionKind;
  description: string | null;
  axes: readonly ChartAxisInput[];
  series: readonly ChartSeriesInput[];
  nodes: readonly VisualNodeInput[];
  edges: readonly VisualEdgeInput[];
  labels: readonly (VisualLabel | string)[];
  numbers: readonly VisionNumber[];
  extraNumbersForGrounding: readonly VisionNumber[];
  units: string;
  trend: string;
  expression: string;
  confidence: number | null;
  illegibleFields: readonly string[];
  abstainReason: VisualAbstentionReason | null;
}

function parseResponseInput(response: VisualResponseInput | undefined): ParsedResponseData | null {
  if (response === undefined) return null;

  if (typeof response === 'string') {
    const trimmed = response.trim();
    if (trimmed.length === 0) {
      return emptyParsedResponse('empty-vision-answer');
    }
    if (trimmed.startsWith('{')) {
      try {
        const json = JSON.parse(trimmed) as unknown;
        if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
          return parseStructuredResponseObject(json as VisualStructuredResponse);
        }
      } catch {
        // Fall through to structured-line text parsing via multimodal.ts.
      }
    }
    return parseTextVisionResponse(response);
  }

  if (response !== null && typeof response === 'object') {
    return parseStructuredResponseObject(response);
  }

  return emptyParsedResponse('empty-vision-answer');
}

function parseTextVisionResponse(text: string): ParsedResponseData {
  let answer: ReturnType<typeof parseVisionAnswer>;
  try {
    answer = parseVisionAnswer(text);
  } catch (error) {
    if (error instanceof VisionAnswerError) {
      return emptyParsedResponse(
        error.code === 'empty-answer' ? 'empty-vision-answer' : 'missing-description',
      );
    }
    throw error;
  }

  const abstainReason = assessAnswerLegibility(answer.description, answer.confidence);
  if (abstainReason !== null) {
    return { ...emptyParsedResponse(abstainReason), confidence: answer.confidence };
  }

  const structuredLines = extractStructuredLines(text);
  const extraNumbersForGrounding =
    answer.droppedNumbers > 0 ? extractUnreportedNumbersFromText(text, answer.numbers) : [];
  return {
    description: answer.description,
    axes: structuredLines.axes,
    series: structuredLines.series,
    nodes: structuredLines.nodes,
    edges: structuredLines.edges,
    labels: structuredLines.labels,
    numbers: answer.numbers,
    extraNumbersForGrounding,
    units: answer.units,
    trend: answer.trend,
    expression: answer.expression,
    confidence: answer.confidence,
    illegibleFields: [],
    abstainReason: null,
  };
}

function parseStructuredResponseObject(obj: VisualStructuredResponse): ParsedResponseData {
  const descriptionText = typeof obj.description === 'string' ? obj.description.trim() : '';
  const confidence =
    obj.confidence === null || obj.confidence === undefined
      ? null
      : isFiniteNumber(obj.confidence) && obj.confidence >= 0 && obj.confidence <= 1
        ? obj.confidence
        : null;

  if (descriptionText.length === 0 || isAbsenceToken(descriptionText)) {
    return { ...emptyParsedResponse('missing-description'), confidence };
  }

  const abstainReason = assessAnswerLegibility(descriptionText, confidence);
  if (abstainReason !== null) {
    return { ...emptyParsedResponse(abstainReason), confidence };
  }

  return {
    ...(obj.kind !== undefined && isVisualRegionKind(obj.kind) ? { kind: obj.kind } : {}),
    description: descriptionText,
    axes: Array.isArray(obj.axes) ? obj.axes : [],
    series: Array.isArray(obj.series) ? obj.series : [],
    nodes: Array.isArray(obj.nodes) ? obj.nodes : [],
    edges: Array.isArray(obj.edges) ? obj.edges : [],
    labels: Array.isArray(obj.labels) ? obj.labels : [],
    numbers: Array.isArray(obj.numbers) ? obj.numbers : [],
    extraNumbersForGrounding: [],
    units: typeof obj.units === 'string' ? obj.units.trim() : '',
    trend: typeof obj.trend === 'string' ? obj.trend.trim() : '',
    expression: typeof obj.expression === 'string' ? obj.expression.trim() : '',
    confidence,
    illegibleFields: Array.isArray(obj.illegibleFields)
      ? obj.illegibleFields.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [],
    abstainReason: null,
  };
}

function assessAnswerLegibility(
  description: string,
  confidence: number | null,
): VisualAbstentionReason | null {
  if (WHOLE_FIGURE_ILLEGIBLE_PATTERN.test(description)) return 'illegible-content';
  if (confidence !== null && confidence < MIN_VISION_CONFIDENCE) return 'low-vision-confidence';
  return null;
}

function enrichRegionForClassification(
  region: VisualRegionInput,
  binding: VisualCaptionBinding,
  parsed: ParsedResponseData | null,
): VisualRegionInput {
  const cues: VisualGeometryCues = {
    ...(region.cues ?? {}),
    ...(parsed !== null && parsed.axes.length > 0 ? { hasAxes: true } : {}),
    ...(parsed !== null && parsed.series.length > 0 ? { seriesCount: parsed.series.length } : {}),
    ...(parsed !== null && parsed.nodes.length > 0
      ? {
          nodeBoxCount: Math.max(region.cues?.nodeBoxCount ?? 0, parsed.nodes.length),
          hasDecisionDiamond:
            region.cues?.hasDecisionDiamond === true ||
            parsed.nodes.some(node => node.kind === 'decision'),
        }
      : {}),
    ...(parsed !== null && parsed.edges.length > 0
      ? { arrowCount: Math.max(region.cues?.arrowCount ?? 0, parsed.edges.length) }
      : {}),
  };

  return {
    ...region,
    ...(parsed?.kind !== undefined && region.declaredKind === undefined ? { declaredKind: parsed.kind } : {}),
    ...(region.caption === undefined && binding.captionText !== null ? { caption: binding.captionText } : {}),
    ...(region.axes === undefined && parsed !== null && parsed.axes.length > 0 ? { axes: parsed.axes } : {}),
    cues,
  };
}

function emptyParsedResponse(abstainReason: VisualAbstentionReason): ParsedResponseData {
  return {
    description: null,
    axes: [],
    series: [],
    nodes: [],
    edges: [],
    labels: [],
    numbers: [],
    extraNumbersForGrounding: [],
    units: '',
    trend: '',
    expression: '',
    confidence: null,
    illegibleFields: [],
    abstainReason,
  };
}

/** Reads optional `axes:`, `series:`, `nodes:`, `edges:`, `labels:` lines from text answers. */
function extractStructuredLines(text: string): {
  axes: ChartAxisInput[];
  series: ChartSeriesInput[];
  nodes: VisualNodeInput[];
  edges: VisualEdgeInput[];
  labels: string[];
} {
  const axes: ChartAxisInput[] = [];
  const series: ChartSeriesInput[] = [];
  const nodes: VisualNodeInput[] = [];
  const edges: VisualEdgeInput[] = [];
  const labels: string[] = [];

  for (const rawLine of text.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();
    if (value.length === 0 || isAbsenceToken(value)) continue;

    if (key === 'axes') {
      parseAxesLine(value, axes);
    } else if (key === 'series') {
      parseSeriesLine(value, series);
    } else if (key === 'nodes') {
      parseNodesLine(value, nodes);
    } else if (key === 'edges') {
      parseEdgesLine(value, edges);
    } else if (key === 'labels') {
      for (const part of value.split(';')) {
        const cleaned = part.trim();
        if (cleaned.length > 0) labels.push(cleaned);
      }
    }
  }

  return { axes, series, nodes, edges, labels };
}

function parseAxesLine(value: string, out: ChartAxisInput[]): void {
  for (const segment of value.split(';')) {
    const match = segment.trim().match(/^(x|y|y2|z|radial)(?:\s*\[([^\]]+)\])?\s*:\s*(.+)$/iu);
    if (match === null) continue;
    const orientation = (match[1] ?? 'x').toLowerCase() as AxisOrientation;
    const unit = (match[2] ?? '').trim();
    const ticks = (match[3] ?? '')
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0)
      .map(t => {
        const num = normalizeNumberToken(t);
        return num !== null && /^[-−–]?\d/u.test(t) ? num : t;
      });
    out.push({ orientation, unit, ticks });
  }
}

function parseSeriesLine(value: string, out: ChartSeriesInput[]): void {
  for (const segment of value.split(';')) {
    const colon = segment.indexOf(':');
    if (colon <= 0) continue;
    const head = segment.slice(0, colon).trim();
    const body = segment.slice(colon + 1).trim();
    const unitMatch = head.match(/^(.+?)\s*\(([^)]+)\)$/u);
    const name = unitMatch !== null ? (unitMatch[1] ?? head).trim() : head;
    const unit = unitMatch !== null ? (unitMatch[2] ?? '').trim() : '';
    const points: ChartPointInput[] = [];
    for (const item of body.split(',')) {
      const eq = item.indexOf('=');
      if (eq <= 0) continue;
      const x = item.slice(0, eq).trim();
      const rawY = item.slice(eq + 1).trim();
      if (isAbsenceToken(rawY)) {
        points.push({ x, y: rawY, illegible: true });
        continue;
      }
      const extracted = extractNumbersFromText(rawY);
      const numY = extracted.length > 0 && /^[-−–]?\d/u.test(rawY) ? extracted[0]?.value ?? null : normalizeNumberToken(rawY);
      points.push({ x, y: numY !== null ? numY : rawY });
    }
    if (points.length > 0) {
      out.push({ name, unit, points });
    }
  }
}

function parseNodesLine(value: string, out: VisualNodeInput[]): void {
  for (const segment of value.split(';')) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)(?:\[([a-z-]+)\])?\s*:\s*(.+)$/u);
    if (match !== null) {
      const id = (match[1] ?? '').trim();
      const kind = (match[2] ?? 'process').trim() as VisualNodeKind;
      const label = (match[3] ?? id).trim();
      out.push({ id, label, kind });
    } else {
      out.push({ id: trimmed, label: trimmed, kind: 'process' });
    }
  }
}

function parseEdgesLine(value: string, out: VisualEdgeInput[]): void {
  for (const segment of value.split(';')) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const pipeMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*-+>\s*\|([^|]+)\|\s*([A-Za-z0-9_-]+)$/u);
    if (pipeMatch !== null) {
      const from = (pipeMatch[1] ?? '').trim();
      const label = (pipeMatch[2] ?? '').trim();
      const to = (pipeMatch[3] ?? '').trim();
      out.push({ from, to, ...(label.length > 0 ? { label } : {}), directed: true });
      continue;
    }
    const labelArrowMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*--\s*([^->]+?)\s*-+>\s*([A-Za-z0-9_-]+)$/u);
    if (labelArrowMatch !== null) {
      const from = (labelArrowMatch[1] ?? '').trim();
      const label = (labelArrowMatch[2] ?? '').trim();
      const to = (labelArrowMatch[3] ?? '').trim();
      out.push({ from, to, ...(label.length > 0 ? { label } : {}), directed: true });
      continue;
    }
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*-+>\s*([A-Za-z0-9_-]+)(?:\s*\[([^\]]+)\])?$/u);
    if (match === null) continue;
    const from = (match[1] ?? '').trim();
    const to = (match[2] ?? '').trim();
    const label = (match[3] ?? '').trim();
    out.push({ from, to, ...(label.length > 0 ? { label } : {}), directed: true });
  }
}

function extractUnreportedNumbersFromText(
  text: string,
  kept: readonly VisionNumber[],
): VisionNumber[] {
  const keptValues = new Set(kept.map(entry => normalizeZero(entry.value)));
  const extra: VisionNumber[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const match = rawLine.trim().match(/^(?:numbers|number|values|readings)\s*:\s*(.+)$/iu);
    if (match === null) continue;
    const rest = match[1] ?? '';
    for (const part of rest.split(/[;,]/u)) {
      const eq = part.indexOf('=');
      const label = eq >= 0 ? part.slice(0, eq).trim() : 'reported';
      const rhs = eq >= 0 ? part.slice(eq + 1) : part;
      for (const found of extractNumbersFromText(rhs)) {
        if (!hasGroundedNumber(keptValues, found.value)) {
          extra.push({ label: label.length > 0 ? label : 'reported', value: found.value });
        }
      }
    }
  }
  return extra;
}

// --- Classification Helpers -------------------------------------------------

function emptyKindScores(): Record<VisualRegionKind, number> {
  return {
    chart: 0,
    diagram: 0,
    flowchart: 0,
    'technical-drawing': 0,
    'table-image': 0,
    photo: 0,
  };
}

function scoreGeometryCues(
  region: VisualRegionInput,
  scores: Record<VisualRegionKind, number>,
  reasons: string[],
): void {
  const cues = region.cues;
  if (region.axes !== undefined && region.axes.length > 0) {
    scores.chart += 2.5;
    reasons.push('axes-present');
  }
  if (cues === undefined || cues === null) return;

  if (cues.hasAxes) {
    scores.chart += 2.5;
    reasons.push('cue=axes');
  }
  if (cues.hasGridLines) {
    scores.chart += 1.5;
    reasons.push('cue=grid-lines');
  }
  if (cues.hasLegend) {
    scores.chart += 1.5;
    reasons.push('cue=legend');
  }
  if ((cues.tickCount ?? 0) >= 2) {
    scores.chart += 1.5;
    reasons.push('cue=ticks');
  }
  if ((cues.seriesCount ?? 0) >= 1) {
    scores.chart += 1.5;
    reasons.push('cue=series');
  }
  if (cues.hasDecisionDiamond) {
    scores.flowchart += 3.5;
    reasons.push('cue=decision-diamond');
  }
  if (cues.hasDimensionLines) {
    scores['technical-drawing'] += 3;
    reasons.push('cue=dimension-lines');
  }
  if (cues.hasCallouts) {
    scores['technical-drawing'] += 1.5;
    reasons.push('cue=callouts');
  }
  if (cues.hasGridCells || ((cues.rowCount ?? 0) >= 2 && (cues.colCount ?? 0) >= 2)) {
    scores['table-image'] += 3;
    reasons.push('cue=grid-cells');
  }
  if ((cues.nodeBoxCount ?? 0) >= 2 && (cues.arrowCount ?? 0) >= 1) {
    scores.diagram += 2;
    scores.flowchart += 1;
    reasons.push('cue=boxes-and-arrows');
  } else if ((cues.nodeBoxCount ?? 0) >= 2 || (cues.arrowCount ?? 0) >= 2) {
    scores.diagram += 1.5;
    reasons.push('cue=structure');
  }
  if (cues.isPhotographic) {
    scores.photo += 3.5;
    reasons.push('cue=photographic');
  }
  if (cues.strokeCount === 0 && !cues.hasAxes && !cues.hasGridCells && (cues.nodeBoxCount ?? 0) === 0) {
    scores.photo += 1;
    reasons.push('cue=raster-no-strokes');
  }
}

function scoreTextCues(
  region: VisualRegionInput,
  scores: Record<VisualRegionKind, number>,
  reasons: string[],
): void {
  const labelTexts = (region.labels ?? []).map(labelTextOf);
  for (const label of region.labels ?? []) {
    if (typeof label === 'string') continue;
    if (label.role === 'axis-label' || label.role === 'tick' || label.role === 'legend' || label.role === 'data-label') {
      scores.chart += 1.25;
      if (!reasons.includes(`label-role=${label.role}`)) reasons.push(`label-role=${label.role}`);
    } else if (label.role === 'dimension') {
      scores['technical-drawing'] += 1.5;
      if (!reasons.includes('label-role=dimension')) reasons.push('label-role=dimension');
    } else if (label.role === 'header' || label.role === 'cell') {
      scores['table-image'] += 1.25;
      if (!reasons.includes(`label-role=${label.role}`)) reasons.push(`label-role=${label.role}`);
    } else if (label.role === 'node' || label.role === 'edge') {
      scores.diagram += 1;
      scores.flowchart += 0.75;
      if (!reasons.includes(`label-role=${label.role}`)) reasons.push(`label-role=${label.role}`);
    }
  }

  const text = [
    textOf(region.caption),
    textOf(region.nearbyText),
    textOf(region.ocrText),
    ...labelTexts,
  ]
    .filter(s => s.length > 0)
    .join(' ');

  if (text.length === 0) return;

  if (CHART_PATTERN.test(text)) {
    scores.chart += 2.5;
    reasons.push('text=chart');
  }
  if (FLOWCHART_PATTERN.test(text)) {
    scores.flowchart += 3.5;
    reasons.push('text=flowchart');
  }
  if (TECHNICAL_PATTERN.test(text)) {
    scores['technical-drawing'] += 3.5;
    reasons.push('text=technical');
  }
  if (TECHNICAL_SYMBOL_PATTERN.test(labelTexts.join(' '))) {
    scores['technical-drawing'] += 2;
    reasons.push('label=technical-symbol');
  }
  if (TABLE_IMAGE_PATTERN.test(text)) {
    scores['table-image'] += 2.5;
    reasons.push('text=table');
  }
  if (DIAGRAM_PATTERN.test(text)) {
    scores.diagram += 2;
    reasons.push('text=diagram');
  }
  if (PHOTO_PATTERN.test(text)) {
    scores.photo += 3;
    reasons.push('text=photo');
  }
}

// --- Caption Binding Helpers ------------------------------------------------

function fallbackCaptionBinding(region: VisualRegionInput): VisualCaptionBinding {
  return {
    sourceImageId: region.imageId,
    sourceBlockId: nonEmptyText(region.sourceBlockId) ?? null,
    captionBlockId: nonEmptyText(region.captionBlockId) ?? null,
    captionText: nonEmptyText(region.caption) ?? null,
    confidence: null,
    reason: null,
  };
}

/**
 * Mirrors `captions.ts`'s deterministic `p{page}-r{order}` derivation so blocks passed
 * without explicit IDs still resolve back to their text after `linkCaptions`.
 */
function resolveBlockIds(blocks: readonly CaptionInputBlock[]): string[] {
  const indexed = blocks.map((block, index) => ({ block, index }));
  indexed.sort((left, right) => {
    const leftPage = pageOf(left.block.page);
    const rightPage = pageOf(right.block.page);
    if (leftPage !== rightPage) return leftPage - rightPage;
    const leftRow = Math.round(finiteOr(left.block.rect?.y, 0) * 2) / 2;
    const rightRow = Math.round(finiteOr(right.block.rect?.y, 0) * 2) / 2;
    if (leftRow !== rightRow) return leftRow - rightRow;
    const leftX = finiteOr(left.block.rect?.x, 0);
    const rightX = finiteOr(right.block.rect?.x, 0);
    if (leftX !== rightX) return leftX - rightX;
    const leftId = typeof left.block.id === 'string' ? left.block.id : '';
    const rightId = typeof right.block.id === 'string' ? right.block.id : '';
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
    return left.index - right.index;
  });

  const result = new Array<string>(blocks.length);
  const rankByPage = new Map<number, number>();
  for (const item of indexed) {
    const page = pageOf(item.block.page);
    const order = rankByPage.get(page) ?? 0;
    rankByPage.set(page, order + 1);
    const explicit = typeof item.block.id === 'string' && item.block.id.length > 0 ? item.block.id : undefined;
    result[item.index] = explicit ?? `p${page}-r${order}`;
  }
  return result;
}

function findMatchingCandidateBlockId(
  region: VisualRegionInput,
  blocks: readonly CaptionInputBlock[],
  resolvedIds: readonly string[],
  claimedIds: ReadonlySet<string>,
): string | null {
  const regionPage = pageOf(region.page);
  const regionRect = sanitizeRect(region.bbox);
  const targetRef = nonEmptyText(region.sourceBlockId) ?? region.imageId;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const id = resolvedIds[i];
    if (block === undefined || id === undefined || claimedIds.has(id)) continue;
    if (block.type !== 'figure' && block.type !== 'table') continue;
    if (id === targetRef) return id;
  }

  let bestId: string | null = null;
  let bestIou = 0.5;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const id = resolvedIds[i];
    if (block === undefined || id === undefined || claimedIds.has(id)) continue;
    if (block.type !== 'figure' && block.type !== 'table') continue;
    if (pageOf(block.page) !== regionPage) continue;
    const iou = rectIou(regionRect, sanitizeRect(block.rect));
    if (iou >= bestIou) {
      bestIou = iou;
      bestId = id;
    }
  }
  return bestId;
}

function rectIou(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (inter <= 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

// --- Grounding & Normalization Helpers --------------------------------------

function collectFigureNumbers(evidence: VisualFigureEvidence): number[] {
  const values: number[] = [];

  for (const rawLabel of evidence.labels ?? []) {
    if (typeof rawLabel !== 'string' && rawLabel.illegible === true) continue;
    const text = labelTextOf(rawLabel);
    if (text.length === 0 || ILLEGIBLE_TOKEN_PATTERN.test(text)) continue;
    for (const found of extractNumbersFromText(text)) {
      values.push(found.value);
    }
  }

  for (const axis of evidence.axes ?? []) {
    for (const tick of axis.ticks ?? []) {
      if (typeof tick === 'number') {
        if (Number.isFinite(tick)) values.push(normalizeZero(tick));
        continue;
      }
      for (const found of extractNumbersFromText(String(tick))) {
        values.push(found.value);
      }
    }
  }

  if (typeof evidence.ocrText === 'string' && evidence.ocrText.trim().length > 0) {
    for (const found of extractNumbersFromText(evidence.ocrText)) {
      values.push(found.value);
    }
  }

  return uniqueNumbers(values);
}

function checkProseNumericClaims(
  text: string | undefined,
  source: 'description' | 'trend',
  figureNumberSet: ReadonlySet<number>,
  verifiedOut: VerifiedNumericClaim[],
  rejectedOut: RejectedNumericClaim[],
): void {
  if (typeof text !== 'string' || text.trim().length === 0) return;
  const scrubbed = stripNonDataProseNumbers(text);
  for (const token of extractNumbersFromText(scrubbed)) {
    if (hasGroundedNumber(figureNumberSet, token.value)) {
      verifiedOut.push({ value: token.value, raw: token.raw, source });
    } else {
      rejectedOut.push({
        value: token.value,
        raw: token.raw,
        source,
        reason: 'not-in-figure-labels-or-ticks',
      });
    }
  }
}

function stripNonDataProseNumbers(text: string): string {
  return text
    .replace(PROSE_REFERENCE_PATTERN, ' ')
    .replace(ORDINAL_TOKEN_PATTERN, ' ')
    .replace(DIMENSION_TAG_PATTERN, ' ')
    .replace(COMPOUND_MODIFIER_PATTERN, ' ');
}

function extractNumbersFromText(text: string): { raw: string; value: number }[] {
  const out: { raw: string; value: number }[] = [];
  for (const match of text.matchAll(NUMBER_TOKEN_PATTERN)) {
    const raw = match[0];
    const value = normalizeNumberToken(raw);
    if (value !== null) out.push({ raw, value });
  }
  return out;
}

function normalizeNumberToken(token: string): number | null {
  let text = token.trim().replace(/^[−–]/u, '-').replace(/%$/u, '');
  text = text.replace(/[\u00A0\u202F\u2009]/gu, '');
  text = text.replace(/(?<=\d),(?=\d{3}(?!\d))/gu, '');
  text = text.replace(/,/gu, '.');
  if (text.length === 0) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? normalizeZero(parsed) : null;
}

function parseSeriesPointNumber(y: number | string | null): number | null {
  if (y === null) return null;
  if (typeof y === 'number') return Number.isFinite(y) ? normalizeZero(y) : null;
  const trimmed = y.trim();
  if (trimmed.length === 0 || isAbsenceToken(trimmed)) return null;
  return normalizeNumberToken(trimmed);
}

function hasGroundedNumber(set: ReadonlySet<number>, candidate: number): boolean {
  if (set.has(candidate)) return true;
  for (const known of set) {
    if (Math.abs(known - candidate) <= FLOAT_EPSILON) return true;
  }
  return false;
}

function sanitizeSeriesWithGrounding(
  seriesInput: readonly ChartSeriesInput[],
  grounding: VisualGroundingReport,
  unreadableFieldsOut: string[],
): ChartSeries[] {
  const verifiedSet = new Set(grounding.verifiedNumbers);
  return seriesInput.map((series, index) => {
    const id = nonEmptyText(series.id) ?? `series-${index + 1}`;
    const name = series.name.trim();
    const points: ChartPoint[] = series.points.map(point => {
      if (
        point.illegible === true ||
        point.y === null ||
        (typeof point.y === 'string' && isAbsenceToken(point.y.trim()))
      ) {
        unreadableFieldsOut.push(`series:${name}:${String(point.x)}`);
        return {
          x: point.x,
          y: null,
          ...(point.label !== undefined ? { label: point.label } : {}),
          illegible: true,
          grounded: false,
        };
      }

      const parsed = parseSeriesPointNumber(point.y);
      if (parsed === null) {
        unreadableFieldsOut.push(`series:${name}:${String(point.x)}`);
        return {
          x: point.x,
          y: null,
          ...(point.label !== undefined ? { label: point.label } : {}),
          illegible: true,
          grounded: false,
        };
      }

      const isGrounded = hasGroundedNumber(verifiedSet, parsed);
      return {
        x: point.x,
        y: isGrounded ? parsed : null,
        ...(point.label !== undefined ? { label: point.label } : {}),
        illegible: false,
        grounded: isGrounded,
      };
    });

    return {
      id,
      name,
      unit: typeof series.unit === 'string' ? series.unit.trim() : '',
      ...(nonEmptyText(series.axisId) !== undefined ? { axisId: series.axisId } : {}),
      points,
      trend: typeof series.trend === 'string' ? series.trend.trim() : '',
    };
  });
}

function filterGroundedNumbers(
  numbers: readonly VisionNumber[],
  grounding: VisualGroundingReport,
): VisionNumber[] {
  const verifiedSet = new Set(grounding.verifiedNumbers);
  return numbers.filter(entry => Number.isFinite(entry.value) && hasGroundedNumber(verifiedSet, normalizeZero(entry.value)));
}

function normalizeLabels(inputs: readonly (VisualLabel | string)[]): VisualLabel[] {
  const out: VisualLabel[] = [];
  for (const item of inputs) {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text.length === 0) continue;
      out.push({ text, illegible: ILLEGIBLE_TOKEN_PATTERN.test(text) });
      continue;
    }
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text.length === 0) continue;
    const illegible = item.illegible === true || ILLEGIBLE_TOKEN_PATTERN.test(text);
    out.push({
      ...(nonEmptyText(item.id) !== undefined ? { id: item.id } : {}),
      text,
      ...(item.role !== undefined ? { role: item.role } : {}),
      ...(item.bbox !== undefined ? { bbox: sanitizeRect(item.bbox) } : {}),
      ...(isFiniteNumber(item.confidence) ? { confidence: item.confidence } : {}),
      illegible,
    });
  }
  return out;
}

function normalizeAxes(inputs: readonly ChartAxisInput[]): ChartAxis[] {
  return inputs.map((axis, index) => {
    const ticks = Array.isArray(axis.ticks) ? [...axis.ticks] : [];
    const numericTicks: number[] = [];
    for (const tick of ticks) {
      if (typeof tick === 'number' && Number.isFinite(tick)) {
        numericTicks.push(normalizeZero(tick));
      } else if (typeof tick === 'string') {
        const parsed = normalizeNumberToken(tick);
        if (parsed !== null && /^-?[\d.,\s]+%?$/u.test(tick.trim())) numericTicks.push(parsed);
      }
    }

    const min = numericTicks.length > 0 ? Math.min(...numericTicks) : null;
    const max = numericTicks.length > 0 ? Math.max(...numericTicks) : null;
    const scale: AxisScale =
      axis.scale ?? (numericTicks.length > 0 && numericTicks.length === ticks.length ? 'linear' : ticks.length > 0 ? 'categorical' : 'unknown');

    return {
      id: nonEmptyText(axis.id) ?? `${axis.orientation}-${index + 1}`,
      orientation: axis.orientation,
      label: typeof axis.label === 'string' ? axis.label.trim() : '',
      unit: typeof axis.unit === 'string' ? axis.unit.trim() : '',
      scale,
      ticks,
      range: { min, max },
    };
  });
}

function mergeLabelInputs(
  regionLabels: readonly (VisualLabel | string)[] | undefined,
  responseLabels: readonly (VisualLabel | string)[] | undefined,
): readonly (VisualLabel | string)[] {
  const merged: (VisualLabel | string)[] = [];
  const seen = new Set<string>();
  for (const source of [regionLabels ?? [], responseLabels ?? []]) {
    for (const entry of source) {
      const key = labelTextOf(entry);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

function mergeAxisInputs(
  regionAxes: readonly ChartAxisInput[] | undefined,
  responseAxes: readonly ChartAxisInput[] | undefined,
): readonly ChartAxisInput[] {
  const primary = regionAxes ?? [];
  const secondary = responseAxes ?? [];
  if (primary.length === 0) return secondary;
  if (secondary.length === 0) return primary;

  const seen = new Set(primary.map(axis => axis.id ?? axis.orientation));
  const merged = [...primary];
  for (const axis of secondary) {
    const key = axis.id ?? axis.orientation;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(axis);
    }
  }
  return merged;
}

function deriveUnits(
  explicitUnits: string,
  axes: readonly ChartAxis[],
  series: readonly ChartSeries[],
): string {
  if (explicitUnits.length > 0) return explicitUnits;
  const seen = new Set<string>();
  const units: string[] = [];
  for (const axis of axes) {
    if (axis.unit.length > 0 && !seen.has(axis.unit)) {
      seen.add(axis.unit);
      units.push(axis.unit);
    }
  }
  for (const entry of series) {
    if (entry.unit.length > 0 && !seen.has(entry.unit)) {
      seen.add(entry.unit);
      units.push(entry.unit);
    }
  }
  return units.join(', ');
}

// --- Topology Helpers -------------------------------------------------------

function normalizeNodes(
  inputs: readonly VisualNodeInput[],
  unreadableFieldsOut?: string[],
): VisualNode[] {
  const seen = new Set<string>();
  const nodes: VisualNode[] = [];

  for (const item of Array.isArray(inputs) ? inputs : []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const illegible = item.illegible === true || ILLEGIBLE_TOKEN_PATTERN.test(label);
    if (illegible && unreadableFieldsOut !== undefined) {
      unreadableFieldsOut.push(`node:${id}`);
    }
    nodes.push({
      id,
      label,
      kind: item.kind ?? 'process',
      ...(item.bbox !== undefined ? { bbox: sanitizeRect(item.bbox) } : {}),
      illegible,
    });
  }
  return nodes;
}

function normalizeEdges(inputs: readonly VisualEdgeInput[]): VisualEdge[] {
  const edges: VisualEdge[] = [];
  let index = 0;
  for (const item of Array.isArray(inputs) ? inputs : []) {
    const from = typeof item?.from === 'string' ? item.from.trim() : '';
    const to = typeof item?.to === 'string' ? item.to.trim() : '';
    if (from.length === 0 || to.length === 0) continue;
    index += 1;
    edges.push({
      id: nonEmptyText(item.id) ?? `edge-${index}`,
      from,
      to,
      label: typeof item.label === 'string' ? item.label.trim() : '',
      ...(nonEmptyText(item.condition) !== undefined ? { condition: item.condition } : {}),
      directed: item.directed !== false,
      dashed: item.dashed === true,
    });
  }
  return edges;
}

function detectBackEdges(
  nodes: readonly VisualNode[],
  entryNodeIds: readonly string[],
  connectedIds: ReadonlySet<string>,
  outgoing: ReadonlyMap<string, readonly VisualEdge[]>,
): VisualEdge[] {
  const state = new Map<string, 0 | 1 | 2>();
  const backEdges: VisualEdge[] = [];

  const visit = (startId: string): void => {
    const stack: { id: string; nextIndex: number }[] = [{ id: startId, nextIndex: 0 }];
    state.set(startId, 1);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      const edges = outgoing.get(top.id) ?? [];
      if (top.nextIndex >= edges.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }

      const edge = edges[top.nextIndex];
      top.nextIndex += 1;
      if (edge === undefined) continue;

      const targetState = state.get(edge.to) ?? 0;
      if (targetState === 1) {
        backEdges.push(edge);
      } else if (targetState === 0) {
        state.set(edge.to, 1);
        stack.push({ id: edge.to, nextIndex: 0 });
      }
    }
  };

  for (const id of entryNodeIds) {
    if (connectedIds.has(id) && (state.get(id) ?? 0) === 0) {
      visit(id);
    }
  }
  for (const node of nodes) {
    if (connectedIds.has(node.id) && (state.get(node.id) ?? 0) === 0) {
      visit(node.id);
    }
  }
  return backEdges;
}

function topologicalOrder(
  nodes: readonly VisualNode[],
  connectedIds: ReadonlySet<string>,
  validEdges: readonly VisualEdge[],
  backEdgeSet: ReadonlySet<VisualEdge>,
): string[] {
  const dagInDegree = new Map<string, number>();
  const dagOut = new Map<string, string[]>();
  const nodeRank = new Map<string, number>();

  let rank = 0;
  for (const node of nodes) {
    if (!connectedIds.has(node.id)) continue;
    dagInDegree.set(node.id, 0);
    dagOut.set(node.id, []);
    nodeRank.set(node.id, rank);
    rank += 1;
  }

  for (const edge of validEdges) {
    if (backEdgeSet.has(edge)) continue;
    dagOut.get(edge.from)?.push(edge.to);
    dagInDegree.set(edge.to, (dagInDegree.get(edge.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const node of nodes) {
    if (connectedIds.has(node.id) && (dagInDegree.get(node.id) ?? 0) === 0) {
      queue.push(node.id);
    }
  }

  const ordered: string[] = [];
  while (queue.length > 0) {
    queue.sort((a, b) => (nodeRank.get(a) ?? 0) - (nodeRank.get(b) ?? 0));
    const current = queue.shift();
    if (current === undefined) break;
    ordered.push(current);

    for (const next of dagOut.get(current) ?? []) {
      const nextDegree = (dagInDegree.get(next) ?? 0) - 1;
      dagInDegree.set(next, nextDegree);
      if (nextDegree === 0) queue.push(next);
    }
  }

  return ordered;
}

// --- Primitive Helpers ------------------------------------------------------

function assertRegionObject(region: unknown, caller: string): asserts region is VisualRegionInput {
  if (region === null || typeof region !== 'object') {
    throw new TypeError(`${caller} requires a VisualRegionInput object.`);
  }
}

function isVisualRegionKind(value: unknown): value is VisualRegionKind {
  return typeof value === 'string' && (VISUAL_REGION_KINDS as readonly string[]).includes(value);
}

function isPositiveRect(rect: Rect | undefined): boolean {
  if (rect === undefined || rect === null || typeof rect !== 'object') return false;
  return (
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function sanitizeRect(rect: Rect | undefined): Rect {
  return {
    x: finiteOr(rect?.x, 0),
    y: finiteOr(rect?.y, 0),
    width: Math.max(0, finiteOr(rect?.width, 0)),
    height: Math.max(0, finiteOr(rect?.height, 0)),
  };
}

function pageOf(page: unknown): number {
  return typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : 1;
}

function labelTextOf(label: VisualLabel | string): string {
  return typeof label === 'string' ? label.trim() : typeof label?.text === 'string' ? label.text.trim() : '';
}

function isAbsenceToken(value: string): boolean {
  return value.length > 0 && ABSENCE_WORD_PATTERN.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

function positiveOrNull(value: unknown): number | null {
  return isFiniteNumber(value) && value > 0 ? value : null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function uniqueNumbers(values: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const value of values) {
    const normalized = normalizeZero(value);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}
