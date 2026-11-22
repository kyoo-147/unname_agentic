# Native desktop completion plan and acceptance contract

Status reviewed against integration HEAD `76a0944` on the current worker worktree.

This plan separates code that exists, deterministic tests, real desktop/browser execution, and product acceptance.

The requested end-to-end journey is not presently verified.

## Acceptance levels

| Level | Meaning | Current status |
|---|---|---|
| Harness | Discovery, prerequisites, reporting, and mock-contract guards exist. | Implemented by `scripts/e2e/native-desktop.mjs`; discovery and four contract tests pass. |
| Real execution | A built native executable and Chrome actually run with isolated profiles and retain execution artifacts. | Not run. This environment has no native executable, Chrome binary, built extension, or host binary. |
| Product acceptance | Every workflow stage is asserted against actual UI, persisted bytes, native messaging, OS permissions, and independent readers. | Not accepted. No real execution evidence. The acceptance runner keeps `fullAcceptance: false` even if an external assertion file claims passes. |

Mock-only tests are contract checks, never a substitute for either real execution or product acceptance.

## Baseline audit

Evidence in the repository includes native PDF import/library persistence, a GPUI development input/capture driver, native bridge protocol validation and duplicate/checksum tests, extension UI unit tests, and a Chrome extension E2E runner that uses a temporary browser profile.

The existing extension capture test creates synthetic canvas pixels. It does not prove that Chrome granted a real screen/window/tab capture permission.

The native bridge tests exercise protocol or inbox seams, not a Chrome-registered host launched by a clean Chrome profile.

`native-shell/src/export_native.rs` explicitly rejects `ExportFormat::Pdf` as a translated-PDF writer. Retained-source PDF Save As is not evidence of translated-PDF output.

`native-shell/src/devtools.rs` supports `FDL_SCRIPT` scripted input and screenshots, but input replay alone is not an assertion of application state.

Existing design/status docs are evidence leads, not fresh execution evidence. In particular, `docs/native-product-status.md` and `docs/desktop-verification.md` describe prior runs and report remaining gaps.

The supplied backlog says 17 yellow items, but its visible A-D table expands to 16 distinct codes (A26-A28, B07-B08, C09-C15/C18/C22, D02, D11). Preserve the backlog's stated 17-item release target, but require the owner to reconcile the missing code before claiming N01 complete.

## Exact integration order for the other six lanes

Use one integration writer and merge only reviewed lane commits. Stop on conflict or failed lane evidence rather than silently resolving scope.

1. **`import-metadata`**: integrate source identity/import metadata first. Confirm source hash and stable document identity survive import, restart, and duplicate handoff. This becomes the fixture identity contract used by the rest.
2. **`ocr-quality`**: integrate OCR/layout output against the import identity and region geometry from step 1. Preserve a deterministic corpus and separate OCR confidence from proof of OS capture permission.
3. **`native-desktop`**: integrate native reader/UI and persistence changes against the frozen import and OCR contracts. Build the real desktop with `devtools` only for test automation; release builds remain unscripted.
4. **`rag-research`**: integrate retrieval/citation contracts after document block IDs and geometry are stable. Require citation navigation to resolve to the same source document/block after reload.
5. **`research-workspace`**: integrate workspace CRUD and backlinks after the citation IDs and library persistence contract are stable. Verify workspace state survives restart and document-source links remain valid.
6. **`quality-release`**: integrate final release/quality policy last. It must not downgrade a failed real-runtime gate to a passing mock gate. Refresh commands/evidence hashes after all prior merges.
7. Run this lane's desktop/Chrome harness over the merged tree, then independent review of changed files, evidence, and git status. This lane is not a substitute for missing product implementations in the six lanes.

If the actual lane artifacts have different commits or contracts, update the lane mapping before merging; the names above reflect the six sibling worker lanes in this wave.

## Required journey and final gate matrix

