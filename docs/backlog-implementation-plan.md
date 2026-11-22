# Document Intelligence backlog implementation and release plan

## Purpose and evidence boundary

This plan turns `docs/backlog-e-n.md` into an execution ledger, with release prerequisites recorded separately from product capabilities.

The backlog's checkmarks are inherited claims from its stated research/audit snapshots, not fresh verification by this plan.
Only a new command output, browser trace, package inspection, screenshot, or reader round-trip can advance an item to verified.
A unit test for an extension module is not proof of native integration, Chrome/native messaging, packaged runtime behavior, or translated-PDF quality.

## Current release truth

| Gate or claim | Current status | Evidence needed to change status | Release consequence |
|---|---|---|---|
| Extension source/test surface | Implemented by repository source and the extension Vitest suite; this plan does not claim a fresh test run | Focused suite output from the current tree | Unit evidence only; not an integration or release claim |
| `dist/extension` artifact | Valid target for the extension build and artifact checks | Build output plus `scripts/verify-release.ps1 -ArtifactsOnly` | Extension artifacts may be checked independently; this is not a full desktop release |
| Standalone `dist/web` product | Not an accepted artifact claim in the migrated repository | No gate currently emits or accepts this as the release artifact | Do not cite `dist/web` as a build/release pass |
| Extension browser E2E lane | Implemented as `pnpm test:e2e:extension`; Playwright discovers 42 real cases against unpacked `dist/extension`, covering MV3 startup, reader import/navigation and reload locale, popup language persistence/fallback, reading modes and accessible controls, export-empty warnings, and synthetic capture-reader handoff in isolated Chrome profiles | `pnpm build`, `pnpm exec playwright test --config extension/playwright.config.ts --list`, plus a real `CHROME_PATH=... pnpm test:e2e:extension` run | Extension-browser coverage floor is met; discovery is not a browser pass and does not satisfy native messaging or full release. Synthetic capture does not prove capture permission or native-host roundtrip |
| Chrome/native E2E and native messaging | Unverified | Fresh Chrome plus built/registered native host, clean profile, exercised reconnect/checksum/duplicate behavior and round-trip, captured output | Block a full release; do not set `RELEASE_BROWSER_E2E_TESTS` from the extension-only lane |
| Native build and tests | Unverified for this checkout | Reproducible native build and Rust test output on the required Windows toolchain | Block a full release; count-only environment input is insufficient |
| Native package | Unverified for this checkout | Fresh package, provenance manifest, checksums, archive, required files, and verification output | Block a full release |
| Trusted signing | Unverified; the historical record describes a self-signed preview only | CA-trusted signature verification on the shipped binary | Do not claim trusted Windows signing |
| Registry/native-host install and registration | Unverified in a clean Chrome installation | Install/registration test and Chrome handshake from the packaged host | Do not claim installed native messaging |
| CI | Unverified; workflow configuration is not a successful run | Green run attached to the current revision, or documented exact external blocker | Do not claim CI pass |
| Independent PDF readers | Unverified | Open representative output in at least two independent PDF readers and record results | Do not claim reader compatibility |
| Translated-PDF writing | Dependency-gated; do not infer product capability from PDF writer unit tests or extension modules | End-to-end translated document creation plus independent-reader checks | Keep output claim blocked until demonstrated |
| K10 shared workspace / per-document RBAC | Deferred and dependency-gated by the backlog's own deployment/auth boundary | Approved identity/deployment scope, threat model, and implementation acceptance | Do not start as a local-only feature or claim enterprise RBAC |

The release scripts must require explicit native pass evidence and a native release package for full verification.
The extension artifact remains `dist/extension`; an extension-only artifact check is not a desktop release.

## Backlog row ledger

Status below is the status recorded in `docs/backlog-e-n.md`, not a fresh pass attestation.
The companion gate column records what can actually release the claim.

