import { describe, expect, it } from 'vitest';
import { ENGINE_SCRIPTS, planEngine, type EngineAvailability, type PageFacts } from '../viewer/src/core/engine-plan';

const ALL: EngineAvailability = { windows: true, tesseract: true, browser: true };

function scanned(overrides: Partial<PageFacts> = {}): PageFacts {
  return {
    kind: 'scanned',
    textItemCount: 0,
    glyphCount: 0,
    textCoverage: 0,
    largestImageRatio: 1,
    ...overrides,
  };
}

describe('script-aware OCR routing', () => {
  it('uses script evidence when the page has no reliable language code', () => {
    const plan = planEngine(scanned({ scripts: ['thai'] }), ALL);

    expect(plan.engine).toBe('browser');
    expect(plan.fallback).toEqual(['tesseract', 'windows']);
    expect(plan.reasons.join(' ')).toContain('script:thai');
  });

  it('keeps script support deterministic regardless of hint order', () => {
    const first = planEngine(scanned({ scripts: ['devanagari', 'thai'] }), ALL);
    const second = planEngine(scanned({ scripts: ['thai', 'devanagari'] }), ALL);

    expect(second).toEqual(first);
    expect(ENGINE_SCRIPTS.windows).not.toContain('thai');
    expect(ENGINE_SCRIPTS.tesseract).toContain('devanagari');
  });

  it('does not let an offline run fall through to hosted OCR', () => {
    const plan = planEngine(scanned({ scripts: ['thai'] }), { windows: false, tesseract: false, browser: true }, { offlineOnly: true });

    expect(plan.engine).toBe('none');
    expect(plan.fallback).toEqual([]);
    expect(plan.reasons.join(' ')).toContain('Offline-only mode');
  });
});
