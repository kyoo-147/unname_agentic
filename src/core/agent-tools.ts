/**
 * The tool contract an agent uses to look at a document (backlog I08).
 *
 * An agent answering questions about a PDF does not get the whole document. It gets a
 * small set of tools, calls them, and quotes what came back. This module is the
 * contract for those calls, in two parts:
 *
 * 1. {@link AGENT_TOOLS} — the six tools an agent may call, each with its parameters
 *    (name, type, required, enum) and the fields its host returns.
 *    {@link validateCall} checks one call before anything executes: shape first, then
 *    geometry against the page sizes the caller knows.
 * 2. {@link planCalls} — a question and what the reader is looking at, turned into a
 *    bounded sequence of candidate calls, each with a reason. A plan is what an agent
 *    executes next; it is not an answer.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network, no I/O. The
 *   same question and context always produce an equal plan, and neither argument is
 *   mutated. Nothing is executed here: no crop is rendered, no OCR runs, no search is
 *   scored, no citation is written. A host owns execution and its cost.
 * - Coordinates are PDF points with the origin at the top-left corner and y growing
 *   downwards, matching `Rect` in `src/core/types.ts`. Pages are 1-based, matching
 *   `Page.index` in `src/core/ir.ts`.
 * - Errors are machine-readable codes plus an English diagnostic for logs and tests,
 *   never UI prose: the same convention `abstain.ts` and `query.ts` use.
 * - Nothing is invented. A region is only cropped when the caller supplied one, a page
 *   is only navigated to when the document has it, and a citation covers the page or
 *   the region that was actually looked at — a citation points at a region, not only at
 *   a page (`citations.ts`, backlog I01).
 *
 * ## The tools
 *
 * | Tool               | What it does                                             | Returns                        |
 * | ------------------ | -------------------------------------------------------- | ------------------------------ |
 * | `navigate_page`    | Scroll the reader to a page.                             | The page now showing.          |
 * | `crop_region`      | Cut a page-space rect out of the page as an image.       | Page, rect, image id.          |
 * | `zoom_region`      | Re-render that rect at a higher scale.                   | Page, rect, scale, image id.   |
 * | `read_region_text` | Read the text of that rect, from the layer or from OCR.  | Page, rect, text, source.      |
 * | `search_document`  | Run one lexical query over the document (BM25).          | Query, ranked hits.            |
 * | `cite_region`      | Write a citation for the page, block or region that was read. | Citation marker, page, region. |
 *
 * `validateCall` reports, in this order: a parameter's presence, its type, its enum
 * value, then geometry (a region on its page), then any argument the tool does not
 * declare. Values are never coerced — an agent sends the JSON type the parameter
 * declares, so `"12"` is not page 12. Geometry is only checked when the caller passes
 * `context.pages`; a call validated without page sizes is checked for shape alone,
 * which is stated rather than assumed.
 *
 * ## The intent table
 *
 * | Intent   | Trigger in the question                          | Calls, in this order                             | Call reason                        |
 * | -------- | ------------------------------------------------ | ------------------------------------------------ | ---------------------------------- |
 * | `page`   | a page number: `page 12`, `p. 12`, `trang 12`, `第12页` | `navigate_page`                            | `page-named`                       |
 * | `region` | a region word: `region`, `figure`, `table`, `vùng`, `hình`, `bảng` | `crop_region`, [`zoom_region`], `read_region_text` | `region-selected`, `region-zoom` |
 * | `search` | a search verb (`search`, `find`, `tìm`), or a quoted span | `search_document`                        | `search-request`, `quoted-term`    |
 * | `cite`   | a citation word: `cite`, `source`, `trích dẫn`, `nguồn` | `cite_region`                              | `citation-request`                 |
 *
 * The pipeline order is fixed — `page`, `region`, `search`, `cite` — so two questions
 * that ask for the same work produce the same sequence. `zoom_region` joins the region
 * intent only when the question also asks to zoom. Triggers are matched over folded
 * whole tokens, so `hình` and `hinh` are the same word and `researcher` is not `search`.
 * The page number and the lexical query behind the `search` call come from
 * `src/core/query.ts`, which already reads `page 12` / `trang 12` and strips the
 * question's language; this module re-implements neither.
 *
 * ## Budget and honesty
 *
 * {@link MAX_PLAN_CALLS} is the default budget, and it is exactly the length of the
 * longest pipeline, so the default can plan every intent. A smaller budget stops the
 * sequence where it is reached, reports `budgetExhausted: true`, and leaves `calls` a
 * prefix of the pipeline — never a re-ordering. `notes` carries what could not be
 * planned (no such page, no region supplied, no search term left), so an agent can say
 * why it did not look instead of looking at something else.
 *
 * `page` in the context is the page the reader already shows; it is the target of a
 * region or a citation when the question names no page. It is not an intent: a question
 * with no trigger produces no calls at all and reports `no-intent`.
 *
 * ## Not here
 *
 * Executing a call, rendering a crop, running OCR, calling a model and recording the
 * trace are the host's. Allowlisting, cost ceilings and per-run step traces are policy
 * on top of this contract, not part of it.
 */

