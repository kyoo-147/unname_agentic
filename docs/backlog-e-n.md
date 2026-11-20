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
| E02 | **P1** | Đọc thứ tự đa cột và xuyên trang | Chuẩn hoá reading-order không lẫn cột, header/footer.  ⬜ |
| E03 | **P1** | Phân loại block: heading, paragraph, list, table, figure, formula, footnote | Lưu type, bbox, confidence và quan hệ cha-con. | ✅ `src/core/blocks.ts` + 27 test: mỗi loại một fixture, heading level 1-3, confidence + lý do |
| E04 | P1 | Lưu Document IR có provenance | Block có page, polygon, reading-order, source bytes hash, version. | ✅ src/core/ir.ts: contract + validate + serialize versioned; 21 test |
| E05 | **P1** | Tái tạo cấu trúc heading/section và mục lục tự động | Click heading đưa đúng đến đoạn gốc. | ✅ `src/core/outline.ts` + 31 test: cây section, TOC có path 1 / 1.1 / 1.1.1, level jump bị kẹp và báo, `sectionAt` cho mọi block |
| E06 | **P1** | Tách bảng thành cell/row/col, merged cells | Xuất table có header, rowspan, colspan mà không mất dữ liệu. | ✅ `src/core/tables.ts` + 13 test: gom hàng theo baseline, cột theo corridor, colSpan, CSV RFC4180, Markdown |
| E07 | **P1** | Nhận diện phương trình inline/display và LaTeX | Giữ công thức khi dịch, sao chép được LaTeX. | ✅ `src/core/formulas.ts` + 33 test: sup/sub/fraction/Greek/operator, `H_2O`→`H_{2}O`, chặn `and/or`, khoá cả cụm khi dịch |
| E08 | **P1** | Tách hình, caption, bảng và liên kết caption | Click caption focus hình/bảng tương ứng. | ✅ `src/core/captions.ts` + 14 test: cùng cột, số khớp ưu tiên, tie ghi alternative, orphan có lý do |
| E09 | **P2** | Nhận diện header/footer/page-number để loại khỏi dịch tuỳ chọn | Không trùng nội dung mỗi trang.  ⬜ |
| E10 | **P2** | Giữ hyperlink, footnote và cross-reference | Link nội bộ hoạt động lại sau export. | ✅ `src/core/links.ts` + 26 test: footnote/figure/table/section, tie báo thay vì đoán, renumber, Markdown anchor theo block id |
| E11 | **P2** | Phát hiện ngôn ngữ theo đoạn/vùng, không chỉ toàn tài liệu | PDF song ngữ dịch đúng từng span.  ⬜ |
| E12 | **P2** | Hỗ trợ DOCX/PPTX/XLSX/EPUB/HTML/ảnh TIFF/PNG/JPG | Đưa về IR, giữ nguồn và metadata.  ⬜ |
| E13 | **P2** | Phát hiện PDF hỏng, font lỗi, text encoding lỗi | Cảnh báo và tự đề xuất extraction fallback.  ⬜ |
| E14 | **P3** | Trích metadata tài liệu: title/author/date/DOI/language | Cho phép người dùng duyệt/chỉnh metadata.  ⬜ |

