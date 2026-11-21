import { describe, expect, it } from 'vitest';
import { buildDocument, type DocumentIR } from '../src/core/ir';
import {
  DEFAULT_INTENSITY_THRESHOLD,
  DEFAULT_MIN_COMPONENT_AREA,
  VisualDiffError,
  diffDocumentVersions,
  diffPageImages,
  pointsRectToPixelMask,
  type RgbaImage,
} from '../src/core/visual-diff';

type Rgb = readonly [number, number, number, number?];

/** Creates an opaque solid RGBA canvas for test fixtures. */
function makeCanvas(width: number, height: number, fill: Rgb = [255, 255, 255, 255]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const [r, g, b, a = 255] = fill;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { data, width, height };
}

/** Clones an RGBA image so mutations never leak across assertions. */
function cloneCanvas(img: RgbaImage): RgbaImage {
  return {
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.data),
  };
}

/** Paints an axis-aligned rectangle `[x, x + w) x [y, y + h)` on a canvas. */
function paintRect(
  img: RgbaImage,
  x: number,
  y: number,
  w: number,
  h: number,
  color: Rgb,
): void {
  const [r, g, b, a = 255] = color;
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const idx = (py * img.width + px) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = a;
    }
  }
}

/** Paints a single pixel at `(x, y)`. */
function paintPixel(img: RgbaImage, x: number, y: number, color: Rgb): void {
  paintRect(img, x, y, 1, 1, color);
}

/** Builds a realistic DocumentIR with pages sized in PDF points (612x792). */
function makeDoc(
  blocks: readonly { page: number; text: string; x: number; y: number; width: number; height: number }[],
  pages: readonly { index: number; width?: number; height?: number }[],
): DocumentIR {
  return buildDocument({
    sourceSha256: 'b'.repeat(64),
    pages: pages.map(p => ({ index: p.index, width: p.width ?? 612, height: p.height ?? 792 })),
    blocks: blocks.map(b => ({
      page: b.page,
      text: b.text,
      rect: { x: b.x, y: b.y, width: b.width, height: b.height },
    })),
  });
}

