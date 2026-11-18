# Mirror PDF — final audit (2026-11-18)

Scope: the objective's five clauses and the release/package evidence. This is a verification record,
not a claim that every optional row in `docs/feature-plan.md` is finished.

## Reproduced on this machine

Web:

```powershell
pnpm typecheck          # clean
pnpm test               # 324 passed / 29 files
pnpm build              # web + Chrome MV3 extension
pnpm exec playwright test --trace off   # 49 passed
```

Native:

```powershell
$env:CARGO_TARGET_DIR='C:/cargo-target-release'
$env:CARGO_PROFILE_DEV_DEBUG='0'; $env:CARGO_PROFILE_TEST_DEBUG='0'; $env:CARGO_INCREMENTAL='0'
cargo test --workspace --manifest-path native-shell/Cargo.toml   # 51 passed, 1 ignored
cargo test --manifest-path desktop/Cargo.toml                    # 23 passed
```

Release package (signed preview):

- `dist/pdf-workspace-windows-x64-release-20261118-110746.zip`, 11.34 MB
- `pdf_workspace.exe`: 21,628,416 bytes, SHA-256 `6FCE99E53EBDAD67A2A3F4C434A8E3FEFA8B87C513D873EE504341AEF3818C6B`
- Zip SHA-256: `FA759D26E8829E2F4E27C831ECBFDF8AE0B58D5BEA2F3D99DF8B59700EAFB782`
- Signature: `CN=Mirror PDF Preview (self-signed)`, thumbprint `CB4361EDB01EC07A25F3EF5722831CCA12261FC3`;
  Authenticode status is `UnknownError` / untrusted root. A public CA certificate is still required
  for a trusted production signature.

## Objective evidence

| Clause | Evidence |
|---|---|
| Web/extension Vietnamese default | 49 e2e incl. `defaults to Vietnamese on a fresh profile`, extension language tests, locale switch |
| OCR capture | `scan-ocr` e2e (scanned PDF → OCR → translated callouts); native Windows OCR on `scanned-page.pdf` (`desktop-native-scan-ocr.png`) |
| Translation flow | provider/glossary/batch/RTL/CJK tests; e2e `translate-batch`, `rtl-cjk-render` |
| Reader UX | 49 journeys incl. import, navigation, rotation, print, a11y, capture; screenshots in `artifacts/` |
| Native rebuild + package | release exe + PDFium + companion host + licenses; first import in 15 s; signed preview runs (`desktop-signed-release.png`) |
| Per-round git | private `kyoo-147/mirror_trans_pdf`; public `kyoo-147/unname_agentic` |

## Known gaps (not hidden)

- CA-issued code-signing certificate (preview is self-signed and untrusted).
- Chat tool calls and an agent/model catalogue; endpoint/model are editable, history/context/SSE work.
- Real Chrome extension capture e2e (web capture path and scan OCR are covered; a browser-extension
  capture run is not automated here).
- Native Tesseract fallback when Windows OCR is unavailable; Windows OCR itself is verified.
- Desktop → Chrome location sync (B08) and GitHub Actions (billing-locked) remain open.
- GUI automation for sidebar click/typing is not part of the suite; posted clicks were unreliable.

## Artifact index

- `artifacts/desktop-signed-release.png` — signed package, fresh reader
- `artifacts/desktop-native-scan-ocr.png` — native OCR on a scanned page
- `artifacts/desktop-chat-context5.png` — chat with page context
- `artifacts/desktop-chat-stream3.png` — streaming answer
- `artifacts/desktop-chat-history.png` — history reload
- `artifacts/desktop-chat-config.png` — provider endpoint/model panel
- `docs/release-verification.md` — hashes, package contents, signing limits
