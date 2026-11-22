import { TranslationError } from './retry';

/**
 * Capability model (backlog M02/M03).
 *
 * A mode is a promise about what the app may do while it is in force. Until now those
 * promises lived in prose — "reader mode never touches the network", "automation writes to
 * the export folder" — and any call site could break one by accident. This module makes the
 * promise executable: every mode declares a fixed set of {@link CapabilityName}
 * capabilities, every documented {@link CapabilityAction} declares the capabilities it
 * needs, and {@link check} answers whether a mode may perform an action. A step that the
 * mode did not declare is refused with a sentence the UI can show, and
 * {@link requireCapability} refuses it by throwing {@link CapabilityError}.
 *
 * The matrix:
 *
 * | mode       | network | loopback | writeLibrary | writeExport | cloudConsent | audit |
 * | ---------- | ------- | -------- | ------------ | ----------- | ------------ | ----- |
 * | reader     | no      | no       | yes          | no          | no           | yes   |
 * | local      | no      | yes      | yes          | yes         | no           | yes   |
 * | cloud      | yes     | yes      | yes          | yes         | yes          | yes   |
 * | automation | no      | no       | no           | yes         | no           | yes   |
 *
 * The capabilities:
 *
 * - `network` — a request may leave this machine.
 * - `loopback` — a request may reach a model on this machine. It is kept apart from
 *   `network` for the same reason `privacy.ts` lets a loopback request through before it
 *   consults `allowsNetwork`: a loopback request never leaves the machine, so a mode that
 *   forbids the network can still allow one.
 * - `writeLibrary` — the mode may change the library: import a document, annotate one,
 *   store settings, delete one.
 * - `writeExport` — the mode may write a file outside the library, which is what an export
 *   is. `reader` denies it, because "no writes outside the library" is the whole of reader
 *   mode.
 * - `cloudConsent` — the user has declared that this mode may use a remote provider. The
 *   stored `allowCloud` flag that `privacy.ts` checks per request is still required; this
 *   capability is the mode-level half of the same decision, not a replacement for it.
 * - `audit` — the mode keeps the append-only record from `audit.ts`. Every mode grants it:
 *   an unrecorded mode is a mode nobody can review afterwards.
 *
 * The documented actions:
 *
 * | action           | requires                  | why                                            |
 * | ---------------- | ------------------------- | ---------------------------------------------- |
 * | `openDocument`   | —                         | opening a document is what a reader exists for |
 * | `translateLocal` | `loopback`                | a local translation talks to a model here      |
 * | `translateCloud` | `network`, `cloudConsent` | a cloud translation sends text beyond here     |
 * | `exportFile`     | `writeExport`             | an export writes outside the library           |
 * | `writeSettings`  | `writeLibrary`            | storing settings changes the library           |
 * | `readCredential` | `cloudConsent`            | a credential exists only for a remote provider |
 * | `deleteDocument` | `writeLibrary`            | deleting a document changes the library        |
 *
 * `openDocument` requires nothing, so every mode may open a document; a mode without
 * `writeLibrary` must then open it read-only, without caching it, which is the contract the
 * opener has to honour for the matrix to mean anything.
 *
 * Two mappings are deliberate least-privilege choices rather than mechanical ones:
 * `readCredential` needs `cloudConsent`, because a stored credential exists only to talk to
 * a remote provider, so a mode that declared no remote use cannot read one; and
 * `automation` declares no `writeLibrary`, because an unattended run is the one caller
 * nobody is watching — it may open a document read-only and export it, but not change the
 * library, the settings or the credentials. `automation` also declares no network: a job
 * that needs a remote provider has to run in `cloud` mode, whose row is where that
 * declaration lives.
 *
 * Enforcement rules:
 *
 * - **Total and pure.** `check` answers every mode and action pair, including pairs whose
 *   names this build does not know, and nothing in it throws, reads a clock or touches I/O.
 *   A refusal is the answer rather than an error, because the UI asks before a step runs.
 * - **The door still throws.** `requireCapability` is the enforcement point: it raises
 *   {@link CapabilityError} naming the mode and the capability, so a call site that skipped
 *   `check` cannot proceed anyway.
 * - **Unknown input grants nothing.** A mode from another vocabulary — `privacy.ts`'s
 *   `offline`, for instance — is refused instead of being mapped onto a mode that looks
 *   similar, and an action outside the list is refused instead of being treated as free.
 * - **The contract is frozen.** The matrix, the action table and the vocabulary arrays are
 *   frozen, so a caller cannot widen a mode at runtime. The vocabulary arrays matter as much
 *   as the matrix: the type guards and the lookups both read them, so an unfrozen array
 *   would let a caller make `isCapabilityMode` accept a mode that has no row.
 * - **Deterministic.** No DOM, no network, no randomness, no clock, no dependency beyond the
 *   shared error type.
 */

