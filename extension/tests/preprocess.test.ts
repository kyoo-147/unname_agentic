import { describe, expect, it } from 'vitest';
import {
  PreprocessError,
  SKEW_THRESHOLD_DEG,
  estimateSkew,
  planPreprocess,
  sampleStats,
  type PreprocessPlan,
  type PreprocessStats,
  type PreprocessStepKind,
  type RgbaSample,
} from '../viewer/src/core/preprocess';

/** Clean-page stats; each test overrides only the numbers its rule cares about. */
function stats(overrides: Partial<PreprocessStats> = {}): PreprocessStats {
  return {
    meanLuma: 240,
    contrast: 60,
    estimatedSkewDeg: 0.1,
    noiseRatio: 0.002,
    isColor: false,
    ...overrides,
  };
}

function kinds(plan: PreprocessPlan): PreprocessStepKind[] {
  return plan.steps.map(step => step.kind);
}

/** The error code a refused call raised, so the failure mode is asserted, not just the throw. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PreprocessError) return error.code;
    throw error;
  }
  throw new Error('expected a PreprocessError');
}

function solidSample(width: number, height: number, red: number, green = red, blue = red): RgbaSample {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = red;
    data[offset + 1] = green;
    data[offset + 2] = blue;
    data[offset + 3] = 255;
  }
  return { data, width, height };
}

function setSamplePixel(sample: RgbaSample, x: number, y: number, value: number): void {
  const offset = (y * sample.width + x) * 4;
  sample.data[offset] = value;
  sample.data[offset + 1] = value;
  sample.data[offset + 2] = value;
  sample.data[offset + 3] = 255;
}

/**
 * A synthetic page of horizontal ink stripes rotated by `angleDeg`, positive
 * clockwise: at +2° the stripes run down to the right, which is what a sheet
 * fed crookedly into a scanner looks like.
 */
function stripedSample(width: number, height: number, angleDeg: number): RgbaSample {
  const period = 10;
  const band = 3;
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centreX = (width - 1) / 2;
  const centreY = (height - 1) / 2;
  const halfWidth = width * 0.42;
  const image = solidSample(width, height, 250);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - centreX;
      const dy = y - centreY;
      // Undo the rotation to read the straight page underneath.
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      const phase = ((v % period) + period) % period;
      if (phase < band && Math.abs(u) <= halfWidth) setSamplePixel(image, x, y, 30);
    }
  }
  return image;
}

describe('planPreprocess', () => {
  it('plans nothing for a clean page', () => {
    const plan = planPreprocess(stats());
    expect(kinds(plan)).toEqual(['none']);
    expect(plan.steps).toHaveLength(1);
    expect(plan.reasons).toEqual([plan.steps[0]?.reason]);
    expect(plan.steps[0]?.reason).toContain('No preprocessing step is planned');
  });

  it('plans deskew for a two-degree tilt and names the angle in the reason', () => {
    const plan = planPreprocess(stats({ estimatedSkewDeg: 2 }));
    expect(kinds(plan)).toEqual(['deskew']);
    const step = plan.steps[0];
    expect(step?.kind).toBe('deskew');
    if (step?.kind !== 'deskew') throw new Error('expected a deskew step');
    // The correction is the opposite of the measured tilt, in canvas degrees.
    expect(step.angleDeg).toBeCloseTo(-2, 6);
    expect(step.reason).toContain('2.0°');
    expect(step.reason).toContain('clockwise');
    expect(plan.reasons).toContain(step.reason);
  });

  it('corrects a left-leaning page the other way', () => {
    const plan = planPreprocess(stats({ estimatedSkewDeg: -1.25 }));
    const step = plan.steps[0];
    if (step?.kind !== 'deskew') throw new Error('expected a deskew step');
    expect(step.angleDeg).toBeCloseTo(1.25, 6);
    expect(step.reason).toContain('1.25°');
    expect(step.reason).toContain('counter-clockwise');
  });

  it('plans binarize for a low-contrast scan', () => {
    const plan = planPreprocess(stats({ meanLuma: 208, contrast: 14 }));
    expect(kinds(plan)).toEqual(['binarize']);
    expect(plan.steps[0]?.reason).toContain('14.0');
  });

  it('plans denoise and grayscale for a noisy colour scan', () => {
    const plan = planPreprocess(stats({ meanLuma: 178, contrast: 55, noiseRatio: 0.09, isColor: true }));
    expect(kinds(plan)).toEqual(['grayscale', 'denoise']);
    expect(plan.steps[1]?.reason).toContain('9.0%');
  });

  it('leaves a page tilted less than the deskew threshold alone', () => {
    const plan = planPreprocess(stats({ estimatedSkewDeg: 0.3 }));
    expect(kinds(plan)).toEqual(['none']);
  });

  it('deskews exactly at the threshold', () => {
    const plan = planPreprocess(stats({ estimatedSkewDeg: SKEW_THRESHOLD_DEG }));
    expect(kinds(plan)).toEqual(['deskew']);
  });

  it('runs the steps in the documented order', () => {
    const plan = planPreprocess(stats({
      meanLuma: 205,
      contrast: 18,
      estimatedSkewDeg: -1.5,
      noiseRatio: 0.08,
      isColor: true,
    }));
    expect(kinds(plan)).toEqual(['grayscale', 'denoise', 'deskew', 'binarize']);
    expect(plan.reasons).toEqual(plan.steps.map(step => step.reason));
  });

  it('keeps colour when the caller asks for it, so nothing greys or thresholds', () => {
    const plan = planPreprocess(
      stats({ meanLuma: 205, contrast: 18, isColor: true }),
      { textOnly: false },
    );
    expect(kinds(plan)).toEqual(['none']);
  });

  it('does not binarise a page too flat to separate', () => {
    const plan = planPreprocess(stats({ meanLuma: 252, contrast: 1.2 }));
    expect(kinds(plan)).toEqual(['none']);
  });

  it('refuses stats it cannot plan from', () => {
    expect(codeOf(() => planPreprocess(stats({ estimatedSkewDeg: Number.NaN })))).toBe('invalid-stats');
    expect(codeOf(() => planPreprocess(stats({ noiseRatio: 4 })))).toBe('invalid-stats');
  });
});

