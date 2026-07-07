/**
 * compliance-ruleset skill — public API (build step 0.2).
 *
 * Per-vertical compliance rules that gate content and ads output for
 * cannabis, real-estate, restaurants, health-life-insurance, and ecommerce
 * (SKILL.md at .claude/skills/compliance-ruleset/). Consumed by the
 * `compliance-review` agent — the hard legal gate before anything publishes.
 *
 * Usage:
 *   const result = checkCompliance({
 *     vertical: "cannabis",
 *     contentType: "ad",
 *     content: { text: "...", platform: "meta" },
 *     jurisdiction: "CA",
 *   });
 *   // result.pass === false → hard block; result.violations carry rule id,
 *   // severity, matched excerpt + position, explanation, and required fix.
 *
 * HONESTY OF SCOPE: deterministic pre-screening only — blocks known-bad
 * patterns and flags risk. It supports (never replaces) the
 * compliance-review agent and human legal sign-off; see the `disclaimer`
 * field on every result. Unknown verticals FAIL CLOSED with a
 * "no ruleset loaded" block violation.
 */

export {
  checkCompliance,
  registerRuleset,
  getRuleset,
  registeredVerticals,
  COMPLIANCE_DISCLAIMER,
} from "./engine";

export {
  SEED_RULESETS,
  cannabisRuleset,
  realEstateRuleset,
  restaurantsRuleset,
  healthLifeInsuranceRuleset,
  ecommerceRuleset,
} from "./rulesets";

export type {
  Vertical,
  ComplianceCheckInput,
  ComplianceContent,
  ComplianceContentType,
  ComplianceFormField,
  ComplianceFinding,
  ComplianceMatch,
  ComplianceResult,
  ComplianceRule,
  ComplianceSeverity,
  ComplianceViolation,
  ComplianceWarning,
  JurisdictionLicenseRule,
  PatternMatcher,
  PatternRule,
  PlatformGateRule,
  RequiredElementRule,
  RequiredStructuredFlag,
  TriggerStructuredFlag,
  VerticalRuleset,
} from "./types";