// --- Modes and capabilities ------------------------------------------------

/** A mode the app can run in; every mode declares a fixed capability set. */
export type CapabilityMode = 'reader' | 'local' | 'cloud' | 'automation';

/** Every {@link CapabilityMode}, in the order a settings screen offers them. */
export const CAPABILITY_MODES: readonly CapabilityMode[] = Object.freeze([
  'reader',
  'local',
  'cloud',
  'automation',
]);

/** Something a mode either declares or does not; a mode cannot do what it did not declare. */
export type CapabilityName =
  | 'network'
  | 'loopback'
  | 'writeLibrary'
  | 'writeExport'
  | 'cloudConsent'
  | 'audit';

/** Every {@link CapabilityName}, in the order a mode sheet reads them. */
export const CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
  'network',
  'loopback',
  'writeLibrary',
  'writeExport',
  'cloudConsent',
  'audit',
]);

/** What one mode declares, one boolean per capability. */
export interface ModeCapabilities {
  /** A request may leave this machine. */
  readonly network: boolean;
  /** A request may reach a model on this machine. */
  readonly loopback: boolean;
  /** The mode may change the library: import, annotate, store settings, delete. */
  readonly writeLibrary: boolean;
  /** The mode may write a file outside the library. */
  readonly writeExport: boolean;
  /** The mode declares that it may use a remote provider; the stored flag still applies. */
  readonly cloudConsent: boolean;
  /** The mode keeps the append-only audit record. */
  readonly audit: boolean;
}

/** One row of {@link capabilityMatrix}. */
export interface ModeDefinition {
  /** The mode this row describes. */
  readonly mode: CapabilityMode;
  /** What it declares, exactly as {@link check} and {@link requireCapability} read it. */
  readonly capabilities: ModeCapabilities;
  /** One sentence for the settings UI: what the mode is for and what it refuses. */
  readonly description: string;
}

// --- Actions ---------------------------------------------------------------

/** A documented step whose capability needs are part of the contract. */
export type CapabilityAction =
  | 'openDocument'
  | 'translateLocal'
  | 'translateCloud'
  | 'exportFile'
  | 'writeSettings'
  | 'readCredential'
  | 'deleteDocument';

/** Every {@link CapabilityAction}, in the order documentation lists them. */
export const CAPABILITY_ACTIONS: readonly CapabilityAction[] = Object.freeze([
  'openDocument',
  'translateLocal',
  'translateCloud',
  'exportFile',
  'writeSettings',
  'readCredential',
  'deleteDocument',
]);

/** One row of {@link ACTION_REQUIREMENTS}: an action and the capabilities it needs. */
export interface ActionDefinition {
  /** The action this row classifies. */
  readonly action: CapabilityAction;
  /** Every capability the mode must declare; all of them, not any one of them. */
  readonly requires: readonly CapabilityName[];
  /** The clause a decision sentence uses to explain why the action needs them. */
  readonly rationale: string;
}

/**
 * One answer to "may this mode perform this action".
 *
 * A decision never throws, so a caller can render a refusal; `mode` and `action` echo the
 * input and are `null` when that name is unknown, which is the one case where the refusal is
 * about the input rather than about a capability.
 */
