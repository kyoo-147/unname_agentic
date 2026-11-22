/**
 * The release gate (backlog item N08).
 *
 * Every release before this module was checked from memory: someone remembered to run
 * the unit suite, someone remembered how many end-to-end tests there used to be, someone
 * remembered the changelog entry and the third-party notices. A ritual that lives in
 * memory fails quietly on the day the person who remembers is away. This module is the
 * part of that ritual a script can hold: it takes what a runner *observed* and answers
 * whether the release may ship.
 *
 * `evaluate` is the whole of it. It is a decision over evidence, not a runner: it does
 * not read a file, spawn a command, look at a clock or know what a test is.
 * `scripts/release-check.mjs` is the runner — it executes the observable checks, records what it
 * saw, and hands the result here. That split is the point: the rules below can be argued
 * with and tested without a repository, and the runner cannot soften a rule by failing to
 * find a number.
 *
 * Contract:
 *
 * - **Pure and deterministic.** No clock, no randomness, no filesystem, no network, no
 *   dependency, no `import` at all. The same input always produces the same report, and
 *   the input is never mutated.
 * - **Blockers stop a release; warnings do not.** A blocker is something the release
 *   documents *claim* and the evidence contradicts, or something a shipped artifact
 *   needs and does not have. A warning is a fact a person must weigh: the native suite
 *   is not covered by this gate, and a feature inventory can be stale without the
 *   artifacts being wrong.
 * - **Absence is not a pass.** Every field is read in the direction that cannot hide a
 *   fault: a gate value other than `"pass"` is a failure, an unreadable test count is
 *   zero tests, and a blank version is a missing version. A caller that forgot a field
 *   gets the blocker, not a green light.
 * - **Every finding carries a stable English code and one English sentence.** `code` is
 *   what a script, a checklist or a UI switches on; `message` is the sentence a log and a
 *   test read. Codes are documented on {@link ReleaseBlockerCode} and
 *   {@link ReleaseWarningCode} and are never localised here.
 * - **One finding per fact, in a fixed order.** Two blockers with the same code are two
 *   distinct facts (two dependencies with no notice), never the same fact twice. The
 *   order is the order of the checks in {@link evaluate}, so two runs of the same input
 *   print the same table.
 *
 * What it does not do: it does not run a check, verify that a reported number is true, or
 * know whether a test was any good. A release that passes here has produced the evidence
 * this gate asks for — the evidence itself is the runner's job, and pretending otherwise
 * is the failure mode this module exists to end.
 */

// --- Public shape ----------------------------------------------------------

/**
 * What one build-time gate reported.
 *
 * Only `"pass"` passes. A runner records `"fail"` for a command that exited non-zero, and
 * {@link evaluate} reads anything else (a missing field, a typo, a `undefined` from an
 * older runner) as a failure too, because a gate nobody can read is not a gate that ran.
 */
export type GateState = 'pass' | 'fail';

/** The test counts a release rests on. */
export interface ReleaseTests {
  /**
   * **Passing** unit tests recorded for this release.
   *
   * The contract is deliberately narrower than "tests that exist": a run that failed, was
   * skipped or ran nothing does not give this release a suite to stand on, so the runner
   * records 0 and prints the real numbers beside it. A count that is unreadable, negative
   * or not a number is read as no count at all.
   */
  unit: number;
  /**
   * End-to-end tests the caller stands behind: the passing count of a run, or the number
   * the suite declares when the runner lists instead of running. Must reach
   * {@link E2E_TEST_FLOOR}.
   */
  e2e: number;
  /**
   * Passing native tests, or `null` when no count was recorded.
   *
   * The Rust workspace has its own gate and needs an MSVC environment; this one does not
   * run it. A missing count is a warning, never a blocker: it means this gate did not
   * verify the native surface, not that the release is broken. A recorded 0 warns for the
   * same reason with a different sentence.
   */
  native: number | null;
}

/** The build-time gates, one field per command a release depends on. */
export interface ReleaseGates {
  /** `pnpm typecheck`: the sources compile. */
  typecheck: GateState;
  /** `pnpm build`: the shipped build output was produced. */
  build: GateState;
  /** `node scripts/check-committed-imports.mjs`: every committed import resolves at that commit. */
  imports: GateState;
}

