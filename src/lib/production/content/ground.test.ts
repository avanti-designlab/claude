/**
 * The M8 guardrail passes: anti-fabrication grounding + the compliance
 * pre-screen. Deterministic; uses the REAL compliance skill.
 */

import { describe, expect, it } from "vitest";
import { findUngroundedClaims, screenCompliance } from "./ground";

describe("findUngroundedClaims — statistics", () => {
  it("flags a percentage and a large number that the grounding facts don't support", () => {
    const flags = findUngroundedClaims("We closed 500 homes with a 98% success rate.", []);
    const excerpts = flags.map((f) => f.excerpt);
    expect(excerpts).toContain("98%");
    expect(excerpts).toContain("500");
    expect(flags.every((f) => f.kind === "statistic")).toBe(true);
  });

  it("grounds a statistic whose digits appear in a grounding fact", () => {
    const flags = findUngroundedClaims("We closed 500 homes.", ["Closed 500 homes in 2024."]);
    expect(flags).toEqual([]);
  });

  it("ignores small bare counts as noise", () => {
    expect(findUngroundedClaims("Here are 3 tips and 5 steps.", [])).toEqual([]);
  });
});

describe("findUngroundedClaims — superlatives", () => {
  it("flags an unsubstantiated absolute claim", () => {
    const flags = findUngroundedClaims("We are the best advisor in the city.", []);
    expect(flags).toEqual([{ kind: "superlative", excerpt: "best", index: 11 }]);
  });

  it("grounds a superlative that the input substantiates", () => {
    expect(findUngroundedClaims("Rated the best advisor.", ["Awarded best advisor by XYZ, 2024."])).toEqual([]);
  });

  it("respects word boundaries (no match inside a longer word)", () => {
    // "bestselling" contains "best" but must not flag; "guaranteed" must.
    const flags = findUngroundedClaims("Our bestselling guide is guaranteed to help.", []);
    expect(flags.map((f) => f.excerpt)).toEqual(["guaranteed"]);
  });

  it("sorts flags by position and caps output", () => {
    const flags = findUngroundedClaims("the best guide is guaranteed and #1 rated", []);
    const indices = flags.map((f) => f.index);
    expect([...indices]).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe("screenCompliance", () => {
  it("flags a cannabis disease claim as a block (guardrail catches leakage)", () => {
    const res = screenCompliance("cannabis", "blog", "This product treats anxiety and cures insomnia.");
    expect(res.pass).toBe(false);
    expect(res.violations.some((v) => v.ruleId === "cannabis.health-claims")).toBe(true);
    expect(res.disclaimer).toContain("not legal review");
  });

  it("passes benign real-estate content and carries the honest-scope disclaimer", () => {
    const res = screenCompliance("real-estate", "pillar", "A calm, factual overview of the buying process.");
    expect(res.pass).toBe(true);
    expect(typeof res.disclaimer).toBe("string");
  });

  it("fails closed on an unknown vertical (never a silent pass)", () => {
    const res = screenCompliance("underwater-basket-weaving", "blog", "anything");
    expect(res.pass).toBe(false);
  });
});
