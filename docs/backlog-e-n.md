# Backlog Document Intelligence — bảng checklist thực thi

Nguồn: backlog nghiên cứu 2026-11-20 (E01–N08 = **120 mục**) + **17 mục 🟡** của `docs/features.md`.

**Quy ước trạng thái:** ⬜ chưa làm · 🟡 có một phần, thiếu test/bằng chứng · ✅ đã có test thật chạy pass và bằng chứng (lệnh + output/ảnh).

**Luật:** không đánh ✅ khi chưa có output chạy thật. Mỗi mục ✅ phải có ít nhất một trong: test unit (vitest/cargo), e2e Playwright, hoặc log/ảnh đo được, và được commit kèm.

Tiến độ cập nhật bằng script: `scripts/backlog-status.mjs` (đếm từ file này).

# Feature expansion backlog — Document Intelligence Workspace

**Ngày nghiên cứu:** 2026-11-20  
**Cơ sở:** Bản kê 83 tính năng do chủ dự án cung cấp (`docs/features.md`, HEAD `0c6361b`). Không thực hiện kiểm tra repo độc lập trong phiên này.  
**Hiện trạng theo bản kê:** 83 mục = 66 ✅ + 17 🟡.  
**Bổ sung:** 120 work items đề xuất E01–N08, **chưa triển khai**; một số là nâng cấp/hoàn thiện năng lực hiện có (đặc biệt 17 mục 🟡), không phải 120 chức năng độc lập hoàn toàn.  
**Quy ước ưu tiên:** P0 = sửa đúng/khép kín; P1 = lõi sản phẩm; P2 = tăng giá trị; P3 = mở rộng sau.  
**Đặc tả này không khẳng định các chức năng đề xuất đều có sẵn ở sản phẩm đối chiếu**; đây là tổng hợp nghiên cứu + đề xuất thiết kế.

## 0. Đóng 17 mục 🟡 trước khi tiếp tục mở rộng

| Mã | Việc hoàn thiện | Bằng chứng cần có | Trạng thái |
|---|---|---|---|
| A26 | PDF writer đúng nghĩa | ✅ DOM-free pagePlan + buildPdf bằng pdf-lib, round-trip qua pdfjs; 31 test (font Unicode đang làm ở H02) |
| A27 | Benchmark OCR đa ngôn ngữ/ảnh xấu | CER/WER cho blur, skew, rotate, noise; định nghĩa language support  🟡 |
| A28 | RTL/CJK nguồn thật | Corpus RTL/CJK + visual regression + copy/search text  🟡 |
| B07/B08 | Native messaging Chrome↔host 2 chiều | Chrome thật ↔ host thật, profile sạch, import và sync roundtrip |
| C09/C10 | Provider validation, consent và credential vault | E2E với key hợp lệ/không hợp lệ, không leak logs |
| C11/C12 | Live mirror thật và chống self-capture | Test window/tab/screen capture, nhiều monitor, quyền OS |
| C13 | Cầu Chrome ↔ desktop | 🟡 | ✅ `native_bridge.rs`: typed error, duplicate bounded, checksum trước khi parse, timeout không rò pending (9 test mới); chưa chạy Chrome thật |
| C14/C15 | Native i18n/theme | Screenshot matrix ngôn ngữ × theme × DPI |
| C18 | Model catalogue | Discovery/config, capabilities, health check, context size  🟡 |
| C22 | Xuất bản dịch native | 🟡 | ✅ `export_native.rs` (Markdown/Text/JSON, ghi atomic, hỏi đường dẫn) + 14 test; nút header đang xuất tiêu đề + text trang vì PdfReader chưa expose bản dịch |
| D02 | Cancel/abort thật | ✅ scheduler có AbortController thật, abortAll, 10 test đếm request; transport không gửi request sau abort |
| D11 | CI | Chạy được trong account hợp lệ; nếu billing block, test runner alternative  🟡 |

## 1. Backlog mở rộng — 120 tính năng

