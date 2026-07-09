/**
 * Deterministic review-velocity (M15). States its window; excludes unavailable
 * platforms from denominators (never zero); undated reviews excluded from buckets.
 */

import { describe, expect, it } from "vitest";
import { computeReviewVelocity } from "./velocity";
import { REVIEW_SIGNAL_THRESHOLD_FLAGS } from "./types";
import type { IngestedReview } from "./types";

const NOW = "2026-07-09T00:00:00.000Z";

/** A review posted `daysAgo` before NOW. */
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

describe("computeReviewVelocity — window buckets + trend", () => {
  it("buckets current [now−w, now] vs prior [now−2w, now−w] and reports the trend (rising)", () => {
    const v = computeReviewVelocity({
      reviews: [at(1), at(10), at(29), at(40), at(50)], // 3 current, 2 prior (window 30)
      now: NOW,
      windowDays: 30,
      coveredPlatforms: ["google"],
      excludedPlatforms: [],
    });
    expect(v.windowDays).toBe(30);
    expect(v.windowEnd).toBe(NOW);
    expect(v.currentCount).toBe(3);
    expect(v.priorCount).toBe(2);
    expect(v.delta).toBe(1);
    expect(v.trend).toBe("rising");
    expect(v.perDay).toBeCloseTo(3 / 30, 10);
  });

  it("falling + flat trends", () => {
    const falling = computeReviewVelocity({
      reviews: [at(5), at(40), at(45), at(50)], // 1 current, 3 prior
      now: NOW,
      windowDays: 30,
      coveredPlatforms: ["google"],
      excludedPlatforms: [],
    });
    expect(falling.trend).toBe("falling");
    expect(falling.delta).toBe(-2);

    const flat = computeReviewVelocity({
      reviews: [at(5), at(40)], // 1 current, 1 prior
      now: NOW,
      windowDays: 30,
      coveredPlatforms: ["google"],
      excludedPlatforms: [],
    });
    expect(flat.trend).toBe("flat");
    expect(flat.delta).toBe(0);
  });

  it("undated reviews are counted separately, not placed in a window", () => {
    const v = computeReviewVelocity({
      reviews: [at(1), at(2, { postedAt: null }), at(3, { postedAt: "not-a-date" })],
      now: NOW,
      windowDays: 30,
      coveredPlatforms: ["google"],
      excludedPlatforms: [],
    });
    expect(v.currentCount).toBe(1);
    expect(v.undatedCount).toBe(2);
  });
});

describe("computeReviewVelocity — honesty of window + denominator", () => {
  it("states its window and defaults to the launch default when unset/invalid", () => {
    const v = computeReviewVelocity({
      reviews: [],
      now: NOW,
      coveredPlatforms: [],
      excludedPlatforms: [],
    });
    expect(v.windowDays).toBe(REVIEW_SIGNAL_THRESHOLD_FLAGS.defaultWindowDays);

    const clamped = computeReviewVelocity({
      reviews: [],
      now: NOW,
      windowDays: -5,
      coveredPlatforms: [],
      excludedPlatforms: [],
    });
    expect(clamped.windowDays).toBe(REVIEW_SIGNAL_THRESHOLD_FLAGS.defaultWindowDays);
  });

  it("EXCLUDED platforms are carried through, never folded into a count as zero", () => {
    // yelp is unavailable — it must be NAMED, and the counts reflect only google.
    const v = computeReviewVelocity({
      reviews: [at(1)],
      now: NOW,
      windowDays: 30,
      coveredPlatforms: ["google"],
      excludedPlatforms: ["yelp"],
    });
    expect(v.coveredPlatforms).toEqual(["google"]);
    expect(v.excludedPlatforms).toEqual(["yelp"]);
    // The excluded platform did not add a phantom "0 reviews" bucket — the count is the real one.
    expect(v.currentCount).toBe(1);
  });
});

describe("computeReviewVelocity — determinism", () => {
  it("same reviews + same now ⇒ identical velocity", () => {
    const input = {
      reviews: [at(1), at(29), at(40)],
      now: NOW,
      windowDays: 30,
      coveredPlatforms: ["google"],
      excludedPlatforms: [] as string[],
    };
    expect(computeReviewVelocity(input)).toEqual(computeReviewVelocity(input));
  });
});
