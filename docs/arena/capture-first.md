# Capture-first hybrid candidate

Status is a proposed arena candidate, not the selected architecture or an implementation. Research date is 2026-11-08. This document explains one bounded decision. A live observed viewport is the common unit of work, and controlled PDF rendering upgrades its accuracy when document bytes are available.

## User outcome and decision

Mirror PDF gives the reader a second, translated view with the same page positions, diagrams, columns, and scroll context. The Chrome extension detects PDFs. The Rust desktop app also works with a selected browser window, another application window, or a monitor. Neither application substitutes a paragraph chat panel for the mirror.

Choose capture-first if support for arbitrary desktop viewers matters as much as support for ordinary browser PDFs. The native app owns the live session and treats OCR as a first-class input. The extension contributes document identity, page transforms, and exact text when it can. It is not a mandatory controller for native capture.

The smallest meaningful product slice is one stable captured page, genuine OCR, a configured real translation provider, source-text suppression, and translated text inside measured regions. A shell populated with fixture text does not satisfy this slice.

This candidate loses to a document-first candidate if the screenshot corpus cannot meet the geometry and background gates below. It also loses if companion-free extension support for opaque PDF viewers is mandatory. Capture permission prevents silent browser capture on every detected PDF.

## Grounding and constraints

The workspace was empty when this candidate started. There is no existing application ownership to preserve. The coordinator supplies the distinct competing candidate and makes the synthesis decision. This worker cannot delegate at its current depth and has not claimed a separate-model review.

There are two different meanings of exactness.

- Exact source geometry means a source pixel, text quad, and diagram map through one transform into the mirror. This is testable.
- Exact translated typography is not generally possible. Another language changes glyph count and line breaks. The product preserves block bounds, reading order, figures, and alignment, with explicit overflow behavior.

A screenshot contains the original glyphs baked into its pixels. OCR does not recover the background under those glyphs. Painting translations over the screenshot produces double text. Painting white rectangles over every OCR box damages figures, rules, shaded cells, and colored pages. These are architectural limits, not polish tasks.

## How the session works

A source adapter produces immutable observations. The session actor alone accepts an observation and publishes the corresponding render snapshot. Recognition and translation workers return proposals, never direct UI mutations.

The source state is `Idle`, `Selecting`, `Observing`, `DocumentCandidate`, `Locked`, `Uncertain`, `Paused`, or `Ended`. Provider availability is a separate state. A source can remain locked while translation reports `NeedsConfiguration` or `RateLimited`.

A user selects a window or monitor once. Detection then looks for stable page regions inside that selected source. It combines edges, repeated page proportions, text density, viewer accessibility hints, and temporal agreement. White color alone is not a document detector. Dark pages, slides, continuous pages, and borderless readers remain valid inputs.

A stable candidate locks after several agreeing observations. Ambiguous layouts retain the last crop only as a visibly paused snapshot. They do not translate browser chrome or another application. A manual region correction is available, but automatic detection must pass its own gate without that correction.

Scrolling changes the viewport immediately. The actor removes unproven overlays before the next frame becomes visible. It waits for a stable region before scheduling expensive OCR. A visual-registration match can reuse recognized blocks only when the match clears its confidence gate. A guessed scroll offset cannot move old translations onto an unrelated page.

The capture callback keeps a latest-frame slot. It never queues an unbounded video stream behind OCR. At most one active recognition job and one newest pending observation exist per session. Translation jobs have bounded concurrency and cancellable deadlines. Obsolete responses may populate a text cache after validation, but cannot paint a newer view.

## Caller usage before types

The following is a contract sketch, not application code.

```text
Desktop controller:
	session = engine.open(SelectedWindow(source_token), policy)
	for event in session.events():
		apply_to_shell(event)
	session.set_target_language("vi")
	session.pause()
	session.close()

Extension controller:
	candidate = detect_pdf(tab_observation)
	if candidate.bytes_are_authorized_and_readable:
		session = browser_engine.open(ControlledPdf(candidate.bytes), policy)
	else:
		show_detected_pdf_with_explicit_start_capture_action(candidate)
		if companion_available_and_user_starts:
			session = companion.open(TabCapture(candidate.tab_token), policy)
		else:
			show_actionable_capture_unavailable_state()
```