Cột **Nghiệm thu tối thiểu** là điều kiện thực thi, không phải lời quảng cáo.
### E. Nhập liệu & hiểu cấu trúc tài liệu — 14 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| E01 | **P0** | Phát hiện PDF born-digital, scanned, hybrid theo trang | Tự chọn extraction/OCR từng trang và ghi lý do chọn engine. | ✅ `src/core/classify.ts` + 18 test: quy tắc có thứ tự, ngưỡng là hằng số có giải thích, mỗi biên được test đúng điểm |
| E02 | **P1** | Đọc thứ tự đa cột và xuyên trang | Chuẩn hoá reading-order không lẫn cột, header/footer. | ✅ `src/core/reading-order.ts` + 21 test: gutter theo coverage valley, block spanning đóng band, `stripRepeats` bỏ header/footer lặp |
| E03 | **P1** | Phân loại block: heading, paragraph, list, table, figure, formula, footnote | Lưu type, bbox, confidence và quan hệ cha-con. | ✅ `src/core/blocks.ts` + 27 test: mỗi loại một fixture, heading level 1-3, confidence + lý do |
| E04 | P1 | Lưu Document IR có provenance | Block có page, polygon, reading-order, source bytes hash, version. | ✅ src/core/ir.ts: contract + validate + serialize versioned; 21 test |
| E05 | **P1** | Tái tạo cấu trúc heading/section và mục lục tự động | Click heading đưa đúng đến đoạn gốc. | ✅ `src/core/outline.ts` + 31 test: cây section, TOC có path 1 / 1.1 / 1.1.1, level jump bị kẹp và báo, `sectionAt` cho mọi block |
| E06 | **P1** | Tách bảng thành cell/row/col, merged cells | Xuất table có header, rowspan, colspan mà không mất dữ liệu. | ✅ `src/core/tables.ts` + 13 test: gom hàng theo baseline, cột theo corridor, colSpan, CSV RFC4180, Markdown |
| E07 | **P1** | Nhận diện phương trình inline/display và LaTeX | Giữ công thức khi dịch, sao chép được LaTeX. | ✅ `src/core/formulas.ts` + 33 test: sup/sub/fraction/Greek/operator, `H_2O`→`H_{2}O`, chặn `and/or`, khoá cả cụm khi dịch |
| E08 | **P1** | Tách hình, caption, bảng và liên kết caption | Click caption focus hình/bảng tương ứng. | ✅ `src/core/captions.ts` + 14 test: cùng cột, số khớp ưu tiên, tie ghi alternative, orphan có lý do |
| E09 | **P2** | Nhận diện header/footer/page-number để loại khỏi dịch tuỳ chọn | Không trùng nội dung mỗi trang. | ✅ `src/core/furniture.ts` + 26 test: cần cả band và lặp, page number giữ lại để in lại theo trang, watermark theo góc xoay |
| E10 | **P2** | Giữ hyperlink, footnote và cross-reference | Link nội bộ hoạt động lại sau export. | ✅ `src/core/links.ts` + 26 test: footnote/figure/table/section, tie báo thay vì đoán, renumber, Markdown anchor theo block id |
| E11 | **P2** | Phát hiện ngôn ngữ theo đoạn/vùng, không chỉ toàn tài liệu | PDF song ngữ dịch đúng từng span. | ✅ `src/core/language-regions.ts` + 29 test: script + chữ riêng tiếng Việt + stopword/particle, số là `und`, gộp vùng theo luật đã ghi |
| E12 | **P2** | Hỗ trợ DOCX/PPTX/XLSX/EPUB/HTML/ảnh TIFF/PNG/JPG | Đưa về IR, giữ nguồn và metadata. | ✅ `src/core/converters.ts` + 19 test (cùng `import-formats.ts` 57 test): converter pure-TS (STORE/DEFLATE ZIP, SHA-256) chuyển 8 định dạng sang DocumentIR đạt `validate(ir)` và build Vite sạch |
| E13 | **P2** | Phát hiện PDF hỏng, font lỗi, text encoding lỗi | Cảnh báo và tự đề xuất extraction fallback. | ✅ `src/core/pdf-health.ts` + 19 test: version/encrypt/object floor/startxref/trailer/EOF, diagnosis ra repair/other-engine/OCR/ask-password |
| E14 | **P3** | Trích metadata tài liệu (title, author, dates, lang) | Metadata hiển thị và dùng cho citation. | ✅ `src/core/metadata.ts` + 41 test: Info dict literal/hex/UTF-16, PDFDocEncoding, date giữ đúng độ chính xác, tách author không phá tên công ty, title fallback có nguồn |

### F. OCR & Agentic Visual Understanding — 14 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| F01 | **P1** | Chọn engine OCR theo loại trang + ghi lý do | Mỗi trang ghi engine đã chọn và vì sao. | ✅ `src/core/engine-plan.ts` + 32 test: digital→none, scan→engine nhanh nhất có sẵn, ngôn ngữ không hỗ trợ bị demote, offline loại cloud, budget ước lượng |
| F02 | **P1** | Deskew/denoise/binarize ảnh scan trước OCR | OCR tăng chất lượng trên ảnh nghiêng/mờ. | ✅ `src/core/deskew.ts` + 17 test: matrix affine, box map/invert trong 0.01pt, crop tight (kèm giải thích), quarter turn bị từ chối; `preprocess.ts` lo binarize/denoise |
| F03 | **P1** | Preprocessing: deskew/binarize/denoise/upscale pipeline | OCR tăng chất lượng đo được. | ✅ `src/core/preprocess.ts` + 19 test: đo stats, ước lượng skew bằng projection profile, quyết định kèm lý do, ngưỡng export |
| F04 | **P1** | Phân tích bảng từ ảnh scan (row/col detection) | Bảng scan thành cell có toạ độ. | ✅ `src/core/table-grid.ts` + 18 test: profile theo trục, merge có ink, speck bị loại, confidence = 1 - biến thiên pitch, từ chối có lý do |
| F05 | **P1** | Searchable PDF tạo text layer từ scan | Copy/search đúng vị trí mà ảnh gốc không mất. | ✅ `src/export/searchable.ts` + 20 test: text render mode 3, đúng baseline, pdfjs trích được chữ |
| F06 | **P1** | Mixed OCR theo vùng, bỏ qua text gốc đã tốt | Không tạo 2 lớp chữ trùng nhau. | ✅ \src/core/mixed-ocr.ts\ + 19 test: phân loại keep-digital/run-ocr/skip-overlap, khử trùng theo IoU/containment, ghép reading-order không 2 lớp |
| F07 | **P1** | Agentic OCR query-driven chỉ đọc vùng cần thiết | Một câu hỏi kích hoạt inspect/crop/zoom/extract có trace. | ✅ `src/core/agentic-ocr.ts` + 13 test (cùng `vision_tools.rs` 9 test): vòng lặp zoom_and_ocr/tile_sweep/stop_with_evidence có `CropArtifactCache`, chặn lặp/placeholder, giới hạn pixel/round budget & `AbortSignal` |
| F08 | **P1** | Visual grounding/citation vào bbox đa giác | Click answer focus đúng box nguồn. | ✅ `src/core/visual-grounding.ts` + 13 test (cùng `citations.ts` 24 test): bbox chuẩn hoá [0,1000], đa giác/quad 4 góc biến đổi ngược 0–270°/45°, IoU/NMS & tile grid (chip click UI nối cùng I01) |
| F10 | **P1** | Offline/no-network mode e2e (không cloud call) | 0 request ra ngoài, có test. | ✅ `src/core/network-guard.ts` + 14 test: ghi mọi attempt kể cả bị chặn, policy deny/loopback/origin list, wrap transport để test cả lỗi lẫn log |
| F11 | **P2** | So sánh nhiều OCR engines bằng confidence và consensus | Ghi engine winner theo vùng và chi phí. | ✅ \src/core/ocr-consensus.ts\ + 23 test: so sánh Levenshtein/token/dấu Việt/số, consensus vượt outlier tự tin thái quá, ghi winner và chi phí từng vùng |
| F12 | **P2** | Image understanding: biểu đồ, sơ đồ, hình kỹ thuật | Kết quả mô tả được gắn với ảnh nguồn. | ✅ \src/core/image-understanding.ts\ + 26 test: phân loại chart/diagram/flowchart/technical, gắn caption+bbox, chặn số bịa và abstain khi ảnh mờ |
| F13 | **P2** | Phát hiện mâu thuẫn OCR bằng kiểm tra số/ngày/đơn vị | Flag số hoặc ký tự rủi ro cao để duyệt. | ✅ \src/core/ocr-verify.ts\ + 22 test: bắt nhầm 0/O, 1/l/I, 5/S, 8/B, dấu thập phân, ngày trái ngược, đơn vị lỗi và tổng cột lệch |
| F14 | **P3** | Human-in-the-loop sửa OCR và tái sử dụng correction | Không sửa file gốc trừ khi người dùng xác nhận. | ✅ \src/core/ocr-corrections.ts\ + 8 test: bất biến SHA-256 nguồn, bắt buộc \confirmed: true\, preview/rollback và rút rule tái sử dụng |
| F09 | **P2** | Cost/time estimate trước khi chạy batch | Ước lượng thời gian và tiền trước khi chạy. | ✅ `src/core/estimate.ts` + 34 test: 4 stage, OCR chỉ khi có trang scan, total = tổng stage, cost null khi chưa biết giá, câu 3 ngôn ngữ |

