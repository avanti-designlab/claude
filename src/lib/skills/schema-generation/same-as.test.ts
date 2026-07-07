import { describe, expect, it } from "vitest";
import { aggregateSameAs, sameAsDedupeKey } from "./same-as";
import type { SameAsSources } from "./types";

describe("sameAsDedupeKey", () => {
  it("collapses protocol, www., and trailing-slash variants", () => {
    const a = sameAsDedupeKey("https://www.forbes.com/profile/daniel-reyes/");
    const b = sameAsDedupeKey("http://forbes.com/profile/daniel-reyes");
    expect(a).toBe(b);
  });

  it("keeps genuinely different URLs distinct", () => {
    expect(sameAsDedupeKey("https://forbes.com/profile/a")).not.toBe(
      sameAsDedupeKey("https://forbes.com/profile/b"),
    );
    expect(sameAsDedupeKey("https://forbes.com/p?x=1")).not.toBe(
      sameAsDedupeKey("https://forbes.com/p?x=2"),
    );
  });
});

describe("aggregateSameAs — SKILL.md hard rule 2", () => {
  const sources: SameAsSources = {
    // deliberately unordered relative to the aggregation order
    other: ["https://example.com/extra"],
    credentialRegistries: ["https://www.dubailand.gov.ae/en/eservices/broker/48812"],
    linkedin: ["https://www.linkedin.com/in/daniel-reyes-dubai"],
    pressArticles: [
      "https://www.forbes.com/profile/daniel-reyes/",
      "https://forbes.com/profile/daniel-reyes", // dup of the one above
      "https://gulfnews.com/business/property/daniel-reyes",
    ],
    youtube: ["https://www.youtube.com/@ReyesPrivateClients"],
    podcast: ["https://podcasts.apple.com/ae/podcast/id1755500042"],
    bylines: ["https://www.arabianbusiness.com/author/daniel-reyes"],
  };

  it("aggregates ALL provided categories in stable source order", () => {
    expect(aggregateSameAs(sources)).toEqual([
      "https://www.forbes.com/profile/daniel-reyes/", // press first
      "https://gulfnews.com/business/property/daniel-reyes",
      "https://www.arabianbusiness.com/author/daniel-reyes", // bylines
      "https://www.linkedin.com/in/daniel-reyes-dubai",
      "https://www.youtube.com/@ReyesPrivateClients",
      "https://podcasts.apple.com/ae/podcast/id1755500042",
      "https://www.dubailand.gov.ae/en/eservices/broker/48812", // credentials
      "https://example.com/extra",
    ]);
  });

  it("deduplicates keeping the first occurrence's original string", () => {
    const result = aggregateSameAs(sources);
    expect(result).toContain("https://www.forbes.com/profile/daniel-reyes/");
    expect(result).not.toContain("https://forbes.com/profile/daniel-reyes");
    expect(result.filter((u) => u.includes("forbes.com"))).toHaveLength(1);
  });

  it("is deterministic — the same input always yields the same array", () => {
    expect(aggregateSameAs(sources)).toEqual(aggregateSameAs(sources));
  });

  it("skips blank entries and handles absent sources", () => {
    expect(aggregateSameAs(undefined)).toEqual([]);
    expect(aggregateSameAs({})).toEqual([]);
    expect(aggregateSameAs({ linkedin: ["  ", "https://www.linkedin.com/in/x"] })).toEqual([
      "https://www.linkedin.com/in/x",
    ]);
  });

  it("dedupes across categories, not just within one", () => {
    expect(
      aggregateSameAs({
        pressArticles: ["https://example.com/story"],
        other: ["https://www.example.com/story/"],
      }),
    ).toEqual(["https://example.com/story"]);
  });
});
