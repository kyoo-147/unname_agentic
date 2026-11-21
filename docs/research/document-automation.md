# Document automation research

**Status:** research-only. No production code was changed.

**Question:** what should a smallest trustworthy document-automation flow look like for this repository, and which parts of Paperless-ngx and related projects are worth adopting as interfaces or operational patterns?

## Executive conclusion

The repository already has most of the deterministic core for a useful vertical slice: PDF page classification, OCR routing, a canonical document IR, schema-based field extraction and validation, a bounded batch queue, folder-watch planning, human review decisions, a local library, privacy policy checks, append-only audit records, and export checks.

The missing piece is not another broad feature set. It is one connected, evidence-preserving pipeline:

```text
stable folder input
  -> immutable source copy + SHA-256
  -> page classification
  -> native text or OCR
  -> canonical DocumentIR
  -> schema extraction + validation
  -> confidence/invalid review queue
  -> explicit review decision
  -> JSON/Markdown export with source and provenance
```

The best division of responsibility is:

- **Paperless-ngx:** operational reference for consumption, asynchronous work, metadata matching, workflows, versions, API task status, export, and privacy warnings.
- **Docling:** reference or optional adapter for layout-aware conversion, typed schema extraction, provenance, and confidence reporting. It is the closest external match to structured extraction, but it is much heavier than the current browser-first TypeScript core.
- **OCRmyPDF:** focused OCR/PDF-A subprocess boundary. Use it for archival PDF OCR when a native executable is available, not as the schema or review system.
- **Apache Tika:** broad file-type detection and text/metadata extraction, especially when process isolation and a server/CLI boundary are required. It is not a replacement for page geometry or field review.
- **Mayan EDMS:** reference for document versions, workflow states, retention, permissions, and REST integration. It is an EDMS platform rather than a small embedded dependency.

Do not copy implementation code from GPL-licensed Paperless-ngx or Mayan EDMS into this MIT-licensed application. Prefer independently implemented contracts, subprocess/API adapters, and clear attribution in dependency notices if an external component is actually bundled.

## 1. Repository baseline

### Already implemented

| Requirement | Current repository evidence | Research assessment |
| --- | --- | --- |
| Import/source identity | `src/core/ir.ts` carries `sourceSha256`, `documentId`, and `revisionId`. | Strong foundation for immutable source and revision records. |
| Digital/scanned/hybrid routing | `src/core/classify.ts` classifies each page and recommends `native`, `ocr`, or `mixed`. | Correct place to avoid OCR on trustworthy digital text. |
| OCR pipeline | `src/ocr/` contains scan, preprocessing, geometry, metrics, and pipeline modules. | Existing OCR path should remain the app-native path for the first slice. |
| Canonical extracted representation | `src/core/ir.ts` provides pages, blocks, reading order, provenance, translations, annotations, and exports. | Use this as the stable boundary between OCR/parsing and automation. |
| Schema extraction | `src/core/schema.ts` accepts typed fields, normalises values, reports source location, confidence, missing fields, and validation problems. | Satisfies the smallest deterministic extraction contract without a model. |
| Batch execution | `src/core/queue.ts` bounds concurrency and has pause, resume, cancellation, retry, failure, and progress semantics. | Suitable for a first batch runner once it is connected to real work. |
| Folder watching | `src/core/watcher.ts` defines include/ignore rules, snapshots, change detection, coalescing, stability-relevant signals, and truncation rules. | The policy is reusable; the filesystem loop still belongs to an integration layer. |
| Human review | `src/core/review.ts` enqueues low-confidence/invalid fields and records one immutable decision per field. | Good basis for confidence-gated review rather than silent correction. |
| Local storage | `src/core/library-store.ts` stores original bytes, metadata summaries, and thumbnails in IndexedDB. | Local-first storage exists, but it is not yet a versioned automation repository. |
| Privacy boundary | `src/core/privacy.ts` distinguishes offline, local-network, and cloud endpoints and requires stored cloud consent. | Reuse for every optional remote extraction/translation path. |
| Audit trail | `src/core/audit.ts` validates bounded details, rejects secret-looking values, and hash-chains local events. | Record pipeline transitions without copying document text into audit details. |
| CLI planning | `docs/cli.md` and `scripts/mirror-cli.mjs` plan folder commands and make non-`check` execution explicitly exit 7 because work is not wired into Node. | This is an honest boundary, not a completed automation runner. |

