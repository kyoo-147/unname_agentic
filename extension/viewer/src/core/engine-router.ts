/**
 * Auto translation engine router and local route telemetry (backlog G14).
 *
 * The four translation engines (`local`, `google`, `deepl`, `openai`) differ in
 * privacy boundary, language coverage, prompt-glossary support, batching, and
 * per-character cost. This module picks the engine before a request leaves the
 * app, enforces `src/core/privacy.ts` as an unbreakable gate, prices OpenAI
 * requests with `src/core/pricing.ts`, supports declarative rules and explicit
 * overrides, and maintains local-only telemetry counters.
 *
 * Contract:
 * - Privacy first: `offline` mode and any unconsented (`allowCloud: false`)
 *   request MUST NEVER route to a cloud engine (`google`, `deepl`, `openai`),
 *   even when an explicit rule or override asks for one.
 * - Pure preview vs stateful telemetry: {@link routeEngine} and
 *   {@link EngineRouter.preview} are pure and deterministic; {@link EngineRouter.route}
 *   additionally updates local in-memory counters using an injectable clock.
 * - No DOM, no network, no unrequested disk I/O.
 */

import { detectDomain, isDocumentDomain, type DocumentDomain } from './domain';
import type { GlossaryEntry } from './glossary';
import { detectLanguage, normalizeLanguageCode } from './language';
import { estimateCost, formatUsd, type CostEstimate } from './pricing';
import {
  PrivacyError,
  assertCanSend,
  classifyEndpoint,
  effectiveEndpoint,
  isCloudProvider,
  privacyPolicy,
  type EndpointScope,
  type PrivacyErrorCode,
  type PrivacyMode,
  type PrivacySettings,
} from './privacy';
import { countCharacters, supportsBatch } from './translation';
import type { ProviderKind } from './types';

// --- Constants -------------------------------------------------------------

/** All translation engines the router evaluates, in fixed tie-break order. */
export const ROUTE_ENGINES: readonly ProviderKind[] = Object.freeze([
  'local',
  'google',
  'deepl',
  'openai',
]);

/** Default loopback endpoint assumed for `local` when the caller omits one. */
export const DEFAULT_LOCAL_ENDPOINT = 'http://127.0.0.1:11434/v1';

/** Default remote endpoint assumed for `openai` when the caller omits one. */
export const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1';

/** Default OpenAI model priced via `src/core/pricing.ts` when omitted. */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/** Character ceiling for the `short` text-length tier. */
export const SHORT_TEXT_CHARS = 500;

/** Character floor for the `long` text-length tier, where batching & cost dominate. */
export const LONG_TEXT_CHARS = 4000;

/**
 * Reference list rates (USD per million source characters) for character-billed
 * cloud APIs not present in `src/core/pricing.ts`'s OpenAI token table.
 */
export const DEFAULT_CLOUD_CHAR_USD_PER_MILLION: Readonly<Record<'google' | 'deepl', number>> = Object.freeze({
  google: 20,
  deepl: 25,
});

/** Schema version for serialized local telemetry snapshots. */
export const ROUTE_TELEMETRY_SCHEMA_VERSION = 1;

/** Envelope `kind` for serialized local telemetry snapshots. */
export const ROUTE_TELEMETRY_DOCUMENT_KIND = 'mirror.engine-router-telemetry';

const PRIVACY_MODES: readonly PrivacyMode[] = Object.freeze(['offline', 'ask', 'cloud']);
const COST_STRATEGIES: readonly CostStrategy[] = Object.freeze(['balanced', 'lowest-cost', 'quality']);

/** Static capability profile of each supported engine in this codebase. */
export interface EngineCapability {
  readonly isCloud: boolean;
  readonly supportsBatch: boolean;
  readonly supportsGlossary: boolean;
  readonly languages: readonly string[];
}

const ALL_SUPPORTED_LANGUAGES = Object.freeze([
  'ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt', 'ru', 'th', 'vi', 'zh',
]);

const DEEPL_SUPPORTED_LANGUAGES = Object.freeze([
  'ar', 'de', 'en', 'es', 'fr', 'id', 'ja', 'ko', 'pt', 'ru', 'zh',
]);

/**
 * Documented capabilities per engine, aligned with `src/core/translation.ts`
 * (only `local` and `openai` accept chat prompts with `Glossary:` rules and batching)
 * and `src/core/language.ts`.
 */
export const ENGINE_CAPABILITIES: Readonly<Record<ProviderKind, EngineCapability>> = Object.freeze({
  local: Object.freeze({
    isCloud: false,
    supportsBatch: supportsBatch('local'),
    supportsGlossary: true,
    languages: ALL_SUPPORTED_LANGUAGES,
  }),
  google: Object.freeze({
    isCloud: true,
    supportsBatch: supportsBatch('google'),
    supportsGlossary: false,
    languages: ALL_SUPPORTED_LANGUAGES,
  }),
  deepl: Object.freeze({
    isCloud: true,
    supportsBatch: supportsBatch('deepl'),
    supportsGlossary: false,
    languages: DEEPL_SUPPORTED_LANGUAGES,
  }),
  openai: Object.freeze({
    isCloud: true,
    supportsBatch: supportsBatch('openai'),
    supportsGlossary: true,
    languages: ALL_SUPPORTED_LANGUAGES,
  }),
});

// --- Public types ----------------------------------------------------------

export type CostStrategy = 'balanced' | 'lowest-cost' | 'quality';
export type TextLengthTier = 'short' | 'medium' | 'long';
export type RouteDecisionSource = 'override' | 'rule' | 'auto';

/** Per-engine configuration passed by the caller. */
export interface EngineRouteConfig {
  readonly enabled?: boolean;
  readonly hasApiKey?: boolean;
  readonly endpoint?: string;
  readonly model?: string;
  readonly charUsdPerMillion?: number;
}

