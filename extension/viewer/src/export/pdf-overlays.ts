/**
 * PDF overlay composer (backlog item H05).
 *
 * Inserts text boxes, bordered callouts (with optional leader lines), PNG/JPEG images, vector
 * shapes (`rect`, `ellipse`, `line`, `arrow`), and rotated translucent watermarks onto either an
 * existing PDF (`pdfBytes`) or freshly sized pages (`pages`), preserving exact reader-to-PDF
 * coordinates.
 *
 * Coordinate contract:
 * - Inputs live in reader space: origin at the page's top-left corner, `x` growing right, `y`
 *   growing down, in PDF points (72 dpi). Rotation angles (`rotation` / `angle`) are clockwise
 *   degrees in reader space, matching `PdfBlockSource.rotation` in `src/export/pdf.ts`.
 * - Outputs live in PDF user space: origin at the page's bottom-left corner, `x` growing right,
 *   `y` growing up, in points, with counter-clockwise PDF rotation `-rotation`.
 * - Rotated boxes (`textbox`, `callout`, `image`, `rect`) pivot around the box center so borders,
 *   fills, and wrapped text lines stay rigidly aligned together.
 *
 * Two layers, matching `src/export/pdf.ts` and `src/export/monolingual-pdf.ts`:
 * - `planPdfOverlays` (plus `readerPointToPdfPoint`, `readerRectToPdfRect`, `computeArrowGeometry`)
 *   is pure and synchronous: validates pages/dimensions/bounds, converts coordinates, wraps text,
 *   and computes arrow/callout/watermark geometry without touching `pdf-lib` or the DOM.
 * - `composePdfOverlays` embeds Noto Sans Unicode once per document via `src/export/fonts.ts`
 *   (falling back cleanly to WinAnsi with `FONT_LIMITATION` if unavailable), creates or loads the
 *   PDF document, draws all overlays with proper `ExtGState` opacity, and returns the serialized
 *   bytes alongside the computed plan and diagnostics.
 */

import {
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  PDFName,
  type PDFImage,
  type PDFPage,
  closePath,
  degrees,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setDashPattern,
  setFillingRgbColor,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
} from 'pdf-lib';
import type { Rect } from '../core/types';
import {
  BUNDLED_FONT_NAME,
  FALLBACK_FACE_NAME,
  foldToWinAnsi,
  registerPdfFonts,
  type PdfFontsOptions,
  type PreparedText,
} from './fonts';
import {
  BIDI_LIMITATION,
  DEFAULT_BASELINE_RATIO,
  DEFAULT_INK,
  DEFAULT_MEASURE_RATIO,
  DEFAULT_MINIMUM_FONT_SIZE,
  FONT_LIMITATION,
  PdfExportError,
  UNICODE_GAP_LIMITATION,
  type Measure,
  type SkipReason,
  type TextRun,
} from './pdf';

export { PdfExportError };

export interface OverlayPoint {
  x: number;
  y: number;
}

export interface OverlayPageSize {
  /** 1-based page number; defaults to the page's 1-based index in `pages`. */
  number?: number;
  width: number;
  height: number;
}

export type OverlayTextAlign = 'left' | 'center' | 'right';
export type OverlayLineCap = 'butt' | 'round' | 'square';
export type ArrowHeadStyle = 'filled' | 'open';
export type WatermarkLayer = 'over' | 'under';

export type PdfOverlayKind =
  | 'textbox'
  | 'callout'
  | 'image'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'watermark';

interface OverlayBase {
  id?: string;
  /** 1-based target page number. */
  page: number;
}

export interface TextBoxOverlay extends OverlayBase {
  kind: 'textbox';
  /** Box rect in reader space (origin top-left, y growing down, points). */
  rect: Rect;
  text: string;
  fontSize?: number;
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  padding?: number;
  align?: OverlayTextAlign;
  lineHeight?: number;
  opacity?: number;
  /** Clockwise rotation in degrees in reader space (pivoted around rect center). */
  rotation?: number;
  /** Shrink down to `minimumFontSize` when text overflows `rect.height`. Default false. */
  autoFit?: boolean;
  minimumFontSize?: number;
  direction?: 'ltr' | 'rtl';
}

export interface CalloutOverlay extends OverlayBase {
  kind: 'callout';
  /** Callout box rect in reader space (origin top-left, y growing down, points). */
  rect: Rect;
  text: string;
  fontSize?: number;
  color?: string;
  backgroundColor?: string | null;
  borderColor?: string;
  borderWidth?: number;
  padding?: number;
  align?: OverlayTextAlign;
  lineHeight?: number;
  opacity?: number;
  /** Clockwise rotation in degrees in reader space (pivoted around rect center). */
  rotation?: number;
  /** Optional leader line target point in reader space (origin top-left, y down). */
  pointer?: OverlayPoint;
  /** Optional intermediate elbow point in reader space for the leader line. */
  knee?: OverlayPoint;
  pointerWidth?: number;
  pointerColor?: string;
  pointerArrow?: boolean;
  autoFit?: boolean;
  minimumFontSize?: number;
  direction?: 'ltr' | 'rtl';
}

export interface ImageOverlay extends OverlayBase {
  kind: 'image';
  /** Placement rect in reader space (origin top-left, y growing down, points). */
  rect: Rect;
  format: 'png' | 'jpeg';
  bytes: Uint8Array;
  opacity?: number;
  /** Clockwise rotation in degrees in reader space (pivoted around rect center). */
  rotation?: number;
}

export interface RectShapeOverlay extends OverlayBase {
  kind: 'rect';
  rect: Rect;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  dashArray?: readonly number[];
  lineCap?: OverlayLineCap;
  opacity?: number;
  strokeOpacity?: number;
  /** Clockwise rotation in degrees in reader space (pivoted around rect center). */
  rotation?: number;
}

export interface EllipseShapeOverlay extends OverlayBase {
  kind: 'ellipse';
  /** Bounding rect of the ellipse in reader space. */
  rect: Rect;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  dashArray?: readonly number[];
  lineCap?: OverlayLineCap;
  opacity?: number;
  strokeOpacity?: number;
  /** Clockwise rotation in degrees in reader space (pivoted around ellipse center). */
  rotation?: number;
}

export interface LineShapeOverlay extends OverlayBase {
  kind: 'line';
  start: OverlayPoint;
  end: OverlayPoint;
  strokeColor?: string;
  strokeWidth?: number;
  dashArray?: readonly number[];
  lineCap?: OverlayLineCap;
  opacity?: number;
}

export interface ArrowShapeOverlay extends OverlayBase {
  kind: 'arrow';
  start: OverlayPoint;
  end: OverlayPoint;
  strokeColor?: string;
  strokeWidth?: number;
  dashArray?: readonly number[];
  lineCap?: OverlayLineCap;
  opacity?: number;
  /** Length of each arrowhead barb in points. */
  headLength?: number;
  /** Half-angle between shaft and each arrowhead barb in degrees (0..90). */
  headAngle?: number;
  /** `'filled'` (default) draws a closed triangle head; `'open'` draws two V-barbs. */
  headStyle?: ArrowHeadStyle;
}

export interface WatermarkOverlay extends OverlayBase {
  kind: 'watermark';
  text: string;
  /** Optional bounding box in reader space; centers watermark on this box when `center` is omitted. */
  rect?: Rect;
  /** Optional explicit center in reader space; defaults to the page center. */
  center?: OverlayPoint;
  fontSize?: number;
  color?: string;
  /** Opacity in `[0, 1]`. Default `DEFAULT_WATERMARK_OPACITY` (`0.25`). */
  opacity?: number;
  /** Clockwise angle in degrees in reader space. Default `-45` (diagonal bottom-left to top-right). */
  angle?: number;
  lineHeight?: number;
  layer?: WatermarkLayer;
}

export type PdfOverlay =
  | TextBoxOverlay
  | CalloutOverlay
  | ImageOverlay
  | RectShapeOverlay
  | EllipseShapeOverlay
  | LineShapeOverlay
  | ArrowShapeOverlay
  | WatermarkOverlay;

export interface ArrowGeometry {
  start: OverlayPoint;
  end: OverlayPoint;
  shaftEnd: OverlayPoint;
  tip: OverlayPoint;
  leftWing: OverlayPoint;
  rightWing: OverlayPoint;
  headLength: number;
  headAngle: number;
  headStyle: ArrowHeadStyle;
}

export interface PlannedTextBoxOverlay {
  id: string;
  kind: 'textbox';
  page: number;
  pdfRect: Rect;
  origin: OverlayPoint;
  center: OverlayPoint;
  rotation: number;
  pdfRotation: number;
  runs: TextRun[];
  fontSize: number;
  lineHeight: number;
  opacity: number;
  color: string;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth: number;
  truncated: boolean;
  folded: boolean;
  dropped: number;
  direction: 'ltr' | 'rtl';
}

