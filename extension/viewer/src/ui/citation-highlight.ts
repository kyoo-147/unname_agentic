/**
 * Source citation chip bar and polygon/bbox highlight overlay controller (backlog I01).
 *
 * Bridges {@link parseCitations} / {@link resolveCitations} (`../core/citations`) and
 * optional 4-corner {@link Quad} / {@link GroundedRegion} geometry
 * (`../core/visual-grounding`) with a minimal, accessible DOM/SVG controller.
 *
 * Contract:
 * - No framework dependency, no inline decorative styling, no global DOM assumption when a
 *   custom `dom` document factory is provided.
 * - Unresolved citations are retained in `unresolved` and never emitted as broken clickable
 *   buttons or snapped onto unrelated regions.
 * - Keyboard navigation supports `ArrowRight`, `ArrowLeft`, `Enter`/`Space`, and `Escape`
 *   to clear the active highlight.
 */

import {
  highlightShape,
  parseCitations,
  resolveCitations,
  type PageSize,
  type ResolvedCitation,
  type UnresolvedCitation,
} from '../core/citations';
import type { DocumentIR, Point, Polygon } from '../core/ir';
import type { Rect } from '../core/types';
import {
  NORMALIZED_COORD_MAX,
  bboxToQuad,
  fromPixelBox,
  polygonToBBox,
  toPixelBox,
  validateNormalizedBBox,
  type GroundedRegion,
  type NormalizedBBox,
  type Point2D,
  type Quad,
} from '../core/visual-grounding';

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const CLASS = {
  chipBar: 'citation-chips',
  chip: 'citation-chip',
  layer: 'citation-highlight-layer',
  overlay: 'citation-highlight-overlay',
  box: 'citation-highlight-box',
  svg: 'citation-highlight-svg',
  polygon: 'citation-highlight-polygon',
} as const;

const UNIT_SCALE = 1e6;
const DISPLAY_SCALE = 1e4;

export interface CitationStyleDeclaration {
  left?: string;
  top?: string;
  width?: string;
  height?: string;
  cssText?: string;
}

export interface CitationEventLike {
  type?: string;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
  currentTarget?: unknown;
  preventDefault?(): void;
  stopPropagation?(): void;
}

export type CitationEventListener = (event: CitationEventLike) => void;

export interface CitationElement {
  tagName: string;
  textContent: string | null;
  style?: CitationStyleDeclaration;
  setAttribute(name: string, value: string): void;
  getAttribute?(name: string): string | null;
  removeAttribute?(name: string): void;
  append(...nodes: unknown[]): void;
  replaceChildren?(...nodes: unknown[]): void;
  addEventListener?(type: string, listener: CitationEventListener): void;
  removeEventListener?(type: string, listener: CitationEventListener): void;
  focus?(options?: { preventScroll?: boolean }): void;
  scrollIntoView?(options?: {
    block?: 'start' | 'center' | 'end' | 'nearest';
    inline?: 'start' | 'center' | 'end' | 'nearest';
    behavior?: 'auto' | 'instant' | 'smooth';
  }): void;
}

export interface CitationDocument {
  createElement(tagName: string): CitationElement;
  createElementNS?(namespaceURI: string, qualifiedName: string): CitationElement;
}

export type HighlightCoordinateSpace = 'normalized' | 'page';

export interface CitationGroundingRegion {
  bbox?: NormalizedBBox;
  quad?: Quad;
  space?: HighlightCoordinateSpace;
  pageIndex?: number;
}

export type CitationGroundingInput = GroundedRegion | Quad | CitationGroundingRegion;

export interface CitationGroundingSource {
  byBlockId?: ReadonlyMap<string, CitationGroundingInput> | Readonly<Record<string, CitationGroundingInput>>;
  byIndex?: ReadonlyMap<number, CitationGroundingInput> | Readonly<Record<number, CitationGroundingInput>>;
}

