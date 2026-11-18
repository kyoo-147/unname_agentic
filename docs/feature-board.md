# Mirror PDF — bảng chức năng, tiến độ và plan dài hạn

Cập nhật: 2026-11-18 10:05 (Asia/Saigon) · Baseline đã push: `5b78dab`.
Nguồn: audit đọc mã thật từng file (3 auditor độc lập) + `pnpm test` / `typecheck` / `build` / `test:e2e` chạy thật, không lấy lời khai từ tài liệu cũ.

> `docs/feature-plan.md` và `docs/roadmap.md` thuộc phiên làm việc song song đang chạy; file này là bảng do phiên hiện tại rà độc lập và là nguồn chuẩn cho các lượt tiếp theo. Hai bên sẽ gộp lại khi phiên kia dừng.

## Cách đọc

| Ký hiệu | Nghĩa |
|---|---|
| ✅ | Có code **và** có bằng chứng chạy thật (test/e2e/ảnh chụp do phiên này xác nhận). |
| 🟡 | Có code nhưng thiếu test, thiếu UX, hoặc mới đúng một nửa. |
| ⬜ | Chưa có. |
| ⚪ | Không build/chạy được trên máy này (native: D: còn ~3.0 GB) → **chưa được coi là xong**. |

Số đo hiện tại (417e745): **310 unit test / 27 file** + **32 e2e pass / 0 fail** (chạy lại trong phiên), typecheck sạch, build ok. Ba con số này là mốc để phát hiện hồi quy; một test xanh **không** chứng minh được tính năng nếu đường UI không gọi tới nó — xem mục 1b.

**Cổng mới chống hồi quy "commit thiếu file"**: `scripts/check-committed-imports.mjs` resolve mọi import tương đối **trong chính commit** (không phải working tree) và đã bắt đúng sự cố thật hôm nay: `6b08e20` chứa `import('./ocr/scan')` nhưng `src/ocr/scan.ts` chưa được add → `main` build hỏng với người clone. Script chạy trong `verify-release.ps1` và trong CI.

---

## 1. Bảng chức năng

### A. Web reader (`src/`)

