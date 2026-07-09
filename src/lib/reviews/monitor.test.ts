/**
 * M15 MONITOR ingest — unavailable platforms are EXCLUDED + named (never zeroed);
 * connected-but-empty is covered; dedup by platform+externalId; never invents.
 */

import { describe, expect, it } from "vitest";
import { ingestReviews } from "./monitor";
import { ScriptedReviewPlatformProvider } from "./provider";
import type { IngestedReview } from "./types";

function review(platform: string, externalId: string | null, over: Partial<IngestedReview> = {}): IngestedReview {
  return {
    platform,
    author: null,
    rating: 5,
    ratingScale: 5,
    text: "ok",
    postedAt: "2026-07-01T00:00:00Z",
    externalId,
    ...over,
  };
}

describe("ingestReviews — honesty: excluded ≠ zero", () => {
  it("an unavailable platform is EXCLUDED + named, contributes zero reviews, is NOT covered", async () => {
    const provider = new ScriptedReviewPlatformProvider()
      .script({ platform: "google", reviews: [review("google", "g-1")] })
      .failNext("yelp");

    const res = await ingestReviews(provider, {
      pulls: [
        { platform: "google", accountRef: "a" },
        { platform: "yelp", accountRef: "b" },
      ],
    });

    expect(res.reviews).toHaveLength(1);
    expect(res.coveredPlatforms).toEqual(["google"]);
    // yelp is NAMED as excluded — never silently "0 reviews".
    expect(res.excludedPlatforms).toEqual([{ platform: "yelp", reason: "unavailable" }]);
  });

  it("a connected-but-empty platform IS covered (honest 'connected, none yet')", async () => {
    const provider = new ScriptedReviewPlatformProvider(); // everything returns empty
    const res = await ingestReviews(provider, { pulls: [{ platform: "bbb", accountRef: "a" }] });
    expect(res.reviews).toEqual([]);
    expect(res.coveredPlatforms).toEqual(["bbb"]);
    expect(res.excludedPlatforms).toEqual([]);
  });

  it("all platforms unavailable → zero covered, all named excluded (nothing invented)", async () => {
    const provider = new ScriptedReviewPlatformProvider().failNext("google").failNext("yelp");
    const res = await ingestReviews(provider, {
      pulls: [
        { platform: "google", accountRef: "a" },
        { platform: "yelp", accountRef: "b" },
      ],
    });
    expect(res.reviews).toEqual([]);
    expect(res.coveredPlatforms).toEqual([]);
    expect(res.excludedPlatforms.map((e) => e.platform)).toEqual(["google", "yelp"]);
  });
});

describe("ingestReviews — dedup + ordering", () => {
  it("dedups by (platform, externalId); keeps id-less reviews", async () => {
    const provider = new ScriptedReviewPlatformProvider().script({
      platform: "google",
      reviews: [review("google", "g-1"), review("google", "g-1"), review("google", null), review("google", null)],
    });
    const res = await ingestReviews(provider, { pulls: [{ platform: "google", accountRef: "a" }] });
    // g-1 collapses to one; the two id-less reviews both survive (can't dedup).
    expect(res.reviews).toHaveLength(3);
  });

  it("preserves pull order for determinism", async () => {
    const provider = new ScriptedReviewPlatformProvider()
      .script({ platform: "google", reviews: [review("google", "g-1")] })
      .script({ platform: "yelp", reviews: [review("yelp", "y-1")] });
    const a = await ingestReviews(provider, {
      pulls: [
        { platform: "google", accountRef: "a" },
        { platform: "yelp", accountRef: "b" },
      ],
    });
    expect(a.reviews.map((r) => r.platform)).toEqual(["google", "yelp"]);
  });
});
