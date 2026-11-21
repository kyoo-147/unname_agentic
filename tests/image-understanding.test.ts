import { describe, expect, it } from 'vitest';
import {
  MAX_READABLE_BLUR_SCORE,
  MIN_READABLE_CONTRAST,
  MIN_READABLE_DPI,
  MIN_READABLE_LONG_EDGE_PX,
  MIN_READABLE_OCR_CONFIDENCE,
  MIN_READABLE_SHORT_EDGE_PX,
  VISUAL_REGION_KINDS,
  analyzeFlowchartTopology,
  assessVisualReadability,
  bindVisualCaption,
  classifyVisualRegion,
  planVisualUnderstanding,
  toVisionKind,
  understandVisualRegion,
  understandVisualRegions,
  verifyVisualGrounding,
  type VisualRegionInput,
} from '../src/core/image-understanding';
import type { CaptionInputBlock } from '../src/core/captions';
import type { Rect } from '../src/core/types';

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function baseRegion(overrides: Partial<VisualRegionInput> = {}): VisualRegionInput {
  return {
    imageId: 'img-p1-0',
    page: 1,
    bbox: rect(60, 120, 400, 260),
    pageHeight: 792,
    widthPx: 800,
    heightPx: 520,
    dpi: 144,
    ...overrides,
  };
}

function captionBlock(id: string, box: Rect, text: string, page = 1): CaptionInputBlock {
  return { id, type: 'caption', page, text, rect: box, pageHeight: 792 };
}

describe('classifyVisualRegion', () => {
  it('recognises all six F12 visual region kinds from text and structural cues', () => {
    expect(VISUAL_REGION_KINDS).toEqual([
      'chart',
      'diagram',
      'flowchart',
      'technical-drawing',
      'table-image',
      'photo',
    ]);

    const chart = classifyVisualRegion(
      baseRegion({
        caption: 'Figure 1. Quarterly revenue bar chart.',
        cues: { hasAxes: true, hasLegend: true, tickCount: 5, seriesCount: 2 },
        labels: ['Q1', 'Q2', '0', '50', '100'],
      }),
    );
    expect(chart.kind).toBe('chart');
    expect(chart.confidence).toBeGreaterThan(0.6);
    expect(toVisionKind(chart.kind)).toBe('chart');

    const flowchart = classifyVisualRegion(
      baseRegion({
        caption: 'Figure 2. Request authentication flowchart.',
        cues: { hasDecisionDiamond: true, arrowCount: 4, nodeBoxCount: 4 },
        labels: ['Start', 'Authenticated?', 'Yes', 'No'],
      }),
    );
    expect(flowchart.kind).toBe('flowchart');
    expect(toVisionKind(flowchart.kind)).toBe('figure');

    const diagram = classifyVisualRegion(
      baseRegion({
        caption: 'Figure 3. Microservice architecture block diagram.',
        cues: { nodeBoxCount: 4, arrowCount: 3 },
        labels: ['Gateway', 'Auth Service', 'Storage'],
      }),
    );
    expect(diagram.kind).toBe('diagram');
    expect(toVisionKind(diagram.kind)).toBe('figure');

    const technical = classifyVisualRegion(
      baseRegion({
        caption: 'Figure 4. Drive shaft cross-section schematic (scale 1:2).',
        cues: { hasDimensionLines: true, hasCallouts: true },
        labels: ['Ø 24 mm', '±0.05 mm', 'R 4.0 mm'],
      }),
    );
    expect(technical.kind).toBe('technical-drawing');
    expect(toVisionKind(technical.kind)).toBe('figure');

    const tableImage = classifyVisualRegion(
      baseRegion({
        caption: 'Table 1. Rasterized benchmark latency comparison.',
        cues: { hasGridCells: true, rowCount: 4, colCount: 3 },
        labels: ['Model', 'p50', 'p95'],
      }),
    );
    expect(tableImage.kind).toBe('table-image');
    expect(toVisionKind(tableImage.kind)).toBe('figure');

    const photo = classifyVisualRegion(
      baseRegion({
        caption: 'Figure 5. SEM micrograph of fractured ceramic specimen.',
        cues: { isPhotographic: true, strokeCount: 0 },
        labels: ['50 µm'],
      }),
    );
    expect(photo.kind).toBe('photo');
    expect(toVisionKind(photo.kind)).toBe('figure');
  });

  it('prefers flowchart over generic diagram when decision diamonds or workflow markers are present', () => {
    const result = classifyVisualRegion(
      baseRegion({
        caption: 'Figure 2. Deployment workflow diagram.',
        cues: { hasDecisionDiamond: true, nodeBoxCount: 5, arrowCount: 6 },
      }),
    );
    expect(result.kind).toBe('flowchart');
    expect(result.reasons).toContain('cue=decision-diamond');
  });
});

