/**
 * M18 — the honesty grader is the module's spine. It never trusts the provider:
 * it verifies every citation against what retrieval actually returned (NO
 * fabricated sources), it only ever LOWERS confidence, and an unsourced or
 * "not found" answer is a first-class low-confidence answer.
 */

import { describe, expect, it } from "vitest";
import { gradeAnswer, normalizeSourceUrl, unavailableAnswer } from "./ground";
import type { AnswerProviderResult, WebSearchResult } from "./types";

const SRC: WebSearchResult[] = [
  { title: "NAR", url: "https://www.nar.realtor/guide", snippet: "Escrow holds funds." },
  { title: "Zillow", url: "https://zillow.com/learn/", snippet: "Closing costs vary." },
];

function result(over: Partial<AnswerProviderResult>): AnswerProviderResult {
  return { answer: "An answer.", citedSourceUrls: [], answered: true, raw: {}, ...over };
}

describe("normalizeSourceUrl", () => {
  it("ignores scheme, www., trailing slash, and query/fragment", () => {
    expect(normalizeSourceUrl("https://www.nar.realtor/guide/")).toBe("nar.realtor/guide");
    expect(normalizeSourceUrl("http://nar.realtor/guide?x=1#top")).toBe("nar.realtor/guide");
    expect(normalizeSourceUrl("  ")).toBe("");
  });
});

describe("gradeAnswer — source attribution / no fabricated sources", () => {
  it("attributes only citations present in retrieval; strips + flags the rest", () => {
    const g = gradeAnswer(
      result({
        citedSourceUrls: ["https://www.nar.realtor/guide", "https://totally-made-up.example/x"],
        selfConfidence: "high",
      }),
      SRC,
      true,
    );
    // The real citation is attributed to the retrieved source.
    expect(g.sources.map((s) => s.url)).toEqual(["https://www.nar.realtor/guide"]);
    // The invented source is stripped from sources and surfaced as unattributed.
    expect(g.unattributedCitations).toEqual(["https://totally-made-up.example/x"]);
    // A fabricated citation present ⇒ not grounded, confidence capped at medium.
    expect(g.grounded).toBe(false);
    expect(g.confidence).toBe("medium");
  });

  it("grounded=true only when answered, ≥1 attributed source, and nothing fabricated", () => {
    const g = gradeAnswer(
      result({ citedSourceUrls: ["https://zillow.com/learn"], selfConfidence: "high" }),
      SRC,
      true,
    );
    expect(g.grounded).toBe(true);
    expect(g.confidence).toBe("high");
    expect(g.sources).toHaveLength(1);
  });

  it("dedupes citations that normalize to the same retrieved source", () => {
    const g = gradeAnswer(
      result({ citedSourceUrls: ["https://nar.realtor/guide", "http://www.nar.realtor/guide/"] }),
      SRC,
      true,
    );
    expect(g.sources).toHaveLength(1);
  });
});

describe("gradeAnswer — low-confidence honesty", () => {
  it("an unsourced answer is capped at low confidence, not grounded", () => {
    const g = gradeAnswer(result({ citedSourceUrls: [], selfConfidence: "high" }), SRC, true);
    expect(g.grounded).toBe(false);
    expect(g.confidence).toBe("low");
    expect(g.sources).toEqual([]);
  });

  it("an honest 'not found' (answered:false) is low confidence with empty prose", () => {
    const g = gradeAnswer(result({ answered: false, answer: "irrelevant", selfConfidence: "high" }), SRC, true);
    expect(g.answered).toBe(false);
    expect(g.answer).toBe("");
    expect(g.confidence).toBe("low");
    expect(g.grounded).toBe(false);
  });

  it("empty prose is treated as not answered even if answered:true", () => {
    const g = gradeAnswer(result({ answer: "   ", answered: true }), SRC, true);
    expect(g.answered).toBe(false);
  });

  it("confidence is only ever LOWERED — a provider claiming high but unsourced still lands low", () => {
    const g = gradeAnswer(result({ selfConfidence: "high", citedSourceUrls: [] }), [], false);
    expect(g.confidence).toBe("low");
    expect(g.webSearchAvailable).toBe(false);
  });
});

describe("unavailableAnswer", () => {
  it("is an honest empty low-confidence answer with its own disclaimer", () => {
    const g = unavailableAnswer(false);
    expect(g).toMatchObject({ answered: false, grounded: false, confidence: "low", answer: "", sources: [] });
    expect(g.disclaimer).toMatch(/isn’t connected|not.*connected/i);
  });
});