### G. Dịch thuật chuyên nghiệp — 16 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| G01 | **P0** | Xuất PDF đơn ngữ thật, không qua Print | Tải file PDF hợp lệ mở được bằng reader độc lập. | ✅ \src/export/monolingual-pdf.ts\ + 17 test: pdf-lib + Noto Sans + reflow + metadata + round-trip mở lại qua pdf-lib và pdfjs-dist đúng tiếng Việt |
| G02 | **P2** | Book mode (facing pages) cho tài liệu sách | Đọc 2 trang đối diện mượt. | ✅ `src/core/book-mode.ts` + 32 test: cover đóng spread riêng, blank parity có ghi nhận, folio lề ngoài, `visibilityFor` trả đúng pane |
| G03 | **P1** | Domain-aware translation (legal, medical, finance, technical) | Glossary + style theo domain. | ✅ `src/core/domain.ts` + 30 test: 5 domain + general, trọng số có tài liệu, guidance 3 ngôn ngữ, glossary hints; chưa nối vào `prompt.ts` |
| G04 | **P1** | Translation memory (TM) theo segment và version | Đoạn lặp được tái sử dụng và truy nguyên bản gốc. | ✅ `src/core/tm.ts` + 17 test: exact 1.0, gần đúng 0.875, import/export byte-identical |
| G05 | **P1** | Glossary learning từ tài liệu và sửa của người dùng | Đề xuất term có duyệt, không tự áp. | ✅ `src/core/glossary-learn.ts` + 16 test: align theo 3 tầng, confidence theo độ nhất quán, xung đột bị từ chối, round-trip `parseGlossary` |
| G06 | P1 | Protect placeholders: số, SKU, URL, công thức, citation, tag | Bản dịch không thay đổi các token bị khoá. | ✅ protect.ts + prompt v2 + transport mask/restore; 20 test |
| G07 | **P1** | Layout-preserving reflow với fit/overflow detection | Không mất chữ khi dịch dài hơn. | ✅ `src/core/reflow.ts` + 20 test: wrap → shrink 0.5pt → condense → overflow có dấu và `clippedCharacters`, không cắt chữ Latin |
| G08 | **P2** | Consistency check cho thuật ngữ trong cùng tài liệu | Cùng term phải cùng bản dịch. | ✅ `src/core/consistency.ts` + 15 test: glossary vi phạm = error, 2 cách viết = warn, term xuất hiện 1 lần không báo, applyCanonical chỉ sửa cái được duyệt |
| G09 | **P2** | Bilingual/parallel export ghép câu theo segment | Bản song ngữ đọc song song được. | ✅ `src/core/parallel-text.ts` + 24 test: align theo block id, ratio báo cắt cụt, Markdown có anchor, TMX round-trip, XML lỗi báo dòng |
| G10 | **P2** | Lựa chọn văn phong formal/technical/legal/academic | Profile được lưu và đưa vào prompt versioned. | ✅ \src/core/style-profile.ts\ + 14 test: 5 văn phong + custom, serialize có version và ghép vào \prompt.ts\/\domain.ts\ |
| G11 | **P2** | Translation QA: số, thuật ngữ, câu phủ định, đơn vị | Hiển thị lỗi có bằng chứng để reviewer duyệt. | ✅ `src/core/qa.ts` + 22 test: số/đơn vị/phủ định/glossary/placeholder, mỗi issue có trích nguồn hai phía |
| G12 | **P2** | Dịch bảng giữ cell alignment và công thức số | Bảng bản dịch không đổi cấu trúc/giá trị. | ✅ `src/core/table-translate.ts` + 20 test: ô số/ngày/tiền giữ nguyên, cache, span giữ, diff/merge theo ô |
| G13 | **P2** | Translation cache thông minh có version | Cache hit/miss, không trả bản dịch cũ. | ✅ `src/core/cache.ts` + 27 test: key = SHA-256(source, langs, provider, model, promptVersion, glossary), TTL rồi LRU, persist/restore có version |
| G14 | **P2** | Auto route engine theo ngôn ngữ, độ dài, chi phí, privacy | Có rule/override và telemetry cục bộ. | ✅ \src/core/engine-router.ts\ + 15 test: chọn engine theo ngôn ngữ/chi phí/glossary/override, offline chặn tuyệt đối cloud, telemetry JSON |
| G15 | **P2** | Import/export glossary và TM: CSV/TMX/TBX ở mức phù hợp | Đọc/ghi UTF-8 và báo lỗi schema rõ ràng. | ✅ \src/core/tm-exchange.ts\ + 14 test: RFC4180 CSV, TMX 1.4b, TBX-Basic UTF-8/BOM round-trip và báo lỗi kèm số dòng |
| G16 | **P3** | Reviewer mode phân vai translator/editor/approver | Mỗi chỉnh sửa có trạng thái và audit log. | ✅ \src/core/reviewer-mode.ts\ + 10 test: máy trạng thái 3 vai, chặn vượt quyền, diff theo từ và chuỗi SHA-256 trên \AuditLog\ |

