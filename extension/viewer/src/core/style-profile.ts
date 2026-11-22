/**
 * Versioned translation style profiles and prompt integration (backlog G10).
 *
 * A document translator needs more than language codes and a glossary: a
 * contract, an API migration guide, an academic paper, and an executive memo
 * carry distinct registers. This module models those style profiles as
 * validated, versioned, serializable values and composes them cleanly with
 * `src/core/prompt.ts` and `src/core/domain.ts`.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network, no I/O.
 * - Defensive copies: every preset fetch, custom creation, validation, and
 *   deserialization returns fresh frozen copies so callers cannot mutate the
 *   built-in registry.
 * - Prompt composition: delegates base translation rules, glossary formatting,
 *   and placeholder protection (`mask` / `restore`) to `src/core/prompt.ts`,
 *   and delegates genre detection and guidance to `src/core/domain.ts`.
 */

import {
  DOMAIN_LANGUAGES,
  detectDomain,
  glossaryHints,
  isDocumentDomain,
  promptGuidance,
  type DocumentDomain,
  type DomainDetection,
  type DomainLanguage,
} from './domain';
import type { GlossaryEntry } from './glossary';
import { normalizeLanguageCode } from './language';
import {
  PROMPT_VERSION,
  buildProtectedMessages,
  buildSystemPrompt,
  type ChatMessage,
  type PromptOptions,
  type ProtectedPrompt,
} from './prompt';

// --- Constants -------------------------------------------------------------

/** Schema version written by {@link serializeStyleProfile} and read back on restore. */
export const STYLE_PROFILE_SCHEMA_VERSION = 1;

/** Envelope `kind` identifying a serialized style profile record. */
export const STYLE_PROFILE_DOCUMENT_KIND = 'mirror.style-profile';

/** Built-in preset kinds, in the order a selector UI offers them. */
export type BuiltinStyleProfileKind = 'formal' | 'technical' | 'legal' | 'academic' | 'concise';

/** All supported style profile kinds, including user-defined `custom`. */
export type StyleProfileKind = BuiltinStyleProfileKind | 'custom';

/** Every built-in style kind, frozen so callers cannot widen it at runtime. */
export const BUILTIN_STYLE_PROFILE_KINDS: readonly BuiltinStyleProfileKind[] = Object.freeze([
  'formal',
  'technical',
  'legal',
  'academic',
  'concise',
]);

/** Every style profile kind, including `custom`, frozen. */
export const STYLE_PROFILE_KINDS: readonly StyleProfileKind[] = Object.freeze([
  ...BUILTIN_STYLE_PROFILE_KINDS,
  'custom',
]);

/** Default profile kind used when a caller omits `style`. */
export const DEFAULT_STYLE_PROFILE_KIND: BuiltinStyleProfileKind = 'formal';

/** Maximum characters allowed for `StyleProfile.id`. */
export const MAX_STYLE_ID_CHARS = 64;
/** Maximum characters allowed for `StyleProfile.name`. */
export const MAX_STYLE_NAME_CHARS = 80;
/** Maximum characters allowed for `StyleProfile.description`. */
export const MAX_STYLE_DESCRIPTION_CHARS = 240;
/** Maximum characters allowed for `StyleProfile.tone`. */
export const MAX_STYLE_TONE_CHARS = 64;
/** Maximum directive lines allowed in one profile. */
export const MAX_STYLE_DIRECTIVES = 12;
/** Maximum characters allowed per directive line. */
export const MAX_STYLE_DIRECTIVE_CHARS = 320;

const MAX_PROMPT_VERSION_CHARS = 64;
const VALID_PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// --- Public types ----------------------------------------------------------

/** A validated, versioned translation style profile. */
export interface StyleProfile {
  readonly schemaVersion: number;
  readonly id: string;
  readonly kind: StyleProfileKind;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly tone: string;
  readonly directives: readonly string[];
  readonly defaultDomain?: DocumentDomain;
  readonly basePromptVersion?: string;
}

/** Input accepted by {@link createCustomStyleProfile}. */
export interface CustomStyleProfileInput {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly tone: string;
  readonly directives: readonly string[];
  readonly defaultDomain?: DocumentDomain;
  readonly version?: number;
  readonly basePromptVersion?: string;
}