| | Chức năng | | Bằng chứng | Còn thiếu |
|---|---|---|---|---|
| A01 | Mở PDF, kéo thả, chọn nhiều tệp | 🟡 | `main.ts` input multiple; e2e `reader.spec.ts` mở fixture | Kéo thả chỉ lấy `files[0]`; không test drop, không test nhiều tệp (mỗi lần load thay tài liệu trước) |
| A02 | Render PDF.js giữ tỉ lệ trang | ✅ | `pdf/document.ts` renderPage; e2e so width gốc = width dịch | — |
| A03 | Trích block chữ + toạ độ | ✅ | `pdf/layout.ts` groupTextItems; `pdf-layout.test.ts` assert rect chính xác | — |
| A04 | Xoá glyph gốc dưới chữ đã dịch | ✅ | `document.ts` suppressTextContext; e2e pixel: ink gốc > 100, ink dịch = 0 | — |
| A05 | Giữ ảnh/biểu đồ/vector | ✅ | `main.ts` paintMirror; e2e 0 pixel lệch ở vùng biểu đồ | — |
| A06 | Hai pane + kéo chia + reset 50/50 | ✅ | `main.ts` splitter aria-valuenow; e2e ArrowRight → 52 | — |
| A07 | Đồng bộ trang/zoom với tab nguồn | 🟡 | `ui/bridge.ts`, `extension/background.ts`; test validator + router | Chưa có test chứng minh reader thật sự nhảy theo message |
| A08 | Dịch ưu tiên vùng nhìn thấy | ✅ | `scheduler.test.ts` selection < visible < prefetch | — |
| A09 | Dịch toàn bộ, có thể dừng | 🟡 | `main.ts` nút Translate all → vòng numPages | Không có test; "stop" chỉ reset queue, không chứng minh huỷ request đang bay |
| A10 | Pause / resume / retry lỗi | 🟡 | `main.ts` pause/resume/retry; e2e chỉ chứng minh nhánh lỗi | Không test pause/resume; retry chỉ xếp lại trang đang thấy (trang đã cuộn qua chết luôn) |
| A11 | Chọn vùng, đọc song song theo vùng | ✅ | e2e click `.source-region` → dialog; `a11y.spec.ts` focus trap | — |
| A12 | Fit chữ vào khung, không cắt âm thầm | ✅ | `pdf-layout.test.ts` (300 ký tự, CJK), fallback callout | — |
| A13 | Cache + dedupe request | ✅ | `translation.test.ts` cache hit, 4 request đồng thời → 1 call | — |
| A14 | 4 provider: Google, DeepL, OpenAI, local | ✅ | `translation.test.ts` payload từng provider, loopback-only | — |
| A15 | Consent cloud, chặn khi chưa bật | ✅ | `translation.ts` throw trước fetch; test fetcher không được gọi | — |
| A16 | Trạng thái lỗi/đang tải/mất nguồn | ✅ | e2e `#status.is-error`, canvas gốc vẫn hiện | — |
| A17 | Thư viện tài liệu (giữ qua reload) | ✅ | `core/library-store.ts` IndexedDB + `main.ts` wire + e2e `export-library.spec.ts` reload | — |
| A18 | Giao diện Việt/Anh/Trung | ✅ | `i18n.test.ts` parity 3 ngữ + mọi key `t()`/`data-i18n` resolve; e2e mặc định tiếng Việt | — |
| A19 | Glossary + áp dụng provider | 🟡 | parseGlossary (6 mã lỗi), prompt có glossary; test prompt; **đã sửa bug**: dòng glossary lỗi không còn nuốt provider/endpoint/ngôn ngữ (giữ glossary cũ + báo lỗi rõ) | Google/DeepL vẫn không nhận glossary (UI nói rõ); chưa có test UI cho đếm lỗi glossary |
| A20 | Tự nhận diện ngôn ngữ nguồn | 🟡 | `main.ts` showDetectedLanguage; detectLanguage có test | Gợi ý `#detected-language` không được test ở đâu |
| A21 | Danh sách ngôn ngữ đích có tên bản địa | ✅ | `language.ts` 14 ngôn ngữ; test pin nativeName | — |
| A22 | Mục lục, thumbnail, nhảy trang | 🟡 | `main.ts` outline/thumb/page input; helper có test | Chưa test append entry, thumbnail render, hay click nhảy |
| A23 | Tìm trong tài liệu | 🟡 | `main.ts` panel + debounce 250ms + abort; helper search có test | Không test gõ truy vấn → kết quả → nhảy |
| A24 | Xoay trang, fit width/page | 🟡 | helper có test; `main.ts` rotateView/applyFit | Không test click 3 nút; remap translation sau xoay chưa chứng minh |
| A25 | Lưu vị trí đọc/zoom/ngôn ngữ | 🟡 | encode/decode + key có test | Không có e2e reload → về đúng trang/zoom |
| A26 | Xuất bản dịch (TXT/PDF song ngữ) | ✅ | `export/bilingual.ts` 20 test; `main.ts` nối TXT + nút **Print / Save as PDF** (`printHtml` + Ctrl/Cmd+P); e2e `export-library.spec.ts` + `export-print.spec.ts` 2 test | Không có PDF writer nhị phân: PDF đi qua bộ in của trình duyệt nên mất bố cục gốc/ảnh — đã ghi rõ trong module |
| A27 | OCR ảnh chụp → block → dịch | ✅ | e2e `capture.spec.ts` OCR thật (3 block, 95–96%); **thêm OCR cho PDF scan**: `ocr/scan.ts` + e2e `scan-ocr.spec.ts` (PDF không có text vẫn OCR + dịch); preprocess một bản duy nhất (`ocr/preprocess.ts`) chạy trước Tesseract, toạ độ map ngược về ảnh gốc | Chỉ `eng+vie`; ảnh nghiêng/mờ chưa có benchmark |
| A28 | RTL và CJK trong vùng dịch | 🟡 | `text-direction.ts` + 11 test; `layout.ts` dùng detect | Chưa render một PDF RTL/CJK nào; `estimateLineUnits` là dead code |
| A29 | Phím tắt đọc | ✅ | `keyboardIntent` 20+ case + test mới `reader-keyboard.test.ts` (Home/End, j/k, +/-, w/f, o, /, Escape, modifier, ô nhập); `main.ts` dispatch đủ | Chưa có e2e bấm phím thật trong trình duyệt (chỉ unit) |
| A30 | Accessibility WCAG cơ bản | ✅ | `a11y.spec.ts` 8 test: focus trap, aria-live, reduced-motion, contrast 4.5:1 (đo thật) | — |

