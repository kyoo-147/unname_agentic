import { describe, expect, it } from 'vitest';
import {
  PAPER_GAP_MARKER,
  PAPER_UNNAMED_SECTION,
  comparePapers,
  summarise,
  toMarkdown,
  type Paper,
  type PaperAspect,
  type PaperAspectKind,
  type PaperAspectSummary,
  type PaperCell,
  type PaperGap,
  type PaperMatrix,
} from '../viewer/src/core/paper-compare';

/** Builds a paper from `[name, text]` section tuples, so fixtures read like the source. */
function paper(
  id: string,
  title: string,
  year: number,
  sections: ReadonlyArray<readonly [string, string]>,
): Paper {
  return { id, title, year, sections: sections.map(([name, text]) => ({ name, text })) };
}

const METHODOLOGY: PaperAspect = {
  id: 'methodology',
  label: 'Methodology',
  kind: 'methodology',
  keywords: ['method', 'approach'],
};

const DATASET: PaperAspect = {
  id: 'dataset',
  label: 'Dataset',
  kind: 'dataset',
  keywords: ['dataset'],
};

const METRIC: PaperAspect = {
  id: 'metric',
  label: 'Metric',
  kind: 'metric',
  keywords: ['exact match', 'F1', 'accuracy'],
};

const ASPECTS: readonly PaperAspect[] = [METHODOLOGY, DATASET, METRIC];

/** A paper whose abstract also names the methodology, so the section preference has to decide. */
const SPANS: Paper = paper('p1', 'Span extraction for reading', 2023, [
  [
    'Abstract',
    'We introduce a framework for open-domain question answering. Our approach is evaluated on three public benchmarks.',
  ],
  ['Method', 'The proposed method trains a span extractor on the SQuAD training split and aggregates scores across paragraphs.'],
  ['Data', 'We evaluate on the SQuAD dataset, which contains 100,000 question–answer pairs.'],
  ['Results', 'Our system reaches 87.1 exact match on the development set.'],
]);

/** A second paper, disagreeing on the dataset and on the metric but not on the method. */
const DENSE: Paper = paper('p2', 'Dense retrieval with dual encoders', 2024, [
  ['Abstract', 'Dense retrieval improves recall over sparse baselines.'],
  ['Method', 'Our method trains a dual encoder with a contrastive objective.'],
  ['Data', 'We evaluate on the CoNLL-2003 dataset.'],
  ['Results', 'The model reaches 55.3 exact match.'],
]);

/** A paper with no sections at all: every column must be a gap, never a refusal. */
const BARE: Paper = paper('p3', 'A survey without sections', 2020, []);

/** A paper with text that never names any of the three aspects. */
const POSITION: Paper = paper('p4', 'Position paper on evaluation', 2021, [
  ['Introduction', 'We argue that evaluation practice needs to change.'],
  ['Discussion', 'Our position is that benchmarks age badly.'],
]);

const PAPERS: readonly Paper[] = [SPANS, DENSE, BARE, POSITION];

function cellOf(matrix: PaperMatrix, paperId: string, aspectId: string): PaperCell | undefined {
  return matrix.cells.find(cell => cell.paperId === paperId && cell.aspectId === aspectId);
}

function gapOf(matrix: PaperMatrix, paperId: string, aspectId: string): PaperGap | undefined {
  return matrix.gaps.find(gap => gap.paperId === paperId && gap.aspectId === aspectId);
}

function summaryOf(matrix: PaperMatrix, aspectId: string): PaperAspectSummary | undefined {
  return summarise(matrix).aspects.find(entry => entry.aspectId === aspectId);
}