describe('structured extraction and source-image / caption binding', () => {
  it('extracts chart axes, series, and labels while binding sourceImageId, bbox, and captionBlockId', () => {
    const region = baseRegion({
      imageId: 'img-chart-1',
      page: 2,
      bbox: rect(70, 100, 380, 220),
      labels: [
        { text: 'Quarter', role: 'axis-label' },
        { text: 'USD (k)', role: 'axis-label' },
        { text: '120', role: 'data-label' },
        { text: '185', role: 'data-label' },
      ],
    });
    const blocks: CaptionInputBlock[] = [
      captionBlock('cap-fig-2', rect(70, 332, 380, 16), 'Figure 1. Quarterly operating revenue.', 2),
      // Across the horizontal column boundary: must never bind to the left-column figure.
      captionBlock('cap-wrong-col', rect(480, 332, 100, 16), 'Figure 2. Unrelated right column.', 2),
    ];

    const result = understandVisualRegion(
      region,
      {
        description: 'Revenue rises from 120 USD in Q1 to 185 USD in Q2.',
        axes: [
          { id: 'x', orientation: 'x', label: 'Quarter', scale: 'categorical', ticks: ['Q1', 'Q2'] },
          { id: 'y', orientation: 'y', label: 'Revenue', unit: 'USD', scale: 'linear', ticks: [0, 100, 200] },
        ],
        series: [
          {
            id: 'rev',
            name: 'Revenue',
            unit: 'USD',
            axisId: 'y',
            points: [
              { x: 'Q1', y: 120 },
              { x: 'Q2', y: 185 },
            ],
            trend: 'increasing',
          },
        ],
        confidence: 0.91,
      },
      { blocks, context: { title: 'Annual Report', language: 'en' } },
    );

    expect(result.status).toBe('understood');
    expect(result.abstained).toBe(false);
    expect(result.sourceImageId).toBe('img-chart-1');
    expect(result.page).toBe(2);
    expect(result.bbox).toEqual(rect(70, 100, 380, 220));
    expect(result.captionBlockId).toBe('cap-fig-2');
    expect(result.captionText).toBe('Figure 1. Quarterly operating revenue.');
    expect(result.kind).toBe('chart');
    expect(result.axes).toHaveLength(2);
    expect(result.axes[1]?.range).toEqual({ min: 0, max: 200 });
    expect(result.series[0]?.points).toEqual([
      { x: 'Q1', y: 120, illegible: false, grounded: true },
      { x: 'Q2', y: 185, illegible: false, grounded: true },
    ]);
    expect(result.labels.map(label => label.text)).toEqual(['Quarter', 'USD (k)', '120', '185']);
    expect(result.grounding.passed).toBe(true);
    expect(result.visionRequest?.prompt).toContain('Annual Report');
  });

  it('extracts flowchart nodes and edges and computes topology with branch and cycle awareness', () => {
    const region = baseRegion({
      imageId: 'img-flow-1',
      cues: { hasDecisionDiamond: true, nodeBoxCount: 4, arrowCount: 4 },
      labels: ['Start', 'Valid?', 'Save', 'Retry'],
    });
    const blocks: CaptionInputBlock[] = [
      captionBlock('cap-flow', rect(60, 390, 400, 16), 'Figure 1. Validation workflow.'),
    ];

    const result = understandVisualRegion(
      region,
      {
        description: 'Input starts validation, saves when valid, or retries when invalid.',
        nodes: [
          { id: 'n1', label: 'Start', kind: 'start' },
          { id: 'n2', label: 'Valid?', kind: 'decision' },
          { id: 'n3', label: 'Save', kind: 'end' },
          { id: 'n4', label: 'Retry', kind: 'process' },
        ],
        edges: [
          { from: 'n1', to: 'n2' },
          { from: 'n2', to: 'n3', label: 'yes', condition: 'valid == true' },
          { from: 'n2', to: 'n4', label: 'no', condition: 'valid == false' },
          { from: 'n4', to: 'n2', label: 'recheck' },
        ],
      },
      { blocks },
    );

    expect(result.kind).toBe('flowchart');
    expect(result.captionBlockId).toBe('cap-flow');
    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(4);
    expect(result.topology).not.toBeNull();
    expect(result.topology?.entryNodeIds).toEqual(['n1']);
    expect(result.topology?.terminalNodeIds).toEqual(['n3']);
    expect(result.topology?.decisionNodeIds).toEqual(['n2']);
    expect(result.topology?.hasCycles).toBe(true);
    expect(result.topology?.backEdges).toHaveLength(1);
    expect(result.topology?.backEdges[0]).toMatchObject({ from: 'n4', to: 'n2' });
  });

  it('binds a table-image to a caption positioned above the table', () => {
    const region = baseRegion({
      imageId: 'img-tbl-1',
      bbox: rect(60, 200, 400, 180),
      cues: { hasGridCells: true, rowCount: 3, colCount: 3 },
      labels: [
        { text: 'Metric', role: 'header' },
        { text: '98.4%', role: 'cell' },
      ],
    });
    const binding = bindVisualCaption(region, [
      captionBlock('cap-tbl-above', rect(60, 174, 400, 14), 'Table 1. Accuracy results.'),
    ]);

    expect(binding.sourceImageId).toBe('img-tbl-1');
    expect(binding.captionBlockId).toBe('cap-tbl-above');
    expect(binding.captionText).toBe('Table 1. Accuracy results.');
    expect(binding.confidence).toBeGreaterThan(0.85);
  });

  it('does not bind a caption from another page or outside the horizontal column band', () => {
    const region = baseRegion({ imageId: 'img-isolated', page: 1, bbox: rect(60, 120, 200, 180) });
    const binding = bindVisualCaption(region, [
      captionBlock('cap-other-page', rect(60, 310, 200, 14), 'Figure 1. Wrong page.', 2),
      captionBlock('cap-other-col', rect(320, 310, 220, 14), 'Figure 1. Right column.', 1),
    ]);

    expect(binding.captionBlockId).toBeNull();
    expect(binding.captionText).toBeNull();
  });
});