/** What a licence scan found for the components shipped in the bundle. */
export interface ReleaseLicenses {
  /**
   * Notice and licence documents the scan read, as paths a reviewer can open.
   *
   * Recorded for the table rather than judged: a release that bundles no third-party
   * component needs no notice, and this module cannot tell those two cases apart. The
   * per-dependency judgement is {@link ReleaseLicenses.missing}.
   */
  bundledNotices: readonly string[];
  /**
   * Bundled dependencies with no notice naming them, by name as the package registry
   * spells it. One blocker each: each one is a separate licence whose text is not
   * travelling with the binary that contains it.
   */
  missing: readonly string[];
}

/** Independent trust/quality checks required before a release can ship. */
export interface ReleaseQualityEvidence {
  readonly privacy: GateState;
  readonly secretBoundary: GateState;
  readonly resourceLimits: GateState;
  readonly consentAudit: GateState;
  readonly retention: GateState;
  readonly goldenDataset: GateState;
  readonly ocrBenchmark: GateState;
  readonly translationBenchmark: GateState;
  readonly exportBenchmark: GateState;
  readonly performanceBenchmark: GateState;
  readonly i18n: GateState;
  readonly accessibility: GateState;
  readonly sbom: GateState;
}

/** Everything the gate needs, as a runner observed it. */
export interface ReleaseGateInput {
  /**
   * The version this release ships, exactly as `package.json` states it (`"0.1.0"`).
   *
   * It is the key the changelog entry, the package name and the artifact checksum are all
   * filed under, so a blank version blocks on its own and skips the checks that need one.
   */
  version: string;
  /**
   * True when a changelog document holds an entry for {@link ReleaseGateInput.version}.
   *
   * The runner reads the document; this module does not parse one. That keeps the rule
   * testable and leaves the definition of an "entry" (a heading, a link, a date) with the
   * document that owns it — `CHANGELOG.md` and `docs/release-checklist.md`.
   */
  changelogHasVersion: boolean;
  /**
   * True when the feature inventory (`docs/features.md`) was updated for this release.
   *
   * Warns rather than blocks: the inventory is where the product's claims live, but a
   * stale one does not make the artifacts wrong, and a runner can only measure a proxy
   * (file timestamps) that no person has confirmed.
   */
  featuresDocUpdated: boolean;
  /** The test counts. */
  tests: ReleaseTests;
  /** The build-time gate outcomes. */
  gates: ReleaseGates;
  /** The licence evidence. */
  licenses: ReleaseLicenses;
  /** Fail-closed trust and product-quality evidence. */
  quality: ReleaseQualityEvidence;
  /**
   * The release package the build produced — a directory or an archive path — or `null`
   * when none was found. A release with nothing to ship is not a release.
   */
  packageArtifact: string | null;
}

/**
 * A finding that stops the release.
 *
 * - `version-missing`: no usable version was recorded.
 * - `changelog-missing-version`: nothing in the changelog names the version being shipped.
 * - `unit-tests-empty`: the unit suite recorded no passing test.
 * - `e2e-tests-below-floor`: the end-to-end count is below {@link E2E_TEST_FLOOR}.
 * - `gate-typecheck-failed`, `gate-build-failed`, `gate-imports-failed`: that gate did not
 *   pass.
 * - `license-notice-missing`: a bundled dependency has no notice; one blocker per name.
 * - `package-artifact-missing`: the release has no package to ship.
 */
export type ReleaseBlockerCode =
  | 'version-missing'
  | 'changelog-missing-version'
  | 'unit-tests-empty'
  | 'e2e-tests-below-floor'
  | 'gate-typecheck-failed'
  | 'gate-build-failed'
  | 'gate-imports-failed'
  | 'license-notice-missing'
  | 'package-artifact-missing'
  | 'quality-privacy-failed'
  | 'quality-secret-boundary-failed'
  | 'quality-resource-limits-failed'
  | 'quality-consent-audit-failed'
  | 'quality-retention-failed'
  | 'quality-golden-dataset-failed'
  | 'quality-ocr-benchmark-failed'
  | 'quality-translation-benchmark-failed'
  | 'quality-export-benchmark-failed'
  | 'quality-performance-benchmark-failed'
  | 'quality-i18n-failed'
  | 'quality-accessibility-failed'
  | 'quality-sbom-failed';

