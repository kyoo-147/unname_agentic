import { describe, expect, it } from 'vitest';
import { agreeing, conflicts as evidenceConflicts } from '../viewer/src/core/evidence-matrix';
import { buildDocument, type BlockType, type DocumentIR } from '../viewer/src/core/ir';
import { summarise } from '../viewer/src/core/paper-compare';
import {
  CANONICAL_DIMENSIONS,
  NOT_REPORTED_VALUE,
  PAPER_MATRIX_CSV_SEPARATOR,
  PAPER_MATRIX_UNNAMED_SECTION,
  buildPaperMatrix,
  getPaperMatrixCell,
  toEvidenceMatrix,
  toPaperCompareMatrix,
  toPaperMatrixCsv,
  toPaperMatrixJson,
  toPaperMatrixMarkdown,
  type MatrixAxis,
  type PaperComparisonMatrix,
  type PaperMatrixInput,
  type ReportedMatrixCell,
} from '../viewer/src/core/paper-matrix';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

interface SpecBlock {
  page: number;
  type?: BlockType;
  text: string;
  confidence?: number;
}

function makePaperIr(
  documentId: string,
  sha256: string,
  specs: readonly SpecBlock[],
): DocumentIR {
  const rowByPage = new Map<number, number>();
  const blocks = specs.map(spec => {
    const row = rowByPage.get(spec.page) ?? 0;
    rowByPage.set(spec.page, row + 1);
    return {
      page: spec.page,
      type: spec.type ?? 'paragraph',
      text: spec.text,
      confidence: spec.confidence ?? 1,
      rect: { x: 72, y: 72 + row * 28, width: 468, height: 22 },
    };
  });
  const pages = [...new Set(specs.map(spec => spec.page))]
    .sort((left, right) => left - right)
    .map(index => ({ index, width: 612, height: 792 }));
  return buildDocument({
    documentId,
    sourceSha256: sha256,
    pages: pages.length > 0 ? pages : [{ index: 1, width: 612, height: 792 }],
    blocks,
  });
}

/** Full RFC 4180 CSV parser supporting CRLF records, quoted fields, doubled quotes, and embedded newlines. */
function parseRfc4180Csv(csv: string): string[][] {
  if (csv.length === 0) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r' && csv[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }

  row.push(field);
  rows.push(row);
  return rows;
}

function assertReported(cell: ReturnType<typeof getPaperMatrixCell>): ReportedMatrixCell {
  expect(cell).toBeDefined();
  expect(cell?.status).toBe('reported');
  return cell as ReportedMatrixCell;
}

const PAPER_ALPHA: PaperMatrixInput = {
  id: 'paper-alpha',
  title: 'Alpha Dual-Encoder Retrieval',
  year: 2024,
  ir: makePaperIr('paper-alpha', SHA_A, [
    { page: 1, type: 'heading', text: '1. Abstract' },
    { page: 1, text: 'We study neural passage retrieval with compact encoders.' },
    { page: 1, type: 'heading', text: '2. Method' },
    {
      page: 1,
      text: 'Our proposed method trains a dual-encoder transformer using an in-batch contrastive objective. Training ran for 120 A100 GPU hours.',
    },
    { page: 2, type: 'heading', text: '3. Datasets' },
    { page: 2, text: 'We evaluate on the SQuAD v1.1 dataset and Natural Questions benchmark.' },
    { page: 2, type: 'heading', text: '4. Results' },
    { page: 2, text: 'Alpha achieves 88.5% F1 and 81.2% EM on the development set.' },
    { page: 3, type: 'heading', text: '5. Limitations' },
    {
      page: 3,
      text: 'A primary limitation is that dense indexing requires 24 GB of RAM and fails on out-of-domain medical queries.',
    },
  ]),
};

const PAPER_BETA: PaperMatrixInput = {
  id: 'paper-beta',
  title: 'Beta Cross-Encoder Reranker',
  year: 2025,
  ir: makePaperIr('paper-beta', SHA_B, [
    { page: 1, type: 'heading', text: '1. Method' },
    {
      page: 1,
      text: 'Our approach trains a cross-encoder reranker with knowledge distillation. Training consumed 360 A100 GPU hours.',
    },
    { page: 1, type: 'heading', text: '2. Data' },
    { page: 1, text: 'Experiments use the SQuAD v1.1 dataset under zero-shot transfer.' },
    { page: 2, type: 'heading', text: '3. Evaluation' },
    { page: 2, text: 'Beta obtains 91.2% F1 and 79.4% EM on the benchmark.' },
  ]),
};

