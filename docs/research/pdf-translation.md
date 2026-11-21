# PDF translation research: layout-preserving output

**As of:** 2026-11-21 (Asia/Ho_Chi_Minh)
**Scope:** official PDFMathTranslate, BabelDOC, and PDFMathTranslate-next repositories; current web/native export gaps; licensing and safe adaptation; smallest verified next slice.
**Mutation boundary:** this report only. No production code or upstream source was copied.

## Executive decision

The inspected projects solve a problem the current product does not yet solve: they operate on a PDF-aware intermediate representation and write a new PDF content stream while retaining source-page objects, rather than printing HTML. BabelDOC is the strongest architectural reference. PDFMathTranslate is the clearest older end-to-end reference. PDFMathTranslate-next is primarily a consumer and integration layer over BabelDOC, not a separate writer implementation.

Do **not** copy or adapt their implementation into this product. All three inspected repositories are AGPL-3.0. Use them as behavior and architecture references only, then design and implement an independent writer around this repository's own contracts and dependencies. Any decision to link, vendor, run as a service, or distribute a derivative of AGPL code needs a separate legal review.

The smallest useful next slice is not a full document translator. It is a one-page, native-text PDF writer proof with a frozen fixture and strict pixel/text/annotation checks. It should be isolated from the production UI until the writer contract is proven.

## Sources and inspection record

The local reference checkouts were inspected at these exact commits:

| Project | Official repository | Inspected commit | License evidence | Relevant role |
|---|---|---:|---|---|
| PDFMathTranslate | https://github.com/Byaidu/PDFMathTranslate | `7e897b204ddc1c99d401e706924d664329885458` | `LICENSE`; `pyproject.toml` declares `AGPL-3.0` | Older Python pipeline: parse layout, translate paragraphs, typeset, patch PDF streams |
| BabelDOC | https://github.com/funstory-ai/BabelDOC | `dd9adc352b957533d05b8cb94e88a7589cc56a35` | `LICENSE`; `pyproject.toml` declares `AGPL-3.0` | PDF parser, document IR, staged processing, Rust/Python writer |
| PDFMathTranslate-next | https://github.com/PDFMathTranslate-next/PDFMathTranslate-next | `07022b4d8585330c6b8413dd2cea9d203d1efb36` | `LICENSE`; `pyproject.toml` declares `AGPL-3.0` | User-facing CLI/API/WebUI over BabelDOC 0.7.x |

The local repository was clean at the start of report authoring on branch `research/pdf-translation`. The tracked Markdown checklist contained 38 files, and the required local guidance and tracked Markdown sources had already been read before this report was authored.

### Exact source paths inspected

These links are pinned to the inspected commits, not to a moving default branch:

- PDFMathTranslate README: https://github.com/Byaidu/PDFMathTranslate/blob/7e897b204ddc1c99d401e706924d664329885458/README.md
- PDFMathTranslate package metadata: https://github.com/Byaidu/PDFMathTranslate/blob/7e897b204ddc1c99d401e706924d664329885458/pyproject.toml
- PDFMathTranslate converter: https://github.com/Byaidu/PDFMathTranslate/blob/7e897b204ddc1c99d401e706924d664329885458/pdf2zh/converter.py
- PDFMathTranslate PDF interpreter: https://github.com/Byaidu/PDFMathTranslate/blob/7e897b204ddc1c99d401e706924d664329885458/pdf2zh/pdfinterp.py
- PDFMathTranslate high-level flow: https://github.com/Byaidu/PDFMathTranslate/blob/7e897b204ddc1c99d401e706924d664329885458/pdf2zh/high_level.py
- PDFMathTranslate OCR path: https://github.com/Byaidu/PDFMathTranslate/blob/7e897b204ddc1c99d401e706924d664329885458/pdf2zh/ocr.py
- BabelDOC README: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/README.md
- BabelDOC package metadata: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/pyproject.toml
- BabelDOC IL schema: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/babeldoc/format/pdf/document_il/il_version_1.py
- BabelDOC layout model: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/babeldoc/docvision/doclayout.py
- BabelDOC high-level stages: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/babeldoc/format/pdf/high_level.py
- BabelDOC translation configuration: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/babeldoc/format/pdf/translation_config.py
- BabelDOC result merging: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/babeldoc/format/pdf/result_merger.py
- BabelDOC Python PDF writer helpers: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/babeldoc/format/pdf/document_il/backend/pdf_creater.py
- BabelDOC Rust IR types: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/rust/il_types/src/lib.rs
- BabelDOC Rust IR core: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/rust/ir_core/src/lib.rs
- BabelDOC Rust processing stages: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/rust/p2_bridge/src/production_stages.rs
- BabelDOC Rust writer bridge: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/rust/p2_bridge/src/writer.rs
- BabelDOC Rust PDF writer: https://github.com/funstory-ai/BabelDOC/blob/dd9adc352b957533d05b8cb94e88a7589cc56a35/rust/writer_core/src/pdf.rs
- PDFMathTranslate-next README: https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/07022b4d8585330c6b8413dd2cea9d203d1efb36/README.md
- PDFMathTranslate-next package metadata: https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/07022b4d8585330c6b8413dd2cea9d203d1efb36/pyproject.toml
- PDFMathTranslate-next high-level adapter: https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/07022b4d8585330c6b8413dd2cea9d203d1efb36/pdf2zh_next/high_level.py

