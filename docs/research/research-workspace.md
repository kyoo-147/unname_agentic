# Research workspace slice: metadata, anchored notes, bibliography, and evidence matrices

**Lane:** research-only design report
**Status:** proposal for a bounded implementation slice
**Production code:** not edited by this report
**Evidence rule:** facts below are labelled **Source-backed**; decisions are labelled **Recommendation** or **Open**.

## 1. Executive decision

### Source-backed

The repository already has the core primitives needed for a small, local-first research workspace:

- `src/core/ir.ts` provides a versioned `DocumentIR` with `sourceSha256`, 1-based pages, page dimensions, four-point polygons, deterministic block IDs, reading order, and provenance.
- `src/core/annotations.ts` provides page/block/rect anchors, quoted text snapshots, deterministic ordering, orphan preservation, re-anchoring, JSON import/export, and block backlinks.
- `src/core/scholar.ts` provides pure DOI/arXiv normalization, Crossref and Semantic Scholar request construction, strict payload parsers, field-level source provenance, record merging, and conversion to the repository's BibTeX entry type.
- `src/core/bibtex.ts` provides tolerant BibTeX parsing, stable citation keys, DOI/title-year deduplication with conflict preservation, and canonical BibTeX output.
- `src/core/evidence-matrix.ts` already keeps page, block ID, excerpt, raw matched text, and normalized comparison value in every evidence cell. Gaps are explicit and are not treated as agreement.

GROBID is a suitable extraction boundary because its official service returns TEI XML, supports full-text extraction and optional coordinates, and documents PDF page dimensions for coordinate scaling. Semantic Scholar is suitable for identifier-keyed scholarly metadata and references, but its API key, rate-limit, and license constraints require an explicit opt-in network adapter. Crossref is suitable for DOI registration metadata and DOI content negotiation. Zotero is a useful interoperability boundary, especially for BibTeX/RIS and its localhost-only API, but it should not become the workspace's source of truth.

### Recommendation

Implement one bounded vertical slice in this order:

1. **Local PDF intake and deterministic identity**: hash the original bytes, create a `DocumentIR`, and record an immutable extraction receipt.
2. **GROBID TEI import**: self-hosted/local by default; parse header, body, references, and selected coordinate-bearing elements into the existing IR.
3. **Identifier and metadata resolution**: reuse the pure logic in `scholar.ts`; add an explicit network adapter with cache, provenance, and privacy controls.
4. **Anchored research notes**: extend the existing annotation record with paper/citation identity and source revision metadata, without replacing the current re-anchoring contract.
5. **BibTeX and RIS interchange**: keep an internal normalized record, preserve raw imported fields, and make lossy mappings visible.
6. **Citation-backed comparison matrices**: build on `AspectMatrix`; require at least one resolvable source anchor for every non-gap cell and preserve gaps/conflicts in exports.

The slice should not include cloud OCR, automatic paper downloading, full Zotero synchronization, automatic claim generation, or a new database schema before these contracts are tested.

## 2. Current repository boundary

| Existing module | Current contract relevant to this slice | Consequence |
|---|---|---|
| `src/core/ir.ts` | `sourceSha256` identifies original bytes; pages are 1-based; polygons use page points with top-left origin and y increasing down; block IDs are deterministic within a revision. | Store anchors in the same coordinate system. Never use viewport pixels as the canonical coordinate system. |
| `src/core/annotations.ts` | A reader annotation has `documentId`, `page`, optional `blockId`, optional `rect`, text, optional quote, timestamps, and `orphaned`; re-anchoring never deletes unresolved records. | Keep the current orphan/recovery behavior. Add provenance fields rather than inventing a second note store. |
| `src/core/scholar.ts` | DOI/arXiv parsing is pure; request builders do not perform I/O; parsers reject malformed payloads; merged fields retain source labels. | Put credentials, retry policy, cache, and network I/O outside this module. |
| `src/core/bibtex.ts` | BibTeX is parsed to `Entry`; unknown fields survive; stable keys and dedupe are deterministic; conflicting DOI keys are retained. | Do not silently overwrite citation keys during import. RIS should map into the same normalized boundary. |
| `src/core/evidence-matrix.ts` | Each `MatrixCell` has `page`, `blockId`, `excerpt`, `raw`, and normalized `value`; absent evidence is a `MatrixGap`. | Add citation identity and exact anchor geometry to cells, not free-text citations after rendering. |