export interface CitationPolygonGeometry {
  pageSize: PageSize;
  rect: Rect;
  unit: Rect;
  polygon: Polygon;
  unitPolygon: Polygon;
  quad: Quad;
  normalizedBBox: NormalizedBBox;
  svgPoints: string;
  svgViewBox: string;
}

export interface CitationChip {
  chipIndex: number;
  citationIndex: number;
  page: number;
  blockId: string | null;
  raw: string;
  count: number;
  label: string;
  ariaLabel: string;
  highlight: CitationPolygonGeometry | null;
}

export interface CitationModel {
  cleanedAnswer: string;
  chips: readonly CitationChip[];
  unresolved: readonly UnresolvedCitation[];
}

export interface CitationNavigationTarget {
  chip: CitationChip;
  page: number;
  blockId: string | null;
  highlight: CitationPolygonGeometry | null;
}

export interface CitationControllerSnapshot {
  activeIndex: number | null;
  focusedIndex: number | null;
  activeChip: CitationChip | null;
  chips: readonly CitationChip[];
  unresolved: readonly UnresolvedCitation[];
}

export type CitationChipBase = Omit<CitationChip, 'label' | 'ariaLabel'>;

export interface PrepareCitationsOptions {
  grounding?: CitationGroundingSource;
  formatChipLabel?: (chip: CitationChipBase) => string;
  formatChipAriaLabel?: (chip: CitationChipBase) => string;
}

export type PageContainerResolver =
  | ReadonlyMap<number, CitationElement>
  | ((page: number) => CitationElement | null | undefined);

export interface CitationHighlightControllerOptions extends PrepareCitationsOptions {
  answer: string;
  ir: DocumentIR;
  dom?: CitationDocument;
  chipContainer?: CitationElement;
  overlayContainer?: CitationElement;
  pageContainers?: PageContainerResolver;
  ariaLabel?: string;
  onNavigate?: (target: CitationNavigationTarget) => void;
  onClear?: () => void;
}

export interface CitationHighlightController {
  readonly chipBar: CitationElement;
  readonly chipElements: readonly CitationElement[];
  readonly overlay: CitationElement;
  readonly cleanedAnswer: string;
  readonly chips: readonly CitationChip[];
  readonly unresolved: readonly UnresolvedCitation[];
  snapshot(): CitationControllerSnapshot;
  select(chipIndex: number): boolean;
  clear(): void;
  handleKeyDown(event: CitationEventLike): boolean;
  destroy(): void;
}

// --- Pure Geometry & Resolution --------------------------------------------

/**
 * Resolves a citation's page-space rect, 4-corner polygon, normalized quad, and SVG
 * attributes. Explicit `grounding` overrides (`Quad` / `GroundedRegion` in `[0, 1000]`
 * or `'page'` space) refine or supply a region; invalid inputs safely fall back or
 * yield `null` without throwing or inventing coordinates.
 */
export function resolveCitationHighlight(
  resolved: ResolvedCitation,
  grounding?: CitationGroundingInput,
): CitationPolygonGeometry | null {
  if (!resolved || !isPositiveFinite(resolved.width) || !isPositiveFinite(resolved.height)) {
    return null;
  }

  const pageSize: PageSize = {
    width: resolved.width,
    height: resolved.height,
    ...(resolved.rotation !== undefined ? { rotation: resolved.rotation } : {}),
  };

  if (grounding !== undefined) {
    const grounded = geometryFromGrounding(grounding, pageSize, resolved.page);
    if (grounded !== null) return grounded;
  }

  if (resolved.polygon !== null) {
    const clamped = clampPagePolygon(resolved.polygon, pageSize);
    if (clamped !== null) return buildGeometryFromPagePolygon(clamped, pageSize);
  }

  if (resolved.rect !== null) {
    return buildGeometryFromPageRect(resolved.rect, pageSize);
  }

  return null;
}

