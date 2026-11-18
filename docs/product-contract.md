# Mirror PDF product contract

## Outcome

Chrome automatically detects a PDF or a document viewer and creates a translated mirror. The original remains available. Both views follow the same page, zoom, rotation, and reading position. The translated view preserves page dimensions, non-text artwork, and text regions. Translation starts with the visible viewport without waiting for the whole document.

A native Rust desktop application supplies the same document workflow and a window or monitor source picker. It follows the selected source and translates changed visible text. It must not capture its own output recursively.

The visual reference is the quiet document-library shell of Quiet.md and the paired reader of PageBridge. The desktop must render natively, not disguise a WebView as a native Rust interface. Commercial Quiet.md icons, product branding, and application icon are excluded from reuse.

## Required behaviors

- Automatically detect direct PDF navigation, PDF response content types, embedded PDF elements, and supported HTML document viewers.
- Establish mirror sessions idempotently. Updating a tab must not open duplicate mirrors.
- Acquire document bytes when available. Retain source identity and use structured text and geometry before screenshot OCR.
- Use capture when document bytes or elements are unavailable. Detect changed regions and discard stale recognition or translation results.
- Prioritize explicit selections, visible blocks, then adjacent pages. Full-document translation is optional and cancellable.
- Keep every text block anchored to page coordinates. Keep source and translation correspondence stable across resizing.
- Never silently truncate translations. Fit within the original text region and expose a full reading view when fitting cannot pass the fidelity gate.
- Provide Google Cloud Translation, DeepL, OpenAI-compatible APIs, and local endpoints. Never label copied source text as translated output.
- Cache with language, provider, model, prompt version, glossary version, and source content identity.
- Keep cloud transfer explicit. A screen-capture permission is not cloud-upload permission.
- Translate selected text and highlight its paired source or translated region.
- Include visible pause, retry, provider error, loading, and source-disconnected states.

## Fidelity acceptance

The user's target is an otherwise identical translated mirror. Keep that target, not a reduced product promise. Record fidelity defects against test documents instead of asserting universal success without proof.

Verify these independently:

1. Page geometry and non-text pixels remain unchanged outside designated translated regions.
2. No original visible glyphs remain behind translated text.
3. Text is complete, readable, and contained in its assigned region.
4. Native extraction and OCR follow reading order on multi-column pages.
5. Source generation N cannot receive translation for generation N-1.
6. Scroll, zoom, resize, rotation, and source-window movement do not misplace translated regions.
7. Requests are not repeated for cached unchanged content.

## Initial verification corpus

Digital PDF with plain paragraphs; colored slide; two-column paper with formulas; long translated text; mixed image/text PDF; scanned page; rotated page; a PDF requiring authentication; embedded document viewer; window resize and mixed-DPI movement.

Use deterministic provider fixtures for offline tests. Real-provider checks are separate and require valid credentials or a running local model. Report them as not verified until executed.