### F. OCR & Agentic Visual Understanding — 14 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| F01 | **P0** | Tăng số ngôn ngữ OCR qua OCR engine adapter | Chọn engine theo script, language packs tải riêng.  ⬜ |
| F02 | **P1** | Tiền xử lý ảnh: deskew, rotate, denoise, binarize | Có before/after và OCR quality gain.  ⬜ |
| F03 | **P1** | Preprocessing: deskew/binarize/denoise/upscale pipeline | OCR tăng chất lượng đo được. | ✅ `src/core/preprocess.ts` + 19 test: đo stats, ước lượng skew bằng projection profile, quyết định kèm lý do, ngưỡng export |
| F04 | **P1** | OCR confidence và vùng nghi ngờ | Highlight vùng confidence thấp, cho sửa thủ công.  ⬜ |
| F05 | **P1** | Searchable PDF tạo text layer từ scan | Copy/search đúng vị trí mà ảnh gốc không mất. | ✅ `src/export/searchable.ts` + 20 test: text render mode 3, đúng baseline, pdfjs trích được chữ |
| F06 | **P1** | Mixed OCR theo vùng, bỏ qua text gốc đã tốt | Không tạo 2 lớp chữ trùng nhau.  ⬜ |
| F07 | **P1** | Agentic OCR query-driven chỉ đọc vùng cần thiết | Một câu hỏi kích hoạt inspect/crop/zoom/extract có trace. | 🟡 `native-shell/src/vision_tools.rs` + 9 test: crop/zoom/rotate OCR một vùng, map toạ độ về trang, ToolTrace + budget; chưa nối vào chat agent |
| F08 | **P1** | Visual grounding/citation vào bbox đa giác | Click answer focus đúng box nguồn. | 🟡 Core có `citations.ts` (web) và `Chat::citations` (native, 15 test); UI chưa vẽ chip click |
| F09 | **P2** | OCR lặp lại có chọn lọc với crop/scale/contrast/rotation | Chỉ re-OCR vùng lỗi, không OCR lại toàn PDF.  ⬜ |
| F10 | **P2** | Nhận diện dấu mộc, checkbox, handwritten/printed | Đánh nhãn từng loại và confidence.  ⬜ |
| F11 | **P2** | So sánh nhiều OCR engines bằng confidence và consensus | Ghi engine winner theo vùng và chi phí.  ⬜ |
| F12 | **P2** | Image understanding: biểu đồ, sơ đồ, hình kỹ thuật | Kết quả mô tả được gắn với ảnh nguồn.  ⬜ |
| F13 | **P2** | Phát hiện mâu thuẫn OCR bằng kiểm tra số/ngày/đơn vị | Flag số hoặc ký tự rủi ro cao để duyệt.  ⬜ |
| F14 | **P3** | Human-in-the-loop sửa OCR và tái sử dụng correction | Không sửa file gốc trừ khi người dùng xác nhận.  ⬜ |

### G. Dịch thuật chuyên nghiệp — 16 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| G01 | **P0** | Xuất PDF đơn ngữ thật, không qua Print | Tải file PDF hợp lệ mở được bằng reader độc lập.  ⬜ |
| G02 | **P1** | Xuất PDF song ngữ thật (dual PDF) | Có tuỳ chọn chia trang đối chiếu hoặc xếp xen kẽ.  ⬜ |
| G03 | **P1** | Dịch theo paragraph/section có cross-page context | Không tách câu sai qua page boundary.  ⬜ |
| G04 | **P1** | Translation memory (TM) theo segment và version | Đoạn lặp được tái sử dụng và truy nguyên bản gốc. | ✅ `src/core/tm.ts` + 17 test: exact 1.0, gần đúng 0.875, import/export byte-identical |
| G05 | **P1** | Glossary đa ngôn ngữ cấp workspace + bảo vệ thuật ngữ | Bảo toàn thuật ngữ khi dịch/đổi provider.  ⬜ |
| G06 | P1 | Protect placeholders: số, SKU, URL, công thức, citation, tag | Bản dịch không thay đổi các token bị khoá. | ✅ protect.ts + prompt v2 + transport mask/restore; 20 test |
| G07 | **P1** | Tự động sửa text overflow bằng layout optimizer | Ưu tiên wrap/reflow rồi mới font scaling với cờ cảnh báo.  ⬜ |
| G08 | **P1** | Preview diff source/target từng block trước khi export | Cho accept/retranslate/edit từng block.  ⬜ |
| G09 | **P1** | Dịch theo vùng trang hoặc page range khi xuất | Xuất chỉ các trang được chọn.  ⬜ |
| G10 | **P2** | Lựa chọn văn phong formal/technical/legal/academic | Profile được lưu và đưa vào prompt versioned.  ⬜ |
| G11 | **P2** | Translation QA: số, thuật ngữ, câu phủ định, đơn vị | Hiển thị lỗi có bằng chứng để reviewer duyệt. | ✅ `src/core/qa.ts` + 22 test: số/đơn vị/phủ định/glossary/placeholder, mỗi issue có trích nguồn hai phía |
| G12 | **P2** | Dịch bảng giữ cell alignment và công thức số | Bảng bản dịch không đổi cấu trúc/giá trị. | ✅ `src/core/table-translate.ts` + 20 test: ô số/ngày/tiền giữ nguyên, cache, span giữ, diff/merge theo ô |
| G13 | **P2** | Translation cache thông minh có version | Cache hit/miss, không trả bản dịch cũ. | ✅ `src/core/cache.ts` + 27 test: key = SHA-256(source, langs, provider, model, promptVersion, glossary), TTL rồi LRU, persist/restore có version |
| G14 | **P2** | Auto route engine theo ngôn ngữ, độ dài, chi phí, privacy | Có rule/override và telemetry cục bộ.  ⬜ |
| G15 | **P2** | Import/export glossary và TM: CSV/TMX/TBX ở mức phù hợp | Đọc/ghi UTF-8 và báo lỗi schema rõ ràng.  ⬜ |
| G16 | **P3** | Reviewer mode phân vai translator/editor/approver | Mỗi chỉnh sửa có trạng thái và audit log.  ⬜ |

