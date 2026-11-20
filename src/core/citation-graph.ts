/**
 * Citation graph across a research workspace (backlog J03/J09).
 *
 * A library of papers records what each paper cites. That is already a graph, but a
 * reader cannot ask it anything until the reference lists are joined to the records the
 * library holds: which paper is cited most, what cites this one, what sits next to it
 * in the literature, and what the library is missing. This module builds that graph
 * from the records alone — no network, no metadata fetch — and answers those questions.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no I/O, no locale. The same
 *   records always produce the same nodes, edges, counts and bytes, and every list a
 *   query returns is sorted by a key documented on that query.
 * - Text is compared by Unicode code unit, never by locale, so two machines with
 *   different collation settings agree on every ordering and on every tie.
 * - The graph never pretends completeness. A reference that cannot be joined to a
 *   known paper becomes a stub node: it is a cited work the library does not hold, not
 *   a paper. A stub keeps only what the citing record said about it (a DOI, a title, a
 *   year, or nothing at all) and is never given a year or DOI it did not carry.
 * - Resolution is DOI first, then normalised title and year. A DOI is an identifier,
 *   so it wins even when the reference's title spells the work differently. Title and
 *   year match only when the folded titles are equal and the years agree; a known year
 *   against an unknown one is not evidence either way, so the reference stays a stub.
 * - Nothing is guessed and nothing is thrown away silently. Two records that claim one
 *   identity keep the first record, in input order, as the owner of that identity; the
 *   graph does not pick between them by title similarity or any other heuristic.
 * - Every returned structure is fresh. The input records are never modified, and a
 *   caller may re-run {@link buildGraph} as many times as it likes.
 *
 * Node identity: a paper node keeps the caller's id verbatim (trimmed). Stub nodes are
 * generated in a separate namespace under {@link STUB_ID_PREFIX}, keyed by the
 * reference's DOI, else its folded title and year, else its position in the citing
 * paper's reference list. Two references that carry the same DOI, or the same title and
 * year, therefore point at one stub — the graph counts works, not repeated mentions.
 *
 * Edges are unique per pair: a paper that lists the same target twice contributes one
 * `cites` edge, because the graph records relationships, not repetitions. A reference
 * that resolves to the paper it came from contributes no edge, because a self-loop says
 * nothing about the corpus and would distort the co-citation counts.
 */

/** Version written into the JSON form; {@link fromJson} accepts only this one. */
export const CITATION_GRAPH_VERSION = 1;

/** Namespace of every generated stub id. Paper ids are the caller's and are not prefixed. */
export const STUB_ID_PREFIX = 'stub:';

/** Rows a ranked query returns when the caller passes no limit. */
export const DEFAULT_LIMIT = 10;

/**
 * Weight of one shared reference in {@link related}.
 *
 * Two papers with the same reference list are building on the same prior work, which is
 * the strongest structural signal a citation graph offers without reading the papers.
 * It outweighs a co-citation, which only says a third author put them in one
 * bibliography.
 */
export const RELATED_SHARED_REFERENCE_WEIGHT = 2;

/** Weight of one co-citing paper in {@link related}; see {@link RELATED_SHARED_REFERENCE_WEIGHT}. */
export const RELATED_CO_CITATION_WEIGHT = 1;

/** A cited work as the citing record describes it. Every field is optional: records lie by omission. */
export interface CitationReference {
  /** DOI as written — with or without the resolver prefix; compared after normalisation. */
  doi?: string;
  /** Title as written; folded for matching and kept verbatim for display. */
  title?: string;
  /** Publication year, when the record states one. */
  year?: number;
}

/**
 * One paper in the workspace, as records we already hold.
 *
 * `doi` is what makes DOI-first resolution possible at all; a record imported from a
 * `.bib` file normally carries one. It is optional because an extracted reference list
 * often does not.
 */
export interface CitationPaper {
  /** Stable id the caller addresses the paper by; written verbatim into edges. */
  id: string;
  title: string;
  year?: number;
  doi?: string;
  /** Works this paper cites, in the order the record lists them. */
  references: readonly CitationReference[];
}