/** Patch accepted by {@link bumpStyleProfileVersion}. */
export interface StyleProfileBumpPatch {
  readonly name?: string;
  readonly description?: string;
  readonly tone?: string;
  readonly directives?: readonly string[];
  readonly defaultDomain?: DocumentDomain;
  readonly basePromptVersion?: string;
}

/** Versioned serialization envelope for storing one style profile. */
export interface StyleProfileEnvelope {
  readonly kind: typeof STYLE_PROFILE_DOCUMENT_KIND;
  readonly schemaVersion: typeof STYLE_PROFILE_SCHEMA_VERSION;
  readonly profile: StyleProfile;
}

export type StyleProfileErrorCode =
  | 'unknown-kind'
  | 'invalid-profile'
  | 'invalid-json'
  | 'unsupported-schema-version'
  | 'invalid-document-kind'
  | 'empty-directives'
  | 'directive-too-long'
  | 'too-many-directives'
  | 'invalid-version';

/** Typed error thrown when selecting, validating, or restoring a style profile fails. */
export class StyleProfileError extends Error {
  readonly code: StyleProfileErrorCode;
  readonly field?: string;

  constructor(code: StyleProfileErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'StyleProfileError';
    this.code = code;
    this.field = field;
  }
}

export interface StyleProfileIssue {
  readonly code: StyleProfileErrorCode;
  readonly field: string;
  readonly message: string;
}

export type StyleProfileValidationResult =
  | { readonly valid: true; readonly profile: StyleProfile }
  | { readonly valid: false; readonly issues: readonly StyleProfileIssue[] };

/** Options for building a styled, versioned translation prompt. */
export interface StyledPromptOptions extends PromptOptions {
  /** Selected preset kind or explicit profile object; defaults to {@link DEFAULT_STYLE_PROFILE_KIND}. */
  readonly style?: BuiltinStyleProfileKind | StyleProfile;
  /** Explicit domain, `'auto'` to classify `sampleText`, or omitted to use profile default. */
  readonly domain?: DocumentDomain | 'auto';
  /** Sample text inspected by `detectDomain` when `domain` is `'auto'` or omitted. */
  readonly sampleText?: string;
  /** Language for `domain.ts` guidance lines; defaults to `target` if supported, else `'en'`. */
  readonly guidanceLanguage?: DomainLanguage;
  /** Set `false` to omit `domain.ts` guidance even if `domain` or `defaultDomain` exists. */
  readonly includeDomainGuidance?: boolean;
  /** Set `true` to merge `domain.ts` glossary seeds without overwriting explicit glossary entries. */
  readonly includeDomainGlossaryHints?: boolean;
}

/** Result of {@link buildStyledPrompt}, carrying resolved metadata alongside the prompt string. */
export interface BuiltStyledPrompt {
  readonly systemPrompt: string;
  readonly promptVersion: string;
  readonly profile: StyleProfile;
  readonly domain: DocumentDomain | null;
  readonly domainDetection: DomainDetection | null;
  readonly guidance: readonly string[];
  readonly glossary: readonly GlossaryEntry[];
}

/** Result of {@link buildProtectedStyledMessages}, preserving masked tokens from `prompt.ts`. */
export interface StyledProtectedPrompt extends ProtectedPrompt {
  readonly promptVersion: string;
  readonly profile: StyleProfile;
  readonly domain: DocumentDomain | null;
  readonly domainDetection: DomainDetection | null;
}

// --- Built-in presets ------------------------------------------------------