### H. PDF editor, xuất file & công cụ tài liệu — 16 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| H01 | **P1** | Document workspace → PDF giữ layout | Output mở được, giữ được bố cục và công thức. | ✅ `src/export/pdf.ts` (ảnh trang gốc + che vùng + chữ dịch, font Noto), `src/export/searchable.ts` (text layer), `src/export/pairs.ts` (bố cục trang đôi/song song), `src/export/tex.ts` (công thức vẽ bằng primitive) |
| H02 | **P1** | Nhúng/subset fonts đa ngôn ngữ CJK/RTL cho bản dịch | Không tofu khi mở trên máy khác. | ✅ `src/export/fonts.ts`: Noto Sans (OFL) + fontkit, "Tiếng Việt — số 42" trích lại đúng dấu; CJK báo thiếu glyph rõ ràng |
| H03 | **P1** | Xuất PDF song ngữ với trang xen kẽ | Có option, giữ chất lượng. | ✅ `planPairs` mode `alternating`/`interleaved` + 31 test: fit rule có số liệu, fallback có lý do, page furniture theo lề trái/phải |
| H04 | **P1** | Bookmarks/highlight/note cá nhân | Lưu theo user, mở lại vẫn còn. | ✅ `src/core/annotations.ts` + 14 test: anchor theo block, backlinks, reanchor sau re-parse (kept/moved/orphan), export/import có version |
| H05 | **P1** | Chèn text, callout, hình, shape, watermark | Export lại PDF và giữ được toạ độ. | ✅ `src/export/pdf-overlays.ts` + 13 test: chèn textbox/callout/PNG/JPEG/rect/ellipse/line/arrow/watermark xoay mờ qua pdf-lib + Noto Sans, round-trip bằng `pdf-lib` và `pdfjs-dist` |
| H06 | **P1** | Sửa text OCR và translated block inline | Undo/redo, autosave và so khớp nguồn. | ✅ `src/core/inline-editor.ts` + 18 test: sửa inline OCR/dịch, undo/redo, autosave schedule, diff nguồn theo từ/ký tự và chặn xung đột `RevisionConflictError` |
| H07 | **P1** | Tách, ghép, đổi thứ tự, xoay, xoá/trích trang | Page thumbnails phản ánh edit tức thời. | ✅ `src/export/pdf-pages.ts` + 18 test: split/merge/reorder/rotate/delete/extract thật bằng pdf-lib, `PageThumbnailDeck` cập nhật tức thời + round-trip `pdfjs-dist` |
| H08 | **P1** | Trích bảng ra CSV/XLSX và công thức ra LaTeX | Dữ liệu đúng row/col và chọn đúng bảng. | ✅ `src/export/table-xlsx.ts` + 10 test: xuất CSV RFC4180, OOXML `.xlsx` ZIP/CRC32 có `mergeCells`, và gói công thức `.tex`; đã kiểm giải nén `Expand-Archive` + XML parser |
| H09 | **P2** | Preserve metadata/outline/AcroForm khi xuất | Mở lại giữ metadata và form. | ✅ `src/export/pdf-preserve.ts` + 9 test: sao chép metadata (`/Lang`, Info), cây bookmark `/Outlines` phân cấp và trường AcroForm vào PDF xuất, kiểm lại bằng `pdfjs-dist` |
| H10 | **P2** | Diff hai phiên bản tài liệu (text + visual) | Chỉ ra thay đổi có toạ độ. | ✅ `src/core/visual-diff.ts` + 18 test (cùng `diff.ts` 13 test): diff RGBA + SSIM luminance, mask vùng động, lọc nhiễu speckle OCR, gộp bbox vùng đổi với text diff |
| H11 | **P1** | Redaction PII: CCCD/CMND, số tài khoản, MST, địa chỉ | Redact đúng vùng, không lộ số. | ✅ `src/core/redact.ts` + 30 test: mỗi rule cần label/checksum/Luhn, plan gộp span + confidence floor, apply giữ nguyên phần còn lại, report không chứa giá trị |
| H12 | **P1** | Redaction có review trước khi áp dụng | Preview và diff trước/sau. | ✅ `planRedaction` trả `kept`/`skipped` kèm lý do để duyệt trước khi `applyRedaction` |
| H13 | **P3** | Form filling và flatten | Điền field, flatten có cảnh báo. | ✅ `src/export/pdf-forms.ts` + 7 test (cùng `forms.ts` 34 test): đọc/điền text/checkbox/dropdown/radio, xuất JSON, `flatten` an toàn và giữ đủ cảnh báo read-only/signature |
| H14 | **P1** | Validation mở file trên nhiều reader, không lỗi font | Mở được trên ≥2 PDF reader. | ✅ `checkExport` + 32 test: header/EOF, page count, font nhúng, text layer, câu nguồn còn sót, size cap |
| H15 | **P2** | Render công thức trong PDF xuất (LaTeX → drawing) | Công thức hiện đúng, không crash. | ✅ `src/export/tex.ts` + 30 test: phân số có rule, script shift/scale, sqrt, fit theo box, `toSvg` escape, `plainText` cho text layer |
| H16 | **P1** | Xử lý tài liệu rất dài (500+ trang) | Chunk, checkpoint, resume. | ✅ `src/core/longform.ts` + 32 test: chunk theo budget, checkpoint ghi trước khi tính done, crash ở chunk 33/500 vẫn resume đúng một lần mỗi trang |

