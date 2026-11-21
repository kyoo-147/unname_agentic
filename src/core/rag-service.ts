import {
  abstainMessage,
  assessEvidence,
  DEFAULT_ABSTAIN_LANGUAGE,
  guardAnswer,
  type AbstainLanguage,
  type AnswerGuard,
  type EvidenceAssessment,
} from './abstain';
import {
  AGENT_TOOL_NAMES,
  MAX_PLAN_CALLS,
  validateCall,
  type AgentToolName,
  type ToolCallContext,
  type ToolCallValidation,
} from './agent-tools';
import { parseAnswer, formatPrompt, type ContextBlock, type ParsedAnswer, type Workspace } from './multi-document';
import { rewriteQuery, type QueryFilters, type QueryPlan } from './query';
import {
  index,
  chunkDocument,
  hybridSearch,
  unavailableEmbeddingAdapter,
  type Chunk,
  type ChunkKind,
  type EmbeddingAdapter,
  type EmbeddingStatus,
  type HybridSearchHit,
} from './retrieval';
import {
  resolveCitations,
  type CitationMarker,
  type ResolvedCitation,
} from './citations';
import type { DocumentIR } from './ir';

/** Metadata fields available on the existing retrieval chunk shape. */
export interface RagMetadataFilters {
  documentIds?: readonly string[];
  kinds?: readonly ChunkKind[];
  headingPaths?: readonly string[];
  languages?: readonly string[];
}

/** Caller filters applied before lexical ranking, plus filters inferred by `query.ts`. */
export interface RagFilters {
  /** Workspace document ids. */
  documentIds?: readonly string[];
  /** 1-based source pages. */
  pages?: readonly number[];
  /** Source block ids. A chunk matches when it contains at least one requested id. */
  blockIds?: readonly string[];
  /** Existing chunk and document metadata filters. */
  metadata?: RagMetadataFilters;
  /** Optional year filter for chunks containing the named year. */
  years?: readonly number[];
}

/** One tool call supplied by a host for validation and audit only. */
export interface RagToolCall {
  name: string;
  args: unknown;
}

/** A single auditable tool-policy decision. No tool is executed by this module. */
export interface RagToolTrace {
  step: number;
  name: string;
  args: unknown;
  status: 'allowed' | 'rejected' | 'budget-exhausted';
  reason: 'not-allowlisted' | 'invalid-call' | 'step-budget-exhausted' | null;
  validation: ToolCallValidation | null;
}

/** A caller-supplied transport. It may be an adapter around any model or local system. */
export type RagTransport = (request: RagTransportRequest) => string;

export interface RagTransportRequest {
  question: string;
  prompt: string;
  context: readonly ContextBlock[];
  queryPlans: readonly RagQueryPlan[];
  toolTrace: readonly RagToolTrace[];
}

/** One query rewrite and its document-language context. */
export interface RagQueryPlan {
  documentId: string;
  plan: QueryPlan;
}

/** One lexical hit retained for audit, whether or not it entered the bounded context. */
export interface RagRetrievalHit {
  documentId: string;
  chunkId: string;
  page: number;
  blockIds: string[];
  kind: ChunkKind;
  headingPath: string[];
  /** Fused score exposed for compatibility with the previous lexical result. */
  score: number;
  lexicalScore: number;
  vectorScore: number | null;
  fusedScore: number;
  retrievalMethod: 'lexical' | 'vector' | 'hybrid';
  embeddingStatus: EmbeddingStatus;
  matchedTerms: string[];
  selected: boolean;
}

/** Options for preparing a pure request. */
export interface RagPrepareOptions {
  /** Optional local vector adapter; unavailable adapters keep lexical fallback explicit. */
  embedding?: EmbeddingAdapter;
  lexicalWeight?: number;
  vectorWeight?: number;
  filters?: RagFilters;
  maxContextChars?: number;
  maxExcerptChars?: number;
  minExcerptChars?: number;
  documentShare?: number;
  abstainLanguage?: AbstainLanguage;
  allowedTools?: readonly AgentToolName[];
  maxToolSteps?: number;
  toolContext?: ToolCallContext;
  toolCalls?: readonly RagToolCall[];
}

