/**
 * Engine-level behavior: fail-closed unknown verticals, seed-ruleset lock,
 * empty-ruleset defense-in-depth, runtime registration, vertical/jurisdiction
 * normalization, case-insensitivity, word-boundary correctness (text and
 * platform), zero-width-evasion hardening, disclaimer, match positions.
 */

import { describe, expect, it } from "vitest";
import {
  COMPLIANCE_DISCLAIMER,
  checkCompliance,
  getRuleset,
  registerRuleset,
  registeredVerticals,
} from "./index";
import type { VerticalRuleset } from "./types";
import { expectClean, expectExcerptAt, violation } from "./test-helpers";

describe("fail-closed behavior (unknown vertical)", () => {
  it("blocks with a 'no ruleset loaded' violation instead of silently passing", () => {
    const result = checkCompliance({
      vertical: "med-spas",
      contentType: "blog",
      content: { text: "Relax with our new hydrafacial treatment menu." },
    });
    expect(result.pass).toBe(false);
    expect(result.rulesetVersion).toBeNull();
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v.ruleId).toBe("engine.no-ruleset-loaded");
    expect(v.severity).toBe("block");
    expect(v.explanation.toLowerCase()).toContain("no ruleset loaded");
    expect(v.explanation.toLowerCase()).toContain("fails closed");
    expect(v.legalReference.length).toBeGreaterThan(0);
    expect(v.requiredFix.length).toBeGreaterThan(0);
  });

  it("even blocks empty content for an unknown vertical", () => {
    const result = checkCompliance({ vertical: "legal", contentType: "page", content: { text: "" } });
    expect(result.pass).toBe(false);
    expect(result.violations[0].ruleId).toBe("engine.no-ruleset-loaded");
  });
});

describe("ruleset registry", () => {
  it("preloads the five seed verticals", () => {
    for (const v of ["cannabis", "real-estate", "restaurants", "health-life-insurance", "ecommerce"]) {
      expect(registeredVerticals()).toContain(v);
      expect(getRuleset(v)?.vertical).toBe(v);
    }
  });

  it("accepts a new vertical at runtime without engine changes (M1b path)", () => {
    const ruleset: VerticalRuleset = {
      vertical: "test-fitness",
      version: "0.1.0",
      rules: [
        {
          kind: "pattern",
          id: "test-fitness.results-guarantee",
          vertical: "test-fitness",
          severity: "block",
          description: "No guaranteed body-transformation claims.",
          legalReference: "FTC Act §5, 15 U.S.C. §45",
          requiredFix: "Remove the guarantee.",
          patterns: [{ phrase: "guaranteed to lose" }],
          explanation: 'Matched "{excerpt}".',
        },
      ],
    };
    registerRuleset(ruleset);

    const bad = checkCompliance({
      vertical: "test-fitness",
      contentType: "ad",
      content: { text: "Guaranteed to lose 20 pounds in 30 days!" },
    });
    expect(bad.pass).toBe(false);
    expect(violation(bad, "test-fitness.results-guarantee").match?.excerpt).toBe("Guaranteed to lose");

    const ok = checkCompliance({
      vertical: "test-fitness",
      contentType: "ad",
      content: { text: "Structured training plans with weekly coaching check-ins." },
    });
    expectClean(ok);
  });

  it("refuses to overwrite an existing non-seed ruleset unless asked", () => {
    const ruleset: VerticalRuleset = {
      vertical: "test-overwrite",
      version: "0.1.0",
      rules: [
        {
          kind: "pattern",
          id: "test-overwrite.forbidden",
          vertical: "test-overwrite",
          severity: "block",
          description: "Test rule.",
          legalReference: "FTC Act §5, 15 U.S.C. §45",
          requiredFix: "Remove it.",
          patterns: [{ phrase: "forbidden phrase" }],
          explanation: 'Matched "{excerpt}".',
        },
      ],
    };
    registerRuleset(ruleset);
    expect(() => registerRuleset(ruleset)).toThrow(/already registered/);
    expect(() => registerRuleset({ ...ruleset, version: "0.2.0" }, { overwrite: true })).not.toThrow();
    expect(getRuleset("test-overwrite")?.version).toBe("0.2.0");
  });
});

