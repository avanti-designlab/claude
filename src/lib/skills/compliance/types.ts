/**
 * compliance-ruleset skill — core types (build step 0.2).
 *
 * Rules are DATA; the engine (`engine.ts`) is a generic evaluator. A new
 * vertical (e.g. from the M1b Playbook Generator) means adding a rule-set
 * module and registering it — never touching the engine.
 *
 * SCOPE (honest): this is a deterministic pre-screening layer. It blocks
 * known-bad patterns and flags risk signals. It supports the
 * `compliance-review` agent and human legal sign-off — it does NOT replace
 * either. `pass === true` means "no known-bad pattern detected", not
 * "compliant".
 */

import type { Vertical } from "@/lib/types/playbook";

export type { Vertical };

/** The content shapes the pipeline produces (doc 05 Part B, doc 01 §4). */
export type ComplianceContentType =
  | "page"
  | "blog"
  | "faq"
  | "social_caption"
  | "review_response"
  | "ad"
  | "lead_form";

/** "block" fails the check (hard legal gate); "warn" flags for human review. */
export type ComplianceSeverity = "block" | "warn";

export interface ComplianceFormField {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
}

/**
 * The content/asset under evaluation. `text` is always required; the
 * structured fields carry signals plain text cannot (platform targeting,
 * declared form fields, verified-freshness stamps, licensing facts).
 */
export interface ComplianceContent {
  /** Full text: body copy, caption, ad copy, form copy incl. consent language. */
  text: string;
  /** Target platform for ads/social (e.g. "meta", "instagram", "google ads", "weedmaps"). */
  platform?: string;
  /** Declared form fields for `lead_form` content. Labels/names are searched alongside `text`. */
  formFields?: ComplianceFormField[];
  /** True when the page/experience is behind an age gate (cannabis). Absent = unknown. */
  hasAgeGate?: boolean;
  /** ISO date the operational/regulatory facts were last verified (dateModified discipline). */
  lastVerified?: string;
  /** States where the operator is licensed (cannabis dispensary / insurance agency). Codes or full names. */
  licensedStates?: string[];
  /** True when a Meta ad is declared under the applicable Special Ad Category (insurance). */
  declaredSpecialAdCategory?: boolean;
  /** True when the content contains customer testimonials/endorsements (FTC 16 CFR Part 255). */
  containsTestimonial?: boolean;
  /** True when the content involves an affiliate/sponsored/material connection. */
  hasAffiliateRelationship?: boolean;
}

export interface ComplianceCheckInput {
  vertical: Vertical;
  contentType: ComplianceContentType;
  content: ComplianceContent;
  /** State/market the content targets, where relevant (cannabis, insurance). */
  jurisdiction?: string;
}

/**
 * Where the violation was found. `index` is the character offset in
 * `content.text`; `index === -1` means the finding came from a structured
 * field (e.g. `platform`, `jurisdiction`), with `excerpt` holding its value.
 */
export interface ComplianceMatch {
  excerpt: string;
  index: number;
}

export interface ComplianceFinding {
  /** Stable rule id, e.g. "cannabis.health-claims" or "engine.no-ruleset-loaded". */
  ruleId: string;
  vertical: Vertical;
  severity: ComplianceSeverity;
  /** What the rule enforces. */
  description: string;
  /** Legal rationale (statute/regulation/policy) — required by the compliance-review agent. */
  legalReference: string;
  /** Plain-language explanation of why THIS content was flagged. */
  explanation: string;
  /** What has to change before the content can pass. */
  requiredFix: string;
  /** Present for text-pattern and structured-field findings; absent for missing-element findings. */
  match?: ComplianceMatch;
}

export type ComplianceViolation = ComplianceFinding & { severity: "block" };
export type ComplianceWarning = ComplianceFinding & { severity: "warn" };

export interface ComplianceResult {
  /** False when any "block" violation exists. A pass is NOT a compliance certification — see `disclaimer`. */
  pass: boolean;
  violations: ComplianceViolation[];
  warnings: ComplianceWarning[];
  /** Honest-scope statement — carried on every result so downstream consumers can never mistake this for legal review. */
  disclaimer: string;
  vertical: Vertical;
  /** Version of the ruleset that evaluated the content; null when the engine failed closed (no ruleset). */
  rulesetVersion: string | null;
  /** Number of rules applicable to this content type that were evaluated. */
  rulesEvaluated: number;
}

