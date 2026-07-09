/**
 * The review SIGNAL builder (M15) — combines sentiment + velocity over a monitor
 * result into the counts-only aggregate persisted to metrics(source='reviews').
 */

import { describe, expect, it } from "vitest";
import { buildReviewSignal } from "./signal";
import type { MonitorResult } from "./monitor";
import type { IngestedReview } from "./types";

const NOW = "2026-07-09T00:00:00.000Z";

function at(daysAgo: number, over: Partial<IngestedReview> = {}): IngestedReview {
  const ms = Date.parse(NOW) - daysAgo * 24 * 60 * 60 * 1000;
  return {
    platform: "google",
    author: null,
    rating: 5,
    ratingScale: 5,
    text: "",
    postedAt: new Date(ms).toISOString(),
    externalId: null,
    ...over,
  };
}

describe("buildReviewSignal", () => {
  it("assembles sentiment + velocity + the covered/excluded platform split", () => {
    const monitor: MonitorResult = {
      reviews: [at(1, { rating: 5 }), at(2, { rating: 1 }), at(40, { rating: 4 })],
      coveredPlatforms: ["google"],
      excludedPlatforms: [{ platform: "yelp", reason: "unavailable" }],
    };
    const signal = buildReviewSignal({ monitor, now: NOW, windowDays: 30 });

    expect(signal.windowDays).toBe(30);
    expect(signal.capturedFor).toBe(NOW);
    expect(signal.totalIngested).toBe(3);
    expect(signal.coveredPlatforms).toEqual(["google"]);
    // The excluded platform is carried by NAME into the persisted signal.
    expect(signal.excludedPlatforms).toEqual(["yelp"]);

    expect(signal.sentiment).toMatchObject({ positive: 2, negative: 1, total: 3 });
    expect(signal.velocity.currentCount).toBe(2); // the two within 30 days
    expect(signal.velocity.priorCount).toBe(1); // the 40-day-old one
    expect(signal.velocity.trend).toBe("rising");
  });

  it("carries an undated review count out of the buckets", () => {
    const monitor: MonitorResult = {
      reviews: [at(1), at(2, { postedAt: null })],
      coveredPlatforms: ["google"],
      excludedPlatforms: [],
    };
    const signal = buildReviewSignal({ monitor, now: NOW, windowDays: 30 });
    expect(signal.undatedCount).toBe(1);
    expect(signal.totalIngested).toBe(2);
  });

  it("an empty monitor result is an honest all-zero signal (nothing fabricated)", () => {
    const signal = buildReviewSignal({
      monitor: { reviews: [], coveredPlatforms: ["google"], excludedPlatforms: [] },
      now: NOW,
    });
    expect(signal.totalIngested).toBe(0);
    expect(signal.sentiment.total).toBe(0);
    expect(signal.velocity.currentCount).toBe(0);
  });
});
