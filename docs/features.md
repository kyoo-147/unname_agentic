# Chức năng và trạng thái xác minh

Cập nhật: **2026-11-22**, code checkpoint `746afa0` (`fix(native): mount export menu and ignore build outputs`). `native-shell` là bề mặt sản phẩm; `dist/extension` là artifact duy nhất của Chrome extension. `dist/web` không phải artifact được chấp nhận.

## Bằng chứng hiện tại tại code checkpoint `746afa0`

| Nhóm / cổng | Bằng chứng chạy lại | Trạng thái |
|---|---|---|
| Native unit tests | `cargo test`: 180 pass, 2 ignored | ✅ local |
| Native release build | `cargo build --release -j 1` với Windows SDK `rc.exe` | ✅ local |
| Native messaging host | `cargo build --release --manifest-path desktop/Cargo.toml --bin pdf-workspace-host -j 1` | ✅ local build |
| Extension | 170 files, 3,092 tests pass; typecheck/build pass | ✅ local |
| UI string gate | 37 native files, 0 literals cần sửa | ✅ local |
| Committed imports | 391 files resolve | ✅ local |
| Native package | `scripts/package-native.ps1` + `verify-release.ps1 -ArtifactsOnly -RequireNativePackage`; 1,013 package files | ✅ integrity/provenance |
| Desktop PDF runtime | `desktop/tests/pdf_runtime.rs`: 1 pass; fixture path points to extension fixture | ✅ local |
| Native desktop E2E | `--list`/`--mock-contract` pass; `--acceptance` fails closed | 🟡 blocked |

Native document-intelligence wiring is now mounted in the visible desktop surface: local lexical RAG/citation chat navigation, persisted local research cards and RIS import/export, local OCR/markup derivation with explicit partial status, and translated-PDF Save As with source-hash/page-geometry checks. The translated PDF remains a new text-only artifact and does not preserve source artwork or embed Helvetica.

Remaining release blockers are explicit: real Chrome/native-host E2E and OS desktop assertions lack `CHROME_PATH`, authored FDL assertions, registered host/origin and independent PDF-reader review; PR #35 CI is blocked/unstable; signing and registry verification remain unconfigured; K10/RBAC remains deferred. These facts are not inferred from unit tests or package integrity.

Các mục cũ bên dưới là inventory lịch sử; checkpoint hiện tại chỉ ghi bằng chứng đã chạy lại, không suy diễn thành kiểm thử native/browser E2E hoặc release acceptance.

Ký hiệu: ✅ có mã **và** có bằng chứng chạy · 🟡 có mã nhưng thiếu test/UX hoặc còn giới hạn đáng kể · ⬜ chưa có.



## Wave 3 historical integration checkpoint (2026-11-21)

The table below is retained as historical inventory evidence, not final-HEAD evidence.

| Nhóm | Bằng chứng hiện có | Trạng thái |
|---|---|---|
| OCR visual/selective | commit `aea0a31`; 3 file, 11 test focused pass; benchmark multilingual/dewarp/handwriting vẫn thiếu | 🟡 |
| RAG semantic boundary/selection | commit `a64fc93`; 8 test focused pass; offline/no-provider là trạng thái rõ ràng, không tạo embedding | ✅ local slice |
| Workflow K03-K09 | commit `70f3c88`; full unit suite cùng branch pass; K10 deferred | ✅ local slice |
| Research J01-J10 | commits `058c5ad` ancestor + `32540f9`; worker report ghi 179 test targeted pass | ✅ local slice |
| Native export/IR | commit `0fc7e11`; worker report ghi 151 pass, 2 ignored; chưa rerun dưới disk gate hiện tại | 🟡 |
| Bridge reconnect/annotation | commit `fab6a93`; worker report ghi 10 native-host + 42 extension tests pass; chưa có Chrome↔Rust/OS roundtrip | 🟡 |
| Security/release policy | commit `5ef1511`; full local quality evidence and license check pass | ✅ local slice |

## Historical release checkpoint (2026-11-21)

The table below records the older release checkpoint and does not replace the final-HEAD limits above.