/**
 * Extracts citation markers from an AI answer, resolves them against the Document IR and
 * optional visual grounding, and produces clickable chip view models plus `unresolved`.
 */
export function prepareCitations(
  answer: string,
  ir: DocumentIR,
  options: PrepareCitationsOptions = {},
): CitationModel {
  const { citations, cleaned } = parseCitations(answer);
  const { resolved, unresolved } = resolveCitations(citations, ir);

  const chips: CitationChip[] = resolved.map((entry, chipIndex) => {
    const grounding = lookupGrounding(options.grounding, entry);
    const base: CitationChipBase = {
      chipIndex,
      citationIndex: entry.index,
      page: entry.page,
      blockId: entry.blockId,
      raw: entry.raw,
      count: entry.count,
      highlight: resolveCitationHighlight(entry, grounding),
    };
    return {
      ...base,
      label: options.formatChipLabel ? options.formatChipLabel(base) : defaultChipLabel(base),
      ariaLabel: options.formatChipAriaLabel ? options.formatChipAriaLabel(base) : defaultChipAriaLabel(base),
    };
  });

  return { cleanedAnswer: cleaned, chips, unresolved };
}

// --- DOM / SVG Rendering ---------------------------------------------------

/**
 * Renders the active citation's DOM bounding box and SVG polygon overlay, or returns
 * `null` when cleared or when the citation carries no spatial region.
 */
export function renderCitationOverlay(chip: CitationChip | null, dom: Document): HTMLElement | null;
export function renderCitationOverlay(chip: CitationChip | null, dom?: CitationDocument): CitationElement | null;
export function renderCitationOverlay(chip: CitationChip | null, dom?: CitationDocument): CitationElement | null {
  if (!chip || !chip.highlight) return null;
  const doc = resolveDocument(dom);
  const highlight = chip.highlight;

  const wrapper = doc.createElement('div');
  setElementClass(wrapper, CLASS.overlay);
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.setAttribute('data-page', String(chip.page));
  wrapper.setAttribute('data-citation-index', String(chip.chipIndex));
  if (chip.blockId !== null) wrapper.setAttribute('data-block-id', chip.blockId);

  const box = doc.createElement('div');
  setElementClass(box, CLASS.box);
  box.setAttribute('aria-hidden', 'true');
  applyPercentBoxStyle(box, highlight.unit);

  const svg = createSvgElement(doc, 'svg');
  setElementClass(svg, CLASS.svg);
  svg.setAttribute('viewBox', highlight.svgViewBox);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const polygon = createSvgElement(doc, 'polygon');
  setElementClass(polygon, CLASS.polygon);
  polygon.setAttribute('points', highlight.svgPoints);

  svg.append(polygon);
  wrapper.append(box, svg);
  return wrapper;
}

// --- Interactive Controller ------------------------------------------------

/**
 * Creates an interactive citation chip bar + source highlight overlay controller.
 */
