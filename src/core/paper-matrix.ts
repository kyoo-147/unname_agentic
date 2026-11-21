/**
 * Evidence-backed paper comparison matrix (backlog item J06).
 *
 * Compares 2+ `DocumentIR` papers across canonical academic dimensions (`method`,
 * `dataset`, `metrics`, `limitations`) plus optional custom axes. Every populated cell
 * carries a verbatim quote copied directly from a source block in `DocumentIR` together
 * with full `(documentId, page, blockId, section)` provenance. Any omitted dimension is
 * rendered explicitly as `'not_reported'` — never extrapolated, guessed, or borrowed from
 * another paper.
 *
 * Composes cleanly with:
 * - `./ir` (`DocumentIR`, `Block`, reading-order traversal and heading-based sections)
 * - `./paper-compare` (keyword/preferred-section scoring weights and `PaperMatrix` projection)
 * - `./evidence-matrix` (deterministic normalization, `AspectMatrix` projection, and conflict readers)
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network, no I/O.
 * - Verbatim evidence only: every `'reported'` cell's `quote` is an exact substring of the
 *   source block's `raw` text, and bare headings without body blocks never count as evidence.
 * - Explicit abstention: omitted dimensions output `'not_reported'`, single-witness or
 *   unit-mismatched metric deltas abstain instead of guessing, and insufficient inputs
 *   refuse cleanly.
 */

import {
  buildMatrix as buildAspectMatrix,
  conflicts as detectAspectConflicts,
  type AspectConflict,
  type AspectMatrix,
  type MatrixAspect,
  type MatrixAspectKind,
  type MatrixCell,
  type MatrixDocument,
  type MatrixGap,
} from './evidence-matrix';
import type { Block, DocumentIR } from './ir';
import {
  PAPER_KEYWORD_HIT_WEIGHT,
  PAPER_PREFERRED_SECTION_BONUS,
  PAPER_UNNAMED_SECTION,
  type PaperAspectKind,
  type PaperCell,
  type PaperGap,
  type PaperMatrix,
} from './paper-compare';

// --- Public constants & shapes ---------------------------------------------

export const CANONICAL_DIMENSIONS = ['method', 'dataset', 'metrics', 'limitations'] as const;
export type CanonicalDimensionId = (typeof CANONICAL_DIMENSIONS)[number];

export const NOT_REPORTED_VALUE = 'not_reported' as const;
export const PAPER_MATRIX_CSV_SEPARATOR = '\r\n';
export const PAPER_MATRIX_UNNAMED_SECTION = PAPER_UNNAMED_SECTION;

export type DimensionKind = CanonicalDimensionId | 'custom';

export interface PaperMatrixInput {
  /** Unique paper id; defaults to `ir.documentId`. Duplicate ids are skipped after first appearance. */
  id?: string;
  /** Display title for table rows; falls back to `documentId`. */
  title?: string;
  /** Optional publication year (0 when unknown). */
  year?: number;
  /** Source Document IR produced by `buildDocument`. */
  ir: DocumentIR;
}

export interface MatrixAxis {
  id: string;
  label: string;
  kind?: DimensionKind;
  keywords?: readonly string[];
  pattern?: RegExp;
  preferredSections?: readonly string[];
  valueKind?: MatrixAspectKind;
  unit?: string;
  higherIsBetter?: boolean;
}

export interface MetricDefinition {
  key: string;
  label: string;
  aliases: readonly string[];
  /** Case-sensitive aliases (e.g. `mAP`, `EM`) prevent false positives on ordinary English words. */
  caseSensitiveAliases?: readonly string[];
  higherIsBetter?: boolean;
}

export interface BuildPaperMatrixOptions {
  dimensions?: readonly CanonicalDimensionId[];
  customAxes?: readonly MatrixAxis[];
  axes?: readonly (CanonicalDimensionId | MatrixAxis)[];
  extraMetrics?: readonly MetricDefinition[];
  /** Minimum block confidence (0..1); blocks below this floor are ignored. Defaults to 0. */
  minConfidence?: number;
  /** Minimum usable papers before matrix-level refusal. Defaults to 1 (2+ required for deltas). */
  minPapers?: number;
  /** Optional baseline document id for pairwise metric deltas; defaults to first reporting paper. */
  baselineDocumentId?: string;
}

export interface CellProvenance {
  documentId: string;
  page: number;
  blockId: string;
  section: string;
}

export interface ExtractedMetric {
  metricKey: string;
  label: string;
  rawValue: string;
  numericValue: number | null;
  normalizedValue: string;
  unit: string;
  quote: string;
  provenance: CellProvenance;
  score: number;
}

export interface MatrixCitation {
  quote: string;
  provenance: CellProvenance;
}

export interface ReportedMatrixCell {
  status: 'reported';
  documentId: string;
  dimensionId: string;
  quote: string;
  provenance: CellProvenance;
  additionalCitations: readonly MatrixCitation[];
  extractedMetrics: readonly ExtractedMetric[];
  normalizedValue: string;
  score: number;
}

export type NotReportedReason = 'no-blocks' | 'no-match' | 'insufficient-evidence';

export interface NotReportedMatrixCell {
  status: 'not_reported';
  documentId: string;
  dimensionId: string;
  reason: NotReportedReason;
}

export type PaperMatrixCell = ReportedMatrixCell | NotReportedMatrixCell;

export interface MetricReadingEntry {
  documentId: string;
  rawValue: string;
  numericValue: number | null;
  normalizedValue: string;
  unit: string;
  quote: string;
  provenance: CellProvenance;
}

export interface PairwiseMetricDelta {
  fromDocumentId: string;
  toDocumentId: string;
  delta: number;
  unit: string;
}

export type MetricComparisonStatus = 'agree' | 'conflict' | 'abstained';
export type MetricAbstainReason = 'single-witness' | 'unit-mismatch' | 'non-numeric';

export interface MetricDeltaReport {
  metricKey: string;
  label: string;
  unit: string;
  status: MetricComparisonStatus;
  abstainReason: MetricAbstainReason | null;
  baselineDocumentId: string | null;
  entries: readonly MetricReadingEntry[];
  missingDocumentIds: readonly string[];
  min: { documentId: string; numericValue: number } | null;
  max: { documentId: string; numericValue: number } | null;
  spread: number | null;
  pairwiseDeltas: readonly PairwiseMetricDelta[];
}

export interface IntraPaperMetricConflict {
  documentId: string;
  metricKey: string;
  label: string;
  readings: readonly ExtractedMetric[];
}

export interface DimensionReadingGroup {
  normalizedValue: string;
  cells: readonly ReportedMatrixCell[];
}

export interface DimensionDeltaReport {
  dimensionId: string;
  label: string;
  status: 'agree' | 'differ' | 'abstained';
  abstainReason: 'no-evidence' | 'single-witness' | null;
  reportedDocumentIds: readonly string[];
  notReportedDocumentIds: readonly string[];
  distinctReadings: readonly DimensionReadingGroup[];
}

export interface CoverageGap {
  documentId: string;
  dimensionId: string;
  reason: NotReportedReason;
}

export interface DimensionCoverage {
  dimensionId: string;
  label: string;
  reportedCount: number;
  notReportedCount: number;
  totalPapers: number;
  coverageRate: number;
  reportedDocumentIds: readonly string[];
  missingDocumentIds: readonly string[];
}

export interface PaperCoverage {
  documentId: string;
  title: string;
  reportedCount: number;
  notReportedCount: number;
  totalDimensions: number;
  coverageRate: number;
  missingDimensionIds: readonly string[];
}

export interface MatrixCoverageSummary {
  totalCells: number;
  reportedCells: number;
  notReportedCells: number;
  overallCoverageRate: number;
  gaps: readonly CoverageGap[];
  byDimension: readonly DimensionCoverage[];
  byPaper: readonly PaperCoverage[];
}

export interface ConflictReport {
  crossPaperMetrics: readonly MetricDeltaReport[];
  intraPaperMetrics: readonly IntraPaperMetricConflict[];
  dimensionDisagreements: readonly DimensionDeltaReport[];
  evidenceMatrixConflicts: readonly AspectConflict[];
}