describe('diffPageImages', () => {
  it('reports identical RGBA buffers as identical with SSIM 1 and no changed regions', () => {
    const a = makeCanvas(40, 40, [245, 245, 245]);
    paintRect(a, 8, 10, 16, 6, [20, 20, 20]);
    const b = cloneCanvas(a);

    const diff = diffPageImages(a, b);

    expect(diff.status).toBe('identical');
    expect(diff.identical).toBe(true);
    expect(diff.dimensionMismatch).toBe(false);
    expect(diff.width).toBe(40);
    expect(diff.height).toBe(40);
    expect(diff.totalPixels).toBe(1600);
    expect(diff.maskedPixelCount).toBe(0);
    expect(diff.comparedPixelCount).toBe(1600);
    expect(diff.changedPixelCount).toBe(0);
    expect(diff.changedPixelRatio).toBe(0);
    expect(diff.ssim).toBe(1);
    expect(diff.minWindowSsim).toBe(1);
    expect(diff.changedRegions).toEqual([]);
  });

  it('extracts connected-component bounding boxes in reading order for changed regions', () => {
    const a = makeCanvas(64, 64, [255, 255, 255]);
    const b = cloneCanvas(a);
    // Paint two separate changes: bottom-right first, top-left second, to verify sorting.
    paintRect(b, 40, 44, 12, 8, [0, 0, 0]); // 96 px
    paintRect(b, 6, 8, 10, 5, [0, 0, 0]); // 50 px

    const diff = diffPageImages(a, b);

    expect(diff.status).toBe('changed');
    expect(diff.identical).toBe(false);
    expect(diff.changedPixelCount).toBe(146);
    expect(diff.changedPixelRatio).toBeCloseTo(146 / (64 * 64), 6);
    expect(diff.changedRegions).toHaveLength(2);
    expect(diff.changedRegions[0]?.rect).toEqual({ x: 6, y: 8, width: 10, height: 5 });
    expect(diff.changedRegions[0]?.pixelCount).toBe(50);
    expect(diff.changedRegions[0]?.fillRatio).toBe(1);
    expect(diff.changedRegions[1]?.rect).toEqual({ x: 40, y: 44, width: 12, height: 8 });
    expect(diff.changedRegions[1]?.pixelCount).toBe(96);
    expect(diff.ssim).toBeLessThan(1);
    expect(diff.minWindowSsim).toBeLessThan(diff.ssim);
  });

  it('detects chromatic color swaps even when Rec.601 luminance is identical', () => {
    // Red (255, 0, 0) luma ≈ 76.245; green (0, 130, 0) luma ≈ 76.310 (within 1 luma count).
    const a = makeCanvas(32, 32, [255, 255, 255]);
    const b = cloneCanvas(a);
    paintRect(a, 10, 10, 8, 8, [255, 0, 0]);
    paintRect(b, 10, 10, 8, 8, [0, 130, 0]);

    const diff = diffPageImages(a, b);

    expect(diff.status).toBe('changed');
    expect(diff.changedRegions).toHaveLength(1);
    expect(diff.changedRegions[0]?.rect).toEqual({ x: 10, y: 10, width: 8, height: 8 });
    expect(diff.changedRegions[0]?.maxDelta).toBe(255);
  });

  it('computes lower SSIM for heavy structural edits than for minor localized edits', () => {
    const base = makeCanvas(48, 48, [255, 255, 255]);
    paintRect(base, 4, 4, 40, 6, [30, 30, 30]);
    paintRect(base, 4, 20, 40, 6, [30, 30, 30]);

    const minorEdit = cloneCanvas(base);
    paintRect(minorEdit, 10, 34, 6, 4, [30, 30, 30]);

    const majorEdit = makeCanvas(48, 48, [20, 20, 20]);

    const minorDiff = diffPageImages(base, minorEdit);
    const majorDiff = diffPageImages(base, majorEdit);

    expect(minorDiff.ssim).toBeGreaterThan(0.8);
    expect(minorDiff.ssim).toBeLessThan(1);
    expect(majorDiff.ssim).toBeLessThan(0.1);
    expect(majorDiff.ssim).toBeLessThan(minorDiff.ssim);
  });

  it('excludes dynamic zones such as timestamps and watermarks via exclusionMasks', () => {
    const a = makeCanvas(60, 60, [255, 255, 255]);
    const b = cloneCanvas(a);
    // Dynamic header timestamp changes completely inside mask.
    paintRect(a, 4, 2, 20, 8, [10, 10, 10]);
    paintRect(b, 4, 2, 20, 8, [240, 20, 20]);

    const diff = diffPageImages(a, b, {
      exclusionMasks: [{ x: 4, y: 2, width: 20, height: 8, label: 'timestamp' }],
    });

    expect(diff.status).toBe('identical');
    expect(diff.identical).toBe(true);
    expect(diff.maskedPixelCount).toBe(160);
    expect(diff.comparedPixelCount).toBe(3600 - 160);
    expect(diff.changedPixelCount).toBe(0);
    expect(diff.changedRegions).toEqual([]);
    expect(diff.ssim).toBe(1);
  });

  it('filters isolated OCR speckles and subtle intensity jitter while keeping real edits', () => {
    const a = makeCanvas(48, 48, [250, 250, 250]);
    const b = cloneCanvas(a);

    // Sub-threshold intensity jitter across a strip (delta <= DEFAULT_INTENSITY_THRESHOLD).
    paintRect(b, 2, 2, 20, 4, [
      250 - DEFAULT_INTENSITY_THRESHOLD,
      250 - DEFAULT_INTENSITY_THRESHOLD,
      250 - DEFAULT_INTENSITY_THRESHOLD,
    ]);

    // Scattered 1px and 2px dust specks (< DEFAULT_MIN_COMPONENT_AREA = 4).
    paintPixel(b, 10, 20, [0, 0, 0]);
    paintPixel(b, 25, 25, [0, 0, 0]);
    paintPixel(b, 26, 25, [0, 0, 0]);

    const noisyDiff = diffPageImages(a, b);
    expect(noisyDiff.status).toBe('identical');
    expect(noisyDiff.changedRegions).toEqual([]);
    expect(noisyDiff.changedPixelCount).toBe(0);
    expect(noisyDiff.rawChangedPixelCount).toBe(3);
    expect(noisyDiff.suppressedSpecklePixelCount).toBe(3);

    // Add a real 2x3 patch (6 pixels >= DEFAULT_MIN_COMPONENT_AREA).
    paintRect(b, 30, 30, 2, 3, [0, 0, 0]);
    const realDiff = diffPageImages(a, b);
    expect(realDiff.status).toBe('changed');
    expect(realDiff.changedRegions).toHaveLength(1);
    expect(realDiff.changedRegions[0]?.rect).toEqual({ x: 30, y: 30, width: 2, height: 3 });
    expect(realDiff.changedPixelCount).toBe(6);
    expect(realDiff.suppressedSpecklePixelCount).toBe(3);
  });

  it('suppresses 1px OCR edge jitter when subpixelJitterRadius is 1 while catching real blocks', () => {
    const a = makeCanvas(40, 40, [255, 255, 255]);
    const b = makeCanvas(40, 40, [255, 255, 255]);
    // Existing glyph bar shifted right by 1px: (10..15) vs (11..16).
    paintRect(a, 10, 10, 6, 10, [0, 0, 0]);
    paintRect(b, 11, 10, 6, 10, [0, 0, 0]);

    const strictDiff = diffPageImages(a, b);
    expect(strictDiff.status).toBe('changed');
    expect(strictDiff.changedPixelCount).toBe(20);

    const jitterTolerantDiff = diffPageImages(a, b, { subpixelJitterRadius: 1 });
    expect(jitterTolerantDiff.status).toBe('identical');
    expect(jitterTolerantDiff.changedRegions).toEqual([]);

    // Adding a genuinely new 4x4 block at (28, 28) is still caught under subpixelJitterRadius: 1.
    paintRect(b, 28, 28, 4, 4, [0, 0, 0]);
    const realAdded = diffPageImages(a, b, { subpixelJitterRadius: 1 });
    expect(realAdded.status).toBe('changed');
    expect(realAdded.changedRegions).toHaveLength(1);
    expect(realAdded.changedRegions[0]?.rect).toEqual({ x: 28, y: 28, width: 4, height: 4 });
  });

  it('merges nearby changed components when mergeDistance is set', () => {
    const a = makeCanvas(50, 50, [255, 255, 255]);
    const b = cloneCanvas(a);
    // Two 4x4 glyphs separated by a 2px gap at x=14..15.
    paintRect(b, 10, 10, 4, 4, [0, 0, 0]);
    paintRect(b, 16, 10, 4, 4, [0, 0, 0]);

    const unmerged = diffPageImages(a, b);
    expect(unmerged.changedRegions).toHaveLength(2);

    const merged = diffPageImages(a, b, { mergeDistance: 2 });
    expect(merged.changedRegions).toHaveLength(1);
    expect(merged.changedRegions[0]?.rect).toEqual({ x: 10, y: 10, width: 10, height: 4 });
    expect(merged.changedRegions[0]?.pixelCount).toBe(32);
  });

  it('handles dimension mismatches according to report, throw, and resample policies', () => {
    const small = makeCanvas(20, 20, [255, 255, 255]);
    paintRect(small, 4, 4, 6, 6, [0, 0, 0]);

    const larger = makeCanvas(40, 40, [255, 255, 255]);
    paintRect(larger, 8, 8, 12, 12, [0, 0, 0]);

    const reported = diffPageImages(small, larger);
    expect(reported.status).toBe('dimension-mismatch');
    expect(reported.dimensionMismatch).toBe(true);
    expect(reported.identical).toBe(false);
    expect(reported.beforeDimensions).toEqual({ width: 20, height: 20 });
    expect(reported.afterDimensions).toEqual({ width: 40, height: 40 });
    expect(reported.width).toBe(40);
    expect(reported.height).toBe(40);
    expect(reported.ssim).toBe(0);
    expect(reported.changedRegions.length).toBeGreaterThanOrEqual(1);

    expect(() => diffPageImages(small, larger, { onDimensionMismatch: 'throw' })).toThrowError(
      VisualDiffError,
    );
    try {
      diffPageImages(small, larger, { onDimensionMismatch: 'throw' });
    } catch (err) {
      expect(err).toBeInstanceOf(VisualDiffError);
      expect((err as VisualDiffError).code).toBe('dimension-mismatch');
    }

    const resampled = diffPageImages(small, larger, { onDimensionMismatch: 'resample' });
    expect(resampled.dimensionMismatch).toBe(true);
    expect(resampled.resampled).toBe(true);
    expect(resampled.width).toBe(20);
    expect(resampled.height).toBe(20);
    expect(resampled.ssim).toBeGreaterThan(0.95);
    expect(resampled.changedRegions).toEqual([]);
  });

  it('rejects invalid image dimensions or short buffers with VisualDiffError', () => {
    const badSize: RgbaImage = { data: new Uint8ClampedArray(0), width: 0, height: 10 };
    const shortBuf: RgbaImage = { data: new Uint8ClampedArray(12), width: 4, height: 4 };
    const good = makeCanvas(4, 4);

    expect(() => diffPageImages(badSize, good)).toThrowError(VisualDiffError);
    expect(() => diffPageImages(good, shortBuf)).toThrowError(VisualDiffError);
    expect(() =>
      diffPageImages(good, good, { minComponentArea: 0 }),
    ).toThrowError(VisualDiffError);
  });
});