export function createCitationHighlightController(
  options: CitationHighlightControllerOptions,
): CitationHighlightController {
  const doc = resolveDocument(options.dom);
  const model = prepareCitations(options.answer, options.ir, options);

  const chipBar = doc.createElement('div');
  setElementClass(chipBar, CLASS.chipBar);
  chipBar.setAttribute('role', 'group');
  chipBar.setAttribute('aria-label', nonEmpty(options.ariaLabel) ?? 'Citations');

  const overlay = options.overlayContainer ?? createOverlayLayer(doc);
  const chipElements: CitationElement[] = [];
  const handledEvents = new WeakSet<object>();
  const cleanups: Array<() => void> = [];

  let activeIndex: number | null = null;
  let focusedIndex: number | null = model.chips.length > 0 ? 0 : null;
  let mountedPageContainer: CitationElement | null = null;
  let destroyed = false;

  function syncPressedAttributes(): void {
    chipElements.forEach((element, index) => {
      element.setAttribute('aria-pressed', String(index === activeIndex));
    });
  }

  function clearMountedOverlay(): void {
    if (mountedPageContainer) {
      clearChildren(mountedPageContainer);
      mountedPageContainer = null;
    }
    if (!options.pageContainers) {
      clearChildren(overlay);
    }
  }

  function renderActiveOverlay(chip: CitationChip | null): void {
    clearMountedOverlay();
    const rendered = renderCitationOverlay(chip, doc);
    if (!rendered || !chip) return;

    if (options.pageContainers) {
      const targetContainer = resolvePageContainer(options.pageContainers, chip.page);
      if (!targetContainer) return;
      mountSingleChild(targetContainer, rendered);
      mountedPageContainer = targetContainer;
      return;
    }

    mountSingleChild(overlay, rendered);
  }

  function select(chipIndex: number): boolean {
    if (destroyed) return false;
    if (!Number.isInteger(chipIndex) || chipIndex < 0 || chipIndex >= model.chips.length) return false;
    const chip = model.chips[chipIndex];
    if (!chip) return false;

    activeIndex = chipIndex;
    focusedIndex = chipIndex;
    syncPressedAttributes();
    renderActiveOverlay(chip);

    options.onNavigate?.({
      chip,
      page: chip.page,
      blockId: chip.blockId,
      highlight: chip.highlight,
    });
    return true;
  }

  function clear(): void {
    if (destroyed) return;
    const wasActive = activeIndex !== null;
    activeIndex = null;
    syncPressedAttributes();
    clearMountedOverlay();
    if (wasActive) options.onClear?.();
  }

  function moveFocus(step: 1 | -1, originIndex: number | null): boolean {
    const total = chipElements.length;
    if (total === 0) return false;
    const base = originIndex ?? focusedIndex ?? activeIndex;
    const nextIndex = base === null
      ? (step > 0 ? 0 : total - 1)
      : (base + step + total) % total;

    focusedIndex = nextIndex;
    chipElements[nextIndex]?.focus?.();
    return true;
  }

  function handleKey(event: CitationEventLike, explicitChipIndex: number | null): boolean {
    if (destroyed) return false;
    if (handledEvents.has(event)) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (isEditableTarget(event.target)) return false;

    const key = event.key;
    if (key === 'Escape') {
      if (activeIndex === null) return false;
      handledEvents.add(event);
      event.preventDefault?.();
      clear();
      return true;
    }

    if (model.chips.length === 0) return false;

    const targetIndex = explicitChipIndex ?? indexOfChipTarget(chipElements, event.target);
    if (key === 'ArrowRight') {
      if (explicitChipIndex === null && event.target !== undefined && event.target !== null && event.target !== chipBar && targetIndex === null) {
        return false;
      }
      handledEvents.add(event);
      event.preventDefault?.();
      return moveFocus(1, targetIndex);
    }

    if (key === 'ArrowLeft') {
      if (explicitChipIndex === null && event.target !== undefined && event.target !== null && event.target !== chipBar && targetIndex === null) {
        return false;
      }
      handledEvents.add(event);
      event.preventDefault?.();
      return moveFocus(-1, targetIndex);
    }

    if (key === 'Enter' || key === ' ') {
      if (explicitChipIndex === null && event.target !== undefined && event.target !== null && event.target !== chipBar && targetIndex === null) {
        return false;
      }
      const chosenIndex = targetIndex ?? focusedIndex ?? activeIndex ?? 0;
      handledEvents.add(event);
      event.preventDefault?.();
      return select(chosenIndex);
    }

    return false;
  }

  model.chips.forEach((chip, index) => {
    const button = doc.createElement('button');
    setElementClass(button, CLASS.chip);
    button.setAttribute('type', 'button');
    button.setAttribute('role', 'button');
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', chip.ariaLabel);
    button.setAttribute('data-page', String(chip.page));
    button.setAttribute('data-citation-index', String(chip.chipIndex));
    if (chip.blockId !== null) button.setAttribute('data-block-id', chip.blockId);
    if (chip.count > 1) button.setAttribute('data-count', String(chip.count));
    button.textContent = chip.label;

    const onClick: CitationEventListener = () => {
      select(index);
    };
    const onFocus: CitationEventListener = () => {
      focusedIndex = index;
    };
    const onKeyDown: CitationEventListener = event => {
      handleKey(event, index);
    };

    button.addEventListener?.('click', onClick);
    button.addEventListener?.('focus', onFocus);
    button.addEventListener?.('keydown', onKeyDown);
    cleanups.push(() => {
      button.removeEventListener?.('click', onClick);
      button.removeEventListener?.('focus', onFocus);
      button.removeEventListener?.('keydown', onKeyDown);
    });

    chipElements.push(button);
    chipBar.append(button);
  });

  const onBarKeyDown: CitationEventListener = event => {
    handleKey(event, null);
  };
  chipBar.addEventListener?.('keydown', onBarKeyDown);
  cleanups.push(() => {
    chipBar.removeEventListener?.('keydown', onBarKeyDown);
  });

  if (options.chipContainer) {
    mountSingleChild(options.chipContainer, chipBar);
  }

  return {
    chipBar,
    chipElements,
    overlay,
    cleanedAnswer: model.cleanedAnswer,
    chips: model.chips,
    unresolved: model.unresolved,
    snapshot(): CitationControllerSnapshot {
      const activeChip = activeIndex !== null ? (model.chips[activeIndex] ?? null) : null;
      return {
        activeIndex,
        focusedIndex,
        activeChip,
        chips: model.chips,
        unresolved: model.unresolved,
      };
    },
    select,
    clear,
    handleKeyDown(event: CitationEventLike): boolean {
      return handleKey(event, null);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      activeIndex = null;
      focusedIndex = null;
      clearMountedOverlay();
      clearChildren(chipBar);
      if (options.chipContainer) clearChildren(options.chipContainer);
    },
  };
}