export interface PlannedCalloutPointer {
  start: OverlayPoint;
  knee?: OverlayPoint;
  end: OverlayPoint;
  width: number;
  color: string;
  arrowHead?: ArrowGeometry;
}

export interface PlannedCalloutOverlay {
  id: string;
  kind: 'callout';
  page: number;
  pdfRect: Rect;
  origin: OverlayPoint;
  center: OverlayPoint;
  rotation: number;
  pdfRotation: number;
  runs: TextRun[];
  fontSize: number;
  lineHeight: number;
  opacity: number;
  color: string;
  backgroundColor?: string;
  borderColor: string;
  borderWidth: number;
  pointer?: PlannedCalloutPointer;
  truncated: boolean;
  folded: boolean;
  dropped: number;
  direction: 'ltr' | 'rtl';
}

export interface PlannedImageOverlay {
  id: string;
  kind: 'image';
  page: number;
  pdfRect: Rect;
  origin: OverlayPoint;
  center: OverlayPoint;
  format: 'png' | 'jpeg';
  bytes: Uint8Array;
  opacity: number;
  rotation: number;
  pdfRotation: number;
}

export interface PlannedRectOverlay {
  id: string;
  kind: 'rect';
  page: number;
  pdfRect: Rect;
  origin: OverlayPoint;
  center: OverlayPoint;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth: number;
  dashArray?: number[];
  lineCap: OverlayLineCap;
  opacity: number;
  strokeOpacity: number;
  rotation: number;
  pdfRotation: number;
}

export interface PlannedEllipseOverlay {
  id: string;
  kind: 'ellipse';
  page: number;
  center: OverlayPoint;
  xScale: number;
  yScale: number;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth: number;
  dashArray?: number[];
  lineCap: OverlayLineCap;
  opacity: number;
  strokeOpacity: number;
  rotation: number;
  pdfRotation: number;
}

export interface PlannedLineOverlay {
  id: string;
  kind: 'line';
  page: number;
  start: OverlayPoint;
  end: OverlayPoint;
  strokeColor: string;
  strokeWidth: number;
  dashArray?: number[];
  lineCap: OverlayLineCap;
  opacity: number;
}

export interface PlannedArrowOverlay extends ArrowGeometry {
  id: string;
  kind: 'arrow';
  page: number;
  strokeColor: string;
  strokeWidth: number;
  dashArray?: number[];
  lineCap: OverlayLineCap;
  opacity: number;
}

export interface PlannedWatermarkOverlay {
  id: string;
  kind: 'watermark';
  page: number;
  center: OverlayPoint;
  runs: TextRun[];
  fontSize: number;
  lineHeight: number;
  angle: number;
  pdfRotation: number;
  opacity: number;
  color: string;
  layer: WatermarkLayer;
  folded: boolean;
  dropped: number;
}

export type PlannedOverlay =
  | PlannedTextBoxOverlay
  | PlannedCalloutOverlay
  | PlannedImageOverlay
  | PlannedRectOverlay
  | PlannedEllipseOverlay
  | PlannedLineOverlay
  | PlannedArrowOverlay
  | PlannedWatermarkOverlay;

export interface SkippedOverlay {
  id: string;
  page: number;
  kind: PdfOverlayKind;
  reason: SkipReason;
}

export interface PlannedOverlayPage {
  number: number;
  width: number;
  height: number;
  overlays: PlannedOverlay[];
  skipped: SkippedOverlay[];
}

export interface PdfOverlayPlan {
  pages: PlannedOverlayPage[];
  pageCount: number;
  overlayCount: number;
  appliedCount: number;
  countsByKind: Record<PdfOverlayKind, number>;
  skipped: SkippedOverlay[];
  limitations: string[];
  fontName: string;
}

export interface PlanPdfOverlaysOptions {
  measure?: Measure;
  minimumFontSize?: number;
  baselineRatio?: number;
  prepare?: (text: string) => PreparedText;
  unicode?: boolean;
  fontName?: string;
}

export interface ComposePdfOverlaysInput {
  /** Existing PDF bytes to annotate/overlay. When omitted, `pages` creates fresh pages. */
  pdfBytes?: Uint8Array;
  /** Page specifications used when `pdfBytes` is omitted. */
  pages?: readonly OverlayPageSize[];
  overlays: readonly PdfOverlay[];
  fonts?: PdfFontsOptions;
  measure?: Measure;
  minimumFontSize?: number;
  baselineRatio?: number;
  title?: string;
  producer?: string;
  creator?: string;
}

export interface ComposePdfOverlaysResult {
  bytes: Uint8Array;
  pageCount: number;
  overlayCount: number;
  appliedCount: number;
  countsByKind: Record<PdfOverlayKind, number>;
  plan: PdfOverlayPlan;
  skipped: SkippedOverlay[];
  limitations: string[];
  fontName: string;
}

export const DEFAULT_OVERLAY_FONT_SIZE = 12;
export const DEFAULT_OVERLAY_LINE_HEIGHT = 1.2;
export const DEFAULT_TEXTBOX_PADDING = 0;
export const DEFAULT_CALLOUT_PADDING = 6;
export const DEFAULT_CALLOUT_BG = '#fffbeb';
export const DEFAULT_CALLOUT_BORDER = '#d97706';
export const DEFAULT_CALLOUT_BORDER_WIDTH = 1.5;
export const DEFAULT_STROKE_WIDTH = 1;
export const DEFAULT_ARROW_HEAD_LENGTH = 10;
export const DEFAULT_ARROW_HEAD_ANGLE = 30;
export const DEFAULT_WATERMARK_FONT_SIZE = 48;
export const DEFAULT_WATERMARK_OPACITY = 0.25;
export const DEFAULT_WATERMARK_ANGLE = -45;
export const DEFAULT_WATERMARK_COLOR = '#64748b';
export const DEFAULT_OVERLAY_PRODUCER = 'Mirror PDF overlay composer';
export const DEFAULT_OVERLAY_CREATOR = 'Mirror';
export const EMPTY_OVERLAY_DOCUMENT_MESSAGE =
  'PDF overlay export needs either source PDF bytes or at least one page.';

const COORDINATE_PRECISION = 10_000;
const EPSILON = 0.01;

const defaultMeasure: Measure = (text, size) => text.length * size * DEFAULT_MEASURE_RATIO;

function round(value: number): number {
  return Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new PdfExportError(`PDF overlay ${label} must be a finite number.`);
  }
  return value;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PdfExportError(`PDF overlay ${label} must be a positive finite number.`);
  }
  return value;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new PdfExportError(`PDF overlay ${label} must be a non-negative finite number.`);
  }
  return value;
}

function unitInterval(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new PdfExportError(`PDF overlay ${label} must be between 0 and 1.`);
  }
  return value;
}