### Existing limitation to preserve

`src/core/scholar.ts` currently models a metadata record, not a full source receipt. `source: 'crossref' | 'semanticscholar'` and `MergedRecord.sources` identify the provider but do not record request URL, retrieval time, response hash, API version, or the exact payload. The network adapter proposed below must add those fields at the boundary rather than weakening the pure parser.

## 3. Source-backed research ledger

### 3.1 Official services and standards

| Source | Exact URL or pinned source | Source-backed fact used here | Design implication |
|---|---|---|---|
| GROBID REST API | <https://grobid.readthedocs.io/en/latest/Grobid-service/> | `processFulltextDocument` accepts multipart PDF input and returns TEI XML. `teiCoordinates` selects coordinate-bearing structures. `includeRawCitations` preserves the original reference string. HTTP `503` means service capacity is exhausted; the documentation suggests waiting before retrying. | Keep TEI as the extraction receipt/source of truth. Bound concurrency and retry only `503` with backoff. |
| GROBID coordinates | <https://github.com/grobidOrg/grobid/blob/c11e7c4a8767092dc51f516a46dcf678218904d3/doc/Coordinates-in-PDF.md> | Coordinates are emitted for supported TEI elements through `@coords`; each box carries page and rectangle values. `<facsimile>` reports page dimensions. Client/browser coordinates must be scaled against those dimensions. | Convert GROBID boxes to IR polygons only after matching page dimensions. Store the original coordinate string in the extraction receipt for audit. |
| GROBID license | <https://github.com/grobidOrg/grobid/blob/c11e7c4a8767092dc51f516a46dcf678218904d3/LICENSE> | The pinned repository contains Apache License 2.0 text. | A local GROBID service is a compatible integration boundary; retain attribution/notice requirements if code or binaries are redistributed. |
| Semantic Scholar product/API | <https://webflow.semanticscholar.org/product/api> | Most endpoints are available without authentication but are shared/rate-limited. API keys enable authenticated access and higher limits; keys must remain private. The introductory API-key limit is documented as 1 request/second. | Use identifier-keyed, on-demand lookups with cache and a per-provider limiter. Never ship the key to a renderer or client bundle. |
| Semantic Scholar API reference | <https://api.semanticscholar.org/api-docs> | The Graph API supports `DOI:<doi>` and `ARXIV:<id>` paper IDs, explicit `fields`, nested reference fields, and bounded result sizes. API keys are sent in the `x-api-key` header. | Request only fields needed by the current parser. Treat `paperId` as provider identity, not the workspace's paper ID. |
| Semantic Scholar API license | <https://api.semanticscholar.org/license/> | Use is governed by AI2's API License Agreement. The page distinguishes the standard use grant from an expanded/commercial license path. | Add a product/legal gate before commercial or bulk use. Store provider terms and retrieval provenance with imported records. |
| Crossref content negotiation | <https://www.crossref.org/documentation/retrieve-metadata/content-negotiation/> | DOI content negotiation can retrieve citation formats from a DOI resolver using `Accept` headers. | Offer DOI-to-BibTeX/RIS as an explicit metadata action, not as an implicit PDF upload or background crawl. |
| Zotero standardized formats | <https://www.zotero.org/support/kb/importing_standardized_formats> | Zotero imports BibTeX, BibLaTeX, and RIS among other standardized formats. | BibTeX and RIS are interchange formats, not a promise of lossless Zotero-library transfer. |
| Zotero format behavior | <https://www.zotero.org/support/dev/data_formats> | Zotero supports BibTeX import/export and RIS import/export. RIS is simple but has divergent real-world variants; Zotero exports relatively strict RIS. | The RIS parser must accept common variants but emit one documented canonical form. Preserve unknown tags/raw input. |
| Zotero local API | <https://www.zotero.org/support/dev/web_api/v3/local_api> | Recent Zotero exposes a local API at `http://localhost:23119/api/`. Reads need no authentication; writes in Zotero 10+ require user-authorized local keys. The API must not be exposed externally. | Make Zotero integration local-only and opt-in. Default to read-only metadata/annotation import. Never forward port 23119 or proxy it through a remote service. |
| Zotero annotation storage | <https://www.zotero.org/support/kb/annotations_in_database> | Zotero stores its own annotations in its database and can export PDFs with embedded annotations. Imported embedded annotations are initially read-only until imported into Zotero. | Treat Zotero annotations as an external source that can be copied into workspace notes with source provenance; do not assume PDF-embedded annotations are the same as Zotero-native records. |
| Zotero docs repository | <https://github.com/zotero/zotero-docs/tree/a45968c20a4b0e83335d50cd612fcd86d046e205> | Documentation was inspected at the pinned repository revision. | Recheck docs and translator mappings before implementation because Zotero format mappings evolve. |

