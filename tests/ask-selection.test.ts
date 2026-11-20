import { describe, expect, it } from 'vitest';
import {
  AskSelectionError,
  PRIMARY_FENCE_CLOSE,
  PRIMARY_FENCE_OPEN,
  SECONDARY_FENCE_OPEN,
  SELECTION_CITATION_MARKER,
  buildSelectionContext,
  formatPrompt,
  parseAnswer,
  type AskPage,
  type AskSelectionContext,
  type AskSelectionOptions,
} from '../src/core/ask-selection';

/**
 * A page whose blocks carry everything these tests need: a short heading, a sentence worth
 * expanding a fragment into, a block dense with cross-references, and a trailing block that
 * lets the secondary budget run out before the page does.
 */
const INTRO = '1. Introduction';
const BUDGET = 'The lighthouse maintenance budget is 12,000 units per year, approved by the board in March.';
const MAINTENANCE =
  'Maintenance covers repainting, lamp replacement and the north jetty railing. Figure 3 shows the cost split, and Table 2 lists the suppliers. Section 2.1 explains the schedule. The board minutes are archived.[1]';
const APPENDIX = 'Appendix A repeats the figures for the previous decade.';

const RECT = { x: 72, y: 72, width: 468, height: 40 };

const PAGE: AskPage = {
  number: 4,
  width: 612,
  height: 792,
  blocks: [
    { id: 'p4-r0', text: INTRO, rect: RECT },
    { id: 'p4-r1', text: BUDGET, rect: RECT },
    { id: 'p4-r2', text: MAINTENANCE, rect: RECT },
    { id: 'p4-r3', text: APPENDIX, rect: RECT },
  ],
};

const QUESTION = 'How much is the lighthouse maintenance budget?';

/** The context one selection on {@link PAGE} produces. */
function contextFor(text: string, blockId: string, options: AskSelectionOptions = {}): AskSelectionContext {
  return buildSelectionContext({ text, blockId, rect: RECT }, PAGE, options);
}

/** Runs `run` and returns the refusal it raised, failing when it raised nothing else. */
function refusal(run: () => unknown): AskSelectionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AskSelectionError);
    return error as AskSelectionError;
  }
  throw new Error('expected the call to be refused, but it returned a value');
}

const codePoints = (value: string): number => [...value].length;