import { quotePhrases, rewriteQuery } from './query';
import type { Rect } from './types';

// --- Public shape ----------------------------------------------------------

/** How a parameter value is checked. */
export type ToolParameterType = 'page' | 'region' | 'string' | 'number' | 'integer' | 'boolean';

/** One argument a tool accepts. */
export interface ToolParameter {
  name: string;
  type: ToolParameterType;
  required: boolean;
  /** Allowed values, for a string parameter that names one of a fixed set. */
  enum?: readonly string[];
  /** One sentence naming the value, in the terms an agent can act on. */
  description: string;
}

/** The kind of value a returned field carries. */
export type ToolReturnFieldType = 'number' | 'string' | 'boolean' | 'rect' | 'array';

/** One field of the object a tool returns. */
export interface ToolReturnField {
  name: string;
  type: ToolReturnFieldType;
  description: string;
}

/** What a host must hand back after a call. */
export interface ToolReturn {
  /** One sentence describing the returned object. */
  summary: string;
  /** Its fields, in the order a caller reads them. */
  fields: readonly ToolReturnField[];
}

/** Every tool this build exposes. */
export type AgentToolName =
  | 'navigate_page'
  | 'crop_region'
  | 'zoom_region'
  | 'read_region_text'
  | 'search_document'
  | 'cite_region';

/** One tool an agent may call. */
export interface AgentTool {
  name: AgentToolName;
  description: string;
  parameters: readonly ToolParameter[];
  returns: ToolReturn;
}

/** A page whose size the caller knows, in points; an IR `Page` fits. */
export interface ToolPageSize {
  index: number;
  width: number;
  height: number;
}

/** What the caller knows about the document, so geometry can be checked. */
export interface ToolCallContext {
  /** Sizes of the pages the document has. Omit to validate shape only. */
  pages?: readonly ToolPageSize[];
}

/** Why a call cannot run. */
export type ToolCallErrorCode =
  | 'unknown-tool'
  | 'missing-parameter'
  | 'unexpected-parameter'
  | 'wrong-type'
  | 'enum-violation'
  | 'unknown-page'
  | 'region-invalid'
  | 'region-outside-page';

/** One concrete reason a call cannot run. */
export interface ToolCallError {
  code: ToolCallErrorCode;
  /** Parameter the error is about; empty for a tool-level error. */
  parameter: string;
  /** English diagnostic for logs and tests; not UI copy. */
  message: string;
}

/** The verdict on one call. */
export interface ToolCallValidation {
  ok: boolean;
  /** Every problem found, in the order documented on {@link validateCall}. */
  errors: ToolCallError[];
  /** The tool the name resolved to; `null` when the name is unknown. */
  tool: AgentTool | null;
}

/** What a planned call is meant to establish. */
export type PlanIntent = 'page' | 'region' | 'search' | 'cite';

/** Why the planner chose one call. */
export type CallReason =
  | 'page-named'
  | 'region-selected'
  | 'region-zoom'
  | 'search-request'
  | 'quoted-term'
  | 'citation-request';

/** Why the plan is shorter than the question asked for. */
export type PlanNote =
  | 'no-intent'
  | 'page-unavailable'
  | 'region-unavailable'
  | 'region-outside-page'
  | 'search-no-terms'
  | 'budget-exhausted';

/** One call the planner proposes, with the reason it is there. */
export interface PlannedCall {
  name: AgentToolName;
  /** Arguments that pass {@link validateCall} against the same context. */
  args: Readonly<Record<string, unknown>>;
  intent: PlanIntent;
  reason: CallReason;
}

/** The reading session a question is asked in. Every field is optional. */
export interface PlanContext {
  /**
   * 1-based page the reader is showing. The target for a region or a citation when the
   * question names no page; never an intent by itself.
   */
  page?: number;
  /**
   * Page-space rect the reader has selected or focused. The only region the planner
   * will crop: it never derives one from a word in the question.
   */
  region?: Rect;
  /** IR block id a citation should name, when the reader has one selected. */
  blockId?: string;
  /** Page sizes of the open document, so a plan only proposes reachable pages. */
  pages?: readonly ToolPageSize[];
  /** Most calls the plan may hold; defaults to {@link MAX_PLAN_CALLS}. */
  maxCalls?: number;
}

/** A bounded sequence of calls, and the record of what could not be planned. */
export interface CallPlan {
  /** Calls to run, in order; empty when the question asked for nothing. */
  calls: PlannedCall[];
  /** Intents the question expressed, in pipeline order. */
  intents: PlanIntent[];
  /**
   * Why work was left out, in the order the decisions were made; `budget-exhausted` and
   * `no-intent` come last.
   */
  notes: PlanNote[];
  /** True when the budget stopped calls the question had asked for. */
  budgetExhausted: boolean;
}

