/**
 * OCR engine planner (backlog F01).
 *
 * OCR is the slowest thing this reader does, and the three engines it can drive
 * disagree about language, cost and whether they need the network. Running the
 * wrong one is not a minor waste: Tesseract re-reads a page in seconds that the
 * Windows engine settles in a fraction of one, and a hosted engine turns an
 * offline document into a failed upload. So the choice is made here, before any
 * pixel moves, from facts the classifier already measured, and every plan
 * carries the sentences that justify it — including the plan that decides no
 * engine can run.
 *
 * The inputs are plain data: {@link PageFacts} (from `classifyPage`, plus the
 * language hints a caller already has), {@link EngineAvailability} (what this
 * device reports) and {@link EnginePreferences} (what the user asked for).
 * Nothing here touches the DOM, loads an engine or reads a locale, so the same
 * three arguments always produce the same plan and a UI can render it before
 * the first page is recognized.
 *
 * ## Decision order
 *
 * 1. **Does the page need OCR at all?** A `digital` page whose text layer is
 *    more than the classifier's own sparse threshold is already readable, so
 *    the plan is `none`. Two corner cases are handled with the same numbers the
 *    classifier used:
 *    - a `digital` page with no text layer and a raster below the
 *      {@link LARGE_IMAGE_RATIO} threshold has nothing worth recognizing (a
 *      logo, a rule), so it is also `none`;
 *    - a `digital` page with no text layer but a raster *at or above* that
 *      threshold is a scan whose picture stopped short of the classifier's
 *      full-page test (85%). It carries no text layer, so OCR still runs: the
 *      classifier said "digital", the density says "there is nothing to read",
 *      and ignoring that would leave the page blank forever.
 * 2. **Which engine?** Only engines the device reports are candidates, and
 *    offline-only mode removes the hosted one first. Then the remaining
 *    candidates are ranked by, in order: documented language support, the
 *    caller's `prefer`, estimated milliseconds per page, and finally the fixed
 *    {@link ENGINE_ORDER} so a tie cannot depend on array order.
 * 3. **Nothing left?** The plan is `none` with a sentence a UI can show. That is
 *    the difference between "OCR is unavailable on this device" and a page that
 *    silently stays empty.
 *
 * ## Why language support outranks speed
 *
 * A fast engine reading a script it has no model for does not fail — it returns
 * confident garbage, which is worse than a slower correct read. So an engine
 * that does not document every hinted language is demoted below every engine
 * that does, and only if no engine documents the language does the plan fall
 * back to the quickest engine with a warning that its text may be poor. The
 * hints are normalized through `normalizeLanguageCode`, so `eng`, `EN` and
 * `en-US` are one code and `zh-Hant` is `zh`.
 *
 * ## The per-page costs
 *
 * {@link ENGINE_COST_MS} are estimates, not measurements, and they exist for
 * two reasons: a document can be budgeted before the first page is recognized,
 * and the speed ranking needs a documented order instead of a preferred one.
 * The shape behind them is defensible — a native OS call has no interpreter to
 * start, a hosted engine pays one network round trip but not the glyph work,
 * and a single-worker WASM Tesseract at 300 dpi is the slowest of the three —
 * but the numbers themselves are coarse. `tests/engine-plan.test.ts` pins them;
 * replacing them with benchmark numbers is a benchmark's job, not this file's.
 * They are deliberately described as "on this platform": a slower phone will
 * spend more on every engine, but the ordering holds, and the ordering is what
 * the plan uses.
 */

import {
  LARGE_IMAGE_RATIO,
  SPARSE_TEXT_COVERAGE,
  SPARSE_TEXT_ITEM_LIMIT,
  type PageClassification,
  type PageKind,
} from './classify';
import { normalizeLanguageCode } from './language';

// --- Public shapes ---------------------------------------------------------

/**
 * The engines this build can drive.
 *
 * - `windows`: the Windows OS recognizer (`Windows.Media.Ocr`) reached through
 *   the desktop shell. Offline, native, no runtime to start.
 * - `tesseract`: the bundled Tesseract WASM worker (`src/ocr/engine.ts`).
 *   Offline and portable; its language data lives beside the app.
 * - `browser`: the hosted OCR provider the web build can call. It needs the
 *   network, which is the only reason `offlineOnly` has anything to exclude.
 */