### 3.2 Pinned implementation references

These are behavioral references only. No code is copied by this research-only change. License statements below are from the pinned repository contents or README at the listed commit and still require a file-level review before reuse.

| Project | Exact pinned commit | Relevant behavior observed | License at pin / reuse boundary |
|---|---|---|---|
| PaperLab | <https://github.com/khannoussi-malek/PaperLab/commit/6dc7408fec03bc11db9af20f4aa24d5f42fa0850> | Local-first paper library; notes and highlights stay linked to page passages; metadata sources and cited answers are separated from user notes. | Apache-2.0 at the pinned root `LICENSE`. Behavioral reference only. |
| PDF Scholar | <https://github.com/emilmsh/pdf-scholar/commit/7a019577e7dfcd2a91079b428739b9639eb86d13> | Local/offline reader, PDF annotations, citation previews, and Zotero handoff. | MIT at the pinned root `LICENSE`. Do not assume bundled dependencies share the same license. |
| Paper viewer / annotation reference | <https://github.com/jaeyoon-kim-dev/pdf-viewer/commit/e2f0e8a34c9b81b8fda2c392a00be0c410ad5083> | PDF.js-style reader with page-linked annotations, citation previews, and JSON export concepts. | No root license file was found at this pin. Do not copy code or depend on it without explicit permission. |
| Omabib | <https://github.com/atomashevic/omabib/commit/f31e2f91059a1889cf9084a744fa97a28dbce0bb> | Local SQLite bibliography, BibTeX import/export, PDF reading, project notes, and explicit agent access. | AGPL-3.0-or-later at the pinned root `LICENSE`; not a safe code-reuse source for a differently licensed product without legal review. |
| PaperNook | <https://github.com/affromero/papernook/commit/03c0169d19b09d84d28db5d1e0f07d7eaffa26e8> | Filesystem-first paper library; PDF-native annotations; plain-file metadata/chat boundary; Zotero metadata-first integration. | MIT at the pinned root `LICENSE`; third-party dependencies remain separately licensed. |

## 4. Proposed bounded data model

The following is a design target, not a production schema change in this report.

### 4.1 Paper and source identity

```ts
interface ResearchPaper {
  paperId: string;                 // workspace-owned stable ID
  documentId?: string;             // local PDF/DocumentIR identity
  sourceSha256?: string;           // original PDF bytes, when present
  title: string;
  authors: string[];
  doi?: string;                    // normalized DOI, no resolver prefix
  arxiv?: string;                  // normalized arXiv ID, no version suffix
  venue?: string;
  year?: number;
  abstract?: string;
  citationKey?: string;
  metadataSources: MetadataReceipt[];
  rawImports: RawBibliographyImport[];
}

interface MetadataReceipt {
  provider: 'crossref' | 'semanticscholar' | 'grobid' | 'zotero' | 'doi-content-negotiation' | 'manual';
  requestUrl?: string;             // omit secrets and API-key query params
  providerId?: string;             // e.g. Semantic Scholar paperId
  retrievedAt: string;
  responseSha256?: string;
  fields: string[];
  termsUrl?: string;
}

interface RawBibliographyImport {
  format: 'bibtex' | 'biblatex' | 'ris' | 'csl-json' | 'zotero-json';
  importedAt: string;
  rawSha256: string;
  rawText?: string;                // local-only, bounded, optional
  unknownFields: Record<string, string[]>;
}
```

Rules:

- `paperId` is workspace-owned and must not be replaced by a DOI, arXiv ID, or Semantic Scholar `paperId`.
- DOI and arXiv IDs are deduplication candidates, not permission to merge records when citation keys or source evidence would be lost. Reuse the current `bibtex.ts` conflict behavior.
- `MetadataReceipt` records where a value came from. A later provider refresh may add a new receipt and a field-level disagreement rather than silently rewriting a user's correction.
- A manually edited value must be marked `manual` and must win display resolution until the user explicitly accepts a provider update.

### 4.2 Extraction receipt

```ts
interface ExtractionReceipt {
  paperId: string;
  sourceSha256: string;
  extractor: 'grobid' | 'native-pdf' | 'ocr' | 'manual';
  extractorVersion?: string;
  requestedParameters: Record<string, string | string[]>;
  receivedAt: string;
  teiSha256?: string;
  pageDimensions: Array<{ page: number; width: number; height: number }>;
  warnings: string[];
}
```

The receipt is necessary because a block ID is revision-local. It prevents a later reparse from being mistaken for the same extraction and makes a note's evidence auditable.

### 4.3 Citation and note anchors

```ts
interface SourceAnchor {
  paperId: string;
  documentId: string;
  sourceSha256: string;
  revisionId: string;
  page: number;                    // 1-based
  blockId?: string;
  polygon?: readonly [{x:number,y:number}, {x:number,y:number}, {x:number,y:number}, {x:number,y:number}];
  quote?: string;
  anchorKind: 'block' | 'selection' | 'reference' | 'metadata';
  confidence?: number;
}

interface ResearchNote {
  noteId: string;
  text: string;
  kind: 'note' | 'highlight' | 'bookmark' | 'question' | 'claim';
  anchors: SourceAnchor[];
  citationIds: string[];
  createdAt: string;
  updatedAt: string;
  orphaned: boolean;
}
```

- The existing annotation store remains the behavior owner for adding, validating, ordering, importing, and re-anchoring notes.
- `sourceSha256` and `revisionId` are required at the research-workspace boundary. Existing annotations without them can be imported as legacy records, but must display an explicit provenance warning.
- `polygon` is the canonical geometry. A rectangle may be retained as a convenience projection for the current reader, but it must not discard a multi-box selection or a GROBID citation spanning multiple lines.
- `quote` is evidence text, not a generated summary. It may be refreshed only after a successful re-anchor and must remain attached to its prior revision in the audit history.
- A citation link is a note-to-source relation, not a bare DOI string. A note can cite a metadata record, a PDF passage, or a reference entry, and the UI must distinguish those types.

## 5. End-to-end workflow

### Step A: ingest a local PDF

1. Read the bytes selected by the user.
2. Compute SHA-256 before parsing.
3. Create `paperId`, `documentId`, and an initial `DocumentIR` with page dimensions from the PDF reader.
4. Keep the original PDF immutable. Derived TEI, normalized metadata, and notes are sidecars/records tied to `sourceSha256`.
5. Do not send the PDF to a remote provider in the default path.

### Step B: extract structure with GROBID

Recommended request for the first implementation:

```text
POST /api/processFulltextDocument
multipart: input=<local PDF>
form: consolidateHeader=2
form: consolidateCitations=2
form: includeRawCitations=1
form: teiCoordinates=s
form: teiCoordinates=ref
form: teiCoordinates=biblStruct
form: teiCoordinates=figure
form: teiCoordinates=table
form: teiCoordinates=formula
```

Recommendation details:

- Keep `consolidateHeader=0` and `consolidateCitations=0` available for a fully local/no-network extraction mode. Consolidation must be an explicit policy switch because it can cause external metadata lookup by the GROBID deployment.
- Parse TEI before converting to the repository IR. TEI is richer than the client-side Markdown/JSON projections documented by GROBID.
- Use `<facsimile>` page dimensions to scale or validate coordinate boxes. A GROBID coordinate is not automatically a browser pixel coordinate.
- Map paragraphs, headings, captions, formulas, figures, tables, `ref`, and `biblStruct` into blocks where the requested element has sufficient text/geometry. Preserve the TEI element name in extraction provenance.
- If GROBID returns `204`, create a visible extraction failure/warning record, not an empty successful paper. If it returns `503`, retry with bounded backoff; the documented starting wait for full text is 5-10 seconds. Do not retry indefinitely.
- A GROBID result is extraction evidence, not a claim that the PDF was correctly understood. Keep confidence and warnings visible.