/** A prepared request. It contains no model output and performs no I/O. */
export interface RagPrepared {
  question: string;
  context: ContextBlock[];
  prompt: string;
  assessment: EvidenceAssessment;
  queryPlans: RagQueryPlan[];
  retrievalHits: RagRetrievalHit[];
  embeddingStatus: EmbeddingStatus;
  retrievalMethod: 'lexical' | 'hybrid';
  toolTrace: RagToolTrace[];
  abstainLanguage: AbstainLanguage;
}

export type RagStatus =
  | 'answer'
  | 'weak'
  | 'abstain'
  | 'unsupported-citation'
  | 'tool-policy-rejected';

/** A citation resolved to every source block represented by a context block. */
export interface RagCitation extends ResolvedCitation {
  documentId: string;
  revisionId: string;
  sourceSha256: string;
  chunkId: string;
}

/** A citation that could not be trusted as evidence for the answer. */
export interface UnsupportedRagCitation {
  index: number;
  documentId: string;
  page: number;
  raw: string;
  count: number;
  reason: 'unknown-document' | 'page-not-in-context' | 'block-not-in-context' | 'region-unresolved';
}

/** Final pure result after a caller-supplied answer has been checked. */
export interface RagResult extends RagPrepared {
  status: RagStatus;
  rawAnswer: string | null;
  answer: string | null;
  citations: RagCitation[];
  unsupportedCitations: UnsupportedRagCitation[];
  guard: AnswerGuard | null;
  abstentionMessage: string;
}

export interface RagServiceOptions {
  embedding?: EmbeddingAdapter;
  lexicalWeight?: number;
  vectorWeight?: number;
  maxContextChars?: number;
  maxExcerptChars?: number;
  minExcerptChars?: number;
  documentShare?: number;
  abstainLanguage?: AbstainLanguage;
  allowedTools?: readonly AgentToolName[];
  maxToolSteps?: number;
}

export interface RagService {
  prepare(question: string, options?: RagPrepareOptions): RagPrepared;
  complete(prepared: RagPrepared, answer: string): RagResult;
  run(question: string, transport: RagTransport, options?: RagPrepareOptions): RagResult;
}

/**
 * Creates a deterministic, multi-document RAG runtime seam.
 *
 * The service owns chunking, lexical retrieval, filtering, context budgeting, prompt
 * fencing, evidence assessment, citation resolution and tool-policy audit. It never
 * calls an LLM, network, clock, DOM or tool executor. A host supplies the answer through
 * `run` or calls `complete` with an already available answer.
 */
export function createRagService(workspace: Workspace, defaults: RagServiceOptions = {}): RagService {
  const documents = usableDocuments(workspace);
  const defaultOptions = normalizeDefaults(defaults);

  return {
    prepare(question, options = {}) {
      return prepareRequest(documents, question, mergeOptions(defaultOptions, options));
    },
    complete(prepared, answer) {
      return completeAnswer(prepared, answer, documents);
    },
    run(question, transport, options = {}) {
      const prepared = prepareRequest(documents, question, mergeOptions(defaultOptions, options));
      if (hasToolPolicyFailure(prepared.toolTrace)) return resultForPolicyFailure(prepared);
      if (prepared.assessment.verdict === 'abstain') return resultForAbstention(prepared);
      return completeAnswer(prepared, transport({
        question: prepared.question,
        prompt: prepared.prompt,
        context: prepared.context,
        queryPlans: prepared.queryPlans,
        toolTrace: prepared.toolTrace,
      }), documents);
    },
  };
}