describe('comparePapers', () => {
  it('keeps papers as rows and aspects as columns, in input order', () => {
    const matrix = comparePapers(PAPERS, ASPECTS);

    expect(matrix.refusal).toBeNull();
    expect(matrix.rows.map(row => row.paperId)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(matrix.rows.map(row => row.year)).toEqual([2023, 2024, 2020, 2021]);
    expect(matrix.aspects).toEqual([
      { aspectId: 'methodology', label: 'Methodology', kind: 'methodology' },
      { aspectId: 'dataset', label: 'Dataset', kind: 'dataset' },
      { aspectId: 'metric', label: 'Metric', kind: 'metric' },
    ]);
  });

  it('takes the method cell from the method section, not from the abstract', () => {
    const cell = cellOf(comparePapers(PAPERS, ASPECTS), 'p1', 'methodology');

    // The abstract does name the methodology ("Our approach is evaluated..."), so the cell is
    // only from "Method" because the preferred-section bonus tipped the score.
    expect(SPANS.sections[0]?.text).toContain('Our approach is evaluated');
    expect(cell?.text).toContain('span extractor');
    expect(cell?.section).toBe('Method');
    // One keyword hit (2) plus the preferred-section bonus (1).
    expect(cell?.score).toBe(3);
  });

  it('carries the dataset name in the dataset cell', () => {
    const cell = cellOf(comparePapers(PAPERS, ASPECTS), 'p1', 'dataset');

    expect(cell?.text).toContain('SQuAD');
    expect(cell?.text).toContain('100,000 question–answer pairs');
    expect(cell?.section).toBe('Data');
    expect(cell?.score).toBe(3);
  });

  it('reports a gap when a paper never mentions the aspect', () => {
    const matrix = comparePapers(PAPERS, ASPECTS);

    expect(gapOf(matrix, 'p4', 'metric')).toEqual({
      paperId: 'p4',
      aspectId: 'metric',
      reason: 'no-match',
    });
    expect(cellOf(matrix, 'p4', 'metric')).toBeUndefined();
    // "evaluation" is a section-preference word, not a metric keyword: it must not match.
    expect(POSITION.sections[0]?.text).toContain('evaluation');
  });

  it('produces gaps only for a paper with no sections', () => {
    const matrix = comparePapers(PAPERS, ASPECTS);

    expect(matrix.cells.filter(cell => cell.paperId === 'p3')).toEqual([]);
    expect(matrix.gaps.filter(gap => gap.paperId === 'p3')).toEqual([
      { paperId: 'p3', aspectId: 'methodology', reason: 'no-sections' },
      { paperId: 'p3', aspectId: 'dataset', reason: 'no-sections' },
      { paperId: 'p3', aspectId: 'metric', reason: 'no-sections' },
    ]);
    expect(matrix.refusal).toBeNull();
    expect(matrix.rows).toHaveLength(4);
  });

  it('treats declared sections with no text as nothing to search', () => {
    const blank = paper('blank', 'Blank sections', 2022, [
      ['Method', '   '],
      ['Data', ''],
    ]);
    const matrix = comparePapers([blank], [DATASET]);

    expect(matrix.cells).toEqual([]);
    expect(matrix.gaps).toEqual([{ paperId: 'blank', aspectId: 'dataset', reason: 'no-sections' }]);
  });

  it('lets keyword hits outweigh the section preference, so the bonus only breaks ties', () => {
    const rich = paper('rich', 'Two keywords in the abstract', 2022, [
      ['Abstract', 'Our method and approach are new.'],
      ['Method', 'Our method is short.'],
    ]);
    const matrix = comparePapers([rich], [METHODOLOGY]);
    const cell = cellOf(matrix, 'rich', 'methodology');

    expect(cell?.section).toBe('Abstract');
    expect(cell?.text).toBe('Our method and approach are new.');
    // Two distinct keywords (2 + 2) beat one keyword plus the section bonus (2 + 1).
    expect(cell?.score).toBe(4);
  });

  it('matches whole words, allowing a plural but never a longer word', () => {
    const plurals = paper('plural', 'Plurals', 2022, [
      ['Data', 'We use two datasets and a database.'],
    ]);

    // "dataset" finds "datasets" through the documented plural, and nothing else.
    const singular = comparePapers([plurals], [{ ...DATASET, keywords: ['dataset'] }]);
    expect(cellOf(singular, 'plural', 'dataset')?.text).toBe('We use two datasets and a database.');

    // A bare "data" is a different word: it matches neither "datasets" nor "database".
    const bare = comparePapers([plurals], [{ ...DATASET, keywords: ['data'] }]);
    expect(bare.cells).toEqual([]);
    expect(bare.gaps).toEqual([{ paperId: 'plural', aspectId: 'dataset', reason: 'no-match' }]);
  });

  it('matches a multi-word keyword across the separators a paper may use', () => {
    const hyphenated = paper('pre', 'Pretraining', 2022, [
      ['Method', 'We start from a pretrained encoder.'],
      ['Results', 'We report 91.2 exact-match accuracy on the test split.'],
    ]);
    const matrix = comparePapers([hyphenated], [
      { ...METHODOLOGY, keywords: ['pre-trained'] },
      METRIC,
    ]);

    expect(cellOf(matrix, 'pre', 'methodology')?.text).toBe('We start from a pretrained encoder.');
    expect(cellOf(matrix, 'pre', 'metric')?.text).toBe('We report 91.2 exact-match accuracy on the test split.');
  });

  it('drops duplicate ids and unusable aspects instead of inventing columns', () => {
    const duplicated = comparePapers([SPANS, { ...DENSE, id: 'p1' }], ASPECTS);
    expect(duplicated.rows.map(row => row.paperId)).toEqual(['p1']);

    const noKeywords = comparePapers([SPANS], [{ ...DATASET, id: 'blank', keywords: [] }]);
    expect(noKeywords.refusal).toBe('no-aspects');
    expect(noKeywords.aspects).toEqual([]);

    const duplicatedAspects = comparePapers([SPANS], [DATASET, { ...METRIC, id: 'dataset' }]);
    expect(duplicatedAspects.aspects.map(aspect => aspect.aspectId)).toEqual(['dataset']);
  });

  it('refuses a comparison that cannot be made', () => {
    expect(comparePapers([], ASPECTS)).toEqual({
      rows: [],
      aspects: [],
      cells: [],
      gaps: [],
      refusal: 'no-papers',
    });
    expect(comparePapers(PAPERS, []).refusal).toBe('no-aspects');
    expect(toMarkdown(comparePapers(PAPERS, []))).toBe('');
    expect(summarise(comparePapers([], ASPECTS))).toEqual({ aspects: [] });
  });

  it('takes the section preference from the aspect kind, not from the section name', () => {
    const named = paper('named', 'Unrecognised kind', 2022, [['Method', 'Our method is short.']]);
    const matrix = comparePapers([named], [
      { id: 'unknown', label: 'Unknown', keywords: ['method'], kind: 'not-a-kind' as PaperAspectKind },
    ]);

    expect(matrix.aspects).toEqual([{ aspectId: 'unknown', label: 'Unknown', kind: 'other' }]);
    // The sentence sits in a "Method" section, but an `other` aspect prefers no section, so it
    // scores the keyword alone: the bonus follows the kind, never the heading.
    expect(cellOf(matrix, 'named', 'unknown')?.score).toBe(2);
  });

  it('keeps a cell whose section carries no name and labels it when rendering', () => {
    const unnamed = paper('unnamed', 'Unnamed section', 2022, [['', 'We evaluate on the SQuAD dataset.']]);
    const matrix = comparePapers([unnamed], [DATASET]);

    expect(cellOf(matrix, 'unnamed', 'dataset')?.section).toBe('');
    expect(toMarkdown(matrix)).toContain(`“We evaluate on the SQuAD dataset.” — ${PAPER_UNNAMED_SECTION}`);
  });

  it('is pure: equal inputs give equal matrices and no input is mutated', () => {
    const before = JSON.stringify({ PAPERS, ASPECTS });
    const first = comparePapers(PAPERS, ASPECTS);
    const second = comparePapers(PAPERS, ASPECTS);

    expect(first).toEqual(second);
    expect(JSON.stringify({ PAPERS, ASPECTS })).toBe(before);
    expect(first).not.toBe(second);
  });
});

describe('summarise', () => {
  const SAME: readonly Paper[] = [
    paper('a', 'Alpha', 2020, [['Data', 'We evaluate on the SQuAD dataset.']]),
    paper('b', 'Beta', 2021, [['Data', 'We evaluate on the SQuAD dataset.']]),
  ];

  it('builds a consensus sentence from cells that quote the same wording', () => {
    const matrix = comparePapers(SAME, [DATASET]);
    const summary = summaryOf(matrix, 'dataset');

    expect(summary?.quotedPapers).toEqual(['Alpha', 'Beta']);
    expect(summary?.unmentioned).toEqual([]);
    expect(summary?.divergence).toBeNull();
    expect(summary?.consensus).toContain('agree');
    expect(summary?.consensus).toContain('“We evaluate on the SQuAD dataset.”');
    expect(summary?.consensus).toContain('Alpha');
    expect(summary?.consensus).toContain('Beta');
  });

  it('names the papers that stay silent instead of counting them as agreement', () => {
    const matrix = comparePapers([...SAME, BARE], [DATASET]);
    const summary = summaryOf(matrix, 'dataset');

    expect(summary?.consensus).toContain('2 of 3 papers agree');
    expect(summary?.consensus).toContain('not mentioned by A survey without sections');
    expect(summary?.unmentioned).toEqual(['A survey without sections']);
  });

  it('builds a divergence sentence from the two differing quotes', () => {
    const matrix = comparePapers(PAPERS, ASPECTS);
    const summary = summaryOf(matrix, 'dataset');

    expect(summary?.consensus).toBeNull();
    expect(summary?.divergence).toContain('Papers disagree on Dataset');
    expect(summary?.divergence).toContain('“We evaluate on the SQuAD dataset, which contains 100,000 question–answer pairs.”');
    expect(summary?.divergence).toContain('“We evaluate on the CoNLL-2003 dataset.”');
    expect(summary?.divergence).toContain('Span extraction for reading');
    expect(summary?.divergence).toContain('Dense retrieval with dual encoders');
    // The papers without a cell are named, not treated as one side of the disagreement.
    expect(summary?.divergence).toContain('not mentioned by A survey without sections, Position paper on evaluation');
  });

  it('calls one witness neither agreement nor disagreement', () => {
    const summary = summaryOf(comparePapers([SPANS], [METHODOLOGY]), 'methodology');

    expect(summary?.quotedPapers).toEqual(['Span extraction for reading']);
    expect(summary?.consensus).toBeNull();
    expect(summary?.divergence).toBeNull();
  });

  it('reports every aspect, including the ones no paper states', () => {
    const matrix = comparePapers(PAPERS, ASPECTS);
    const summary = summarise(matrix);

    expect(summary.aspects.map(entry => entry.aspectId)).toEqual(['methodology', 'dataset', 'metric']);
    const methodology = summary.aspects[0];
    expect(methodology?.divergence).toContain('Papers disagree on Methodology');
    const metric = summary.aspects[2];
    expect(metric?.quotedPapers).toEqual(['Span extraction for reading', 'Dense retrieval with dual encoders']);
    expect(metric?.divergence).toContain('87.1 exact match');
    expect(metric?.divergence).toContain('55.3 exact match');
  });
});

describe('toMarkdown', () => {
  it('writes the quote and its section in every cell', () => {
    const markdown = toMarkdown(comparePapers(PAPERS, ASPECTS));
    const lines = markdown.split('\n');

    expect(lines[0]).toBe('| Paper | Year | Methodology | Dataset | Metric |');
    expect(lines[1]).toBe('| --- | --- | --- | --- | --- |');
    expect(lines).toHaveLength(6);
    expect(markdown).toContain('| Span extraction for reading | 2023 |');
    expect(markdown).toContain('“The proposed method trains a span extractor on the SQuAD training split and aggregates scores across paragraphs.” — Method');
    expect(markdown).toContain('“We evaluate on the CoNLL-2003 dataset.” — Data');
    expect(markdown).toContain('“Our system reaches 87.1 exact match on the development set.” — Results');
  });

  it('renders a gap as a marker instead of an empty cell', () => {
    const markdown = toMarkdown(comparePapers(PAPERS, ASPECTS));
    const bare = markdown.split('\n')[4] ?? '';

    expect(markdown).toContain(PAPER_GAP_MARKER);
    expect(bare).toBe(`| A survey without sections | 2020 | ${PAPER_GAP_MARKER} | ${PAPER_GAP_MARKER} | ${PAPER_GAP_MARKER} |`);
  });

  it('escapes a pipe so a quote cannot end its row early', () => {
    const piped = paper('pipe', 'Pipes', 2020, [['Metric', 'The metric is exact match | F1.']]);
    const markdown = toMarkdown(comparePapers([piped], [METRIC]));

    expect(markdown).toContain('exact match \\| F1');
    expect(markdown.split('\n')).toHaveLength(3);
  });

  it('writes nothing for a matrix that was refused', () => {
    expect(toMarkdown(comparePapers([], ASPECTS))).toBe('');
    expect(toMarkdown(comparePapers(PAPERS, []))).toBe('');
  });
});