describe('low-resolution and illegible abstention', () => {
  it('abstains when pixel dimensions are below the readable edge thresholds', () => {
    const lowRes = baseRegion({
      imageId: 'img-tiny',
      widthPx: MIN_READABLE_LONG_EDGE_PX - 20,
      heightPx: MIN_READABLE_SHORT_EDGE_PX - 12,
    });
    const blocks: CaptionInputBlock[] = [
      captionBlock('cap-tiny', rect(60, 390, 400, 14), 'Figure 1. Tiny thumbnail.'),
    ];

    const readability = assessVisualReadability(lowRes);
    expect(readability.readable).toBe(false);
    expect(readability.reasons).toContain('low-resolution');

    const result = understandVisualRegion(
      lowRes,
      {
        description: 'Revenue was 500 USD.',
        axes: [{ orientation: 'y', ticks: [0, 500] }],
        series: [{ name: 'Revenue', points: [{ x: 'Q1', y: 500 }] }],
      },
      { blocks },
    );

    expect(result.status).toBe('abstain');
    expect(result.abstained).toBe(true);
    expect(result.abstentionReasons).toContain('low-resolution');
    // Source binding and caption are preserved even when content abstains.
    expect(result.sourceImageId).toBe('img-tiny');
    expect(result.bbox).toEqual(lowRes.bbox);
    expect(result.captionBlockId).toBe('cap-tiny');
    // Nothing fabricated leaks into structured output.
    expect(result.description).toBeNull();
    expect(result.axes).toEqual([]);
    expect(result.series).toEqual([]);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.labels).toEqual([]);
  });

  it('abstains on low DPI, low contrast, high blur, low OCR confidence, or explicit illegibility', () => {
    expect(
      understandVisualRegion(baseRegion({ dpi: MIN_READABLE_DPI - 20 }), { description: 'Chart' }).abstentionReasons,
    ).toContain('low-dpi');

    expect(
      understandVisualRegion(
        baseRegion({ quality: { contrast: MIN_READABLE_CONTRAST - 3 } }),
        { description: 'Chart' },
      ).abstentionReasons,
    ).toContain('low-contrast');

    expect(
      understandVisualRegion(
        baseRegion({ quality: { blurScore: 0.85 } }),
        { description: 'Chart' },
      ).abstentionReasons,
    ).toContain('blurry-image');

    expect(
      understandVisualRegion(
        baseRegion({ quality: { ocrConfidence: MIN_READABLE_OCR_CONFIDENCE - 0.1 } }),
        { description: 'Chart' },
      ).abstentionReasons,
    ).toContain('low-ocr-confidence');

    expect(
      understandVisualRegion(
        baseRegion({ quality: { legible: false } }),
        { description: 'Chart' },
      ).abstentionReasons,
    ).toContain('illegible-content');
  });

  it('abstains instead of crashing when given a zero-area bounding box or illegible/empty vision answer', () => {
    const zeroArea = baseRegion({ bbox: rect(10, 10, 0, 100), widthPx: 400, heightPx: 300 });
    const plan = planVisualUnderstanding(zeroArea);
    expect(plan.abstained).toBe(true);
    expect(plan.abstentionReasons).toContain('invalid-region');
    expect(plan.visionRequest).toBeNull();

    const emptyAns = understandVisualRegion(baseRegion(), '   \n  ');
    expect(emptyAns.status).toBe('abstain');
    expect(emptyAns.abstained).toBe(true);
    expect(emptyAns.abstentionReasons).toContain('empty-vision-answer');
    expect(emptyAns.description).toBeNull();

    const blurryAns = understandVisualRegion(
      baseRegion(),
      'description: The chart axes and values are too blurry and unreadable.',
    );
    expect(blurryAns.status).toBe('abstain');
    expect(blurryAns.abstained).toBe(true);
    expect(blurryAns.abstentionReasons).toContain('illegible-content');
    expect(blurryAns.description).toBeNull();
  });

  it('withholds unreadable chart points as null without inventing zero or interpolated numbers', () => {
    const result = understandVisualRegion(
      baseRegion({
        labels: ['40', '80', '?'],
        axes: [{ orientation: 'y', ticks: [0, 40, 80, 100] }],
      }),
      {
        description: 'Q1 measured 40, Q2 is unreadable, and Q3 measured 80.',
        series: [
          {
            name: 'Latency',
            unit: 'ms',
            points: [
              { x: 'Q1', y: 40 },
              { x: 'Q2', y: 'unreadable' },
              { x: 'Q3', y: 80 },
            ],
          },
        ],
      },
    );

    expect(result.abstained).toBe(false);
    expect(result.status).toBe('partial');
    expect(result.unreadableFields).toContain('series:Latency:Q2');
    expect(result.series[0]?.points[1]).toEqual({
      x: 'Q2',
      y: null,
      illegible: true,
      grounded: false,
    });
  });
});