/** A paper the library holds, or a cited work it does not. */
export type CitationNodeKind = 'paper' | 'stub';

/** One vertex: a known paper (`kind: 'paper'`) or a cited work the library lacks. */
export interface CitationNode {
  /** Paper id, or a generated id under {@link STUB_ID_PREFIX}. */
  id: string;
  kind: CitationNodeKind;
  /**
   * Paper title, or the title the citing reference gave for a stub. The empty string
   * when a stub's reference named no title — the strongest signal that a reference was
   * lost rather than merely unheld.
   */
  title: string;
  /** Four-digit year, or `null` when the record does not state one. */
  year: number | null;
  /** Normalised DOI, or `null` when the record carries none. */
  doi: string | null;
}

/** One directed edge: `from` cites `to`. */
export interface CitationEdge {
  /** Citing paper id. */
  from: string;
  /** Cited node id: a paper, or a stub for a work the library does not hold. */
  to: string;
  kind: 'cites';
  /**
   * True when the reference was joined to a known paper. It mirrors the target's node
   * kind today and stays explicit so a reader never has to infer it from `to`.
   */
  resolved: boolean;
}

export interface CitationGraphStats {
  /** Known paper nodes. */
  papers: number;
  /** Stub nodes: cited works the library does not hold. */
  stubs: number;
  /** Edges joined to a known paper. */
  resolvedEdges: number;
  /** Edges pointing at a stub. */
  unresolvedEdges: number;
}

/** The whole graph as plain data, so it can be stored and read back unchanged. */
export interface CitationGraph {
  /** Papers in input order, then stubs in first-appearance order. */
  nodes: CitationNode[];
  /** Unique `cites` edges, sorted by source id then target id. */
  edges: CitationEdge[];
  /** Counts derived from `nodes` and `edges`. */
  stats: CitationGraphStats;
}

/** A node with a count attached; the shape ranked queries return. */
export interface CitationCount {
  node: CitationNode;
  count: number;
}

/** One paper ranked by {@link related}. */
export interface RelatedPaper {
  node: CitationNode;
  /** {@link RELATED_SHARED_REFERENCE_WEIGHT} * `sharedReferences` + {@link RELATED_CO_CITATION_WEIGHT} * `coCitations`. */
  score: number;
  /** Distinct works both papers cite. */
  sharedReferences: number;
  /** Papers that cite both this paper and the one asked about. */
  coCitations: number;
}

// --- Building --------------------------------------------------------------

/**
 * Builds the citation graph of a workspace.
 *
 * Each paper becomes a node and each of its references becomes a `cites` edge to either
 * a known paper or a fresh stub. Nodes come back in input order (papers first, then
 * stubs in first-appearance order) and edges sorted by source then target, so an
 * unchanged input always produces byte-identical output.
 *
 * A record without a usable id is ignored: an edge cannot address it, and inventing an
 * id would make the graph claim a paper the library cannot show. A later record that
 * repeats an id updates nothing — the first record owns that node's title, year and DOI
 * — but its references still add edges, because those citations exist in the corpus
 * whatever the duplicate says about the paper itself.
 */
