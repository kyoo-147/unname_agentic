import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  E2E_TEST_FLOOR,
  MIN_UNIT_TESTS,
  RELEASE_BLOCKER_CODES,
  RELEASE_WARNING_CODES,
  evaluate,
  type ReleaseBlockerCode,
  type ReleaseGateInput,
  type ReleaseGates,
  type ReleaseLicenses,
  type ReleaseQualityEvidence,
  type ReleaseTests,
} from '../src/core/release-gate';

// --- Fixtures --------------------------------------------------------------

/**
 * The release this repository *could* ship: every gate reported, the counts recorded, the
 * notices scanned, a package artifact on disk. Each test breaks exactly one field, so a
 * failure names the rule that fired rather than the fixture that moved.
 */
const CLEAN: ReleaseGateInput = {
  version: '0.1.0',
  changelogHasVersion: true,
  featuresDocUpdated: true,
  tests: { unit: 380, e2e: 49, native: 12 },
  gates: { typecheck: 'pass', build: 'pass', imports: 'pass' },
  licenses: {
    bundledNotices: ['public/third-party/NOTICE.txt', 'public/third-party/LICENSE-pdfjs.txt'],
    missing: [],
  },
  quality: {
    privacy: 'pass',
    secretBoundary: 'pass',
    resourceLimits: 'pass',
    consentAudit: 'pass',
    retention: 'pass',
    goldenDataset: 'pass',
    ocrBenchmark: 'pass',
    translationBenchmark: 'pass',
    exportBenchmark: 'pass',
    performanceBenchmark: 'pass',
    i18n: 'pass',
    accessibility: 'pass',
    sbom: 'pass',
  },
  packageArtifact: 'dist/pdf-workspace-windows-x64-release-20261120-180552.zip',
};

/** Overrides one release aspect at a time, so a case cannot accidentally change two. */
interface InputOverrides {
  version?: string;
  changelogHasVersion?: boolean;
  featuresDocUpdated?: boolean;
  tests?: Partial<ReleaseTests>;
  gates?: Partial<ReleaseGates>;
  licenses?: Partial<ReleaseLicenses>;
  quality?: Partial<ReleaseQualityEvidence>;
  packageArtifact?: string | null;
}

/** A fresh input every call: `evaluate` must never be handed a shared mutable object. */
function gate(overrides: InputOverrides = {}): ReleaseGateInput {
  return {
    version: overrides.version ?? CLEAN.version,
    changelogHasVersion: overrides.changelogHasVersion ?? CLEAN.changelogHasVersion,
    featuresDocUpdated: overrides.featuresDocUpdated ?? CLEAN.featuresDocUpdated,
    tests: { ...CLEAN.tests, ...overrides.tests },
    gates: { ...CLEAN.gates, ...overrides.gates },
    licenses: { ...CLEAN.licenses, ...overrides.licenses },
    quality: { ...CLEAN.quality, ...overrides.quality },
    packageArtifact:
      overrides.packageArtifact === undefined ? CLEAN.packageArtifact : overrides.packageArtifact,
  };
}

/** Codes of a finding list, in report order. */
const blockerCodes = (input: ReleaseGateInput): string[] =>
  evaluate(input).blockers.map(blocker => blocker.code);
const warningCodes = (input: ReleaseGateInput): string[] =>
  evaluate(input).warnings.map(warning => warning.code);

/** The message of the one blocker with `code`; fails the test when there is not exactly one. */
function soleMessage(input: ReleaseGateInput, code: string): string {
  const matching = evaluate(input).blockers.filter(blocker => blocker.code === code);
  expect(matching).toHaveLength(1);
  return matching[0]?.message ?? '';
}

// --- The clean release -----------------------------------------------------

describe('a release with the evidence in place', () => {
  it('passes with no blocker and no warning', () => {
    expect(evaluate(gate())).toEqual({ ok: true, blockers: [], warnings: [] });
  });

  it('passes on the exact unit-test floor, not just above it', () => {
    const report = evaluate(gate({ tests: { unit: MIN_UNIT_TESTS } }));
    expect(report).toEqual({ ok: true, blockers: [], warnings: [] });
  });
});

// --- Blockers --------------------------------------------------------------

interface BrokenCase {
  /** The blocker the broken input must produce, and the only one. */
  code: ReleaseBlockerCode;
  /** What is broken, as a phrase that completes the test name. */
  what: string;
  /** The release with this one fact broken. */
  broken: () => ReleaseGateInput;
  /** Findings expected for `code`; two bundled dependencies without notice are two. */
  findings?: number;
}

