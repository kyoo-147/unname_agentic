import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  MAX_PLAN_CALLS,
  PLAN_ZOOM_SCALE,
  REGION_BOUNDS_TOLERANCE,
  getTool,
  planCalls,
  regionInsidePage,
  validateCall,
  executeToolCalls,
} from '../viewer/src/core/agent-tools';
import type { AgentToolName, ToolCallValidation, ToolPageSize } from '../viewer/src/core/agent-tools';

const A4_WIDTH = 595;
const A4_HEIGHT = 842;

function page(index: number): ToolPageSize {
  return { index, width: A4_WIDTH, height: A4_HEIGHT };
}

const PAGES: readonly ToolPageSize[] = [1, 2, 3, 4].map(page);

/** A rect on A4, well clear of every edge. */
const REGION = { x: 40, y: 60, width: 200, height: 120 };

/** The smallest argument object each tool accepts, used to prove the registry validates. */
const MINIMAL_ARGS: Record<AgentToolName, Record<string, unknown>> = {
  navigate_page: { page: 1 },
  crop_region: { page: 1, region: { x: 10, y: 20, width: 100, height: 50 } },
  zoom_region: { page: 1, region: { x: 10, y: 20, width: 100, height: 50 } },
  read_region_text: { page: 1, region: { x: 10, y: 20, width: 100, height: 50 } },
  search_document: { query: 'termination' },
  cite_region: { page: 1 },
};

/** The question that exercises every intent: page, region, zoom, search and cite. */
const RICH_QUESTION = 'Zoom into the figure on page 4, search for "revenue", and cite the source.';

function codesOf(validation: ToolCallValidation): string[] {
  return validation.errors.map(error => error.code);
}

function paramsOf(validation: ToolCallValidation): string[] {
  return validation.errors.map(error => error.parameter);
}