function prepareRequest(
  documents: readonly WorkspaceDocumentView[],
  question: string,
  options: NormalizedPrepareOptions,
): RagPrepared {
  const text = typeof question === 'string' ? question : '';
  const queryPlans = documents.map(document => ({
    documentId: document.id,
    plan: rewriteQuery(text, { documentTitle: document.title, language: document.ir.language }),
  }));
  const questionFilters = rewriteQuery(text).filters;
  const candidates = collectChunks(documents, options.filters, questionFilters);
  const ranked = rankChunks(candidates, queryPlans, options);
  const context = selectContext(ranked, documents, options);
  const assessment = assessEvidence(text, context);
  const prompt = formatPrompt(fencedContext(context), text);
  const toolTrace = auditToolCalls(options.toolCalls, options);

  const selected = new Set(context.flatMap(block => `${block.documentId}\u0000${block.blockIds.join('\u0001')}\u0000${block.page}`));
  const retrievalHits = ranked.map(hit => ({
    documentId: hit.chunk.documentId,
    chunkId: hit.chunk.id,
    page: hit.chunk.page,
    blockIds: [...hit.chunk.blockIds],
    kind: hit.chunk.kind,
    headingPath: [...hit.chunk.headingPath],
    score: hit.fusedScore,
    lexicalScore: hit.lexicalScore,
    vectorScore: hit.vectorScore,
    fusedScore: hit.fusedScore,
    retrievalMethod: hit.retrievalMethod,
    embeddingStatus: hit.embeddingStatus,
    matchedTerms: [...hit.matchedTerms],
    selected: selected.has(`${hit.chunk.documentId}\u0000${hit.chunk.blockIds.join('\u0001')}\u0000${hit.chunk.page}`),
  }));

  return {
    question: text,
    context,
    prompt,
    assessment,
    queryPlans,
    retrievalHits,
    toolTrace,
    abstainLanguage: options.abstainLanguage,
    embeddingStatus: options.embedding.status,
    retrievalMethod: options.embedding.status.state === 'available' ? 'hybrid' : 'lexical',
  };
}

function completeAnswer(
  prepared: RagPrepared,
  answer: string,
  documents: readonly WorkspaceDocumentView[],
): RagResult {
  if (hasToolPolicyFailure(prepared.toolTrace)) return resultForPolicyFailure(prepared);
  if (prepared.assessment.verdict === 'abstain') return resultForAbstention(prepared, answer);

  const rawAnswer = typeof answer === 'string' ? answer : '';
  const parsed = parseAnswer(rawAnswer, prepared.context);
  const resolved = resolveRagCitations(parsed, prepared.context, documents);
  const guard = guardAnswer(rawAnswer, prepared.assessment);

  if (resolved.unsupported.length > 0) {
    return {
      ...prepared,
      status: 'unsupported-citation',
      rawAnswer,
      answer: null,
      citations: resolved.citations,
      unsupportedCitations: resolved.unsupported,
      guard,
      abstentionMessage: '',
    };
  }

  return {
    ...prepared,
    status: prepared.assessment.verdict === 'weak' ? 'weak' : 'answer',
    rawAnswer,
    answer: guard.ok ? parsed.answer : null,
    citations: resolved.citations,
    unsupportedCitations: [],
    guard,
    abstentionMessage: guard.ok ? abstainMessage(prepared.assessment.verdict, prepared.abstainLanguage) : abstainMessage('abstain', prepared.abstainLanguage),
  };
}

function resultForAbstention(prepared: RagPrepared, rawAnswer: string | null = null): RagResult {
  return {
    ...prepared,
    status: 'abstain',
    rawAnswer,
    answer: null,
    citations: [],
    unsupportedCitations: [],
    guard: null,
    abstentionMessage: abstainMessage('abstain', prepared.abstainLanguage),
  };
}

function resultForPolicyFailure(prepared: RagPrepared): RagResult {
  return {
    ...prepared,
    status: 'tool-policy-rejected',
    rawAnswer: null,
    answer: null,
    citations: [],
    unsupportedCitations: [],
    guard: null,
    abstentionMessage: '',
  };
}

