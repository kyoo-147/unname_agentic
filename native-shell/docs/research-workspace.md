# Native research workspace module

`pdf_library::research` is the native-shell integration boundary for local research data.
It is UI-framework-free and performs no network requests.

## Parent shell integration hook

The parent shell can open `pdf_library::research::ResearchStore::open_at(<library root>)` beside its existing `pdf_library::store::Store`.
Keep the store behind the shell's existing local-library lifecycle, call `save`-backed methods for mutations, and present metadata and duplicate proposals for explicit user review.
Do not wire this as background enrichment or imply a visible research UI exists.

The module exports `Paper`, `KnowledgeCard`, `ExactLocator`, `Collection`, metadata and duplicate proposal types, `ReflowDecision`, `parse_ris`, and `export_ris`.
`ResearchStore::add_card` requires valid source identity and one-based page locators for supported cards.
Unsupported or unverified records must remain distinct from source-supported evidence.

Metadata proposals are pending by default.
Accepting one changes only the named allowlisted metadata field and leaves its state `unverified`; it does not assert that provider data or user input was checked against the source.
Duplicate candidates remain proposals until `confirm_duplicate` is called.
Confirmation reassigns source-linked cards and collection membership to the selected retained paper, but does not delete those records.

Reflow keeps same-revision anchors, flags a cross-revision exact-quote match for review, and orphans a nonmatching locator without rewriting its page, quote, source hash, or geometry.
RIS import/export is local-only and retains unknown tags in `ris_extra`; RIS does not carry knowledge-card evidence or locators.
No DOI resolver, Crossref/Semantic Scholar API, Zotero connection, or file fetch is implemented here.

## Provenance and license boundary

The code in `native-shell/crates/library/src/research.rs` is newly authored for this repository under the repository's MIT license.
It adapts data-contract ideas from the project's existing local research workspace and research report, not copied implementation code.
The existing extension/viewer and referenced external projects were inspected as behavioral references only.
No external code, dependency, or provider metadata was copied or introduced.