// --- Geometry Helpers ------------------------------------------------------

function readGroundingEntry<K extends string | number>(
  container: ReadonlyMap<K, CitationGroundingInput> | Readonly<Record<K, CitationGroundingInput>>,
  key: K,
): CitationGroundingInput | undefined {
  if (container instanceof Map) {
    return (container as ReadonlyMap<K, CitationGroundingInput>).get(key);
  }
  const record = container as Readonly<Record<string | number, CitationGroundingInput>>;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function lookupGrounding(
  source: CitationGroundingSource | undefined,
  resolved: ResolvedCitation,
): CitationGroundingInput | undefined {
  if (!source) return undefined;
  if (source.byIndex !== undefined) {
    const byIndex = readGroundingEntry(source.byIndex, resolved.index);
    if (byIndex !== undefined) return byIndex;
  }
  if (resolved.blockId !== null && source.byBlockId !== undefined) {
    return readGroundingEntry(source.byBlockId, resolved.blockId);
  }
  return undefined;
}

function geometryFromGrounding(
  input: CitationGroundingInput,
  pageSize: PageSize,
  expectedPage: number,
): CitationPolygonGeometry | null {
  if (Array.isArray(input)) {
    const normQuad = readValidQuad(input, NORMALIZED_COORD_MAX);
    return normQuad === null ? null : buildGeometryFromNormalizedQuad(normQuad, pageSize);
  }

  if (input === null || typeof input !== 'object') return null;

  if (
    input.pageIndex !== undefined &&
    Number.isFinite(input.pageIndex) &&
    input.pageIndex !== expectedPage
  ) {
    return null;
  }

  const space: HighlightCoordinateSpace = 'space' in input && input.space === 'page' ? 'page' : 'normalized';

  if (input.quad !== undefined) {
    if (space === 'page') {
      const pagePoly = clampPagePolygon(input.quad, pageSize);
      if (pagePoly !== null) return buildGeometryFromPagePolygon(pagePoly, pageSize);
    } else {
      const normQuad = readValidQuad(input.quad, NORMALIZED_COORD_MAX);
      if (normQuad !== null) return buildGeometryFromNormalizedQuad(normQuad, pageSize);
    }
  }

  if (input.bbox !== undefined) {
    if (space === 'page') {
      const raw = input.bbox;
      if (Array.isArray(raw) && raw.length === 4 && raw.every(n => typeof n === 'number' && Number.isFinite(n))) {
        const rect: Rect = {
          x: raw[0],
          y: raw[1],
          width: raw[2] - raw[0],
          height: raw[3] - raw[1],
        };
        return buildGeometryFromPageRect(rect, pageSize);
      }
    } else {
      const valid = validateNormalizedBBox(input.bbox, NORMALIZED_COORD_MAX);
      if (valid.ok) {
        return buildGeometryFromNormalizedQuad(bboxToQuad(valid.bbox), pageSize, valid.bbox);
      }
    }
  }

  return null;
}

function buildGeometryFromNormalizedQuad(
  quad: Quad,
  pageSize: PageSize,
  precomputedBBox?: NormalizedBBox,
): CitationPolygonGeometry | null {
  const pagePoly: Polygon = [
    normPointToPage(quad[0], pageSize),
    normPointToPage(quad[1], pageSize),
    normPointToPage(quad[2], pageSize),
    normPointToPage(quad[3], pageSize),
  ];

  const bbox = boundingRectOfPolygon(pagePoly);
  const shape = highlightShape(bbox, pageSize);
  if (shape.rect.width <= 0 || shape.rect.height <= 0) return null;

  const normalizedBBox = precomputedBBox ?? polygonToBBox(quad, NORMALIZED_COORD_MAX);
  const unitPolygon = toUnitPolygon(pagePoly, pageSize);
  return {
    pageSize,
    rect: shape.rect,
    unit: shape.unit,
    polygon: pagePoly,
    unitPolygon,
    quad: copyQuad(quad),
    normalizedBBox,
    svgPoints: formatSvgPoints(pagePoly),
    svgViewBox: formatSvgViewBox(pageSize),
  };
}

function buildGeometryFromPagePolygon(
  polygon: Polygon,
  pageSize: PageSize,
): CitationPolygonGeometry | null {
  const bbox = boundingRectOfPolygon(polygon);
  const shape = highlightShape(bbox, pageSize);
  if (shape.rect.width <= 0 || shape.rect.height <= 0) return null;

  const quad: Quad = [
    pagePointToNorm(polygon[0], pageSize),
    pagePointToNorm(polygon[1], pageSize),
    pagePointToNorm(polygon[2], pageSize),
    pagePointToNorm(polygon[3], pageSize),
  ];
  const normalizedBBox = polygonToBBox(quad, NORMALIZED_COORD_MAX);
  const unitPolygon = toUnitPolygon(polygon, pageSize);

  return {
    pageSize,
    rect: shape.rect,
    unit: shape.unit,
    polygon,
    unitPolygon,
    quad,
    normalizedBBox,
    svgPoints: formatSvgPoints(polygon),
    svgViewBox: formatSvgViewBox(pageSize),
  };
}

function buildGeometryFromPageRect(
  rect: Rect,
  pageSize: PageSize,
): CitationPolygonGeometry | null {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return null;
  }

  const shape = highlightShape(rect, pageSize);
  if (shape.rect.width <= 0 || shape.rect.height <= 0) return null;

  const normalizedBBox = fromPixelBox(shape.rect, pageSize.width, pageSize.height, NORMALIZED_COORD_MAX);
  const quad = bboxToQuad(normalizedBBox);

  return {
    pageSize,
    rect: shape.rect,
    unit: shape.unit,
    polygon: shape.polygon,
    unitPolygon: shape.unitPolygon,
    quad,
    normalizedBBox,
    svgPoints: formatSvgPoints(shape.polygon),
    svgViewBox: formatSvgViewBox(pageSize),
  };
}

