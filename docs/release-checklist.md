# Release checklist

A full release is gated by observable evidence from the current revision, not by inherited notes or helper-module tests.
The extension artifact directory is `dist/extension`.
A passing extension-only artifact check is not a native desktop release.

- Policy: `extension/viewer/src/core/release-gate.ts`
- Runner: `scripts/release-check.mjs`
- PowerShell verifier: `scripts/verify-release.ps1`
- Relevant tests: `extension/tests/release-gate.test.ts`, `extension/tests/release-scripts.test.ts`, and `extension/tests/quality-gate-scripts.test.ts`
- Backlog plan and evidence ledger: `docs/backlog-implementation-plan.md`

## Run the checks

```powershell
node scripts/release-check.mjs --json
node scripts/release-check.mjs --build --require-native --require-ci
pwsh -File scripts/verify-release.ps1
pwsh -File scripts/verify-release.ps1 -ArtifactsOnly
pwsh -File scripts/verify-release.ps1 -RequireNativePackage -PackagePath <path>
```

`release-check.mjs` runs the unit, typecheck, committed-import, build-output, quality, notice, changelog and package checks.
It does not run Chrome/native E2E or the Rust suite.
Real browser E2E count and CI/native statuses must be supplied from actual runs; an environment variable is a record, not proof by itself.

`--require-native` remains accepted for compatibility, but native pass evidence is mandatory for every invocation.
`--require-ci` also makes a missing or blocked CI record fail the command.
`--build` runs the extension build before checking the output.

`verify-release.ps1` performs tests, typecheck, build, import and extension-artifact checks, then requires a native package for full verification.
`-ArtifactsOnly` deliberately checks only existing extension output and does not represent a full release verification.
`-DryRun` prints the selected mode without running checks or changing files.

Exit codes are 0 for a passing gate, 1 for a blocker or required evidence gap, and 2 when the runner itself cannot run.
A missing native status, a positive test count without `RELEASE_NATIVE_STATUS=pass`, or a blocked native run is not a pass.

## Evidence rows

| # | Evidence | Pass condition | Owning check |
|---|---|---|---|
| 1 | Version and changelog | `package.json` version has a matching `CHANGELOG.md` entry | `release-check.mjs` |
| 2 | Extension unit tests | `pnpm test:extension` exits 0 and produces a readable Vitest summary with passing tests | `release-check.mjs`, `pre-push.ps1` |
| 3 | Typecheck and committed imports | Both current source typecheck and commit-bound import scan exit 0 | All release runners |
| 4 | Extension artifact | `dist/extension/index.html`, assets, or required MV3 files and local references exist | `release-check.mjs`, `verify-release.ps1` |
| 5 | Native tests | A positive count and `RELEASE_NATIVE_STATUS=pass` are recorded from a real Rust run | `release-check.mjs` |
| 6 | Native package | Commit-bound release package, required files, manifest, checksums and archive verify | `release-check.mjs`, `verify-release.ps1` |
| 7 | Chrome/native E2E | Fresh Chrome plus packaged host completes the native messaging workflow | External run evidence; not executed by these scripts |
| 8 | CI | A green CI run is recorded for the release revision; blocked/unknown is not green | `release-check.mjs --require-ci` |
| 9 | Notices and quality evidence | Dependency notices and required local quality gates pass | `release-check.mjs` |
| 10 | Trusted signature | The shipped binary's signature chain is trusted and verified | Manual/platform verification; not established by packaging alone |
| 11 | Independent PDF readers | Representative output opens and is reviewed in at least two independent readers | Manual validation record |
| 12 | Feature inventory | `docs/features.md` is reviewed and updated; timestamp alone is only a warning proxy | `release-check.mjs` |

## Gate finding codes

The policy emits these blockers; a blocker prevents release:

`version-missing`, `changelog-missing-version`, `unit-tests-empty`, `e2e-tests-below-floor`,
`gate-typecheck-failed`, `gate-build-failed`, `gate-imports-failed`, `license-notice-missing`,
`package-artifact-missing`, `quality-privacy-failed`, `quality-secret-boundary-failed`,
`quality-resource-limits-failed`, `quality-consent-audit-failed`, `quality-retention-failed`,
`quality-golden-dataset-failed`, `quality-ocr-benchmark-failed`, `quality-translation-benchmark-failed`,
`quality-export-benchmark-failed`, `quality-performance-benchmark-failed`, `quality-i18n-failed`,
`quality-accessibility-failed`, and `quality-sbom-failed`.

The policy's warning codes are `native-tests-unknown` and `features-doc-stale`.
The runner additionally treats missing/blocked native pass evidence as a required-evidence failure, so the warning does not allow a full release to pass.
CI is recorded separately; a blocked or unknown native/CI record is never printed as a pass.

## Artifact boundary

`dist/extension` is the extension build output and remains the only accepted extension artifact path.
`dist/web` is not the product artifact in this migrated repository and must not be used as evidence of a build or release.
The extension output does not satisfy native package, trusted-signing, Chrome/native E2E, or PDF-reader compatibility gates.

The native package's presence and checksums establish package integrity/provenance as inspected by the verifier.
They do not establish that the application starts, that the host is registered in Chrome, that signing is trusted, or that translated PDFs are correct.

## Recording separate evidence

Record native test evidence only after a real native run:

```powershell
pwsh -File scripts/build-windows.ps1 -Action test
$env:RELEASE_NATIVE_TESTS = '<positive passing test count from that run>'
$env:RELEASE_NATIVE_STATUS = 'pass'
node scripts/release-check.mjs --json
```

A count without `RELEASE_NATIVE_STATUS=pass` is rejected.
`RELEASE_NATIVE_STATUS=blocked` should include the exact blocker in `RELEASE_NATIVE_BLOCKER`.
Never set `pass` from source inspection, a workflow definition, a historical receipt, or a package manifest.

For CI, set `RELEASE_CI_STATUS=pass` only from a successful run of the release revision.
Use `RELEASE_CI_STATUS=blocked` with `RELEASE_CI_BLOCKER` for a real provider/runner blocker; it is not a pass.

For browser/native E2E, record `RELEASE_BROWSER_E2E_TESTS` only from a real Chrome run against the packaged host.
The runner checks that a positive count was provided but cannot independently authenticate that run; attach the actual output/trace to release review.

## Current known gaps

The native release build, native messaging host build, commit-bound package and checksum/archive verification were rerun at HEAD `c3a5de5` and pass locally. This establishes build and package integrity only.
The current Chrome/native E2E, trusted signing, Chrome registry/native-host installation, CI and independent PDF-reader checks remain unverified.
Do not infer runtime acceptance from extension module tests, package integrity, or a previous branch's receipt.
Translated-PDF writing is mounted in the desktop Save As flow, but remains quality-gated until an end-to-end output is verified in independent readers.
K10 shared workspace/per-document RBAC remains deferred until deployment and identity scope are approved.
