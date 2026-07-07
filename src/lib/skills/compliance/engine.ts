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
 * it returns a "no ruleset loaded" block violation. A check that evaluates
 * ZERO rules (empty ruleset, or none applicable to the content type) also
 * fails closed with an "engine.empty-ruleset" block violation.
 *
 * SEED LOCK: the five seed verticals (SEED_RULESETS) can never be overwritten
 * through this API — registerRuleset() throws, with no unlock option.
 * Replacing a seed ruleset (e.g. with an approved M1b-generated one) is an
 * operator-level decision made in code, not an API call.
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

/**
 * Registry keys are normalized (lowercase, trimmed) so "Cannabis" and
 * "cannabis" resolve to the same ruleset — while genuinely unknown verticals
 * still fail closed. Normalization applies at registration AND lookup, so a
 * case-variant can never shadow (or dodge the lock on) a seed vertical.
 */
function normalizeVertical(vertical: string): string {
  return vertical.trim().toLowerCase();
}

const registry = new Map<string, VerticalRuleset>();
for (const ruleset of SEED_RULESETS) registry.set(normalizeVertical(ruleset.vertical), ruleset);

/** Seed verticals are locked: they can never be overwritten via registerRuleset(). */
const SEED_VERTICAL_KEYS: ReadonlySet<string> = new Set(
  SEED_RULESETS.map((ruleset) => normalizeVertical(ruleset.vertical)),
);

/**
 * Register a ruleset for a new vertical (e.g. an approved M1b-generated
 * playbook). Generated rulesets for regulated industries are drafts until a
 * human approves them (SKILL.md) — register only approved rulesets.
 *
 * Seed verticals (cannabis, real-estate, restaurants, health-life-insurance,
 * ecommerce) can NEVER be overwritten here — not even with
 * `{ overwrite: true }`. There is no unlock mechanism in this library:
 * replacing a seed ruleset is an operator-level decision made in the seed
 * modules themselves (with code review), because a runtime overwrite could
 * neuter the hard legal gate.
 */
export function registerRuleset(ruleset: VerticalRuleset, options?: { overwrite?: boolean }): void {
  const key = normalizeVertical(ruleset.vertical);
  if (SEED_VERTICAL_KEYS.has(key)) {
    throw new Error(
      `Refusing to overwrite the seed compliance ruleset for vertical "${ruleset.vertical}". ` +
        "Seed rulesets are locked — there is no overwrite option. Replacing one is an operator-level " +
        "change to the seed modules (rulesets/), gated by code review, never a runtime API call.",
    );
  }
  if (registry.has(key) && !options?.overwrite) {
    throw new Error(
      `A compliance ruleset for vertical "${ruleset.vertical}" is already registered; pass { overwrite: true } to replace it.`,
    );
  }
  registry.set(key, ruleset);
}

export function getRuleset(vertical: string): VerticalRuleset | undefined {
  return registry.get(normalizeVertical(vertical));
}

export function registeredVerticals(): string[] {
  return [...registry.keys()];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function checkCompliance(input: ComplianceCheckInput): ComplianceResult {
  const ruleset = registry.get(normalizeVertical(input.vertical));
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

  // Defense-in-depth: a check that evaluated ZERO rules screened nothing —
  // fail closed, never pass (empty ruleset, however it got there, or no rule
  // applicable to this content type).
  if (rulesEvaluated === 0) return failClosedEmpty(input, ruleset);

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

/** A check that evaluated zero rules screened nothing → block, never pass. */
function failClosedEmpty(input: ComplianceCheckInput, ruleset: VerticalRuleset): ComplianceResult {
  const violation: ComplianceViolation = {
    ruleId: "engine.empty-ruleset",
    vertical: input.vertical,
    severity: "block",
    description:
      "A compliance check that evaluates zero rules fails closed — an empty ruleset never passes content.",
    legalReference:
      "Doc 00 §7.7 / doc 02 (compliance_ruleset_ref is non-negotiable): nothing ships for a vertical without passing its ruleset.",
    explanation:
      `The ruleset for vertical "${input.vertical}" (version ${ruleset.version}) evaluated 0 rules for ` +
      `content type "${input.contentType}" — the content was not screened at all, so the compliance ` +
      "engine fails closed rather than passing unscreened content.",
    requiredFix:
      "Load a reviewed ruleset that contains rules applicable to this content type (M1b-generated " +
      "rulesets require human legal review before use), then re-run the check.",
  };
  return {
    pass: false,
    violations: [violation],
    warnings: [],
    disclaimer: COMPLIANCE_DISCLAIMER,
    vertical: input.vertical,
    rulesetVersion: ruleset.version,
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

/** Split a platform string into comparable word tokens ("Instagram Stories" → ["instagram", "stories"]). */
function platformTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);
}

/**
 * Word-boundary-aware platform matching. An entry matches only as a whole
 * contiguous token sequence: "google ads" matches "google ads campaign" but
 * NOT "google adsense" (no substring matching across token boundaries).
 * Single-token entries match any whole token ("meta" matches "meta ads
 * manager"). Fail-safe direction preserved: exact equality always matches,
 * and list entries stay broad ("google" alone still catches "google
 * adsense" wherever a ruleset prohibits Google entirely).
 */
function platformMatches(platform: string, entry: string): boolean {
  if (platform === entry) return true;
  const haystack = platformTokens(platform);
  const needle = platformTokens(entry);
  if (needle.length === 0) return false;
  return haystack.some((_, i) => needle.every((token, j) => haystack[i + j] === token));
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