PDF detection can run automatically after installation and permission setup. Starting a `tabCapture` stream still needs the user's invocation. The ordinary readable-PDF path does not need tab capture or the native companion. Automatic takeover must not refetch a protected PDF using an unrelated desktop HTTP client or silently expose signed URLs.

The extension's own PDF.js viewer is a deliberate controlled mode. The extension cannot assume DOM access to Chrome's built-in PDF viewer. It detects candidates through navigation, response MIME hints where permission allows, and embedded document hints. File URLs need the user's file-access setting. Blob URLs and authenticated POST-generated PDFs need a proven byte acquisition adapter or capture fallback, not URL-string rewriting.

## Canonical contracts

The pure session and geometry model lives in Rust. Its browser build targets WebAssembly and excludes Windows, native file access, and native OCR. A generated JSON Schema and TypeScript bindings describe transport data. Adapters parse wire values into validated domain values. A window handle, PDFium object, or framework texture never appears in the shared schema.

All IDs below are distinct opaque types. A source token is session-scoped and cannot be reconstructed from an HWND string sent by a web page.

```text
SourceIdentity = {
	session_id: SessionId,
	source_id: SourceId,
	source_epoch: u64,
	kind: BrowserTab | NativeWindow | Monitor | ControlledPdf
}

CapturedFrame = {
	source: SourceIdentity,
	frame_id: FrameId,
	monotonic_time_ns: u64,
	width_px: u32,
	height_px: u32,
	stride_bytes: u32,
	pixel_format: Rgba8 | Bgra8,
	color_space: Srgb,
	pixels: OwnedFrameBuffer,
	capture_status: Ready,
	capture_to_desktop_px: Affine2D,
	window_dpi_scale: PositiveFiniteFloat,
	content_digest: Digest
}

CaptureEvent = Frame(CapturedFrame)
	| Unavailable(Minimized | Protected | SourceClosed | DeviceLost | PermissionDenied)

DocumentIdentity = KnownPdf {
	byte_digest: Digest,
	acquisition_revision: u64
} | ObservedDocument {
	track_id: DocumentTrackId,
	detector_revision: u64
}

ViewportIdentity = {
	source: SourceIdentity,
	document: DocumentIdentity,
	viewport_epoch: u64,
	geometry_revision: u64,
	evidence_frame: FrameId,
	regions: Vec<VisibleRegion>
}

VisibleRegion = {
	region_id: RegionId,
	page: KnownPage(PageIndex) | UnknownObservedPage(PageTrackId),
	quad_in_capture_px: Quad,
	clip_in_capture_px: Polygon,
	local_to_capture_px: Affine2D,
	coordinate_space: PdfPointsTopLeft | RegionPixels,
	registration: Measured | Estimated { confidence: Probability }
}

TextBlock = {
	block_id: BlockId,
	region_id: RegionId,
	text_revision: u64,
	source_text_digest: Digest,
	source_text: String,
	language_hint: Option<LanguageTag>,
	quad_in_region: Quad,
	lines: Vec<LineWithWordQuads>,
	reading_order: u32,
	role: Paragraph | Heading | Caption | TableCell | Formula | Unknown,
	provenance: PdfText | Ocr { engine: EngineId, confidence: Option<Probability> },
	background_policy: CleanDocumentLayer | FlatFill(Color) | Uncertain
}
```

`CapturedFrame` dimensions, stride, buffer length, finite transforms, and allocation limits are checked at admission. An unavailable capture is not an empty black frame marked ready. A frozen last frame carries its original capture timestamp and a paused label.

