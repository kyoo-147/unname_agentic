/**
 * Non-destructive human-in-the-loop (HITL) OCR correction store and reusable rules (backlog F14).
 *
 * Recognised OCR text often needs human review (flagged by `ocr-verify.ts`).
 * Corrections must never mutate original source PDF/image bytes and must never
 * take effect silently:
 *
 * - Every source document registers an immutable SHA-256 snapshot digest
 *   (`sourceSha256`) over its original bytes or initial text. Re-registering
 *   conflicting bytes or passing altered bytes to preview/apply/rollback fails
 *   with `source-hash-mismatch`.
 * - Every edit enters as `pending` (`confirmed: false`). Moving an edit or rule
 *   to `confirmed` and applying edits to produce derived text BOTH require an
 *   explicit `{ confirmed: true }` guard; `false`, `undefined`, or truthy
 *   non-booleans are refused with `confirmation-required`.
 * - `preview` and `previewRules` are pure read-only simulations.
 * - `apply` and `applyRules` write an append-only ledger entry recording
 *   `beforeSha256`, `afterSha256`, `sourceSha256`, and reversible patches so
 *   `rollback` / `undo` restores the exact prior text, even across length-changing
 *   replacements.
 * - `extractRules` learns reusable exact and contextual glyph/unit pattern rules
 *   strictly from approved edits (`confirmed === true`, never pending/rejected/rolled-back).
 * - `exportJson` / `importJson` round-trip all sources, corrections, rules, and
 *   ledger entries as canonical versioned JSON.
 */

import type { OcrFinding } from './ocr-verify';

// --- Constants & Errors ----------------------------------------------------

export const OCR_CORRECTIONS_SCHEMA_VERSION = 1;
export const OCR_CORRECTIONS_EXPORT_KIND = 'mirror.ocr-corrections';

export type OcrCorrectionErrorCode =
  | 'invalid-field'
  | 'confirmation-required'
  | 'source-hash-mismatch'
  | 'unknown-source'
  | 'unknown-id'
  | 'duplicate-id'
  | 'immutable-field'
  | 'span-mismatch'
  | 'overlapping-corrections'
  | 'already-rolled-back'
  | 'rollback-conflict'
  | 'rule-not-confirmed'
  | 'malformed-json'
  | 'malformed-export'
  | 'unsupported-schema-version';

export class OcrCorrectionError extends Error {
  readonly code: OcrCorrectionErrorCode;
  readonly path: string;

  constructor(code: OcrCorrectionErrorCode, message: string, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'OcrCorrectionError';
    this.code = code;
    this.path = path;
  }
}

// --- Public types ----------------------------------------------------------

export type CorrectionStatus = 'pending' | 'confirmed' | 'rejected' | 'applied' | 'rolled-back';
export type CorrectionRuleKind = 'exact' | 'pattern';
export type PatternRuleScope = 'numeric-glyph' | 'unit-glyph' | 'word-token';

export interface SourceSnapshot {
  documentId: string;
  sourceSha256: string;
  byteLength: number;
  registeredAt: string;
}

export interface RegisterSourceInput {
  documentId: string;
  /** Original raw source bytes; hashed synchronously and NEVER mutated. */
  sourceBytes?: Uint8Array;
  /** Fallback text snapshot when raw bytes are unavailable. */
  sourceText?: string;
  /** Expected SHA-256 hex digest to verify at registration. */
  expectedSha256?: string;
}

export interface SourceVerificationResult {
  ok: boolean;
  documentId: string;
  expectedSha256: string;
  actualSha256: string;
}

export interface OcrCorrection {
  id: string;
  documentId: string;
  page: number;
  blockId?: string;
  start: number;
  end: number;
  original: string;
  corrected: string;
  reason?: string;
  sourceSha256: string;
  status: CorrectionStatus;
  confirmed: boolean;
  confirmedBy?: string;
  confirmedAt?: string;
  ruleId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StageCorrectionInput {
  documentId: string;
  page: number;
  blockId?: string;
  start: number;
  end: number;
  original: string;
  corrected: string;
  reason?: string;
  sourceText?: string;
  sourceSha256?: string;
  ruleId?: string;
}

export interface StageOptions {
  id?: string;
}

export interface ConfirmOptions {
  /** Must be strictly `true`; any other value throws `confirmation-required`. */
  confirmed: boolean;
  reviewer?: string;
}

export interface RejectOptions {
  reviewer?: string;
}

export interface CorrectionPatch {
  correctionId?: string;
  ruleId?: string;
  start: number;
  end: number;
  original: string;
  corrected: string;
}

export interface CorrectionConflict {
  correctionId: string;
  code: 'not-confirmed' | 'span-mismatch' | 'overlapping-corrections';
  detail: string;
}

export interface PreviewCorrectionsOptions {
  documentId: string;
  text: string;
  correctionIds?: readonly string[];
  blockId?: string;
  includePending?: boolean;
  sourceBytes?: Uint8Array;
}

export interface CorrectionPreview {
  documentId: string;
  originalText: string;
  previewText: string;
  patches: CorrectionPatch[];
  conflicts: CorrectionConflict[];
  sourceSha256: string;
  changed: boolean;
}

export interface ApplyCorrectionsOptions {
  documentId: string;
  text: string;
  /** Must be strictly `true`; any other value throws `confirmation-required`. */
  confirmed: boolean;
  correctionIds?: readonly string[];
  blockId?: string;
  reviewer?: string;
  sourceBytes?: Uint8Array;
}

export interface ApplyCorrectionsResult {
  revisionId: string;
  documentId: string;
  text: string;
  appliedIds: string[];
  skippedPendingIds: string[];
  patches: CorrectionPatch[];
  sourceSha256: string;
  beforeSha256: string;
  afterSha256: string;
  appliedAt: string;
}

export interface LedgerEntry {
  revisionId: string;
  documentId: string;
  blockId?: string;
  sequence: number;
  appliedAt: string;
  confirmedBy?: string;
  sourceSha256: string;
  beforeSha256: string;
  afterSha256: string;
  correctionIds: string[];
  patches: CorrectionPatch[];
  rolledBack: boolean;
  rolledBackAt?: string;
}

export interface RollbackOptions {
  text: string;
  sourceBytes?: Uint8Array;
}

export interface RollbackResult {
  revisionId: string;
  documentId: string;
  restoredText: string;
  correctionIds: string[];
  beforeSha256: string;
  afterSha256: string;
  rolledBackAt: string;
}

export interface RuleExample {
  original: string;
  corrected: string;
}

export interface OcrCorrectionRule {
  id: string;
  kind: CorrectionRuleKind;
  from: string;
  to: string;
  scope?: PatternRuleScope;
  supportCount: number;
  confidence: number;
  examples: RuleExample[];
  confirmed: boolean;
  confirmedBy?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractRulesOptions {
  documentId?: string;
  minSupport?: number;
}

export interface PreviewRulesOptions {
  documentId: string;
  text: string;
  ruleIds?: readonly string[];
  includeUnconfirmed?: boolean;
  sourceBytes?: Uint8Array;
}

export interface ApplyRulesOptions {
  documentId: string;
  text: string;
  /** Must be strictly `true`; any other value throws `confirmation-required`. */
  confirmed: boolean;
  ruleIds?: readonly string[];
  page?: number;
  blockId?: string;
  reviewer?: string;
  sourceBytes?: Uint8Array;
}

export interface OcrCorrectionStoreOptions {
  now?: () => string;
}

export interface OcrCorrectionImportResult {
  sources: number;
  corrections: number;
  rules: number;
  ledger: number;
}

// --- Synchronous SHA-256 ---------------------------------------------------

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

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

const UTF8 = new TextEncoder();
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

/**
 * Synchronous SHA-256 over UTF-8 text or raw bytes (`Uint8Array`), never mutating its input.
 */
export function sha256Hex(input: string | Uint8Array): string {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    bytes = UTF8.encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    throw new OcrCorrectionError('invalid-field', 'sha256Hex expects a string or Uint8Array.', 'input');
  }

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

// --- Rule extraction constants ---------------------------------------------

const CONFUSABLE_GLYPH_PAIRS: Readonly<Record<string, string>> = {
  O: '0',
  o: '0',
  l: '1',
  I: '1',
  S: '5',
  B: '8',
};

const KNOWN_UNIT_PATTERNS: readonly { from: string; to: string }[] = [
  { from: 'o/o', to: '%' },
  { from: '0/0', to: '%' },
  { from: '°/o', to: '%' },
  { from: 'm1', to: 'ml' },
  { from: '1bs', to: 'lbs' },
  { from: '1b', to: 'lb' },
  { from: 'k9', to: 'kg' },
  { from: 'm9', to: 'mg' },
  { from: 'U5D', to: 'USD' },
  { from: 'US0', to: 'USD' },
  { from: 'VNO', to: 'VND' },
  { from: 'VN0', to: 'VND' },
  { from: 'EUB', to: 'EUR' },
  { from: 'G8P', to: 'GBP' },
];

const CORRECTION_STATUSES: readonly CorrectionStatus[] = [
  'pending', 'confirmed', 'rejected', 'applied', 'rolled-back',
];
const RULE_KINDS: readonly CorrectionRuleKind[] = ['exact', 'pattern'];
const RULE_SCOPES: readonly PatternRuleScope[] = ['numeric-glyph', 'unit-glyph', 'word-token'];

const SYSTEM_CLOCK = (): string => new Date().toISOString();

// --- Store -----------------------------------------------------------------

export class OcrCorrectionStore {
  private readonly sources = new Map<string, SourceSnapshot>();
  private readonly corrections: OcrCorrection[] = [];
  private readonly correctionsById = new Map<string, OcrCorrection>();
  private readonly rules: OcrCorrectionRule[] = [];
  private readonly rulesById = new Map<string, OcrCorrectionRule>();
  private readonly ledgerEntries: LedgerEntry[] = [];
  private readonly ledgerById = new Map<string, LedgerEntry>();
  private readonly clock: () => string;