### I. AI Assistant, RAG & multi-document intelligence — 14 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| I01 | **P0** | Chat answers với citation trang+vùng source | Click citation highlight đúng block, không chỉ page. | ✅ `src/ui/citation-highlight.ts` + 11 test (cùng `citations.ts` 24 test + native 15 test): chip điều hướng bàn phím/Escape và overlay SVG đa giác/bbox highlight đúng block nguồn |
| I02 | **P1** | Hybrid retrieval BM25 + embeddings trên Document IR | Truy vấn trả top-k kèm score và nguồn. | ✅ `src/core/hybrid-retrieval.ts` + 24 test (cùng `retrieval.ts` 18 test): embeddings cục bộ n-gram/TF-IDF, cosine + RRF ghép BM25, lọc document/page/kind/section, 0 network |
| I03 | **P1** | Chunking hiểu bảng và section thay vì chia text máy móc | Chunk theo section/bảng, không cắt giữa công thức. | ✅ `chunkDocument`: section theo outline, bảng + caption riêng, cắt câu có overlap, không cắt trong công thức; 18 test |
| I04 | **P1** | Hỏi đáp trên nhiều PDF với citation theo tài liệu | Câu trả lời nêu rõ tài liệu/trang. | ✅ `src/core/multi-document.ts` + 20 test: chia budget, fence theo doc, citation không có trong context bị báo unsupported, evidence matrix |
| I05 | **P1** | Ask selected text/figure/table and explain | Context ưu tiên vùng người dùng chọn. | ✅ `src/core/ask-selection.ts` + 21 test: mở rộng về whole block, secondary có giới hạn, fence chống đóng sớm, `grounded=false` khi không overlap |
| I06 | **P1** | Query rewriting / decomposition | Câu hỏi phức tạp được tách và viết lại. | ✅ `src/core/query.ts` + 32 test: bỏ từ hỏi, giữ số và quoted span, synonym VN↔EN, mỗi intent một query, keyword là token của BM25 |
| N07 | **P1** | Đo p50/p95 cho startup, OCR, translate, export, memory | Có số thật theo build. | ✅ `src/core/metrics.ts` + `docs/metrics.md` + 22 test: 9 metric có đơn vị, series theo tag, so baseline ngưỡng 10% p95, phân biệt "không hồi quy" với "không đo" |
| I07 | **P1** | So sánh nhiều tài liệu và tạo evidence matrix | Mỗi khác biệt có trích dẫn và trang. | ✅ `src/core/evidence-matrix.ts` + 32 test: cell có page/block/excerpt, gap khác zero, conflict/agree, CSV + Markdown |
| I08 | **P1** | Agent tools: navigate_page, crop, zoom, OCR_region, search, cite | Ghi tool call + kết quả, có budget. | ✅ `src/core/agent-tools.ts` + 48 test: 6 tool có type/return, validate không coerce, planner theo intent có trần 6 bước |
| I10 | **P2** | Figure/formula explanation dưới dạng multimodal | Nhận thức từ image crop và trả giải thích. | ✅ `src/core/multimodal.ts` + 26 test: plan theo pixel budget (không upscale), prompt theo loại figure/chart/formula, parse số bịa thì bỏ và đếm, thiếu description thì từ chối |
| I11 | **P0** | Không đủ bằng chứng thì báo không đủ, không bịa | Abstain trước khi trả lời. | ✅ `src/core/abstain.ts` + 16 test: coverage/floor, câu hỏi số không có chữ số → abstain, câu yes-no không xác nhận → abstain, `guardAnswer` chặn câu trả lời không citation |
| I09 | **P2** | Table Q&A có cell provenance và phép tính kiểm chứng | Trả kết quả số + cách tính. | ✅ `src/core/table-qa.ts` + 21 test: sum/count/max/min/compare/lookup kèm cell đã dùng, phát hiện total lệch 1 và cột % cộng 102 |
| I12 | **P1** | Eval harness cho answer quality (citation hit, abstention) | Bảng điểm theo case cố định. | ✅ `src/core/reranker.ts` + `tests/eval-corpus.test.ts` + 18 test (cùng `eval-harness.ts` 24 test): cross-feature local reranker + 20-case cố định (multi-doc/bảng/abstain/injection) đạt 1.00 |
| I13 | **P2** | Multi-turn conversation với context window | Hội thoại nhiều lượt vẫn đúng nguồn. | ✅ `src/core/conversation.ts` + 31 test: giữ 4 lượt cuối bất kể budget, đếm `droppedTurns`, citation gộp theo lượt, prune không để lại 0 lượt user |
| I14 | **P2** | Notes/flashcards tự sinh từ tài liệu | Tạo ghi chú học tập có nguồn. | ✅ `src/core/notes.ts` + 25 test: section theo outline, point có trần mỗi section, definition EN/VI, formula kèm LaTeX, mọi entry có page+blockId, Anki CSV RFC4180 |