## What each project actually does

### PDFMathTranslate 1.x

The older pipeline is compact and easy to follow:

1. `pdf2zh/high_level.py` opens a working copy with PyMuPDF, prepares multilingual fonts, optionally adds OCR text to image-only pages, and creates an `obj_patch` map for page/content-stream replacement.
2. `pdf2zh/pdfinterp.py` subclasses the pdfminer page interpreter. It records page and form-object content streams, preserves object identifiers, and returns original drawing operations separately from new text operations.
3. `pdf2zh/converter.py` walks `LTChar`, `LTLine`, and figure objects. It groups text into paragraphs, identifies formulas using font/character/layout heuristics, and replaces formulas with placeholders such as `{v0}` while translation runs.
4. The translated paragraph is typeset back into the original paragraph bounds. The implementation chooses a font, tracks advances, wraps when the original paragraph had line breaks, and re-emits formula glyphs and lines at their recorded coordinates.
5. The old content streams are retained for page artwork and non-text operations. The new stream is installed so translated text is painted over the source page. It then produces a translated PDF and a bilingual PDF by inserting original and translated files into a new document.

This is a useful reference for the minimum data needed by a paragraph-level renderer: source bounds, baseline/size, line-break state, font/glyph identity, formula spans, and page/object coordinates. It is not a general document model. Its formula detection is heuristic, its paragraph model is mutable stack state, and its typesetting is coupled to pdfminer and PyMuPDF internals.

**Images, charts, and tables:** figures are not translated by the paragraph pass. The source drawing operations remain available, which preserves much of the page artwork. Layout detection supplies protected regions so ordinary text processing does not consume figure/table/formula areas. This is preservation, not semantic table reconstruction.

**OCR:** `pdf2zh/ocr.py` groups OCR words by detected regions, translates paragraphs, paints white rectangles over source glyph locations, and inserts a translated HTML text overlay. It preserves the source page pixels and explicitly restores links. The approach is limited by the rectangle fill and OCR geometry; it is not proof that arbitrary backgrounds or complex scans are safely erased.

### BabelDOC

BabelDOC is the most relevant architectural reference because it separates parsing, document state, processing stages, typesetting, and PDF writing.

#### Document IR

The generated/declared IL in `document_il/il_version_1.py` contains first-class types for:

- document and page structure;
- page/crop/media boxes and detected layout regions;
- fonts and per-glyph bounding boxes;
- characters and styles;
- paragraphs and paragraph compositions;
- formulas and formula characters;
- figures, curves, lines, forms, XObjects, inline forms, and original paths;
- graphic-state and passthrough instructions.

The Rust `il_types` crate mirrors the schema and adds passthrough nodes/views for preserving PDF operations. `ir_core` owns the document graph, page scopes, shared tables, typed cursors, generations, permissions, and artifact serialization. This is materially stronger than a list of translated strings because the writer can distinguish mutable translated content from immutable or preserved source structure.

#### Processing pipeline

`format/pdf/high_level.py` exposes an explicit staged flow. The named stages include:

1. parse PDF and create IR;
2. detect scanned pages;
3. parse page layout;
4. parse tables;
5. find paragraphs;
6. parse formulas and styles;
7. extract terms/glossary;
8. translate paragraphs;
9. typeset;
10. add fonts;
11. generate drawing instructions;
12. subset fonts;
13. save PDF.