| Hạng mục | Bằng chứng hiện có | Trạng thái |
|---|---|---|
| Web typecheck/unit/build/imports | 3.023 tests, typecheck, build, `verify-release.ps1 -ArtifactsOnly` pass | ✅ local |
| Playwright | 51 tests declared; full current run not claimed | 🟡 |
| Native Cargo/GPUI | worker evidence only; current integration rerun blocked by resource/toolchain gate | 🟡 |
| Native release package | no package artifact recorded | ❌ blocked |
| Changelog and third-party notices | checked-in notices and release files present | ✅ local |
| GitHub Actions | billing/runner block remains external | 🟡 external |

---

---

## 1. Web reader lịch sử — đọc và dịch PDF trong trình duyệt (30)

Inventory này mô tả web reader cũ, không phải bề mặt sản phẩm hiện tại.

| | Chức năng | | Ghi chú |
|---|---|---|---|
| A01 | Mở PDF, kéo thả, chọn nhiều tệp | ✅ | e2e: 2 tệp cùng lúc, drop thật bằng DataTransfer |
| A02 | Render PDF.js giữ tỉ lệ trang | ✅ | e2e so width gốc = width bản dịch |
| A03 | Trích block chữ + toạ độ | ✅ | rect chính xác trong unit test |
| A04 | Xoá glyph gốc dưới chữ đã dịch | ✅ | đo pixel: mực gốc >100, mực bản dịch = 0 |
| A05 | Giữ ảnh/biểu đồ/vector | ✅ | 0 pixel lệch ở vùng biểu đồ |
| A06 | Hai pane + kéo chia + reset 50/50 | ✅ | e2e bấm phím trên splitter |
| A07 | Đồng bộ trang với tab nguồn | ✅ | e2e với extension thật: cuộn tab nguồn → viewer nhảy theo |
| A08 | Dịch ưu tiên vùng nhìn thấy | ✅ | scheduler: selection < visible < prefetch |
| A09 | Dịch toàn bộ, dừng được | ✅ | e2e: Stop giữa tài liệu → tối đa 2 trang, nhãn hồi |
| A10 | Pause / resume / retry | ✅ | journey 02/03; Retry quét **mọi trang đã render** |
| A11 | Chọn vùng, đọc song song | ✅ | e2e click vùng + focus trap |
| A12 | Fit chữ, không cắt âm thầm | ✅ | 300 ký tự → cờ overflow, không mất chữ |
| A13 | Cache + dedupe request | ✅ | 4 request đồng thời → 1 lần gọi |
| A14 | 4 provider: Google, DeepL, OpenAI, local | ✅ | payload từng provider; local phải loopback |
| A15 | Consent cloud | ✅ | chưa bật → không gọi mạng |
| A16 | Trạng thái lỗi/đang tải | ✅ | e2e lỗi provider 400 |
| A17 | Thư viện giữ qua reload | ✅ | IndexedDB + e2e reload khôi phục |
| A18 | Giao diện vi/en/zh | ✅ | 3 bộ khoá khớp nhau + e2e chụp 3 ngôn ngữ |
| A19 | Glossary theo provider | ✅ | journey 11: thuật ngữ vào request; Google/DeepL nói rõ không nhận |
| A20 | Tự nhận diện ngôn ngữ nguồn | ✅ | e2e: gợi ý không ghi đè lựa chọn |
| A21 | Danh sách ngôn ngữ đích | ✅ | 14 ngôn ngữ, tên bản địa |
| A22 | Mục lục, thumbnail, nhảy trang | ✅ | e2e cả 3 đường |
| A23 | Tìm trong tài liệu | ✅ | e2e gõ → kết quả → nhảy + highlight |
| A24 | Xoay trang, fit width/page | ✅ | journey 04 là cổng cứng, xoay 90/180/270/360 vẫn giữ bản dịch |
| A25 | Lưu vị trí/zoom/ngôn ngữ | ✅ | e2e reload về đúng trang 3 + UI tiếng Anh |
| A26 | Xuất bản dịch (TXT/PDF) | ✅ | `src/export/pdf.ts`: PDF thật bằng pdf-lib (ảnh trang gốc + che vùng + chữ dịch), round-trip đọc lại bằng pdfjs; 31 test + nút "Tải PDF thật". Font Unicode đang bổ sung (H02) |
| A27 | OCR ảnh chụp → block → dịch | 🟡 | e2e OCR thật + PDF scan; model chỉ có vi/en/zh/ja/ko, chưa benchmark ảnh nghiêng/mờ |
| A28 | RTL và CJK trong vùng dịch | 🟡 | e2e target Ả Rập (dir=rtl) + Trung (wrap, không tràn); **chưa có PDF nguồn RTL/CJK** |
| A29 | Phím tắt đọc | ✅ | e2e bấm j/k/+/−/Ctrl+F/Escape thật |
| A30 | Accessibility WCAG cơ bản | ✅ | 8 e2e: contrast đo 4.78–13.44:1, focus trap, skip link, reduced motion |

