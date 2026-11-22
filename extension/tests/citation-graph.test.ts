import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  CITATION_GRAPH_VERSION,
  citedBy,
  cites,
  coCitations,
  DEFAULT_LIMIT,
  fromJson,
  missingReferences,
  mostCited,
  related,
  RELATED_CO_CITATION_WEIGHT,
  RELATED_SHARED_REFERENCE_WEIGHT,
  toDot,
  toJson,
} from '../viewer/src/core/citation-graph';
import type { CitationGraph, CitationNode, CitationPaper } from '../viewer/src/core/citation-graph';

/**
 * Three papers whose references exercise every resolution path: a DOI written with a
 * resolver prefix and the wrong case, a title written with extra spaces, a work the
 * library does not hold, and a reference that says nothing at all.
 */
const LIBRARY: CitationPaper[] = [
  { id: 'p1', title: 'Deep Learning', year: 2020, doi: '10.1000/DL', references: [] },
  { id: 'p2', title: 'Attention Is All You Need', year: 2017, references: [] },
  {
    id: 'p3',
    title: 'A Survey of Pretrained Models',
    year: 2021,
    references: [
      { doi: 'https://doi.org/10.1000/dl' },
      { title: '  attention   is all you need ', year: 2017 },
      { title: 'Unlisted Paper', year: 2019 },
      {},
    ],
  },
];

/** Two papers cited by everyone in the fixture below; the graph's centre of mass. */
const CO_CITED: CitationPaper[] = [
  { id: 't', title: 'Target Paper', doi: '10.1/t', references: [] },
  { id: 'w', title: 'Partner Work', doi: '10.1/w', references: [] },
  { id: 'a', title: 'Alpha', references: [{ doi: '10.1/t' }] },
  { id: 'b', title: 'Beta', references: [{ doi: '10.1/t' }, { doi: '10.1/w' }, { title: 'Unknown Elsewhere', year: 2015 }] },
  { id: 'c', title: 'Gamma', references: [{ doi: '10.1/t' }, { doi: '10.1/w' }, { title: 'Unknown Elsewhere', year: 2015 }] },
];

/**
 * A graph with one strong candidate (shares a reference and is co-cited), one weak
 * candidate (shares only that reference) and three that share nothing with `t`.
 */
const RELATED_LIBRARY: CitationPaper[] = [
  { id: 't', title: 'Target Paper', doi: '10.1/t', references: [{ doi: '10.1/x' }] },
  { id: 'w', title: 'Co-Cited Partner', doi: '10.1/w', references: [{ doi: '10.1/x' }] },
  { id: 'y', title: 'Prior Only', references: [{ doi: '10.1/x' }] },
  { id: 'z', title: 'Stranger', references: [] },
  { id: 'x', title: 'Shared Prior', doi: '10.1/x', references: [] },
  { id: 'a', title: 'Citers A', references: [{ doi: '10.1/t' }] },
  { id: 'b', title: 'Citers B', references: [{ doi: '10.1/t' }, { doi: '10.1/w' }] },
  { id: 'c', title: 'Citers C', references: [{ doi: '10.1/t' }, { doi: '10.1/w' }] },
];

function idsOf(nodes: readonly { id: string }[]): string[] {
  return nodes.map(node => node.id);
}

function rankedIds(entries: readonly { node: { id: string } }[]): string[] {
  return entries.map(entry => entry.node.id);
}

function nodeById(graph: CitationGraph, id: string): CitationNode {
  const node = graph.nodes.find(candidate => candidate.id === id);
  if (node === undefined) throw new Error(`fixture has no node ${id}`);
  return node;
}