A document revision is not a viewport revision. The actor increments the source epoch on source replacement. It increments the viewport epoch on unproven scrolling, zoom, rotation, navigation, page track change, or capture-to-document mode change. It increments the geometry revision when crop or mapping changes. An unchanged frame does not invalidate text solely because another timer tick occurred.

`UnknownObservedPage` is honest. Native capture cannot derive a reliable PDF hash or page index from pixels alone. Cross-page block reuse requires verified registration or a controlled document identity. The actor creates a new document track when evidence no longer proves continuity.

Every accepted OCR block retains word quads before paragraph grouping. Grouping must not merge separate columns or table cells. Formula blocks default to preservation unless an explicit formula-aware translator exists. Confidence is optional because some OCR APIs do not return calibrated confidence.

## Translation generation guards

```text
TranslationTicket = {
	session_id: SessionId,
	source_epoch: u64,
	document: DocumentIdentity,
	viewport_epoch: u64,
	geometry_revision: u64,
	block_id: BlockId,
	text_revision: u64,
	source_text_digest: Digest,
	target_language: LanguageTag,
	translation_generation: u64,
	provider_config_revision: u64,
	glossary_revision: u64,
	request_id: RequestId
}

TranslationResult = {
	ticket: TranslationTicket,
	translated_text: String,
	provider_id: ProviderId,
	model_id: String,
	finish: Complete | Rejected | Truncated
}

MirrorSnapshot = {
	viewport: ViewportIdentity,
	background: BackgroundAsset,
	blocks: Vec<SourceOrTranslatedBlock>,
	status: Live | Translating | Paused | Degraded(Reason)
}
```

The actor accepts a result for display only when every identity and revision in its ticket still matches the block and active policy. A changed target language or provider configuration increments `translation_generation`. A changed crop rejects old geometry even when the source sentence is unchanged. Closing a session revokes all of its tickets.

The UI commits a complete `MirrorSnapshot` atomically. It never combines a new bitmap with an old block list. Translation can replace individual pending blocks inside that same viewport identity. Streaming partial provider text stays in a pending detail view until it has passed response validation and layout.

The translation cache key includes exact normalized source text, source language policy, target language, provider and model identity, prompt revision, glossary revision, and context digest. Cache entries store text, not screen coordinates. Recognition cache keys include a region image digest, OCR engine version, language packs, and preprocessing revision.

A production translator calls a real, configured HTTPS provider through a `Translator` interface. An OpenAI-compatible adapter is one concrete option, not a promise that every such endpoint implements the same schema. The request uses bounded blocks with stable IDs and nearby context. The response must contain exactly the requested IDs. The adapter rejects missing blocks, invented IDs, empty translations, malformed JSON, and truncated output. Documents are untrusted data, not instructions to operate tools.

Credentials belong in Windows Credential Manager for native use. Browser-only mode either uses a local endpoint explicitly chosen by the user or a separately authorized provider configuration stored with a clear browser-storage warning. The extension cannot borrow the agent's model subscription. No credentials means `NeedsConfiguration`, not a hidden fake translator. Retry policy respects rate limits and caps concurrent requests and daily budget. Cached content stays usable offline.

## Geometry and source-text suppression

The transform chain is explicit. PDF user coordinates first normalize the crop box and rotation into top-left PDF points. A page transform maps those points to capture pixels. A mirror transform maps capture pixels to physical output pixels. The shell finally converts physical pixels to logical UI units exactly once.

For screenshot-only input, region coordinates are measured crop pixels. Resize and DPI changes invalidate the map. Homography is reserved for perspective-distorted sources, not ordinary desktop screenshots. A polygon clip prevents a partly visible page from drawing over another page or viewer chrome.

Controlled mode uses the original page assets and measured text positions. Native PDFium can inspect page objects and render a modified in-memory page with selected text objects omitted. This is a capability to prove, not a universal guarantee. Nested forms, invisible OCR layers, text outlines, clipping, annotations, and rasterized glyphs complicate suppression. Never overwrite the original file. Browser PDF.js text extraction gives geometry but does not by itself provide a dependable public render-without-text switch. Do not promise clean text removal from a text layer alone. Browser controlled mode can initially use verified flat fills on simple page backgrounds and companion-assisted clean rendering when available.