const PRESETS: Readonly<Record<BuiltinStyleProfileKind, StyleProfile>> = {
  formal: freezeProfile({
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    id: 'formal',
    kind: 'formal',
    version: 1,
    name: 'Formal',
    description: 'Polished, polite, and publication-ready register for official and business documents.',
    tone: 'formal',
    directives: [
      'Use a formal, polished register suitable for official correspondence and executive documents.',
      'Avoid slang, contractions, and conversational filler; prefer complete grammatical sentences.',
      'Maintain consistent polite forms of address and standard terminology across the document.',
    ],
  }),
  technical: freezeProfile({
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    id: 'technical',
    kind: 'technical',
    version: 1,
    name: 'Technical',
    description: 'Unambiguous engineering register for documentation, specifications, and manuals.',
    tone: 'precise',
    directives: [
      'Use exact domain-standard engineering terminology and keep technical terms consistent.',
      'Prefer unambiguous declarative or imperative sentences over stylistic variation.',
      'Keep identifiers, symbols, configuration keys, units, and syntax verbatim.',
    ],
    defaultDomain: 'technical',
  }),
  legal: freezeProfile({
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    id: 'legal',
    kind: 'legal',
    version: 1,
    name: 'Legal',
    description: 'Authoritative contractual register preserving binding modal force and defined terms.',
    tone: 'authoritative',
    directives: [
      'Preserve the exact legal force of modal verbs ("shall", "must", "may", "shall not").',
      'Keep defined terms capitalized and mapped identically throughout the entire instrument.',
      'Do not paraphrase boilerplate legal conditions or alter clause cross-references.',
    ],
    defaultDomain: 'legal',
  }),
  academic: freezeProfile({
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    id: 'academic',
    kind: 'academic',
    version: 1,
    name: 'Academic',
    description: 'Scholarly, objective register suited for research papers, reviews, and theses.',
    tone: 'scholarly',
    directives: [
      'Use an objective, scholarly third-person tone free of colloquialisms.',
      'Preserve hedged claims, causal qualifiers, and methodological precision accurately.',
      'Keep disciplinary nomenclature, statistical phrasing, and citation markers intact.',
    ],
    defaultDomain: 'academic',
  }),
  concise: freezeProfile({
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    id: 'concise',
    kind: 'concise',
    version: 1,
    name: 'Concise',
    description: 'Compact, direct prose that removes redundancy without omitting facts.',
    tone: 'terse',
    directives: [
      'Express the exact meaning in the fewest clear words without padding or redundant qualifiers.',
      'Preserve every factual detail, constraint, number, and named entity completely.',
      'Prefer direct active phrasing and tight sentence structure.',
    ],
  }),
};

// --- Type guards and lookup ------------------------------------------------

/** Narrows a runtime value to {@link BuiltinStyleProfileKind}. */
export function isBuiltinStyleProfileKind(value: unknown): value is BuiltinStyleProfileKind {
  return typeof value === 'string' && (BUILTIN_STYLE_PROFILE_KINDS as readonly string[]).includes(value);
}

/** Narrows a runtime value to {@link StyleProfileKind}. */
export function isStyleProfileKind(value: unknown): value is StyleProfileKind {
  return typeof value === 'string' && (STYLE_PROFILE_KINDS as readonly string[]).includes(value);
}

/** Returns fresh frozen copies of all built-in style presets in display order. */
export function listStyleProfiles(): StyleProfile[] {
  return BUILTIN_STYLE_PROFILE_KINDS.map(kind => cloneProfile(PRESETS[kind]));
}

/** Returns a fresh frozen copy of one built-in preset, or throws {@link StyleProfileError}. */
export function getStyleProfile(kind: BuiltinStyleProfileKind): StyleProfile {
  if (!isBuiltinStyleProfileKind(kind)) {
    throw new StyleProfileError(
      'unknown-kind',
      `Unknown built-in style profile kind ${describeValue(kind)}. Expected one of ${BUILTIN_STYLE_PROFILE_KINDS.join(', ')}.`,
      'kind',
    );
  }
  return cloneProfile(PRESETS[kind]);
}

/**
 * Resolves a preset kind or validates an explicit {@link StyleProfile} object.
 * Defaults to {@link DEFAULT_STYLE_PROFILE_KIND} when `selection` is omitted.
 */
export function selectStyleProfile(selection: BuiltinStyleProfileKind | StyleProfile = DEFAULT_STYLE_PROFILE_KIND): StyleProfile {
  if (typeof selection === 'string') {
    if ((selection as string) === 'custom') {
      throw new StyleProfileError(
        'unknown-kind',
        'Selecting "custom" requires a full custom StyleProfile object.',
        'kind',
      );
    }
    return getStyleProfile(selection);
  }
  return assertValidStyleProfile(selection);
}

// --- Creation, bumping, and validation -------------------------------------

/** Creates and validates a versioned `custom` style profile. */
export function createCustomStyleProfile(input: CustomStyleProfileInput): StyleProfile {
  if (!isRecord(input)) {
    throw new StyleProfileError('invalid-profile', 'Style profile input must be an object.');
  }
  return assertValidStyleProfile({
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    id: input.id,
    kind: 'custom',
    version: input.version ?? 1,
    name: input.name,
    description: input.description ?? '',
    tone: input.tone,
    directives: input.directives,
    ...(input.defaultDomain !== undefined ? { defaultDomain: input.defaultDomain } : {}),
    ...(input.basePromptVersion !== undefined ? { basePromptVersion: input.basePromptVersion } : {}),
  });
}