describe('grounding check against figure labels and ticks', () => {
  it('rejects unverified numeric claims in description, numbers, and series not present in labels or ticks', () => {
    const grounding = verifyVisualGrounding(
      {
        description: 'Throughput starts at 40 req/s and peaks at 999 req/s.',
        numbers: [
          { label: 'start', value: 40 },
          { label: 'peak', value: 999 },
        ],
        series: [
          {
            name: 'Throughput',
            points: [
              { x: 't0', y: 40 },
              { x: 't1', y: 73 },
            ],
          },
        ],
      },
      {
        axes: [{ orientation: 'y', ticks: [0, 50, 100] }],
        labels: [{ text: '40', role: 'data-label' }],
      },
    );

    expect(grounding.passed).toBe(false);
    expect(grounding.verifiedNumbers).toEqual([40]);
    expect(grounding.rejectedNumbers).toEqual([73, 999]);
    expect(grounding.rejectedClaims.map(claim => ({ source: claim.source, value: claim.value }))).toEqual([
      { source: 'series', value: 73 },
      { source: 'numbers', value: 999 },
      { source: 'description', value: 999 },
    ]);
  });

  it('rejects unverified series values during understandVisualRegion and strips them from verified points and numbers', () => {
    const region = baseRegion({
      labels: ['25', '75'],
      axes: [{ orientation: 'y', label: 'Score', unit: '%', ticks: [0, 50, 100] }],
    });

    const result = understandVisualRegion(region, {
      description: 'Score rises from 25% to 75%, reaching 88% in the final step.',
      numbers: [
        { label: 'start', value: 25 },
        { label: 'final', value: 88 },
      ],
      series: [
        {
          name: 'Score',
          unit: '%',
          points: [
            { x: 'Step 1', y: 25 },
            { x: 'Step 2', y: 75 },
            { x: 'Step 3', y: 88 },
          ],
        },
      ],
    });

    expect(result.grounding.passed).toBe(false);
    expect(result.grounding.rejectedNumbers).toEqual([88]);
    expect(result.status).toBe('partial');
    expect(result.numbers).toEqual([{ label: 'start', value: 25 }]);
    expect(result.series[0]?.points).toEqual([
      { x: 'Step 1', y: 25, illegible: false, grounded: true },
      { x: 'Step 2', y: 75, illegible: false, grounded: true },
      { x: 'Step 3', y: null, illegible: false, grounded: false },
    ]);
  });

  it('accepts numbers verified by technical-drawing dimension labels including diameter and tolerance signs', () => {
    const region = baseRegion({
      caption: 'Figure 3. Bearing housing mechanical drawing.',
      cues: { hasDimensionLines: true, hasCallouts: true },
      labels: [
        { text: 'Ø24 mm', role: 'dimension' },
        { text: '±0.05 mm', role: 'dimension' },
        { text: 'Scale 1:2', role: 'callout' },
      ],
    });

    const result = understandVisualRegion(region, {
      description: 'Figure 3 specifies a bore diameter of Ø24 mm with tolerance ±0.05 mm at scale 1:2.',
    });

    expect(result.kind).toBe('technical-drawing');
    expect(result.grounding.passed).toBe(true);
    expect(result.grounding.verifiedNumbers).toEqual([24, 0.05, 1, 2]);
    expect(result.grounding.rejectedNumbers).toEqual([]);
  });

  it('computes deterministic topology for disconnected graphs via analyzeFlowchartTopology', () => {
    const topology = analyzeFlowchartTopology(
      [
        { id: 'a', label: 'Ingest', kind: 'start' },
        { id: 'b', label: 'Parse', kind: 'process' },
        { id: 'orphan', label: 'Unused Note', kind: 'annotation' },
      ],
      [{ from: 'a', to: 'b' }],
    );

    expect(topology.entryNodeIds).toEqual(['a']);
    expect(topology.terminalNodeIds).toEqual(['b']);
    expect(topology.disconnectedNodeIds).toEqual(['orphan']);
    expect(topology.orderedNodeIds).toEqual(['a', 'b']);
    expect(topology.hasCycles).toBe(false);
  });
});

