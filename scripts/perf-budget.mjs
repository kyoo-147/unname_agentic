#!/usr/bin/env node
/**
 * Performance budget runner (backlog N06).
 *
 * Two questions, answered with numbers instead of adjectives:
 *
 * 1. Does a realistic workload over the pure core modules finish inside its budget?
 *    A deterministic synthetic document is chunked (`retrieval.chunkDocument`),
 *    indexed and searched (`index` / `search`), diffed against a revised copy
 *    (`diff.diffDocuments`), and scored for OCR error (`ocr-metrics.characterErrorRate`).
 *    Each scenario runs `WARMUP_RUNS` times unrecorded and `SAMPLED_RUNS` times
 *    recorded, and the report prints p50/p95/max against the budget.
 * 2. Did the last `pnpm build` grow the extension bundle past its ceiling? Every
 *    `dist/extension/assets/**\/*.{js,mjs,css}` byte is counted, and gzip is reported beside
 *    it because that is closer to what a user downloads.
 *
 * The measurement primitives, the percentile rule and the budget comparison all come
 * from `src/core/perf.ts` — the same code the unit tests exercise, so the report and
 * the tests cannot disagree about what p95 means. Node loads that TypeScript directly
 * (type stripping since 22.18); a resolve hook below adds the extension Node's ESM
 * resolver insists on, because the repository's imports are extensionless by
 * convention.
 *
 * Why a synthetic corpus rather than a real PDF: it is deterministic (the seeded
 * generator below produces the same document on every machine, so two runs differ only
 * by the machine), it needs no fixture binary in git, and it exercises the paths that
 * scale — section chunking, BM25 index build, ranking, block alignment, edit distance.
 * It is not a substitute for measuring a real document end to end; it is a tripwire for
 * a change that makes the core quadratic.
 *
 * p95 is the value at rank `ceil(0.95 * n) - 1`, so at 25 samples it is the
 * second-largest: up to 5% of runs may sit above it. `max` is printed beside it so a
 * one-off pause stays visible even when the budget holds.
 *
 * Usage:
 *   node scripts/perf-budget.mjs            run the budget gate
 *   node scripts/perf-budget.mjs --json     machine-readable report
 *   node scripts/perf-budget.mjs --help
 *
 * Exit codes: 0 every budget met, 1 a budget exceeded or a scenario produced no
 * samples, 2 the script could not run (Node too old, module failed to load).
 *
 * This script does NOT run `pnpm build`: a hook runs the build first (see
 * `scripts/pre-push.ps1`), and building here would blow the hook's time budget. When
 * `dist/extension` is absent the size row says "not built" and no size verdict is invented.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const assetsDir = path.join(root, 'dist', 'extension', 'assets');

// --- Budgets ---------------------------------------------------------------
//
// Timing budgets are p95 milliseconds; size budgets are raw KiB of JS + CSS under
// dist/extension/assets. Every number was set from a measured baseline on the machine that
// wrote it, with the headroom stated: a budget that already fits the current code and
// a little noise fails on a change that actually costs something, and nothing else.
// docs/performance.md carries the same table with the reasoning in prose.

const BUDGETS = Object.freeze({
  'chunk 1,200 blocks': {
    kind: 'time',
    // Baseline p95 2.8 ms over three runs. 15 ms is 5x: chunking runs when a document
    // opens, so the ceiling is loose in absolute terms but far below the hundreds of ms
    // an accidental O(n^2) would cost.
    p95Ms: 15,
  },
  'index passages': {
    kind: 'time',
    // Baseline p95 8.9 ms, stable across runs. 25 ms allows for a loaded machine (this
    // gate is meant for a hook, where a build may be running beside it) while failing a
    // 3x regression.
    p95Ms: 25,
  },
  'search 3 queries': {
    kind: 'time',
    // Baseline p95 1.0 ms. This is the keystroke path, so the budget is an absolute floor
    // rather than a ratio: at ~1 ms, run-to-run differences are mostly noise and a tight
    // relative budget would flap, while 10 ms is where a search box starts to feel slow.
    p95Ms: 10,
  },
  'diff 2 revisions': {
    kind: 'time',
    // Baseline p95 9.9–13.9 ms across runs. 40 ms is ~3x the worst observed: the diff
    // runs on a document pair, not per keystroke, and its slow path is similarity scoring
    // that would be seconds, not milliseconds, if it went document-wide.
    p95Ms: 40,
  },
  'cer 100 words': {
    kind: 'time',
    // Baseline median 2.0 ms and p95 8.7–9.0 ms — the gap is an allocator pause, not the
    // algorithm: the metric allocates its DP rows per call. 20 ms sits above that tail
    // while still failing a complexity change (a full matrix instead of two rows is ~100x).
    p95Ms: 20,
  },
  'extension js+css': {
    kind: 'size',
    // Baseline 2,951 KiB (the pdf.js worker and fontkit dominate). 3,200 KiB is +8%:
    // enough for a small feature, not enough for a new bundle-sized dependency.
    maxKiB: 3200,
  },
});

/** Unrecorded runs before sampling, so the numbers are of warm code. */
const WARMUP_RUNS = 3;