/**
 * Returns a new profile with `version` incremented by 1 and optional patch fields applied.
 * Never mutates the source profile.
 */
export function bumpStyleProfileVersion(profile: StyleProfile, patch: StyleProfileBumpPatch = {}): StyleProfile {
  const current = assertValidStyleProfile(profile);
  if (!isRecord(patch)) {
    throw new StyleProfileError('invalid-profile', 'bumpStyleProfileVersion patch must be an object.');
  }
  return assertValidStyleProfile({
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    id: current.id,
    kind: current.kind,
    version: current.version + 1,
    name: patch.name !== undefined ? patch.name : current.name,
    description: patch.description !== undefined ? patch.description : current.description,
    tone: patch.tone !== undefined ? patch.tone : current.tone,
    directives: patch.directives !== undefined ? patch.directives : current.directives,
    ...((patch.defaultDomain ?? current.defaultDomain) !== undefined
      ? { defaultDomain: patch.defaultDomain ?? current.defaultDomain }
      : {}),
    ...((patch.basePromptVersion ?? current.basePromptVersion) !== undefined
      ? { basePromptVersion: patch.basePromptVersion ?? current.basePromptVersion }
      : {}),
  });
}

/** Non-throwing validator returning a canonical frozen {@link StyleProfile} or structured issues. */
export function validateStyleProfile(input: unknown): StyleProfileValidationResult {
  const issues: StyleProfileIssue[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      issues: [{ code: 'invalid-profile', field: 'profile', message: 'Style profile must be an object.' }],
    };
  }

  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== STYLE_PROFILE_SCHEMA_VERSION) {
    issues.push({
      code: 'unsupported-schema-version',
      field: 'schemaVersion',
      message: `schemaVersion must be ${STYLE_PROFILE_SCHEMA_VERSION}, got ${describeValue(schemaVersion)}.`,
    });
  }

  const kind = input.kind;
  if (!isStyleProfileKind(kind)) {
    issues.push({
      code: 'unknown-kind',
      field: 'kind',
      message: `kind must be one of ${STYLE_PROFILE_KINDS.join(', ')}, got ${describeValue(kind)}.`,
    });
  }

  const id = cleanInline(input.id);
  if (!id || id.length > MAX_STYLE_ID_CHARS || !VALID_PROFILE_ID.test(id)) {
    issues.push({
      code: 'invalid-profile',
      field: 'id',
      message: `id must be 1..${MAX_STYLE_ID_CHARS} characters matching ${VALID_PROFILE_ID.source}.`,
    });
  } else if (isBuiltinStyleProfileKind(kind) && id !== kind) {
    issues.push({
      code: 'invalid-profile',
      field: 'id',
      message: `Built-in profile of kind "${kind}" must have id "${kind}", got "${id}".`,
    });
  }

  const version = input.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    issues.push({
      code: 'invalid-version',
      field: 'version',
      message: `version must be a positive integer, got ${describeValue(version)}.`,
    });
  }

  const name = cleanInline(input.name);
  if (!name || name.length > MAX_STYLE_NAME_CHARS) {
    issues.push({
      code: 'invalid-profile',
      field: 'name',
      message: `name must be a non-empty string up to ${MAX_STYLE_NAME_CHARS} characters.`,
    });
  }

  let description = '';
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      issues.push({
        code: 'invalid-profile',
        field: 'description',
        message: 'description must be a string when provided.',
      });
    } else {
      description = cleanInline(input.description);
      if (description.length > MAX_STYLE_DESCRIPTION_CHARS) {
        issues.push({
          code: 'invalid-profile',
          field: 'description',
          message: `description exceeds ${MAX_STYLE_DESCRIPTION_CHARS} characters.`,
        });
      }
    }
  }

  const tone = cleanInline(input.tone);
  if (!tone || tone.length > MAX_STYLE_TONE_CHARS) {
    issues.push({
      code: 'invalid-profile',
      field: 'tone',
      message: `tone must be a non-empty string up to ${MAX_STYLE_TONE_CHARS} characters.`,
    });
  }

  const directives = validateDirectives(input.directives, issues);

  let defaultDomain: DocumentDomain | undefined;
  if (input.defaultDomain !== undefined) {
    if (!isDocumentDomain(input.defaultDomain)) {
      issues.push({
        code: 'invalid-profile',
        field: 'defaultDomain',
        message: `defaultDomain must be a valid DocumentDomain, got ${describeValue(input.defaultDomain)}.`,
      });
    } else {
      defaultDomain = input.defaultDomain;
    }
  }

  let basePromptVersion: string | undefined;
  if (input.basePromptVersion !== undefined) {
    if (typeof input.basePromptVersion !== 'string') {
      issues.push({
        code: 'invalid-profile',
        field: 'basePromptVersion',
        message: 'basePromptVersion must be a string when provided.',
      });
    } else {
      const cleaned = cleanInline(input.basePromptVersion);
      if (!cleaned || cleaned.length > MAX_PROMPT_VERSION_CHARS) {
        issues.push({
          code: 'invalid-profile',
          field: 'basePromptVersion',
          message: `basePromptVersion must be 1..${MAX_PROMPT_VERSION_CHARS} characters.`,
        });
      } else {
        basePromptVersion = cleaned;
      }
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues: Object.freeze(issues) };
  }

  return {
    valid: true,
    profile: freezeProfile({
      schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
      id,
      kind: kind as StyleProfileKind,
      version: version as number,
      name,
      description,
      tone,
      directives,
      ...(defaultDomain !== undefined ? { defaultDomain } : {}),
      ...(basePromptVersion !== undefined ? { basePromptVersion } : {}),
    }),
  };
}

