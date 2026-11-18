# Product integration into the approved shell

The user approved the live GPUI shell shown in artifacts/gpui-shell-preview.png. Preserve its Home layout, sidebar, custom titlebar, card spacing, search, and control sizing. Replace sample content with real PDFs and connect product actions. Do not return to the rejected egui UI.

## Data ownership

The native application owns an isolated library rooted at PDF_WORKSPACE_HOME or LocalAppData/PdfWorkspace. Product mode uses its documents subfolder. Layout preview remains separate and opt-in. Never read the user's Quiet.md library.

Each imported PDF has original bytes retained under the product library and a generated thumbnail. The original Store entry is a library presentation record, not an editable PDF body. Optional metadata identifies its PDF attachment and page count. Its DocxXML preview contains only a real rendered thumbnail and descriptive title. Open routes PDF records to PdfReader instead of the old note editor. Search, favorites, sort, and removal operate on library records, not the external source file.

## GPUI boundary

Library integration owns app.rs, home.rs, sidebar.rs, transfer.rs, store metadata, and import preparation. Reader integration owns pdf_reader.rs and any pdf_reader submodules. Parent owns main module declarations, Cargo configuration, backend model/provider changes, and integration tests.

Reader construction contract:

- PdfReader::new(path: PathBuf, initial_page: u16, window: &mut Window, cx: &mut Context<Self>) -> Self
- PdfReader::from_capture(source: CaptureSource, window: &mut Window, cx: &mut Context<Self>) -> Self
- PdfReader emits PdfReaderEvent::Location(u16) and PdfReaderEvent::Toast(String).
- Reader implements Render and EventEmitter<PdfReaderEvent>.
- Its own toolbar exposes page navigation, target language, translation pause/retry, provider settings, and source status.

The shell stores Entity<PdfReader> and renders it on the right without adding another native titlebar. The outer custom window controls and sidebar remain original. PDFium and OCR work never block GPUI rendering. Provider credentials remain in the native vault, not the thumbnail or preview document.

## First live product gate

1. Launch product mode without seeded notes.
2. Import the generated four-page PDF through the native file picker or explicit command-line PDF input.
3. Home shows its real thumbnail and persisted metadata after restart.
4. Clicking the card opens original and translated panes within the accepted shell.
5. A deterministic local provider verifies request-to-composition behavior, clearly distinct from live translation quality.
6. Original artwork pixels and source-glyph removal are checked against the actual rendered output.
7. Unavailable provider or OCR shows a recoverable error, not invented results.

Capture and Chrome live synchronization are separate acceptance gates. Keep original access and visible source control throughout.