### Step C: resolve DOI and metadata

1. Search only for identifiers the local extraction or user input actually supplies: DOI first, then arXiv ID.
2. Reuse `buildLookup`, `normalizeDoi`, `arxivId`, `parseCrossref`, `parseSemanticScholar`, and `mergeRecords`.
3. The network adapter performs requests and passes parsed JSON to the pure functions.
4. Request only the current Semantic Scholar field set unless a feature explicitly needs more:

```text
title,authors,venue,year,abstract,citationCount,externalIds,references.title
```

5. Cache by provider plus canonical identifier plus requested fields. Cache entries must include retrieval time, response hash, and terms URL.
6. On a provider failure, retain the local record and mark the provider attempt as failed. Never replace a known field with `undefined` because a second provider did not return it.
7. Citation counts are time-varying metadata. Display them with retrieval time and provider, not as a timeless property of the paper.

### Step D: import/export through Zotero

Default behavior should be file-based and read-only:

- Import `.bib`, `.biblatex`, and `.ris` from a user-selected file.
- Export the selected paper set as BibTeX and RIS.
- Offer an optional Zotero local API connector only when the user enables it and Zotero is running on loopback.
- On connection, perform `GET http://localhost:23119/api/`, read `Zotero-API-Version`, and verify the `Zotero-Server-ID` header before other requests.
- Require a separate user confirmation before any write. This slice does not need writes.
- Never expose the local API through a server binding, browser remote origin, reverse proxy, or cloud worker.
- Import Zotero metadata and annotations as external-source records. Preserve Zotero item key, library scope, note/annotation type, page, quote, and any available position data.

## 6. Page and bounding-box-linked notes

### Canonical coordinate rules

- Page numbers are 1-based everywhere at the workspace boundary.
- Canonical coordinates are PDF/page points in the IR's top-left origin, y-down coordinate system.
- Every anchor stores the page dimensions or can resolve them from the referenced `DocumentIR` revision.
- Convert GROBID's page boxes to four-point polygons. For a single rectangle `(x, y, width, height)`:

```text
[(x,y), (x+width,y), (x+width,y+height), (x,y+height)]
```

- If a selected quote spans multiple GROBID boxes, store all boxes in order. Do not collapse them to one large rectangle if that would cover unrelated columns or paragraphs.
- A PDF viewer may scale/rotate the polygon for rendering. That view transform must not rewrite the stored anchor.

### Re-anchoring policy

The existing store's three-pass behavior is the right baseline:

1. old block ID plus matching quote;
2. best similar quote on the same page;
3. unique exact quote elsewhere after page insertion/reflow.

Add two research-specific checks:

- Reject automatic re-anchoring across a different `sourceSha256` unless the user explicitly confirms that the new PDF is a replacement.
- When a re-parse changes page dimensions or rotation, require geometry normalization before comparing boxes. A matching quote alone is not enough for a highlight whose meaning depends on location.

A failed re-anchor remains visible as `orphaned: true` with its old revision, quote, and geometry. It is a review task, not a deletion or silent move.

### Backlinks

A note list should support these directions without duplicating records:

- paper -> all notes;
- page/block -> notes;
- citation/reference -> notes that cite it;
- matrix cell -> notes/evidence anchors behind the cell;
- note -> paper, page, block, citation, and matrix uses.

## 7. BibTeX and RIS boundaries

### Internal normalized record

Use one internal citation record for BibTeX, BibLaTeX, RIS, Crossref, Semantic Scholar, GROBID, and Zotero imports. Keep at minimum:

- `citationKey`
- `type`
- `title`
- ordered `authors` and `editors`
- `year` and optional full date
- `venue`
- `publisher`
- `doi`
- `url`
- `arxiv`
- `abstract`
- `pages`, `volume`, `issue`
- arbitrary `extra` fields
- `sourceReceipts`
- `rawImport`

### Import rules