### B. Chrome extension (`extension/`)

| | Chức năng | | Bằng chứng | Còn thiếu |
|---|---|---|---|---|
| B01 | Tự phát hiện PDF (URL, MIME, embed/object/iframe) | 🟡 | background webRequest + tabs.onUpdated có test; e2e MIME | Nhánh DOM `content.ts` **0 test**, e2e không bao giờ chạy tới |
| B02 | Một mirror cho mỗi nguồn | ✅ | `extension.test.ts` open 1 lần, reopen khi tab mất, session sau restart | — |
| B03 | Fetch bytes có kiểm `%PDF-` + quyền host | ✅ | authorize theo tab, cap 100 MiB, test login page bị từ chối | — |
| B04 | Popup bật/tắt + trạng thái | 🟡 | `popup.ts` lưu `mirror:enabled`; **đã có select ngôn ngữ đích** (`extension/target-language.ts`, lưu `mirror:targetLanguage`) + test DOM; reader đọc lại và áp nếu hợp lệ (`main.ts`) | Chưa có e2e trong Chrome thật chứng minh reader nhận ngôn ngữ từ popup; chưa có ảnh chụp popup |
| B05 | Badge số mirror | ✅ | test badge 2 → 1 → '' và xoá khi đóng tab nguồn | — |
| B06 | Capture tab → mirror ảnh | 🟡 | reader + e2e web capture chạy thật | Chưa chạy chuỗi thật trong Chrome extension (captureVisibleTab → ?capture=1 → OCR) |
| B07 | Gửi PDF sang desktop | 🟡 | `native-bridge.ts` chunk 192 KiB + SHA-256, test byte-exact | Host binary không còn build được; đường Chrome thật chưa từng chạy |
| B08 | Đồng bộ trang/zoom 2 chiều | 🟡 | 2 chiều có code + unit test | Chưa chứng minh desktop thật điều khiển reader thật |
| B09 | Context menu "Mở bản dịch" | 🟡 | page URL có test | `linkUrl` và nhánh MIME-only chưa test |
| B10 | Phím tắt bật/tắt mirror | ✅ | manifest + test Ctrl+Shift+M / Ctrl+Shift+Y | — |
| B11 | Popup 3 ngôn ngữ | ✅ | dùng chung `i18n.ts`; test mọi key; bundle có dấu Việt + Hán | — |
| B12 | Nguồn login/blob/protected xử lý rõ | ✅ | 3 test từ chối trung thực, không bypass | — |
| B13 | Quyền tối thiểu | 🟡 | authorize theo tab có test | Manifest xin tabs + host all-site; chưa có test pin danh sách quyền |

### C. Native desktop (GPUI + Rust)

⚪ Toàn bộ bảng C **chưa verify được** trên máy này: D: còn ~3.0 GB, `native-shell/target` và `desktop/target` không tồn tại. Audit tĩnh 09:20 cho kết quả dưới đây; chỉ đánh ✅ khi build + test lại được.