function readValidQuad(raw: readonly Point2D[], maxCoord: number): Quad | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [p0, p1, p2, p3] = raw;
  if (!isFinitePoint(p0) || !isFinitePoint(p1) || !isFinitePoint(p2) || !isFinitePoint(p3)) {
    return null;
  }
  return [
    { x: clampRange(p0.x, 0, maxCoord), y: clampRange(p0.y, 0, maxCoord) },
    { x: clampRange(p1.x, 0, maxCoord), y: clampRange(p1.y, 0, maxCoord) },
    { x: clampRange(p2.x, 0, maxCoord), y: clampRange(p2.y, 0, maxCoord) },
    { x: clampRange(p3.x, 0, maxCoord), y: clampRange(p3.y, 0, maxCoord) },
  ];
}

function clampPagePolygon(raw: readonly Point[], pageSize: PageSize): Polygon | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [p0, p1, p2, p3] = raw;
  if (!isFinitePoint(p0) || !isFinitePoint(p1) || !isFinitePoint(p2) || !isFinitePoint(p3)) {
    return null;
  }
  return [
    { x: clampRange(p0.x, 0, pageSize.width), y: clampRange(p0.y, 0, pageSize.height) },
    { x: clampRange(p1.x, 0, pageSize.width), y: clampRange(p1.y, 0, pageSize.height) },
    { x: clampRange(p2.x, 0, pageSize.width), y: clampRange(p2.y, 0, pageSize.height) },
    { x: clampRange(p3.x, 0, pageSize.width), y: clampRange(p3.y, 0, pageSize.height) },
  ];
}

