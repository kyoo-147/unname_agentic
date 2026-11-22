import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GUTTER,
  DEFAULT_MAX_BANDS,
  DEFAULT_RAIL_WIDTH,
  READING_MODES,
  ReadingModeError,
  isReadingMode,
  layoutFor,
  offsetToPage,
  pageExtent,
  pageToOffset,
  positionAfterModeChange,
  READER_MODES,
  ReaderModeSession,
  geometryModeForReaderMode,
  resolveReaderMode,
} from '../viewer/src/core/reading-modes';
import type { Pane, PaneRole, ReadingLayout, ReadingMode, Viewport } from '../viewer/src/core/reading-modes';

/** Float slack for comparing pane edges, in pixels. */
const REL = 1e-9;

const VIEWPORT: Viewport = { width: 1200, height: 800 };

/** Portrait, square, landscape, plus the edges of the documented aspect band. */
const ASPECTS = [0.4, 0.7, 1, 1.4, 2.4, 3];

const VIEWPORTS: Viewport[] = [VIEWPORT, { width: 375, height: 667 }, { width: 2560, height: 1080 }];

function paneOf(layout: ReadingLayout, role: PaneRole): Pane {
  const pane = layout.panes.find(candidate => candidate.role === role);
  if (pane === undefined) throw new Error(`layout ${layout.mode} has no ${role} pane`);
  return pane;
}

function panesOf(layout: ReadingLayout, role: PaneRole): Pane[] {
  return layout.panes.filter(candidate => candidate.role === role);
}

function overlapArea(a: Pane, b: Pane): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > REL && height > REL ? width * height : 0;
}

/** Every pane stays inside the viewport, no two overlap, and the areas add up to it. */
function expectFillsViewport(layout: ReadingLayout, viewport: Viewport): void {
  expect(layout.panes.length).toBeGreaterThan(0);
  for (const pane of layout.panes) {
    expect(pane.width).toBeGreaterThan(0);
    expect(pane.height).toBeGreaterThan(0);
    expect(pane.x).toBeGreaterThanOrEqual(-REL);
    expect(pane.y).toBeGreaterThanOrEqual(-REL);
    expect(pane.x + pane.width).toBeLessThanOrEqual(viewport.width + REL);
    expect(pane.y + pane.height).toBeLessThanOrEqual(viewport.height + REL);
  }

  if (layout.mode === 'overlay') {
    // Overlay mode fills by coincidence, not by tiling: both panes are the viewport.
    for (const pane of layout.panes) {
      expect({ x: pane.x, y: pane.y, width: pane.width, height: pane.height }).toEqual({
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
      });
    }
    return;
  }

  for (let first = 0; first < layout.panes.length; first += 1) {
    for (let second = first + 1; second < layout.panes.length; second += 1) {
      const a = layout.panes[first];
      const b = layout.panes[second];
      if (a === undefined || b === undefined) continue;
      expect(overlapArea(a, b)).toBe(0);
    }
  }

  // The gutter is the one gap a layout may leave; nothing else may be uncovered.
  const gutter = layout.mode === 'side-by-side' ? DEFAULT_GUTTER : 0;
  const covered = layout.panes.reduce((total, pane) => total + pane.width * pane.height, 0);
  expect(covered + gutter * viewport.height).toBeCloseTo(viewport.width * viewport.height, 6);
}

function captureError(run: () => unknown): ReadingModeError {
  try {
    run();
  } catch (error) {
    if (error instanceof ReadingModeError) return error;
    throw error;
  }
  throw new Error('expected a ReadingModeError');
}