| | Chức năng | | Trạng thái tĩnh | Ghi chú |
|---|---|---|---|---|
| C01 | Shell GPUI, titlebar tự vẽ | ⚪ | có code, 0 test | Chỉ có ảnh chụp `desktop-verify/native-build.log` |
| C02 | Nhập PDF, lưu bytes, thumbnail | 🟡 | `product_library.rs` 256MB cap + validate `%PDF-` | Không test `create_pdf_once` → chưa chứng minh giữ bytes/thumbnail |
| C03 | Thư viện: rename, pin, favourite, sort, search | 🟡 | `store.rs`, `app.rs` | `crates/library/src/store.rs` 412 dòng, **0 test** |
| C04 | Thùng rác: xoá/khôi phục/xoá vĩnh viễn | 🟡 | `trash.rs` | 0 test, kể cả hạn 30 ngày |
| C05 | Reader 2 pane PDFium, scroll đồng bộ | ⚪ | 16 test trong `geometry`/`state` | Không chạy được |
| C06 | Zoom, chuyển trang, nhảy trang | 🟡 | zoom 0.55–3.0, ±1 trang | **Không có nhảy trang** (ô "1 / 4" chỉ là text) |
| C07 | Dịch vùng nhìn thấy, pause/retry | 🟡 | `translate_visible`, toggle_pause/retry | Ảnh chụp duy nhất cho thấy "Dịch đang tắt", chưa từng render bản dịch |
| C08 | Cache + generation guard | ⚪ | 4 test guard + cache JSON atomic | Không chạy được |
| C09 | 4 provider + consent | ⚪ | `provider.rs` hardening, 3 test provider | Consent gate không có test riêng |
| C10 | Credential vault Windows | 🟡 | `#[serde(skip)] api_key`, PasswordVault | Doc nói "4 test secret" nhưng file đó 0 test |
| C11 | Live mirror + OCR Windows | 🟡 | `capture.rs` 40 region từng chạy | Chỉ OCR chính cửa sổ app, "translation: Not invoked" |
| C12 | Chống tự capture | ⚪ | `WDA_EXCLUDEFROMCAPTURE` | Chưa rà lại |
| C13 | Cầu Chrome ↔ desktop | ⚪ | checksum + chống trùng | Chưa rà lại |
| C14 | i18n native 3 ngôn ngữ | 🟡 | pass 1+2 đã commit (`8e850d1`) | Còn `localized_format!` 2 ngữ ở `app.rs`, `trash.rs`, `tree.rs` |
| C15 | 6 bảng màu + Light/Dark/System | ⚪ | `themes.rs` | Chưa rà lại |
| C16 | Phím tắt + màn hình Shortcuts | ⚪ | `shortcuts.rs` | Chưa rà lại |
| C17 | Chat hỏi tài liệu | ⬜ | UI giả, toast "coming next" | Chưa có gì thật |
| C18 | Chọn model/agent cho chat | ⬜ | nhãn "Model · Auto" tĩnh | — |
| C19 | Voice input / voice mode | ⬜ | nút có, chưa nối | — |
| C20 | OCR Tesseract dự phòng ngoài Windows OCR | ⬜ | máy chưa cài | — |
| C21 | Xoay trang trong reader native | ⬜ | — | Web đã có; native chưa |
| C22 | Xuất PDF/bản dịch native | ⬜ | — | — |
| C23 | Packaging + license + ký số | 🟡 | `package-native.ps1`, notice files | Chưa đóng gói lại sau khi xoá editor |
| C24 | Auto-update | ⬜ | tắt có chủ đích | — |
| C25 | Build + test lại toàn bộ | ⚪ | 67 `#[test]` trong source | **Không build được** → mọi mục C tối đa 🟡 |

### D. Lõi dùng chung & chất lượng

