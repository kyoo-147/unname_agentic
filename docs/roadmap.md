# Mirror PDF — roadmap dài hạn

Mục tiêu: một workspace đọc và dịch PDF thật sự dùng được: Chrome tự tạo bản dịch song song, desktop native đọc bằng PDFium, OCR cho nguồn không có text, dịch có glossary, giao diện Việt mặc định, và mọi tuyên bố "xong" đều có bằng chứng chạy thật.

## Nguyên tắc

1. Không đánh dấu xong nếu chưa chạy test/build/e2e hoặc chưa có ảnh chụp thật.
2. Mỗi vòng có một nhánh `main` xanh: `pnpm test`, `pnpm typecheck`, `pnpm build`.
3. Native chỉ được coi là xong khi build lại được và 166 test cũ chạy lại.
4. Chi phí cloud là của người dùng: không tự gửi text khi chưa opt-in, không giả lập bản dịch.
5. Song song tối đa 7 worker, mỗi worker sở hữu file riêng, lead merge và push.

## Phase 0 — Nền móng (đã xong 2026-11-18)

- [x] Git repo private `mirror_trans_pdf`, baseline 595 files, push `main`.
- [x] Đo lại baseline: 54 test web pass, typecheck sạch.
- [x] Bảng chức năng `docs/feature-plan.md`.
- [x] Hạ tầng subagent: `dsh headless` + tài khoản #3, overlay tắt MCP KiCAD.
- [ ] CI GitHub Actions (phase 1).

## Phase 1 — Web + extension hoàn chỉnh (2026-11-18 → 2026-11-22)

Mục tiêu: bản web/extension là sản phẩm độc lập dùng được, tiếng Việt mặc định, OCR capture hoạt động.

- [x] i18n Việt/Anh/Trung cho reader + popup, lưu lựa chọn.
- [x] Glossary UI + parser + áp dụng cho OpenAI/local; nói rõ giới hạn Google/DeepL.
- [x] Language detection + danh sách ngôn ngữ đích có tên bản địa.
- [x] Retry/backoff + phân loại lỗi provider; chunk helper cho tài liệu dài.
- [x] Mục lục, thumbnail, tìm kiếm, nhảy trang, fit width/page, xoay trang.
- [x] Lưu vị trí đọc/zoom/ngôn ngữ qua reload (thư viện qua IndexedDB vẫn để sau).
- [x] OCR capture: `?capture=1` → OCR (Tesseract eng+vie) → PageModel → dịch; chưa e2e trong Chrome.
- [x] Extension: context menu, Ctrl+Shift+M, badge, capture-ready, không trùng mirror.
- [x] Tích hợp toàn bộ vào `src/main.ts`, chạy 16 e2e Chromium thật.
- [~] CI đã viết trong `.github/workflows/ci.yml`; chưa chạy trên GitHub.

**Exit:** `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm test:e2e` xanh; một PDF scan chụp màn hình được OCR và dịch trong Chromium thật; UI mặc định tiếng Việt.

## Phase 2 — Native trở lại (2026-11-23 → 2026-11-29)

Điều kiện mở: giải phóng >= 15 GB đĩa hoặc build trên máy khác.

- [x] `cargo test --workspace` chạy lại: 45 pass, 1 ignored; `cargo check` sạch.
- [~] Build debug GPUI + chụp Home/Reader vi; worker QA đang chụp en/zh.
- [~] pass 1: 124 chuỗi `tr` → `tr3`; pass 2 đang dịch pdf_reader/shortcuts/time.
- [ ] Windows OCR: scan thật, mixed-DPI, cửa sổ ngoài; ghi tỉ lệ nhận dạng.
- [ ] Tesseract `vie+eng` dự phòng nếu Windows OCR dưới ngưỡng.
- [ ] Đóng gói `scripts/package-native.ps1`, license bundle, chạy trên máy sạch.
- [ ] Sửa 34 warning tồn đọng; kiểm tra dung lượng binary.

**Exit:** bản release mở được trên máy không cài Rust; ảnh chụp 3 ngôn ngữ; OCR scan thật có số liệu; test native xanh.

## Phase 3 — Tính năng sản phẩm (2026-11-30 → 2026-12-13)

- [ ] Chat hỏi tài liệu thật: chọn provider/model, streaming, trích dẫn trang, không bịa khi thiếu nguồn.
- [ ] Voice input (Windows Speech hoặc Whisper local) và voice mode; hoặc bỏ nút nếu chưa làm.
- [~] Xuất bản dịch: web .txt, native Markdown theo trang; PDF/DOCX giữ layout còn thiếu.
- [ ] Desktop → Chrome hai chiều; đồng bộ vị trí đọc.
- [ ] Auto-update có ký; kênh stable/beta.
- [ ] Context menu native: dịch trang, dịch vùng chọn, copy song ngữ.
- [ ] Glossary editor native + import/export CSV.

**Exit:** 3 flow lớn (chat, export, hai chiều) có demo thật và test.

## Phase 4 — Chất lượng và phát hành (2026-12-14 → 2026-12-31)

- [ ] Corpus 12 loại tài liệu trong product-contract; ghi fidelity từng loại.
- [ ] Accessibility WCAG 2.2 AA cho web; keyboard-only; screen reader.
- [ ] Benchmark OCR/translate latency, RAM, dung lượng; ghi số thật.
- [ ] RTL, CJK, công thức, Type 3 font, trang xoay, tài liệu có mật khẩu.
- [ ] Trang landing + tài liệu người dùng + video 90 giây.
- [ ] Release v0.2 public trên GitHub, kèm installer và checksum.

## Ước lượng

| Phase | Thời gian | Worker song song | Rủi ro chính |
|---|---|---|---|
| 0 | xong | 5 | quota subagent |
| 1 | 4–5 ngày | 5–7 | OCR model, e2e memory |
| 2 | 5–7 ngày | 3–4 | đĩa < 15 GB, build 20–40 phút |
| 3 | 2 tuần | 4–6 | provider/model credential |
| 4 | 2–3 tuần | 3–5 | fidelity corpus, thời gian |

## Rủi ro đang mở

- **[chặn]** Ổ D: còn ~3.2 GB; GPUI target cần hàng chục GB. Không thể build native trên máy này cho tới khi dọn đĩa.
- **[chặn]** Chỉ tài khoản OpenCode #3 còn quota; #1 hết hạn mức tháng, #2 hết số dư. 5 worker chạy chung một pool.
- **[nên biết]** Tesseract tiếng Việt trên ảnh chụp màn hình sẽ sai với chữ nhỏ, nền màu, và font lạ; cần đo trước khi hứa "OCR mọi tài liệu".
- **[nên biết]** Google/DeepL không nhận glossary tự do như prompt OpenAI; UI phải nói rõ thay vì giả vờ đã áp dụng.
- **[nên biết]** Native build lại sẽ làm thay đổi số test (95+71 cũ); chỉ tin số mới chạy trong phiên.
