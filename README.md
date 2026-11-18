# PDF translation workspace

This project contains a Chrome extension and a native Rust Windows desktop application. The visible desktop title is Documents until a product name is selected.

## Open the desktop preview

Run `pwsh -File scripts/build-shell.ps1`, then `pwsh -File scripts/preview-shell.ps1`. The current UI is the user-approved native GPUI shell in `native-shell`, with custom Windows titlebar controls. The older egui executable is a retired reference, not the product UI.

To import an initial PDF, add `-Pdf <path>` to the preview command. `-LayoutSamples` opens a separate, explicitly labeled layout-only preview. The application uses the packaged PDFium runtime under `desktop/runtime/bin` during development. A portable release must include the DLL beside the executable and its license notices.

The Home view contains locally imported PDFs. Open a PDF for paired reading, or choose a window or display for local capture and OCR. Configure a translation provider before translating. No translation model or cloud quota is included.

## Load the Chrome extension

1. Run `pnpm install` and `pnpm build`.
2. Open `chrome://extensions` and enable Developer mode.
3. Choose Load unpacked and select `dist/extension`.
4. Open the extension popup and enable automatic mirrors.
5. Navigate to a PDF. The extension keeps the source tab and opens a paired reader beside it.

The extension requests source-host access for discovery and authorized PDF fetching. Local file URLs additionally require Chrome's Allow access to file URLs setting. Unsupported protected or opaque sources show an error rather than bypassing access restrictions.

## Link Chrome to the desktop

The extension remains usable without the desktop. For the opt-in companion, build `pdf-workspace-host` from `desktop/Cargo.toml`, keep the desktop open, then register that exact host executable for the installed extension ID with `scripts/install-native-host.ps1`. The extension popup exposes **Open in desktop** and **Stop desktop synchronization**. A source-bound transfer is checksum-verified before import, and browser page/position updates follow the retained PDF. No host registration is performed automatically by builds or tests. See `docs/native-bridge.md` for the exact command and data/privacy boundaries.

## Configure translation

Open Translation settings. Local mode supports a running OpenAI-compatible loopback server, such as Ollama's `/v1` endpoint. Google Cloud Translation and DeepL require their API credentials. OpenAI-compatible cloud endpoints require an API key. Cloud transfer is disabled until explicitly allowed.

The deterministic endpoint in `scripts/test-provider.mjs` is a test fixture, not a real translator. It must not be used as evidence of translation quality.

## Develop and verify

- `pnpm test` runs browser-core and extension behavior tests.
- `pnpm typecheck` checks the TypeScript sources.
- `pnpm build` creates the web and unpacked extension artifacts.
- `pnpm test:e2e` checks a real PDF, local fixture-provider integration, source-glyph removal, preserved chart pixels, provider errors, and automatic extension detection in isolated Chromium.
- `pwsh -File scripts/build-windows.ps1 -Action test` runs native tests with the MSVC environment.
- `pwsh -File scripts/build-shell.ps1 -Release` builds the current GPUI native release.
- The backend `reference-shell` Cargo feature is opt-in for the retired egui diagnostic executable.

Generate the PDF fixtures with `node scripts/fixtures.mjs`. Tests use generated documents rather than redistributing third-party papers.

## Verification status

Browser source-glyph removal and preserved chart pixels pass on the generated digital PDF. This is not universal fidelity proof for scans, clipped text, Type 3 fonts, textured backgrounds, or arbitrary languages. Complex cases retain source access and expose a paired reading view.

Native PDF smoke checks and interactive desktop operation are recorded under `desktop/proof` and the native guide. Live cloud provider quality, mixed-DPI capture, protected viewers, and complete multilingual OCR coverage remain separate acceptance checks.

See `docs/product-contract.md`, `docs/implementation-plan.md`, and `docs/decisions.tsv` for the requirements, architecture choices, and evidence trail.