/** Recorded runs per scenario. 25 keeps p95 the second-largest rather than the max. */
const SAMPLED_RUNS = 25;

// --- Corpus ----------------------------------------------------------------

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const PAGE_COUNT = 40;
const BLOCKS_PER_PAGE = 30;

const VOCABULARY = Object.freeze([
  'retrieval', 'passage', 'reader', 'document', 'layout', 'block', 'heading',
  'citation', 'annotation', 'translation', 'glossary', 'table', 'formula', 'page',
  'outline', 'caption', 'excerpt', 'budget', 'latency', 'percentile', 'measurement',
  'deterministic', 'index', 'query', 'window', 'sentence', 'structure', 'evidence',
  'confidence', 'source', 'revision', 'diff', 'accuracy', 'boundary', 'section',
]);

/** mulberry32: 32-bit seeded generator, so the corpus is identical on every run. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function word(random) {
  return VOCABULARY[Math.floor(random() * VOCABULARY.length)] ?? 'passage';
}

function sentence(random, minWords = 9, maxWords = 16) {
  const count = minWords + Math.floor(random() * (maxWords - minWords + 1));
  const words = [];
  for (let index = 0; index < count; index += 1) words.push(word(random));
  const text = words.join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function paragraph(random, withFormula) {
  const sentences = [sentence(random), sentence(random), sentence(random)];
  if (withFormula) sentences.splice(1, 0, 'The rate is $E = mc^2$ for every window.');
  return sentences.join(' ');
}

function tableText(random) {
  const rows = ['count  value  rate'];
  for (let index = 1; index <= 5; index += 1) {
    rows.push(`${index}  ${Math.floor(random() * 1000)}  0.${index}${index}`);
  }
  return rows.join('\n');
}

function slotType(rank) {
  if (rank === 0 || rank % 9 === 0) return 'heading';
  if (rank % 25 === 7) return 'table';
  return 'paragraph';
}

function blockText(type, rank, random) {
  if (type === 'heading') return `${rank === 0 ? 'Overview' : 'Section'} ${rank} ${sentence(random, 3, 5)}`;
  if (type === 'table') return tableText(random);
  return paragraph(random, rank % 7 === 0);
}

/** Builds the deterministic document both the timing and the diff scenarios use. */
function createCorpus() {
  const random = seededRandom(0x5eed);
  const pages = [];
  const blocks = [];
  let readingOrder = 0;

  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    pages.push({ index: page, width: PAGE_WIDTH, height: PAGE_HEIGHT, rotation: 0 });
    for (let rank = 0; rank < BLOCKS_PER_PAGE; rank += 1) {
      const type = slotType(rank);
      const top = 48 + rank * 22;
      blocks.push({
        id: `p${page}-b${rank}`,
        type,
        page,
        polygon: [
          { x: 54, y: top },
          { x: PAGE_WIDTH - 54, y: top },
          { x: PAGE_WIDTH - 54, y: top + 18 },
          { x: 54, y: top + 18 },
        ],
        readingOrder,
        raw: blockText(type, rank, random),
        language: 'en',
        confidence: 1,
        children: [],
      });
      readingOrder += 1;
    }
  }

  return {
    schemaVersion: 1,
    documentId: 'perf-budget',
    revisionId: 'r1',
    sourceSha256: '0'.repeat(64),
    language: 'en',
    pages,
    blocks,
    translations: [],
    provenance: [],
    annotations: [],
    exports: [],
  };
}