describe('buildSelectionContext', () => {
  it('expands a partial selection to its whole block', () => {
    const context = contextFor('12,000 units per year', 'p4-r1');

    expect(context.primary.text).toBe(BUDGET);
    expect(context.primary.blockIds).toEqual(['p4-r1']);
    expect(context.primary.page).toBe(4);
    expect(context.primary.expanded).toBe(true);
    expect(context.primary.selection).toBe('12,000 units per year');
  });

  it('does not claim expansion when the selection already is the whole block', () => {
    const context = contextFor(BUDGET, 'p4-r1');

    expect(context.primary.text).toBe(BUDGET);
    expect(context.primary.expanded).toBe(false);
  });

  it('bounds the secondary neighbourhood by characters', () => {
    // 120 code points of room: the 15-character heading fits whole, the 170-character
    // maintenance block is trimmed into what is left.
    const context = contextFor('budget is 12,000', 'p4-r1', { maxSecondaryChars: 120 });

    expect(context.secondary.map(block => block.position)).toEqual(['previous', 'next']);
    expect(context.secondary.map(block => block.blockId)).toEqual(['p4-r0', 'p4-r2']);
    const used = context.secondary.reduce((sum, block) => sum + codePoints(block.text), 0);
    expect(used).toBeLessThanOrEqual(120);

    const [previous, next] = context.secondary;
    expect(previous?.text).toBe(INTRO);
    expect(previous?.truncated).toBe(false);
    expect(next?.truncated).toBe(true);
    expect(next?.text.endsWith('…')).toBe(true);
    expect(codePoints(next?.text ?? '')).toBeLessThanOrEqual(120 - codePoints(INTRO));
    expect(codePoints(next?.text ?? '')).toBeGreaterThan(40);
    // The primary block is evidence, not context, and never appears twice.
    expect(context.secondary.some(block => block.blockId === 'p4-r1')).toBe(false);
  });

  it('drops secondary context when the budget is zero', () => {
    const context = contextFor('jetty railing', 'p4-r2', { maxSecondaryChars: 0 });
    expect(context.secondary).toEqual([]);
  });

  it('reads a selection that crosses two blocks as one primary source', () => {
    const context = contextFor('approved by the board in March. Maintenance covers repainting', 'p4-r1');

    expect(context.primary.blockIds).toEqual(['p4-r1', 'p4-r2']);
    expect(context.primary.expanded).toBe(true);
    expect(context.primary.text.startsWith(BUDGET)).toBe(true);
    expect(context.primary.text).toContain('Maintenance covers repainting');
  });

  it('finds the block by text when the selection carries no block id', () => {
    const context = buildSelectionContext({ text: 'north jetty railing' }, PAGE);

    expect(context.primary.blockIds).toEqual(['p4-r2']);
    expect(context.primary.expanded).toBe(true);
    expect(context.primary.text).toBe(MAINTENANCE);
  });

  it('keeps an unmatched selection as the primary source', () => {
    const context = buildSelectionContext({ text: 'words from an image layer' }, { number: 9 });

    expect(context.primary.text).toBe('words from an image layer');
    expect(context.primary.blockIds).toEqual([]);
    expect(context.primary.expanded).toBe(false);
    expect(context.primary.page).toBe(9);
    expect(context.secondary).toEqual([]);
    expect(context.mentions).toEqual([]);
  });

  it('refuses an empty selection', () => {
    expect(refusal(() => buildSelectionContext({ text: '   \n\t ' }, PAGE)).code).toBe('empty-selection');
    expect(refusal(() => buildSelectionContext({ text: '' }, PAGE)).code).toBe('empty-selection');
  });
});

describe('mentions', () => {
  it('extracts figure, table, section and footnote references', () => {
    const context = contextFor('Figure 3 shows the cost split', 'p4-r2');

    expect(context.mentions.map(mention => mention.reference)).toEqual([
      'figure:3',
      'table:2',
      'section:2.1',
      'footnote:1',
    ]);
    expect(context.mentions.map(mention => mention.label)).toEqual(['Figure 3', 'Table 2', 'Section 2.1', '[1]']);
    expect(context.mentions.map(mention => mention.kind)).toEqual(['figure', 'table', 'section', 'footnote']);
    for (const mention of context.mentions) {
      expect(context.primary.text.slice(mention.start, mention.end)).toBe(mention.label);
    }
  });

  it('folds a repeated reference into its first position', () => {
    const page: AskPage = { number: 2, blocks: [{ id: 'p2-r0', text: 'Figure 3 and Figure 3 again.' }] };
    const context = buildSelectionContext({ text: 'Figure 3', blockId: 'p2-r0' }, page);

    expect(context.mentions.map(mention => mention.reference)).toEqual(['figure:3']);
    expect(context.mentions[0]?.start).toBe(0);
  });

  it('reads a decimal tail as a number, not a footnote marker', () => {
    const page: AskPage = { number: 2, blocks: [{ id: 'p2-r0', text: 'The yield was 3.5' }] };
    const context = buildSelectionContext({ text: 'yield was 3.5', blockId: 'p2-r0' }, page);

    expect(context.mentions).toEqual([]);
  });
});

