import { describe, expect, it } from 'vitest';
import { estimateCost as pricingEstimateCost, formatUsd } from '../viewer/src/core/pricing';
import { PrivacyError } from '../viewer/src/core/privacy';
import {
  DEFAULT_CLOUD_CHAR_USD_PER_MILLION,
  DEFAULT_LOCAL_ENDPOINT,
  DEFAULT_OPENAI_MODEL,
  ENGINE_CAPABILITIES,
  EngineRouter,
  EngineRouterError,
  LONG_TEXT_CHARS,
  ROUTE_ENGINES,
  ROUTE_TELEMETRY_DOCUMENT_KIND,
  ROUTE_TELEMETRY_SCHEMA_VERSION,
  SHORT_TEXT_CHARS,
  routeEngine,
  type RoutingRule,
} from '../viewer/src/core/engine-router';

const LEGAL_CONTRACT_EN =
  'WHEREAS the Supplier wishes to supply goods and the Buyer wishes to purchase them under this Agreement, ' +
  'HEREINAFTER the parties agree that Clause 4.2 governs delivery, indemnity, and breach under governing law.';

describe('G14 privacy enforcement (hard gate)', () => {
  it('routes to local and never to cloud in offline mode regardless of allowCloud, length, language, or glossary', () => {
    const decision = routeEngine({
      privacyMode: 'offline',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'de',
      text: 'Long contract '.repeat(500),
      glossary: [{ source: 'Clause', target: 'Klausel' }],
    });

    expect(decision.engine).toBe('local');
    expect(decision.fallback).toEqual([]);
    expect(decision.blocked.map(entry => entry.engine).sort()).toEqual(['deepl', 'google', 'openai']);
    for (const entry of decision.blocked) {
      expect(entry.category).toBe('privacy');
      expect(entry.privacyCode).toBe('offline');
    }
  });

  it('never routes to cloud when allowCloud is false in ask or cloud mode', () => {
    for (const privacyMode of ['ask', 'cloud'] as const) {
      const decision = routeEngine({
        privacyMode,
        allowCloud: false,
        sourceLanguage: 'en',
        targetLanguage: 'de',
        text: 'Hello world.',
      });

      expect(decision.engine, privacyMode).toBe('local');
      expect(decision.fallback, privacyMode).toEqual([]);
      expect(decision.blocked.some(entry => entry.engine === 'openai' && entry.privacyCode === 'consent')).toBe(true);
    }
  });

  it('blocks cloud overrides and cloud rules when offline or unconsented', () => {
    const cloudRule: RoutingRule = {
      id: 'force-deepl-for-de',
      priority: 100,
      match: { targetLanguage: 'de' },
      engine: 'deepl',
    };

    const decision = routeEngine({
      privacyMode: 'offline',
      allowCloud: false,
      sourceLanguage: 'en',
      targetLanguage: 'de',
      text: 'Short sentence.',
      rules: [cloudRule],
      override: 'openai',
    });

    expect(decision.engine).toBe('local');
    expect(decision.overrideApplied).toBe(false);
    expect(decision.overrideBlocked).toBe(true);
    expect(decision.matchedRuleId).toBeNull();
    expect(decision.reasons.some(reason => /override/i.test(reason) && /privacy|offline/i.test(reason))).toBe(true);

    expect(() =>
      routeEngine({
        privacyMode: 'offline',
        allowCloud: true,
        sourceLanguage: 'en',
        targetLanguage: 'de',
        text: 'Short sentence.',
        override: 'google',
        strictOverride: true,
      }),
    ).toThrow(PrivacyError);

    expect(() =>
      routeEngine({
        privacyMode: 'cloud',
        allowCloud: false,
        sourceLanguage: 'en',
        targetLanguage: 'de',
        text: 'Short sentence.',
        override: 'openai',
        strictOverride: true,
      }),
    ).toThrow(PrivacyError);
  });

  it('refuses a non-loopback local endpoint in offline mode, and allows private LAN local outside offline mode', () => {
    expect(() =>
      routeEngine({
        privacyMode: 'offline',
        allowCloud: false,
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        text: 'Hello',
        engines: {
          local: { endpoint: 'http://192.168.1.10:11434/v1' },
        },
      }),
    ).toThrow(PrivacyError);

    const lanInAsk = routeEngine({
      privacyMode: 'ask',
      allowCloud: false,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      text: 'Hello',
      engines: {
        local: { endpoint: 'http://192.168.1.10:11434/v1' },
      },
    });
    expect(lanInAsk.engine).toBe('local');
  });

  it('blocks misconfigured openai even with a loopback endpoint when offline or unconsented', () => {
    const decision = routeEngine({
      privacyMode: 'offline',
      allowCloud: false,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      text: 'Hello',
      override: 'openai',
      engines: {
        openai: { endpoint: DEFAULT_LOCAL_ENDPOINT },
      },
    });
    expect(decision.engine).toBe('local');
    expect(decision.overrideBlocked).toBe(true);
  });
});

