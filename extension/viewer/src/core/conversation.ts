/**
 * Multi-turn conversation about a document (backlog item I13).
 *
 * A reader asks a question, reads the answer, then asks a follow-up — about the same
 * page, about the answer just given, about a number that appeared three turns ago. Two
 * things make that safe to build on. First, every turn keeps the citations it produced,
 * so a later answer can be traced back to the turn that first pointed at a region and no
 * attribution is lost as the conversation grows. Second, the conversation never grows
 * past what a prompt can carry without saying how much it left out.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network, no I/O. Two
 *   conversations fed the same turns in the same order return equal results.
 * - Nothing changes silently. `addUser` and `addAssistant` append and return the turn;
 *   `context` reports `droppedTurns`; `prune` reports `{ removed, kept }` and refuses a
 *   prune that would leave no user turn. A caller can always tell how many turns a
 *   result does not carry.
 * - Turns are held oldest first and are never reordered. `ConversationTurn.index` is the
 *   turn's position in the conversation as it is now; `prune` renumbers the tail it
 *   keeps, and renumbers the citations stored on those turns with it, so an index always
 *   addresses the current conversation.
 * - Lengths are measured in Unicode code points, as `multi-document.ts` measures its
 *   context budget, so a budget means the same thing for Latin, Vietnamese and CJK text.
 *   Only the turn text counts; citations hang off the turn and cost no budget.
 * - A citation is read structurally: `citations.ts` markers (`{ page, blockId?, raw }`)
 *   and `multi-document.ts` answer citations (`{ documentId, page, raw }`) can be passed
 *   as they are. What is stored is normalised enough to fold one target across turns:
 *   document, page, block and an explicit id, with the raw marker as the last identity.
 * - The context budget never drops the most recent turns. The last `keepTurns` turns
 *   (default {@link DEFAULT_KEEP_TURNS}) are always carried, even when those turns alone
 *   exceed `maxCharacters`; older turns join only while they fit, contiguously, so the
 *   prompt never holds a gap where a turn used to be.
 *
 * ```ts
 * const conversation = createConversation();
 * conversation.addUser('What is the maintenance budget?');
 * conversation.addAssistant('It is 12,000 units a year [p12:r3].', parseCitations(answer).citations);
 * const { messages, droppedTurns } = conversation.context({ maxCharacters: 4000 });
 * ```
 */

// --- Public shape ----------------------------------------------------------

/** Who produced a turn. */
export type ConversationRole = 'user' | 'assistant';

/**
 * The most recent turns a character budget may never drop.
 *
 * Four: a follow-up usually depends on the question and the answer just before it, and
 * sometimes on the pair before that when the reader is quoting back and forth. Older
 * turns still join the context while they fit.
 */
export const DEFAULT_KEEP_TURNS = 4;

/**
 * Character budget used when {@link ContextOptions.maxCharacters} is not given.
 *
 * Twelve thousand code points is roughly three thousand tokens: room for several turns
 * of prose while the prompt still has space for the document context those turns are
 * about.
 */
export const DEFAULT_CONTEXT_CHARACTERS = 12_000;

/**
 * A citation as a caller hands it to {@link Conversation.addAssistant}.
 *
 * Every field is optional because a caller may know only part of the target: a model
 * answer resolved by `citations.ts` has a page and often a block, a multi-document
 * answer has a document and a page, and a caller with its own citation registry has an
 * id. A citation that names nothing at all is still stored — it is not silently dropped
 * — but it cannot be folded into another one.
 */
export interface CitationInput {
  /**
   * Explicit identity. Two citations with the same id are one target whatever their
   * other fields say, which is what a caller that already has stable citation ids
   * should pass.
   */
  id?: string;
  /** Document the citation belongs to; omitted for a single-document reader. */
  documentId?: string;
  /** 1-based page. A non-integer or negative value is read as "no page". */
  page?: number | null;
  /** Block id on the page, when the citation points at a region rather than a page. */
  blockId?: string | null;
  /** The marker as the answer wrote it, for example `[p12:r3]`; identity of last resort. */
  raw?: string;
}