## 2. Chrome extension (13)

| | Chức năng | | Ghi chú |
|---|---|---|---|
| B01 | Tự phát hiện PDF (URL, MIME, embed/object/iframe) | ✅ | unit cho embed/object/iframe + e2e MIME-only trong Chrome thật |
| B02 | Một mirror mỗi nguồn | ✅ | test mở 1 lần, mở lại khi tab chết, sống qua worker restart |
| B03 | Fetch bytes kiểm `%PDF-` + quyền host | ✅ | từ chối trang login/chrome://blob:, cap 100 MiB |
| B04 | Popup bật/tắt + ngôn ngữ đích | ✅ | e2e: chọn EN → reader English + request hỏi đúng ngôn ngữ |
| B05 | Badge số mirror | ✅ | 2 → 1 → '' |
| B06 | Capture tab → mirror ảnh | ✅ | e2e với extension thật: viewer `?capture=1`, OCR >5 card, 1 card done |
| B07 | Gửi PDF sang desktop | 🟡 | 14 test native-messaging (chunk, sha256, binding); **chưa chạy cặp Chrome ↔ host thật** |
| B08 | Đồng bộ 2 chiều với desktop | 🟡 | hai nửa có test, chưa có demo app desktop thật điều khiển reader thật |
| B09 | Context menu "Mở bản dịch" | ✅ | 5 nhánh: page/linkUrl/MIME-only/không phải PDF/focus mirror cũ |
| B10 | Phím tắt bật/tắt mirror | ✅ | manifest + test chord |
| B11 | Popup 3 ngôn ngữ | ✅ | dùng chung bộ khoá i18n |
| B12 | Nguồn login/blob/protected xử lý thẳng thắn | ✅ | báo lỗi, không bypass |
| B13 | Quyền tối thiểu | ✅ | test pin đúng danh sách + lý do từng quyền |

## 3. Native desktop — Rust + GPUI (25)