describe("seed-ruleset lock (the hard legal gate cannot be neutered)", () => {
  it("refuses to overwrite ANY seed vertical — even with { overwrite: true }", () => {
    for (const vertical of ["cannabis", "real-estate", "restaurants", "health-life-insurance", "ecommerce"]) {
      const clone = { ...getRuleset(vertical)! };
      expect(() => registerRuleset(clone)).toThrow(/seed/i);
      expect(() => registerRuleset(clone, { overwrite: true })).toThrow(/seed/i);
    }
  });

  it("normalizes vertical names at registration — a case/whitespace variant cannot dodge the lock", () => {
    const decoy: VerticalRuleset = { vertical: "  Cannabis ", version: "0.0.0-neutered", rules: [] };
    expect(() => registerRuleset(decoy, { overwrite: true })).toThrow(/seed/i);
    expect(getRuleset("cannabis")?.version).toBe("1.0.0");
  });

  it("the exact 'cures cancer' Meta ad still blocks after an attempted cannabis overwrite", () => {
    const neutered: VerticalRuleset = { vertical: "cannabis", version: "0.0.0-neutered", rules: [] };
    expect(() => registerRuleset(neutered, { overwrite: true })).toThrow(/seed/i);

    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "ad",
      content: { text: "We ship nationwide! Cures cancer.", platform: "meta" },
    });
    expect(result.pass).toBe(false);
    expect(result.rulesEvaluated).toBeGreaterThan(0);
    expect(result.rulesetVersion).toBe("1.0.0");
    violation(result, "cannabis.health-claims");
    violation(result, "cannabis.interstate-commerce");
    violation(result, "cannabis.ad-platform-gate");
  });
});

describe("empty-ruleset defense-in-depth (zero rules evaluated fails closed)", () => {
  it("an empty ruleset (however it got registered) blocks with engine.empty-ruleset — never passes", () => {
    registerRuleset({ vertical: "test-empty", version: "0.1.0", rules: [] });
    const result = checkCompliance({
      vertical: "test-empty",
      contentType: "ad",
      content: { text: "We ship nationwide! Cures cancer.", platform: "meta" },
    });
    expect(result.pass).toBe(false);
    expect(result.rulesEvaluated).toBe(0);
    expect(result.rulesetVersion).toBe("0.1.0");
    const v = violation(result, "engine.empty-ruleset");
    expect(v.severity).toBe("block");
    expect(v.explanation).toMatch(/fails closed/i);
    expect(v.explanation).toContain("0 rules");
  });

  it("a ruleset with no rules applicable to the content type also fails closed", () => {
    registerRuleset({
      vertical: "test-ads-only",
      version: "0.1.0",
      rules: [
        {
          kind: "pattern",
          id: "test-ads-only.forbidden",
          vertical: "test-ads-only",
          severity: "block",
          description: "Ad-only test rule.",
          legalReference: "FTC Act §5, 15 U.S.C. §45",
          requiredFix: "Remove it.",
          appliesTo: ["ad"],
          patterns: [{ phrase: "forbidden phrase" }],
          explanation: 'Matched "{excerpt}".',
        },
      ],
    });
    const result = checkCompliance({
      vertical: "test-ads-only",
      contentType: "blog",
      content: { text: "A perfectly ordinary blog post." },
    });
    expect(result.pass).toBe(false);
    expect(result.rulesEvaluated).toBe(0);
    violation(result, "engine.empty-ruleset");
  });
});

describe("vertical + jurisdiction normalization (fail-safe hardening)", () => {
  it("resolves case/whitespace variants of a known vertical instead of failing closed", () => {
    const text = "Our tincture treats anxiety.";
    for (const vertical of ["Cannabis", " CANNABIS "]) {
      const result = checkCompliance({ vertical, contentType: "social_caption", content: { text } });
      expect(result.rulesetVersion).toBe("1.0.0");
      expect(result.rulesEvaluated).toBeGreaterThan(0);
      violation(result, "cannabis.health-claims");
    }
    expect(getRuleset("Health-Life-Insurance")?.vertical).toBe("health-life-insurance");
  });

  it("still fails closed for genuinely unknown verticals in any casing", () => {
    const result = checkCompliance({ vertical: "Med-Spas", contentType: "blog", content: { text: "hello" } });
    expect(result.pass).toBe(false);
    violation(result, "engine.no-ruleset-loaded");
  });

  it("collapses internal whitespace in jurisdiction normalization ('new  york' === 'NY')", () => {
    const text = "Order online for pickup at our dispensary.";
    const licensed = checkCompliance({
      vertical: "cannabis",
      contentType: "blog",
      content: { text, licensedStates: ["NY"] },
      jurisdiction: "new  york",
    });
    expectClean(licensed);

    const unlicensed = checkCompliance({
      vertical: "cannabis",
      contentType: "blog",
      content: { text, licensedStates: ["CA"] },
      jurisdiction: "new  york",
    });
    violation(unlicensed, "cannabis.state-licensing");
  });
});