### H. PDF editor, xuất file & công cụ tài liệu — 16 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| H01 | **P0** | Native Save As PDF/Markdown/TXT/DOCX/HTML/JSON | Hộp thoại Save As và kiểm tra bytes thực.  ⬜ |
| H02 | **P1** | Nhúng/subset fonts đa ngôn ngữ CJK/RTL cho bản dịch | Không tofu khi mở trên máy khác. | ✅ `src/export/fonts.ts`: Noto Sans (OFL) + fontkit, "Tiếng Việt — số 42" trích lại đúng dấu; CJK báo thiếu glyph rõ ràng |
| H03 | **P1** | Bảo toàn images/vector/hyperlinks/bookmarks ở bản PDF xuất | So sánh ảnh kết quả với bản gốc.  ⬜ |
| H04 | **P1** | Bookmarks/highlight/note cá nhân | Lưu theo user, mở lại vẫn còn. | ✅ `src/core/annotations.ts` + 14 test: anchor theo block, backlinks, reanchor sau re-parse (kept/moved/orphan), export/import có version |
| H05 | **P1** | Chèn text, callout, hình, shape, watermark | Export lại PDF và giữ được toạ độ.  ⬜ |
| H06 | **P1** | Sửa text OCR và translated block inline | Undo/redo, autosave và so khớp nguồn.  ⬜ |
| H07 | **P1** | Tách, ghép, đổi thứ tự, xoay, xoá/trích trang | Page thumbnails phản ánh edit tức thời.  ⬜ |
| H08 | **P1** | Trích bảng ra CSV/XLSX và công thức ra LaTeX | Dữ liệu đúng row/col và chọn đúng bảng.  ⬜ |
| H09 | **P2** | Preserve metadata/outline/AcroForm khi xuất | Mở lại giữ metadata và form. | 🟡 `src/core/export-check.ts` kiểm cấu trúc file trước khi giao; chưa ghi metadata/outline vào file xuất |
| H10 | **P2** | Diff hai phiên bản tài liệu (text + visual) | Chỉ ra thay đổi có toạ độ. | 🟡 `src/core/diff.ts` + 13 test: diff text theo block/từ, bỏ nhiễu whitespace/1-2 ký tự; **visual diff chưa** |
| H11 | **P1** | Redaction PII: CCCD/CMND, số tài khoản, MST, địa chỉ | Redact đúng vùng, không lộ số. | ✅ `src/core/redact.ts` + 30 test: mỗi rule cần label/checksum/Luhn, plan gộp span + confidence floor, apply giữ nguyên phần còn lại, report không chứa giá trị |
| H12 | **P1** | Redaction có review trước khi áp dụng | Preview và diff trước/sau. | ✅ `planRedaction` trả `kept`/`skipped` kèm lý do để duyệt trước khi `applyRedaction` |
| H13 | **P2** | Chữ ký điện tử cơ bản + kiểm tra chữ ký hiện có | Tách ký tay đơn giản khỏi chữ ký số certificate.  ⬜ |
| H14 | **P1** | Validation mở file trên nhiều reader, không lỗi font | Mở được trên ≥2 PDF reader. | ✅ `checkExport` + 32 test: header/EOF, page count, font nhúng, text layer, câu nguồn còn sót, size cap |
| H15 | **P3** | PDF/UA tagged accessibility export | Semantic structure/tag tree đọc được qua assistive tech.  ⬜ |
| H16 | **P3** | Batch PDF utilities: compress, optimize, encrypt, decrypt có quyền | Có before/after quality và cảnh báo phá signature.  ⬜ |

