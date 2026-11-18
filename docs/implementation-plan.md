# Mirror PDF implementation plan

## Scope and lifecycle

This is a greenfield application. The installed pstack figure-it-out, architect, arena, show-me-your-work, model-the-domain, test-behavior-not-implementation, and prove-it-works instructions govern this run. Skill-tool invocation is disabled for the installed pstack entries, so their installed sources were read directly. Unavailable Superpowers aliases are not claimed as loaded.

The work follows frame, competing sketches, synthesis, tests, implementation, direct product verification, packaging, and defect review. Every stage has evidence. A compile alone does not complete a feature.

## Synthesis decision

Use document-first as the base. Its PDF.js browser viewer and PDF-aware native rendering avoid OCR errors for available embedded text. Graft capture-first's independent viewport/source generations, stale-result rejection, latest-frame bounded work, and explicit capture status. Capture is a full second source adapter, not a fake PDF page.

The browser owns a bundled PDF.js viewer. Native Rust owns its own native UI and PDF/capture adapters. The browser and native implementations share the domain contract and fixture behaviors rather than delaying a working product for a common WASM renderer. Provider requests return plain text. Both pipelines retain block IDs and original coordinates.

The first eframe/egui implementation was explicitly rejected by the user at the visual gate. It is now a retired diagnostic shell behind an opt-in reference-shell feature. The user subsequently approved the live original Quiet.md GPUI source fork in native-shell, including its custom Windows titlebar. All product integration now preserves that approved shell. The original branding and commercial icon folders are excluded from embedded assets; Lucide replacements are used. The tested desktop crate remains a reusable backend library rather than the visible product UI.

Only openai-codex/gpt-6.1-sol is available. The two candidates are independent same-model analyses. A cross-family arena judge is unavailable, and no diverse-model approval is claimed.

## Candidate rubric

Each candidate was read end to end. Grade 1 is weaker and 5 is stronger. These are design judgments, not measured benchmarks.

| Criterion | Document-first | Capture-first | Synthesis |
| --- | --- | --- | --- |
| Embedded PDF text fidelity | 5 | 3 | Use document extraction whenever authorized bytes exist |
| Arbitrary window support | 3 | 5 | Keep native capture as independent input |
| Stale result prevention | 4 | 5 | Adopt capture source/viewport generations |
| Buildable native shell | 3 | 4 | Start eframe with real Windows build gate |
| Companion-free extension | 5 | 3 | Extension reads and renders PDFs without native app |
| Background preservation | 4 | 2 | Test text suppression; do not call image masks exact |

## Ownership and throughput checkpoint

- Parent owns shared TypeScript types, translation adapters, scheduler, root configuration, verification fixtures, integration, and acceptance evidence.
- Reader worker owns src/pdf, src/ui, src/main.ts, src/style.css, index.html, and PDF tests.
- Extension worker owns extension, the extension build script, and extension behavior tests.
- Native worker owns desktop and the native usage guide.

Workers use separate file ownership in this empty repository. No worker changes another worker's files. The parent integrates only after reading the files and running the real checks. Workers are not allowed to count mocks as a live provider result.

The first checkpoint is a generated real PDF rendered in two panes, with a deterministic test-provider response anchored to the original text regions and automatic extension detection proven in a real browser. Native shell startup, local PDF rendering, and capture recognition form separate gates. The deterministic provider proves integration, not translation quality or a live paid provider.

## Atomic implementation units

1. Establish product contract, core types, and decision log.
2. Add failing translation and queue behavior tests. Implement legitimate Google Cloud, DeepL, OpenAI-compatible, and loopback providers with cloud consent.
3. Generate PDF fixtures and a local deterministic test provider. Add browser end-to-end checks before claiming visual success.
4. Implement PDF extraction, geometry, text suppression, fit, paired selection, and lazy viewport work.
5. Implement extension detection, per-source deduplication, authorized byte acquisition, MIME observation, embed discovery, and service-worker translation.
6. Implement native shell, PDF file rendering, capture source picker, OCR, provider calls, and revision-bound composition.
7. Run unit tests, type checks, production builds, real browser flows, and interactive native checks. Fix root causes.
8. Package extension and native outputs with licenses and launch/install instructions. Record incomplete gates explicitly.

## Verification gates

- Translation tests prove endpoint payloads, consent, deduplication, cache isolation, empty reply rejection, and failure states.
- Queue tests prove selection/viewport priority, bounded concurrency, deduplication, and superseded work rejection.
- PDF tests prove geometry, grouping, readable fit, and artwork-preserving text suppression on generated fixtures.
- Browser tests import a real PDF, translate through a local test endpoint, scroll, resize split, select paired regions, and preserve state through provider errors.
- Chrome extension tests load the production extension, observe PDF navigation and MIME-only sources, create one mirror per source, and render the acquired PDF.
- Native tests compile with MSVC, exercise pure revision/geometry/provider state, launch the real binary, open a PDF, and capture an actual window. OCR availability is visible rather than simulated.
- Privacy tests reject arbitrary source fetches, prevent keys in content-script messages, and require cloud consent.

Live external-provider quality and credentials, protected viewers, authenticated POST/blob acquisition, mixed-DPI monitors, scans over textured images, and universal font/script fitting remain acceptance work until directly verified. These are tracked defects or verification gaps, not removed requirements.
