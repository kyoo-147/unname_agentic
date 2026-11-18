# Mirror PDF document-first architecture candidate

Status: design candidate, not an implementation or a validated build. Prepared 2026-11-08. Scope includes a standalone Chrome extension and a native Rust Windows app. This candidate owns the document model. A captured window is a distinct, weaker source, not a PDF with invented pages.

## Decision and limits

Keep PDF bytes and fixed page coordinates as the source of truth. Extract positioned text, translate semantic regions, and paint translated glyphs over a background that retains the source graphics. Never rebuild a PDF as Markdown, HTML paragraphs, or a flowing document. The original pane always renders the unchanged source.

Use PDF.js in the extension and PDFium in an isolated native worker. Share a versioned scene and translation contract, fixtures, and geometry algorithms rather than pretending the render engines produce identical extraction IDs. Prefer a small GPUI shell informed by quiet-md, gated by a Windows build and interaction spike. Keep egui as the documented fallback if that gate fails.

The following distinctions are product requirements, not later implementation details.

- Exact geometry means the page size, crop, rotation, graphics, and region positions do not move. It does not mean arbitrary translated text has the same glyph widths or line breaks.
- Embedded text with usable Unicode is the high-fidelity route. Raster scans, outlined letters, and live window capture require OCR and a visible approximate-quality label.
- Automatic detection is not permission to send a PDF to a cloud provider. Show the document immediately. Start cloud translation only after consent to the selected provider and source scope.

There is no defensible promise that every PDF can have its original text removed without changing other pixels. Text can define clipping, be embedded in a photograph, or be drawn as vector outlines. Retain the original when replacement is unsafe, and expose the translation as a paired region or callout. Never silently cover a diagram with a white rectangle.

## How the document pipeline works

A source adapter acquires bytes or a capture frame. A PDF engine opens the immutable document, renders original tiles, and extracts glyph geometry. A region builder groups text into reading-order regions without crossing table cells or columns. An OCR adapter supplies regions only where native text is missing or demonstrably unusable. The coordinator schedules visible regions first. A translation adapter returns plain text keyed by region ID. A layout engine shapes that text within the original region. The compositor replaces only regions with a validated background plan. Selection uses region and range maps, not another OCR pass.

The coordinator is the sole writer of session state. PDF engine handles remain inside their worker. UI components receive immutable snapshots and issue commands. Provider credentials never enter the scene or page renderer.

### Proposed module ownership

These names describe proposed modules, not existing files.

| Module | Owns | Does not own |
| --- | --- | --- |
| `document-domain` | IDs, source revisions, page geometry, regions, selection pairs, state reducer, wire schemas | GPUI, DOM, network, PDF handles |
| `pdf-native` | PDFium version, extraction, original tiles, safe text suppression, passwords in memory | Translation policy, shell state |
| `pdf-browser` | Pinned PDF.js worker, extraction, canvas tiles, experimental suppression adapter | Provider secrets in content scripts |
| `region-layout` | Reading order, table boundaries, shaping, overflow, hit testing | Translating or changing page dimensions |
| `translation` | Provider adapters, batching, retries, request validation, budget accounting | Drawing text or deciding user consent |
| `session` | Viewport scheduling, deduplication, generations, cancellation, source lifecycle | Engine-specific pointer lifetimes |
| `cache` | Versioned scene metadata and translation storage | URLs as document identity, credentials |
| `capture-windows` | User-picked WGC session, frame revisions, dirty regions, OCR input | Arbitrary input injection into another app |
| `desktop-shell` | GPUI windows, toolbar, split layout, dialogs, accessibility integration | PDF parsing on UI thread |
| `extension-shell` | Detection, acquisition UI, mirror viewer, permissions, browser lifecycle | Reading Chrome's internal PDF viewer DOM |

Rust domain logic can compile to WebAssembly after its schema and algorithm tests pass. Do not make a common renderer, a general RPC framework, or a mandatory background daemon prerequisites for the first working product.

## Quiet-md reuse is feasible only at the shell level