/** Predicate matched against request metadata for declarative routing rules. */
export interface RoutingRuleMatch {
  readonly sourceLanguage?: string | readonly string[];
  readonly targetLanguage?: string | readonly string[];
  readonly languagePair?: string | readonly string[];
  readonly minCharacters?: number;
  readonly maxCharacters?: number;
  readonly hasGlossary?: boolean;
  readonly privacyMode?: PrivacyMode | readonly PrivacyMode[];
  readonly domain?: DocumentDomain | readonly DocumentDomain[];
  readonly maxEstimatedCostUsd?: number;
}

/** Declarative routing rule evaluated before auto-scoring (after privacy checks). */
export interface RoutingRule {
  readonly id: string;
  readonly description?: string;
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly match: RoutingRuleMatch;
  readonly engine: ProviderKind;
}

/** Input describing a translation request to route. */
export interface RouteRequest {
  readonly privacyMode: PrivacyMode;
  readonly allowCloud: boolean;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly text?: string;
  readonly characterCount?: number;
  readonly glossary?: readonly GlossaryEntry[];
  readonly requireGlossary?: boolean;
  readonly glossaryStrict?: boolean;
  readonly domain?: DocumentDomain;
  readonly maxCostUsd?: number;
  readonly costStrategy?: CostStrategy;
  readonly engines?: Readonly<Partial<Record<ProviderKind, EngineRouteConfig>>>;
  readonly rules?: readonly RoutingRule[];
  readonly override?: ProviderKind;
  readonly strictOverride?: boolean;
}

/** Estimated cost for one candidate engine. */
export interface EngineCostEstimate {
  readonly engine: ProviderKind;
  readonly characters: number;
  readonly estimatedUsd: number | null;
  readonly formattedUsd: string;
  readonly source: 'pricing-table' | 'provider-char-rate' | 'local-free' | 'unknown';
  readonly tokenEstimate: CostEstimate | null;
  readonly model?: string;
}

/** Explanation for a candidate excluded before ranking. */
export interface BlockedCandidate {
  readonly engine: ProviderKind;
  readonly category: 'privacy' | 'unavailable' | 'budget' | 'capability';
  readonly privacyCode?: PrivacyErrorCode;
  readonly reason: string;
}

/** Deterministic decision returned by {@link routeEngine} and {@link EngineRouter}. */
export interface RouteDecision {
  readonly engine: ProviderKind;
  readonly fallback: readonly ProviderKind[];
  readonly source: RouteDecisionSource;
  readonly matchedRuleId: string | null;
  readonly overrideApplied: boolean;
  readonly overrideBlocked: boolean;
  readonly privacyMode: PrivacyMode;
  readonly allowCloud: boolean;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly detectedSourceLanguage: string | null;
  readonly characters: number;
  readonly textLengthTier: TextLengthTier;
  readonly hasGlossary: boolean;
  readonly glossaryCount: number;
  readonly cost: EngineCostEstimate;
  readonly candidateCosts: Readonly<Partial<Record<ProviderKind, EngineCostEstimate>>>;
  readonly blocked: readonly BlockedCandidate[];
  readonly reasons: readonly string[];
}

/** Local-only counter snapshot exported by {@link EngineRouter.telemetry}. */
export interface RouteTelemetrySnapshot {
  readonly totalRoutes: number;
  readonly byEngine: Readonly<Record<ProviderKind, number>>;
  readonly bySource: Readonly<Record<RouteDecisionSource, number>>;
  readonly byPrivacyMode: Readonly<Record<PrivacyMode, number>>;
  readonly ruleHits: Readonly<Record<string, number>>;
  readonly privacyBlockedCount: number;
  readonly overrideBlockedCount: number;
  readonly fallbackCount: number;
  readonly totalCharacters: number;
  readonly totalEstimatedCostUsd: number;
  readonly lastUpdatedAt: string | null;
}

export interface EngineRouterOptions {
  readonly defaultRules?: readonly RoutingRule[];
  readonly defaultEngines?: Readonly<Partial<Record<ProviderKind, EngineRouteConfig>>>;
  readonly defaultCostStrategy?: CostStrategy;
  readonly now?: () => Date;
}

export type EngineRouterErrorCode =
  | 'invalid-input'
  | 'no-eligible-engine'
  | 'invalid-telemetry'
  | 'unsupported-schema-version'
  | 'invalid-document-kind';

/** Typed error raised for invalid router arguments, unusable telemetry, or zero eligible engines. */
export class EngineRouterError extends Error {
  readonly code: EngineRouterErrorCode;

  constructor(code: EngineRouterErrorCode, message: string) {
    super(message);
    this.name = 'EngineRouterError';
    this.code = code;
  }
}

// --- Internal evaluation structures ----------------------------------------

interface EvaluatedCandidate {
  readonly engine: ProviderKind;
  readonly cost: EngineCostEstimate;
  readonly supportsPair: boolean;
  readonly supportsGlossary: boolean;
}

interface TelemetryRecordOutcome {
  readonly decision?: RouteDecision;
  readonly privacyBlockedInRequest: boolean;
  readonly overrideBlocked: boolean;
  readonly usedFallback: boolean;
}

// --- One-shot convenience API ----------------------------------------------

/** Pure, stateless translation engine route decision with zero telemetry side effects. */
export function routeEngine(request: RouteRequest): RouteDecision {
  return new EngineRouter().preview(request);
}

// --- Stateful router with local telemetry ----------------------------------

/**
 * Stateful translation engine router keeping local-only counters across calls.
 * Call {@link preview} for side-effect-free planning and {@link route} to record
 * local telemetry.
 */
export class EngineRouter {
  readonly #defaultRules: readonly RoutingRule[];
  readonly #defaultEngines: Readonly<Partial<Record<ProviderKind, EngineRouteConfig>>>;
  readonly #defaultCostStrategy: CostStrategy;
  readonly #now: () => Date;