const PAPER_GAMMA: PaperMatrixInput = {
  id: 'paper-gamma',
  title: 'Gamma Position Essay',
  year: 2023,
  ir: makePaperIr('paper-gamma', SHA_C, [
    { page: 1, type: 'heading', text: '1. Introduction' },
    { page: 1, text: 'Retrieval evaluation protocols deserve broader scrutiny.' },
    { page: 1, type: 'heading', text: '2. Limitations' },
    // Bare heading with no content under it must NOT produce a false match.
    { page: 2, type: 'heading', text: '3. Conclusion' },
    { page: 2, text: 'Community benchmarks should track calibration.' },
  ]),
};

describe('buildPaperMatrix: canonical dimensions and provenance', () => {
  it('compares 2+ DocumentIR papers across method, dataset, metrics, and limitations', () => {
    expect(CANONICAL_DIMENSIONS).toEqual(['method', 'dataset', 'metrics', 'limitations']);

    const matrix = buildPaperMatrix([PAPER_ALPHA, PAPER_BETA]);

    expect(matrix.refusal).toBeNull();
    expect(matrix.comparisonVerdict).toBe('partial');
    expect(matrix.rows.map(r => r.documentId)).toEqual(['paper-alpha', 'paper-beta']);
    expect(matrix.columns.map(c => c.dimensionId)).toEqual([
      'method',
      'dataset',
      'metrics',
      'limitations',
    ]);

    const alphaMethod = assertReported(getPaperMatrixCell(matrix, 'paper-alpha', 'method'));
    expect(alphaMethod.quote).toBe(
      'Our proposed method trains a dual-encoder transformer using an in-batch contrastive objective.',
    );
    expect(alphaMethod.provenance).toEqual({
      documentId: 'paper-alpha',
      page: 1,
      blockId: 'p1-r3',
      section: '2. Method',
    });

    const alphaDataset = assertReported(getPaperMatrixCell(matrix, 'paper-alpha', 'dataset'));
    expect(alphaDataset.provenance).toEqual({
      documentId: 'paper-alpha',
      page: 2,
      blockId: 'p2-r1',
      section: '3. Datasets',
    });
    expect(alphaDataset.quote).toContain('SQuAD v1.1 dataset');

    const alphaMetrics = assertReported(getPaperMatrixCell(matrix, 'paper-alpha', 'metrics'));
    expect(alphaMetrics.provenance).toEqual({
      documentId: 'paper-alpha',
      page: 2,
      blockId: 'p2-r3',
      section: '4. Results',
    });
    expect(alphaMetrics.extractedMetrics.map(m => m.metricKey)).toEqual(['f1', 'exact_match']);

    const alphaLimits = assertReported(getPaperMatrixCell(matrix, 'paper-alpha', 'limitations'));
    expect(alphaLimits.provenance).toEqual({
      documentId: 'paper-alpha',
      page: 3,
      blockId: 'p3-r1',
      section: '5. Limitations',
    });
  });

  it('enforces verbatim source quote matching the exact block in DocumentIR', () => {
    const papers = [PAPER_ALPHA, PAPER_BETA];
    const matrix = buildPaperMatrix(papers);
    const byDoc = new Map(papers.map(p => [p.id!, p.ir]));

    for (const cell of matrix.cells) {
      if (cell.status !== 'reported') continue;
      const ir = byDoc.get(cell.documentId);
      const block = ir?.blocks.find(b => b.id === cell.provenance.blockId);
      expect(block).toBeDefined();
      expect(block?.page).toBe(cell.provenance.page);
      expect(block?.raw.includes(cell.quote)).toBe(true);
    }
  });

  it('accepts bare DocumentIR inputs and sorts shuffled blocks by readingOrder', () => {
    const shuffledAlpha: DocumentIR = {
      ...PAPER_ALPHA.ir,
      blocks: [...PAPER_ALPHA.ir.blocks].reverse(),
    };
    const matrix = buildPaperMatrix([shuffledAlpha, PAPER_BETA.ir]);

    expect(matrix.rows.map(r => r.documentId)).toEqual(['paper-alpha', 'paper-beta']);
    const cell = assertReported(getPaperMatrixCell(matrix, 'paper-alpha', 'limitations'));
    expect(cell.provenance).toEqual({
      documentId: 'paper-alpha',
      page: 3,
      blockId: 'p3-r1',
      section: '5. Limitations',
    });
  });

  it('supports custom axes alongside canonical dimensions', () => {
    const computeAxis: MatrixAxis = {
      id: 'compute',
      label: 'Compute Budget',
      keywords: ['GPU hours', 'A100'],
      pattern: /(\d+(?:\.\d+)?)\s*A100\s*GPU\s*hours?/iu,
      preferredSections: ['method', 'setup'],
      valueKind: 'number',
      unit: 'A100 GPU hours',
    };

    const matrix = buildPaperMatrix([PAPER_ALPHA, PAPER_BETA], {
      customAxes: [computeAxis],
    });

    expect(matrix.columns.map(c => c.dimensionId)).toEqual([
      'method',
      'dataset',
      'metrics',
      'limitations',
      'compute',
    ]);

    const alphaCompute = assertReported(getPaperMatrixCell(matrix, 'paper-alpha', 'compute'));
    expect(alphaCompute.quote).toBe('Training ran for 120 A100 GPU hours.');
    expect(alphaCompute.normalizedValue).toBe('120');
    expect(alphaCompute.provenance.section).toBe('2. Method');

    const betaCompute = assertReported(getPaperMatrixCell(matrix, 'paper-beta', 'compute'));
    expect(betaCompute.normalizedValue).toBe('360');

    const computeDelta = matrix.metricDeltas.find(d => d.metricKey === 'compute');
    expect(computeDelta).toBeDefined();
    expect(computeDelta?.status).toBe('conflict');
    expect(computeDelta?.spread).toBe(240);
    expect(computeDelta?.pairwiseDeltas).toEqual([
      { fromDocumentId: 'paper-alpha', toDocumentId: 'paper-beta', delta: 240, unit: 'A100 GPU hours' },
    ]);
  });
});

