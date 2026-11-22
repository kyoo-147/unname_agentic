# Development guide

This is the workspace guide for building and verifying Mirror PDF. The product overview is the root [README](../README.md).

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

- `pnpm test:extension` runs the extension-owned viewer, OCR, export and bridge behavior tests.
- `pnpm build` then `CHROME_PATH=<Chrome-or-Chromium-executable> pnpm test:e2e:extension` runs `extension/playwright.config.ts` against the built, unpacked `dist/extension` MV3 artifact. It fails closed when the build, executable, or Playwright package is missing. Every spec launches a fresh temporary Chrome profile, closes it, and removes that profile. No standalone Vite server or `dist/web` is used.
- The extension lane discovers 42 real Playwright cases against the built, unpacked MV3 artifact: manifest/service-worker startup, local PDF import and page navigation, persisted UI locale, all popup target-language options and invalid-value fallback, reading-mode and panel controls, keyboard/accessibility semantics, empty-export warnings, and synthetic capture-reader handoff. Synthetic capture does not prove screenshot permission or native-host roundtrip. Native Save As chrome, reconnect/checksum/duplicate-message behavior, packaged-host registration, and Chrome-to-native transfer remain unsupported by this lane and require the real packaged host and browser environment. Record `RELEASE_BROWSER_E2E_TESTS` only after a real clean-profile Chrome run against the packaged native host, with the run output and revision captured; it is not set by this local command.
- `pnpm typecheck` checks the TypeScript sources.
- `pnpm build` creates the unpacked MV3 extension artifact with its extension-owned viewer. It empties `dist/extension` first, so a stale bundle cannot ship beside a fresh one.
- `pwsh -File scripts/verify-release.ps1` is the extension/native artifact gate (extension tests, typecheck, build, committed imports and built-artifact references).
- `node scripts/check-committed-imports.mjs [rev]` resolves every relative import against the files committed at that revision. It exists because a local green build cannot catch a committed file importing a module that was never added.
- `pwsh -File scripts/build-windows.ps1 -Action test` runs native tests with the MSVC environment.
- `pwsh -File scripts/build-shell.ps1 -Release` builds the current GPUI native release. Native builds need a Developer shell so `rc.exe` exists; plain `cargo build` fails with "Windows SDK rc.exe is required".
- The backend `reference-shell` Cargo feature is opt-in for the retired egui diagnostic executable.

### Disk layout on this machine

`D:` is nearly full, so two large generated trees live on `C:` behind NTFS junctions and every path above keeps working:

| Path | Real location | Why |
| --- | --- | --- |
| `native-shell/target` | `C:\mirror-store\native-target` | a debug GPUI dependency tree is about 4 GB; on `D:` it left 0 bytes free and broke `pnpm test:extension`, `pnpm build` and the native build with ENOSPC |
| `artifacts/` | `C:\mirror-store\artifacts` | screenshots, logs and measurement runs (gitignored either way) |

They are junctions, so `git` and the scripts see the normal path. Move them back with `cmd /c rmdir native-shell\target` then a real move when `D:` has space again. Keep one cargo profile: mixing `CARGO_PROFILE_DEV_DEBUG=0` builds with default ones makes every rebuild recompile the whole graph.


Generate the PDF fixtures with `node scripts/fixtures.mjs`. Tests use generated documents rather than redistributing third-party papers.

### Seeing a translation without any API key

The desktop app has no built-in translation engine of its own: it calls a provider. If you have no key and no local model, run the keyless bridge and point the app at it:

```powershell
node scripts/translate-bridge.mjs --verbose          # http://127.0.0.1:4400/v1
```

Then in the reader: **Ngôn ngữ / Language → tab Cục bộ (Local) → endpoint `http://127.0.0.1:4400/v1` → model `translate-bridge` → Lưu**. Open a page and the visible region translates; the bridge reports `/health` counters so you can see the blocks it served.

The bridge translates with MyMemory's public API first and Google's public `gtx` endpoint as a fallback. Both are free web endpoints, not licensed translation APIs, and MyMemory's anonymous quota is small — this is for demos and for testing the product end to end. For real work use a provider key (Google Cloud, DeepL, OpenAI-compatible) or a local model such as Ollama; the app speaks the same protocol to all of them.


## Verification status

The native GPUI shell is the product surface. The extension-owned viewer has a passing local unit suite and build; real Chrome↔native browser E2E, native packaging and signing remain separate evidence gates. `docs/feature-board.md` carries one row per feature with the evidence behind it and is the honest source of truth; `docs/feature-plan.md` and `docs/roadmap.md` are the older plans.

Known limits, stated rather than hidden:

- Source-glyph removal and preserved chart pixels pass on the generated digital PDF. This is not fidelity proof for scans, clipped text, Type 3 fonts, textured backgrounds, or arbitrary languages.
- GitHub Actions cannot run on this repository: every workflow, including a trivial six-line probe, fails at startup because the account is locked for a billing issue. Re-verified on 2026-11-20 **after the repository became public**: `gh workflow run ci` creates a run, both jobs are created, and GitHub rejects each one with "The job was not started because your account is locked due to a billing issue." Making the repository public does not lift the lock, and no workflow change can. The gate scripts still run locally and are wired into `ci.yml`, so the day Billing is fixed CI starts working with no code change.
- The native GPUI shell builds and runs on this machine now (the earlier "cannot build" note was the disk; `native-shell/target` moved to `C:` behind a junction). What is genuinely unverified is narrower: the live-mirror capture path, the Chrome↔desktop bridge end to end, and any cloud translation quality.
- RTL and CJK rendering is proven for translated regions (Arabic and Chinese targets); a source PDF that itself contains an RTL script is not in the fixtures.

See `docs/product-contract.md`, `docs/implementation-plan.md`, `docs/feature-board.md` and `docs/decisions.tsv` for the requirements, architecture choices, evidence trail and current status.