describe('sampleStats', () => {
  it('measures a two-pixel sample by hand', () => {
    const image: RgbaSample = {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]),
    };
    const measured = sampleStats(image);
    expect(measured.meanLuma).toBeCloseTo(127.5, 6);
    expect(measured.contrast).toBeCloseTo(127.5, 6);
    expect(measured.estimatedSkewDeg).toBe(0);
    expect(measured.noiseRatio).toBe(0);
    expect(measured.isColor).toBe(false);
  });

  it('flags a tinted sample and passes a grey one', () => {
    expect(sampleStats(solidSample(4, 4, 255, 0, 0)).isColor).toBe(true);
    expect(sampleStats(solidSample(4, 4, 128, 128, 128)).isColor).toBe(false);
  });

  it('counts an isolated speck as noise and leaves a solid patch alone', () => {
    expect(sampleStats(solidSample(5, 5, 200)).noiseRatio).toBe(0);

    const speckled = solidSample(5, 5, 200);
    setSamplePixel(speckled, 2, 2, 255);
    // The 3x3 interior holds nine pixels, one of which is now a speck.
    expect(sampleStats(speckled).noiseRatio).toBeCloseTo(1 / 9, 10);
  });

  it('estimates an injected clockwise tilt within half a degree', () => {
    const image = stripedSample(320, 200, 2);
    const estimate = estimateSkew(image);
    expect(Math.abs(estimate - 2)).toBeLessThanOrEqual(0.5);
    expect(estimateSkew(image)).toBe(estimate);
    expect(sampleStats(image).estimatedSkewDeg).toBe(estimate);
  });

  it('estimates an injected counter-clockwise tilt with the same sign convention', () => {
    const estimate = estimateSkew(stripedSample(320, 200, -2));
    expect(Math.abs(estimate + 2)).toBeLessThanOrEqual(0.5);
  });

  it('plans deskew from measured pixels and names the measured angle', () => {
    const plan = planPreprocess(sampleStats(stripedSample(320, 200, 2)));
    const step = plan.steps.find(candidate => candidate.kind === 'deskew');
    if (step?.kind !== 'deskew') throw new Error('expected a deskew step');
    expect(step.angleDeg).toBeLessThan(0);
    expect(step.reason).toMatch(/\d+\.\d° clockwise/);
  });

  it('refuses an empty sample', () => {
    const empty: RgbaSample = { width: 0, height: 0, data: new Uint8ClampedArray(0) };
    expect(codeOf(() => sampleStats(empty))).toBe('empty-sample');
    expect(codeOf(() => estimateSkew(empty))).toBe('empty-sample');
  });

  it('refuses a buffer shorter than its dimensions', () => {
    const short: RgbaSample = { width: 10, height: 10, data: new Uint8ClampedArray(4) };
    expect(codeOf(() => sampleStats(short))).toBe('short-buffer');
    expect(codeOf(() => estimateSkew(short))).toBe('short-buffer');
  });
});
