/**
 * What a text selection can do (backlog items L05 + L07).
 *
 * A selection reaches the product from three places — a drag inside the reader, the
 * command palette, and the Chrome extension's content script — and each of them used
 * to decide for itself which actions to offer. This module is that decision, made
 * once: given the text a reader selected and what the host can actually do, it returns
 * the same list, in the same order, with the same enable rules and the same reasons,
 * so the three surfaces cannot drift apart.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no I/O, no locale. The
 *   same selection and the same context always produce the same actions, and nothing
 *   in the result is mutated between calls.
 * - Every action is returned, enabled or not. A disabled action always carries a
 *   reason key, never silence: the reader is told why "Cite" is unavailable instead of
 *   watching a button disappear. This module decides *whether*; the surface decides how.
 * - Labels and reasons are keys, not sentences. The dictionary owns the words; the keys
 *   below are `TranslationKey`-shaped so they drop straight into `i18n.ts`, and a key the
 *   dictionary does not carry yet renders as the key itself through `t()`.
 * - Absent capability flags read as false, so a host that forgets to pass consent never
 *   unlocks a cloud action (L05: nothing goes to a provider without consent).
 * - Nothing is performed here: no clipboard write, no network call, no note stored, no
 *   redaction applied. A host receives ids for what it may do and does the work.
 *
 * What a host is expected to pass:
 * - `text` is the selected characters exactly as the page holds them. {@link describe}
 *   normalises a copy for classification; a copy action must copy the selection's own
 *   text, not the normalised form.
 * - `blockId` is the IR block the selection sits in, when the reader could resolve one.
 *   It is what makes `cite` possible and what a note prefers to anchor to.
 * - `rect` is the page-space rect of the selection, in points, matching `Rect` in
 *   `src/core/types.ts`. It is the fallback anchor when the selection spans no single
 *   block. `page` is carried for the caller and is not consulted by any rule here.
 * - `isUrl`, `isEmail` and `isNumber` are the host's own knowledge. A hint can only
 *   *assert* a shape, never deny one: a flag left out falls back to the text's shape,
 *   and a flag set to `true` wins over it.
 */

import { detectSensitive, type SensitiveMatch } from './redact';
import type { Rect } from './types';

// --- Public shape ----------------------------------------------------------

/** The shape of the selected text, as the action rules see it. */
export type SelectionKind = 'word' | 'phrase' | 'sentence' | 'number' | 'email' | 'url';

/** Where an action is rendered. */
export type SelectionGroup = 'primary' | 'annotate' | 'research' | 'danger';

/**
 * Canonical group order: what a reader most likely wants first, what can destroy
 * content last. A surface renders the groups in this order and never invents one.
 */
export const SELECTION_GROUPS: readonly SelectionGroup[] = ['primary', 'annotate', 'research', 'danger'];

/** Every action this module knows about. */
export type SelectionActionId =
  | 'translate'
  | 'copy'
  | 'copy-translation'
  | 'cite'
  | 'add-note'
  | 'add-glossary'
  | 'search-document'
  | 'search-web'
  | 'define'
  | 'redact';

/** Canonical action order, which is the order {@link actionsFor} returns. */
export const SELECTION_ACTION_IDS: readonly SelectionActionId[] = [
  'translate',
  'copy',
  'copy-translation',
  'cite',
  'add-note',
  'add-glossary',
  'search-document',
  'search-web',
  'define',
  'redact',
];

/** Dictionary key for an action's label, in every locale. */
export type SelectionLabelKey =
  | 'selectionTranslate'
  | 'selectionCopy'
  | 'selectionCopyTranslation'
  | 'selectionCite'
  | 'selectionAddNote'
  | 'selectionAddGlossary'
  | 'selectionSearchDocument'
  | 'selectionSearchWeb'
  | 'selectionDefine'
  | 'selectionRedact';