| | Chức năng | | Ghi chú |
|---|---|---|---|
| C01 | Shell GPUI, titlebar tự vẽ | ✅ | chạy thật, ảnh chụp, không viền OS |
| C02 | Nhập PDF, lưu bytes, thumbnail | ✅ | 6 test; source + thumbnail PNG + key sha256 |
| C03 | Thư viện: rename, pin, favourite, sort, search | ✅ | 5 test `pdf_library` (xoá/khôi phục/purge, biên 29/31 ngày, rename+pin+star sống qua reload) + UI có sẵn |
| C04 | Thùng rác: xoá/khôi phục/xoá vĩnh viễn | ✅ | `purge_expired` chạy mỗi lần mở app; chứng minh runtime: bản ghi xoá 31 ngày biến mất lúc khởi động (1 → 0 thư mục) |
| C05 | Reader 2 pane PDFium, scroll đồng bộ | ✅ | 16 test geometry/state + ảnh chụp |
| C06 | Zoom, chuyển trang, nhảy trang | ✅ | bấm "1 / N" → ô nhập, gõ 42 rồi Enter → nhảy đúng trang 42/158; 4 test cho `parse_page_input` (0/âm/chữ/bị kẹp) |
| C07 | Dịch vùng nhìn thấy, pause/retry | ✅ | trang scan giờ **vẽ bản dịch** lên vùng nền phẳng (tô màu giấy dominant rồi vẽ chữ); vùng ảnh/logo (share < 0.55) vẫn để bảng song song — đo trên trang 5 của bản scan 158 trang |
| C08 | Cache + generation guard | ✅ | 5 test guard + cache ghi atomic |
| C09 | 4 provider + consent | 🟡 | 4 builder + consent; chưa test validate endpoint/consent |
| C10 | Credential vault Windows | 🟡 | `#[serde(skip)] api_key` + PasswordVault; chưa test |
| C11 | Live mirror + OCR Windows | 🟡 | OCR đo thật (312–1073 ms/trang); **live mirror chưa có lần chạy ghi lại** |
| C12 | Chống tự capture | 🟡 | WDA_EXCLUDEFROMCAPTURE chỉ cho capture toàn màn hình, chưa verify |
| C13 | Cầu Chrome ↔ desktop | 🟡 | inbox + 4 test; chưa chạy end-to-end, chưa test checksum sai |
| C14 | i18n native 3 ngôn ngữ | 🟡 | quality line + toast đã dịch; còn chuỗi tiếng Anh ở capture picker + bridge |
| C15 | 6 bảng màu + Light/Dark/System | 🟡 | 6 palette + segmented; chưa có test/ảnh chứng minh đổi màu thật |
| C16 | Phím tắt + màn hình Shortcuts | ✅ | vào từ Settings → Phím tắt **và** bằng Ctrl+/; liệt kê đúng binding thật (Ctrl+N, Ctrl+,, Ctrl+], Ctrl+J, F11, Ctrl+/) |
| C17 | Chat hỏi tài liệu | ✅ | streaming SSE, context trang được fence, lịch sử 100 tin; ảnh + 3 test |
| C18 | Chọn model cho chat | 🟡 | chỉ ô nhập endpoint+model, không có catalogue/agent |
| C19 | Voice input / voice mode | ✅ | `voice.rs`: state machine có test + WinRT `SpeechRecognizer` chạy trên thread riêng; nút mic bật/tắt, hiện "Đang nghe…", chèn vào composer; probe WinRT chạy thật, phiên mic thật chưa được kích hoạt tự động |
| C20 | OCR Tesseract dự phòng | ✅ | `ocr_fallback.rs`: Windows OCR trước, chỉ khi rỗng/lỗi mới gọi `tesseract ... tsv` (PATH hoặc `PDF_WORKSPACE_TESSERACT`); log `engine=windows|tesseract|none`; 10 test |
| C21 | Xoay trang native | ✅ | 2 test + ảnh chụp |
| C22 | Xuất bản dịch native | 🟡 | chỉ Markdown, ghi vào thư viện, không hộp thoại lưu, chưa e2e |
| C23 | Đóng gói + license + ký | ✅ | build **release** thật (3m56s, exe 22.76 MB) + đóng gói `dist/pdf-workspace-windows-x64-release-20261120-180552` (MANIFEST.json, pdfium.dll, 897 file notice, CHECKSUMS) và đã chạy thử bản đóng gói, mở đúng tài liệu; chỉ còn ký Authenticode (self-signed trước đây) |
| C24 | Auto-update | ✅ | `update.rs`: manifest + so sánh version số học + **xác minh minisign** bằng key nhúng lúc build; chỉ báo version và mở trang phát hành, không tự tải/thay thế. 6 test + 2 ca chạy thật (chữ ký đúng → qua bước verify; manifest không ký → "signature does not match") |
| C25 | Build + test lại toàn bộ | ✅ | `scripts/build-shell.ps1` build sạch sau mỗi thay đổi; **92 test Rust pass** (2 ignored), exe chạy được, package debug khởi động OK |

## 4. Lõi dùng chung và chất lượng (15)