export function buildGraph(papers: readonly CitationPaper[]): CitationGraph {
  const records: readonly unknown[] = Array.isArray(papers) ? papers : [];
  const nodes: CitationNode[] = [];
  const byId = new Map<string, CitationNode>();
  const doiIndex = new Map<string, string>();
  const titleIndex = new Map<string, string[]>();

  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    const paper = record as CitationPaper;
    const id = readId(paper.id);
    if (id === null || byId.has(id)) continue;
    const title = collapseText(paper.title);
    const doi = normalizeDoi(paper.doi);
    const node: CitationNode = {
      id,
      kind: 'paper',
      title,
      year: readYear(paper.year),
      doi: doi.length > 0 ? doi : null,
    };
    nodes.push(node);
    byId.set(id, node);
    // First record in input order owns an identity; a later claimant cannot steal it.
    if (doi.length > 0 && !doiIndex.has(doi)) doiIndex.set(doi, id);
    const folded = foldTitle(title);
    if (folded.length > 0) {
      const group = titleIndex.get(folded);
      if (group === undefined) titleIndex.set(folded, [id]);
      else group.push(id);
    }
  }

  const edges: CitationEdge[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (from: string, to: string, resolved: boolean): void => {
    const key = `${from}\u0000${to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, kind: 'cites', resolved });
  };

  /**
   * The stub for one unresolved reference, or the one an earlier reference with the
   * same identity already created. The id is the identity, so two papers citing one
   * unknown work point at one stub instead of at two placeholders.
   */
  const stubFor = (paperId: string, index: number, doi: string, title: string, year: number | null): CitationNode => {
    const identity = stubIdentity(paperId, index, doi, title, year);
    const known = byId.get(identity);
    // Only a stub can be the earlier holder; a paper id that happens to sit in the stub
    // namespace is a different vertex, and the loop below steps this stub aside from it.
    if (known !== undefined && known.kind === 'stub') return known;
    let id = identity;
    let step = 2;
    while (byId.has(id)) {
      id = `${identity}~${step}`;
      step++;
    }
    const node: CitationNode = { id, kind: 'stub', title, year, doi: doi.length > 0 ? doi : null };
    nodes.push(node);
    byId.set(id, node);
    return node;
  };

  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    const paper = record as CitationPaper;
    const from = readId(paper.id);
    if (from === null || !byId.has(from)) continue;
    const references: readonly unknown[] = Array.isArray(paper.references) ? paper.references : [];
    references.forEach((value, index) => {
      if (value === null || typeof value !== 'object') return;
      const reference = value as CitationReference;
      const doi = normalizeDoi(reference.doi);
      const title = collapseText(reference.title);
      const year = readYear(reference.year);
      const resolved = resolveTarget(doi, title, year, byId, doiIndex, titleIndex);
      if (resolved !== null) {
        // A record repeating its own DOI or title cites itself; that is an artefact of
        // the record, not a relationship in the corpus.
        if (resolved !== from) addEdge(from, resolved, true);
        return;
      }
      const stub = stubFor(from, index, doi, title, year);
      addEdge(from, stub.id, false);
    });
  }

  edges.sort((left, right) => compareText(left.from, right.from) || compareText(left.to, right.to));
  return { nodes, edges, stats: recomputeStats(nodes, edges) };
}

/**
 * The known paper a reference names, or `null` when it names none.
 *
 * DOI first: it is an identifier, so a reference whose title is abbreviated or
 * translated still lands on the record that owns the DOI. Title and year is the
 * fallback, and it needs both sides to agree — equal folded titles and equal years,
 * with two missing years counting as equal and one missing year counting as no match.
 */
function resolveTarget(
  doi: string,
  title: string,
  year: number | null,
  byId: ReadonlyMap<string, CitationNode>,
  doiIndex: ReadonlyMap<string, string>,
  titleIndex: ReadonlyMap<string, readonly string[]>,
): string | null {
  if (doi.length > 0) {
    const owner = doiIndex.get(doi);
    if (owner !== undefined) return owner;
  }
  const folded = foldTitle(title);
  if (folded.length === 0) return null;
  for (const candidateId of titleIndex.get(folded) ?? []) {
    const candidate = byId.get(candidateId);
    if (candidate === undefined) continue;
    if (candidate.year === year) return candidateId;
  }
  return null;
}

/**
 * Identity of a stub, in one of three forms:
 * `stub:doi:<doi>`, `stub:title:<folded-title>[:<year>]`, or `stub:ref:<paper>:<index>`
 * for a reference that named nothing at all.
 */
function stubIdentity(paperId: string, index: number, doi: string, title: string, year: number | null): string {
  if (doi.length > 0) return `${STUB_ID_PREFIX}doi:${doi}`;
  const slug = slugOf(title);
  if (slug.length > 0) {
    return year === null ? `${STUB_ID_PREFIX}title:${slug}` : `${STUB_ID_PREFIX}title:${slug}:${year}`;
  }
  return `${STUB_ID_PREFIX}ref:${paperId}:${index}`;
}

// --- Queries ---------------------------------------------------------------

/**
 * Papers that cite `id`, sorted by title then id.
 *
 * The citers of a stub are included: they are the reader's evidence that a work the
 * library does not hold is still load-bearing in this corpus.
 */
export function citedBy(graph: CitationGraph, id: string): CitationNode[] {
  const index = indexGraph(graph);
  const target = readId(id);
  if (target === null) return [];
  return sortByTitle(targetsOf(index, index.incoming.get(target)));
}

/**
 * Nodes `id` cites, sorted by title then id — known papers and stubs alike, because a
 * reference list is exactly that mix. Empty for a stub: the library knows what it is
 * cited for, not what it cites.
 */
export function cites(graph: CitationGraph, id: string): CitationNode[] {
  const index = indexGraph(graph);
  const target = readId(id);
  if (target === null) return [];
  return sortByTitle(targetsOf(index, index.outgoing.get(target)));
}

/**
 * Works cited alongside `id` by at least one common citing paper, most co-cited first.
 *
 * Co-citation is the third-author signal: two works are co-cited when one bibliography
 * names both. Sorted by count descending, then title, then id. A stub can appear here —
 * being co-cited is what a work the library lacks is often known by.
 */
export function coCitations(graph: CitationGraph, id: string): CitationCount[] {
  const index = indexGraph(graph);
  const target = readId(id);
  if (target === null) return [];
  const counts = new Map<string, number>();
  for (const citer of index.incoming.get(target) ?? []) {
    for (const partner of index.outgoing.get(citer) ?? []) {
      if (partner === target) continue;
      counts.set(partner, (counts.get(partner) ?? 0) + 1);
    }
  }
  return rankEntities(index, counts);
}

/**
 * The most cited known papers, most cited first, then by title, then by id.
 *
 * `citations` counts citing papers, once each. Stubs are not ranked: a stub is not a
 * paper, and printing an unnamed work in a "most cited" panel would dress a placeholder
 * as a record. Their counts stay visible through {@link citedBy} and
 * {@link missingReferences}. A paper nothing in the library cites is left out too: a
 * "most cited" row needs a count, and the library's size is `stats.papers`.
 */
export function mostCited(graph: CitationGraph, limit?: number): CitationCount[] {
  const index = indexGraph(graph);
  const counts = new Map<string, number>();
  for (const node of index.nodes) {
    if (node.kind !== 'paper') continue;
    const count = (index.incoming.get(node.id) ?? []).length;
    if (count > 0) counts.set(node.id, count);
  }
  return rankEntities(index, counts).slice(0, readLimit(limit));
}

/**
 * Stubs, most cited first, then by title, then by id: the references the library cannot
 * answer with.
 *
 * A stub carries no metadata of its own — only the text its citing record gave it. One
 * with an empty title and no DOI is the strongest signal this module can offer that
 * extraction lost a reference rather than that the library lacks a paper.
 */
export function missingReferences(graph: CitationGraph): CitationCount[] {
  const index = indexGraph(graph);
  const counts = new Map<string, number>();
  for (const node of index.nodes) {
    if (node.kind !== 'stub') continue;
    counts.set(node.id, (index.incoming.get(node.id) ?? []).length);
  }
  return rankEntities(index, counts);
}

/**
 * Papers related to `id`, scored by shared references and co-citation:
 *
 * ```text
 * score = 2 * sharedReferences + 1 * coCitations
 * ```
 *
 * `sharedReferences` counts works both papers cite (bibliographic coupling), so two
 * papers with the same reference list sit at the top even when nothing cites either.
 * `coCitations` counts papers that cite both — the weaker signal, hence the weight of
 * one. Sorted by score, then shared references, then co-citations, then title, then id,
 * so ties land in a fixed order. Stubs are never candidates: a placeholder is not a
 * paper to read next. A stub may be the paper asked about, though — it cites nothing, so
 * only co-citation counts for it. A candidate scoring zero is left out, and a graph with
 * no relationships returns an empty list rather than the whole library.
 */
export function related(graph: CitationGraph, id: string, limit?: number): RelatedPaper[] {
  const index = indexGraph(graph);
  const target = readId(id);
  if (target === null || !index.byId.has(target)) return [];

  const targetOut = new Set(index.outgoing.get(target) ?? []);
  const targetIn = new Set(index.incoming.get(target) ?? []);
  const ranked: RelatedPaper[] = [];

  for (const candidate of index.nodes) {
    if (candidate.id === target || candidate.kind !== 'paper') continue;
    let sharedReferences = 0;
    for (const referenceId of index.outgoing.get(candidate.id) ?? []) {
      if (targetOut.has(referenceId)) sharedReferences++;
    }
    let coCited = 0;
    for (const citer of index.incoming.get(candidate.id) ?? []) {
      if (targetIn.has(citer)) coCited++;
    }
    if (sharedReferences === 0 && coCited === 0) continue;
    ranked.push({
      node: candidate,
      score: RELATED_SHARED_REFERENCE_WEIGHT * sharedReferences + RELATED_CO_CITATION_WEIGHT * coCited,
      sharedReferences,
      coCitations: coCited,
    });
  }

  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      right.sharedReferences - left.sharedReferences ||
      right.coCitations - left.coCitations ||
      compareNodes(left.node, right.node),
  );
  return ranked.slice(0, readLimit(limit));
}

// --- Output ----------------------------------------------------------------

/**
 * Graphviz DOT for a quick look at the graph.
 *
 * Nodes are sorted by id and edges by source then target, so two runs over one graph
 * produce the same file. Labels escape `\` and `"` and collapse whitespace, which is
 * what a DOT quoted string needs. A paper is a solid box labelled `Title (year)`; a
 * stub is a dashed box labelled with what the reference gave — its DOI, its title, or
 * its generated id when it gave nothing. An unresolved edge is dashed for the same
 * reason.
 */
export function toDot(graph: CitationGraph): string {
  const nodes = [...readNodes(graph)].sort((left, right) => compareText(left.id, right.id));
  const edges = [...readEdges(graph)].sort(
    (left, right) => compareText(left.from, right.from) || compareText(left.to, right.to),
  );
  const stats = recomputeStats(nodes, edges);
  const lines: string[] = [
    'digraph citations {',
    `  // ${stats.papers} papers, ${stats.stubs} stubs, ${stats.resolvedEdges} resolved edges, ${stats.unresolvedEdges} unresolved edges`,
    '  rankdir=LR;',
  ];
  for (const node of nodes) {
    const style = node.kind === 'paper' ? 'shape=box' : 'shape=box, style=dashed';
    lines.push(`  ${dotString(node.id)} [label=${dotString(labelOf(node))}, ${style}];`);
  }
  for (const edge of edges) {
    const style = edge.resolved ? '' : ' [style=dashed]';
    lines.push(`  ${dotString(edge.from)} -> ${dotString(edge.to)}${style};`);
  }
  lines.push('}', '');
  return lines.join('\n');
}

/**
 * The graph as JSON, ready to be stored beside the library.
 *
 * The stats are recomputed from the emitted nodes and edges, so a stored graph cannot
 * carry counts that disagree with its contents. {@link fromJson} reads the result back
 * into an equal graph — same nodes, same order, same edges, same stats.
 */
export function toJson(graph: CitationGraph): string {
  const nodes = readNodes(graph);
  const edges = readEdges(graph);
  const value = {
    version: CITATION_GRAPH_VERSION,
    nodes: nodes.map(node => ({
      id: node.id,
      kind: node.kind,
      title: node.title,
      year: node.year,
      doi: node.doi,
    })),
    edges: edges.map(edge => ({ from: edge.from, to: edge.to, kind: edge.kind, resolved: edge.resolved })),
    stats: recomputeStats(nodes, edges),
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Reads back what {@link toJson} wrote.
 *
 * This is the one function in the module that throws, and deliberately so: a codec that
 * returned an empty graph for a truncated or hand-broken file would hide the corruption
 * exactly where the reader needs to see it. The structure is validated — node kinds,
 * year and DOI types, and that every edge has both endpoints — and the stats are
 * recomputed rather than trusted.
 */
export function fromJson(text: string): CitationGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof text === 'string' ? text : '');
  } catch {
    throw new Error('Citation graph JSON is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Citation graph JSON must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== CITATION_GRAPH_VERSION) {
    throw new Error(`Citation graph JSON must declare version ${CITATION_GRAPH_VERSION}.`);
  }
  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
    throw new Error('Citation graph JSON must carry a nodes array and an edges array.');
  }

  const nodes: CitationNode[] = [];
  const ids = new Set<string>();
  for (const value of record.nodes) {
    const node = readJsonNode(value);
    if (node === null) throw new Error('Citation graph JSON carries a node that is not a node.');
    if (ids.has(node.id)) throw new Error(`Citation graph JSON carries node ${node.id} twice.`);
    ids.add(node.id);
    nodes.push(node);
  }

  const edges: CitationEdge[] = [];
  for (const value of record.edges) {
    const edge = readJsonEdge(value);
    if (edge === null) throw new Error('Citation graph JSON carries an edge that is not an edge.');
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new Error(`Citation graph JSON has an edge ${edge.from} -> ${edge.to} whose node is missing.`);
    }
    edges.push(edge);
  }

  return { nodes, edges, stats: recomputeStats(nodes, edges) };
}