- BibTeX/BibLaTeX: reuse the current parser and preserve unknown fields. Keep the original entry text/hash when imported from a file.
- RIS: parse line-oriented `TY`/`ER` records, accept repeated tags, preserve tag order and unknown tags, and normalize only known fields. Accept CRLF and LF. Do not assume every producer uses strict 2001 spelling.
- Zotero JSON/CSL JSON: treat as a separate adapter, not as a BibTeX parser shortcut.
- GROBID `application/x-bibtex` output may be used as a convenience preview, but TEI remains the authoritative extraction receipt because the official documentation says the BibTeX projection is less rich.
- Crossref content negotiation output is external citation text. Parse it through the same boundary and retain the DOI/content-negotiation receipt.

### Export rules

- Export a canonical deterministic BibTeX form using current `toBibTeX` behavior.
- Export a canonical RIS form with one record per paper, explicit `TY` and `ER`, and documented tag mappings.
- Do not export notes, page boxes, source hashes, or matrix claims into BibTeX/RIS as if those formats were evidence formats. If an export needs them, write a separate JSON/Markdown evidence bundle.
- Preserve citation keys by default. If deduplication creates a collision, emit a deterministic suffix and a machine-readable key-change report.
- A round-trip test must compare normalized fields and preserved unknown fields, not byte-for-byte source text.

## 8. Citation-backed comparison matrices

### Baseline

Build on `src/core/evidence-matrix.ts`, not on a parallel comparison implementation. Its current behavior is already aligned with evidence-first review:

- one row per document and one column per aspect;
- a cell only when a matched passage exists;
- page, block ID, excerpt, raw text, and normalized value in the cell;
- explicit gaps for no evidence;
- conflicts based on normalized values, not on missing data;
- deterministic first reading-order match.

### Proposed research cell

```ts
interface CitationMatrixCell extends MatrixCell {
  paperId: string;
  sourceSha256: string;
  revisionId: string;
  anchors: SourceAnchor[];
  citationIds: string[];
  evidenceStatus: 'supported' | 'partial' | 'conflicting' | 'unverified';
}
```

The existing `MatrixCell.page` and `blockId` remain the fast navigation projection. `anchors` carry the complete geometry and exact source revision.

### Matrix behavior

- A cell is `supported` only when the matched text and anchor resolve to the current `DocumentIR` revision.
- A cell is `partial` when the passage exists but the aspect extractor captures only part of the claim, such as a metric without a split or confidence interval.
- A cell is `conflicting` when multiple cited passages or papers state incompatible values. Do not collapse the conflict to a mean or a winner.
- A cell is `unverified` when a metadata provider supplies a value but there is no page-linked passage in the local document. It may be shown in a separate metadata column, never silently merged into page evidence.
- `gaps` remain gaps. Missing paper text, missing section, failed extraction, and no aspect match should be separately reasoned in the gap detail, but none is agreement.
- Consensus summaries must cite the representative cells that produced the normalized value. The summary is a derived view, not a replacement for the quotes.
- Markdown and CSV exports must include paper ID, citation key/DOI where known, page, block ID, quote/excerpt, normalized value, source hash, and evidence status. A reader must be able to get back to the source without consulting hidden application state.
- A matrix claim must never cite only the paper metadata record when the claim is about a method, result, dataset, limitation, or other page-level proposition.

### Comparison recipe

1. Choose a fixed aspect definition with an ID, label, kind, and pattern/extractor version.
2. Run it against stable IR blocks in reading order.
3. Select the first valid evidence match unless the aspect explicitly allows multiple evidence spans.
4. Resolve each match to a page polygon and source revision.
5. Normalize only the comparison key. Keep the exact raw wording and excerpt.
6. Group equal values and report conflicts/gaps separately.
7. Render every conclusion with the cells behind it.

## 9. API, privacy, rate-limit, and license constraints

### API and reliability

- **GROBID:** local service by default. Bound in-flight jobs. Handle `200`, `204`, `400`, `500`, and `503` distinctly. Retry `503` with a finite budget and a documented delay. Persist the request parameters and GROBID version.
- **Semantic Scholar:** API key is a secret. Send it only as `x-api-key` from a trusted local adapter. Use a queue with a conservative default of one request per second for keyed requests, cache identifier lookups, and surface `429`/`5xx` without blind retries. Do not rely on the public unauthenticated shared limit for product behavior.
- **Crossref:** send only identifiers/metadata needed for the requested operation. Use DOI content negotiation or the REST endpoint explicitly and retain the response receipt. Do not use title search as an authoritative identity merge without user confirmation.
- **Zotero local API:** only connect to loopback after user opt-in. Reads are powerful because they expose the local library without authentication. Do not bind or forward port `23119`. This slice does not need write authorization.