describe('buildGraph', () => {
  it('resolves a reference by DOI despite a resolver prefix and different case', () => {
    const graph = buildGraph(LIBRARY);
    const edge = graph.edges.find(candidate => candidate.from === 'p3' && candidate.to === 'p1');
    expect(edge).toEqual({ from: 'p3', to: 'p1', kind: 'cites', resolved: true });
    expect(nodeById(graph, 'p1').kind).toBe('paper');
  });

  it('resolves a reference by normalised title and year', () => {
    const graph = buildGraph(LIBRARY);
    expect(graph.edges).toContainEqual({ from: 'p3', to: 'p2', kind: 'cites', resolved: true });
    expect(graph.nodes.map(node => node.id)).not.toContain('stub:title:attention-is-all-you-need:2017');
  });

  it('keeps an unresolved reference as a stub with resolved false', () => {
    const graph = buildGraph(LIBRARY);
    const stub = nodeById(graph, 'stub:title:unlisted-paper:2019');
    expect(stub).toEqual({
      id: 'stub:title:unlisted-paper:2019',
      kind: 'stub',
      title: 'Unlisted Paper',
      year: 2019,
      doi: null,
    });
    expect(graph.edges).toContainEqual({
      from: 'p3',
      to: 'stub:title:unlisted-paper:2019',
      kind: 'cites',
      resolved: false,
    });
  });

  it('keeps a reference that named nothing as an unnamed stub', () => {
    const graph = buildGraph(LIBRARY);
    const stub = nodeById(graph, 'stub:ref:p3:3');
    expect(stub).toEqual({ id: 'stub:ref:p3:3', kind: 'stub', title: '', year: null, doi: null });
    expect(graph.edges).toContainEqual({ from: 'p3', to: 'stub:ref:p3:3', kind: 'cites', resolved: false });
  });

  it('counts papers, stubs and both kinds of edge', () => {
    const graph = buildGraph(LIBRARY);
    expect(graph.stats).toEqual({ papers: 3, stubs: 2, resolvedEdges: 2, unresolvedEdges: 2 });
  });

  it('gives the DOI precedence over a title that names another paper', () => {
    const graph = buildGraph([
      { id: 'left', title: 'Left', doi: '10.1/left', references: [] },
      { id: 'right', title: 'Right', doi: '10.1/right', references: [] },
      { id: 'citing', title: 'Citing', references: [{ doi: '10.1/left', title: 'Right' }] },
    ]);
    expect(graph.edges).toEqual([{ from: 'citing', to: 'left', kind: 'cites', resolved: true }]);
  });

  it('falls back to the title when the DOI names nothing the library holds', () => {
    const graph = buildGraph([
      { id: 'right', title: 'Right', references: [] },
      { id: 'citing', title: 'Citing', references: [{ doi: '10.9/unknown', title: 'Right' }] },
    ]);
    expect(graph.edges).toEqual([{ from: 'citing', to: 'right', kind: 'cites', resolved: true }]);
  });

  it('refuses a title match when only one side states a year', () => {
    const graph = buildGraph([
      { id: 'held', title: 'Deep Learning', year: 2020, references: [] },
      { id: 'citing', title: 'Citing', references: [{ title: 'Deep Learning' }, { title: 'Deep Learning', year: 2019 }] },
    ]);
    expect(graph.edges.map(edge => edge.to)).toEqual(['stub:title:deep-learning', 'stub:title:deep-learning:2019']);
    expect(graph.stats.unresolvedEdges).toBe(2);
  });

  it('matches a title when neither side states a year', () => {
    const graph = buildGraph([
      { id: 'held', title: 'Deep Learning', references: [] },
      { id: 'citing', title: 'Citing', references: [{ title: 'deep   learning' }] },
    ]);
    expect(graph.edges).toEqual([{ from: 'citing', to: 'held', kind: 'cites', resolved: true }]);
  });

  it('writes one edge per pair however often the reference repeats', () => {
    const graph = buildGraph([
      { id: 'held', title: 'Held', doi: '10.1/held', references: [] },
      { id: 'citing', title: 'Citing', references: [{ doi: '10.1/held' }, { doi: '10.1/held' }, { title: 'Held' }] },
    ]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.stats.resolvedEdges).toBe(1);
  });

  it('gives the same edges to two papers citing one unknown work', () => {
    const graph = buildGraph([
      { id: 'first', title: 'First', references: [{ doi: '10.9/missing' }] },
      { id: 'second', title: 'Second', references: [{ doi: '10.9/missing' }] },
    ]);
    expect(graph.stats.stubs).toBe(1);
    expect(graph.edges.map(edge => edge.to)).toEqual(['stub:doi:10.9/missing', 'stub:doi:10.9/missing']);
    expect(citedBy(graph, 'stub:doi:10.9/missing')).toHaveLength(2);
  });

  it('drops a self-citation instead of drawing a loop', () => {
    const graph = buildGraph([
      { id: 'self', title: 'Self', doi: '10.1/self', references: [{ doi: '10.1/self' }, { title: 'Self' }] },
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.stats).toEqual({ papers: 1, stubs: 0, resolvedEdges: 0, unresolvedEdges: 0 });
  });

  it('keeps one node per id and one node per identity', () => {
    const graph = buildGraph([
      { id: 'dup', title: 'First Owner', references: [] },
      { id: 'dup', title: 'Second Owner', references: [] },
    ]);
    expect(graph.nodes).toHaveLength(1);
    expect(nodeById(graph, 'dup').title).toBe('First Owner');
  });

  it('keeps the references of a record whose id is a duplicate', () => {
    const graph = buildGraph([
      { id: 'dup', title: 'First Owner', references: [] },
      { id: 'dup', title: 'Second Owner', references: [{ doi: '10.9/missing' }] },
    ]);
    expect(graph.stats.stubs).toBe(1);
    expect(graph.edges).toEqual([{ from: 'dup', to: 'stub:doi:10.9/missing', kind: 'cites', resolved: false }]);
  });

  it('steps a stub aside from a paper that already owns its generated id', () => {
    const graph = buildGraph([
      { id: 'stub:doi:10.9/missing', title: 'A paper with an unlucky id', references: [] },
      { id: 'citing', title: 'Citing', references: [{ doi: '10.9/missing' }] },
    ]);
    expect(idsOf(graph.nodes)).toEqual(['stub:doi:10.9/missing', 'citing', 'stub:doi:10.9/missing~2']);
    expect(graph.edges).toEqual([{ from: 'citing', to: 'stub:doi:10.9/missing~2', kind: 'cites', resolved: false }]);
  });

  it('sorts edges by source then target', () => {
    const graph = buildGraph(LIBRARY);
    const keys = graph.edges.map(edge => `${edge.from}\u0000${edge.to}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('tolerates a record with no reference list', () => {
    const graph = buildGraph([{ id: 'bare', title: 'Bare' } as unknown as CitationPaper]);
    expect(graph.nodes).toEqual([{ id: 'bare', kind: 'paper', title: 'Bare', year: null, doi: null }]);
    expect(graph.edges).toEqual([]);
  });

  it('is deterministic for one input', () => {
    expect(buildGraph(LIBRARY)).toEqual(buildGraph(LIBRARY));
    expect(toDot(buildGraph(CO_CITED))).toBe(toDot(buildGraph(CO_CITED)));
  });
});

describe('citedBy and cites', () => {
  it('lists the papers that cite a paper, sorted by title', () => {
    const graph = buildGraph([
      ...LIBRARY,
      { id: 'p4', title: 'Language Models are Few-Shot Learners', year: 2020, references: [{ title: 'Deep Learning', year: 2020 }] },
    ]);
    expect(idsOf(citedBy(graph, 'p1'))).toEqual(['p3', 'p4']);
    expect(citedBy(graph, 'p1').map(node => node.title)).toEqual([
      'A Survey of Pretrained Models',
      'Language Models are Few-Shot Learners',
    ]);
  });

  it('lists what a paper cites, stubs included, sorted by title', () => {
    const graph = buildGraph(LIBRARY);
    expect(idsOf(cites(graph, 'p3'))).toEqual(['stub:ref:p3:3', 'p2', 'p1', 'stub:title:unlisted-paper:2019']);
    expect(cites(graph, 'p3').map(node => node.kind)).toEqual(['stub', 'paper', 'paper', 'stub']);
  });

  it('lists the citers of a stub', () => {
    const graph = buildGraph(CO_CITED);
    expect(idsOf(citedBy(graph, 'stub:title:unknown-elsewhere:2015'))).toEqual(['b', 'c']);
  });

  it('returns nothing for a paper that cites nothing or an unknown id', () => {
    const graph = buildGraph(LIBRARY);
    expect(cites(graph, 'p1')).toEqual([]);
    expect(citedBy(graph, 'not-in-the-graph')).toEqual([]);
    expect(cites(graph, '')).toEqual([]);
  });
});

describe('coCitations', () => {
  it('ranks works cited alongside a paper by common citers', () => {
    const graph = buildGraph(CO_CITED);
    const ranked = coCitations(graph, 't');
    expect(rankedIds(ranked)).toEqual(['w', 'stub:title:unknown-elsewhere:2015']);
    expect(ranked.map(entry => entry.count)).toEqual([2, 2]);
  });

  it('breaks a co-citation tie by title', () => {
    const graph = buildGraph([
      { id: 't', title: 'Target', references: [] },
      { id: 'zeta', title: 'Zeta Work', references: [] },
      { id: 'alpha', title: 'Alpha Work', references: [] },
      { id: 'citer', title: 'Citer', references: [{ title: 'Target' }, { title: 'Zeta Work' }, { title: 'Alpha Work' }] },
    ]);
    expect(coCitations(graph, 't').map(entry => entry.node.title)).toEqual(['Alpha Work', 'Zeta Work']);
    expect(coCitations(graph, 't').map(entry => entry.count)).toEqual([1, 1]);
  });

  it('returns nothing when no paper cites the target', () => {
    expect(coCitations(buildGraph(LIBRARY), 'p3')).toEqual([]);
  });
});

describe('mostCited', () => {
  const TIE: CitationPaper[] = [
    { id: 'z', title: 'Zeta', references: [] },
    { id: 'a', title: 'Alpha', references: [] },
    { id: 'm', title: 'Middle', references: [] },
    { id: 'c1', title: 'Citer One', references: [{ title: 'Middle' }, { title: 'Zeta' }] },
    { id: 'c2', title: 'Citer Two', references: [{ title: 'Middle' }, { title: 'Alpha' }] },
  ];

  it('orders by citation count then by title', () => {
    const ranked = mostCited(buildGraph(TIE));
    expect(rankedIds(ranked)).toEqual(['m', 'a', 'z']);
    expect(ranked.map(entry => entry.count)).toEqual([2, 1, 1]);
  });

  it('leaves out papers nothing cites and stubs', () => {
    const graph = buildGraph(LIBRARY);
    const ranked = mostCited(graph);
    expect(rankedIds(ranked)).toEqual(['p2', 'p1']);
    expect(ranked.every(entry => entry.node.kind === 'paper')).toBe(true);
    expect(rankedIds(ranked)).not.toContain('p3');
    expect(rankedIds(ranked)).not.toContain('stub:title:unlisted-paper:2019');
  });

  it('honours a limit and never reports a negative one', () => {
    expect(rankedIds(mostCited(buildGraph(TIE), 1))).toEqual(['m']);
    expect(mostCited(buildGraph(TIE), 0)).toEqual([]);
    expect(mostCited(buildGraph(TIE), -3)).toEqual([]);
  });

  it('falls back to the default limit when none is given', () => {
    const papers: CitationPaper[] = [];
    for (let index = 0; index < DEFAULT_LIMIT + 2; index++) {
      const title = `Cited ${index}`;
      papers.push({ id: `cited-${index}`, title, references: [] });
      papers.push({ id: `citer-${index}`, title: `Citer ${index}`, references: [{ title }] });
    }
    const ranked = mostCited(buildGraph(papers));
    expect(ranked).toHaveLength(DEFAULT_LIMIT);
    expect(ranked.every(entry => entry.count === 1)).toBe(true);
  });
});

describe('missingReferences', () => {
  it('lists stubs by how many papers need them', () => {
    const graph = buildGraph(LIBRARY);
    const missing = missingReferences(graph);
    expect(rankedIds(missing)).toEqual(['stub:ref:p3:3', 'stub:title:unlisted-paper:2019']);
    expect(missing.map(entry => entry.count)).toEqual([1, 1]);
  });

  it('marks a stub whose reference named nothing with an empty title and no DOI', () => {
    const [first] = missingReferences(buildGraph(LIBRARY));
    expect(first?.node).toEqual({ id: 'stub:ref:p3:3', kind: 'stub', title: '', year: null, doi: null });
  });

  it('keeps the DOI a reference carried so the gap can be looked up', () => {
    const graph = buildGraph([{ id: 'citing', title: 'Citing', references: [{ doi: 'https://doi.org/10.9/Missing' }] }]);
    const [only] = missingReferences(graph);
    expect(only?.node.id).toBe('stub:doi:10.9/missing');
    expect(only?.node.doi).toBe('10.9/missing');
    expect(only?.node.title).toBe('');
  });

  it('returns nothing for a library that holds every cited work', () => {
    const graph = buildGraph([
      { id: 'held', title: 'Held', references: [] },
      { id: 'citing', title: 'Citing', references: [{ title: 'Held' }] },
    ]);
    expect(missingReferences(graph)).toEqual([]);
    expect(graph.stats.stubs).toBe(0);
  });
});

describe('related', () => {
  it('scores shared references and co-citations with the documented weights', () => {
    const graph = buildGraph(RELATED_LIBRARY);
    const ranked = related(graph, 't');
    expect(rankedIds(ranked)).toEqual(['w', 'y']);
    expect(ranked[0]).toEqual({
      node: nodeById(graph, 'w'),
      score: RELATED_SHARED_REFERENCE_WEIGHT * 1 + RELATED_CO_CITATION_WEIGHT * 2,
      sharedReferences: 1,
      coCitations: 2,
    });
    expect(ranked[1]).toEqual({
      node: nodeById(graph, 'y'),
      score: RELATED_SHARED_REFERENCE_WEIGHT * 1,
      sharedReferences: 1,
      coCitations: 0,
    });
  });

  it('leaves unrelated papers and stubs out', () => {
    const graph = buildGraph(RELATED_LIBRARY);
    expect(rankedIds(related(graph, 't'))).not.toContain('z');
    expect(related(graph, 't').every(entry => entry.node.kind === 'paper')).toBe(true);
    expect(related(graph, 'z')).toEqual([]);
  });

  it('honours a limit', () => {
    const graph = buildGraph(RELATED_LIBRARY);
    expect(rankedIds(related(graph, 't', 1))).toEqual(['w']);
    expect(related(graph, 't', 0)).toEqual([]);
  });

  it('returns nothing for an unknown id', () => {
    expect(related(buildGraph(RELATED_LIBRARY), 'not-in-the-graph')).toEqual([]);
  });
});

describe('toDot', () => {
  it('escapes quotes and backslashes in labels', () => {
    const graph = buildGraph([
      { id: 'p1', title: 'Notes on "quotes" and \\ backslash', year: 2020, references: [{ title: 'A "quoted" work', year: 2019 }] },
    ]);
    const dot = toDot(graph);
    expect(dot).toContain('label="Notes on \\"quotes\\" and \\\\ backslash (2020)"');
    expect(dot).toContain('label="A \\"quoted\\" work (2019)"');
  });

  it('writes a valid graph header, nodes and edges', () => {
    const graph = buildGraph(LIBRARY);
    const dot = toDot(graph);
    expect(dot.startsWith('digraph citations {\n')).toBe(true);
    expect(dot.trimEnd().endsWith('}')).toBe(true);
    expect(dot).toContain('rankdir=LR;');
    expect(dot).toContain('"p3" -> "p1";');
    expect(dot).toContain('"p3" -> "stub:title:unlisted-paper:2019" [style=dashed];');
    expect(dot).toContain('// 3 papers, 2 stubs, 2 resolved edges, 2 unresolved edges');
  });

  it('sorts nodes by id, whatever the input order was', () => {
    const dot = toDot(buildGraph(LIBRARY));
    const ids = dot
      .split('\n')
      .filter(line => line.includes('[label='))
      .map(line => /^\s*"([^"]+)"/u.exec(line)?.[1] ?? '');
    expect(ids).toEqual(['p1', 'p2', 'p3', 'stub:ref:p3:3', 'stub:title:unlisted-paper:2019']);
  });

  it('labels an unnamed stub with its generated id', () => {
    const dot = toDot(buildGraph(LIBRARY));
    expect(dot).toContain('"stub:ref:p3:3" [label="stub:ref:p3:3", shape=box, style=dashed];');
  });
});

describe('toJson and fromJson', () => {
  it('round-trips a graph unchanged', () => {
    const graph = buildGraph(RELATED_LIBRARY);
    const restored = fromJson(toJson(graph));
    expect(restored).toEqual(graph);
    expect(restored.stats).toEqual(graph.stats);
    expect(restored.nodes).toEqual(graph.nodes);
    expect(restored.edges).toEqual(graph.edges);
  });

  it('round-trips an empty graph', () => {
    const graph = buildGraph([]);
    expect(graph).toEqual({ nodes: [], edges: [], stats: { papers: 0, stubs: 0, resolvedEdges: 0, unresolvedEdges: 0 } });
    expect(fromJson(toJson(graph))).toEqual(graph);
  });

  it('writes a versioned document whose stats match its content', () => {
    const graph = buildGraph(LIBRARY);
    const parsed: unknown = JSON.parse(toJson(graph));
    expect(parsed).toMatchObject({ version: CITATION_GRAPH_VERSION, stats: graph.stats });
    expect((parsed as { nodes: unknown[] }).nodes).toHaveLength(graph.nodes.length);
  });

  it('rejects text that is not a graph', () => {
    expect(() => fromJson('not json')).toThrow(/not valid JSON/u);
    expect(() => fromJson('[]')).toThrow(/must be an object/u);
    expect(() => fromJson(JSON.stringify({ version: CITATION_GRAPH_VERSION + 1, nodes: [], edges: [] }))).toThrow(/version/u);
    expect(() => fromJson(JSON.stringify({ version: CITATION_GRAPH_VERSION, nodes: [] }))).toThrow(/nodes array/u);
  });

  it('rejects an edge whose node is missing', () => {
    const broken = {
      version: CITATION_GRAPH_VERSION,
      nodes: [{ id: 'a', kind: 'paper', title: 'A', year: null, doi: null }],
      edges: [{ from: 'a', to: 'gone', kind: 'cites', resolved: true }],
    };
    expect(() => fromJson(JSON.stringify(broken))).toThrow(/whose node is missing/u);
  });

  it('rejects a node that is not a node', () => {
    const broken = {
      version: CITATION_GRAPH_VERSION,
      nodes: [{ id: 'a', kind: 'essay', title: 'A', year: null, doi: null }],
      edges: [],
    };
    expect(() => fromJson(JSON.stringify(broken))).toThrow(/node that is not a node/u);
  });
});