// --- Index -----------------------------------------------------------------

/**
 * Adjacency built from a graph for one query. The public shape stays plain data; the
 * maps are cheap to rebuild and never escape a call.
 */
interface GraphIndex {
  /** Node lookup; a duplicate id keeps the first node, as `buildGraph` does. */
  byId: Map<string, CitationNode>;
  /** Every node, in graph order. */
  nodes: CitationNode[];
  /** Cited ids per citing id, sorted by id. */
  outgoing: Map<string, string[]>;
  /** Citing ids per cited id, sorted by id. */
  incoming: Map<string, string[]>;
}

function indexGraph(graph: CitationGraph): GraphIndex {
  const nodes = readNodes(graph);
  const byId = new Map<string, CitationNode>();
  for (const node of nodes) {
    if (!byId.has(node.id)) byId.set(node.id, node);
  }

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of readEdges(graph)) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    appendId(outgoing, edge.from, edge.to);
    appendId(incoming, edge.to, edge.from);
  }
  for (const list of outgoing.values()) list.sort(compareText);
  for (const list of incoming.values()) list.sort(compareText);

  const ordered: CitationNode[] = [];
  for (const node of byId.values()) ordered.push(node);
  return { byId, nodes: ordered, outgoing, incoming };
}

function appendId(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/** Nodes for ids, skipping ids the graph does not carry. */
function targetsOf(index: GraphIndex, ids: readonly string[] | undefined): CitationNode[] {
  const nodes: CitationNode[] = [];
  for (const id of ids ?? []) {
    const node = index.byId.get(id);
    if (node !== undefined) nodes.push(node);
  }
  return nodes;
}

function sortByTitle(nodes: CitationNode[]): CitationNode[] {
  return nodes.sort(compareNodes);
}

/** Counted results, highest count first, then title, then id. */
function rankEntities(index: GraphIndex, counts: ReadonlyMap<string, number>): CitationCount[] {
  const entries: CitationCount[] = [];
  for (const [id, count] of counts) {
    const node = index.byId.get(id);
    if (node !== undefined) entries.push({ node, count });
  }
  entries.sort(
    (left, right) =>
      right.count - left.count ||
      compareText(left.node.title, right.node.title) ||
      compareText(left.node.id, right.node.id),
  );
  return entries;
}

// --- Reading inputs --------------------------------------------------------

/** A node as the public shape promises, or `false` for anything else a caller may hold. */
function isNodeLike(value: unknown): value is CitationNode {
  if (value === null || typeof value !== 'object') return false;
  const node = value as Partial<CitationNode>;
  return (
    typeof node.id === 'string' &&
    (node.kind === 'paper' || node.kind === 'stub') &&
    typeof node.title === 'string' &&
    (node.year === null || typeof node.year === 'number') &&
    (node.doi === null || typeof node.doi === 'string')
  );
}

function isEdgeLike(value: unknown): value is CitationEdge {
  if (value === null || typeof value !== 'object') return false;
  const edge = value as Partial<CitationEdge>;
  return (
    typeof edge.from === 'string' &&
    typeof edge.to === 'string' &&
    edge.kind === 'cites' &&
    typeof edge.resolved === 'boolean'
  );
}

/** Nodes of a graph, ignoring anything a runtime caller slipped past the types. */
function readNodes(graph: CitationGraph | null | undefined): CitationNode[] {
  const raw: unknown = graph?.nodes;
  return Array.isArray(raw) ? raw.filter(isNodeLike) : [];
}

/** Edges of a graph, ignoring anything a runtime caller slipped past the types. */
function readEdges(graph: CitationGraph | null | undefined): CitationEdge[] {
  const raw: unknown = graph?.edges;
  return Array.isArray(raw) ? raw.filter(isEdgeLike) : [];
}

function readJsonNode(value: unknown): CitationNode | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = readId(record.id);
  if (id === null) return null;
  if (record.kind !== 'paper' && record.kind !== 'stub') return null;
  if (typeof record.title !== 'string') return null;
  const year = record.year;
  if (year !== null && (typeof year !== 'number' || !Number.isFinite(year))) return null;
  const doi = record.doi;
  if (doi !== null && typeof doi !== 'string') return null;
  return {
    id,
    kind: record.kind,
    title: collapseText(record.title),
    year: year === null ? null : Math.trunc(year),
    doi: typeof doi === 'string' ? doi : null,
  };
}