describe("platform gate — word-boundary matching", () => {
  registerRuleset({
    vertical: "test-platform-gate",
    version: "0.1.0",
    rules: [
      {
        kind: "platform-gate",
        id: "test-platform-gate.google-ads",
        vertical: "test-platform-gate",
        severity: "block",
        appliesTo: ["ad"],
        description: "No ads on Google Ads (test gate).",
        legalReference: "Test platform advertising policy",
        requiredFix: "Target a permitted platform.",
        prohibitedPlatforms: ["google ads"],
        explanation: 'Ad output targets "{platform}".',
      },
    ],
  });

  it("blocks a multi-word entry appearing as a whole-token sequence ('google ads campaign')", () => {
    const result = checkCompliance({
      vertical: "test-platform-gate",
      contentType: "ad",
      content: { text: "Buy now.", platform: "Google Ads campaign" },
    });
    expect(result.pass).toBe(false);
    violation(result, "test-platform-gate.google-ads");
  });

  it("does NOT match 'google adsense' via the 'google ads' entry (no substring bleed)", () => {
    const result = checkCompliance({
      vertical: "test-platform-gate",
      contentType: "ad",
      content: { text: "Buy now.", platform: "google adsense" },
    });
    expectClean(result);
  });

  it("keeps the fail-safe direction — cannabis still blocks 'google adsense' via its broad 'google' entry", () => {
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "ad",
      content: { text: "Daily deals for adults 21 and over.", platform: "google adsense" },
    });
    expect(result.pass).toBe(false);
    violation(result, "cannabis.ad-platform-gate");
  });
});

describe("matching correctness", () => {
  it("is case-insensitive", () => {
    const text = "THIS STRAIN CURES CANCER AND TREATS ANXIETY.";
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "page",
      content: { text, hasAgeGate: true },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "cannabis.health-claims");
    expect(v.match?.excerpt).toBe("CURES CANCER");
    expect(v.match?.index).toBe(text.indexOf("CURES CANCER"));
  });

  it("respects word boundaries — no false positive on 'treatsury' or 'retreats'", () => {
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "page",
      content: {
        text: "Our treatsury of retreats awaits — a curated selection for connoisseurs. Must be 21 or older.",
        hasAgeGate: true,
      },
    });
    expectClean(result);
  });

  it.each([
    ["U+200B zero-width space", "\u200B"],
    ["U+200C zero-width non-joiner", "\u200C"],
    ["U+200D zero-width joiner", "\u200D"],
    ["U+FEFF zero-width no-break space (BOM)", "\uFEFF"],
  ])("catches zero-width evasion (%s) and slices the excerpt verbatim from the original", (_name, zw) => {
    const text = `Get guaranteed${zw}approval today with no waiting period.`;
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "social_caption",
      content: { text },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "health-life-insurance.guarantee-claims");
    expectExcerptAt(v, text, `guaranteed${zw}approval`);
  });

  it("matches across hyphen/curly-quote variants and reports original-text excerpts", () => {
    const text = "Act before it’s too late — protect them now."; // curly apostrophe
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "social_caption",
      content: { text },
    });
    expect(result.pass).toBe(true); // fear-based framing warns, never blocks
    const w = result.warnings.find((x) => x.ruleId === "health-life-insurance.fear-based-marketing");
    expect(w?.match?.excerpt).toBe("before it’s too late");
    expect(w?.match?.index).toBe(text.indexOf("before it’s"));
  });
});

describe("result envelope", () => {
  it("carries the honest-scope disclaimer on every result", () => {
    const clean = checkCompliance({
      vertical: "restaurants",
      contentType: "blog",
      content: { text: "Our chef sources heirloom tomatoes from two family farms." },
    });
    const failedClosed = checkCompliance({ vertical: "unknown-x", contentType: "blog", content: { text: "hi" } });
    expect(clean.disclaimer).toBe(COMPLIANCE_DISCLAIMER);
    expect(failedClosed.disclaimer).toBe(COMPLIANCE_DISCLAIMER);
    expect(COMPLIANCE_DISCLAIMER).toMatch(/does not replace/i);
  });

  it("reports which ruleset version evaluated and how many rules applied", () => {
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "page",
      content: { text: "A plain product description." },
    });
    expect(result.rulesetVersion).toBe("1.0.0");
    expect(result.rulesEvaluated).toBeGreaterThan(0);
  });
});