/**
 * One broken release per blocker code.
 *
 * Every entry is a release that *looks* shippable — a version, a changelog, tests, green
 * gates — with one observed fact missing or contradicting it. That is what makes the table
 * a specification of the rules rather than a set of examples: each row isolates one rule.
 */
const BROKEN_CASES: readonly BrokenCase[] = [
  {
    code: 'version-missing',
    what: 'a blank version',
    broken: () => gate({ version: '   ' }),
  },
  {
    code: 'changelog-missing-version',
    what: 'a version no changelog entry names',
    broken: () => gate({ changelogHasVersion: false }),
  },
  {
    code: 'unit-tests-empty',
    what: 'a unit suite that recorded nothing',
    broken: () => gate({ tests: { unit: 0 } }),
  },
  {
    code: 'e2e-tests-below-floor',
    what: 'an end-to-end count under the floor',
    broken: () => gate({ tests: { e2e: E2E_TEST_FLOOR - 1 } }),
  },
  {
    code: 'gate-typecheck-failed',
    what: 'a failed typecheck gate',
    broken: () => gate({ gates: { typecheck: 'fail' } }),
  },
  {
    code: 'gate-build-failed',
    what: 'a failed build gate',
    broken: () => gate({ gates: { build: 'fail' } }),
  },
  {
    code: 'gate-imports-failed',
    what: 'a failed committed-imports gate',
    broken: () => gate({ gates: { imports: 'fail' } }),
  },
  {
    code: 'license-notice-missing',
    what: 'two bundled dependencies without a notice',
    broken: () => gate({ licenses: { missing: ['pdf-lib', '@pdf-lib/fontkit'] } }),
    findings: 2,
  },
  {
    code: 'package-artifact-missing',
    what: 'no package artifact',
    broken: () => gate({ packageArtifact: null }),
  },
  { code: 'quality-privacy-failed', what: 'missing privacy evidence', broken: () => gate({ quality: { privacy: 'fail' } }) },
  { code: 'quality-secret-boundary-failed', what: 'missing secret-boundary evidence', broken: () => gate({ quality: { secretBoundary: 'fail' } }) },
  { code: 'quality-resource-limits-failed', what: 'missing resource-limit evidence', broken: () => gate({ quality: { resourceLimits: 'fail' } }) },
  { code: 'quality-consent-audit-failed', what: 'missing consent-audit evidence', broken: () => gate({ quality: { consentAudit: 'fail' } }) },
  { code: 'quality-retention-failed', what: 'missing retention evidence', broken: () => gate({ quality: { retention: 'fail' } }) },
  { code: 'quality-golden-dataset-failed', what: 'missing golden-dataset evidence', broken: () => gate({ quality: { goldenDataset: 'fail' } }) },
  { code: 'quality-ocr-benchmark-failed', what: 'missing OCR evidence', broken: () => gate({ quality: { ocrBenchmark: 'fail' } }) },
  { code: 'quality-translation-benchmark-failed', what: 'missing translation evidence', broken: () => gate({ quality: { translationBenchmark: 'fail' } }) },
  { code: 'quality-export-benchmark-failed', what: 'missing export evidence', broken: () => gate({ quality: { exportBenchmark: 'fail' } }) },
  { code: 'quality-performance-benchmark-failed', what: 'missing performance evidence', broken: () => gate({ quality: { performanceBenchmark: 'fail' } }) },
  { code: 'quality-i18n-failed', what: 'missing i18n evidence', broken: () => gate({ quality: { i18n: 'fail' } }) },
  { code: 'quality-accessibility-failed', what: 'missing accessibility evidence', broken: () => gate({ quality: { accessibility: 'fail' } }) },
  { code: 'quality-sbom-failed', what: 'missing SBOM evidence', broken: () => gate({ quality: { sbom: 'fail' } }) },
];