interface WorkspaceDocumentView {
  id: string;
  title: string;
  ir: DocumentIR;
}

interface NormalizedPrepareOptions {
  filters: RagFilters;
  maxContextChars: number;
  maxExcerptChars: number;
  minExcerptChars: number;
  documentShare: number;
  abstainLanguage: AbstainLanguage;
  allowedTools: readonly AgentToolName[];
  maxToolSteps: number;
  embedding: EmbeddingAdapter;
  lexicalWeight: number;
  vectorWeight: number;
  toolContext?: ToolCallContext;
  toolCalls?: readonly RagToolCall[];
}

function normalizeDefaults(options: RagServiceOptions): NormalizedPrepareOptions {
  return {
    filters: {},
    maxContextChars: positiveOr(options.maxContextChars, 6000),
    maxExcerptChars: positiveOr(options.maxExcerptChars, 1200),
    minExcerptChars: positiveOr(options.minExcerptChars, 120),
    documentShare: shareOr(options.documentShare, 0.6),
    abstainLanguage: readLanguage(options.abstainLanguage),
    allowedTools: options.allowedTools ?? AGENT_TOOL_NAMES,
    maxToolSteps: budgetOr(options.maxToolSteps, MAX_PLAN_CALLS),
    embedding: options.embedding ?? unavailableEmbeddingAdapter(),
    lexicalWeight: nonNegative(options.lexicalWeight, 0.5),
    vectorWeight: nonNegative(options.vectorWeight, 0.5),
    toolContext: undefined,
    toolCalls: undefined,
  };
}

function mergeOptions(
  defaults: NormalizedPrepareOptions,
  options: RagPrepareOptions,
): NormalizedPrepareOptions {
  return {
    ...defaults,
    ...options,
    filters: options.filters ?? defaults.filters,
    maxContextChars: positiveOr(options.maxContextChars, defaults.maxContextChars),
    maxExcerptChars: positiveOr(options.maxExcerptChars, defaults.maxExcerptChars),
    minExcerptChars: positiveOr(options.minExcerptChars, defaults.minExcerptChars),
    documentShare: shareOr(options.documentShare, defaults.documentShare),
    abstainLanguage: readLanguage(options.abstainLanguage ?? defaults.abstainLanguage),
    allowedTools: options.allowedTools ?? defaults.allowedTools,
    maxToolSteps: budgetOr(options.maxToolSteps, defaults.maxToolSteps),
    embedding: options.embedding ?? defaults.embedding,
    lexicalWeight: nonNegative(options.lexicalWeight, defaults.lexicalWeight),
    vectorWeight: nonNegative(options.vectorWeight, defaults.vectorWeight),
    toolContext: options.toolContext ?? defaults.toolContext,
    toolCalls: options.toolCalls ?? defaults.toolCalls,
  };
}

function usableDocuments(workspace: Workspace | undefined): WorkspaceDocumentView[] {
  const documents: WorkspaceDocumentView[] = [];
  const seen = new Set<string>();
  for (const document of Array.isArray(workspace?.documents) ? workspace.documents : []) {
    if (!document || typeof document !== 'object' || !document.ir || typeof document.ir !== 'object') continue;
    const id = typeof document.id === 'string' ? document.id.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    documents.push({
      id,
      title: typeof document.title === 'string' && document.title.trim().length > 0 ? document.title.trim() : id,
      ir: document.ir,
    });
  }
  return documents;
}

function collectChunks(
  documents: readonly WorkspaceDocumentView[],
  filters: RagFilters,
  questionFilters: QueryFilters,
): Chunk[] {
  const chunks: Chunk[] = [];
  for (const document of documents) {
    for (const sourceChunk of chunkDocument(document.ir)) {
      const chunk: Chunk = {
        ...sourceChunk,
        id: `${document.id}\u0000${sourceChunk.id}`,
        documentId: document.id,
      };
      if (matchesFilters(chunk, document.ir, filters, questionFilters)) chunks.push(chunk);
    }
  }
  return chunks;
}

