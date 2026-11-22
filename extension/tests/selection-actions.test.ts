import { describe, expect, it, vi } from 'vitest';
import {
  CJK_PHRASE_MAX_CHARS,
  CJK_WORD_MAX_CHARS,
  PHRASE_MAX_WORDS,
  SELECTION_ACTION_IDS,
  SELECTION_GROUPS,
  SELECTION_LABEL_KEYS,
  SELECTION_REASON_KEYS,
  SelectionActionMenu,
  actionsFor,
  countWords,
  describe as describeSelection,
  filterEnabled,
  orderedGroups,
  type SelectionAction,
  type SelectionActionId,
  type SelectionContext,
  type SelectionKind,
  type SelectionReasonKey,
  type TextSelection,
} from '../viewer/src/core/selection-actions';

/** A reader who can translate: a provider is configured and consent is given. */
const READY: SelectionContext = { hasTranslation: true, providerConfigured: true };

/** A phrase a reader would select on a page. */
const PHRASE = 'machine learning';

function selection(text: string, extra: Partial<TextSelection> = {}): TextSelection {
  return { text, page: 1, ...extra };
}

function actionOf(actions: readonly SelectionAction[], id: SelectionActionId): SelectionAction {
  const found = actions.find(action => action.id === id);
  if (found === undefined) throw new Error(`no action ${id}`);
  return found;
}

function enabledIds(actions: readonly SelectionAction[]): SelectionActionId[] {
  return filterEnabled(actions).map(action => action.id);
}

function kindOf(text: string): SelectionKind {
  return describeSelection({ text }).kind;
}

describe('the action list', () => {
  it('returns every action in canonical order, enabled or not', () => {
    expect(actionsFor(selection(PHRASE), READY).map(action => action.id)).toEqual([...SELECTION_ACTION_IDS]);
  });

  it('gives a disabled action a reason and an enabled one none', () => {
    const actions = actionsFor(selection(PHRASE, { blockId: 'p1-r2' }), READY);
    expect(actions.some(action => !action.enabled)).toBe(true);
    expect(actions.some(action => action.enabled)).toBe(true);
    for (const action of actions) {
      if (action.enabled) expect(action.reason).toBeUndefined();
      else expect(SELECTION_REASON_KEYS).toContain(action.reason);
    }
  });

  it('labels every action with its own dictionary key', () => {
    const actions = actionsFor(selection(PHRASE), READY);
    for (const action of actions) expect(action.labelKey).toBe(SELECTION_LABEL_KEYS[action.id]);
    expect(new Set(actions.map(action => action.labelKey)).size).toBe(SELECTION_ACTION_IDS.length);
  });

  it('is deterministic and never writes to its input', () => {
    const frozen = Object.freeze(selection(PHRASE, { blockId: 'p1-r2' }));
    const context = Object.freeze({ ...READY });
    expect(actionsFor(frozen, context)).toEqual(actionsFor(frozen, context));
    expect(frozen.text).toBe(PHRASE);
    expect(frozen.blockId).toBe('p1-r2');
  });

  it('reads a half-built selection as empty instead of throwing', () => {
    const broken = { page: 1, text: 42 } as unknown as TextSelection;
    expect(actionsFor(broken, READY).map(action => action.reason)).toEqual(actionsFor(broken, READY).map(() => 'selectionReasonNoText'));
  });
});

describe('a selected phrase', () => {
  it('enables translate and copy, and refuses cite without a block', () => {
    const actions = actionsFor(selection(PHRASE), READY);
    expect(actionOf(actions, 'translate').enabled).toBe(true);
    expect(actionOf(actions, 'copy').enabled).toBe(true);
    expect(actionOf(actions, 'cite')).toEqual({
      id: 'cite',
      labelKey: 'selectionCite',
      group: 'annotate',
      enabled: false,
      reason: 'selectionReasonUnanchored',
    });
  });

  it('enables cite once the selection sits inside a block', () => {
    const actions = actionsFor(selection(PHRASE, { blockId: 'p4-r2' }), READY);
    expect(actionOf(actions, 'cite').enabled).toBe(true);
    expect(actionOf(actions, 'cite').reason).toBeUndefined();
  });

  it('does not treat a blank block id as an anchor', () => {
    const actions = actionsFor(selection(PHRASE, { blockId: '   ' }), READY);
    expect(actionOf(actions, 'cite').enabled).toBe(false);
    expect(actionOf(actions, 'cite').reason).toBe('selectionReasonUnanchored');
  });

  it('enables the reading actions a phrase can use', () => {
    expect(enabledIds(actionsFor(selection(PHRASE), READY))).toEqual([
      'translate',
      'copy',
      'copy-translation',
      'add-glossary',
      'search-document',
      'search-web',
      'define',
    ]);
  });

  it('refuses a term action on a sentence', () => {
    const actions = actionsFor(selection('The model learns from data.'), READY);
    expect(actionOf(actions, 'add-glossary')).toMatchObject({ enabled: false, reason: 'selectionReasonNotATerm' });
    expect(actionOf(actions, 'define')).toMatchObject({ enabled: false, reason: 'selectionReasonNotATerm' });
    expect(actionOf(actions, 'translate').enabled).toBe(true);
  });
});