describe('buildPaperMatrix: explicit not_reported, coverage gaps, and deltas', () => {
  it('outputs explicit not_reported when a paper omits a dimension or has a bare heading', () => {
    const matrix = buildPaperMatrix([PAPER_ALPHA, PAPER_BETA, PAPER_GAMMA]);

    const betaLimits = getPaperMatrixCell(matrix, 'paper-beta', 'limitations');
    expect(betaLimits).toEqual({
      status: 'not_reported',
      documentId: 'paper-beta',
      dimensionId: 'limitations',
      reason: 'no-match',
    });

    // Gamma has a bare "2. Limitations" heading followed immediately by "3. Conclusion".
    const gammaLimits = getPaperMatrixCell(matrix, 'paper-gamma', 'limitations');
    expect(gammaLimits).toEqual({
      status: 'not_reported',
      documentId: 'paper-gamma',
      dimensionId: 'limitations',
      reason: 'no-match',
    });

    const gammaMethod = getPaperMatrixCell(matrix, 'paper-gamma', 'method');
    expect(gammaMethod?.status).toBe(NOT_REPORTED_VALUE);
  });

  it('computes cross-paper coverage gaps per dimension and per paper', () => {
    const matrix = buildPaperMatrix([PAPER_ALPHA, PAPER_BETA, PAPER_GAMMA]);

    expect(matrix.coverage.totalCells).toBe(12);
    expect(matrix.coverage.reportedCells).toBe(7);
    expect(matrix.coverage.notReportedCells).toBe(5);
    expect(matrix.coverage.overallCoverageRate).toBeCloseTo(7 / 12, 4);

    const limitsCov = matrix.coverage.byDimension.find(d => d.dimensionId === 'limitations');
    expect(limitsCov).toEqual({
      dimensionId: 'limitations',
      label: 'Limitations',
      reportedCount: 1,
      notReportedCount: 2,
      totalPapers: 3,
      coverageRate: 0.3333,
      reportedDocumentIds: ['paper-alpha'],
      missingDocumentIds: ['paper-beta', 'paper-gamma'],
    });

    const gammaCov = matrix.coverage.byPaper.find(p => p.documentId === 'paper-gamma');
    expect(gammaCov).toEqual({
      documentId: 'paper-gamma',
      title: 'Gamma Position Essay',
      reportedCount: 0,
      notReportedCount: 4,
      totalDimensions: 4,
      coverageRate: 0,
      missingDimensionIds: ['method', 'dataset', 'metrics', 'limitations'],
    });
  });

  it('computes cross-paper metric deltas with baseline, min, max, spread, and missing papers', () => {
    const matrix = buildPaperMatrix([PAPER_ALPHA, PAPER_BETA, PAPER_GAMMA]);

    const f1Delta = matrix.metricDeltas.find(d => d.metricKey === 'f1');
    expect(f1Delta).toBeDefined();
    expect(f1Delta?.status).toBe('conflict');
    expect(f1Delta?.unit).toBe('%');
    expect(f1Delta?.baselineDocumentId).toBe('paper-alpha');
    expect(f1Delta?.min).toEqual({ documentId: 'paper-alpha', numericValue: 88.5 });
    expect(f1Delta?.max).toEqual({ documentId: 'paper-beta', numericValue: 91.2 });
    expect(f1Delta?.spread).toBe(2.7);
    expect(f1Delta?.pairwiseDeltas).toEqual([
      { fromDocumentId: 'paper-alpha', toDocumentId: 'paper-beta', delta: 2.7, unit: '%' },
    ]);
    expect(f1Delta?.missingDocumentIds).toEqual(['paper-gamma']);

    const emDelta = matrix.metricDeltas.find(d => d.metricKey === 'exact_match');
    expect(emDelta?.spread).toBe(1.8);
    expect(emDelta?.pairwiseDeltas).toEqual([
      { fromDocumentId: 'paper-alpha', toDocumentId: 'paper-beta', delta: -1.8, unit: '%' },
    ]);
  });
});

