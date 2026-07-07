/**
 * compliance-ruleset skill — generic rule engine (build step 0.2).
 *
 * One deterministic evaluator consumes declarative per-vertical rule modules
 * (pattern matchers, required-element checks, platform gates, jurisdiction
 * licensing). Pure TypeScript: no network, no DB, no LLM calls.
 *
 * HONESTY OF SCOPE — this engine is a pre-screening layer. It BLOCKS
 * known-bad patterns and FLAGS risk signals so nothing obviously unlawful
 * reaches the publish queue. It supports the `compliance-review` agent and
 * human sign-off; it does not replace them, and it cannot certify content as
 * compliant. Every result carries this statement in its `disclaimer` field.
 *
 * FAIL-CLOSED: a vertical with no registered ruleset never silently passes —
 * it returns a "no ruleset loaded" block violation.
 */

import type {
  ComplianceCheckInput,
  ComplianceContent,
  ComplianceFinding,
  ComplianceResult,
  ComplianceRule,
  ComplianceViolation,
  ComplianceWarning,
  JurisdictionLicenseRule,
  PatternRule,
  PlatformGateRule,
  RequiredElementRule,
  VerticalRuleset,
} from "./types";
import { findMatches, normalizeForMatching, normalizeJurisdiction, withinWindow, type TextSpan } from "./match";
import { SEED_RULESETS } from "./rulesets";

export const COMPLIANCE_DISCLAIMER =
  "Deterministic pre-screening only. This check blocks known-bad patterns and flags risk signals; " +
  "it is not legal review and does not replace the compliance-review agent or human legal sign-off. " +
  "A pass means no known-bad pattern was detected — it is not a certification of compliance.";

const DEFAULT_SUBSTANTIATION_WINDOW = 150;

// ---------------------------------------------------------------------------
// Ruleset registry (seed verticals preloaded; M1b playbooks register more)
// ---------------------------------------------------------------------------

const registry = new Map<string, VerticalRuleset>();
for (const ruleset of SEED_RULESETS) registry.set(ruleset.vertical, ruleset);

/**
 * Register a ruleset for a new vertical (e.g. an approved M1b-generated
 * playbook). Generated rulesets for regulated industries are drafts until a
 * human approves them (SKILL.md) — register only approved rulesets.
 */
export function registerRuleset(ruleset: VerticalRuleset, options?: { overwrite?: boolean }): void {
  if (registry.has(ruleset.vertical) && !options?.overwrite) {
    throw new Error(
      `A compliance ruleset for vertical "${ruleset.vertical}" is already registered; pass { overwrite: true } to replace it.`,
    );
  }
  registry.set(ruleset.vertical, ruleset);
}

export function getRuleset(vertical: string): VerticalRuleset | undefined {
  return registry.get(vertical);
}

export function registeredVerticals(): string[] {
  return [...registry.keys()];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function checkCompliance(input: ComplianceCheckInput): ComplianceResult {
  const ruleset = registry.get(input.vertical);
  if (!ruleset) return failClosed(input);

  const originalText = input.content.text ?? "";
  const normText = normalizeForMatching(originalText);
  const findings: ComplianceFinding[] = [];
  let rulesEvaluated = 0;

  for (const rule of ruleset.rules) {
    if (rule.appliesTo && !rule.appliesTo.includes(input.contentType)) continue;
    rulesEvaluated += 1;
    switch (rule.kind) {
      case "pattern":
        findings.push(...evaluatePatternRule(rule, normText, originalText));
        break;
      case "required-element": {
        const finding = evaluateRequiredElementRule(rule, input.content, normText);
        if (finding) findings.push(finding);
        break;
      }
      case "platform-gate": {
        const finding = evaluatePlatformGateRule(rule, input.content);
        if (finding) findings.push(finding);
        break;
      }
      case "jurisdiction-license": {
        const finding = evaluateJurisdictionRule(rule, input);
        if (finding) findings.push(finding);
        break;
      }
    }
  }

  const violations = findings.filter((f): f is ComplianceViolation => f.severity === "block");
  const warnings = findings.filter((f): f is ComplianceWarning => f.severity === "warn");

  return {
    pass: violations.length === 0,
    violations,
    warnings,
    disclaimer: COMPLIANCE_DISCLAIMER,
    vertical: input.vertical,
    rulesetVersion: ruleset.version,
    rulesEvaluated,
  };
}

/** Unknown vertical → block, never silently pass. */
function failClosed(input: ComplianceCheckInput): ComplianceResult {
  const violation: ComplianceViolation = {
    ruleId: "engine.no-ruleset-loaded",
    vertical: input.vertical,
    severity: "block",
    description: `No compliance ruleset loaded for vertical "${input.vertical}" — unknown verticals fail closed.`,
    legalReference:
      "Doc 00 §7.7 / doc 02 (compliance_ruleset_ref is non-negotiable): nothing ships for a vertical without passing its ruleset.",
    explanation:
      `No ruleset loaded for vertical "${input.vertical}": the compliance engine fails closed rather than passing unscreened content.`,
    requiredFix:
      "Register a reviewed compliance ruleset for this vertical (M1b-generated rulesets require human legal review before use), then re-run the check.",
  };
  return {
    pass: false,
    violations: [violation],
    warnings: [],
    disclaimer: COMPLIANCE_DISCLAIMER,
    vertical: input.vertical,
    rulesetVersion: null,
    rulesEvaluated: 0,
  };
}

// ---------------------------------------------------------------------------
// Rule evaluators
// ---------------------------------------------------------------------------

function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{(excerpt|platform|jurisdiction)\}/g, (whole, key: string) => values[key] ?? whole);
}

