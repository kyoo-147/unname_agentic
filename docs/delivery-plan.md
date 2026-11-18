# Delivery plan — verified build in progress

Correction to the earlier freeze: the disk is now clear (18 GB free), so the build resumed in the same session. The plan below is the live one.

## Verified this session

- Rust: `cargo test --workspace` → 95 + 74 passed, 0 failed (re-run green after the asset removal).
- Web: `pnpm test` → 54 passed; `pnpm test:e2e` → 3 passed.
- Upstream assets removed for good: `assets/covers` (52 files), `assets/editor-icons` (173 svg), `assets/fonts` (21 KaTeX ttf). `build.rs` no longer embeds covers, editor-icons or fonts.
- Binary size after the trim: 34,100,224 → 33,524,224 → **33,303,040 bytes** (preview renderer removed as well).
- Deleted with the preview path: `src/home_text.rs`, `src/home_preview_style.rs`, the `thumb_blocks`/`thumb_block` renderer, the thumbnail cache and the DocxXML preview dependency of Home. Cards now render `assets/{id}-pdf.png` directly; the grid looks identical (same screenshot hash before/after).
- Package `dist/pdf-workspace-windows-x64-release-20261108-225912` (+ zip); packaged app launched and rendered the 41-PDF library.
- Home cards read `assets/{id}-pdf.png` directly — no DocxXML parse on the grid; chat header shows its own title.

## Editor engine removed (done)

- `src/editor/**` (29 files, 917 KB), `editor_ui.rs`, `editor_theme.rs`, `highlight.rs`, `html.rs` deleted.
- The product now has its own text element: `src/text_field_element.rs` (shapes, wraps, paints placeholder / selection / caret / IME underline, and records a layout for hit-testing). `input.rs` runs on it; no `editor::text` dependency.
- Theme colour tokens moved into `themes.rs` (`TOKENS`, `base_color`), so `editor_theme` is gone.
- Edit menu now dispatches the product's `field::Cut/Copy/Paste/SelectAll`; the editor-only Undo/Redo rows are gone.
- Reminder notifications use a plain product string; the editor's formatter is gone.
- Verified: `cargo build` green, `cargo test --workspace` → 95 + 49 passed, and the running app renders the 41-PDF library (capture `post-editor-home.png`, taken without touching the mouse).

## The upstream engine is gone (verified)

- `crates/core` (fdl_core, 10,180 lines) deleted. The workspace now builds `pdf_workspace` + `crates/library`.
- New `crates/library` (`pdf_library`, ~450 lines): `store` (JSON index, retained `sources/`, `assets/` thumbnails, trash, settings, bounded reads) and `time` (civil dates with a configurable UTC offset).
- Legacy records migrate on first read: the title is taken from the old `.xml` note, rewritten as `docs/<id>.json`, and the `.xml` removed.
- Removed with the engine: Markdown import/export and its dialog, backlink visibility, reminders, the document info panel, blank-page creation, `InfoRow`, `PageWidth`.
- `native-shell/Cargo.toml` metadata is the product's own (description, keywords, authors, categories).
- Verified: `cargo build` green; `cargo test --workspace` → 48 passed; the app renders all 41 library records from the new store (capture `library-newstore.png`).

## Remaining before publishing