export type Engine = 'windows' | 'tesseract' | 'browser';

/** What a plan can select: an engine, or `none` when the page needs no OCR. */
export type PlannedEngine = Engine | 'none';

/** Which engines this device can actually run right now. */
export interface EngineAvailability {
  readonly windows: boolean;
  readonly tesseract: boolean;
  readonly browser: boolean;
}

/** Knobs that describe what the caller wants rather than what the page is. */
export interface EnginePreferences {
  /**
   * Forbid engines that need the network. When true every engine in
   * {@link CLOUD_ENGINES} is removed before ranking, never merely demoted.
   */
  readonly offlineOnly?: boolean;
  /**
   * An engine the caller would like to use. It wins over the speed ranking but
   * loses to the hard constraints: it must be available, allowed by
   * `offlineOnly`, and it is still demoted when it does not document the page's
   * language.
   */
  readonly prefer?: Engine;
}

/**
 * What the classifier measured about one page, plus the language hints.
 *
 * Every numeric field is copied from `classifyPage(...).stats`; the language
 * list usually comes from `detectLanguage` on the document's text, from the PDF
 * metadata, or from a user setting.
 */
export interface PageFacts {
  /** `kind` from `classifyPage`: digital, scanned or hybrid. */
  readonly kind: PageKind;
  /** Text runs on the page, after empty runs were dropped. */
  readonly textItemCount: number;
  /** Glyphs across those runs. Zero means the layer has no text at all. */
  readonly glyphCount: number;
  /** Share of the page covered by glyph boxes, 0..1. */
  readonly textCoverage: number;
  /** Share of the page covered by the largest single raster, 0..1. */
  readonly largestImageRatio: number;
  /** Language hints, any spelling; normalized before use. */
  readonly languages?: readonly string[];
}

/** The decision for one page, plus the evidence for it. */
export interface EnginePlan {
  /** Engine to run, or `none` when the page needs no OCR or none is available. */
  readonly engine: PlannedEngine;
  /**
   * Remaining engines in the order they should be tried if `engine` fails, best
   * first. Empty when nothing else is usable — including every `none` plan.
   */
  readonly fallback: readonly Engine[];
  /**
   * Complete sentences, in decision order, for a UI that shows why. Never empty:
   * a `none` plan explains whether the page needed no OCR or no engine existed.
   */
  readonly reasons: readonly string[];
  /** Documented estimate for the selected engine; 0 for `none`. */
  readonly estimatedMsPerPage: number;
}

/** Options for {@link budgetFor}. */
export interface BudgetOptions {
  /** Wall-clock budget for the run, in milliseconds. Defaults to {@link DEFAULT_BUDGET_MS}. */
  readonly budgetMs?: number;
}

/** What a run of `pages` pages is expected to cost. */
export interface OcrBudget {
  /** Pages the plan was applied to, echoed back for the report. */
  readonly pages: number;
  /** `estimatedMsPerPage × pages`, rounded to whole milliseconds. */
  readonly estimatedMs: number;
  /** True when `estimatedMs` is strictly above the budget. */
  readonly exceedsBudget: boolean;
}

// --- Documented constants --------------------------------------------------

/**
 * Tie-break order, used only when two candidates agree on language support,
 * caller preference and estimated cost. Fixed so a plan never depends on the
 * order the availability object happened to be written in.
 */
export const ENGINE_ORDER: readonly Engine[] = ['windows', 'browser', 'tesseract'];

/** Names used inside the reasons. Sentence case, no trailing period. */
export const ENGINE_LABELS: Record<Engine, string> = {
  windows: 'Windows OCR',
  tesseract: 'Tesseract',
  browser: 'hosted browser OCR',
};