### Current gap

The CLI can inspect a folder and print a plan, but `extract`, `translate`, and `export` do not execute their work from Node. The first implementation should therefore be a deliberately small integration seam that calls existing core functions, not a new general-purpose document platform.

## 2. Reference comparison by pipeline stage

| Stage | Paperless-ngx | Docling | OCRmyPDF | Mayan EDMS | Apache Tika | Fit for this repo |
| --- | --- | --- | --- | --- | --- | --- |
| Import | Consume directory, API, web UI, mail fetch | Local paths and supported input formats | Input PDF path/stream | Browser, server-side files, scanners, watched folders, cloud/email sources | File/URL/stdin, CLI/server/gRPC | Adopt a stable local input contract and source hash. |
| Classify | Automatic matching for tags, correspondents, document types, storage | Layout/document conversion | Detect existing text and choose OCR mode | Document type and source drive processing | Byte-level media detection and parser selection | Keep current page classifier; use Tika only for broader format detection. |
| OCR | OCRmyPDF-backed processing and optional remote OCR | Multiple OCR engines and pipeline options | Focused OCR text layer/PDF-A output | Tesseract by default, pluggable OCR backends | OCR/parser integration, with 4.x process isolation | Keep native OCR for the slice; make OCRmyPDF an optional adapter. |
| Extract | Text/index metadata; custom fields are storage-oriented | Typed Pydantic/dictionary schemas and page-organised extraction | Sidecar text, not business schema extraction | Metadata, indexes, workflows | Text/metadata, not geometry-first field extraction | Current `schema.ts` is the simplest trustworthy extractor. |
| Validate | Custom field data types and task errors | Confidence reports and structured output validation | PDF/A validation and exit codes | Metadata/workflow constraints | Parser limits and partial results | Combine current field validation with explicit artifact QA. |
| Review | UI, audit log, task failures, manual workflows | Confidence grades suggest manual review | Logs/exit statuses, no human queue | Workflow states, comments, permissions, escalation | Errors/partial output, no business review queue | Current `review.ts` fills the missing narrow field-review seam. |
| Export | Original/archive files, metadata, thumbnails, database export | JSON/Markdown/DoclingDocument and extraction outputs | PDF/A/PDF plus sidecar | Version/file export and downloads | Text/metadata/embedded content | Export source, IR, decisions, provenance, and QA status together. |

## 3. Paperless-ngx findings

### 3.1 Import and folder watching

Paperless treats its consumption directory as a temporary inbox. The consumer detects files, the task processor performs consumption, and the consumed file is recreated inside managed storage and removed from the inbox. Its configuration supports native filesystem notifications or polling for filesystems where notifications are unreliable, plus a stability delay requiring unchanged size and modification time before consumption.

This is a useful operational rule for this repository: a watcher must not process a file while a scanner, browser download, or network share is still writing it. The current watcher module already models changed size/mtime, temporary and lock-file exclusions, coalescing, and the warning that a truncated enumeration must not be compared with a full snapshot. The missing runtime adapter should add an explicit stability check before enqueueing work.

Relevant references:

- [Paperless basic usage](https://docs.paperless-ngx.com/usage/)
- [Paperless configuration](https://docs.paperless-ngx.com/configuration/)
- [Paperless setup and services](https://docs.paperless-ngx.com/setup/)

### 3.2 Import, OCR, and preservation

Paperless describes a pipeline that OCRs documents without usable text, creates an archive PDF/A when configured, performs automatic metadata matching, and stores both the original and archive representation. It explicitly states that original documents are not overwritten. Its version model keeps root metadata shared while file, checksum, archive, and extracted-text data belong to a specific version.

The direct design lesson is to make source bytes first-class evidence:

```text
SourceAsset
  id
  originalFilename
  mime
  byteLength
  sourceSha256
  importedAt
  storageLocator

Revision
  id
  sourceAssetId
  parentRevisionId?
  transform
  tool
  toolVersion
  settingsDigest
  outputSha256
  createdAt
```

A generated searchable PDF, OCR text layer, translated block, or exported file must be a new artifact or revision. It must never replace the source record in place.

Reference: [Paperless FAQ on originals, checksums, and export](https://docs.paperless-ngx.com/faq/), [Paperless document versions and API](https://docs.paperless-ngx.com/api/).

### 3.3 Classification, custom fields, workflows, and review

Paperless has two different mechanisms that should not be conflated:

1. A local automatic matcher assigns tags, correspondents, document types, and storage paths.
2. Workflows run ordered trigger/action sequences, including assignment/removal of metadata, webhooks, email, and manual/scheduled execution.

Custom fields are typed document metadata. They are useful as a destination contract, but Paperless does not make them a page-geometry-aware extraction result with field-level evidence. This repository's `schema.ts` is more appropriate for that boundary because each extracted value retains `page`, `blockId`, `rect`, `raw`, normalised `value`, confidence, and problem codes. The review queue can then accept, edit, or reject one field without erasing the extracted evidence.

Paperless' classifier threshold is a useful configuration precedent: automatic assignment should require a configurable minimum confidence and should leave low-confidence cases for a person or later workflow. The current `ReviewQueue.fromExtraction` follows the same shape, with strict threshold semantics and separate invalid-value reasons.

Reference: [Paperless workflows and custom fields](https://docs.paperless-ngx.com/usage/), [Paperless classifier configuration](https://docs.paperless-ngx.com/configuration/).

### 3.4 API, asynchronous tasks, and export

The Paperless API demonstrates an important asynchronous contract: an upload or bulk action can return a task UUID before document processing is complete; callers query the task endpoint for state and the resulting document id. A batch endpoint's completion means work was scheduled, not necessarily that every downstream file operation has finished.

The first local API should follow the same distinction:

```json
{
  "jobId": "job-...",
  "documentId": "doc-...",
  "state": "queued | running | review | done | failed | cancelled",
  "progress": { "jobs": 1, "done": 0, "failed": 0, "cancelled": 0, "pending": 1 },
  "artifacts": [],
  "errors": []
}
```

Do not report `done` merely because an input was discovered or an extraction task was scheduled. The current queue's `done` state is correctly a quiescence state; failures remain visible in totals and `failures()`.

Paperless' exporter is also a good backup model: export originals, archive files, thumbnails, metadata, and a manifest, with incremental behaviour and explicit options for excluding archive or thumbnail derivatives. It warns that its full database export is version-sensitive. The local report/export format should therefore be versioned and should not claim cross-version import compatibility without a migration contract.

References: [Paperless REST API](https://docs.paperless-ngx.com/api/), [Paperless administration and exporter](https://docs.paperless-ngx.com/administration/).

### 3.5 Privacy boundary

Paperless' optional AI and remote OCR documentation is explicit that document content can leave the installation when a remote provider is selected. It supports local backends such as Ollama and can restrict remote OCR to documents selected by workflow. This is the right product shape: local processing is the default for sensitive documents, and remote processing is a named, inspectable, per-workflow opt-in.

The repository already has a stricter privacy policy in `src/core/privacy.ts`. Any future Docling remote service, OpenAI-compatible endpoint, or cloud OCR adapter must pass through that policy. A provider choice alone must not authorise a request; the effective endpoint must be re-derived and cloud consent must be checked immediately before sending.

Reference: [Paperless AI and remote OCR configuration](https://docs.paperless-ngx.com/configuration/), [Paperless advanced usage and privacy](https://docs.paperless-ngx.com/advanced_usage/).

## 4. Docling findings

Docling is the strongest reference for layout-aware conversion and typed extraction, not for document storage or human workflow.

### 4.1 Conversion and schema extraction

The official extraction example accepts either a dictionary template or a Pydantic model and returns standardised extracted data organised by page. The documented extraction API is aimed at PDF/image inputs for that path. Docling's broader `DocumentConverter` supports more formats and produces a structured document representation.

The current repository should borrow the contract, not the runtime dependency for the smallest slice:

- schema is explicit and versioned;
- output is typed and machine-readable;
- page association is retained;
- raw text is preserved beside normalised values;
- extraction failures are visible rather than converted to guessed values.

Current `defineSchema`, `extractFields`, and `validateValue` already implement these properties for label/value fields without an LLM. Docling becomes useful when the input requires layout reconstruction, tables, figures, or more complex document structure than the current block stream provides.

References: [Docling information extraction](https://docling-project.github.io/docling/_generated/examples/extraction/), [Docling document model](https://docling-project.github.io/docling/reference/docling_document/).

### 4.2 Confidence and review routing

Docling documents page- and document-level confidence reports with component scores for layout, OCR, parse, and table extraction. Its guidance says to use aggregate quality grades for review routing and numerical scores as informational values whose computation may change. It explicitly identifies manual review and unattended-batch thresholds as use cases.

This supports a two-level policy for this repository:

- **hard validation:** schema/type/date/number/enum errors always require review;
- **soft confidence:** values below a configured threshold require review, while ambiguity is a review note unless it also causes a validation failure.

The current code has this distinction already. It should not import an external confidence score and treat it as a truth value. Store the producer, model/engine, settings, and score semantics in provenance.

Reference: [Docling confidence scores](https://docling-project.github.io/docling/concepts/confidence_scores/).

### 4.3 Local/offline operation and dependency cost

Docling supports pre-downloaded model artifacts and an `artifacts_path`, and its pipeline options document disabling automatic downloads for offline environments. Optional extras add OCR, VLM, HTML rendering, and other capabilities. This is good evidence for an explicit offline packaging mode, but it also shows why Docling should not be silently added to the current browser bundle: model artifacts and optional Python dependencies materially change distribution, startup, memory, and license-review requirements.

References: [Docling installation and extras](https://docling-project.github.io/docling/getting_started/installation/), [Docling pipeline options](https://docling-project.github.io/docling/reference/pipeline_options/).

## 5. OCRmyPDF findings

OCRmyPDF is a focused PDF transformation tool. It is useful behind a process boundary when the required result is a searchable/archive PDF, not when the required result is a business field with evidence.

Important behaviours:

- `--mode skip` preserves pages with an existing text layer and is useful for mixed born-digital/scanned files.
- `--mode redo` removes the old invisible OCR layer and recognises again.
- `--mode force` rasterises all content and rebuilds the text layer, which can discard structural markup.
- PDF/A can be best-effort (`auto`) or required (`pdfa`), and explicit PDF/A conversion can fail rather than silently produce invalid output.
- `--sidecar` provides OCR text separately, but skipped/error pages may not appear in the sidecar.
- The watcher example uses separate input, output, and archive directories to avoid reprocessing generated files.

This maps cleanly to an adapter contract:

```text
ocr(sourcePath, outputPath, settings)
  -> outputPath
  -> sidecarPath?
  -> exitCode
  -> stdout/stderr summary
  -> outputSha256
  -> tool/version/settings provenance
```

The adapter must preserve the original source, record the exact mode and output type, and treat missing sidecar pages as a warning or failure according to an explicit policy. It must never infer complete OCR merely because the subprocess returned zero.

References: [OCRmyPDF processing modes](https://ocrmypdf.readthedocs.io/en/latest/advanced.html), [OCRmyPDF PDF/A output](https://ocrmypdf.readthedocs.io/en/stable/advanced.html), [OCRmyPDF batch and watcher](https://ocrmypdf.readthedocs.io/en/latest/batch.html), [OCRmyPDF API](https://ocrmypdf.readthedocs.io/en/stable/api.html).

## 6. Mayan EDMS findings

Mayan EDMS is the broadest workflow/EDMS reference in this review. Its official feature documentation covers:

- multiple document versions with download and rollback;
- non-destructive page remapping and disabling;
- original uploaded files never being altered;
- watched folders, cloud storage, and email sources;
- background OCR, text extraction, previews, and metadata extraction;
- workflow states, escalation, retention, event tracking, and comments;
- a versioned REST API and batch requests.

The relevant design lesson is that review is a workflow state with an audit trail, not a boolean attached to an extracted value. The current field-level review queue can be the first stateful slice; document-level states such as `needs_review`, `approved`, and `exported` should be added only when the pipeline has a durable job/document store.

Mayan is GPL-2.0-only in the pinned current source, and its trademark policy is separate. It should be treated as an external product/reference, not copied into this codebase.

References: [Mayan features](https://docs.mayan-edms.com/chapters/features.html), [Mayan first steps](https://docs.mayan-edms.com/chapters/getting_started.html), [Mayan FAQ and license](https://docs.mayan-edms.com/chapters/faq.html), [Mayan installation](https://docs.mayan-edms.com/chapters/installation.html).

## 7. Apache Tika findings

Tika is a general content-analysis toolkit. It detects file types from bytes and extracts text and metadata from a wide range of formats. The official docs expose four integration modes: Java API, CLI, REST server, and gRPC. Tika Pipes adds process-isolated, fault-tolerant bulk processing.

Useful boundaries for this repository:

- use Tika's detection/parsing adapter only when format coverage is broader than the current PDF reader;
- use its CLI or server as an explicit subprocess/service boundary rather than embedding untrusted parsing into the UI process;
- configure parser, detector, metadata filters, request size, time, memory, and embedded-document limits;
- do not expose a Tika server or gRPC endpoint to an untrusted network without authentication and network controls;
- do not treat Tika's plain text or Markdown as a replacement for page geometry, OCR confidence, or field provenance.

Tika 4.x requires Java 17 or later and has a breaking migration from 3.x. The official docs warn that the CLI is still in flux in 4.x and that the authoritative option list is the installed binary's `--help` output. For this repository, Tika is therefore a later optional worker, not a first-slice browser dependency.

References: [Tika overview](https://tika.apache.org/docs/), [Tika integration choices](https://tika.apache.org/docs/4.2.x/using-tika/index.html), [Tika CLI](https://tika.apache.org/docs/4.2.x/using-tika/cli/index.html), [Tika server and isolation](https://tika.apache.org/docs/4.0.x/using-tika/server/index.html), [Tika security](https://tika.apache.org/docs/4.2.x/security.html).

## 8. Smallest real vertical slice

### Input contract

Start with a flat or recursively watched local directory containing PDFs. A file is eligible only when:

1. its name matches the include policy;
2. it is not a temporary, lock, hidden, or ignored path;
3. size and mtime have remained stable for the configured delay;
4. the source bytes can be read and hashed;
5. the source hash is not already represented by the same source/revision policy.

The source is copied or moved into managed local storage before destructive cleanup of the inbox. The original filename and source path are metadata, not identity. Identity is the content hash plus the application document/revision ids.

### Processing contract

1. **Import:** create `import` audit event and immutable `SourceAsset` metadata.
2. **Classify:** run `classifyDocument`; retain page-level reason codes and statistics.
3. **Read/OCR:** use native PDF text for digital pages, OCR only scanned/hybrid pages, and retain engine/settings provenance.
4. **Build IR:** call `buildDocument`; set `sourceSha256`, revision, pages, blocks, and provenance.
5. **Extract:** load a user schema and run deterministic `extractFields`.
6. **Validate:** preserve `raw`, normalised `value`, location, confidence, and problem codes.
7. **Review:** enqueue invalid or below-threshold fields. Do not auto-edit. A rejection keeps the source evidence and marks the field missing in the applied result.
8. **Export:** write a versioned JSON result and a human-readable Markdown report. Include source hash, IR revision, extracted fields, review decisions, QA state, and artifact hashes.
9. **Audit:** append `extract`, `review`, and `export` events with bounded facts only. Never put OCR text, API keys, email addresses, phone numbers, or document content into audit details.

### Example output set

```text
managed/
  documents/doc-<hash16>/
    source/original.pdf
    revisions/rev-1/document-ir.json
    revisions/rev-1/fields.json
    revisions/rev-1/review-decisions.json
    exports/rev-1/report.md
    exports/rev-1/result.json
    audit.json
```

This is intentionally smaller than a full DMS. It proves the important claim: a local document can move from source bytes to typed, reviewable, reproducible output without losing provenance or pretending that scheduled work is completed work.

## 9. Privacy and security boundaries

The first slice should be local-only and should not require a provider key, remote API, model download, or network service. Optional remote processing must be a separate adapter with:

- an explicit provider and effective endpoint;
- an offline/local-network/cloud policy check immediately before send;
- a user-visible consent record for cloud processing;
- a request log containing endpoint and byte counts, but not content or secrets;
- a timeout, size limit, retry policy, and cancellation path;
- an output hash and provenance row;
- a failure state that is not converted into a low-confidence success.

Untrusted files should be processed out of the UI process where the chosen parser supports it. Tika's forked Pipes model and OCRmyPDF's subprocess model are useful references. For browser-only parsing, keep the existing input limits and avoid claiming parser isolation that does not exist.

Immutable source/versioning is a privacy feature as well as an audit feature: it lets the user delete derived artifacts or remote-result caches without destroying the original local record, and it makes it possible to show exactly which bytes were sent if a remote path is ever enabled.

## 10. Licensing and dependency decision

| Project | Pinned source ref | License | Relevant dependency/runtime notes | Decision |
| --- | --- | --- | --- | --- |
| Paperless-ngx | `4973be8499bc61dc4f791a609d0d31e9ac9ccd41` on `dev` | GPL-3.0-only | Python >=3.11; Django, Celery/Redis-compatible broker, OCRmyPDF, Tesseract/system PDF tools, optional databases and AI backends. | Reference architecture and API behaviour only. Do not copy implementation. |
| Docling | `5182e556308958f3ac4762bb7d03a092c2f339c9` on `main` | MIT | Python package; optional OCR/VLM/HTML extras; model artifacts can be downloaded or pre-staged for offline use. | Consider an isolated Python worker later for layout/table extraction. Keep out of first browser slice. |
| OCRmyPDF | `86a5e723ea2b612e8df4a647056b0ebf3b3c97a5` on `main` | MPL-2.0 | Python >=3.11; pikepdf, PDF/image libraries, Tesseract/Ghostscript and related system tools depending on mode. | Optional local subprocess adapter for searchable/PDF-A output. |
| Mayan EDMS | `834ffec1b539171390358e60a0406870108514f5` on `master` | GPL-2.0-only | Python/Django, Celery, storage/database/search/OCR integrations; official Docker Compose is the supported starting point. | Product/reference comparison only. Do not embed. |
| Apache Tika | `f1f785f533877ce7426f45b1460ed52e154bcaca` on `main` | Apache-2.0 | Tika 4.x requires Java 17+; CLI distribution needs adjacent `lib/` and `plugins/`; server/gRPC/Pipes have separate security and isolation considerations. | Optional broad-format worker, likely later than PDF-only slice. |

The repository itself is private and currently uses TypeScript with `pdfjs-dist`, `pdf-lib`, `tesseract.js`, Vite, Vitest, and Playwright. Adding Python/Java runtimes is an operational product decision, not a small package addition. The smallest implementation should therefore use the existing TypeScript core and make external engines optional, explicit adapters.

Do not reuse AGPL or GPL implementation code from unrelated document/translation projects. Reimplement the required contracts or invoke the project as a separate process under its own license obligations.

## 11. Test and verification plan

### Existing tests that already cover the core contract

- `tests/schema.test.ts`: schema shape errors, duplicate ids/labels, enum/pattern validation, typed normalisation, source location, missing fields, ambiguity, and invalid values.
- `tests/queue.test.ts`: concurrency limit, launch order, pause/resume, cancellation, failure accounting, retry, progress, and the totals invariant.
- `tests/watcher.test.ts`: defaults, path matching, temporary/lock exclusions, custom include/ignore rules, snapshots, modification/touch signals, and coalescing.
- `tests/classify.test.ts`: page kinds, threshold boundaries, reasons, document summaries, and mixed OCR recommendations.
- `tests/review.test.ts`: threshold routing, invalid-value routing, ambiguity handling, accept/edit/reject, one-decision locking, stable export, parsing, and application back to extracted fields.
- `tests/ir.test.ts`: deterministic IDs/order, source hash, provenance, validation, canonical JSON, revisions/transforms, and export records.
- `tests/audit.test.ts`: append-only copies, typed rejection, secret detection, hash-chain persistence/restoration, and Markdown reporting.
- `tests/library-store.test.ts`: IndexedDB open/list/get/put/remove/clear, thumbnail storage, transaction failure, quota mapping, and source-record copying.
- `tests/ocr-*.test.ts` and `tests/e2e/scan-ocr.spec.ts`: OCR scan/preprocess/geometry/metrics and browser-level OCR flow.
- `tests/e2e/export-library.spec.ts`, `tests/pdf-export.test.ts`, and `tests/export-check.test.ts`: export behaviour and artifact checks.
- `tests/cli-args.test.ts`: CLI table consistency, parser semantics, plans, and runner exit codes.

### New integration tests required before calling the slice complete

1. A fixture PDF enters a temporary inbox, remains untouched until stable, and produces one source hash.
2. Re-polling the unchanged file is idempotent and does not create a second source revision.
3. A mixed digital/scanned fixture OCRs only the pages classified as scanned or hybrid.
4. The resulting IR contains the source hash, deterministic block ids, page locations, and OCR provenance.
5. A schema extraction with one valid, one invalid, one missing, and one low-confidence field produces the expected review queue.
6. A review edit records the original and decided value, and a second decision is refused.
7. A rejected field remains present with source location and `missing: true`; it is not silently dropped.
8. JSON and Markdown exports include source/revision ids, hashes, provenance, decisions, and QA state.
9. A failing OCR/extraction/export step leaves the source and prior successful revision intact and marks the job failed.
10. Offline mode makes no non-loopback request. A cloud endpoint without stored consent fails before request construction.
11. Audit persistence rejects document content and secret-like details while retaining bounded event facts.
12. A cancelled batch never launches another job after cancellation and never counts a late abort rejection as a failure.

Verification should use the repository's real commands once the integration exists:

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e
```

The current research pass did not run a new product implementation, so these are verification requirements, not claims that the complete vertical slice already passes.

## 12. Source ledger

The following refs were resolved while preparing this report. The SHA is included so source claims can be revisited without silently following a moving branch.

### Paperless-ngx

- Repository at pinned commit: https://github.com/paperless-ngx/paperless-ngx/tree/4973be8499bc61dc4f791a609d0d31e9ac9ccd41
- License at pinned commit: https://github.com/paperless-ngx/paperless-ngx/blob/4973be8499bc61dc4f791a609d0d31e9ac9ccd41/LICENSE
- Dependencies at pinned commit: https://github.com/paperless-ngx/paperless-ngx/blob/4973be8499bc61dc4f791a609d0d31e9ac9ccd41/pyproject.toml
- Official docs: https://docs.paperless-ngx.com/usage/, https://docs.paperless-ngx.com/api/, https://docs.paperless-ngx.com/configuration/, https://docs.paperless-ngx.com/administration/, https://docs.paperless-ngx.com/advanced_usage/

### Docling

- Repository at pinned commit: https://github.com/docling-project/docling/tree/5182e556308958f3ac4762bb7d03a092c2f339c9
- License at pinned commit: https://github.com/docling-project/docling/blob/5182e556308958f3ac4762bb7d03a092c2f339c9/LICENSE
- Package metadata at pinned commit: https://github.com/docling-project/docling/blob/5182e556308958f3ac4762bb7d03a092c2f339c9/pyproject.toml
- Official docs: https://docling-project.github.io/docling/_generated/examples/extraction/, https://docling-project.github.io/docling/concepts/confidence_scores/, https://docling-project.github.io/docling/reference/docling_document/, https://docling-project.github.io/docling/reference/pipeline_options/, https://docling-project.github.io/docling/getting_started/installation/

### OCRmyPDF

- Repository at pinned commit: https://github.com/ocrmypdf/OCRmyPDF/tree/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5
- License at pinned commit: https://github.com/ocrmypdf/OCRmyPDF/blob/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5/LICENSE
- Package metadata at pinned commit: https://github.com/ocrmypdf/OCRmyPDF/blob/86a5e723ea2b612e8df4a647056b0ebf3b3c97a5/pyproject.toml
- Official docs: https://ocrmypdf.readthedocs.io/en/latest/advanced.html, https://ocrmypdf.readthedocs.io/en/stable/advanced.html, https://ocrmypdf.readthedocs.io/en/latest/batch.html, https://ocrmypdf.readthedocs.io/en/stable/api.html

### Mayan EDMS

- Repository at pinned commit: https://gitlab.com/mayan-edms/mayan-edms/-/tree/834ffec1b539171390358e60a0406870108514f5
- License at pinned commit: https://gitlab.com/mayan-edms/mayan-edms/-/blob/834ffec1b539171390358e60a0406870108514f5/LICENSE
- Dependencies at pinned commit: https://gitlab.com/mayan-edms/mayan-edms/-/blob/834ffec1b539171390358e60a0406870108514f5/setup.py
- Official docs: https://docs.mayan-edms.com/chapters/features.html, https://docs.mayan-edms.com/chapters/getting_started.html, https://docs.mayan-edms.com/chapters/faq.html, https://docs.mayan-edms.com/chapters/installation.html

### Apache Tika

- Repository at pinned commit: https://github.com/apache/tika/tree/f1f785f533877ce7426f45b1460ed52e154bcaca
- License at pinned commit: https://github.com/apache/tika/blob/f1f785f533877ce7426f45b1460ed52e154bcaca/LICENSE.txt
- Build/dependency metadata at pinned commit: https://github.com/apache/tika/blob/f1f785f533877ce7426f45b1460ed52e154bcaca/pom.xml
- Official docs: https://tika.apache.org/docs/, https://tika.apache.org/docs/4.2.x/using-tika/index.html, https://tika.apache.org/docs/4.2.x/using-tika/cli/index.html, https://tika.apache.org/docs/4.0.x/using-tika/server/index.html, https://tika.apache.org/docs/4.2.x/security.html

## Bottom line

Implement the local PDF vertical slice around the repository's existing core contracts. Borrow Paperless' stability delay, asynchronous task distinction, original/version preservation, workflow opt-in, and export discipline. Borrow Docling's typed schema and confidence concepts only where the current IR cannot express the required layout. Keep OCRmyPDF and Tika behind explicit local process adapters. Treat Mayan as a workflow/versioning reference, not a library.

The success criterion is not "automated extraction always succeeds." It is: every result is attributable to source bytes and a revision, every uncertainty is visible, every human correction is recorded, and failures remain failures until the artifact and its verification actually pass.