export interface PaperMatrixRow {
  documentId: string;
  title: string;
  year: number;
}

export interface PaperMatrixColumn {
  dimensionId: string;
  label: string;
  kind: DimensionKind;
  valueKind: MatrixAspectKind;
}

export type MatrixRefusalReason = 'no-papers' | 'insufficient-papers' | 'no-dimensions';
export type ComparisonVerdict = 'ready' | 'partial' | 'abstain';
export type ComparisonAbstainReason =
  | 'no-papers'
  | 'insufficient-papers'
  | 'no-dimensions'
  | 'no-evidence';

export interface PaperComparisonMatrix {
  rows: readonly PaperMatrixRow[];
  columns: readonly PaperMatrixColumn[];
  cells: readonly PaperMatrixCell[];
  coverage: MatrixCoverageSummary;
  metricDeltas: readonly MetricDeltaReport[];
  dimensionDeltas: readonly DimensionDeltaReport[];
  conflicts: ConflictReport;
  refusal: MatrixRefusalReason | null;
  comparisonVerdict: ComparisonVerdict;
  abstainReasons: readonly ComparisonAbstainReason[];
}

// --- Canonical defaults ----------------------------------------------------

interface CanonicalSpec {
  id: CanonicalDimensionId;
  label: string;
  keywords: readonly string[];
  preferredSections: readonly string[];
}

const CANONICAL_SPECS: Readonly<Record<CanonicalDimensionId, CanonicalSpec>> = {
  method: {
    id: 'method',
    label: 'Method',
    keywords: [
      'method',
      'methodology',
      'approach',
      'architecture',
      'algorithm',
      'framework',
      'pipeline',
      'technique',
      'procedure',
      'objective',
      'training objective',
      'encoder',
      'decoder',
      'reranker',
      'transformer',
      'loss function',
      'proposed system',
    ],
    preferredSections: [
      'method',
      'methodology',
      'approach',
      'architecture',
      'model',
      'algorithm',
      'framework',
      'procedure',
      'protocol',
      'implementation',
    ],
  },
  dataset: {
    id: 'dataset',
    label: 'Dataset',
    keywords: [
      'dataset',
      'datasets',
      'corpus',
      'corpora',
      'benchmark dataset',
      'benchmark datasets',
      'evaluation benchmark',
      'training data',
      'evaluation data',
      'test data',
      'training set',
      'validation set',
      'dev set',
      'development set',
      'test set',
      'data split',
      'participants',
      'cohort',
      'subjects',
    ],
    preferredSections: [
      'data',
      'dataset',
      'datasets',
      'corpus',
      'corpora',
      'benchmark',
      'experiment',
      'setup',
      'material',
      'participant',
    ],
  },
  metrics: {
    id: 'metrics',
    label: 'Metrics',
    keywords: [
      'accuracy',
      'f1',
      'f1-score',
      'precision',
      'recall',
      'exact match',
      'bleu',
      'rouge',
      'rouge-1',
      'rouge-2',
      'rouge-l',
      'meteor',
      'bertscore',
      'auc',
      'auroc',
      'auprc',
      'perplexity',
      'rmse',
      'mae',
      'mse',
      'wer',
      'cer',
      'mrr',
      'ndcg',
      'latency',
      'throughput',
      'metric',
      'metrics',
      'evaluation metric',
      'evaluation metrics',
    ],
    preferredSections: [
      'result',
      'results',
      'evaluation',
      'evaluate',
      'experiment',
      'experiments',
      'performance',
      'metric',
      'metrics',
      'finding',
      'findings',
    ],
  },
  limitations: {
    id: 'limitations',
    label: 'Limitations',
    keywords: [
      'limitation',
      'limitations',
      'drawback',
      'weakness',
      'caveat',
      'shortcoming',
      'threat to validity',
      'threats to validity',
      'bottleneck',
      'fails to',
      'fails on',
      'failure mode',
      'failure cases',
      'cannot',
      'unable to',
      'restricted to',
      'only evaluated',
      'only tested',
      'only supports',
      'sensitive to',
      'degrades',
      'does not generalize',
      'hallucinate',
      'hallucination',
      'ethical risk',
      'future work',
    ],
    preferredSections: [
      'limitation',
      'limitations',
      'threat',
      'threats to validity',
      'validity',
      'weakness',
      'weaknesses',
      'caveat',
      'error analysis',
      'discussion',
    ],
  },
};

const DEFAULT_METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  { key: 'top1_accuracy', label: 'Top-1 Accuracy', aliases: ['top-1 accuracy', 'top-1 acc'], higherIsBetter: true },
  { key: 'top5_accuracy', label: 'Top-5 Accuracy', aliases: ['top-5 accuracy', 'top-5 acc'], higherIsBetter: true },
  { key: 'macro_f1', label: 'Macro-F1', aliases: ['macro-f1', 'macro f1'], higherIsBetter: true },
  { key: 'micro_f1', label: 'Micro-F1', aliases: ['micro-f1', 'micro f1'], higherIsBetter: true },
  { key: 'f1', label: 'F1', aliases: ['f1-score', 'f1 score', 'f1'], higherIsBetter: true },
  {
    key: 'exact_match',
    label: 'Exact Match',
    aliases: ['exact match', 'exact-match'],
    caseSensitiveAliases: ['EM'],
    higherIsBetter: true,
  },
  { key: 'accuracy', label: 'Accuracy', aliases: ['accuracy'], caseSensitiveAliases: ['Acc'], higherIsBetter: true },
  { key: 'precision', label: 'Precision', aliases: ['precision'], higherIsBetter: true },
  { key: 'recall', label: 'Recall', aliases: ['recall'], higherIsBetter: true },
  { key: 'bleu_4', label: 'BLEU-4', aliases: ['bleu-4', 'bleu4'], higherIsBetter: true },
  { key: 'bleu', label: 'BLEU', aliases: ['bleu'], higherIsBetter: true },
  { key: 'rouge_1', label: 'ROUGE-1', aliases: ['rouge-1', 'rouge1'], higherIsBetter: true },
  { key: 'rouge_2', label: 'ROUGE-2', aliases: ['rouge-2', 'rouge2'], higherIsBetter: true },
  { key: 'rouge_l', label: 'ROUGE-L', aliases: ['rouge-l', 'rougel'], higherIsBetter: true },
  { key: 'rouge', label: 'ROUGE', aliases: ['rouge'], higherIsBetter: true },
  { key: 'meteor', label: 'METEOR', aliases: ['meteor'], higherIsBetter: true },
  { key: 'bertscore', label: 'BERTScore', aliases: ['bertscore'], higherIsBetter: true },
  { key: 'auroc', label: 'AUROC', aliases: ['auroc'], higherIsBetter: true },
  { key: 'auprc', label: 'AUPRC', aliases: ['auprc'], higherIsBetter: true },
  { key: 'auc', label: 'AUC', aliases: ['auc'], higherIsBetter: true },
  { key: 'perplexity', label: 'Perplexity', aliases: ['perplexity'], caseSensitiveAliases: ['PPL'], higherIsBetter: false },
  {
    key: 'latency',
    label: 'Latency',
    aliases: ['inference latency', 'latency', 'inference time', 'runtime'],
    higherIsBetter: false,
  },
  { key: 'throughput', label: 'Throughput', aliases: ['throughput'], higherIsBetter: true },
  {
    key: 'memory',
    label: 'Memory',
    aliases: ['peak memory', 'gpu memory', 'memory usage', 'vram'],
    higherIsBetter: false,
  },
  { key: 'rmse', label: 'RMSE', aliases: ['rmse'], higherIsBetter: false },
  { key: 'mae', label: 'MAE', aliases: ['mae'], higherIsBetter: false },
  { key: 'mse', label: 'MSE', aliases: ['mse'], higherIsBetter: false },
  { key: 'wer', label: 'WER', aliases: ['wer'], higherIsBetter: false },
  { key: 'cer', label: 'CER', aliases: ['cer'], higherIsBetter: false },
  { key: 'mrr', label: 'MRR', aliases: ['mrr'], higherIsBetter: true },
  { key: 'ndcg', label: 'NDCG', aliases: ['ndcg'], higherIsBetter: true },
  { key: 'map', label: 'mAP', aliases: [], caseSensitiveAliases: ['mAP'], higherIsBetter: true },
];

