/**
 * E-commerce compliance ruleset (SKILL.md; doc 02 §2.5).
 *
 * Pricing/claims accuracy; substantiation for superiority claims; FTC
 * endorsement/review rules (disclosures on endorsements, no incentivized
 * sentiment-conditioned reviews); no deceptive comparisons; plus the
 * cross-cutting disease-claim lexicon for supplement/food/wellness products.
 *
 * False-positive design (this vertical's content templates are literally
 * "best [category] buying guides", so naive "the best" matching would block
 * the product's own templates):
 * - Superiority claims block only when SELF-referential ("our/we ... the
 *   best", "the best on the market", "#1") — editorial "best X for Y"
 *   buying-guide language does not fire.
 * - A nearby substantiation marker ("rated #1 by <source>", "according to")
 *   suppresses the match instead of blocking cited claims.
 * - "number one priority/goal/focus" is an exception span, not a claim.
 */

import type { VerticalRuleset } from "../types";
import { makeDiseaseClaimRule } from "./shared-health-claims";

export const ecommerceRuleset: VerticalRuleset = {
  vertical: "ecommerce",
  version: "1.0.0",
  notes:
    "Deceptive-pricing and urgency rules warn rather than block: 'only 3 left' may be true, and the engine cannot verify inventory or former prices — it forces verification instead.",
  rules: [
    {
      kind: "pattern",
      id: "ecommerce.superiority-claims",
      vertical: "ecommerce",
      severity: "block",
      description: "Superiority claims (\"the best\", \"#1\") require substantiation markers.",
      legalReference:
        "FTC Act §5, 15 U.S.C. §45; FTC Advertising Substantiation Policy Statement (objective superiority claims need prior substantiation)",
      requiredFix:
        "Cite the source next to the claim (\"Rated #1 by <source>, <year>\") or reframe as a subjective/feature statement.",
      patterns: [
        { regex: "(?<![\\w#])#\\s?1\\b" },
        { phrase: "number one" },
        { regex: "\\b(?:our|we(?:'re|\\s+are)?)\\b[^.!?\\n]{0,50}?\\bthe\\s+best\\b" },
        { regex: "\\bthe\\s+best\\b[^.!?\\n]{0,40}?\\b(?:on\\s+the\\s+market|in\\s+the\\s+world|available|anywhere|money\\s+can\\s+buy)\\b" },
        { regex: "\\bworld'?s\\s+(?:best|finest|leading)\\b" },
        { regex: "\\bamerica'?s\\s+(?:best|favorite)\\b" },
        { phrase: "clinically proven" },
        { regex: "\\b(?:doctor|dermatologist|dentist)[- ]recommended\\b" },
      ],
      exceptions: [
        { regex: "\\b(?:number\\s+one|#\\s?1)\\s+(?:priority|goal|focus|concern|question|rule|fan)\\b" },
      ],
      substantiationSignals: [
        { phrase: "according to" },
        { regex: "\\brated\\b[^.!?\\n]{0,30}\\bby\\b" },
        { regex: "\\branked\\b[^.!?\\n]{0,30}\\bby\\b" },
        { phrase: "voted" },
        { regex: "\\bawarded\\b" },
        { phrase: "based on" },
        { phrase: "source:" },
        { regex: "\\b(?:survey|study|reviews?)\\s+(?:of|by|from)\\b" },
      ],
      substantiationWindow: 120,
      explanation:
        'Matched "{excerpt}" — an objective superiority claim with no substantiation marker nearby. FTC requires prior substantiation for #1/best-type claims.',
    },
    {
      kind: "required-element",
      id: "ecommerce.endorsement-disclosure",
      vertical: "ecommerce",
      severity: "block",
      appliesTo: ["page", "blog", "faq", "social_caption", "review_response", "ad", "lead_form"],
      description:
        "FTC endorsement disclosure required on testimonial/affiliate/sponsored content.",
      legalReference:
        "FTC Endorsement Guides, 16 CFR Part 255 (§255.5 material connections); FTC Rule on Consumer Reviews and Testimonials, 16 CFR Part 465",
      requiredFix:
        "Add a clear and conspicuous disclosure of the material connection (#ad, \"Sponsored\", \"We may earn a commission from links on this page\") placed where consumers will see it before engaging.",
      onlyWhen: { structuredFlags: ["containsTestimonial", "hasAffiliateRelationship"] },
      requirement: {
        textSignals: [
          { regex: "(?<![\\w#])#(?:ad|sponsored|gifted|affiliate)\\b" },
          { phrase: "paid partnership" },
          { phrase: "sponsored" },
          { phrase: "advertisement" },
          { regex: "\\bwe\\s+may\\s+earn\\b" },
          { phrase: "affiliate commission" },
          { phrase: "affiliate links" },
          { phrase: "compensated" },
          { phrase: "in partnership with" },
          { phrase: "materially connected" },
        ],
      },
      explanation:
        "This content is marked as containing testimonials or an affiliate/sponsored relationship, but no FTC-required disclosure language was found.",
    },
    {
      kind: "pattern",
      id: "ecommerce.review-incentives",
      vertical: "ecommerce",
      severity: "block",
      description:
        "No incentives conditioned on positive review sentiment (fake/incentivized-undisclosed reviews).",
      legalReference:
        "FTC Rule on Consumer Reviews and Testimonials, 16 CFR §465.4 (buying positive reviews); FTC Endorsement Guides, 16 CFR Part 255",
      requiredFix:
        "Remove the sentiment condition. Incentives may only be offered for honest reviews regardless of rating, with the incentive disclosed.",
      patterns: [
        { regex: "\\b(?:5|five)[- ]star\\b[^.!?\\n]{0,80}?\\b(?:discount|coupon|free|gift|refund|reward|credit)\\b" },
        { regex: "\\b(?:discount|coupon|free|gift|refund|reward|credit)\\b[^.!?\\n]{0,80}?\\b(?:5|five)[- ]star\\b" },
        { regex: "\\bpositive\\s+review\\b[^.!?\\n]{0,60}?\\b(?:discount|coupon|free|gift|refund|reward|credit)\\b" },
        { regex: "\\b(?:discount|coupon|free|gift|refund|reward|credit)\\b[^.!?\\n]{0,60}?\\bpositive\\s+review\\b" },
      ],
      explanation:
        'Matched "{excerpt}" — offering compensation conditioned on positive review sentiment is prohibited outright (not merely a disclosure issue).',
    },
    makeDiseaseClaimRule({
      id: "ecommerce.health-claims",
      vertical: "ecommerce",
      description:
        "Cross-cutting disease-claim lexicon — no disease claims for supplement/food/wellness products.",
      legalReference:
        "FD&C Act, 21 U.S.C. §§321(g)(1), 343(r)(6) (structure/function vs disease claims); FTC Act §5, 15 U.S.C. §45",
      requiredFix:
        "Remove the disease claim; permissible structure/function claims require substantiation and the FDA disclaimer for supplements.",
    }),
    {
      kind: "pattern",
      id: "ecommerce.false-urgency",
      vertical: "ecommerce",
      severity: "warn",
      description:
        "Urgency/scarcity claims must be true — flagged for verification (fake urgency is a deceptive dark pattern).",
      legalReference:
        "FTC Act §5, 15 U.S.C. §45; FTC staff report \"Bringing Dark Patterns to Light\" (2022) — false scarcity/urgency",
      requiredFix:
        "Verify the claim is literally true (real inventory count, real deadline that is enforced). Remove or correct if synthetic.",
      patterns: [
        { regex: "\\bonly\\s+\\d+\\s+left\\b" },
        { regex: "\\bends\\s+(?:tonight|today|at\\s+midnight)\\b" },
        { phrase: "last chance" },
        { regex: "\\bprices?\\s+(?:go(?:es)?\\s+up|doubles?|increases?)\\s+(?:tomorrow|tonight|soon)\\b" },
        { regex: "\\bact\\s+now\\s+before\\b" },
      ],
      explanation:
        'Matched "{excerpt}" — an urgency/scarcity claim. It is only lawful if literally true and enforced; verify before publish.',
    },
    {
      kind: "pattern",
      id: "ecommerce.deceptive-pricing",
      vertical: "ecommerce",
      severity: "warn",
      description:
        "Pricing accuracy — former-price/value comparisons and \"free\" offers are flagged for verification.",
      legalReference:
        "FTC Guides Against Deceptive Pricing, 16 CFR Part 233; FTC Guide Concerning Use of the Word \"Free\", 16 CFR Part 251",
      requiredFix:
        "Verify the former price was the actual, recent, bona fide selling price (or the value comparison is honest), and that \"free\" offers do not bury costs in shipping/handling.",
      patterns: [
        { regex: "\\bcompared?\\s+at:?\\s+\\$?\\d" },
        { regex: "\\b(?:a|an)\\s+\\$\\d[\\d,]*\\s+value\\b" },
        { regex: "\\bwas\\s+\\$\\d[\\d,.]*[^.!?\\n]{0,15}?\\bnow\\s+\\$\\d" },
        { regex: "\\bfree\\b[^.!?\\n]{0,30}?\\bjust\\s+pay\\s+(?:shipping|handling)\\b" },
      ],
      explanation:
        'Matched "{excerpt}" — a price-comparison or free-offer pattern that is deceptive unless the reference price/terms are genuine; verify before publish.',
    },
    {
      kind: "pattern",
      id: "ecommerce.comparison-claims",
      vertical: "ecommerce",
      severity: "warn",
      description: "No deceptive comparisons — quantified/absolute competitor comparisons need substantiation.",
      legalReference:
        "FTC Statement of Policy Regarding Comparative Advertising, 16 CFR §14.15; FTC Act §5, 15 U.S.C. §45; Lanham Act §43(a), 15 U.S.C. §1125(a)",
      requiredFix:
        "Substantiate the comparison with testing/data (kept on file) and cite it, or soften to a non-comparative feature claim.",
      patterns: [
        { regex: "\\b\\d+x\\s+(?:better|faster|stronger|longer|more\\s+effective)\\b" },
        { regex: "\\bbetter\\s+than\\s+(?:any|all|every)\\b" },
        { regex: "\\bunlike\\s+(?:any|all)\\s+other\\b" },
      ],
      substantiationSignals: [
        { phrase: "according to" },
        { phrase: "based on" },
        { regex: "\\b(?:tested|study|survey)\\b" },
        { phrase: "source:" },
      ],
      substantiationWindow: 120,
      explanation:
        'Matched "{excerpt}" — a quantified competitive claim with no substantiation marker nearby; unsupported comparisons are deceptive.',
    },
  ],
};