export interface CapabilityDecision {
  /** True only when the mode declares every capability the action requires. */
  readonly allowed: boolean;
  /** One sentence naming the mode, the action and the outcome; stable and safe to show. */
  readonly reason: string;
  /** The mode the decision is about, or `null` when the mode name is unknown. */
  readonly mode: CapabilityMode | null;
  /** The action the decision is about, or `null` when the action name is unknown. */
  readonly action: CapabilityAction | null;
  /**
   * Capabilities the action requires and the mode does not declare, in
   * {@link CAPABILITY_NAMES} order. Empty when the action is allowed, and also empty when
   * the refusal is about an unknown mode or action: then the name is the problem.
   */
  readonly missing: readonly CapabilityName[];
}

/** Retention defaults used by the local library purge workflow. */
export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

export interface RetentionPolicy {
  readonly maxAgeDays: number;
  readonly requireConfirmation: boolean;
}

export interface RetentionRecord {
  readonly documentId: string;
  readonly lastAccessedAt: string;
}

export interface PurgePlan {
  readonly cutoff: string;
  readonly candidates: readonly string[];
  readonly requiresConfirmation: boolean;
}

export type RetentionErrorCode = 'invalid-policy' | 'invalid-record' | 'confirmation-required';

export class RetentionError extends Error {
  readonly code: RetentionErrorCode;

  constructor(code: RetentionErrorCode, message: string) {
    super(message);
    this.name = 'RetentionError';
    this.code = code;
  }
}

/** Builds a reviewable purge plan without mutating records or deleting anything. */
export function planPurge(
  records: readonly RetentionRecord[],
  now: string,
  policy: RetentionPolicy = { maxAgeDays: DEFAULT_RETENTION_DAYS, requireConfirmation: true },
): PurgePlan {
  if (!Number.isInteger(policy.maxAgeDays) || policy.maxAgeDays < 0 || policy.maxAgeDays > MAX_RETENTION_DAYS) {
    throw new RetentionError('invalid-policy', `Retention must be an integer from 0 to ${MAX_RETENTION_DAYS} days.`);
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new RetentionError('invalid-policy', 'Purge time must be an ISO timestamp.');
  const cutoffMs = nowMs - policy.maxAgeDays * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString();
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (typeof record?.documentId !== 'string' || record.documentId.trim() === '') {
      throw new RetentionError('invalid-record', 'Every retention record needs a document id.');
    }
    if (seen.has(record.documentId)) continue;
    const lastAccessedMs = Date.parse(record.lastAccessedAt);
    if (!Number.isFinite(lastAccessedMs)) throw new RetentionError('invalid-record', `Invalid last-access time for ${record.documentId}.`);
    seen.add(record.documentId);
    if (lastAccessedMs <= cutoffMs) candidates.push(record.documentId);
  }
  return { cutoff, candidates: Object.freeze(candidates), requiresConfirmation: policy.requireConfirmation };
}

/** Returns the only ids a caller may pass to its deletion store after confirmation. */
export function confirmPurge(plan: PurgePlan, confirmed: boolean): readonly string[] {
  if (plan.requiresConfirmation && confirmed !== true) {
    throw new RetentionError('confirmation-required', 'Permanent purge requires explicit confirmation.');
  }
  return Object.freeze([...plan.candidates]);
}

// --- The matrix ------------------------------------------------------------

/**
 * The rows, keyed by mode.
 *
 * A `Record` over the whole mode union, so adding a mode without declaring its capabilities
 * is a type error here instead of a mode that silently grants nothing at runtime.
 */
const MODE_ROWS: Readonly<
  Record<CapabilityMode, { readonly description: string; readonly capabilities: ModeCapabilities }>