describe('layoutFor', () => {
  it('recognises exactly the four modes', () => {
    expect(READING_MODES).toEqual(['side-by-side', 'overlay', 'interleaved', 'reflow']);
    for (const mode of READING_MODES) expect(isReadingMode(mode)).toBe(true);
    for (const value of ['split', 'sidebyside', 'side_by_side', '', null, undefined, 2]) {
      expect(isReadingMode(value)).toBe(false);
    }
  });

  it('fills the viewport exactly for every mode and page shape', () => {
    for (const mode of READING_MODES) {
      for (const viewport of VIEWPORTS) {
        for (const aspect of ASPECTS) {
          expectFillsViewport(layoutFor(mode, viewport, aspect), viewport);
        }
      }
    }
  });

  it('splits the width with a 1 px gutter and equal panes', () => {
    const layout = layoutFor('side-by-side', VIEWPORT, 0.7);
    expect(layout.panes).toEqual([
      { role: 'source', x: 0, y: 0, width: 599.5, height: 800 },
      { role: 'translation', x: 600.5, y: 0, width: 599.5, height: 800 },
    ]);
    const source = paneOf(layout, 'source');
    const translation = paneOf(layout, 'translation');
    expect(translation.x - (source.x + source.width)).toBe(1);
    expect(translation.width).toBeCloseTo(source.width, 9);
    expect(layout.scroll).toBe('linked');
    expect(layout.overlays).toEqual([]);
  });

  it('keeps one full-size pane and puts the translation exactly on top', () => {
    for (const aspect of ASPECTS) {
      const layout = layoutFor('overlay', VIEWPORT, aspect);
      expect(paneOf(layout, 'source')).toEqual({
        role: 'source',
        x: 0,
        y: 0,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
      });
      expect(paneOf(layout, 'translation')).toEqual({
        role: 'translation',
        x: 0,
        y: 0,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
      });
      expect(layout.overlays).toEqual([
        { role: 'translation', x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, opacity: 1, z: 1 },
      ]);
      expect(layout.scroll).toBe('linked');
    }

    const translucent = layoutFor('overlay', VIEWPORT, 1, { overlayOpacity: 0.6 });
    expect(translucent.panes.length).toBe(2);
    expect(translucent.overlays[0]?.opacity).toBe(0.6);
  });

  it('stacks equal paired bands that cover the height', () => {
    const portrait = layoutFor('interleaved', VIEWPORT, 0.7);
    expect(portrait.panes).toEqual([{ role: 'paired', x: 0, y: 0, width: 1200, height: 800 }]);

    const landscape = layoutFor('interleaved', VIEWPORT, 3);
    expect(landscape.panes).toEqual([
      { role: 'paired', x: 0, y: 0, width: 1200, height: 400 },
      { role: 'paired', x: 0, y: 400, width: 1200, height: 400 },
    ]);

    const three = layoutFor('interleaved', { width: 1200, height: 1200 }, 3);
    expect(three.panes.length).toBe(3);
    for (const band of three.panes) expect(band.height).toBeCloseTo(400, 9);

    const capped = layoutFor('interleaved', { width: 1200, height: 1600 }, 3);
    expect(capped.panes.length).toBe(DEFAULT_MAX_BANDS);
    expect(layoutFor('interleaved', VIEWPORT, 3).scroll).toBe('linked');
  });

  it('leaves no seam between bands and ends exactly at the bottom', () => {
    for (const height of [800, 813, 1200, 1600]) {
      const layout = layoutFor('interleaved', { width: 1200, height }, 3);
      const bands = panesOf(layout, 'paired');
      expect(bands.length).toBeGreaterThan(1);
      let cursor = 0;
      for (const band of bands) {
        expect(band.x).toBe(0);
        expect(band.width).toBe(1200);
        expect(band.y).toBeCloseTo(cursor, 9);
        cursor = band.y + band.height;
      }
      expect(cursor).toBeCloseTo(height, 9);
    }
  });

  it('respects the documented rail width in reflow mode', () => {
    const layout = layoutFor('reflow', VIEWPORT, 0.7);
    expect(layout.panes).toEqual([
      { role: 'source', x: 0, y: 0, width: DEFAULT_RAIL_WIDTH, height: 800 },
      { role: 'translation', x: DEFAULT_RAIL_WIDTH, y: 0, width: 1200 - DEFAULT_RAIL_WIDTH, height: 800 },
    ]);
    expect(layout.scroll).toBe('independent');

    expect(paneOf(layoutFor('reflow', VIEWPORT, 0.7, { railWidth: 72 }), 'source').width).toBe(72);

    const mirrored = layoutFor('reflow', VIEWPORT, 0.7, { railSide: 'right' });
    expect(paneOf(mirrored, 'source')).toEqual({ role: 'source', x: 1104, y: 0, width: 96, height: 800 });
    expect(paneOf(mirrored, 'translation')).toEqual({
      role: 'translation',
      x: 0,
      y: 0,
      width: 1104,
      height: 800,
    });

    // A narrow viewport shrinks the rail instead of letting it swallow the column.
    const narrow = layoutFor('reflow', { width: 80, height: 400 }, 0.7);
    expect(paneOf(narrow, 'source').width).toBe(79);
    expect(paneOf(narrow, 'translation').width).toBe(1);
  });

  it('links the scroll of the paired modes and keeps reflow independent', () => {
    expect(layoutFor('side-by-side', VIEWPORT, 1).scroll).toBe('linked');
    expect(layoutFor('overlay', VIEWPORT, 1).scroll).toBe('linked');
    expect(layoutFor('interleaved', VIEWPORT, 1).scroll).toBe('linked');
    expect(layoutFor('reflow', VIEWPORT, 1).scroll).toBe('independent');
  });

  it('is a pure planner: the same request returns the same layout', () => {
    for (const mode of READING_MODES) {
      expect(layoutFor(mode, VIEWPORT, 1.3)).toEqual(layoutFor(mode, VIEWPORT, 1.3));
    }
  });

  it('refuses an unknown mode with a typed error', () => {
    const error = captureError(() => layoutFor('fisheye' as ReadingMode, VIEWPORT, 1));
    expect(error.name).toBe('ReadingModeError');
    expect(error.code).toBe('unknown-mode');
    expect(error.message).toContain('fisheye');

    const geometry = { viewport: VIEWPORT, pageAspect: 1 };
    expect(
      captureError(() =>
        positionAfterModeChange('overlay', 'fisheye' as ReadingMode, { page: 2, progress: 0.5 }, geometry),
      ).code,
    ).toBe('unknown-mode');
    expect(
      captureError(() =>
        positionAfterModeChange('fisheye' as ReadingMode, 'overlay', { page: 2, progress: 0.5 }, geometry),
      ).code,
    ).toBe('unknown-mode');
  });

  it('refuses a viewport or page aspect it cannot lay out', () => {
    for (const viewport of [
      { width: 0, height: 800 },
      { width: 1200, height: -1 },
      { width: Number.NaN, height: 800 },
    ]) {
      expect(captureError(() => layoutFor('overlay', viewport, 1)).code).toBe('invalid-viewport');
    }
    for (const aspect of [0, -1, Number.NaN]) {
      expect(captureError(() => layoutFor('overlay', VIEWPORT, aspect)).code).toBe('invalid-page-aspect');
    }
  });
});