Screenshot mode offers three honest suppression outcomes.

1. A verified uniform local background permits a tight color fill with protection masks for nearby rules and figures.
2. A controlled document clean layer permits full replacement while retaining non-text art.
3. An uncertain background preserves the source area and marks that block as degraded. A user can inspect the translation in a positioned callout or paired detail view. It must not silently claim the full mirror-quality gate passed.

Generative inpainting is not the default. It can invent diagram content, adds models and latency, and complicates privacy. A later optional local inpainting adapter needs a protected-figure regression corpus. Blur is not source removal.

The compositor clips each translated paragraph to its source block, shapes Unicode text, and tries line breaks and a bounded font-size reduction. Overflow produces a visible affordance and expanded inspection, not disappearing text or a 4-pixel font. Fonts must cover Vietnamese, CJK, and any claimed target language. Arabic and mixed-direction text need real shaping and bidi handling. A browser text box or toolkit label is not proof that the custom mirror compositor handles those cases.

## Native shell and toolkit choice

Choose Slint for this candidate's native Rust shell. Its declarative compiled UI fits a carefully composed document application without a WebView. Its custom styling is a better starting point for the requested Quiet-md and PageBridge direction than a default engineering-tool widget set. This is a design judgment, not a measured comparison.

The shell uses a compact source rail, restrained title bar, warm document canvas, slim language controls, and one persistent capture-state indicator. The translated page remains the dominant object. The design must include real source thumbnails, permission states, uncertain detection, reconnect, provider setup, overflow, and keyboard navigation. No gradients, dashboard metric cards, or simulated activity logs stand in for those states.

`eframe` with `egui` is a viable lower-risk alternative for custom image painting, permissive licensing, and accessibility through AccessKit. Its own README explicitly lists native-looking UI as a non-goal. Choosing it requires a custom visual system and native interaction review, not declaring the default demo style refined. `winit` alone is window and event infrastructure, not a complete application UI. Tauri is not this candidate because the request calls for a native Rust desktop shell rather than a WebView application.

Start Slint with the winit backend and software renderer for a minimal build. Prove page-image throughput and text layout before deciding whether to add a GPU renderer. Do not force capture textures through a costly CPU conversion without measuring it. UI handles stay on the UI thread. Capture, OCR, PDF parsing, and network calls never block that thread.

## Native capture, OCR, and bridge

Use `windows-capture` for the first WGC adapter. Its current source advertises window or monitor picking, changed-frame callbacks, and DXGI fallback. Keep raw `windows` bindings behind the same Windows module for DPI, process-owned window filtering, credential access, and display affinity. Restrict the first release to a tested Windows 11 baseline. Do not infer the crate's complete OS support from the underlying API's earliest introduction date.

Use Windows `OcrEngine` first when the installed language is supported. It returns lines, words, and bounding positions. Probe language availability and maximum image dimensions at runtime. Test the unpackaged installer path explicitly rather than assuming that a UWP API works in every desktop distribution.

A bundled Tesseract worker is the deterministic multilingual fallback. Run a pinned executable with explicit language packs and TSV output, or adopt Rust FFI only after a packaging spike proves it simpler. A sidecar avoids making every developer compile Leptonica and Tesseract before seeing the UI. Use bounded stdin or private temporary files, fixed executable paths, no shell interpolation, process timeouts, and crash isolation. `ocrs` is attractive for a Rust-only fallback but its current README limits recognition to the Latin alphabet and calls it an early preview. It cannot satisfy a general multilingual promise without a separate evaluated model.

The desktop has a single session actor per source. A Chrome native-messaging host is a small broker process, not a second engine. It validates the calling extension origin and communicates with the existing desktop process over a current-user-restricted Windows named pipe. If no desktop exists, it launches only the installed, fixed-path executable. Named pipes are a product mechanism here, not an assertion that this agent sandbox can open them.

