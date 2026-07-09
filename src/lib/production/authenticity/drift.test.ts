/**
 * M9 drift recheck — proves a humanizer that changes MEANING or slips off-VOICE is
 * caught (task point 3). Meaning drift reuses M8's grounding pass; voice drift is
 * the deterministic banned-phrase guardrail.
 */

import { describe, expect, it } from "vitest";
import { recheckDrift } from "./drift";
import type { VoiceProfile } from "@/lib/types/brand";

const VOICE: VoiceProfile = {
  descriptors: ["calm", "factual"],
  samples: [],
  do: ["explain plainly"],
  dont: ["cheap", "guaranteed returns"],
};

describe("recheckDrift — meaning", () => {
  it("flags a statistic the humanizer INTRODUCED that the original never stated", () => {
    const original = "We help expat buyers navigate the local market.";
    const humanized = "We help expat buyers navigate the local market. 98% of clients close fast.";
    const drift = recheckDrift({ original, humanized, voice: VOICE });
    expect(drift.detected).toBe(true);
    expect(drift.meaning.map((m) => m.excerpt)).toContain("98%");
    expect(drift.meaning[0].kind).toBe("statistic");
  });

  it("flags an introduced superlative", () => {
    const original = "We advise buyers in the area.";
    const humanized = "We are the best advisers for buyers in the area.";
    const drift = recheckDrift({ original, humanized, voice: VOICE });
    expect(drift.meaning.some((m) => m.kind === "superlative" && m.excerpt.toLowerCase() === "best")).toBe(true);
  });

  it("does NOT flag when the humanized text stays within the original's claims", () => {
    const original = "We advise expat buyers. Our team has 25 years of combined experience overall.";
    const humanized = "Our team brings 25 years of combined experience to advising expat buyers.";
    const drift = recheckDrift({ original, humanized, voice: VOICE });
    expect(drift.detected).toBe(false);
    expect(drift.meaning).toEqual([]);
    expect(drift.voice).toEqual([]);
  });

  it("flags an INTRODUCED '20%' even though the original contains '2024' (R1: value-exact, not digit-substring)", () => {
    // Old digit-substring grounding wrongly grounded '20' inside '2024'; value-exact flags it.
    const original = "Our 2024 market report covers expat buyers.";
    const humanized = "Our 2024 market report covers expat buyers. Prices rose 20% this year.";
    const drift = recheckDrift({ original, humanized, voice: VOICE });
    expect(drift.detected).toBe(true);
    expect(drift.meaning.map((m) => m.excerpt)).toContain("20%");
    // The legitimately-carried '2024' is still grounded (present in the original) — not flagged.
    expect(drift.meaning.map((m) => m.excerpt)).not.toContain("2024");
  });
});

describe("recheckDrift — voice", () => {
  it("flags a banned dont-phrase the humanizer INTRODUCED", () => {
    const original = "We offer premium advisory services.";
    const humanized = "We offer cheap, premium advisory services.";
    const drift = recheckDrift({ original, humanized, voice: VOICE });
    expect(drift.detected).toBe(true);
    expect(drift.voice.map((v) => v.excerpt)).toContain("cheap");
    expect(drift.voice[0].kind).toBe("banned_phrase");
  });

  it("does NOT flag a banned phrase that was ALREADY in the original (humanizer didn't add it)", () => {
    const original = "Some call our fees cheap; we call them fair.";
    const humanized = "Our fees are cheap by comparison, and fair.";
    const drift = recheckDrift({ original, humanized, voice: VOICE });
    expect(drift.voice).toEqual([]); // "cheap" pre-existed
  });

  it("word-boundary aware: a substring of a longer word is not a false banned-phrase hit", () => {
    const original = "We advise buyers.";
    const humanized = "We advise buyers on cheaply-built new developments."; // "cheap" ⊂ "cheaply"
    const drift = recheckDrift({ original, humanized, voice: VOICE });
    expect(drift.voice).toEqual([]);
  });
});