| Gate | Native-shell responsibility | Extension/native contract | Test and retained artifact | Dependency | Final acceptance rule | Current status |
|---|---|---|---|---|---|---|
| Import | Open fixture in the real built app; retain immutable source bytes and stable ID. | Transfer supplies validated PDF bytes, metadata, and digest; never accept an arbitrary path. | Native import/reload assertions; original and imported SHA-256, process log, native-window screenshot. | import-metadata | Real app import; source hash matches; library entry survives restart. | Existing native import code/tests; not run in this environment. |
| OCR/markup | Render OCR blocks and edits with page geometry and saved state. | Block IDs, page coordinates, confidence, and edit revision remain stable. | OCR fixture assertions, markup screenshot, persisted edit record. | Import + OCR-quality | Edit is visible, source PDF remains unchanged, reload restores the edit. | Extension unit coverage exists; native journey not run. |
| RAG/citation navigation | Show answer/citations and navigate to exact source block. | Citation identifies document revision, page, block, and region. | Query/citation assertion, source-pane screenshot, navigation trace. | OCR blocks + rag-research | Clicked citation selects the cited block, not only a plausible page. | Not verified in native UI. |
| Research workspace | Create and reopen note/workspace with source backlink. | Backlink uses stable document/block identity; merge/conflict states are explicit. | Workspace JSON/database diff, reopened screenshot, backlink assertion. | RAG citation IDs + research-workspace | Note and source link survive process restart. | Not verified in native UI. |
| Translated-PDF Save As | Native Save As writes translated output bytes, not a renamed copy of source. | Translation records and export provenance bind to source revision. | Independent PDF reader inspection, output hash, text extraction, page render diff. | PDF writer implementation + export-release | Output opens in two independent readers and contains verified translated content. | Blocked: current native PDF export deliberately rejects translated PDF writing. |
| Persistence/reload | Quit and launch the real executable using the same isolated library. | Extension/native duplicate delivery remains idempotent after restart. | Before/after library index and file hashes; screenshots/logs. | Import + all persisted records | Same document/workspace state, no duplicate document, no stale links. | Native persistence tests exist; full journey not run. |
| Extension/native handoff | Consume only a validated, complete native inbox transfer. | Exact allowed extension origin, framing, session binding, digest, monotonic sequence. | Real Chrome profile, registered host logs, extension ID/manifest, inbox/ack trace. | Native desktop + bridge-capture lane | Chrome itself starts registered host; actual PDF roundtrip imports once. | Protocol tests exist; real Chrome registration not run. |
| Reconnect/duplicate/checksum | Resume the same session; ignore duplicate/stale events; reject corruption before parser/import. | `resume` exact binding; duplicate/replay suppression; checksum and byte count mandatory. | Fault injection trace, accepted event IDs, library count, corrupt payload rejection. | Handoff | Reconnect resumes one binding; duplicate adds no entry; wrong digest never reaches importer. | Deterministic tests exist; real OS roundtrip not run. |
| Cleanup | Remove only temporary directories created by the run. | No mutation to user library, Chrome profile, registry, or unrelated inbox. | Cleanup report, temp-root absence, evidence hashes outside temp root. | All gates | Cleanup succeeds or runner fails and reports retained path. | Harness cleanup implemented; runtime cleanup not exercised. |

Capture evidence must label source explicitly. A synthetic image/canvas is **synthetic capture wording**, never permission proof. `osPermissionProof` is false unless a separately reviewed real OS permission artifact exists.

## Backlog-to-native/extension/test/artifact/dependency/final-gate map

Every ID below is included once. Rows inherit the shared acceptance contract immediately below, and the gate column points to the journey or release gate above. `Proposed` means a target path/contract, not an implementation claim.

Shared per-item mapping: native implementation is in the category's native owner; extension contract is the category's extension owner; test is the named category test plus a real UI assertion at the mapped gate; artifact is the named category output plus the evidence types in the gate matrix; dependencies are the category predecessors; no item becomes accepted from unit tests alone.