The broker protocol has a versioned envelope with `protocol_version`, `connection_id`, monotonic `seq`, `request_id`, `kind`, and validated `payload`. Initial messages are `Hello`, `Capabilities`, and `OpenSession`. Later messages include `ObserveViewport`, `DocumentChunk`, `FrameChunk`, `SetPolicy`, `Ack`, `Snapshot`, `Pause`, `CloseSession`, and typed `Error`. Unknown versions fail with an upgrade instruction. Duplicate commands are idempotent by request ID.

Use `connectNative`, not one new host per frame. Native messaging uses length-prefixed UTF-8 JSON and reserves stdout for that protocol. stderr is for diagnostics without document text. Keep every application message below 256 KiB regardless of Chrome's larger direction-specific limits. Chunk blobs conservatively, with declared total length, chunk index, digest, and strict reassembly limits. Require ACK credit before sending another frame. The newest pending frame replaces older unsent frames. Do not stream full-rate base64 4K frames through JSON.

Native capture can supply frames directly once a user has selected the appropriate window. Extension tab capture is used only when the browser tab is the actual consented source. Matching a tab title to a desktop window is advisory, not authorization. A tab URL is not permission to read arbitrary files or issue arbitrary HTTP requests.

The installer registers an exact native host manifest under HKCU with explicit development and release extension IDs. No wildcard origins. A separately documented development installer can register the unpacked extension ID. Uninstall removes only product-owned keys and files. The bridge has no arbitrary command execution, arbitrary path read, or generic URL-fetch method.

## Concrete ownership map

These are proposed paths, not files created by this candidate.

```text
apps/desktop/
	src/main.rs                   Process lifetime and UI-thread startup.
	src/controller.rs             Commands and immutable session events.
	ui/app.slint                  Quiet-md shell and real application states.
	ui/mirror.slint               Viewport canvas and positioned output.
apps/native-host/
	src/main.rs                   Chrome framing, origin checks, pipe broker.
apps/extension/
	src/background.ts             PDF detection and permissions.
	src/document-source.ts        Authorized PDF byte acquisition.
	src/viewer/                   PDF.js controlled reader and mirror.
	src/offscreen.ts              User-authorized tab stream lifetime.
	src/bridge.ts                 Generated-schema native client.
crates/mirror-core/
	src/session.rs                Sole owner of identity and generations.
	src/geometry.rs               Coordinate spaces and registration policy.
	src/blocks.rs                 Text identity and grouping invariants.
	src/translation.rs            Ticket acceptance and cache identity.
crates/mirror-windows/
	src/capture.rs                WGC, source tokens, DPI, and source closure.
	src/detection.rs              Page-region tracks and uncertainty.
	src/ocr.rs                    Windows OCR and Tesseract supervision.
	src/credentials.rs            Credential Manager adapter.
crates/mirror-document/
	src/lib.rs                    Isolated PDFium document worker client.
	src/worker.rs                 PDF bytes, objects, extraction, clean render.
crates/mirror-translate/
	src/lib.rs                    Provider calls, budgets, and response checks.
crates/mirror-layout/
	src/lib.rs                    Unicode shaping, fitting, and clip output.
crates/mirror-protocol/
	src/lib.rs                    Wire schema and generated bindings.
tests/fixtures/                 Licensed PDFs, images, and capture traces.
tests/replay/                   Deterministic stale-result and geometry tests.
scripts/doctor.ps1              Toolchain, SDK, linker, assets, and host checks.
scripts/build-windows.ps1       Developer environment and locked build.
scripts/package-windows.ps1     Installer, assets, notices, and hashes.
```

The session actor owns identities, jobs, and accepted snapshots. The Windows adapter owns capture resources and source selection tokens. The document worker owns PDFium handles. The translator owns credentials and network policy. The shell owns interaction state, not a second translation cache or viewport model. Shared Rust core builds natively and for the browser. Native-only dependencies stay outside that core.