describe('G14 language pair, length, and glossary routing', () => {
  it('exports the four engines and documented capability matrix', () => {
    expect(ROUTE_ENGINES).toEqual(['local', 'google', 'deepl', 'openai']);
    expect(ENGINE_CAPABILITIES.deepl.languages).not.toContain('vi');
    expect(ENGINE_CAPABILITIES.google.languages).toContain('vi');
    expect(ENGINE_CAPABILITIES.openai.supportsGlossary).toBe(true);
    expect(ENGINE_CAPABILITIES.google.supportsGlossary).toBe(false);
    expect(SHORT_TEXT_CHARS).toBe(500);
    expect(LONG_TEXT_CHARS).toBe(4000);
  });

  it('routes short plain supported pairs to deepl and unsupported pairs like vi to google when consented', () => {
    const enToDe = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en-US',
      targetLanguage: 'de-DE',
      text: 'Please review the attached invoice before Friday.',
    });
    expect(enToDe.engine).toBe('deepl');
    expect(enToDe.sourceLanguage).toBe('en');
    expect(enToDe.targetLanguage).toBe('de');
    expect(enToDe.textLengthTier).toBe('short');

    const enToVi = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      text: 'Please review the attached invoice before Friday.',
    });
    expect(enToVi.engine).toBe('google');
    expect(enToVi.fallback).toContain('openai');
    expect(enToVi.fallback).toContain('local');
  });

  it('detects source language automatically when sourceLanguage is auto', () => {
    const viToEn = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      text: 'Xin chào thế giới, đây là tài liệu tiếng Việt cần dịch.',
    });
    expect(viToEn.detectedSourceLanguage).toBe('vi');
    expect(viToEn.sourceLanguage).toBe('vi');
    // DeepL does not support Vietnamese source, so Google wins for short plain text.
    expect(viToEn.engine).toBe('google');

    const jaToEn = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      text: 'こんにちは世界。契約書の条項を確認してください。',
    });
    expect(jaToEn.detectedSourceLanguage).toBe('ja');
    expect(jaToEn.engine).toBe('deepl');
  });

  it('routes long documents to batch-capable openai over per-block google/deepl when consented', () => {
    const longDecision = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'de',
      characterCount: LONG_TEXT_CHARS,
    });

    expect(longDecision.textLengthTier).toBe('long');
    expect(longDecision.engine).toBe('openai');
    expect(longDecision.fallback).toContain('local');
  });

  it('routes glossary-constrained requests to glossary-capable engines (openai or local)', () => {
    const cloudGlossary = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'de',
      text: 'Review the EBITDA margin.',
      glossary: [{ source: 'EBITDA', target: 'EBITDA' }],
    });
    expect(cloudGlossary.hasGlossary).toBe(true);
    expect(cloudGlossary.glossaryCount).toBe(1);
    expect(cloudGlossary.engine).toBe('openai');
    expect(cloudGlossary.fallback).toEqual(['local']);

    const requiredFlagOnly = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      text: 'Short text.',
      requireGlossary: true,
    });
    expect(requiredFlagOnly.engine).toBe('openai');
  });
});

