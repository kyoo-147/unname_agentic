# Desktop verification: Home and Reader in Vietnamese, English and Chinese

Date: 2026-11-18 (Asia/Ho_Chi_Minh)
Build: native `pdf_workspace` dev profile, `C:\cargo-target-mirror\debug\pdf_workspace.exe`,
40,182,784 bytes, final timestamp 2026-11-18 08:47:44 (see build provenance below).
Fixture: `tests/fixtures/mirror-field-notes.pdf` (6,177 bytes, 4 pages).
Platform: Windows, native GPUI app.

This run used window captures only (`PrintWindow`, `MODE=printwindow`), with no screen fallback,
no mouse clicks and no cursor movement. No `git` command was run.

## Verdict

**ISSUES.** All six requested views rendered and the interface language is clearly correct in
Vietnamese, English and Chinese. Two defects remain:

1. **First-import reader frame is blank at 18 seconds** in all three locales. The PDF is imported,
   but the document area paints nothing at 18s; a 25s retry on the already-imported library renders
   the reader. A warm launch at 18s also renders, so this is first-import latency, not a permanent
   blank or a capture failure.
2. **An English diagnostic suffix is still visible in the Vietnamese and Chinese reader footer**:
   `PDF text removed; artwork retained. Inspect complex clipping and raster text.` It is produced by
   `desktop/src/pdf.rs:64` and displayed by the native reader without translation.

No BLOCKED condition: the reader rendered on the retry in every locale, and all final screenshots
are non-blank. No text truncation was observed at the tested window size.

## Commands and results

Environment for both Rust gates:

```powershell
$env:CARGO_TARGET_DIR='C:/cargo-target-mirror'
$env:CARGO_PROFILE_DEV_DEBUG='0'
$env:CARGO_PROFILE_TEST_DEBUG='0'
$env:CARGO_INCREMENTAL='0'
```

Visual Studio environment:
`C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat -arch=x64 -host_arch=x64`.

### Desktop backend gate

```powershell
cmd /c "call ""C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat"" -arch=x64 -host_arch=x64 >nul && cargo test --manifest-path desktop/Cargo.toml -j 4"
```

Exit code **0**. The target directory was not locked; the first attempt succeeded.
`Finished test profile [unoptimized] target(s) in 40.06s`.

| Test target | Result |
|---|---|
| `mirror_pdf_desktop` unit tests (`src/lib.rs`) | 0 passed, 0 failed |
| `pdf_workspace_host` unit tests (bin) | 0 passed, 0 failed |
| `tests/contracts.rs` | 8 passed, 0 failed |
| `tests/native_host.rs` | 8 passed, 0 failed |
| `tests/pdf_runtime.rs` | 1 passed, 0 failed |
| `tests/providers.rs` | 3 passed, 0 failed |
| Doc-tests | 0 passed, 0 failed |
| **Total** | **20 passed, 0 failed, 0 ignored** |

The full log is `artifacts/desktop-verify/desktop-cargo-test.log`.

### Native rebuild

The i18n worker's marker first appeared at 2026-11-18 08:46:06, but the worker saved
`pdf_reader.rs` and `view.rs` again at 08:47:12 and rewrote the marker at 08:48:04. The build command
was run at 08:47:03 against the source state then on disk:

```powershell
cmd /c "call ""C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat"" -arch=x64 -host_arch=x64 >nul && cargo build --manifest-path native-shell/Cargo.toml -p pdf_workspace -j 4"
```

Exit code **0**, `Finished dev profile [unoptimized] target(s) in 14.12s`, 36 pre-existing warnings.
Full log: `artifacts/desktop-verify/native-build.log`.

The worker rebuilt after its 08:47:12 saves. The final binary is
`C:\cargo-target-mirror\debug\pdf_workspace.exe`, 40,182,784 bytes, timestamp
2026-11-18 08:47:44. All reader captures and the English/Chinese Home captures used that final
binary. The Vietnamese Home capture at 08:47:34 used the 08:47:03 binary; the only files saved after
it were `pdf_reader.rs` and `view.rs`, and the Home/sidebar/shortcuts/i18n sources were unchanged
after 08:46:14, so the Home evidence matches the final Home code.