`TranslationConfig` carries the cross-stage policy: page ranges, split strategy, formula patterns, OCR workarounds, table model, glossary state, font family, compatibility flags, output modes, cancellation, stage capture, deterministic output, and whether to skip or retain specific rendering features.

The pipeline is therefore a document transformation system, not just a translation API call. It can preserve context across split parts, extract terms, translate tables experimentally, isolate scanned-document workarounds, and report stage progress and cancellation.

#### PDF writer strategy

The writer is a two-level design:

- Python/PyMuPDF owns document opening, fallbacks, output assembly, metadata, font-subsetting orchestration, and dual/alternating-page merging.
- The Rust writer loads the source PDF, obtains a parser-selected page-object map, adds used fonts, builds per-page drawing instructions from the IR, supplements missing resource references, replaces content streams, and saves the PDF.

`writer_core/src/pdf.rs` is explicit that the page-object map is writer metadata rather than IR. Production functions reject missing or mismatched page mappings instead of silently selecting another page. The writer preserves source page objects and resources where possible, while replacing the content stream with generated drawing instructions. It also handles form/XObject streams and resource dependencies such as `ExtGState` and `Shading`.

The Python `PDFCreater` path shows the practical boundary around this writer: save fallbacks, CMap repair, font subsetting in a subprocess with a timeout, output merging, and compatibility modes. This is important for a production export path because PDF serialization and font operations can fail independently of translation quality.

#### Formulas, tables, and images

- **Formulas:** represented separately from ordinary paragraph text, with formula characters, visual boxes, offsets, advances, font evidence, and formula-specific stage logic. They remain anchored rather than being sent as ordinary translatable prose.
- **Tables:** represented through layout classes and table-aware processing. Translation is configurable and explicitly described as experimental in the README. This is not evidence of universal table fidelity.
- **Images/figures/vector artwork:** preserved through PDF forms, XObjects, curves, original paths, and passthrough drawing instructions. The architecture is designed to retain source operations while replacing or adding text operations. It does not guarantee fidelity for every malformed, unsupported, or unusual PDF.
- **Scans:** handled through scanned-page detection and an optional OCR workaround. The README states that the workaround assumes black text on a white background and uses white rectangles, so it is a controlled fallback, not a universal solution.

### PDFMathTranslate-next

The next repository's README describes it as a PDF translator based on BabelDOC and the official reference implementation for calling BabelDOC. Its `pyproject.toml` depends on `babeldoc>=0.7.1,<0.8.0`. Its high-level flow imports BabelDOC's asynchronous translator and configuration, creates a BabelDOC configuration from its settings model, runs translation in a subprocess, forwards structured progress, reports token usage, and propagates cancellation/errors through multiprocessing pipes.

This separation is useful for the current product's integration design, but it does not remove the AGPL and dependency boundary. PDFMathTranslate-next is a service/UI/process wrapper around the BabelDOC engine, not an independent permissively licensed writer that can be copied into this repository.

## Capability comparison

| Capability | PDFMathTranslate 1.x | BabelDOC | PDFMathTranslate-next | Implication for this product |
|---|---|---|---|---|
| Layout-preserving PDF output | Yes, paragraph heuristics and stream patching | Yes, staged IR and writer | Yes through BabelDOC | Current browser print path is not equivalent |
| Owned document IR | Limited paragraph/formula state | Yes, typed IL plus Rust ownership | Delegates to BabelDOC | A small owned IR is required before a robust writer |
| Formula preservation | Font/character heuristics and placeholders | First-class formula/style stages | Delegates to BabelDOC | Keep formulas as protected spans, not plain text |
| Tables | Protected regions; limited semantic handling | Table-aware, configurable, experimental translation | Delegates to BabelDOC | Do not promise translated tables in the first slice |
| Images/vector artwork | Retain original drawing operations | Preserve page objects, forms, XObjects, curves, passthrough | Delegates to BabelDOC | Pixel-preserving background is a hard acceptance check |
| OCR/scans | OCR pages and rectangle overlay | Detection plus explicit workaround modes | Delegates to BabelDOC | Current scan OCR is not enough for arbitrary PDF export |
| Font handling | Tiro/Noto insertion and optional subsetting | Font mapper, used-font discovery, subsetting/CMap repair | Delegates to BabelDOC | Font fallback and subset failures need visible errors |
| Bilingual output | Original/translated documents assembled | Mono, dual, side-by-side/alternating, split merge | Exposes BabelDOC options | Product should start with mono output only |
| Cancellation/progress | Callback/thread pool support | Stage progress, cancellation, deterministic options | Multiprocessing forwarding | Preserve current generation/cancellation contract |
| Operational isolation | In-process Python | Rust/Python boundary and subprocess fallbacks | Dedicated subprocess | A writer spike should be isolated from the UI |
| License | AGPL-3.0 | AGPL-3.0 | AGPL-3.0 | Reference only unless legal/product decision changes |