function matchesFilters(chunk: Chunk, ir: DocumentIR, filters: RagFilters, question: QueryFilters): boolean {
  const documentIds = filters.documentIds ?? filters.metadata?.documentIds;
  if (documentIds !== undefined && !documentIds.includes(chunk.documentId)) return false;
  if (filters.metadata?.languages !== undefined && !filters.metadata.languages.includes(ir.language)) return false;

  const pages = filters.pages;
  if (pages !== undefined && !pages.includes(chunk.page)) return false;
  if (question.page !== undefined && chunk.page !== question.page) return false;

  const blockIds = filters.blockIds;
  if (blockIds !== undefined && !chunk.blockIds.some(blockId => blockIds.includes(blockId))) return false;
  if (filters.metadata?.kinds !== undefined && !filters.metadata.kinds.includes(chunk.kind)) return false;
  if (filters.metadata?.headingPaths !== undefined && !matchesHeading(chunk.headingPath, filters.metadata.headingPaths)) return false;
  if (question.section !== undefined && !matchesHeading(chunk.headingPath, [question.section])) return false;

  const years = filters.years ?? (question.year === undefined ? undefined : [question.year]);
  if (years !== undefined && !years.some(year => new RegExp(`(?:^|[^0-9])${year}(?:$|[^0-9])`, 'u').test(chunk.text))) return false;
  return true;
}

function rankChunks(
  chunks: readonly Chunk[],
  queryPlans: readonly RagQueryPlan[],
  options: NormalizedPrepareOptions,
): HybridSearchHit[] {
  if (chunks.length === 0) return [];
  const target = index(chunks);
  const merged = new Map<string, HybridSearchHit>();
  const queries = new Set<string>();

  for (const queryPlan of queryPlans) {
    for (const query of queryPlan.plan.queries) {
      const key = query.toLowerCase();
      if (queries.has(key)) continue;
      queries.add(key);
      for (const hit of hybridSearch(target, query, {
        limit: chunks.length,
        embedding: options.embedding,
        lexicalWeight: options.lexicalWeight,
        vectorWeight: options.vectorWeight,
      })) {
        const current = merged.get(hit.chunk.id);
        if (!current) {
          merged.set(hit.chunk.id, { ...hit, matchedTerms: [...hit.matchedTerms] });
          continue;
        }
        if (hit.fusedScore > current.fusedScore) {
          current.score = hit.fusedScore;
          current.fusedScore = hit.fusedScore;
          current.lexicalScore = hit.lexicalScore;
          current.vectorScore = hit.vectorScore;
          current.retrievalMethod = hit.retrievalMethod;
          current.embeddingStatus = hit.embeddingStatus;
        }
        current.matchedTerms = [...new Set([...current.matchedTerms, ...hit.matchedTerms])].sort(compareText);
      }
    }
  }

  return [...merged.values()].sort(
    (left, right) => right.fusedScore - left.fusedScore
      || left.chunk.page - right.chunk.page
      || compareText(left.chunk.documentId, right.chunk.documentId)
      || compareText(left.chunk.id, right.chunk.id),
  );
}