describe('exports and composition with paper-compare and evidence-matrix', () => {
  it('exports Markdown with quote, provenance, and explicit not_reported', () => {
    const matrix = buildPaperMatrix([PAPER_ALPHA, PAPER_BETA]);
    const md = toPaperMatrixMarkdown(matrix);
    const lines = md.split('\n');

    expect(lines[0]).toBe('| Paper | Method | Dataset | Metrics | Limitations |');
    expect(lines[1]).toBe('| --- | --- | --- | --- | --- |');
    expect(lines).toHaveLength(4);

    expect(lines[2]).toContain('paper-alpha, p.1, p1-r3, 2. Method');
    expect(lines[2]).toContain('Our proposed method trains a dual-encoder transformer');
    expect(lines[3]).toContain(`| ${NOT_REPORTED_VALUE} |`);
  });

  it('exports RFC 4180 CSV that round-trips cleanly', () => {
    const matrix = buildPaperMatrix([PAPER_ALPHA, PAPER_BETA]);
    const csv = toPaperMatrixCsv(matrix);

    expect(csv.includes(PAPER_MATRIX_CSV_SEPARATOR)).toBe(true);
    expect(csv.endsWith(PAPER_MATRIX_CSV_SEPARATOR)).toBe(false);

    const parsed = parseRfc4180Csv(csv);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual(['Paper', 'Method', 'Dataset', 'Metrics', 'Limitations']);
    expect(parsed[1]?.[0]).toBe('Alpha Dual-Encoder Retrieval');
    expect(parsed[1]?.[1]).toContain('paper-alpha, p.1, p1-r3, 2. Method');
    expect(parsed[2]?.[4]).toBe(NOT_REPORTED_VALUE);
  });

  it('exports deterministic JSON and round-trips identically', () => {
    const matrix = buildPaperMatrix([PAPER_ALPHA, PAPER_BETA]);
    const firstJson = toPaperMatrixJson(matrix);
    const secondJson = toPaperMatrixJson(buildPaperMatrix([PAPER_ALPHA, PAPER_BETA]));

    expect(firstJson).toBe(secondJson);
    const roundTripped = JSON.parse(firstJson) as PaperComparisonMatrix;
    expect(roundTripped).toEqual(matrix);
  });

  it('composes cleanly with paper-compare and evidence-matrix readers', () => {
    const matrix = buildPaperMatrix([PAPER_ALPHA, PAPER_BETA]);

    const paperCompare = toPaperCompareMatrix(matrix);
    const prose = summarise(paperCompare);
    expect(prose.aspects.map(a => a.aspectId)).toEqual(['method', 'dataset', 'metrics', 'limitations']);
    expect(prose.aspects[3]?.unmentioned).toEqual(['Beta Cross-Encoder Reranker']);

    const evMatrix = toEvidenceMatrix(matrix);
    expect(evMatrix.rows.map(r => r.documentId)).toEqual(['paper-alpha', 'paper-beta']);
    expect(evidenceConflicts(evMatrix).length).toBeGreaterThan(0);
    expect(agreeing(evMatrix)).toEqual([]);
  });
});