## Gap against the current repository

The current repository already has a usable reader and translation overlay, but it does not yet have a binary PDF writer.

### Web

`docs/feature-board.md` records A26 as TXT plus **Print / Save as PDF** through the browser print path. The same entry explicitly records the gap: browser-generated PDF loses the original binary layout and artwork fidelity. The web pipeline currently extracts text items, suppresses or masks source text in the viewer, retains artwork in the rendered view, and fits translated text into browser regions. Those are strong reader behaviors, not a PDF content-stream writer.

The web package already includes `pdf-lib`, but the presence of that dependency is not evidence that it can import arbitrary existing page content, remove source glyphs, preserve all resources, and re-emit a faithful translated page. A writer proof must establish those properties on fixtures before the dependency is promoted to a production export path.

### Native

`docs/native-product-status.md` records the native reader, PDFium rendering, source-art preservation, and paired translated text as implemented and tested. It also records native PDF export as an open item. `docs/feature-board.md` marks C22, native translated PDF export, as not implemented. PDFium is currently a rendering/inspection boundary in this product, not an owned PDF serialization layer.

### Shared product constraints

Current evidence supports these claims:

- native embedded text can be extracted and translated into paired regions;
- source artwork is retained in the reader;
- scan OCR exists for reader/capture flows;
- translation is consent-gated and generation-bound;
- browser print is not layout-preserving binary export;
- no current native or web path proves source glyph removal plus target glyph insertion in a saved PDF.

Current evidence does **not** support these claims:

- universal PDF fidelity;
- table structure reconstruction;
- safe source erasure on complex backgrounds;
- preserved annotations, forms, outlines, or all embedded resources after export;
- live-provider translation quality in an exported PDF;
- production-ready native PDF export.

## Licensing and commercial constraints

All three source projects expose AGPL-3.0 as the project license. The official AGPL text permits commercial charging, but it is strong copyleft. In practical terms, distribution of a covered or derivative work requires preserving license and notices and providing the corresponding source under the license terms. AGPL also has a network-interaction source-offer requirement for modified versions used to provide network access.

The following are separate questions and must not be conflated:

1. **Reading ideas:** safe as an engineering activity. This report does that.
2. **Calling an unmodified external executable/service:** potentially a separable-process integration, but still requires legal review of distribution, deployment, user access, and dependency obligations.
3. **Linking, vendoring, copying, translating, or adapting code:** may create a covered or derivative work. Do not do this without an explicit license decision.
4. **Reimplementing behavior independently:** the preferred technical path here, provided no upstream source expression is copied and the implementation is based on documented requirements and independent code.

The current repository's `docs/reference-notes.md` already records BabelDOC and PDFMathTranslate as AGPL references only and says not to copy their code. The existing third-party notices for other dependencies do not grant permission to use these three AGPL projects in the product.

This is an engineering report, not legal advice. Before shipping a linked or bundled AGPL engine, obtain a written decision covering desktop distribution, hosted use, source-offer obligations, notices, upgrades, and whether the intended product license is compatible.

## Safe adaptation boundary

### Safe to learn and reimplement independently

- staged parse/layout/translate/typeset/write lifecycle;
- explicit page and block identifiers;
- protected spans for formulas and non-translatable regions;
- page-object identity maps and fail-closed writer validation;
- resource dependency checks before replacing content streams;
- font usage tracking, fallback, subsetting, and CMap validation;
- cancellation, progress, deterministic fixture output, and bounded subprocess isolation;
- separate mono and bilingual output policies;
- OCR as a distinct path with explicit background assumptions and warnings.

### Do not copy into this repository

