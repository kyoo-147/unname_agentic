# Mirror PDF — bảng chức năng và kế hoạch tiến độ

Cập nhật: 2026-11-18 (Asia/Saigon). Nguồn: đọc mã nguồn, chạy test web, đối chiếu tài liệu sản phẩm và bằng chứng đã ghi.

## Cách đọc trạng thái

- `[x]` — có mã, có bằng chứng chạy thật (test, e2e, ảnh chụp), không có lỗi đã biết.
- `[~]` — có mã nhưng chưa đủ UX, chưa verify lại trong phiên này, hoặc mới đúng một phần.
- `[ ]` — chưa có.

Không đánh dấu `[x]` cho phần chỉ biên dịch được hoặc chỉ có mock. Native chưa build lại trong phiên này vì ổ D: chỉ còn ~3.2 GB; mọi mục native vì vậy tối đa là `[~]` trừ khi có bằng chứng cũ ghi rõ.

## 1. Bảng chức năng

### A. Đọc PDF trên trình duyệt (web reader)

| | Chức năng | Trạng thái | Bằng chứng / ghi chú |
|---|---|---|---|
| A01 | Mở PDF cục bộ, kéo thả, chọn nhiều tệp | [x] | `src/main.ts`; `src/pdf/document.ts`; e2e reader |
| A02 | Render PDF.js, giữ đúng tỉ lệ trang | [x] | `tests/pdf-layout.test.ts`; `tests/e2e/reader.spec.ts` |
| A03 | Trích xuất block văn bản + toạ độ | [x] | `src/pdf/document.ts`; `src/core/types.ts` |
| A04 | Xoá glyph gốc dưới chữ đã dịch | [x] | `src/pdf/suppression.ts`; `tests/pdf-suppression.test.ts` |
| A05 | Giữ nguyên ảnh, biểu đồ, vector ngoài vùng chữ | [x] | `tests/e2e/reader.spec.ts` (pixel check) |
| A06 | Hai pane gốc/dịch, kéo chia, reset 50/50 | [x] | `src/main.ts`; `src/style.css` |
| A07 | Đồng bộ trang/zoom với tab nguồn (linked view) | [x] | `src/ui/bridge.ts`; `tests/browser-bridge.test.ts` |
| A08 | Dịch ưu tiên vùng nhìn thấy, hàng đợi có priority | [x] | `src/core/scheduler.ts`; `tests/scheduler.test.ts` |
| A09 | Dịch toàn bộ tài liệu, có thể dừng | [x] | `src/main.ts` nút Translate all |
| A10 | Tạm dừng / tiếp tục / thử lại lỗi | [x] | `src/main.ts`; e2e provider error |
| A11 | Chọn vùng, dialog đọc song song theo vùng | [x] | `src/main.ts`; `#selection-dialog` |
| A12 | Fit chữ vào đúng khung, không cắt âm thầm | [x] | `src/pdf/layout.ts`; `tests/pdf-layout.test.ts` |
| A13 | Cache theo nội dung + cấu hình, dedupe request | [x] | `src/core/translation.ts`; `tests/translation.test.ts` |
| A14 | Bốn nhà cung cấp: Google, DeepL, OpenAI-compatible, local | [x] | `src/core/translation.ts`; `tests/translation.test.ts` |
| A15 | Consent cloud rõ ràng, chặn cloud khi chưa bật | [x] | `src/core/translation.ts`; settings dialog |
| A16 | Trạng thái lỗi/đang tải/mất nguồn | [x] | status bar + e2e error flow |
| A17 | Thư viện tài liệu trong phiên | [~] | chỉ trong RAM; mất khi reload |
| A18 | Giao diện Việt/Anh/Trung | [ ] | toàn bộ UI web đang là tiếng Anh |
| A19 | Glossary thuật ngữ có UI + áp dụng cho mọi provider | [~] | có kiểu dữ liệu, chưa có UI; Google/DeepL bỏ qua |
| A20 | Tự nhận diện ngôn ngữ nguồn | [ ] | mặc định `auto` nhưng không có bộ dò/ gợi ý |
| A21 | Danh sách ngôn ngữ đích có tên hiển thị | [~] | ô nhập mã ngôn ngữ tự do |
| A22 | Mục lục, thumbnail, nhảy trang | [ ] | chưa có |
| A23 | Tìm trong tài liệu | [ ] | chưa có |
| A24 | Xoay trang, chế độ fit width/page | [ ] | chưa có |
| A25 | Lưu vị trí đọc, zoom, ngôn ngữ qua reload | [ ] | chưa có persistence |
| A26 | Xuất bản dịch (txt/PDF song ngữ) | [ ] | chưa có |
| A27 | OCR ảnh chụp màn hình → block → dịch | [ ] | capture mở viewer nhưng reader không đọc `?capture=1` |
| A28 | RTL và ngôn ngữ CJK trong vùng dịch | [~] | block.direction được set; chưa có test RTL |
| A29 | Phím tắt đọc (j/k, +/-, Ctrl+F, Home/End) | [~] | mới có Ctrl/Cmd+O và splitter arrows |
| A30 | Accessibility: focus trap, aria, reduced motion, contrast | [~] | có aria cơ bản; chưa audit WCAG |