/** Dictionary key explaining why an action is disabled. */
export type SelectionReasonKey =
  | 'selectionReasonNoText'
  | 'selectionReasonProviderOff'
  | 'selectionReasonNoTranslation'
  | 'selectionReasonUnanchored'
  | 'selectionReasonNotProse'
  | 'selectionReasonNotATerm'
  | 'selectionReasonNotSearchable'
  | 'selectionReasonNoSensitiveMatch';

/** Label key per action, so a surface never builds a key from a string template. */
export const SELECTION_LABEL_KEYS: Readonly<Record<SelectionActionId, SelectionLabelKey>> = {
  translate: 'selectionTranslate',
  copy: 'selectionCopy',
  'copy-translation': 'selectionCopyTranslation',
  cite: 'selectionCite',
  'add-note': 'selectionAddNote',
  'add-glossary': 'selectionAddGlossary',
  'search-document': 'selectionSearchDocument',
  'search-web': 'selectionSearchWeb',
  define: 'selectionDefine',
  redact: 'selectionRedact',
};

/** Every reason key, in documentation order; a surface can translate all of them up front. */
export const SELECTION_REASON_KEYS: readonly SelectionReasonKey[] = [
  'selectionReasonNoText',
  'selectionReasonProviderOff',
  'selectionReasonNoTranslation',
  'selectionReasonUnanchored',
  'selectionReasonNotProse',
  'selectionReasonNotATerm',
  'selectionReasonNotSearchable',
  'selectionReasonNoSensitiveMatch',
];

/** One selection of page text. */
export interface TextSelection {
  /** The selected characters, exactly as the page holds them. */
  readonly text: string;
  /** 1-based page the selection was made on; carried for the caller, not consulted here. */
  readonly page: number;
  /** IR block the selection sits in, when the reader could resolve one. */
  readonly blockId?: string;
  /** Page-space rect of the selection, in points. */
  readonly rect?: Rect;
}

/** What the host can do, and what it already knows about the text. */
export interface SelectionContext {
  /** The selection already has a translation the reader can copy. */
  readonly hasTranslation: boolean;
  /** A translation provider is configured and the reader has consented to it. */
  readonly providerConfigured: boolean;
  /** The host knows the text is a URL, for example because it came from a link. */
  readonly isUrl?: boolean;
  /** The host knows the text is an email address. */
  readonly isEmail?: boolean;
  /** The host knows the text is a number, for example from a table cell. */
  readonly isNumber?: boolean;
}

/** One thing a reader may do with a selection. */
export interface SelectionAction {
  readonly id: SelectionActionId;
  readonly labelKey: SelectionLabelKey;
  readonly group: SelectionGroup;
  /** `false` means unavailable; the action stays in the list so the reason can be shown. */
  readonly enabled: boolean;
  /** Present exactly when `enabled` is false, and never present otherwise. */
  readonly reason?: SelectionReasonKey;
}

/** Actions of one group, as a surface renders them. */
export interface SelectionActionGroup {
  readonly group: SelectionGroup;
  readonly actions: readonly SelectionAction[];
}

/** The normalised form of a selection's text, which the action rules classify. */
export interface DescribedSelection {
  /** Shape of the selection; rules that cannot use a shape report why instead. */
  readonly kind: SelectionKind;
  /** Whitespace folded to single spaces, invisibles removed, trimmed. Empty when nothing is selected. */
  readonly trimmed: string;
}

// --- Classification --------------------------------------------------------

/**
 * Most words a selection can hold and still be a phrase. Past it the selection spans
 * more than a phrase whatever its punctuation says, so `add to glossary` and `define`
 * stop applying.
 */
export const PHRASE_MAX_WORDS = 8;

/**
 * Most characters a spacesless run may hold and still be a word. Han, Hiragana and
 * Katakana do not separate words with spaces, so those scripts are measured in
 * characters instead: 一 two-character 词 is a word, 机器学习 is a phrase.
 */
export const CJK_WORD_MAX_CHARS = 2;