// --- Public constants ------------------------------------------------------

/**
 * Default budget, and the length of the longest pipeline: navigate, crop, zoom, read,
 * search, cite. A caller may lower it; nothing can raise the pipeline past it.
 */
export const MAX_PLAN_CALLS = 6;

/**
 * Slack, in points, allowed between a region and its page edge, so a selection that
 * overhangs by a fraction of a point is not rejected. The same half-point slack the IR
 * allows a polygon corner (`POLYGON_BOUNDS_TOLERANCE` in `src/core/ir.ts`).
 */
export const REGION_BOUNDS_TOLERANCE = 0.5;

/** Scale the planner asks for when the question says to zoom. */
export const PLAN_ZOOM_SCALE = 2;

/** Default hit cap `search_document` documents, matching `retrieval.ts`. */
export const PLAN_SEARCH_LIMIT = 10;

// --- The registry ----------------------------------------------------------

/**
 * The six tools an agent may call, in the order a reader uses them.
 *
 * A tool describes what a host must implement, not how: the descriptions name the page
 * and the region a call acts on, and the `returns` block names the fields the host has
 * to fill so the next call and the final answer have something to quote.
 */
export const AGENT_TOOLS: readonly AgentTool[] = [
  {
    name: 'navigate_page',
    description: 'Scroll the reader to a page of the open document.',
    parameters: [
      { name: 'page', type: 'page', required: true, description: '1-based page number to show.' },
    ],
    returns: {
      summary: 'The page the reader is showing after the call.',
      fields: [{ name: 'page', type: 'number', description: '1-based page the reader scrolled to.' }],
    },
  },
  {
    name: 'crop_region',
    description: 'Cut a page-space rect out of the page as an image an agent can inspect.',
    parameters: [
      { name: 'page', type: 'page', required: true, description: '1-based page the region is on.' },
      {
        name: 'region',
        type: 'region',
        required: true,
        description: 'Rect in page points: x, y, width and height, with a positive area.',
      },
    ],
    returns: {
      summary: 'The page and rect that were cropped, plus the id of the produced image.',
      fields: [
        { name: 'page', type: 'number', description: '1-based page that was cropped.' },
        { name: 'region', type: 'rect', description: 'The rect that was cropped, in page points.' },
        { name: 'imageId', type: 'string', description: 'Opaque id of the image the host produced.' },
      ],
    },
  },
  {
    name: 'zoom_region',
    description: 'Re-render a page-space rect at a higher scale, for small type or a figure.',
    parameters: [
      { name: 'page', type: 'page', required: true, description: '1-based page the region is on.' },
      {
        name: 'region',
        type: 'region',
        required: true,
        description: 'Rect in page points: x, y, width and height, with a positive area.',
      },
      {
        name: 'scale',
        type: 'number',
        required: false,
        description: 'Render scale from 1 to 8; the host picks its own default when omitted.',
      },
    ],
    returns: {
      summary: 'The page, rect and scale that were rendered, plus the id of the image.',
      fields: [
        { name: 'page', type: 'number', description: '1-based page that was rendered.' },
        { name: 'region', type: 'rect', description: 'The rect that was rendered, in page points.' },
        { name: 'scale', type: 'number', description: 'Scale the host actually rendered at.' },
        { name: 'imageId', type: 'string', description: 'Opaque id of the image the host produced.' },
      ],
    },
  },
  {
    name: 'read_region_text',
    description: 'Read the text of a page-space rect, from the text layer or from OCR.',
    parameters: [
      { name: 'page', type: 'page', required: true, description: '1-based page the region is on.' },
      {
        name: 'region',
        type: 'region',
        required: true,
        description: 'Rect in page points: x, y, width and height, with a positive area.',
      },
      {
        name: 'source',
        type: 'string',
        required: false,
        enum: ['auto', 'text-layer', 'ocr'],
        description: 'Where the text comes from; `auto` reads the text layer when the region has one.',
      },
    ],
    returns: {
      summary: 'The text found in the rect, and where it came from.',
      fields: [
        { name: 'page', type: 'number', description: '1-based page that was read.' },
        { name: 'region', type: 'rect', description: 'The rect that was read, in page points.' },
        { name: 'text', type: 'string', description: 'Text found in the rect; empty when there is none.' },
        {
          name: 'source',
          type: 'string',
          description: '`text-layer` or `ocr`: which one actually produced the text.',
        },
      ],
    },
  },
  {
    name: 'search_document',
    description: 'Run one lexical query over the document and rank the passages that match.',
    parameters: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'Search terms, not a question; the planner sends what `query.ts` rewrites.',
      },
      {
        name: 'limit',
        type: 'integer',
        required: false,
        description: `Maximum hits, from 1 to 50; defaults to ${PLAN_SEARCH_LIMIT}.`,
      },
    ],
    returns: {
      summary: 'The query and its ranked hits, best first.',
      fields: [
        { name: 'query', type: 'string', description: 'The query that was run.' },
        {
          name: 'hits',
          type: 'array',
          description: 'Ranked hits, each with page, blockId, text and score (see `retrieval.ts`).',
        },
      ],
    },
  },
  {
    name: 'cite_region',
    description:
      'Write a citation for the page, block or region that was read, in the marker form `citations.ts` parses.',
    parameters: [
      { name: 'page', type: 'page', required: true, description: '1-based page the citation points at.' },
      {
        name: 'region',
        type: 'region',
        required: false,
        description: 'Rect in page points, when the citation covers a region rather than a whole page.',
      },
      {
        name: 'blockId',
        type: 'string',
        required: false,
        description: 'IR block id the citation should name, for example `p12-r3`.',
      },
    ],
    returns: {
      summary: 'The citation marker a reader can click, and the page and region it covers.',
      fields: [
        { name: 'citation', type: 'string', description: 'Marker such as `[p12:r3]` or `[p12]`.' },
        { name: 'page', type: 'number', description: '1-based page the citation points at.' },
        {
          name: 'region',
          type: 'rect',
          description: 'The rect the citation covers, when it names one.',
        },
      ],
    },
  },
];