/**
 * A finding the release ships with, if a person accepts it.
 *
 * - `native-tests-unknown`: no native test count was recorded, or zero were. The Rust
 *   surface is outside this gate and this warning says so instead of pretending
 *   otherwise.
 * - `features-doc-stale`: the feature inventory was not updated for this release.
 */
export type ReleaseWarningCode = 'native-tests-unknown' | 'features-doc-stale';

/** One finding: a stable code plus the sentence a human reads. */
export interface ReleaseFinding<Code extends string> {
  code: Code;
  message: string;
}

export type ReleaseBlocker = ReleaseFinding<ReleaseBlockerCode>;
export type ReleaseWarning = ReleaseFinding<ReleaseWarningCode>;

/** The verdict for one release. `ok` is true when there is no blocker; warnings do not flip it. */
export interface ReleaseGateReport {
  ok: boolean;
  blockers: ReleaseBlocker[];
  warnings: ReleaseWarning[];
}

// --- Public constants ------------------------------------------------------

/**
 * The fewest end-to-end tests a release may ship with: 40.
 *
 * The suite declared 49 tests in 15 files at the 2026-11-20 audit (`docs/features.md`).
 * The floor sits about a fifth below that: a legitimate merge or consolidation of a
 * handful of specs does not fail the gate, while deleting or failing to discover a whole
 * file of journeys does. It is a floor on the *count*, which is the only thing a runner
 * can measure without a browser matrix, so it is a tripwire against coverage quietly
 * disappearing — not proof that what remains is any good.
 */
export const E2E_TEST_FLOOR = 40;

/**
 * The fewest unit tests a release may rest on: one, not zero.
 *
 * Not a coverage target and not a replacement for {@link E2E_TEST_FLOOR} — a count of
 * zero means the suite did not run, failed, or ran a file nobody collected, and each of
 * those ships a release with no unit evidence at all.
 */
export const MIN_UNIT_TESTS = 1;

/**
 * Every blocker code, in the order {@link evaluate} can produce them.
 *
 * Exported so a runner, a checklist or a test can enumerate the vocabulary rather than
 * copy it. The order is the report order, not a severity order: every entry stops a
 * release the same way.
 */
export const RELEASE_BLOCKER_CODES: readonly ReleaseBlockerCode[] = [
  'version-missing',
  'changelog-missing-version',
  'unit-tests-empty',
  'e2e-tests-below-floor',
  'gate-typecheck-failed',
  'gate-build-failed',
  'gate-imports-failed',
  'license-notice-missing',
  'package-artifact-missing',
  'quality-privacy-failed',
  'quality-secret-boundary-failed',
  'quality-resource-limits-failed',
  'quality-consent-audit-failed',
  'quality-retention-failed',
  'quality-golden-dataset-failed',
  'quality-ocr-benchmark-failed',
  'quality-translation-benchmark-failed',
  'quality-export-benchmark-failed',
  'quality-performance-benchmark-failed',
  'quality-i18n-failed',
  'quality-accessibility-failed',
  'quality-sbom-failed',
];

/** Every warning code, in the order {@link evaluate} can produce them. */
export const RELEASE_WARNING_CODES: readonly ReleaseWarningCode[] = [
  'native-tests-unknown',
  'features-doc-stale',
];

// --- Private tables --------------------------------------------------------

/** How each gate is named in the report, and what its failure means. */
interface GateRule {
  /** Field of {@link ReleaseGates} this rule reads. */
  key: keyof ReleaseGates;
  /** Blocker produced when the field is not `"pass"`. */
  code: Extract<ReleaseBlockerCode, `gate-${string}-failed`>;
  message: string;
}

/**
 * The gates, in report order.
 *
 * A table rather than three `if`s so the field, the code and the sentence cannot drift
 * apart, and so adding a gate is one entry and one type member.
 */