/**
 * Estimated milliseconds to recognize one A4 page at 300 dpi, by engine.
 *
 * - `windows`: 260 ms — one native call, no interpreter start, no model load.
 * - `browser`: 900 ms — remote compute is fast, but the page is uploaded and the
 *   result downloaded, so a network round trip dominates.
 * - `tesseract`: 2400 ms — a single WASM worker segments and classifies every
 *   glyph on the local CPU.
 *
 * See the file comment: coarse, documented, and pinned by the tests.
 */
export const ENGINE_COST_MS: Record<Engine, number> = {
  windows: 260,
  browser: 900,
  tesseract: 2400,
};

/**
 * Engines that need the network. `offlineOnly` removes these before ranking,
 * and nothing downstream may resurrect them.
 */
export const CLOUD_ENGINES: readonly Engine[] = ['browser'];

/**
 * Languages each engine documents support for, as ISO 639-1 codes.
 *
 * The lists follow each engine's own documentation rather than a wish list:
 * Windows OCR only recognizes the language packs Microsoft ships (notably no
 * Thai and no Hindi), Tesseract ships traineddata for every code below (`tha`,
 * `hin` and the rest), and the hosted provider advertises a narrower set than
 * Tesseract. A code missing from a list is therefore a real gap, which is why
 * the ranking treats it as one.
 */
