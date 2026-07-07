/**
 * Health & life insurance compliance ruleset (SKILL.md — strict; doc 02 §2.4;
 * doc 01 §4 compliance-review checks).
 *
 * TCPA consent language on ALL lead forms; no misleading guarantees
 * ("guaranteed approval" limits); state licensing accuracy; Special Ad
 * Category rules for ads; no fear-based manipulation; accurate product
 * representation.
 *
 * False-positive design:
 * - "guaranteed issue" / "guaranteed universal life" are real product names
 *   and are NOT in the guarantee patterns; only outcome-promises
 *   ("guaranteed approval", "no one is denied", "no risk") block. A
 *   "no-risk quote/consultation" exception avoids flagging free-quote offers.
 * - Fear-based patterns WARN (flag for human review) — emotional framing is
 *   contextual; the review agent decides, but nothing slips through unseen.
 */

import type { VerticalRuleset } from "../types";

/** Consent-language signals shared by the two TCPA rules. */
const TCPA_CONSENT_SIGNALS = [
  { phrase: "consent to be contacted" },
  { regex: "\\bconsent\\s+to\\s+receive\\b" },
  { regex: "\\bagree\\s+to\\s+(?:be\\s+contacted|receive)\\b" },
  { regex: "\\bauthoriz(?:e|es|ing)\\b[^.!?\\n]{0,60}\\b(?:calls?|texts?|contact|emails?)\\b" },
  { regex: "\\bautomat(?:ic|ed)\\s+(?:telephone\\s+)?dial(?:ing|er)\\b" },
  { phrase: "autodialer" },
  { regex: "\\bpre[- ]?recorded\\b" },
  { phrase: "artificial voice" },
  { phrase: "tcpa" },
  { regex: "\\b(?:msg|message)\\s*(?:&|and)\\s*data\\s+rates\\b" },
];