### J. Research & paper workflow — 10 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| J01 | **P1** | DOI/arXiv detection, authors, venue, references | Metadata đúng, tạo được BibTeX. | ✅ `src/core/paper-metadata.ts` + 10 test (cùng `bibtex.ts` 26 test): tách title/authors/venue/DOI/arXiv/references từ IR, ghép Crossref/Semantic Scholar qua `scholar.ts` có bước duyệt + xuất BibTeX |
| J02 | **P2** | BibTeX/RIS import/export + Zotero bridge | Import/export chuẩn, key ổn định. | ✅ `src/core/ris-zotero.ts` + 9 test: parser/serializer RIS chuẩn, chuyển CSL-JSON, dedupe key ổn định với BibTeX và cầu Zotero chỉ nhận loopback `127.0.0.1`/`localhost` |
| J03 | **P2** | Citation graph/tìm paper liên quan | Đồ thị citation tương tác. | ✅ `src/core/citation-graph.ts` + 47 test: resolve theo DOI rồi title+year, stub cho cái không resolve, related/coCitation, DOT + JSON |
| J04 | **P2** | Semantic Scholar/Crossref enrichment | Có metadata, abstract, citation count. | ✅ `src/core/scholar.ts` + 32 test: DOI/arXiv normalise, build URL, parse 2 nguồn, merge có provenance |
| J05 | **P2** | Notes/backlinks liên kết tới trang và trích đoạn | Note trỏ đúng vị trí, hiện backlink. | ✅ cùng module `annotations.ts`: quote, backlinks, reanchor |
| J06 | **P2** | Paper comparison matrix method/data/metrics/limitations | Cell có citation cụ thể, tránh suy diễn. | ✅ `src/core/paper-matrix.ts` + 22 test: ma trận method/dataset/metrics/limitations, mọi ô có quote nguyên văn + provenance hoặc `not_reported`, xuất Markdown/CSV/JSON |
| J08 | **P2** | Clean/reflow reading mode for papers | Giữ công thức, footnote, citations khi reflow. | ✅ `src/core/paper-reflow.ts` + 18 test: reflow 1 cột từ PDF 2 cột, giữ LaTeX inline/display, footnote neo ngược, caption/citation và ánh xạ 2 chiều `reflowId <-> page/rect` |
| J09 | **P3** | Study pack: flashcards, questions, concept map | Generated content liên kết tới sources. | ✅ `src/core/study-pack.ts` + 13 test: thẻ ghi nhớ Anki CSV/TSV, câu hỏi kèm đáp án trích dẫn kiểm chứng và sơ đồ khái niệm Mermaid gắn `(page, blockId)` |
| J10 | **P3** | Research library smart collections theo topic/author/year | Filter, tag, duplicate merge có xác nhận. | ✅ `src/core/smart-collections.ts` + 12 test: lọc topic/author/year/venue/tag, thao tác tag hàng loạt, phát hiện trùng DOI/arXiv/title và confirm-before-merge kèm rollback |
| J07 | **P2** | So sánh methodology/dataset/metric giữa paper | Bảng so sánh có trích dẫn. | ✅ `src/core/paper-compare.ts` + 23 test: mỗi cell có câu trích + section + score, gap có lý do, consensus/divergence chỉ từ cell |

### K. Document workflow & structured extraction — 10 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| K01 | **P1** | Template trích fields dưới dạng schema JSON | Field có value, bbox, confidence, type, validator. | ✅ `src/core/schema.ts` + 26 test: 6 kiểu field, chuẩn hoá số/ngày/tiền, ambiguity báo chứ không đoán |
| K03 | **P1** | Batch jobs: pause/cancel/retry, progress | Hàng đợi có trạng thái rõ, không treo. | 🟢 `src/core/queue.ts` exposes per-job state/progress/subscriptions; durable runtime supports bounded concurrency, pause/cancel/retry; UI wiring remains outside this local lane |
| K04 | **P1** | Batch API/CLI với folder watcher | Chạy được batch không cần UI. | 🟢 CLI executes extract/export locally, recursively polls a persisted snapshot, coalesces changes, enforces file/byte caps, and keeps dry-run/check side-effect free |
| K05 | **P1** | Human review queue cho field thiếu chắc chắn | Confidence thấp vào queue, có accept/reject. | ✅ `src/core/review.ts` + 15 test: chỉ field dưới ngưỡng hoặc lỗi vào queue, quyết định có audit, lần hai trả AlreadyDecided, export/apply round-trip |
| K06 | **P2** | Rule engine auto-tag/classify/date/vendor/document type | Mỗi rule có preview và override. | 🟢 Existing deterministic rules are executed in the durable pipeline with persisted results and overrides |
| K07 | **P2** | Review/approve queue cho tài liệu lỗi hoặc low-confidence | Thống kê unresolved fields, không tự xuất sai. | 🟢 Pending review items block completion/export; boundary exposes list/approve and runtime exposes review counts |
| K08 | **P2** | Webhook/REST API/CLI hoặc local MCP document tools | Auth, permission, audit và rate limits. | 🟢 Local boundary/MCP exposes permissioned operations, authorized roots, audit and rate limiting; no remote listener |
| K09 | **P2** | Document versioning với immutable source và derived artifacts | Khôi phục/so sánh từng phiên bản. | 🟢 Immutable source snapshots plus atomic version store, restore and compare |
| K10 | **P3** | Team workspace chia sẻ, quyền theo document/collection | RBAC và audit đủ cho tổ chức. | ⚪ Deferred: shared multi-user workspace and per-document RBAC are not local-only and have no approved deployment/auth scope |
| K02 | **P1** | Folder watcher + import tự động | Thả file vào folder là tự xử lý. | ✅ `src/core/watcher.ts` + 38 test: glob + ignore mặc định, diff snapshot (mtime-only → `maybeTouch`), coalesce theo cửa sổ cố định |

### L. Reader UX, Chrome extension & desktop — 10 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| L01 | **P0** | Native messaging Chrome↔Rust real E2E | Gửi PDF và roundtrip event qua Chrome thật.  ⬜ |
| L02 | **P0** | Live mirror thực tế với capture permissions | Test tab/window/screen, không loop capture.  ⬜ |
| L03 | **P1** | Một unified job progress UI web/extension/desktop | Có phần trăm từng stage và cancel thật.  ⬜ |
| L04 | **P1** | Bi-directional scroll/selection sync theo document coordinates | Click highlight pane nguồn focus đúng pane dịch.  ⬜ |
| L05 | **P2** | Quick actions từ selection (menu/dropdown) | Chọn là ra hành động đúng ngữ cảnh. | ✅ `src/core/selection-actions.ts` + 35 test: translate/copy/cite/note/glossary/search/web/define/redact, disable kèm lý do |
| L06 | **P2** | Reading modes: original/translation/bilingual/interleave | Chuyển mode giữ đúng vị trí đọc. | 🟡 `src/core/reading-modes.ts` + 12 test: 4 mode phủ kín viewport, đổi mode giữ trang và progress <1%; **UI chưa nối** |
| L07 | **P2** | Selection → glossary/citation với 1 click | Tạo glossary/citation nhanh. | ✅ cùng `selection-actions.ts`: nhóm `annotate` + `research`, phân loại selection (word/phrase/sentence/number/email/url) |
| L09 | **P2** | Quick actions/palette từ selection | Chọn text hiện palette hành động. | 🟡 `src/core/commands.ts` + 29 test: registry fuzzy + chord + nhóm; **UI palette chưa nối** |
| L10 | **P3** | Offline desktop model manager với download/checksum/quantization | Model download opt-in, xoá được, báo RAM/VRAM.  ⬜ |
| L08 | **P2** | Drag/drop nhiều file, thư mục | Drop folder hoạt động. | ✅ `src/core/drop.ts` + 24 test: format theo extension, duplicate theo tên+size, folder defer có lý do, caps tham lam, code lỗi rõ |