describe('a url', () => {
  it('enables search the web and nothing that reads it as prose', () => {
    const actions = actionsFor(selection('https://example.org/paper'), READY);
    expect(actionOf(actions, 'search-web').enabled).toBe(true);
    expect(actionOf(actions, 'search-document')).toMatchObject({ enabled: false, reason: 'selectionReasonNotSearchable' });
    expect(actionOf(actions, 'translate')).toMatchObject({ enabled: false, reason: 'selectionReasonNotProse' });
    expect(actionOf(actions, 'add-glossary')).toMatchObject({ enabled: false, reason: 'selectionReasonNotATerm' });
  });

  it('recognises a schemeless host but not a code path', () => {
    expect(kindOf('example.org/vn')).toBe('url');
    expect(kindOf('www.example.org')).toBe('url');
    expect(kindOf('src/core/ir.ts')).toBe('word');
    expect(kindOf('README.md')).toBe('word');
  });
});

describe('an email address', () => {
  it('enables copy and no other shape-driven action', () => {
    const actions = actionsFor(selection('lien.he@example.com'), READY);
    // `redact` is driven by sensitivity rather than shape, and an address is exactly
    // what `redact.ts` looks for, so it stays available. Everything that reads the
    // address as prose, as a term or as something to search is off.
    expect(enabledIds(actions).filter(id => id !== 'redact')).toEqual(['copy']);
  });

  it('offers redact because redact.ts finds the address', () => {
    expect(actionOf(actionsFor(selection('lien.he@example.com'), READY), 'redact').enabled).toBe(true);
  });
});

describe('a number', () => {
  it('enables search in the document and copy', () => {
    const actions = actionsFor(selection('1,234.56'), READY);
    expect(actionOf(actions, 'search-document').enabled).toBe(true);
    expect(enabledIds(actions)).toEqual(['copy', 'search-document']);
    expect(actionOf(actions, 'translate')).toMatchObject({ enabled: false, reason: 'selectionReasonNotProse' });
    expect(actionOf(actions, 'search-web')).toMatchObject({ enabled: false, reason: 'selectionReasonNotSearchable' });
    expect(actionOf(actions, 'define')).toMatchObject({ enabled: false, reason: 'selectionReasonNotATerm' });
  });

  it('enables redact only when redact.ts finds the number sensitive', () => {
    const phone = actionsFor(selection('0912345678'), READY);
    expect(actionOf(phone, 'redact').enabled).toBe(true);
    expect(actionOf(phone, 'search-document').enabled).toBe(true);

    const plain = actionsFor(selection('2024'), READY);
    expect(actionOf(plain, 'redact')).toMatchObject({ enabled: false, reason: 'selectionReasonNoSensitiveMatch' });
  });
});