/** Validates `input` and returns a frozen normalized {@link StyleProfile}, or throws {@link StyleProfileError}. */
export function assertValidStyleProfile(input: unknown): StyleProfile {
  const result = validateStyleProfile(input);
  if (result.valid) return result.profile;
  const first = result.issues[0]!;
  throw new StyleProfileError(first.code, first.message, first.field);
}

// --- Serialization ---------------------------------------------------------

/** Wraps a validated {@link StyleProfile} in a canonical versioned envelope object. */
export function toStyleProfileEnvelope(profile: StyleProfile): StyleProfileEnvelope {
  const validated = assertValidStyleProfile(profile);
  return {
    kind: STYLE_PROFILE_DOCUMENT_KIND,
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    profile: orderedProfileRecord(validated),
  };
}

/** Reads and validates a {@link StyleProfileEnvelope} object, throwing {@link StyleProfileError} on mismatch. */
export function fromStyleProfileEnvelope(value: unknown): StyleProfile {
  if (!isRecord(value)) {
    throw new StyleProfileError('invalid-profile', 'Style profile envelope must be a JSON object.');
  }
  if (value.kind !== STYLE_PROFILE_DOCUMENT_KIND) {
    throw new StyleProfileError(
      'invalid-document-kind',
      `Invalid style profile document kind ${describeValue(value.kind)}; expected "${STYLE_PROFILE_DOCUMENT_KIND}".`,
      'kind',
    );
  }
  if (value.schemaVersion !== STYLE_PROFILE_SCHEMA_VERSION) {
    throw new StyleProfileError(
      'unsupported-schema-version',
      `Unsupported style profile schemaVersion ${describeValue(value.schemaVersion)}; expected ${STYLE_PROFILE_SCHEMA_VERSION}.`,
      'schemaVersion',
    );
  }
  return assertValidStyleProfile(value.profile);
}

/** Serializes a validated {@link StyleProfile} into deterministic versioned JSON. */
export function serializeStyleProfile(profile: StyleProfile): string {
  return JSON.stringify(toStyleProfileEnvelope(profile));
}

