/**
 * Append-only local audit log (backlog M05/M08).
 *
 * A reader that imports, extracts, translates, redacts, exports, reviews and deletes a
 * document should be able to say what happened to that file without a server, an account
 * or a network request. This module is that record: a flat list of {@link AuditEvent}
 * values, one per step, with a hash chain over it so an edited record can be told apart
 * from one the app wrote.
 *
 * Contract:
 *
 * - **Append-only.** `append` adds; nothing here removes, reorders or rewrites an event.
 *   `entries`, `chain` and `append` all hand out copies, so a caller holding one event
 *   cannot change the log behind its back.
 * - **Validated at the door.** An unknown kind, a missing document id, an unknown actor,
 *   a timestamp without a zone, or a detail that is not a flat, bounded fact is refused
 *   with a typed {@link AuditError} whose `field` names the offending member. Refusal
 *   happens before anything is stored.
 * - **No secrets in the log.** Every detail value and field name is scanned for an email
 *   address, a phone number and the shapes provider credentials take; a match is refused
 *   with `secret-in-detail` and the message names the field, never the value. A refusal
 *   cannot itself become the leak. Detail values are also capped in size and shape: a
 *   detail is a fact about an event, not a copy of the document. The document id is
 *   shape-checked but not scanned — it is an opaque id (`doc-<sha16>` by default) that may
 *   legitimately be a long number — and a report masks it anyway.
 * - **Hash-chained.** `chain()` numbers every event with SHA-256 over `prevHash` and the
 *   canonical JSON of the event, starting from the empty {@link AUDIT_GENESIS_HASH}.
 *   `verifyChain()` returns the first entry that does not follow its predecessor, or
 *   `null` when the chain is clean. `persist()` writes the chain, `restoreAuditLog()`
 *   refuses a document that is not exactly the chain it claims to be, and every field is
 *   re-validated on the way back in — a hand-edited record cannot re-enter the log with a
 *   secret in it.
 * - **It is a tripwire, not a signature.** The chain catches an edit that does not rewrite
 *   the rest of the file, which is what happens when someone opens the stored record in a
 *   text editor. A tamperer who recomputes every hash can produce a self-consistent log;
 *   proving otherwise needs a key, and a key on the same machine as the log buys nothing.
 *   The digest is here so a reader can compare what the app reports with what is stored,
 *   not to defeat a determined local attacker.
 * - **Local and self-contained.** No DOM, no network, no clock read except through the
 *   injectable `now` (so a replay writes the same bytes), no dependency, and a synchronous
 *   digest — SHA-256 is implemented here because `crypto.subtle` is async and absent in a
 *   page without a secure context.
 *
 * Persisted form, schema version 1 (the only version this build reads):
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "kind": "mirror.audit",
 *   "chain": [
 *     { "hash": "<64 hex>", "prevHash": "", "entry": { "kind": "import", "...": "..." } }
 *   ]
 * }
 * ```
 */

// --- Public shape ----------------------------------------------------------

/** Schema version written by {@link AuditLog.persist} and the only one restore reads. */
export const AUDIT_SCHEMA_VERSION = 1;

/** `kind` of a persisted audit document, so another stored record cannot be misread as one. */
export const AUDIT_DOCUMENT_KIND = 'mirror.audit';

/** `prevHash` of the first entry: the chain starts from nothing, not from a borrowed digest. */
export const AUDIT_GENESIS_HASH = '';

/** How many detail fields one event may carry. */
export const MAX_AUDIT_DETAILS = 32;

/** How many values one list detail may carry. */
export const MAX_AUDIT_DETAIL_ITEMS = 64;

/** Longest detail text kept, in UTF-16 code units. */
export const MAX_AUDIT_DETAIL_TEXT = 512;

/** Longest detail field name kept, in UTF-16 code units. */
export const MAX_AUDIT_DETAIL_KEY = 64;

/** Longest document id kept, in UTF-16 code units. */
export const MAX_DOCUMENT_ID = 200;

/**
 * What the app did with a document.
 *
 * The list is closed on purpose: a log a reader can sum up is more useful than one that
 * accepts any verb, and a typo in a call site becomes a refusal instead of a new category.
 */
export type AuditEventKind =
  | 'import'
  | 'extract'
  | 'translate'
  | 'redact'
  | 'export'
  | 'review'
  | 'delete'
  | 'config';

/** Every {@link AuditEventKind}, in the order documentation lists them. */
export const AUDIT_EVENT_KINDS: readonly AuditEventKind[] = [
  'import',
  'extract',
  'translate',
  'redact',
  'export',
  'review',
  'delete',
  'config',
];

