/**
 * Cross-cutting health-claims lexicon (SKILL.md "health claims — supplements/
 * food"): no disease claims; FTC substantiation for any health-adjacent claim.
 *
 * Shared by cannabis, restaurants, and ecommerce via factories that stamp the
 * consuming vertical onto the rule — every emitted rule carries an accurate
 * `vertical` field and a per-vertical id.
 *
 * False-positive design:
 * - Disease-claim matching pairs a claim VERB with a named CONDITION within
 *   the same sentence (max 80 chars apart). "Sweet treats for the family" or
 *   "treat yourself to dessert" never fire — there is no condition term.
 * - The verb→condition connector is LAZY ({0,80}?) so each claim yields its
 *   own minimal span: "treats anxiety and cures insomnia" is two findings
 *   ("treats anxiety", "cures insomnia"), not one sentence-wide match.
 * - Word boundaries prevent "treatsury"/"retreats" hits.
 * - Explicit-negation/disclaimer spans ("does not treat", "not intended to
 *   diagnose, treat, cure") suppress overlapping matches.
 */

import type { Vertical } from "@/lib/types/playbook";
import type { PatternMatcher, PatternRule } from "../types";

/** Named diseases/medical conditions (claiming to affect these = drug claim). */
const CONDITIONS =
  "cancer|tumou?rs?|anxiety|depression|insomnia|ptsd|epilepsy|seizures?|" +
  "arthritis|diabetes|alzheimer'?s|dementia|glaucoma|chronic pain|" +
  "inflammation|high blood pressure|hypertension|heart disease|" +
  "covid(?:-19)?|obesity|adhd|autism|migraines?|asthma|eczema|psoriasis|addiction";

/** Claim verbs that turn a product statement into a disease/drug claim. */
const CLAIM_VERBS =
  "cures?|cured|curing|treats?|treated|treating|heals?|healed|healing|" +
  "prevents?|prevented|preventing|reverses?|reversed|reversing|" +
  "eliminates?|eliminated|eliminating|fights?|fighting|kills?";

/** Verb + named condition in the same sentence, plus relief/remedy framings. */
export function diseaseClaimPatterns(): PatternMatcher[] {
  return [
    {
      regex: `\\b(?:${CLAIM_VERBS})\\b[^.!?\\n]{0,80}?\\b(?:${CONDITIONS})\\b`,
      note: "claim verb within one sentence of a named condition (lazy connector → minimal span per claim)",
    },
    { regex: `\\b(?:${CONDITIONS}|pain)\\s+relief\\b`, note: "condition + relief" },
    { regex: `\\brelieves?\\b[^.!?\\n]{0,40}?\\b(?:${CONDITIONS}|pain)\\b` },
    { regex: `\\bhelps?\\s+(?:with\\s+|treat\\s+|cure\\s+|manage\\s+)?(?:your\\s+)?(?:${CONDITIONS})\\b` },
    { regex: `\\b(?:remedy|medicine|medication|treatment)\\s+for\\s+(?:${CONDITIONS}|pain)\\b` },
  ];
}

/** Negations/disclaimers whose spans suppress overlapping disease-claim matches. */
export function diseaseClaimExceptions(): PatternMatcher[] {
  return [
    { regex: "\\b(?:does|do|did|will|would|can)\\s+not\\s+(?:treat|cure|heal|prevent|diagnose)\\b" },
    { regex: "\\bcannot\\s+(?:treat|cure|heal|prevent|diagnose)\\b" },
    { phrase: "not intended to diagnose" },
    { regex: "\\bnot\\s+(?:intended|meant)\\s+to\\s+(?:treat|cure|prevent)\\b" },
    { regex: "\\b(?:fda|food and drug administration)\\s+has\\s+not\\s+(?:approved|evaluated)\\b" },
  ];
}

export interface DiseaseClaimRuleOptions {
  id: string;
  vertical: Vertical;
  description: string;
  legalReference: string;
  requiredFix: string;
  /** Vertical-specific additions (e.g. restaurants' alcohol-health claims). */
  extraPatterns?: PatternMatcher[];
}

/** Block-severity disease-claim rule stamped for the consuming vertical. */
export function makeDiseaseClaimRule(opts: DiseaseClaimRuleOptions): PatternRule {
  return {
    kind: "pattern",
    id: opts.id,
    vertical: opts.vertical,
    severity: "block",
    description: opts.description,
    legalReference: opts.legalReference,
    requiredFix: opts.requiredFix,
    patterns: [...diseaseClaimPatterns(), ...(opts.extraPatterns ?? [])],
    exceptions: diseaseClaimExceptions(),
    explanation:
      'Matched "{excerpt}" — this reads as a disease/medical claim. Claiming a product treats, cures, prevents, or relieves a medical condition makes it an unapproved drug claim.',
  };
}

/** Health-adjacent structure/function claims that need FTC substantiation (warn). */
export function substantiationClaimPatterns(): PatternMatcher[] {
  return [
    { regex: "\\bboosts?\\s+(?:your\\s+)?immun(?:e\\s+system|ity)\\b" },
    { regex: "\\bdetox(?:es|ify|ifies|ifying|ing)?\\b" },
    { phrase: "superfood" },
    { regex: "\\banti[- ]inflammatory\\b" },
    { regex: "\\bburns?\\s+fat\\b" },
    { phrase: "stress relief" },
    { regex: "\\bimproves?\\s+(?:sleep|digestion|focus|mood|memory)\\b" },
    { phrase: "healing properties" },
    { regex: "\\btherapeutic\\s+(?:benefits?|effects?|properties)\\b" },
    { regex: "\\bmedicinal\\s+(?:benefits?|properties|value)\\b" },
    { phrase: "wellness benefits" },
  ];
}

export interface SubstantiationRuleOptions {
  id: string;
  vertical: Vertical;
  description: string;
  legalReference: string;
  requiredFix: string;
}

/** Warn-severity substantiation rule stamped for the consuming vertical. */
export function makeSubstantiationRule(opts: SubstantiationRuleOptions): PatternRule {
  return {
    kind: "pattern",
    id: opts.id,
    vertical: opts.vertical,
    severity: "warn",
    description: opts.description,
    legalReference: opts.legalReference,
    requiredFix: opts.requiredFix,
    patterns: substantiationClaimPatterns(),
    explanation:
      'Matched "{excerpt}" — a health-adjacent structure/function claim. FTC requires competent and reliable scientific evidence before making it.',
  };
}