  private correctionSeq = 0;
  private ruleSeq = 0;
  private revisionSeq = 0;

  constructor(options: OcrCorrectionStoreOptions = {}) {
    const settings: OcrCorrectionStoreOptions = typeof options === 'object' && options !== null ? options : {};
    this.clock = typeof settings.now === 'function' ? settings.now : SYSTEM_CLOCK;
  }

  /**
   * Registers an immutable source snapshot for `documentId`.
   * Re-registering with different bytes or hash is refused with `source-hash-mismatch`.
   */
  registerSource(input: RegisterSourceInput): SourceSnapshot {
    if (typeof input !== 'object' || input === null) {
      throw new OcrCorrectionError('invalid-field', 'registerSource needs an input object.', 'source');
    }
    const documentId = requireText(input.documentId, 'documentId');

    let sourceSha256: string;
    let byteLength: number;

    if (input.sourceBytes !== undefined) {
      if (!(input.sourceBytes instanceof Uint8Array)) {
        throw new OcrCorrectionError('invalid-field', 'sourceBytes must be a Uint8Array.', 'sourceBytes');
      }
      sourceSha256 = sha256Hex(input.sourceBytes);
      byteLength = input.sourceBytes.byteLength;
    } else if (typeof input.sourceText === 'string') {
      const encoded = UTF8.encode(input.sourceText);
      sourceSha256 = sha256Hex(encoded);
      byteLength = encoded.byteLength;
    } else {
      throw new OcrCorrectionError(
        'invalid-field',
        'registerSource needs sourceBytes or sourceText.',
        'sourceBytes',
      );
    }

    if (input.expectedSha256 !== undefined) {
      const expected = requireSha256(input.expectedSha256, 'expectedSha256');
      if (expected !== sourceSha256) {
        throw new OcrCorrectionError(
          'source-hash-mismatch',
          `source hash ${sourceSha256} does not match expected ${expected}.`,
          'expectedSha256',
        );
      }
    }

    const existing = this.sources.get(documentId);
    if (existing !== undefined) {
      if (existing.sourceSha256 !== sourceSha256) {
        throw new OcrCorrectionError(
          'source-hash-mismatch',
          `document "${documentId}" is already bound to immutable source hash ${existing.sourceSha256}; received ${sourceSha256}.`,
          'sourceBytes',
        );
      }
      return { ...existing };
    }

    const snapshot: SourceSnapshot = {
      documentId,
      sourceSha256,
      byteLength,
      registeredAt: this.stamp(),
    };
    this.sources.set(documentId, snapshot);
    return { ...snapshot };
  }

  /** Verifies that `source` matches the immutable snapshot registered for `documentId`. */
  verifySource(documentId: string, source: string | Uint8Array): SourceVerificationResult {
    const id = requireText(documentId, 'documentId');
    const snapshot = this.sources.get(id);
    if (snapshot === undefined) {
      throw new OcrCorrectionError('unknown-source', `no source snapshot registered for "${id}".`, 'documentId');
    }
    const actualSha256 = sha256Hex(source);
    return {
      ok: actualSha256 === snapshot.sourceSha256,
      documentId: id,
      expectedSha256: snapshot.sourceSha256,
      actualSha256,
    };
  }

  getSource(documentId: string): SourceSnapshot | undefined {
    if (typeof documentId !== 'string') return undefined;
    const found = this.sources.get(documentId.trim());
    return found === undefined ? undefined : { ...found };
  }