The worker's report claims 47 discovered / 46 passed / 1 ignored for the native workspace; that is
the worker's own evidence, not re-run here. After the captures, the shared target directory
`C:/cargo-target-mirror` was removed externally. The screenshots and logs were already on
disk, and no further build was possible.

## Capture method

Each locale has its own library home, created before launch:

| Locale | `PDF_WORKSPACE_HOME` | `documents/preferences.json` |
|---|---|---|
| Vietnamese | `artifacts/desktop-verify/home-vi` | `{"lang":"vi"}` |
| English | `artifacts/desktop-verify/home-en` | `{"lang":"en"}` |
| Chinese | `artifacts/desktop-verify/home-zh` | `{"lang":"zh"}` |

For each locale: launch the app, wait 10s for Home, capture, close; launch again with
`tests/fixtures/mirror-field-notes.pdf` as the startup argument, wait 18s, capture the reader, close.
The capture and close commands were:

```powershell
pwsh -File artifacts/verify-2026-11-09/win-capture.ps1 -Action capture -ProcessId <pid> -Out <path>
pwsh -File artifacts/verify-2026-11-09/win-capture.ps1 -Action close -ProcessId <pid>
```

The reader was blank at 18s on the first launch in every locale. Each reader was retried once on the
same already-imported home with a 25s wait. The blank first frames are preserved as
`desktop-reader-{vi,en,zh}-attempt1-blank.png`; the six final screenshots use the successful frames.
A third, diagnostic warm launch in Vietnamese at 18s also rendered and is byte-identical to the
25s Vietnamese retry (`desktop-reader-vi-warm18.png`).

## Six screenshots

All images are 1679x950 window captures.

| View | Locale shown | Path |
|---|---|---|
| Home | Vietnamese | `artifacts/desktop-verify/desktop-home-vi.png` |
| Reader | Vietnamese (UI), source content English | `artifacts/desktop-verify/desktop-reader-vi.png` |
| Home | English | `artifacts/desktop-verify/desktop-home-en.png` |
| Reader | English | `artifacts/desktop-verify/desktop-reader-en.png` |
| Home | Chinese | `artifacts/desktop-verify/desktop-home-zh.png` |
| Reader | Chinese (UI), source content English | `artifacts/desktop-verify/desktop-reader-zh.png` |

The final reader files were produced by the 25s retry. The 18s first-import frames are the preserved
blank attempts listed above.

## Visual inspection

### Home

- **Vietnamese:** sidebar and empty state are Vietnamese: `Trang chủ`, `Phản chiếu trực tiếp`,
  `Dịch thuật`, `Tài liệu của tôi`, `Thùng rác`, `Cài đặt`; greeting and composer are Vietnamese.
  The former `Live mirror` label is now `Phản chiếu trực tiếp` and fits the sidebar row.
- **English:** `Home`, `Live mirror`, `Translate`, `Trash`, `Settings`, with the English greeting and
  composer.
- **Chinese:** `主页`, `实时镜像`, `翻译`, `回收站`, `设置`, with the Chinese greeting and composer.
- No clipped labels, overlapping text or missing glyphs were visible in the three Home views.

### Reader

- **Vietnamese UI:** `Ngôn ngữ / nhà cung cấp`, `Chỉ bản dịch`, `Tạm dừng`, `Thử lại`,
  `PDF cục bộ · 4 trang · bản gốc được giữ trong thư viện`,
  `BẢN GỐC · chọn vùng liên kết`, `BẢN DỊCH · vi · vùng chọn liên kết`. The left and right pane
  headers fit their rows.
- **English UI:** `Language / provider`, `Translation only`, `Pause`, `Retry`,
  `Local PDF · 4 pages · original retained in your library`, `ORIGINAL · linked region selection`,
  `TRANSLATION · vi · linked selection`.
- **Chinese UI:** `语言 / 提供方`, `仅译文`, `暂停`, `重试`,
  `本地 PDF · 4 页 · 原文件保留在你的文档库中`, `原文 · 联动区域选择`,
  `翻译 · vi · 联动选择`.