These modules hide policy, rather than merely forwarding calls through stages named load, process, and save. A source adapter has one purpose. It submits an observation to the actor. PDF text and OCR are alternative evidence providers behind that operation, not two independent writers of mirror state.

## Reliable Windows bootstrap

Read-only inspection on this host found installed `stable-x86_64-pc-windows-msvc`, but `rustup show` reported no active toolchain. Visual Studio C++ BuildTools exists at `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools`. Windows SDK `10.0.26100.0` exists. The `link.exe` on PATH is Git Bash coreutils, not MSVC. No toolchain, registry, or machine setting was changed during this research.

The proposed doctor checks an exact repository toolchain file, `cargo +stable -V`, the compiler host triple, VS discovery through `vswhere`, Windows SDK libraries, actual MSVC linker resolution, writable build cache, and asset digests. Pin the tested Rust toolchain after the spike, with edition-2024 support for the observed capture crate. Do not set a machine-global Rust default as a hidden bootstrap step.

The build script discovers Visual Studio rather than hardcoding version 2022 or 18. It enters `VsDevCmd.bat` with x64 host and target, then runs Cargo in that same developer environment. On this machine that step also prevents accidental use of the Unix `link.exe`. A PowerShell `Get-Command cl` failure outside a developer environment does not prove MSVC is missing.

The initial dependency spike builds a blank Slint window, captures one chosen window frame, recognizes a bundled image, and loads one pinned PDFium DLL. Only then lock versions and feature selections. Disable unnecessary Qt, Skia, video encoding, and binding-generation dependencies where supported. If a selected crate cannot exclude a heavy dependency, record its build and installer cost instead of assuming it is optional.

PDFium is not included by `pdfium-render`. Ship a fixed-architecture DLL from a reviewed release with its exact API feature and checksum. Load it from an application-owned absolute path, never the current working directory or an untrusted PATH. Ship OCR assets with hashes and language metadata. First launch must not depend on anonymous downloads or a developer's caches.

A Windows CI runner builds with `cargo build --locked --release`, runs core tests and bridge framing tests, verifies generated bindings, and checks distribution contents. GUI and WGC acceptance needs an interactive Windows session. A headless CI compile does not prove the capture picker or GPU path works. A clean Windows VM without Rust, Visual Studio, or Python must install and run the packaged application.

## Gates that decide whether this candidate survives

The following numbers are proposed acceptance limits, not measured performance claims. The corpus and machine description must accompany results.