// --- Internal prepared structures ------------------------------------------

interface PreparedSentence {
  text: string;
  section: string;
  page: number;
  blockId: string;
  block: Block;
  extractedMetrics: ExtractedMetric[];
}

interface PreparedPaper {
  documentId: string;
  title: string;
  year: number;
  ir: DocumentIR;
  sentences: PreparedSentence[];
  hasSearchableBlocks: boolean;
  hasAnyRawText: boolean;
  /** All metric mentions found across all searchable blocks, in reading order. */
  allMetrics: ExtractedMetric[];
  /** Primary reading per metricKey (preferred section first, then earliest reading order). */
  primaryMetrics: Map<string, ExtractedMetric>;
  /** Intra-paper conflicts where the same paper reports multiple distinct values for one metricKey. */
  intraPaperMetricConflicts: IntraPaperMetricConflict[];
}

interface PreparedAxis {
  id: string;
  label: string;
  kind: DimensionKind;
  valueKind: MatrixAspectKind;
  matchers: readonly RegExp[];
  pattern: RegExp | null;
  preferredSections: readonly string[];
  unit: string;
}

interface CompiledMetricAlias {
  metric: MetricDefinition;
  alias: string;
  caseSensitive: boolean;
  beforePattern: RegExp;
  afterPattern: RegExp;
}

// --- Public builder & query helpers ----------------------------------------

/**
 * Builds an evidence-backed comparison matrix across 2+ `DocumentIR` papers.
 */
export function buildPaperMatrix(
  papers: readonly (PaperMatrixInput | DocumentIR)[],
  options: BuildPaperMatrixOptions = {},
): PaperComparisonMatrix {
  const minConfidence = clampConfidence(options.minConfidence);
  const minPapers = typeof options.minPapers === 'number' && Number.isFinite(options.minPapers)
    ? Math.max(1, Math.trunc(options.minPapers))
    : 1;
  const compiledMetrics = compileMetricCatalog(options.extraMetrics);
  const preparedPapers = preparePapers(papers, minConfidence, compiledMetrics);
  const preparedAxes = prepareAxes(options);

  if (preparedPapers.length === 0) {
    return refusedMatrix('no-papers', ['no-papers']);
  }
  if (preparedPapers.length < minPapers) {
    return refusedMatrix('insufficient-papers', ['insufficient-papers']);
  }
  if (preparedAxes.length === 0) {
    return refusedMatrix('no-dimensions', ['no-dimensions']);
  }

  const rows: PaperMatrixRow[] = preparedPapers.map(paper => ({
    documentId: paper.documentId,
    title: paper.title,
    year: paper.year,
  }));
  const columns: PaperMatrixColumn[] = preparedAxes.map(axis => ({
    dimensionId: axis.id,
    label: axis.label,
    kind: axis.kind,
    valueKind: axis.valueKind,
  }));

  const cells: PaperMatrixCell[] = [];
  for (const paper of preparedPapers) {
    for (const axis of preparedAxes) {
      cells.push(evaluateCell(paper, axis));
    }
  }

  const coverage = computeCoverage(rows, columns, cells);
  const metricDeltas = computeMetricDeltas(
    preparedPapers,
    preparedAxes,
    cells,
    compiledMetrics,
    options.baselineDocumentId,
  );
  const dimensionDeltas = computeDimensionDeltas(rows, columns, cells);
  const intraPaperMetrics = preparedPapers.flatMap(paper => paper.intraPaperMetricConflicts);

  const abstainReasons: ComparisonAbstainReason[] = [];
  if (preparedPapers.length < 2) {
    abstainReasons.push('insufficient-papers');
  }
  if (coverage.reportedCells === 0) {
    abstainReasons.push('no-evidence');
  }

  const comparisonVerdict: ComparisonVerdict = abstainReasons.length > 0
    ? 'abstain'
    : coverage.notReportedCells > 0
      ? 'partial'
      : 'ready';

  const partialMatrix: PaperComparisonMatrix = {
    rows,
    columns,
    cells,
    coverage,
    metricDeltas,
    dimensionDeltas,
    conflicts: {
      crossPaperMetrics: metricDeltas.filter(delta => delta.status === 'conflict'),
      intraPaperMetrics,
      dimensionDisagreements: dimensionDeltas.filter(delta => delta.status === 'differ'),
      evidenceMatrixConflicts: [],
    },
    refusal: null,
    comparisonVerdict,
    abstainReasons,
  };

  // Compose with ./evidence-matrix conflict detection over the projected AspectMatrix.
  const evidenceMatrixConflicts = detectAspectConflicts(toEvidenceMatrix(partialMatrix));

  return {
    ...partialMatrix,
    conflicts: {
      ...partialMatrix.conflicts,
      evidenceMatrixConflicts,
    },
  };
}

/**
 * Looks up a single `(documentId, dimensionId)` cell in the matrix.
 */
export function getPaperMatrixCell(
  matrix: PaperComparisonMatrix,
  documentId: string,
  dimensionId: string,
): PaperMatrixCell | undefined {
  return matrix.cells.find(
    cell => cell.documentId === documentId && cell.dimensionId === dimensionId,
  );
}

// --- Exporters: Markdown, RFC 4180 CSV, JSON -------------------------------

/**
 * Exports the matrix as a GitHub-Flavored Markdown table where every reported cell
 * keeps its verbatim quote and `(documentId, page, blockId, section)` provenance, and
 * omitted dimensions render explicitly as `not_reported`.
 */