- upstream Python/Rust functions, classes, generated schema, or code fragments;
- upstream IR schema files or generated bindings;
- upstream writer/parser modules or a translated/adapted port;
- upstream model assets or weights without independent license review;
- upstream test fixtures or output artifacts if they contain protected source material;
- a dependency lockfile or package arrangement that silently pulls an AGPL engine into the product.

### Recommended independent contract

Define a product-owned, smaller IR first. It should contain only the information needed by the first proven slice:

```text
Document
  pages[]
Page
  page_index
  media_box / crop_box / rotation
  source_page_identity
  preserved_content_reference
  blocks[]
TextBlock
  stable_id
  source_text
  target_text
  bbox
  baseline / font_size / writing_direction
  protected_spans[]
  fit_status / warning
AnnotationReference
  source_object_identity
  kind
  bounds or page-relative metadata
```

This is an independent proposal, not a copy of the upstream IL. It intentionally excludes tables, formula reconstruction, arbitrary PDF operators, and full resource graphs until the first writer proof demonstrates the need for them.

## Smallest verified next slice

### Scope

Build a test-only or isolated prototype for **one native-text page** with:

- two translated text blocks with different lengths;
- one embedded raster or vector chart outside the text blocks;
- one link annotation;
- one embedded source font and one target fallback font;
- a known page size and rotation of zero;
- a deterministic local translation fixture, not a paid provider.

The slice should produce one monolingual translated PDF. Do not start with bilingual assembly, OCR, tables, formulas, multi-page splitting, or the native UI.

### Required behavior

1. Read the source PDF and preserve page size, rotation, chart/artwork, and link annotation.
2. Suppress the source text only within explicitly accepted text rectangles, then insert target text at those coordinates.
3. Fail closed when a source page/object/resource identity cannot be resolved.
4. Record per-block fit status. Overflow must be visible in the result or fail the export; it must not be silently clipped.
5. Keep source and target text in a product-owned IR so the writer is not coupled directly to the translation provider.
6. Keep the writer behind an isolated interface. No production export button should depend on it until the checks pass.

### Verification gate

The slice is verified only when all of these pass on a checked-in fixture:

- output opens in an independent PDF parser;
- page count, media box, crop box, and rotation match the source;
- chart/artwork pixels outside approved text masks are identical after rasterization at a fixed DPI;
- the target text is extractable and appears in the expected reading order;
- source text is absent from the accepted text regions in the saved PDF, or the result is explicitly classified as overlay-only and rejected for production export;
- the link annotation remains present and points to the same target;
- no block reports silent overflow;
- malformed/missing page-resource identity produces a deterministic error;
- the fixture output is deterministic when deterministic mode is enabled;
- existing web/native reader and translation tests remain green because the prototype is not wired into them.

### Explicit non-goals

- no AGPL code or generated schema;
- no OCR or scanned-page export;
- no formula translation;
- no semantic table translation;
- no full font-subsetting implementation unless the fixture requires it;
- no claims of universal PDF compatibility;
- no production UI integration;
- no live cloud provider request;
- no native packaging or deployment.

If this slice cannot preserve source-text absence while retaining artwork and annotations, stop and record the limitation. Do not restore a green test by changing masks, tolerances, or acceptance criteria after seeing a failure.

## Decision gates after the slice

- **Pass:** expand the owned IR with only the missing evidence-backed fields, then add a small multi-page fixture.
- **Overlay-only pass:** keep it as reader-preview export only and do not label it layout-preserving PDF translation.
- **Fail on writer/library limits:** compare a different permissively licensed writer or an isolated external engine, then revisit the licensing decision before integration.
- **Font or annotation loss:** treat as a writer blocker, not a translation-quality issue.
- **Complex background failure:** keep scan/OCR export out of scope and retain the current paired reader path.

## Bottom line

BabelDOC demonstrates the architecture needed for high-fidelity output: owned document state, protected formulas and graphics, staged translation/typesetting, page-object identity, resource-aware stream writing, font handling, and explicit operational fallbacks. PDFMathTranslate demonstrates the simpler predecessor pattern and its limits. PDFMathTranslate-next demonstrates how a user-facing application can isolate that engine behind a subprocess and progress protocol.

The current product should copy none of the implementation. The next defensible move is an independent one-page writer proof with strict evidence. Until that proof passes, browser print remains a convenience export, paired reader translation remains the primary product path, and native PDF export remains unimplemented.