/** The registry's names, in registry order. */
export const AGENT_TOOL_NAMES: readonly AgentToolName[] = AGENT_TOOLS.map(tool => tool.name);

/**
 * Resolves a tool name. A name that is not a declared string is an unknown tool, so a
 * caller can hand over untrusted JSON without checking the type itself.
 */
export function getTool(name: unknown): AgentTool | null {
  if (typeof name !== 'string') return null;
  for (const tool of AGENT_TOOLS) {
    if (tool.name === name) return tool;
  }
  return null;
}

// --- Validation ------------------------------------------------------------

/**
 * Checks one call before anything runs.
 *
 * Reports, in this order and in a fixed order inside each step:
 * 1. **Presence** — a missing required parameter, or one sent as `null`.
 * 2. **Type** — the JSON type the parameter declares. A page is a whole number of at
 *    least 1; a region is an object with finite `x`, `y`, `width`, `height` and a
 *    strictly positive area; values are not coerced from strings.
 * 3. **Enum** — a value the parameter's closed set does not contain.
 * 4. **Geometry** — a region that leaves its page, or a page the caller's
 *    `context.pages` does not describe. Only checked when the page is known.
 * 5. **Undeclared arguments** — sorted by name, so a misspelt parameter is reported
 *    instead of silently ignored.
 *
 * `ok` is true only when `errors` is empty.
 */
export function validateCall(name: string, args: unknown, context?: ToolCallContext): ToolCallValidation {
  const tool = getTool(name);
  if (tool === null) {
    return {
      ok: false,
      errors: [
        {
          code: 'unknown-tool',
          parameter: '',
          message: `${describeValue(name)} is not a tool; call one of ${AGENT_TOOL_NAMES.join(', ')}.`,
        },
      ],
      tool: null,
    };
  }

  const errors: ToolCallError[] = [];
  const record = isRecord(args) ? args : null;
  if (record === null) {
    errors.push({
      code: 'wrong-type',
      parameter: '',
      message: `${tool.name} takes an argument object; received ${describeValue(args)}.`,
    });
  }

  const pages = pageSizes(context?.pages);
  const regions: Array<{ parameter: string; region: Rect }> = [];

  if (record !== null) {
    for (const parameter of tool.parameters) {
      const value = record[parameter.name];
      if (value === undefined || value === null) {
        if (parameter.required) {
          errors.push({
            code: 'missing-parameter',
            parameter: parameter.name,
            message: `${tool.name} requires ${parameter.name}: ${parameter.description}`,
          });
        }
        continue;
      }

      if (parameter.type === 'region') {
        const region = readRegion(value);
        if (region !== null) {
          regions.push({ parameter: parameter.name, region });
          continue;
        }
        errors.push(
          isRecord(value)
            ? {
                code: 'region-invalid',
                parameter: parameter.name,
                message: `${tool.name}.${parameter.name} needs finite x, y, width and height with a positive area.`,
              }
            : {
                code: 'wrong-type',
                parameter: parameter.name,
                message: `${tool.name}.${parameter.name} must be a region object; received ${describeValue(value)}.`,
              },
        );
        continue;
      }

      if (parameter.type === 'page') {
        const page = readPageNumber(value);
        if (page === null) {
          errors.push({
            code: 'wrong-type',
            parameter: parameter.name,
            message: `${tool.name}.${parameter.name} must be a whole page number of at least 1; received ${describeValue(value)}.`,
          });
          continue;
        }
        if (pages.length > 0 && !hasPage(pages, page)) {
          errors.push({
            code: 'unknown-page',
            parameter: parameter.name,
            message: `${tool.name}.${parameter.name} names page ${page}, which the document does not have.`,
          });
        }
        continue;
      }

      if (parameter.type === 'string') {
        if (typeof value !== 'string') {
          errors.push({
            code: 'wrong-type',
            parameter: parameter.name,
            message: `${tool.name}.${parameter.name} must be a string; received ${describeValue(value)}.`,
          });
          continue;
        }
        if (parameter.required && value.trim().length === 0) {
          errors.push({
            code: 'missing-parameter',
            parameter: parameter.name,
            message: `${tool.name}.${parameter.name} must not be empty: ${parameter.description}`,
          });
          continue;
        }
        if (parameter.enum !== undefined && !parameter.enum.includes(value)) {
          errors.push({
            code: 'enum-violation',
            parameter: parameter.name,
            message: `${tool.name}.${parameter.name} must be one of ${parameter.enum.join(' | ')}; received ${describeValue(value)}.`,
          });
        }
        continue;
      }

      const typeOk =
        parameter.type === 'boolean'
          ? typeof value === 'boolean'
          : parameter.type === 'integer'
            ? Number.isInteger(value as number)
            : typeof value === 'number' && Number.isFinite(value);
      if (!typeOk) {
        errors.push({
          code: 'wrong-type',
          parameter: parameter.name,
          message: `${tool.name}.${parameter.name} must be ${typeDescription(parameter.type)}; received ${describeValue(value)}.`,
        });
      }
    }

    // Geometry last, and only for a region whose page the caller described: a region on
    // an unknown page has nothing to be measured against.
    const pageNumber = readPageNumber(record['page']);
    const size = pageNumber === null ? null : pageSizeOf(pages, pageNumber);
    if (size !== null) {
      for (const entry of regions) {
        if (regionInsidePage(entry.region, size)) continue;
        errors.push({
          code: 'region-outside-page',
          parameter: entry.parameter,
          message: `${tool.name}.${entry.parameter} covers (${entry.region.x}, ${entry.region.y}, ${entry.region.width}x${entry.region.height}), which leaves page ${size.index} (${size.width}x${size.height}).`,
        });
      }
    }

    const declared = new Set(tool.parameters.map(parameter => parameter.name));
    const undeclared = Object.keys(record)
      .filter(key => !declared.has(key))
      .sort(compareText);
    for (const key of undeclared) {
      errors.push({
        code: 'unexpected-parameter',
        parameter: key,
        message: `${tool.name} has no parameter ${key}.`,
      });
    }
  }

  return { ok: errors.length === 0, errors, tool };
}