describe('diffDocumentVersions', () => {
  it('combines text diffs from diffDocuments with per-page visual diffs and block coordinates', () => {
    // Page size 612x792 points, rendered at 1/6 scale = 102x132 pixels.
    const pageW = 612;
    const pageH = 792;
    const imgW = 102;
    const imgH = 132;

    const beforeDoc = makeDoc(
      [
        {
          page: 1,
          text: 'The quick brown fox jumps over the lazy dog in chapter one.',
          x: 60,
          y: 120,
          width: 300,
          height: 36,
        },
        {
          page: 2,
          text: 'Figure 2 shows the unchanged diagram caption below.',
          x: 60,
          y: 60,
          width: 300,
          height: 24,
        },
      ],
      [{ index: 1, width: pageW, height: pageH }, { index: 2, width: pageW, height: pageH }],
    );

    const afterDoc = makeDoc(
      [
        {
          page: 1,
          text: 'The quick brown fox leaps over the lazy dog in chapter one.',
          x: 60,
          y: 120,
          width: 300,
          height: 36,
        },
        {
          page: 2,
          text: 'Figure 2 shows the unchanged diagram caption below.',
          x: 60,
          y: 60,
          width: 300,
          height: 24,
        },
      ],
      [{ index: 1, width: pageW, height: pageH }, { index: 2, width: pageW, height: pageH }],
    );

    const p1Before = makeCanvas(imgW, imgH, [255, 255, 255]);
    const p1After = cloneCanvas(p1Before);
    // Visual edit inside block 1 area: points (60..360, 120..156) -> pixels (10..60, 20..26).
    paintRect(p1After, 15, 21, 12, 4, [0, 0, 0]);
    // Dynamic timestamp at top-right masked out.
    paintRect(p1After, 80, 2, 18, 6, [200, 0, 0]);

    const p2Before = makeCanvas(imgW, imgH, [255, 255, 255]);
    const p2After = cloneCanvas(p2Before);
    // Page 2 has NO text diff, only a visual graphic change at (20, 70, 24, 18).
    paintRect(p2After, 20, 70, 24, 18, [20, 80, 180]);

    const timestampMask = pointsRectToPixelMask(
      { x: 480, y: 12, width: 108, height: 36 },
      { width: pageW, height: pageH },
      { width: imgW, height: imgH },
      'timestamp',
    );
    expect(timestampMask).toEqual({ x: 80, y: 2, width: 18, height: 6, label: 'timestamp' });

    const combined = diffDocumentVersions(
      { document: beforeDoc, pageImages: new Map([[1, p1Before], [2, p2Before]]) },
      { document: afterDoc, pageImages: new Map([[1, p1After], [2, p2After]]) },
      { pageMasks: { 1: [timestampMask] } },
    );

    expect(combined.summary.text).toEqual({
      added: 0,
      removed: 0,
      changed: 1,
      moved: 0,
      unchanged: 1,
    });
    expect(combined.summary.visual).toMatchObject({
      pagesCompared: 2,
      pagesIdentical: 0,
      pagesVisuallyChanged: 2,
      pagesAdded: 0,
      pagesRemoved: 0,
      pagesDimensionMismatch: 0,
      pagesUnavailable: 0,
      totalChangedRegions: 2,
    });
    expect(combined.summary.hasChanges).toBe(true);

    const page1 = combined.pages[0];
    const page2 = combined.pages[1];
    expect(page1?.page).toBe(1);
    expect(page1?.changeCategory).toBe('both');
    expect(page1?.visual.status).toBe('changed');
    expect(page1?.visual.pointRegions).toEqual([{ x: 90, y: 126, width: 72, height: 24 }]);
    expect(page1?.correlatedChanges).toHaveLength(1);
    expect(page1?.correlatedChanges[0]?.visualRegionIndices).toEqual([0]);
    expect(page1?.unlinkedVisualRegions).toEqual([]);

    expect(page2?.page).toBe(2);
    expect(page2?.changeCategory).toBe('visual-only');
    expect(page2?.text.changes).toEqual([]);
    expect(page2?.visual.status).toBe('changed');
    expect(page2?.unlinkedVisualRegions).toHaveLength(1);
    expect(page2?.visual.pointRegions).toEqual([{ x: 120, y: 420, width: 144, height: 108 }]);
  });

  it('tracks added, removed, and unavailable page images cleanly', () => {
    const doc1 = makeDoc(
      [{ page: 1, text: 'Page one stays untouched.', x: 50, y: 50, width: 200, height: 20 }],
      [{ index: 1 }, { index: 2 }],
    );
    const doc2 = makeDoc(
      [
        { page: 1, text: 'Page one stays untouched.', x: 50, y: 50, width: 200, height: 20 },
        { page: 3, text: 'Appended page three.', x: 50, y: 50, width: 200, height: 20 },
      ],
      [{ index: 1 }, { index: 3 }],
    );

    const p1 = makeCanvas(24, 24, [255, 255, 255]);
    const p3 = makeCanvas(24, 24, [240, 240, 240]);

    const combined = diffDocumentVersions(
      { document: doc1, pageImages: { 1: p1 } },
      { document: doc2, pageImages: { 1: cloneCanvas(p1), 3: p3 } },
    );

    expect(combined.pages.map(p => [p.page, p.visual.status])).toEqual([
      [1, 'identical'],
      [2, 'unavailable'],
      [3, 'added'],
    ]);
    expect(combined.summary.visual.pagesIdentical).toBe(1);
    expect(combined.summary.visual.pagesUnavailable).toBe(1);
    expect(combined.summary.visual.pagesAdded).toBe(1);
  });

  it('applies global exclusionMasks plus per-page pageMasks and handles text-only/unchanged/moved pages', () => {
    const doc1 = makeDoc(
      [
        { page: 1, text: 'Header block identical across revisions.', x: 60, y: 80, width: 200, height: 20 },
        { page: 1, text: 'Moved paragraph carried verbatim to page two.', x: 60, y: 200, width: 240, height: 24 },
        { page: 2, text: 'Static footer text that stays put.', x: 60, y: 700, width: 240, height: 20 },
      ],
      [{ index: 1 }, { index: 2 }],
    );
    const doc2 = makeDoc(
      [
        { page: 1, text: 'Header block identical across revisions.', x: 60, y: 80, width: 200, height: 20 },
        { page: 2, text: 'Moved paragraph carried verbatim to page two.', x: 60, y: 200, width: 240, height: 24 },
        { page: 2, text: 'Static footer text that stays put.', x: 60, y: 700, width: 240, height: 20 },
      ],
      [{ index: 1 }, { index: 2 }],
    );

    const p1a = makeCanvas(102, 132, [255, 255, 255]);
    const p1b = cloneCanvas(p1a);
    // Global header stamp on page 1 changed inside global mask.
    paintRect(p1b, 2, 2, 20, 6, [0, 0, 0]);

    const p2a = makeCanvas(102, 132, [255, 255, 255]);
    const p2b = cloneCanvas(p2a);
    // Global header stamp + page-2 watermark both masked out -> page 2 becomes text-only change (moved block).
    paintRect(p2b, 2, 2, 20, 6, [0, 0, 0]);
    paintRect(p2b, 40, 60, 20, 20, [180, 180, 180]);

    const combined = diffDocumentVersions(
      { document: doc1, pageImages: [p1a, p2a] },
      { document: doc2, pageImages: [p1b, p2b] },
      {
        exclusionMasks: [{ x: 2, y: 2, width: 20, height: 6, label: 'running-header' }],
        pageMasks: new Map([[2, [{ x: 40, y: 60, width: 20, height: 20, label: 'draft-watermark' }]]]),
      },
    );

    expect(combined.pages[0]?.changeCategory).toBe('unchanged');
    expect(combined.pages[0]?.visual.status).toBe('identical');
    expect(combined.pages[1]?.changeCategory).toBe('text-only');
    expect(combined.pages[1]?.text.changes.map(c => c.kind)).toEqual(['moved']);
    expect(combined.pages[1]?.visual.status).toBe('identical');
    expect(combined.summary.text.moved).toBe(1);
    expect(combined.summary.visual.pagesIdentical).toBe(2);
    expect(combined.summary.hasChanges).toBe(true);
  });
});