export const ENGINE_LANGUAGES: Record<Engine, readonly string[]> = {
  windows: [
    'ar', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hu', 'it', 'ja',
    'ko', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'tr', 'uk', 'vi', 'zh',
  ],
  tesseract: [
    'ar', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'hu', 'id',
    'it', 'ja', 'ko', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr', 'uk',
    'vi', 'zh',
  ],
  browser: ['ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'pt', 'ru', 'th', 'vi', 'zh'],
};

/**
 * Default wall-clock budget for one run: two minutes.
 *
 * Past that a batch stops reading as a background job and the user expects a
 * progress dialog; a plan that silently spends ten minutes on a 300-page scan
 * is the failure {@link budgetFor} exists to surface before it starts.
 */
export const DEFAULT_BUDGET_MS = 120_000;

// --- Helpers ---------------------------------------------------------------

function percent(ratio: number): string {
  const value = Math.max(0, ratio) * 100;
  if (value === 0 || value >= 10) return `${Math.round(value)}%`;
  return `${value.toFixed(1)}%`;
}

function labelsOf(engines: readonly Engine[]): string {
  return engines.map(engine => ENGINE_LABELS[engine]).join(' and ');
}

function hasText(facts: PageFacts): boolean {
  return facts.textItemCount > 0 && facts.glyphCount > 0;
}

/** The classifier's own sparse test, applied to the facts it reported. */
function hasThinText(facts: PageFacts): boolean {
  return facts.textItemCount <= SPARSE_TEXT_ITEM_LIMIT || facts.textCoverage <= SPARSE_TEXT_COVERAGE;
}

/**
 * Whether the page's content is only pixels.
 *
 * Scanned and hybrid pages always are. A digital page normally is not, with one
 * exception documented in the file comment: no text layer at all but a raster
 * big enough to be the page's content.
 */
function needsOcr(facts: PageFacts): boolean {
  if (facts.kind !== 'digital') return true;
  if (hasText(facts)) return false;
  return facts.largestImageRatio >= LARGE_IMAGE_RATIO;
}

function skipReason(facts: PageFacts): string {
  if (hasText(facts)) {
    if (hasThinText(facts)) {
      return `The page is digital but its text layer is thin (${facts.glyphCount} glyphs across ${facts.textItemCount} runs) with no raster to recognize, so no OCR engine runs.`;
    }
    return `The page is digital: ${facts.glyphCount} glyphs across ${facts.textItemCount} text runs already carry its content, so no OCR engine runs.`;
  }
  return `The page has no text layer and its largest image covers ${percent(facts.largestImageRatio)} of the page, below the ${percent(LARGE_IMAGE_RATIO)} recognition threshold, so no OCR engine runs.`;
}

function ocrNeededReason(facts: PageFacts): string {
  if (facts.kind === 'scanned') {
    return `The page is a scan: its largest image covers ${percent(facts.largestImageRatio)} of the page and its ${facts.glyphCount} glyphs cannot be trusted as content, so OCR is required.`;
  }
  if (facts.kind === 'hybrid') {
    return `The page mixes a raster covering ${percent(facts.largestImageRatio)} of the page with a thin text layer (${facts.glyphCount} glyphs), so its pixels need OCR.`;
  }
  return `The page is classified digital but has no usable text (${facts.glyphCount} glyphs) and a raster covering ${percent(facts.largestImageRatio)} of the page, so it is treated as a scan.`;
}

function normalizeLanguages(input: readonly string[] | undefined): string[] {
  const codes = new Set<string>();
  for (const value of input ?? []) {
    const code = normalizeLanguageCode(value);
    if (code !== 'auto') codes.add(code);
  }
  // Sorted so the hint order cannot leak into the plan (and so reasons are stable).
  return [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function supportsAll(engine: Engine, languages: readonly string[]): boolean {
  if (languages.length === 0) return true;
  const documented = ENGINE_LANGUAGES[engine];
  return languages.every(code => documented.includes(code));
}

interface Candidate {
  readonly engine: Engine;
  readonly supported: boolean;
  readonly msPerPage: number;
}

/**
 * Total order over candidates: language support, then caller preference, then
 * cost, then {@link ENGINE_ORDER}. Every step is a fixed number or a fixed list
 * position, so the sort is stable regardless of how `availability` was built.
 */
function compareCandidates(a: Candidate, b: Candidate, preferred: Engine | undefined): number {
  if (a.supported !== b.supported) return a.supported ? -1 : 1;
  const aPreferred = a.engine === preferred ? 1 : 0;
  const bPreferred = b.engine === preferred ? 1 : 0;
  if (aPreferred !== bPreferred) return bPreferred - aPreferred;
  if (a.msPerPage !== b.msPerPage) return a.msPerPage - b.msPerPage;
  return ENGINE_ORDER.indexOf(a.engine) - ENGINE_ORDER.indexOf(b.engine);
}

function assertMeasure(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`planEngine: ${name} must be a non-negative finite number, got ${String(value)}.`);
  }
}

// --- Planning --------------------------------------------------------------

/**
 * Facts for one page, copied from a `classifyPage` result.
 *
 * The helper exists so callers cannot quietly hand over a kind with stats from
 * a different page, and so the density fields the planner needs are the ones the
 * classifier actually measured.
 */
export function pageFactsFrom(classification: PageClassification, languages: readonly string[] = []): PageFacts {
  const { stats } = classification;
  return {
    kind: classification.kind,
    textItemCount: stats.textItemCount,
    glyphCount: stats.glyphCount,
    textCoverage: stats.textCoverage,
    largestImageRatio: stats.largestImageRatio,
    languages,
  };
}

/**
 * Chooses the engine for one page and explains the choice.
 *
 * Returns `none` either because the page needs no OCR or because this device
 * and these preferences leave no engine that can run; `reasons` always says
 * which, and `fallback` never contains an engine excluded by `offlineOnly`.
 */
export function planEngine(
  facts: PageFacts,
  availability: EngineAvailability,
  preferences: EnginePreferences = {},
): EnginePlan {
  assertMeasure(facts.textItemCount, 'textItemCount');
  assertMeasure(facts.glyphCount, 'glyphCount');
  assertMeasure(facts.textCoverage, 'textCoverage');
  assertMeasure(facts.largestImageRatio, 'largestImageRatio');

  if (!needsOcr(facts)) {
    return { engine: 'none', fallback: [], reasons: [skipReason(facts)], estimatedMsPerPage: 0 };
  }

  const offlineOnly = preferences.offlineOnly ?? false;
  const prefer = preferences.prefer;
  const reasons: string[] = [ocrNeededReason(facts)];

  const reported = ENGINE_ORDER.filter(engine => availability[engine]);
  const blocked = offlineOnly ? reported.filter(engine => CLOUD_ENGINES.includes(engine)) : [];
  const usable = reported.filter(engine => !blocked.includes(engine));

  if (reported.length === 0) {
    reasons.push('No OCR engine is available on this device, so this page keeps its pixels and gets no text layer.');
    return { engine: 'none', fallback: [], reasons, estimatedMsPerPage: 0 };
  }

  if (usable.length === 0) {
    reasons.push(`Offline-only mode rules out ${labelsOf(blocked)}, the only OCR engine this device reports, so this page keeps its pixels and gets no text layer.`);
    return { engine: 'none', fallback: [], reasons, estimatedMsPerPage: 0 };
  }

  if (blocked.length > 0) {
    reasons.push(`Offline-only mode leaves ${labelsOf(blocked)} out of the ranking.`);
  }
  if (prefer && !reported.includes(prefer)) {
    reasons.push(`The requested ${ENGINE_LABELS[prefer]} is not available on this device, so the ranking decided instead.`);
  } else if (prefer && blocked.includes(prefer)) {
    reasons.push(`The requested ${ENGINE_LABELS[prefer]} was skipped because offline-only mode is on.`);
  }

  const languages = normalizeLanguages(facts.languages);
  const candidates: Candidate[] = usable.map(engine => ({
    engine,
    supported: supportsAll(engine, languages),
    msPerPage: ENGINE_COST_MS[engine],
  }));
  candidates.sort((a, b) => compareCandidates(a, b, prefer));

  const [chosen, ...rest] = candidates;
  if (!chosen) {
    // Unreachable: `usable` is non-empty, so `candidates` is too. Kept so the
    // return type stays total under `noUncheckedIndexedAccess`.
    reasons.push('No OCR engine could be ranked for this page, so it keeps its pixels and gets no text layer.');
    return { engine: 'none', fallback: [], reasons, estimatedMsPerPage: 0 };
  }

  const languageList = languages.join(', ');
  if (chosen.supported) {
    for (const candidate of candidates) {
      if (candidate.supported) continue;
      reasons.push(`${ENGINE_LABELS[candidate.engine]} does not document ${languageList}, so it ranks below ${ENGINE_LABELS[chosen.engine]}.`);
    }
  } else {
    reasons.push(`No available engine documents ${languageList}, so ${ENGINE_LABELS[chosen.engine]} runs as a best effort and its text may be poor.`);
  }

  if (chosen.engine === prefer) {
    reasons.push(`OCR runs with ${ENGINE_LABELS[chosen.engine]} at ${chosen.msPerPage} ms per page, as the caller preferred.`);
  } else if (chosen.supported) {
    reasons.push(`OCR runs with ${ENGINE_LABELS[chosen.engine]} at ${chosen.msPerPage} ms per page, the quickest supported engine on this device.`);
  } else {
    reasons.push(`OCR runs with ${ENGINE_LABELS[chosen.engine]} at ${chosen.msPerPage} ms per page.`);
  }

  return {
    engine: chosen.engine,
    fallback: rest.map(candidate => candidate.engine),
    reasons,
    estimatedMsPerPage: chosen.msPerPage,
  };
}

/**
 * Estimates a run of `pages` pages under `plan`.
 *
 * `pages` should be the number of pages the plan applies to — usually the
 * scanned and hybrid pages, not the whole document. A `none` plan costs nothing
 * because no engine runs, and a budget equal to the estimate is *within* budget:
 * `exceedsBudget` is strictly greater-than, so a run tuned to exactly two
 * minutes is not reported as failing.
 */
export function budgetFor(pages: number, plan: EnginePlan, options: BudgetOptions = {}): OcrBudget {
  if (!Number.isInteger(pages) || pages < 0) {
    throw new RangeError(`budgetFor: pages must be a non-negative integer, got ${String(pages)}.`);
  }
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new RangeError(`budgetFor: budgetMs must be a non-negative finite number, got ${String(budgetMs)}.`);
  }
  const perPage = Number.isFinite(plan.estimatedMsPerPage) && plan.estimatedMsPerPage > 0
    ? plan.estimatedMsPerPage
    : 0;
  const estimatedMs = Math.round(perPage * pages);
  return { pages, estimatedMs, exceedsBudget: estimatedMs > budgetMs };
}
