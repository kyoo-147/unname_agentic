# Native backend and reference shell

## Status

The eframe/egui shell is a **rejected UI reference**, not the accepted desktop product. The user requested the actual Quiet.md native shell to be forked and customized instead. Keep the backend adapters below while replacing the shell. No WebView is used by the reference executable.

## Build and tests

From the repository root, use the parent-owned MSVC wrapper:

```powershell
.\scripts\build-windows.ps1 -Action check
.\scripts\build-windows.ps1 -Action test
.\scripts\build-windows.ps1 -Action build
.\scripts\build-windows.ps1 -Action run
```

The wrapper accepts `-Release`. The debug reference executable is `desktop/target/debug/mirror-pdf-desktop.exe`. A running executable must be closed before replacing it on Windows.

Backend verification on 2026-11-08: six pure contract tests and one real PDFium integration test passed. The PDF test loads pages 0, 1, and 0 again from `tests/fixtures/mirror-field-notes.pdf`; verifies extraction, geometry, changed pixels after text suppression, and an unchanged chart-artwork pixel. This catches the PDFium process-wide binding lifetime bug found during interactive use.

## Adapter contracts

- `pdf::load_page(path, page_index, password)` returns `PageFrame`: original RGBA pixels, text-free artwork RGBA pixels, normalized text rectangles, stable per-page block IDs, document SHA-256, and page count. A process-wide mutex owns one PDFium instance and serializes complete document operations. Text objects, including nested form text, are made invisible before rendering the clean artwork.
- `capture::sources()` enumerates eligible windows and monitors, excluding this process's windows. `grab(source)` captures pixels. `recognize_frame(image, title, auto_detect)` automatically locates a likely bright document region, runs Windows OCR locally, and prepares conservative flat-background suppression. `recognize(image)` exposes local OCR separately.
- `capture::exclude_own_windows()` applies Windows `WDA_EXCLUDEFROMCAPTURE`. Monitor capture must fail closed unless exclusion succeeds. Do not enable this merely on application startup: it hides the UI from screenshots unnecessarily.
- `provider::translate_blocks(settings, blocks)` calls actual Google Cloud Translation, DeepL, OpenAI-compatible, or local OpenAI-compatible endpoints. It returns one nonempty string per block, rejects truncated OpenAI replies, gates non-loopback transfer on cloud consent, and caches provider/model/language/glossary/content identity. API keys use Windows PasswordVault, not settings JSON.
- `GenerationGuard` invalidates results when source, viewport, pause, provider, or language changes. Every asynchronous recognition/translation result must carry and recheck its generation before composition.

## Reference shell behavior

The reference implements local PDF import, persisted recent documents and favorites, searchable thumbnail grid/list, paired source/translation view, visible-region translation, region comparison with selectable full text, provider settings, source selection, continuous capture, automatic document-boundary detection, local OCR, and stale-result rejection. Start composition from the original image; copy clean artwork **only underneath ready translated regions**. Pending regions must retain original text. Overlong translations use the full comparison view instead of silent truncation. OCR regions with uncertain backgrounds retain original artwork and show a warning rather than claiming exact suppression.

The reference's bounded capture channel and latest pending OCR frame prevent an unbounded recognition backlog. Selecting a capture scope is required for privacy; document detection inside that scope is automatic, not a manual crop-only workflow.

## Runtime and evidence

The downloaded PDFium runtime, version record, headers, and upstream licenses are under `desktop/runtime`. Keep `pdfium.dll` beside a distributed executable and retain all upstream licenses. Development also resolves `desktop/runtime/bin/pdfium.dll`.

The reference CLI supports:

```powershell
.\desktop\target\debug\mirror-pdf-desktop.exe --smoke-pdf .\tests\fixtures\mirror-field-notes.pdf .\desktop\proof
```

Recorded smoke artifacts: `desktop/proof/native-original.png`, `native-clean.png`, and `native-smoke.json`. The real fixture produced four pages and fourteen blocks on page one. Visual inspection of the clean raster confirmed removed glyphs and retained vector chart/header artwork. This is fixture-specific proof, not universal fidelity acceptance.

`desktop/proof/native-home.png` is an actual native-window screenshot after explicitly activating the process. It records the rejected shell and the PDFium rebinding error discovered before the singleton fix; it is **not accepted Home UI proof**. Earlier captures mistakenly contained the underlying DSH window and were rejected. Do not use them as native evidence.

## Remaining gates

- Replace rejected eframe UI with the requested Quiet.md native shell.
- Integrate and verify the adapters in that accepted shell.
- Run real Windows capture/OCR and translated capture-mirror acceptance. Windows OCR APIs compile, but recognition was not verified in this pass; Tesseract is unavailable.
- Verify live Google, DeepL, and OpenAI providers with credentials and a running local model. No Ollama service was available on port 11434; no live translation quality is claimed.
- Verify deterministic test-provider integration separately from live translation quality.
- Rotation, arbitrary text-range selection, cancellation of already-sent HTTP work, dirty-region-only OCR, full-document translation, authenticated sources, mixed-DPI movement, and comprehensive multilingual/font fitting remain gaps in the reference shell.
- The document detector is a bright-page-region heuristic, not semantic classification of every arbitrary viewer or dark document. Changed frames are invalidated correctly, but cursor/video changes can trigger unnecessary OCR. Do not claim universal automatic detection.
- Preserve real provider errors, source-disconnected states, explicit cloud transfer consent, and no-recursion checks in the replacement.
