/**
 * The M8 guardrail passes: anti-fabrication grounding + the compliance
 * pre-screen. Deterministic; uses the REAL compliance skill.
 */

import { describe, expect, it } from "vitest";
import { evaluateAeoFormatting, findBannedVoicePhrases, findUngroundedClaims, screenCompliance } from "./ground";

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

describe("findUngroundedClaims — value-exact numeric grounding (R1: no digit-substring under-flag)", () => {
  it("FLAGS '98%' when a fact only contains '1980' ('98' must NOT match inside '1980')", () => {
    const flags = findUngroundedClaims("Our approval rate is 98%.", ["We were founded in 1980."]);
    expect(flags.map((f) => f.excerpt)).toContain("98%");
  });

  it("FLAGS '20%' when a fact only contains '2024' ('20' must NOT match inside '2024')", () => {
    const flags = findUngroundedClaims("Prices rose 20% last year.", ["Report published in 2024."]);
    expect(flags.map((f) => f.excerpt)).toContain("20%");
  });

  it("still grounds VALUE-EXACT matches (separator/format-insensitive)", () => {
    const flags = findUngroundedClaims(
      "The fee is $1,200 and we closed 500 homes at a 98% rate.",
      ["Our fee is 1200 dollars.", "Closed 500 homes.", "A 98% satisfaction score."],
    );
    expect(flags).toEqual([]);
  });

  it("grounds '1,200' against '1200.00' (thousands + trailing-zero normalization)", () => {
    expect(findUngroundedClaims("We manage 1,200 units.", ["Portfolio of 1200.00 units."])).toEqual([]);
  });
});

describe("findBannedVoicePhrases — M8's own-output voice.dont screen (FIX 4)", () => {
  it("flags banned dont-phrases present in the generated draft itself", () => {
    const flags = findBannedVoicePhrases("Our cheap plans deliver pure hype.", ["cheap", "hype"]);
    expect(flags.map((f) => f.excerpt).sort()).toEqual(["cheap", "hype"]);
  });

  it("is word-boundary aware (no hit inside a longer word) and dedupes markers", () => {
    expect(findBannedVoicePhrases("We ship cheaply-made goods.", ["cheap", "cheap"])).toEqual([]);
  });

  it("returns [] when no banned phrase appears", () => {
    expect(findBannedVoicePhrases("A calm, factual overview.", ["cheap", "hype"])).toEqual([]);
  });
});

describe("evaluateAeoFormatting — direct-answer opening guardrail (R2)", () => {
  it("flags a hedged/preamble FAQ opening (uses the aeo-audit skill's FAQ check)", () => {
    const f = evaluateAeoFormatting("faq", "Well, that really depends on many factors we will explore.");
    expect(f.check).toBe("faq_direct_answer");
    expect(f.direct).toBe(false);
    expect(f.reason).not.toBeNull();
  });

  it("passes a direct FAQ opening", () => {
    const f = evaluateAeoFormatting("faq", "Yes. Foreign buyers can get a mortgage from most Dubai banks.");
    expect(f.direct).toBe(true);
    expect(f.reason).toBeNull();
  });

  it("applies the analog opening check to blog/pillar", () => {
    const hedged = evaluateAeoFormatting("blog", "In this article, we will take a look at the buying process.");
    expect(hedged.check).toBe("opening_directness");
    expect(hedged.direct).toBe(false);

    const direct = evaluateAeoFormatting("pillar", "The buying process has five clear steps. Here is each one.");
    expect(direct.check).toBe("opening_directness");
    expect(direct.direct).toBe(true);
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