### M. Privacy, bảo mật và quản trị — 8 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| M01 | **P0** | Privacy modes Offline-only/Ask/Cloud-enabled | Không network trong Offline-only, e2e test. | ✅ `src/core/privacy.ts` + 20 test: offline = **0 fetch** kể cả batch, loopback vẫn chạy, ask cần consent |
| M04 | **P1** | Encryption at rest cho dữ liệu local | File DB mã hoá bằng key/passphrase. | ✅ `src/core/crypto.ts` + 24 test: PBKDF2 600k + AES-GCM, salt/IV mỗi lần, sai passphrase hay tamper đều WrongPassphrase, 1 KB thành 1505 B |
| M05 | **P1** | Audit log local: file nào, ai, khi nào, export gì | Truy vết được mọi thao tác. | ✅ `src/core/audit.ts` + 25 test: 8 loại event, chặn detail giống secret, chain SHA-256 phát hiện sửa, report mask giá trị |
| M06 | **P2** | Audit log consent/cloud route per document/job | Biết file nào dùng engine nào và tại sao.  🟡 `recordConsentDecision` + unit coverage records provider/mode/scope/consent without endpoint or payload; full call-site integration remains open |
| M08 | **P2** | Local-only mode + audit trail cho cloud call | Biết cái gì đã gửi lên cloud. | ✅ cùng `audit.ts` (kind translate/export) + `privacy.ts` chặn mạng; audit ghi lại quyết định |
| M07 | **P1** | Preview chính xác nội dung sẽ gửi cloud | Xem payload trước khi consent. | ✅ `src/core/payload-preview.ts` + 21 test: characters/bytes tính từ text thật (không từ preview), endpoint scope theo effective endpoint, redact preview, cost null khi thiếu giá |
| M02 | **P1** | Data retention + xoá vĩnh viễn có xác nhận | Không giữ dữ liệu ngoài ý muốn. | ✅ `src/core/capabilities.ts` + 39 test: 4 mode × 6 capability, 7 action phân loại, `CapabilityError`; xoá qua `deleteDocument` + purge 30 ngày |
| M03 | **P2** | Permission model theo mode (reader/local/cloud/automation) | Mỗi mode chỉ làm được việc đã khai. | ✅ cùng `capabilities.ts`: matrix frozen, mode lạ/action lạ bị từ chối thay vì map mặc định |

### N. Đo chất lượng, quan sát và phát hành — 8 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| N02 | **P0** | Nối AbortController thật tới tất cả provider calls | Cancel không sinh result stale hoặc tốn request ngoài ý muốn.  ⬜ |
| N03 | **P1** | i18n matrix test cho 3 ngôn ngữ | Không missing key, không lệch placeholder. | ✅ `src/core/i18n-audit.ts` + `scripts/i18n-matrix.mjs` + 16 test: so key set, placeholder theo thứ tự, cờ untranslated, xanh trên 3 từ điển thật |
| N04 | **P1** | Accessibility audit (contrast, role, focus order) | Không lỗi a11y nghiêm trọng. | ✅ `src/core/a11y.ts` + 33 test: contrast AA/UI + gợi ý màu đạt, lỗi cấu trúc, focus order + cảnh báo tabIndex dương |
| N05 | **P1** | Benchmark OCR: CER/WER theo ngôn ngữ và loại ảnh | Bảng số thật, so sánh engine. | 🟡 `src/core/ocr-metrics.ts` + `scripts/ocr-benchmark.mjs` + checked-in synthetic golden fixture; **execution and difficult-image numbers remain open** |
| N06 | **P1** | Benchmark chất lượng dịch theo loại tài liệu | Bảng điểm thật, so sánh model. | 🟡 `src/core/perf.ts` + `scripts/perf-budget.mjs` + `docs/performance.md`: baseline p95 thật (chunk 2.71 ms, index 8.98 ms, search 0.89 ms, diff 11.74 ms) |
| N08 | **P2** | Release checklist có gate (tests, licences, i18n, a11y) | Checklist tự chạy, thiếu là fail. | ✅ `src/core/release-gate.ts` + `scripts/release-check.mjs` + `docs/release-checklist.md` + 36 test: unit>0, e2e≥40, gate xanh, notice đủ, changelog, artifact |

## 2. Kiến trúc đề xuất (không giả định đã tồn tại trong repo)

```text
Input: Browser / Chrome extension / Rust GPUI desktop / Folder watch / API
  -> Ingestion Gate (magic bytes, quotas, permissions, privacy profile)
  -> Document Classifier (born-digital / scanned / hybrid; per page)
  -> Parsing Router
       native text+geometry (PDF.js / PDFium)
       OCR engine adapter (Tesseract / PaddleOCR / others)
       layout/formula/table adapter (Docling / PaddleOCR / optional GPU)
       Agentic Vision tools: crop, zoom, rotate, re-OCR region on demand
  -> Canonical Document IR (immutable source, page polygons, semantic graph)
       -> Translation service (TM, glossary, placeholder protection, QA)
       -> Evidence Index (BM25 + embeddings, exact page-region provenance)
       -> Extraction service (schema, validators, human review)
  -> Output layer
       PDF writer (mono/dual/searchable), DOCX, Markdown, HTML, JSON, CSV
       overlay renderer / AI chat / research notes / workflow automation
  -> Job engine + cache + consent + audit + regression telemetry
```