  /**
   * Stages a proposed OCR correction as `pending` (`confirmed: false`).
   * Never modifies source text or original source bytes.
   */
  stage(input: StageCorrectionInput, options: StageOptions = {}): OcrCorrection {
    if (typeof input !== 'object' || input === null) {
      throw new OcrCorrectionError('invalid-field', 'stage needs a correction input object.', 'correction');
    }

    const documentId = requireText(input.documentId, 'documentId');
    const page = requirePage(input.page, 'page');
    const blockId = optionalText(input.blockId, 'blockId');
    const start = requireNonNegativeInt(input.start, 'start');
    const end = requireNonNegativeInt(input.end, 'end');
    if (end < start) {
      throw new OcrCorrectionError('invalid-field', 'end must be >= start.', 'end');
    }
    const original = requireString(input.original, 'original');
    const corrected = requireString(input.corrected, 'corrected');
    if (original.length !== end - start) {
      throw new OcrCorrectionError('span-mismatch', 'original length must equal end - start.', 'original');
    }

    if (input.sourceText !== undefined) {
      if (typeof input.sourceText !== 'string') {
        throw new OcrCorrectionError('invalid-field', 'sourceText must be a string when present.', 'sourceText');
      }
      if (end > input.sourceText.length || input.sourceText.slice(start, end) !== original) {
        throw new OcrCorrectionError(
          'span-mismatch',
          `span [${start}, ${end}) does not match "${original}" in sourceText.`,
          'original',
        );
      }
    }

    const sourceSha256 = this.resolveSourceSha256(documentId, input.sourceSha256, input.sourceText);
    const id = options?.id === undefined ? this.nextCorrectionId() : requireText(options.id, 'id');
    if (this.correctionsById.has(id)) {
      throw new OcrCorrectionError('duplicate-id', `correction id "${id}" already exists.`, 'id');
    }

    const reason = optionalText(input.reason, 'reason');
    const ruleId = optionalText(input.ruleId, 'ruleId');
    const now = this.stamp();

    const record: OcrCorrection = {
      id,
      documentId,
      page,
      start,
      end,
      original,
      corrected,
      sourceSha256,
      status: 'pending',
      confirmed: false,
      createdAt: now,
      updatedAt: now,
      ...(blockId !== undefined ? { blockId } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(ruleId !== undefined ? { ruleId } : {}),
    };

    this.corrections.push(record);
    this.correctionsById.set(id, record);
    return cloneCorrection(record);
  }

  /** Convenience helper to stage a correction directly from an F13 `OcrFinding`. */
  stageFromFinding(
    documentId: string,
    finding: OcrFinding,
    corrected: string,
    options: { sourceText?: string; sourceSha256?: string; id?: string } = {},
  ): OcrCorrection {
    if (typeof finding !== 'object' || finding === null || typeof finding.span !== 'object' || finding.span === null) {
      throw new OcrCorrectionError('invalid-field', 'stageFromFinding needs a valid OcrFinding.', 'finding');
    }
    const reason = finding.reasons[0];
    return this.stage(
      {
        documentId,
        page: finding.span.page ?? 1,
        ...(finding.span.blockId !== undefined ? { blockId: finding.span.blockId } : {}),
        start: finding.span.start,
        end: finding.span.end,
        original: finding.span.value,
        corrected,
        ...(reason !== undefined ? { reason } : {}),
        ...(options.sourceText !== undefined ? { sourceText: options.sourceText } : {}),
        ...(options.sourceSha256 !== undefined ? { sourceSha256: options.sourceSha256 } : {}),
      },
      options.id !== undefined ? { id: options.id } : {},
    );
  }

  /**
   * Explicitly confirms a staged correction. Refuses unless `options.confirmed === true`.
   */
  confirm(id: string, options: ConfirmOptions): OcrCorrection {
    requireConfirmedTrue(options, 'confirm');
    const key = requireText(id, 'id');
    const current = this.correctionsById.get(key);
    if (current === undefined) {
      throw new OcrCorrectionError('unknown-id', `correction "${key}" was not found.`, 'id');
    }
    if (current.status === 'rejected') {
      throw new OcrCorrectionError('invalid-field', `correction "${key}" was rejected and cannot be confirmed.`, 'status');
    }
    if (current.status === 'applied') {
      throw new OcrCorrectionError('invalid-field', `correction "${key}" is already applied.`, 'status');
    }

    const reviewer = optionalText(options.reviewer, 'reviewer');
    const now = this.stamp();
    current.confirmed = true;
    current.status = 'confirmed';
    current.confirmedAt = now;
    current.updatedAt = now;
    if (reviewer !== undefined) current.confirmedBy = reviewer;
    return cloneCorrection(current);
  }

  /** Rejects a staged correction so it can neither be applied nor contribute to rule extraction. */
  reject(id: string, options: RejectOptions = {}): OcrCorrection {
    const key = requireText(id, 'id');
    const current = this.correctionsById.get(key);
    if (current === undefined) {
      throw new OcrCorrectionError('unknown-id', `correction "${key}" was not found.`, 'id');
    }
    if (current.status === 'applied') {
      throw new OcrCorrectionError('invalid-field', `applied correction "${key}" must be rolled back, not rejected.`, 'status');
    }
    const reviewer = optionalText(options?.reviewer, 'reviewer');
    current.confirmed = false;
    current.status = 'rejected';
    delete current.confirmedAt;
    if (reviewer !== undefined) current.confirmedBy = reviewer;
    else delete current.confirmedBy;
    current.updatedAt = this.stamp();
    return cloneCorrection(current);
  }

  get(id: string): OcrCorrection | undefined {
    if (typeof id !== 'string') return undefined;
    const record = this.correctionsById.get(id.trim());
    return record === undefined ? undefined : cloneCorrection(record);
  }

  list(documentId?: string): OcrCorrection[] {
    const filtered =
      documentId === undefined
        ? this.corrections
        : this.corrections.filter(c => c.documentId === requireText(documentId, 'documentId'));
    return [...filtered].sort(compareCorrections).map(cloneCorrection);
  }

  /**
   * Pure preview of pending or confirmed corrections against `text`.
   * Never modifies store state or original source bytes.
   */
  preview(options: PreviewCorrectionsOptions): CorrectionPreview {
    if (typeof options !== 'object' || options === null) {
      throw new OcrCorrectionError('invalid-field', 'preview needs an options object.', 'options');
    }
    const documentId = requireText(options.documentId, 'documentId');
    const text = requireString(options.text, 'text');
    const sourceSha256 = this.verifyBytesIfSupplied(documentId, options.sourceBytes, text);
    const includePending = options.includePending === true;

    const candidates = this.selectCorrectionsForPreview(documentId, options.correctionIds, options.blockId, includePending);
    const conflicts: CorrectionConflict[] = [];
    const usable: OcrCorrection[] = [];

    for (const item of candidates) {
      if (!includePending && !item.confirmed) {
        conflicts.push({
          correctionId: item.id,
          code: 'not-confirmed',
          detail: `Correction "${item.id}" is not confirmed.`,
        });
        continue;
      }
      if (item.end > text.length || text.slice(item.start, item.end) !== item.original) {
        conflicts.push({
          correctionId: item.id,
          code: 'span-mismatch',
          detail: `Span [${item.start}, ${item.end}) does not match "${item.original}".`,
        });
        continue;
      }
      usable.push(item);
    }

    usable.sort((a, b) => a.start - b.start || a.end - b.end || compareText(a.id, b.id));
    const nonOverlapping: OcrCorrection[] = [];
    for (const item of usable) {
      const prev = nonOverlapping[nonOverlapping.length - 1];
      if (prev && item.start < prev.end) {
        conflicts.push({
          correctionId: item.id,
          code: 'overlapping-corrections',
          detail: `Correction "${item.id}" overlaps with "${prev.id}".`,
        });
        continue;
      }
      nonOverlapping.push(item);
    }

    const patches = nonOverlapping.map(item => toPatch(item));
    const previewText = applyPatchesToText(text, patches);
    return {
      documentId,
      originalText: text,
      previewText,
      patches,
      conflicts,
      sourceSha256,
      changed: previewText !== text,
    };
  }

  /**
   * Applies confirmed corrections to `text` and appends an immutable ledger entry.
   * Requires `options.confirmed === true`. Never modifies original source bytes.
   */
  apply(options: ApplyCorrectionsOptions): ApplyCorrectionsResult {
    requireConfirmedTrue(options, 'apply');
    const documentId = requireText(options.documentId, 'documentId');
    const text = requireString(options.text, 'text');
    const sourceSha256 = this.verifyBytesIfSupplied(documentId, options.sourceBytes, text);
    const reviewer = optionalText(options.reviewer, 'reviewer');

    const { selected, skippedPendingIds } = this.selectCorrectionsForApply(
      documentId,
      options.correctionIds,
      options.blockId,
    );

    if (selected.length === 0) {
      const stamp = this.stamp();
      const digest = sha256Hex(text);
      return {
        revisionId: '',
        documentId,
        text,
        appliedIds: [],
        skippedPendingIds,
        patches: [],
        sourceSha256,
        beforeSha256: digest,
        afterSha256: digest,
        appliedAt: stamp,
      };
    }

    // Validate every span and check for overlaps before modifying anything.
    const sorted = [...selected].sort((a, b) => a.start - b.start || a.end - b.end || compareText(a.id, b.id));
    for (let idx = 0; idx < sorted.length; idx += 1) {
      const current = sorted[idx]!;
      if (current.end > text.length || text.slice(current.start, current.end) !== current.original) {
        throw new OcrCorrectionError(
          'span-mismatch',
          `correction "${current.id}" expected "${current.original}" at [${current.start}, ${current.end}).`,
          'correctionIds',
        );
      }
      if (idx > 0 && current.start < sorted[idx - 1]!.end) {
        throw new OcrCorrectionError(
          'overlapping-corrections',
          `correction "${current.id}" overlaps "${sorted[idx - 1]!.id}".`,
          'correctionIds',
        );
      }
    }

    const patches = sorted.map(toPatch);
    const newText = applyPatchesToText(text, patches);
    const beforeSha256 = sha256Hex(text);
    const afterSha256 = sha256Hex(newText);
    const appliedAt = this.stamp();
    const revisionId = this.nextRevisionId();
    const appliedIds = sorted.map(c => c.id);

    const entry: LedgerEntry = {
      revisionId,
      documentId,
      sequence: this.ledgerEntries.length + 1,
      appliedAt,
      sourceSha256,
      beforeSha256,
      afterSha256,
      correctionIds: [...appliedIds],
      patches: patches.map(p => ({ ...p })),
      rolledBack: false,
      ...(options.blockId !== undefined ? { blockId: requireText(options.blockId, 'blockId') } : {}),
      ...(reviewer !== undefined ? { confirmedBy: reviewer } : {}),
    };

    this.ledgerEntries.push(entry);
    this.ledgerById.set(revisionId, entry);

    for (const item of sorted) {
      item.status = 'applied';
      item.updatedAt = appliedAt;
    }

    return {
      revisionId,
      documentId,
      text: newText,
      appliedIds,
      skippedPendingIds,
      patches: patches.map(p => ({ ...p })),
      sourceSha256,
      beforeSha256,
      afterSha256,
      appliedAt,
    };
  }

  /** Rolls back one applied revision, restoring exact prior text and verifying hashes. */
  rollback(revisionId: string, options: RollbackOptions): RollbackResult {
    const revId = requireText(revisionId, 'revisionId');
    if (typeof options !== 'object' || options === null) {
      throw new OcrCorrectionError('invalid-field', 'rollback needs an options object.', 'options');
    }
    const currentText = requireString(options.text, 'text');
    const entry = this.ledgerById.get(revId);
    if (entry === undefined) {
      throw new OcrCorrectionError('unknown-id', `revision "${revId}" was not found in ledger.`, 'revisionId');
    }
    if (entry.rolledBack) {
      throw new OcrCorrectionError('already-rolled-back', `revision "${revId}" was already rolled back.`, 'revisionId');
    }

    this.verifyBytesIfSupplied(entry.documentId, options.sourceBytes, currentText, entry.sourceSha256);

    const currentSha256 = sha256Hex(currentText);
    if (currentSha256 !== entry.afterSha256) {
      throw new OcrCorrectionError(
        'rollback-conflict',
        `text hash ${currentSha256} does not match revision "${revId}" output hash ${entry.afterSha256}.`,
        'text',
      );
    }

    const restoredText = revertPatchesFromText(currentText, entry.patches);
    const restoredSha256 = sha256Hex(restoredText);
    if (restoredSha256 !== entry.beforeSha256) {
      throw new OcrCorrectionError(
        'rollback-conflict',
        `reverted text hash ${restoredSha256} does not match expected pre-revision hash ${entry.beforeSha256}.`,
        'text',
      );
    }

    const rolledBackAt = this.stamp();
    entry.rolledBack = true;
    entry.rolledBackAt = rolledBackAt;

    for (const cid of entry.correctionIds) {
      const correction = this.correctionsById.get(cid);
      if (correction !== undefined) {
        correction.status = 'rolled-back';
        correction.updatedAt = rolledBackAt;
      }
    }

    return {
      revisionId: revId,
      documentId: entry.documentId,
      restoredText,
      correctionIds: [...entry.correctionIds],
      beforeSha256: entry.beforeSha256,
      afterSha256: entry.afterSha256,
      rolledBackAt,
    };
  }

  /** Rolls back the most recent active (non-rolled-back) revision for `documentId`. */
  undo(documentId: string, options: RollbackOptions): RollbackResult {
    const docId = requireText(documentId, 'documentId');
    for (let idx = this.ledgerEntries.length - 1; idx >= 0; idx -= 1) {
      const entry = this.ledgerEntries[idx]!;
      if (entry.documentId === docId && !entry.rolledBack) {
        return this.rollback(entry.revisionId, options);
      }
    }
    throw new OcrCorrectionError('unknown-id', `no active revision to undo for document "${docId}".`, 'documentId');
  }

  ledger(documentId?: string): LedgerEntry[] {
    const entries =
      documentId === undefined
        ? this.ledgerEntries
        : this.ledgerEntries.filter(e => e.documentId === requireText(documentId, 'documentId'));
    return [...entries].sort((a, b) => a.sequence - b.sequence).map(cloneLedgerEntry);
  }

  // --- Reusable rules ------------------------------------------------------

  /**
   * Extracts reusable correction rules strictly from approved edits (`confirmed === true`
   * and status `'confirmed'` or `'applied'`). Extracted rules start with `confirmed: false`.
   */
  extractRules(options: ExtractRulesOptions = {}): OcrCorrectionRule[] {
    const docFilter = options.documentId !== undefined ? requireText(options.documentId, 'documentId') : undefined;
    const minSupport = options.minSupport ?? 1;
    if (!Number.isInteger(minSupport) || minSupport < 1) {
      throw new OcrCorrectionError('invalid-field', 'minSupport must be a positive integer.', 'minSupport');
    }

    const approved = this.corrections.filter(
      c =>
        c.confirmed === true &&
        (c.status === 'confirmed' || c.status === 'applied') &&
        c.original !== c.corrected &&
        (docFilter === undefined || c.documentId === docFilter),
    );

    interface CandidateAccumulator {
      kind: CorrectionRuleKind;
      scope: PatternRuleScope;
      from: string;
      to: string;
      supportCount: number;
      examples: RuleExample[];
    }

    const buckets = new Map<string, CandidateAccumulator>();
    const addCandidate = (
      kind: CorrectionRuleKind,
      scope: PatternRuleScope,
      from: string,
      to: string,
      example: RuleExample,
    ): void => {
      const key = `${kind}|${scope}|${from}|${to}`;
      const existing = buckets.get(key);
      if (!existing) {
        buckets.set(key, {
          kind,
          scope,
          from,
          to,
          supportCount: 1,
          examples: [example],
        });
        return;
      }
      existing.supportCount += 1;
      if (!existing.examples.some(ex => ex.original === example.original && ex.corrected === example.corrected)) {
        existing.examples.push(example);
      }
    };

    for (const edit of approved) {
      const candidates = deriveRuleCandidates(edit.original, edit.corrected);
      for (const cand of candidates) {
        addCandidate(cand.kind, cand.scope, cand.from, cand.to, {
          original: edit.original,
          corrected: edit.corrected,
        });
      }
    }

    const now = this.stamp();
    const touched: OcrCorrectionRule[] = [];

    const sortedCandidates = [...buckets.values()].sort((a, b) =>
      compareText(`${a.kind}|${a.scope}|${a.from}|${a.to}`, `${b.kind}|${b.scope}|${b.from}|${b.to}`),
    );

    for (const cand of sortedCandidates) {
      if (cand.supportCount < minSupport) continue;
      const confidence = computeRuleConfidence(cand.supportCount);
      const existing = this.rules.find(
        r => r.kind === cand.kind && r.scope === cand.scope && r.from === cand.from && r.to === cand.to,
      );

      if (existing) {
        existing.supportCount = cand.supportCount;
        existing.confidence = confidence;
        existing.examples = cand.examples.map(ex => ({ ...ex }));
        existing.updatedAt = now;
        touched.push(cloneRule(existing));
      } else {
        const rule: OcrCorrectionRule = {
          id: this.nextRuleId(),
          kind: cand.kind,
          from: cand.from,
          to: cand.to,
          scope: cand.scope,
          supportCount: cand.supportCount,
          confidence,
          examples: cand.examples.map(ex => ({ ...ex })),
          confirmed: false,
          createdAt: now,
          updatedAt: now,
        };
        this.rules.push(rule);
        this.rulesById.set(rule.id, rule);
        touched.push(cloneRule(rule));
      }
    }

    return touched;
  }

  /** Explicitly confirms a reusable correction rule. Requires `options.confirmed === true`. */
  confirmRule(ruleId: string, options: ConfirmOptions): OcrCorrectionRule {
    requireConfirmedTrue(options, 'confirmRule');
    const key = requireText(ruleId, 'ruleId');
    const rule = this.rulesById.get(key);
    if (rule === undefined) {
      throw new OcrCorrectionError('unknown-id', `rule "${key}" was not found.`, 'ruleId');
    }
    const reviewer = optionalText(options.reviewer, 'reviewer');
    const now = this.stamp();
    rule.confirmed = true;
    rule.confirmedAt = now;
    rule.updatedAt = now;
    if (reviewer !== undefined) rule.confirmedBy = reviewer;
    return cloneRule(rule);
  }

  listRules(): OcrCorrectionRule[] {
    return [...this.rules].sort((a, b) => compareText(a.id, b.id)).map(cloneRule);
  }

  /** Pure preview of reusable rules against `text`. Never mutates text or store. */
  previewRules(options: PreviewRulesOptions): CorrectionPreview {
    if (typeof options !== 'object' || options === null) {
      throw new OcrCorrectionError('invalid-field', 'previewRules needs an options object.', 'options');
    }
    const documentId = requireText(options.documentId, 'documentId');
    const text = requireString(options.text, 'text');
    const sourceSha256 = this.verifyBytesIfSupplied(documentId, options.sourceBytes, text);
    const includeUnconfirmed = options.includeUnconfirmed === true;

    const rules = this.resolveRulesForSelection(options.ruleIds, includeUnconfirmed, false);
    const patches = findNonOverlappingRuleMatches(text, rules);
    const previewText = applyPatchesToText(text, patches);

    return {
      documentId,
      originalText: text,
      previewText,
      patches,
      conflicts: [],
      sourceSha256,
      changed: previewText !== text,
    };
  }

  /**
   * Applies confirmed reusable rules to `text`, staging and confirming individual
   * correction records and committing an immutable ledger revision.
   * Requires both `options.confirmed === true` AND every selected rule to be confirmed.
   */
  applyRules(options: ApplyRulesOptions): ApplyCorrectionsResult {
    requireConfirmedTrue(options, 'applyRules');
    const documentId = requireText(options.documentId, 'documentId');
    const text = requireString(options.text, 'text');
    const page = options.page === undefined ? 1 : requirePage(options.page, 'page');
    const blockId = optionalText(options.blockId, 'blockId');
    const reviewer = optionalText(options.reviewer, 'reviewer');
    const sourceSha256 = this.verifyBytesIfSupplied(documentId, options.sourceBytes, text);

    const rules = this.resolveRulesForSelection(options.ruleIds, false, true);
    const patches = findNonOverlappingRuleMatches(text, rules);

    if (patches.length === 0) {
      const digest = sha256Hex(text);
      return {
        revisionId: '',
        documentId,
        text,
        appliedIds: [],
        skippedPendingIds: [],
        patches: [],
        sourceSha256,
        beforeSha256: digest,
        afterSha256: digest,
        appliedAt: this.stamp(),
      };
    }

    const stagedIds: string[] = [];
    for (const patch of patches) {
      const staged = this.stage({
        documentId,
        page,
        ...(blockId !== undefined ? { blockId } : {}),
        start: patch.start,
        end: patch.end,
        original: patch.original,
        corrected: patch.corrected,
        sourceText: text,
        sourceSha256,
        ...(patch.ruleId !== undefined ? { ruleId: patch.ruleId } : {}),
        reason: patch.ruleId !== undefined ? `rule:${patch.ruleId}` : 'reusable-rule',
      });
      this.confirm(staged.id, { confirmed: true, ...(reviewer !== undefined ? { reviewer } : {}) });
      stagedIds.push(staged.id);
    }

    return this.apply({
      documentId,
      text,
      confirmed: true,
      correctionIds: stagedIds,
      ...(blockId !== undefined ? { blockId } : {}),
      ...(reviewer !== undefined ? { reviewer } : {}),
      ...(options.sourceBytes !== undefined ? { sourceBytes: options.sourceBytes } : {}),
    });
  }

  // --- JSON Export / Import ------------------------------------------------

  /**
   * Serializes sources, corrections, rules, and ledger in deterministic canonical JSON.
   */
  exportJson(): string {
    const payload = {
      schemaVersion: OCR_CORRECTIONS_SCHEMA_VERSION,
      kind: OCR_CORRECTIONS_EXPORT_KIND,
      sources: [...this.sources.values()]
        .sort((a, b) => compareText(a.documentId, b.documentId))
        .map(s => ({
          documentId: s.documentId,
          sourceSha256: s.sourceSha256,
          byteLength: s.byteLength,
          registeredAt: s.registeredAt,
        })),
      corrections: [...this.corrections].sort(compareCorrections).map(serializeCorrection),
      rules: [...this.rules].sort((a, b) => compareText(a.id, b.id)).map(serializeRule),
      ledger: [...this.ledgerEntries].sort((a, b) => a.sequence - b.sequence).map(serializeLedgerEntry),
    };
    return JSON.stringify(payload, null, 2);
  }

  /**
   * Atomically validates and imports an exported JSON document.
   * Refuses malformed data, unsupported schema versions, duplicate IDs, or source hash conflicts.
   */
  importJson(json: string): OcrCorrectionImportResult {
    const doc = parseExportDocument(json);

    const parsedSources: SourceSnapshot[] = [];
    const seenDocs = new Set<string>();
    doc.sources.forEach((entry, idx) => {
      const snap = readSourceSnapshot(entry, `sources[${idx}]`);
      if (seenDocs.has(snap.documentId)) {
        throw new OcrCorrectionError('duplicate-id', `duplicate source "${snap.documentId}".`, `sources[${idx}].documentId`);
      }
      const existing = this.sources.get(snap.documentId);
      if (existing && existing.sourceSha256 !== snap.sourceSha256) {
        throw new OcrCorrectionError(
          'source-hash-mismatch',
          `source hash mismatch for "${snap.documentId}".`,
          `sources[${idx}].sourceSha256`,
        );
      }
      seenDocs.add(snap.documentId);
      parsedSources.push(snap);
    });

    const parsedCorrections: OcrCorrection[] = [];
    const seenCorrections = new Set<string>();
    doc.corrections.forEach((entry, idx) => {
      const rec = readCorrectionRecord(entry, `corrections[${idx}]`);
      if (seenCorrections.has(rec.id) || this.correctionsById.has(rec.id)) {
        throw new OcrCorrectionError('duplicate-id', `duplicate correction id "${rec.id}".`, `corrections[${idx}].id`);
      }
      seenCorrections.add(rec.id);
      parsedCorrections.push(rec);
    });

    const parsedRules: OcrCorrectionRule[] = [];
    const seenRules = new Set<string>();
    doc.rules.forEach((entry, idx) => {
      const rule = readRuleRecord(entry, `rules[${idx}]`);
      if (seenRules.has(rule.id) || this.rulesById.has(rule.id)) {
        throw new OcrCorrectionError('duplicate-id', `duplicate rule id "${rule.id}".`, `rules[${idx}].id`);
      }
      seenRules.add(rule.id);
      parsedRules.push(rule);
    });

    const parsedLedger: LedgerEntry[] = [];
    const seenRevisions = new Set<string>();
    doc.ledger.forEach((entry, idx) => {
      const item = readLedgerRecord(entry, `ledger[${idx}]`);
      if (seenRevisions.has(item.revisionId) || this.ledgerById.has(item.revisionId)) {
        throw new OcrCorrectionError('duplicate-id', `duplicate revision id "${item.revisionId}".`, `ledger[${idx}].revisionId`);
      }
      seenRevisions.add(item.revisionId);
      parsedLedger.push(item);
    });

    // All validation passed — commit atomically.
    for (const snap of parsedSources) {
      if (!this.sources.has(snap.documentId)) this.sources.set(snap.documentId, snap);
    }
    for (const rec of parsedCorrections) {
      this.corrections.push(rec);
      this.correctionsById.set(rec.id, rec);
      this.correctionSeq = Math.max(this.correctionSeq, parseNumericSuffix(rec.id, 'c'));
    }
    for (const rule of parsedRules) {
      this.rules.push(rule);
      this.rulesById.set(rule.id, rule);
      this.ruleSeq = Math.max(this.ruleSeq, parseNumericSuffix(rule.id, 'r'));
    }
    for (const item of parsedLedger) {
      this.ledgerEntries.push(item);
      this.ledgerById.set(item.revisionId, item);
      this.revisionSeq = Math.max(this.revisionSeq, parseNumericSuffix(item.revisionId, 'rev'));
    }

    return {
      sources: parsedSources.length,
      corrections: parsedCorrections.length,
      rules: parsedRules.length,
      ledger: parsedLedger.length,
    };
  }

  // --- Internal store helpers ----------------------------------------------

  private resolveSourceSha256(documentId: string, providedSha?: string, sourceText?: string): string {
    const registered = this.sources.get(documentId);
    const validProvided = providedSha !== undefined ? requireSha256(providedSha, 'sourceSha256') : undefined;

    if (registered !== undefined) {
      if (validProvided !== undefined && validProvided !== registered.sourceSha256) {
        throw new OcrCorrectionError(
          'source-hash-mismatch',
          `provided sourceSha256 ${validProvided} does not match registered ${registered.sourceSha256}.`,
          'sourceSha256',
        );
      }
      return registered.sourceSha256;
    }

    if (validProvided !== undefined) return validProvided;
    if (typeof sourceText === 'string') return sha256Hex(sourceText);

    throw new OcrCorrectionError(
      'unknown-source',
      `document "${documentId}" has no registered source snapshot and no sourceSha256/sourceText was provided.`,
      'documentId',
    );
  }

  private verifyBytesIfSupplied(
    documentId: string,
    sourceBytes: Uint8Array | undefined,
    fallbackText: string,
    expectedOverride?: string,
  ): string {
    const registered = this.sources.get(documentId);
    const expected = expectedOverride ?? registered?.sourceSha256;

    if (sourceBytes !== undefined) {
      if (!(sourceBytes instanceof Uint8Array)) {
        throw new OcrCorrectionError('invalid-field', 'sourceBytes must be a Uint8Array.', 'sourceBytes');
      }
      if (expected === undefined) {
        throw new OcrCorrectionError('unknown-source', `no source snapshot registered for "${documentId}".`, 'documentId');
      }
      const actual = sha256Hex(sourceBytes);
      if (actual !== expected) {
        throw new OcrCorrectionError(
          'source-hash-mismatch',
          `sourceBytes SHA-256 ${actual} does not match immutable snapshot ${expected}.`,
          'sourceBytes',
        );
      }
      return expected;
    }

    return expected ?? sha256Hex(fallbackText);
  }

  private selectCorrectionsForPreview(
    documentId: string,
    correctionIds: readonly string[] | undefined,
    blockId: string | undefined,
    includePending: boolean,
  ): OcrCorrection[] {
    if (correctionIds !== undefined) {
      const selected: OcrCorrection[] = [];
      for (const id of correctionIds) {
        const rec = this.correctionsById.get(requireText(id, 'correctionIds'));
        if (rec === undefined) {
          throw new OcrCorrectionError('unknown-id', `correction "${id}" was not found.`, 'correctionIds');
        }
        if (rec.documentId !== documentId) {
          throw new OcrCorrectionError('invalid-field', `correction "${id}" belongs to "${rec.documentId}".`, 'correctionIds');
        }
        selected.push(rec);
      }
      return selected;
    }

    return this.corrections.filter(
      c =>
        c.documentId === documentId &&
        (blockId === undefined || c.blockId === blockId) &&
        (c.status === 'confirmed' || (includePending && c.status === 'pending')),
    );
  }

  private selectCorrectionsForApply(
    documentId: string,
    correctionIds: readonly string[] | undefined,
    blockId: string | undefined,
  ): { selected: OcrCorrection[]; skippedPendingIds: string[] } {
    if (correctionIds !== undefined) {
      if (!Array.isArray(correctionIds)) {
        throw new OcrCorrectionError('invalid-field', 'correctionIds must be an array.', 'correctionIds');
      }
      const selected: OcrCorrection[] = [];
      for (const id of correctionIds) {
        const key = requireText(id, 'correctionIds');
        const rec = this.correctionsById.get(key);
        if (rec === undefined) {
          throw new OcrCorrectionError('unknown-id', `correction "${key}" was not found.`, 'correctionIds');
        }
        if (rec.documentId !== documentId) {
          throw new OcrCorrectionError('invalid-field', `correction "${key}" belongs to "${rec.documentId}".`, 'correctionIds');
        }
        if (rec.confirmed !== true) {
          throw new OcrCorrectionError(
            'confirmation-required',
            `correction "${key}" must be explicitly confirmed before applying.`,
            'correctionIds',
          );
        }
        if (rec.status !== 'confirmed') {
          throw new OcrCorrectionError(
            'invalid-field',
            `correction "${key}" has status "${rec.status}" and cannot be applied.`,
            'correctionIds',
          );
        }
        selected.push(rec);
      }
      return { selected, skippedPendingIds: [] };
    }

    const selected: OcrCorrection[] = [];
    const skippedPendingIds: string[] = [];
    for (const c of this.corrections) {
      if (c.documentId !== documentId) continue;
      if (blockId !== undefined && c.blockId !== blockId) continue;
      if (c.status === 'pending') {
        skippedPendingIds.push(c.id);
      } else if (c.status === 'confirmed' && c.confirmed === true) {
        selected.push(c);
      }
    }
    return { selected, skippedPendingIds };
  }

  private resolveRulesForSelection(
    ruleIds: readonly string[] | undefined,
    includeUnconfirmed: boolean,
    requireAllConfirmed: boolean,
  ): OcrCorrectionRule[] {
    let selected: OcrCorrectionRule[];
    if (ruleIds !== undefined) {
      if (!Array.isArray(ruleIds)) {
        throw new OcrCorrectionError('invalid-field', 'ruleIds must be an array.', 'ruleIds');
      }
      selected = [];
      for (const id of ruleIds) {
        const key = requireText(id, 'ruleIds');
        const rule = this.rulesById.get(key);
        if (rule === undefined) {
          throw new OcrCorrectionError('unknown-id', `rule "${key}" was not found.`, 'ruleIds');
        }
        selected.push(rule);
      }
    } else {
      selected = [...this.rules];
    }

    if (requireAllConfirmed) {
      const unconfirmed = selected.find(r => r.confirmed !== true);
      if (unconfirmed !== undefined) {
        throw new OcrCorrectionError(
          'rule-not-confirmed',
          `rule "${unconfirmed.id}" must be explicitly confirmed before applying.`,
          'ruleIds',
        );
      }
    }

    return includeUnconfirmed ? selected : selected.filter(r => r.confirmed === true);
  }

  private nextCorrectionId(): string {
    let id = '';
    do {
      this.correctionSeq += 1;
      id = `c${this.correctionSeq}`;
    } while (this.correctionsById.has(id));
    return id;
  }

  private nextRuleId(): string {
    let id = '';
    do {
      this.ruleSeq += 1;
      id = `r${this.ruleSeq}`;
    } while (this.rulesById.has(id));
    return id;
  }

  private nextRevisionId(): string {
    let id = '';
    do {
      this.revisionSeq += 1;
      id = `rev${this.revisionSeq}`;
    } while (this.ledgerById.has(id));
    return id;
  }

  private stamp(): string {
    const value = this.clock();
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new OcrCorrectionError('invalid-field', 'clock must return a non-empty ISO-8601 timestamp.', 'now');
    }
    return value.trim();
  }
}

// --- Rule extraction & matching helpers ------------------------------------

interface DerivedRuleCandidate {
  kind: CorrectionRuleKind;
  scope: PatternRuleScope;
  from: string;
  to: string;
}

function deriveRuleCandidates(original: string, corrected: string): DerivedRuleCandidate[] {
  const results: DerivedRuleCandidate[] = [];

  // 1. Monetary leading `S` -> `$` (e.g. `S1,250.00` -> `$1,250.00`).
  if (original.startsWith('S') && corrected.startsWith('$') && original.slice(1) === corrected.slice(1)) {
    results.push({ kind: 'pattern', scope: 'unit-glyph', from: 'S', to: '$' });
    return results;
  }

  // 2. Unit-glyph fixes (e.g. `15 o/o` -> `15%`, `100 m1` -> `100 ml`).
  for (const unit of KNOWN_UNIT_PATTERNS) {
    if (original.endsWith(unit.from) && corrected.endsWith(unit.to)) {
      const origPrefix = original.slice(0, original.length - unit.from.length).trimEnd();
      const corrPrefix = corrected.slice(0, corrected.length - unit.to.length).trimEnd();
      if (origPrefix === corrPrefix && /\d$/u.test(origPrefix)) {
        results.push({ kind: 'pattern', scope: 'unit-glyph', from: unit.from, to: unit.to });
        return results;
      }
    }
  }

  // 3. Numeric/date glyph substitution patterns (e.g. `1O0` -> `100`, `l50` -> `150`).
  if (
    original.length === corrected.length &&
    /^[+-]?[\d.,/\-:]+$/u.test(corrected) &&
    /^[+-]?[\dOlISBo.,/\-:]+$/u.test(original)
  ) {
    const seenPairs = new Set<string>();
    for (let i = 0; i < original.length; i += 1) {
      const fromCh = original.charAt(i);
      const toCh = corrected.charAt(i);
      if (fromCh === toCh) continue;
      if (CONFUSABLE_GLYPH_PAIRS[fromCh] === toCh) {
        const key = `${fromCh}->${toCh}`;
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          results.push({ kind: 'pattern', scope: 'numeric-glyph', from: fromCh, to: toCh });
        }
      }
    }
    if (results.length > 0) return results;
  }