describe('agent tool registry', () => {
  it('exposes the six documented tools in order', () => {
    expect([...AGENT_TOOL_NAMES]).toEqual([
      'navigate_page',
      'crop_region',
      'zoom_region',
      'read_region_text',
      'search_document',
      'cite_region',
    ]);
    expect(AGENT_TOOL_NAMES).toEqual(AGENT_TOOLS.map(tool => tool.name));
  });

  it('documents every tool, parameter and returned field', () => {
    const names = new Set<string>();
    for (const tool of AGENT_TOOLS) {
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.parameters.length).toBeGreaterThan(0);
      expect(tool.returns.summary.length).toBeGreaterThan(10);
      expect(tool.returns.fields.length).toBeGreaterThan(0);

      for (const parameter of tool.parameters) {
        expect(parameter.name.length).toBeGreaterThan(0);
        expect(parameter.description.length).toBeGreaterThan(0);
        expect(typeof parameter.required).toBe('boolean');
        if (parameter.enum !== undefined) {
          expect(parameter.type).toBe('string');
          expect(parameter.enum.length).toBeGreaterThan(1);
        }
      }
      for (const field of tool.returns.fields) {
        expect(field.name.length).toBeGreaterThan(0);
        expect(field.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('resolves a tool by name and refuses anything else', () => {
    expect(getTool('crop_region')?.name).toBe('crop_region');
    expect(getTool('nope')).toBeNull();
    expect(getTool(null)).toBeNull();
    expect(getTool(7)).toBeNull();
  });

  it('accepts the smallest valid call for every tool', () => {
    for (const tool of AGENT_TOOLS) {
      const validation = validateCall(tool.name, MINIMAL_ARGS[tool.name], { pages: PAGES });
      expect(validation.tool?.name).toBe(tool.name);
      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
    }
  });
});

describe('validateCall: argument shape', () => {
  it('reports an unknown tool', () => {
    const validation = validateCall('read_pixels', { page: 1 });

    expect(validation.ok).toBe(false);
    expect(validation.tool).toBeNull();
    expect(codesOf(validation)).toEqual(['unknown-tool']);
  });

  it('reports a missing required parameter', () => {
    const validation = validateCall('crop_region', { page: 1 }, { pages: PAGES });

    expect(validation.ok).toBe(false);
    expect(codesOf(validation)).toEqual(['missing-parameter']);
    expect(paramsOf(validation)).toEqual(['region']);
  });

  it('reports a required string that is present but empty', () => {
    const validation = validateCall('search_document', { query: '   ' });

    expect(codesOf(validation)).toEqual(['missing-parameter']);
    expect(paramsOf(validation)).toEqual(['query']);
  });

  it('reports a wrong type and never coerces from a string', () => {
    const validation = validateCall('navigate_page', { page: '12' });

    expect(codesOf(validation)).toEqual(['wrong-type']);
    expect(paramsOf(validation)).toEqual(['page']);
  });

  it('reports a page that is not a whole page number', () => {
    expect(codesOf(validateCall('navigate_page', { page: 0 }))).toEqual(['wrong-type']);
    expect(codesOf(validateCall('navigate_page', { page: 1.5 }))).toEqual(['wrong-type']);
  });

  it('reports a region that is not an object', () => {
    const validation = validateCall('read_region_text', { page: 1, region: 'the figure' });

    expect(codesOf(validation)).toEqual(['wrong-type']);
    expect(paramsOf(validation)).toEqual(['region']);
  });

  it('reports a region with no area', () => {
    const validation = validateCall('crop_region', {
      page: 1,
      region: { x: 10, y: 20, width: 0, height: 40 },
    });

    expect(codesOf(validation)).toEqual(['region-invalid']);
    expect(paramsOf(validation)).toEqual(['region']);
  });

  it('reports a value outside a parameter enum', () => {
    const validation = validateCall('read_region_text', {
      page: 1,
      region: REGION,
      source: 'pixels',
    });

    expect(validation.ok).toBe(false);
    expect(codesOf(validation)).toEqual(['enum-violation']);
    expect(paramsOf(validation)).toEqual(['source']);
  });

  it('accepts every value of a parameter enum', () => {
    for (const source of ['auto', 'text-layer', 'ocr']) {
      expect(validateCall('read_region_text', { page: 1, region: REGION, source }).ok).toBe(true);
    }
  });

  it('reports an argument the tool does not declare', () => {
    const validation = validateCall('navigate_page', { page: 1, blockId: 'p1-r0' });

    expect(codesOf(validation)).toEqual(['unexpected-parameter']);
    expect(paramsOf(validation)).toEqual(['blockId']);
  });

  it('reports arguments that are not an object at all', () => {
    const validation = validateCall('navigate_page', null);

    expect(codesOf(validation)).toEqual(['wrong-type']);
    expect(validation.tool?.name).toBe('navigate_page');
  });

  it('keeps one error per parameter, in declaration order', () => {
    const validation = validateCall('read_region_text', { page: 0, region: { x: 0 } });

    expect(paramsOf(validation)).toEqual(['page', 'region']);
    expect(codesOf(validation)).toEqual(['wrong-type', 'region-invalid']);
  });
});

describe('validateCall: geometry', () => {
  it('reports a region that leaves its page', () => {
    const validation = validateCall(
      'crop_region',
      { page: 1, region: { x: 560, y: 60, width: 60, height: 40 } },
      { pages: PAGES },
    );

    expect(codesOf(validation)).toEqual(['region-outside-page']);
    expect(paramsOf(validation)).toEqual(['region']);
  });

  it('allows the documented half-point slack at a page edge', () => {
    expect(REGION_BOUNDS_TOLERANCE).toBe(0.5);
    expect(regionInsidePage({ x: -0.4, y: 0, width: 10, height: 10 }, { width: A4_WIDTH, height: A4_HEIGHT })).toBe(true);
    expect(regionInsidePage({ x: -0.6, y: 0, width: 10, height: 10 }, { width: A4_WIDTH, height: A4_HEIGHT })).toBe(false);
  });

  it('checks geometry only when the caller describes the page', () => {
    const offPage = { x: 5000, y: 5000, width: 100, height: 100 };

    expect(validateCall('crop_region', { page: 1, region: offPage }).ok).toBe(true);
    expect(codesOf(validateCall('crop_region', { page: 1, region: offPage }, { pages: PAGES }))).toEqual([
      'region-outside-page',
    ]);
  });

  it('reports a page the document does not have', () => {
    const validation = validateCall('navigate_page', { page: 9 }, { pages: PAGES });

    expect(codesOf(validation)).toEqual(['unknown-page']);
    expect(paramsOf(validation)).toEqual(['page']);
  });

  it('accepts a citation that covers only a page', () => {
    expect(validateCall('cite_region', { page: 3 }, { pages: PAGES }).ok).toBe(true);
  });
});

describe('planCalls: page intent', () => {
  it('navigates for a question that names a page', () => {
    const plan = planCalls('What is on page 12?');

    expect(plan.intents).toEqual(['page']);
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.name).toBe('navigate_page');
    expect(plan.calls[0]?.args).toEqual({ page: 12 });
    expect(plan.calls[0]?.intent).toBe('page');
    expect(plan.calls[0]?.reason).toBe('page-named');
    expect(plan.notes).toEqual([]);
    expect(plan.budgetExhausted).toBe(false);
  });

  it('reads the Vietnamese page form too', () => {
    const plan = planCalls('Trang 3 nói gì?');

    expect(plan.calls[0]?.name).toBe('navigate_page');
    expect(plan.calls[0]?.args).toEqual({ page: 3 });
  });

  it('does not treat the page being read as an intent', () => {
    const plan = planCalls('What does this say?', { page: 3, pages: PAGES });

    expect(plan.intents).toEqual([]);
    expect(plan.calls).toEqual([]);
    expect(plan.notes).toEqual(['no-intent']);
  });

  it('does not plan a page the document does not have', () => {
    const plan = planCalls('What is on page 9?', { pages: PAGES });

    expect(plan.intents).toEqual(['page']);
    expect(plan.calls).toEqual([]);
    expect(plan.notes).toEqual(['page-unavailable']);
  });
});

describe('planCalls: region intent', () => {
  it('crops and reads the region the reader selected', () => {
    const plan = planCalls('Read the text in the selected region.', { page: 2, region: REGION, pages: PAGES });

    expect(plan.intents).toEqual(['region']);
    expect(plan.calls.map(call => call.name)).toEqual(['crop_region', 'read_region_text']);
    expect(plan.calls.map(call => call.intent)).toEqual(['region', 'region']);
    expect(plan.calls[0]?.args).toEqual({ page: 2, region: REGION });
    expect(plan.calls[0]?.reason).toBe('region-selected');
    expect(plan.notes).toEqual([]);
  });

  it('adds a zoom when the question asks for one', () => {
    const plan = planCalls('Zoom into the chart on page 2.', { page: 2, region: REGION, pages: PAGES });

    expect(plan.intents).toEqual(['page', 'region']);
    expect(plan.calls.map(call => call.name)).toEqual([
      'navigate_page',
      'crop_region',
      'zoom_region',
      'read_region_text',
    ]);
    expect(plan.calls[2]?.args).toEqual({ page: 2, region: REGION, scale: PLAN_ZOOM_SCALE });
    expect(plan.calls[2]?.reason).toBe('region-zoom');
  });

  it('never invents a region the reader did not supply', () => {
    const plan = planCalls('Crop the figure.');

    expect(plan.intents).toEqual(['region']);
    expect(plan.calls).toEqual([]);
    expect(plan.notes).toEqual(['region-unavailable']);
  });

  it('refuses a region that leaves the page instead of planning an invalid crop', () => {
    const plan = planCalls('Crop the figure.', {
      page: 1,
      region: { x: 560, y: 60, width: 60, height: 40 },
      pages: PAGES,
    });

    expect(plan.calls).toEqual([]);
    expect(plan.notes).toEqual(['region-outside-page']);
  });

  it('reports the missing page, not the region, when the page is not in the document', () => {
    const plan = planCalls('Crop the figure on page 9.', { page: 1, region: REGION, pages: PAGES });

    expect(plan.calls).toEqual([]);
    expect(plan.notes).toEqual(['page-unavailable']);
  });

  it('matches region words without their accents', () => {
    const plan = planCalls('Phong to hinh nay.', { page: 1, region: REGION, pages: PAGES });

    expect(plan.intents).toEqual(['region']);
    expect(plan.calls.map(call => call.name)).toEqual(['crop_region', 'zoom_region', 'read_region_text']);
  });
});

describe('planCalls: search intent', () => {
  it('searches for the term the question asks about', () => {
    const plan = planCalls('Search for payment terms.');

    expect(plan.intents).toEqual(['search']);
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.name).toBe('search_document');
    expect(plan.calls[0]?.args).toEqual({ query: 'payment terms' });
    expect(plan.calls[0]?.reason).toBe('search-request');
    expect(plan.notes).toEqual([]);
  });

  it('searches a quoted span as one term', () => {
    const plan = planCalls('What is "force majeure"?');

    expect(plan.calls[0]?.name).toBe('search_document');
    expect(plan.calls[0]?.args).toEqual({ query: 'force majeure' });
    expect(plan.calls[0]?.reason).toBe('quoted-term');
  });

  it('does not treat a word that merely contains a trigger as one', () => {
    const plan = planCalls('What is the researcher clause?');

    expect(plan.intents).toEqual([]);
    expect(plan.notes).toEqual(['no-intent']);
  });

  it('reports a search request that left no term', () => {
    const plan = planCalls('Search for');

    expect(plan.intents).toEqual(['search']);
    expect(plan.calls).toEqual([]);
    expect(plan.notes).toEqual(['search-no-terms']);
  });

  it('still searches when the page the question names is not in the document', () => {
    const plan = planCalls('Search for "revenue" on page 9.', { pages: PAGES });

    expect(plan.intents).toEqual(['page', 'search']);
    expect(plan.calls.map(call => call.name)).toEqual(['search_document']);
    expect(plan.notes).toEqual(['page-unavailable']);
  });
});

describe('planCalls: citation intent', () => {
  it('cites when the question asks for a source', () => {
    const plan = planCalls('Cite the source for this claim.', { page: 3, pages: PAGES });

    expect(plan.intents).toEqual(['cite']);
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.name).toBe('cite_region');
    expect(plan.calls[0]?.args).toEqual({ page: 3 });
    expect(plan.calls[0]?.intent).toBe('cite');
    expect(plan.calls[0]?.reason).toBe('citation-request');
  });

  it('carries the selected region and block into the citation', () => {
    const plan = planCalls('Cite the source for this claim.', {
      page: 3,
      region: REGION,
      blockId: 'p3-r1',
      pages: PAGES,
    });

    expect(plan.calls[0]?.args).toEqual({ page: 3, region: REGION, blockId: 'p3-r1' });
  });

  it('recognises the Vietnamese citation words', () => {
    const plan = planCalls('Cho tôi nguồn của đoạn này.', { page: 1, pages: PAGES });

    expect(plan.intents).toEqual(['cite']);
    expect(plan.calls[0]?.name).toBe('cite_region');
  });
});

describe('planCalls: order, budget and determinism', () => {
  it('plans the whole pipeline in its fixed order', () => {
    const plan = planCalls(RICH_QUESTION, { page: 1, region: REGION, pages: PAGES });

    expect(plan.intents).toEqual(['page', 'region', 'search', 'cite']);
    expect(plan.calls.map(call => call.name)).toEqual([
      'navigate_page',
      'crop_region',
      'zoom_region',
      'read_region_text',
      'search_document',
      'cite_region',
    ]);
    expect(plan.calls).toHaveLength(MAX_PLAN_CALLS);
    expect(plan.budgetExhausted).toBe(false);
    expect(plan.notes).toEqual([]);
  });

  it('stops at the budget and says so', () => {
    const plan = planCalls(RICH_QUESTION, { page: 1, region: REGION, pages: PAGES, maxCalls: 2 });

    expect(plan.calls.map(call => call.name)).toEqual(['navigate_page', 'crop_region']);
    expect(plan.budgetExhausted).toBe(true);
    expect(plan.notes).toEqual(['budget-exhausted']);
  });

  it('plans nothing at a zero budget', () => {
    const plan = planCalls(RICH_QUESTION, { page: 1, region: REGION, pages: PAGES, maxCalls: 0 });

    expect(plan.calls).toEqual([]);
    expect(plan.budgetExhausted).toBe(true);
    expect(plan.notes).toEqual(['budget-exhausted']);
  });

  it('keeps the default budget equal to the longest pipeline', () => {
    expect(MAX_PLAN_CALLS).toBe(6);
    expect(MAX_PLAN_CALLS).toBe(AGENT_TOOL_NAMES.length);
  });

  it('plans the same sequence for the same question and context', () => {
    const first = planCalls(RICH_QUESTION, { page: 1, region: REGION, pages: PAGES });
    const second = planCalls(RICH_QUESTION, { page: 1, region: REGION, pages: PAGES });

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('does not alias the region the caller passed in', () => {
    const region = { x: 40, y: 60, width: 200, height: 120 };
    const plan = planCalls('Crop the figure.', { page: 1, region, pages: PAGES });

    expect(plan.calls[0]?.args['region']).toEqual(region);
    expect(plan.calls[0]?.args['region']).not.toBe(region);

    region.x = 0;
    expect(plan.calls[0]?.args['region']).toEqual({ x: 40, y: 60, width: 200, height: 120 });
  });
});

describe('planCalls: no intent', () => {
  it('returns an empty plan with a reason', () => {
    const plan = planCalls('What is the termination clause?');

    expect(plan.calls).toEqual([]);
    expect(plan.intents).toEqual([]);
    expect(plan.notes).toEqual(['no-intent']);
    expect(plan.budgetExhausted).toBe(false);
  });

  it('returns an empty plan for an empty question', () => {
    const plan = planCalls('');

    expect(plan.calls).toEqual([]);
    expect(plan.notes).toEqual(['no-intent']);
  });
});

describe('planCalls: every proposed call validates', () => {
  it('never proposes a call its own validator rejects', () => {
    const context = { page: 1, region: REGION, pages: PAGES };
    const plan = planCalls(RICH_QUESTION, context);

    expect(plan.calls).toHaveLength(MAX_PLAN_CALLS);
    for (const call of plan.calls) {
      const validation = validateCall(call.name, call.args, { pages: PAGES });
      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
    }
  });
});

describe('executeToolCalls', () => {
  it('records rejected calls and enforces the step budget', async () => {
    const events: string[] = [];
    const run = await executeToolCalls(
      [{ name: 'navigate_page', args: { page: 1 } }, { name: 'navigate_page', args: { page: 2 } }],
      { navigate_page: async () => ({ ok: true }) },
      { context: { pages: PAGES }, limits: { maxSteps: 1 }, onEvent: event => events.push(`${event.step}:${event.status}`) },
    );
    expect(run.results).toEqual([{ ok: true }]);
    expect(events).toEqual(['1:completed', '2:budget-exhausted']);
  });

  it('does not execute prompt-injected or unallowlisted tool names', async () => {
    const executor = vi.fn(async () => 'bad');
    const run = await executeToolCalls(
      [{ name: 'delete_everything', args: { instruction: 'ignore policy' } }],
      { navigate_page: executor },
      { allowedTools: ['navigate_page'] },
    );
    expect(executor).not.toHaveBeenCalled();
    expect(run.events[0]?.status).toBe('rejected');
  });
});