  #totalRoutes = 0;
  #byEngine: Record<ProviderKind, number> = emptyEngineCounts();
  #bySource: Record<RouteDecisionSource, number> = emptySourceCounts();
  #byPrivacyMode: Record<PrivacyMode, number> = emptyPrivacyCounts();
  #ruleHits = new Map<string, number>();
  #privacyBlockedCount = 0;
  #overrideBlockedCount = 0;
  #fallbackCount = 0;
  #totalCharacters = 0;
  #totalEstimatedCostUsd = 0;
  #lastUpdatedAt: string | null = null;

  constructor(options: EngineRouterOptions = {}) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new EngineRouterError('invalid-input', 'EngineRouter options must be an object.');
    }
    this.#defaultRules = validateRules(options.defaultRules ?? []);
    this.#defaultEngines = options.defaultEngines ?? {};
    this.#defaultCostStrategy = validateCostStrategy(options.defaultCostStrategy ?? 'balanced');
    this.#now = typeof options.now === 'function' ? options.now : () => new Date();
  }

  /** Evaluates a route without altering local telemetry counters. */
  preview(request: RouteRequest): RouteDecision {
    return this.#evaluate(request).decision!;
  }

  /** Evaluates a route and records local telemetry counters. */
  route(request: RouteRequest): RouteDecision {
    let outcome: TelemetryRecordOutcome;
    try {
      outcome = this.#evaluate(request);
    } catch (error) {
      if (error instanceof PrivacyError) {
        this.#privacyBlockedCount += 1;
        if (request && typeof request === 'object' && request.override !== undefined) {
          this.#overrideBlockedCount += 1;
        }
        this.#lastUpdatedAt = this.#now().toISOString();
      }
      throw error;
    }

    const decision = outcome.decision!;
    this.#totalRoutes += 1;
    this.#byEngine[decision.engine] += 1;
    this.#bySource[decision.source] += 1;
    this.#byPrivacyMode[decision.privacyMode] += 1;
    if (decision.matchedRuleId !== null) {
      this.#ruleHits.set(decision.matchedRuleId, (this.#ruleHits.get(decision.matchedRuleId) ?? 0) + 1);
    }
    if (outcome.privacyBlockedInRequest) this.#privacyBlockedCount += 1;
    if (outcome.overrideBlocked) this.#overrideBlockedCount += 1;
    if (outcome.usedFallback) this.#fallbackCount += 1;
    this.#totalCharacters += decision.characters;
    if (decision.cost.estimatedUsd !== null) {
      this.#totalEstimatedCostUsd = roundUsd(this.#totalEstimatedCostUsd + decision.cost.estimatedUsd);
    }
    this.#lastUpdatedAt = this.#now().toISOString();

    return decision;
  }

  /** Returns a defensive snapshot of all local route counters. */
  telemetry(): RouteTelemetrySnapshot {
    const ruleHits: Record<string, number> = {};
    for (const [id, count] of [...this.#ruleHits.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      ruleHits[id] = count;
    }
    return {
      totalRoutes: this.#totalRoutes,
      byEngine: { ...this.#byEngine },
      bySource: { ...this.#bySource },
      byPrivacyMode: { ...this.#byPrivacyMode },
      ruleHits,
      privacyBlockedCount: this.#privacyBlockedCount,
      overrideBlockedCount: this.#overrideBlockedCount,
      fallbackCount: this.#fallbackCount,
      totalCharacters: this.#totalCharacters,
      totalEstimatedCostUsd: this.#totalEstimatedCostUsd,
      lastUpdatedAt: this.#lastUpdatedAt,
    };
  }

  /** Clears all local telemetry counters back to zero. */
  resetTelemetry(): void {
    this.#totalRoutes = 0;
    this.#byEngine = emptyEngineCounts();
    this.#bySource = emptySourceCounts();
    this.#byPrivacyMode = emptyPrivacyCounts();
    this.#ruleHits.clear();
    this.#privacyBlockedCount = 0;
    this.#overrideBlockedCount = 0;
    this.#fallbackCount = 0;
    this.#totalCharacters = 0;
    this.#totalEstimatedCostUsd = 0;
    this.#lastUpdatedAt = null;
  }

  /** Exports a versioned local telemetry JSON string. */
  exportTelemetry(): string {
    return JSON.stringify({
      kind: ROUTE_TELEMETRY_DOCUMENT_KIND,
      schemaVersion: ROUTE_TELEMETRY_SCHEMA_VERSION,
      snapshot: this.telemetry(),
    });
  }

  /** Restores and validates a previously exported local telemetry JSON snapshot. */
  restoreTelemetry(json: string): RouteTelemetrySnapshot {
    if (typeof json !== 'string' || json.trim() === '') {
      throw new EngineRouterError('invalid-telemetry', 'Telemetry JSON must be a non-empty string.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      throw new EngineRouterError(
        'invalid-telemetry',
        `Telemetry JSON is malformed: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    if (!isRecord(parsed)) {
      throw new EngineRouterError('invalid-telemetry', 'Telemetry payload must be a JSON object.');
    }
    if (parsed.kind !== ROUTE_TELEMETRY_DOCUMENT_KIND) {
      throw new EngineRouterError(
        'invalid-document-kind',
        `Invalid telemetry kind ${String(parsed.kind)}; expected "${ROUTE_TELEMETRY_DOCUMENT_KIND}".`,
      );
    }
    if (parsed.schemaVersion !== ROUTE_TELEMETRY_SCHEMA_VERSION) {
      throw new EngineRouterError(
        'unsupported-schema-version',
        `Unsupported telemetry schemaVersion ${String(parsed.schemaVersion)}; expected ${ROUTE_TELEMETRY_SCHEMA_VERSION}.`,
      );
    }
    const snapshot = validateSnapshot(parsed.snapshot);
    this.#totalRoutes = snapshot.totalRoutes;
    this.#byEngine = { ...snapshot.byEngine };
    this.#bySource = { ...snapshot.bySource };
    this.#byPrivacyMode = { ...snapshot.byPrivacyMode };
    this.#ruleHits = new Map(Object.entries(snapshot.ruleHits));
    this.#privacyBlockedCount = snapshot.privacyBlockedCount;
    this.#overrideBlockedCount = snapshot.overrideBlockedCount;
    this.#fallbackCount = snapshot.fallbackCount;
    this.#totalCharacters = snapshot.totalCharacters;
    this.#totalEstimatedCostUsd = snapshot.totalEstimatedCostUsd;
    this.#lastUpdatedAt = snapshot.lastUpdatedAt;
    return this.telemetry();
  }

  #evaluate(request: RouteRequest): TelemetryRecordOutcome {
    const validated = validateRequest(request, this.#defaultCostStrategy);
    const rules = validateRules(request.rules ?? this.#defaultRules);
    const enginesConfig = mergeEngines(this.#defaultEngines, request.engines);

    const text = validated.text;
    const characters = validated.characters;
    const textLengthTier: TextLengthTier =
      characters >= LONG_TEXT_CHARS ? 'long' : characters > SHORT_TEXT_CHARS ? 'medium' : 'short';

    const glossaryCount = validated.glossaryCount;
    const hasGlossary = glossaryCount > 0 || validated.requireGlossary;

    const rawSource = normalizeLanguageCode(validated.sourceLanguage);
    const detected = rawSource === 'auto' && text.trim().length > 0 ? detectLanguage(text) : null;
    const detectedSourceLanguage = detected && detected.code !== 'unknown' ? detected.code : null;
    const sourceLanguage = detectedSourceLanguage ?? rawSource;
    const targetLanguage = normalizeLanguageCode(validated.targetLanguage);

    const candidateCosts: Partial<Record<ProviderKind, EngineCostEstimate>> = {};
    const blocked: BlockedCandidate[] = [];
    const eligible: EvaluatedCandidate[] = [];
    const blockedMap = new Map<ProviderKind, BlockedCandidate>();

    for (const engine of ROUTE_ENGINES) {
      const cfg = enginesConfig[engine] ?? {};
      const cost = estimateEngineCost(engine, characters, cfg);
      candidateCosts[engine] = cost;

      const privacyCheck = checkEnginePrivacy(
        engine,
        endpointFor(engine, cfg),
        validated.privacyMode,
        validated.allowCloud,
      );
      if (!privacyCheck.allowed) {
        const entry: BlockedCandidate = {
          engine,
          category: 'privacy',
          privacyCode: privacyCheck.code,
          reason: privacyCheck.reason,
        };
        blocked.push(entry);
        blockedMap.set(engine, entry);
        continue;
      }

      if (cfg.enabled === false || cfg.hasApiKey === false) {
        const entry: BlockedCandidate = {
          engine,
          category: 'unavailable',
          reason: cfg.enabled === false ? `${engine} is disabled.` : `${engine} has no configured API key.`,
        };
        blocked.push(entry);
        blockedMap.set(engine, entry);
        continue;
      }

      if (
        validated.maxCostUsd !== undefined &&
        cost.estimatedUsd !== null &&
        cost.estimatedUsd > validated.maxCostUsd
      ) {
        const entry: BlockedCandidate = {
          engine,
          category: 'budget',
          reason: `${engine} estimated cost (${cost.formattedUsd}) exceeds maxCostUsd (${formatUsd(validated.maxCostUsd)}).`,
        };
        blocked.push(entry);
        blockedMap.set(engine, entry);
        continue;
      }

      if (hasGlossary && (validated.requireGlossary || validated.glossaryStrict) && !ENGINE_CAPABILITIES[engine].supportsGlossary) {
        const entry: BlockedCandidate = {
          engine,
          category: 'capability',
          reason: `${engine} does not support prompt-injected glossaries.`,
        };
        blocked.push(entry);
        blockedMap.set(engine, entry);
        continue;
      }

      eligible.push({
        engine,
        cost,
        supportsPair: supportsLanguagePair(engine, sourceLanguage, targetLanguage),
        supportsGlossary: ENGINE_CAPABILITIES[engine].supportsGlossary,
      });
    }

    const privacyBlockedInRequest = blocked.some(entry => entry.category === 'privacy');

    // Enforce strictOverride even if other engines exist: never silently accept a blocked override when strict.
    if (validated.override !== undefined) {
      const overrideBlock = blockedMap.get(validated.override);
      if (overrideBlock && validated.strictOverride) {
        if (overrideBlock.category === 'privacy' && overrideBlock.privacyCode) {
          throw new PrivacyError(overrideBlock.privacyCode);
        }
        throw new EngineRouterError('no-eligible-engine', overrideBlock.reason);
      }
    }

    if (eligible.length === 0) {
      const firstPrivacy = blocked.find(entry => entry.category === 'privacy');
      if (firstPrivacy?.privacyCode) {
        throw new PrivacyError(firstPrivacy.privacyCode);
      }
      throw new EngineRouterError(
        'no-eligible-engine',
        `No eligible translation engine remained (${blocked.map(b => `${b.engine}: ${b.reason}`).join('; ')}).`,
      );
    }

    const reasons: string[] = [];
    if (privacyBlockedInRequest) {
      const names = blocked.filter(b => b.category === 'privacy').map(b => b.engine).join(', ');
      reasons.push(
        validated.privacyMode === 'offline'
          ? `Privacy mode "offline" excluded ${names}; only loopback local models are allowed.`
          : `Cloud consent (allowCloud=false) is missing, excluding ${names}.`,
      );
    }

    const sortedAuto = [...eligible].sort((a, b) =>
      compareEligible(a, b, {
        costStrategy: validated.costStrategy,
        hasGlossary,
        glossaryStrict: validated.glossaryStrict,
        characters,
        maxCostUsd: validated.maxCostUsd,
      }),
    );

    const eligibleMap = new Map(eligible.map(candidate => [candidate.engine, candidate]));
    let selected: EvaluatedCandidate | undefined;
    let source: RouteDecisionSource = 'auto';
    let matchedRuleId: string | null = null;
    let overrideApplied = false;
    let overrideBlocked = false;
    let usedFallback = false;

    // 1. Explicit override (subject to privacy, availability, and budget).
    if (validated.override !== undefined) {
      const hit = eligibleMap.get(validated.override);
      if (hit) {
        selected = hit;
        source = 'override';
        overrideApplied = true;
        reasons.push(`Explicit override selected "${hit.engine}".`);
      } else {
        const block = blockedMap.get(validated.override);
        overrideBlocked = block?.category === 'privacy';
        usedFallback = true;
        reasons.push(
          `Override to "${validated.override}" was blocked (${block?.reason ?? 'ineligible'}); falling back to compliant routing.`,
        );
      }
    }

    // 2. Prioritized explicit rules (skipping rules whose engine is ineligible).
    if (!selected && rules.length > 0) {
      let resolvedDomain: DocumentDomain | undefined = validated.domain;
      const orderedRules = rules
        .map((rule, index) => ({ rule, index }))
        .filter(({ rule }) => rule.enabled !== false)
        .sort((a, b) => (b.rule.priority ?? 0) - (a.rule.priority ?? 0) || a.index - b.index);

      for (const { rule } of orderedRules) {
        if (rule.match.domain !== undefined && resolvedDomain === undefined) {
          resolvedDomain = detectDomain(text).domain;
        }
        const targetCost = candidateCosts[rule.engine]?.estimatedUsd ?? null;
        if (
          !ruleMatches(rule.match, {
            sourceLanguage,
            targetLanguage,
            characters,
            hasGlossary,
            privacyMode: validated.privacyMode,
            domain: resolvedDomain,
            targetEstimatedCostUsd: targetCost,
          })
        ) {
          continue;
        }

        const candidate = eligibleMap.get(rule.engine);
        if (candidate) {
          selected = candidate;
          source = 'rule';
          matchedRuleId = rule.id;
          reasons.push(`Matched rule "${rule.id}" selecting "${candidate.engine}".`);
          break;
        }

        usedFallback = true;
        const block = blockedMap.get(rule.engine);
        reasons.push(
          `Rule "${rule.id}" targeted "${rule.engine}", which was skipped (${block?.reason ?? 'ineligible'}).`,
        );
      }
    }

    // 3. Auto-scored winner.
    if (!selected) {
      selected = sortedAuto[0]!;
      source = 'auto';
      reasons.push(
        autoReason(selected, {
          sourceLanguage,
          targetLanguage,
          characters,
          textLengthTier,
          hasGlossary,
          costStrategy: validated.costStrategy,
        }),
      );
    }

    const fallback = sortedAuto
      .filter(candidate => candidate.engine !== selected!.engine)
      .map(candidate => candidate.engine);

    return {
      decision: {
        engine: selected.engine,
        fallback: Object.freeze(fallback),
        source,
        matchedRuleId,
        overrideApplied,
        overrideBlocked,
        privacyMode: validated.privacyMode,
        allowCloud: validated.allowCloud,
        sourceLanguage,
        targetLanguage,
        detectedSourceLanguage,
        characters,
        textLengthTier,
        hasGlossary,
        glossaryCount,
        cost: selected.cost,
        candidateCosts: Object.freeze(candidateCosts),
        blocked: Object.freeze(blocked),
        reasons: Object.freeze(reasons),
      },
      privacyBlockedInRequest,
      overrideBlocked,
      usedFallback,
    };
  }
}

// --- Privacy, cost, language, and scoring helpers --------------------------

function endpointFor(engine: ProviderKind, cfg: EngineRouteConfig): string {
  if (typeof cfg.endpoint === 'string' && cfg.endpoint.trim() !== '') return cfg.endpoint;
  if (engine === 'local') return DEFAULT_LOCAL_ENDPOINT;
  if (engine === 'openai') return DEFAULT_OPENAI_ENDPOINT;
  return '';
}

function checkEnginePrivacy(
  engine: ProviderKind,
  endpoint: string,
  privacyMode: PrivacyMode,
  allowCloud: boolean,
): { readonly allowed: true; readonly scope: EndpointScope } | { readonly allowed: false; readonly code: PrivacyErrorCode; readonly reason: string } {
  const settings: PrivacySettings = { provider: engine, endpoint, allowCloud };
  const eff = effectiveEndpoint(settings);
  const policy = privacyPolicy(privacyMode, eff);

  // Defense-in-depth: even if `openai` were configured with a loopback URL, treat
  // cloud provider kinds as cloud when offline or unconsented.
  if (isCloudProvider(engine)) {
    if (!policy.allowsNetwork) {
      return {
        allowed: false,
        code: 'offline',
        reason: `Offline mode blocks cloud engine "${engine}".`,
      };
    }
    if (!allowCloud) {
      return {
        allowed: false,
        code: 'consent',
        reason: `Cloud engine "${engine}" requires allowCloud consent.`,
      };
    }
  }

  try {
    assertCanSend(policy, settings);
  } catch (error) {
    if (error instanceof PrivacyError) {
      return { allowed: false, code: error.code, reason: error.message };
    }
    throw error;
  }

  if (policy.scope === 'invalid') {
    return {
      allowed: false,
      code: privacyMode === 'offline' ? 'offline' : 'consent',
      reason: `Engine "${engine}" has an invalid endpoint.`,
    };
  }

  if (engine === 'local' && policy.scope === 'remote' && !allowCloud) {
    return {
      allowed: false,
      code: 'consent',
      reason: 'Remote endpoint for local engine requires allowCloud consent.',
    };
  }

  return { allowed: true, scope: policy.scope };
}

function estimateEngineCost(
  engine: ProviderKind,
  characters: number,
  cfg: EngineRouteConfig,
): EngineCostEstimate {
  if (engine === 'local') {
    return {
      engine,
      characters,
      estimatedUsd: 0,
      formattedUsd: formatUsd(0),
      source: 'local-free',
      tokenEstimate: null,
      ...(cfg.model ? { model: cfg.model } : {}),
    };
  }

  if (engine === 'openai') {
    const model = cfg.model?.trim() || DEFAULT_OPENAI_MODEL;
    const tokenEstimate = estimateCost({ characters, model, direction: 'both' });
    if (tokenEstimate !== null) {
      return {
        engine,
        characters,
        estimatedUsd: tokenEstimate.usd,
        formattedUsd: formatUsd(tokenEstimate.usd),
        source: 'pricing-table',
        tokenEstimate,
        model,
      };
    }
    if (typeof cfg.charUsdPerMillion === 'number' && Number.isFinite(cfg.charUsdPerMillion) && cfg.charUsdPerMillion >= 0) {
      const usd = (characters * cfg.charUsdPerMillion) / 1_000_000;
      return {
        engine,
        characters,
        estimatedUsd: usd,
        formattedUsd: formatUsd(usd),
        source: 'provider-char-rate',
        tokenEstimate: null,
        model,
      };
    }
    return {
      engine,
      characters,
      estimatedUsd: null,
      formattedUsd: formatUsd(null),
      source: 'unknown',
      tokenEstimate: null,
      model,
    };
  }

  const rate =
    typeof cfg.charUsdPerMillion === 'number' && Number.isFinite(cfg.charUsdPerMillion) && cfg.charUsdPerMillion >= 0
      ? cfg.charUsdPerMillion
      : DEFAULT_CLOUD_CHAR_USD_PER_MILLION[engine];
  const usd = (characters * rate) / 1_000_000;
  return {
    engine,
    characters,
    estimatedUsd: usd,
    formattedUsd: formatUsd(usd),
    source: 'provider-char-rate',
    tokenEstimate: null,
  };
}

function supportsLanguagePair(engine: ProviderKind, source: string, target: string): boolean {
  const supported = ENGINE_CAPABILITIES[engine].languages;
  if (source !== 'auto' && source !== 'unknown' && !supported.includes(source)) return false;
  if (target !== 'auto' && target !== 'unknown' && !supported.includes(target)) return false;
  return true;
}

interface ScoringContext {
  readonly costStrategy: CostStrategy;
  readonly hasGlossary: boolean;
  readonly glossaryStrict: boolean;
  readonly characters: number;
  readonly maxCostUsd: number | undefined;
}

function compareEligible(a: EvaluatedCandidate, b: EvaluatedCandidate, ctx: ScoringContext): number {
  if (a.supportsPair !== b.supportsPair) return a.supportsPair ? -1 : 1;

  if (ctx.hasGlossary && ctx.glossaryStrict && a.supportsGlossary !== b.supportsGlossary) {
    return a.supportsGlossary ? -1 : 1;
  }

  if (ctx.costStrategy === 'lowest-cost' || ctx.maxCostUsd === 0) {
    const costCmp = compareCost(a.cost.estimatedUsd, b.cost.estimatedUsd);
    if (costCmp !== 0) return costCmp;
    return ROUTE_ENGINES.indexOf(a.engine) - ROUTE_ENGINES.indexOf(b.engine);
  }

  const preferenceOrder: readonly ProviderKind[] =
    ctx.hasGlossary || ctx.characters >= LONG_TEXT_CHARS
      ? ['openai', 'local', 'deepl', 'google']
      : ctx.costStrategy === 'quality'
        ? ['deepl', 'openai', 'google', 'local']
        : ['deepl', 'google', 'openai', 'local'];

  const rankA = preferenceOrder.indexOf(a.engine);
  const rankB = preferenceOrder.indexOf(b.engine);
  if (rankA !== rankB) return rankA - rankB;

  const costCmp = compareCost(a.cost.estimatedUsd, b.cost.estimatedUsd);
  if (costCmp !== 0) return costCmp;
  return ROUTE_ENGINES.indexOf(a.engine) - ROUTE_ENGINES.indexOf(b.engine);
}

function compareCost(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function autoReason(
  selected: EvaluatedCandidate,
  info: {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly characters: number;
    readonly textLengthTier: TextLengthTier;
    readonly hasGlossary: boolean;
    readonly costStrategy: CostStrategy;
  },
): string {
  const pair = `${info.sourceLanguage}->${info.targetLanguage}`;
  if (info.costStrategy === 'lowest-cost') {
    return `Auto-routed to "${selected.engine}" (${selected.cost.formattedUsd}) under lowest-cost strategy for ${pair}.`;
  }
  if (info.hasGlossary) {
    return `Auto-routed to "${selected.engine}" for ${pair} because glossary enforcement requires a prompt-capable engine (${selected.cost.formattedUsd}).`;
  }
  if (info.textLengthTier === 'long') {
    return `Auto-routed to "${selected.engine}" for long text (${info.characters} chars, ${pair}, est. ${selected.cost.formattedUsd}) with batching support.`;
  }
  return `Auto-routed to "${selected.engine}" for ${info.textLengthTier} ${pair} text (${info.characters} chars, est. ${selected.cost.formattedUsd}).`;
}

// --- Rule matching ---------------------------------------------------------

interface RuleContext {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly characters: number;
  readonly hasGlossary: boolean;
  readonly privacyMode: PrivacyMode;
  readonly domain: DocumentDomain | undefined;
  readonly targetEstimatedCostUsd: number | null;
}

function ruleMatches(match: RoutingRuleMatch, ctx: RuleContext): boolean {
  if (match.sourceLanguage !== undefined) {
    const list = toArray(match.sourceLanguage).map(normalizeLanguageCode);
    if (!list.includes(ctx.sourceLanguage)) return false;
  }
  if (match.targetLanguage !== undefined) {
    const list = toArray(match.targetLanguage).map(normalizeLanguageCode);
    if (!list.includes(ctx.targetLanguage)) return false;
  }
  if (match.languagePair !== undefined) {
    const pairs = toArray(match.languagePair).map(normalizePair);
    const current = `${ctx.sourceLanguage}->${ctx.targetLanguage}`;
    if (!pairs.includes(current)) return false;
  }
  if (match.minCharacters !== undefined && ctx.characters < match.minCharacters) return false;
  if (match.maxCharacters !== undefined && ctx.characters > match.maxCharacters) return false;
  if (match.hasGlossary !== undefined && ctx.hasGlossary !== match.hasGlossary) return false;
  if (match.privacyMode !== undefined) {
    const modes = toArray(match.privacyMode);
    if (!modes.includes(ctx.privacyMode)) return false;
  }
  if (match.domain !== undefined) {
    const domains = toArray(match.domain);
    if (ctx.domain === undefined || !domains.includes(ctx.domain)) return false;
  }
  if (match.maxEstimatedCostUsd !== undefined) {
    if (ctx.targetEstimatedCostUsd === null || ctx.targetEstimatedCostUsd > match.maxEstimatedCostUsd) {
      return false;
    }
  }
  return true;
}

function normalizePair(pair: string): string {
  const parts = pair.split(/->|:/);
  if (parts.length !== 2) return pair.trim().toLowerCase();
  return `${normalizeLanguageCode(parts[0] ?? '')}->${normalizeLanguageCode(parts[1] ?? '')}`;
}

function toArray<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? value : [value as T];
}

// --- Input validation ------------------------------------------------------

interface ValidatedRequest {
  readonly privacyMode: PrivacyMode;
  readonly allowCloud: boolean;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly text: string;
  readonly characters: number;
  readonly glossaryCount: number;
  readonly requireGlossary: boolean;
  readonly glossaryStrict: boolean;
  readonly domain: DocumentDomain | undefined;
  readonly maxCostUsd: number | undefined;
  readonly costStrategy: CostStrategy;
  readonly override: ProviderKind | undefined;
  readonly strictOverride: boolean;
}

function validateRequest(request: RouteRequest, defaultStrategy: CostStrategy): ValidatedRequest {
  if (!isRecord(request)) {
    throw new EngineRouterError('invalid-input', 'RouteRequest must be an object.');
  }
  if (typeof request.privacyMode !== 'string' || !PRIVACY_MODES.includes(request.privacyMode)) {
    throw new EngineRouterError(
      'invalid-input',
      `privacyMode must be one of ${PRIVACY_MODES.join(', ')}, got ${String(request.privacyMode)}.`,
    );
  }
  if (typeof request.allowCloud !== 'boolean') {
    throw new EngineRouterError('invalid-input', 'allowCloud must be a boolean.');
  }
  if (typeof request.sourceLanguage !== 'string' || typeof request.targetLanguage !== 'string') {
    throw new EngineRouterError('invalid-input', 'sourceLanguage and targetLanguage must be strings.');
  }

  const text = request.text ?? '';
  if (typeof text !== 'string') {
    throw new EngineRouterError('invalid-input', 'text must be a string when provided.');
  }

  let characters: number;
  if (request.characterCount !== undefined) {
    if (typeof request.characterCount !== 'number' || !Number.isFinite(request.characterCount) || request.characterCount < 0) {
      throw new EngineRouterError('invalid-input', 'characterCount must be a finite non-negative number.');
    }
    characters = Math.floor(request.characterCount);
  } else {
    characters = countCharacters(text);
  }

  let maxCostUsd: number | undefined;
  if (request.maxCostUsd !== undefined) {
    if (typeof request.maxCostUsd !== 'number' || !Number.isFinite(request.maxCostUsd) || request.maxCostUsd < 0) {
      throw new EngineRouterError('invalid-input', 'maxCostUsd must be a finite non-negative number.');
    }
    maxCostUsd = request.maxCostUsd;
  }

  if (request.override !== undefined && !isProviderKind(request.override)) {
    throw new EngineRouterError(
      'invalid-input',
      `override engine must be one of ${ROUTE_ENGINES.join(', ')}, got ${String(request.override)}.`,
    );
  }

  if (request.domain !== undefined && !isDocumentDomain(request.domain)) {
    throw new EngineRouterError('invalid-input', `Unknown document domain ${String(request.domain)}.`);
  }

  const glossaryCount = Array.isArray(request.glossary)
    ? request.glossary.filter(item => item && typeof item.source === 'string' && item.source.trim() !== '').length
    : 0;

  return {
    privacyMode: request.privacyMode,
    allowCloud: request.allowCloud,
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
    text,
    characters,
    glossaryCount,
    requireGlossary: request.requireGlossary === true,
    glossaryStrict: request.glossaryStrict !== false,
    domain: request.domain,
    maxCostUsd,
    costStrategy: validateCostStrategy(request.costStrategy ?? defaultStrategy),
    override: request.override,
    strictOverride: request.strictOverride === true,
  };
}

function validateCostStrategy(value: unknown): CostStrategy {
  if (typeof value !== 'string' || !COST_STRATEGIES.includes(value as CostStrategy)) {
    throw new EngineRouterError(
      'invalid-input',
      `costStrategy must be one of ${COST_STRATEGIES.join(', ')}, got ${String(value)}.`,
    );
  }
  return value as CostStrategy;
}

function validateRules(rules: readonly RoutingRule[]): readonly RoutingRule[] {
  if (!Array.isArray(rules)) {
    throw new EngineRouterError('invalid-input', 'rules must be an array.');
  }
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!isRecord(rule) || typeof rule.id !== 'string' || rule.id.trim() === '') {
      throw new EngineRouterError('invalid-input', `rules[${i}] must have a non-empty string id.`);
    }
    if (!isProviderKind(rule.engine)) {
      throw new EngineRouterError(
        'invalid-input',
        `rules[${i}].engine must be one of ${ROUTE_ENGINES.join(', ')}.`,
      );
    }
    if (rule.priority !== undefined && (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority))) {
      throw new EngineRouterError('invalid-input', `rules[${i}].priority must be a finite number.`);
    }
    if (!isRecord(rule.match)) {
      throw new EngineRouterError('invalid-input', `rules[${i}].match must be an object.`);
    }
    if (rule.match.domain !== undefined) {
      for (const domain of toArray(rule.match.domain)) {
        if (!isDocumentDomain(domain)) {
          throw new EngineRouterError('invalid-input', `rules[${i}].match.domain contains unknown domain ${String(domain)}.`);
        }
      }
    }
    if (rule.match.privacyMode !== undefined) {
      for (const mode of toArray(rule.match.privacyMode)) {
        if (typeof mode !== 'string' || !PRIVACY_MODES.includes(mode as PrivacyMode)) {
          throw new EngineRouterError('invalid-input', `rules[${i}].match.privacyMode contains invalid mode ${String(mode)}.`);
        }
      }
    }
  }
  return rules;
}

function validateSnapshot(value: unknown): RouteTelemetrySnapshot {
  if (!isRecord(value)) {
    throw new EngineRouterError('invalid-telemetry', 'Telemetry snapshot must be an object.');
  }

  const totalRoutes = readNonNegInt(value.totalRoutes, 'totalRoutes');
  const privacyBlockedCount = readNonNegInt(value.privacyBlockedCount, 'privacyBlockedCount');
  const overrideBlockedCount = readNonNegInt(value.overrideBlockedCount, 'overrideBlockedCount');
  const fallbackCount = readNonNegInt(value.fallbackCount, 'fallbackCount');
  const totalCharacters = readNonNegInt(value.totalCharacters, 'totalCharacters');

  if (typeof value.totalEstimatedCostUsd !== 'number' || !Number.isFinite(value.totalEstimatedCostUsd) || value.totalEstimatedCostUsd < 0) {
    throw new EngineRouterError('invalid-telemetry', 'totalEstimatedCostUsd must be a finite non-negative number.');
  }

  const byEngine = readCountMap(value.byEngine, ROUTE_ENGINES, 'byEngine');
  const bySource = readCountMap(value.bySource, ['override', 'rule', 'auto'] as const, 'bySource');
  const byPrivacyMode = readCountMap(value.byPrivacyMode, PRIVACY_MODES, 'byPrivacyMode');

  if (!isRecord(value.ruleHits)) {
    throw new EngineRouterError('invalid-telemetry', 'ruleHits must be an object.');
  }
  const ruleHits: Record<string, number> = {};
  for (const [id, count] of Object.entries(value.ruleHits)) {
    ruleHits[id] = readNonNegInt(count, `ruleHits.${id}`);
  }

  let lastUpdatedAt: string | null = null;
  if (value.lastUpdatedAt !== null && value.lastUpdatedAt !== undefined) {
    if (typeof value.lastUpdatedAt !== 'string' || Number.isNaN(Date.parse(value.lastUpdatedAt))) {
      throw new EngineRouterError('invalid-telemetry', 'lastUpdatedAt must be null or an ISO timestamp.');
    }
    lastUpdatedAt = value.lastUpdatedAt;
  }

  return {
    totalRoutes,
    byEngine,
    bySource,
    byPrivacyMode,
    ruleHits,
    privacyBlockedCount,
    overrideBlockedCount,
    fallbackCount,
    totalCharacters,
    totalEstimatedCostUsd: value.totalEstimatedCostUsd,
    lastUpdatedAt,
  };
}

function readCountMap<K extends string>(
  raw: unknown,
  keys: readonly K[],
  field: string,
): Record<K, number> {
  if (!isRecord(raw)) {
    throw new EngineRouterError('invalid-telemetry', `${field} must be an object.`);
  }
  const result = {} as Record<K, number>;
  for (const key of keys) {
    result[key] = readNonNegInt(raw[key], `${field}.${key}`);
  }
  return result;
}

function readNonNegInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new EngineRouterError('invalid-telemetry', `${field} must be a non-negative integer.`);
  }
  return value;
}

function mergeEngines(
  defaults: Readonly<Partial<Record<ProviderKind, EngineRouteConfig>>>,
  overrides?: Readonly<Partial<Record<ProviderKind, EngineRouteConfig>>>,
): Partial<Record<ProviderKind, EngineRouteConfig>> {
  const merged: Partial<Record<ProviderKind, EngineRouteConfig>> = {};
  for (const engine of ROUTE_ENGINES) {
    merged[engine] = { ...(defaults[engine] ?? {}), ...(overrides?.[engine] ?? {}) };
  }
  return merged;
}

function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (ROUTE_ENGINES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function emptyEngineCounts(): Record<ProviderKind, number> {
  return { local: 0, google: 0, deepl: 0, openai: 0 };
}

function emptySourceCounts(): Record<RouteDecisionSource, number> {
  return { override: 0, rule: 0, auto: 0 };
}

function emptyPrivacyCounts(): Record<PrivacyMode, number> {
  return { offline: 0, ask: 0, cloud: 0 };
}