function selectContext(
  ranked: readonly HybridSearchHit[],
  documents: readonly WorkspaceDocumentView[],
  options: NormalizedPrepareOptions,
): ContextBlock[] {
  if (ranked.length === 0) return [];
  const titles = new Map(documents.map(document => [document.id, document.title]));
  const byDocument = new Map<string, HybridSearchHit[]>();
  for (const hit of ranked) {
    const list = byDocument.get(hit.chunk.documentId);
    if (list) list.push(hit);
    else byDocument.set(hit.chunk.documentId, [hit]);
  }

  const matched = documents.map(document => document.id).filter(id => (byDocument.get(id)?.length ?? 0) > 0);
  const perDocumentCap = matched.length > 1 ? Math.floor(options.maxContextChars * options.documentShare) : options.maxContextChars;
  const selected: Array<{ hit: HybridSearchHit; excerpt: string }> = [];
  const allocation = new Map<string, number>();
  const cursor = new Map<string, number>();
  let total = 0;
  let progressed = true;

  while (progressed && total < options.maxContextChars) {
    progressed = false;
    for (const documentId of matched) {
      if (total >= options.maxContextChars) break;
      const hits = byDocument.get(documentId) ?? [];
      const used = allocation.get(documentId) ?? 0;
      const room = Math.min(options.maxContextChars - total, perDocumentCap - used);
      if (room < options.minExcerptChars) continue;
      const at = cursor.get(documentId) ?? 0;
      const hit = hits[at];
      if (!hit) continue;
      cursor.set(documentId, at + 1);
      const excerpt = takeExcerpt(hit.chunk.text, options.maxExcerptChars, room);
      if (excerpt.length === 0) continue;
      const cost = charLength(excerpt);
      selected.push({ hit, excerpt });
      allocation.set(documentId, used + cost);
      total += cost;
      progressed = true;
    }
  }

  selected.sort(
    (left, right) => right.hit.score - left.hit.score
      || compareText(left.hit.chunk.documentId, right.hit.chunk.documentId)
      || left.hit.chunk.page - right.hit.chunk.page
      || compareText(left.hit.chunk.blockIds[0] ?? '', right.hit.chunk.blockIds[0] ?? ''),
  );

  return selected.map((entry, index) => ({
    documentId: entry.hit.chunk.documentId,
    title: titles.get(entry.hit.chunk.documentId) ?? entry.hit.chunk.documentId,
    page: entry.hit.chunk.page,
    blockIds: [...entry.hit.chunk.blockIds],
    excerpt: entry.excerpt,
    rank: index + 1,
    chunkId: entry.hit.chunk.id,
    kind: entry.hit.chunk.kind,
    headingPath: [...entry.hit.chunk.headingPath],
    revisionId: documents.find(document => document.id === entry.hit.chunk.documentId)?.ir.revisionId,
    sourceSha256: documents.find(document => document.id === entry.hit.chunk.documentId)?.ir.sourceSha256,
    lexicalScore: entry.hit.lexicalScore,
    vectorScore: entry.hit.vectorScore,
    fusedScore: entry.hit.fusedScore,
    retrievalMethod: entry.hit.retrievalMethod,
  }));
}

function fencedContext(context: readonly ContextBlock[]): ContextBlock[] {
  return context.map(block => ({
    ...block,
    excerpt: `<retrieved-data document="${escapeAttribute(block.documentId)}" page="${block.page}" blocks="${escapeAttribute(block.blockIds.join(','))}">\n${escapeText(block.excerpt)}\n</retrieved-data>`,
  }));
}