describe('H10 masked dynamic zones, speckle suppression, and pixel-coordinate accuracy', () => {
  it('clips out-of-bounds masks, avoids double-counting overlapping masks, and handles full-page masking', () => {
    const a = makeCanvas(30, 30, [255, 255, 255]);
    const b = makeCanvas(30, 30, [0, 0, 0]);

    // Overlapping and partially out-of-bounds masks on a 30x30 canvas.
    const clipped = diffPageImages(a, b, {
      exclusionMasks: [
        { x: -5, y: -5, width: 15, height: 15 }, // clips to [0..10) x [0..10) = 100 px
        { x: 5, y: 5, width: 10, height: 10 },  // overlaps 5x5 = 25 px -> union = 175 px
        { x: 25, y: 25, width: 0, height: 10 }, // zero-width ignored
      ],
    });
    expect(clipped.maskedPixelCount).toBe(175);
    expect(clipped.comparedPixelCount).toBe(900 - 175);
    expect(clipped.changedPixelCount).toBe(900 - 175);

    // Full-page mask yields identical visual result with SSIM 1 even on totally inverted pixels.
    const allMasked = diffPageImages(a, b, {
      exclusionMasks: [{ x: 0, y: 0, width: 30, height: 30 }],
    });
    expect(allMasked.status).toBe('identical');
    expect(allMasked.maskedPixelCount).toBe(900);
    expect(allMasked.comparedPixelCount).toBe(0);
    expect(allMasked.changedPixelRatio).toBe(0);
    expect(allMasked.ssim).toBe(1);
    expect(allMasked.changedRegions).toEqual([]);
  });

  it('splits a changed band cleanly when an exclusion mask cuts across its middle', () => {
    const a = makeCanvas(40, 30, [255, 255, 255]);
    const b = cloneCanvas(a);
    // Paint a 24x6 bar at (8, 12)..(31, 17).
    paintRect(b, 8, 12, 24, 6, [10, 10, 10]);

    // Vertical mask covering x=[18, 22) splits bar into left [8, 18) (10x6) and right [22, 32) (10x6).
    const diff = diffPageImages(a, b, {
      exclusionMasks: [{ x: 18, y: 10, width: 4, height: 10, label: 'dynamic-column' }],
    });

    expect(diff.changedRegions.map(r => r.rect)).toEqual([
      { x: 8, y: 12, width: 10, height: 6 },
      { x: 22, y: 12, width: 10, height: 6 },
    ]);
    expect(diff.changedPixelCount).toBe(120);
  });

  it('respects exact intensityThreshold and minComponentArea boundaries including diagonal 8-connectivity and 1px strokes', () => {
    const a = makeCanvas(40, 40, [200, 200, 200]);
    const b = cloneCanvas(a);

    // Exactly at threshold (delta === 16): ignored.
    paintRect(b, 2, 2, 5, 5, [184, 200, 200]);
    // 1 unit above threshold (delta === 17) on 3 pixels (< minComponentArea = 4): suppressed as speckle.
    paintRect(b, 2, 10, 3, 1, [183, 200, 200]);
    // 4-pixel diagonal chain via 8-connectivity (>= minComponentArea = 4): retained!
    paintPixel(b, 10, 10, [183, 200, 200]);
    paintPixel(b, 11, 11, [183, 200, 200]);
    paintPixel(b, 12, 12, [183, 200, 200]);
    paintPixel(b, 13, 13, [183, 200, 200]);
    // Thin 1px horizontal underline stroke (12x1 = 12 px): retained with exact height 1.
    paintRect(b, 20, 25, 12, 1, [0, 0, 0]);

    const diff = diffPageImages(a, b, {
      intensityThreshold: 16,
      minComponentArea: 4,
    });

    expect(diff.rawChangedPixelCount).toBe(19); // 3 + 4 + 12
    expect(diff.suppressedSpecklePixelCount).toBe(3);
    expect(diff.changedPixelCount).toBe(16);
    expect(diff.changedRegions.map(r => r.rect)).toEqual([
      { x: 10, y: 10, width: 4, height: 4 },
      { x: 20, y: 25, width: 12, height: 1 },
    ]);
    expect(diff.changedRegions[0]?.fillRatio).toBe(0.25); // 4 / (4*4)
    expect(diff.changedRegions[0]?.meanDelta).toBe(17);
    expect(diff.changedRegions[1]?.fillRatio).toBe(1);
  });

  it('does not resurrect suppressed speckles or let masked neighbors excuse changes under jitter tolerance', () => {
    const a = makeCanvas(32, 32, [255, 255, 255]);
    const b = cloneCanvas(a);

    // 1px speckle at (15, 10) right next to a 4x4 block at (10..13, 10..13) with mergeDistance=2.
    paintRect(b, 10, 10, 4, 4, [0, 0, 0]);
    paintPixel(b, 15, 10, [0, 0, 0]);

    const merged = diffPageImages(a, b, { mergeDistance: 2 });
    expect(merged.changedRegions).toHaveLength(1);
    expect(merged.changedRegions[0]?.rect).toEqual({ x: 10, y: 10, width: 4, height: 4 });
    expect(merged.suppressedSpecklePixelCount).toBe(1);

    // Subpixel jitter check: masked black pixel at (4, 5) must NOT excuse unmasked black pixel at (5, 5).
    const c1 = makeCanvas(16, 16, [255, 255, 255]);
    const c2 = cloneCanvas(c1);
    paintRect(c1, 4, 4, 1, 6, [0, 0, 0]); // inside mask x=4
    paintRect(c2, 5, 4, 2, 6, [0, 0, 0]); // unmasked addition at x=5..6
    const maskedJitter = diffPageImages(c1, c2, {
      subpixelJitterRadius: 1,
      exclusionMasks: [{ x: 4, y: 4, width: 1, height: 6 }],
    });
    expect(maskedJitter.status).toBe('changed');
    expect(maskedJitter.changedRegions[0]?.rect).toEqual({ x: 5, y: 4, width: 2, height: 6 });
  });

  it('reports exact pixel coordinates at corners, concave L-shapes, tiny images, alpha changes, and Uint8Array buffers', () => {
    // Top-left (0, 0) and bottom-right (29, 19) corner regions + concave L-shape.
    const a = makeCanvas(30, 20, [255, 255, 255]);
    const b = cloneCanvas(a);

    paintRect(b, 0, 0, 2, 2, [0, 0, 0]); // top-left corner: 4 px
    // L-shape occupying (10..14, 5..10): vertical 2x6 + horizontal 5x2 overlap 2x2 => 12 + 10 - 4 = 18 px
    paintRect(b, 10, 5, 2, 6, [55, 55, 55]);
    paintRect(b, 10, 9, 5, 2, [55, 55, 55]);
    paintRect(b, 28, 18, 2, 2, [0, 0, 0]); // bottom-right corner: 4 px

    const diff = diffPageImages(a, b);
    expect(diff.changedRegions.map(r => r.rect)).toEqual([
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 10, y: 5, width: 5, height: 6 },
      { x: 28, y: 18, width: 2, height: 2 },
    ]);
    expect(diff.changedRegions[1]?.pixelCount).toBe(18);
    expect(diff.changedRegions[1]?.fillRatio).toBe(0.6); // 18 / 30
    expect(diff.normalizedRegions[0]).toEqual({ x: 0, y: 0, width: 0.0667, height: 0.1 });
    expect(diff.normalizedRegions[2]).toEqual({ x: 0.9333, y: 0.9, width: 0.0667, height: 0.1 });

    // Tiny 3x3 image smaller than default 8x8 SSIM window + Uint8Array buffer + alpha change.
    const tinyA: RgbaImage = { width: 3, height: 3, data: new Uint8Array(3 * 3 * 4).fill(0) }; // transparent black -> white paper
    const tinyB: RgbaImage = {
      width: 3,
      height: 3,
      data: Uint8Array.from(tinyA.data.map((_, i) => (i % 4 === 3 ? 255 : 0))), // opaque black
    };
    const tinyDiff = diffPageImages(tinyA, tinyB);
    expect(tinyDiff.status).toBe('changed');
    expect(tinyDiff.changedRegions[0]?.rect).toEqual({ x: 0, y: 0, width: 3, height: 3 });
    expect(tinyDiff.ssim).toBeLessThan(0.1);

    // Invalid geometry in pointsRectToPixelMask throws VisualDiffError.
    expect(() =>
      pointsRectToPixelMask({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 100 }, { width: 100, height: 100 }),
    ).toThrowError(VisualDiffError);
  });
});