describe('G14 pricing integration and budget constraints', () => {
  it('uses src/core/pricing.ts for openai estimates and enforces maxCostUsd budgets', () => {
    const chars = 2000;
    const expectedOpenAi = pricingEstimateCost({
      characters: chars,
      model: DEFAULT_OPENAI_MODEL,
      direction: 'both',
    });
    expect(expectedOpenAi).not.toBeNull();

    // Budget $0.001 excludes DeepL ($0.05) and Google ($0.04) for 2,000 chars, keeping gpt-4o-mini ($0.000375).
    const underOneMill = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'de',
      characterCount: chars,
      maxCostUsd: 0.001,
    });
    expect(underOneMill.engine).toBe('openai');
    expect(underOneMill.cost.estimatedUsd).toBe(expectedOpenAi?.usd);
    expect(underOneMill.cost.source).toBe('pricing-table');
    expect(underOneMill.cost.formattedUsd).toBe(formatUsd(expectedOpenAi!.usd));
    expect(underOneMill.candidateCosts.google?.estimatedUsd).toBeCloseTo(
      (chars * DEFAULT_CLOUD_CHAR_USD_PER_MILLION.google) / 1_000_000,
      9,
    );
    expect(underOneMill.blocked.some(b => b.engine === 'deepl' && b.category === 'budget')).toBe(true);
    expect(underOneMill.blocked.some(b => b.engine === 'google' && b.category === 'budget')).toBe(true);

    // Budget below gpt-4o-mini ($0.000375) routes to local ($0.00).
    const ultraLowBudget = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'de',
      characterCount: chars,
      maxCostUsd: 0.0001,
    });
    expect(ultraLowBudget.engine).toBe('local');
    expect(ultraLowBudget.cost.estimatedUsd).toBe(0);
    expect(ultraLowBudget.cost.formattedUsd).toBe('$0.00');
  });

  it('respects lowest-cost strategy and handles unknown openai models without inventing a price', () => {
    const cheap = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'de',
      characterCount: 300,
      costStrategy: 'lowest-cost',
    });
    expect(cheap.engine).toBe('local');

    const unknownModel = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      characterCount: 1000,
      override: 'openai',
      engines: {
        openai: { model: 'custom-unlisted-model' },
      },
    });
    expect(unknownModel.engine).toBe('openai');
    expect(unknownModel.cost.estimatedUsd).toBeNull();
    expect(unknownModel.cost.formattedUsd).toBe('—');
    expect(unknownModel.cost.source).toBe('unknown');
  });
});

