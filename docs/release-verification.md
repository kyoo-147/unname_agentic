# Native release verification record

This file preserves a historical native receipt, not current-branch evidence.
The receipt below must not be read as a native pass for a later checkout or wave.
Current audit: native build/tests/package, Chrome/native E2E, trusted signing, Chrome registry/native-host installation,
CI and independent PDF-reader validation are unverified.
A historical self-signed preview is not trusted signing, and a packaged host is not proof of Chrome registration.
For a full current release, run `scripts/package-native.ps1`, `scripts/verify-release.ps1`,
and `node scripts/release-check.mjs --require-native --require-ci`, then attach fresh evidence for each gate.
The release checker requires both a positive `RELEASE_NATIVE_TESTS` count and `RELEASE_NATIVE_STATUS=pass` from a real run.
If Windows SDK, `rc.exe`, linker/paging-file error 1455, or another infrastructure condition blocks
the run, record `RELEASE_NATIVE_STATUS=blocked` and the exact error instead of changing it to pass.

## Historical native release verification

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

- Executable: `pdf_workspace.exe`, 21,628,416 bytes
- SHA-256: `6FCE99E53EBDAD67A2A3F4C434A8E3FEFA8B87C513D873EE504341AEF3818C6B`
- Package: `dist/pdf-workspace-windows-x64-release-20261118-110746/`
- Native-messaging host: `pdf-workspace-host.exe`, 478,208 bytes, SHA-256 `79713585756FC360B2CC9590C3FBE1B5769030DFDBAFBF4E841358BDC95AAF1C`
- Zip: `dist/pdf-workspace-windows-x64-release-20261118-110746.zip`, 11.34 MB
- Zip SHA-256: `FA759D26E8829E2F4E27C831ECBFDF8AE0B58D5BEA2F3D99DF8B59700EAFB782`

Package contents: executable, `pdfium.dll`, `pdf-workspace-host.exe`, `install-native-host.ps1`,
root and upstream licenses, Lucide license, PDFium version and component licenses. The executable is
signed with a **self-signed preview certificate** (`CN=Mirror PDF Preview (self-signed)`, thumbprint
`CB4361EDB01EC07A25F3EF5722831CCA12261FC3`); Windows reports an untrusted-root chain because that
certificate is not issued by a public CA. The companion host answered a framed `hello` handshake with
protocol 1 and `status: ready`.

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
**51 passed, 0 failed, 1 ignored** in the native workspace plus **22 passed** in the desktop crate
(2 new chat-context tests); release build succeeds. Destructive dialogs (delete/rename/move/trash) now pick a Vietnamese format string through `localized_format!`; a unit test pins the Vietnamese branch.

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

## Native chat

The packaged executable was started on the chat view against a local OpenAI-compatible fixture provider
(`http://127.0.0.1:4319/v1`, model `deterministic-test-only`). A submitted message returned an assistant
bubble through the real request path:

- user: `Tóm tắt nội dung chính`
- assistant: `Bản dịch kiểm thử: Tóm tắt nội dung chính`

With a PDF open, the chat shows `Đang hỏi về: mirror-field-notes` and sends the current page's extracted
source text (up to 6,000 characters) as fenced document context. The context fence and the no-context
fallback are covered by two provider unit tests (`chat_system`). The fixture provider ignores context and
returns a canned translation, so the screenshot proves the UI and request path, not summary quality.
Screenshot: `artifacts/desktop-chat-context5.png`.

Conversation history is persisted to `chat.json` (last 100 messages) and reloaded on the next launch;
the restart was verified with the same two-message exchange and screenshot `artifacts/desktop-chat-history.png`.
Answers stream through `provider::chat_stream` (SSE `delta.content` frames) and the assistant bubble grows
while the stream is open; the fixture provider was extended to emit SSE and the packaged build rendered
`Bản dịch kiểm thử: Chào anh, đây là kiểm tra streaming` (`artifacts/desktop-chat-stream3.png`).
The chat also offers three contextual prompts (`Tóm tắt trang này`, `Liệt kê số liệu`, `Giải thích thuật ngữ`)
when a page is attached; the header shows the configured model and a `Cuộc trò chuyện mới` reset.
On a fresh data directory the chat opens a provider panel for `Endpoint` and `Mô hình` with validation and
save (`artifacts/desktop-chat-config.png`); no API-key field is shown here because keys stay in the
Windows Credential Manager and are configured in the reader. Screenshot: `artifacts/desktop-chat-polish.png`. `parse_sse_delta` has a unit test for real deltas, `[DONE]`,
ping and non-JSON lines.
Still open: tool calls, selecting another page, and an agent/list picker; endpoint and model are now
editable text fields rather than a catalogue. Without a configured provider the view shows the provider
error inline.

## Preview signature

`scripts/sign-preview.ps1 -Exe <path> -Create` creates a CurrentUser code-signing certificate, exports
the PFX under `artifacts/` (never committed), signs with SHA-256 and a timestamp, and prints the
signature status. The packaged executable launched after signing and rendered a fresh library
(`artifacts/desktop-signed-release.png`). `Get-AuthenticodeSignature` reports `UnknownError` with
"terminated in a root certificate which is not trusted"; this is expected for a self-signed preview.
A trusted release still needs a CA-issued certificate; the private key and PFX are not in Git.

## Limits

- The release is portable, not an installer; it is self-signed and not trusted by Windows until a CA certificate is used.
- The Chrome native-messaging host is included, but Chrome registration is a separate user step (`install-native-host.ps1`).
- Translation is off until a provider is configured; no live provider was called.
- One fixture, one window size (1679x950), one DPI.