function makeFinding(rule: ComplianceRule, overrides: Partial<ComplianceFinding>): ComplianceFinding {
  return {
    ruleId: rule.id,
    vertical: rule.vertical,
    severity: rule.severity,
    description: rule.description,
    legalReference: rule.legalReference,
    requiredFix: rule.requiredFix,
    explanation: rule.description,
    ...overrides,
  };
}

function evaluatePatternRule(rule: PatternRule, normText: string, originalText: string): ComplianceFinding[] {
  const raw = findMatches(normText, rule.patterns);
  if (raw.length === 0) return [];

  const exceptionSpans = rule.exceptions?.length ? findMatches(normText, rule.exceptions) : [];
  const substantiationSpans = rule.substantiationSignals?.length
    ? findMatches(normText, rule.substantiationSignals)
    : [];
  const exceptionWindow = rule.exceptionWindow ?? 0;
  const substantiationWindow = rule.substantiationWindow ?? DEFAULT_SUBSTANTIATION_WINDOW;

  const kept: TextSpan[] = [];
  for (const span of raw) {
    if (exceptionSpans.some((e) => withinWindow(span, e, exceptionWindow))) continue;
    if (substantiationSpans.some((s) => withinWindow(span, s, substantiationWindow))) continue;
    if (kept.some((k) => withinWindow(span, k, 0))) continue; // dedupe overlapping matches
    kept.push(span);
  }

  return kept.map((span) => {
    const excerpt = originalText.slice(span.start, span.end);
    return makeFinding(rule, {
      explanation: render(rule.explanation, { excerpt }),
      match: { excerpt, index: span.start },
    });
  });
}

function evaluateRequiredElementRule(
  rule: RequiredElementRule,
  content: ComplianceContent,
  normText: string,
): ComplianceFinding | null {
  const fieldsText = (content.formFields ?? [])
    .map((f) => [f.name, f.label, f.type].filter(Boolean).join(" "))
    .join("\n");
  const haystack = fieldsText ? `${normText}\n${normalizeForMatching(fieldsText)}` : normText;

  if (rule.onlyWhen) {
    const textTriggered =
      (rule.onlyWhen.textSignals?.length ?? 0) > 0 &&
      findMatches(haystack, rule.onlyWhen.textSignals ?? []).length > 0;
    const flagTriggered = rule.onlyWhen.structuredFlags?.some((flag) => content[flag] === true) ?? false;
    if (!textTriggered && !flagTriggered) return null;
  }

  if (rule.requirement.structuredFlag && content[rule.requirement.structuredFlag]) return null;
  if (findMatches(haystack, rule.requirement.textSignals).length > 0) return null;

  // Missing element — no text span to point at.
  return makeFinding(rule, { explanation: rule.explanation });
}

function platformMatches(platform: string, entry: string): boolean {
  if (platform === entry) return true;
  if (entry.includes(" ")) return platform.includes(entry);
  return platform.split(/[^a-z0-9+]+/).includes(entry);
}

function evaluatePlatformGateRule(rule: PlatformGateRule, content: ComplianceContent): ComplianceFinding | null {
  if (rule.bypassFlag && content[rule.bypassFlag] === true) return null;

  const raw = content.platform?.trim();
  if (!raw) {
    return makeFinding(rule, {
      severity: "warn",
      explanation:
        `No target platform specified for gated ${rule.vertical} output — the platform gate cannot be verified. ` +
        "Specify content.platform so the gate can evaluate it.",
      requiredFix: "Set content.platform to the intended ad platform and re-run the check.",
    });
  }

  const platform = raw.toLowerCase();
  const prohibited = rule.prohibitedPlatforms.find((p) => platformMatches(platform, p));
  if (prohibited) {
    return makeFinding(rule, {
      explanation: render(rule.explanation, { platform: raw }),
      match: { excerpt: raw, index: -1 },
    });
  }

  if (rule.allowedPlatforms && !rule.allowedPlatforms.some((p) => platformMatches(platform, p))) {
    return makeFinding(rule, {
      severity: "warn",
      explanation:
        `Platform "${raw}" is not on this vertical's vetted platform list — verify the platform's advertising policy before producing output.`,
      match: { excerpt: raw, index: -1 },
    });
  }

  return null;
}

function evaluateJurisdictionRule(
  rule: JurisdictionLicenseRule,
  input: ComplianceCheckInput,
): ComplianceFinding | null {
  const jurisdiction = input.jurisdiction?.trim();
  if (!jurisdiction) return null; // jurisdiction only "where relevant" (SKILL.md)

  const target = normalizeJurisdiction(jurisdiction);
  const licensed = input.content.licensedStates;

  if (!licensed || licensed.length === 0) {
    return makeFinding(rule, {
      severity: "warn",
      explanation:
        `Content targets jurisdiction "${jurisdiction}" but no licensedStates were provided — licensing cannot be verified. ` +
        "Provide content.licensedStates or have compliance-review confirm licensing.",
      match: { excerpt: jurisdiction, index: -1 },
    });
  }

  if (licensed.some((state) => normalizeJurisdiction(state) === target)) return null;

  return makeFinding(rule, {
    explanation: render(rule.explanation, { jurisdiction }),
    match: { excerpt: jurisdiction, index: -1 },
  });
}