export function toPaperMatrixMarkdown(
  matrix: PaperComparisonMatrix,
  options: { includeYear?: boolean; includeSummary?: boolean } = {},
): string {
  const grid = buildTableGrid(matrix, options.includeYear === true);
  if (grid === null) return '';

  const [header, ...bodyRows] = grid;
  if (header === undefined) return '';

  const lines: string[] = [
    markdownRow(header),
    `| ${header.map(() => '---').join(' | ')} |`,
    ...bodyRows.map(markdownRow),
  ];

  if (options.includeSummary === true) {
    lines.push('');
    lines.push(
      `Coverage: ${matrix.coverage.reportedCells}/${matrix.coverage.totalCells} cells reported (${Math.round(matrix.coverage.overallCoverageRate * 100)}%).`,
    );
    for (const delta of matrix.metricDeltas) {
      if (delta.status === 'conflict' && delta.spread !== null) {
        lines.push(`- ${delta.label}: spread ${delta.spread}${delta.unit}`);
      } else if (delta.status === 'abstained' && delta.abstainReason !== null) {
        lines.push(`- ${delta.label}: abstained (${delta.abstainReason})`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Exports the matrix as RFC 4180 CSV with CRLF record separators, quote-doubling,
 * full provenance on reported cells, and explicit `not_reported` on omissions.
 */
export function toPaperMatrixCsv(
  matrix: PaperComparisonMatrix,
  options: { includeYear?: boolean } = {},
): string {
  const grid = buildTableGrid(matrix, options.includeYear === true);
  if (grid === null) return '';
  return grid.map(csvRow).join(PAPER_MATRIX_CSV_SEPARATOR);
}

function buildTableGrid(
  matrix: PaperComparisonMatrix,
  includeYear: boolean,
): string[][] | null {
  if (matrix.refusal !== null || matrix.rows.length === 0 || matrix.columns.length === 0) {
    return null;
  }

  const header = includeYear
    ? ['Paper', 'Year', ...matrix.columns.map(col => col.label)]
    : ['Paper', ...matrix.columns.map(col => col.label)];
  const rows: string[][] = [header];
  const cellMap = indexCells(matrix.cells);

  for (const row of matrix.rows) {
    const rendered = matrix.columns.map(col => {
      const cell = cellMap.get(pairKey(row.documentId, col.dimensionId));
      return cell && cell.status === 'reported' ? formatRenderedCell(cell) : NOT_REPORTED_VALUE;
    });
    const yearText = Number.isInteger(row.year) && row.year > 0 ? String(row.year) : '';
    rows.push(includeYear ? [row.title, yearText, ...rendered] : [row.title, ...rendered]);
  }

  return rows;
}

/**
 * Exports the matrix as deterministic plain JSON.
 */
export function toPaperMatrixJson(
  matrix: PaperComparisonMatrix,
  options: { pretty?: boolean } = {},
): string {
  return options.pretty === true ? JSON.stringify(matrix, null, 2) : JSON.stringify(matrix);
}

// --- Composition adapters with ./paper-compare & ./evidence-matrix ---------

/**
 * Projects a J06 `PaperComparisonMatrix` into `./paper-compare`'s `PaperMatrix` shape so
 * callers can invoke `summarise` or `toMarkdown` from `./paper-compare`.
 */
export function toPaperCompareMatrix(matrix: PaperComparisonMatrix): PaperMatrix {
  if (matrix.refusal !== null) {
    const refusal = matrix.refusal === 'no-dimensions' ? 'no-aspects' : 'no-papers';
    return { rows: [], aspects: [], cells: [], gaps: [], refusal };
  }

  const rows = matrix.rows.map(row => ({
    paperId: row.documentId,
    title: row.title,
    year: row.year,
  }));
  const aspects = matrix.columns.map(col => ({
    aspectId: col.dimensionId,
    label: col.label,
    kind: toPaperAspectKind(col.kind),
  }));

  const cells: PaperCell[] = [];
  const gaps: PaperGap[] = [];
  for (const cell of matrix.cells) {
    if (cell.status === 'reported') {
      cells.push({
        paperId: cell.documentId,
        aspectId: cell.dimensionId,
        text: cell.quote,
        section: cell.provenance.section,
        score: cell.score,
      });
    } else {
      gaps.push({
        paperId: cell.documentId,
        aspectId: cell.dimensionId,
        reason: cell.reason === 'no-blocks' ? 'no-sections' : 'no-match',
      });
    }
  }

  return { rows, aspects, cells, gaps, refusal: null };
}

/**
 * Projects a J06 `PaperComparisonMatrix` into `./evidence-matrix`'s `AspectMatrix` shape
 * so `conflicts()` and `agreeing()` from `./evidence-matrix` can inspect every column.
 */
export function toEvidenceMatrix(matrix: PaperComparisonMatrix): AspectMatrix {
  if (matrix.refusal !== null) {
    const refusal = matrix.refusal === 'no-dimensions' ? 'no-aspects' : 'no-documents';
    return { rows: [], columns: [], cells: [], gaps: [], refusal };
  }

  const rows = matrix.rows.map(row => ({
    documentId: row.documentId,
    title: row.title,
  }));
  const columns = matrix.columns.map(col => ({
    aspectId: col.dimensionId,
    label: col.label,
    kind: col.valueKind,
  }));

  const cells: MatrixCell[] = [];
  const gaps: MatrixGap[] = [];
  for (const cell of matrix.cells) {
    if (cell.status === 'reported') {
      cells.push({
        documentId: cell.documentId,
        aspectId: cell.dimensionId,
        page: cell.provenance.page,
        blockId: cell.provenance.blockId,
        excerpt: cell.quote,
        raw: cell.quote,
        value: cell.normalizedValue,
      });
    } else {
      gaps.push({
        documentId: cell.documentId,
        aspectId: cell.dimensionId,
      });
    }
  }

  return { rows, columns, cells, gaps, refusal: null };
}

function toPaperAspectKind(kind: DimensionKind): PaperAspectKind {
  if (kind === 'method') return 'methodology';
  if (kind === 'dataset') return 'dataset';
  if (kind === 'metrics') return 'metric';
  return 'other';
}

// --- Refusal & cell evaluation ---------------------------------------------

function refusedMatrix(
  refusal: MatrixRefusalReason,
  abstainReasons: readonly ComparisonAbstainReason[],
): PaperComparisonMatrix {
  return {
    rows: [],
    columns: [],
    cells: [],
    coverage: {
      totalCells: 0,
      reportedCells: 0,
      notReportedCells: 0,
      overallCoverageRate: 0,
      gaps: [],
      byDimension: [],
      byPaper: [],
    },
    metricDeltas: [],
    dimensionDeltas: [],
    conflicts: {
      crossPaperMetrics: [],
      intraPaperMetrics: [],
      dimensionDisagreements: [],
      evidenceMatrixConflicts: [],
    },
    refusal,
    comparisonVerdict: 'abstain',
    abstainReasons,
  };
}

function evaluateCell(paper: PreparedPaper, axis: PreparedAxis): PaperMatrixCell {
  if (!paper.hasSearchableBlocks) {
    return {
      status: NOT_REPORTED_VALUE,
      documentId: paper.documentId,
      dimensionId: axis.id,
      reason: paper.hasAnyRawText ? 'insufficient-evidence' : 'no-blocks',
    };
  }

  let bestSentence: PreparedSentence | null = null;
  let bestScore = 0;
  let bestPatternRaw: string | null = null;
  const matchedSentences: PreparedSentence[] = [];

  for (const sentence of paper.sentences) {
    if (isExplicitNonReportedStub(sentence.text)) continue;

    const patternMatch = axis.pattern !== null ? execRegex(axis.pattern, sentence.text) : null;
    if (axis.pattern !== null && axis.matchers.length === 0 && patternMatch === null) {
      continue;
    }

    const keywordHits = countKeywordHits(foldText(sentence.text), axis.matchers);
    const metricHits = axis.id === 'metrics' ? sentence.extractedMetrics.length : 0;
    const hasMatch = patternMatch !== null || keywordHits > 0 || metricHits > 0;
    if (!hasMatch) continue;

    matchedSentences.push(sentence);

    const preferred = prefersSection(sentence.section, axis.preferredSections);
    const score =
      (patternMatch !== null ? PAPER_KEYWORD_HIT_WEIGHT * 2 : 0)
      + keywordHits * PAPER_KEYWORD_HIT_WEIGHT
      + metricHits * PAPER_KEYWORD_HIT_WEIGHT
      + (preferred ? PAPER_PREFERRED_SECTION_BONUS : 0);

    if (bestSentence === null || score > bestScore) {
      bestSentence = sentence;
      bestScore = score;
      bestPatternRaw = patternMatch;
    }
  }

  if (bestSentence === null) {
    return {
      status: NOT_REPORTED_VALUE,
      documentId: paper.documentId,
      dimensionId: axis.id,
      reason: paper.hasAnyRawText && paper.sentences.length < countNonHeadingTextBlocks(paper.ir.blocks)
        ? 'insufficient-evidence'
        : 'no-match',
    };
  }

  const provenance: CellProvenance = {
    documentId: paper.documentId,
    page: bestSentence.page,
    blockId: bestSentence.blockId,
    section: bestSentence.section,
  };

  const additionalCitations: MatrixCitation[] = [];
  if (axis.id === 'metrics') {
    for (const candidate of matchedSentences) {
      if (candidate.extractedMetrics.length === 0) continue;
      if (
        candidate.blockId === bestSentence.blockId
        && candidate.text === bestSentence.text
      ) {
        continue;
      }
      additionalCitations.push({
        quote: candidate.text,
        provenance: {
          documentId: paper.documentId,
          page: candidate.page,
          blockId: candidate.blockId,
          section: candidate.section,
        },
      });
    }
  }

  const normalizedValue = normalizeCellValue(
    paper,
    bestSentence,
    axis,
    bestPatternRaw,
  );

  const extractedMetrics = axis.id === 'metrics'
    ? collectPrimaryMetricList(paper)
    : [];

  return {
    status: 'reported',
    documentId: paper.documentId,
    dimensionId: axis.id,
    quote: bestSentence.text,
    provenance,
    additionalCitations,
    extractedMetrics,
    normalizedValue,
    score: bestScore,
  };
}

function normalizeCellValue(
  paper: PreparedPaper,
  sentence: PreparedSentence,
  axis: PreparedAxis,
  patternRaw: string | null,
): string {
  if (axis.pattern !== null && patternRaw !== null) {
    // Compose with ./evidence-matrix's normalizers on the isolated matched block.
    const miniIr: DocumentIR = {
      ...paper.ir,
      blocks: [{ ...sentence.block, raw: sentence.text }],
    };
    const doc: MatrixDocument = {
      id: paper.documentId,
      title: paper.title,
      ir: miniIr,
    };
    const aspect: MatrixAspect = {
      id: axis.id,
      label: axis.label,
      kind: axis.valueKind,
      pattern: axis.pattern,
    };
    const built = buildAspectMatrix([doc], [aspect]);
    const cell = built.cells[0];
    if (cell !== undefined) {
      return cell.value;
    }
  }

  if (axis.id === 'metrics') {
    const metrics = collectPrimaryMetricList(paper);
    if (metrics.length > 0) {
      return metrics
        .map(m => `${m.metricKey}:${m.normalizedValue}${m.unit}`)
        .join(';');
    }
  }

  return normalizeQuoteKey(sentence.text);
}

function collectPrimaryMetricList(paper: PreparedPaper): ExtractedMetric[] {
  return [...paper.primaryMetrics.values()];
}

// --- Coverage & Deltas -----------------------------------------------------

function computeCoverage(
  rows: readonly PaperMatrixRow[],
  columns: readonly PaperMatrixColumn[],
  cells: readonly PaperMatrixCell[],
): MatrixCoverageSummary {
  const gaps: CoverageGap[] = [];
  let reportedCells = 0;
  let notReportedCells = 0;

  for (const cell of cells) {
    if (cell.status === 'reported') {
      reportedCells += 1;
    } else {
      notReportedCells += 1;
      gaps.push({
        documentId: cell.documentId,
        dimensionId: cell.dimensionId,
        reason: cell.reason,
      });
    }
  }

  const totalCells = cells.length;
  const overallCoverageRate = totalCells > 0 ? roundRate(reportedCells / totalCells) : 0;

  const byDimension: DimensionCoverage[] = columns.map(col => {
    const reportedDocumentIds: string[] = [];
    const missingDocumentIds: string[] = [];
    for (const row of rows) {
      const cell = cells.find(c => c.documentId === row.documentId && c.dimensionId === col.dimensionId);
      if (cell && cell.status === 'reported') reportedDocumentIds.push(row.documentId);
      else missingDocumentIds.push(row.documentId);
    }
    const totalPapers = rows.length;
    return {
      dimensionId: col.dimensionId,
      label: col.label,
      reportedCount: reportedDocumentIds.length,
      notReportedCount: missingDocumentIds.length,
      totalPapers,
      coverageRate: totalPapers > 0 ? roundRate(reportedDocumentIds.length / totalPapers) : 0,
      reportedDocumentIds,
      missingDocumentIds,
    };
  });

  const byPaper: PaperCoverage[] = rows.map(row => {
    let reportedCount = 0;
    const missingDimensionIds: string[] = [];
    for (const col of columns) {
      const cell = cells.find(c => c.documentId === row.documentId && c.dimensionId === col.dimensionId);
      if (cell && cell.status === 'reported') reportedCount += 1;
      else missingDimensionIds.push(col.dimensionId);
    }
    const totalDimensions = columns.length;
    return {
      documentId: row.documentId,
      title: row.title,
      reportedCount,
      notReportedCount: missingDimensionIds.length,
      totalDimensions,
      coverageRate: totalDimensions > 0 ? roundRate(reportedCount / totalDimensions) : 0,
      missingDimensionIds,
    };
  });

  return {
    totalCells,
    reportedCells,
    notReportedCells,
    overallCoverageRate,
    gaps,
    byDimension,
    byPaper,
  };
}

function computeMetricDeltas(
  papers: readonly PreparedPaper[],
  axes: readonly PreparedAxis[],
  cells: readonly PaperMatrixCell[],
  catalog: readonly CompiledMetricAlias[],
  baselineDocumentId: string | undefined,
): MetricDeltaReport[] {
  const reports: MetricDeltaReport[] = [];
  const hasMetricsDimension = axes.some(axis => axis.id === 'metrics');

  if (hasMetricsDimension) {
    const metricOrder: string[] = [];
    const labelByKey = new Map<string, string>();
    for (const def of catalog) {
      labelByKey.set(def.metric.key, def.metric.label);
    }
    for (const paper of papers) {
      for (const key of paper.primaryMetrics.keys()) {
        if (!metricOrder.includes(key)) metricOrder.push(key);
      }
    }

    for (const metricKey of metricOrder) {
      const entries: MetricReadingEntry[] = [];
      const missingDocumentIds: string[] = [];
      for (const paper of papers) {
        const reading = paper.primaryMetrics.get(metricKey);
        if (reading !== undefined) {
          entries.push({
            documentId: paper.documentId,
            rawValue: reading.rawValue,
            numericValue: reading.numericValue,
            normalizedValue: reading.normalizedValue,
            unit: reading.unit,
            quote: reading.quote,
            provenance: reading.provenance,
          });
        } else {
          missingDocumentIds.push(paper.documentId);
        }
      }
      reports.push(
        buildMetricDeltaReport(
          metricKey,
          labelByKey.get(metricKey) ?? metricKey,
          entries,
          missingDocumentIds,
          baselineDocumentId,
        ),
      );
    }
  }

  // Also compute deltas for numeric custom axes (e.g., compute budget, memory, latency).
  for (const axis of axes) {
    if (axis.kind !== 'custom' || axis.valueKind !== 'number') continue;
    const entries: MetricReadingEntry[] = [];
    const missingDocumentIds: string[] = [];
    for (const paper of papers) {
      const cell = cells.find(
        c => c.documentId === paper.documentId && c.dimensionId === axis.id,
      );
      if (cell && cell.status === 'reported') {
        const parsed = parseFiniteNumber(cell.normalizedValue);
        entries.push({
          documentId: paper.documentId,
          rawValue: cell.normalizedValue,
          numericValue: parsed,
          normalizedValue: cell.normalizedValue,
          unit: axis.unit,
          quote: cell.quote,
          provenance: cell.provenance,
        });
      } else {
        missingDocumentIds.push(paper.documentId);
      }
    }
    if (entries.length > 0) {
      reports.push(
        buildMetricDeltaReport(axis.id, axis.label, entries, missingDocumentIds, baselineDocumentId),
      );
    }
  }

  return reports;
}

function buildMetricDeltaReport(
  metricKey: string,
  label: string,
  entries: readonly MetricReadingEntry[],
  missingDocumentIds: readonly string[],
  baselineDocumentId: string | undefined,
): MetricDeltaReport {
  const firstEntry = entries[0];
  if (entries.length < 2 || firstEntry === undefined) {
    return {
      metricKey,
      label,
      unit: firstEntry?.unit ?? '',
      status: 'abstained',
      abstainReason: 'single-witness',
      baselineDocumentId: firstEntry?.documentId ?? null,
      entries,
      missingDocumentIds,
      min: null,
      max: null,
      spread: null,
      pairwiseDeltas: [],
    };
  }

  if (entries.some(entry => entry.numericValue === null)) {
    return {
      metricKey,
      label,
      unit: firstEntry.unit,
      status: 'abstained',
      abstainReason: 'non-numeric',
      baselineDocumentId: firstEntry.documentId,
      entries,
      missingDocumentIds,
      min: null,
      max: null,
      spread: null,
      pairwiseDeltas: [],
    };
  }

  const units = new Set(entries.map(entry => entry.unit));
  if (units.size > 1) {
    return {
      metricKey,
      label,
      unit: '',
      status: 'abstained',
      abstainReason: 'unit-mismatch',
      baselineDocumentId: firstEntry.documentId,
      entries,
      missingDocumentIds,
      min: null,
      max: null,
      spread: null,
      pairwiseDeltas: [],
    };
  }

  const sharedUnit = firstEntry.unit;
  const baseline =
    (baselineDocumentId !== undefined
      ? entries.find(entry => entry.documentId === baselineDocumentId)
      : undefined) ?? firstEntry;

  let minEntry = firstEntry;
  let maxEntry = firstEntry;
  for (const entry of entries) {
    const val = entry.numericValue!;
    if (val < minEntry.numericValue!) minEntry = entry;
    if (val > maxEntry.numericValue!) maxEntry = entry;
  }

  const spread = roundNumeric(maxEntry.numericValue! - minEntry.numericValue!);
  const pairwiseDeltas: PairwiseMetricDelta[] = [];
  for (const entry of entries) {
    if (entry.documentId === baseline.documentId) continue;
    pairwiseDeltas.push({
      fromDocumentId: baseline.documentId,
      toDocumentId: entry.documentId,
      delta: roundNumeric(entry.numericValue! - baseline.numericValue!),
      unit: sharedUnit,
    });
  }

  return {
    metricKey,
    label,
    unit: sharedUnit,
    status: spread === 0 ? 'agree' : 'conflict',
    abstainReason: null,
    baselineDocumentId: baseline.documentId,
    entries,
    missingDocumentIds,
    min: { documentId: minEntry.documentId, numericValue: minEntry.numericValue! },
    max: { documentId: maxEntry.documentId, numericValue: maxEntry.numericValue! },
    spread,
    pairwiseDeltas,
  };
}

function computeDimensionDeltas(
  rows: readonly PaperMatrixRow[],
  columns: readonly PaperMatrixColumn[],
  cells: readonly PaperMatrixCell[],
): DimensionDeltaReport[] {
  return columns.map(col => {
    const reported: ReportedMatrixCell[] = [];
    const notReportedDocumentIds: string[] = [];

    for (const row of rows) {
      const cell = cells.find(c => c.documentId === row.documentId && c.dimensionId === col.dimensionId);
      if (cell && cell.status === 'reported') reported.push(cell);
      else notReportedDocumentIds.push(row.documentId);
    }

    const groups: DimensionReadingGroup[] = [];
    const byValue = new Map<string, DimensionReadingGroup>();
    for (const cell of reported) {
      const existing = byValue.get(cell.normalizedValue);
      if (existing) {
        (existing.cells as ReportedMatrixCell[]).push(cell);
      } else {
        const group: DimensionReadingGroup = { normalizedValue: cell.normalizedValue, cells: [cell] };
        byValue.set(cell.normalizedValue, group);
        groups.push(group);
      }
    }

    let status: 'agree' | 'differ' | 'abstained';
    let abstainReason: 'no-evidence' | 'single-witness' | null = null;
    if (reported.length === 0) {
      status = 'abstained';
      abstainReason = 'no-evidence';
    } else if (reported.length === 1) {
      status = 'abstained';
      abstainReason = 'single-witness';
    } else if (groups.length === 1) {
      status = 'agree';
    } else {
      status = 'differ';
    }

    return {
      dimensionId: col.dimensionId,
      label: col.label,
      status,
      abstainReason,
      reportedDocumentIds: reported.map(cell => cell.documentId),
      notReportedDocumentIds,
      distinctReadings: groups,
    };
  });
}

// --- Input preparation & section tracking ----------------------------------

function preparePapers(
  papers: readonly (PaperMatrixInput | DocumentIR)[] | undefined,
  minConfidence: number,
  catalog: readonly CompiledMetricAlias[],
): PreparedPaper[] {
  if (!Array.isArray(papers)) return [];
  const seen = new Set<string>();
  const prepared: PreparedPaper[] = [];

  for (const rawInput of papers) {
    if (!rawInput || typeof rawInput !== 'object') continue;
    const normalized = normalizePaperInput(rawInput);
    if (normalized === null || seen.has(normalized.documentId)) continue;
    seen.add(normalized.documentId);

    const blocks = orderedBlocks(normalized.ir);
    let currentSection = '';
    const sentences: PreparedSentence[] = [];
    let hasAnyRawText = false;

    for (const block of blocks) {
      const rawText = typeof block?.raw === 'string' ? block.raw : '';
      if (block.type === 'heading') {
        currentSection = collapseSpace(rawText);
        continue;
      }

      if (rawText.trim().length > 0) hasAnyRawText = true;
      const confidence = typeof block.confidence === 'number' && Number.isFinite(block.confidence)
        ? block.confidence
        : 1;
      if (confidence < minConfidence) continue;

      for (const slice of splitVerbatimSentences(rawText)) {
        const extractedMetrics = isExplicitNonReportedStub(slice)
          ? []
          : extractMetricsFromSentence(
              slice,
              normalized.documentId,
              pageOf(block),
              block.id,
              currentSection,
              catalog,
            );
        sentences.push({
          text: slice,
          section: currentSection,
          page: pageOf(block),
          blockId: block.id,
          block,
          extractedMetrics,
        });
      }
    }

    const allMetrics = sentences.flatMap(sentence => sentence.extractedMetrics);
    const { primaryMetrics, intraPaperMetricConflicts } = indexPaperMetrics(
      normalized.documentId,
      allMetrics,
    );

    prepared.push({
      documentId: normalized.documentId,
      title: normalized.title,
      year: normalized.year,
      ir: normalized.ir,
      sentences,
      hasSearchableBlocks: sentences.length > 0,
      hasAnyRawText,
      allMetrics,
      primaryMetrics,
      intraPaperMetricConflicts,
    });
  }

  return prepared;
}

function normalizePaperInput(
  input: PaperMatrixInput | DocumentIR,
): { documentId: string; title: string; year: number; ir: DocumentIR } | null {
  if (isDocumentIr(input)) {
    const documentId = typeof input.documentId === 'string' ? input.documentId.trim() : '';
    if (documentId.length === 0) return null;
    return { documentId, title: documentId, year: 0, ir: input };
  }

  if (!input.ir || typeof input.ir !== 'object') return null;
  const explicitId = typeof input.id === 'string' ? input.id.trim() : '';
  const irId = typeof input.ir.documentId === 'string' ? input.ir.documentId.trim() : '';
  const documentId = explicitId.length > 0 ? explicitId : irId;
  if (documentId.length === 0) return null;

  const rawTitle = typeof input.title === 'string' ? input.title.trim() : '';
  const title = rawTitle.length > 0 ? rawTitle : documentId;
  const year = typeof input.year === 'number' && Number.isFinite(input.year) ? Math.trunc(input.year) : 0;
  return { documentId, title, year, ir: input.ir };
}

function isDocumentIr(value: PaperMatrixInput | DocumentIR): value is DocumentIR {
  return 'schemaVersion' in value && 'blocks' in value && !('ir' in value);
}

function prepareAxes(options: BuildPaperMatrixOptions): PreparedAxis[] {
  const requested: (CanonicalDimensionId | MatrixAxis)[] = options.axes !== undefined
    ? [...options.axes]
    : [
        ...(options.dimensions ?? CANONICAL_DIMENSIONS),
        ...(options.customAxes ?? []),
      ];

  const seen = new Set<string>();
  const prepared: PreparedAxis[] = [];

  for (const item of requested) {
    if (typeof item === 'string') {
      const spec = CANONICAL_SPECS[item];
      if (!spec || seen.has(spec.id)) continue;
      seen.add(spec.id);
      prepared.push({
        id: spec.id,
        label: spec.label,
        kind: spec.id,
        valueKind: 'text',
        matchers: buildKeywordMatchers(spec.keywords),
        pattern: null,
        preferredSections: spec.preferredSections.map(foldText),
        unit: '',
      });
      continue;
    }

    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;

    const matchers = buildKeywordMatchers(item.keywords);
    const pattern = cloneScanner(item.pattern);
    if (matchers.length === 0 && pattern === null) continue;

    seen.add(id);
    const label = typeof item.label === 'string' && item.label.trim().length > 0 ? item.label.trim() : id;
    const kind: DimensionKind = item.kind ?? (isCanonicalId(id) ? id : 'custom');
    const valueKind: MatrixAspectKind =
      item.valueKind === 'number' || item.valueKind === 'date' || item.valueKind === 'text'
        ? item.valueKind
        : 'text';
    const preferredSections = Array.isArray(item.preferredSections)
      ? item.preferredSections.map(foldText).filter(s => s.length > 0)
      : [];

    prepared.push({
      id,
      label,
      kind,
      valueKind,
      matchers,
      pattern,
      preferredSections,
      unit: typeof item.unit === 'string' ? item.unit.trim() : '',
    });
  }

  return prepared;
}

function isCanonicalId(value: string): value is CanonicalDimensionId {
  return (CANONICAL_DIMENSIONS as readonly string[]).includes(value);
}

// --- Metric extraction -----------------------------------------------------

const NUMBER_PATTERN = '[-+\\u2212]?(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:[.,]\\d+)?)';
const UNIT_PATTERN = '(?:%|ms|seconds|sec|s|tokens\\/s|tok\\/s|samples\\/s|fps|req\\/s|GB|MB|KB)';
const CONNECTOR_PATTERN = '(?:[:=]|\\b(?:of|is|was|at|reaches|achieves|obtains|reports|gets|drops\\s+to)\\b)';

function compileMetricCatalog(extraMetrics?: readonly MetricDefinition[]): CompiledMetricAlias[] {
  const merged: MetricDefinition[] = [...DEFAULT_METRIC_DEFINITIONS];
  if (Array.isArray(extraMetrics)) {
    for (const def of extraMetrics) {
      if (def && typeof def.key === 'string' && def.key.trim().length > 0) {
        merged.push(def);
      }
    }
  }

  const compiled: CompiledMetricAlias[] = [];
  for (const metric of merged) {
    for (const alias of metric.aliases) {
      const entry = compileMetricAlias(metric, alias, false);
      if (entry !== null) compiled.push(entry);
    }
    for (const alias of metric.caseSensitiveAliases ?? []) {
      const entry = compileMetricAlias(metric, alias, true);
      if (entry !== null) compiled.push(entry);
    }
  }

  // Longer aliases win over shorter prefixes (e.g. `F1-score` before `F1`, `ROUGE-L` before `ROUGE`).
  compiled.sort((left, right) => right.alias.length - left.alias.length);
  return compiled;
}

function compileMetricAlias(
  metric: MetricDefinition,
  alias: string,
  caseSensitive: boolean,
): CompiledMetricAlias | null {
  const trimmed = alias.trim();
  if (trimmed.length === 0) return null;
  const escaped = escapePattern(trimmed).replace(/\s+/gu, '\\s+');
  const flags = caseSensitive ? 'gu' : 'giu';

  const beforePattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${NUMBER_PATTERN})\\s*(${UNIT_PATTERN})?\\s+(?:of\\s+)?${escaped}(?![\\p{L}\\p{N}-])`,
    flags,
  );
  const afterPattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?!-\\d)(?:\\s+score)?(?:\\s*${CONNECTOR_PATTERN}\\s*|\\s+)(${NUMBER_PATTERN})\\s*(${UNIT_PATTERN})?(?![\\p{L}\\p{N}])`,
    flags,
  );

  return { metric, alias: trimmed, caseSensitive, beforePattern, afterPattern };
}

interface Span {
  start: number;
  end: number;
}

function extractMetricsFromSentence(
  sentence: string,
  documentId: string,
  page: number,
  blockId: string,
  section: string,
  catalog: readonly CompiledMetricAlias[],
): ExtractedMetric[] {
  const found: Array<{ start: number; item: ExtractedMetric }> = [];
  const claimedSpans: Span[] = [];
  const preferredBonus = prefersSection(section, CANONICAL_SPECS.metrics.preferredSections)
    ? PAPER_PREFERRED_SECTION_BONUS
    : 0;

  for (const compiled of catalog) {
    for (const pattern of [compiled.beforePattern, compiled.afterPattern]) {
      pattern.lastIndex = 0;
      let match = pattern.exec(sentence);
      while (match !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (!overlapsAny(claimedSpans, start, end)) {
          const numText = match[1] ?? '';
          const rawUnit = match[2] ?? '';
          const normalized = normalizeExtractedNumber(numText);
          if (normalized !== null) {
            const numericValue = parseFiniteNumber(normalized);
            if (numericValue !== null) {
              claimedSpans.push({ start, end });
              const unit = normalizeUnit(rawUnit);
              found.push({
                start,
                item: {
                  metricKey: compiled.metric.key,
                  label: compiled.metric.label,
                  rawValue: rawUnit.length > 0 ? `${numText}${rawUnit === '%' ? '%' : ` ${rawUnit}`}` : numText,
                  numericValue,
                  normalizedValue: normalized,
                  unit,
                  quote: sentence,
                  provenance: { documentId, page, blockId, section },
                  score: PAPER_KEYWORD_HIT_WEIGHT * 2 + preferredBonus,
                },
              });
            }
          }
        }
        match = pattern.exec(sentence);
      }
    }
  }

  found.sort((left, right) => left.start - right.start);
  return found.map(entry => entry.item);
}

function indexPaperMetrics(
  documentId: string,
  allMetrics: readonly ExtractedMetric[],
): {
  primaryMetrics: Map<string, ExtractedMetric>;
  intraPaperMetricConflicts: IntraPaperMetricConflict[];
} {
  const byKey = new Map<string, ExtractedMetric[]>();
  for (const metric of allMetrics) {
    const list = byKey.get(metric.metricKey);
    if (list) list.push(metric);
    else byKey.set(metric.metricKey, [metric]);
  }

  const primaryMetrics = new Map<string, ExtractedMetric>();
  const intraPaperMetricConflicts: IntraPaperMetricConflict[] = [];

  for (const [metricKey, readings] of byKey) {
    const first = readings[0];
    if (first === undefined) continue;

    // Pick highest-scoring reading (preferred Results section beats Abstract; earliest wins ties).
    let best = first;
    for (const candidate of readings) {
      if (candidate.score > best.score) best = candidate;
    }
    primaryMetrics.set(metricKey, best);

    const distinctValues = new Set(readings.map(r => `${r.normalizedValue}|${r.unit}`));
    if (distinctValues.size > 1) {
      intraPaperMetricConflicts.push({
        documentId,
        metricKey,
        label: first.label,
        readings,
      });
    }
  }

  return { primaryMetrics, intraPaperMetricConflicts };
}

function overlapsAny(spans: readonly Span[], start: number, end: number): boolean {
  return spans.some(span => start < span.end && end > span.start);
}

function normalizeExtractedNumber(raw: string): string | null {
  const cleaned = raw.trim().replace(/\u2212/gu, '-').replace(/^\+/u, '');
  if (cleaned.length === 0) return null;

  const negative = cleaned.startsWith('-');
  let body = negative ? cleaned.slice(1) : cleaned;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(body)) {
    body = body.replace(/,/gu, '');
  } else {
    body = body.replace(/,/gu, '.');
  }
  if (!/^\d+(?:\.\d+)?$/u.test(body)) return null;

  const [intPart = '', fracPart = ''] = body.split('.');
  const canonicalInt = intPart.replace(/^0+(?=\d)/u, '');
  const canonicalFrac = fracPart.replace(/0+$/u, '');
  const magnitude = canonicalFrac.length > 0 ? `${canonicalInt}.${canonicalFrac}` : canonicalInt;
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude;
}

function normalizeUnit(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (trimmed === '%') return '%';
  const lower = trimmed.toLowerCase();
  if (lower === 'ms') return 'ms';
  if (lower === 's' || lower === 'sec' || lower === 'seconds') return 's';
  if (lower === 'tok/s' || lower === 'tokens/s') return 'tokens/s';
  if (lower === 'gb') return 'GB';
  if (lower === 'mb') return 'MB';
  if (lower === 'kb') return 'KB';
  return trimmed;
}

function parseFiniteNumber(text: string): number | null {
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

// --- Sentence splitting, matching & folding --------------------------------

const SENTENCE_BREAK = /[.!?…。！？]+(?=\s|$)|\n+/gu;

const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'al', 'approx', 'ca', 'cf', 'e.g', 'eq', 'eqs', 'fig', 'figs', 'i.e', 'no', 'ref', 'refs',
  'sec', 'tab', 'vs',
]);

const NON_REPORTED_STUB_PATTERN = new RegExp(
  '^(?:'
    + '(?:method|methodology|dataset|datasets|data|metrics?|limitations?|results?|evaluation)\\s*[:=-]\\s*'
    + ')?(?:'
    + 'none|n\\/a'
    + '|not\\s+(?:reported|applicable|available|measured|evaluated|discussed|provided|specified|disclosed)(?:\\s+in\\s+(?:this|the)\\s+(?:paper|work|study))?'
    + '|no\\s+(?:metrics?|datasets?|limitations?|results?)\\s+(?:were\\s+|are\\s+)?(?:reported|used|evaluated|discussed|available|provided|measured)'
    + ')\\.?$'
    + '|^(?:(?:method|methodology|dataset|datasets|data|metrics?|limitations?|results?|evaluation)\\s+(?:is|are|was|were)\\s+not\\s+(?:reported|discussed|provided|specified|evaluated|disclosed))\\.?$',
  'iu',
);

function isExplicitNonReportedStub(sentence: string): boolean {
  return NON_REPORTED_STUB_PATTERN.test(collapseSpace(sentence));
}

/**
 * Splits `raw` into verbatim sentences preserving exact inner characters so
 * `raw.includes(sentence)` always holds.
 */
function splitVerbatimSentences(raw: string): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const sentences: string[] = [];
  let start = 0;

  for (const match of raw.matchAll(SENTENCE_BREAK)) {
    const index = match.index ?? 0;
    const run = match[0];
    const end = index + run.length;
    const newline = run.startsWith('\n');
    if (!newline && isAbbreviationStop(run, raw, index, end)) continue;

    const slice = raw.slice(start, newline ? index : end).trim();
    if (slice.length > 0) sentences.push(slice);
    start = end;
  }

  const tail = raw.slice(start).trim();
  if (tail.length > 0) sentences.push(tail);
  return sentences;
}