describe('multi-metric conflict reporting', () => {
  it('reports cross-paper multi-metric conflicts alongside metric agreements', () => {
    const p1: PaperMatrixInput = {
      id: 'm1',
      title: 'Model One',
      ir: makePaperIr('m1', SHA_A, [
        { page: 1, type: 'heading', text: 'Results' },
        { page: 1, text: 'Model One achieves 88.5% F1, 81.2% EM, 42.0 ms latency, and 2.1% WER.' },
      ]),
    };
    const p2: PaperMatrixInput = {
      id: 'm2',
      title: 'Model Two',
      ir: makePaperIr('m2', SHA_B, [
        { page: 1, type: 'heading', text: 'Evaluation' },
        { page: 1, text: 'Model Two reaches 91.2% F1, 79.4% EM, 65.5 ms latency, and 2.10% WER.' },
      ]),
    };
    const p3: PaperMatrixInput = {
      id: 'm3',
      title: 'Model Three',
      ir: makePaperIr('m3', SHA_C, [
        { page: 1, type: 'heading', text: 'Results' },
        { page: 1, text: 'Model Three obtains 88.50% F1 on the same split.' },
      ]),
    };

    const matrix = buildPaperMatrix([p1, p2, p3]);

    // Three metrics conflict (F1, EM, Latency) while WER agrees (2.1% == 2.10%).
    expect(matrix.conflicts.crossPaperMetrics.map(m => m.metricKey)).toEqual([
      'f1',
      'exact_match',
      'latency',
    ]);

    const werDelta = matrix.metricDeltas.find(d => d.metricKey === 'wer');
    expect(werDelta?.status).toBe('agree');
    expect(werDelta?.spread).toBe(0);
    expect(werDelta?.missingDocumentIds).toEqual(['m3']);

    const latencyDelta = matrix.metricDeltas.find(d => d.metricKey === 'latency');
    expect(latencyDelta?.unit).toBe('ms');
    expect(latencyDelta?.spread).toBe(23.5);
    expect(latencyDelta?.pairwiseDeltas).toEqual([
      { fromDocumentId: 'm1', toDocumentId: 'm2', delta: 23.5, unit: 'ms' },
    ]);
  });

  it('detects intra-paper metric conflicts across sections and prefers Results over Abstract', () => {
    const conflictingPaper: PaperMatrixInput = {
      id: 'intra',
      title: 'Self-Conflicting Paper',
      ir: makePaperIr('intra', SHA_A, [
        { page: 1, type: 'heading', text: 'Abstract' },
        { page: 1, text: 'Our system reaches 92.4% F1 in preliminary runs.' },
        { page: 3, type: 'heading', text: '4. Results' },
        { page: 3, text: 'On the final test set, our system achieves 89.1% F1 and 82.0% EM.' },
      ]),
    };
    const consistentPaper: PaperMatrixInput = {
      id: 'clean',
      title: 'Consistent Paper',
      ir: makePaperIr('clean', SHA_B, [
        { page: 1, type: 'heading', text: 'Abstract' },
        { page: 1, text: 'We achieve 90.0% F1 overall.' },
        { page: 2, type: 'heading', text: 'Results' },
        { page: 2, text: 'We obtain 90.00% F1 on the benchmark.' },
      ]),
    };

    const matrix = buildPaperMatrix([conflictingPaper, consistentPaper], {
      baselineDocumentId: 'clean',
    });

    expect(matrix.conflicts.intraPaperMetrics).toHaveLength(1);
    const intra = matrix.conflicts.intraPaperMetrics[0]!;
    expect(intra.documentId).toBe('intra');
    expect(intra.metricKey).toBe('f1');
    expect(intra.readings).toHaveLength(2);
    expect(intra.readings[0]?.normalizedValue).toBe('92.4');
    expect(intra.readings[0]?.provenance).toEqual({
      documentId: 'intra',
      page: 1,
      blockId: 'p1-r1',
      section: 'Abstract',
    });
    expect(intra.readings[1]?.normalizedValue).toBe('89.1');
    expect(intra.readings[1]?.provenance).toEqual({
      documentId: 'intra',
      page: 3,
      blockId: 'p3-r1',
      section: '4. Results',
    });

    // Primary F1 value used in cross-paper delta prefers Results (89.1) over Abstract (92.4),
    // and baselineDocumentId: 'clean' computes delta from clean (90.0) -> intra (89.1) = -0.9.
    const f1Delta = matrix.metricDeltas.find(d => d.metricKey === 'f1');
    expect(f1Delta?.baselineDocumentId).toBe('clean');
    expect(f1Delta?.pairwiseDeltas).toEqual([
      { fromDocumentId: 'clean', toDocumentId: 'intra', delta: -0.9, unit: '%' },
    ]);
  });

  it('tracks additional metric citations across blocks and guards case-sensitive acronyms', () => {
    const multiBlock: PaperMatrixInput = {
      id: 'multi',
      title: 'Multi-Block Metrics',
      ir: makePaperIr('multi', SHA_A, [
        { page: 1, type: 'heading', text: 'Introduction' },
        { page: 1, text: 'We map 12 challenges and help them scale.' },
        { page: 2, type: 'heading', text: 'Results' },
        { page: 2, text: 'The model reaches 85.0% F1 and 0.78 mAP.' },
        { page: 3, type: 'heading', text: 'Efficiency' },
        { page: 3, text: 'Inference latency is 18.5 ms per query.' },
      ]),
    };

    const matrix = buildPaperMatrix([multiBlock, PAPER_ALPHA]);
    const cell = assertReported(getPaperMatrixCell(matrix, 'multi', 'metrics'));

    // Lowercase "map 12" and "them" must NOT be mistaken for mAP or EM.
    expect(cell.extractedMetrics.map(m => m.metricKey)).toEqual(['f1', 'map', 'latency']);
    expect(cell.additionalCitations).toEqual([
      {
        quote: 'Inference latency is 18.5 ms per query.',
        provenance: {
          documentId: 'multi',
          page: 3,
          blockId: 'p3-r1',
          section: 'Efficiency',
        },
      },
    ]);
  });
});