| | Chức năng | | Bằng chứng | Còn thiếu |
|---|---|---|---|---|
| D01 | Kiểu chung, block ID ổn định | 🟡 | `types.ts`; id `p{page}-r{n}` | Không test scheme; UI key lại theo text sau khi xoay → id chỉ ổn định trong 1 lần trích |
| D02 | Scheduler priority/dedupe/abort | ✅ | 4 test scheduler, wire trong `main.ts` | AbortController trong scheduler là **trang trí** (signal không được truyền) |
| D03 | Retry/backoff, phân loại lỗi | ✅ | 7 loại lỗi, backoff jitter, test delay 50/100 | — |
| D04 | Batch cho tài liệu dài | 🟡 | `translateBatch` + `chunkBlocks` + test mới | UI vẫn 1 request/block: `translateBatch` chưa có caller |
| D05 | Đếm ký tự / chi phí | ✅ | `pricing.ts` (USD, 4 model) + 17 test; status bar hiện `... · ước tính $0.0004` | Bảng giá là ảnh chụp tại một thời điểm; model lạ hiện "chưa có bảng giá", không bịa số |
| D06 | Glossary parser | ✅ | 6 mã lỗi, cap 200, test edge case | — |
| D07 | Prompt có version, chống injection | ✅ | `PROMPT_VERSION`, câu "treat as data", 3 test | — |
| D08 | Unit test web | ✅ | 19 file / 233 test pass | — |
| D09 | e2e Chromium | ✅ | 16 pass / 0 fail (7d3fb13) | — |
| D10 | Test native | ⚪ | 67 `#[test]` | Không chạy được |
| D11 | CI GitHub Actions | 🟡 | `ci.yml` web job thật; `verify-release.ps1` 6/6 check chạy local pass | **Chặn bởi tài khoản**: mọi run (kể cả workflow tối giản) trả `startup_failure` 0s; GitHub ghi rõ "The job was not started because your account is locked due to a billing issue". Sửa ở Billing, không sửa được bằng code |
| D12 | LICENSE + third-party notice | ✅ | MIT + OCR/PDFium/GPUI notice | — |
| D13 | Tài liệu kiến trúc/quyết định | ✅ | `decisions.tsv` 26 dòng có ngày | — |
| D14 | Feature flag / telemetry / crash report | ⬜ | — | Cố ý không có (privacy-first) |
| D15 | Repo + remote, push | ✅ | `origin` GitHub, `main` = `7d3fb13` | — |

**Tổng quan tại 7d3fb13:** A: 14 ✅ / 16 🟡 · B: 6 ✅ / 7 🟡 · D: 8 ✅ / 6 🟡 / 1 ⬜ · C: 0 ✅ (toàn bộ ⚪ hoặc 🟡 vì không build được). Tức bản **web + extension dùng được**, native còn trên giấy.

---

## 1b. Lượt 2 đã giao gì — và cái còn thiếu là **nối vào UI**

Lượt 2 (6 agent song song) đã đưa 300 test từ 233 và thêm 6 module mới. Nhưng kiểm tra bằng grep: **cả 6 module chưa được import ở đâu**. Đây đúng là bệnh cũ của repo (module + test đầy đủ, UI không gọi), nên các dòng tương ứng vẫn để 🟡 chứ không tick:

| Module mới | Test | Nối vào đâu (việc còn lại) |
|---|---|---|
| `src/core/pricing.ts` (`estimateCost`, `formatUsd`) | có | Thanh trạng thái `main.ts` sau mỗi lượt dịch: hiện ký tự + USD ước tính |
| `translation.ts` `translateBatch` (JSON envelope, fallback Google/DeepL) | có | Nút "Dịch tất cả" dùng batch thay vì 1 request/khối |
| `src/ocr/preprocess.ts` (`normalizeForOcr`) | có | Gọi trước Tesseract trong `capture/reader.ts` (ảnh tối/ngược màu, chữ nhỏ) |
| `src/export/download.ts` (`saveTextFile`) | có | Nút xuất TXT trong reader |
| `src/export/print.ts` (`printHtml`) | có | Nút xuất PDF (đường in của trình duyệt) |
| `scripts/verify-release.ps1` + fix dọn `dist/extension` | có | Chạy trong CI (xem D11) |