// ---------------------------------------------------------------------------
// Rule model (declarative — consumed by the generic engine)
// ---------------------------------------------------------------------------

/**
 * A text matcher. `phrase` is compiled case-insensitively with word
 * boundaries and flexible whitespace/hyphens ("risk free" also matches
 * "risk-free"). `regex` is a raw pattern compiled with flags "gi" for cases
 * phrases can't express (proximity, alternation, lookarounds).
 */
export type PatternMatcher = { phrase: string } | { regex: string; note?: string };

/** Structured flags that can satisfy a required-element rule. */
export type RequiredStructuredFlag = "hasAgeGate" | "lastVerified" | "declaredSpecialAdCategory";

/** Structured flags that can trigger a conditional rule. */
export type TriggerStructuredFlag = "containsTestimonial" | "hasAffiliateRelationship";

interface RuleBase {
  id: string;
  vertical: Vertical;
  severity: ComplianceSeverity;
  description: string;
  /** Legal rationale reference, e.g. "TCPA 47 U.S.C. §227" — never omitted. */
  legalReference: string;
  requiredFix: string;
  /** Content types the rule applies to. Omitted = all content types. */
  appliesTo?: ComplianceContentType[];
}

/**
 * Prohibited-language rule. Matches are suppressed when they overlap an
 * `exceptions` span (within `exceptionWindow` chars, default 0 = strict
 * overlap) or sit within `substantiationWindow` chars (default 150) of a
 * `substantiationSignals` span (e.g. "#1" next to "rated by <source>").
 */
export interface PatternRule extends RuleBase {
  kind: "pattern";
  patterns: PatternMatcher[];
  exceptions?: PatternMatcher[];
  exceptionWindow?: number;
  substantiationSignals?: PatternMatcher[];
  substantiationWindow?: number;
  /** Plain-language explanation template; "{excerpt}" is interpolated per match. */
  explanation: string;
}

/**
 * Required-element rule: fires when NONE of `requirement.textSignals` appear
 * in the text (or form-field labels) AND `requirement.structuredFlag` is not
 * truthy. `onlyWhen` limits enforcement to content that triggers a
 * precondition (topic signals or structured flags, OR-combined).
 */
export interface RequiredElementRule extends RuleBase {
  kind: "required-element";
  appliesTo: ComplianceContentType[];
  requirement: {
    textSignals: PatternMatcher[];
    structuredFlag?: RequiredStructuredFlag;
  };
  onlyWhen?: {
    textSignals?: PatternMatcher[];
    structuredFlags?: TriggerStructuredFlag[];
  };
  explanation: string;
}

/**
 * Platform gate for ads/social. A `prohibitedPlatforms` hit fires at the
 * rule's severity. If `allowedPlatforms` is set, a platform on neither list
 * yields a "warn" (verify the platform's policy). A missing platform on
 * gated content yields a "warn" (cannot verify — fail toward review).
 * `bypassFlag` satisfies the gate when the named content flag is true
 * (e.g. `declaredSpecialAdCategory` for insurance Meta ads).
 */
export interface PlatformGateRule extends RuleBase {
  kind: "platform-gate";
  appliesTo: ComplianceContentType[];
  prohibitedPlatforms: string[];
  allowedPlatforms?: string[];
  bypassFlag?: "declaredSpecialAdCategory";
  /** Explanation template; "{platform}" is interpolated. */
  explanation: string;
}

/**
 * Jurisdiction/licensing rule. Silent when no `jurisdiction` is provided.
 * With a jurisdiction: blocks (rule severity) when `content.licensedStates`
 * excludes it; warns when `licensedStates` is absent (licensing unverifiable
 * — fail toward review, never silently pass).
 */
export interface JurisdictionLicenseRule extends RuleBase {
  kind: "jurisdiction-license";
  /** Explanation template; "{jurisdiction}" is interpolated. */
  explanation: string;
}

export type ComplianceRule =
  | PatternRule
  | RequiredElementRule
  | PlatformGateRule
  | JurisdictionLicenseRule;

export interface VerticalRuleset {
  vertical: Vertical;
  version: string;
  /** Human note on the scope/limits of the deterministic layer for this vertical. */
  notes?: string;
  rules: ComplianceRule[];
}
