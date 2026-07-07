/**
 * Engine-level behavior: fail-closed unknown verticals, runtime registration,
 * case-insensitivity, word-boundary correctness, disclaimer, match positions.
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
import { expectClean, violation } from "./test-helpers";

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

  it("refuses to overwrite an existing ruleset unless asked", () => {
    const clone = { ...getRuleset("cannabis")! };
    expect(() => registerRuleset(clone)).toThrow(/already registered/);
    expect(() => registerRuleset(clone, { overwrite: true })).not.toThrow();
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