  // 4. Exact non-numeric token/phrase substitution (`T0tal` -> `Total`).
  results.push({ kind: 'exact', scope: 'word-token', from: original, to: corrected });
  return results;
}

function computeRuleConfidence(supportCount: number): number {
  const score = 0.6 + 0.15 * Math.min(supportCount, 2) + 0.05 * Math.max(0, supportCount - 2);
  return Math.min(0.99, Math.round(score * 1000) / 1000);
}

const REGEXP_SPECIAL = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|']);

function escapeRegExp(value: string): string {
  let out = '';
  for (const ch of value) out += REGEXP_SPECIAL.has(ch) ? `\\${ch}` : ch;
  return out;
}

function findNonOverlappingRuleMatches(text: string, rules: readonly OcrCorrectionRule[]): CorrectionPatch[] {
  const candidates: CorrectionPatch[] = [];

  for (const rule of rules) {
    if (rule.kind === 'exact') {
      const re = new RegExp(String.raw`(?<![\p{L}\p{N}])${escapeRegExp(rule.from)}(?![\p{L}\p{N}])`, 'gu');
      for (const match of text.matchAll(re)) {
        const start = match.index ?? 0;
        candidates.push({
          ruleId: rule.id,
          start,
          end: start + match[0].length,
          original: match[0],
          corrected: rule.to,
        });
      }
      continue;
    }

    if (rule.scope === 'numeric-glyph') {
      const tokenRe = /(?<![\p{L}\p{N}])[+-]?[\dOlISBo.,/\-:]+(?![\p{L}\p{N}])/gu;
      for (const match of text.matchAll(tokenRe)) {
        const token = match[0];
        if (!/\d/u.test(token) || !token.includes(rule.from)) continue;
        const start = match.index ?? 0;
        const replaced = token.split(rule.from).join(rule.to);
        if (replaced !== token) {
          candidates.push({
            ruleId: rule.id,
            start,
            end: start + token.length,
            original: token,
            corrected: replaced,
          });
        }
      }
      continue;
    }

    if (rule.scope === 'unit-glyph') {
      if (rule.from === 'S' && rule.to === '$') {
        const re = /(?<![\p{L}\p{N}$])S(?=(?:[1-9]\d{0,2}(?:,\d{3})+(?:\.\d{1,2})?|[1-9]\d*\.\d{2})(?![\p{L}\p{N}]))/gu;
        for (const match of text.matchAll(re)) {
          const start = match.index ?? 0;
          candidates.push({
            ruleId: rule.id,
            start,
            end: start + 1,
            original: 'S',
            corrected: '$',
          });
        }
      } else {
        const re = new RegExp(
          String.raw`(?<![\p{L}\p{N}])(\d[\d.,]*)\s*${escapeRegExp(rule.from)}(?![\p{L}\p{N}])`,
          'gu',
        );
        for (const match of text.matchAll(re)) {
          const start = match.index ?? 0;
          const numPart = match[1] ?? '';
          const corrected = rule.to === '%' ? `${numPart}%` : `${numPart} ${rule.to}`;
          candidates.push({
            ruleId: rule.id,
            start,
            end: start + match[0].length,
            original: match[0],
            corrected,
          });
        }
      }
    }
  }

  // Prefer earlier start, then longer match (so combined numeric tokens or exact phrases win),
  // and coalesce/reject overlapping matches deterministically.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end || compareText(a.ruleId ?? '', b.ruleId ?? ''));

  const accepted: CorrectionPatch[] = [];
  for (const patch of candidates) {
    const prev = accepted[accepted.length - 1];
    if (!prev || patch.start >= prev.end) {
      accepted.push(patch);
      continue;
    }
    // If two numeric-glyph rules hit different characters of the exact same token span,
    // combine their character substitutions into one patch.
    if (
      prev.start === patch.start &&
      prev.end === patch.end &&
      prev.original === patch.original
    ) {
      const merged = combineEqualSpanCharacterEdits(prev.original, prev.corrected, patch.corrected);
      if (merged !== null) {
        prev.corrected = merged;
      }
    }
  }

  return accepted;
}

function combineEqualSpanCharacterEdits(original: string, first: string, second: string): string | null {
  if (original.length !== first.length || original.length !== second.length) return null;
  let out = '';
  for (let i = 0; i < original.length; i += 1) {
    const o = original.charAt(i);
    const f = first.charAt(i);
    const s = second.charAt(i);
    if (f !== o && s === o) out += f;
    else if (s !== o && f === o) out += s;
    else if (f === s) out += f;
    else return null;
  }
  return out;
}

// --- Text patching & rollback helpers --------------------------------------

function toPatch(correction: OcrCorrection): CorrectionPatch {
  return {
    correctionId: correction.id,
    start: correction.start,
    end: correction.end,
    original: correction.original,
    corrected: correction.corrected,
    ...(correction.ruleId !== undefined ? { ruleId: correction.ruleId } : {}),
  };
}

function applyPatchesToText(text: string, patches: readonly CorrectionPatch[]): string {
  if (patches.length === 0) return text;
  const descending = [...patches].sort((a, b) => b.start - a.start);
  let out = text;
  for (const patch of descending) {
    out = `${out.slice(0, patch.start)}${patch.corrected}${out.slice(patch.end)}`;
  }
  return out;
}

function revertPatchesFromText(afterText: string, forwardPatches: readonly CorrectionPatch[]): string {
  if (forwardPatches.length === 0) return afterText;
  const ascending = [...forwardPatches].sort((a, b) => a.start - b.start);
  let delta = 0;
  const shifted = ascending.map(patch => {
    const afterStart = patch.start + delta;
    const afterEnd = afterStart + patch.corrected.length;
    delta += patch.corrected.length - patch.original.length;
    return { afterStart, afterEnd, original: patch.original, expectedAfter: patch.corrected };
  });

  let out = afterText;
  for (let idx = shifted.length - 1; idx >= 0; idx -= 1) {
    const item = shifted[idx]!;
    if (out.slice(item.afterStart, item.afterEnd) !== item.expectedAfter) {
      throw new OcrCorrectionError(
        'rollback-conflict',
        `expected "${item.expectedAfter}" at [${item.afterStart}, ${item.afterEnd}) during rollback.`,
        'text',
      );
    }
    out = `${out.slice(0, item.afterStart)}${item.original}${out.slice(item.afterEnd)}`;
  }
  return out;
}

// --- JSON Serialization & Validation ---------------------------------------

function serializeCorrection(c: OcrCorrection): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: c.id,
    documentId: c.documentId,
    page: c.page,
    start: c.start,
    end: c.end,
    original: c.original,
    corrected: c.corrected,
  };
  if (c.blockId !== undefined) out.blockId = c.blockId;
  if (c.reason !== undefined) out.reason = c.reason;
  if (c.ruleId !== undefined) out.ruleId = c.ruleId;
  out.sourceSha256 = c.sourceSha256;
  out.status = c.status;
  out.confirmed = c.confirmed;
  if (c.confirmedBy !== undefined) out.confirmedBy = c.confirmedBy;
  if (c.confirmedAt !== undefined) out.confirmedAt = c.confirmedAt;
  out.createdAt = c.createdAt;
  out.updatedAt = c.updatedAt;
  return out;
}