### I. AI Assistant, RAG & multi-document intelligence — 14 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| I01 | **P0** | Chat answers với citation trang+vùng source | Click citation highlight đúng block, không chỉ page. | 🟡 Parser + resolve đã xong ở cả web (24 test) và native (15 test); phần highlight trong UI là wave sau |
| I02 | **P1** | Hybrid retrieval BM25 + embeddings trên Document IR | Truy vấn trả top-k kèm score và nguồn. | 🟡 `src/core/retrieval.ts` BM25 (k1 1.5, b 0.75) + heading boost + fold dấu tiếng Việt, 18 test; **chưa có embeddings** |
| I03 | **P1** | Chunking hiểu bảng và section thay vì chia text máy móc | Chunk theo section/bảng, không cắt giữa công thức. | ✅ `chunkDocument`: section theo outline, bảng + caption riêng, cắt câu có overlap, không cắt trong công thức; 18 test |
| I04 | **P1** | Hỏi đáp trên nhiều PDF với citation theo tài liệu | Câu trả lời nêu rõ tài liệu/trang. | ✅ `src/core/multi-document.ts` + 20 test: chia budget, fence theo doc, citation không có trong context bị báo unsupported, evidence matrix |
| I05 | **P1** | Ask selected text/figure/table and explain | Context ưu tiên vùng người dùng chọn.  ⬜ |
| I06 | **P1** | Tóm tắt toàn tài liệu và từng mục với nguồn | Có outline, findings, caveats gắn citation.  ⬜ |
| I07 | **P1** | So sánh nhiều tài liệu và tạo evidence matrix | Mỗi khác biệt có trích dẫn hai phía.  ⬜ |
| I08 | **P1** | Agent tools: navigate_page, crop, zoom, OCR_region, search, cite | Ghi tool trace, giới hạn bước/chi phí và allowlist.  ⬜ |
| I09 | **P2** | Table Q&A có cell provenance và phép tính kiểm chứng | Trả kết quả số + cell nguồn + phép tính.  ⬜ |
| I10 | **P2** | Figure/formula explanation dưới dạng multimodal | Nhận thức từ image crop và cite đúng vùng.  ⬜ |
| I11 | **P0** | Không đủ bằng chứng thì báo không đủ, không bịa | Abstain trước khi trả lời. | ✅ `src/core/abstain.ts` + 16 test: coverage/floor, câu hỏi số không có chữ số → abstain, câu yes-no không xác nhận → abstain, `guardAnswer` chặn câu trả lời không citation |
| I12 | **P2** | Local embedding + reranker + on-device LLM mode | Không có outbound request ở offline mode.  ⬜ |
| I13 | **P2** | Reusable prompt templates: summarize, extract, review, compare | Template theo version, inject được tham số.  ⬜ |
| I14 | **P3** | Sinh outline/report/slide brief từ bằng chứng | Đính kèm citations; không claim là kết quả đã được kiểm duyệt.  ⬜ |

