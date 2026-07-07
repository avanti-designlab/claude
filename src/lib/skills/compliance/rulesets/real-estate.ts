/**
 * Real-estate compliance ruleset (SKILL.md; doc 02 §2.2).
 *
 * Fair Housing language compliance (no steering, no discriminatory preference
 * language across the HUD-recognized classes: race, color, religion, sex,
 * disability, familial status, national origin), no misleading investment
 * guarantees, and dateModified discipline on regulatory content.
 *
 * False-positive design:
 * - "exclusive" only fires with neighborhood/community nouns — "exclusive
 *   listing" / "exclusive right to sell" are ordinary brokerage terms and
 *   never match.
 * - HOPA senior housing (42 U.S.C. §3607(b)) is lawful: "adults only" style
 *   matches are suppressed when 55+/62+/senior-community signals appear
 *   nearby (exceptionWindow).
 * - Ambiguous coded language ("family-friendly", "safe neighborhood") warns
 *   for human review instead of blocking — context decides those.
 */

import type { VerticalRuleset } from "../types";

export const realEstateRuleset: VerticalRuleset = {
  vertical: "real-estate",
  version: "1.0.0",
  notes:
    "Deterministic Fair-Housing screen over marketing language. It cannot verify factual accuracy of visa/tax statements — the freshness rule enforces the last-verified discipline; accuracy itself is on compliance-review.",
  rules: [
    {
      kind: "pattern",
      id: "real-estate.fair-housing-exclusion",
      vertical: "real-estate",
      severity: "block",
      description:
        "No exclusionary language toward protected classes (familial status, disability, sex, national origin, race, color, religion).",
      legalReference:
        "Fair Housing Act, 42 U.S.C. §3604(c); 24 CFR §100.75(c)(3); state source-of-income laws (e.g., Cal. Gov. Code §12955) for Section 8 refusals",
      requiredFix:
        "Remove the exclusion. Describe the property, not who may live there. Lawful senior housing must cite its HOPA qualification (55+/62+) explicitly.",
      patterns: [
        { regex: "\\bno\\s+(?:kids|children|minors)\\b" },
        { regex: "\\b(?:adults?|couples?|singles?|males?|females?|men|women)\\s+only\\b" },
        { phrase: "no section 8" },
        { regex: "\\bno\\s+(?:wheelchairs?|disabled|handicapped)\\b" },
        { regex: "\\bnot\\s+suitable\\s+for\\s+(?:families|children|kids|the\\s+disabled|wheelchairs?)\\b" },
        { regex: "\\bno\\s+(?:foreigners|immigrants)\\b" },
      ],
      exceptions: [
        { regex: "\\b(?:55|62)\\s*\\+" },
        { phrase: "senior living" },
        { phrase: "senior community" },
        { phrase: "age restricted community" },
        { phrase: "housing for older persons" },
        { phrase: "active adult community" },
      ],
      exceptionWindow: 300,
      explanation:
        'Matched "{excerpt}" — excluding a protected class in housing advertising violates the Fair Housing Act (unless the property qualifies as HOPA senior housing and says so).',
    },
    {
      kind: "pattern",
      id: "real-estate.fair-housing-preference",
      vertical: "real-estate",
      severity: "block",
      description:
        "No preference/steering language describing the ideal occupant by protected class (\"perfect for families\", \"exclusive neighborhood\", religious or racial neighborhood labels).",
      legalReference:
        "Fair Housing Act, 42 U.S.C. §3604(c); 24 CFR §100.75; HUD advertising guidance (former 24 CFR Part 109)",
      requiredFix:
        "Describe property features (bedrooms, yard, layout, location facts) instead of who it is \"for\". Replace occupant-preference and exclusivity-of-people language.",
      patterns: [
        {
          regex:
            "\\b(?:perfect|ideal|great|suitable|wonderful|best)\\s+for\\s+(?:a\\s+|your\\s+)?(?:young\\s+|growing\\s+|new\\s+)?famil(?:y|ies)\\b",
        },
        { regex: "\\b(?:christian|jewish|muslim|catholic|hindu|buddhist)\\s+(?:community|neighborhood|families|tenants|buyers|residents)\\b" },
        { regex: "\\bexclusive\\s+(?:neighborhood|community|enclave|area)\\b" },
        { regex: "\\b(?:white|black|asian|hispanic|latino)\\s+(?:neighborhood|community|area)\\b" },
        { regex: "\\b(?:perfect|ideal|great)\\s+for\\s+(?:a\\s+)?(?:single\\s+(?:man|woman|men|women)|bachelors?|bachelorettes?)\\b" },
      ],
      explanation:
        'Matched "{excerpt}" — HUD treats describing the preferred buyer/tenant by protected class (or coding it via people-exclusivity) as discriminatory advertising.',
    },
    {
      kind: "pattern",
      id: "real-estate.fair-housing-language-review",
      vertical: "real-estate",
      severity: "warn",
      description:
        "Coded/ambiguous language HUD guidance flags for context review (not a per-se violation).",
      legalReference:
        "HUD advertising guidance (former 24 CFR Part 109 Appendix I word list); Fair Housing Act, 42 U.S.C. §3604(c)",
      requiredFix:
        "Have compliance-review confirm context; prefer objective property/location facts over audience descriptors.",
      patterns: [
        { regex: "\\bfamily[- ]friendly\\b" },
        { phrase: "safe neighborhood" },
        { regex: "\\bup[- ]and[- ]coming\\s+(?:neighborhood|area)\\b" },
        { regex: "\\bempty[- ]nesters?\\b" },
        { regex: "\\b(?:perfect|ideal|great)\\s+for\\s+young\\s+(?:professionals|couples)\\b" },
        { phrase: "integrated neighborhood" },
      ],
      explanation:
        'Matched "{excerpt}" — coded audience language; HUD guidance treats it as a steering signal depending on context.',
    },
    {
      kind: "pattern",
      id: "real-estate.investment-guarantees",
      vertical: "real-estate",
      severity: "block",
      description: "No misleading investment guarantees.",
      legalReference:
        "FTC Act §5, 15 U.S.C. §45; Securities Act §17(a) / SEC Rule 10b-5 where an investment offering is involved; state real-estate license advertising rules",
      requiredFix:
        "Remove the guarantee or replace with historical, sourced data plus risk disclosure. Contractually guaranteed yields may only be described with the contract terms and counterparty disclosed.",
      patterns: [
        { regex: "\\bguaranteed\\s+(?:returns?|rental\\s+(?:income|yields?)|income|yields?|roi|appreciation|profits?|investment)\\b" },
        { regex: "\\bcan(?:not|'t)\\s+lose\\b" },
        { regex: "\\brisk[- ]free\\b" },
        { phrase: "no risk investment" },
        { phrase: "double your money" },
        { regex: "\\bwill\\s+(?:definitely|certainly|surely)\\s+(?:appreciate|increase|go\\s+up|double)\\b" },
        { phrase: "sure thing" },
      ],
      explanation:
        'Matched "{excerpt}" — guaranteed-outcome language about property investment is misleading; future returns cannot be promised.',
    },
    {
      kind: "required-element",
      id: "real-estate.regulatory-freshness",
      vertical: "real-estate",
      severity: "block",
      appliesTo: ["page", "blog", "faq"],
      description:
        "Regulatory content (visa/golden-visa/residency/tax) must carry a real last-verified date (dateModified discipline).",
      legalReference:
        "FTC Act §5, 15 U.S.C. §45 (stale regulatory claims are material misrepresentations); doc 02 §2.2 dateModified discipline",
      requiredFix:
        "Set content.lastVerified (feeds dateModified) or add explicit \"Last updated/verified <date>\" language, after actually re-verifying the regulatory facts.",
      onlyWhen: {
        textSignals: [
          { phrase: "golden visa" },
          { regex: "\\bvisas?\\b" },
          { regex: "\\bresidenc(?:y|e)\\b" },
          { phrase: "citizenship" },
          { regex: "\\btax(?:es|ation)?\\b" },
          { phrase: "capital gains" },
          { phrase: "stamp duty" },
          { regex: "\\bregulations?\\b" },
          { phrase: "legal requirements" },
          { phrase: "rera" },
        ],
      },
      requirement: {
        structuredFlag: "lastVerified",
        textSignals: [
          { phrase: "last updated" },
          { phrase: "last verified" },
          { phrase: "updated on" },
          { phrase: "verified on" },
          { phrase: "date modified" },
          {
            regex:
              "\\bas\\s+of\\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|\\d{4})\\b",
          },
        ],
      },
      explanation:
        "This content makes regulatory statements (visa/residency/tax) but carries no last-verified date — doc 02 requires dateModified discipline on regulatory content.",
    },
  ],
};