**Document IR contract:** `document_id`, `revision_id`, `source_sha256`, `pages[]`, `blocks[]` (`block_id`, `type`, `page`, `polygon`, `reading_order`, `raw_text`, `language`, `confidence`, `children[]`, `relations[]`), `translations[]` (`lang`, `engine`, `model_version`, `prompt_version`, `text`, `qa_status`), `provenance[]` (`source_block_ids`, `ocr_engine`, `model`, `transform`), `annotations[]`, `exports[]`. Version schema, support migrations and do not overwrite source bytes.

**OCR/router principle:** digital text first; OCR only scanned/hybrid sections; high-cost visual agent only on low-confidence regions, user selection or evidence gaps. This prevents the architecture turning into a mandatory heavy multi-model pipeline.

## 3. Phased plan

| Giai đoạn | Mục tiêu | Gợi ý tiêu chí chặn release |
|---|---|---|---|
| Gate 0 — Trust | Dứt 17 mục 🟡, chỉnh abort/consent/vault, hệ thống test | Không claim ✅ khi thiếu test thật |
| Gate 1 — Core output | G01, H01-H03, E01/E04, F05, N03/N04 | PDF hợp lệ, CJK fonts, source unchanged, visual inspection |
| Gate 2 — Document Intelligence | E02-E08, F02-F09, I01-I08 | Table/formula OCR và cited answers có tọa độ, đo chất lượng |
| Gate 3 — Workflows | G04-G13, H04-H14, J01-J08, K01-K09 | User review, editable outputs, stable job resumes |
| Gate 4 — Enterprise | M03-M08, K10, H15-H16, L08-L10 | Permission, retention, threat-model, license audit |

## 4. Open-source/build/reference links và giấy phép cần kiểm tra

- **Docling** — https://github.com/docling-project/docling — MIT code (kiểm thêm model/dependency licenses).
- **PaddleOCR** — https://github.com/PaddlePaddle/PaddleOCR — Apache-2.0 project code (kiểm weights từng model).
- **OCRmyPDF** — https://github.com/ocrmypdf/OCRmyPDF — pipeline OCR searchable PDF; kiểm dependencies Ghostscript/Tesseract.
- **pdf-lib** — https://github.com/Hopding/pdf-lib — JS PDF creation/modification; không phải drop-in full layout recreation engine.
- **MinerU** — https://github.com/opendatalab/MinerU — giấy phép riêng; đọc tại thời điểm tích hợp.
- **PDFMathTranslate** — https://github.com/PDFMathTranslate/PDFMathTranslate — AGPL-3.0.
- **BabelDOC** — https://github.com/funstory-ai/BabelDOC — AGPL-3.0.
- **Surya / Marker** — https://github.com/VikParuchuri/surya và https://github.com/datalab-to/marker — hạn chế licensing liên quan code/weights; kiểm bản đang triển khai.
- **MuPDF** — https://mupdf.readthedocs.io/en/latest/license.html — AGPL hoặc commercial license; không thay thế PDFium mà bỏ qua legal review.
- **GROBID** — https://github.com/grobidOrg/grobid — academic metadata/citation parsing.
- **RAGFlow** — https://github.com/infiniflow/ragflow — reference RAG chunking, deep parsing, citations.
- **Paperless-ngx** — https://github.com/paperless-ngx/paperless-ngx — workflow, document archive.
- **AgenticOCR** — https://github.com/OpenDataLab/AgenticOCR — query-driven OCR; kiểm code license + model/provider deps.

**Quan trọng:** AGPL không phải lệnh cấm thương mại. Nó tạo nghĩa vụ copyleft cần đánh giá theo mô hình phân phối/triển khai và kết hợp mã. Tài liệu này không phải tư vấn pháp lý. Chọn adapter/clean-room implementation khi cần; không sao chép code chỉ vì có repository public.

## 5. Bộ benchmark bắt buộc trước khi claim quality

- PDF test matrix: born-digital, scanned, hybrid, 2/3 cột, journal article, biểu mẫu, technical datasheet, hoá đơn, hợp đồng, bảng lớn, biểu đồ, footnotes, font nhúng/thiếu, PDF lỗi, passworded, RTL, CJK, vertical text, handwriting.
- Language matrix: vi, en, zh-Hans, zh-Hant, ja, ko, ar, he; tách OCR coverage vs translation coverage.
- OCR: CER/WER và confidence calibration; text reading order; table TEDS/structure F1; formula exact/token edit distance.
- Translation: terminology consistency, digit/unit invariance, numeric negation checks, paired human eval + chrF/COMET if evaluation setup is appropriate.
- Export: raster image diff per page (source vs target with masks), missing fonts/tofu, overflow, broken bookmarks/hyperlinks, selectable/searchable text, multi-reader compatibility.
- AI QA: exact source region citation hit rate, evidence support, abstention on unanswerable queries, tool cost/time, injection tests.
- Performance: p50/p95 CPU/RAM/GPU usage, 10/100/500-page PDF, cold/warm start, 1/100 concurrent jobs, offline/no-network test.

## 6. Những điều không được tự động coi là đã có

1. 66 ✅ là trạng thái do chủ dự án cung cấp, không phải em đã chạy repo.
2. 17 🟡 đang chờ nghiệm thu; không tính là đã hoàn thành.
3. 120 mục E–N đều là backlog đề xuất, chưa triển khai; có hạng mục cùng phạm vi với A–D nên không cộng cơ học thành 203 chức năng độc lập.
4. Một tính năng được thấy ở sản phẩm thương mại chỉ là nguồn inspiration, không phải chứng cứ có thư viện SDK hoặc mã nguồn tương đương.
5. Chỉ bật bất kỳ cloud OCR/translation/chat khi đã có explicit consent; offline mode không fallback âm thầm lên cloud.
| N01 | **P1** | Export → re-import round-trip tương thích | Mở lại không mất dữ liệu. | ✅ `src/core/roundtrip.ts` + 17 test: so từng field theo identity, tolerance chỉ cho số đo, codec phải khai báo mất mát |