function resolveRagCitations(
  parsed: ParsedAnswer,
  context: readonly ContextBlock[],
  documents: readonly WorkspaceDocumentView[],
): {
  citations: RagCitation[];
  unsupported: UnsupportedRagCitation[];
} {
  const byId = new Map(documents.map(document => [document.id, document]));
  const citations: RagCitation[] = [];
  const seenBlocks = new Set<string>();
  const unsupported: UnsupportedRagCitation[] = parsed.unsupported.map(citation => ({
    index: citation.index,
    documentId: citation.documentId,
    page: citation.page,
    raw: citation.raw,
    count: citation.count,
    reason: citation.reason ?? 'page-not-in-context',
  }));

  for (const citation of parsed.citations.filter(item => item.supported)) {
    const document = byId.get(citation.documentId);
    const blocks = context.filter(
      block => block.documentId === citation.documentId
        && block.page === citation.page
        && (citation.blockId === undefined || block.blockIds.includes(citation.blockId)),
    );
    if (!document || blocks.length === 0) {
      unsupported.push({
        index: citation.index,
        documentId: citation.documentId,
        page: citation.page,
        raw: citation.raw,
        count: citation.count,
        reason: document ? 'page-not-in-context' : 'unknown-document',
      });
      continue;
    }

    let resolvedAny = false;
    for (const contextBlock of blocks) {
      const blockIds = citation.blockId === undefined
        ? contextBlock.blockIds
        : contextBlock.blockIds.filter(blockId => blockId === citation.blockId);
      for (const blockId of blockIds) {
        const marker: CitationMarker = {
          page: citation.page,
          blockId,
          raw: citation.raw,
          index: citation.index,
          count: citation.count,
        };
        const key = `${citation.documentId}\u0000${blockId}`;
        if (seenBlocks.has(key)) continue;
        const resolved = resolveCitations([marker], document.ir).resolved[0];
        if (!resolved) continue;
        resolvedAny = true;
        seenBlocks.add(key);
        citations.push({
          ...resolved,
          documentId: citation.documentId,
          revisionId: document.ir.revisionId,
          sourceSha256: document.ir.sourceSha256,
          chunkId: `${citation.documentId}\u0000${blockId}`,
        });
      }
    }
    if (!resolvedAny) {
      unsupported.push({
        index: citation.index,
        documentId: citation.documentId,
        page: citation.page,
        raw: citation.raw,
        count: citation.count,
        reason: 'region-unresolved',
      });
    }
  }

  return { citations, unsupported };
}

function auditToolCalls(calls: readonly RagToolCall[] | undefined, options: NormalizedPrepareOptions): RagToolTrace[] {
  if (!Array.isArray(calls)) return [];
  const allowed = new Set(options.allowedTools);
  const trace: RagToolTrace[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const step = index + 1;
    if (step > options.maxToolSteps) {
      trace.push({ step, name: call?.name ?? '', args: call?.args, status: 'budget-exhausted', reason: 'step-budget-exhausted', validation: null });
      continue;
    }
    if (!call || typeof call.name !== 'string' || !allowed.has(call.name as AgentToolName)) {
      trace.push({ step, name: call?.name ?? '', args: call?.args, status: 'rejected', reason: 'not-allowlisted', validation: null });
      continue;
    }
    const validation = validateCall(call.name, call.args, options.toolContext);
    trace.push({
      step,
      name: call.name,
      args: call.args,
      status: validation.ok ? 'allowed' : 'rejected',
      reason: validation.ok ? null : 'invalid-call',
      validation,
    });
  }
  return trace;
}

function hasToolPolicyFailure(trace: readonly RagToolTrace[]): boolean {
  return trace.some(event => event.status !== 'allowed');
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function shareOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

function budgetOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function readLanguage(value: AbstainLanguage | undefined): AbstainLanguage {
  return value === 'en' || value === 'zh' || value === 'vi' ? value : DEFAULT_ABSTAIN_LANGUAGE;
}

function matchesHeading(headings: readonly string[], wanted: readonly string[]): boolean {
  return wanted.some(value => {
    const target = normalizeMetadata(value);
    return headings.some(heading => normalizeMetadata(heading) === target || normalizeMetadata(heading).includes(target));
  });
}

function normalizeMetadata(value: string): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/\s+/gu, ' ').trim() : '';
}

function charLength(value: string): number {
  return [...value].length;
}

function takeExcerpt(text: string, maxExcerpt: number, room: number): string {
  const value = typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
  const limit = Math.min(Math.floor(maxExcerpt), Math.floor(room));
  if (value.length === 0 || limit <= 0) return '';
  const characters = [...value];
  if (characters.length <= limit) return value;
  const clipped = characters.slice(0, Math.max(1, limit - 1)).join('').trimEnd();
  return `${clipped}…`;
}

function escapeText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/gu, '&quot;');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