1. **Native build gate.** A clean Windows VM installs the package, starts the native shell, opens the source picker, captures a frame, performs OCR, and translates through a real configured provider. No development tools or cache downloads are required.
2. **Extension gate.** The unpacked MV3 extension detects a MIME-identified PDF without a `.pdf` suffix, a local PDF after file-access permission, an embedded PDF, and a protected case. Each either mirrors authorized bytes or offers the explicit capture route. No protected case silently falls back to fixture text.
3. **Capture gate.** Tests cover window resize, minimized source, source closure, protected content, monitor removal, mixed 100%, 150%, and 200% DPI, and a browser moved between monitors. Unsupported cases pause visibly without translating stale or black pixels.
4. **Detection gate.** On an annotated corpus of at least 50 captures with toolbars, two visible pages, dark pages, slides, and non-document windows, document-region precision reaches 0.98 and recall reaches 0.90 at region IoU 0.90. False positives on browser chrome are separately reported. Manual crop does not count as automatic success.
5. **Geometry gate.** Controlled-mode corner transform error stays within one output pixel. Screenshot-mode annotated region and word alignment error has p95 at most three capture pixels after lock. Multi-page clips never cross into another page.
6. **Suppression gate.** Flat backgrounds have no visible double glyphs. Pixels outside approved suppression masks match the source exactly before output resampling. Shaded tables, figures under text, and raster pages either retain correct art or receive an explicit degraded status. A degraded screenshot must not count as a full-fidelity success.
7. **Stale-response gate.** Deterministic replays delay and reorder OCR and translation across scroll, zoom, target-language change, provider change, source replacement, pause, and close. Zero obsolete tickets paint. Replays also assert bitmap and overlay viewport identities match at every commit.
8. **Translation gate.** A real provider run translates a technical two-column page into Vietnamese with correct block IDs and preserved numbers, equations, and glossary terms. Invalid JSON, quota errors, offline state, missing credentials, and truncated output produce visible recoverable states. Identity translation is rejected as a demo substitute, but valid unchanged proper nouns are allowed.
9. **Layout gate.** Vietnamese accents, CJK, Arabic, mixed-direction text, long URLs, and translation expansion fit or expose overflow. No text leaves its clip. Keyboard focus, source selection, pause, language change, and settings work without a mouse.
10. **Resource gate.** With provider delay injected, frame and job counts remain bounded. After 100 source switches and a 30-minute idle session, handles and resident memory show no unbounded growth. Capture-to-first-mirror p95 targets 250 ms, excluding OCR and translation. Stable-frame-to-first-translated-block targets three seconds on the stated network and reference machine. Measure those stages separately before tuning.
11. **Privacy gate.** A network recording proves OCR-only preview sends nothing remotely. Translation sends only accepted document text unless the user explicitly opts into image translation. Logs contain no provider keys, signed PDF URLs, source paragraphs, or raw frames. Monitor mode visibly identifies the larger capture scope.
12. **Bridge gate.** Tests exercise partial reads, malformed lengths, invalid UTF-8, unknown versions, oversized allocation attempts, duplicate requests, missing chunks, wrong digests, unexpected origins, desktop restart, and service-worker reconnect. No untrusted request launches a shell or reads an arbitrary path.

## Licensing and supply-chain decision

Licenses below describe observed upstream source, not a completed distribution audit. Exact pinned revisions, model files, fonts, DLLs, and transitive dependencies need their own notices.

- `windows-capture` declares MIT in its current manifest. Its README currently describes version 2.0.1. WGC and DXGI behavior still needs the Windows spike.
- Slint currently offers Royalty-free License 2.0, GPLv3, or commercial terms. The current license page permits proprietary desktop applications without a fee under the royalty-free option and requires Slint disclosure. This is not MIT or Apache. Review the exact version selected and satisfy its disclosure rules. Switch to `egui` if that requirement is unacceptable.
- `egui` declares MIT or Apache-2.0. Its default fonts include several different font licenses. A curated font bundle needs separate attribution and target-language coverage.
- `ocrs` declares MIT or Apache-2.0 for its Rust crate. Model weights and training provenance need separate inspection. Latin-only recognition is an immediate product limitation.
- Tesseract declares Apache-2.0. Leptonica and bundled image codecs have their own licenses. Pin and review every language pack and Windows binary rather than assuming an installer website transfers all redistribution rights.
- `pdfium-render` declares MIT or Apache-2.0 and does not include PDFium. The PDFium distribution includes its own license and third-party notices. Review the actual binary archive. Do not casually substitute MuPDF, whose distribution terms require a separate licensing decision.
- Windows API access does not bundle a redistributable OCR engine or language pack with the application. The Windows path depends on the user's OS capabilities. Provider terms, document retention, and charges remain separate from code licensing.

## Evidence register

All links were fetched directly on 2026-11-08. Search was unavailable because the search service had insufficient credits. Main-branch documents can change, so release work must replace these with pinned revision evidence.

