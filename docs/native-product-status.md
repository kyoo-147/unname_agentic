# Native product integration status

The original GPUI shell was approved by the user. Product integration preserves that shell, its native custom Windows controls, sidebar, search, and Home card grid.

## Implemented and exercised

- Import a real PDF asynchronously; retain its original bytes in the isolated workspace; render a real first-page thumbnail.
- Persistent library metadata: PDF page count, current page, title, favorite and pin state. Rename changes the library label, not original PDF bytes.
- Native two-pane reader using the existing PDFium backend. Source pixels remain visible until translated text fits its region. Overflow is available in full paired reading and the selected-region drawer.
- Native provider configuration for OpenAI-compatible, local loopback, Google and DeepL; source/target languages; cloud-transfer opt-in; native credential vault.
- Region-priority background translation, cache identity, source/profile generation guards, page navigation, zoom, retry and pause.
- Live-mirror source picker and capture/OCR reader path. Hidden readers are suspended when leaving the document view, rejecting stale source/provider results. Original raster artwork is retained when no verified text-only mask exists.

## Evidence

- Twelve backend tests pass: geometry/generation/cache/endpoint safety, real PDFium reopening and source suppression, exact provider block count, loopback HTTP response and offline cache, grouped bounding-box union, and raster-art retention.
- Fifteen reader-state/geometry tests pass, including suppression-patch padding, formula retention, unequal pane widths, divider constraints, viewport intersections and scroll feedback guards.
- Four secret-field tests pass for grapheme masking, source/display offset mapping, clipboard suppression and ordinary-field compatibility. A real native synthetic-key screenshot shows bullets only.
- The full native workspace suite passes: core engine/store 95 passed, 2 intentionally ignored; UI crate 71 passed, 1 intentionally ignored. Coverage includes retained PDF bytes, thumbnail/location/restart/trash/restore, import rollback/idempotency, old metadata defaults, path confinement, secret inputs, split geometry and companion freshness/poison-entry isolation.
- The real native script asserts reader active in Doc, suspended on Home, and active again after reopening the same card. All three assertions pass; see artifacts/native-privacy-stderr.log.
- Browser: 44 unit tests and typecheck pass, including opt-in companion transport and hello-handshake concurrency. Production build and all three Chromium end-to-end flows pass (MIME-only auto-detection, real PDF artwork/text suppression, recoverable provider error).
- Six native-host protocol tests pass: framed hello, ordered bounded chunks, checksum/source binding, stale generation rejection, EOF cleanup and strict malformed-message rejection.
- Actual native host -> checksum-verified inbox -> live GPUI reader passes initial zero-based page 2, subsequent page 1 at normalized progress 0.25, explicit end/detach and removal of the duplicate inbox PDF after acknowledgment. No Chrome registry keys were modified; see artifacts/native-companion-verification.json.
- Real native screenshots are saved as artifacts/product-library.png, product-reader-original.png, product-reader-settings.png. The screenshot helper runs in a separate process because xcap deliberately excludes its own process from window enumeration.
- artifacts/native-art-verification.json compares an actual chart interior in both native panes: 29,904 of 29,904 pixels equal on the generated fixture, excluding translated heading/caption.
- Translation screenshots use the explicitly named deterministic-test-only local provider. This is integration evidence, not model quality evidence. The regular preview has a separate profile with no fixture provider or cloud consent preconfigured.

## Remaining acceptance work

- Unequal-width divider and synchronized scrolling now have 15 reader geometry/state tests and a live native drag/wheel/zoom harness. Further mixed-DPI and long-document corpus coverage remains.
- Chrome companion transport, native consumer and page following are implemented and independently/integratively tested. Actual Chrome nativeMessaging registration is user-invoked via scripts/install-native-host.ps1 with the exact installed extension ID; the registered Chrome -> host launch remains a separate acceptance gate. Desktop-to-Chrome navigation is not yet bidirectional.
- Live selected-window OCR/capture on representative external sources and mixed-DPI monitors; scan text-only masks without damaging artwork.
- Clipped/Type3 text, complex colored backgrounds, full script/font coverage and typography/fit corpus. Raster scans currently use paired translated text rather than unverified rectangular erasure.
- Secret-field Unicode rendering, clipboard suppression and OS text-query blocking are implemented. Cross-IME/native assistive-technology testing remains.
- Credentialed Google/DeepL/cloud/local-model translation quality and quota checks. No paid provider requests were made.
- Owned PDF/thumbnail cleanup, shared-thumbnail retention and partial-import rollback now pass regression tests. Browser imports have persisted binding-key idempotency, so acknowledgment retry cannot duplicate records. Quarantined browser inbox entries expose consumer-error.txt and require re-import or explicit correction before retry.
- Native packaging/license bundle, production-warning cleanup, and release-mode full checks.

Do not describe the entire original product objective as complete based on the current checkpoint.