/**
 * Who caused the step.
 *
 * `user` is a deliberate action through the interface, `app` is a step the reader took on
 * its own (extraction after an import), and `system` is housekeeping outside either (a
 * settings migration after an update).
 */
export type AuditActor = 'user' | 'app' | 'system';

/** Every {@link AuditActor}. */
export const AUDIT_ACTORS: readonly AuditActor[] = ['user', 'app', 'system'];

/** One scalar inside a detail: text, a number, a boolean or null. */
export type AuditDetailValue = string | number | boolean | null;

/** One detail value: a scalar, or a list of scalars for a multi-value fact. */
export type AuditDetail = AuditDetailValue | readonly AuditDetailValue[];

/** A flat set of facts about an event; empty rather than absent when a caller gives none. */
export type AuditDetails = Readonly<Record<string, AuditDetail>>;

/** One recorded step, as the log stores it. */
export interface AuditEvent {
  /** What happened. */
  kind: AuditEventKind;
  /** The document it happened to; trimmed of surrounding whitespace. */
  documentId: string;
  /** When it happened: UTC ISO-8601, zone included, as `toISOString()` writes it. */
  at: string;
  /** Who caused it. */
  actor: AuditActor;
  /** The facts of the step; `{}` when the caller gave none. */
  details: AuditDetails;
}

/**
 * What `append` accepts.
 *
 * `documentId` and `kind` are required; `actor` defaults to `'user'` (a local reader's
 * every step is started by the reader until a caller says otherwise) and `at` defaults to
 * the log's clock. Fields outside the documented shape are ignored rather than stored, so
 * a spread of a larger object cannot smuggle an unvalidated field into the log.
 */
export interface AuditEventInput {
  kind: AuditEventKind;
  documentId: string;
  at?: string;
  actor?: AuditActor;
  details?: AuditDetails;
}

/** One link of the chain: a hash, the hash it follows, and the event it covers. */
export interface AuditChainEntry {
  /** SHA-256 of this entry, lowercase hex. */
  hash: string;
  /** Hash of the entry before it, or {@link AUDIT_GENESIS_HASH} for the first. */
  prevHash: string;
  /** The event the two hashes describe. */
  entry: AuditEvent;
}

export interface AuditLogOptions {
  /**
   * Clock used when an event arrives without `at`, returning a UTC ISO-8601 timestamp.
   * Injectable so a replay and a test write the same bytes; defaults to the system clock.
   */
  now?: () => string;
}

// --- Errors ----------------------------------------------------------------

export type AuditErrorCode =
  | 'unknown-kind'
  | 'missing-document-id'
  | 'invalid-document-id'
  | 'unknown-actor'
  | 'invalid-timestamp'
  | 'invalid-details'
  | 'secret-in-detail'
  | 'malformed-json'
  | 'malformed-log'
  | 'unsupported-schema-version'
  | 'broken-chain';

/**
 * A refused audit operation.
 *
 * `code` is the machine-readable reason, `field` the member that failed (`details.note`,
 * `chain[1].entry.at`, `schemaVersion`) and `index` the chain position, set only by
 * `broken-chain`. The message repeats the field and never repeats a refused value.
 */
export class AuditError extends Error {
  readonly code: AuditErrorCode;
  readonly field: string;
  readonly index: number | null;

  constructor(code: AuditErrorCode, message: string, field = '', index: number | null = null) {
    super(field === '' ? message : `${field}: ${message}`);
    this.name = 'AuditError';
    this.code = code;
    this.field = field;
    this.index = index;
  }
}

// --- Secret detection ------------------------------------------------------

/** What a refused detail looked like, in the words the error uses. */
export type SecretKind = 'email' | 'phone' | 'api-key';

const SECRET_LABELS: Readonly<Record<SecretKind, string>> = {
  email: 'an email address',
  phone: 'a phone number',
  'api-key': 'an API key or password',
};

interface SecretRule {
  kind: SecretKind;
  /** Stateless probe: no `g` flag, so `test` does not move between calls. */
  probe: RegExp;
  /** Global copy used by {@link redactSecrets}. */
  sweep: RegExp;
}

function secretRule(kind: SecretKind, source: string, flags = 'u'): SecretRule {
  return { kind, probe: new RegExp(source, flags), sweep: new RegExp(source, `${flags}g`) };
}

/**
 * The shapes this log refuses.
 *
 * Deliberately narrow: an address, a dialable number, and the prefixes credentials are
 * actually written with. A 64-character hex digest is *not* on the list — the log is where
 * a document hash belongs — and neither is a bare number, so page and block counts pass.
 */
