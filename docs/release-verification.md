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

- Executable: `pdf_workspace.exe`, 21,400,064 bytes
- SHA-256: `0C120D7D38115931A7EAED35B3D7302167683A6218F939FCB9F5B4B83250D63F`
- Package: `dist/pdf-workspace-windows-x64-release-20261118-110746/`
- Zip: `dist/pdf-workspace-windows-x64-release-20261118-110746.zip`, 11.07 MB
- Zip SHA-256: `DDFBB2F480F5936E45EEA0EE4C0AB2A327834CD2D7A4E4E6BFA3CCBF4E2E857F`

Package contents: executable, `pdfium.dll`, root and upstream licenses, Lucide license, PDFium
version and component licenses. The package is **unsigned**; no code-signing certificate was used.
The Chrome native-messaging host is not part of this zip.

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
**50 passed, 0 failed, 1 ignored**; release build succeeds.

## Limits

- The release is portable, not an installer; it is unsigned.
- The Chrome native-messaging host (`pdf-workspace-host.exe`) is not included in this package.
- Translation is off until a provider is configured; no live provider was called.
- One fixture, one window size (1679x950), one DPI.