function normPointToPage(pt: Point2D, pageSize: PageSize): Point {
  return {
    x: roundTo((clampRange(pt.x, 0, NORMALIZED_COORD_MAX) / NORMALIZED_COORD_MAX) * pageSize.width, DISPLAY_SCALE),
    y: roundTo((clampRange(pt.y, 0, NORMALIZED_COORD_MAX) / NORMALIZED_COORD_MAX) * pageSize.height, DISPLAY_SCALE),
  };
}

function pagePointToNorm(pt: Point, pageSize: PageSize): Point2D {
  return {
    x: clampRange((pt.x / pageSize.width) * NORMALIZED_COORD_MAX, 0, NORMALIZED_COORD_MAX),
    y: clampRange((pt.y / pageSize.height) * NORMALIZED_COORD_MAX, 0, NORMALIZED_COORD_MAX),
  };
}

function toUnitPolygon(poly: Polygon, pageSize: PageSize): Polygon {
  return [
    { x: roundTo(poly[0].x / pageSize.width, UNIT_SCALE), y: roundTo(poly[0].y / pageSize.height, UNIT_SCALE) },
    { x: roundTo(poly[1].x / pageSize.width, UNIT_SCALE), y: roundTo(poly[1].y / pageSize.height, UNIT_SCALE) },
    { x: roundTo(poly[2].x / pageSize.width, UNIT_SCALE), y: roundTo(poly[2].y / pageSize.height, UNIT_SCALE) },
    { x: roundTo(poly[3].x / pageSize.width, UNIT_SCALE), y: roundTo(poly[3].y / pageSize.height, UNIT_SCALE) },
  ];
}

function boundingRectOfPolygon(poly: Polygon): Rect {
  const xs = [poly[0].x, poly[1].x, poly[2].x, poly[3].x];
  const ys = [poly[0].y, poly[1].y, poly[2].y, poly[3].y];
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: left,
    y: top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  };
}

