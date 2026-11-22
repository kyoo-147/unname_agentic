import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_GLYPH_HEIGHT,
  DewarpError,
  MAX_SCALE,
  dewarpForOcr,
  detectInverted,
  estimateGlyphHeight,
  normalizeForOcr,
  toGrayscale,
  type RgbaImage,
} from '../viewer/src/ocr/preprocess';

interface TextImageOptions {
  width?: number;
  height?: number;
  background?: number;
  ink?: number;
  bandHeight?: number;
  gap?: number;
  left?: number;
  right?: number;
}

function setPixel(image: RgbaImage, x: number, y: number, value: number): void {
  const offset = (y * image.width + x) * 4;
  image.data[offset] = value;
  image.data[offset + 1] = value;
  image.data[offset + 2] = value;
  image.data[offset + 3] = 255;
}

function pixel(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset] ?? 0,
    image.data[offset + 1] ?? 0,
    image.data[offset + 2] ?? 0,
    image.data[offset + 3] ?? 0,
  ];
}

function fill(image: RgbaImage, x0: number, y0: number, x1: number, y1: number, value: number): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) setPixel(image, x, y, value);
  }
}

function flatImage(width: number, height: number, value: number): RgbaImage {
  const image: RgbaImage = { data: new Uint8ClampedArray(width * height * 4), width, height };
  fill(image, 0, 0, width, height, value);
  return image;
}

/** Background plus a few ink bands, so row profiles have lines to find. */
function textImage(options: TextImageOptions = {}): RgbaImage {
  const width = options.width ?? 64;
  const height = options.height ?? 64;
  const background = options.background ?? 255;
  const ink = options.ink ?? 0;
  const bandHeight = options.bandHeight ?? 10;
  const gap = options.gap ?? 10;
  const left = options.left ?? Math.floor(width * 0.1);
  const right = options.right ?? Math.floor(width * 0.4);
  const image = flatImage(width, height, background);
  for (let top = 4; top + bandHeight <= height - 4; top += bandHeight + gap) {
    fill(image, left, top, right, top + bandHeight, ink);
  }
  return image;
}

function meanLuma(image: RgbaImage): number {
  let total = 0;
  let count = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    total += image.data[offset] ?? 0;
    count++;
  }
  return count ? total / count : 0;
}

