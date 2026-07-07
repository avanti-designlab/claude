/**
 * Restaurants compliance ruleset (SKILL.md; doc 02 §2.3).
 *
 * Health claims on food limited; allergen accuracy required (allergen claims
 * are flagged for kitchen verification); alcohol rules where applicable;
 * accurate hours/pricing — stale operational facts are compliance failures,
 * not just quality issues.
 *
 * False-positive design:
 * - Disease claims require verb+condition proximity, so "sweet treats" and
 *   "treat yourself" never fire.
 * - Allergen claims WARN (verify with kitchen) rather than block — the claim
 *   may be true; the engine cannot know, so it fails toward review.
 * - Unlimited-alcohol promos WARN with a jurisdiction note (happy-hour law
 *   varies by state); minor-targeted alcohol marketing BLOCKS.
 */

import type { VerticalRuleset } from "../types";
import { makeDiseaseClaimRule, makeSubstantiationRule } from "./shared-health-claims";

export const restaurantsRuleset: VerticalRuleset = {
  vertical: "restaurants",
  version: "1.0.0",
  notes:
    "The engine cannot verify that hours/prices/allergen practices are factually current — those rules fire as verification requirements (warn) and rely on the lastVerified stamp plus human confirmation.",
  rules: [
    makeDiseaseClaimRule({
      id: "restaurants.health-claims",
      vertical: "restaurants",
      description: "Health claims on food are limited — no disease/medical claims about menu items.",
      legalReference:
        "FD&C Act, 21 U.S.C. §343(r) (nutrient content and health claims); 21 CFR §101.14; FTC Act §5, 15 U.S.C. §45",
      requiredFix:
        "Remove the medical claim. Describe ingredients and taste; nutrient-content claims must meet FDA definitions.",
      extraPatterns: [
        { regex: "\\b(?:wine|beer|alcohol|cocktails?)\\b[^.!?\\n]{0,40}?\\bgood\\s+for\\s+(?:your\\s+)?(?:heart|health|liver)\\b" },
      ],
    }),
    makeSubstantiationRule({
      id: "restaurants.health-substantiation",
      vertical: "restaurants",
      description: "Health-adjacent food claims need substantiation before publishing.",
      legalReference:
        "FTC Act §5, 15 U.S.C. §45; FTC Advertising Substantiation Policy Statement; FD&C Act, 21 U.S.C. §343(r)",
      requiredFix:
        "Substantiate the claim or soften to descriptive language (ingredients, preparation, taste).",
    }),
    {
      kind: "pattern",
      id: "restaurants.allergen-verification",
      vertical: "restaurants",
      severity: "warn",
      description:
        "Allergen accuracy required — allergen-free claims must be verified with the kitchen before publish.",
      legalReference:
        "FALCPA, 21 U.S.C. §343(w); 21 CFR §101.91 (gluten-free is a regulated claim); state food codes on allergen disclosure",
      requiredFix:
        "Verify the claim against current kitchen practice (shared fryers/prep surfaces). Add cross-contact qualifiers where preparation is shared, and keep the menu source-of-truth in sync.",
      patterns: [
        { regex: "\\b(?:gluten|nut|peanut|dairy|soy|shellfish|egg|lactose|allergen)[- ]free\\b" },
        { phrase: "celiac safe" },
        { regex: "\\bno\\s+cross[- ]contamination\\b" },
        { phrase: "allergy friendly" },
      ],
      explanation:
        'Matched "{excerpt}" — an allergen claim. It may be true, but it must be verified with the kitchen before publish; an inaccurate allergen claim is a safety and legal failure.',
    },
    {
      kind: "pattern",
      id: "restaurants.alcohol-minors",
      vertical: "restaurants",
      severity: "block",
      description: "No alcohol marketing aimed at minors or students, and no ID-free service claims.",
      legalReference:
        "State alcoholic beverage control statutes (marketing to persons under 21; mandatory age verification); FTC Act §5, 15 U.S.C. §45",
      requiredFix:
        "Remove student/minor-targeted alcohol framing and any suggestion that age verification is skipped.",
      patterns: [
        { regex: "\\b(?:students?|college|teens?)\\b[^.!?\\n]{0,40}?\\b(?:drink\\s+specials?|shots?|beer|cocktails?|happy\\s+hour|booze)\\b" },
        { phrase: "no id required" },
        { regex: "\\bminors?\\b[^.!?\\n]{0,30}?\\b(?:drink|drinks|alcohol|bar)\\b" },
      ],
      explanation:
        'Matched "{excerpt}" — alcohol promotion directed at (or accessible to) under-21 audiences is prohibited in every US jurisdiction.',
    },
    {
      kind: "pattern",
      id: "restaurants.alcohol-promotion-review",
      vertical: "restaurants",
      severity: "warn",
      description:
        "Unlimited/free alcohol promotions are illegal in several states — jurisdiction check required before publish.",
      legalReference:
        "State happy-hour/drink-special statutes (e.g., Mass. 204 CMR 4.03; Va. 3VAC5-50-160; N.C. Gen. Stat. §18B-1005(a)(4))",
      requiredFix:
        "Confirm the promotion is lawful in the venue's state (and platform policy for boosted posts); otherwise reword to per-drink pricing.",
      patterns: [
        { regex: "\\b(?:bottomless|unlimited)\\s+(?:drinks?|mimosas?|beer|wine|cocktails?|sangria|champagne|bubbly)\\b" },
        { phrase: "all you can drink" },
        { regex: "\\bfree\\s+(?:drinks?|shots?|beer|wine|cocktails?|alcohol)\\b" },
        { phrase: "open bar" },
      ],
      explanation:
        'Matched "{excerpt}" — unlimited/free-alcohol promotions are prohibited or restricted in several states; verify the venue\'s jurisdiction before publishing.',
    },
    {
      kind: "required-element",
      id: "restaurants.operational-freshness",
      vertical: "restaurants",
      severity: "warn",
      appliesTo: ["page", "blog", "faq"],
      description:
        "Accurate hours/pricing — content stating hours or prices must carry a last-verified stamp (stale operational facts are compliance failures).",
      legalReference:
        "FTC Act §5, 15 U.S.C. §45 (pricing accuracy); doc 02 §2.3 (stale operational facts are compliance failures, not just quality issues)",
      requiredFix:
        "Verify current hours/prices against the source of truth, then set content.lastVerified or add \"Last updated <date>\" to the page.",
      onlyWhen: {
        textSignals: [
          { regex: "\\bhours\\b" },
          { regex: "\\bopen\\s+(?:daily|from|until|till|late)\\b" },
          { regex: "\\bhappy\\s+hour\\b" },
          { regex: "\\$\\d" },
          { regex: "\\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?\\b[^.!?\\n]{0,15}\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b" },
        ],
      },
      requirement: {
        structuredFlag: "lastVerified",
        textSignals: [
          { phrase: "last updated" },
          { phrase: "last verified" },
          { phrase: "updated on" },
          { phrase: "verified on" },
        ],
      },
      explanation:
        "This content states hours or prices but carries no last-verified stamp — operational facts go stale and stale facts are compliance failures for this vertical.",
    },
  ],
};