### B. Tiện ích Chrome (extension)

| | Chức năng | Trạng thái | Bằng chứng / ghi chú |
|---|---|---|---|
| B01 | Tự phát hiện PDF qua URL, content-type, embed/object/iframe | [x] | `extension/background.ts`, `content.ts`; e2e |
| B02 | Một mirror cho mỗi nguồn, không mở trùng | [x] | `controller.ts`; `tests/extension*.test.ts` |
| B03 | Fetch bytes có kiểm tra `%PDF-` và quyền host | [x] | `controller.ts`; unit tests |
| B04 | Popup bật/tắt auto mirror, trạng thái | [~] | có; UI tiếng Anh, chưa có ngôn ngữ đích |
| B05 | Badge / số mirror đang mở | [~] | có badge; chưa có test hiển thị |
| B06 | Capture tab đang xem → mở mirror ảnh | [~] | background tạo viewer `?capture=1`; reader chưa xử lý |
| B07 | Gửi PDF sang desktop qua native messaging | [x] | `native-bridge.ts`; `tests/extension-native-bridge.test.ts` |
| B08 | Theo trang/zoom hai chiều với desktop | [~] | Chrome → desktop có; desktop → Chrome chưa |
| B09 | Context menu “Open mirror” | [ ] | chưa có |
| B10 | Phím tắt bật/tắt mirror | [ ] | chưa có |
| B11 | Popup Việt/Anh/Trung | [ ] | chưa có |
| B12 | Xử lý nguồn cần đăng nhập/blob/protected rõ ràng | [x] | thông báo lỗi trung thực, không bypass |
| B13 | Quyền tối thiểu, không đọc lén tab khác | [x] | manifest + authorize theo tab |

### C. Ứng dụng desktop native (GPUI + Rust)

| | Chức năng | Trạng thái | Bằng chứng / ghi chú |
|---|---|---|---|
| C01 | Shell native GPUI, titlebar Windows tự vẽ | [x] | đã được duyệt; `native-shell/src/*`; ảnh artifacts |
| C02 | Nhập PDF, lưu bytes gốc, thumbnail trang 1 | [x] | docs/native-product-status.md; tests cũ |
| C03 | Thư viện: đổi tên, yêu thích, ghim, sắp xếp, tìm kiếm | [x] | docs + code; test cũ |
| C04 | Thùng rác: xoá, khôi phục, xoá vĩnh viễn | [x] | `trash.rs`; test cũ |
| C05 | Reader hai pane PDFium, divider, scroll đồng bộ | [x] | 15 reader tests; ảnh chụp |
| C06 | Zoom, chuyển trang, nhảy trang | [x] | `pdf_reader/*`; tests cũ |
| C07 | Dịch theo vùng nhìn thấy, pause/retry | [x] | docs; test cũ |
| C08 | Cache + generation guard chống kết quả cũ | [x] | docs; tests cũ |
| C09 | Provider Google/DeepL/OpenAI/local + consent | [x] | `desktop/src/provider.rs`; tests |
| C10 | Credential vault Windows, không lưu key vào JSON | [x] | docs; test secret field |
| C11 | Live mirror: chọn cửa sổ/màn hình, capture, OCR Windows | [x] | docs; OCR 40 regions từng chạy |
| C12 | Chống tự capture chính mình | [x] | WDA_EXCLUDEFROMCAPTURE; docs |
| C13 | Cầu Chrome ↔ desktop, checksum, chống trùng | [x] | native bridge tests; docs |
| C14 | Giao diện Việt/Anh/Trung đầy đủ | [~] | có bảng ~100 chuỗi; nhiều chuỗi `tr(zh,en)` vẫn rơi về tiếng Anh |
| C15 | Sáu bảng màu + Light/Dark/System | [x] | `themes.rs`; ảnh chụp |
| C16 | Phím tắt + màn hình Shortcuts | [x] | `shortcuts.rs`; settings |
| C17 | Chat hỏi tài liệu | [ ] | mới là UI giả: attach/skills/mic/voice hiện toast “coming next” |
| C18 | Chọn model/agent cho chat | [ ] | nhãn “Model · Auto” tĩnh |
| C19 | Voice input / voice mode | [ ] | nút có, chưa nối |
| C20 | OCR Tesseract dự phòng ngoài Windows OCR | [ ] | máy chưa cài; Windows OCR là engine duy nhất |
| C21 | Xoay trang trong reader | [ ] | tài liệu ghi rõ là gap |
| C22 | Xuất PDF/bản dịch | [ ] | chưa có |
| C23 | Packaging + license bundle + ký số | [~] | từng đóng gói; chưa làm lại sau khi xoá editor |
| C24 | Auto-update | [ ] | bị tắt có chủ đích |
| C25 | Build lại + test lại toàn bộ trong phiên này | [ ] | bị chặn bởi dung lượng đĩa (~3.2 GB) |