const GATE_RULES: readonly GateRule[] = [
  {
    key: 'typecheck',
    code: 'gate-typecheck-failed',
    message:
      'The typecheck gate did not pass; the sources of this release are not verified to compile.',
  },
  {
    key: 'build',
    code: 'gate-build-failed',
    message: 'The build gate did not pass; this release has no build output to ship.',
  },
  {
    key: 'imports',
    code: 'gate-imports-failed',
    message:
      'The committed-imports gate did not pass; a committed file imports a module that is ' +
      'not committed, so a fresh clone cannot build.',
  },
];

interface QualityRule {
  readonly key: keyof ReleaseQualityEvidence;
  readonly code: Extract<ReleaseBlockerCode, `quality-${string}-failed`>;
  readonly message: string;
}

const QUALITY_RULES: readonly QualityRule[] = [
  { key: 'privacy', code: 'quality-privacy-failed', message: 'Privacy enforcement evidence did not pass.' },
  { key: 'secretBoundary', code: 'quality-secret-boundary-failed', message: 'Secret-boundary evidence did not pass.' },
  { key: 'resourceLimits', code: 'quality-resource-limits-failed', message: 'Parser/resource-limit evidence did not pass.' },
  { key: 'consentAudit', code: 'quality-consent-audit-failed', message: 'Consent and cloud-route audit evidence did not pass.' },
  { key: 'retention', code: 'quality-retention-failed', message: 'Retention/purge evidence did not pass.' },
  { key: 'goldenDataset', code: 'quality-golden-dataset-failed', message: 'Golden dataset evidence did not pass.' },
  { key: 'ocrBenchmark', code: 'quality-ocr-benchmark-failed', message: 'OCR benchmark evidence did not pass.' },
  { key: 'translationBenchmark', code: 'quality-translation-benchmark-failed', message: 'Translation benchmark evidence did not pass.' },
  { key: 'exportBenchmark', code: 'quality-export-benchmark-failed', message: 'Export benchmark evidence did not pass.' },
  { key: 'performanceBenchmark', code: 'quality-performance-benchmark-failed', message: 'Performance benchmark evidence did not pass.' },
  { key: 'i18n', code: 'quality-i18n-failed', message: 'Internationalisation evidence did not pass.' },
  { key: 'accessibility', code: 'quality-accessibility-failed', message: 'Accessibility evidence did not pass.' },
  { key: 'sbom', code: 'quality-sbom-failed', message: 'SBOM/license evidence did not pass.' },
];

// --- The gate --------------------------------------------------------------

/**
 * Decides whether the release described by `input` may ship.
 *
 * The checks run in the order a release is assembled, and the report keeps that order:
 *
 * 1. the version, because everything else is filed under it;
 * 2. the changelog entry for that version, because a release note is not written after
 *    the release from memory;
 * 3. the unit count, because a suite that did not run proves nothing;
 * 4. the e2e count against {@link E2E_TEST_FLOOR}, because that is where coverage is lost
 *    without anyone noticing;
 * 5. the three build-time gates, because a green test run over sources that do not compile
 *    is not evidence of anything shippable;
 * 6. the third-party notices, because they must travel with the binary and cannot be
 *    added afterwards;
 * 7. the package artifact, because a release nobody can hand over is not a release.
 *
 * Then the two warnings, which are facts this gate reports and does not decide: the native
 * suite count (outside this gate) and the feature inventory (a proxy a person confirms).
 *
 * `ok` is true when no check produced a blocker. Warnings are returned either way and
 * never flip it.
 */