const SECRET_RULES: readonly SecretRule[] = [
  secretRule('email', String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}`),
  // Provider prefixes come before the phone rule: a key body is a run of digits and letters,
  // and a 10-digit stretch of it can look like a dialable number. Naming the key and masking
  // the whole of it is both the truer refusal and the cleaner redaction.
  // OpenAI/Anthropic-style sk-, GitHub, AWS, Google, Slack.
  secretRule('api-key', String.raw`\bsk-[A-Za-z0-9_-]{16,}`),
  secretRule('api-key', String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`),
  secretRule('api-key', String.raw`\bAKIA[0-9A-Z]{16}\b`),
  secretRule('api-key', String.raw`\bAIza[0-9A-Za-z_-]{30,}`),
  secretRule('api-key', String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}`),
  secretRule('api-key', String.raw`\bBearer\s+[A-Za-z0-9._~+/=-]{16,}`),
  // The label-and-value form a log line or a pasted config snippet takes.
  secretRule(
    'api-key',
    String.raw`(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*\S{4,}`,
    'iu',
  ),
  // Vietnamese dialling prefixes, as redact.ts recognises them, plus any other international
  // number with a leading plus; a bare digit run is a count, not a phone.
  secretRule('phone', String.raw`(?<![\d+])(?:\(\+84\)|\+84|0)(?:[ .-]?\d){9,10}(?!\d)`),
  secretRule('phone', String.raw`(?<!\d)\+\d{9,15}(?!\d)`),
];

/** The one marker {@link redactSecrets} leaves in place of a value. */
const REDACTED = '[redacted]';

/**
 * The first kind of secret `text` looks like, or `null`.
 *
 * Order is the order of {@link SECRET_RULES}, so a string that matches two shapes reports
 * the first one; which kind it is only matters for the sentence in the refusal.
 */
export function findSecret(text: string): SecretKind | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const rule of SECRET_RULES) {
    if (rule.probe.test(text)) return rule.kind;
  }
  return null;
}

/**
 * Masks every secret-looking span in `text`.
 *
 * The log refuses secrets at the door, so this exists for the one artifact that leaves the
 * app: a report is what a reader copies into a bug report or an email, and a value that
 * still looks like an address there must not travel.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string') return '';
  let redacted = text;
  for (const rule of SECRET_RULES) redacted = redacted.replace(rule.sweep, REDACTED);
  return redacted;
}

/** The refusal for a value (or field name) that looks like a secret; never repeats it. */
function secretRefusal(kind: SecretKind, field: string, subject: 'value' | 'field name'): AuditError {
  return new AuditError(
    'secret-in-detail',
    `the detail ${subject} looks like ${SECRET_LABELS[kind]}; an audit log must not record personal data or credentials, so nothing was stored.`,
    field,
  );
}

// --- The log ---------------------------------------------------------------

/**
 * Append-only log of what the app did with each document.
 *
 * The log holds its own records and returns copies, so an event is only ever changed by a
 * new `append`. Order is global append order; `entries(documentId)` keeps that order while
 * narrowing to one document, which is what a "what happened to this file" view reads.
 */
export class AuditLog {
  private readonly events: AuditEvent[] = [];
  private readonly clock: () => string;

  constructor(options: AuditLogOptions = {}) {
    const now = options?.now;
    this.clock = typeof now === 'function' ? now : systemClock;
  }

  /** How many events the log holds, across every document. */
  get size(): number {
    return this.events.length;
  }

  /**
   * Validates `input` and appends it, returning a copy of the stored event.
   *
   * Nothing is stored when validation refuses: a half-written event would leave a hole in
   * the chain, so the check and the append are the same step.
   */
  append(input: AuditEventInput): AuditEvent {
    const event = readEvent(input, '', this.clock);
    this.events.push(event);
    return cloneEvent(event);
  }

  /**
   * Copies of one document's events in append order, or of every event when `documentId`
   * is omitted. An unknown document is an empty list, not an error: nothing happened to it
   * yet.
   */
  entries(documentId?: string): AuditEvent[] {
    const matching =
      documentId === undefined
        ? this.events
        : this.events.filter(event => event.documentId === readDocumentId(documentId, 'documentId'));
    return matching.map(cloneEvent);
  }

  /** Every entry of the chain, in append order, as copies. */
  chain(): AuditChainEntry[] {
    return chainOf(this.events);
  }

  /**
   * The first entry that does not follow its predecessor, or `null` when the chain is
   * clean. Indexes are positions in {@link chain}: `0` is the first event ever appended.
   */
  verifyChain(): number | null {
    return verifyAuditChain(this.chain());
  }

  /**
   * The whole log as canonical JSON, schema version included, ready for storage.
   *
   * The bytes are stable for a stable log: fixed key order, sorted detail fields, two-space
   * indentation. The chain in the document is the same chain {@link chain} returns, so a
   * reader can recompute it from the events and compare.
   */
  persist(): string {
    return JSON.stringify(
      {
        schemaVersion: AUDIT_SCHEMA_VERSION,
        kind: AUDIT_DOCUMENT_KIND,
        chain: this.chain().map(item => ({
          hash: item.hash,
          prevHash: item.prevHash,
          entry: serializeEvent(item.entry),
        })),
      },
      null,
      2,
    );
  }

  /**
   * Reads a log written by {@link persist}.
   *
   * The same function as {@link restoreAuditLog}, offered here because a caller that holds
   * the class reads `AuditLog.restore(text)` as the pair of `log.persist()`.
   */
  static restore(json: string, options: AuditLogOptions = {}): AuditLog {
    return restoreAuditLog(json, options);
  }
}

/** The clock a log uses when a caller injects none. */
function systemClock(): string {
  return new Date().toISOString();
}

// --- Canonical form and the chain ------------------------------------------

/** Domain separator, so this digest is never mistaken for a digest of the same JSON elsewhere. */
const CHAIN_DOMAIN = 'mirror.audit.v1';

/**
 * The canonical JSON of one event, as the chain hashes it.
 *
 * Fixed key order, `details` as key-sorted `[key, value]` pairs, no whitespace. The pair
 * form is deliberate: `JSON.stringify` writes integer-like object keys first whatever order
 * they were inserted in, so an object with sorted keys is not canonical; pairs are. Values
 * outside JSON become `null`, so a chain holding a tampered entry still yields an index
 * instead of an unrelated serialisation error.
 */
function canonicalEventJson(entry: unknown): string {
  const record = isRecord(entry) ? entry : {};
  return JSON.stringify({
    kind: jsonScalar(record.kind),
    documentId: jsonScalar(record.documentId),
    at: jsonScalar(record.at),
    actor: jsonScalar(record.actor),
    details: detailPairs(record.details).map(([key, value]) => [key, jsonDetail(value)]),
  });
}

/** A scalar as JSON can hold it; anything else is `null`. */
function jsonScalar(value: unknown): string | number | boolean | null {
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

/** A detail value as canonical JSON holds it: a scalar, or a list of scalars. */
function jsonDetail(value: unknown): string | number | boolean | null | Array<string | number | boolean | null> {
  return Array.isArray(value) ? value.map(jsonScalar) : jsonScalar(value);
}

/** A detail record as sorted pairs; anything unreadable is treated as no details at all. */
function detailPairs(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .sort()
    .map(key => [key, value[key]] as [string, unknown]);
}

/**
 * One link: SHA-256 over the domain, the previous hash and the canonical event.
 *
 * The canonical JSON never contains a raw newline, so the newlines around `prevHash` frame
 * it unambiguously.
 */
function entryHash(prevHash: string, entry: unknown): string {
  return sha256Hex(`${CHAIN_DOMAIN}\n${prevHash}\n${canonicalEventJson(entry)}`);
}

/** The chain of `events`, each link hashing the one before. */
function chainOf(events: readonly AuditEvent[]): AuditChainEntry[] {
  const chain: AuditChainEntry[] = [];
  let prevHash = AUDIT_GENESIS_HASH;
  for (const event of events) {
    const hash = entryHash(prevHash, event);
    chain.push({ hash, prevHash, entry: cloneEvent(event) });
    prevHash = hash;
  }
  return chain;
}

/**
 * The first entry that does not follow its predecessor, or `null`.
 *
 * An entry is broken when its `prevHash` is not the previous `hash`, when its own `hash` is
 * not the digest of its event, or when the line is not a chain entry at all. The first
 * broken index is returned, because everything after it is suspect for the same reason.
 */
export function verifyAuditChain(chain: readonly AuditChainEntry[]): number | null {
  if (!Array.isArray(chain)) {
    throw new AuditError('malformed-log', 'a chain is the array returned by chain().', 'chain');
  }
  let prevHash = AUDIT_GENESIS_HASH;
  for (let index = 0; index < chain.length; index += 1) {
    const item: unknown = chain[index];
    if (
      !isRecord(item) ||
      typeof item.hash !== 'string' ||
      typeof item.prevHash !== 'string' ||
      !isRecord(item.entry) ||
      item.prevHash !== prevHash
    ) {
      return index;
    }
    let expected: string;
    try {
      expected = entryHash(prevHash, item.entry);
    } catch {
      return index;
    }
    if (item.hash !== expected) return index;
    prevHash = item.hash;
  }
  return null;
}

// --- Persistence -----------------------------------------------------------

/**
 * Reads a log written by {@link AuditLog.persist}.
 *
 * The version is read before any field, so a record from a newer build is refused for its
 * version rather than for a field it never had. Every chain entry is then shape-checked and
 * every event validated exactly as `append` validates one — including the secret scan —
 * before the chain is verified. A document that is not the chain it claims to be, or that
 * carries a value the log would have refused, does not restore.
 *
 * The returned log verifies clean and holds the same events, in the same order, with the
 * same chain a caller would get by appending them again.
 */
export function restoreAuditLog(json: string, options: AuditLogOptions = {}): AuditLog {
  if (typeof json !== 'string') {
    throw new AuditError('malformed-json', 'a persisted audit log is JSON text.', 'json');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AuditError('malformed-json', 'the persisted audit log is not valid JSON.', 'json');
  }

  if (!isRecord(parsed)) {
    throw new AuditError(
      'malformed-log',
      'a persisted audit log is an object with a schema version, a kind and a chain.',
      'log',
    );
  }

  if (parsed.schemaVersion !== AUDIT_SCHEMA_VERSION) {
    throw new AuditError('unsupported-schema-version', versionRefusal(parsed.schemaVersion), 'schemaVersion');
  }

  if (parsed.kind !== AUDIT_DOCUMENT_KIND) {
    throw new AuditError(
      'malformed-log',
      `the document is not an audit log (kind ${label(parsed.kind)}).`,
      'kind',
    );
  }

  // A v1 record holds exactly the fields the chain covers. A field outside them is not
  // confidential — it is unverifiable, and an unverifiable field in an audit record is worse
  // than no field at all.
  requireNoExtraKeys(parsed, DOCUMENT_KEYS, '');

  if (!Array.isArray(parsed.chain)) {
    throw new AuditError('malformed-log', 'a persisted audit log needs its chain array.', 'chain');
  }

  const chain: AuditChainEntry[] = [];
  parsed.chain.forEach((item: unknown, index: number) => {
    const at = `chain[${index}]`;
    if (!isRecord(item)) {
      throw new AuditError('malformed-log', 'a chain entry is an object of hash, prevHash and entry.', at);
    }
    requireNoExtraKeys(item, CHAIN_KEYS, at);
    requireNoExtraKeys(item.entry, EVENT_KEYS, `${at}.entry`);
    chain.push({
      hash: readHash(item.hash, `${at}.hash`),
      prevHash: readHash(item.prevHash, `${at}.prevHash`, true),
      entry: readEvent(item.entry, `${at}.entry`, null),
    });
  });

  const broken = verifyAuditChain(chain);
  if (broken !== null) {
    throw new AuditError(
      'broken-chain',
      `the audit chain breaks at entry ${broken}: the entry does not follow the hash recorded before it, so the record was edited or truncated.`,
      `chain[${broken}]`,
      broken,
    );
  }

  const log = new AuditLog(options);
  for (const item of chain) log.append(item.entry);
  return log;
}

/** The sentence for a version this build does not read. */
function versionRefusal(version: unknown): string {
  if (version === undefined) {
    return `the persisted audit log has no schema version; this build reads version ${AUDIT_SCHEMA_VERSION} only.`;
  }
  return (
    `the persisted audit log is schema version ${label(version)}, written by another build; ` +
    `this build reads version ${AUDIT_SCHEMA_VERSION} only.`
  );
}

/** One hash: 64 lowercase hex characters, or the genesis hash where an empty one is allowed. */
function readHash(value: unknown, field: string, allowGenesis = false): string {
  if (typeof value === 'string' && ((allowGenesis && value === AUDIT_GENESIS_HASH) || HASH_PATTERN.test(value))) {
    return value;
  }
  throw new AuditError(
    'malformed-log',
    allowGenesis
      ? 'a chain link is the empty genesis hash or a 64-character lowercase hex digest.'
      : 'a chain hash is a 64-character lowercase hex digest.',
    field,
  );
}

// --- Markdown --------------------------------------------------------------

/**
 * A user-facing report of what the log holds, grouped by document.
 *
 * The header counts the events and prints the chain head, so a reader comparing this file
 * with the app has something to compare. Documents appear in the order they were first
 * touched and each document's events keep append order, which is the story a reader
 * follows. Details are sorted under each event, one nested bullet per field.
 *
 * The report does not trust the log it is handed: every rendered value — the document id
 * and detail field names included — is masked by {@link redactSecrets}. The log refuses a
 * secret at the door, so this second pass normally finds nothing; it is here because a
 * report is the one artifact that leaves the app, and a stored record is exactly what an
 * older build or a hand edit could have written.
 *
 * `source` may be the log itself or the events a caller already holds (`log.entries()`);
 * both produce the same report, header included, because the head is recomputed from the
 * events.
 */
export function toMarkdown(source: AuditLog | readonly AuditEvent[]): string {
  const events = source instanceof AuditLog ? source.entries() : readEventList(source);
  const lines = ['# Document audit log', ''];

  if (events.length === 0) {
    lines.push('No events recorded.');
    return `${lines.join('\n')}\n`;
  }

  const groups = groupByDocument(events);
  const head = chainOf(events);
  lines.push(
    `${countOf(events.length, 'event')} across ${countOf(groups.length, 'document')}. ` +
      `Chain head: \`${head[head.length - 1]!.hash}\`.`,
  );

  for (const group of groups) {
    lines.push('', `## ${redactSecrets(oneLine(group.documentId)) || '(no document)'}`, '');
    for (const event of group.events) {
      lines.push(
        `- ${redactSecrets(oneLine(textOf(event.at)) || 'unknown time')} — ` +
          `**${redactSecrets(oneLine(textOf(event.kind)) || 'unknown')}** — ` +
          `${redactSecrets(oneLine(textOf(event.actor)) || 'unknown')}`,
      );
      for (const [key, value] of detailPairs(event.details)) {
        lines.push(`  - ${redactSecrets(oneLine(key)) || '(unnamed)'}: ${renderDetail(value)}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

interface DocumentGroup {
  documentId: string;
  events: AuditEvent[];
}

/** Events grouped by document, documents in first-appearance order, events in append order. */
function groupByDocument(events: readonly AuditEvent[]): DocumentGroup[] {
  const groups: DocumentGroup[] = [];
  const byId = new Map<string, DocumentGroup>();
  for (const event of events) {
    const documentId = textOf(event.documentId);
    const existing = byId.get(documentId);
    if (existing !== undefined) {
      existing.events.push(event);
      continue;
    }
    const group: DocumentGroup = { documentId, events: [event] };
    byId.set(documentId, group);
    groups.push(group);
  }
  return groups;
}

/** One detail value as a report line: a list joined by commas, an empty fact named. */
function renderDetail(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? '(none)' : value.map(renderScalar).join(', ');
  }
  return renderScalar(value);
}

/** One scalar as a report line; anything unreadable says so instead of printing an object. */
function renderScalar(value: unknown): string {
  if (typeof value === 'string') return redactSecrets(oneLine(value)) || '(empty)';
  if (typeof value === 'number' || typeof value === 'boolean') return redactSecrets(String(value));
  if (value === null) return 'null';
  return '(unreadable)';
}

/** The events a caller passed instead of a log; a non-list or a non-object is refused. */
function readEventList(value: unknown): AuditEvent[] {
  if (!Array.isArray(value)) {
    throw new AuditError('malformed-log', 'the report needs an audit log or the list of its events.', 'events');
  }
  return value.map((entry: unknown, index: number) => {
    if (!isRecord(entry)) {
      throw new AuditError('malformed-log', 'every audit event is an object.', `events[${index}]`);
    }
    return entry as unknown as AuditEvent;
  });
}

// --- Validation ------------------------------------------------------------

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const RESERVED_DETAIL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** The fields a persisted document, a chain entry and an event each hold — no more. */
const DOCUMENT_KEYS = ['schemaVersion', 'kind', 'chain'] as const;
const CHAIN_KEYS = ['hash', 'prevHash', 'entry'] as const;
const EVENT_KEYS = ['kind', 'documentId', 'at', 'actor', 'details'] as const;

/**
 * Refuses a field the record's schema does not name.
 *
 * `append` ignores an extra field (a caller spreading a larger object), but a persisted
 * record is held to the fields the chain hashes: a value the hash does not cover is a value
 * nobody can vouch for, so reading one back is refused rather than silently dropped.
 */
function requireNoExtraKeys(record: unknown, allowed: readonly string[], prefix: string): void {
  if (!isRecord(record)) {
    throw new AuditError('malformed-log', 'a persisted audit record is an object.', prefix === '' ? 'log' : prefix);
  }
  for (const key of Object.keys(record)) {
    if ((allowed as readonly string[]).includes(key)) continue;
    throw new AuditError(
      'malformed-log',
      `the field ${label(key)} is not part of a schema version ${AUDIT_SCHEMA_VERSION} record; the chain does not cover it.`,
      path(prefix, key),
    );
  }
}

/**
 * Validates one event and returns the record the log stores.
 *
 * `prefix` names the location in a persisted document (`chain[2].entry`), so a refusal
 * points at the member that failed wherever the event came from. `clock` is the log's clock
 * for an append and `null` for a restore, where a missing timestamp is a malformed record
 * rather than a fact to stamp now.
 */
function readEvent(input: unknown, prefix: string, clock: (() => string) | null): AuditEvent {
  if (!isRecord(input)) {
    throw new AuditError(
      'malformed-log',
      'an audit event is an object of kind, documentId, at, actor and details.',
      prefix === '' ? 'event' : prefix,
    );
  }

  return {
    kind: readKind(input.kind, path(prefix, 'kind')),
    documentId: readDocumentId(input.documentId, path(prefix, 'documentId')),
    at: readTimestamp(input.at, path(prefix, 'at'), clock),
    actor: readActor(input.actor, path(prefix, 'actor')),
    details: readDetails(input.details, prefix),
  };
}

function readKind(value: unknown, field: string): AuditEventKind {
  if (typeof value === 'string' && (AUDIT_EVENT_KINDS as readonly string[]).includes(value)) {
    return value as AuditEventKind;
  }
  throw new AuditError(
    'unknown-kind',
    `the kind ${label(value)} is not one of ${AUDIT_EVENT_KINDS.join(', ')}.`,
    field,
  );
}

function readDocumentId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AuditError('invalid-document-id', 'a document id is text, not a number or an object.', field);
  }
  const id = value.trim();
  if (id.length === 0) {
    throw new AuditError('missing-document-id', 'an event needs the id of the document it is about.', field);
  }
  if (id.length > MAX_DOCUMENT_ID) {
    throw new AuditError(
      'invalid-document-id',
      `the document id is ${id.length} characters; at most ${MAX_DOCUMENT_ID} are kept.`,
      field,
    );
  }
  if (CONTROL.test(id)) {
    throw new AuditError('invalid-document-id', 'the document id carries a control character.', field);
  }
  return id;
}

/** `'user'` when the caller did not say; a value outside {@link AUDIT_ACTORS} is refused. */
function readActor(value: unknown, field: string): AuditActor {
  if (value === undefined) return 'user';
  if (typeof value === 'string' && (AUDIT_ACTORS as readonly string[]).includes(value)) {
    return value as AuditActor;
  }
  throw new AuditError(
    'unknown-actor',
    `the actor ${label(value)} is not one of ${AUDIT_ACTORS.join(', ')}.`,
    field,
  );
}

function readTimestamp(value: unknown, field: string, clock: (() => string) | null): string {
  const raw = value === undefined && clock !== null ? clock() : value;
  if (typeof raw !== 'string') {
    throw new AuditError(
      'invalid-timestamp',
      'an event needs a UTC ISO-8601 timestamp with its zone, as toISOString() writes it.',
      field,
    );
  }
  const at = raw.trim();
  if (!ISO_TIMESTAMP.test(at) || !Number.isFinite(Date.parse(at))) {
    throw new AuditError(
      'invalid-timestamp',
      `the timestamp ${label(at)} is not ISO-8601 with a zone; a timestamp without one names no instant.`,
      field,
    );
  }
  return at;
}

function readDetails(input: unknown, prefix: string): AuditDetails {
  const field = path(prefix, 'details');
  if (input === undefined) return {};
  if (!isRecord(input)) {
    throw new AuditError('invalid-details', 'details are a flat object of facts about the event.', field);
  }

  const keys = Object.keys(input);
  if (keys.length > MAX_AUDIT_DETAILS) {
    throw new AuditError(
      'invalid-details',
      `the event carries ${keys.length} details; at most ${MAX_AUDIT_DETAILS} are kept.`,
      field,
    );
  }

  const details: Record<string, AuditDetail> = {};
  for (const key of keys) {
    if (
      key.length === 0 ||
      key !== key.trim() ||
      key.length > MAX_AUDIT_DETAIL_KEY ||
      CONTROL.test(key) ||
      RESERVED_DETAIL_KEYS.has(key)
    ) {
      throw new AuditError(
        'invalid-details',
        `the detail field name is empty, padded, reserved or longer than ${MAX_AUDIT_DETAIL_KEY} characters.`,
        field,
      );
    }
    const kind = findSecret(key);
    if (kind !== null) throw secretRefusal(kind, field, 'field name');
    details[key] = readDetail(input[key], path(field, key));
  }
  return details;
}

/** One detail: a scalar or a list of scalars, bounded and scanned. */
function readDetail(value: unknown, field: string): AuditDetail {
  if (typeof value === 'string') {
    checkDetailText(value, field);
    return value;
  }
  if (typeof value === 'number') {
    checkDetailNumber(value, field);
    return value === 0 ? 0 : value;
  }
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_AUDIT_DETAIL_ITEMS) {
      throw new AuditError(
        'invalid-details',
        `the list is ${value.length} values long; at most ${MAX_AUDIT_DETAIL_ITEMS} are kept.`,
        field,
      );
    }
    const items: AuditDetailValue[] = [];
    value.forEach((item: unknown, index: number) => {
      const itemField = `${field}[${index}]`;
      if (typeof item === 'string') {
        checkDetailText(item, itemField);
        items.push(item);
        return;
      }
      if (typeof item === 'number') {
        checkDetailNumber(item, itemField);
        items.push(item === 0 ? 0 : item);
        return;
      }
      if (typeof item === 'boolean' || item === null) {
        items.push(item);
        return;
      }
      throw new AuditError(
        'invalid-details',
        'a list detail holds text, numbers, booleans or null, never a nested object.',
        itemField,
      );
    });
    return items;
  }
  throw new AuditError(
    'invalid-details',
    'a detail holds text, a number, a boolean, null, or a list of those; a detail is a fact, not a document.',
    field,
  );
}

function checkDetailText(value: string, field: string): void {
  if (value.length > MAX_AUDIT_DETAIL_TEXT) {
    throw new AuditError(
      'invalid-details',
      `the detail is ${value.length} characters; at most ${MAX_AUDIT_DETAIL_TEXT} are kept, because a detail is a fact and not a copy of the document.`,
      field,
    );
  }
  const kind = findSecret(value);
  if (kind !== null) throw secretRefusal(kind, field, 'value');
}

function checkDetailNumber(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new AuditError('invalid-details', 'a numeric detail must be finite; JSON cannot hold NaN or infinity.', field);
  }
  // A number is scanned through its digits, because a phone number stored as a number is
  // the same leak as one stored as text.
  const kind = findSecret(String(value));
  if (kind !== null) throw secretRefusal(kind, field, 'value');
}

// --- Reading helpers -------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function path(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}.${name}`;
}

/** A copy of one event, so a caller cannot change the record the log holds. */
function cloneEvent(event: AuditEvent): AuditEvent {
  return {
    kind: event.kind,
    documentId: event.documentId,
    at: event.at,
    actor: event.actor,
    details: cloneDetails(event.details),
  };
}

function cloneDetails(details: AuditDetails): AuditDetails {
  const copy: Record<string, AuditDetail> = {};
  for (const key of Object.keys(details)) {
    const value = details[key]!;
    copy[key] = Array.isArray(value) ? [...value] : value;
  }
  return copy;
}

/** An event as the persisted document writes it: fields in a fixed order, details sorted. */
function serializeEvent(event: AuditEvent): Record<string, unknown> {
  const details: Record<string, AuditDetail> = {};
  for (const key of Object.keys(event.details).sort()) details[key] = event.details[key]!;
  return {
    kind: event.kind,
    documentId: event.documentId,
    at: event.at,
    actor: event.actor,
    details,
  };
}

/** The text of a field a report is rendering, or `''` when a hand-built event made it unreadable. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Folds a value onto one line so a report bullet never breaks in the middle of a fact. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** `1 event`, `0 events`, `12 events`. */
function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** How a refused value is named in a message, without repeating it. */
function label(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (typeof value === 'bigint') return `${value}n`;
  return typeof value;
}

// --- SHA-256 ---------------------------------------------------------------

/**
 * FIPS 180-4 SHA-256 of `value`, as lowercase hex.
 *
 * Synchronous on purpose: `append` must hand back a hashed entry, and `crypto.subtle` is
 * async and missing in a page without a secure context. The same short implementation as
 * `cache.ts` — kept local rather than shared so this module stays free of a new dependency
 * and of an async hash API.
 */
function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  // One 0x80 terminator, then zeros, then the 64-bit big-endian bit length.
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);

  const schedule = new Uint32Array(64);
  let h0: number = SHA256_INITIAL[0];
  let h1: number = SHA256_INITIAL[1];
  let h2: number = SHA256_INITIAL[2];
  let h3: number = SHA256_INITIAL[3];
  let h4: number = SHA256_INITIAL[4];
  let h5: number = SHA256_INITIAL[5];
  let h6: number = SHA256_INITIAL[6];
  let h7: number = SHA256_INITIAL[7];

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const w15 = schedule[index - 15]!;
      const w2 = schedule[index - 2]!;
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + SHA256_ROUNDS[index]! + schedule[index]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map(word => word.toString(16).padStart(8, '0')).join('');
}

/** FIPS 180-4 initial hash values. */
const SHA256_INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] as const;

/** FIPS 180-4 round constants. */
const SHA256_ROUNDS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}