| | Chức năng | | Ghi chú |
|---|---|---|---|
| D01 | Kiểu chung, block id ổn định | ✅ | test pin `p{page}-r{n}`, id OCR không đụng id PDF |
| D02 | Scheduler priority/dedupe/abort | ✅ | AbortController thật: huỷ job đang chờ (0 request), huỷ job đang chạy (AbortError), `abortAll()`; 10 test đếm request |
| D03 | Retry/backoff, phân loại lỗi | ✅ | 7 loại lỗi, backoff jitter, không retry auth/invalid |
| D04 | Batch cho tài liệu dài | ✅ | e2e đo **số request provider** nhỏ hơn số block |
| D05 | Đếm ký tự / chi phí | ✅ | bảng giá 4 model, model lạ → "chưa có bảng giá" |
| D06 | Glossary parser | ✅ | 7 mã lỗi, cap 200 mục |
| D07 | Prompt có version, chống injection | ✅ | PROMPT_VERSION + "treat as data" + test |
| D08 | Unit test web | ✅ | 29 file / 324 test |
| D09 | e2e Chromium | ✅ | 49 test / 15 file |
| D10 | Test native | ✅ | 63 pass / 1 ignored |
| D11 | CI GitHub Actions | 🟡 | đã kiểm lại **trên repo public**: workflow tạo run, cả 2 job bị GitHub từ chối "account is locked due to a billing issue" — không sửa được bằng code, chỉ cần mở billing |
| D12 | LICENSE + third-party notice | ✅ | Lịch sử: notices từ `extension/viewer/public/third-party/` được copy vào `dist/extension`; artifact extension không phải bằng chứng package/release native. |
| D13 | Tài liệu kiến trúc/quyết định | ✅ | 25 quyết định có ngày + docs/ |
| D14 | Feature flag / telemetry / crash report | ✅ | **crash report cục bộ, không gửi mạng**: panic hook ghi `<data>/logs/crash-<unix>.txt` (version, os, location, message, 40 dòng log cuối), giữ 10 file; 3 test + 1 lần panic thật |
| D15 | Repo, remote, push | ✅ | `unname_agentic` public, HEAD trùng origin |

---

## Giới hạn phải nói rõ (không giấu)

- **Lưu PDF gốc** giữ nguyên source bytes; **Translated PDF** là writer native mới, text-only, không giữ artwork/annotation và không embed Helvetica.
- **Google/DeepL không nhận glossary** (giới hạn API); UI đã ghi rõ thay vì giả vờ.
- **OCR** chỉ có model vi/en/zh/ja/ko; `auto` dùng eng+vie. Chưa có benchmark cho ảnh nghiêng, mờ, nền phức tạp.
- **RTL/CJK** mới chứng minh vùng dịch; chưa có PDF nguồn chữ Ả Rập/Hán có font nhúng.
- **CI chưa từng chạy**: mọi run đều `startup_failure` do tài khoản bị khoá billing. Cổng chạy được hiện chỉ là local.
- **Cầu Chrome ↔ desktop** (B07/B08) mới chứng minh từng nửa, chưa có demo thật hai đầu.
- **Trash 30 ngày**: đã có purge khi khởi động và test boundary; runtime UI/E2E vẫn chưa được claim.
- **Màn hình Shortcuts**: đã có đường vào từ Settings và Ctrl+/; screenshot/E2E hiện tại vẫn chưa được claim.

## Lệnh xác minh

```powershell
pnpm test:extension
pnpm typecheck
pnpm build                 # typecheck + extension artifact at dist/extension
powershell -NoProfile -File scripts/build-shell.ps1 -Test
node scripts/check-committed-imports.mjs
powershell -NoProfile -File scripts/verify-release.ps1
```

`dist/extension` is only the Chrome extension artifact. It does not establish native package or
release readiness; native-shell tests/package verification are separate.

## Đã làm xong trong đợt này (2026-11-20)

| | |
|---|---|
| C06 | Nhập số trang để nhảy — gõ 42 → đúng trang 42/158 |
| C07 | Trang scan vẽ bản dịch trên vùng nền phẳng |
| C03/C04 | 5 test thư viện/thùng rác + auto-purge 30 ngày, chứng minh bằng lần chạy thật |
| C16 | Màn hình Phím tắt mở được từ Settings và bằng Ctrl+/ |
| C19 | Voice input thật bằng Windows SpeechRecognition |
| C20 | OCR Tesseract dự phòng, log engine= |
| C24 | Update check có chữ ký minisign, không tự cài |
| D12 | Notice pdf.js/lucide nằm trong bundle |
| D14 | Crash report cục bộ, không gửi mạng |
| C23 | Đóng gói lại — **build release thật**, gói release đã chạy thử |

## Còn lại

1. **C23**: build **release** + đóng gói release — cần dọn ~3–4 GB trên `D:`/`C:`; script đã sẵn (`scripts/package-native.ps1`).
2. **D11**: CI chỉ chạy khi mở khoá billing của tài khoản GitHub; workflow đã đúng, không sửa được bằng code.
3. **Chất lượng dịch**: bridge keyless là để demo; muốn chất lượng thật cần key (Google Cloud/DeepL/OpenAI) hoặc Ollama.
4. **Ký Authenticode** cho bản release: hiện chỉ self-signed.