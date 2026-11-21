# PDF document parsing and OCR research

Date: 2026-11-21 (Asia/Saigon)

Status: research-only.

This report inspects the official Docling, MinerU, PaddleOCR, and OCRmyPDF repositories at pinned commits.

No production code, vendor code, model weights, or runtime assets were modified or added by this research.

## Decision

Keep PDF.js in the browser and PDFium in the native shell as the authoritative renderer and first-pass native-text source.

Do not replace either renderer with a Python document parser.

Add semantic parsing behind an optional sidecar adapter that converts engine output into the existing Document IR.

The recommended first candidate for a controlled adapter spike is Docling Standard on local CPU, with explicit model prefetching and an offline artifact directory.

Use OCRmyPDF as a separate searchable-PDF/PDF-A export adapter, not as the semantic parser.

Benchmark PaddleOCR PP-StructureV3 as the strongest specialized alternative for layout, table, formula, and OCR quality.

Keep MinerU as a research comparator and possible opt-in service adapter, but do not make it the default product dependency before a license review because its repository license adds commercial thresholds and an online-service attribution obligation to Apache-2.0.

The recommendation changes only if a controlled benchmark shows that PaddleOCR or MinerU materially improves the current workflow without violating the offline, packaging, latency, or license requirements.

## Scope and evidence rules

Claims below are separated into observed repository facts, engineering recommendations, and open questions.

The pinned commit is the source identity for each repository.

The canonical documentation links are included for navigation, while the pinned blob links are the evidence used for this report.

Model weights are not assumed to have the same license as repository code.

A model or external runtime must be audited by exact model identifier, revision, license, and redistribution terms before packaging.

No benchmark result is claimed in this document.

## Repository provenance