export const healthLifeInsuranceRuleset: VerticalRuleset = {
  vertical: "health-life-insurance",
  version: "1.0.0",
  notes:
    "The engine verifies consent LANGUAGE presence, not legal sufficiency of the whole consent flow (checkbox behavior, e-sign, one-to-one consent scope) — that stays with compliance-review and counsel.",
  rules: [
    {
      kind: "required-element",
      id: "health-life-insurance.tcpa-consent",
      vertical: "health-life-insurance",
      severity: "block",
      appliesTo: ["lead_form"],
      description: "TCPA prior-express-written-consent language required on all lead forms.",
      legalReference:
        "TCPA, 47 U.S.C. §227; 47 CFR §64.1200(f)(9) (prior express written consent: clear disclosure of autodialed/prerecorded calls and texts)",
      requiredFix:
        "Add explicit consent language near the submit action: consent to receive calls/texts (including via automatic telephone dialing system or prerecorded voice), the contacting entity by name, and that consent is not a condition of purchase.",
      requirement: { textSignals: TCPA_CONSENT_SIGNALS },
      explanation:
        "Lead form has no TCPA consent language — no consent-to-contact, autodialer, or prerecorded-call disclosure was found in the form copy or field labels.",
    },
    {
      kind: "required-element",
      id: "health-life-insurance.tcpa-condition-clause",
      vertical: "health-life-insurance",
      severity: "warn",
      appliesTo: ["lead_form"],
      description:
        "Consent language present but missing the \"not a condition of purchase\" clause required for prior express written consent.",
      legalReference: "47 CFR §64.1200(f)(9)(i)(B) (consent not required as a condition of purchase)",
      requiredFix:
        "Add \"Consent is not a condition of purchase\" (or equivalent) alongside the existing consent language.",
      onlyWhen: { textSignals: TCPA_CONSENT_SIGNALS },
      requirement: {
        textSignals: [
          { regex: "\\bnot\\s+(?:a\\s+)?condition\\s+of\\s+(?:any\\s+)?purchase\\b" },
          { phrase: "consent is not required" },
          { regex: "\\bnot\\s+required\\s+(?:as\\s+a\\s+condition|to\\s+(?:purchase|buy))\\b" },
        ],
      },
      explanation:
        "The form has consent-to-contact language but no \"consent is not a condition of purchase\" clause — required for valid prior express written consent.",
    },
    {
      kind: "pattern",
      id: "health-life-insurance.guarantee-claims",
      vertical: "health-life-insurance",
      severity: "block",
      description:
        "No misleading guarantees — \"guaranteed approval\"/\"no risk\" style promises misrepresent underwriting.",
      legalReference:
        "NAIC Unfair Trade Practices Act (Model #880) §4(A) (misrepresentation); NAIC Model #570 (Advertisements of Life Insurance); state UDAP statutes (e.g., Cal. Ins. Code §790.03(b))",
      requiredFix:
        "Remove the blanket promise. Describe actual underwriting (e.g., \"guaranteed issue\" products may be named as products, with eligibility limits and graded-benefit terms disclosed).",
      patterns: [
        { phrase: "guaranteed approval" },
        { phrase: "approval guaranteed" },
        { regex: "\\beveryone\\s+(?:is\\s+approved|qualifies)\\b" },
        { regex: "\\bno\\s+one\\s+is\\s+(?:denied|turned\\s+down|rejected)\\b" },
        { regex: "\\bcan(?:not|'t)\\s+be\\s+(?:denied|turned\\s+down|rejected)\\b" },
        { phrase: "no risk" },
        { phrase: "risk free" },
        { phrase: "zero risk" },
        { regex: "\\b100%\\s+approval\\b" },
      ],
      exceptions: [{ regex: "\\bno[- ]risk\\s+(?:quote|consultation)\\b" }],
      explanation:
        'Matched "{excerpt}" — a blanket approval/no-risk promise. Insurance approval depends on underwriting; promising it is a misrepresentation.',
    },
    {
      kind: "pattern",
      id: "health-life-insurance.fear-based-marketing",
      vertical: "health-life-insurance",
      severity: "warn",
      description: "No fear-based manipulation — scare framing is flagged for human review.",
      legalReference:
        "NAIC Model #570 §5 (advertisement form and content must not be deceptive or exploit fear); NAIC Model #880; state UDAP statutes",
      requiredFix:
        "Reframe from fear to protection/benefit language (what the coverage provides), and route to compliance-review for the final call.",
      patterns: [
        { phrase: "before it's too late" },
        { regex: "\\bleave\\s+your\\s+(?:family|loved\\s+ones|kids|children)\\b[^.!?\\n]{0,40}?\\b(?:nothing|debt|burden(?:ed)?|struggling)\\b" },
        { regex: "\\byour\\s+(?:family|loved\\s+ones)\\s+(?:will|could|may)\\s+(?:suffer|struggle|be\\s+left\\s+with\\s+nothing|lose\\s+everything)\\b" },
        { regex: "\\bdon'?t\\s+be\\s+a\\s+burden\\b" },
        { regex: "\\bwhat\\s+(?:will|would)\\s+(?:happen\\s+to\\s+)?your\\s+(?:family|kids|children)\\b[^.!?\\n]{0,40}?\\b(?:when|if)\\s+you\\s+(?:die|'?re\\s+gone|pass)\\b" },
        { regex: "\\bfuneral\\s+costs?\\b[^.!?\\n]{0,40}?\\b(?:bankrupt|devastat|crush)" },
      ],
      explanation:
        'Matched "{excerpt}" — fear-based framing. Insurance advertising standards prohibit exploiting fear to drive purchase; human review required.',
    },
    {
      kind: "jurisdiction-license",
      id: "health-life-insurance.state-licensing",
      vertical: "health-life-insurance",
      severity: "block",
      description:
        "State licensing accuracy — content may only target states where the agent/agency is licensed.",
      legalReference:
        "State producer licensing acts (NAIC Producer Licensing Model Act #218 §3: no selling, soliciting, or negotiating insurance without a license in that state)",
      requiredFix:
        "Limit the content's target states to licensed states, or provide content.licensedStates so licensing can be verified against the jurisdiction.",
      explanation:
        'Content targets jurisdiction "{jurisdiction}" — soliciting insurance in a state without a producer license is unlawful.',
    },
    {
      kind: "platform-gate",
      id: "health-life-insurance.special-ad-category",
      vertical: "health-life-insurance",
      severity: "block",
      appliesTo: ["ad"],
      description:
        "Special Ad Category gate — Meta insurance ads must run under the Financial Products & Services special ad category (restricted targeting).",
      legalReference:
        "Meta Advertising Standards — Special Ad Categories (Financial Products & Services, required for insurance since 2024); state UDAP discriminatory-targeting concerns",
      requiredFix:
        "Declare the campaign under the Financial Products & Services Special Ad Category (which restricts age/gender/zip targeting) and set content.declaredSpecialAdCategory = true.",
      prohibitedPlatforms: ["meta", "facebook", "instagram", "threads", "whatsapp", "messenger", "audience network"],
      bypassFlag: "declaredSpecialAdCategory",
      explanation:
        'Ad output targets "{platform}" without a declared Special Ad Category — Meta requires insurance ads to run under Financial Products & Services with restricted targeting.',
    },
    {
      kind: "pattern",
      id: "health-life-insurance.superlative-cost-claims",
      vertical: "health-life-insurance",
      severity: "warn",
      description:
        "Accurate product representation — absolute rate/price superlatives need substantiation.",
      legalReference:
        "NAIC Model #570 (misleading cost comparisons); FTC Act §5, 15 U.S.C. §45; FTC Advertising Substantiation Policy Statement",
      requiredFix:
        "Qualify or substantiate the rate claim (rates vary by carrier, age, health class) or remove the superlative.",
      patterns: [
        { regex: "\\b(?:lowest|cheapest|best)\\s+(?:rates?|prices?|premiums?)\\b" },
        { phrase: "lowest price guaranteed" },
      ],
      explanation:
        'Matched "{excerpt}" — an absolute cost superlative. Rates vary by underwriting; unqualified superlatives misrepresent the product.',
    },
  ],
};