- The PDF page, chart and page furniture render in both panes in all three locales. The document
  body is the fixture's English source because no translation provider is configured; the footer
  says translation is off. This is not evidence of translation quality or of a translated pane.
- The translation target remains `vi` in all three UI locales. That is the current default, not a
  rendering defect, but it is a product-behavior question for English and Chinese users.

### Blank-frame check

A sampled ink measurement of the main pane (right of the sidebar) gives:

| Frame | Main-pane non-background pixels |
|---|---|
| Home, all locales | 1.72% to 1.95% |
| Reader final, all locales | 26.71% |
| Reader 18s first-import attempts | **0.00%** |

The blank attempts show the sidebar and window chrome but a uniform white document area, so they are
true blank reader frames, not a failed window capture. The 25s retries and the warm 18s launch prove
the reader surface can render.

### Defects

| Severity | Defect | Evidence |
|---|---|---|
| Medium | First launch with a new PDF is blank at 18s in all three locales; reader renders after a 25s retry on the imported library, and on a warm 18s launch | Three preserved blank attempts with 0.00% main-pane ink; three non-blank retries; `desktop-reader-vi-warm18.png` has the same SHA-256 as the vi retry |
| Low | English footer suffix `PDF text removed; artwork retained. Inspect complex clipping and raster text.` remains visible in Vietnamese and Chinese | `desktop-reader-vi.png`, `desktop-reader-zh.png`; source at `desktop/src/pdf.rs:64` |

No text truncation was visible at 1679x950. The Vietnamese reader footer is long and ends close to
the right edge, so truncation at the 980px minimum window width is a residual risk that this run did
not test.

## Evidence files

All under `artifacts/desktop-verify/`:

- `desktop-cargo-test.log` — desktop gate, 20 passed / 0 failed, exit 0.
- `native-build.log` — native rebuild, exit 0, 36 warnings.
- `desktop-home-vi.png`, `desktop-reader-vi.png`
- `desktop-home-en.png`, `desktop-reader-en.png`
- `desktop-home-zh.png`, `desktop-reader-zh.png`
- `desktop-reader-vi-attempt1-blank.png`, `desktop-reader-en-attempt1-blank.png`,
  `desktop-reader-zh-attempt1-blank.png` — 18s first-import blanks.
- `desktop-reader-vi-retry.png`, `desktop-reader-en-retry.png`, `desktop-reader-zh-retry.png`
- `desktop-reader-vi-warm18.png` — warm-launch diagnostic.

Raw screenshot hashes (SHA-256):

| File | SHA-256 |
|---|---|
| `desktop-home-vi.png` | `43F62320F44EBA7C11A0878A8559B4D16135BACC009A7E0ECA02E0D1A25C46AA` |
| `desktop-reader-vi.png` | `EE2FB9F94AC02C300C0FC77D2EDDE9EECB30B794E15641D96B01CE2F26A7E895` |
| `desktop-home-en.png` | `E78B4C10CDE370570971392A52F290B0D18FAA7131237F83D4B7EA5D91BAC430` |
| `desktop-reader-en.png` | `3CB5032F7AF40B45A6D4842DAFB66E63866AC43E14AB1CE32B0F6DE3D31F900E` |
| `desktop-home-zh.png` | `B9794DEB9D62FE09BFC16A4A3D317F3BFB130CF98560C3BFB2075F800C6A820D` |
| `desktop-reader-zh.png` | `70981E1D7F48C71D5DE4AABF77165329BE887E896A72E52CCBD09062AE897325` |

## Limits

- Dev build only; the packaged release executable was not tested.
- One fixture, one window size (1679x950), one DPI. The 980x620 minimum window size was not tested.
- Translation was off (no provider configured), so this run does not verify translation quality,
  OCR, live mirror or provider behavior. The right-pane body staying English is expected in this
  state.
- The first-import blank is a timing observation between 18s and 25s; the exact cold-start threshold
  was not measured.
- No mouse or cursor input was used, by design. Navigation was limited to the startup argument and
  window capture/close.