**Bug P0 mới, có bằng chứng ảnh**: `tests/e2e/user-journeys.spec.ts` hành trình 04 đang `test.fail` — xoay 90°/270° làm mất chữ đã dịch. Nguyên nhân: khung chữ sau xoay thành cao–hẹp, `paintMirror` vẫn vẽ chữ **ngang** vào khung đó nên `fitText` tràn và rơi về callout vô hình. Cách sửa đúng: xoay canvas theo `block.rotation` rồi vẽ, hoặc hoán đổi trục đo khi vẽ (`main.ts` — lane của phiên song song). Ảnh: `artifacts/journeys/04-rotate-90.png`.

### Danh sách nối UI chính xác (một commit, không chia nhỏ)

| Việc | Điểm sửa | Cần thêm |
|---|---|---|
| Xuất PDF (in) | `main.ts` cạnh handler `#export-bilingual` (dòng ~435): `printHtml(toBilingualHtml(pages,{title:documentTitle(activeTitle),lang:settings.targetLanguage,pageLabel}))`, `document.title=documentTitle(activeTitle)` trước khi in | key `exportPrint`, `exportPrintOpened`, `exportPrintUnavailable`, `exportPrintBlocked`, `exportPrintTimeout` |
| Xuất TXT sạch | thay khối blob+anchor thủ công bằng `saveTextFile(\`${...}.bilingual\`, text, TEXT_MIME)` | key `exportPageLabel` |
| Chi phí | sau mỗi lượt dịch, cạnh `statusTranslated`: `estimateCost({characters,model:settings.model})` → `formatUsd` | key `costEstimate`, `costUnknownModel`, `costEstimateNote` |
| Batch | nút `#full` dùng `translateBatch(pageBlocks, settings, signal)` thay vì `scheduleBlock` từng khối; giữ nguyên đường per-block cho vùng nhìn thấy | không cần |
| Ngôn ngữ đích từ popup | sau `syncToolbarTarget()`: đọc `chrome.storage.local['mirror:targetLanguage']`, chỉ áp khi thuộc `SUPPORTED_TARGETS` | không cần |
| Lỗi thư viện | `hydrateLibrary()` thay `catch{}` bằng map `LibraryStoreError` → key | key `libraryUnavailable`, `libraryQuotaFull`, `librarySaveFailed` |
| OCR đã chuẩn hoá | `capture/reader.ts` (đang làm ở lane riêng) → báo cho người dùng khi ảnh bị đảo màu/phóng to | key `captureNormalized`, `captureTinyText` |

Luật: mỗi key phải có đủ `vi`/`en`/`zh`, không hardcode tiếng Anh; test `tests/i18n.test.ts` sẽ bắt key thiếu.

**Giao thức khi có hai phiên cùng commit một repo** (đã xảy ra sự cố thật): phiên kia chạy `git clean -fd` và **xoá file mới chưa track** của agent (mất spec hành trình lúc 09:47 và 09:49). Từ giờ: mỗi lane ghi bản dự phòng vào `artifacts/` (đã gitignore, `clean -fd` không xoá) và lead commit ngay khi file xuất hiện.

## 2. Việc phải làm để tick hết (theo thứ tự tác động)

### P0 — chặn phát hành
1. **A09/A10** stop thật sự + retry mọi trang lỗi (kể cả đã cuộn qua) + test — retry hiện chỉ xếp lại trang đang thấy.
2. **D04 batch**: nút "Dịch tất cả" dùng `translateBatch` thay vì 1 request/khối (module đã có + 17 test, chỉ thiếu call site).
3. **Nối nốt OCR preprocess vào `capture/reader.ts`** (đang chạy ở lane riêng) và xoá bản trùng trong `ocr/pipeline.ts`.
4. **D11 CI**: code đã đúng, tài khoản GitHub bị **khoá vì billing** nên không job nào start — sửa ở GitHub Billing (hoặc chuyển repo sang public), không phải sửa mã.
5. **A30**: skip-link đang trỏ `#app` (chứa cả sidebar) — trỏ `#main-content` để thật sự bỏ qua nav.