/**
 * True when `region` stays on `page`, allowing {@link REGION_BOUNDS_TOLERANCE} of slack
 * at every edge. A region with no area is not inside anything, so it is refused here;
 * {@link validateCall} reports that case as `region-invalid` first.
 *
 * Exported because the planner and a host both need the same rule: a crop the reader
 * cannot make is not a crop.
 */
export function regionInsidePage(region: Rect, page: { width: number; height: number }): boolean {
  if (region.width <= 0 || region.height <= 0) return false;
  const slack = REGION_BOUNDS_TOLERANCE;
  return (
    region.x >= -slack &&
    region.y >= -slack &&
    region.x + region.width <= page.width + slack &&
    region.y + region.height <= page.height + slack
  );
}

// --- Planning --------------------------------------------------------------

/**
 * Turns a question into the calls an agent would make to answer it.
 *
 * The steps, in order:
 * 1. Read the page number and the search query from `query.ts`'s rewrite of the
 *    question, and the triggers from the question's folded tokens (the intent table at
 *    the top of this module).
 * 2. Resolve the target page: the page the question names, then `context.page`, then the
 *    document's first page, then page 1.
 * 3. Emit the pipeline in its fixed order — navigate, crop, zoom, read, search, cite —
 *    skipping an intent the context cannot support and recording why in `notes`.
 * 4. Cut the sequence at the budget and report `budgetExhausted` when something was cut.
 *
 * A call is only emitted with arguments the same context validates: a page the document
 * does not have and a region that leaves its page are reported in `notes` instead.
 * Triggers are matched accent-insensitively, so `hình` and `hinh` plan the same call.
 */
