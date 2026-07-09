/**
 * M3 scoring suite (scoring.ts).
 *
 * What must hold: the ⚑ formula behaves exactly as documented (cited = half
 * credit + reciprocal position, unknown position conservative); zero measured
 * samples score NULL, never 0; per-engine gaps are null, never fake zeros;
 * share-of-voice attribution is deterministic (cited → client, domain match →
 * first competitor in caller order, unmatched source → other); the cited-URL
 * inventory is stably ordered.
 */

import { describe, expect, it } from "vitest";
import { VISIBILITY_ENGINES } from "@/lib/types/db";
import {
  citationCredit,
  citedUrlInventory,
  computeRunMetrics,
  domainMatches,
  normalizeDomain,
  perEngineBreakdown,
  shareOfVoice,
  visibilityScore,
  type CompetitorRef,
  type MeasuredSample,
} from "./scoring";

function sample(overrides: Partial<MeasuredSample> = {}): MeasuredSample {
  return {
    engine: "chatgpt",
    prompt: "who is Gable & Grove Realty",
    cited: false,
    position: null,
    citedSource: null,
    ...overrides,
  };
}

const RIVALS: CompetitorRef[] = [
  { name: "Rival Realty", domains: ["rival.com"] },
  { name: "Other Rival", domains: ["otherrival.com", "or-blog.net"] },
];

describe("citationCredit (the ⚑ formula, per sample)", () => {
  it("scores uncited as 0 — measured invisibility is a real zero", () => {
    expect(citationCredit(false, 1)).toBe(0);
    expect(citationCredit(false, null)).toBe(0);
  });

  it("scores cited by reciprocal position on top of the half-credit floor", () => {
    expect(citationCredit(true, 1)).toBe(1);
    expect(citationCredit(true, 2)).toBe(0.75);
    expect(citationCredit(true, 4)).toBe(0.625);
  });

  it("treats an unknown or invalid position as 'cited, deep' — never extrapolates up", () => {
    expect(citationCredit(true, null)).toBe(0.5);
    expect(citationCredit(true, 0)).toBe(0.5);
    expect(citationCredit(true, -2)).toBe(0.5);
    expect(citationCredit(true, 1.5)).toBe(0.5);
  });
});

describe("visibilityScore", () => {
  it("is NULL for zero measured samples — measured-nothing is not 0", () => {
    expect(visibilityScore([])).toBeNull();
  });

  it("is 0 when every sample was measured and uncited", () => {
    expect(visibilityScore([sample(), sample({ engine: "gemini" })])).toBe(0);
  });

  it("is 100 × mean credit, to one decimal", () => {
    expect(
      visibilityScore([
        sample({ cited: true, position: 1 }),
        sample({ cited: false }),
      ])
    ).toBe(50);
    expect(
      visibilityScore([
        sample({ cited: true, position: 2 }), // 0.75
        sample({ cited: true, position: null }), // 0.5
        sample({ cited: false }), // 0
      ])
    ).toBe(41.7);
  });
});

describe("perEngineBreakdown", () => {
  it("covers all six engines in canonical order; unmeasured engines are null, not 0", () => {
    const breakdown = perEngineBreakdown([
      sample({ engine: "chatgpt", cited: true, position: 1 }),
      sample({ engine: "chatgpt", cited: false }),
      sample({ engine: "perplexity", cited: false }),
    ]);
    expect(breakdown.map((b) => b.engine)).toEqual([...VISIBILITY_ENGINES]);
    expect(breakdown[0]).toEqual({ engine: "chatgpt", sampled: 2, cited: 1, score: 50 });
    expect(breakdown[1]).toEqual({ engine: "perplexity", sampled: 1, cited: 0, score: 0 });
    expect(breakdown[2]).toEqual({ engine: "gemini", sampled: 0, cited: 0, score: null });
  });
});