describe('scroll offsets', () => {
  const aspect = 0.7;

  it('derives one page of scroll from the pane that shows the page', () => {
    expect(pageExtent(layoutFor('side-by-side', VIEWPORT, aspect), aspect)).toBeCloseTo(599.5 / aspect, 9);
    expect(pageExtent(layoutFor('overlay', VIEWPORT, aspect), aspect)).toBeCloseTo(1200 / aspect, 9);
    expect(pageExtent(layoutFor('reflow', VIEWPORT, aspect), aspect)).toBeCloseTo(1104 / aspect, 9);
    expect(pageExtent(layoutFor('reflow', VIEWPORT, aspect, { railWidth: 72 }), aspect)).toBeCloseTo(
      1128 / aspect,
      9,
    );
    // Interleaved re-flows fragments, so a page pair advances one viewport of bands.
    expect(pageExtent(layoutFor('interleaved', VIEWPORT, aspect), aspect)).toBe(800);
  });

  it('round-trips an offset through its reading position', () => {
    for (const mode of READING_MODES) {
      for (const shape of [0.7, 2.4]) {
        const layout = layoutFor(mode, VIEWPORT, shape);
        const extent = pageExtent(layout, shape);
        const offsets = [0, 1, 137.25, extent * 0.37, extent * 2, extent * 3 + 0.61 * extent, 12345.678];
        for (const offset of offsets) {
          const position = offsetToPage(layout, shape, offset);
          expect(pageToOffset(layout, shape, position)).toBeCloseTo(offset, 6);
        }
      }
    }
  });

  it('clamps positions instead of refusing them', () => {
    const layout = layoutFor('side-by-side', VIEWPORT, aspect);
    const extent = pageExtent(layout, aspect);

    expect(pageToOffset(layout, aspect, { page: 0, progress: -0.5 })).toBe(0);
    expect(pageToOffset(layout, aspect, { page: 2.9, progress: 0 })).toBeCloseTo(extent, 6);
    expect(pageToOffset(layout, aspect, { page: 2, progress: 1.5 })).toBeCloseTo(2 * extent, 6);
    expect(pageToOffset(layout, aspect, { page: Number.NaN, progress: Number.NaN })).toBe(0);
    expect(offsetToPage(layout, aspect, -40)).toEqual({ page: 1, progress: 0 });
    expect(offsetToPage(layout, aspect, Number.POSITIVE_INFINITY)).toEqual({ page: 1, progress: 0 });
  });

  it('keeps the page and the progress within 1% across every mode change', () => {
    const position = { page: 4, progress: 0.42 };
    const geometry = { viewport: VIEWPORT, pageAspect: aspect };

    for (const from of READING_MODES) {
      for (const to of READING_MODES) {
        const change = positionAfterModeChange(from, to, position, geometry);
        expect(change.from).toBe(from);
        expect(change.to).toBe(to);
        expect(change.page).toBe(position.page);
        expect(Math.abs(change.progress - position.progress)).toBeLessThanOrEqual(0.01);

        const target = layoutFor(to, VIEWPORT, aspect);
        expect(change.offset).toBeCloseTo(pageToOffset(target, aspect, position), 9);
        expect(change.pageTop).toBeCloseTo(3 * pageExtent(target, aspect), 9);

        const back = offsetToPage(target, aspect, change.offset);
        expect(back.page).toBe(position.page);
        expect(Math.abs(back.progress - position.progress)).toBeLessThanOrEqual(0.01);
      }
    }
  });

  it('moves the offset when the target mode scrolls pages differently', () => {
    const geometry = { viewport: VIEWPORT, pageAspect: aspect };
    const position = { page: 4, progress: 0.42 };

    const toSideBySide = positionAfterModeChange('overlay', 'side-by-side', position, geometry);
    expect(toSideBySide.fromOffset).toBeCloseTo((3 + 0.42) * (1200 / aspect), 6);
    expect(toSideBySide.offset).toBeCloseTo((3 + 0.42) * (599.5 / aspect), 6);
    expect(toSideBySide.offset).toBeLessThan(toSideBySide.fromOffset);

    const toInterleaved = positionAfterModeChange('overlay', 'interleaved', position, geometry);
    expect(toInterleaved.offset).toBeCloseTo((3 + 0.42) * 800, 6);
    expect(toInterleaved.pageTop).toBeCloseTo(3 * 800, 6);
  });
});