describe('flowchart topology', () => {
  it('traces parallel branches, join points, decision counts, retry back-edges, and dangling edges', () => {
    const topology = analyzeFlowchartTopology(
      [
        { id: 'start', label: 'Receive Job', kind: 'start' },
        { id: 'route', label: 'Needs OCR?', kind: 'decision' },
        { id: 'ocr', label: 'Run OCR', kind: 'process' },
        { id: 'text', label: 'Extract Stream', kind: 'process' },
        { id: 'verify', label: 'Quality OK?', kind: 'decision' },
        { id: 'done', label: 'Emit IR', kind: 'end' },
        { id: 'legend', label: 'Dashed = async', kind: 'annotation' },
      ],
      [
        { from: 'start', to: 'route' },
        { from: 'route', to: 'ocr', label: 'yes' },
        { from: 'route', to: 'text', label: 'no' },
        { from: 'ocr', to: 'verify' },
        { from: 'text', to: 'verify' },
        { from: 'verify', to: 'done', label: 'pass' },
        { from: 'verify', to: 'ocr', label: 'retry', dashed: true },
        { from: 'done', to: 'missing-sink', label: 'notify' },
      ],
    );

    expect(topology.entryNodeIds).toEqual(['start']);
    expect(topology.terminalNodeIds).toEqual(['done']);
    expect(topology.decisionNodeIds).toEqual(['route', 'verify']);
    expect(topology.branchCount).toBe(4);
    expect(topology.hasCycles).toBe(true);
    expect(topology.backEdges).toHaveLength(1);
    expect(topology.backEdges[0]).toMatchObject({ from: 'verify', to: 'ocr', label: 'retry', dashed: true });
    expect(topology.disconnectedNodeIds).toEqual(['legend']);
    expect(topology.danglingEdges).toHaveLength(1);
    expect(topology.danglingEdges[0]).toMatchObject({ from: 'done', to: 'missing-sink' });
    expect(topology.orderedNodeIds).toEqual(['start', 'route', 'ocr', 'text', 'verify', 'done']);
  });

  it('breaks pure cycles with no zero-in-degree node deterministically', () => {
    const topology = analyzeFlowchartTopology(
      [
        { id: 'poll', label: 'Poll Queue', kind: 'process' },
        { id: 'dispatch', label: 'Dispatch Task', kind: 'process' },
        { id: 'ack', label: 'Acknowledge', kind: 'process' },
      ],
      [
        { from: 'poll', to: 'dispatch' },
        { from: 'dispatch', to: 'ack' },
        { from: 'ack', to: 'poll' },
      ],
    );

    expect(topology.entryNodeIds).toEqual(['poll']);
    expect(topology.hasCycles).toBe(true);
    expect(topology.backEdges).toHaveLength(1);
    expect(topology.backEdges[0]).toMatchObject({ from: 'ack', to: 'poll' });
    expect(topology.orderedNodeIds).toEqual(['poll', 'dispatch', 'ack']);
  });

  it('parses flowchart topology from multimodal structured text lines and builds diagram topology too', () => {
    const textAnswer = [
      'description: Requests pass authentication before branching to cache or origin.',
      'nodes: n1[start]: Client; n2[decision]: Cached?; n3[end]: Hit; n4[process]: Origin',
      'edges: n1 -> n2; n2 ->|yes| n3; n2 -- miss --> n4; n4 -> n2 [populate]',
      'labels: Client; Cached?; Hit; Origin',
      'confidence: 0.89',
    ].join('\n');

    const flowResult = understandVisualRegion(
      baseRegion({
        imageId: 'img-flow-text',
        caption: 'Figure 2. Cache lookup flowchart.',
      }),
      textAnswer,
    );

    expect(flowResult.kind).toBe('flowchart');
    expect(flowResult.status).toBe('understood');
    expect(flowResult.nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(flowResult.edges.map(e => ({ from: e.from, to: e.to, label: e.label }))).toEqual([
      { from: 'n1', to: 'n2', label: '' },
      { from: 'n2', to: 'n3', label: 'yes' },
      { from: 'n2', to: 'n4', label: 'miss' },
      { from: 'n4', to: 'n2', label: 'populate' },
    ]);
    expect(flowResult.topology?.decisionNodeIds).toEqual(['n2']);
    expect(flowResult.topology?.hasCycles).toBe(true);

    const diagramResult = understandVisualRegion(
      baseRegion({
        imageId: 'img-arch',
        caption: 'Figure 3. Module dependency diagram.',
      }),
      {
        description: 'Parser feeds translator which outputs PDF blocks.',
        nodes: [
          { id: 'parser', label: 'Parser', kind: 'component' },
          { id: 'translator', label: 'Translator', kind: 'component' },
          { id: 'writer', label: 'PDF Writer', kind: 'component' },
        ],
        edges: [
          { from: 'parser', to: 'translator' },
          { from: 'translator', to: 'writer' },
        ],
      },
    );

    expect(diagramResult.kind).toBe('diagram');
    expect(diagramResult.topology?.orderedNodeIds).toEqual(['parser', 'translator', 'writer']);
    expect(diagramResult.topology?.hasCycles).toBe(false);
  });
});

describe('multi-series chart grounding and batch caption binding', () => {
  it('grounds multi-series charts across dual axes, negative ticks, thousands separators, and percentages', () => {
    const region = baseRegion({
      imageId: 'img-multi-series',
      labels: [
        { text: '1,250', role: 'data-label' },
        { text: '1,480', role: 'data-label' },
        { text: '−3.5%', role: 'data-label' },
        { text: '12.5%', role: 'data-label' },
      ],
      axes: [
        { id: 'x', orientation: 'x', label: 'Year', ticks: ['2023', '2024'] },
        { id: 'y', orientation: 'y', label: 'Volume', unit: 'units', ticks: [0, 1000, 2000] },
        { id: 'y2', orientation: 'y2', label: 'Delta', unit: '%', ticks: [-10, 0, 10, 20] },
      ],
    });

    const result = understandVisualRegion(region, {
      description: 'Volume rose from 1250 in 2023 to 1480 in 2024 while Delta shifted from -3.5% to 12.5%.',
      series: [
        {
          id: 'vol',
          name: 'Volume',
          unit: 'units',
          axisId: 'y',
          points: [
            { x: '2023', y: 1250 },
            { x: '2024', y: 1480 },
          ],
        },
        {
          id: 'delta',
          name: 'Delta',
          unit: '%',
          axisId: 'y2',
          points: [
            { x: '2023', y: -3.5 },
            { x: '2024', y: 12.5 },
          ],
        },
      ],
      numbers: [
        { label: 'vol-2023', value: 1250 },
        { label: 'delta-2024', value: 12.5 },
      ],
    });

    expect(result.status).toBe('understood');
    expect(result.grounding.passed).toBe(true);
    expect(result.grounding.rejectedNumbers).toEqual([]);
    expect(result.units).toBe('units, %');
    expect(result.series[0]?.points.every(p => p.grounded)).toBe(true);
    expect(result.series[1]?.points.every(p => p.grounded)).toBe(true);
  });

  it('isolates unverified and illegible points per series without polluting verified series', () => {
    const region = baseRegion({
      imageId: 'img-multi-mixed',
      labels: ['42', '68', '55', '?'],
      axes: [{ orientation: 'y', unit: '%', ticks: [0, 25, 50, 75, 100] }],
    });

    const result = understandVisualRegion(region, {
      description: 'Series A reached 42 and 68; Series B reached 55.',
      series: [
        {
          id: 'a',
          name: 'Series A',
          points: [
            { x: 'Q1', y: 42 },
            { x: 'Q2', y: 68 },
          ],
        },
        {
          id: 'b',
          name: 'Series B',
          points: [
            { x: 'Q1', y: 55 },
            { x: 'Q2', y: 91 }, // unverified hallucination
            { x: 'Q3', y: '?' }, // unreadable value
          ],
        },
      ],
    });

    expect(result.status).toBe('partial');
    expect(result.grounding.passed).toBe(false);
    expect(result.grounding.rejectedClaims).toEqual([
      {
        source: 'series',
        seriesId: 'b',
        label: 'Q2',
        value: 91,
        raw: '91',
        reason: 'not-in-figure-labels-or-ticks',
      },
    ]);
    expect(result.series[0]?.points).toEqual([
      { x: 'Q1', y: 42, illegible: false, grounded: true },
      { x: 'Q2', y: 68, illegible: false, grounded: true },
    ]);
    expect(result.series[1]?.points).toEqual([
      { x: 'Q1', y: 55, illegible: false, grounded: true },
      { x: 'Q2', y: null, illegible: false, grounded: false },
      { x: 'Q3', y: null, illegible: true, grounded: false },
    ]);
    expect(result.unreadableFields).toContain('series:Series B:Q3');
  });

  it('prevents untrusted response labels from spoofing grounding and abstains under strictGrounding', () => {
    const region = baseRegion({
      imageId: 'img-strict',
      labels: ['10', '20'],
      axes: [{ orientation: 'y', ticks: [0, 10, 20, 30] }],
    });

    const spoofAttempt = understandVisualRegion(region, {
      description: 'The peak hit 999 units.',
      labels: ['999'],
      numbers: [{ label: 'peak', value: 999 }],
    });
    expect(spoofAttempt.grounding.passed).toBe(false);
    expect(spoofAttempt.grounding.rejectedNumbers).toEqual([999]);
    expect(spoofAttempt.numbers).toEqual([]);

    const strictResult = understandVisualRegion(
      region,
      { description: 'The peak hit 999 units.' },
      { strictGrounding: true },
    );
    expect(strictResult.status).toBe('abstain');
    expect(strictResult.abstained).toBe(true);
    expect(strictResult.abstentionReasons).toEqual(['unverified-numeric-claim']);
    expect(strictResult.description).toBeNull();
  });

  it('catches unverified numbers dropped by parseVisionAnswer into grounding rejections', () => {
    const region = baseRegion({
      imageId: 'img-text-dropped',
      labels: ['10', '20'],
      axes: [{ orientation: 'y', ticks: [0, 10, 20] }],
    });
    const textResponse = [
      'description: Values grow from 10 to 20 across the period.',
      'axes: y [units]: 0, 10, 20',
      'series: Growth (units): t0=10 units, t1=20 units',
      'numbers: start = 10; end = 20; peak = 999',
      'confidence: 0.8',
    ].join('\n');

    const result = understandVisualRegion(region, textResponse);
    expect(result.numbers).toEqual([
      { label: 'start', value: 10 },
      { label: 'end', value: 20 },
    ]);
    expect(result.grounding.passed).toBe(false);
    expect(result.grounding.rejectedNumbers).toEqual([999]);
    expect(result.series[0]?.points).toEqual([
      { x: 't0', y: 10, illegible: false, grounded: true },
      { x: 't1', y: 20, illegible: false, grounded: true },
    ]);
  });

  it('binds two figures on the same page to distinct captions by reading order and resolves existing figure blocks', () => {
    const leftRegion = baseRegion({
      imageId: 'img-left',
      bbox: rect(60, 100, 220, 160),
      cues: { hasAxes: true },
    });
    const rightRegion = baseRegion({
      imageId: 'img-right',
      bbox: rect(332, 100, 220, 160),
      cues: { hasAxes: true },
    });

    const blocks: CaptionInputBlock[] = [
      // Existing figure block overlapping rightRegion: must reuse it instead of creating an ambiguity tie.
      { id: 'blk-fig-right', type: 'figure', page: 1, text: '', rect: rect(332, 100, 220, 160), pageHeight: 792 },
      captionBlock('cap-left', rect(60, 272, 220, 16), 'Figure 1. Left chart.'),
      captionBlock('cap-right', rect(332, 272, 220, 16), 'Figure 2. Right chart.'),
    ];

    const results = understandVisualRegions(
      [
        { region: leftRegion, response: { description: 'Left series.' } },
        { region: rightRegion, response: { description: 'Right series.' } },
      ],
      { blocks },
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.captionBlockId).toBe('cap-left');
    expect(results[1]?.captionBlockId).toBe('cap-right');
    expect(results[1]?.sourceBlockId).toBe('blk-fig-right');
  });
});

describe('abstention boundaries and determinism', () => {
  it('enforces exact readability boundaries and accumulates multiple abstention reasons', () => {
    const exactOk = assessVisualReadability(
      baseRegion({
        widthPx: MIN_READABLE_LONG_EDGE_PX,
        heightPx: MIN_READABLE_SHORT_EDGE_PX,
        dpi: MIN_READABLE_DPI,
        quality: {
          contrast: MIN_READABLE_CONTRAST,
          blurScore: MAX_READABLE_BLUR_SCORE,
          ocrConfidence: MIN_READABLE_OCR_CONFIDENCE,
          legible: true,
        },
      }),
    );
    expect(exactOk.readable).toBe(true);
    expect(exactOk.reasons).toEqual([]);

    const multiFail = assessVisualReadability(
      baseRegion({
        widthPx: MIN_READABLE_LONG_EDGE_PX - 1,
        heightPx: MIN_READABLE_SHORT_EDGE_PX - 1,
        dpi: MIN_READABLE_DPI - 1,
        quality: {
          contrast: MIN_READABLE_CONTRAST - 0.1,
          blurScore: MAX_READABLE_BLUR_SCORE + 0.01,
          ocrConfidence: MIN_READABLE_OCR_CONFIDENCE - 0.01,
          legible: false,
        },
      }),
    );
    expect(multiFail.readable).toBe(false);
    expect(multiFail.reasons).toEqual([
      'low-resolution',
      'low-dpi',
      'illegible-content',
      'low-contrast',
      'blurry-image',
      'low-ocr-confidence',
    ]);
  });

  it('abstains on low vision confidence, missing description, or Vietnamese illegible prose', () => {
    expect(
      understandVisualRegion(baseRegion(), 'description: A chart.\nconfidence: 0.15').abstentionReasons,
    ).toEqual(['low-vision-confidence']);

    expect(
      understandVisualRegion(baseRegion(), 'numbers: peak = 42\nconfidence: 0.8').abstentionReasons,
    ).toEqual(['missing-description']);

    expect(
      understandVisualRegion(baseRegion(), 'description: Biểu đồ quá mờ không đọc được số liệu.')
        .abstentionReasons,
    ).toEqual(['illegible-content']);
  });

  it('never invents a description when called before a vision model responds', () => {
    const result = understandVisualRegion(
      baseRegion({
        caption: 'Biểu đồ 1. Tăng trưởng theo quý.',
        labels: ['25%', '50%'],
      }),
    );

    expect(result.abstained).toBe(false);
    expect(result.status).toBe('partial');
    expect(result.kind).toBe('chart');
    expect(result.description).toBeNull();
    expect(result.visionRequest).not.toBeNull();
  });

  it('produces byte-identical deterministic outputs across repeated calls', () => {
    const region = baseRegion({
      imageId: 'img-det',
      labels: ['10', '20', '30'],
      axes: [{ orientation: 'y', ticks: [0, 10, 20, 30] }],
    });
    const response = {
      description: 'Values rise from 10 to 30.',
      series: [{ name: 'Metric', points: [{ x: 't0', y: 10 }, { x: 't1', y: 30 }] }],
    };
    const blocks = [captionBlock('cap-det', rect(60, 390, 400, 16), 'Figure 1. Deterministic test.')];

    const first = understandVisualRegion(region, response, { blocks });
    const second = understandVisualRegion(region, response, { blocks });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