function normalizeHexColor(color: string | null | undefined, fallback: string): string {
  const raw = typeof color === 'string' ? color.trim().replace(/^#/, '') : '';
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw
      .split('')
      .map(ch => `${ch}${ch}`)
      .join('')
      .toLowerCase()}`;
  }
  return fallback;
}

function parseRgb(hexColor: string, fallback: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(hexColor, fallback).slice(1);
  const value = Number.parseInt(normalized, 16);
  return {
    r: ((value >> 16) & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: (value & 0xff) / 255,
  };
}

function assertFinitePoint(point: OverlayPoint | null | undefined, label: string): OverlayPoint {
  if (!point || typeof point !== 'object') {
    throw new PdfExportError(`PDF overlay ${label} point is required.`);
  }
  return {
    x: finite(point.x, `${label}.x`),
    y: finite(point.y, `${label}.y`),
  };
}

function assertPositiveRect(rect: Rect | null | undefined, label: string): Rect {
  if (!rect || typeof rect !== 'object') {
    throw new PdfExportError(`PDF overlay ${label} rect is required.`);
  }
  return {
    x: finite(rect.x, `${label}.x`),
    y: finite(rect.y, `${label}.y`),
    width: positive(rect.width, `${label}.width`),
    height: positive(rect.height, `${label}.height`),
  };
}

function normalizeDashArray(
  dashArray: readonly number[] | undefined,
  label: string,
): number[] | undefined {
  if (dashArray === undefined) return undefined;
  if (!Array.isArray(dashArray)) {
    throw new PdfExportError(`PDF overlay ${label} dashArray must be an array.`);
  }
  const clean = dashArray.map((item, idx) => nonNegative(item, `${label}.dashArray[${idx}]`));
  return clean.length > 0 ? clean : undefined;
}

/**
 * Converts a reader-space point (origin top-left, y down, in points) into PDF user-space
 * coordinates (origin bottom-left, y up, in points).
 */
export function readerPointToPdfPoint(point: OverlayPoint, pageHeight: number): OverlayPoint {
  const height = positive(pageHeight, 'page height');
  const validated = assertFinitePoint(point, 'point');
  return {
    x: round(validated.x),
    y: round(height - validated.y),
  };
}

/**
 * Converts a reader-space rectangle (origin top-left, y down, in points) into a PDF user-space
 * rectangle (origin bottom-left, y up, in points).
 */
export function readerRectToPdfRect(rect: Rect, pageHeight: number): Rect {
  const height = positive(pageHeight, 'page height');
  const validated = assertPositiveRect(rect, 'rect');
  return {
    x: round(validated.x),
    y: round(height - validated.y - validated.height),
    width: round(validated.width),
    height: round(validated.height),
  };
}

function rotateLocalPoint(
  lx: number,
  ly: number,
  center: OverlayPoint,
  thetaRad: number,
): OverlayPoint {
  if (thetaRad === 0) {
    return { x: round(center.x + lx), y: round(center.y + ly) };
  }
  const cos = Math.cos(thetaRad);
  const sin = Math.sin(thetaRad);
  return {
    x: round(center.x + lx * cos - ly * sin),
    y: round(center.y + lx * sin + ly * cos),
  };
}

interface RotatedBoxPlacement {
  pdfRect: Rect;
  center: OverlayPoint;
  origin: OverlayPoint;
  rotation: number;
  pdfRotation: number;
  thetaRad: number;
}

function planRotatedBox(rect: Rect, pageHeight: number, rotationDeg: number): RotatedBoxPlacement {
  const pdfRect = readerRectToPdfRect(rect, pageHeight);
  const center: OverlayPoint = {
    x: round(pdfRect.x + pdfRect.width / 2),
    y: round(pdfRect.y + pdfRect.height / 2),
  };
  const pdfRotation = rotationDeg === 0 ? 0 : round(-rotationDeg);
  const thetaRad = (pdfRotation * Math.PI) / 180;
  const origin =
    pdfRotation === 0
      ? { x: pdfRect.x, y: pdfRect.y }
      : rotateLocalPoint(-pdfRect.width / 2, -pdfRect.height / 2, center, thetaRad);
  return {
    pdfRect,
    center,
    origin,
    rotation: round(rotationDeg),
    pdfRotation,
    thetaRad,
  };
}

/**
 * Computes PDF-space arrowhead and shaft coordinates from PDF-space `start` and `end` points.
 * Rejects coincident endpoints or invalid head geometry with `PdfExportError`.
 */
export function computeArrowGeometry(
  start: OverlayPoint,
  end: OverlayPoint,
  options: {
    headLength?: number;
    headAngle?: number;
    headStyle?: ArrowHeadStyle;
  } = {},
): ArrowGeometry {
  const p0 = assertFinitePoint(start, 'arrow.start');
  const p1 = assertFinitePoint(end, 'arrow.end');
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0) {
    throw new PdfExportError('PDF overlay arrow requires distinct start and end points.');
  }

  const headLength =
    options.headLength !== undefined
      ? positive(options.headLength, 'arrow.headLength')
      : Math.min(DEFAULT_ARROW_HEAD_LENGTH, length * 0.4);
  const headAngle =
    options.headAngle !== undefined
      ? finite(options.headAngle, 'arrow.headAngle')
      : DEFAULT_ARROW_HEAD_ANGLE;
  if (headAngle <= 0 || headAngle >= 90) {
    throw new PdfExportError('PDF overlay arrow.headAngle must be strictly between 0 and 90 degrees.');
  }
  const headStyle: ArrowHeadStyle = options.headStyle ?? 'filled';

  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;

  const alphaRad = (headAngle * Math.PI) / 180;
  const back = headLength * Math.cos(alphaRad);
  const side = headLength * Math.sin(alphaRad);

  const baseX = p1.x - ux * back;
  const baseY = p1.y - uy * back;
  const shaftEnd: OverlayPoint =
    headStyle === 'open'
      ? { x: round(p1.x), y: round(p1.y) }
      : back >= length
        ? { x: round(p0.x), y: round(p0.y) }
        : { x: round(baseX), y: round(baseY) };

  return {
    start: { x: round(p0.x), y: round(p0.y) },
    end: { x: round(p1.x), y: round(p1.y) },
    shaftEnd,
    tip: { x: round(p1.x), y: round(p1.y) },
    leftWing: { x: round(baseX + px * side), y: round(baseY + py * side) },
    rightWing: { x: round(baseX - px * side), y: round(baseY - py * side) },
    headLength: round(headLength),
    headAngle: round(headAngle),
    headStyle,
  };
}

function normalizeBoxText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n');
}

interface PreparedBoxLines {
  normalized: string;
  lines: string[];
  changed: boolean;
  dropped: number;
}

/**
 * Normalizes line breaks before running font-level `prepare` per line so TrueType/WinAnsi glyph
 * filtering never consumes `\n` or `\t` as missing glyphs.
 */
function prepareBoxLines(
  rawText: string,
  prepare: (text: string) => PreparedText,
): PreparedBoxLines {
  const sourceLines = normalizeBoxText(typeof rawText === 'string' ? rawText : '')
    .split('\n')
    .filter(line => line.length > 0);
  if (sourceLines.length === 0) {
    return { normalized: '', lines: [], changed: false, dropped: 0 };
  }
  const lines: string[] = [];
  let changed = false;
  let dropped = 0;
  for (const sourceLine of sourceLines) {
    const prepared = prepare(sourceLine);
    if (prepared.changed) changed = true;
    dropped += prepared.dropped;
    const cleaned = prepared.text.replace(/[ \t]+/g, ' ').trim();
    if (cleaned.length > 0) lines.push(cleaned);
  }
  return {
    normalized: lines.join('\n'),
    lines,
    changed,
    dropped,
  };
}

function wrapLinesAtSize(text: string, width: number, size: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    const tokens = paragraph.match(/\s+|[^\s\u3000-\u9fff]+|[\u3000-\u9fff]/gu) ?? [''];
    for (const token of tokens) {
      if (measure(line + token, size) <= width + EPSILON) {
        line += token;
        continue;
      }
      if (line) {
        lines.push(line.trimEnd());
        line = '';
      }
      const trimmed = token.trimStart();
      if (measure(trimmed, size) <= width + EPSILON) {
        line = trimmed;
      } else {
        for (const ch of Array.from(trimmed)) {
          if (line && measure(line + ch, size) > width + EPSILON) {
            lines.push(line);
            line = '';
          }
          line += ch;
        }
      }
    }
    const finalLine = line.trimEnd();
    if (finalLine.length > 0) lines.push(finalLine);
  }
  return lines;
}

interface FittedBoxText {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  truncated: boolean;
}

function fitOverlayBoxText(
  text: string,
  rect: Rect,
  padding: number,
  preferredFontSize: number,
  lineHeightMultiplier: number,
  baselineRatio: number,
  measure: Measure,
  autoFit: boolean,
  minimumFontSize: number,
): FittedBoxText {
  const innerWidth = rect.width - 2 * padding;
  const floor = autoFit ? Math.min(preferredFontSize, Math.max(1, minimumFontSize)) : preferredFontSize;

  let chosenSize = preferredFontSize;
  let chosenLines = wrapLinesAtSize(text, innerWidth, preferredFontSize, measure);

  if (autoFit) {
    for (let size = preferredFontSize; size >= floor - 1e-6; size -= 0.5) {
      const candidateSize = Math.max(floor, round(size));
      const candidateLines = wrapLinesAtSize(text, innerWidth, candidateSize, measure);
      const lineAdvance = candidateSize * lineHeightMultiplier;
      const lastBaseline =
        padding + Math.max(0, candidateLines.length - 1) * lineAdvance + candidateSize * baselineRatio;
      const fitsWidth = candidateLines.every(line => measure(line, candidateSize) <= innerWidth + EPSILON);
      const fitsHeight = lastBaseline <= rect.height - padding + EPSILON;
      chosenSize = candidateSize;
      chosenLines = candidateLines;
      if (fitsWidth && fitsHeight) break;
      if (candidateSize <= floor) break;
    }
  }

  const lineAdvance = chosenSize * lineHeightMultiplier;
  const maxBaseline = rect.height - padding + EPSILON;
  const kept: string[] = [];
  let truncated = false;

  for (let index = 0; index < chosenLines.length; index++) {
    const line = chosenLines[index]!;
    const baselineOffset = padding + index * lineAdvance + chosenSize * baselineRatio;
    if (baselineOffset > maxBaseline) {
      truncated = true;
      break;
    }
    if (measure(line, chosenSize) > innerWidth + EPSILON) {
      truncated = true;
    }
    kept.push(line);
  }

  return {
    lines: kept,
    fontSize: round(chosenSize),
    lineHeight: round(lineAdvance),
    truncated,
  };
}

function planBoxRuns(
  fit: FittedBoxText,
  rect: Rect,
  placement: RotatedBoxPlacement,
  padding: number,
  baselineRatio: number,
  align: OverlayTextAlign,
  measure: Measure,
): TextRun[] {
  const innerWidth = rect.width - 2 * padding;
  const runs: TextRun[] = [];
  for (let index = 0; index < fit.lines.length; index++) {
    const line = fit.lines[index]!;
    const lineWidth = measure(line, fit.fontSize);
    let localFromLeft = padding;
    if (align === 'center') {
      localFromLeft = padding + Math.max(0, (innerWidth - lineWidth) / 2);
    } else if (align === 'right') {
      localFromLeft = padding + Math.max(0, innerWidth - lineWidth);
    }
    const offsetFromTop = padding + index * fit.lineHeight + fit.fontSize * baselineRatio;
    const lx = -rect.width / 2 + localFromLeft;
    const ly = rect.height / 2 - offsetFromTop;
    const origin = rotateLocalPoint(lx, ly, placement.center, placement.thetaRad);
    runs.push({ text: line, x: origin.x, y: origin.y });
  }
  return runs;
}

/**
 * Anchors a callout leader line cleanly on the perimeter of the (possibly rotated) callout box
 * facing `targetPdf`.
 */
function anchorOnRotatedBoxBoundary(
  placement: RotatedBoxPlacement,
  targetPdf: OverlayPoint,
): OverlayPoint {
  const dxWorld = targetPdf.x - placement.center.x;
  const dyWorld = targetPdf.y - placement.center.y;
  const cos = Math.cos(placement.thetaRad);
  const sin = Math.sin(placement.thetaRad);
  // Inverse rotation to express target in box-local centered coordinates.
  const localDx = dxWorld * cos + dyWorld * sin;
  const localDy = -dxWorld * sin + dyWorld * cos;

  const halfW = placement.pdfRect.width / 2;
  const halfH = placement.pdfRect.height / 2;
  if (Math.abs(localDx) < 1e-6 && Math.abs(localDy) < 1e-6) {
    return rotateLocalPoint(0, -halfH, placement.center, placement.thetaRad);
  }
  const scaleToEdge = 1 / Math.max(Math.abs(localDx) / halfW, Math.abs(localDy) / halfH);
  const clampedScale = Math.min(1, scaleToEdge);
  return rotateLocalPoint(localDx * clampedScale, localDy * clampedScale, placement.center, placement.thetaRad);
}

interface PreparedBoxLayout {
  placement: RotatedBoxPlacement;
  runs: TextRun[];
  fontSize: number;
  lineHeight: number;
  opacity: number;
  color: string;
  truncated: boolean;
  folded: boolean;
  dropped: number;
  direction: 'ltr' | 'rtl';
}

function prepareBoxTextLayout(
  id: string,
  page: number,
  kind: 'textbox' | 'callout',
  rect: Rect,
  pageHeight: number,
  defaultPadding: number,
  params: {
    text: string;
    padding?: number;
    fontSize?: number;
    lineHeight?: number;
    opacity?: number;
    rotation?: number;
    color?: string;
    align?: OverlayTextAlign;
    autoFit?: boolean;
    minimumFontSize?: number;
    direction?: 'ltr' | 'rtl';
  },
  ctx: {
    measure: Measure;
    prepare: (text: string) => PreparedText;
    baselineRatio: number;
    defaultMinFontSize: number;
  },
): { ok: true; layout: PreparedBoxLayout } | { ok: false; skipped: SkippedOverlay; glyphGap: boolean; rtl: boolean } {
  const padding =
    params.padding !== undefined ? nonNegative(params.padding, `${id}.padding`) : defaultPadding;
  if (rect.width - 2 * padding <= 0 || rect.height - 2 * padding <= 0) {
    throw new PdfExportError(`Overlay "${id}" padding leaves no inner box area.`);
  }
  const fontSize =
    params.fontSize !== undefined ? positive(params.fontSize, `${id}.fontSize`) : DEFAULT_OVERLAY_FONT_SIZE;
  const lineHeightRatio =
    params.lineHeight !== undefined
      ? positive(params.lineHeight, `${id}.lineHeight`)
      : DEFAULT_OVERLAY_LINE_HEIGHT;
  const opacity = params.opacity !== undefined ? unitInterval(params.opacity, `${id}.opacity`) : 1;
  const rotation = params.rotation !== undefined ? finite(params.rotation, `${id}.rotation`) : 0;
  const direction: 'ltr' | 'rtl' = params.direction === 'rtl' ? 'rtl' : 'ltr';
  const rtl = direction === 'rtl';

  const prepared = prepareBoxLines(params.text, ctx.prepare);
  const glyphGap = prepared.dropped > 0;
  if (!prepared.normalized) {
    const reason: SkipReason = prepared.dropped > 0 ? 'unrepresentable' : 'empty';
    return { ok: false, skipped: { id, page, kind, reason }, glyphGap, rtl };
  }

  const placement = planRotatedBox(rect, pageHeight, rotation);
  const minFont =
    params.minimumFontSize !== undefined
      ? positive(params.minimumFontSize, `${id}.minimumFontSize`)
      : ctx.defaultMinFontSize;
  const fit = fitOverlayBoxText(
    prepared.normalized,
    rect,
    padding,
    fontSize,
    lineHeightRatio,
    ctx.baselineRatio,
    ctx.measure,
    params.autoFit === true,
    minFont,
  );
  if (fit.lines.length === 0) {
    return {
      ok: false,
      skipped: { id, page, kind, reason: 'unrepresentable' },
      glyphGap,
      rtl,
    };
  }
  const align: OverlayTextAlign = params.align ?? (rtl ? 'right' : 'left');
  const runs = planBoxRuns(fit, rect, placement, padding, ctx.baselineRatio, align, ctx.measure);

  return {
    ok: true,
    layout: {
      placement,
      runs,
      fontSize: fit.fontSize,
      lineHeight: fit.lineHeight,
      opacity: round(opacity),
      color: normalizeHexColor(params.color, DEFAULT_INK),
      truncated: fit.truncated,
      folded: prepared.changed,
      dropped: prepared.dropped,
      direction,
    },
  };
}

interface ResolvedShapeStyle {
  fillColor?: string;
  strokeColor?: string;
  strokeWidth: number;
  dashArray?: number[];
  lineCap: OverlayLineCap;
  opacity: number;
  strokeOpacity: number;
  rotation: number;
  pdfRotation: number;
}

function resolveShapeStyle(
  id: string,
  overlay: RectShapeOverlay | EllipseShapeOverlay,
): ResolvedShapeStyle {
  const opacity = overlay.opacity !== undefined ? unitInterval(overlay.opacity, `${id}.opacity`) : 1;
  const strokeOpacity =
    overlay.strokeOpacity !== undefined ? unitInterval(overlay.strokeOpacity, `${id}.strokeOpacity`) : opacity;
  const rotation = overlay.rotation !== undefined ? finite(overlay.rotation, `${id}.rotation`) : 0;
  const hasFill = overlay.fillColor !== undefined;
  const explicitStroke = overlay.strokeColor !== undefined;
  const strokeColor = explicitStroke
    ? normalizeHexColor(overlay.strokeColor, DEFAULT_INK)
    : hasFill
      ? undefined
      : DEFAULT_INK;
  const strokeWidth =
    overlay.strokeWidth !== undefined
      ? nonNegative(overlay.strokeWidth, `${id}.strokeWidth`)
      : strokeColor !== undefined
        ? DEFAULT_STROKE_WIDTH
        : 0;
  const dashArray = normalizeDashArray(overlay.dashArray, id);

  return {
    ...(hasFill ? { fillColor: normalizeHexColor(overlay.fillColor, '#ffffff') } : {}),
    ...(strokeColor !== undefined && strokeWidth > 0 ? { strokeColor } : {}),
    strokeWidth: round(strokeWidth),
    ...(dashArray ? { dashArray } : {}),
    lineCap: overlay.lineCap ?? 'butt',
    opacity: round(opacity),
    strokeOpacity: round(strokeOpacity),
    rotation: round(rotation),
    pdfRotation: rotation === 0 ? 0 : round(-rotation),
  };
}

function resolvePageDirectory(
  pages: readonly OverlayPageSize[],
): { pageEntries: Array<{ number: number; width: number; height: number }>; byNumber: Map<number, number> } {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new PdfExportError(EMPTY_OVERLAY_DOCUMENT_MESSAGE);
  }
  const byNumber = new Map<number, number>();
  const pageEntries: Array<{ number: number; width: number; height: number }> = [];

  pages.forEach((source, index) => {
    if (!source || typeof source !== 'object') {
      throw new PdfExportError(`PDF overlay page at index ${index} is invalid.`);
    }
    const width = positive(source.width, `page[${index}].width`);
    const height = positive(source.height, `page[${index}].height`);
    const number = source.number !== undefined ? source.number : index + 1;
    if (!Number.isInteger(number) || number < 1) {
      throw new PdfExportError(`PDF overlay page number must be a positive integer (got ${String(number)}).`);
    }
    if (byNumber.has(number)) {
      throw new PdfExportError(`PDF overlay duplicate page number ${number}.`);
    }
    byNumber.set(number, index);
    pageEntries.push({ number, width: round(width), height: round(height) });
  });

  return { pageEntries, byNumber };
}

function overlayId(overlay: PdfOverlay, index: number): string {
  return typeof overlay.id === 'string' && overlay.id.trim().length > 0
    ? overlay.id
    : `${overlay.kind}-${index + 1}`;
}

function emptyKindCounts(): Record<PdfOverlayKind, number> {
  return {
    textbox: 0,
    callout: 0,
    image: 0,
    rect: 0,
    ellipse: 0,
    line: 0,
    arrow: 0,
    watermark: 0,
  };
}

/**
 * Pure overlay planner (no DOM, no pdf-lib mutation): validates every page and overlay, translates
 * reader top-left coordinates to PDF y-up coordinates, wraps text, computes arrow and callout
 * leader geometry, and collects skip/limitation diagnostics.
 */
export function planPdfOverlays(
  pages: readonly OverlayPageSize[],
  overlays: readonly PdfOverlay[],
  opts: PlanPdfOverlaysOptions = {},
): PdfOverlayPlan {
  const { pageEntries, byNumber } = resolvePageDirectory(pages);
  if (!Array.isArray(overlays as unknown)) {
    throw new PdfExportError('PDF overlay list must be an array.');
  }

  const measure = opts.measure ?? defaultMeasure;
  const prepare = opts.prepare ?? foldToWinAnsi;
  const unicode = opts.unicode === true;
  const fontName = opts.fontName ?? (unicode ? BUNDLED_FONT_NAME : FALLBACK_FACE_NAME);
  const defaultMinFontSize = Math.max(
    1,
    Number.isFinite(opts.minimumFontSize) ? (opts.minimumFontSize ?? DEFAULT_MINIMUM_FONT_SIZE) : DEFAULT_MINIMUM_FONT_SIZE,
  );
  const baselineRatio = Math.max(
    0,
    Math.min(1.2, Number.isFinite(opts.baselineRatio) ? (opts.baselineRatio ?? DEFAULT_BASELINE_RATIO) : DEFAULT_BASELINE_RATIO),
  );

  const plannedPages: PlannedOverlayPage[] = pageEntries.map(entry => ({
    number: entry.number,
    width: entry.width,
    height: entry.height,
    overlays: [],
    skipped: [],
  }));

  const countsByKind = emptyKindCounts();
  const skipped: SkippedOverlay[] = [];
  let appliedCount = 0;
  let rightToLeft = false;
  let glyphGap = false;

  for (let index = 0; index < overlays.length; index++) {
    const overlay = overlays[index];
    if (!overlay || typeof overlay !== 'object') {
      throw new PdfExportError(`PDF overlay at index ${index} must be an object.`);
    }
    const id = overlayId(overlay, index);
    if (!Number.isInteger(overlay.page) || overlay.page < 1) {
      throw new PdfExportError(`Overlay "${id}" has invalid page number ${String(overlay.page)}.`);
    }
    const pageIndex = byNumber.get(overlay.page);
    if (pageIndex === undefined) {
      throw new PdfExportError(
        `Overlay "${id}" targets nonexistent page ${overlay.page} (document has ${pageEntries.length} page(s)).`,
      );
    }
    const targetPage = plannedPages[pageIndex]!;
    const pageHeight = targetPage.height;
    const pageWidth = targetPage.width;

    switch (overlay.kind) {
      case 'textbox': {
        const rect = assertPositiveRect(overlay.rect, `${id}.rect`);
        const borderWidth =
          overlay.borderWidth !== undefined
            ? nonNegative(overlay.borderWidth, `${id}.borderWidth`)
            : overlay.borderColor !== undefined
              ? DEFAULT_STROKE_WIDTH
              : 0;
        const prepared = prepareBoxTextLayout(
          id,
          overlay.page,
          'textbox',
          rect,
          pageHeight,
          DEFAULT_TEXTBOX_PADDING,
          overlay,
          { measure, prepare, baselineRatio, defaultMinFontSize },
        );
        if (!prepared.ok) {
          if (prepared.glyphGap) glyphGap = true;
          if (prepared.rtl) rightToLeft = true;
          targetPage.skipped.push(prepared.skipped);
          skipped.push(prepared.skipped);
          break;
        }
        const { layout } = prepared;
        if (layout.dropped > 0) glyphGap = true;
        if (layout.direction === 'rtl') rightToLeft = true;

        targetPage.overlays.push({
          id,
          kind: 'textbox',
          page: overlay.page,
          pdfRect: layout.placement.pdfRect,
          origin: layout.placement.origin,
          center: layout.placement.center,
          rotation: layout.placement.rotation,
          pdfRotation: layout.placement.pdfRotation,
          runs: layout.runs,
          fontSize: layout.fontSize,
          lineHeight: layout.lineHeight,
          opacity: layout.opacity,
          color: layout.color,
          ...(overlay.backgroundColor !== undefined
            ? { backgroundColor: normalizeHexColor(overlay.backgroundColor, '#ffffff') }
            : {}),
          ...(overlay.borderColor !== undefined && borderWidth > 0
            ? { borderColor: normalizeHexColor(overlay.borderColor, DEFAULT_INK) }
            : {}),
          borderWidth: overlay.borderColor !== undefined ? round(borderWidth) : 0,
          truncated: layout.truncated,
          folded: layout.folded,
          dropped: layout.dropped,
          direction: layout.direction,
        });
        countsByKind.textbox += 1;
        appliedCount += 1;
        break;
      }

      case 'callout': {
        const rect = assertPositiveRect(overlay.rect, `${id}.rect`);
        const borderWidth =
          overlay.borderWidth !== undefined
            ? nonNegative(overlay.borderWidth, `${id}.borderWidth`)
            : DEFAULT_CALLOUT_BORDER_WIDTH;
        const prepared = prepareBoxTextLayout(
          id,
          overlay.page,
          'callout',
          rect,
          pageHeight,
          DEFAULT_CALLOUT_PADDING,
          overlay,
          { measure, prepare, baselineRatio, defaultMinFontSize },
        );
        if (!prepared.ok) {
          if (prepared.glyphGap) glyphGap = true;
          if (prepared.rtl) rightToLeft = true;
          targetPage.skipped.push(prepared.skipped);
          skipped.push(prepared.skipped);
          break;
        }
        const { layout } = prepared;
        if (layout.dropped > 0) glyphGap = true;
        if (layout.direction === 'rtl') rightToLeft = true;

        const borderColor = normalizeHexColor(overlay.borderColor, DEFAULT_CALLOUT_BORDER);
        const backgroundColor =
          overlay.backgroundColor === null
            ? undefined
            : normalizeHexColor(overlay.backgroundColor, DEFAULT_CALLOUT_BG);

        let pointer: PlannedCalloutPointer | undefined;
        if (overlay.pointer !== undefined) {
          const pointerEnd = readerPointToPdfPoint(assertFinitePoint(overlay.pointer, `${id}.pointer`), pageHeight);
          const kneePdf =
            overlay.knee !== undefined
              ? readerPointToPdfPoint(assertFinitePoint(overlay.knee, `${id}.knee`), pageHeight)
              : undefined;
          const anchorTarget = kneePdf ?? pointerEnd;
          const leaderStart = anchorOnRotatedBoxBoundary(layout.placement, anchorTarget);
          const pointerWidth =
            overlay.pointerWidth !== undefined
              ? positive(overlay.pointerWidth, `${id}.pointerWidth`)
              : borderWidth > 0
                ? borderWidth
                : DEFAULT_STROKE_WIDTH;
          const pointerColor = normalizeHexColor(overlay.pointerColor, borderColor);

          let arrowHead: ArrowGeometry | undefined;
          if (overlay.pointerArrow === true) {
            const headFrom = kneePdf ?? leaderStart;
            if (Math.hypot(pointerEnd.x - headFrom.x, pointerEnd.y - headFrom.y) > 0) {
              arrowHead = computeArrowGeometry(headFrom, pointerEnd);
            }
          }
          pointer = {
            start: leaderStart,
            ...(kneePdf ? { knee: kneePdf } : {}),
            end: pointerEnd,
            width: round(pointerWidth),
            color: pointerColor,
            ...(arrowHead ? { arrowHead } : {}),
          };
        }

        targetPage.overlays.push({
          id,
          kind: 'callout',
          page: overlay.page,
          pdfRect: layout.placement.pdfRect,
          origin: layout.placement.origin,
          center: layout.placement.center,
          rotation: layout.placement.rotation,
          pdfRotation: layout.placement.pdfRotation,
          runs: layout.runs,
          fontSize: layout.fontSize,
          lineHeight: layout.lineHeight,
          opacity: layout.opacity,
          color: layout.color,
          ...(backgroundColor ? { backgroundColor } : {}),
          borderColor,
          borderWidth: round(borderWidth),
          ...(pointer ? { pointer } : {}),
          truncated: layout.truncated,
          folded: layout.folded,
          dropped: layout.dropped,
          direction: layout.direction,
        });
        countsByKind.callout += 1;
        appliedCount += 1;
        break;
      }

      case 'image': {
        const rect = assertPositiveRect(overlay.rect, `${id}.rect`);
        if (overlay.format !== 'png' && overlay.format !== 'jpeg') {
          throw new PdfExportError(`Overlay "${id}" image format must be "png" or "jpeg".`);
        }
        if (!(overlay.bytes instanceof Uint8Array) || overlay.bytes.length === 0) {
          throw new PdfExportError(`Overlay "${id}" requires non-empty image bytes.`);
        }
        const opacity = overlay.opacity !== undefined ? unitInterval(overlay.opacity, `${id}.opacity`) : 1;
        const rotation = overlay.rotation !== undefined ? finite(overlay.rotation, `${id}.rotation`) : 0;
        const placement = planRotatedBox(rect, pageHeight, rotation);

        targetPage.overlays.push({
          id,
          kind: 'image',
          page: overlay.page,
          pdfRect: placement.pdfRect,
          origin: placement.origin,
          center: placement.center,
          format: overlay.format,
          bytes: overlay.bytes,
          opacity: round(opacity),
          rotation: placement.rotation,
          pdfRotation: placement.pdfRotation,
        });
        countsByKind.image += 1;
        appliedCount += 1;
        break;
      }

      case 'rect': {
        const rect = assertPositiveRect(overlay.rect, `${id}.rect`);
        const style = resolveShapeStyle(id, overlay);
        const placement = planRotatedBox(rect, pageHeight, style.rotation);

        targetPage.overlays.push({
          id,
          kind: 'rect',
          page: overlay.page,
          pdfRect: placement.pdfRect,
          origin: placement.origin,
          center: placement.center,
          ...style,
        });
        countsByKind.rect += 1;
        appliedCount += 1;
        break;
      }

      case 'ellipse': {
        const rect = assertPositiveRect(overlay.rect, `${id}.rect`);
        const style = resolveShapeStyle(id, overlay);
        const center = readerPointToPdfPoint(
          { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
          pageHeight,
        );

        targetPage.overlays.push({
          id,
          kind: 'ellipse',
          page: overlay.page,
          center,
          xScale: round(rect.width / 2),
          yScale: round(rect.height / 2),
          ...style,
        });
        countsByKind.ellipse += 1;
        appliedCount += 1;
        break;
      }

      case 'line': {
        const start = readerPointToPdfPoint(assertFinitePoint(overlay.start, `${id}.start`), pageHeight);
        const end = readerPointToPdfPoint(assertFinitePoint(overlay.end, `${id}.end`), pageHeight);
        const strokeWidth =
          overlay.strokeWidth !== undefined
            ? positive(overlay.strokeWidth, `${id}.strokeWidth`)
            : DEFAULT_STROKE_WIDTH;
        const opacity = overlay.opacity !== undefined ? unitInterval(overlay.opacity, `${id}.opacity`) : 1;
        const dashArray = normalizeDashArray(overlay.dashArray, id);

        targetPage.overlays.push({
          id,
          kind: 'line',
          page: overlay.page,
          start,
          end,
          strokeColor: normalizeHexColor(overlay.strokeColor, DEFAULT_INK),
          strokeWidth: round(strokeWidth),
          ...(dashArray ? { dashArray } : {}),
          lineCap: overlay.lineCap ?? 'butt',
          opacity: round(opacity),
        });
        countsByKind.line += 1;
        appliedCount += 1;
        break;
      }

      case 'arrow': {
        const start = readerPointToPdfPoint(assertFinitePoint(overlay.start, `${id}.start`), pageHeight);
        const end = readerPointToPdfPoint(assertFinitePoint(overlay.end, `${id}.end`), pageHeight);
        const strokeWidth =
          overlay.strokeWidth !== undefined
            ? positive(overlay.strokeWidth, `${id}.strokeWidth`)
            : DEFAULT_STROKE_WIDTH;
        const opacity = overlay.opacity !== undefined ? unitInterval(overlay.opacity, `${id}.opacity`) : 1;
        const dashArray = normalizeDashArray(overlay.dashArray, id);
        const geometry = computeArrowGeometry(start, end, {
          headLength: overlay.headLength,
          headAngle: overlay.headAngle,
          headStyle: overlay.headStyle,
        });

        targetPage.overlays.push({
          id,
          kind: 'arrow',
          page: overlay.page,
          ...geometry,
          strokeColor: normalizeHexColor(overlay.strokeColor, DEFAULT_INK),
          strokeWidth: round(strokeWidth),
          ...(dashArray ? { dashArray } : {}),
          lineCap: overlay.lineCap ?? 'butt',
          opacity: round(opacity),
        });
        countsByKind.arrow += 1;
        appliedCount += 1;
        break;
      }

      case 'watermark': {
        const fontSize =
          overlay.fontSize !== undefined
            ? positive(overlay.fontSize, `${id}.fontSize`)
            : DEFAULT_WATERMARK_FONT_SIZE;
        const lineHeightRatio =
          overlay.lineHeight !== undefined
            ? positive(overlay.lineHeight, `${id}.lineHeight`)
            : DEFAULT_OVERLAY_LINE_HEIGHT;
        const opacity =
          overlay.opacity !== undefined
            ? unitInterval(overlay.opacity, `${id}.opacity`)
            : DEFAULT_WATERMARK_OPACITY;
        const angle =
          overlay.angle !== undefined
            ? finite(overlay.angle, `${id}.angle`)
            : DEFAULT_WATERMARK_ANGLE;

        let centerReader: OverlayPoint;
        if (overlay.center !== undefined) {
          centerReader = assertFinitePoint(overlay.center, `${id}.center`);
        } else if (overlay.rect !== undefined) {
          const box = assertPositiveRect(overlay.rect, `${id}.rect`);
          centerReader = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        } else {
          centerReader = { x: pageWidth / 2, y: pageHeight / 2 };
        }
        const center = readerPointToPdfPoint(centerReader, pageHeight);

        const prepared = prepareBoxLines(overlay.text, prepare);
        if (prepared.dropped > 0) glyphGap = true;
        const lines = prepared.lines;
        if (lines.length === 0) {
          const reason: SkipReason = prepared.dropped > 0 ? 'unrepresentable' : 'empty';
          const entry: SkippedOverlay = { id, page: overlay.page, kind: 'watermark', reason };
          targetPage.skipped.push(entry);
          skipped.push(entry);
          break;
        }

        const pdfRotation = angle === 0 ? 0 : round(-angle);
        const thetaRad = (pdfRotation * Math.PI) / 180;
        const lineHeightPt = round(fontSize * lineHeightRatio);
        const runs: TextRun[] = lines.map((line, lineIndex) => {
          const lineWidth = measure(line, fontSize);
          const lx = -lineWidth / 2;
          const ly = ((lines.length - 1) / 2 - lineIndex) * lineHeightPt - fontSize * 0.32;
          const origin = rotateLocalPoint(lx, ly, center, thetaRad);
          return { text: line, x: origin.x, y: origin.y };
        });

        targetPage.overlays.push({
          id,
          kind: 'watermark',
          page: overlay.page,
          center,
          runs,
          fontSize: round(fontSize),
          lineHeight: lineHeightPt,
          angle: round(angle),
          pdfRotation,
          opacity: round(opacity),
          color: normalizeHexColor(overlay.color, DEFAULT_WATERMARK_COLOR),
          layer: overlay.layer ?? 'over',
          folded: prepared.changed,
          dropped: prepared.dropped,
        });
        countsByKind.watermark += 1;
        appliedCount += 1;
        break;
      }

      default: {
        const neverKind: never = overlay;
        throw new PdfExportError(`Unsupported PDF overlay kind: ${String((neverKind as { kind?: unknown }).kind)}`);
      }
    }
  }

  const limitations = new Set<string>();
  if (!unicode) limitations.add(FONT_LIMITATION);
  if (unicode && glyphGap) limitations.add(UNICODE_GAP_LIMITATION);
  if (rightToLeft) limitations.add(BIDI_LIMITATION);

  return {
    pages: plannedPages,
    pageCount: plannedPages.length,
    overlayCount: overlays.length,
    appliedCount,
    countsByKind,
    skipped,
    limitations: [...limitations],
    fontName,
  };
}

function toPdfLineCap(cap: OverlayLineCap): LineCapStyle {
  if (cap === 'round') return LineCapStyle.Round;
  if (cap === 'square') return LineCapStyle.Projecting;
  return LineCapStyle.Butt;
}

function ensureExtGState(
  doc: PDFDocument,
  page: PDFPage,
  fillOpacity: number | undefined,
  strokeOpacity: number | undefined,
): PDFName | undefined {
  const needsFillAlpha = fillOpacity !== undefined && fillOpacity < 1;
  const needsStrokeAlpha = strokeOpacity !== undefined && strokeOpacity < 1;
  if (!needsFillAlpha && !needsStrokeAlpha) return undefined;
  const gsDict = doc.context.obj({
    Type: 'ExtGState',
    ...(needsFillAlpha ? { ca: fillOpacity } : {}),
    ...(needsStrokeAlpha ? { CA: strokeOpacity } : {}),
  });
  return page.node.newExtGState('GS', gsDict);
}

function drawLinePath(
  doc: PDFDocument,
  page: PDFPage,
  points: readonly OverlayPoint[],
  strokeColor: string,
  strokeWidth: number,
  opacity: number,
  lineCap: OverlayLineCap,
  dashArray?: readonly number[],
): void {
  const first = points[0];
  if (!first || points.length < 2) return;
  const strokeRgb = parseRgb(strokeColor, DEFAULT_INK);
  const gsKey = ensureExtGState(doc, page, undefined, opacity);
  const ops = [
    pushGraphicsState(),
    ...(gsKey ? [setGraphicsState(gsKey)] : []),
    setStrokingRgbColor(strokeRgb.r, strokeRgb.g, strokeRgb.b),
    setLineWidth(strokeWidth),
    setLineCap(toPdfLineCap(lineCap)),
    setLineJoin(LineJoinStyle.Round),
    ...(dashArray && dashArray.length > 0 ? [setDashPattern([...dashArray], 0)] : []),
    moveTo(first.x, first.y),
    ...points.slice(1).map(pt => lineTo(pt.x, pt.y)),
    stroke(),
    popGraphicsState(),
  ];
  page.pushOperators(...ops);
}

function drawArrowHead(
  doc: PDFDocument,
  page: PDFPage,
  geometry: ArrowGeometry,
  colorHex: string,
  strokeWidth: number,
  opacity: number,
): void {
  const color = parseRgb(colorHex, DEFAULT_INK);
  if (geometry.headStyle === 'filled') {
    const gsKey = ensureExtGState(doc, page, opacity, undefined);
    page.pushOperators(
      pushGraphicsState(),
      ...(gsKey ? [setGraphicsState(gsKey)] : []),
      setFillingRgbColor(color.r, color.g, color.b),
      moveTo(geometry.tip.x, geometry.tip.y),
      lineTo(geometry.leftWing.x, geometry.leftWing.y),
      lineTo(geometry.rightWing.x, geometry.rightWing.y),
      closePath(),
      fill(),
      popGraphicsState(),
    );
    return;
  }

  const gsKey = ensureExtGState(doc, page, undefined, opacity);
  page.pushOperators(
    pushGraphicsState(),
    ...(gsKey ? [setGraphicsState(gsKey)] : []),
    setStrokingRgbColor(color.r, color.g, color.b),
    setLineWidth(strokeWidth),
    setLineCap(LineCapStyle.Butt),
    setLineJoin(LineJoinStyle.Miter),
    setDashPattern([], 0),
    moveTo(geometry.leftWing.x, geometry.leftWing.y),
    lineTo(geometry.tip.x, geometry.tip.y),
    lineTo(geometry.rightWing.x, geometry.rightWing.y),
    stroke(),
    popGraphicsState(),
  );
}

function drawPlannedRuns(
  page: PDFPage,
  runs: readonly TextRun[],
  fontSize: number,
  colorHex: string,
  opacity: number,
  pdfRotation: number,
): void {
  const ink = parseRgb(colorHex, DEFAULT_INK);
  const color = rgb(ink.r, ink.g, ink.b);
  for (const run of runs) {
    page.drawText(run.text, {
      x: run.x,
      y: run.y,
      size: fontSize,
      color,
      ...(opacity < 1 ? { opacity } : {}),
      ...(pdfRotation !== 0 ? { rotate: degrees(pdfRotation) } : {}),
    });
  }
}

function drawBoxOutlineAndFill(
  page: PDFPage,
  opts: {
    origin: OverlayPoint;
    width: number;
    height: number;
    pdfRotation: number;
    fillColor?: string;
    strokeColor?: string;
    strokeWidth: number;
    dashArray?: readonly number[];
    lineCap: OverlayLineCap;
    opacity: number;
    strokeOpacity: number;
  },
): void {
  const fillRgb = opts.fillColor !== undefined ? parseRgb(opts.fillColor, '#ffffff') : undefined;
  const strokeRgb =
    opts.strokeColor !== undefined && opts.strokeWidth > 0
      ? parseRgb(opts.strokeColor, DEFAULT_INK)
      : undefined;
  if (!fillRgb && !strokeRgb) return;

  page.drawRectangle({
    x: opts.origin.x,
    y: opts.origin.y,
    width: opts.width,
    height: opts.height,
    ...(opts.pdfRotation !== 0 ? { rotate: degrees(opts.pdfRotation) } : {}),
    ...(fillRgb ? { color: rgb(fillRgb.r, fillRgb.g, fillRgb.b) } : {}),
    ...(strokeRgb
      ? { borderColor: rgb(strokeRgb.r, strokeRgb.g, strokeRgb.b), borderWidth: opts.strokeWidth }
      : { borderWidth: 0 }),
    ...(opts.dashArray && opts.dashArray.length > 0 ? { borderDashArray: [...opts.dashArray] } : {}),
    ...(strokeRgb ? { borderLineCap: toPdfLineCap(opts.lineCap) } : {}),
    ...(fillRgb && opts.opacity < 1 ? { opacity: opts.opacity } : {}),
    ...(strokeRgb && opts.strokeOpacity < 1 ? { borderOpacity: opts.strokeOpacity } : {}),
  });
}

async function resolveEmbeddedImage(
  doc: PDFDocument,
  cache: Map<Uint8Array, PDFImage>,
  overlay: PlannedImageOverlay,
): Promise<PDFImage> {
  const cached = cache.get(overlay.bytes);
  if (cached) return cached;

  // pdf-lib's JpegEmbedder reads `new DataView(imageData.buffer)` without byteOffset; slicing when
  // viewing into a larger ArrayBuffer avoids reading header bytes at offset 0 of the slab.
  const normalizedBytes =
    overlay.bytes.byteOffset === 0 && overlay.bytes.byteLength === overlay.bytes.buffer.byteLength
      ? overlay.bytes
      : overlay.bytes.slice();

  try {
    const embedded =
      overlay.format === 'jpeg'
        ? await doc.embedJpg(normalizedBytes)
        : await doc.embedPng(normalizedBytes);
    cache.set(overlay.bytes, embedded);
    return embedded;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PdfExportError(`Overlay "${overlay.id}" failed to embed ${overlay.format}: ${detail}`);
  }
}

async function drawPlannedOverlay(
  doc: PDFDocument,
  page: PDFPage,
  overlay: PlannedOverlay,
  imageCache: Map<Uint8Array, PDFImage>,
): Promise<void> {
  switch (overlay.kind) {
    case 'textbox': {
      drawBoxOutlineAndFill(page, {
        origin: overlay.origin,
        width: overlay.pdfRect.width,
        height: overlay.pdfRect.height,
        pdfRotation: overlay.pdfRotation,
        fillColor: overlay.backgroundColor,
        strokeColor: overlay.borderColor,
        strokeWidth: overlay.borderWidth,
        lineCap: 'butt',
        opacity: overlay.opacity,
        strokeOpacity: overlay.opacity,
      });
      drawPlannedRuns(
        page,
        overlay.runs,
        overlay.fontSize,
        overlay.color,
        overlay.opacity,
        overlay.pdfRotation,
      );
      return;
    }

    case 'callout': {
      if (overlay.pointer) {
        const ptr = overlay.pointer;
        const points = ptr.knee ? [ptr.start, ptr.knee, ptr.end] : [ptr.start, ptr.end];
        if (ptr.arrowHead) {
          const tailPoints = ptr.knee
            ? [ptr.start, ptr.knee, ptr.arrowHead.shaftEnd]
            : [ptr.start, ptr.arrowHead.shaftEnd];
          if (
            tailPoints.length >= 2 &&
            Math.hypot(
              tailPoints[tailPoints.length - 1]!.x - tailPoints[0]!.x,
              tailPoints[tailPoints.length - 1]!.y - tailPoints[0]!.y,
            ) > 1e-6
          ) {
            drawLinePath(doc, page, tailPoints, ptr.color, ptr.width, overlay.opacity, 'round');
          }
          drawArrowHead(doc, page, ptr.arrowHead, ptr.color, ptr.width, overlay.opacity);
        } else {
          drawLinePath(doc, page, points, ptr.color, ptr.width, overlay.opacity, 'round');
        }
      }

      drawBoxOutlineAndFill(page, {
        origin: overlay.origin,
        width: overlay.pdfRect.width,
        height: overlay.pdfRect.height,
        pdfRotation: overlay.pdfRotation,
        fillColor: overlay.backgroundColor,
        strokeColor: overlay.borderColor,
        strokeWidth: overlay.borderWidth,
        lineCap: 'butt',
        opacity: overlay.opacity,
        strokeOpacity: overlay.opacity,
      });
      drawPlannedRuns(
        page,
        overlay.runs,
        overlay.fontSize,
        overlay.color,
        overlay.opacity,
        overlay.pdfRotation,
      );
      return;
    }

    case 'image': {
      const embedded = await resolveEmbeddedImage(doc, imageCache, overlay);
      page.drawImage(embedded, {
        x: overlay.origin.x,
        y: overlay.origin.y,
        width: overlay.pdfRect.width,
        height: overlay.pdfRect.height,
        ...(overlay.pdfRotation !== 0 ? { rotate: degrees(overlay.pdfRotation) } : {}),
        ...(overlay.opacity < 1 ? { opacity: overlay.opacity } : {}),
      });
      return;
    }

    case 'rect': {
      drawBoxOutlineAndFill(page, {
        origin: overlay.origin,
        width: overlay.pdfRect.width,
        height: overlay.pdfRect.height,
        pdfRotation: overlay.pdfRotation,
        fillColor: overlay.fillColor,
        strokeColor: overlay.strokeColor,
        strokeWidth: overlay.strokeWidth,
        dashArray: overlay.dashArray,
        lineCap: overlay.lineCap,
        opacity: overlay.opacity,
        strokeOpacity: overlay.strokeOpacity,
      });
      return;
    }

    case 'ellipse': {
      const fillRgb = overlay.fillColor !== undefined ? parseRgb(overlay.fillColor, '#ffffff') : undefined;
      const strokeRgb =
        overlay.strokeColor !== undefined && overlay.strokeWidth > 0
          ? parseRgb(overlay.strokeColor, DEFAULT_INK)
          : undefined;
      if (!fillRgb && !strokeRgb) return;

      page.drawEllipse({
        x: overlay.center.x,
        y: overlay.center.y,
        xScale: overlay.xScale,
        yScale: overlay.yScale,
        ...(overlay.pdfRotation !== 0 ? { rotate: degrees(overlay.pdfRotation) } : {}),
        ...(fillRgb ? { color: rgb(fillRgb.r, fillRgb.g, fillRgb.b) } : {}),
        ...(strokeRgb
          ? { borderColor: rgb(strokeRgb.r, strokeRgb.g, strokeRgb.b), borderWidth: overlay.strokeWidth }
          : { borderWidth: 0 }),
        ...(overlay.dashArray && overlay.dashArray.length > 0
          ? { borderDashArray: [...overlay.dashArray] }
          : {}),
        ...(strokeRgb ? { borderLineCap: toPdfLineCap(overlay.lineCap) } : {}),
        ...(fillRgb && overlay.opacity < 1 ? { opacity: overlay.opacity } : {}),
        ...(strokeRgb && overlay.strokeOpacity < 1 ? { borderOpacity: overlay.strokeOpacity } : {}),
      });
      return;
    }

    case 'line': {
      drawLinePath(
        doc,
        page,
        [overlay.start, overlay.end],
        overlay.strokeColor,
        overlay.strokeWidth,
        overlay.opacity,
        overlay.lineCap,
        overlay.dashArray,
      );
      return;
    }

    case 'arrow': {
      if (
        overlay.headStyle === 'open' ||
        Math.hypot(overlay.shaftEnd.x - overlay.start.x, overlay.shaftEnd.y - overlay.start.y) > 1e-6
      ) {
        drawLinePath(
          doc,
          page,
          [overlay.start, overlay.shaftEnd],
          overlay.strokeColor,
          overlay.strokeWidth,
          overlay.opacity,
          overlay.lineCap,
          overlay.dashArray,
        );
      }
      drawArrowHead(doc, page, overlay, overlay.strokeColor, overlay.strokeWidth, overlay.opacity);
      return;
    }

    case 'watermark': {
      drawPlannedRuns(
        page,
        overlay.runs,
        overlay.fontSize,
        overlay.color,
        overlay.opacity,
        overlay.pdfRotation,
      );
      return;
    }
  }
}

/**
 * Inserts overlays (text boxes, callouts, images, vector shapes, and watermarks) onto either
 * existing PDF bytes (`pdfBytes`) or freshly sized pages (`pages`), embedding Noto Sans Unicode once
 * per document when available and preserving exact coordinates.
 */
export async function composePdfOverlays(
  input: ComposePdfOverlaysInput,
): Promise<ComposePdfOverlaysResult> {
  if (!input || typeof input !== 'object') {
    throw new PdfExportError(EMPTY_OVERLAY_DOCUMENT_MESSAGE);
  }

  let doc: PDFDocument;
  let pageSpecs: OverlayPageSize[];
  const fromExistingPdf = input.pdfBytes !== undefined;

  if (fromExistingPdf) {
    if (!(input.pdfBytes instanceof Uint8Array) || input.pdfBytes.length === 0) {
      throw new PdfExportError('Source PDF bytes are invalid or empty.');
    }
    try {
      doc = await PDFDocument.load(input.pdfBytes);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PdfExportError(`Source PDF bytes could not be loaded: ${detail}`);
    }
    const existingPages = doc.getPages();
    if (existingPages.length === 0) {
      throw new PdfExportError(EMPTY_OVERLAY_DOCUMENT_MESSAGE);
    }
    pageSpecs = existingPages.map((target, index) => {
      const size = target.getSize();
      return { number: index + 1, width: size.width, height: size.height };
    });
  } else {
    if (!input.pages || input.pages.length === 0) {
      throw new PdfExportError(EMPTY_OVERLAY_DOCUMENT_MESSAGE);
    }
    // Validate page specs before creating/allocating PDF resources.
    const validated = resolvePageDirectory(input.pages);
    pageSpecs = validated.pageEntries;
    doc = await PDFDocument.create();
    for (const spec of pageSpecs) {
      doc.addPage([spec.width, spec.height]);
    }
  }

  const fonts = await registerPdfFonts(doc, input.fonts);
  const font = fonts.font;
  const measure: Measure =
    input.measure ??
    ((text, size) => {
      try {
        return font.widthOfTextAtSize(text, size);
      } catch {
        return defaultMeasure(text, size);
      }
    });

  const plan = planPdfOverlays(pageSpecs, input.overlays, {
    measure,
    minimumFontSize: input.minimumFontSize,
    baselineRatio: input.baselineRatio,
    prepare: fonts.prepare,
    unicode: fonts.unicode,
    fontName: fonts.name,
  });

  const pdfPages = doc.getPages();
  const imageCache = new Map<Uint8Array, PDFImage>();

  for (let pageIndex = 0; pageIndex < plan.pages.length; pageIndex++) {
    const plannedPage = plan.pages[pageIndex]!;
    const targetPage = pdfPages[pageIndex]!;
    const needsFont = plannedPage.overlays.some(
      item => item.kind === 'textbox' || item.kind === 'callout' || item.kind === 'watermark',
    );
    if (needsFont) {
      targetPage.setFont(font);
    }

    const underWatermarks = plannedPage.overlays.filter(
      item => item.kind === 'watermark' && item.layer === 'under',
    );
    const foreground = plannedPage.overlays.filter(item => item.kind !== 'watermark');
    const overWatermarks = plannedPage.overlays.filter(
      item => item.kind === 'watermark' && item.layer === 'over',
    );

    for (const item of [...underWatermarks, ...foreground, ...overWatermarks]) {
      await drawPlannedOverlay(doc, targetPage, item, imageCache);
    }
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title) doc.setTitle(title);
  if (typeof input.producer === 'string' && input.producer.trim()) {
    doc.setProducer(input.producer.trim());
  } else if (!fromExistingPdf) {
    doc.setProducer(DEFAULT_OVERLAY_PRODUCER);
  }
  if (typeof input.creator === 'string' && input.creator.trim()) {
    doc.setCreator(input.creator.trim());
  } else if (!fromExistingPdf) {
    doc.setCreator(DEFAULT_OVERLAY_CREATOR);
  }

  const bytes = await doc.save();

  return {
    bytes,
    pageCount: doc.getPageCount(),
    overlayCount: plan.overlayCount,
    appliedCount: plan.appliedCount,
    countsByKind: plan.countsByKind,
    plan,
    skipped: plan.skipped,
    limitations: plan.limitations,
    fontName: plan.fontName,
  };
}