export function evaluate(input: ReleaseGateInput): ReleaseGateReport {
  const blockers: ReleaseBlocker[] = [];
  const warnings: ReleaseWarning[] = [];

  const version = readText(input?.version);
  if (version === null) {
    // Nothing that follows can be keyed without a version, and "no changelog entry for an
    // empty string" would be noise on top of the one fact that matters.
    blockers.push({
      code: 'version-missing',
      message:
        'The release has no version; a version is what a changelog entry, a package name ' +
        'and an artifact checksum are all keyed to.',
    });
  } else if (input?.changelogHasVersion !== true) {
    blockers.push({
      code: 'changelog-missing-version',
      message:
        `No changelog entry names version "${version}"; the release note would be ` +
        'written from memory.',
    });
  }

  const unit = readCount(input?.tests?.unit);
  if (unit === null || unit < MIN_UNIT_TESTS) {
    blockers.push({ code: 'unit-tests-empty', message: unitEmptyMessage(unit) });
  }

  const e2e = readCount(input?.tests?.e2e);
  if (e2e === null || e2e < E2E_TEST_FLOOR) {
    blockers.push({ code: 'e2e-tests-below-floor', message: e2eBelowFloorMessage(e2e) });
  }

  for (const rule of GATE_RULES) {
    if (input?.gates?.[rule.key] === 'pass') continue;
    blockers.push({ code: rule.code, message: rule.message });
  }

  for (const rule of QUALITY_RULES) {
    if (input?.quality?.[rule.key] === 'pass') continue;
    blockers.push({ code: rule.code, message: rule.message });
  }

  for (const name of readNames(input?.licenses?.missing)) {
    blockers.push({
      code: 'license-notice-missing',
      message:
        `The bundled dependency "${name}" has no third-party notice; every component ` +
        'shipped in the bundle must carry its licence notice.',
    });
  }

  if (readText(input?.packageArtifact) === null) {
    blockers.push({
      code: 'package-artifact-missing',
      message:
        'No release package artifact was recorded; there is nothing to hand over under a ' +
        'name and a checksum.',
    });
  }

  const native = readCount(input?.tests?.native);
  if (native === null || native < MIN_UNIT_TESTS) {
    warnings.push({ code: 'native-tests-unknown', message: nativeMessage(native) });
  }

  if (input?.featuresDocUpdated !== true) {
    warnings.push({
      code: 'features-doc-stale',
      message:
        'The feature inventory was not updated for this release; it may describe an older ' +
        'product than the one shipping.',
    });
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

// --- Message building ------------------------------------------------------

/** The sentence for a unit count that is zero or unreadable. */
function unitEmptyMessage(count: number | null): string {
  const recorded = count === null ? 'no readable passing count' : countOf(count, 'passing test');
  return (
    `The unit suite recorded ${recorded}; a release does not rest on a suite that failed, ` +
    'did not run, or ran nothing.'
  );
}

/** The sentence for an e2e count under {@link E2E_TEST_FLOOR}, in the suite's own numbers. */
function e2eBelowFloorMessage(count: number | null): string {
  const recorded = count === null ? 'no readable test count' : countOf(count, 'test');
  return (
    `The end-to-end suite recorded ${recorded}, below the floor of ${E2E_TEST_FLOOR} this ` +
    'gate holds it to; end-to-end coverage has been lost.'
  );
}

/**
 * The sentence for a native count this gate cannot stand on.
 *
 * Two causes, two sentences: "nobody recorded a count" is a gap in the release record,
 * "zero tests were recorded" is a suite that ran and found nothing. Both are warnings for
 * the same reason — the native workspace is verified by its own gate — but a reader
 * should not have to guess which one happened.
 */
function nativeMessage(count: number | null): string {
  if (count === null) {
    return (
      'No native test count was recorded; the Rust surface is outside this gate, so ' +
      'nothing here verifies it.'
    );
  }
  return (
    `The native suite recorded ${countOf(count, 'passing test')}; the Rust surface is ` +
    'outside this gate, so nothing here verifies it.'
  );
}

/** `1 test`, `0 tests`, `12 tests`. */
function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// --- Input reading ---------------------------------------------------------

/**
 * A non-blank string, trimmed; null for anything else.
 *
 * Trimming is not cosmetic: a version of `" "` would otherwise name a changelog entry that
 * cannot exist and an artifact nobody can find.
 */
function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length === 0 ? null : text;
}

/**
 * A test count as a whole number, or null when the caller has no count.
 *
 * A finite number is floored, because half a test is not a count anyone meant to pass; a
 * negative or non-finite value is no count at all, which reads in the same direction as
 * zero under {@link MIN_UNIT_TESTS}.
 */
function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const count = Math.floor(value);
  return count < 0 ? null : count;
}

/** Names from a caller's list, trimmed, deduplicated, in the caller's order. */
function readNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const names: string[] = [];
  for (const entry of value) {
    const name = readText(entry);
    if (name === null || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}