describe('RFC 4180 CSV and Markdown escaping', () => {
  it('escapes commas, double quotes, embedded newlines, pipes, and surrounding spaces cleanly', () => {
    const trickyA: PaperMatrixInput = {
      id: 'tricky-a',
      title: '  Paper "Alpha",\nPart 1  ',
      year: 2024,
      ir: makePaperIr('tricky-a', SHA_A, [
        { page: 1, type: 'heading', text: 'Method | Core' },
        { page: 1, text: 'Our method uses "sparse, adaptive" | routing.' },
        { page: 2, type: 'heading', text: 'Results' },
        { page: 2, text: 'Accuracy is 90.5% on test.' },
      ]),
    };
    const trickyB: PaperMatrixInput = {
      id: 'tricky-b',
      title: 'Paper Beta',
      year: 2025,
      ir: makePaperIr('tricky-b', SHA_B, [
        { page: 1, type: 'heading', text: 'Method' },
        { page: 1, text: 'Our approach uses dense attention.' },
      ]),
    };

    const matrix = buildPaperMatrix([trickyA, trickyB], { dimensions: ['method', 'metrics'] });

    const csv = toPaperMatrixCsv(matrix, { includeYear: true });
    expect(csv.includes('""sparse, adaptive""')).toBe(true);
    expect(csv.endsWith(PAPER_MATRIX_CSV_SEPARATOR)).toBe(false);

    const parsed = parseRfc4180Csv(csv);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual(['Paper', 'Year', 'Method', 'Metrics']);
    expect(parsed[1]?.[0]).toBe('Paper "Alpha",\nPart 1');
    expect(parsed[1]?.[1]).toBe('2024');
    expect(parsed[1]?.[2]).toContain('Our method uses "sparse, adaptive" | routing.');
    expect(parsed[2]?.[3]).toBe(NOT_REPORTED_VALUE);

    const md = toPaperMatrixMarkdown(matrix, { includeYear: true, includeSummary: true });
    const tableLines = md.split('\n').slice(0, 4);
    expect(tableLines[0]).toBe('| Paper | Year | Method | Metrics |');
    expect(tableLines[2]).toContain('Paper "Alpha",<br>Part 1');
    expect(tableLines[2]).toContain('sparse, adaptive" \\| routing');
    expect(tableLines[2]).toContain('Method \\| Core');
    expect(md).toContain('Coverage: 3/4 cells reported (75%).');
  });

  it('returns empty string from exporters when matrix is refused', () => {
    const refused = buildPaperMatrix([]);
    expect(toPaperMatrixMarkdown(refused)).toBe('');
    expect(toPaperMatrixCsv(refused)).toBe('');
    expect(JSON.parse(toPaperMatrixJson(refused, { pretty: true }))).toEqual(refused);
  });
});