function readJsonEdge(value: unknown): CitationEdge | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const from = readId(record.from);
  const to = readId(record.to);
  if (from === null || to === null) return null;
  if (record.kind !== 'cites' || typeof record.resolved !== 'boolean') return null;
  return { from, to, kind: 'cites', resolved: record.resolved };
}

// --- Small helpers ---------------------------------------------------------

function recomputeStats(nodes: readonly CitationNode[], edges: readonly CitationEdge[]): CitationGraphStats {
  let papers = 0;
  let stubs = 0;
  for (const node of nodes) {
    if (node.kind === 'paper') papers++;
    else stubs++;
  }
  let resolvedEdges = 0;
  for (const edge of edges) {
    if (edge.resolved) resolvedEdges++;
  }
  return { papers, stubs, resolvedEdges, unresolvedEdges: edges.length - resolvedEdges };
}

/** A usable id: a non-empty string, trimmed so `" p1 "` and `"p1"` are one paper. */
function readId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Four-digit year as a number; accepts `"2020"` because extracted records carry strings. */
function readYear(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const match = /\d{4}/u.exec(value);
    if (match !== null) return Number.parseInt(match[0], 10);
  }
  return null;
}

/** Collapses whitespace runs and trims; used for one-line values such as a title. */
function collapseText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