describe('OCR preprocessing', () => {
  it('inverts a white-on-dark capture into dark glyphs on a light page', () => {
    const dark = textImage({ background: 12, ink: 240, bandHeight: 10, gap: 10 });
    expect(detectInverted(dark)).toBe(true);

    const { image, report } = normalizeForOcr(dark);
    expect(report.inverted).toBe(true);
    expect(report.contrastGain).toBeGreaterThan(1);
    expect(image.width).toBe(dark.width * report.scale);
    expect(image.height).toBe(dark.height * report.scale);

    const scale = report.scale;
    expect(pixel(image, 0, 0)[0]).toBe(255);
    expect(pixel(image, 10 * scale, 6 * scale)[0]).toBe(0);
    expect(meanLuma(image)).toBeGreaterThan(128);
  });

  it('leaves an already light capture untouched', () => {
    const light = textImage({ width: 80, height: 80, background: 255, ink: 0, bandHeight: 24, gap: 12 });
    expect(detectInverted(light)).toBe(false);

    const { image, report } = normalizeForOcr(light);
    expect(report).toEqual({ inverted: false, contrastGain: 1, scale: 1 });
    expect(image.width).toBe(light.width);
    expect(image.height).toBe(light.height);
    expect(image.data).toEqual(light.data);
  });

  it('stretches around a percentile clamp instead of one outlier pixel', () => {
    const image = flatImage(100, 100, 100);
    fill(image, 0, 50, 100, 100, 175);
    setPixel(image, 5, 5, 0);
    setPixel(image, 60, 60, 255);

    const clamped = normalizeForOcr(image);
    // Only 100..175 survives the 2% trim; min/max would have found the outliers
    // and stretched by 1, which is the behaviour this guards against.
    expect(clamped.report.contrastGain).toBeCloseTo(3.4, 5);
    expect(clamped.image.width).toBe(image.width);
    expect(pixel(clamped.image, 1, 1)[0]).toBe(0);
    expect(pixel(clamped.image, 1, 99)[0]).toBe(255);
    expect(pixel(clamped.image, 5, 5)[0]).toBe(0);
    expect(pixel(clamped.image, 60, 60)[0]).toBe(255);

    const naive = normalizeForOcr(image, { percentile: 0 });
    expect(naive.report.contrastGain).toBe(1);
    expect(pixel(naive.image, 1, 99)[0]).toBe(175);
  });

  it('upscales tiny glyphs but keeps large ones at 1x', () => {
    const large = textImage({ width: 80, height: 80, bandHeight: 24, gap: 12 });
    expect(estimateGlyphHeight(large)).toBe(24);
    expect(normalizeForOcr(large).report.scale).toBe(1);

    const small = textImage({ width: 80, height: 64, bandHeight: 10, gap: 8 });
    expect(estimateGlyphHeight(small)).toBe(10);
    const smallResult = normalizeForOcr(small);
    expect(smallResult.report.scale).toBe(Math.min(MAX_SCALE, Math.ceil(DEFAULT_MIN_GLYPH_HEIGHT / 10)));
    expect(smallResult.report.scale).toBe(2);
    expect(smallResult.image.width).toBe(small.width * smallResult.report.scale);
    expect(smallResult.image.height).toBe(small.height * smallResult.report.scale);

    const tiny = textImage({ width: 80, height: 64, bandHeight: 5, gap: 7 });
    expect(estimateGlyphHeight(tiny)).toBe(5);
    const tinyResult = normalizeForOcr(tiny);
    expect(tinyResult.report.scale).toBeGreaterThanOrEqual(2);
    expect(tinyResult.report.scale).toBeLessThanOrEqual(MAX_SCALE);
    expect(tinyResult.report.scale).toBe(MAX_SCALE);
  });

  it('computes Rec.601 luminance for known colours', () => {
    const source: RgbaImage = {
      width: 6,
      height: 1,
      data: new Uint8ClampedArray([
        255, 0, 0, 128,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255,
        0, 0, 0, 255,
        10, 20, 30, 255,
      ]),
    };

    const output = toGrayscale(source);
    expect(Array.from(output.data)).toEqual([
      76, 76, 76, 128,
      150, 150, 150, 255,
      29, 29, 29, 255,
      255, 255, 255, 255,
      0, 0, 0, 255,
      18, 18, 18, 255,
    ]);
    expect(output.width).toBe(6);
    expect(output.height).toBe(1);
  });

  it('does not invert a uniformly dark capture with no bright ink', () => {
    const dark = flatImage(16, 16, 8);
    expect(detectInverted(dark)).toBe(false);

    const { image, report } = normalizeForOcr(dark);
    expect(report.inverted).toBe(false);
    expect(report.contrastGain).toBe(1);
    expect(pixel(image, 0, 0)[0]).toBe(8);
  });

  it('leaves perspective, curved, and unknown pages untouched with explicit unknown provenance', () => {
    const image = textImage({ width: 48, height: 32 });

    for (const pageGeometry of ['perspective', 'curved', 'unknown'] as const) {
      const result = dewarpForOcr(image, 4, { pageGeometry });
      expect(result.image).toBe(image);
      expect(result.transform.sourceToOutput).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      expect(result.transform.outputToSource).toEqual(result.transform.sourceToOutput);
      expect(result.provenance).toMatchObject({
        status: 'unknown',
        pageGeometry,
        measuredSkewDeg: 4,
        correctionDeg: 0,
        mappedBackToSource: true,
        sourceWidth: 48,
        sourceHeight: 32,
        outputWidth: 48,
        outputHeight: 32,
      });
      expect(result.provenance.reason).toMatch(/unsupported|not established/u);
    }
  });

  it('applies a bounded planar rotation with invertible source-coordinate provenance', () => {
    const image = textImage({ width: 48, height: 32 });
    const result = dewarpForOcr(image, 4, { pageGeometry: 'planar' });

    expect(result.provenance.status).toBe('applied');
    expect(result.provenance.pageGeometry).toBe('planar');
    expect(result.provenance.mappedBackToSource).toBe(true);
    expect(result.transform.outputToSource).toEqual(expect.objectContaining({ a: expect.any(Number), d: expect.any(Number) }));
    expect(result.transform.sourceToOutput.a * result.transform.outputToSource.a + result.transform.sourceToOutput.c * result.transform.outputToSource.b).toBeCloseTo(1);
  });

  it('rejects degenerate raster dimensions and malformed pixel buffers', () => {
    expect(() => dewarpForOcr({ data: new Uint8ClampedArray(0), width: 0, height: 1 }, 0)).toThrow(DewarpError);
    expect(() => dewarpForOcr({ data: new Uint8ClampedArray(4), width: 2, height: 1 }, 0)).toThrow(DewarpError);
  });

  it('survives an empty or malformed image everywhere', () => {
    const empty: RgbaImage = { data: new Uint8ClampedArray(0), width: 0, height: 0 };
    expect(toGrayscale(empty)).toEqual({ data: new Uint8ClampedArray(0), width: 0, height: 0 });
    expect(detectInverted(empty)).toBe(false);
    expect(estimateGlyphHeight(empty)).toBe(0);

    const { image, report } = normalizeForOcr(empty);
    expect(report).toEqual({ inverted: false, contrastGain: 1, scale: 1 });
    expect(image.width).toBe(0);
    expect(image.data.length).toBe(0);

    const malformed: RgbaImage = { data: new Uint8ClampedArray(4), width: 10, height: 10 };
    expect(() => normalizeForOcr(malformed)).not.toThrow();
    expect(normalizeForOcr(malformed).report).toEqual({ inverted: false, contrastGain: 1, scale: 1 });
  });
});