> = {
  reader: {
    description:
      'Reads documents in the library. It never uses the network and never writes outside the library.',
    capabilities: {
      network: false,
      loopback: false,
      writeLibrary: true,
      writeExport: false,
      cloudConsent: false,
      audit: true,
    },
  },
  local: {
    description:
      'Reads and exports, and translates with a model on this machine over loopback. Nothing leaves the machine.',
    capabilities: {
      network: false,
      loopback: true,
      writeLibrary: true,
      writeExport: true,
      cloudConsent: false,
      audit: true,
    },
  },
  cloud: {
    description:
      'Adds a remote provider: the network and the cloud consent are declared, and the stored consent flag is still required per request.',
    capabilities: {
      network: true,
      loopback: true,
      writeLibrary: true,
      writeExport: true,
      cloudConsent: true,
      audit: true,
    },
  },
  automation: {
    description:
      'Runs unattended and writes only to the export folder: no network, no library writes, no settings, no credential.',
    capabilities: {
      network: false,
      loopback: false,
      writeLibrary: false,
      writeExport: true,
      cloudConsent: false,
      audit: true,
    },
  },
};

const MATRIX: readonly ModeDefinition[] = Object.freeze(
  CAPABILITY_MODES.map(mode => {
    const row = MODE_ROWS[mode];
    return Object.freeze({
      mode,
      description: row.description,
      capabilities: Object.freeze({ ...row.capabilities }),
    });
  }),
);

const MODE_BY_NAME: ReadonlyMap<CapabilityMode, ModeDefinition> = new Map(
  MATRIX.map(definition => [definition.mode, definition]),
);

// --- The action table ------------------------------------------------------

/**
 * The action rows, keyed by action.
 *
 * Like {@link MODE_ROWS}, the `Record` makes a missing classification a type error: an
 * action added to {@link CAPABILITY_ACTIONS} cannot ship without saying what it needs.
 */
const ACTION_ROWS: Readonly<
  Record<CapabilityAction, { readonly requires: readonly CapabilityName[]; readonly rationale: string }>
> = {
  openDocument: {
    requires: [],
    rationale: 'opening a document is what a reader exists for',
  },
  translateLocal: {
    requires: ['loopback'],
    rationale: 'a local translation talks to a model on this machine',
  },
  translateCloud: {
    requires: ['network', 'cloudConsent'],
    rationale: 'a cloud translation sends text beyond this machine',
  },
  exportFile: {
    requires: ['writeExport'],
    rationale: 'an export writes a file outside the library',
  },
  writeSettings: {
    requires: ['writeLibrary'],
    rationale: 'storing settings changes the library',
  },
  readCredential: {
    requires: ['cloudConsent'],
    rationale: 'a credential exists only for a remote provider',
  },
  deleteDocument: {
    requires: ['writeLibrary'],
    rationale: 'deleting a document changes the library',
  },
};

/** The action classifications, in {@link CAPABILITY_ACTIONS} order, frozen. */
export const ACTION_REQUIREMENTS: readonly ActionDefinition[] = Object.freeze(
  CAPABILITY_ACTIONS.map(action => {
    const row = ACTION_ROWS[action];
    return Object.freeze({
      action,
      requires: Object.freeze([...row.requires]),
      rationale: row.rationale,
    });
  }),
);

const ACTION_BY_NAME: ReadonlyMap<CapabilityAction, ActionDefinition> = new Map(
  ACTION_REQUIREMENTS.map(definition => [definition.action, definition]),
);

// --- Errors ----------------------------------------------------------------

/** Why {@link requireCapability} refused. Stable identifiers, safe to switch on. */
export type CapabilityErrorCode = 'unknown-mode' | 'unknown-capability' | 'missing-capability';

/**
 * A capability the mode does not declare.
 *
 * It is a {@link TranslationError} of kind `invalid` and is never retried, for the same
 * reason `PrivacyError` is: a policy decision only changes when the user changes the mode,
 * not between two attempts. `mode` and `capability` are the contract — they name what was
 * asked for — and `code` says whether the mode was known, the capability was known, or the
 * capability was known and simply withheld.
 */