export function planCalls(question: string, context?: PlanContext): CallPlan {
  const ctx: PlanContext = context ?? {};
  const text = typeof question === 'string' ? question.trim() : '';
  const pages = pageSizes(ctx.pages);
  const budget = readBudget(ctx.maxCalls);

  const tokens = phraseTokens(text);
  const quotes = quotePhrases(text);
  const filters = rewriteQuery(text).filters;

  const namedPage = readPageNumber(filters.page);
  const targetPage = namedPage ?? readPageNumber(ctx.page) ?? readPageNumber(pages[0]?.index) ?? 1;

  const wantsPage = namedPage !== null;
  const wantsRegion = containsAny(tokens, REGION_TRIGGERS);
  const wantsZoom = containsAny(tokens, ZOOM_TRIGGERS);
  const wantsSearch = containsAny(tokens, SEARCH_TRIGGERS) || quotes.length > 0;
  const wantsCite = containsAny(tokens, CITE_TRIGGERS);

  const pageUsable = pages.length === 0 || hasPage(pages, targetPage);
  const size = pageSizeOf(pages, targetPage);
  const region = readRegion(ctx.region);
  const regionUsable = region !== null && (size === null || regionInsidePage(region, size));

  const intents: PlanIntent[] = [];
  if (wantsPage) intents.push('page');
  if (wantsRegion) intents.push('region');
  if (wantsSearch) intents.push('search');
  if (wantsCite) intents.push('cite');

  const notes: PlanNote[] = [];
  const candidates: PlannedCall[] = [];

  if (!pageUsable && (wantsPage || wantsRegion || wantsCite)) {
    notes.push('page-unavailable');
  }

  if (wantsPage && pageUsable) {
    candidates.push({
      name: 'navigate_page',
      args: { page: targetPage },
      intent: 'page',
      reason: 'page-named',
    });
  }

  // A region needs a page the document has: when it does not, the page note above is the
  // reason nothing was cropped, and repeating it would read as two separate faults.
  if (wantsRegion && pageUsable) {
    if (region === null) {
      notes.push('region-unavailable');
    } else if (!regionUsable) {
      notes.push('region-outside-page');
    } else {
      candidates.push({
        name: 'crop_region',
        args: { page: targetPage, region: copyRect(region) },
        intent: 'region',
        reason: 'region-selected',
      });
      if (wantsZoom) {
        candidates.push({
          name: 'zoom_region',
          args: { page: targetPage, region: copyRect(region), scale: PLAN_ZOOM_SCALE },
          intent: 'region',
          reason: 'region-zoom',
        });
      }
      candidates.push({
        name: 'read_region_text',
        args: { page: targetPage, region: copyRect(region) },
        intent: 'region',
        reason: 'region-selected',
      });
    }
  }

  if (wantsSearch) {
    const query = resolveSearchQuery(text, quotes);
    if (query.length === 0) {
      notes.push('search-no-terms');
    } else {
      candidates.push({
        name: 'search_document',
        args: { query },
        intent: 'search',
        reason: quotes.length > 0 ? 'quoted-term' : 'search-request',
      });
    }
  }

  if (wantsCite && pageUsable) {
    const args: Record<string, unknown> = { page: targetPage };
    if (region !== null && regionUsable) args['region'] = copyRect(region);
    const blockId = typeof ctx.blockId === 'string' ? ctx.blockId.trim() : '';
    if (blockId.length > 0) args['blockId'] = blockId;
    candidates.push({
      name: 'cite_region',
      args,
      intent: 'cite',
      reason: 'citation-request',
    });
  }

  const calls = candidates.slice(0, budget);
  const budgetExhausted = candidates.length > calls.length;
  if (budgetExhausted) notes.push('budget-exhausted');
  if (intents.length === 0) notes.push('no-intent');

  return { calls, intents, notes, budgetExhausted };
}

// --- Intent vocabulary -----------------------------------------------------

/**
 * Words that ask for a region. Matched as folded whole tokens, so an inflection such as
 * `figures` needs its own entry instead of matching inside a word.
 */
const REGION_TRIGGERS: readonly (readonly string[])[] = wordPhrases(
  'region regions area areas zone zones crop figure figures table tables diagram diagrams ' +
    'chart charts image images picture pictures graph graphs close-up ' +
    'vùng hình bảng biểu-đồ sơ-đồ khoanh',
);

/** Words that ask for a closer look; they add `zoom_region` to the region intent. */
const ZOOM_TRIGGERS: readonly (readonly string[])[] = wordPhrases(
  'zoom zooms zoomed zooming zoom-in enlarge enlarges enlarged magnify magnifies magnified ' +
    'close-up phóng phóng-to phóng-đại',
);

/** Words that ask to search the document. A quoted span asks for one on its own. */
const SEARCH_TRIGGERS: readonly (readonly string[])[] = wordPhrases(
  'search searches searched searching find finds finding look-up look-for locate locates ' +
    'tìm tìm-kiếm tra-cứu',
);

/** Words that ask where something comes from. */
const CITE_TRIGGERS: readonly (readonly string[])[] = wordPhrases(
  'cite cites cited citing citation citations reference references source sources quote quotes ' +
    'trích-dẫn nguồn dẫn-nguồn',
);

// --- Planning helpers ------------------------------------------------------

/** The search term behind a `search_document` call: the quote if there is one. */
function resolveSearchQuery(text: string, quotes: readonly string[]): string {
  const quoted = quotes[0];
  if (quoted !== undefined) return quoted.trim();
  const rewritten = rewriteQuery(stripSearchRequest(text));
  return (rewritten.queries[0] ?? '').trim();
}

/**
 * Removes the request scaffolding a search question starts with, so the query contains
 * the term and not the verb: `search for payment terms` searches `payment terms`.
 */
function stripSearchRequest(text: string): string {
  const stripped = text.replace(SEARCH_REQUEST, '');
  return stripped.length === 0 ? '' : stripped.trim();
}