function serializeRule(r: OcrCorrectionRule): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: r.id,
    kind: r.kind,
    from: r.from,
    to: r.to,
  };
  if (r.scope !== undefined) out.scope = r.scope;
  out.supportCount = r.supportCount;
  out.confidence = r.confidence;
  out.examples = r.examples.map(ex => ({ original: ex.original, corrected: ex.corrected }));
  out.confirmed = r.confirmed;
  if (r.confirmedBy !== undefined) out.confirmedBy = r.confirmedBy;
  if (r.confirmedAt !== undefined) out.confirmedAt = r.confirmedAt;
  out.createdAt = r.createdAt;
  out.updatedAt = r.updatedAt;
  return out;
}

function serializeLedgerEntry(entry: LedgerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    revisionId: entry.revisionId,
    documentId: entry.documentId,
    sequence: entry.sequence,
  };
  if (entry.blockId !== undefined) out.blockId = entry.blockId;
  out.appliedAt = entry.appliedAt;
  if (entry.confirmedBy !== undefined) out.confirmedBy = entry.confirmedBy;
  out.sourceSha256 = entry.sourceSha256;
  out.beforeSha256 = entry.beforeSha256;
  out.afterSha256 = entry.afterSha256;
  out.correctionIds = [...entry.correctionIds];
  out.patches = entry.patches.map(serializePatch);
  out.rolledBack = entry.rolledBack;
  if (entry.rolledBackAt !== undefined) out.rolledBackAt = entry.rolledBackAt;
  return out;
}