export class CapabilityError extends TranslationError {
  readonly code: CapabilityErrorCode;
  /** The mode that refused, or `null` when the mode name itself was unknown. */
  readonly mode: CapabilityMode | null;
  /** The capability that was withheld, or `null` when the capability name was unknown. */
  readonly capability: CapabilityName | null;

  constructor(
    code: CapabilityErrorCode,
    message: string,
    options: { mode?: CapabilityMode | null; capability?: CapabilityName | null } = {},
  ) {
    super('invalid', message, { retryable: false, userMessage: message });
    this.name = 'CapabilityError';
    this.code = code;
    this.mode = options.mode ?? null;
    this.capability = options.capability ?? null;
  }
}

// --- Reading the contract --------------------------------------------------

/** Narrows a runtime value to a {@link CapabilityMode}. */
export function isCapabilityMode(value: unknown): value is CapabilityMode {
  return typeof value === 'string' && (CAPABILITY_MODES as readonly string[]).includes(value);
}

/** Narrows a runtime value to a {@link CapabilityAction}. */
export function isCapabilityAction(value: unknown): value is CapabilityAction {
  return typeof value === 'string' && (CAPABILITY_ACTIONS as readonly string[]).includes(value);
}

/** Narrows a runtime value to a {@link CapabilityName}. */
export function isCapabilityName(value: unknown): value is CapabilityName {
  return typeof value === 'string' && (CAPABILITY_NAMES as readonly string[]).includes(value);
}

/**
 * The matrix, one row per mode in {@link CAPABILITY_MODES} order.
 *
 * The same frozen array on every call: it is the contract, not a snapshot of one, and a
 * caller that tried to append a mode or flip a capability gets a `TypeError` instead of a
 * silently widened app.
 */
export function capabilityMatrix(): readonly ModeDefinition[] {
  return MATRIX;
}

/**
 * The row for one mode, or `null` when the name is not a {@link CapabilityMode}.
 *
 * Returns the frozen row itself, so a caller reads exactly what {@link check} reads.
 */
export function modeDefinition(mode: CapabilityMode): ModeDefinition | null {
  return isCapabilityMode(mode) ? definitionOf(mode) : null;
}

/**
 * Whether one mode declares one capability.
 *
 * The non-throwing form of {@link requireCapability}, and the primitive a feature toggle
 * wants: unknown input answers `false`, because a mode that is not known declares nothing.
 */
export function hasCapability(mode: CapabilityMode, capability: CapabilityName): boolean {
  if (!isCapabilityMode(mode) || !isCapabilityName(capability)) return false;
  return definitionOf(mode).capabilities[capability];
}

// --- Enforcement -----------------------------------------------------------

/**
 * Whether `mode` may perform `action`, with a sentence explaining the answer.
 *
 * Total: a known pair gets a capability decision, an unknown mode or action is refused with
 * a reason naming the input, and nothing throws. The decision echoes the mode and action it
 * was given, so a caller that saw a `null` knows it passed a name this build does not know
 * rather than a mode that refused.
 *
 * ```ts
 * check('reader', 'translateCloud');
 * // { allowed: false, mode: 'reader', action: 'translateCloud',
 * //   missing: ['network', 'cloudConsent'],
 * //   reason: 'reader mode refuses translateCloud: a cloud translation sends text beyond
 * //            this machine, and it does not declare network or cloudConsent.' }
 * ```
 */
export function check(mode: CapabilityMode, action: CapabilityAction): CapabilityDecision {
  if (!isCapabilityMode(mode)) {
    return refused(unknownModeReason(mode), null, isCapabilityAction(action) ? action : null);
  }
  if (!isCapabilityAction(action)) {
    return refused(unknownActionReason(action), mode, null);
  }

  const definition = definitionOf(mode);
  const requirement = requirementOf(action);
  const missing = requirement.requires.filter(capability => !definition.capabilities[capability]);
  if (missing.length > 0) {
    return refused(refusedReason(definition, requirement, missing), mode, action, missing);
  }
  return {
    allowed: true,
    reason: allowedReason(definition, requirement),
    mode,
    action,
    missing: Object.freeze([]),
  };
}