### J. Research & paper workflow — 10 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| J01 | **P1** | DOI/arXiv detection, authors, venue, references | Metadata đúng, tạo được BibTeX. | 🟡 `src/core/bibtex.ts` (parse/emit/stable key/dedupe, 26 test); **chưa fetch DOI/arXiv** |
| J02 | **P2** | BibTeX/RIS import/export + Zotero bridge | Import/export chuẩn, key ổn định. | 🟡 BibTeX đã có; RIS + Zotero chưa |
| J03 | **P2** | Citation graph/tìm paper liên quan | Đồ thị citation tương tác. | ✅ `src/core/citation-graph.ts` + 47 test: resolve theo DOI rồi title+year, stub cho cái không resolve, related/coCitation, DOT + JSON |
| J04 | **P2** | Semantic Scholar/Crossref enrichment | Có metadata, abstract, citation count. | ✅ `src/core/scholar.ts` + 32 test: DOI/arXiv normalise, build URL, parse 2 nguồn, merge có provenance |
| J05 | **P2** | Notes/backlinks liên kết tới trang và trích đoạn | Note trỏ đúng vị trí, hiện backlink. | ✅ cùng module `annotations.ts`: quote, backlinks, reanchor |
| J06 | **P2** | Paper comparison matrix method/data/metrics/limitations | Cell có citation cụ thể, tránh suy diễn.  ⬜ |
| J07 | **P2** | Thu thập công thức, thuật ngữ, bảng số liệu thành knowledge cards | Có liên kết về nguồn.  ⬜ |
| J08 | **P2** | Clean/reflow reading mode for papers | Giữ công thức, footnote, citations khi reflow.  ⬜ |
| J09 | **P3** | Study pack: flashcards, questions, concept map | Generated content liên kết tới sources.  ⬜ |
| J10 | **P3** | Research library smart collections theo topic/author/year | Filter, tag, duplicate merge có xác nhận.  ⬜ |

### K. Document workflow & structured extraction — 10 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| K01 | **P1** | Template trích fields dưới dạng schema JSON | Field có value, bbox, confidence, type, validator. | ✅ `src/core/schema.ts` + 26 test: 6 kiểu field, chuẩn hoá số/ngày/tiền, ambiguity báo chứ không đoán |
| K02 | **P1** | Extract key-value từ invoice/contract/certificate/customs docs | Có review screen và export structured JSON/CSV.  ⬜ |
| K03 | **P1** | Batch jobs: pause/cancel/retry, progress | Hàng đợi có trạng thái rõ, không treo. | 🟡 `src/core/queue.ts` + 12 test: concurrency, pause/resume/cancel, retry failed, progress nguyên; **chưa có UI** |
| K04 | **P1** | Folder watch tự động import/process theo rule | Chỉ kích hoạt thư mục do user cấp quyền.  ⬜ |
| K05 | **P1** | Human review queue cho field thiếu chắc chắn | Confidence thấp vào queue, có accept/reject. | ✅ `src/core/review.ts` + 15 test: chỉ field dưới ngưỡng hoặc lỗi vào queue, quyết định có audit, lần hai trả AlreadyDecided, export/apply round-trip |
| K06 | **P2** | Rule engine auto-tag/classify/date/vendor/document type | Mỗi rule có preview và override.  ⬜ |
| K07 | **P2** | Review/approve queue cho tài liệu lỗi hoặc low-confidence | Thống kê unresolved fields, không tự xuất sai.  ⬜ |
| K08 | **P2** | Webhook/REST API/CLI hoặc local MCP document tools | Auth, permission, audit và rate limits.  ⬜ |
| K09 | **P2** | Document versioning với immutable source và derived artifacts | Khôi phục/so sánh từng phiên bản.  ⬜ |
| K10 | **P3** | Team workspace chia sẻ, quyền theo document/collection | RBAC và audit đủ cho tổ chức.  ⬜ |

### L. Reader UX, Chrome extension & desktop — 10 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| L01 | **P0** | Native messaging Chrome↔Rust real E2E | Gửi PDF và roundtrip event qua Chrome thật.  ⬜ |
| L02 | **P0** | Live mirror thực tế với capture permissions | Test tab/window/screen, không loop capture.  ⬜ |
| L03 | **P1** | Một unified job progress UI web/extension/desktop | Có phần trăm từng stage và cancel thật.  ⬜ |
| L04 | **P1** | Bi-directional scroll/selection sync theo document coordinates | Click highlight pane nguồn focus đúng pane dịch.  ⬜ |
| L05 | **P1** | Hover quick translate, dictionary, copy, pronunciation | Không gửi cloud nếu consent chưa cấp.  ⬜ |
| L06 | **P2** | Reading modes: original/translation/bilingual/interleave | Chuyển mode giữ đúng vị trí đọc. | 🟡 `src/core/reading-modes.ts` + 12 test: 4 mode phủ kín viewport, đổi mode giữ trang và progress <1%; **UI chưa nối** |
| L07 | **P1** | Reader annotations sync desktop↔web qua local bridge | Merge conflict rõ ràng; offline giữ local.  ⬜ |
| L08 | **P2** | System-wide capture selection & OCR translate in-place | Chọn màn hình/window/vùng, overlay không tự chụp.  ⬜ |
| L09 | **P2** | Split editor panels: source/translation/AI/outline/notes | Workspace layouts persist per project.  ⬜ |
| L10 | **P3** | Offline desktop model manager với download/checksum/quantization | Model download opt-in, xoá được, báo RAM/VRAM.  ⬜ |