/**
 * DOI as an identity: resolver prefix and `doi:` label removed, case folded, trimmed.
 * `https://doi.org/10.1000/ABC` and `10.1000/abc` are one DOI.
 */
function normalizeDoi(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '')
    .trim()
    .toLowerCase();
}

/** Title as a matching key: accents decomposed away, letters and digits kept, one space between words. */
function foldTitle(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The same fold as a readable id fragment, with hyphens between words. */
function slugOf(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNodes(left: CitationNode, right: CitationNode): number {
  return compareText(left.title, right.title) || compareText(left.id, right.id);
}

/** A limit of `0` keeps nothing; a missing or unusable one falls back to {@link DEFAULT_LIMIT}. */
function readLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(0, Math.trunc(value));
}

/** What a node is called on the drawing: title and year, or what a stub can offer instead. */
function labelOf(node: CitationNode): string {
  if (node.title.length === 0) return node.doi === null ? node.id : node.doi;
  return node.year === null ? node.title : `${node.title} (${node.year})`;
}

/** A DOT quoted string: backslash and quote escaped, whitespace collapsed to single spaces. */
function dotString(value: string): string {
  let escaped = '';
  for (const character of collapseText(value)) {
    if (character === '\\') escaped += '\\\\';
    else if (character === '"') escaped += '\\"';
    else escaped += character;
  }
  return `"${escaped}"`;
}