describe('host capabilities', () => {
  it('disables translate without a configured provider, and keeps copy', () => {
    const actions = actionsFor(selection(PHRASE), { hasTranslation: true, providerConfigured: false });
    expect(actionOf(actions, 'translate')).toMatchObject({ enabled: false, reason: 'selectionReasonProviderOff' });
    expect(actionOf(actions, 'copy').enabled).toBe(true);
    expect(actionOf(actions, 'copy-translation').enabled).toBe(true);
  });

  it('needs a translation before copy translation is offered', () => {
    const actions = actionsFor(selection(PHRASE), { hasTranslation: false, providerConfigured: true });
    expect(actionOf(actions, 'copy-translation')).toMatchObject({
      enabled: false,
      reason: 'selectionReasonNoTranslation',
    });
    expect(actionOf(actionsFor(selection(PHRASE), READY), 'copy-translation').enabled).toBe(true);
  });

  it('anchors a note to a block or to a rect', () => {
    expect(actionOf(actionsFor(selection(PHRASE), READY), 'add-note')).toMatchObject({
      enabled: false,
      reason: 'selectionReasonUnanchored',
    });
    const withRect = actionsFor(selection(PHRASE, { rect: { x: 10, y: 20, width: 120, height: 14 } }), READY);
    expect(actionOf(withRect, 'add-note').enabled).toBe(true);
    const withBlock = actionsFor(selection(PHRASE, { blockId: 'p1-r3' }), READY);
    expect(actionOf(withBlock, 'add-note').enabled).toBe(true);
  });

  it('lets a host assert a shape the text does not show', () => {
    const numeric = actionsFor(selection('twelve'), { ...READY, isNumber: true });
    expect(actionOf(numeric, 'search-document').enabled).toBe(true);
    expect(actionOf(numeric, 'translate').enabled).toBe(false);

    const url = actionsFor(selection('see example'), { ...READY, isUrl: true });
    expect(actionOf(url, 'search-web').enabled).toBe(true);
    expect(actionOf(url, 'translate').enabled).toBe(false);
  });
});

describe('nothing selected', () => {
  it('disables every action and says why', () => {
    const actions = actionsFor(selection('  \n\t '), READY);
    expect(actions.every(action => !action.enabled)).toBe(true);
    expect(actions.every(action => action.reason === 'selectionReasonNoText')).toBe(true);
    expect(describeSelection({ text: '   ' })).toEqual({ kind: 'word', trimmed: '' });
  });
});

describe('ordering', () => {
  it('renders groups in the fixed order and drops empty ones', () => {
    const groups = orderedGroups(actionsFor(selection(PHRASE, { blockId: 'p1-r2' }), READY));
    expect(groups.map(entry => entry.group)).toEqual([...SELECTION_GROUPS]);
    expect(groups.map(entry => entry.actions.map(action => action.id))).toEqual([
      ['translate', 'copy', 'copy-translation'],
      ['cite', 'add-note', 'add-glossary'],
      ['search-document', 'search-web', 'define'],
      ['redact'],
    ]);
  });

  it('omits a group with no actions', () => {
    const primary = actionsFor(selection(PHRASE), READY).filter(action => action.group === 'primary');
    expect(orderedGroups(primary).map(entry => entry.group)).toEqual(['primary']);
    expect(orderedGroups([])).toEqual([]);
  });

  it('sorts inside a group without reordering the caller array', () => {
    const shuffled = [...actionsFor(selection(PHRASE), READY)].reverse();
    const before = shuffled.map(action => action.id);
    expect(orderedGroups(shuffled)[0]?.actions.map(action => action.id)).toEqual([
      'translate',
      'copy',
      'copy-translation',
    ]);
    expect(shuffled.map(action => action.id)).toEqual(before);
  });

  it('keeps disabled actions unless asked to filter', () => {
    const actions = actionsFor(selection(PHRASE, { blockId: 'p1-r2' }), READY);
    const enabled = filterEnabled(actions);
    expect(enabled.every(action => action.enabled)).toBe(true);
    expect(enabled).toHaveLength(actions.length - 1);
  });
});