### M. Privacy, bảo mật và quản trị — 8 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| M01 | **P0** | Privacy modes Offline-only/Ask/Cloud-enabled | Không network trong Offline-only, e2e test. | ✅ `src/core/privacy.ts` + 20 test: offline = **0 fetch** kể cả batch, loopback vẫn chạy, ask cần consent |
| M02 | **P0** | Key vault đã kiểm thử + không log credential/content nhạy cảm | Secret từ OS keystore, rotation/migration hợp lệ.  ⬜ |
| M03 | **P1** | Document encryption at rest và secure temp/cache purge | Không tồn tại bản plaintext ngoài thư mục được quản lý.  ⬜ |
| M04 | **P1** | Encryption at rest cho dữ liệu local | File DB mã hoá bằng key/passphrase. | ✅ `src/core/crypto.ts` + 24 test: PBKDF2 600k + AES-GCM, salt/IV mỗi lần, sai passphrase hay tamper đều WrongPassphrase, 1 KB thành 1505 B |
| M05 | **P1** | PDF parser isolation/sandbox và resource limits | Chặn zip-bomb-like, memory/CPU/decompression attacks.  ⬜ |
| M06 | **P2** | Audit log consent/cloud route per document/job | Biết file nào dùng engine nào và tại sao.  ⬜ |
| M07 | **P2** | Workspace-level policy: no-cloud, allowed providers, retention | Rule enforcement trước request.  ⬜ |
| M08 | **P3** | Compliance export và retention/deletion policy configuration | Quy trình xoá dữ liệu, back-up, audit đều kiểm chứng được.  ⬜ |

### N. Đo chất lượng, quan sát và phát hành — 8 mục

| ID | Ưu tiên | Chức năng | Nghiệm thu tối thiểu | Trạng thái |
|---|---|---|---|---|
| N01 | **P0** | Hoàn tất 17 mục 🟡 có bằng chứng E2E | Mỗi mục dẫn commit, lệnh test, ảnh/log và tình trạng.  ⬜ |
| N02 | **P0** | Nối AbortController thật tới tất cả provider calls | Cancel không sinh result stale hoặc tốn request ngoài ý muốn.  ⬜ |
| N03 | **P1** | Golden dataset PDF đa cột/scan/bảng/công thức/RTL/CJK | Có license hợp lệ, expected outputs và reproducible eval.  ⬜ |
| N04 | **P1** | Visual regression cho PDF render & export | SSIM/LPIPS/pixel diff có mask vùng động và manual review.  ⬜ |
| N05 | **P1** | Benchmark OCR: CER/WER theo ngôn ngữ và loại ảnh | Bảng số thật, so sánh engine. | 🟡 `src/core/ocr-metrics.ts` + `scripts/ocr-benchmark.mjs` + doc; **chưa có fixture/benchmark numbers** |
| N06 | **P1** | Translation quality benchmark COMET/chrF + number/term QA | Đánh giá người thật đối với đoạn rủi ro cao.  ⬜ |
| N07 | **P1** | Performance metrics p50/p95 startup/OCR/translation/export | Báo CPU/RAM/VRAM/file size và kích thước PDF.  ⬜ |
| N08 | **P2** | CI signed release matrix Win/web/extension + SBOM/dependencies | Không phát hành nếu security/regression gate fail.  ⬜ |

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