/** A citation as the conversation stores it. */
export interface ConversationCitation {
  /** Identity used to fold the same target across turns; stable for the conversation. */
  key: string;
  /** Document the citation belongs to, or `null` when the caller named none. */
  documentId: string | null;
  /** 1-based page, or `null` when the citation names no page. */
  page: number | null;
  /** Block id, or `null` when the citation names only a page. */
  blockId: string | null;
  /** The marker as it first appeared, or `null` when the caller wrote none. */
  raw: string | null;
  /**
   * 0-based turn indices that produced this citation, in first-seen order. A citation
   * stored on a turn carries that turn alone; {@link Conversation.allCitations} folds
   * the per-turn copies into one entry listing every turn that produced it.
   */
  turns: number[];
}

/** One turn of the conversation. */
export interface ConversationTurn {
  /** 0-based position in the conversation as it is currently held. */
  index: number;
  role: ConversationRole;
  /** The text exactly as it was added. */
  text: string;
  /** Distinct citations this turn produced, in first-seen order; empty for a user turn. */
  citations: ConversationCitation[];
}

/** What {@link Conversation.context} returns. */
export interface ConversationContext {
  /**
   * The turns carried into the prompt, oldest first, contiguous at the recent end.
   * Each message is the turn itself, so its citations travel with it.
   */
  messages: ConversationTurn[];
  /**
   * How many turns the conversation holds that `messages` does not carry. Zero when
   * every held turn fits, and never negative.
   */
  droppedTurns: number;
  /** The caller-provided digest, present only when one was set. */
  summary?: string;
}

/** Options for {@link Conversation.turns}. */
export interface TurnQueryOptions {
  /**
   * How many of the most recent turns to return. Omitted or not a finite number: every
   * held turn. Zero or less: none. Turns always come back in chronological order.
   */
  limit?: number;
}

/** Options for {@link Conversation.context}. */
export interface ContextOptions {
  /**
   * Character budget for the message texts, in code points; default
   * {@link DEFAULT_CONTEXT_CHARACTERS}. A value that is not positive selects the
   * default.
   */
  maxCharacters?: number;
  /**
   * Most recent turns the budget may never drop; default {@link DEFAULT_KEEP_TURNS}. A
   * value below one is read as one: a context without at least the latest turn would
   * answer nothing.
   */
  keepTurns?: number;
}

/** Options for {@link Conversation.prune}. */
export interface PruneOptions {
  /** How many of the most recent turns to keep. */
  keepTurns: number;
}

/** What {@link Conversation.prune} did. */
export interface PruneResult {
  /** Turns dropped from the oldest end; 0 when the prune was refused. */
  removed: number;
  /** Turns the conversation holds afterwards; the whole conversation when refused. */
  kept: number;
  /**
   * Set when the prune was refused because the tail it would keep holds no user turn.
   * The conversation is unchanged in that case, and `removed` is 0, so the flag is what
   * tells a refusal apart from a prune that happened to remove nothing.
   */
  refused?: true;
}

/** A bounded, attributable conversation; see {@link createConversation}. */
export interface Conversation {
  /** Appends a user turn and returns it as it stood when added. */
  addUser(text: string): ConversationTurn;
  /**
   * Appends an assistant turn with the citations it produced and returns it as it
   * stood when added. Omitted citations are no citations.
   */
  addAssistant(text: string, citations?: readonly CitationInput[]): ConversationTurn;
  /** The turns currently held, oldest first, at most `limit` of the most recent ones. */
  turns(options?: TurnQueryOptions): ConversationTurn[];
  /** The turns to carry into a prompt, the count left out, and the summary when set. */
  context(options?: ContextOptions): ConversationContext;
  /**
   * Sets the digest carried in every context, or clears it with `null`, an empty string
   * or a blank string. The digest is caller-provided and is not counted against
   * `maxCharacters`.
   */
  setSummary(digest: string | null | undefined): void;
  /**
   * The citations one turn produced, in first-seen order. An index the conversation does
   * not hold yields an empty list rather than throwing.
   */
  citationsFor(turnIndex: number): ConversationCitation[];
  /**
   * Every citation the held turns produced, de-duplicated across turns and in first-seen
   * order, each listing every turn that produced it.
   */
  allCitations(): ConversationCitation[];
  /**
   * Drops turns from the oldest end, keeping the `keepTurns` most recent ones.
   *
   * Refuses when the result would hold no user turn — a conversation with no question
   * left is not a conversation — and reports that refusal instead of changing anything.
   */
  prune(options: PruneOptions): PruneResult;
}

