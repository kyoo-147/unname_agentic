import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.MIRROR_TEST_PORT ?? 4319);
const translations = new Map([
  ['Reading without boundaries', 'Đọc không còn rào cản'],
  ['Evidence remains visible', 'Bằng chứng vẫn hiển thị'],
  ['Results and discussion', 'Kết quả và thảo luận'],
  ['A document should keep its shape when the language changes.', 'Tài liệu cần giữ nguyên bố cục khi thay đổi ngôn ngữ.'],
  ['Scientific reading depends on context. Figures, tables and page structure help readers connect a result to its evidence.', 'Đọc tài liệu khoa học cần có ngữ cảnh. Hình, bảng và bố cục trang giúp liên hệ kết quả với bằng chứng.'],
  ['A translated mirror preserves the original document. It replaces prose in the same regions while keeping diagrams in place.', 'Bản dịch đối chiếu giữ nguyên tài liệu gốc. Nội dung dịch nằm đúng vùng chữ và giữ vị trí các sơ đồ.'],
  ['Translation starts with the visible page. Previously translated paragraphs remain available when the reader scrolls back.', 'Bắt đầu dịch trang đang xem. Các đoạn đã dịch được lưu lại khi người đọc cuộn trở về.'],
  ['The user controls the translation engine. Local recognition keeps images on the device and cloud translation requires consent.', 'Người dùng chọn bộ máy dịch. Nhận dạng cục bộ giữ ảnh trên máy; dịch đám mây cần được đồng ý.'],
  ['Figure 1. A vector chart with preserved geometry.', 'Hình 1. Biểu đồ vector giữ nguyên hình học.'],
  ['Numbers must not change: 42, 3.14159 and 2026. Text is grouped by reading regions, not by the entire visual row.', 'Giữ nguyên số liệu: 42, 3.14159 và 2026. Văn bản được nhóm theo vùng đọc thay vì cả hàng ngang.'],
]);
let requests = 0;
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  if (request.url === '/metrics') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ requests })); return; }
  if (request.url === '/sample.pdf' || request.url === '/document-without-suffix') {
    response.setHeader('Content-Type', 'application/pdf');
    response.end(await readFile(new URL('../tests/fixtures/mirror-field-notes.pdf', import.meta.url)));
    return;
  }
  if (request.url === '/v1/chat/completions' && request.method === 'POST') {
    let raw = '';
    for await (const chunk of request) { raw += chunk; if (raw.length > 1024 * 1024) { response.writeHead(413).end(); return; } }
    try {
      const payload = JSON.parse(raw);
      const text = payload.messages?.findLast(item => item.role === 'user')?.content;
      if (typeof text !== 'string') throw new Error('Missing user text');
      requests++;
      response.setHeader('Content-Type', 'application/json');
      let content = translations.get(text) ?? `Bản dịch kiểm thử: ${text}`;
      if (payload.response_format?.type === 'json_object') {
        const blocks = JSON.parse(text);
        if (!Array.isArray(blocks) || !blocks.every(item => typeof item === 'string')) throw new Error('Expected text blocks');
        content = JSON.stringify({ translations: blocks.map(block => translations.get(block) ?? `Bản dịch kiểm thử: ${block}`) });
      }
      response.end(JSON.stringify({ choices: [{ message: { content } }], testOnly: true }));
    } catch { response.writeHead(400).end('Invalid test request'); }
    return;
  }
  response.writeHead(404).end('Mirror deterministic test provider. Not a production translator.');
});
server.listen(port, '127.0.0.1', () => console.log(`Deterministic test provider at http://127.0.0.1:${port}. NOT a live translation engine.`));