describe("normalizeDomain / domainMatches", () => {
  it("normalizes URLs and bare hosts to a comparable domain", () => {
    expect(normalizeDomain("https://www.Example.com/path?q=1")).toBe("example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
    expect(normalizeDomain("blog.example.com.")).toBe("blog.example.com");
    expect(normalizeDomain("HTTP://EXAMPLE.COM")).toBe("example.com");
  });

  it("returns null for garbage — garbage never silently matches anyone", () => {
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
    expect(normalizeDomain("not a url at all")).toBeNull();
    expect(normalizeDomain("javascript:alert(1)")).toBeNull();
  });

  it("matches subdomains only on a dot boundary", () => {
    expect(domainMatches("rival.com", "rival.com")).toBe(true);
    expect(domainMatches("blog.rival.com", "rival.com")).toBe(true);
    expect(domainMatches("notrival.com", "rival.com")).toBe(false);
  });
});

describe("shareOfVoice", () => {
  it("attributes cited→client, domain→competitor, unmatched source→other, no source→unattributed", () => {
    const report = shareOfVoice(
      [
        sample({ cited: true, position: 1, citedSource: "https://client.example.com/a" }),
        sample({ cited: true, position: 3, citedSource: "https://client.example.com/b" }),
        sample({ citedSource: "https://www.rival.com/why-us" }),
        sample({ citedSource: "https://or-blog.net/post" }),
        sample({ citedSource: "https://random-listicle.org/top10" }),
        sample({ citedSource: null }),
      ],
      RIVALS
    );
    expect(report).toEqual({
      measured: 6,
      client: { citations: 2, share: 2 / 6 },
      competitors: [
        { name: "Rival Realty", citations: 1, share: 1 / 6 },
        { name: "Other Rival", citations: 1, share: 1 / 6 },
      ],
      otherCitations: 1,
      unattributed: 1,
    });
  });

  it("first competitor in caller order wins a shared domain", () => {
    const report = shareOfVoice(
      [sample({ citedSource: "https://shared.com/x" })],
      [
        { name: "First", domains: ["shared.com"] },
        { name: "Second", domains: ["shared.com"] },
      ]
    );
    expect(report.competitors).toEqual([
      { name: "First", citations: 1, share: 1 },
      { name: "Second", citations: 0, share: 0 },
    ]);
  });

  it("normalizes competitor domain input (www., full URLs) before matching", () => {
    const report = shareOfVoice(
      [sample({ citedSource: "https://rival.com/page" })],
      [{ name: "Rival", domains: ["https://www.rival.com/about"] }]
    );
    expect(report.competitors[0].citations).toBe(1);
  });

  it("reports zero shares (not NaN, not invented) when nothing was measured", () => {
    const report = shareOfVoice([], RIVALS);
    expect(report.measured).toBe(0);
    expect(report.client).toEqual({ citations: 0, share: 0 });
    expect(report.competitors.every((c) => c.share === 0)).toBe(true);
  });
});

describe("citedUrlInventory (M4's input)", () => {
  it("counts, attributes, and orders sources deterministically", () => {
    const inventory = citedUrlInventory(
      [
        sample({ engine: "perplexity", citedSource: "https://rival.com/why-us" }),
        sample({ engine: "chatgpt", citedSource: "https://rival.com/why-us" }),
        sample({
          engine: "gemini",
          cited: true,
          position: 1,
          citedSource: "https://client.example.com/guide",
        }),
        sample({ engine: "claude", citedSource: "https://random.org/list" }),
        sample({ engine: "claude", citedSource: null }),
      ],
      RIVALS
    );
    expect(inventory).toEqual([
      {
        url: "https://rival.com/why-us",
        domain: "rival.com",
        attribution: "competitor",
        competitor: "Rival Realty",
        count: 2,
        engines: ["chatgpt", "perplexity"], // canonical engine order
      },
      {
        url: "https://client.example.com/guide",
        domain: "client.example.com",
        attribution: "client",
        competitor: null,
        count: 1,
        engines: ["gemini"],
      },
      {
        url: "https://random.org/list",
        domain: "random.org",
        attribution: "other",
        competitor: null,
        count: 1,
        engines: ["claude"],
      },
    ]);
  });

  it("prefers competitor attribution (domain is definitive) over ever-client-cited", () => {
    const inventory = citedUrlInventory(
      [sample({ cited: true, position: 1, citedSource: "https://rival.com/mentions-both" })],
      RIVALS
    );
    expect(inventory[0].attribution).toBe("competitor");
  });

  it("breaks count ties by url ascending", () => {
    const inventory = citedUrlInventory(
      [
        sample({ citedSource: "https://b.example.com/x" }),
        sample({ citedSource: "https://a.example.com/x" }),
      ],
      []
    );
    expect(inventory.map((entry) => entry.url)).toEqual([
      "https://a.example.com/x",
      "https://b.example.com/x",
    ]);
  });
});

describe("computeRunMetrics", () => {
  it("assembles all metrics deterministically from the same samples", () => {
    const samples = [
      sample({ cited: true, position: 1, citedSource: "https://client.example.com/a" }),
      sample({ engine: "perplexity", citedSource: "https://rival.com/x" }),
    ];
    const a = computeRunMetrics(samples, RIVALS);
    const b = computeRunMetrics(samples, RIVALS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.score).toBe(50);
    expect(a.shareOfVoice.client.citations).toBe(1);
    expect(a.citedUrls).toHaveLength(2);
    expect(a.perEngine).toHaveLength(VISIBILITY_ENGINES.length);
  });
});