/**
 * `search for`, `find`, `look up`, `tìm kiếm` and the like. The accent-less Vietnamese
 * forms are recognised by `SEARCH_TRIGGERS`, but only the accented spelling is stripped:
 * removing `tim` would turn an English name into a search term.
 */
const SEARCH_REQUEST =
  /^(?:please\s+|hãy\s+)?(?:search(?:\s+(?:the\s+|this\s+)?(?:document|doc|pdf))?(?:\s+for)?|look\s+up|look\s+for|find|locate|tìm\s*kiếm|tra\s*cứu|tìm)(?=[\s:,.;!?"'“]|$)\s*[:,-]?\s*/iu;

/** Reads the budget: absent or malformed keeps the default, and 0 means no calls. */
function readBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_PLAN_CALLS;
  const budget = Math.floor(value);
  return budget < 0 ? MAX_PLAN_CALLS : budget;
}

// --- Region and page helpers -----------------------------------------------

/** Reads a usable region: finite corners and a strictly positive area. */
function readRegion(value: unknown): Rect | null {
  if (!isRecord(value)) return null;
  const x = numberOrNull(value['x']);
  const y = numberOrNull(value['y']);
  const width = numberOrNull(value['width']);
  const height = numberOrNull(value['height']);
  if (x === null || y === null || width === null || height === null) return null;
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

function copyRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** Reads a 1-based page number, or `null` when the value is not one. */
function readPageNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

/** The page sizes of a context, with every entry that is not a page dropped. */
function pageSizes(input: unknown): ToolPageSize[] {
  const sizes: ToolPageSize[] = [];
  for (const entry of Array.isArray(input) ? input : []) {
    if (!isRecord(entry)) continue;
    const index = readPageNumber(entry['index']);
    const width = numberOrNull(entry['width']);
    const height = numberOrNull(entry['height']);
    if (index === null || width === null || height === null) continue;
    if (!(width > 0) || !(height > 0)) continue;
    sizes.push({ index, width, height });
  }
  return sizes;
}

function hasPage(pages: readonly ToolPageSize[], index: number): boolean {
  return pages.some(page => page.index === index);
}

function pageSizeOf(pages: readonly ToolPageSize[], index: number): ToolPageSize | null {
  for (const page of pages) {
    if (page.index === index) return page;
  }
  return null;
}

// --- Text helpers ----------------------------------------------------------

/** The question's folded tokens, which every trigger is matched against. */
function phraseTokens(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 0);
}

/** Splits a space-separated trigger list into folded token phrases, once, at load. */
function wordPhrases(source: string): ReadonlyArray<readonly string[]> {
  const phrases: Array<readonly string[]> = [];
  for (const word of source.split(/\s+/u)) {
    const tokens = phraseTokens(word);
    if (tokens.length > 0) phrases.push(tokens);
  }
  return phrases;
}

/** True when any phrase appears in `tokens` as consecutive whole tokens. */
function containsAny(tokens: readonly string[], phrases: ReadonlyArray<readonly string[]>): boolean {
  for (const phrase of phrases) {
    if (containsPhrase(tokens, phrase)) return true;
  }
  return false;
}

function containsPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
    let matched = true;
    for (let at = 0; at < phrase.length; at += 1) {
      if (tokens[start + at] !== phrase[at]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Lowercases, decomposes and drops combining marks, and folds `đ`, so `hình` and `hinh`
 * are one word. The same fold `retrieval.ts` uses for terms, repeated here because
 * trigger matching must not depend on the index.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/gu, 'd');
}

// --- Small helpers ---------------------------------------------------------

function typeDescription(type: ToolParameterType): string {
  switch (type) {
    case 'page':
      return 'a whole page number of at least 1';
    case 'region':
      return 'a region object';
    case 'string':
      return 'a string';
    case 'number':
      return 'a finite number';
    case 'integer':
      return 'a whole number';
    case 'boolean':
      return 'a boolean';
  }
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `the string "${value}"`;
  return `${typeof value} ${String(value)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Runtime limits for executing already-validated calls. */
export interface ToolExecutionLimits {
  maxSteps?: number;
  maxBytes?: number;
  maxMilliseconds?: number;
  signal?: AbortSignal;
}

export type ToolExecutor = (args: Readonly<Record<string, unknown>>, context: {
  signal: AbortSignal;
  step: number;
}) => unknown | Promise<unknown>;

export interface ToolExecutionEvent {
  step: number;
  name: string;
  status: 'completed' | 'rejected' | 'budget-exhausted' | 'cancelled' | 'failed';
  bytesIn: number;
  bytesOut: number;
  elapsedMs: number;
  reason: string | null;
  validation: ToolCallValidation | null;
}

export interface ToolExecutionRun {
  results: unknown[];
  events: ToolExecutionEvent[];
  bytesUsed: number;
  elapsedMs: number;
}

/**
 * Executes an allowlisted tool sequence with step, byte, time and cancellation gates.
 * The host still owns the actual tool implementations; this wrapper makes policy and
 * audit ordering explicit and never turns a rejected call into evidence.
 */
export async function executeToolCalls(
  calls: readonly { name: string; args: unknown }[],
  executors: Readonly<Partial<Record<AgentToolName, ToolExecutor>>>,
  options: {
    allowedTools?: readonly AgentToolName[];
    context?: ToolCallContext;
    limits?: ToolExecutionLimits;
    onEvent?: (event: ToolExecutionEvent) => void;
  } = {},
): Promise<ToolExecutionRun> {
  const started = nowMs();
  const limits = options.limits ?? {};
  const maxSteps = finiteFloor(limits.maxSteps, MAX_PLAN_CALLS);
  const maxBytes = finitePositive(limits.maxBytes, Number.POSITIVE_INFINITY);
  const maxMilliseconds = finitePositive(limits.maxMilliseconds, Number.POSITIVE_INFINITY);
  const allowed = new Set(options.allowedTools ?? AGENT_TOOL_NAMES);
  const controller = new AbortController();
  const signal = controller.signal;
  const external = limits.signal;
  const abortExternal = (): void => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', abortExternal, { once: true });

  const results: unknown[] = [];
  const events: ToolExecutionEvent[] = [];
  let bytesUsed = 0;
  try {
    for (let index = 0; index < (Array.isArray(calls) ? calls.length : 0); index += 1) {
      const call = calls[index];
      const step = index + 1;
      const name = typeof call?.name === 'string' ? call.name : '';
      const args = isRecord(call?.args) ? call.args : {};
      const bytesIn = utf8Bytes(JSON.stringify(args));
      const elapsedBefore = nowMs() - started;
      if (step > maxSteps || bytesUsed + bytesIn > maxBytes || elapsedBefore > maxMilliseconds) {
        const event = executionEvent(step, name, 'budget-exhausted', bytesIn, 0, elapsedBefore, 'execution budget exhausted', null);
        events.push(event);
        options.onEvent?.(event);
        continue;
      }
      if (signal.aborted) {
        const event = executionEvent(step, name, 'cancelled', bytesIn, 0, elapsedBefore, 'cancelled', null);
        events.push(event);
        options.onEvent?.(event);
        break;
      }
      if (!allowed.has(name as AgentToolName)) {
        const event = executionEvent(step, name, 'rejected', bytesIn, 0, elapsedBefore, 'tool is not allowlisted', null);
        events.push(event);
        options.onEvent?.(event);
        continue;
      }
      const validation = validateCall(name, args, options.context);
      if (!validation.ok) {
        const event = executionEvent(step, name, 'rejected', bytesIn, 0, nowMs() - started, 'invalid call', validation);
        events.push(event);
        options.onEvent?.(event);
        continue;
      }
      const executor = executors[name as AgentToolName];
      if (typeof executor !== 'function') {
        const event = executionEvent(step, name, 'rejected', bytesIn, 0, nowMs() - started, 'no executor registered', validation);
        events.push(event);
        options.onEvent?.(event);
        continue;
      }
      try {
        const value = await withTimeout(Promise.resolve(executor(args, { signal, step })), maxMilliseconds - (nowMs() - started));
        if (signal.aborted) {
          const event = executionEvent(step, name, 'cancelled', bytesIn, 0, nowMs() - started, 'cancelled', validation);
          events.push(event);
          options.onEvent?.(event);
          break;
        }
        const bytesOut = utf8Bytes(JSON.stringify(value));
        if (bytesUsed + bytesIn + bytesOut > maxBytes) {
          const event = executionEvent(step, name, 'budget-exhausted', bytesIn, bytesOut, nowMs() - started, 'byte budget exhausted', validation);
          events.push(event);
          options.onEvent?.(event);
          continue;
        }
        bytesUsed += bytesIn + bytesOut;
        results.push(value);
        const event = executionEvent(step, name, 'completed', bytesIn, bytesOut, nowMs() - started, null, validation);
        events.push(event);
        options.onEvent?.(event);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const event = executionEvent(step, name, 'failed', bytesIn, 0, nowMs() - started, reason, validation);
        events.push(event);
        options.onEvent?.(event);
      }
    }
  } finally {
    external?.removeEventListener('abort', abortExternal);
  }
  return { results, events, bytesUsed, elapsedMs: nowMs() - started };
}

function executionEvent(
  step: number,
  name: string,
  status: ToolExecutionEvent['status'],
  bytesIn: number,
  bytesOut: number,
  elapsedMs: number,
  reason: string | null,
  validation: ToolCallValidation | null,
): ToolExecutionEvent {
  return { step, name, status, bytesIn, bytesOut, elapsedMs, reason, validation };
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  if (!Number.isFinite(milliseconds)) return promise;
  if (milliseconds <= 0) return Promise.reject(new Error('execution time budget exhausted'));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('execution time budget exhausted')), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(typeof value === 'string' ? value : '').byteLength;
}

function finiteFloor(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