| Category and IDs | Proposed native-shell owner | Extension contract and focused test/artifact | Dependency and final gate |
|---|---|---|---|
| A26 | `native-shell/src/export_native.rs` PDF writer, currently absent. | `extension/viewer/src/export`; independent reader + bytes/render evidence. | Writer + release; translated-PDF Save As. |
| A27 | `native-shell/src/pdf_reader.rs` OCR engine selection/quality display. | `extension/viewer/src/core/ocr`; multilingual CER/WER corpus report. | OCR-quality lane + licensed corpus; OCR/markup + N05. |
| A28 | Native font/script shaping and accessible text in PDF reader. | `extension/viewer/src/i18n.ts` and reader; RTL/CJK visual, copy, and search matrix. | Font and native rendering support; OCR/markup + N04. |
| B07/B08 | `native-shell/src/native_bridge.rs` consumer, acknowledgments, replay control. | `extension/native-bridge.ts`; real Chrome-to-host launch and reverse command E2E. | Host registration + exact origin; extension/native handoff. |
| C09/C10 | `native-shell/src/settings.rs`, `pdf_reader.rs`, credential vault boundary. | Provider-validation and explicit-consent contract; valid/invalid key E2E with log scan. | OS vault/runtime; privacy gate M02. |
| C11/C12 | Native capture, source picker, self-capture exclusion. | `extension/viewer` capture permission/session contract; real OS tab/window/screen and multi-monitor traces. | User gesture and OS permission; capture permission gate, separate from synthetic capture. |
| C13 | Native bridge lifecycle and session state. | `extension/native-bridge.ts`; reconnect, duplicate, timeout and event-delivery trace. | B07/B08; extension/native handoff. |
| C14/C15 | Native theme/localization modules and native controls. | Reader locale/theme contract; screenshot matrix by locale/theme/DPI. | CJK/RTL shaping where applicable; native visual gate. |
| C18 | Native provider/model settings and capability display. | Model catalogue schema/capability/health checks; structured catalogue artifact. | Provider adapter and health isolation; provider gate. |
| C22 | `native-shell/src/export_native.rs` and native Save As panel. | Export request/result bytes and conflicts; Save As/permission-path E2E. | Export implementations; translated-PDF Save As. |
| D02 | Native job/task cancellation and stale-result guard. | Abort signal to every provider call; abort/no-commit/no-double-submit trace. | Provider cancellation support; N02 cancellation gate. |
| D11 | No product module; use existing test runners and release gate. | CI configuration is outside this lane's edit scope; record credentials/billing blockers. | All tests runnable; final release gate. |
| E01 | `native-shell/src/pdf_reader/document.rs` classifier/router. | Per-page classification/engine-reason contract; mixed born-digital/scan fixture report. | Import identity + OCR adapter; Gate 1/2. |
| E02 | `native-shell/src/pdf_reader/document.rs` reading-order model. | Ordered block/column contract; multi-column fixture and visual diff. | E04 IR; Gate 2. |
| E03 | `native-shell/src/pdf_reader/document.rs` semantic block model. | Typed block and parent-child contract; schema/bbox test. | E04 IR; Gate 2. |
| E04 | Native immutable document/provenance representation. | Versioned IR/source hash contract; serialization/hash artifact. | Import identity; Gate 1. |
| E05 | Native outline/section navigation. | Stable block/heading anchor; click-to-source screenshot/trace. | E02/E03; Gate 2. |
| E06 | Native table cell model/render. | Row/column/span provenance; table fixture and CSV/XLSX check. | E03 IR; Gate 2/3. |
| E07 | Native formula preservation/render. | LaTeX and protected-token contract; formula copy/export fixture. | E03/E04; Gate 2/3. |
| E08 | Native figure/caption relation/navigation. | Figure/caption IDs and source bbox; click focus screenshot. | E03/E04; Gate 2. |
| E09 | Native header/footer classification toggle. | Non-content block flags; repeated-page corpus diff. | E02; Gate 2. |
| E10 | Native link/footnote/reference graph. | Safe internal-link map; PDF link roundtrip artifact. | E04; Gate 3. |
| E11 | Native span-level language metadata. | Per-span language tags; bilingual fixture and route trace. | E04; Gate 2. |
| E12 | Native format adapters. | Canonical IR per format; licensed fixtures and metadata/hash report. | E04 + parser/license review; Gate 3. |
| E13 | Native import health/fallback reporting. | Typed errors and fallback choices; corrupt-PDF matrix report. | E01; Gate 0/1. |
| E14 | Native metadata review UI. | Editable metadata fields/provenance; persisted before/after artifact. | Import; Gate 3. |
| F01 | Native OCR engine adapter and language-pack selection. | OCR script/language adapter contract; language coverage matrix. | OCR-quality lane + licensing; Gate 0/2. |
| F02 | Native preprocessing pipeline controls. | Deterministic image transform contract; before/after and measured quality report. | F01; Gate 2/N05. |
| F03 | Native page dewarp geometry. | Transform provenance and coordinate mapping; curved-page visual evidence. | F02; Gate 2. |
| F04 | Native confidence rendering/edit UI. | Confidence and region IDs; low-confidence review screenshot/test. | F01/E04; Gate 2. |
| F05 | Native searchable-PDF export. | Text-layer alignment and source-image retention; independent reader/copy/search check. | A26 writer; Gate 1. |
| F06 | Native mixed OCR/text layer merge. | Deduped spans and provenance; duplicate-layer regression fixture. | E01/F01; Gate 2. |
| F07 | Native selected-region OCR tool. | Query-to-region allowlisted tool trace; step/size/consent assertions. | F04/I08; Gate 2. |
| F08 | Native bbox citation/highlight navigation. | Region polygon contract; source-focus screenshot and coordinate assertion. | E04/I01; RAG/citation gate. |
| F09 | Native selective re-OCR controls. | Region-only job and revision contract; prove unaffected pages unchanged. | F04/F07; Gate 2. |
| F10 | Native marks/handwriting classifier. | Type/confidence result; representative labeled corpus report. | OCR adapter; Gate 2/N05. |
| F11 | Native engine consensus provenance. | Engine/version/cost result; consensus reproducibility artifact. | F01 + licensed engines; Gate 2. |
| F12 | Native figure understanding/crop viewer. | Crop-to-source citation; figure explanation support report. | F08/I10; Gate 2. |
| F13 | Native numeric/date/unit QA flags. | Evidence-linked warning payload; adversarial numbers fixture. | OCR text + E11; Gate 2. |
| F14 | Native review/correction persistence. | User-confirmed correction version; source unchanged and reload evidence. | F04/E04; Gate 3. |
| G01 | Native PDF writer; currently blocked by A26. | Export bytes/provenance; two-reader compatibility artifact. | A26; translated-PDF Save As. |
| G02 | Native bilingual PDF layout. | Source/target block link; page mode render matrix. | G01/G07; Gate 1/3. |
| G03 | Native section-aware translation jobs. | Segment context and cross-page provenance; sentence-boundary fixture. | E05 + provider; Gate 3. |
| G04 | Native TM version store. | Segment/source revision contract; repeat reuse and provenance test. | E04; Gate 3. |
| G05 | Native glossary and locked terms. | Versioned glossary and provider-invariant protected terms; roundtrip fixture. | Provider contract; Gate 3. |
| G06 | Native protected token handling. | Placeholder identity/integrity schema; adversarial number/formula/citation tests. | E07; Gate 3. |
| G07 | Native layout optimizer. | Overflow status/warnings; fit and visual evidence. | G01 + font support; Gate 3. |
| G08 | Native source/target review diff. | Block revision and accept/retranslate commands; persisted diff artifact. | E04/G03; Gate 3. |
| G09 | Native page-range export. | Explicit selected page list; output page count/hash test. | G01; Gate 3. |
| G10 | Native style profile/settings. | Versioned prompt/profile contract; persisted settings and request trace. | Provider consent; Gate 3. |
| G11 | Native translation QA review. | Evidence-backed QA finding; numeric/term/negation regression report. | G05/G06; Gate 3. |
| G12 | Native translated table layout. | Cell ID/value/formula preservation contract; row/col alignment report. | E06; Gate 3. |
| G13 | Native figure text overlay. | Opt-in OCR overlay linked to source image; preserve/overlay visual pair. | F12; Gate 3. |
| G14 | Native engine router and override display. | Route reason/privacy/telemetry contract; deterministic route matrix. | C18/M01; Gate 3. |
| G15 | Native glossary/TM exchange flow. | UTF-8 import/export schema; malformed and roundtrip files. | G04/G05; Gate 3. |
| G16 | Native reviewer state/audit. | Translator/editor/approver event contract; audit log and permission tests. | M06; Gate 4. |
| H01 | Native dialogs and serializers. | Format request/result contract; bytes and conflict/permission E2E. | Individual writer; Gate 1/3. |
| H02 | Native embedded/subset fonts. | Font manifest/provenance; CJK/RTL independent-reader renders. | A28 + H01; Gate 1. |
| H03 | Native vector/image/link/bookmark preservation. | Object mapping and output provenance; per-page visual/link diff. | G01/H01; Gate 1. |
| H04 | Native annotation model/writeback. | Annotation IDs, geometry, revision; reopen in independent reader. | E04 + writer; Gate 3. |
| H05 | Native object insert/edit tools. | Document coordinate and undo contract; export/reopen image evidence. | H01/H03; Gate 3. |
| H06 | Native inline edits/autosave. | Revision/undo contract; persistence and source comparison. | E04; Gate 3. |
| H07 | Native page operations. | Page identity remap; thumbnails/order/export assertion. | H01; Gate 3. |
| H08 | Native table/formula extraction. | Cell and formula provenance; CSV/XLSX/LaTeX output fixture. | E06/E07; Gate 3. |
| H09 | Native faithful bundle export. | HTML/media relationship contract; ZIP links/assets inspection. | E04/H01; Gate 3. |
| H10 | Native PDF text/visual diff. | Version/revision alignment; masked diff artifact. | E04; Gate 3/N04. |
| H11 | Native permanent redaction. | Sanitized output and explicit confirmation; search/copy/object inspection. | H01/H03 + security review; Gate 4. |
| H12 | Native form fields and flatten. | Field schema/value contract; independent reopen/flatten tests. | H01; Gate 3. |
| H13 | Native signature display/sign flow. | Explicit distinction of drawn vs certificate signature; independent validation report. | H01 + security/legal review; Gate 4. |
| H14 | Native archival/sanitization pipeline. | PDF/A profile and metadata report; external validator output. | H01/H02; Gate 4. |
| H15 | Native tagged PDF/UA output. | Semantic tag structure; assistive-tech/accessibility artifact. | E03/H01; Gate 4. |
| H16 | Native batch utilities. | Per-file operation/provenance contract; before/after quality and confirmation log. | H01 + M policies; Gate 4. |
| I01 | Native chat citation rendering and selection. | Document revision/page/block/polygon citation schema; click-navigation trace. | E04/F08; RAG/citation gate. |
| I02 | Native retrieval service. | Lexical/vector/filter trace schema; deterministic retrieval report. | E04 + index; Gate 2. |
| I03 | Native IR-aware chunking. | Stable block/cell chunk provenance; table/formula boundary tests. | E04/E06/E07; Gate 2. |
| I04 | Native project multi-PDF chat. | Source identity per cited result; cross-document query artifact. | I01/I02 + workspace; Gate 2. |
| I05 | Native selection-aware question context. | Selected block ID contract; selected/unselected query comparison. | I01; Gate 2. |
| I06 | Native sourced summaries. | Outline/findings/caveats citations; support audit artifact. | I01/I02; Gate 2. |
| I07 | Native evidence matrix. | Both-side citations per comparison cell; source navigation trace. | I04; Gate 2. |
| I08 | Native allowlisted document tools. | Tool schema, budgets, trace and denial contract; injection/resource tests. | I02/M04; Gate 2. |
| I09 | Native table Q&A/cell evidence. | Cell IDs and calculation trace; recomputation fixture. | E06/I02; Gate 3. |
| I10 | Native multimodal source crop explanation. | Crop/source polygon citation; figure/formula support report. | F12/F08; Gate 3. |
| I11 | Native abstention/evidence support. | Explicit insufficient-evidence state; unanswerable query report. | I01/I02; Gate 2. |
| I12 | Native offline routing/model mode. | Network-deny assertion and local model provenance; packet/network evidence. | M01/C18; Gate 4. |
| I13 | Native versioned prompt templates. | Template ID/version/parameter contract; rendering and injection tests. | I08/M04; Gate 3. |
| I14 | Native sourced report/brief export. | Citation bindings and unreviewed status label; exported report artifact. | I01/I06; Gate 3. |
| J01 | Native research metadata review. | Metadata source/provenance contract; user review and accepted-value artifact. | Import metadata lane; research-workspace gate. |
| J02 | Native bibliography/Zotero exchange. | Stable citation key and duplicate policy; BibTeX/RIS roundtrip. | J01; research-workspace gate. |
| J03 | Native notes/backlinks. | Highlight page/bbox source ID; click-back trace and reload. | I01/E04; research-workspace gate. |
| J04 | Native metadata provider integration. | Metadata-only/no-download policy; request and accepted metadata log. | J01 + privacy policy; research-workspace gate. |
| J05 | Native citation graph. | API-sourced edge provenance; graph and source artifact. | J02/J04; research-workspace gate. |
| J06 | Native paper comparison matrix. | Each cell tied to citations; reviewer support audit. | I07/J01; research-workspace gate. |
| J07 | Native knowledge cards. | Card-to-source block linkage; reopen navigation evidence. | E04/I01; research-workspace gate. |
| J08 | Native academic reflow mode. | Formula/footnote/citation anchor preservation; visual and navigation tests. | E02/E07; research-workspace gate. |
| J09 | Native study-pack UI/state. | Each generated item cites source; persisted/reopen report. | I06/I01; Gate 3. |
| J10 | Native smart collection/library filters. | Explicit duplicate merge confirmation; filtered results/persistence test. | K09/J01; Gate 3. |
| K01 | Native schema extraction review. | Field/value/bbox/confidence/type/validator schema; JSON artifact. | E04; Gate 3. |
| K02 | Native review/export for key-value extraction. | User-approved fields and CSV/JSON mapping; correction artifact. | K01; Gate 3. |
| K03 | Native job queue/resume UI. | Job state and cancel contract; pause/cancel/resume trace. | N02; Gate 3. |
| K04 | Native user-authorized folder watcher. | Permission-scoped directory events; consent and no-outside-path audit. | M03; Gate 3. |
| K05 | Native workflow composition/dry run. | Versioned step plan; dry-run report and confirmed execution trace. | K01/K03; Gate 3. |
| K06 | Native deterministic rule UI. | Preview/override rule contract; rule trace and persisted override. | K01; Gate 3. |
| K07 | Native unresolved-review queue. | Confidence/status counts; no-export-unresolved assertion. | K01/K02; Gate 3. |
| K08 | Native local API/CLI/MCP boundary. | Authentication, permission, audit, rate-limit contract; conformance report. | M policies; Gate 3. |
| K09 | Native immutable source/revision storage. | Revision lineage and derived artifact contract; restore/compare artifact. | E04; Gate 3. |
| K10 | Native team workspace/RBAC. | Document-level role/audit schema; access-denial and audit test. | M07/M08; Gate 4. |
| L01 | Native host process and desktop import. | Chrome nativeMessaging framing and real PDF event; `extension/native-bridge.ts` roundtrip. | B07/B08 + host registration; extension/native handoff. |
| L02 | Native capture permission/user selection. | Explicit capture session, exclusion, no-loop contract; OS permission evidence. | C11/C12; permission gate. |
| L03 | Native job progress/cancel. | Shared job ID/stage/progress/cancel contract; three-surface trace. | K03/N02; Gate 3. |
| L04 | Native source/translation coordinate sync. | Shared document coordinate and selection contract; cross-pane screenshot. | E04/F08; Gate 2. |
| L05 | Native/extension quick actions. | Explicit consent/provider boundary; no-network-before-consent trace. | M01; Gate 3. |
| L06 | Native reader mode state. | Persisted mode/page/selection contract; mode-switch/reload visual trace. | E04; Gate 3. |
| L07 | Native annotation bridge merge. | Revision/conflict/offline merge schema; conflict resolution trace. | H04 + C13; Gate 3. |
| L08 | Native OS capture selector/OCR. | User-granted source/session contract; per-source permission and OCR evidence. | C11/C12/F01; permission gate. |
| L09 | Native panel layout persistence. | Workspace layout schema; reopen panel layout assertion. | research-workspace; Gate 3. |
| L10 | Native model lifecycle/storage. | Opt-in model manifest/checksum/quantization contract; download/delete/resource report. | C18/M03; Gate 4. |
| M01 | Native privacy mode enforcement. | Shared offline/ask/cloud policy; network-deny and explicit-consent trace. | Provider boundary; privacy gate. |
| M02 | Native OS credential vault and redacted logs. | No credential transfer/log contract; key lifecycle and log scan. | C09/C10; privacy gate. |
| M03 | Native encrypted files/temp cleanup. | Workspace storage ownership contract; plaintext/temp filesystem scan. | OS storage design; Gate 4. |
| M04 | Native untrusted-document and tool permission boundary. | Prompt/data provenance and allowlist; injection denial tests. | I08; Gate 4. |
| M05 | Native parser isolation/resource limits. | Bounded parser result/error contract; resource-limit corpus report. | Import gate; Gate 4. |
| M06 | Native per-document consent/provider audit. | Append-only route/consent event schema; audit export and trace. | M01; Gate 4. |
| M07 | Native workspace policy enforcement. | Provider/retention policy contract; deny-before-request tests. | M01/M02; Gate 4. |
| M08 | Native retention/deletion/compliance export. | Verifiable deletion/audit format; restore/back-up/deletion evidence. | M03/M06; Gate 4. |
| N01 | No product module; evidence ledger and release gate. | One proof set per yellow item; commits, commands, image/log hashes, status. | All 17 yellow items; Gate 0. |
| N02 | Native cancellation through job/provider boundaries. | Abort signal contract through every provider; stale-result and abort trace. | Provider adapters; Gate 0/3. |
| N03 | Native/extension golden fixture runner. | Licensed, versioned expected-output manifest; corpus hash report. | License review; Gate 1/2. |
| N04 | Native PDF rendering visual tests. | Shared page render normalization/masks; image diff and manual review. | G01/H03; Gate 1/2. |
| N05 | Native OCR/layout benchmark runner. | CER/WER/TEDS/layout metrics and versions; reproducible result JSON. | N03; Gate 2. |
| N06 | Native translation quality and invariant checks. | Model/prompt version and human review marks; reproducible quality report. | N03 + consented providers; Gate 3. |
| N07 | Native performance/evidence sampling. | Machine/file/model provenance and percentile schema; raw samples/summary. | Stable corpus; release gate. |
| N08 | Release workflow/security metadata. | Signed artifact/SBOM/dependency gate; release matrix and provenance. | All quality gates; final release gate. |