### Privacy

Default privacy contract:

1. PDF bytes and notes stay local.
2. Local GROBID is the default extraction route.
3. Remote metadata requests send a DOI/arXiv ID, or a narrowly scoped reference identifier, not the PDF or note body.
4. An optional remote GROBID or AI provider requires a separate consent screen naming the data sent, provider, retention uncertainty, and resulting artifact.
5. API keys are stored outside source control and never serialized into metadata receipts, URLs, logs, or exports.
6. Logs record provider, endpoint class, status, timing bucket, and response hash, not full PDF text or note content.
7. Zotero imports must not silently copy an entire library or attachments. Import selected records only.

### Licenses

- GROBID at the pinned commit is Apache-2.0.
- PaperLab at the pinned commit is Apache-2.0.
- PDF Scholar at the pinned commit is MIT, with separately licensed dependencies.
- Omabib at the pinned commit is AGPL-3.0-or-later and links AGPL MuPDF; use as a behavioral reference unless the product's distribution model is compatible.
- PaperNook at the pinned commit is MIT, with separately licensed dependencies.
- The pinned PDF viewer reference has no root license file at that revision; do not copy code.
- Zotero documentation and translators are not automatically reusable application code. If implementing a format adapter, use the public format documentation and review the specific translator/license before copying any implementation.

This report does not authorize dependency adoption, code copying, redistribution of GROBID binaries, or use of Semantic Scholar data outside its API license.

## 10. Acceptance tests for implementation

These are proposed tests. They were **not run** in this research-only lane.

### A. Deterministic intake and extraction

1. Given the same PDF bytes and the same pinned GROBID response, two imports produce byte-identical `DocumentIR` JSON and extraction receipts except for explicitly excluded wall-clock fields.
2. The original PDF SHA-256 is retained and a changed byte produces a different document identity.
3. A fixture with two pages and different page sizes maps GROBID coordinates to the correct 1-based pages and in-bounds IR polygons.
4. A multi-line `biblStruct` or `ref` preserves multiple boxes rather than becoming one column-spanning rectangle.
5. A GROBID `204` is represented as an extraction warning/failure, not an empty successful document.
6. A GROBID `503` retries at most the configured count, waits according to the bounded policy, and then returns a visible failure.
7. `includeRawCitations=1` content is retained in the extraction receipt and is not confused with normalized citation metadata.

### B. Metadata and privacy

8. DOI, DOI URL, DOI-in-sentence, arXiv ID, and arXiv URL inputs produce the current expected lookup URLs and never send a title-only guess to an identifier endpoint.
9. Crossref and Semantic Scholar fixture payloads parse through the existing pure functions; malformed fields report a path; missing fields remain missing.
10. A merged record records field-level provider provenance and does not overwrite a manual field during refresh.
11. Semantic Scholar API keys appear only in the request header in a mocked adapter. They do not appear in logs, cache keys, URLs, serialized receipts, or exported files.
12. A remote metadata adapter sends only the identifier and requested fields. A test fails if PDF bytes, notes, or matrix excerpts appear in the request body.
13. A `429`/`503` provider response is surfaced with retry metadata and does not trigger unbounded retry or provider substitution.
14. Citation counts are rendered with provider and retrieval time.

### C. Anchors and re-anchoring

15. A note created from a block stores `paperId`, `documentId`, `sourceSha256`, `revisionId`, page, block ID, quote, and polygon.
16. A same-revision block-ID re-anchor succeeds only when the quote still matches.
17. A block-ID change with the same quote re-anchors on the same page.
18. A page insertion plus one unique exact quote re-anchors to the new page and preserves the old revision in history.
19. A changed source SHA does not auto-migrate a geometry-sensitive highlight without explicit replacement confirmation.
20. An unresolved anchor remains in storage as orphaned, with its old quote and geometry; it is not deleted or silently moved.
21. A multi-box selection round-trips through JSON without losing box order or page number.
22. Backlinks return the same note from block, citation, paper, and matrix-cell queries without duplicated note records.