function serializePatch(p: CorrectionPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.correctionId !== undefined) out.correctionId = p.correctionId;
  if (p.ruleId !== undefined) out.ruleId = p.ruleId;
  out.start = p.start;
  out.end = p.end;
  out.original = p.original;
  out.corrected = p.corrected;
  return out;
}

function parseExportDocument(json: string): {
  sources: unknown[];
  corrections: unknown[];
  rules: unknown[];
  ledger: unknown[];
} {
  if (typeof json !== 'string') {
    throw new OcrCorrectionError('malformed-json', 'importJson expects a JSON string.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    throw new OcrCorrectionError('malformed-json', `JSON parse failed (${detail}).`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OcrCorrectionError('malformed-export', 'export must be a JSON object.');
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.schemaVersion !== OCR_CORRECTIONS_SCHEMA_VERSION) {
    throw new OcrCorrectionError(
      'unsupported-schema-version',
      `schemaVersion ${String(doc.schemaVersion)} is unsupported.`,
      'schemaVersion',
    );
  }
  if (doc.kind !== OCR_CORRECTIONS_EXPORT_KIND) {
    throw new OcrCorrectionError('malformed-export', `kind must be "${OCR_CORRECTIONS_EXPORT_KIND}".`, 'kind');
  }
  if (!Array.isArray(doc.sources) || !Array.isArray(doc.corrections) || !Array.isArray(doc.rules) || !Array.isArray(doc.ledger)) {
    throw new OcrCorrectionError('malformed-export', 'sources, corrections, rules, and ledger must be arrays.');
  }
  return {
    sources: doc.sources,
    corrections: doc.corrections,
    rules: doc.rules,
    ledger: doc.ledger,
  };
}

function readSourceSnapshot(value: unknown, path: string): SourceSnapshot {
  const rec = requireObject(value, path);
  return {
    documentId: requireText(rec.documentId, `${path}.documentId`),
    sourceSha256: requireSha256(rec.sourceSha256, `${path}.sourceSha256`),
    byteLength: requireNonNegativeInt(rec.byteLength, `${path}.byteLength`),
    registeredAt: requireText(rec.registeredAt, `${path}.registeredAt`),
  };
}

function readCorrectionRecord(value: unknown, path: string): OcrCorrection {
  const rec = requireObject(value, path);
  const status = requireEnum(rec.status, `${path}.status`, CORRECTION_STATUSES);
  const confirmed = requireBoolean(rec.confirmed, `${path}.confirmed`);
  if ((status === 'confirmed' || status === 'applied' || status === 'rolled-back') && confirmed !== true) {
    throw new OcrCorrectionError('invalid-field', `status "${status}" requires confirmed === true.`, `${path}.confirmed`);
  }
  if ((status === 'pending' || status === 'rejected') && confirmed !== false) {
    throw new OcrCorrectionError('invalid-field', `status "${status}" requires confirmed === false.`, `${path}.confirmed`);
  }
  const start = requireNonNegativeInt(rec.start, `${path}.start`);
  const end = requireNonNegativeInt(rec.end, `${path}.end`);
  const original = requireString(rec.original, `${path}.original`);
  if (end < start || original.length !== end - start) {
    throw new OcrCorrectionError('invalid-field', 'invalid span range or original length.', `${path}.end`);
  }

  const out: OcrCorrection = {
    id: requireText(rec.id, `${path}.id`),
    documentId: requireText(rec.documentId, `${path}.documentId`),
    page: requirePage(rec.page, `${path}.page`),
    start,
    end,
    original,
    corrected: requireString(rec.corrected, `${path}.corrected`),
    sourceSha256: requireSha256(rec.sourceSha256, `${path}.sourceSha256`),
    status,
    confirmed,
    createdAt: requireText(rec.createdAt, `${path}.createdAt`),
    updatedAt: requireText(rec.updatedAt, `${path}.updatedAt`),
  };
  const blockId = optionalText(rec.blockId, `${path}.blockId`);
  const reason = optionalText(rec.reason, `${path}.reason`);
  const ruleId = optionalText(rec.ruleId, `${path}.ruleId`);
  const confirmedBy = optionalText(rec.confirmedBy, `${path}.confirmedBy`);
  const confirmedAt = optionalText(rec.confirmedAt, `${path}.confirmedAt`);
  if (blockId !== undefined) out.blockId = blockId;
  if (reason !== undefined) out.reason = reason;
  if (ruleId !== undefined) out.ruleId = ruleId;
  if (confirmedBy !== undefined) out.confirmedBy = confirmedBy;
  if (confirmedAt !== undefined) out.confirmedAt = confirmedAt;
  return out;
}

function readRuleRecord(value: unknown, path: string): OcrCorrectionRule {
  const rec = requireObject(value, path);
  const examplesRaw = rec.examples;
  if (!Array.isArray(examplesRaw)) {
    throw new OcrCorrectionError('malformed-export', 'examples must be an array.', `${path}.examples`);
  }
  const examples: RuleExample[] = examplesRaw.map((ex, idx) => {
    const obj = requireObject(ex, `${path}.examples[${idx}]`);
    return {
      original: requireString(obj.original, `${path}.examples[${idx}].original`),
      corrected: requireString(obj.corrected, `${path}.examples[${idx}].corrected`),
    };
  });
  const supportCount = requireNonNegativeInt(rec.supportCount, `${path}.supportCount`);
  if (supportCount < 1) {
    throw new OcrCorrectionError('invalid-field', 'supportCount must be >= 1.', `${path}.supportCount`);
  }
  if (typeof rec.confidence !== 'number' || !Number.isFinite(rec.confidence) || rec.confidence < 0 || rec.confidence > 1) {
    throw new OcrCorrectionError('invalid-field', 'confidence must be in [0, 1].', `${path}.confidence`);
  }
  const out: OcrCorrectionRule = {
    id: requireText(rec.id, `${path}.id`),
    kind: requireEnum(rec.kind, `${path}.kind`, RULE_KINDS),
    from: requireString(rec.from, `${path}.from`),
    to: requireString(rec.to, `${path}.to`),
    supportCount,
    confidence: rec.confidence,
    examples,
    confirmed: requireBoolean(rec.confirmed, `${path}.confirmed`),
    createdAt: requireText(rec.createdAt, `${path}.createdAt`),
    updatedAt: requireText(rec.updatedAt, `${path}.updatedAt`),
  };
  if (rec.scope !== undefined) out.scope = requireEnum(rec.scope, `${path}.scope`, RULE_SCOPES);
  const confirmedBy = optionalText(rec.confirmedBy, `${path}.confirmedBy`);
  const confirmedAt = optionalText(rec.confirmedAt, `${path}.confirmedAt`);
  if (confirmedBy !== undefined) out.confirmedBy = confirmedBy;
  if (confirmedAt !== undefined) out.confirmedAt = confirmedAt;
  return out;
}

function readLedgerRecord(value: unknown, path: string): LedgerEntry {
  const rec = requireObject(value, path);
  if (!Array.isArray(rec.correctionIds) || !Array.isArray(rec.patches)) {
    throw new OcrCorrectionError('malformed-export', 'correctionIds and patches must be arrays.', path);
  }
  const sequence = requireNonNegativeInt(rec.sequence, `${path}.sequence`);
  if (sequence < 1) {
    throw new OcrCorrectionError('invalid-field', 'sequence must be >= 1.', `${path}.sequence`);
  }
  const out: LedgerEntry = {
    revisionId: requireText(rec.revisionId, `${path}.revisionId`),
    documentId: requireText(rec.documentId, `${path}.documentId`),
    sequence,
    appliedAt: requireText(rec.appliedAt, `${path}.appliedAt`),
    sourceSha256: requireSha256(rec.sourceSha256, `${path}.sourceSha256`),
    beforeSha256: requireSha256(rec.beforeSha256, `${path}.beforeSha256`),
    afterSha256: requireSha256(rec.afterSha256, `${path}.afterSha256`),
    correctionIds: rec.correctionIds.map((id, idx) => requireText(id, `${path}.correctionIds[${idx}]`)),
    patches: rec.patches.map((p, idx) => readPatch(p, `${path}.patches[${idx}]`)),
    rolledBack: requireBoolean(rec.rolledBack, `${path}.rolledBack`),
  };
  const blockId = optionalText(rec.blockId, `${path}.blockId`);
  const confirmedBy = optionalText(rec.confirmedBy, `${path}.confirmedBy`);
  const rolledBackAt = optionalText(rec.rolledBackAt, `${path}.rolledBackAt`);
  if (blockId !== undefined) out.blockId = blockId;
  if (confirmedBy !== undefined) out.confirmedBy = confirmedBy;
  if (rolledBackAt !== undefined) out.rolledBackAt = rolledBackAt;
  return out;
}

function readPatch(value: unknown, path: string): CorrectionPatch {
  const rec = requireObject(value, path);
  const start = requireNonNegativeInt(rec.start, `${path}.start`);
  const end = requireNonNegativeInt(rec.end, `${path}.end`);
  const original = requireString(rec.original, `${path}.original`);
  if (end < start || original.length !== end - start) {
    throw new OcrCorrectionError('invalid-field', 'invalid patch span.', `${path}.end`);
  }
  const patch: CorrectionPatch = {
    start,
    end,
    original,
    corrected: requireString(rec.corrected, `${path}.corrected`),
  };
  const correctionId = optionalText(rec.correctionId, `${path}.correctionId`);
  const ruleId = optionalText(rec.ruleId, `${path}.ruleId`);
  if (correctionId !== undefined) patch.correctionId = correctionId;
  if (ruleId !== undefined) patch.ruleId = ruleId;
  return patch;
}

// --- Field validation & cloning helpers ------------------------------------

function requireConfirmedTrue(options: unknown, action: string): void {
  if (typeof options !== 'object' || options === null || (options as { confirmed?: unknown }).confirmed !== true) {
    throw new OcrCorrectionError(
      'confirmation-required',
      `${action} requires explicit { confirmed: true } user confirmation.`,
      'confirmed',
    );
  }
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OcrCorrectionError('malformed-export', `${path} must be an object.`, path);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new OcrCorrectionError('invalid-field', `${path} must be a string.`, path);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new OcrCorrectionError('invalid-field', `${path} must not be blank.`, path);
  }
  return trimmed;
}