function copyQuad(quad: Quad): Quad {
  return [
    { x: quad[0].x, y: quad[0].y },
    { x: quad[1].x, y: quad[1].y },
    { x: quad[2].x, y: quad[2].y },
    { x: quad[3].x, y: quad[3].y },
  ];
}

function formatSvgPoints(poly: Polygon): string {
  return poly.map(pt => `${roundTo(pt.x, DISPLAY_SCALE)},${roundTo(pt.y, DISPLAY_SCALE)}`).join(' ');
}

function formatSvgViewBox(pageSize: PageSize): string {
  return `0 0 ${roundTo(pageSize.width, DISPLAY_SCALE)} ${roundTo(pageSize.height, DISPLAY_SCALE)}`;
}

// --- Label & DOM Helpers ---------------------------------------------------

function defaultChipLabel(chip: CitationChipBase): string {
  return chip.blockId !== null ? `p.${chip.page} · ${chip.blockId}` : `p.${chip.page}`;
}

function defaultChipAriaLabel(chip: CitationChipBase): string {
  return chip.blockId !== null
    ? `Page ${chip.page}, block ${chip.blockId}`
    : `Page ${chip.page}`;
}

function resolveDocument(dom?: CitationDocument): CitationDocument {
  if (dom) return dom;
  const globalDocument = (globalThis as { document?: CitationDocument }).document;
  if (!globalDocument) throw new Error('citation-highlight needs a DOM document');
  return globalDocument;
}

function createOverlayLayer(doc: CitationDocument): CitationElement {
  const layer = doc.createElement('div');
  setElementClass(layer, CLASS.layer);
  layer.setAttribute('aria-hidden', 'true');
  return layer;
}

function createSvgElement(doc: CitationDocument, tagName: string): CitationElement {
  return typeof doc.createElementNS === 'function'
    ? doc.createElementNS(SVG_NAMESPACE, tagName)
    : doc.createElement(tagName);
}

function setElementClass(element: CitationElement, className: string): void {
  element.setAttribute('class', className);
}

function applyPercentBoxStyle(box: CitationElement, unit: Rect): void {
  const left = formatPercent(unit.x);
  const top = formatPercent(unit.y);
  const width = formatPercent(unit.width);
  const height = formatPercent(unit.height);

  if (box.style) {
    box.style.left = left;
    box.style.top = top;
    box.style.width = width;
    box.style.height = height;
    return;
  }
  box.setAttribute('style', `left:${left};top:${top};width:${width};height:${height};`);
}

function formatPercent(fraction: number): string {
  const clamped = clampRange(Number.isFinite(fraction) ? fraction : 0, 0, 1);
  return `${roundTo(clamped * 100, DISPLAY_SCALE)}%`;
}

function clearChildren(element: CitationElement): void {
  if (typeof element.replaceChildren === 'function') {
    element.replaceChildren();
    return;
  }
  element.textContent = '';
}

function mountSingleChild(parent: CitationElement, child: CitationElement): void {
  if (typeof parent.replaceChildren === 'function') {
    parent.replaceChildren(child);
    return;
  }
  clearChildren(parent);
  parent.append(child);
}

function resolvePageContainer(
  resolver: PageContainerResolver,
  page: number,
): CitationElement | null | undefined {
  return typeof resolver === 'function' ? resolver(page) : resolver.get(page);
}

function indexOfChipTarget(chipElements: readonly CitationElement[], target: unknown): number | null {
  if (target === undefined || target === null) return null;
  const idx = chipElements.indexOf(target as CitationElement);
  return idx >= 0 ? idx : null;
}

function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const record = target as { tagName?: unknown; isContentEditable?: unknown };
  if (record.isContentEditable === true) return true;
  const tag = typeof record.tagName === 'string' ? record.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function isFinitePoint(point: Point2D | undefined): point is Point2D {
  return point !== undefined && point !== null && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundTo(value: number, scale: number): number {
  return Number.isFinite(value) ? Math.round(value * scale) / scale : 0;
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