describe('blockers', () => {
  for (const testCase of BROKEN_CASES) {
    it(`blocks on ${testCase.what} with ${testCase.code}`, () => {
      const expected = Array<string>(testCase.findings ?? 1).fill(testCase.code);
      expect(blockerCodes(testCase.broken())).toEqual(expected);
    });
  }

  it('produces every blocker code the vocabulary documents, and no code outside it', () => {
    expect([...BROKEN_CASES.map(testCase => testCase.code)].sort()).toEqual(
      [...RELEASE_BLOCKER_CODES].sort(),
    );
  });

  it('explains a missing version instead of guessing what it was', () => {
    expect(soleMessage(gate({ version: '  ' }), 'version-missing')).toBe(
      'The release has no version; a version is what a changelog entry, a package name ' +
        'and an artifact checksum are all keyed to.',
    );
  });

  it('names the version no changelog entry carries', () => {
    expect(soleMessage(gate({ changelogHasVersion: false }), 'changelog-missing-version')).toContain(
      '"0.1.0"',
    );
  });

  it('does not report a changelog gap when there is no version to look for', () => {
    // One fact, one blocker: an entry for "" cannot exist, so reporting it would bury the
    // fact that actually needs fixing.
    expect(blockerCodes(gate({ version: '', changelogHasVersion: false }))).toEqual([
      'version-missing',
    ]);
  });

  it('reports a zero unit count as zero, not as an unreadable one', () => {
    expect(soleMessage(gate({ tests: { unit: 0 } }), 'unit-tests-empty')).toContain(
      'recorded 0 passing tests',
    );
  });

  it('reports a unit count the caller could not supply as no count at all', () => {
    const unreadable = gate();
    // A runner that could not parse its output must not be able to pass by omission.
    (unreadable.tests as { unit: unknown }).unit = 'many';
    expect(soleMessage(unreadable, 'unit-tests-empty')).toContain('no readable passing count');
  });

  it('reads a gate that reported nothing as a failed gate', () => {
    const report = evaluate({ ...gate(), gates: {} as ReleaseGates });
    expect(report.ok).toBe(false);
    expect(report.blockers.map(blocker => blocker.code)).toEqual([
      'gate-typecheck-failed',
      'gate-build-failed',
      'gate-imports-failed',
    ]);
  });

  it('accumulates every broken fact, in the documented order', () => {
    const report = evaluate(
      gate({
        changelogHasVersion: false,
        tests: { unit: 0, e2e: 3 },
        gates: { imports: 'fail' },
        licenses: { missing: ['pdf-lib'] },
        packageArtifact: '   ',
      }),
    );

    expect(report.blockers.map(blocker => blocker.code)).toEqual([
      'changelog-missing-version',
      'unit-tests-empty',
      'e2e-tests-below-floor',
      'gate-imports-failed',
      'license-notice-missing',
      'package-artifact-missing',
    ]);
    expect(report.ok).toBe(false);
  });

  it('reports one licence blocker per missing dependency and names it', () => {
    const report = evaluate(gate({ licenses: { missing: ['pdf-lib', '@pdf-lib/fontkit'] } }));
    expect(report.blockers.map(blocker => blocker.code)).toEqual([
      'license-notice-missing',
      'license-notice-missing',
    ]);
    expect(report.blockers[0]?.message).toContain('"pdf-lib"');
    expect(report.blockers[1]?.message).toContain('"@pdf-lib/fontkit"');
  });

  it('counts a duplicated licence name once', () => {
    expect(blockerCodes(gate({ licenses: { missing: ['pdf-lib', 'pdf-lib'] } }))).toEqual([
      'license-notice-missing',
    ]);
  });

  it('requires nothing of the notice list itself', () => {
    // A release that bundles no third-party code needs no notice; the scan says which
    // dependencies are missing, and this gate does not invent a second opinion.
    expect(evaluate(gate({ licenses: { bundledNotices: [] } })).ok).toBe(true);
  });
});

// --- The e2e floor ---------------------------------------------------------

describe('the end-to-end floor', () => {
  it('accepts the floor itself', () => {
    expect(evaluate(gate({ tests: { e2e: E2E_TEST_FLOOR } })).ok).toBe(true);
  });

  it('blocks one test below the floor', () => {
    expect(blockerCodes(gate({ tests: { e2e: E2E_TEST_FLOOR - 1 } }))).toEqual([
      'e2e-tests-below-floor',
    ]);
  });

  it('names the recorded count and the floor in the sentence a reader sees', () => {
    const message = soleMessage(
      gate({ tests: { e2e: E2E_TEST_FLOOR - 2 } }),
      'e2e-tests-below-floor',
    );
    expect(message).toContain(`${E2E_TEST_FLOOR - 2} tests`);
    expect(message).toContain(`floor of ${E2E_TEST_FLOOR}`);
  });

  it('treats an unreadable e2e count as none, not as the floor', () => {
    const unreadable = gate();
    (unreadable.tests as { e2e: unknown }).e2e = null;
    expect(soleMessage(unreadable, 'e2e-tests-below-floor')).toContain('no readable test count');
  });

  it('floors a fractional count instead of rounding it up', () => {
    expect(evaluate(gate({ tests: { e2e: E2E_TEST_FLOOR + 0.9 } })).ok).toBe(true);
    expect(evaluate(gate({ tests: { e2e: E2E_TEST_FLOOR - 0.1 } })).ok).toBe(false);
  });
});