### D. BibTeX/RIS/Zotero interoperability

23. Existing BibTeX fixtures round-trip through parse/write/parse with equal normalized fields and preserved unknown fields.
24. DOI duplicates merge only when the current dedupe rules permit it; conflicting citation keys remain and are reported.
25. RIS fixtures with CRLF, repeated author tags, unknown tags, blank lines, and common producer variants parse deterministically.
26. Canonical RIS export imports into Zotero's documented RIS path without losing title, author order, year, DOI, venue, or URL.
27. BibTeX/RIS exports do not claim to contain page polygons, source hashes, note text, or matrix evidence.
28. Zotero local API reads are refused when the local API is disabled, and the adapter never attempts to expose or forward port `23119`.
29. A Zotero import preserves item key/library identity and marks annotation records as external-source data.

### E. Citation-backed matrices

30. Every filled matrix cell has a resolvable anchor, source hash, revision ID, quote/excerpt, and evidence status.
31. A metadata-only value becomes `unverified` or a separate metadata cell, not a page-supported claim.
32. Same normalized values group as agreement only when at least two papers provide evidence; one witness is neither agreement nor conflict.
33. Conflicting values retain one or more representative cells per value and all their citations.
34. Missing evidence is rendered as an explicit gap with a reason and is not counted as agreement.
35. Markdown and CSV exports contain enough fields to navigate back to the paper, page, block, and source revision.
36. Re-running the same matrix with the same IR and aspect definitions is byte-identical.
37. A changed extraction revision invalidates or rechecks affected cells rather than leaving stale citations marked supported.

### F. License and release hygiene

38. Dependency/license inventory names GROBID, PDF rendering libraries, BibTeX/RIS parsers, Zotero adapters, and all transitive components before implementation merge.
39. No code is copied from the unlicensed-at-pin PDF viewer reference.
40. A report or implementation PR includes the exact provider URLs, pinned implementation SHAs, rate-limit policy, privacy behavior, and unresolved license questions.

## 11. Deliberate non-goals and open decisions

### Non-goals for this slice

- No automatic full-text download from publishers or paywalled sources.
- No remote PDF processing by default.
- No bulk Semantic Scholar crawling or citation graph synchronization.
- No Zotero library mirroring, attachment upload, or write-back.
- No automatic AI-generated comparison claims without page-linked evidence.
- No replacement of the current annotation re-anchoring rules.
- No production code changes in this report.

### Open decisions before implementation

1. **GROBID deployment:** local Docker/service process versus an already-managed local endpoint. The product should not assume a public hosted GROBID instance.
2. **TEI parser scope:** first pass can support paragraphs, headings, sentences, figures, tables, formulas, in-text refs, and bibliography entries. Full TEI fidelity is out of scope until fixtures demonstrate need.
3. **RIS library:** implement a small tested parser at the repository boundary or adopt a dependency after license and malformed-input behavior review.
4. **Source revision storage:** extend `Annotation` directly or introduce a research-note wrapper around the existing store. The wrapper is lower risk if existing annotation JSON compatibility must remain unchanged.
5. **Matrix extractor versioning:** aspect definitions need a stable version/hash so a changed regex or normalization rule can invalidate derived matrix cells.
6. **Provider freshness:** define a user-visible refresh action and a cache TTL per field. Citation counts should have a shorter TTL than title/authors/DOI.

## 12. Conclusion

The smallest complete implementation is not a new paper database. It is a source-preserving layer around the repository's existing IR, annotation, metadata, BibTeX, and evidence-matrix contracts:

- GROBID supplies locally reproducible structure and optional coordinates.
- Crossref and Semantic Scholar supply explicitly attributed metadata, not truth without provenance.
- Zotero supplies a user-controlled interoperability bridge, not the workspace source of truth.
- Notes point to immutable PDF identity, revision, page, geometry, block, and quote.
- BibTeX/RIS carry bibliographic interchange only; evidence stays in a separate source-linked bundle.
- Comparison matrices report supported evidence, gaps, and conflicts without turning silence or metadata guesses into findings.

This boundary is implementable without editing production code in the research lane and gives the next implementation PR concrete fixtures, privacy gates, and failure behavior to verify.
