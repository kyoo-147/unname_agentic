import type { DocumentIR } from '../ir';
import type { ExtractedField, FieldExtractionResult } from '../schema';

export type RuleOperator = 'contains' | 'equals' | 'matches' | 'exists' | 'missing';

export interface AutomationRule {
  readonly id: string;
  readonly description?: string;
  readonly priority?: number;
  readonly when: {
    readonly fieldId?: string;
    readonly operator: RuleOperator;
    readonly value?: string;
    readonly pattern?: string;
  };
  readonly tags?: readonly string[];
  readonly classification?: string;
}

export interface RuleOverride {
  readonly ruleId: string;
  readonly enabled: boolean;
  readonly tags?: readonly string[];
  readonly classification?: string | null;
}

export interface RuleEvidence {
  readonly fieldId?: string;
  readonly value?: string;
  readonly problem?: string;
}

export interface RuleMatch {
  readonly ruleId: string;
  readonly tags: readonly string[];
  readonly classification: string | null;
  readonly evidence: RuleEvidence;
}

export interface RuleEvaluation {
  readonly tags: readonly string[];
  readonly classification: string | null;
  readonly matches: readonly RuleMatch[];
}

export interface RuleInput {
  readonly document: DocumentIR;
  readonly extraction?: FieldExtractionResult | null;
}

export function evaluateRules(input: RuleInput, rules: readonly AutomationRule[], overrides: readonly RuleOverride[] = []): RuleEvaluation {
  if (!Array.isArray(rules)) throw new TypeError('rules must be an array.');
  const fields = new Map((input.extraction?.fields ?? []).map(field => [field.id, field]));
  const missing = new Set((input.extraction?.missing ?? []).map(field => field.id));
  const overrideById = new Map(overrides.map(override => [override.ruleId, override]));
  const matches: RuleMatch[] = [];
  const tags = new Set<string>();
  let classification: string | null = null;

  for (const rule of [...rules].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id))) {
    const override = overrideById.get(rule.id);
    if (override?.enabled === false) continue;
    const field = rule.when.fieldId === undefined ? undefined : fields.get(rule.when.fieldId);
    const matched = matchesRule(rule, input.document, field, rule.when.fieldId === undefined ? false : missing.has(rule.when.fieldId));
    if (!matched.ok) continue;
    const ruleTags = [...(override?.tags ?? rule.tags ?? [])].map(value => value.trim()).filter(Boolean);
    for (const tag of ruleTags) tags.add(tag);
    const ruleClassification = override?.classification !== undefined ? override.classification : rule.classification;
    if (ruleClassification) classification = ruleClassification;
    matches.push({ ruleId: rule.id, tags: ruleTags, classification: ruleClassification ?? null, evidence: matched.evidence });
  }

  return { tags: [...tags].sort(), classification, matches };
}

export function previewRules(input: RuleInput, rules: readonly AutomationRule[], overrides: readonly RuleOverride[] = []): RuleEvaluation {
  return evaluateRules(input, rules, overrides);
}

function matchesRule(rule: AutomationRule, document: DocumentIR, field: ExtractedField | undefined, missing: boolean): { ok: boolean; evidence: RuleEvidence } {
  const { operator, value, pattern } = rule.when;
  if (operator === 'missing') return { ok: missing, evidence: { fieldId: rule.when.fieldId, problem: 'missing' } };
  if (operator === 'exists') return { ok: field !== undefined, evidence: { fieldId: rule.when.fieldId, value: field?.value } };
  const candidate = field?.value ?? document.blocks.map(block => block.raw).join('\n');
  if (typeof candidate !== 'string') return { ok: false, evidence: {} };
  if (operator === 'equals') return { ok: candidate === (value ?? ''), evidence: { fieldId: rule.when.fieldId, value: candidate } };
  if (operator === 'contains') return { ok: candidate.toLocaleLowerCase().includes((value ?? '').toLocaleLowerCase()), evidence: { fieldId: rule.when.fieldId, value: candidate } };
  if (operator === 'matches') {
    if (typeof pattern !== 'string') return { ok: false, evidence: { problem: 'missing-pattern' } };
    try {
      const expression = new RegExp(pattern, 'iu');
      return { ok: expression.test(candidate), evidence: { fieldId: rule.when.fieldId, value: candidate } };
    } catch {
      return { ok: false, evidence: { problem: 'invalid-pattern' } };
    }
  }
  return { ok: false, evidence: {} };
}