| Backlog rows | Recorded status in source backlog | Implementation sequencing / dependency | Verification gate |
|---|---|---|---|
| A26-A28, B07-B08, C09-C15, C18, C22, D02, D11 (partial checklist) | The source backlog lists mixed historical statuses; current audit facts override any implied current release proof | Resolve evidence for each row independently; do not combine claims across surfaces | Real source PDFs, export review, Chrome/native host, native build and tests, CI run, and integration evidence as applicable |
| Native release and cross-surface integration (C-series, B07-B08, L01-L04) | Unverified for current checkout | Requires native build/toolchain, packaged host, clean Chrome profile and actual integration | Native tests/package plus Chrome-to-native round-trip E2E |
| N08 release scripts and D11 CI | Partial/unverified in current audit | Workflow definition does not satisfy CI; release runner must observe current evidence | Current CI run and fail-closed release-check output |
| E01-E14 | Backlog marks most as implemented/tested | Preserve per-feature provenance; extension/viewer evidence does not imply native parity | Feature-specific tests and real input/output evidence; E12 format converter checks remain distinct from PDF translation |
| F01-F14 | Backlog marks most as implemented/tested | Query-driven OCR and language/quality scope need real corpus before general claims | Golden corpus, CER/WER, calibration and actual OCR output; synthetic fixtures alone do not establish difficult-image quality |
| G01-G16 | Backlog marks most as implemented/tested | Translation provider behavior and PDF writing remain separate gates; do not assume tests equal live provider/output fidelity | Translation workflow evidence, independent reader checks, and real document review |
| H01-H16 | Backlog marks most as implemented/tested | Export tests cover the code paths they exercise, not broad reader compatibility or translation workflow | Multi-reader open, visual/fidelity review, font and searchable-text checks |
| I01-I14, J01-J10 | Backlog marks most as implemented/tested | Keep citations and research enrichment bounded to source evidence and consent | Fixed corpus, citation-hit/abstention evidence, and API-specific integration where applicable |
| K01-K09 | Mostly implemented/partial in source backlog | K03-K09 require their respective durable workflow and persistence checks; do not treat extension test moves as native integration | Workflow tests and persistence/recovery evidence at the product surface |
| K10 | Deferred | Requires an approved shared deployment and identity/RBAC boundary; not available from local-only scope | Explicit product/security approval before implementation; multi-user authorization and audit tests |
| L01-L04, L10 | Unverified/empty in source backlog | Chrome/native E2E, capture permissions, cross-surface progress/sync and model management require actual integrations | Full desktop/Chrome E2E and runtime evidence |
| L05-L09 | Mixed: several marked tested, L06/L09 partial | Unit-tested helpers do not prove UI wiring; wire and validate before capability claims | Product-surface interaction tests and accessibility evidence |
| M01-M08 | Mostly implemented/tested in source backlog; M06 partial | Keep cloud consent/audit integration distinct from pure helpers; no hidden cloud fallback | Network-capture/privacy tests and end-to-end consent/audit trail |
| N01-N08 | Mixed: N01/N03/N04/N08 marked tested; N05/N06 partial; CI/native checks unresolved | Fresh benchmark execution, not fixture presence or stale metrics; release runner must fail closed | Actual benchmark output, accessibility audit, CI run and full native release evidence |

### Source backlog status corrections

- An extension-module test or a moved test file establishes, at most, behavior at that module's test seam.
  It does not establish integration with the native desktop.
- Current Chrome/native E2E, the native package, trusted signing, registry/native-host installation, CI, and independent PDF-reader validation are unverified.
- The backlog's older historical checkmarks and receipts must not override those current evidence gaps.
- Backlog statuses are intentionally not bulk-rewritten here: owners should update each row only after capturing the evidence named by its acceptance criterion.

## Execution order and gates

1. **Restore reliable local gates.** Keep `pnpm test:extension` as the owned unit command, keep typecheck/build/import checks fail-closed, and ensure quality tests exercise the command actually used by the gate.
2. **Establish native prerequisites.** Build native sources and run the Rust suite in a supported Windows/MSVC environment. Record exact toolchain, revision, command, exit status, and test summary.
3. **Package one revision.** Build the native package from that revision, inspect its manifest/files/checksums/archive, and run the verifier. Packaging is not a native runtime or quality certificate.
4. **Prove host and browser integration.** Register/install the packaged host only in a controlled test environment; use a clean Chrome profile to prove request/response, duplicate handling, permissions, and failure behavior.
5. **Prove user-facing output.** Demonstrate translated-PDF creation and open representative exports in at least two independent readers. Record fidelity limitations rather than silently accepting them.
6. **Close CI and signing claims.** Require a green CI run for the release revision. Treat a self-signed preview as untrusted; only report trusted signing after verifying the shipped signature chain.
7. **Defer K10 until scope is approved.** Define deployment, authentication, tenant isolation, authorization, retention, and audit before building shared workspace/RBAC.

## Stop conditions

A full release remains blocked when native evidence is absent, count-only, stale, or not bound to an identified run; when the commit-bound native package is missing; or when Chrome/native integration is not demonstrated.
`dist/extension` may be validated as an extension artifact, but it cannot satisfy native package, native E2E, trusted-signing, or standalone-web claims.
No CI, registry, signing, or production mutation is authorized by this plan.