// --- Warnings --------------------------------------------------------------

describe('warnings', () => {
  it('passes a release that only has warnings, and returns them', () => {
    const report = evaluate(gate({ tests: { native: null }, featuresDocUpdated: false }));
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.warnings.map(warning => warning.code)).toEqual([
      'native-tests-unknown',
      'features-doc-stale',
    ]);
  });

  it('warns, without blocking, when no native count was recorded', () => {
    const report = evaluate(gate({ tests: { native: null } }));
    expect(report.ok).toBe(true);
    expect(report.warnings[0]?.message).toContain('No native test count was recorded');
  });

  it('warns, without blocking, when the native suite recorded zero tests', () => {
    const report = evaluate(gate({ tests: { native: 0 } }));
    expect(report.ok).toBe(true);
    expect(report.warnings[0]?.code).toBe('native-tests-unknown');
    expect(report.warnings[0]?.message).toContain('recorded 0 passing tests');
  });

  it('says nothing about native tests when a count was recorded', () => {
    expect(warningCodes(gate({ tests: { native: 1 } }))).toEqual([]);
  });

  it('produces every warning code the vocabulary documents, and no code outside it', () => {
    const produced = new Set<string>();
    produced.add(evaluate(gate({ tests: { native: null } })).warnings[0]?.code ?? '');
    produced.add(evaluate(gate({ featuresDocUpdated: false })).warnings[0]?.code ?? '');
    expect([...produced].sort()).toEqual([...RELEASE_WARNING_CODES].sort());
  });

  it('keeps warnings out of the way of the verdict when a blocker is present too', () => {
    const report = evaluate(gate({ packageArtifact: null, featuresDocUpdated: false }));
    expect(report.ok).toBe(false);
    expect(report.blockers.map(blocker => blocker.code)).toEqual(['package-artifact-missing']);
    expect(report.warnings.map(warning => warning.code)).toEqual(['features-doc-stale']);
  });
});

// --- Purity ----------------------------------------------------------------

describe('purity', () => {
  it('decides the same thing twice, and never mutates its input', () => {
    const input = gate({ tests: { e2e: E2E_TEST_FLOOR - 1 }, licenses: { missing: ['pdf-lib'] } });
    deepFreeze(input);
    const snapshot = JSON.stringify(input);

    const first = evaluate(input);
    const second = evaluate(input);

    expect(second).toEqual(first);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('reaches no filesystem, no clock and no dependency to make its decision', () => {
    // The module reads a value and returns a value. The only way to prove that without a
    // sandbox is that it has nothing to call: no import, no require, no process, no clock.
    const source = readFileSync(new URL('../src/core/release-gate.ts', import.meta.url), 'utf8');
    const code = stripComments(source);

    expect(code).not.toMatch(/^\s*import\b/mu);
    expect(code).not.toMatch(/^\s*export\b[^\n]*\bfrom\b/mu);
    expect(code).not.toMatch(/\brequire\s*\(/u);
    expect(code).not.toMatch(/\bfrom\s+['"]/u);
    expect(code).not.toMatch(/\bnode:/u);
    expect(code).not.toMatch(/\bnew Date\b/u);
    expect(code).not.toMatch(/\bMath\.random\b/u);
    expect(code).not.toMatch(/\bprocess\./u);
  });
});

// --- Documentation ---------------------------------------------------------

describe('the checklist', () => {
  it('names every blocker and warning code the gate can produce', () => {
    const checklist = readFileSync(
      new URL('../docs/release-checklist.md', import.meta.url),
      'utf8',
    );
    for (const code of [...RELEASE_BLOCKER_CODES, ...RELEASE_WARNING_CODES]) {
      expect(checklist, `docs/release-checklist.md never names ${code}`).toContain(`\`${code}\``);
    }
  });
});

// --- Helpers ---------------------------------------------------------------

/** Freezes every object and array the input reaches, so a mutation throws instead of passing. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

/**
 * Drops comments so the purity checks only see code.
 *
 * Crude on purpose: the file is comments and code with no regex literal or string that
 * contains a comment opener, and a purity check that needed a parser would be a check that
 * could be fooled by the parser's absence.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map(line => line.replace(/(^|[^:])\/\/.*$/u, '$1'))
    .join('\n');
}