function isAbbreviationStop(run: string, text: string, index: number, end: number): boolean {
  if (!/^\.+$/u.test(run)) return false;
  const word = /([\p{L}][\p{L}\p{M}.'’-]*)$/u.exec(text.slice(0, index))?.[1] ?? '';
  if (word.length === 0) return false;
  const token = word.toLowerCase().replace(/\.+$/u, '');
  if (token.length !== 1 && !ABBREVIATIONS.has(token)) return false;
  const next = text.slice(end).replace(/^\s+/u, '').charAt(0);
  return next.length > 0 && next === next.toLowerCase() && next !== next.toUpperCase();
}

const KEYWORD_SEPARATOR = '[\\s\\u00A0\\u202F\\u2009\\p{Pd}\\u2019\']*';

function buildKeywordMatchers(keywords: readonly string[] | undefined): RegExp[] {
  if (!Array.isArray(keywords)) return [];
  const matchers: RegExp[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    if (typeof keyword !== 'string') continue;
    const words = foldText(keyword).split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 0);
    if (words.length === 0) continue;
    const body = words.map(escapePattern).join(KEYWORD_SEPARATOR);
    try {
      const regex = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:s|es)?(?![\\p{L}\\p{N}])`, 'u');
      if (!seen.has(regex.source)) {
        seen.add(regex.source);
        matchers.push(regex);
      }
    } catch {
      // Ignore malformed keyword pattern.
    }
  }
  return matchers;
}

function countKeywordHits(foldedSentence: string, matchers: readonly RegExp[]): number {
  let hits = 0;
  for (const matcher of matchers) {
    if (matcher.test(foldedSentence)) hits += 1;
  }
  return hits;
}

function prefersSection(sectionName: string, preferredSections: readonly string[]): boolean {
  if (preferredSections.length === 0 || sectionName.length === 0) return false;
  const folded = foldText(sectionName);
  return preferredSections.some(word => folded.includes(word));
}

function cloneScanner(pattern: unknown): RegExp | null {
  if (!(pattern instanceof RegExp)) return null;
  const flags = pattern.flags.replace(/[gy]/gu, '');
  try {
    return new RegExp(pattern.source, flags);
  } catch {
    return null;
  }
}

function execRegex(pattern: RegExp, text: string): string | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  if (match === null || match[0].length === 0) return null;
  for (let index = 1; index < match.length; index += 1) {
    const group = match[index];
    if (typeof group === 'string' && group.length > 0) return group;
  }
  return match[0];
}

// --- Rendering & formatting helpers ----------------------------------------

function formatRenderedCell(cell: ReportedMatrixCell): string {
  const { documentId, page, blockId, section } = cell.provenance;
  const sectionLabel = section.length > 0 ? section : PAPER_MATRIX_UNNAMED_SECTION;
  return `“${cell.quote}” (${documentId}, p.${page}, ${blockId}, ${sectionLabel})`;
}

function markdownRow(fields: readonly string[]): string {
  return `| ${fields.map(markdownField).join(' | ')} |`;
}

function markdownField(value: string): string {
  return value.replace(/\r\n|\r|\n/gu, '<br>').replace(/\|/gu, '\\|');
}

function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(',');
}

function csvField(value: string): string {
  const needsQuotes = /[",\r\n]/u.test(value) || /^\s|\s$/u.test(value);
  return needsQuotes ? `"${value.replace(/"/gu, '""')}"` : value;
}