/**
 * A second revision: every twentieth block edited, one block deleted, one block moved
 * to the last page. The diff therefore exercises all four change kinds, which is the
 * path that costs something — alignment, similarity scoring and the word-level diff.
 */
function revise(ir) {
  const deletedIndex = 77;
  const movedIndex = 33;
  const blocks = [];

  ir.blocks.forEach((block, index) => {
    if (index === deletedIndex) return;
    if (index === movedIndex) {
      const top = 48 + BLOCKS_PER_PAGE * 22;
      blocks.push({
        ...block,
        page: PAGE_COUNT,
        polygon: [
          { x: 54, y: top },
          { x: PAGE_WIDTH - 54, y: top },
          { x: PAGE_WIDTH - 54, y: top + 18 },
          { x: 54, y: top + 18 },
        ],
      });
      return;
    }
    blocks.push(index % 20 === 0 ? { ...block, raw: `${block.raw} (revised)` } : block);
  });

  return { ...ir, revisionId: 'r2', blocks };
}

/** A reference/hypothesis pair for CER: every 37th character is mis-recognised. */
const CER_WORDS = 100;

function createOcrPair() {
  const random = seededRandom(0xce2);
  const words = [];
  for (let index = 0; index < CER_WORDS; index += 1) words.push(word(random));
  const reference = words.join(' ');
  let hypothesis = '';
  for (let index = 0; index < reference.length; index += 1) {
    const character = reference.charAt(index);
    hypothesis += index % 37 === 0 ? (character === 'e' ? 'a' : 'e') : character;
  }
  return { reference, hypothesis };
}

const SEARCH_QUERIES = Object.freeze(['retrieval passage window', 'budget latency', 'citation annotation translation']);

// --- Loading the shipped modules -------------------------------------------

/**
 * Node's ESM resolver needs an extension; this repository's imports do not use one.
 * The hook only rewrites relative specifiers that have no extension and resolve to a
 * `.ts` file, and leaves everything else to the default resolver.
 */
function installTypeScriptResolver() {
  if (typeof registerHooks !== 'function') {
    fail('Node 22.15 or newer is required for module.registerHooks; this is Node ' + process.version + '.', 2);
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && path.extname(specifier) === '') {
        const parent = context.parentURL;
        if (parent && parent.startsWith('file:')) {
          const candidate = path.resolve(path.dirname(fileURLToPath(parent)), `${specifier}.ts`);
          if (existsSync(candidate)) return nextResolve(`${specifier}.ts`, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

async function loadModule(relativePath) {
  const file = path.join(root, relativePath);
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`Cannot import ${relativePath}.\n`
      + 'The runner loads the shipped TypeScript directly, which needs Node 22.18 or newer '
      + '(type stripping) and 22.15 or newer (module.registerHooks).\n'
      + `This is Node ${process.version}.\nCause: ${reason}`, 2);
  }
}

// --- Measurement -----------------------------------------------------------

/**
 * Runs one scenario: warm-up calls, then recorded ones. `work` returns a number that
 * is added to the checksum, so the call cannot be optimised away and the report can
 * prove the workload did something.
 */
function runScenario({ recorder, name, work, checksum }) {
  for (let run = 0; run < WARMUP_RUNS; run += 1) checksum.sum += work();
  for (let run = 0; run < SAMPLED_RUNS; run += 1) {
    const handle = recorder.span(name);
    try {
      checksum.sum += work();
    } finally {
      handle.end();
    }
  }
}

// --- Bundle size -----------------------------------------------------------

function bundleFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...bundleFiles(full));
    else if (entry.isFile() && /\.(js|mjs|css)$/u.test(entry.name)) files.push(full);
  }
  return files.sort();
}

function measureBundle() {
  const files = bundleFiles(assetsDir);
  if (files.length === 0) return { built: false, files: 0, bytes: 0, gzipBytes: 0, newestMs: 0 };

  let bytes = 0;
  let gzipBytes = 0;
  let newestMs = 0;
  for (const file of files) {
    const buffer = readFileSync(file);
    bytes += buffer.byteLength;
    gzipBytes += gzipSync(buffer, { level: 6 }).byteLength;
    newestMs = Math.max(newestMs, statSync(file).mtimeMs);
  }
  return { built: true, files: files.length, bytes, gzipBytes, newestMs };
}

// --- Reporting -------------------------------------------------------------

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

