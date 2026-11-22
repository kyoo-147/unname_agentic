/**
 * Local prompt-injection and tool-permission policy.
 *
 * Document text is untrusted data, even when it looks like an instruction. This module
 * detects common attempts to override the assistant or exfiltrate credentials without
 * copying the matched text into a finding. Tool authorization is a separate deny-by-default
 * decision: a document cannot grant itself permission, unknown tools are refused, and
 * write/network/credential capabilities need explicit policy and user approval.
 *
 * The module is pure and deterministic. It does not execute tools, call a model, read the
 * clock, touch the network, or redact the document source.
 */

export type PromptInjectionCode =
  | 'instruction-override'
  | 'secret-exfiltration'
  | 'tool-escalation';

export interface PromptInjectionFinding {
  readonly code: PromptInjectionCode;
  readonly severity: 'high';
}

export interface PromptSafetyAssessment {
  readonly trusted: boolean;
  readonly findings: readonly PromptInjectionFinding[];
}

export class PromptInjectionError extends Error {
  readonly code = 'prompt-injection-detected' as const;
  readonly findings: readonly PromptInjectionFinding[];

  constructor(assessment: PromptSafetyAssessment) {
    super('Untrusted document text contains instruction-like content and cannot authorize actions.');
    this.name = 'PromptInjectionError';
    this.findings = assessment.findings;
  }
}

const INJECTION_RULES: readonly { code: PromptInjectionCode; pattern: RegExp }[] = [
  {
    code: 'instruction-override',
    pattern: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|system)\s+instructions?\b/iu,
  },
  {
    code: 'secret-exfiltration',
    pattern: /\b(?:reveal|print|show|dump|exfiltrate)\s+(?:the\s+)?(?:system\s+prompt|api\s*key|access\s+token|password|secret|credential)s?\b/iu,
  },
  {
    code: 'tool-escalation',
    pattern: /\b(?:call|run|execute|invoke|use)\s+(?:the\s+)?(?:tool|function|shell|command|browser)\b|\b(?:disable|bypass|grant|elevate)\s+(?:safety|permission|restriction|policy|approval)s?\b/iu,
  },
];

/** Inspects untrusted document text without returning or logging the matched content. */
export function inspectUntrustedText(text: string): PromptSafetyAssessment {
  if (typeof text !== 'string') {
    throw new TypeError('Untrusted prompt text must be a string.');
  }
  const findings = INJECTION_RULES
    .filter(rule => rule.pattern.test(text))
    .map(rule => ({ code: rule.code, severity: 'high' as const }));
  return { trusted: findings.length === 0, findings };
}

/** Throws when untrusted text is being used at a trusted instruction boundary. */
export function assertPromptSafe(text: string): void {
  const assessment = inspectUntrustedText(text);
  if (!assessment.trusted) throw new PromptInjectionError(assessment);
}

export type ToolCapability = 'read' | 'write' | 'network' | 'credential';
export type ToolRequestSource = 'user' | 'model' | 'document' | 'system';

export interface ToolPermissionPolicy {
  readonly allowedTools: readonly string[];
  readonly allowedCapabilities: readonly ToolCapability[];
  readonly approvalRequired: readonly ToolCapability[];
}

export interface ToolCallRequest {
  readonly tool: string;
  readonly source: ToolRequestSource;
  readonly capabilities?: readonly ToolCapability[];
  readonly approved?: boolean;
}

export type ToolPermissionErrorCode =
  | 'invalid-request'
  | 'untrusted-source'
  | 'unknown-tool'
  | 'tool-not-allowed'
  | 'capability-not-allowed'
  | 'approval-required';

export interface ToolPermissionDecision {
  readonly allowed: boolean;
  readonly code: ToolPermissionErrorCode | null;
  readonly missing: readonly ToolCapability[];
}

/** The six existing document-reading tools, with no network/write/credential authority. */
export const DEFAULT_DOCUMENT_TOOL_POLICY: ToolPermissionPolicy = Object.freeze({
  allowedTools: Object.freeze([
    'navigate_page',
    'crop_region',
    'zoom_region',
    'read_region_text',
    'search_document',
    'cite_region',
  ]),
  allowedCapabilities: Object.freeze(['read'] as const),
  approvalRequired: Object.freeze(['write', 'network', 'credential'] as const),
});

const KNOWN_TOOLS = new Set(DEFAULT_DOCUMENT_TOOL_POLICY.allowedTools);

/**
 * Authorizes a proposed tool call. Document-originated text can never authorize a call,
 * regardless of the policy supplied by a caller.
 */
export function authorizeToolCall(
  policy: ToolPermissionPolicy,
  request: ToolCallRequest,
): ToolPermissionDecision {
  if (!isPolicy(policy) || !isRequest(request)) {
    return { allowed: false, code: 'invalid-request', missing: [] };
  }
  if (request.source === 'document') {
    return { allowed: false, code: 'untrusted-source', missing: [] };
  }
  if (!KNOWN_TOOLS.has(request.tool) && !policy.allowedTools.includes(request.tool)) {
    return { allowed: false, code: 'unknown-tool', missing: [] };
  }
  if (!policy.allowedTools.includes(request.tool)) {
    return { allowed: false, code: 'tool-not-allowed', missing: [] };
  }

  const requested: ToolCapability[] = [...new Set(request.capabilities ?? (['read'] as const))];
  const missing = requested.filter(capability => !policy.allowedCapabilities.includes(capability));
  if (missing.length > 0) return { allowed: false, code: 'capability-not-allowed', missing };

  const needsApproval = requested.some(capability => policy.approvalRequired.includes(capability));
  if (needsApproval && request.approved !== true) {
    return { allowed: false, code: 'approval-required', missing: [] };
  }
  return { allowed: true, code: null, missing: [] };
}

function isPolicy(value: unknown): value is ToolPermissionPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ToolPermissionPolicy>;
  return Array.isArray(candidate.allowedTools)
    && Array.isArray(candidate.allowedCapabilities)
    && Array.isArray(candidate.approvalRequired);
}

function isRequest(value: unknown): value is ToolCallRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ToolCallRequest>;
  return typeof candidate.tool === 'string'
    && ['user', 'model', 'document', 'system'].includes(candidate.source as string);
}