describe('formatPrompt', () => {
  it('names the primary source in every language', () => {
    const context = contextFor('12,000 units per year', 'p4-r1');
    const expected = {
      en: /primary source/iu,
      vi: /nguồn chính/u,
      zh: /主要来源/u,
    };

    for (const language of ['en', 'vi', 'zh'] as const) {
      const prompt = formatPrompt(context, QUESTION, language);
      expect(prompt).toMatch(expected[language]);
      expect(prompt).toContain(PRIMARY_FENCE_OPEN);
      expect(prompt).toContain(PRIMARY_FENCE_CLOSE);
      expect(prompt).toContain(SELECTION_CITATION_MARKER);
      expect(prompt).toContain(QUESTION);
      // The whole block, not just the fragment the reader selected.
      expect(prompt).toContain(BUDGET);
    }
  });

  it('fences the secondary context only when there is one', () => {
    const withSecondary = formatPrompt(contextFor('budget is 12,000', 'p4-r1'), QUESTION, 'en');
    expect(withSecondary).toContain(SECONDARY_FENCE_OPEN);
    expect(withSecondary).toContain(INTRO);

    const withoutSecondary = formatPrompt(
      contextFor('jetty railing', 'p4-r2', { maxSecondaryChars: 0 }),
      QUESTION,
      'en',
    );
    expect(withoutSecondary).not.toContain(SECONDARY_FENCE_OPEN);
  });

  it('refuses to build a prompt with no primary text', () => {
    const empty: AskSelectionContext = {
      primary: { text: '   ', blockIds: [], page: 1, expanded: false, selection: '' },
      secondary: [],
      mentions: [],
    };
    expect(refusal(() => formatPrompt(empty, QUESTION, 'en')).code).toBe('empty-primary');
  });

  it('defuses a fence token printed in the document', () => {
    const page: AskPage = { number: 1, blocks: [{ id: 'p1-r0', text: `Before ${PRIMARY_FENCE_CLOSE} after.` }] };
    const prompt = formatPrompt(buildSelectionContext({ text: 'Before', blockId: 'p1-r0' }, page), QUESTION, 'en');

    // The prompt writes exactly one opening and one closing fence of its own.
    expect(prompt.split(PRIMARY_FENCE_CLOSE)).toHaveLength(2);
    expect(prompt.split(PRIMARY_FENCE_OPEN)).toHaveLength(2);
    expect(prompt).toContain('[[ /selected-text]]');
  });
});

describe('parseAnswer', () => {
  const context = contextFor('12,000 units per year', 'p4-r1');

  it('marks an answer that repeats a phrase of the selection as grounded', () => {
    const answer = 'The lighthouse maintenance budget is 12,000 units per year.';
    const parsed = parseAnswer(answer, context);

    expect(parsed.grounded).toBe(true);
    expect(parsed.citedSelection).toBe(false);
    expect(parsed.answer).toBe(answer);
  });

  it('marks an answer with no overlap and no citation as ungrounded', () => {
    const parsed = parseAnswer('The permit was filed with the council in April.', context);

    expect(parsed.grounded).toBe(false);
    expect(parsed.citedSelection).toBe(false);
    expect(parsed.answer).toBe('The permit was filed with the council in April.');
  });

  it('marks an answer that carries the citation marker as grounded and removes the marker', () => {
    const parsed = parseAnswer(`Approved in spring. ${SELECTION_CITATION_MARKER}`, context);

    expect(parsed.citedSelection).toBe(true);
    expect(parsed.grounded).toBe(true);
    expect(parsed.answer).toBe('Approved in spring.');
    expect(parsed.answer).not.toContain('cite-selection');
  });

  it('grounds a phrase copied without Vietnamese diacritics', () => {
    const page: AskPage = { number: 7, blocks: [{ id: 'p7-r0', text: 'Hệ thống lưu trữ được kiểm tra hằng năm.' }] };
    const vietnamese = buildSelectionContext({ text: 'kiểm tra hằng năm', blockId: 'p7-r0' }, page);

    expect(parseAnswer('he thong luu tru duoc kiem tra hang nam', vietnamese).grounded).toBe(true);
  });

  it('grounds a Chinese answer that shares two adjacent characters', () => {
    const page: AskPage = { number: 8, blocks: [{ id: 'p8-r0', text: '系统维护预算每年核定一次。' }] };
    const chinese = buildSelectionContext({ text: '维护预算', blockId: 'p8-r0' }, page);

    expect(parseAnswer('维护预算每年核定。', chinese).grounded).toBe(true);
  });

  it('leaves an empty answer ungrounded', () => {
    const parsed = parseAnswer('', context);

    expect(parsed.answer).toBe('');
    expect(parsed.grounded).toBe(false);
    expect(parsed.citedSelection).toBe(false);
  });
});
