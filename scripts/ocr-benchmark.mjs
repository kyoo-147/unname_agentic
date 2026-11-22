#!/usr/bin/env node
/**
 * OCR benchmark runner (backlog N05).
 *
 * Reports, per fixture: PDF page count, characters recognised, CER and WER
 * against a hand-checked expected transcript. The metric maths is imported from
 * `extension/viewer/src/core/ocr-metrics.ts` (Node >= 22.18 loads the TypeScript directly, so the
 * report and the tests cannot drift apart).
 *
 * Where the recognised text comes from, in order:
 *   engine     `{name}.pages/*.png` next to the PDF, OCR'd here with tesseract.js
 *              and the vendored `extension/viewer/public/ocr` traineddata: the same engine, the
 *              same language data and the same `--lang` list as
 *              `extension/viewer/src/ocr/engine.ts`, called without the app.
 *   manual-run `{name}.actual.txt`, the text exported from a real run of the app.
 *   none       neither exists: the row says so, prints dashes, and no rate is
 *              invented.
 *
 * This script cannot rasterise a PDF on its own: the repository has no Node
 * canvas, and `pdfjs-dist` needs one to produce pixels. Render the pages with
 * the app's scan capture or any external rasteriser first (see
 * docs/ocr-benchmark.md). Page counts are read straight from the PDF, so they
 * are available even for a row with no text yet.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const metricsFile = path.join(root, 'extension', 'viewer', 'src', 'core', 'ocr-metrics.ts');
const assetDir = path.join(root, 'extension', 'viewer', 'public', 'ocr');
const standardFonts = path.join(root, 'node_modules', 'pdfjs-dist', 'standard_fonts');
const defaultFixtures = path.join(root, 'extension', 'tests', 'fixtures', 'ocr-bench');
const pageImagePattern = /\.(png|jpe?g|webp|tiff?)$/i;

function relative(target) {
  const inside = path.relative(root, target);
  return (inside === '' ? '.' : inside).split(path.sep).join('/');
}

function usage() {
  console.error(`Usage: node scripts/ocr-benchmark.mjs [options]

Measures OCR text quality on a directory of fixtures:

  {name}.pdf            the source document (its page count is read from it)
  {name}.expected.txt   hand-checked transcript of the document, UTF-8
  {name}.pages/*.png    optional page renders, OCR'd here with tesseract.js
  {name}.actual.txt     optional text exported from a run of the app

For each pair the report prints page count, characters recognised, CER and WER.
A row with neither page renders nor actual.txt is printed as "no text" with
dashes: it is not a measurement, and this script will not guess one.

It does NOT rasterise PDFs. The repository has no Node canvas, so a PDF has to
be rendered to images first (the app's scan capture or any external rasteriser).
Page counts are still read from the PDF when nothing else is available.

Options:
  --fixtures <dir>   fixture directory (default: extension/tests/fixtures/ocr-bench)
  --lang <list>      tesseract language list (default: eng+vie)
  --json             print machine-readable JSON instead of the table
  --metrics <file>   score with another build of the metrics module
  --verbose          log per-page OCR progress to stderr
  --help, -h         this text

Exit codes: 0 report produced (including "no fixture yet"), 2 bad usage or a
missing explicit --fixtures directory, 3 fixtures exist but none could be
measured.`);
}

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    fixtures: defaultFixtures,
    explicitFixtures: false,
    lang: 'eng+vie',
    json: false,
    metrics: '',
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--fixtures') {
      const value = argv[++index] ?? '';
      if (!value) fail('--fixtures needs a directory.', 2);
      options.fixtures = path.resolve(value);
      options.explicitFixtures = true;
    } else if (argument === '--lang') {
      options.lang = argv[++index] ?? options.lang;
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--metrics') {
      options.metrics = argv[++index] ?? '';
      if (!options.metrics) fail('--metrics needs a module path.', 2);
    } else if (argument === '--verbose') {
      options.verbose = true;
    } else if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${argument}`);
      usage();
      process.exit(2);
    }
  }
  if (!options.lang.trim()) fail('--lang needs a value such as eng+vie.', 2);
  return options;
}

async function loadMetrics(override) {
  const file = override ? path.resolve(override) : metricsFile;
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`Cannot import ${relative(file)}.\n`
      + 'The runner scores with the shipped TypeScript module, which Node loads directly from 22.18 on.\n'
      + `This is Node ${process.version}; pass --metrics <compiled module> on an older runtime.\n`
      + `Cause: ${reason}`, 2);
  }
}

function discover(dir) {
  return readdirSync(dir)
    .filter(name => /\.pdf$/i.test(name) && statSync(path.join(dir, name)).isFile())
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map(name => {
      const base = name.replace(/\.pdf$/i, '');
      return {
        base,
        pdf: path.join(dir, name),
        expected: path.join(dir, `${base}.expected.txt`),
        actual: path.join(dir, `${base}.actual.txt`),
        pages: path.join(dir, `${base}.pages`),
      };
    });
}

function pageImages(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter(name => pageImagePattern.test(name))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
    .map(name => path.join(dir, name));
}

function readText(file) {
  const text = readFileSync(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

let pdfjsModule;

function loadPdfjs() {
  pdfjsModule ??= import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null);
  return pdfjsModule;
}

async function pdfPageCount(file) {
  const pdfjs = await loadPdfjs();
  if (!pdfjs) return { pages: null, note: 'pdfjs-dist is not importable; page count unknown' };
  const data = new Uint8Array(readFileSync(file));
  let task;
  try {
    task = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useWorkerFetch: false,
      verbosity: 0,
      ...(existsSync(standardFonts) ? { standardFontDataUrl: `${pathToFileURL(standardFonts).href}/` } : {}),
    });
    const document = await task.promise;
    const pages = document.numPages;
    await document.destroy();
    return { pages, note: '' };
  } catch (error) {
    if (task && typeof task.destroy === 'function') await task.destroy().catch(() => {});
    const reason = error instanceof Error ? error.message : String(error);
    return { pages: null, note: `PDF unreadable: ${reason}` };
  }
}

async function ocrPages(images, lang, verbose) {
  const { default: Tesseract } = await import('tesseract.js');
  const worker = await Tesseract.createWorker(lang, Tesseract.OEM.LSTM_ONLY, {
    langPath: assetDir,
    gzip: false,
    cacheMethod: 'none',
    ...(verbose ? { logger: message => process.stderr.write(`${message.status} ${Math.round((message.progress ?? 0) * 100)}%\n`) } : {}),
  });
  try {
    const texts = [];
    for (const [index, image] of images.entries()) {
      const { data } = await worker.recognize(image, {}, { text: true });
      texts.push(data.text);
      if (verbose) process.stderr.write(`page ${index + 1}/${images.length}: ${data.text.trim().length} chars\n`);
    }
    return texts.join('\n');
  } finally {
    await worker.terminate().catch(() => {});
  }
}

async function measure(fixture, metrics, options) {
  const row = { name: fixture.base, pages: null, chars: null, cer: null, wer: null, source: 'none', note: '' };
  const notes = [];
  const expected = existsSync(fixture.expected) ? readText(fixture.expected) : null;
  const images = pageImages(fixture.pages);
  let recognised = null;

  if (images.length > 0) {
    try {
      recognised = await ocrPages(images, options.lang, options.verbose);
      row.source = 'engine';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notes.push(`engine failed: ${reason}`);
    }
  }
  if (recognised === null && existsSync(fixture.actual)) {
    recognised = readText(fixture.actual);
    row.source = 'manual-run';
  }

  if (recognised !== null) row.chars = metrics.countCharacters(recognised);
  if (expected === null) notes.push(`missing ${fixture.base}.expected.txt`);
  if (recognised === null) notes.push('no page renders and no actual.txt');
  if (recognised !== null && expected !== null) {
    row.cer = metrics.characterErrorRate(expected, recognised);
    row.wer = metrics.wordErrorRate(expected, recognised);
  }

  const pageInfo = await pdfPageCount(fixture.pdf);
  row.pages = pageInfo.pages;
  if (pageInfo.note) notes.push(pageInfo.note);
  row.note = notes.join('; ');
  return row;
}

function formatTable(rows) {
  const header = ['name', 'pages', 'chars', 'CER', 'WER', 'source'];
  const body = rows.map(row => [
    row.name,
    row.pages === null ? '?' : String(row.pages),
    row.chars === null ? '-' : String(row.chars),
    row.cer ? row.cer.rate.toFixed(4) : '-',
    row.wer ? row.wer.rate.toFixed(4) : '-',
    row.source === 'none' ? 'no text' : row.source,
  ]);
  const widths = header.map((title, index) => Math.max(title.length, ...body.map(cells => cells[index].length)));
  const line = cells => cells.map((cell, index) => (index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]))).join('  ');
  return [line(header), widths.map(width => '-'.repeat(width)).join('  '), ...body.map(line)].join('\n');
}

function layout() {
  return `  {name}.pdf            source document, page count read from the PDF
  {name}.expected.txt   hand-checked transcript, UTF-8
  {name}.pages/*.png    optional page renders (page-01.png, page-02.png, ...)
  {name}.actual.txt     optional text exported from the app`;
}

function emptyReport(options, reason) {
  if (options.json) {
    console.log(JSON.stringify({
      fixtures: relative(options.fixtures),
      languages: options.lang,
      metrics: relative(options.metrics || metricsFile),
      rows: [],
      measured: 0,
      note: reason,
    }, null, 2));
    return;
  }
  console.log(reason);
  console.log(`Expected layout:\n${layout()}`);
  console.log('Nothing to measure: this is the documented empty state, not a failure.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.fixtures) || !statSync(options.fixtures).isDirectory()) {
    const reason = `No fixture directory at ${relative(options.fixtures)}.`;
    if (options.explicitFixtures) {
      fail(`${reason}\nExpected layout:\n${layout()}\n`
        + 'Create it and add a {name}.pdf + {name}.expected.txt pair; docs/ocr-benchmark.md walks through one.', 2);
    }
    emptyReport(options, reason);
    return;
  }

  const fixtures = discover(options.fixtures);
  if (fixtures.length === 0) {
    emptyReport(options, `No {name}.pdf fixtures yet in ${relative(options.fixtures)}.`);
    return;
  }

  const metrics = await loadMetrics(options.metrics);
  const rows = [];
  for (const fixture of fixtures) rows.push(await measure(fixture, metrics, options));
  const measured = rows.filter(row => row.cer !== null);
  const fromEngine = rows.filter(row => row.source === 'engine').length;
  const manual = rows.filter(row => row.source === 'manual-run').length;

  if (options.json) {
    console.log(JSON.stringify({
      fixtures: relative(options.fixtures),
      languages: options.lang,
      metrics: relative(options.metrics || metricsFile),
      rows,
      measured: measured.length,
    }, null, 2));
  } else {
    console.log(`Fixtures: ${relative(options.fixtures)} (${rows.length} pair(s)), languages: ${options.lang}`);
    console.log('');
    console.log(formatTable(rows));
    console.log('');
    const noted = rows.filter(row => row.note);
    for (const row of noted) console.log(`${row.name}: ${row.note}`);
    if (noted.length > 0) console.log('');
    console.log(`Measured ${measured.length}/${rows.length}: ${fromEngine} by the engine, ${manual} from a manual run.`);
    console.log('A dash is not a measurement. "engine" rows use tesseract.js on {name}.pages/*.png with extension/viewer/public/ocr traineddata;');
    console.log('"manual-run" rows use {name}.actual.txt exported from the app. See docs/ocr-benchmark.md.');
  }

  if (measured.length === 0) {
    console.error('No fixture produced a CER/WER yet. Render {name}.pages/*.png or export {name}.actual.txt, then re-run.');
    process.exit(3);
  }
}

main().catch(error => {
  console.error('OCR benchmark failed:', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