- [windows-capture README](https://raw.githubusercontent.com/NiiightmareXD/windows-capture/main/README.md) and [manifest](https://raw.githubusercontent.com/NiiightmareXD/windows-capture/main/Cargo.toml). High confidence in advertised WGC, DXGI, version 2.0.1, MIT, edition 2024, and `windows` dependency 0.62.2. Open question is tested minimum OS and packaged capture behavior.
- [Slint README](https://raw.githubusercontent.com/slint-ui/slint/master/README.md) and [license](https://raw.githubusercontent.com/slint-ui/slint/master/LICENSE.md). High confidence in compiled native Rust UI support and current licensing choices. Open question is compositor throughput and font behavior with the chosen renderer.
- [egui README](https://raw.githubusercontent.com/emilk/egui/main/README.md). High confidence in eframe Windows support, AccessKit support, custom painting, permissive code license, and native appearance being a non-goal. Open question is the effort for the requested visual finish.
- [Windows OcrEngine reference](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine?view=winrt-26100). High confidence in word positions, line grouping, available-language probing, and maximum-dimension API. Open question is unpackaged distribution support and real corpus quality.
- [ocrs README](https://raw.githubusercontent.com/robertknight/ocrs/main/README.md) and [crate manifest](https://raw.githubusercontent.com/robertknight/ocrs/main/ocrs/Cargo.toml). High confidence in preview status, Latin-only stated language support, RTen execution, and code license. Open question is recognition coverage of any future chosen model.
- [Tesseract README](https://raw.githubusercontent.com/tesseract-ocr/tesseract/main/README.md). High confidence in multilingual language packs, TSV and hOCR outputs, Apache-2.0 code, and Leptonica dependency. Open question is the pinned Windows sidecar and its complete redistribution manifest.
- [pdfium-render README](https://raw.githubusercontent.com/ajrcarey/pdfium-render/master/README.md) and [manifest](https://raw.githubusercontent.com/ajrcarey/pdfium-render/master/Cargo.toml). High confidence in extraction, rendering, object inspection, external DLL requirement, and serialized access concerns. Open question is clean-layer correctness on nested and raster content.
- [Chrome tabCapture documentation source](https://raw.githubusercontent.com/GoogleChrome/developer.chrome.com/main/site/en/docs/extensions/reference/tabCapture/index.md). High confidence in the user invocation requirement and Chrome 116 offscreen stream-ID path. Open question is every target viewer's captured content and permissions on current Chrome.
- [Chrome native-messaging documentation source](https://raw.githubusercontent.com/GoogleChrome/developer.chrome.com/main/site/en/docs/extensions/mv3/nativeMessaging/index.md). This archived documentation is dated 2023-02-27. High confidence in JSON length framing, explicit origins, registry installation, and stdout discipline. Direction-specific limits may evolve, so the proposed protocol uses a lower application cap and must test the current browser.
- [SetWindowDisplayAffinity reference](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity). High confidence that `WDA_EXCLUDEFROMCAPTURE` applies to process-owned top-level windows and starts at Windows 10 version 2004. Open question is behavior across the tested capture backends. The app excludes its own mirror to prevent recursive capture, but does not market this API as DRM or a security boundary.
- [Rustup MSVC prerequisites](https://rust-lang.github.io/rustup/installation/windows-msvc.html). High confidence in the need for a Microsoft linker, C++ tools, Windows SDK, and appropriate Visual Studio licensing. Local tool inspection supplies the host-specific facts above. No application build has been attempted in this document-only task.

## Arena synthesis handoff

This candidate's distinct choice is that the observed viewport and session actor are primary. A document parser upgrades evidence without becoming mandatory for arbitrary desktop capture. The benefit is one stale-result policy and one geometry model across browser, window, and monitor sources. The cost is that high-quality screenshot text removal cannot be guaranteed for every background.

Graft these parts into another candidate even if capture-first loses. Keep the tagged source identities, immutable snapshots, exact revision tickets, bounded latest-frame scheduling, honest unknown-page identity, explicit suppression outcomes, and native build doctor.

Reject these premises during synthesis. A screenshot cannot recover hidden background pixels exactly. OCR cannot guarantee page identity. A Chrome extension cannot silently begin tab capture on every PDF. A passing Rust compile cannot prove a usable capture product. The next decision should follow the native capture and suppression spikes, not the visual appeal of a shell screenshot.
