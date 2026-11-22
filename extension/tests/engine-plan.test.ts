import { describe, expect, it } from 'vitest';
import { classifyPage } from '../viewer/src/core/classify';
import type { ClassifyPageInput } from '../viewer/src/core/classify';
import {
  CLOUD_ENGINES,
  DEFAULT_BUDGET_MS,
  ENGINE_COST_MS,
  ENGINE_LANGUAGES,
  ENGINE_ORDER,
  budgetFor,
  pageFactsFrom,
  planEngine,
} from '../viewer/src/core/engine-plan';
import type { EngineAvailability, EnginePlan, PageFacts } from '../viewer/src/core/engine-plan';

const A4_WIDTH = 595;
const A4_HEIGHT = 842;
const A4_AREA = A4_WIDTH * A4_HEIGHT;

const ALL: EngineAvailability = { windows: true, tesseract: true, browser: true };
const NOTHING: EngineAvailability = { windows: false, tesseract: false, browser: false };
const NO_WINDOWS: EngineAvailability = { windows: false, tesseract: true, browser: true };
const NATIVE_ONLY: EngineAvailability = { windows: true, tesseract: false, browser: false };
const WASM_ONLY: EngineAvailability = { windows: false, tesseract: true, browser: false };
const CLOUD_ONLY: EngineAvailability = { windows: false, tesseract: false, browser: true };

function facts(overrides: Partial<PageFacts> = {}): PageFacts {
  return {
    kind: 'scanned',
    textItemCount: 0,
    glyphCount: 0,
    textCoverage: 0,
    largestImageRatio: 1,
    ...overrides,
  };
}

/** A born-digital page: 40 text runs, roughly 46% coverage on A4. */
function digitalTextFacts(overrides: Partial<PageFacts> = {}): PageFacts {
  return facts({
    kind: 'digital',
    textItemCount: 40,
    glyphCount: 880,
    textCoverage: 0.46,
    largestImageRatio: 0,
    ...overrides,
  });
}

function reasonText(plan: EnginePlan): string {
  return plan.reasons.join(' ');
}

function estTesseractPlan(): EnginePlan {
  return planEngine(facts(), WASM_ONLY);
}

describe('planEngine with digital pages', () => {
  it('plans no OCR for a born-digital page that already has text', () => {
    const plan = planEngine(digitalTextFacts(), ALL);
    expect(plan.engine).toBe('none');
    expect(plan.fallback).toEqual([]);
    expect(plan.estimatedMsPerPage).toBe(0);
    expect(plan.reasons).toHaveLength(1);
    expect(reasonText(plan)).toMatch(/880 glyphs across 40 text runs/);
    expect(reasonText(plan)).toMatch(/no OCR engine runs/);
  });

  it('plans no OCR for a page with neither text nor a raster worth reading', () => {
    const plan = planEngine(facts({ kind: 'digital', largestImageRatio: 0 }), ALL);
    expect(plan.engine).toBe('none');
    expect(plan.fallback).toEqual([]);
    expect(reasonText(plan)).toMatch(/no text layer/);
    expect(reasonText(plan)).toMatch(/below the 40% recognition threshold/);
  });

  it('plans no OCR for a digital page whose raster is too small to be the content', () => {
    const plan = planEngine(facts({ kind: 'digital', largestImageRatio: 0.39 }), ALL);
    expect(plan.engine).toBe('none');
  });

  it('still runs OCR for a page classified digital with no text layer and a page-sized raster', () => {
    // A scan whose image stopped short of the classifier's 85% full-page test:
    // classifyPage calls it digital, the density says there is nothing to read.
    const plan = planEngine(facts({ kind: 'digital', largestImageRatio: 0.6 }), ALL);
    expect(plan.engine).toBe('windows');
    expect(plan.fallback).toEqual(['browser', 'tesseract']);
    expect(reasonText(plan)).toMatch(/classified digital but has no usable text/);
    expect(reasonText(plan)).toMatch(/treated as a scan/);
  });

  it('notes a thin digital text layer without starting OCR', () => {
    const plan = planEngine(
      facts({ kind: 'digital', textItemCount: 2, glyphCount: 12, textCoverage: 0.004, largestImageRatio: 0.1 }),
      ALL,
    );
    expect(plan.engine).toBe('none');
    expect(reasonText(plan)).toMatch(/text layer is thin/);
  });
});