/** Longest spacesless run that is still a phrase; past it the run is a sentence. */
export const CJK_PHRASE_MAX_CHARS = 12;

/** Soft hyphen, zero-width space/joiners, word joiner and BOM: layout noise, not text. */
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/gu;

/** Any run of whitespace, including the line breaks a PDF insertion carries. */
const WHITESPACE_RUN = /\s+/gu;

/** A character that makes a token a word rather than punctuation. */
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** One character of a script that does not separate words with spaces. */
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Same, global, for counting. */
const CJK_CHARACTERS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/** `https://…`, `http://…`, `ftp://…`. */
const URL_SCHEME = /^(?:https?|ftp):\/\/[^\s]+$/iu;

/** `www.example.com/…`, the form a reader types and a PDF prints. */
const URL_WWW = /^www\.[^\s/]+\.[^\s]+$/iu;

/** A schemeless host and optional path; the final label must be a known TLD. */
const URL_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s]*)?$/iu;

/**
 * TLDs a schemeless host may end with. Deliberately a list and not a shape: accepting
 * any two-letter label would read `src/core/ir.ts` as a host, and a wrong "search the
 * web" is worse than a missing one. Anything outside the list stays text, which is why
 * the host can pass `isUrl` for a domain this table does not know.
 */
const KNOWN_TLDS = new Set<string>([
  'academy',
  'agency',
  'ai',
  'app',
  'art',
  'biz',
  'blog',
  'cloud',
  'club',
  'co',
  'com',
  'design',
  'dev',
  'digital',
  'edu',
  'email',
  'finance',
  'foundation',
  'gov',
  'group',
  'health',
  'info',
  'institute',
  'int',
  'io',
  'law',
  'link',
  'live',
  'ltd',
  'me',
  'media',
  'mil',
  'name',
  'net',
  'network',
  'news',
  'online',
  'org',
  'page',
  'pro',
  'research',
  'school',
  'science',
  'shop',
  'site',
  'solutions',
  'store',
  'studio',
  'systems',
  'tech',
  'tools',
  'tv',
  'wiki',
  'works',
  'xyz',
  // Country codes, including every one a Vietnamese document is likely to name.
  'ae',
  'ar',
  'at',
  'au',
  'be',
  'br',
  'by',
  'ca',
  'ch',
  'cl',
  'cn',
  'cz',
  'de',
  'dk',
  'es',
  'fi',
  'fr',
  'gr',
  'hk',
  'id',
  'ie',
  'il',
  'in',
  'it',
  'jp',
  'kr',
  'kz',
  'mx',
  'my',
  'nl',
  'no',
  'nz',
  'ph',
  'pl',
  'pt',
  'ru',
  'sa',
  'se',
  'sg',
  'th',
  'tr',
  'tw',
  'ua',
  'uk',
  'us',
  'vn',
  'za',
]);

/** Entire selection is one address. */
const EMAIL = /^[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}$/u;

/**
 * Entire selection is one quantity: an optional sign, digits with optional separators,
 * an optional decimal part, an optional exponent and an optional percent sign. Digits
 * are `\p{Nd}`, so a document set in Arabic-Indic or fullwidth digits still counts.
 */
const NUMBER = /^[+-]?(?:\p{Nd}+(?:[.,]\p{Nd}+)?|\p{Nd}{1,3}(?:[ .,]\p{Nd}{3})+(?:[.,]\p{Nd}+)?)(?:[eE][+-]?\p{Nd}+)?\s*%?$/u;

/** A currency mark on either edge of a quantity, which a reader selects with the digits. */
const CURRENCY_EDGE = /^[$€£¥₫]\s*|\s*(?:[$€£¥₫]|₫|đ|VND|USD|EUR|GBP|JPY)$/iu;