/** Parses and validates a serialized {@link StyleProfile} JSON document. */
export function deserializeStyleProfile(json: string): StyleProfile {
  if (typeof json !== 'string' || json.trim() === '') {
    throw new StyleProfileError('invalid-json', 'Style profile JSON must be a non-empty string.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new StyleProfileError(
      'invalid-json',
      `Style profile JSON is malformed: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return fromStyleProfileEnvelope(parsed);
}

// --- Prompt integration ----------------------------------------------------

/**
 * Composes a bounded version label combining the base prompt version with the
 * active style profile id and version, preserving `@v<version>` within
 * `prompt.ts`'s 64-character limit.
 */
export function composeStylePromptVersion(profile: StyleProfile, basePromptVersion?: string): string {
  const validated = assertValidStyleProfile(profile);
  const rawBase = cleanInline(basePromptVersion) || validated.basePromptVersion || PROMPT_VERSION;
  const suffix = `@v${validated.version}`;
  const separator = '+style:';
  const maxBaseLength = Math.max(1, MAX_PROMPT_VERSION_CHARS - separator.length - suffix.length - 1);
  const base = rawBase.slice(0, maxBaseLength);
  const availableForId = MAX_PROMPT_VERSION_CHARS - base.length - separator.length - suffix.length;

  let slug = validated.id;
  if (slug.length > availableForId) {
    if (availableForId >= 6) {
      const digest = shortHash(validated.id);
      slug = `${slug.slice(0, availableForId - 5)}-${digest}`;
    } else {
      slug = slug.slice(0, Math.max(1, availableForId));
    }
  }
  return `${base}${separator}${slug}${suffix}`.slice(0, MAX_PROMPT_VERSION_CHARS);
}

/**
 * Builds a complete styled, domain-aware, versioned translation prompt by
 * composing `src/core/prompt.ts` and `src/core/domain.ts`.
 */
export function buildStyledPrompt(options: StyledPromptOptions): BuiltStyledPrompt {
  const profile = selectStyleProfile(options.style);
  const domainResolution = resolveDomain(options, profile);
  const guidanceLanguage = resolveGuidanceLanguage(options.target, options.guidanceLanguage);

  const guidance =
    domainResolution.domain !== null && options.includeDomainGuidance !== false
      ? promptGuidance(domainResolution.domain, guidanceLanguage)
      : [];

  const mergedGlossary = mergeGlossary(
    options.glossary ?? [],
    options.includeDomainGlossaryHints === true && domainResolution.domain !== null
      ? glossaryHints(domainResolution.domain, guidanceLanguage)
      : [],
  );

  const promptVersion = composeStylePromptVersion(profile, options.promptVersion);
  const basePrompt = buildSystemPrompt({
    source: options.source,
    target: options.target,
    glossary: mergedGlossary,
    promptVersion,
  });

  const sections: string[] = [
    [
      `Style profile (${profile.id} v${profile.version}, tone: ${profile.tone}):`,
      ...profile.directives.map(line => `- ${line}`),
    ].join('\n'),
  ];

  if (guidance.length > 0 && domainResolution.domain !== null) {
    sections.push(
      [`Domain guidance (${domainResolution.domain}):`, ...guidance.map(line => `- ${line}`)].join('\n'),
    );
  }

  const systemPrompt = insertBeforePromptVersion(basePrompt, sections.join('\n\n'));

  return {
    systemPrompt,
    promptVersion,
    profile,
    domain: options.includeDomainGuidance === false ? null : domainResolution.domain,
    domainDetection: domainResolution.detection,
    guidance: Object.freeze([...guidance]),
    glossary: Object.freeze(mergedGlossary.map(entry => ({ ...entry }))),
  };
}

/** Convenience helper returning only the formatted system prompt string. */
export function buildStyledSystemPrompt(options: StyledPromptOptions): string {
  return buildStyledPrompt(options).systemPrompt;
}

/** Builds `[system, user]` chat messages for unmasked or pre-masked text. */
export function buildStyledMessages(text: string, options: StyledPromptOptions): ChatMessage[] {
  return [
    { role: 'system', content: buildStyledSystemPrompt(options) },
    { role: 'user', content: text },
  ];
}

/**
 * Masks locked tokens via `src/core/prompt.ts` (`buildProtectedMessages`) and
 * pairs the masked user message with the styled, versioned system prompt.
 * When `domain === 'auto'` and `sampleText` is omitted, domain detection inspects
 * the raw `text` before masking so genre terms and citations remain visible.
 */
export function buildProtectedStyledMessages(text: string, options: StyledPromptOptions): StyledProtectedPrompt {
  const effectiveOptions: StyledPromptOptions =
    options.domain === 'auto' && options.sampleText === undefined
      ? { ...options, sampleText: text }
      : options;

  const built = buildStyledPrompt(effectiveOptions);
  const protectedPrompt = buildProtectedMessages(text, {
    source: effectiveOptions.source,
    target: effectiveOptions.target,
    glossary: built.glossary,
    promptVersion: built.promptVersion,
  });

  return {
    messages: [
      { role: 'system', content: built.systemPrompt },
      protectedPrompt.messages[1]!,
    ],
    tokens: protectedPrompt.tokens,
    promptVersion: built.promptVersion,
    profile: built.profile,
    domain: built.domain,
    domainDetection: built.domainDetection,
  };
}

// --- Internal helpers ------------------------------------------------------

function validateDirectives(value: unknown, issues: StyleProfileIssue[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({
      code: 'empty-directives',
      field: 'directives',
      message: 'directives must be a non-empty array of instruction strings.',
    });
    return [];
  }
  if (value.length > MAX_STYLE_DIRECTIVES) {
    issues.push({
      code: 'too-many-directives',
      field: 'directives',
      message: `directives cannot exceed ${MAX_STYLE_DIRECTIVES} items.`,
    });
    return [];
  }

  const cleaned: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (typeof item !== 'string') {
      issues.push({
        code: 'empty-directives',
        field: `directives[${index}]`,
        message: `directives[${index}] must be a non-empty string.`,
      });
      continue;
    }
    const line = cleanInline(item);
    if (!line) {
      issues.push({
        code: 'empty-directives',
        field: `directives[${index}]`,
        message: `directives[${index}] must not be blank.`,
      });
      continue;
    }
    if (line.length > MAX_STYLE_DIRECTIVE_CHARS) {
      issues.push({
        code: 'directive-too-long',
        field: `directives[${index}]`,
        message: `directives[${index}] exceeds ${MAX_STYLE_DIRECTIVE_CHARS} characters.`,
      });
      continue;
    }
    cleaned.push(line);
  }
  return cleaned;
}

function resolveDomain(
  options: StyledPromptOptions,
  profile: StyleProfile,
): { readonly domain: DocumentDomain | null; readonly detection: DomainDetection | null } {
  if (options.domain !== undefined && options.domain !== 'auto') {
    if (!isDocumentDomain(options.domain)) {
      throw new StyleProfileError(
        'invalid-profile',
        `Unknown document domain ${describeValue(options.domain)}.`,
        'domain',
      );
    }
    return { domain: options.domain, detection: null };
  }

  if (options.domain === 'auto' || options.sampleText !== undefined) {
    const detection = detectDomain(options.sampleText ?? '');
    const domain = detection.domain !== 'general' ? detection.domain : (profile.defaultDomain ?? 'general');
    return { domain, detection };
  }

  return { domain: profile.defaultDomain ?? null, detection: null };
}

function resolveGuidanceLanguage(target: string, explicit?: DomainLanguage): DomainLanguage {
  if (explicit !== undefined) return explicit;
  const normalized = normalizeLanguageCode(target);
  if ((DOMAIN_LANGUAGES as readonly string[]).includes(normalized)) {
    return normalized as DomainLanguage;
  }
  // `prompt.ts` instructions are written in English; match that for targets outside DOMAIN_LANGUAGES.
  return 'en';
}

function mergeGlossary(
  userGlossary: readonly GlossaryEntry[],
  domainSeeds: readonly GlossaryEntry[],
): GlossaryEntry[] {
  const merged: GlossaryEntry[] = [];
  const seen = new Set<string>();

  for (const entry of userGlossary) {
    const key = cleanInline(entry.source).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({ source: entry.source, target: entry.target });
  }

  for (const seed of domainSeeds) {
    const key = cleanInline(seed.source).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({ source: seed.source, target: seed.target });
  }

  return merged;
}

function insertBeforePromptVersion(basePrompt: string, extraSections: string): string {
  const marker = '\n\nPrompt version: ';
  const index = basePrompt.lastIndexOf(marker);
  if (index < 0) return `${basePrompt}\n\n${extraSections}`;
  return `${basePrompt.slice(0, index)}\n\n${extraSections}${basePrompt.slice(index)}`;
}

function cloneProfile(profile: StyleProfile): StyleProfile {
  return freezeProfile(orderedProfileRecord(profile));
}

function freezeProfile(profile: StyleProfile): StyleProfile {
  return Object.freeze({
    ...profile,
    directives: Object.freeze([...profile.directives]),
  });
}

function orderedProfileRecord(profile: StyleProfile): StyleProfile {
  return {
    schemaVersion: profile.schemaVersion,
    id: profile.id,
    kind: profile.kind,
    version: profile.version,
    name: profile.name,
    description: profile.description,
    tone: profile.tone,
    directives: [...profile.directives],
    ...(profile.defaultDomain !== undefined ? { defaultDomain: profile.defaultDomain } : {}),
    ...(profile.basePromptVersion !== undefined ? { basePromptVersion: profile.basePromptVersion } : {}),
  };
}

function cleanInline(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 4);
}