| Project | Official repository | Inspected commit | Pinned source tree | Code/license evidence |
| --- | --- | --- | --- | --- |
| Docling | [docling-project/docling](https://github.com/docling-project/docling) | `5182e556308958f3ac4762bb7d03a092c2f339c9` | [commit tree](https://github.com/docling-project/docling/tree/5182e556308958f3ac4762bb7d03a092c2f339c9) | [MIT license](https://raw.githubusercontent.com/docling-project/docling/5182e556308958f3ac4762bb7d03a092c2f339c9/LICENSE), [package metadata](https://raw.githubusercontent.com/docling-project/docling/5182e556308958f3ac4762bb7d03a092c2f339c9/pyproject.toml) |
| MinerU | [opendatalab/MinerU](https://github.com/opendatalab/MinerU) | `097de7f63f54722c9b805ee1c9a14a0c5b02e078` | [commit tree](https://github.com/opendatalab/MinerU/tree/097de7f63f54722c9b805ee1c9a14a0c5b02e078) | [MinerU Open Source License](https://raw.githubusercontent.com/opendatalab/MinerU/097de7f63f54722c9b805ee1c9a14a0c5b02e078/LICENSE.md), [package metadata](https://raw.githubusercontent.com/opendatalab/MinerU/097de7f63f54722c9b805ee1c9a14a0c5b02e078/pyproject.toml) |
| PaddleOCR | [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | `dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf` | [commit tree](https://github.com/PaddlePaddle/PaddleOCR/tree/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf) | [Apache-2.0 license](https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/LICENSE), [package metadata](https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/pyproject.toml) |
| OCRmyPDF | [ocrmypdf/OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) | `86a5e723ea2b612e8df4a647056b0ebf3b3c97a5` | [commit tree](https://github.com/ocrmypdf/OCRmyPDF/tree/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5) | [MPL-2.0 license](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5/LICENSE), [package metadata](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5/pyproject.toml) |

## Current architecture and adapter constraint

The current browser reader uses PDF.js for page rendering, embedded text extraction, geometry, search, outline navigation, and text suppression experiments.

The native Windows path uses PDFium through `pdfium-render` for page rendering, text segments, geometry, and clean-artwork generation.

The current browser OCR engine is Tesseract.js with locally bundled assets and explicit preprocessing in `src/ocr/preprocess.ts`.

The native OCR path prefers Windows OCR and has a Tesseract TSV fallback in `desktop/src/ocr_fallback.rs`.

The existing canonical Document IR already has pages, polygons, stable block IDs, reading order, semantic block types, confidence, provenance, translations, and export records.

Relevant local contracts are:

- `src/pdf/document.ts` for PDF.js rendering and text extraction.
- `desktop/src/pdf.rs` for PDFium rendering, text extraction, and text-object suppression.
- `src/core/ir.ts` for the versioned Document IR.
- `src/core/blocks.ts` for conservative semantic block classification.
- `src/core/tables.ts` for geometry-based table recovery.
- `src/core/formulas.ts` for conservative formula protection and LaTeX conversion.
- `docs/ocr-benchmark.md` for the existing CER/WER runner and fixture conventions.
- `docs/features.md` and `docs/backlog-e-n.md` for the current feature and evidence status.

The adapter boundary should preserve those ownership rules:

1. PDF.js and PDFium own source bytes, page rasterization, embedded text, page geometry, and visual fidelity.
2. The semantic engine receives a page or document reference plus an explicit render policy.
3. The semantic engine returns immutable page/block evidence, not UI state or translations.
4. The adapter maps engine coordinates into the IR's top-left, page-point coordinate system.
5. The adapter records engine, model, revision, preprocessing, runtime, and confidence provenance.
6. The adapter never silently uploads a document or downloads a missing model during an offline run.
7. Searchable-PDF generation is a separate export adapter that consumes recognized word geometry.
8. The original PDF bytes and original page pixels remain available when an engine fails or produces a warning.

## Capability comparison

| Capability | Docling | MinerU | PaddleOCR PP-StructureV3 | OCRmyPDF |
| --- | --- | --- | --- | --- |
| Primary role | General document conversion and structured PDF understanding | End-to-end document parsing, OCR, structured outputs, library and service workflows | Modular OCR plus layout, table, formula, chart, and reading-order parsing | OCR text-layer and PDF/A production pipeline |
| Layout | Standard pipeline has layout object detection; VLM pipeline handles more complex pages | Multiple tiers with native PDF parsing and model-based layout; complex layouts are a core target | Layout detection with document categories including text, title, table, formula, image, header, footer, chart, and sidebar | No semantic layout model; preserves page image and places OCR text |
| Reading order | Standard reading-order stage; visible PDF rules can be used as signals; VLM is available for difficult pages | Reading-order-sorted JSON/Markdown; newer native parsing can use Tagged PDF/PDF/UA semantics and geometric rules | Explicit multi-column reading-order recovery and chart/layout parsing | Text layer follows OCR output; not a semantic reading-order contract |
| Tables | TableFormer fast/accurate modes; optional VLM table structure; cell matching controls | Structured tables, HTML/Markdown/JSON, merged and cross-page table handling in higher tiers | Optional table recognition with layout, table classification, cell detection, structure models, and merged-cell output | OCR text only; cookbook notes tables are read row by row in sidecar text |
| Formulas | Formula enrichment and VLM paths; standard text extraction alone is not formula understanding | Formula recognition with LaTeX in model-based tiers; Flash can preserve formula images for display | Optional formula recognition with UniMERNet, PP-FormulaNet, or related models; Markdown/JSON output | No formula recognition; OCR text may preserve some symbols but has no LaTeX/formula structure |
| OCR | Pluggable Tesseract, EasyOCR, RapidOCR, SuryaOCR, macOS Vision, and other engine options | OCR integrated into quality tiers; scanned and garbled PDFs can enter OCR flow | General OCR plus document preprocessing; 100+ language model families and PP-OCR variants | Tesseract by default, RapidOCR optional through ONNX Runtime |
| Searchable PDF | Not the primary output contract inspected here; keep the existing writer or use OCRmyPDF | PDF rendering exists and text remains selectable, but it is a derived render contract, not a PDF/A archival contract | PP-StructureV3 documentation centers on Markdown/JSON; no equivalent PDF/A text-layer contract was found in the inspected sources | First-class searchable PDF/PDF-A output, sidecar text, page rotation, deskew, and validation |
| Best adapter shape | Local process or service returning structured JSON and page assets | Local service or Python SDK adapter returning structured JSON and stable locators | Local process, HTTP service, or C++/Python boundary returning structured JSON | Subprocess or Python API for export, with a PDF artifact and optional sidecar/hOCR data |

## Project findings

### Docling

Primary evidence:

- [README at pinned commit](https://github.com/docling-project/docling/blob/5182e556308958f3ac4762bb7d03a092c2f339c9/README.md)
- [CLI reference](https://github.com/docling-project/docling/blob/5182e556308958f3ac4762bb7d03a092c2f339c9/docs/reference/cli.md)
- [Model catalog](https://github.com/docling-project/docling/blob/5182e556308958f3ac4762bb7d03a092c2f339c9/docs/usage/model_catalog.md)
- [Advanced options](https://github.com/docling-project/docling/blob/5182e556308958f3ac4762bb7d03a092c2f339c9/docs/usage/advanced_options.md)

Observed strengths:

- It has a unified document representation with layout, reading order, tables, formulas, pictures, and provenance-oriented exports.
- The Standard PDF pipeline is designed for born-digital PDFs and can run CPU-only.
- The pipeline can use OCR on bitmap content, replace a broken text layer, enable table structure extraction, and select OCR, layout, and table engines independently.
- Visible horizontal and vertical PDF rules can participate in reading-order decisions.
- TableFormer has explicit fast and accurate modes, and cell matching can be disabled when mapping predicted structure back to PDF text cells causes merges.
- Formula enrichment is explicit rather than silently applied to every document.
- The native PDF pipeline is a useful low-cost comparison because it exposes native text and embedded images without layout, OCR, or table models.
- Models can be prefetched into an artifact directory and supplied with `--artifacts-path` for air-gapped use.
- Remote services require an explicit opt-in flag in the inspected options.

Constraints:

- The code is MIT, but the README and model catalog explicitly separate model usage licenses from code licensing.
- The Standard path has a substantial Python and model dependency surface even when CPU-only.
- The VLM path is slower and usually needs GPU or Apple MPS, depending on the selected model and backend.
- The VLM catalog includes models with different upstream licenses and some presets that require remote code review or a separately managed server.
- The CLI emits Markdown, JSON, YAML, HTML, DocTags, DocLang, LaTeX, and related structured outputs, but the inspected CLI does not make a searchable PDF/A artifact its primary contract.
- Page geometry is expressed in document points and page images are generated at a requested scale, so coordinate normalization is required at the adapter boundary.

Offline/runtime evidence:

- The pinned package metadata requires Python `>=3.10,<4.0`.
- The package separates format, OCR, local-model, VLM, and remote-service extras.
- The CLI provides `docling-tools models download` and `--artifacts-path` for prefetching and reuse.
- The default Standard pipeline is the realistic CPU baseline.
- VLM, formula enrichment, and advanced picture understanding need separate model and runtime choices.

Recommendation for this project:

Use Docling as the first semantic-parser adapter candidate because its code license is permissive, its output model maps naturally to the current Document IR, and it can be run locally without requiring a browser bundle.

Do not embed Python or model weights in the browser extension.

Start with Standard PDF parsing, native embedded-text comparison, OCR only on scan or broken-text pages, table structure enabled, formula enrichment disabled by default, and explicit artifact prefetching.

Treat VLM conversion as a later experimental path behind the same adapter contract.

### MinerU

Primary evidence:

- [README at pinned commit](https://github.com/opendatalab/MinerU/blob/097de7f63f54722c9b805ee1c9a14a0c5b02e078/README.md)
- [License at pinned commit](https://github.com/opendatalab/MinerU/blob/097de7f63f54722c9b805ee1c9a14a0c5b02e078/LICENSE.md)
- [Package metadata](https://github.com/opendatalab/MinerU/blob/097de7f63f54722c9b805ee1c9a14a0c5b02e078/pyproject.toml)
- [Official documentation index](https://github.com/opendatalab/MinerU/blob/097de7f63f54722c9b805ee1c9a14a0c5b02e078/docs/en/index.md)
- [Output formats and result contract](https://github.com/opendatalab/MinerU/blob/097de7f63f54722c9b805ee1c9a14a0c5b02e078/docs/en/reference/output_files.md)

Observed strengths:

- It targets complex PDFs, scans, formulas, tables, figures, and multi-column reading order.
- It has four parsing tiers: Flash, Basic, Standard, and Advanced.
- It returns structured content, Middle JSON, page/block locators, page images, and source-traceable outputs.
- The result contract separates internal model JSON from consumer-facing structured content.
- The PDF renderer supports original-layout or reflow output, and text remains selectable in the rendered PDF.
- Higher-quality parsing includes formula recognition, table reconstruction, cross-page table handling, and VLM-based recognition.
- The README describes local CPU operation on Windows, Linux, and macOS, with ONNX and llama.cpp in the base path and optional Torch/full extras for accelerated paths.
- The project has explicit model verification and local-server management commands in its documented workflow.

Constraints:

- The inspected repository uses a custom MinerU Open Source License based on Apache-2.0 with additional terms.
- The additional terms require a separate commercial license when consolidated MAU exceeds 100 million or monthly revenue exceeds USD 20 million.
- An online service based on MinerU must prominently identify that MinerU is used.
- Failure to satisfy those conditions can automatically terminate the license grant.
- The package requires Python `>=3.11,<3.15` at the inspected commit.
- The local quality tiers have meaningful RAM and model-download requirements.
- The documented table lists approximately 0.8 GB model download and 2 GB minimum RAM for Basic ONNX, approximately 2 GB and 8 GB RAM for Standard/Advanced ONNX plus llama.cpp, and approximately 3 GB and 16 GB RAM for the fuller accelerated path.
- Exact model licenses are not inherited from the repository license and must be checked per model repository and revision.
- The service-oriented workflow, model cache, background server, telemetry setting, and tier selection introduce more operational state than the current reader has today.
- The project can render a derived PDF, but that is not the same acceptance contract as OCRmyPDF's validated PDF/A pipeline.

Recommendation for this project:

Use MinerU as a pinned benchmark comparator and optional external service adapter.

Do not make it the default embedded dependency until legal review accepts the additional license obligations and the model manifest is complete.

If evaluated in production-like tests, invoke it through a separate process or local HTTP boundary and convert only its structured result into the Document IR.

Do not couple the reader UI to MinerU locators, tier names, background-server state, or its internal JSON schema.

### PaddleOCR and PP-StructureV3

Primary evidence:

- [README at pinned commit](https://github.com/PaddlePaddle/PaddleOCR/blob/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/README.md)
- [PP-StructureV3 pipeline guide](https://github.com/PaddlePaddle/PaddleOCR/blob/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/docs/version3.x/pipeline_usage/PP-StructureV3.en.md)
- [PP-StructureV3 algorithm and benchmark page](https://github.com/PaddlePaddle/PaddleOCR/blob/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/docs/version3.x/algorithm/PP-StructureV3/PP-StructureV3.en.md)
- [Installation and dependency groups](https://github.com/PaddlePaddle/PaddleOCR/blob/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/docs/version3.x/installation.en.md)
- [PaddleOCR package metadata](https://github.com/PaddlePaddle/PaddleOCR/blob/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/pyproject.toml)

Observed strengths:

- PP-StructureV3 is explicitly a document parsing pipeline rather than only scene OCR.
- It combines layout detection, general OCR, optional document preprocessing, table recognition, optional formula recognition, optional seal recognition, chart parsing, and Markdown/JSON formatting.
- The layout categories include headings, text, tables, formulas, figures, headers, footers, references, algorithms, charts, and sidebars.
- The documentation explicitly claims multi-column reading-order recovery.
- Table parsing is modular and includes table classification, wired/wireless structure recognition, cell detection, and model selection.
- Formula recognition is modular and exposes UniMERNet and PP-FormulaNet families, with variants for speed and accuracy.
- The pipeline supports CPU inference and offers lighter configurations, although the documentation recommends GPU for best throughput.
- The project exposes Paddle, Transformers, and ONNX Runtime execution options for supported modules.
- PaddleOCR has a separate `doc-parser` optional dependency group, so basic OCR installation does not need the full document parser surface.
- The docs expose model download links, model directory overrides, model names, device selection, and model auto-download behavior when a directory is not supplied.

Preprocessing evidence:

- PP-StructureV3 can enable document orientation classification, document unwarping, and text-line orientation classification.
- Its document-image-preprocessing subline is optional and independent of table and formula modules.
- The pipeline has configuration variants for preprocessing, chart parsing, table-disabled, formula-disabled, and lightweight modes.
- The exact preprocessing combination must be pinned in the benchmark because changing orientation, unwarping, or model size changes both quality and runtime.

Constraints:

- The repository code is Apache-2.0, but the inspected sources do not establish one universal license for every downloaded model weight.
- The pipeline is a multi-model stack, not a single small OCR asset.
- CPU support exists, but default model choices and formula/table modules can be expensive in memory and latency.
- PP-StructureV3's primary structured outputs are Markdown and JSON; no PDF/A searchable-text-layer contract comparable to OCRmyPDF was found in the inspected sources.
- The official browser SDK announced in the README targets PP-OCR OCR inference, not the complete PP-StructureV3 document parser.
- The exact Windows packaging story for all PP-StructureV3 modules, especially formula recognition and accelerated backends, remains an open integration question.

Recommendation for this project:

Benchmark PP-StructureV3 as the strongest specialized alternative to Docling.

Use it behind a sidecar boundary with an explicit model manifest and a JSON output converter.

Do not put Paddle runtime or PP-StructureV3 models into the browser extension.

If it wins on Vietnamese scans, tables, or formulas, consider it as a selectable native worker rather than replacing PDF.js or PDFium.

### OCRmyPDF

Primary evidence:

- [README at pinned commit](https://github.com/ocrmypdf/OCRmyPDF/blob/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5/README.md)
- [CLI at pinned commit](https://github.com/ocrmypdf/OCRmyPDF/blob/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5/src/ocrmypdf/cli.py)
- [Cookbook at pinned commit](https://github.com/ocrmypdf/OCRmyPDF/blob/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5/docs/cookbook.md)
- [Installation at pinned commit](https://github.com/ocrmypdf/OCRmyPDF/blob/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5/docs/installation.md)
- [Python package metadata](https://github.com/ocrmypdf/OCRmyPDF/blob/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5/pyproject.toml)

Observed strengths:

- It produces a searchable PDF or PDF/A with an invisible OCR text layer aligned below the page image.
- It keeps original embedded image resolution when possible and validates input and output.
- It supports sidecar OCR text, page rotation, deskew, background removal, cleaning, oversampling, and skip/redo/force OCR modes.
- Its documented preprocessing order is rotate, remove background, deskew, then clean.
- Tesseract is the default OCR engine and RapidOCR is an optional ONNX Runtime engine.
- The plugin interface can replace the OCR engine without changing the core PDF pipeline.
- The output contract is well suited to archival/searchable-PDF production rather than semantic document understanding.

Constraints:

- It does not provide semantic block types, table cell structure, formula LaTeX, or a general reading-order IR.
- The sidecar contains OCR text, not a complete semantic representation.
- It requires Python `>=3.11` plus external Ghostscript and Tesseract installations for the standard path.
- RapidOCR avoids Tesseract but brings its own ONNX model cache and resource cost.
- The README reports Windows support and registry-based Tesseract discovery, but a portable product still needs an explicit runtime packaging and language-pack plan.
- `--clean-final` and `--remove-background` can create visual artifacts and require page review.
- The core software is MPL-2.0, while some non-core code is MIT and documentation/test files are CC-BY-SA-4.0.

Recommendation for this project:

Use OCRmyPDF only for an explicit searchable-PDF/PDF-A export path or a preprocessing comparison.

Treat its output as a derived artifact with its own provenance and validation record.

Do not use its sidecar text as a replacement for the Document IR because it does not preserve the required semantic structure.

A subprocess adapter is preferable to linking the Python package into the native process.

## License and redistribution review

### Direct code licenses

| Project | Direct repository evidence | Integration implication |
| --- | --- | --- |
| Docling | MIT at the pinned `LICENSE` file | Code integration is permissive, but model and dependency licenses remain separate obligations. |
| MinerU | Apache-2.0 base with additional MAU/revenue thresholds, online-service attribution, and automatic termination terms | Do not treat this as ordinary Apache-2.0. Keep it optional until legal review and product attribution decisions are complete. |
| PaddleOCR | Apache License 2.0 in the repository and package metadata | Code is permissive, but each model weight and runtime must be checked separately. |
| OCRmyPDF | MPL-2.0 for core software; repository README identifies MIT non-core and CC-BY-SA documentation/test material | A subprocess boundary limits source coupling, but redistribution still needs the correct notices and any modified OCRmyPDF source must be published under MPL terms. |

### Model and runtime evidence

The inspected repositories make it clear that model weights are not a single project-level license decision.

For every selected model, record:

- Model repository URL.
- Exact model revision or commit.
- Weight filename and SHA-256.
- Model-card license.
- Commercial-use restrictions.
- Remote-code requirement.
- Runtime and accelerator requirement.
- Required attribution or notice.
- Whether redistribution is allowed.

Do not commit model weights to this repository.

Do not auto-download weights from a production application without an explicit provisioning step.

For an offline package, ship or provision a model manifest and verify every file before the worker starts.

### Legal recommendation

Docling is the cleanest first code-level candidate because the repository code is MIT and the model cache can be separated from the product source.

PaddleOCR is also code-level compatible with the current MIT product, but the multi-model weight and runtime matrix needs more work before packaging.

OCRmyPDF is suitable as an external tool with a notice bundle and clear MPL boundary.

MinerU should remain an optional research adapter until the additional license terms are accepted for the intended product and service distribution model.

This is an engineering license screen, not legal advice.

## Integration design for the current PDF.js/PDFium architecture

### Proposed data flow

```text
PDF bytes
  -> SHA-256 and page inventory
  -> PDF.js or PDFium native text extraction
  -> page classification: born-digital, scanned, hybrid, broken text
  -> optional sidecar parser on selected pages
  -> adapter normalization
  -> Document IR v1
  -> reader/search/translation/export
```

The browser and native renderer remain the source of truth for what the user sees.

The sidecar is an evidence producer, not a second viewer.

### Proposed sidecar request

The request should contain:

```json
{
  "protocol": 1,
  "source_sha256": "<64 lowercase hex>",
  "input": "path-or-private-staged-file",
  "pages": [1, 2],
  "mode": "standard",
  "offline": true,
  "render_dpi": 300,
  "language_policy": ["eng", "vie"],
  "tables": true,
  "formulas": true,
  "ocr": "auto",
  "model_manifest_sha256": "<64 lowercase hex>"
}
```

The production implementation should not accept arbitrary shell strings or arbitrary output paths.

The worker should receive a private staged input or a validated file descriptor and write only to a private output directory.

### Proposed sidecar response

Each page result should retain:

- Source page index and page dimensions.
- Source render dimensions and transform.
- Text spans and word boxes.
- Block polygons and semantic labels.
- Reading-order rank.
- Table cells, row/column indices, spans, and cell text.
- Formula source text, normalized LaTeX when available, and formula image bounds.
- OCR engine and model identity.
- Preprocessing operations and parameters.
- Confidence and warnings.
- Engine version, repository commit, model revisions, and runtime fingerprint.
- Explicit `complete`, `partial`, or `failed` page status.

The adapter should reject malformed, duplicated, out-of-bounds, or unproven coordinates.

Missing formula or table structure must remain a warning or unknown state, not an invented paragraph.

### Engine-specific adapter boundaries

| Adapter | Input | Output consumed by product | Must not own |
| --- | --- | --- | --- |
| PDF.js baseline | PDF bytes already opened by browser | Native text items, geometry, page images, search | Semantic model cache, translations, native process state |
| PDFium baseline | Validated local PDF path and page index | Native text segments, original/clean page raster, geometry | Browser state, cloud providers, model selection |
| Docling | Private staged PDF or page images plus pinned manifest | Structured JSON mapped to IR blocks, tables, formulas, page images | PDF.js/PDFium rendering authority, translations, UI state |
| MinerU | Private staged PDF through local CLI, SDK, or service | Structured content, block geometry, tables, formulas, locators mapped to IR | Product locator identity, remote upload policy, UI state |
| PaddleOCR | Rendered page images or PDF path through a local worker | Layout boxes, OCR words, tables, formulas, reading order mapped to IR | Browser bundle, source-PDF archival output, translation state |
| OCRmyPDF | Source PDF or rendered scan plus explicit preprocessing policy | Searchable PDF/PDF-A artifact, optional sidecar/hOCR evidence | Semantic block classification, formula LaTeX, canonical IR ownership |

### Failure behavior

If a sidecar is unavailable, the current PDF.js/PDFium path continues to work.

If a model is missing in offline mode, the worker returns a machine-readable missing-artifact error and does not attempt a network fallback.

If a parser returns partial output, the adapter keeps partial pages marked as partial and preserves the original raster.

If a parser changes page dimensions or rotation, the adapter rejects the result until the coordinate transform is explicit and tested.

If OCR confidence is low, the result is a warning and remains selectable for human correction.

## Real benchmark and acceptance plan

This plan is intended to produce evidence that can decide whether an adapter belongs in the product.

It does not assume that a public benchmark score predicts this application's behavior.

### Corpus

Build a versioned, hand-checked corpus outside the production source tree first.

The first release candidate should contain at least 30 documents and 90 pages:

| Slice | Minimum pages | Required cases |
| --- | ---: | --- |
| Born-digital native text | 15 | Single column, two columns, visible rules, headings, footnotes, rotated text, broken ToUnicode text |
| Scanned/OCR | 20 | Clean 300 DPI, skew, blur, low contrast, background noise, screen capture, mixed rotation |
| Hybrid | 10 | Native text plus raster stamp, image-only figure beside native text, partial OCR layer, outlined text |
| Tables | 15 | Wired, borderless, merged cells, empty cells, wrapped cells, multi-line headers, cross-page continuation |
| Formulas | 10 | Inline superscripts, display formulas, fractions, Greek symbols, matrices, formula labels, image-only formulas |
| Languages and scripts | 20 | English, Vietnamese with diacritics, Simplified Chinese, Japanese, Korean, Arabic or Hebrew, and mixed-language pages |

Keep the current checked-in fixtures as smoke fixtures.

Do not claim product quality from synthetic pages alone.

Each corpus document needs:

- Immutable source PDF SHA-256.
- Page-level source images rendered at a declared DPI.
- Hand-checked reading-order transcript.
- Word boxes or line boxes for OCR pages.
- Block polygons and semantic type labels.
- Table cell grid, text, row spans, column spans, and merged-cell labels.
- Formula reference in canonical LaTeX plus a rendered reference image.
- Expected page rotation and page dimensions.
- Notes for intentionally ambiguous or unscorable regions.

Sensitive documents should remain outside the repository.

Commit only small synthetic fixtures or redacted metadata unless the corpus owner explicitly approves redistribution.

### Engines and baselines

Run all candidates against the same PDF bytes and page images.

Record these baselines:

1. Current browser PDF.js native text extraction.
2. Current native PDFium text extraction.
3. Current browser Tesseract.js with the existing preprocessing and language assets.
4. Current native Windows OCR and Tesseract fallback where available.
5. Docling Standard with OCR and table structure enabled.
6. MinerU Basic and Standard where the local hardware supports both.
7. PaddleOCR PP-StructureV3 default and a lightweight CPU configuration.
8. OCRmyPDF Tesseract and, separately, OCRmyPDF RapidOCR where available.

Pin every engine commit, package version, model revision, language pack, runtime, device, and preprocessing configuration.

Run each engine in cold and warm modes.

The cold run includes process startup and model load.

The warm run reuses the already loaded worker but not cached output.

Offline runs must deny network access or run inside a network-isolated test environment.

A successful offline run must prove that all model artifacts were available before processing began.

### Metrics

#### Text recognition

Use the existing CER and WER definitions in `docs/ocr-benchmark.md`.

Report per page, per document, per language, and aggregate macro and micro averages.

Do not let a long easy document hide a short catastrophic page.

Record exact normalized text, CER, WER, substitutions, insertions, and deletions.

#### Reading order

Compare the predicted block sequence with the hand-checked sequence.

Report normalized sequence edit distance, adjacent-pair accuracy, Kendall tau, and cross-column inversion count.

A page with a single cross-column swap should be visible as a failure even if its CER is low.

#### Layout

For each semantic class, report polygon IoU, precision, recall, and F1.

At minimum score text, heading, table, formula, figure, caption, header/footer, and footnote.

Use a separate score for page-level detection and block-level matching.

#### Tables

Report table detection precision and recall.

Report cell grid structure F1, merged-cell span accuracy, and cell-text CER/WER.

Use TEDS or an equivalent tree-structure score when the evaluator is available.

Keep the raw predicted grid and normalized grid for failed cases.

#### Formulas

Report exact normalized LaTeX match, token edit distance, and operator/symbol preservation.

Also render the predicted and reference LaTeX and record visual equivalence separately.

A formula that is textually different but visually equivalent must not be silently counted as exact.

#### Searchable PDF

For OCRmyPDF and any future searchable-PDF writer, verify:

- PDF.js opens every output page.
- PDFium opens every output page.
- Page count, page dimensions, rotation, and visible source raster are preserved.
- Copy and search return the expected text.
- Extracted text matches the scored OCR transcript within the declared normalization.
- Text-layer word boxes overlap the reference boxes at the declared tolerance.
- Pixels outside approved text masks are unchanged.
- PDF/A validation passes when PDF/A is requested.
- The output contains no duplicate visible glyph layer.

#### Runtime and operations

Record:

- Cold start time.
- Warm page latency p50 and p95.
- Full-document throughput.
- Peak resident memory.
- Peak GPU or accelerator memory when applicable.
- Model download size and cache size.
- Output size.
- Failure and partial-page rate.
- Network requests attempted during offline mode.
- Number of pages processed before cancellation.

### Proposed acceptance gates

These are proposed product gates, not measured results.

They should be calibrated after the first baseline run, but they should not be weakened after seeing a bad result.

#### Gate A: source fidelity

The parser must not alter the source PDF or the authoritative PDF.js/PDFium raster.

Native text pages must not regress in page count, geometry, search, or copy behavior.

Any changed pixels must be inside an explicitly recorded text or overlay mask.

#### Gate B: OCR quality

The selected candidate must reduce scan-slice CER by at least 10% relative to the current engine baseline, or provide a statistically clear structure gain without increasing CER by more than 2 percentage points in any required language slice.

No language marked as supported may have an unreported catastrophic page failure.

#### Gate C: reading order

Two-column and mixed-layout pages must reach at least 95% adjacent-pair accuracy and less than 2% cross-column inversions on the acceptance set.

A single catastrophic inversion that changes a paragraph's meaning is a review failure even if the aggregate score passes.

#### Gate D: table structure

The initial release target is at least 0.90 structure score on wired tables and at least 0.80 on borderless or merged-cell tables.

Cell-text CER must be reported separately from grid structure.

A table result with missing cells must remain a warning and must not be exported as a clean table without provenance.

#### Gate E: formula preservation

Clean printed formulas should reach at least 0.85 exact normalized-LaTeX accuracy on the formula slice.

Image-only, handwritten, or ambiguous formulas may be marked unsupported, but the output must preserve the original formula region and record the reason.

#### Gate F: searchable export

Every searchable-PDF candidate must pass PDF.js and PDFium open/search/copy checks.

The text layer must align with the page image and pass PDF/A validation when requested.

The original raster must remain unchanged outside the approved OCR text-layer mask.

#### Gate G: offline and privacy

With networking disabled, the worker must finish using only preseeded artifacts.

A missing artifact must fail explicitly without a cloud fallback.

No source bytes, extracted text, paths, or credentials may leave the process through telemetry or logging.

#### Gate H: runtime budget

On the declared reference Windows machine, warm selected-page parsing should target p95 below 5 seconds for the CPU baseline.

Batch parsing should target p95 below 15 seconds per page on CPU, with GPU results reported separately rather than mixed into the CPU claim.

Peak memory must stay below the machine's declared admission limit with at least 20% headroom.

These are operational budgets, not permission to lower quality or hide out-of-memory failures.

### Benchmark artifacts

Each run should write a machine-readable manifest containing:

- Corpus revision and document SHA-256.
- Engine repository URL and commit SHA.
- Package and runtime versions.
- Model URLs, revisions, licenses, and file hashes.
- Preprocessing configuration.
- Device and operating-system details.
- Network isolation status.
- Raw engine output.
- Normalized Document IR output.
- Metrics JSON.
- Per-page failure report.
- Searchable-PDF validation report when applicable.

The final report should include a comparison table and a failure gallery.

Do not report only a single aggregate score.

### Stop conditions

Stop the integration experiment if a candidate requires an unreviewed restrictive model license.

Stop if offline mode still attempts network access after artifact prefetching.

Stop if the adapter cannot map coordinates into the current IR without a page-specific transform that can be tested.

Stop if a candidate silently drops formulas, tables, or pages while returning success.

Stop if packaging requires bundling an unbounded interpreter or model cache before the quality case is established.

## Implementation sequence after this research

This report does not authorize production implementation.

The next implementation allocation should be a disposable benchmark harness, not a product dependency.

The harness should:

1. Stage one PDF and its rendered pages.
2. Run one selected engine with a pinned manifest.
3. Normalize the result into a temporary Document IR.
4. Emit raw output, IR, metrics, provenance, and failure artifacts.
5. Run offline and missing-artifact tests.
6. Compare against the current PDF.js/PDFium/Tesseract baselines.

Only after the harness passes the acceptance gates should a production adapter be proposed.

The first production candidate should preserve the current renderer and call the worker only for pages classified as scanned, hybrid, broken-text, table-heavy, formula-heavy, or explicitly requested by the user.

## Open questions

- Which Docling model families can be redistributed in the intended desktop package after exact model-card review?
- Which PaddleOCR PP-StructureV3 models have compatible weight terms for commercial offline redistribution?
- Can a stable Windows sidecar package be built without requiring a developer-installed Python environment?
- Which engine produces the best Vietnamese diacritic accuracy on the project's real scan corpus?
- Can formula output be normalized into the current formula protection contract without losing source geometry?
- Does the current PDF writer need OCRmyPDF for PDF/A, or is the existing `src/export/searchable.ts` sufficient for product requirements?
- What is the acceptable cold-start budget for a first selected-page parse on the reference machine?
- Which model artifact store and update process can provide deterministic SHA-256 verification without network access at runtime?

## Conclusion

The four repositories are not interchangeable.

Docling and MinerU are structured document parsers.

PaddleOCR is a modular OCR and document-parsing stack with strong table and formula components.

OCRmyPDF is a mature searchable-PDF and PDF/A pipeline.

The current PDF.js/PDFium architecture should keep rendering and native text ownership, then add one explicit semantic sidecar boundary.

Docling is the best first adapter spike from a code-license and IR-mapping perspective.

PaddleOCR is the most important quality comparator for structured OCR, tables, and formulas.

OCRmyPDF should own searchable-PDF export if the benchmark and packaging review accept its external runtime.

MinerU should remain optional until its additional license terms and model provenance are accepted.

No production integration is justified from repository inspection alone.

The benchmark and acceptance gates above are the evidence required before that decision.