/** Quotes and brackets that may close a sentence after its full stop. */
const CLOSERS = /["'”’»)\]】」』）〉》]+$/u;

/** A sentence's final punctuation, once {@link CLOSERS} are removed. */
const SENTENCE_END = /[.!?…。！？]+$/u;

/**
 * A sentence boundary inside the selection: ASCII punctuation, any closing marks, a
 * space and a capital or spacesless-script character, or CJK terminal punctuation with
 * anything but whitespace after it. `Fig. 3` is not a boundary; `First. Second` is.
 */
const INTERIOR_SENTENCE =
  /[.!?…]["'”’»)\]】」』）〉》]*[ \t]+[\p{Lu}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[。！？](?=[ \t]*[^\s])/u;

/**
 * Folds a selection's text to the form the rules compare: invisibles dropped,
 * whitespace runs collapsed to one space, ends trimmed. Returns an empty string for
 * anything that is not a string, so a half-built selection never throws.
 */
function normalize(value: string): string {
  if (typeof value !== 'string') return '';
  return value.replace(INVISIBLE, '').replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * Words in a selection, counted by spaces — the rule Vietnamese and English share.
 * Punctuation-only tokens do not count, and a run of CJK characters counts as one
 * token because it carries no spaces; {@link describe} measures those in characters
 * instead of calling that token a word.
 */
export function countWords(text: string): number {
  const normalized = normalize(text);
  if (normalized === '') return 0;
  let words = 0;
  for (const token of normalized.split(' ')) {
    if (WORD_CHARACTER.test(token)) words += 1;
  }
  return words;
}

/** How many spacesless-script characters the text holds. */
function countCjkCharacters(text: string): number {
  let count = 0;
  for (const _character of text.matchAll(CJK_CHARACTERS)) count += 1;
  return count;
}

/** True when the selection is one schemeless host whose TLD is known. */
function hasKnownTld(value: string): boolean {
  const authority = value.split('/')[0] ?? '';
  const labels = authority.toLowerCase().split('.');
  const tld = labels[labels.length - 1];
  return tld !== undefined && KNOWN_TLDS.has(tld);
}

/** True when the whole selection is one URL the reader could open. */
function looksLikeUrl(value: string): boolean {
  if (URL_SCHEME.test(value)) return true;
  if (value.includes('@')) return false;
  if (URL_WWW.test(value)) return true;
  return URL_HOST.test(value) && hasKnownTld(value);
}

/** True when the whole selection is one quantity, currency mark included. */
function looksNumeric(value: string): boolean {
  const body = value.replace(CURRENCY_EDGE, '').trim();
  return body !== '' && NUMBER.test(body);
}

/** True when the selection reads as at least one sentence, by punctuation or by length. */
function isSentence(value: string, words: number): boolean {
  if (SENTENCE_END.test(value.replace(CLOSERS, ''))) return true;
  if (INTERIOR_SENTENCE.test(value)) return true;
  if (words > PHRASE_MAX_WORDS) return true;
  return countCjkCharacters(value) > CJK_PHRASE_MAX_CHARS;
}

/**
 * Classifies a selection's text and normalises it in the same pass.
 *
 * Order matters and is the order a reader would explain it in: a URL, an address and a
 * quantity are recognised whole; anything else is a sentence when it reads like one and
 * a word or a phrase by how many words it holds. Scripts without spaces are measured in
 * characters, so CJK text classifies without ever needing a space.
 *
 * An empty selection has no shape. It is reported as a `word` with an empty `trimmed`,
 * and {@link actionsFor} disables every action with `selectionReasonNoText` before any
 * shape rule runs — the shape is then never shown, only the reason.
 */
export function describe(selection: Pick<TextSelection, 'text'>): DescribedSelection {
  const trimmed = normalize(selection.text);
  if (trimmed === '') return { kind: 'word', trimmed };
  if (looksLikeUrl(trimmed)) return { kind: 'url', trimmed };
  if (EMAIL.test(trimmed)) return { kind: 'email', trimmed };
  if (looksNumeric(trimmed)) return { kind: 'number', trimmed };

  const words = countWords(trimmed);
  if (isSentence(trimmed, words)) return { kind: 'sentence', trimmed };
  if (words > 1) return { kind: 'phrase', trimmed };
  return countCjkCharacters(trimmed) > CJK_WORD_MAX_CHARS ? { kind: 'phrase', trimmed } : { kind: 'word', trimmed };
}

// --- Rules -----------------------------------------------------------------

/** Kinds an action can accept, named so a spec reads as a rule instead of a list. */
type KindSet = 'all' | 'prose' | 'term' | 'lexical' | 'web';

const ALL_KINDS: readonly SelectionKind[] = ['word', 'phrase', 'sentence', 'number', 'email', 'url'];

const KIND_SETS: Readonly<Record<KindSet, readonly SelectionKind[]>> = {
  all: ALL_KINDS,
  prose: ['word', 'phrase', 'sentence'],
  term: ['word', 'phrase'],
  lexical: ['word', 'phrase', 'sentence', 'number'],
  web: ['word', 'phrase', 'sentence', 'url'],
};

/** Why an action is unavailable for a kind it does not accept. */
const KIND_SET_REASONS: Readonly<Record<Exclude<KindSet, 'all'>, SelectionReasonKey>> = {
  prose: 'selectionReasonNotProse',
  term: 'selectionReasonNotATerm',
  lexical: 'selectionReasonNotSearchable',
  web: 'selectionReasonNotSearchable',
};

interface ActionSpec {
  readonly id: SelectionActionId;
  readonly group: SelectionGroup;
  readonly kinds: KindSet;
}

/**
 * The table. Kind rules live here; capability and anchor rules live in {@link GATES},
 * so a new action is one entry plus, when it needs one, one gate.
 *
 * Kind rules, and why:
 * - `translate` and `copy translation` work on prose. A URL, an address or a bare
 *   quantity has nothing a translator should rewrite.
 * - `copy` works on everything: it is the one action no selection can be wrong for.
 * - `cite` and `add note` work on everything; what they need is an anchor, not a shape.
 * - `add to glossary` and `define` need a term: a word or a phrase, never a sentence.
 * - `search in document` is lexical, so a number is searchable and an address or a URL
 *   is not: an identifier is copied or opened, not sought.
 * - `search the web` covers prose and URLs, which is what a reader looks up.
 * - `redact` is driven by `redact.ts`, not by shape; any selection may carry an
 *   identifier.
 */
const ACTION_SPECS: readonly ActionSpec[] = [
  { id: 'translate', group: 'primary', kinds: 'prose' },
  { id: 'copy', group: 'primary', kinds: 'all' },
  { id: 'copy-translation', group: 'primary', kinds: 'prose' },
  { id: 'cite', group: 'annotate', kinds: 'all' },
  { id: 'add-note', group: 'annotate', kinds: 'all' },
  { id: 'add-glossary', group: 'annotate', kinds: 'term' },
  { id: 'search-document', group: 'research', kinds: 'lexical' },
  { id: 'search-web', group: 'research', kinds: 'web' },
  { id: 'define', group: 'research', kinds: 'term' },
  { id: 'redact', group: 'danger', kinds: 'all' },
];

/** What the rules read once per call. */
interface SelectionFacts {
  /** Shape after the host's hints; see {@link kindWithHints}. */
  readonly kind: SelectionKind;
  readonly empty: boolean;
  /** True only when the host said so: an absent flag never unlocks a cloud action. */
  readonly providerConfigured: boolean;
  readonly hasTranslation: boolean;
  /** The selection is inside an IR block, so a citation can name it. */
  readonly hasBlock: boolean;
  /** The selection has a page rect, so a note has somewhere to sit. */
  readonly hasRect: boolean;
  /** Identifiers `redact.ts` found in the trimmed text. */
  readonly sensitive: readonly SensitiveMatch[];
}

/**
 * Capability and anchor gates, checked after the text and its shape. A gate returns a
 * reason to disable and `undefined` to allow; an action with no entry is always allowed
 * once its shape is.
 */
const GATES: Readonly<
  Partial<Record<SelectionActionId, (facts: SelectionFacts) => SelectionReasonKey | undefined>>
> = {
  translate: facts => (facts.providerConfigured ? undefined : 'selectionReasonProviderOff'),
  'copy-translation': facts => (facts.hasTranslation ? undefined : 'selectionReasonNoTranslation'),
  cite: facts => (facts.hasBlock ? undefined : 'selectionReasonUnanchored'),
  'add-note': facts => (facts.hasBlock || facts.hasRect ? undefined : 'selectionReasonUnanchored'),
  redact: facts => (facts.sensitive.length > 0 ? undefined : 'selectionReasonNoSensitiveMatch'),
};

/** The host's hints win over the text's shape; a hint can assert a kind, never deny one. */
function kindWithHints(described: DescribedSelection, context: SelectionContext): SelectionKind {
  if (context.isUrl === true) return 'url';
  if (context.isEmail === true) return 'email';
  if (context.isNumber === true) return 'number';
  return described.kind;
}

/**
 * Why an action is disabled, or `undefined` when it is available.
 *
 * The checks run in the order a reader would ask the questions: is anything selected,
 * can this action use this text, and only then can the host deliver it. A `3.14` with
 * no provider therefore says "nothing to translate here", not "no provider", because
 * the second answer is true of every selection and would teach the reader nothing.
 */
function blockerFor(spec: ActionSpec, facts: SelectionFacts): SelectionReasonKey | undefined {
  if (facts.empty) return 'selectionReasonNoText';
  if (!KIND_SETS[spec.kinds].includes(facts.kind)) {
    // A set that accepts every kind cannot reject one; the guard is here so the index
    // below stays typed to the narrowed sets.
    if (spec.kinds === 'all') return undefined;
    return KIND_SET_REASONS[spec.kinds];
  }
  return GATES[spec.id]?.(facts);
}

function actionFor(spec: ActionSpec, facts: SelectionFacts): SelectionAction {
  const reason = blockerFor(spec, facts);
  const action: SelectionAction = {
    id: spec.id,
    labelKey: SELECTION_LABEL_KEYS[spec.id],
    group: spec.group,
    enabled: reason === undefined,
  };
  return reason === undefined ? action : { ...action, reason };
}

/**
 * Every action for a selection, in canonical order, enabled or not.
 *
 * A disabled action always carries a `reason` and an enabled one never does, so a
 * surface can filter on `enabled` alone and explain the rest without a second lookup.
 * The call is safe on a raw selection: a non-string `text` reads as empty, and a
 * context that omits a capability flag reads as "not available".
 */
export function actionsFor(selection: TextSelection, context: SelectionContext): SelectionAction[] {
  const described = describe(selection);
  const facts: SelectionFacts = {
    kind: kindWithHints(described, context),
    empty: described.trimmed === '',
    providerConfigured: context.providerConfigured === true,
    hasTranslation: context.hasTranslation === true,
    hasBlock: typeof selection.blockId === 'string' && selection.blockId.trim() !== '',
    hasRect: selection.rect !== undefined,
    sensitive: described.trimmed === '' ? [] : detectSensitive(described.trimmed),
  };
  return ACTION_SPECS.map(spec => actionFor(spec, facts));
}

// --- Ordering --------------------------------------------------------------

/** Position of an action in {@link SELECTION_ACTION_IDS}; unknown ids sort last. */
function canonicalRank(id: SelectionActionId): number {
  const index = SELECTION_ACTION_IDS.indexOf(id);
  return index === -1 ? SELECTION_ACTION_IDS.length : index;
}

/**
 * Groups actions for rendering: {@link SELECTION_GROUPS} order, empty groups omitted,
 * and canonical order inside each group whatever order the caller passed. Actions whose
 * group is not one of the four are dropped rather than rendered in a place no surface
 * styles.
 */
export function orderedGroups(actions: readonly SelectionAction[]): SelectionActionGroup[] {
  const groups: SelectionActionGroup[] = [];
  for (const group of SELECTION_GROUPS) {
    const members = actions
      .filter(action => action.group === group)
      .sort((left, right) => canonicalRank(left.id) - canonicalRank(right.id));
    if (members.length > 0) groups.push({ group, actions: members });
  }
  return groups;
}

/** The actions a surface may offer, keeping the order they came in. */
export function filterEnabled(actions: readonly SelectionAction[]): SelectionAction[] {
  return actions.filter(action => action.enabled);
}

export interface SelectionActionAudit {
  readonly kind: 'selection-action';
  readonly actionId: SelectionActionId;
  readonly page: number;
  readonly blockId?: string;
  readonly outcome: 'executed' | 'blocked';
  readonly reason?: SelectionReasonKey;
}

export interface SelectionActionMenuSnapshot {
  readonly open: boolean;
  readonly selectedIndex: number;
  readonly actions: readonly SelectionAction[];
  readonly empty: boolean;
}

export interface SelectionActionKeyEvent {
  readonly key: string;
}

/**
 * Keyboard-ready selection menu state. Hosts render this model however they like;
 * execution returns an audit record and never invokes a disabled action.
 */
export class SelectionActionMenu {
  private openState = false;
  private selected = 0;

  constructor(
    private readonly selection: Pick<TextSelection, 'page' | 'blockId'>,
    private readonly actions: readonly SelectionAction[],
    private readonly execute: (action: SelectionActionId) => void,
  ) {}

  open(): SelectionActionMenuSnapshot {
    this.openState = true;
    this.selected = 0;
    return this.snapshot();
  }

  close(): SelectionActionMenuSnapshot {
    this.openState = false;
    return this.snapshot();
  }

  move(delta: number): SelectionActionMenuSnapshot {
    if (this.actions.length === 0) return this.snapshot();
    const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    this.selected = (this.selected + step + this.actions.length) % this.actions.length;
    return this.snapshot();
  }

  handleKey(event: SelectionActionKeyEvent): SelectionActionAudit | SelectionActionMenuSnapshot {
    if (event.key === 'Escape') return this.close();
    if (event.key === 'ArrowDown') return this.move(1);
    if (event.key === 'ArrowUp') return this.move(-1);
    if (event.key === 'Home') { this.selected = 0; return this.snapshot(); }
    if (event.key === 'End') { this.selected = Math.max(0, this.actions.length - 1); return this.snapshot(); }
    if (event.key === 'Enter' || event.key === ' ') return this.executeSelected();
    return this.snapshot();
  }

  executeSelected(): SelectionActionAudit {
    const action = this.actions[this.selected];
    if (!action) return { kind: 'selection-action', actionId: 'copy', page: this.selection.page, outcome: 'blocked', reason: 'selectionReasonNoText' };
    if (!action.enabled) {
      return {
        kind: 'selection-action',
        actionId: action.id,
        page: this.selection.page,
        ...(this.selection.blockId ? { blockId: this.selection.blockId } : {}),
        outcome: 'blocked',
        ...(action.reason ? { reason: action.reason } : {}),
      };
    }
    this.execute(action.id);
    this.openState = false;
    return {
      kind: 'selection-action',
      actionId: action.id,
      page: this.selection.page,
      ...(this.selection.blockId ? { blockId: this.selection.blockId } : {}),
      outcome: 'executed',
    };
  }

  snapshot(): SelectionActionMenuSnapshot {
    const selectedIndex = this.actions.length === 0 ? 0 : Math.min(this.selected, this.actions.length - 1);
    this.selected = selectedIndex;
    return { open: this.openState, selectedIndex, actions: [...this.actions], empty: this.actions.length === 0 };
  }
}