function indexCells(cells: readonly PaperMatrixCell[]): Map<string, PaperMatrixCell> {
  const map = new Map<string, PaperMatrixCell>();
  for (const cell of cells) {
    const key = pairKey(cell.documentId, cell.dimensionId);
    if (!map.has(key)) map.set(key, cell);
  }
  return map;
}

function pairKey(documentId: string, dimensionId: string): string {
  return `${documentId}\u0000${dimensionId}`;
}

// --- Small deterministic helpers -------------------------------------------

function orderedBlocks(ir: DocumentIR): Block[] {
  const blocks = Array.isArray(ir?.blocks) ? ir.blocks : [];
  return [...blocks].sort((left, right) => {
    const leftOrder = Number.isFinite(left?.readingOrder) ? left.readingOrder : 0;
    const rightOrder = Number.isFinite(right?.readingOrder) ? right.readingOrder : 0;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    const leftId = typeof left?.id === 'string' ? left.id : '';
    const rightId = typeof right?.id === 'string' ? right.id : '';
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

function countNonHeadingTextBlocks(blocks: readonly Block[]): number {
  let count = 0;
  for (const block of blocks) {
    if (block.type !== 'heading' && typeof block.raw === 'string' && block.raw.trim().length > 0) {
      count += 1;
    }
  }
  return count;
}

function pageOf(block: Block): number {
  return Number.isInteger(block?.page) && block.page >= 1 ? block.page : 1;
}

function clampConfidence(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function roundNumeric(value: number): number {
  return Number(value.toFixed(6));
}

function roundRate(value: number): number {
  return Number(value.toFixed(4));
}

const COMBINING_MARKS = /\p{M}+/gu;
const EDGE_PUNCTUATION = /^[\s.,;:!?\u2026'"“”‘’()[\]{}]+|[\s.,;:!?\u2026'"“”‘’()[\]{}]+$/gu;

function foldText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/đ/gu, 'd');
}

function normalizeQuoteKey(value: string): string {
  const folded = collapseSpace(foldText(value));
  if (folded.length === 0) return '';
  const trimmed = folded.replace(EDGE_PUNCTUATION, '');
  return trimmed.length > 0 ? trimmed : folded;
}

function collapseSpace(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