### P1 — chất lượng cảm nhận
7. A22/A23/A24/A25: e2e cho outline/jump, search, xoay, fit, reload — đây là 4 chức năng người dùng thấy mà chưa có bằng chứng click.
8. A19/A20: test UI glossary + gợi ý ngôn ngữ.
9. A07: test linked-view thật (reader nhảy theo message).
10. B01/B04/B09/B13: embed branch, popup DOM, linkUrl, pin quyền.
11. D04/D05: batch thật trong luồng dịch + ước tính chi phí.

### P2 — mở rộng
12. Native: khi có ≥15 GB đĩa → build + `cargo test`, rồi C03/C04 test cho `store.rs`/`trash.rs` (đang 0 test).
13. C06 nhảy trang native, C14 i18n native pass 3, C21 xoay native.
14. C17 chat thật (hoặc bỏ UI giả), C19 voice (hoặc bỏ nút), C20 Tesseract dự phòng.
15. A28: PDF RTL/CJK thật + ảnh chụp; D14 quyết định có telemetry opt-in hay không.

---

## 3. Plan dài hạn (mốc + điều kiện ra)

| Mốc | Ngày | Nội dung | Điều kiện xong (Definition of Done) |
|---|---|---|---|
| M1 | 11-18 → 11-19 | P0: bug glossary, Home/End, stop/retry, export PDF, CI chạy thật, dọn dist | `pnpm test`, `typecheck`, `build`, `test:e2e` xanh **và** GitHub Actions xanh trên `main` |
| M2 | 11-20 → 11-22 | P1: 4 e2e reader còn thiếu, extension depth, batch + cost | Mỗi dòng A22–A25, B01/B04/B09/B13 có e2e click thật; ảnh chụp trong `artifacts/journeys/` |
| M3 | 11-23 → 11-29 | Native trở lại (nếu dọn được ≥15 GB): build, `cargo test`, test `store.rs`/`trash.rs` | `cargo test --workspace` xanh trên máy này, ảnh 3 ngôn ngữ, packaging chạy trên máy sạch |
| M4 | 11-30 → 12-13 | Tính năng sản phẩm: chat thật, voice hoặc bỏ, hai chiều desktop↔Chrome, context menu native | 3 flow lớn có demo + test |
| M5 | 12-14 → 12-31 | Chất lượng: corpus 12 loại tài liệu, WCAG AA đầy đủ, benchmark OCR/translate, release v0.2 | Báo cáo fidelity từng loại + release có checksum |

Quy tắc bất biến: **không tick ✅ nếu chưa có lệnh + output thật trong phiên đó**; mỗi lượt push phải để `main` xanh; native không bao giờ quá 🟡 khi chưa build được.

## 4. Chia lane song song (tối đa 7)

| Lane | Vùng file | Deliverable | Trạng thái |
|---|---|---|---|
| reader-ux | `src/main.ts`, `src/ui/reader.ts` | Home/End, stop/retry, nối export PDF + các e2e click | chờ |
| translation-core | `src/core/translation.ts`, `pricing.ts` | batch thật + cost + fallback provider | lượt 2 |
| ocr-capture | `src/ocr/*`, `src/capture/*` | preprocess (đảo màu, contrast, upscale) + test | lượt 2 |
| extension | `extension/*` | embed branch, popup ngôn ngữ đích, linkUrl, pin quyền | lượt 2 |
| export | `src/export/*` | download/print + PDF | lượt 2 |
| e2e-journeys | `tests/e2e/user-journeys.spec.ts` | 13 hành trình click thật | lượt 2 |
| release-gate | `.github/*`, `scripts/*` | CI thật, `verify-release.ps1`, dọn dist | lượt 2 |
| native | `native-shell/*` | build lại + test (cần đĩa) | bị chặn |

Luật lane: mỗi agent chỉ sửa file trong cột của mình; không commit/push; báo PASS/ISSUES/BLOCKED kèm lệnh + output thật; file nào chưa test được thì khai 🟡 chứ không tick.