describe('planEngine with scanned pages', () => {
  it('chooses the quickest engine the platform reports', () => {
    const plan = planEngine(facts({ largestImageRatio: 0.92, glyphCount: 12 }), ALL);
    expect(plan.engine).toBe('windows');
    expect(plan.fallback).toEqual(['browser', 'tesseract']);
    expect(plan.estimatedMsPerPage).toBe(ENGINE_COST_MS.windows);
    expect(reasonText(plan)).toMatch(/a scan/);
    expect(reasonText(plan)).toMatch(/quickest supported engine/);
  });

  it('falls back in ranked order when the quickest engine is missing', () => {
    const plan = planEngine(facts(), NO_WINDOWS);
    expect(plan.engine).toBe('browser');
    expect(plan.fallback).toEqual(['tesseract']);
    expect(plan.estimatedMsPerPage).toBe(ENGINE_COST_MS.browser);
  });

  it('treats a hybrid page as needing OCR for its pixels', () => {
    const plan = planEngine(
      facts({ kind: 'hybrid', textItemCount: 4, glyphCount: 40, textCoverage: 0.01, largestImageRatio: 0.7 }),
      ALL,
    );
    expect(plan.engine).toBe('windows');
    expect(reasonText(plan)).toMatch(/mixes a raster/);
  });

  it('honours a requested engine that is available and supported', () => {
    const plan = planEngine(facts(), ALL, { prefer: 'tesseract' });
    expect(plan.engine).toBe('tesseract');
    expect(plan.fallback).toEqual(['windows', 'browser']);
    expect(reasonText(plan)).toMatch(/as the caller preferred/);
  });

  it('explains a requested engine that this device does not report', () => {
    const plan = planEngine(facts(), WASM_ONLY, { prefer: 'windows' });
    expect(plan.engine).toBe('tesseract');
    expect(plan.fallback).toEqual([]);
    expect(reasonText(plan)).toMatch(/The requested Windows OCR is not available on this device/);
  });
});

describe('planEngine language support', () => {
  it('demotes an engine that does not document the page language', () => {
    // Windows OCR ships no Thai pack; Tesseract does.
    const plan = planEngine(facts({ languages: ['th'] }), { ...WASM_ONLY, windows: true });
    expect(plan.engine).toBe('tesseract');
    expect(plan.fallback).toEqual(['windows']);
    expect(reasonText(plan)).toMatch(/Windows OCR does not document th, so it ranks below Tesseract/);
  });

  it('keeps a documented language on the quickest engine', () => {
    const plan = planEngine(facts({ languages: ['vi'] }), ALL);
    expect(plan.engine).toBe('windows');
  });

  it('normalizes aliases and region tags before checking support', () => {
    // 'tha' -> th (unsupported by Windows), 'ENG' -> en (supported by both).
    const plan = planEngine(facts({ languages: ['tha', 'ENG'] }), { ...WASM_ONLY, windows: true });
    expect(plan.engine).toBe('tesseract');
    expect(plan.fallback).toEqual(['windows']);
    expect(reasonText(plan)).toMatch(/does not document en, th|does not document th, en/);
  });

  it('runs a best effort with a warning when no engine documents the language', () => {
    const plan = planEngine(facts({ languages: ['th'] }), NATIVE_ONLY);
    expect(plan.engine).toBe('windows');
    expect(plan.fallback).toEqual([]);
    expect(reasonText(plan)).toMatch(/No available engine documents th/);
    expect(reasonText(plan)).toMatch(/best effort/);
  });

  it('ignores auto and empty language hints', () => {
    expect(planEngine(facts({ languages: ['auto', ''] }), ALL).engine).toBe('windows');
  });
});

describe('planEngine offline-only', () => {
  it('never selects the hosted engine when offline-only is on', () => {
    const plan = planEngine(facts(), NO_WINDOWS, { offlineOnly: true });
    expect(plan.engine).toBe('tesseract');
    expect(plan.fallback).toEqual([]);
    expect(plan.fallback).not.toContain('browser');
    expect(reasonText(plan)).toMatch(/Offline-only mode leaves hosted browser OCR/);
  });

  it('keeps the native engine available offline', () => {
    const plan = planEngine(facts(), ALL, { offlineOnly: true });
    expect(plan.engine).toBe('windows');
    expect(plan.fallback).toEqual(['tesseract']);
  });

  it('reports no engine when offline-only leaves only the hosted one', () => {
    const plan = planEngine(facts(), CLOUD_ONLY, { offlineOnly: true });
    expect(plan.engine).toBe('none');
    expect(plan.fallback).toEqual([]);
    expect(plan.estimatedMsPerPage).toBe(0);
    expect(reasonText(plan)).toMatch(/Offline-only mode rules out hosted browser OCR/);
    expect(reasonText(plan)).toMatch(/keeps its pixels/);
  });

  it('skips a requested engine that needs the network', () => {
    const plan = planEngine(facts(), ALL, { offlineOnly: true, prefer: 'browser' });
    expect(plan.engine).toBe('windows');
    expect(reasonText(plan)).toMatch(/requested hosted browser OCR was skipped/);
  });
});

describe('planEngine when nothing is available', () => {
  it('reports none with a reason instead of failing silently', () => {
    const plan = planEngine(facts(), NOTHING);
    expect(plan.engine).toBe('none');
    expect(plan.fallback).toEqual([]);
    expect(plan.estimatedMsPerPage).toBe(0);
    expect(plan.reasons).toHaveLength(2);
    expect(reasonText(plan)).toMatch(/No OCR engine is available on this device/);
    expect(reasonText(plan)).toMatch(/keeps its pixels/);
  });
});