describe('abstention and edge-case safety', () => {
  it('refuses 0 papers and unusable dimensions cleanly', () => {
    const noPapers = buildPaperMatrix([]);
    expect(noPapers.refusal).toBe('no-papers');
    expect(noPapers.comparisonVerdict).toBe('abstain');
    expect(noPapers.abstainReasons).toEqual(['no-papers']);
    expect(toPaperCompareMatrix(noPapers).refusal).toBe('no-papers');
    expect(toEvidenceMatrix(noPapers).refusal).toBe('no-documents');

    const noDims = buildPaperMatrix([PAPER_ALPHA, PAPER_BETA], {
      axes: [{ id: 'empty', label: 'Empty', keywords: [] }],
    });
    expect(noDims.refusal).toBe('no-dimensions');
    expect(noDims.comparisonVerdict).toBe('abstain');
    expect(noDims.abstainReasons).toEqual(['no-dimensions']);
    expect(toPaperCompareMatrix(noDims).refusal).toBe('no-aspects');
    expect(toEvidenceMatrix(noDims).refusal).toBe('no-aspects');
  });

  it('abstains on cross-paper deltas for a single paper and supports minPapers refusal', () => {
    const single = buildPaperMatrix([PAPER_ALPHA]);
    expect(single.refusal).toBeNull();
    expect(single.comparisonVerdict).toBe('abstain');
    expect(single.abstainReasons).toEqual(['insufficient-papers']);
    for (const delta of single.metricDeltas) {
      expect(delta.status).toBe('abstained');
      expect(delta.abstainReason).toBe('single-witness');
      expect(delta.spread).toBeNull();
      expect(delta.pairwiseDeltas).toEqual([]);
    }
    for (const dimDelta of single.dimensionDeltas) {
      expect(dimDelta.status).toBe('abstained');
      expect(dimDelta.abstainReason).toBe('single-witness');
    }

    const strictSingle = buildPaperMatrix([PAPER_ALPHA], { minPapers: 2 });
    expect(strictSingle.refusal).toBe('insufficient-papers');
    expect(strictSingle.comparisonVerdict).toBe('abstain');
  });

  it('abstains with no-evidence when 2+ papers report zero dimensions', () => {
    const emptyA: PaperMatrixInput = {
      id: 'empty-a',
      title: 'Empty A',
      ir: makePaperIr('empty-a', SHA_A, []),
    };
    const unrelatedB: PaperMatrixInput = {
      id: 'unrelated-b',
      title: 'Unrelated B',
      ir: makePaperIr('unrelated-b', SHA_B, [
        { page: 1, text: 'General editorial remarks without empirical study.' },
      ]),
    };

    const matrix = buildPaperMatrix([emptyA, unrelatedB]);
    expect(matrix.refusal).toBeNull();
    expect(matrix.comparisonVerdict).toBe('abstain');
    expect(matrix.abstainReasons).toEqual(['no-evidence']);
    expect(matrix.coverage.reportedCells).toBe(0);
    expect(getPaperMatrixCell(matrix, 'empty-a', 'method')).toEqual({
      status: 'not_reported',
      documentId: 'empty-a',
      dimensionId: 'method',
      reason: 'no-blocks',
    });
    expect(getPaperMatrixCell(matrix, 'unrelated-b', 'method')).toEqual({
      status: 'not_reported',
      documentId: 'unrelated-b',
      dimensionId: 'method',
      reason: 'no-match',
    });
  });

  it('abstains on unit-mismatched metrics instead of inventing conversions', () => {
    const percentPaper: PaperMatrixInput = {
      id: 'pct',
      title: 'Percent Paper',
      ir: makePaperIr('pct', SHA_A, [
        { page: 1, type: 'heading', text: 'Results' },
        { page: 1, text: 'Our model reaches 88.5% F1 with 42 ms latency.' },
      ]),
    };
    const ratioPaper: PaperMatrixInput = {
      id: 'ratio',
      title: 'Ratio Paper',
      ir: makePaperIr('ratio', SHA_B, [
        { page: 1, type: 'heading', text: 'Results' },
        { page: 1, text: 'Our model reaches 0.912 F1 with 0.065 s latency.' },
      ]),
    };

    const matrix = buildPaperMatrix([percentPaper, ratioPaper]);

    const f1 = matrix.metricDeltas.find(d => d.metricKey === 'f1');
    expect(f1?.status).toBe('abstained');
    expect(f1?.abstainReason).toBe('unit-mismatch');
    expect(f1?.spread).toBeNull();
    expect(f1?.pairwiseDeltas).toEqual([]);

    const latency = matrix.metricDeltas.find(d => d.metricKey === 'latency');
    expect(latency?.status).toBe('abstained');
    expect(latency?.abstainReason).toBe('unit-mismatch');
  });

  it('filters low-confidence OCR blocks and rejects explicit non-reporting stubs', () => {
    const ocrPaper: PaperMatrixInput = {
      id: 'ocr-low',
      title: 'Noisy OCR Paper',
      year: Number.NaN,
      ir: makePaperIr('ocr-low', SHA_A, [
        { page: 1, type: 'heading', text: 'Method' },
        {
          page: 1,
          text: 'Our proposed method uses a graph transformer. It runs in two passes.',
          confidence: 0.95,
        },
        { page: 2, type: 'heading', text: 'Limitations' },
        {
          page: 2,
          text: 'A key limitation is sensitivity to blurry scans.',
          confidence: 0.35,
        },
      ]),
    };
    const stubPaper: PaperMatrixInput = {
      id: 'stub',
      title: 'Stub Paper',
      ir: makePaperIr('stub', SHA_B, [
        { page: 1, text: 'Limitations: not reported.' },
        { page: 1, text: 'Metrics: N/A.' },
      ]),
    };

    const matrix = buildPaperMatrix([ocrPaper, stubPaper], { minConfidence: 0.7 });

    // Method had high confidence (0.95) -> reported.
    expect(getPaperMatrixCell(matrix, 'ocr-low', 'method')?.status).toBe('reported');
    // Limitations only appeared in a 0.35-confidence block -> abstained as insufficient-evidence.
    expect(getPaperMatrixCell(matrix, 'ocr-low', 'limitations')).toEqual({
      status: 'not_reported',
      documentId: 'ocr-low',
      dimensionId: 'limitations',
      reason: 'insufficient-evidence',
    });

    // Explicit non-reporting stubs must stay not_reported.
    expect(getPaperMatrixCell(matrix, 'stub', 'limitations')?.status).toBe('not_reported');
    expect(getPaperMatrixCell(matrix, 'stub', 'metrics')?.status).toBe('not_reported');
    expect(matrix.rows[0]?.year).toBe(0);
  });

  it('preserves blank section provenance for unsectioned blocks and drops duplicate ids', () => {
    const unsectioned: PaperMatrixInput = {
      id: 'unsec',
      title: 'Unsectioned Paper',
      ir: makePaperIr('unsec', SHA_A, [
        { page: 1, text: 'Our proposed method trains a tiny MLP.' },
      ]),
    };
    const duplicate: PaperMatrixInput = {
      id: 'unsec',
      title: 'Duplicate Should Be Dropped',
      ir: makePaperIr('unsec', SHA_B, [
        { page: 1, text: 'Our architecture uses something else.' },
      ]),
    };

    const matrix = buildPaperMatrix([unsectioned, duplicate, PAPER_BETA]);
    expect(matrix.rows.map(r => r.documentId)).toEqual(['unsec', 'paper-beta']);

    const cell = assertReported(getPaperMatrixCell(matrix, 'unsec', 'method'));
    expect(cell.provenance.section).toBe('');
    expect(toPaperMatrixMarkdown(matrix)).toContain(PAPER_MATRIX_UNNAMED_SECTION);
  });
});
