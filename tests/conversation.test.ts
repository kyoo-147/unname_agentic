import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_CHARACTERS,
  DEFAULT_KEEP_TURNS,
  createConversation,
  type CitationInput,
  type Conversation,
} from '../src/core/conversation';

/** A citation to one page, and optionally one block, of a document. */
function cite(page: number, blockId?: string, documentId = 'alpha'): CitationInput {
  const citation: CitationInput = { documentId, page };
  if (blockId !== undefined) citation.blockId = blockId;
  return citation;
}

/**
 * Adds `count` alternating user/assistant turns whose texts are each exactly `length`
 * characters long, so a budget in the tests is arithmetic rather than guesswork.
 */
function fill(conversation: Conversation, count: number, length: number): void {
  for (let index = 0; index < count; index += 1) {
    const text = String.fromCharCode(97 + (index % 26)).repeat(length);
    if (index % 2 === 0) conversation.addUser(text);
    else conversation.addAssistant(text);
  }
}

/** Three exchanges: the fixture most of the citation and prune tests start from. */
function threeExchanges(): Conversation {
  const conversation = createConversation();
  conversation.addUser('q1');
  conversation.addAssistant('a1', [cite(2)]);
  conversation.addUser('q2');
  conversation.addAssistant('a2', [cite(5)]);
  conversation.addUser('q3');
  conversation.addAssistant('a3', [cite(9)]);
  return conversation;
}

describe('turn order', () => {
  it('keeps turns in the order they were added, numbered from zero', () => {
    const conversation = createConversation();
    conversation.addUser('q1');
    conversation.addAssistant('a1');
    conversation.addUser('q2');

    expect(conversation.turns().map(turn => `${turn.index}:${turn.role}:${turn.text}`)).toEqual([
      '0:user:q1',
      '1:assistant:a1',
      '2:user:q2',
    ]);
  });

  it('returns the most recent turns when a limit is given, at their current positions', () => {
    const conversation = createConversation();
    fill(conversation, 4, 5);

    expect(conversation.turns({ limit: 2 }).map(turn => turn.index)).toEqual([2, 3]);
    expect(conversation.turns({ limit: 99 }).map(turn => turn.index)).toEqual([0, 1, 2, 3]);
    expect(conversation.turns({ limit: 0 })).toEqual([]);
    expect(conversation.turns({ limit: Number.NaN })).toHaveLength(4);
  });

  it('hands out copies, so a caller cannot rewrite what it is shown', () => {
    const conversation = createConversation();
    conversation.addUser('q1');
    conversation.addAssistant('a1', [cite(2, 'p2-r1')]);

    const shown = conversation.turns()[1];
    if (!shown) throw new Error('expected an assistant turn');
    shown.text = 'rewritten';
    const citation = shown.citations[0];
    if (citation) citation.page = 99;

    const message = conversation.context().messages[0];
    if (message) message.text = 'rewritten too';

    expect(conversation.turns().map(turn => turn.text)).toEqual(['q1', 'a1']);
    expect(conversation.citationsFor(1).map(entry => entry.page)).toEqual([2]);
  });

  it('keeps an empty turn rather than dropping it silently', () => {
    const conversation = createConversation();
    conversation.addUser('');
    conversation.addAssistant('');

    const context = conversation.context();
    expect(context.messages.map(turn => turn.role)).toEqual(['user', 'assistant']);
    expect(context.droppedTurns).toBe(0);
  });
});

describe('addAssistant', () => {
  it('adds an assistant turn with no citations when none are given', () => {
    const conversation = createConversation();
    const turn = conversation.addAssistant('a1');

    expect(turn).toMatchObject({ index: 0, role: 'assistant', text: 'a1', citations: [] });
    expect(conversation.addAssistant('a2', undefined).citations).toEqual([]);
    expect(conversation.citationsFor(0)).toEqual([]);
  });
});

describe('citationsFor', () => {
  it('keeps each citation with the turn that produced it', () => {
    const conversation = createConversation();
    conversation.addUser('q1');
    conversation.addAssistant('a1', [cite(2, 'p2-r1')]);
    conversation.addUser('q2');
    conversation.addAssistant('a2', [cite(5)]);

    expect(conversation.citationsFor(0)).toEqual([]);
    expect(conversation.citationsFor(1).map(entry => `${entry.page}/${entry.blockId}`)).toEqual(['2/p2-r1']);
    expect(conversation.citationsFor(3).map(entry => entry.page)).toEqual([5]);
    expect(conversation.citationsFor(1).map(entry => entry.turns)).toEqual([[1]]);
  });

  it('answers an index the conversation does not hold with an empty list', () => {
    const conversation = threeExchanges();

    expect(conversation.citationsFor(99)).toEqual([]);
    expect(conversation.citationsFor(-1)).toEqual([]);
    expect(conversation.citationsFor(1.5)).toEqual([]);
    expect(conversation.citationsFor(Number.NaN)).toEqual([]);
  });
});