describe('planEngine determinism and validation', () => {
  it('returns the same plan for the same input', () => {
    const first = planEngine(facts({ languages: ['th', 'en'] }), NO_WINDOWS, { prefer: 'tesseract' });
    const second = planEngine(facts({ languages: ['th', 'en'] }), NO_WINDOWS, { prefer: 'tesseract' });
    expect(second).toEqual(first);
  });

  it('does not let hint order change the plan', () => {
    const forward = planEngine(facts({ languages: ['th', 'en'] }), ALL);
    const reversed = planEngine(facts({ languages: ['en', 'th'] }), ALL);
    expect(reversed).toEqual(forward);
  });

  it('rejects non-finite facts', () => {
    expect(() => planEngine(facts({ glyphCount: Number.NaN }), ALL)).toThrow(RangeError);
    expect(() => planEngine(facts({ textCoverage: -1 }), ALL)).toThrow(RangeError);
  });

  it('documents the cost order and support tables the ranking relies on', () => {
    expect(ENGINE_ORDER).toEqual(['windows', 'browser', 'tesseract']);
    expect(ENGINE_COST_MS.windows).toBeLessThan(ENGINE_COST_MS.browser);
    expect(ENGINE_COST_MS.browser).toBeLessThan(ENGINE_COST_MS.tesseract);
    expect(ENGINE_LANGUAGES.tesseract).toContain('th');
    expect(ENGINE_LANGUAGES.windows).not.toContain('th');
    for (const engine of CLOUD_ENGINES) expect(ENGINE_LANGUAGES[engine].length).toBeGreaterThan(0);
  });
});

describe('budgetFor', () => {
  it('estimates a run from the documented per-page cost', () => {
    const plan = estTesseractPlan();
    const budget = budgetFor(10, plan);
    expect(budget).toEqual({ pages: 10, estimatedMs: ENGINE_COST_MS.tesseract * 10, exceedsBudget: false });
  });

  it('flags a document that exceeds the default budget', () => {
    const budget = budgetFor(500, estTesseractPlan());
    expect(budget.estimatedMs).toBe(ENGINE_COST_MS.tesseract * 500);
    expect(budget.estimatedMs).toBeGreaterThan(DEFAULT_BUDGET_MS);
    expect(budget.exceedsBudget).toBe(true);
  });

  it('accepts a configurable budget', () => {
    const plan = estTesseractPlan();
    expect(budgetFor(10, plan, { budgetMs: 24_000 }).exceedsBudget).toBe(false);
    expect(budgetFor(10, plan, { budgetMs: 23_999 }).exceedsBudget).toBe(true);
  });

  it('costs nothing when the plan runs no engine', () => {
    const plan = planEngine(digitalTextFacts(), ALL);
    expect(budgetFor(1_000, plan)).toEqual({ pages: 1_000, estimatedMs: 0, exceedsBudget: false });
  });

  it('rejects invalid counts and budgets', () => {
    const plan = estTesseractPlan();
    expect(() => budgetFor(-1, plan)).toThrow(RangeError);
    expect(() => budgetFor(1.5, plan)).toThrow(RangeError);
    expect(() => budgetFor(10, plan, { budgetMs: Number.NaN })).toThrow(RangeError);
  });
});

describe('pageFactsFrom', () => {
  function classifyInput(overrides: Partial<ClassifyPageInput> = {}): ClassifyPageInput {
    return { textItems: [], images: [], pageArea: A4_AREA, glyphCount: 0, ...overrides };
  }

  it('copies the classifier stats that route the page', () => {
    const classification = classifyPage(classifyInput({
      images: [{ rect: { x: 0, y: 0, width: A4_WIDTH, height: A4_HEIGHT } }],
    }));
    expect(classification.kind).toBe('scanned');

    const derived = pageFactsFrom(classification);
    expect(derived.kind).toBe('scanned');
    expect(derived.textItemCount).toBe(0);
    expect(derived.glyphCount).toBe(0);
    expect(derived.largestImageRatio).toBe(1);
    expect(derived.languages).toEqual([]);
    expect(planEngine(derived, ALL).engine).toBe('windows');
  });

  it('routes a real digital page past OCR without hand-built facts', () => {
    const textItems = Array.from({ length: 40 }, (_, line) => ({
      text: `line ${line} of body text`,
      rect: { x: 56, y: 56 + line * 14, width: 480, height: 12 },
    }));
    const classification = classifyPage(classifyInput({
      textItems,
      glyphCount: textItems.reduce((total, item) => total + item.text.length, 0),
    }));
    expect(classification.kind).toBe('digital');

    const plan = planEngine(pageFactsFrom(classification, ['eng']), ALL);
    expect(plan.engine).toBe('none');
    expect(plan.estimatedMsPerPage).toBe(0);
  });

  it('carries the language hints through to the plan', () => {
    const classification = classifyPage(classifyInput({
      images: [{ rect: { x: 0, y: 0, width: A4_WIDTH, height: A4_HEIGHT } }],
    }));
    const plan = planEngine(pageFactsFrom(classification, ['th']), { ...WASM_ONLY, windows: true });
    expect(plan.engine).toBe('tesseract');
  });
});
