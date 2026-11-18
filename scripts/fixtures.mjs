import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('tests/fixtures', { recursive: true });
await mkdir('public', { recursive: true });
const pdf = await PDFDocument.create();
const regular = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
for (let index = 0; index < 4; index++) {
  const page = pdf.addPage([612, 792]);
  page.drawRectangle({ x: 0, y: 740, width: 612, height: 52, color: rgb(0.88, 0.94, 0.9) });
  page.drawText('MIRROR / FIELD NOTES', { x: 44, y: 760, size: 12, font: bold, color: rgb(0.13, 0.31, 0.26) });
  page.drawText(index === 0 ? 'Reading without boundaries' : `A closer look at page ${index + 1}`, { x: 44, y: 696, size: 24, font: bold });
  page.drawText('A document should keep its shape when the language changes.', { x: 44, y: 665, size: 11, font: regular });
  const paragraphs = [
    'Scientific reading depends on context. Figures, tables and page structure help readers connect a result to its evidence.',
    'A translated mirror preserves the original document. It replaces prose in the same regions while keeping diagrams in place.',
    'Translation starts with the visible page. Previously translated paragraphs remain available when the reader scrolls back.',
    'The user controls the translation engine. Local recognition keeps images on the device and cloud translation requires consent.',
  ];
  let y = 610;
  for (const paragraph of paragraphs) {
    page.drawText(paragraph, { x: 44, y, size: 12, font: regular, maxWidth: 242, lineHeight: 18 });
    y -= 94;
  }
  page.drawRectangle({ x: 335, y: 330, width: 226, height: 275, borderWidth: 1, borderColor: rgb(0.35, 0.55, 0.48), color: rgb(0.95, 0.97, 0.96) });
  page.drawLine({ start: { x: 355, y: 365 }, end: { x: 535, y: 365 }, thickness: 2, color: rgb(0.16, 0.4, 0.34) });
  for (let bar = 0; bar < 5; bar++) {
    page.drawRectangle({ x: 365 + bar * 33, y: 367, width: 19, height: 55 + bar * 27, color: rgb(0.25 + bar * 0.07, 0.55, 0.44) });
  }
  page.drawText('Evidence remains visible', { x: 347, y: 575, size: 13, font: bold, color: rgb(0.15, 0.35, 0.28) });
  page.drawText('Figure 1. A vector chart with preserved geometry.', { x: 335, y: 309, size: 9, font: regular, maxWidth: 226, lineHeight: 12 });
  page.drawText('Results and discussion', { x: 335, y: 267, size: 16, font: bold });
  page.drawText('Numbers must not change: 42, 3.14159 and 2026. Text is grouped by reading regions, not by the entire visual row.', { x: 335, y: 240, size: 12, font: regular, maxWidth: 226, lineHeight: 18 });
  page.drawText(`${index + 1} / 4`, { x: 535, y: 30, size: 10, font: regular });
  page.drawText('Generated locally for Mirror PDF verification. No third-party document content.', { x: 44, y: 30, size: 8, font: regular });
}
const bytes = await pdf.save();
await writeFile('tests/fixtures/mirror-field-notes.pdf', bytes);
await writeFile('public/sample.pdf', bytes);
console.log('Generated 4-page digital PDF with columns, colored regions and vector chart.');
