#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Tesseract from 'tesseract.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const assets = path.join(root, 'extension', 'viewer', 'public', 'ocr');

function usage() {
  console.error(`Usage: node scripts/ocr-smoke.mjs --image <path.png|jpg> [--lang eng+vie] [--min-confidence 35]

Runs the real Tesseract engine against a local screenshot. It uses the vendored
assets in extension/viewer/public/ocr, so it makes no network request. This script is not part of
pnpm test:extension.`);
}

const args = process.argv.slice(2);
let image = '';
let lang = 'eng+vie';
let minConfidence = 35;
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--image') image = args[++index] ?? '';
  else if (argument === '--lang') lang = args[++index] ?? lang;
  else if (argument === '--min-confidence') minConfidence = Number(args[++index] ?? minConfidence);
  else if (argument === '--help' || argument === '-h') { usage(); process.exit(0); }
  else { console.error(`Unknown argument: ${argument}`); usage(); process.exit(2); }
}
if (!image || !existsSync(image)) { usage(); process.exit(2); }
if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 100) {
  console.error('min-confidence must be between 0 and 100.');
  process.exit(2);
}

const started = Date.now();
let worker;
try {
  worker = await Tesseract.createWorker(lang, Tesseract.OEM.LSTM_ONLY, {
    langPath: assets,
    gzip: false,
    cacheMethod: 'none',
    logger: message => {
      if (process.env.OCR_SMOKE_VERBOSE === '1') process.stderr.write(`${message.status} ${Math.round((message.progress ?? 0) * 100)}%\n`);
    },
  });
  const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
  const words = (data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words)))
    .map(word => ({ text: word.text, confidence: word.confidence, bbox: word.bbox }))
    .filter(word => word.text.trim() && word.confidence >= minConfidence);
  const meanConfidence = words.length ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length : 0;
  console.log(JSON.stringify({
    image: path.resolve(image),
    lang,
    minConfidence,
    durationMs: Date.now() - started,
    meanConfidence: Math.round(meanConfidence * 10) / 10,
    words: words.length,
    text: data.text.trim(),
    wordBoxes: words.slice(0, 5),
  }, null, 2));
} catch (error) {
  console.error('OCR smoke failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await worker?.terminate().catch(() => {});
}
