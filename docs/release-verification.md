# Native release verification

Date: 2026-11-18 (Asia/Saigon)
Host: Windows x64, MSVC 18 BuildTools, Rust 1.99.1
Profile: release, debuginfo off, strip on, LTO off, 16 codegen units

## Build

```powershell
$env:CARGO_TARGET_DIR='C:/cargo-target-release'
$env:CARGO_PROFILE_RELEASE_DEBUG='0'
$env:CARGO_PROFILE_RELEASE_LTO='false'
$env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS='16'
$env:CARGO_PROFILE_RELEASE_STRIP='true'
# VsDevCmd -arch=x64 -host_arch=x64, then:
cargo build --release --manifest-path native-shell/Cargo.toml -p pdf_workspace -j 4
```

Result: exit 0, 36 pre-existing warnings, 6m 38s cold build (31.7s after the first-import fix).

- Executable: `pdf_workspace.exe`, 21,405,696 bytes
- SHA-256: `8C1000D6CCBC43690751B5EB155A51247C95023124CBCE421606F90DF55C97DF`
- Package: `dist/pdf-workspace-windows-x64-release-20261118-110746/`
- Native-messaging host: `pdf-workspace-host.exe`, 478,208 bytes, SHA-256 `79713585756FC360B2CC9590C3FBE1B5769030DFDBAFBF4E841358BDC95AAF1C`
- Zip: `dist/pdf-workspace-windows-x64-release-20261118-110746.zip`, 11.28 MB
- Zip SHA-256: `718C60611DEEA1DB09C56FF19B1E5ECAB8A7CE98AA2B34320F4E6B92E2451227`

Package contents: executable, `pdfium.dll`, `pdf-workspace-host.exe`, `install-native-host.ps1`,
root and upstream licenses, Lucide license, PDFium version and component licenses. The package is
**unsigned**; no code-signing certificate was used. The companion host answered a framed `hello`
handshake with protocol 1 and `status: ready`.

## Runtime check

- Fresh library, first import of `tests/fixtures/mirror-field-notes.pdf`, 15 s wait:
  `artifacts/desktop-packaged-first-import.png` renders the reader and sidebar.
- The same packaged executable renders a warm library as before.
- Window capture used PrintWindow; no mouse or cursor movement.

## First-import defect and fix

Before the fix, a fresh library showed a blank document area indefinitely after the first import
(18 s, 27 s and 45 s probes). Root cause: the import ran in a second `Store` handle, while the UI's
`SharedStore` kept its startup in-memory index. `entries` stayed empty, so `open(id)` could not find
the newly imported record and left an empty document view. Warm launches worked because the startup
index already contained the record.

Fix: `Store::reload()` clears and re-reads `index.json`; `SharedStore::reload()` exposes it; the
workspace calls it after file import and after browser-companion updates, then rebuilds the entry list.

Regression evidence: fresh packaged launch renders at 15 s; native workspace tests remain
**51 passed, 0 failed, 1 ignored**; release build succeeds. Destructive dialogs (delete/rename/move/trash) now pick a Vietnamese format string through `localized_format!`; a unit test pins the Vietnamese branch.

## Native scanned PDF OCR

The packaged release opened `tests/fixtures/scanned-page.pdf` (image-only, no embedded text) on a
fresh library. After 20 s the reader showed the scanned page with the recognized lines:

- `SCANNED PAGE`
- `Reading without boundaries`
- `Local OCR should find this text.`
- `Numbers 42 and 3.14159 stay exact.`

Engine: Windows OCR. The original raster is preserved and the text is used as paired text, not
painted over the scan. Screenshot: `artifacts/desktop-native-scan-ocr.png`.
Translation was off; this proves the native OCR path, not translation quality.

## Limits

- The release is portable, not an installer; it is unsigned.
- The Chrome native-messaging host is included, but Chrome registration is a separate user step (`install-native-host.ps1`).
- Translation is off until a provider is configured; no live provider was called.
- One fixture, one window size (1679x950), one DPI.