/**
 * Creates an empty conversation.
 *
 * The object holds its own turn list; nothing passed in or handed out is shared with it
 * except through the copies its methods return. There is no capacity built in: growth is
 * bounded by {@link Conversation.prune} when the caller wants to forget, and by the
 * budget {@link Conversation.context} applies when the caller wants a prompt.
 */
export function createConversation(): Conversation {
  let history: ConversationTurn[] = [];
  let summary: string | null = null;

  const append = (
    role: ConversationRole,
    text: unknown,
    citations: readonly CitationInput[] | undefined,
  ): ConversationTurn => {
    const index = history.length;
    const turn: ConversationTurn = {
      index,
      role,
      text: typeof text === 'string' ? text : '',
      citations: readCitations(citations, index),
    };
    history.push(turn);
    return snapshot(turn);
  };

  return {
    addUser(text: string): ConversationTurn {
      return append('user', text, []);
    },
    addAssistant(text: string, citations?: readonly CitationInput[]): ConversationTurn {
      return append('assistant', text, citations);
    },
    turns(options?: TurnQueryOptions): ConversationTurn[] {
      return readTurns(history, options?.limit);
    },
    context(options?: ContextOptions): ConversationContext {
      return buildContext(history, summary, options);
    },
    setSummary(digest: string | null | undefined): void {
      summary = readDigest(digest);
    },
    citationsFor(turnIndex: number): ConversationCitation[] {
      if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= history.length) return [];
      const turn = history[turnIndex];
      return turn ? turn.citations.map(copyCitation) : [];
    },
    allCitations(): ConversationCitation[] {
      const ordered: ConversationCitation[] = [];
      const byKey = new Map<string, ConversationCitation>();
      for (const turn of history) {
        for (const citation of turn.citations) {
          const seen = byKey.get(citation.key);
          if (seen) {
            if (!seen.turns.includes(turn.index)) seen.turns.push(turn.index);
            continue;
          }
          const folded = copyCitation(citation);
          byKey.set(folded.key, folded);
          ordered.push(folded);
        }
      }
      return ordered;
    },
    prune(options: PruneOptions): PruneResult {
      const held = history.length;
      if (held === 0) return { removed: 0, kept: 0 };

      const keep = readPruneKeep(options?.keepTurns);
      if (keep >= held) return { removed: 0, kept: held };

      const start = held - keep;
      const tail = history.slice(start);
      // The surviving turns are the conversation: renumber them from zero, and every
      // citation with them, so `citationsFor` keeps addressing what is there now.
      const kept: ConversationTurn[] = tail.map((turn, position) => ({
        index: position,
        role: turn.role,
        text: turn.text,
        citations: turn.citations.map(citation => ({ ...citation, turns: [position] })),
      }));

      if (!kept.some(turn => turn.role === 'user')) {
        return { removed: 0, kept: held, refused: true };
      }

      history = kept;
      return { removed: held - kept.length, kept: kept.length };
    },
  };
}

// --- Normalisation ---------------------------------------------------------

/**
 * Reads one caller's citations into the stored shape, folding repeats inside the turn.
 *
 * Identity is resolved in this order: an explicit `id`, then the document/page/block
 * tuple, then the raw marker. A citation that names none of those is still stored; its
 * key is its position in the turn, which is the only identity it has.
 */
function readCitations(input: readonly CitationInput[] | undefined, turnIndex: number): ConversationCitation[] {
  const source = Array.isArray(input) ? input : [];
  const citations: ConversationCitation[] = [];
  const seen = new Set<string>();

  source.forEach((candidate, position) => {
    if (candidate === null || typeof candidate !== 'object') return;
    const id = readText(candidate.id);
    const documentId = readText(candidate.documentId);
    const page = readPage(candidate.page);
    const blockId = readText(candidate.blockId);
    const raw = typeof candidate.raw === 'string' && candidate.raw.trim().length > 0 ? candidate.raw : null;
    const named = citationKey(id, documentId, page, blockId, raw);
    const key = named.length > 0 ? named : `untargeted:${turnIndex}:${position}`;
    if (seen.has(key)) return;
    seen.add(key);
    citations.push({ key, documentId, page, blockId, raw, turns: [turnIndex] });
  });

  return citations;
}