## Exact command sequence

1. `node scripts/e2e/native-desktop.mjs --list` - inspect gates and current surfaces; this never launches a product.
2. `node scripts/e2e/native-desktop.mjs --mock-contract` - deterministic contract-only evidence; it must never be called acceptance.
3. `node --test scripts/e2e/native-desktop.test.mjs` - harness regression tests.
4. On a supported Windows/macOS runner, build native and extension artifacts using their documented project commands, then register the native host only through a separately approved installer operation. This harness must not write registry entries or alter a user's persistent browser profile.
5. Provide `PDF_WORKSPACE_EXE`, `PDF_WORKSPACE_E2E_SCRIPT`, `PDF_WORKSPACE_E2E_ASSERTIONS`, `CHROME_PATH`, `PDF_WORKSPACE_NATIVE_HOST`, and optional `PDF_WORKSPACE_EXTENSION`; run `node scripts/e2e/native-desktop.mjs --acceptance --evidence <absolute-path>`.
6. Review actual screenshot/log hashes and each per-stage artifact independently. The runner reports `fullAcceptance: false` by design until an independent reviewer has validated all UI assertions, OS permission evidence, native messaging and output bytes.
7. Run the existing extension browser E2E separately with `CHROME_PATH` and built extension. Its synthetic capture test remains explicitly non-permission evidence.
8. Run `git diff --check`, inspect `git status --short`, and verify no staged files before handoff.

Exit codes: `0` for discovery/mock contracts; `2` for explicit missing acceptance prerequisites; `3` for real execution that lacks independently accepted gate evidence; `1` for runtime/cleanup failure.

## Current status / blockers

- Harness implementation: present; listing, mock-only guards, fail-closed prerequisite checks, isolated native/Chrome profiles, real executable/Chrome launch paths, screenshot hashing, structured JSON, and temp cleanup are implemented.
- Real execution: not run. No built executable, Chrome binary, native host binary, or `dist/extension` artifact is available in this worktree. No actual registered-host/profile permission evidence is present.
- Product acceptance: not verified. The full UI driver and assertion outputs required for OCR/markup, citation navigation, workspace persistence, translated PDF Save As, reconnect, duplicate delivery, checksum rejection, and cleanup are unavailable. Existing native translated PDF Save As is a known product blocker, not a harness failure.
- OS permission proof: unavailable. Synthetic canvas/capture artifacts are not a substitute.
- No conclusion about user-visible acceptance is inferred from mock tests or old docs.