function optionalText(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireText(value, path);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new OcrCorrectionError('invalid-field', `${path} must be a string.`, path);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new OcrCorrectionError('invalid-field', `${path} must be a boolean.`, path);
  }
  return value;
}

function requirePage(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new OcrCorrectionError('invalid-field', `${path} must be a 1-based integer page.`, path);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new OcrCorrectionError('invalid-field', `${path} must be a non-negative integer.`, path);
  }
  return value;
}

function requireSha256(value: unknown, path: string): string {
  const text = requireText(value, path).toLowerCase();
  if (!SHA256_HEX_RE.test(text)) {
    throw new OcrCorrectionError('invalid-field', `${path} must be a 64-character SHA-256 hex digest.`, path);
  }
  return text;
}

function requireEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const text = requireText(value, path);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new OcrCorrectionError('invalid-field', `${path} must be one of ${allowed.join(' | ')}.`, path);
  }
  return text as T;
}

function compareCorrections(left: OcrCorrection, right: OcrCorrection): number {
  return (
    compareText(left.documentId, right.documentId) ||
    left.page - right.page ||
    left.start - right.start ||
    left.end - right.end ||
    compareText(left.id, right.id)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneCorrection(c: OcrCorrection): OcrCorrection {
  return { ...c };
}

function cloneRule(r: OcrCorrectionRule): OcrCorrectionRule {
  return {
    ...r,
    examples: r.examples.map(ex => ({ ...ex })),
  };
}

function cloneLedgerEntry(entry: LedgerEntry): LedgerEntry {
  return {
    ...entry,
    correctionIds: [...entry.correctionIds],
    patches: entry.patches.map(p => ({ ...p })),
  };
}

function parseNumericSuffix(id: string, prefix: string): number {
  if (!id.startsWith(prefix)) return 0;
  const rest = id.slice(prefix.length);
  if (!/^\d+$/u.test(rest)) return 0;
  return Number.parseInt(rest, 10);
}
