# Upstream code base and rebrand status

This document answers one question honestly: how much of the native desktop application is original work, how much is the Quiet.md fork, and what has actually been renamed.

## Technology

| Layer | Technology |
| --- | --- |
| Desktop UI | Rust, GPUI 0.2.2 with this fork's local patches (`native-shell/vendor/gpui`, `vendor/taffy`) |
| Document engine | `fdl_core` (DocxXML model, editor core, library store) |
| PDF rendering | PDFium 8125 through `pdfium-render` 0.9.5, DLL loaded beside the executable |
| OCR | Windows WinRT `Windows.Media.Ocr` |
| Capture | `xcap` 0.9.8 (WGC on Windows) |
| Translation | Google Cloud, DeepL, OpenAI-compatible, loopback local; `reqwest` |
| Credentials | Windows `PasswordVault` |
| Chrome | Manifest V3, TypeScript, Vite 7, PDF.js 5.7 |
| Companion | Native Messaging host over framed stdio + file inbox |
| Verification | Rust tests, Vitest, Playwright Chromium |

## What is taken from Quiet.md

The whole application source was copied, not only the shell. Measured on the current tree:

- `native-shell/src`: 73 Rust files, 36,313 lines (Home, sidebar, window controls, themes, editor UI, Settings, printing, updater, guides, quick note, changelog).
- `native-shell/crates/core`: 14 files, 10,180 lines (DocxXML/Feishu document engine, editor core, library store).
- `native-shell/vendor/gpui`: Quiet.md's patched GPUI. `assets/themes`, `assets/fonts`, `assets/covers`, `assets/illus`, `assets/editor-icons` are also upstream.

So roughly 46.5k lines are upstream code under the MIT licence.

## What is original work in this repository

- `desktop/` (7 files, 1,061 lines): PDFium page loading and text suppression, capture/OCR, provider adapters and vault.
- `src/` + `extension/` (16 files, 1,269 lines): browser reader and Chrome extension.
- `native-shell/src/{pdf_reader,product_library,native_bridge}.rs` (710 lines): PDF library, paired reader, companion bridge.
- Tests, fixtures, scripts, and documentation.

That is roughly 3k lines of product-specific code on top of the fork.

## MIT and branding

Quiet.md is MIT: copying and modifying the code is allowed provided the copyright notice is retained, which `native-shell/LICENSE` does. MIT does **not** grant the product name, the app icon, or the commercial Nucleo icon set.

## Rebranding completed in this pass

- Package renamed `pdf_workspace`; application id `local.pdfworkspace.preview`; window title Documents.
- `assets/branding` (app icon and mascot) and `assets/icons` (67 commercial Nucleo icons) deleted from the tree; they are replaced by generated Lucide aliases in `assets-safe/icons`, and the Windows resource embeds no upstream icon.
- Log directory, log file names, and the log target changed from `quiet_md`/`quiet-md.log` to `pdf-workspace.log`.
- Updater can no longer reach upstream: `BASE` is empty, so a release build refuses to fetch a manifest instead of downloading upstream packages or trusting upstream's signing key.
- Quick note title, hide-app shortcut label, changelog entry, generated theme CSS author, printing WebView data folder, and the Appearance theme sample text no longer name Quiet.md.

## Still upstream by design

- The DocxXML editor engine and library store remain because Home cards render their PDF previews through that model. Removing it would require an image-only card renderer.
- Dead upstream modules (updater UI, quick note, guide seeding, changelog, printing) are still compiled but unreachable; they add binary size and warnings.
- Upstream test names and internal identifiers such as `quiet_md` in test-only strings remain.
- The `quiet-md.log`-era comment text in some modules is stale documentation, not behaviour.

## Decision pending

Whether to keep this as a fork with attribution or strip it down to a shell-only fork (deleting `crates/core`, the editor, printing, updater, guides, quick note) and reimplement Home previews as image-only cards. The second option is smaller and clearer to own, but is a larger, separate change.