The observed upstream head is [b9bed5513a222292d92601c50bbd4e6850882dea](https://github.com/s1dashu/quiet-md/commit/b9bed5513a222292d92601c50bbd4e6850882dea), dated 2026-11-07. The following are source observations, not proof of a passing local build.

- [Cargo manifest](https://github.com/s1dashu/quiet-md/blob/b9bed5513a222292d92601c50bbd4e6850882dea/Cargo.toml) declares quiet_md 0.1.7, Rust edition 2024, GPUI 0.2.2, a separate GPUI-free `fdl_core`, and local patches for GPUI, taffy, and xattr. Windows dependencies include windows 0.61, windows-registry, and webview2-com. The latter is for printing and PDF export, not PDF ingestion.
- [Toolchain](https://github.com/s1dashu/quiet-md/blob/b9bed5513a222292d92601c50bbd4e6850882dea/rust-toolchain.toml) pins Rust 1.99.1. [Windows CI](https://github.com/s1dashu/quiet-md/blob/b9bed5513a222292d92601c50bbd4e6850882dea/.github/workflows/ci.yml) loads a Visual Studio x64 developer environment and runs `cargo build --release --locked` and checks. The workflow definition is evidence of intended Windows support, not a checked green run.
- [Application entry point](https://github.com/s1dashu/quiet-md/blob/b9bed5513a222292d92601c50bbd4e6850882dea/src/main.rs) constructs GPUI windows and wires theme, shortcuts, settings, and application state. Its startup also seeds a notes library and installs quiet-md update behavior. Do not copy that startup wholesale.
- [Non-macOS header](https://github.com/s1dashu/quiet-md/blob/b9bed5513a222292d92601c50bbd4e6850882dea/src/native_header_fallback.rs) reports `supported() == false`. On Windows the reference is a GPUI-painted shell, not a reusable WinUI native sidebar.
- [Patch inventory](https://github.com/s1dashu/quiet-md/blob/b9bed5513a222292d92601c50bbd4e6850882dea/vendor/PATCHES.md) includes Windows IME, Unicode shader paths, clipboard changes, and scrolling behavior. Those patches explain why replacing the vendored GPUI with crates.io is not a neutral change.
- [License section](https://github.com/s1dashu/quiet-md/blob/b9bed5513a222292d92601c50bbd4e6850882dea/README.md#license) excludes the Nucleo icons, Quiet.md name, and app icon from the MIT grant. Retain required copyright notices for copied code. Supply new branding and independently licensed icons. Audit fonts and transitive notices separately.

Recommended reuse is window setup, theme organization, settings and shortcut patterns, and packaging lessons. Do not import the Feishu document model, undo system, XML persistence, rich-text editor, or upstream update endpoint. A fixed PDF page is not an editable notes document. Start with unpatched GPUI only if the Windows spike passes the relevant interaction gates. If adopting the fork, pin its exact source and keep a short, owned patch inventory rather than inheriting every patch unnoticed.

### GPUI versus egui

GPUI fits the requested reference and retained interactive workspace. Its text system can support translated text, but PDF selection, bidirectional hit testing, screen-reader exposure, and PDF tile painting remain our work. The vendored fork creates an ongoing upgrade obligation.

Egui with eframe is a viable alternative for a native Rust page-and-texture viewer. It removes dependence on quiet-md's GPUI patches, but does not solve PDF rendering, OCR, capture, or exact layout. It also requires deliberate font fallback, accessibility, and custom selection work. Choose it if the GPUI spike cannot pass on the supported Windows baseline, not on an unmeasured claim that one toolkit is faster.

The shell boundary prevents this fallback from replacing the document pipeline. No runtime plugin abstraction for two UI frameworks is needed. Select one toolkit before implementation expands.

## Extraction beats OCR when the PDF contains text

[PDF.js page APIs](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html) expose text content, structure tree, operator list, and a viewport transform. Text items are not guaranteed to be words, paragraphs, or faithful character boxes. The adapter must preserve item transforms and derive regions carefully. PDFium supplies native character geometry and page objects. Neither engine can recover semantic reading order for every untagged PDF.

Use native extraction for searchable born-digital content. Score extraction per region using Unicode validity, visible text coverage, duplicated hidden OCR layers, direction, and plausible geometry. Do not decide that a sparse title page requires OCR merely because its text count is small. On mixed pages OCR only unresolved image regions and deduplicate against existing text.

For scans, use a local OCR backend selected by a Windows deployment spike. Windows OCR is a candidate, but language-pack availability and desktop packaging requirements must be verified. A bundled ONNX or Tesseract backend avoids an implicit OS language dependency at the cost of models, size, and notices. OCR output contains image-pixel quads, language, and confidence when available. An engine without confidence reports `unknown`, not a fabricated probability. No cloud OCR occurs without separate permission.

Math, code, proper names, and chart labels are distinct region kinds. Preserve math and code by default. Translate prose and explicit labels without merging table cells. Let the user retry or exclude a region.

## Text suppression is a capability, not the default mask

The original tile is always available. Each translated region gets one of three background plans.

1. `SuppressedText` uses the rendering engine to omit mapped text paint operations while retaining other graphics.
2. `VerifiedFlatMask` uses a sampled uniform background only when a conservative region check finds no overlapping non-text marks. The scene records that this is a mask.
3. `OriginalWithCallout` preserves the source pixels and shows translated text separately when safe suppression is unavailable.

[PDFium editing APIs](https://raw.githubusercontent.com/chromium/pdfium/main/public/fpdf_edit.h) expose page-object enumeration, nested form enumeration, text render modes, and active-state changes. Some are experimental. Prototype suppression on a separate document instance after extraction. Do not mutate original handles, invalidate their text pages, or suppress every text object on the page. Suppress only objects mapped to translated regions. Nested forms and shared resources need explicit tests. Text clipping, Type 3 glyph behavior, transparency groups, and appearance streams can defeat naive omission. Fail closed to the original.

In the browser, hiding the PDF.js DOM text layer does not remove text painted into canvas. Its public API does not provide a stable semantic `renderWithoutText(regionIds)` call. A pinned, narrowly maintained renderer adapter must preserve text positioning and clipping state while controlling paint. Blindly deleting text-show operators changes later positioning and can damage clipping. This candidate does not call that an already solved feature. Ship the background replacement mode only after its gate passes. Masks are an explicit fallback, not evidence of exact visual preservation.

For scan text inside photos or live capture pixels, neither engine has a clean background to reveal. Inpainting is uncertain and deferred. Default to a paired overlay or callout instead of claiming restoration.

## Caller usage before implementation

The user opens a PDF or starts a consented window capture. The same viewer coordinator accepts both, but a capture cannot expose PDF page navigation.

```rust
let session = sessions.open(source, OpenPolicy::local_only()).await?;
let mut events = sessions.subscribe(session.id());
sessions.set_viewport(session.id(), viewport)?;
sessions.set_translation(session.id(), consented_profile)?;
while let Some(event) = events.next().await {
	view.apply(event)?;
}
sessions.select(session.id(), selection)?;
sessions.close(session.id()).await?;
```

This is a signature sketch only. This candidate adds no stubs or application code.

## Concrete domain contracts

Wire messages use JSON schema version 1. Rust types use validated newtypes. TypeScript bindings are generated from the same schema. Unknown variants or unsupported major versions are rejected before dispatch.

```rust
struct DocumentId([u8; 32]); // SHA-256 of complete PDF bytes
struct SourceRevision(u64);
struct ViewGeneration(u64);
struct ProfileRevision(u64);
struct PageIndex(u32); // zero-based everywhere outside engine adapters
struct RegionId(String); // engine revision + page + deterministic region fingerprint
struct RequestId(String);
struct SessionId(String);
struct Point { x: f64, y: f64 }
struct Quad { points: [Point; 4] }
struct Rect { x: f64, y: f64, width: f64, height: f64 }
struct Affine { a: f64, b: f64, c: f64, d: f64, e: f64, f: f64 }

enum Source {
	Pdf { bytes: ByteSource, display_name: String },
	Capture { consent: CaptureConsent, target: CaptureTarget },
}
enum Anchor {
	Pdf { document: DocumentId, page: PageIndex, scene_revision: String },
	Capture { session: SessionId, frame: SourceRevision },
}
struct PageGeometry {
	crop_box_pdf_units: Rect,
	user_unit: f64,
	rotation_degrees: u16,
	pdf_to_page: Affine,
	width_pt: f64,
	height_pt: f64,
}
struct TextRegion {
	id: RegionId,
	anchor: Anchor,
	quads: Vec<Quad>,
	text: String,
	kind: RegionKind,
	reading_order: u32,
	provenance: TextProvenance,
	style_runs: Vec<StyleRun>,
	source_ranges: Vec<SourceRange>,
	background: BackgroundPlan,
}
enum TextProvenance {
	Embedded { engine: String, extraction_revision: String },
	Ocr { engine: String, model_revision: String, confidence: Confidence },
}
enum BackgroundPlan {
	SuppressedText { object_refs: Vec<String>, renderer_revision: String },
	VerifiedFlatMask { polygons: Vec<Quad>, rgba: [u8; 4] },
	OriginalWithCallout { reason: String },
}
```

All PDF scene geometry uses top-left origin, x to the right, y down, and physical points at 72 points per inch after CropBox, UserUnit, and page rotation. Store the invertible engine-to-page transform rather than discarding it. Capture geometry uses top-left frame pixels and never masquerades as PDF points. Validate finite coordinates, positive dimensions, legal rotations, bounded region sizes, and invertible transforms at adapters.

A `StyleRun` contains source UTF-8 byte range, estimated font size in points, weight, italic, direction, color, and optional engine font reference. It does not guarantee the source embedded font can shape another language. A `SourceRange` maps normalized region UTF-8 byte ranges back to engine character or item ranges and quads. JavaScript UTF-16 offsets are converted at its adapter boundary. Range boundaries must be valid grapheme boundaries when selected.

`RegionKind` is `Prose`, `Heading`, `TableCell`, `Label`, `Math`, or `Code`. Page extraction returns `PageScene { anchor, geometry, regions, capability_warnings }`. Opaque engine object references expire with the scene revision and never cross into provider payloads.

### Session commands and events

```rust
trait MirrorSessions {
	async fn open(&self, source: Source, policy: OpenPolicy) -> Result<SessionHandle, MirrorError>;
	fn set_viewport(&self, id: SessionId, viewport: Viewport) -> Result<(), MirrorError>;
	fn set_translation(&self, id: SessionId, profile: ConsentedProfile) -> Result<(), MirrorError>;
	fn select(&self, id: SessionId, selection: Selection) -> Result<(), MirrorError>;
	fn subscribe(&self, id: SessionId) -> EventStream;
	async fn close(&self, id: SessionId) -> Result<(), MirrorError>;
}
```

`Viewport` contains visible anchor rectangles, active pane, scale, pan, and a monotonically increasing view generation. Both panes derive their transforms from one canonical page anchor. Unequal pane widths preserve the same page-point anchor, not identical scroll pixel offsets. The resize handle updates pane transforms without changing scene geometry or translation keys. Keyboard resizing and a minimum readable pane size are required.

`Selection` contains anchor, region IDs, source or translated side, and text ranges. Each translated segment maps to one or more source regions. Region-level pairing is guaranteed. Exact word alignment is optional metadata and must be labeled inferred unless the provider supplies it. Never infer word alignment from character-count ratios. Drag selection, keyboard selection, copy, and paired highlight all use the same map.

Session states are `Opening`, `PasswordRequired`, `Ready`, `Paused`, `Failed`, and `Closed`. Translation is per region with `Unrequested`, `Queued`, `Running`, `Ready`, `RetryableError`, and `PermanentError`. An error in one region does not replace the whole document with an error screen.

Events include `Opened`, `PageSceneReady`, `TileReady`, `RegionTranslationReady`, `SelectionChanged`, `Progress`, `Warning`, and `Failed`. Every event carries session ID, event sequence, source revision, and the relevant profile revision. Tiles also carry view generation. The UI drops stale tiles. Translation text from an old viewport can populate its cache if source and profile still match, but never attaches to a changed document or profile.

`MirrorError` codes include `UnsupportedSource`, `PermissionDenied`, `PasswordRequired`, `InvalidPassword`, `CorruptPdf`, `SourceUnavailable`, `EngineCrashed`, `UnsupportedSuppression`, `OcrUnavailable`, `ProviderAuth`, `ProviderQuota`, `ProviderTimeout`, `InvalidProviderReply`, `Cancelled`, and `VersionMismatch`. Errors include retryability and a safe user message. Logs omit document text, passwords, keys, and signed URLs.

### Translation provider contract

```rust
struct TranslationBatch {
	request_id: RequestId,
	profile_revision: ProfileRevision,
	source_language: LanguageHint,
	target_language: String,
	segments: Vec<TranslationSegment>,
	context: Option<String>,
}
struct TranslationSegment { id: RegionId, text: String, preserve: Vec<ProtectedSpan> }
struct TranslationResult { request_id: RequestId, segments: Vec<TranslatedSegment>, usage: Usage }
struct TranslatedSegment { id: RegionId, text: String, detected_language: Option<String> }
trait TranslationProvider {
	fn capabilities(&self) -> ProviderCapabilities;
	async fn translate(&self, batch: TranslationBatch, cancel: Cancellation) -> Result<TranslationResult, ProviderError>;
}
```

Capabilities include supported languages, batch item limit, request byte limit, context support, and whether the provider reports token or character usage. The adapter validates exact ID coverage, duplicate IDs, empty or oversized output, and protected-span preservation before cache commit. Treat output as text, never HTML or executable instructions.

Implement documented Google Cloud Translation and DeepL text APIs, OpenAI structured output where supported, and a configurable local HTTP adapter with an explicit capability handshake. Consumer Google Translate scraping is not a supported provider. An OpenAI subscription or Codex access does not imply an API key or quota for this product. A local provider must pass a real request contract test before its settings show **Connected**.

Cloud adapters send text only by default. They do not upload original PDF bytes or capture frames. OpenAI prompts identify PDF content as untrusted source data and forbid following document instructions, but validation still treats the result as untrusted. No automatic fallback to another cloud provider after a failure. Changing provider requires explicit policy and changes the cache namespace.

Desktop secrets use Windows Credential Manager. Browser-only credentials stay in extension-controlled session memory by default, with a clear persistence opt-in if supported. They never enter a page content script or sync storage. A desktop companion can hold credentials behind an allowlisted Native Messaging host. Do not expose an unauthenticated local HTTP service.

### Layout and rendering contract

`layout(region, translation, fonts, policy) -> LayoutResult` returns shaped glyph runs, translated text hit boxes, region-pair mappings, and an overflow status. It never moves another region. Shape with language-aware fallback and bidirectional handling. Do not reuse source glyph IDs for translated text.

Try line wrapping inside the original region, then reduce font size only to the user's minimum. If text still does not fit, preserve the full text in a callout and mark overflow. Never truncate silently, stretch glyphs to arbitrary widths, overlap another cell, or enlarge the page. The browser and desktop can have different shaping implementations, but run the same overflow and geometry fixtures.

`render_original(anchor, tile)` uses the unchanged source. `render_translated(anchor, tile, ready_regions)` paints the validated background plan and the latest completed layout for those regions. Until a region is ready, retain its original pixels. This avoids blank translated pages during incremental work.

## Viewport priority, cache, and bounded work

Selection-triggered work has the highest priority, then visible regions, then adjacent pages, then explicit background translation. Maintain separate bounded queues for render, extraction, OCR, and provider calls. The renderer must not wait behind network calls. Large documents remain virtualized. The queue stores IDs and demand, not every page bitmap.

A viewport update replaces pending demand and cancels obsolete render work. It does not repeatedly submit identical provider requests. Deduplicate in-flight work by semantic cache key. Maintain provider-specific concurrency, request-size, retry, and user budget limits. Retry only retryable responses, honor server backoff, apply jitter, and stop on quota or authentication failure. Cancellation cannot guarantee a request already received by a provider is unbilled.

Translation keys include document hash, extraction engine and version, region fingerprint, normalized text, source and target languages, provider and model, prompt version, glossary hash, context hash, and relevant translation settings. Never key by page number and URL alone. Layout keys add font set, layout version, and fit policy, but not viewport zoom. Tile keys add scale bucket, rotation, background revision, and region layout revisions.

Use IndexedDB for the browser and SQLite plus a tile directory for native. Start with separate caches. Both stores support schema migration, bounded least-recently-used eviction, clear-document, clear-all, and private sessions without disk persistence. An optional companion may later share results through the same contract. Passwords and decrypted file bytes do not persist without explicit consent. A complete PDF hash is only available after complete acquisition. Partial downloads use provisional session identity and cannot write durable cross-session entries under an assumed full-file hash.

## Chrome acquisition is part of the product

Own a bundled extension-origin PDF viewer. Do not inject into or depend on Chrome's built-in PDF viewer. Bundle PDF.js, workers, fonts, and WebAssembly locally under MV3 policy. The content script only detects ordinary-page embeds or links and offers an acquisition action.

Detect likely PDF navigations using permitted response MIME observation and navigation metadata. URL suffixes are hints, not proof. Deduplicate per tab and navigation ID, prevent viewer-to-viewer loops, preserve the original URL, and provide **Open original**. An automatic mode can open the mirror after the user grants the source-host permissions. It is not universal interception of every response body.

A byte acquisition adapter must check MIME, size limits, redirect destinations, PDF signature, and authorization failures. Optional host permissions cover the actual source and permitted provider destinations. Signed URLs, cookies, POST downloads, cross-origin redirects, blob URLs, embedded private viewers, and `file://` are separate fixtures. A second GET can fail or have side effects. Never replay a POST, export page credentials to native, or silently ask the companion to bypass browser authorization. Offer explicit file selection or save-and-open when bytes cannot be acquired. Local file access requires Chrome's separate file-access setting if navigating a file URL.

Chrome API capabilities change. The current documentation lists a `mimeHandler` API, but this investigation did not establish its channel, availability, or public PDF replacement permissions. Feature detection and a real supported-version spike are mandatory before using it. The initial candidate does not depend on it or on blocking `webRequest` in MV3.

Long-running viewer state and workers live in the extension page rather than assuming the MV3 service worker stays alive. Persist only resumable metadata. Closing the viewer cancels outstanding work. The desktop companion is optional, so extension-only mode must still open a PDF, translate through a configured supported provider, select pairs, and resize its split.

## Windows capture is not document extraction

Use [Windows.Graphics.Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture) after `IsSupported()` and a system picker initialized with the app HWND. The source describes display and application-window frames, resize handling, device loss, frame lifetime, and HDR concerns. Work stays off the UI thread.

Copy only the valid content rectangle before returning a frame to its pool. Stamp every frame with session and revision. Detect unchanged regions before OCR and translation. A resize, DPI change, target replacement, or large scene change invalidates geometry. Drop stale OCR results and overlays. Hold a translated overlay only while its source-region fingerprint still matches. Suspend on lock, target close, unsupported capture, protected black frames, or unstable content. The UI must report paused rather than translate stale pixels.

Mirror the captured source inside our own split view. Do not make click-through overlays or synthetic wheel forwarding necessary for the first release. A user scrolls the actual target, and capture follows. Selection in the mirror pairs recognized text and translation only. It cannot promise selection control inside the other app. Screen capture risks capturing the mirror itself. Exclude our window where supported and reject or warn on recursive capture paths. Show a persistent capture indicator and a Stop control. Store no frame history by default.

## Alternatives and synthesis

The document-first candidate concentrates PDF fidelity in extraction and rendering adapters. It preserves exact coordinates for accessible PDFs and permits an honest approximate route for capture. Its cost is two PDF render engines and a difficult browser suppression adapter.

A structurally different pixel-first candidate captures or rasterizes every source, then uses one OCR, tracking, masking, and translation pipeline. It can treat browser PDFs and arbitrary desktop windows alike. It loses embedded Unicode, font metadata, hidden reading structure, original vector scale, and clean text suppression. It spends OCR work on content the PDF already describes. That violates this product's highest-fidelity use case, so it is not the base candidate. Reuse its dirty-region tracking and revision discipline only for capture and raster regions.

A common PDFium-WASM and native engine could reduce extraction differences. It adds a browser toolchain, binary size, sandbox, font, packaging, and engine-API validation burden. Reconsider it if the PDF.js suppression spike fails and a measured WASM feasibility spike passes. Do not hide that choice behind an engine factory before evidence exists.

Only openai-codex/gpt-6.1-sol is available in this task. The alternatives above are same-model analysis, not a diverse-model arena or independent external validation. This document is one architecture candidate for parent synthesis. Implementation and final product approval are deliberately not started.

## Verifiable implementation gates

These are proposed acceptance checks, not measured results. Agree the fixture corpus and reference Windows hardware before assigning performance thresholds.

1. **Native shell gate.** Pin dependencies, install the required Rust and MSVC SDK toolchain, build a clean Windows x64 release, and launch on Windows 10 2004 or a deliberately raised documented baseline plus Windows 11. Render a PDF tile and Unicode translation. Test resize, keyboard navigation, split dragging, CJK input, high contrast, DPI changes, and screen-reader reachability. A workflow file or macOS screenshot does not pass this gate.
2. **Geometry gate.** Run round-trip transform fixtures for CropBox offsets, non-default UserUnit, every page rotation, mixed sizes, negative coordinates, zoom, and display scale. Assert region hit tests and paired highlights land on the same source content in both panes. Declare tolerances before screenshots are generated.
3. **Suppression gate.** Compare original and translated-background renders for plain text, forms, nested forms, shared resources, transparency, clipping text, Type 3 fonts, annotations, table rules, watermarks, and text over images. Non-target graphics must remain unchanged within an explicitly declared raster tolerance. Any unsafe case must produce `OriginalWithCallout`, not a misleading success.
4. **Text and layout gate.** Test ligatures, missing Unicode maps, mixed OCR and embedded text, multi-column reading order, RTL, CJK, combining marks, vertical text, tables, math, and code. Test long translations at the font-size floor. Full translated text must remain reachable. Region pairing must work both ways without claiming word alignment.
5. **Scheduling gate.** With fake delayed and reordered providers, scroll and change language during requests. Assert visible demand wins, stale replies cannot attach to a new profile, identical requests deduplicate, work stays bounded, and closing the document cancels or discards completion. Record document size, hardware, cache state, network, provider, and percentile methodology when latency is eventually measured.
6. **Provider gate.** Contract tests cover Google, DeepL, OpenAI, and the chosen local server. Include auth failure, quota, retry headers, malformed structured output, missing or duplicate IDs, malicious HTML, document prompt injection, oversized text, and cancellation. Unit tests use fakes. Live smoke tests require explicit credentials and budget, never hidden paid calls.
7. **Browser gate.** Load a packaged MV3 extension on the stated stable Chrome baseline. Exercise MIME-only PDF URLs, redirects, range responses, signed and authenticated links, attachment responses, denied host access, file URLs, blob URLs, POST downloads, embeds, worker suspension, reopening, original-view escape, and interception-loop prevention. Unsupported acquisition must show an actionable import path.
8. **Capture gate.** Use an actual Windows window and display. Test scrolling, motion, minimize, target close, resize, mixed-DPI monitors, lock, HDR or explicit SDR limits, protected content, GPU reset, recursive capture, unavailable OCR languages, and stop. No result may be displayed on a different frame revision.
9. **Privacy and release gate.** Inspect provider payloads and logs. Verify keys and text never leak to page scripts, cloud calls require policy, private sessions leave no persistent document data, clear-cache deletes its documented scope, native host permits only the intended extension ID, dependencies carry notices, and installers use Mirror branding. Test clean install and uninstall without deleting user PDFs.

The throughput checkpoint is a native local PDF rendered in two resizable panes with one fake translated region, correct coordinates, selection pairing, and an explicit suppression warning. It proves the core interaction without spending provider money. The next checkpoint is extension-only acquisition of a real PDF under MV3. Only after those pass should provider expansion and window capture run in parallel.

## Remaining risks and decision-changing evidence

- The browser text-removal gate is the largest fidelity risk. A failure changes renderer strategy, not permission to relabel masks as exact.
- GPUI is supported by upstream source and packaging work, but no build was run here. A failed clean Windows spike or inaccessible text interaction favors egui or a revised shell decision without changing the domain contracts.
- Cloud provider credentials, consent, costs, and regional data policy remain deployment concerns. A provider being available to the coding agent does not configure the finished app.

This design is ready for comparison and checkpoint review. It is not evidence that universal automatic interception, pixel-perfect translated typography, OCR restoration, or a Windows binary already works.
