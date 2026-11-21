import { describe, expect, it } from 'vitest';
import { agreeing, conflicts as evidenceConflicts } from '../src/core/evidence-matrix';
import { buildDocument, type BlockType, type DocumentIR } from '../src/core/ir';
import { summarise } from '../src/core/paper-compare';
import {
  CANONICAL_DIMENSIONS,
  NOT_REPORTED_VALUE,
  PAPER_MATRIX_CSV_SEPARATOR,
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
} from '../src/core/paper-matrix';

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
