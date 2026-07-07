/**
 * Cannabis compliance ruleset (SKILL.md — strictest vertical; doc 02 §2.1).
 *
 * Hard gates: no ads on prohibited platforms (Meta weight 0), age-gating on
 * pages, no health/disease claims, no interstate-commerce implications
 * (state-licensed operation only), no content targeting minors, claim
 * substantiation, state rules per jurisdiction.
 *
 * False-positive design:
 * - Minor-targeting patterns require marketing framing ("perfect for
 *   students"), and mandatory safety text ("keep out of reach of children")
 *   is an explicit exception — it must never trip the minor-appeal rule.
 * - "medical marijuana"/"medical cannabis" are legal product-category terms
 *   and are not matched by the health-claim patterns (which need a claim
 *   verb + condition, or relief framing).
 */

import type { VerticalRuleset } from "../types";
import { makeDiseaseClaimRule, makeSubstantiationRule } from "./shared-health-claims";

export const cannabisRuleset: VerticalRuleset = {
  vertical: "cannabis",
  version: "1.0.0",
  notes:
    "Deterministic pre-screen for the strictest vertical. State-specific advertising rules vary; the jurisdiction rule verifies licensing only — state ad-content rules still need compliance-review sign-off.",
  rules: [
    makeDiseaseClaimRule({
      id: "cannabis.health-claims",
      vertical: "cannabis",
      description:
        "No health or disease claims about cannabis products (including relief-framing like \"anxiety relief\").",
      legalReference:
        "FD&C Act, 21 U.S.C. §§321(g)(1), 331 (unapproved drug claims); FTC Act §5, 15 U.S.C. §45; state cannabis advertising rules (e.g., Cal. Code Regs. tit. 4 §15040)",
      requiredFix:
        "Remove or rewrite the claim. Describe product characteristics and reported experience without disease, medical-benefit, or relief language; educational content must use non-claim phrasing.",
    }),
    makeSubstantiationRule({
      id: "cannabis.health-substantiation",
      vertical: "cannabis",
      description:
        "Claim substantiation required — health-adjacent wellness claims about cannabis are flagged for evidence review.",
      legalReference:
        "FTC Act §5, 15 U.S.C. §45; FTC Advertising Substantiation Policy Statement; state claim-substantiation rules",
      requiredFix:
        "Provide competent and reliable evidence for the claim or remove it; route to compliance-review with the substantiation attached.",
    }),
    {
      kind: "required-element",
      id: "cannabis.age-gate",
      vertical: "cannabis",
      severity: "block",
      appliesTo: ["page"],
      description: "Age-gating required on cannabis content/experiences.",
      legalReference:
        "State cannabis advertising regulations requiring age restriction of marketing audiences (e.g., Cal. Code Regs. tit. 4 §15040(b); Colo. Code Regs. 212-3, Rule 6-105)",
      requiredFix:
        "Put the page behind an age gate (set content.hasAgeGate = true once implemented) or add explicit 21+ age-restriction signaling to the page.",
      requirement: {
        structuredFlag: "hasAgeGate",
        textSignals: [
          { regex: "\\b21\\s*\\+" },
          { phrase: "must be 21" },
          { phrase: "21 or older" },
          { phrase: "21 years or older" },
          { regex: "\\badults?\\s+21\\b" },
          { phrase: "age verification" },
          { phrase: "age gate" },
          { phrase: "of legal age" },
        ],
      },
      explanation:
        "No age-gate signal found: the page is not marked age-gated (hasAgeGate) and carries no 21+/age-verification language.",
    },
    {
      kind: "pattern",
      id: "cannabis.interstate-commerce",
      vertical: "cannabis",
      severity: "block",
      description:
        "No interstate-commerce implications — cannabis operations are state-licensed only.",
      legalReference:
        "Controlled Substances Act, 21 U.S.C. §§812, 841 (interstate transfer of cannabis is a federal offense; state-licensed intrastate operation only)",
      requiredFix:
        "Remove nationwide/out-of-state shipping or delivery language; scope all fulfillment claims to the licensed state(s).",
      patterns: [
        { regex: "\\b(?:ships?|shipping|delivers?|delivery|mails?|mailing)\\b[^.!?\\n]{0,30}?\\bnationwide\\b" },
        { regex: "\\bnationwide\\b[^.!?\\n]{0,20}?\\b(?:shipping|delivery)\\b" },
        {
          regex:
            "\\b(?:ships?|shipping|delivers?|delivery)\\b[^.!?\\n]{0,30}?\\b(?:to\\s+)?(?:all\\s+(?:50\\s+)?states|any\\s+state|anywhere\\s+in\\s+the\\s+(?:us|usa|country|united\\s+states)|out\\s+of\\s+state)\\b",
        },
        { regex: "\\bavailable\\s+in\\s+all\\s+(?:50\\s+)?states\\b" },
        { phrase: "across state lines" },
        { regex: "\\binterstate\\s+(?:delivery|shipping|commerce)\\b" },
      ],
      explanation:
        'Matched "{excerpt}" — this implies interstate cannabis commerce, which is federally prohibited regardless of state legality.',
    },
    {
      kind: "platform-gate",
      id: "cannabis.ad-platform-gate",
      vertical: "cannabis",
      severity: "block",
      appliesTo: ["ad"],
      description:
        "No cannabis ads on prohibited platforms (Meta weight 0 — the gate blocks any Meta ad output; Google/TikTok/etc. likewise prohibit cannabis ads).",
      legalReference:
        "Meta Advertising Standards (Drugs & Pharmaceuticals — prohibited); Google Ads Dangerous Products & Services policy; Controlled Substances Act, 21 U.S.C. §841; doc 02 §2.1 channel weighting (Meta ads: 0)",
      requiredFix:
        "Do not produce cannabis ad output for this platform. Reallocate to permitted channels per the playbook (GBP/local, Reddit organic, reviews, on-site education, cannabis-native networks).",
      prohibitedPlatforms: [
        "meta", "facebook", "instagram", "threads", "whatsapp", "messenger",
        "audience network", "google", "google ads", "youtube", "tiktok",
        "snapchat", "pinterest", "linkedin", "amazon",
      ],
      allowedPlatforms: ["weedmaps", "leafly", "mantis", "traffic roots", "surfside"],
      explanation:
        'Ad output targets "{platform}", a platform that prohibits cannabis advertising — this is a hard block, not a fix-and-resubmit.',
    },
    {
      kind: "pattern",
      id: "cannabis.minor-appeal",
      vertical: "cannabis",
      severity: "block",
      description: "No content targeting or appealing to minors.",
      legalReference:
        "State cannabis advertising rules prohibiting content appealing to persons under 21 (e.g., Cal. Bus. & Prof. Code §26151(c); Colo. Code Regs. 212-3, Rule 6-105)",
      requiredFix:
        "Remove youth-targeted framing entirely; cannabis marketing must be directed at adults 21+ only.",
      patterns: [
        { phrase: "kid friendly" },
        { phrase: "child friendly" },
        { regex: "\\b(?:perfect|great|fun|ideal)\\s+for\\s+(?:kids|children|teens|teenagers|students|minors)\\b" },
        { phrase: "back to school" },
        { regex: "\\b(?:appeals?|marketed|marketing)\\s+to\\s+(?:kids|children|teens|minors)\\b" },
      ],
      exceptions: [
        { phrase: "keep out of reach of children" },
        { phrase: "keep away from children" },
        { regex: "\\bnot\\s+(?:intended\\s+)?for\\s+(?:use\\s+by\\s+)?(?:children|minors|kids)\\b" },
        { phrase: "not for sale to minors" },
      ],
      explanation:
        'Matched "{excerpt}" — cannabis marketing may not target or appeal to minors under any state regime.',
    },
    {
      kind: "jurisdiction-license",
      id: "cannabis.state-licensing",
      vertical: "cannabis",
      severity: "block",
      description:
        "State-specific rules apply per jurisdiction — content may only target states where the operator is licensed.",
      legalReference:
        "State cannabis licensing acts (operation and marketing limited to the licensing state); Controlled Substances Act, 21 U.S.C. §841",
      requiredFix:
        "Restrict the content's target market to licensed states, or provide content.licensedStates so licensing can be verified.",
      explanation:
        'Content targets jurisdiction "{jurisdiction}" — cannabis marketing is limited to states where the operator holds a license.',
    },
  ],
};