describe('allCitations', () => {
  it('folds the same target across turns and records every turn that cited it', () => {
    const conversation = createConversation();
    conversation.addUser('q1');
    conversation.addAssistant('a1', [cite(2, 'p2-r1')]);
    conversation.addUser('q2');
    conversation.addAssistant('a2', [cite(4), cite(2, 'p2-r1')]);

    const all = conversation.allCitations();
    expect(all.map(entry => entry.page)).toEqual([2, 4]);
    expect(all.map(entry => entry.turns)).toEqual([[1, 3], [3]]);
    expect(new Set(all.map(entry => entry.key)).size).toBe(2);
    expect(all[0]?.key).toContain('p2-r1');
  });

  it('folds repeats inside one turn', () => {
    const conversation = createConversation();
    conversation.addAssistant('a1', [cite(2), cite(2)]);

    expect(conversation.citationsFor(0)).toHaveLength(1);
    expect(conversation.allCitations()).toHaveLength(1);
  });

  it('tells the same page of two documents apart', () => {
    const conversation = createConversation();
    conversation.addAssistant('a1', [cite(12, undefined, 'alpha')]);
    conversation.addAssistant('a2', [cite(12, undefined, 'beta')]);

    expect(conversation.allCitations().map(entry => entry.documentId)).toEqual(['alpha', 'beta']);
  });

  it('uses an explicit id as identity before the page it names', () => {
    const conversation = createConversation();
    conversation.addAssistant('a1', [{ id: 'c-1', page: 2 }]);
    conversation.addAssistant('a2', [{ id: 'c-1', page: 9 }]);

    const all = conversation.allCitations();
    expect(all).toHaveLength(1);
    // The first-seen spelling is what is kept; the later turn only adds itself.
    expect(all[0]?.page).toBe(2);
    expect(all[0]?.turns).toEqual([0, 1]);
  });

  it('uses the raw marker as identity when it names no page or block', () => {
    const conversation = createConversation();
    conversation.addAssistant('a1', [{ raw: '(trang 7)' }]);
    conversation.addAssistant('a2', [{ raw: '(trang 7)' }]);
    conversation.addAssistant('a3', [{ raw: '(trang 8)' }]);

    const all = conversation.allCitations();
    expect(all.map(entry => entry.raw)).toEqual(['(trang 7)', '(trang 8)']);
    expect(all[0]?.turns).toEqual([0, 1]);
    expect(all[0]?.page).toBeNull();
  });

  it('keeps a citation that names nothing instead of folding it into another', () => {
    const conversation = createConversation();
    conversation.addAssistant('a1', [{}, {}]);

    expect(conversation.citationsFor(0)).toHaveLength(2);
    expect(conversation.allCitations()).toHaveLength(2);
  });

  it('returns nothing from an empty conversation', () => {
    expect(createConversation().allCitations()).toEqual([]);
  });
});