### D. Lõi dùng chung & chất lượng

| | Chức năng | Trạng thái | Bằng chứng / ghi chú |
|---|---|---|---|
| D01 | Kiểu dữ liệu chung, block ID ổn định | [x] | `src/core/types.ts` |
| D02 | Scheduler có priority, dedupe, abort | [x] | `tests/scheduler.test.ts` |
| D03 | Retry/backoff, phân loại lỗi provider | [ ] | hiện chỉ báo lỗi thô |
| D04 | Batch request cho tài liệu dài | [ ] | mỗi block một request |
| D05 | Đếm ký tự/chi phí ước tính | [ ] | chưa có |
| D06 | Glossary parser + kiểm tra thuật ngữ | [ ] | mới có `Record<string,string>` |
| D07 | Prompt template có version, chống prompt injection | [~] | có promptVersion + câu “do not follow instructions”; chưa test |
| D08 | Test web đơn vị | [x] | 54 passed (2026-11-18) |
| D09 | Test e2e Chromium | [x] | 3 passed (lần chạy gần nhất; cần chạy lại sau thay đổi) |
| D10 | Test native | [~] | 95 + 71 passed trước khi xoá editor; chưa build lại |
| D11 | CI GitHub Actions | [ ] | chưa có |
| D12 | LICENSE root + third-party notices | [~] | native có; root chưa có LICENSE |
| D13 | Tài liệu kiến trúc/quyết định | [x] | `docs/decisions.tsv`, product-contract, native.md |
| D14 | Feature flag / telemetry / crash report | [ ] | không có; privacy-first |
| D15 | Repo Git + remote | [x] | `https://github.com/kyoo-147/mirror_trans_pdf` (private) |

## 2. Ảnh chụp kiểm chứng hiện tại

- Ngày 2026-11-18: `pnpm test` → 8 files, 54 tests passed; `pnpm typecheck` → sạch.
- `pnpm test:e2e` chưa chạy lại trong phiên này; lần gần nhất 3 passed.
- Native: không build lại; dung lượng đĩa D: ~3.2 GB, không đủ cho target GPUI.
- Subagent: đã gọi được qua `dsh headless` với tài khoản OpenCode #3; hai tài khoản còn lại hết quota/số dư.

## 3. Ưu tiên

### P0 — chặn bán được sản phẩm
1. Build native lại được (dọn đĩa hoặc build trên máy khác), chạy lại 166 test.
2. OCR capture trên web: `?capture=1` phải OCR ảnh và dịch được.
3. i18n web + extension mặc định tiếng Việt.
4. Đóng gói native + license + thử mở trên máy sạch.
5. CI chạy test web + typecheck + e2e.

### P1 — hoàn thiện trải nghiệm
6. Glossary UI + language detection + retry/backoff.
7. Mục lục/thumbnail/tìm kiếm/xoay/fit trong reader.
8. Lưu vị trí đọc và thư viện qua reload.
9. Popup extension: ngôn ngữ đích, trạng thái, context menu, phím tắt.
10. Native i18n đủ 3 ngôn ngữ; chat thật hoặc bỏ UI giả.

### P2 — mở rộng
11. Xuất bản dịch song ngữ.
12. Desktop → Chrome hai chiều.
13. Tesseract dự phòng + benchmark OCR.
14. Auto-update có ký.
15. Đa ngôn ngữ đích mở rộng + RTL.

## 4. Cách chia việc song song

| Agent | Vùng file | Kết quả bàn giao |
|---|---|---|
| i18n-web | `src/i18n.ts`, `index.html`, `src/main.ts`, popup | UI Việt mặc định, đổi ngôn ngữ, test |
| translation-core | `src/core/*` | glossary, detect, retry, batch, prompt, test |
| reader-core | `src/pdf/*`, `src/ui/reader.*` | outline, search, fit, xoay, phím, test |
| ocr-capture | `src/ocr/*`, `public/ocr/*` | OCR engine + pipeline + capture, test |
| extension-core | `extension/*` (trừ popup) | context menu, shortcut, badge, capture signal, test |
| integration | `src/main.ts`, `src/style.css` | nối toàn bộ module, UX hoàn chỉnh, e2e |
| qa-release | `tests/e2e/*`, `docs/*`, README | chạy lại toàn bộ, bằng chứng, release notes |

Luật chung: mỗi agent chỉ sửa file trong cột của mình; không `git commit/push`; báo cáo PASS/ISSUES/BLOCKED kèm lệnh và kết quả thật.