/**
 * Throws {@link CapabilityError} unless `mode` declares `capability`.
 *
 * The door a step calls after `check`, or instead of it: the error names the mode and the
 * withheld capability, so a caller that ignored the decision still cannot run the step.
 * An unknown mode and an unknown capability are refused with their own code, because a
 * typo is a bug in the call site and not a policy decision.
 */
export function requireCapability(mode: CapabilityMode, capability: CapabilityName): void {
  if (!isCapabilityMode(mode)) {
    throw new CapabilityError('unknown-mode', unknownModeReason(mode));
  }
  if (!isCapabilityName(capability)) {
    throw new CapabilityError('unknown-capability', unknownCapabilityReason(capability), { mode });
  }

  const definition = definitionOf(mode);
  if (definition.capabilities[capability]) return;

  throw new CapabilityError(
    'missing-capability',
    `${mode} mode does not declare ${capability}, so a step that needs it cannot run in this mode.`,
    { mode, capability },
  );
}

// --- Sentences -------------------------------------------------------------

/** The reason for an allowed pair: why the action needs those capabilities, and that they are declared. */
function allowedReason(definition: ModeDefinition, requirement: ActionDefinition): string {
  const declaration =
    requirement.requires.length === 0
      ? 'it needs no capability of its own'
      : `it declares ${joinList(requirement.requires)}`;
  return `${definition.mode} mode allows ${requirement.action}: ${requirement.rationale}, and ${declaration}.`;
}

/** The reason for a refused pair: why the action needs them, and that the mode withholds them. */
function refusedReason(
  definition: ModeDefinition,
  requirement: ActionDefinition,
  missing: readonly CapabilityName[],
): string {
  return (
    `${definition.mode} mode refuses ${requirement.action}: ${requirement.rationale}, ` +
    `and it does not declare ${joinList(missing)}.`
  );
}

/** The reason for a mode this build does not know; the mode is the refusal, not a capability. */
function unknownModeReason(mode: unknown): string {
  return `The mode ${label(mode)} is not one of ${CAPABILITY_MODES.join(', ')}, so it grants nothing.`;
}

/** The reason for an action this build does not classify; refusing it is the safe default. */
function unknownActionReason(action: unknown): string {
  return (
    `The action ${label(action)} is not one of ${CAPABILITY_ACTIONS.join(', ')}, so it is refused.`
  );
}

/** The message for a capability name this build does not know. */
function unknownCapabilityReason(capability: unknown): string {
  return (
    `The capability ${label(capability)} is not one of ${CAPABILITY_NAMES.join(', ')}, ` +
    'so it cannot be required.'
  );
}

/** A refusal about an unknown name: the decision echoes only the names it recognised. */
function refused(
  reason: string,
  mode: CapabilityMode | null,
  action: CapabilityAction | null,
  missing: readonly CapabilityName[] = [],
): CapabilityDecision {
  return { allowed: false, reason, mode, action, missing: Object.freeze([...missing]) };
}

// --- Lookup and formatting helpers -----------------------------------------

/** The row for a known mode; the matrix is built from {@link CAPABILITY_MODES}, so it exists. */
function definitionOf(mode: CapabilityMode): ModeDefinition {
  return MODE_BY_NAME.get(mode)!;
}

/** The row for a known action; the table is built from {@link CAPABILITY_ACTIONS}, so it exists. */
function requirementOf(action: CapabilityAction): ActionDefinition {
  return ACTION_BY_NAME.get(action)!;
}

/** `a`, `a or b`, `a, b or c`. */
function joinList(items: readonly string[]): string {
  if (items.length === 0) return 'nothing';
  const last = items[items.length - 1]!;
  if (items.length === 1) return last;
  return `${items.slice(0, -1).join(', ')} or ${last}`;
}

/** How an unknown name is quoted in a refusal, without assuming it is a string. */
function label(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (typeof value === 'bigint') return `${value}n`;
  return typeof value;
}
