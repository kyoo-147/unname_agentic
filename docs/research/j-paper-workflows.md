# J01-J10 paper workflows

This slice adds a local-first research boundary under `src/core/research/`.

## Evidence contract

A derived cell, card, question, or concept node carries an `EvidenceRef`.

- `supported` has an exact page and block anchor.
- `partial` is reserved for an incomplete but located passage.
- `unverified` means metadata exists without local page/block confirmation.
- `unknown` means the local evidence was not found.

The implementation never turns missing evidence into a claim.

## Metadata enrichment

`enrichMetadata` accepts DOI or arXiv identifiers only.

- `offline` never calls `fetch`.
- `consent` refuses network access unless `consent: true` is supplied.
- Requests have a timeout and cache by provider plus canonical request URL.
- Receipts keep provider, URL, status, retrieval time, response hash when Web Crypto is available, requested fields, and terms URL.
- Provider failures preserve the local paper and return `timeout` or `unavailable` states.

The cache is a derived local artifact and is versioned.

## Bibliography exchange

`src/core/research/ris.ts` parses common RIS variants, repeated author tags, CRLF/LF input, and unknown tags.

`exchange.ts` provides BibTeX/RIS import and export plus selected Zotero JSON import.

BibTeX/RIS contain bibliographic interchange only.

Page polygons, source hashes, notes, and matrix evidence remain in versioned JSON/Markdown research artifacts.

## Notes and backlinks

`ResearchNoteStore` requires at least one evidence reference and supports backlinks by paper, block, and citation id.

Its JSON is schema-versioned and import is all-or-nothing for duplicate ids.

## Paper mode and study packs

`cleanPaper` keeps formulas and footnotes as source text, extracts citation tokens, and preserves the source anchor.

`reflowPaper` wraps without clipping or silently dropping text.

`buildStudyPack` creates deterministic flashcards, questions, and concept-map links from exact evidence blocks.

The artifacts include the schema version and source block ids.

## Collections and duplicate merge

`ResearchLibrary` supports topic, author, year, tag, and text filters.

Duplicate candidates are proposals only.

`mergeDuplicate(candidate, true)` is the explicit confirmation boundary.

The surviving paper keeps source receipts, raw imports, and merge history.

A false confirmation does not mutate the library.