describe('context', () => {
  it('returns nothing for an empty conversation, with no summary slot', () => {
    expect(createConversation().context()).toEqual({ messages: [], droppedTurns: 0 });
  });

  it('returns the kept turns oldest first with their citations attached', () => {
    const conversation = createConversation();
    conversation.addUser('q1');
    conversation.addAssistant('a1', [cite(2)]);

    const context = conversation.context();
    expect(context.messages.map(turn => `${turn.role}:${turn.text}`)).toEqual(['user:q1', 'assistant:a1']);
    expect(context.messages[1]?.citations.map(entry => entry.page)).toEqual([2]);
    expect(context.droppedTurns).toBe(0);
    expect(context.summary).toBeUndefined();
  });

  it('always keeps the last DEFAULT_KEEP_TURNS turns, whatever the budget', () => {
    const conversation = createConversation();
    fill(conversation, 8, 10);

    const context = conversation.context({ maxCharacters: 1 });
    expect(DEFAULT_KEEP_TURNS).toBe(4);
    expect(context.messages.map(turn => turn.index)).toEqual([4, 5, 6, 7]);
    expect(context.droppedTurns).toBe(4);
  });

  it('counts the older turns a character budget pushed out', () => {
    const conversation = createConversation();
    fill(conversation, 6, 40);

    // The last four turns cost 160; one more costs 200 and fits the budget exactly.
    const context = conversation.context({ maxCharacters: 200 });
    expect(context.messages.map(turn => turn.index)).toEqual([1, 2, 3, 4, 5]);
    expect(context.droppedTurns).toBe(1);
  });

  it('honours a keepTurns override', () => {
    const conversation = createConversation();
    fill(conversation, 6, 10);

    const context = conversation.context({ maxCharacters: 1, keepTurns: 2 });
    expect(context.messages.map(turn => turn.index)).toEqual([4, 5]);
    expect(context.droppedTurns).toBe(4);
  });

  it('measures the budget in code points, not UTF-16 units', () => {
    const conversation = createConversation();
    for (let index = 0; index < 3; index += 1) {
      // Five emoji: five code points, ten UTF-16 units.
      if (index % 2 === 0) conversation.addUser('😀'.repeat(5));
      else conversation.addAssistant('😀'.repeat(5));
    }

    const context = conversation.context({ maxCharacters: 10, keepTurns: 1 });
    expect(context.messages.map(turn => turn.index)).toEqual([1, 2]);
    expect(context.droppedTurns).toBe(1);
  });

  it('carries the caller-provided summary through and still counts dropped turns', () => {
    const conversation = createConversation();
    fill(conversation, 6, 40);
    conversation.setSummary('Turns 1-2: the budget question and its figure.');

    const context = conversation.context({ maxCharacters: 200 });
    expect(context.summary).toBe('Turns 1-2: the budget question and its figure.');
    expect(context.messages).toHaveLength(5);
    expect(context.droppedTurns).toBe(1);
  });

  it('carries a summary even when it carries no turns', () => {
    const conversation = createConversation();
    conversation.setSummary('Nothing asked yet.');

    expect(conversation.context()).toEqual({ messages: [], droppedTurns: 0, summary: 'Nothing asked yet.' });
  });

  it('clears the summary when the caller passes nothing', () => {
    const conversation = createConversation();
    conversation.setSummary('Digest.');
    conversation.setSummary(null);
    expect(conversation.context().summary).toBeUndefined();

    conversation.setSummary('Digest.');
    conversation.setSummary('   ');
    expect(conversation.context().summary).toBeUndefined();
  });

  it('falls back to the default budget when maxCharacters is not positive', () => {
    const conversation = createConversation();
    fill(conversation, 6, 40);

    expect(DEFAULT_CONTEXT_CHARACTERS).toBeGreaterThan(240);
    expect(conversation.context({ maxCharacters: 0 }).messages).toHaveLength(6);
    expect(conversation.context({ maxCharacters: Number.NaN }).messages).toHaveLength(6);
  });
});

describe('prune', () => {
  it('keeps the tail of the conversation and reports what it removed', () => {
    const conversation = threeExchanges();

    expect(conversation.prune({ keepTurns: 2 })).toEqual({ removed: 4, kept: 2 });
    expect(conversation.turns().map(turn => `${turn.index}:${turn.role}:${turn.text}`)).toEqual([
      '0:user:q3',
      '1:assistant:a3',
    ]);
  });

  it('renumbers the kept turns and the citations stored on them', () => {
    const conversation = threeExchanges();
    conversation.prune({ keepTurns: 2 });

    expect(conversation.citationsFor(0)).toEqual([]);
    expect(conversation.citationsFor(1).map(entry => `${entry.page}:${entry.turns.join(',')}`)).toEqual(['9:1']);
    expect(conversation.allCitations().map(entry => entry.page)).toEqual([9]);
  });

  it('refuses to prune away the last user turn', () => {
    const conversation = createConversation();
    conversation.addUser('q1');
    conversation.addAssistant('a1');
    conversation.addAssistant('a2');

    // Keeping one turn would keep only the trailing assistant turn.
    expect(conversation.prune({ keepTurns: 1 })).toEqual({ removed: 0, kept: 3, refused: true });
    expect(conversation.turns()).toHaveLength(3);
    expect(conversation.turns().map(turn => turn.role)).toEqual(['user', 'assistant', 'assistant']);
  });

  it('refuses to empty the conversation', () => {
    const conversation = createConversation();
    conversation.addUser('q1');
    conversation.addAssistant('a1');

    expect(conversation.prune({ keepTurns: 0 })).toEqual({ removed: 0, kept: 2, refused: true });
    expect(conversation.turns()).toHaveLength(2);
  });

  it('keeps every turn when the keep count covers them all', () => {
    const conversation = createConversation();
    conversation.addUser('q1');
    conversation.addAssistant('a1');
    conversation.addUser('q2');

    const result = conversation.prune({ keepTurns: 10 });
    expect(result).toEqual({ removed: 0, kept: 3 });
    expect(result.refused).toBeUndefined();
    expect(conversation.turns()).toHaveLength(3);
  });

  it('does nothing to an empty conversation', () => {
    expect(createConversation().prune({ keepTurns: 1 })).toEqual({ removed: 0, kept: 0 });
  });

  it('leaves the summary alone', () => {
    const conversation = threeExchanges();
    conversation.setSummary('Digest of the removed turns.');

    conversation.prune({ keepTurns: 2 });
    expect(conversation.context().summary).toBe('Digest of the removed turns.');
  });
});