function usage() {
  console.error(`Usage: node scripts/perf-budget.mjs [--json] [--help]

Measures a deterministic synthetic workload over the pure core modules (chunking,
BM25 index, search, document diff, CER) and the size of the last build's extension bundle,
then compares both against the budgets declared at the top of this file.

  p50/p95/max are milliseconds over ${SAMPLED_RUNS} recorded runs after ${WARMUP_RUNS} warm-ups.
  p95 is the value at rank ceil(0.95*n)-1, so at ${SAMPLED_RUNS} samples it is the second-largest.
  The bundle row counts dist/extension/assets/**/*.{js,mjs,css}; gzip is reported for context.

  --json   machine-readable report
  --help   this text

Exit codes: 0 every budget met, 1 a budget exceeded or a scenario measured nothing,
2 the script could not run. This script does not run the build; run \`pnpm build\`
first when dist/extension is stale.`);
}

function parseArgs(argv) {
  const options = { json: false };
  for (const argument of argv) {
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${argument}`);
      usage();
      process.exit(2);
    }
  }
  return options;
}

/** Fixed-width table: first column left-aligned, the rest right-aligned. */
function formatTable(header, rows) {
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map(cells => cells[index].length)));
  const line = cells => cells.map((cell, index) => (index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]))).join('  ');
  return [line(header), widths.map(width => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

function milliseconds(value) {
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
}

function kibibytes(bytes) {
  return (bytes / 1024).toFixed(1);
}

function timeRows(report) {
  return report.rows.map(row => {
    const budget = BUDGETS[row.name];
    const max = row.samples.reduce((highest, sample) => Math.max(highest, sample), 0);
    const limit = budget?.kind === 'time' ? budget.p95Ms : null;
    return {
      name: row.name,
      count: row.count,
      p50: row.p50,
      p95: row.p95,
      // Rounded like the module's percentiles, so JSON carries no float noise.
      max: Math.round(max * 1000) / 1000,
      limit,
      failed: limit !== null && row.p95 > limit,
    };
  });
}

// --- Main ------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  installTypeScriptResolver();

  const perf = await loadModule('extension/viewer/src/core/perf.ts');
  const retrieval = await loadModule('extension/viewer/src/core/retrieval.ts');
  const diff = await loadModule('extension/viewer/src/core/diff.ts');
  const metrics = await loadModule('extension/viewer/src/core/ocr-metrics.ts');

  // --- Corpus and the work each scenario does (built once, reused).
  const base = createCorpus();
  const revised = revise(base);
  const ocr = createOcrPair();
  const chunks = retrieval.chunkDocument(base);
  const searchIndex = retrieval.index(chunks);
  const corpusChars = base.blocks.reduce((total, block) => total + block.raw.length, 0);
  const checksum = { sum: 0 };

  const recorder = perf.createRecorder();
  const scenarios = [
    {
      name: 'chunk 1,200 blocks',
      work: () => retrieval.chunkDocument(base).length,
    },
    {
      name: 'index passages',
      work: () => retrieval.index(chunks).postings.size,
    },
    {
      name: 'search 3 queries',
      work: () => {
        let hits = 0;
        for (const query of SEARCH_QUERIES) hits += retrieval.search(searchIndex, query, { limit: 10 }).length;
        return hits;
      },
    },
    {
      name: 'diff 2 revisions',
      work: () => {
        const result = diff.diffDocuments(base, revised);
        const { added, removed, changed, moved } = result.summary;
        return added + removed + changed + moved;
      },
    },
    {
      name: 'cer 100 words',
      work: () => metrics.characterErrorRate(ocr.reference, ocr.hypothesis).errors,
    },
  ];

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  for (const scenario of scenarios) runScenario({ recorder, name: scenario.name, work: scenario.work, checksum });
  const elapsedMs = Date.now() - startedMs;

  const report = recorder.report();
  const rows = timeRows(report);
  const timeBudgets = {};
  for (const [name, budget] of Object.entries(BUDGETS)) {
    if (budget.kind === 'time') timeBudgets[name] = budget.p95Ms;
  }
  const violations = perf.assertBudget(report, timeBudgets);
  const measuredNames = new Set(report.rows.map(row => row.name));
  const timeNames = Object.keys(timeBudgets);
  const unmeasured = timeNames.filter(name => !measuredNames.has(name));
  const timingMet = timeNames.length - unmeasured.length - violations.length;
  const bundle = measureBundle();
  const sizeBudget = BUDGETS['extension js+css'];
  const sizeFailed = bundle.built && sizeBudget.kind === 'size' && bundle.bytes > sizeBudget.maxKiB * 1024;
  const failed = violations.length > 0 || unmeasured.length > 0 || sizeFailed;
  const diffSummary = diff.diffDocuments(base, revised).summary;

  if (options.json) {
    console.log(JSON.stringify({
      node: process.version,
      startedAt,
      corpus: {
        pages: base.pages.length,
        blocks: base.blocks.length,
        characters: corpusChars,
        passages: chunks.length,
        postings: searchIndex.postings.size,
      },
      runs: { warmup: WARMUP_RUNS, sampled: SAMPLED_RUNS, elapsedMs },
      timings: rows,
      bundle: { ...bundle, budgetKiB: sizeBudget.maxKiB },
      violations,
      unmeasured,
      checksum: checksum.sum,
    }, null, 2));
  } else {
    console.log(`Performance budgets - Node ${process.version}, ${startedAt}`);
    console.log(`Corpus: ${base.pages.length} pages, ${base.blocks.length} blocks, ${(corpusChars / 1024).toFixed(0)} K chars, deterministic seed`);
    console.log(`Work:   ${chunks.length} passages, ${searchIndex.postings.size} index terms, diff ` +
      `${diffSummary.changed} changed / ${diffSummary.moved} moved / ${diffSummary.removed} removed / ` +
      `${diffSummary.added} added / ${diffSummary.unchanged} unchanged`);
    console.log(`Runs:   ${WARMUP_RUNS} warm-up + ${SAMPLED_RUNS} sampled per scenario (${elapsedMs} ms total)`);
    console.log('');

    console.log(formatTable(
      ['scenario', 'n', 'p50 ms', 'p95 ms', 'max ms', 'budget', 'result'],
      rows.map(row => [
        row.name,
        String(row.count),
        milliseconds(row.p50),
        milliseconds(row.p95),
        milliseconds(row.max),
        row.limit === null ? '-' : milliseconds(row.limit),
        row.failed ? 'OVER' : 'ok',
      ]),
    ));
    console.log('');

    const sizeResult = !bundle.built ? 'not built' : sizeFailed ? 'OVER' : 'ok';
    console.log(formatTable(
      ['artifact', 'files', 'raw KiB', 'gzip KiB', 'budget', 'result'],
      [[
        'dist/extension/assets js+css',
        bundle.built ? String(bundle.files) : '-',
        bundle.built ? kibibytes(bundle.bytes) : '-',
        bundle.built ? kibibytes(bundle.gzipBytes) : '-',
        `${sizeBudget.maxKiB} KiB`,
        sizeResult,
      ]],
    ));
    if (!bundle.built) {
      console.log('');
      console.log(`No build output at ${path.relative(root, assetsDir).split(path.sep).join('/')}.`);
      console.log('Run `pnpm build` first; the size budget is not checked against nothing.');
    } else {
      console.log('');
      console.log(`Bundle built ${new Date(bundle.newestMs).toISOString()} (newest asset mtime).`);
    }

    console.log('');
    if (unmeasured.length > 0) {
      console.log(`No samples for: ${unmeasured.join(', ')}. A scenario that measured nothing cannot pass.`);
    }
    if (violations.length > 0) {
      for (const violation of violations) {
        console.log(`OVER ${violation.name}: p95 ${milliseconds(violation.p95)} ms > ${milliseconds(violation.budget)} ms budget`);
      }
    }
    if (sizeFailed) {
      console.log(`OVER dist/extension/assets: ${kibibytes(bundle.bytes)} KiB > ${sizeBudget.maxKiB} KiB budget`);
    }
    const timingTotal = timeNames.length - unmeasured.length;
    if (failed) {
      console.log(`FAILED: ${timingMet}/${timingTotal} timing budgets met`
        + `${bundle.built ? `, bundle size ${sizeFailed ? 'over' : 'within'} budget` : ''}.`);
    } else if (!bundle.built) {
      console.log(`PASS: ${timingMet}/${timingTotal} timing budgets met; bundle size not checked (no build).`);
    } else {
      console.log(`PASS: ${timingMet + 1}/${timingTotal + 1} budgets met (p95 timing, bundle size).`);
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error('Performance budget run failed:', error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(2);
});