1. Delete the upstream leftovers that no longer have a consumer: `native-shell/{docs,.github,site,services,shared-mock,tools,packaging}`, `README.ja.md`, `README.zh-CN.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `AGENTS.md`, `desktop/{proof,examples}`; then check whether `feishu_theme.rs` and the CSS theme system (`themes.rs`) can go too.
2. Trim the 34 build warnings (dead helpers left by the removals).
3. Release build + `scripts/package-native.ps1` + a capture of the packaged app.
4. Run `scripts/publish-to-github.ps1` and push (code only; README already prepared with the two product screenshots).


## Testing rule

No harness mouse commands (`click`/`move`/`drag`) — they move the user's real cursor. Verification uses `shot` / `--dev-capture-window`, Playwright, and unit tests only.

A scheduled task exists for 09:00 tomorrow as a backstop: `Xác minh build và đóng gói bản native` (one-shot).

## Done and compiled before the build cache was cleared

- Dead modules removed: printing, guides, quick note, changelog; `webview2-com` and the `windows` crate dropped; guide assets no longer embedded.
- PDF library from real thumbnails; 41-PDF corpus imported and verified (41 sources, 41 thumbnails, grid screenshot).
- Paired reader, split divider, synchronized scroll, capture picker, Chrome companion, provider settings, secret API-key field.
- Sidebar destinations: New chat, Home, Recent, Favorites, Live mirror, Translate, Settings; one selected row at a time.
- Appearance: Light / System / Dark and six palettes (Mặc định, Sage Lab, Paper Studio, Mineral, Arctic, Aurora Studio), persisted in `preferences.json`, plus palette depth for borders, dividers, hover/pressed, selection and sidebar.
- Window default 1663 × 941, minimum 980 × 620.
- Chat composer: Ask/Document modes, model label, attach, skills, mic, voice, suggestion chips, honest empty states.
- `assets/covers` deleted; `assets/illus/*.svg` redrawn as our own line art.
- Sidebar footer now carries Trash next to Settings, so every library surface has a destination.

## OCR

Windows OCR (`Windows.Media.Ocr`) is the OCR engine and already returned 40 regions on a real captured window earlier. Tesseract is not installed on this machine, so no extra model is downloaded; a Tesseract `vie+eng` bundle is only worth adding if Windows OCR proves insufficient for Vietnamese scans.

## Written after the build freeze (needs one compile to verify)

- `src/i18n.rs`: central Vietnamese table. `tr(zh, en)` now resolves Vietnamese from the English string, so the hundreds of existing two-language call sites translate without edits. `tr3` still gives exact Vietnamese where written.
- `src/settings.rs::text()` routes through the same table, so Chinese-keyed shell strings also show Vietnamese.

## Known compile risks for tomorrow

1. `settings::text()` lifetime: `vi_for` returns `&'static str`, mapped into the input lifetime with an explicit `match` (not `unwrap_or`) — check it compiles.
2. `i18n::tr` now calls `vi_for`; ensure the `static VI` table has no duplicate keys.
3. Sidebar references `home.recent_view` and `home.chat`; both fields exist with defaults.

## Tomorrow, in order

1. `cargo check -p pdf_workspace` and fix the three risks above.
2. `cargo build -p pdf_workspace` + launch; screenshot Chat, Home, Favorites, Settings in vi, en, zh.
3. Assert the selected sidebar row is unique per destination.
4. Release build + `scripts/package-native.ps1` + launch the packaged exe.
5. Then the editor/fdl_core removal (frees `assets/fonts` and `assets/editor-icons`):
   - drop `mod editor*`, `editor_ui`, `editor_theme`, `modes`, `docmenu`, `docinfo` and their dependencies;
   - Home cards already use thumbnails only, so the DocxXML model is no longer needed for PDFs;
   - delete `crates/core`, `assets/fonts`, `assets/editor-icons`, `vendor` patches that only existed for the editor;
   - rebuild, re-import the 41 PDFs, re-run the reader.
6. Light OCR test: install Tesseract with `vie+eng` traineddata (or use Windows OCR already available) and run `scripts/capture_smoke`-style verification on one scanned PDF.

## Disk policy

`native-shell/target` and `desktop/target` were deleted (15.5 GB). Free space after cleanup: ~18 GB. Keep it: no build until tomorrow's session, no new large downloads except the OCR traineddata (~15 MB).

## Note on pstack

The installed pstack skills are disabled for tool invocation in this session, so their checklists cannot be machine-invoked. Their substance is being followed manually: reproduce first, verify with a real run, keep evidence, and never report a feature as working without a build and a screenshot. That last step is exactly what tomorrow's session must perform.