/**
 * The identity of a citation: `id:<id>`, `target:<doc>/<page>/<block>` with only the
 * parts the caller named, or `raw:<marker>`. The prefixes keep the three namespaces
 * apart, so an explicit id can never coincide with a target tuple.
 */
function citationKey(
  id: string | null,
  documentId: string | null,
  page: number | null,
  blockId: string | null,
  raw: string | null,
): string {
  if (id !== null) return `id:${id}`;
  const parts: string[] = [];
  if (documentId !== null) parts.push(`doc:${documentId}`);
  if (page !== null) parts.push(`page:${page}`);
  if (blockId !== null) parts.push(`block:${blockId}`);
  if (parts.length > 0) return `target:${parts.join('\u0000')}`;
  return raw !== null ? `raw:${raw}` : '';
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPage(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function readDigest(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().length > 0 ? value : null;
}

// --- Turn queries ----------------------------------------------------------

/** The held turns, or the most recent `limit` of them, as fresh copies. */
function readTurns(history: readonly ConversationTurn[], limit: number | undefined): ConversationTurn[] {
  const size = readLimit(limit);
  if (size === null || size >= history.length) return history.map(snapshot);
  return history.slice(history.length - size).map(snapshot);
}

/**
 * A turn limit. Omitted or not finite: `null`, meaning every turn; a finite value is
 * floored and clamped at zero, so `limit: 2.9` keeps two turns and `limit: 0` keeps none.
 */
function readLimit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

// --- Context building ------------------------------------------------------

/**
 * Selects the recent tail that fits the budget.
 *
 * Walking back from the newest turn, the last `keepTurns` turns are taken whatever they
 * cost; before them a turn joins while the running total stays within `maxCharacters`,
 * and the first one that does not fit ends the walk. That keeps the carried turns a
 * contiguous suffix: a prompt with a hole in the middle would look like context the
 * reader never gave.
 */
function buildContext(
  history: readonly ConversationTurn[],
  summary: string | null,
  options: ContextOptions | undefined,
): ConversationContext {
  const budget = positiveOr(options?.maxCharacters, DEFAULT_CONTEXT_CHARACTERS);
  const keep = Math.min(readKeepTurns(options?.keepTurns), history.length);
  const floor = history.length - keep;

  let start = history.length;
  let total = 0;
  for (let position = history.length - 1; position >= 0; position -= 1) {
    const turn = history[position];
    if (!turn) break;
    const cost = charLength(turn.text);
    const required = position >= floor;
    if (!required && total + cost > budget) break;
    total += cost;
    start = position;
  }

  const messages = history.slice(start).map(snapshot);
  const context: ConversationContext = { messages, droppedTurns: history.length - messages.length };
  if (summary !== null) context.summary = summary;
  return context;
}

/**
 * The turn floor for {@link Conversation.context}: at least one, defaulting to
 * {@link DEFAULT_KEEP_TURNS} so a context is never empty while the conversation is not.
 */
function readKeepTurns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_KEEP_TURNS;
  return Math.max(1, Math.floor(value));
}

/**
 * The keep count for {@link Conversation.prune}. Unlike the context floor this may be
 * zero: a requested prune that keeps nothing is refused by the caller, not silently
 * rounded up, and an unreadable count is treated the same way.
 */
function readPruneKeep(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

// --- Copies ----------------------------------------------------------------

/** A deep-enough copy: callers may edit what they are shown without touching the store. */
function snapshot(turn: ConversationTurn): ConversationTurn {
  return {
    index: turn.index,
    role: turn.role,
    text: turn.text,
    citations: turn.citations.map(copyCitation),
  };
}

function copyCitation(citation: ConversationCitation): ConversationCitation {
  return {
    key: citation.key,
    documentId: citation.documentId,
    page: citation.page,
    blockId: citation.blockId,
    raw: citation.raw,
    turns: [...citation.turns],
  };
}

// --- Small helpers ---------------------------------------------------------

/** Length in Unicode code points: one emoji, one CJK character, one letter each 1. */
function charLength(value: string): number {
  return typeof value === 'string' ? [...value].length : 0;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