describe('G14 explicit rules, overrides, and local telemetry counters', () => {
  it('applies prioritized matching rules (including domain matching) and explicit overrides', () => {
    const rules: RoutingRule[] = [
      {
        id: 'disabled-rule',
        priority: 500,
        enabled: false,
        match: { targetLanguage: 'vi' },
        engine: 'openai',
      },
      {
        id: 'legal-to-local',
        priority: 50,
        match: { domain: 'legal', targetLanguage: 'vi' },
        engine: 'local',
      },
      {
        id: 'vi-to-openai',
        priority: 10,
        match: { targetLanguage: 'vi' },
        engine: 'openai',
      },
    ];

    const byDomainRule = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      text: LEGAL_CONTRACT_EN,
      rules,
    });
    expect(byDomainRule.engine).toBe('local');
    expect(byDomainRule.source).toBe('rule');
    expect(byDomainRule.matchedRuleId).toBe('legal-to-local');

    const byOverride = routeEngine({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      text: LEGAL_CONTRACT_EN,
      rules,
      override: 'google',
    });
    expect(byOverride.engine).toBe('google');
    expect(byOverride.source).toBe('override');
    expect(byOverride.overrideApplied).toBe(true);
    expect(byOverride.matchedRuleId).toBeNull();
  });

  it('tracks local route telemetry accurately across route(), preview(), reset(), export(), and restore()', () => {
    let tick = 1000;
    const router = new EngineRouter({
      now: () => new Date(tick++),
      defaultRules: [
        {
          id: 'de-via-deepl',
          priority: 20,
          match: { languagePair: 'en->de' },
          engine: 'deepl',
        },
      ],
    });

    // preview() must not touch telemetry counters.
    const previewed = router.preview({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'de',
      characterCount: 100,
    });
    expect(previewed.engine).toBe('deepl');
    expect(router.telemetry().totalRoutes).toBe(0);

    // 1. Rule hit -> deepl
    router.route({
      privacyMode: 'cloud',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'de',
      characterCount: 1000,
    });

    // 2. Override blocked by offline mode -> falls back to local
    router.route({
      privacyMode: 'offline',
      allowCloud: false,
      sourceLanguage: 'en',
      targetLanguage: 'de',
      characterCount: 500,
      override: 'openai',
    });

    // 3. Auto route -> openai (glossary)
    router.route({
      privacyMode: 'ask',
      allowCloud: true,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      characterCount: 2000,
      glossary: [{ source: 'Clause', target: 'Điều khoản' }],
    });

    const snap = router.telemetry();
    expect(snap.totalRoutes).toBe(3);
    expect(snap.byEngine).toEqual({ local: 1, google: 0, deepl: 1, openai: 1 });
    expect(snap.bySource).toEqual({ override: 0, rule: 1, auto: 2 });
    expect(snap.byPrivacyMode).toEqual({ offline: 1, ask: 1, cloud: 1 });
    expect(snap.ruleHits).toEqual({ 'de-via-deepl': 1 });
    expect(snap.overrideBlockedCount).toBe(1);
    expect(snap.privacyBlockedCount).toBeGreaterThanOrEqual(1);
    expect(snap.fallbackCount).toBe(1);
    expect(snap.totalCharacters).toBe(3500);
    expect(snap.totalEstimatedCostUsd).toBeGreaterThan(0);
    expect(snap.lastUpdatedAt).toBe(new Date(1002).toISOString());

    // Mutating snapshot must not mutate internal telemetry.
    (snap.byEngine as Record<string, number>).local = 999;
    expect(router.telemetry().byEngine.local).toBe(1);

    // Export and restore round-trip.
    const serialized = router.exportTelemetry();
    const parsed = JSON.parse(serialized) as { kind: string; schemaVersion: number };
    expect(parsed.kind).toBe(ROUTE_TELEMETRY_DOCUMENT_KIND);
    expect(parsed.schemaVersion).toBe(ROUTE_TELEMETRY_SCHEMA_VERSION);

    const freshRouter = new EngineRouter();
    const restored = freshRouter.restoreTelemetry(serialized);
    expect(restored).toEqual(router.telemetry());

    // Rejects invalid telemetry JSON/version/kind.
    expect(() => freshRouter.restoreTelemetry('not json')).toThrow(EngineRouterError);
    expect(() =>
      freshRouter.restoreTelemetry(JSON.stringify({ ...parsed, kind: 'wrong.kind' })),
    ).toThrow(EngineRouterError);
    expect(() =>
      freshRouter.restoreTelemetry(JSON.stringify({ ...parsed, schemaVersion: 99 })),
    ).toThrow(EngineRouterError);

    router.resetTelemetry();
    expect(router.telemetry()).toEqual({
      totalRoutes: 0,
      byEngine: { local: 0, google: 0, deepl: 0, openai: 0 },
      bySource: { override: 0, rule: 0, auto: 0 },
      byPrivacyMode: { offline: 0, ask: 0, cloud: 0 },
      ruleHits: {},
      privacyBlockedCount: 0,
      overrideBlockedCount: 0,
      fallbackCount: 0,
      totalCharacters: 0,
      totalEstimatedCostUsd: 0,
      lastUpdatedAt: null,
    });
  });

  it('rejects invalid input arguments with EngineRouterError', () => {
    expect(() =>
      routeEngine({
        privacyMode: 'public' as unknown as 'offline',
        allowCloud: false,
        sourceLanguage: 'en',
        targetLanguage: 'vi',
      }),
    ).toThrow(EngineRouterError);

    expect(() =>
      routeEngine({
        privacyMode: 'cloud',
        allowCloud: true,
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        characterCount: -1,
      }),
    ).toThrow(EngineRouterError);

    expect(() =>
      routeEngine({
        privacyMode: 'cloud',
        allowCloud: true,
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        maxCostUsd: Number.NaN,
      }),
    ).toThrow(EngineRouterError);

    expect(() =>
      routeEngine({
        privacyMode: 'cloud',
        allowCloud: true,
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        override: 'anthropic' as unknown as 'openai',
      }),
    ).toThrow(EngineRouterError);
  });
});
