# Ghi chú tham khảo từ các repo mã nguồn mở

Cập nhật: 2026-11-20. Bản clone `--depth 1` nằm ở `C:\refs\<tên repo>` (script `scripts/clone-references.ps1`).

Mục đích: biết **học thiết kế gì** và **được phép/không được phép** chép gì, cho từng mục backlog E–N.

> Nguyên tắc: chỉ đọc để học kiến trúc. Repo AGPL (BabelDOC, PDFMathTranslate, MuPDF) **không chép code** vào sản phẩm; nếu cần thì viết lại từ đầu theo thiết kế.

| Repo | Giấy phép | Đáng học | Mục backlog liên quan |
|---|---|---|---|
| docling | MIT | `docling/datamodel/document.py` — schema tài liệu (pages/blocks/relations) là tham chiếu tốt cho IR | E03, E04, E05, E08, K01 |
| OCRmyPDF | MPL-2.0 | `src/ocrmypdf/{hocr_parser,hocr_to_ocr_pdf,pdf_to_hocr}.py` — cách tạo **text layer vô hình** đè lên ảnh scan | F05, H01, H14 |
| BabelDOC | AGPL-3.0 | `babeldoc/docvision/*` (layout), `babeldoc/format`, `babeldoc/utils` — kiến trúc layout-preserving, không chép code | G01, G07, H02, H03 |
| PDFMathTranslate | AGPL-3.0 | `pdf2zh/` pipeline parse → translate → typeset | G01, G02, G09 |
| AgenticOCR | xem repo | `src/AgenticOCR.py`, `src/RAGAgent.py` — agent dùng tool crop/zoom/OCR theo câu hỏi, có trace | F07, F08, I08, I11 |
| OCR-Agent | xem repo | `ocr_agent/` — vòng lặp agent + tool OCR | F07, I08 |
| AgentOCR | xem repo | `agent_system/` — planner/executor tách vai | I08, K05 |
| pdf-lib | MIT | `PDFDocument.create`, `embedFont`, `embedPng`, `drawImage`, `drawText` — nền của A26 | A26, G01, G02, H01 |
| paperless-ngx | GPL-3.0 | `src/documents/` — consumer/workflow: import → classify → OCR → tag | K03, K04, K05, K06 |
| grobid | Apache-2.0 | trích metadata/citation học thuật (clone lỗi, đọc qua API khi cần) | J01, J02, J04 |

## Ba kỹ thuật nên áp dụng sớm

1. **Text layer vô hình (OCRmyPDF/F05)**: mỗi vùng OCR sinh glyph trong suốt (render mode 3) đúng toạ độ bbox, đặt **dưới** ảnh gốc. Kết quả: file vẫn là ảnh nhưng chọn/copy/tìm được. Đây là cách duy nhất để "scan + searchable" mà không làm mờ chữ gốc.
2. **Layout-preserving typeset (BabelDOC/G07)**: không vẽ lại trang; giữ ảnh gốc, chỉ che vùng chữ nguồn rồi vẽ chữ dịch; khi chữ tràn thì hạ font-size có ngưỡng, sau đó mới reflow, và **luôn ghi cờ cảnh báo** để người dùng biết vùng nào bị ép.
3. **Query-driven OCR (AgenticOCR/F07)**: chỉ crop + OCR vùng mà câu hỏi cần; tool trace lưu `{tool, args, result_bbox}` để citation của AI chỉ đúng hình chữ nhật nguồn (I01/I11).

## Điều không được làm

- Không copy code AGPL/GPL vào `src/` hay `native-shell/` (BabelDOC, PDFMathTranslate, paperless-ngx).
- Không đóng gói model weights của bên thứ ba khi chưa đọc license của weights (PaddleOCR, MinerU, Surya).
- Không gọi cloud OCR/dịch khi người dùng chưa cấp consent (M01, M07).