describe('describe', () => {
  it('classifies one word and one phrase', () => {
    expect(describeSelection({ text: 'model' })).toEqual({ kind: 'word', trimmed: 'model' });
    expect(kindOf(PHRASE)).toBe('phrase');
    expect(kindOf('natural language processing pipeline')).toBe('phrase');
  });

  it('classifies a sentence by its final punctuation', () => {
    expect(kindOf('The model learns from data.')).toBe('sentence');
    expect(kindOf('Does it generalise?')).toBe('sentence');
    expect(kindOf('“It does.”')).toBe('sentence');
  });

  it('classifies a sentence by an interior boundary or by length', () => {
    expect(kindOf('First. Second')).toBe('sentence');
    expect(kindOf('Fig. 3')).toBe('phrase');
    const atLimit = Array.from({ length: PHRASE_MAX_WORDS }, () => 'word').join(' ');
    const overLimit = Array.from({ length: PHRASE_MAX_WORDS + 1 }, () => 'word').join(' ');
    expect(kindOf(atLimit)).toBe('phrase');
    expect(kindOf(overLimit)).toBe('sentence');
  });

  it('classifies quantities, addresses and urls', () => {
    expect(kindOf('42')).toBe('number');
    expect(kindOf('-3.5')).toBe('number');
    expect(kindOf('1,234.56')).toBe('number');
    expect(kindOf('12 %')).toBe('number');
    expect(kindOf('1e-5')).toBe('number');
    expect(kindOf('12.500 ₫')).toBe('number');
    expect(kindOf('lien.he@example.com')).toBe('email');
    expect(kindOf('https://example.org/paper.pdf')).toBe('url');
  });

  it('normalises the text it classifies', () => {
    expect(describeSelection({ text: '  machine\n\tlearning  ' })).toEqual({
      kind: 'phrase',
      trimmed: 'machine learning',
    });
    expect(describeSelection({ text: 'trans\u00adlation' }).trimmed).toBe('translation');
    expect(describeSelection({ text: 'a\u200bb' }).trimmed).toBe('ab');
  });

  it('counts Vietnamese words by spaces', () => {
    expect(countWords('Học máy là một lĩnh vực')).toBe(6);
    expect(countWords('  Học   máy  ')).toBe(2);
    expect(countWords('')).toBe(0);
    expect(countWords('— ...')).toBe(0);
  });

  it('classifies CJK text without any spaces', () => {
    expect(countWords('机器学习')).toBe(1);
    expect(kindOf('中文')).toBe('word');
    expect(kindOf('机'.repeat(CJK_WORD_MAX_CHARS))).toBe('word');
    expect(kindOf('机'.repeat(CJK_WORD_MAX_CHARS + 1))).toBe('phrase');
    expect(kindOf('机器学习')).toBe('phrase');
    expect(kindOf('这是一个测试。')).toBe('sentence');
    expect(kindOf('机'.repeat(CJK_PHRASE_MAX_CHARS))).toBe('phrase');
    expect(kindOf('机'.repeat(CJK_PHRASE_MAX_CHARS + 1))).toBe('sentence');
  });
});

describe('the catalogue', () => {
  it('keeps action ids and reason keys unique', () => {
    expect(new Set(SELECTION_ACTION_IDS).size).toBe(SELECTION_ACTION_IDS.length);
    expect(new Set(SELECTION_REASON_KEYS).size).toBe(SELECTION_REASON_KEYS.length);
    for (const id of SELECTION_ACTION_IDS) expect(SELECTION_LABEL_KEYS[id]).toBeDefined();
  });

  it('reaches every documented reason', () => {
    const seen = new Set<SelectionReasonKey>();
    const cases: ReadonlyArray<readonly [TextSelection, SelectionContext]> = [
      [selection(''), READY],
      [selection(PHRASE), { hasTranslation: false, providerConfigured: false }],
      [selection('lien.he@example.com'), READY],
      [selection('https://example.org'), READY],
      [selection('42'), READY],
    ];
    for (const [candidate, context] of cases) {
      for (const action of actionsFor(candidate, context)) {
        if (action.enabled) continue;
        const { reason } = action;
        if (reason === undefined) throw new Error(`disabled ${action.id} without a reason`);
        expect(SELECTION_REASON_KEYS).toContain(reason);
        seen.add(reason);
      }
    }
    expect(seen.size).toBe(SELECTION_REASON_KEYS.length);
  });

  it('orders the groups primary, annotate, research, danger', () => {
    expect([...SELECTION_GROUPS]).toEqual(['primary', 'annotate', 'research', 'danger']);
  });
});

describe('selection action menu', () => {
  it('navigates, blocks disabled actions, and returns an audit record', () => {
    const selected = selection(PHRASE, { blockId: 'p2-r1' });
    const actions = actionsFor(selected, { hasTranslation: false, providerConfigured: false });
    const run = vi.fn();
    const menu = new SelectionActionMenu(selected, actions, run);
    menu.open();
    const result = menu.handleKey({ key: 'Enter' });
    expect(result).toMatchObject({ kind: 'selection-action', actionId: 'translate', outcome: 'blocked' });
    expect(run).not.toHaveBeenCalled();
    expect(menu.snapshot().actions).toHaveLength(SELECTION_ACTION_IDS.length);
  });

  it('executes the selected enabled action and closes', () => {
    const selected = selection(PHRASE, { blockId: 'p2-r1' });
    const actions = actionsFor(selected, { hasTranslation: false, providerConfigured: true });
    const run = vi.fn();
    const menu = new SelectionActionMenu(selected, actions, run);
    menu.open();
    const result = menu.handleKey({ key: 'Enter' });
    expect(result).toMatchObject({ actionId: 'translate', outcome: 'executed' });
    expect(run).toHaveBeenCalledWith('translate');
    expect(menu.snapshot().open).toBe(false);
  });
});