describe('semantic reader modes', () => {
  it('keeps unavailable translation modes explicit instead of falling back', () => {
    expect(READER_MODES).toEqual(['original', 'translation', 'bilingual', 'interleave']);
    expect(resolveReaderMode('original', { sourceAvailable: true, translation: 'missing' })).toMatchObject({ available: true, status: 'available' });
    expect(resolveReaderMode('bilingual', { sourceAvailable: true, translation: 'missing' })).toMatchObject({ available: false, status: 'missing-translation' });
    expect(resolveReaderMode('translation', { sourceAvailable: true, translation: 'unsupported' })).toMatchObject({ available: false, status: 'unsupported' });
  });

  it('preserves page and anchor when a supported mode changes', () => {
    const session = new ReaderModeSession({
      documentId: 'doc-1',
      sourceSha256: 'a'.repeat(64),
      generation: 2,
      mode: 'original',
      position: { page: 3, progress: 0.42, anchorId: 'p3-r4' },
    }, { sourceAvailable: true, translation: 'available' });
    const change = session.setMode('bilingual');
    expect(change.changed).toBe(true);
    expect(change.state.position).toEqual({ page: 3, progress: 0.42, anchorId: 'p3-r4' });
    expect(geometryModeForReaderMode('bilingual')).toBe('side-by-side');
    expect(geometryModeForReaderMode('interleave')).toBe('interleaved');
  });

  it('reports unsupported interleave without changing the current mode', () => {
    const session = new ReaderModeSession({
      documentId: 'doc-1', sourceSha256: 'b'.repeat(64), generation: 1, mode: 'original', position: { page: 1, progress: 0 },
    }, { sourceAvailable: true, translation: 'available', interleaveSupported: false });
    const result = session.setMode('interleave');
    expect(result.changed).toBe(false);
    expect(result.resolution.status).toBe('unsupported');
    expect(session.snapshot().mode).toBe('original');
  });
});
