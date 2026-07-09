/**
 * Deterministic sentiment classification (M15). Rating-first, lexical fallback,
 * honest about basis; classifies only real ingested reviews.
 */

import { describe, expect, it } from "vitest";
import { aggregateSentiment, classifyReviewSentiment } from "./sentiment";
import type { IngestedReview } from "./types";

function review(over: Partial<IngestedReview> = {}): IngestedReview {
  return {
    platform: "google",
    author: null,
    rating: null,
    ratingScale: 5,
    text: "",
    postedAt: null,
    externalId: null,
    ...over,
  };
}

describe("classifyReviewSentiment — rating decides (basis 'rating')", () => {
  it("5/5 and 4/5 are positive; 3/5 neutral; 2/5 and 1/5 negative", () => {
    expect(classifyReviewSentiment(review({ rating: 5 }))).toEqual({ sentiment: "positive", basis: "rating" });
    expect(classifyReviewSentiment(review({ rating: 4 }))).toEqual({ sentiment: "positive", basis: "rating" });
    expect(classifyReviewSentiment(review({ rating: 3 }))).toEqual({ sentiment: "neutral", basis: "rating" });
    expect(classifyReviewSentiment(review({ rating: 2 }))).toEqual({ sentiment: "negative", basis: "rating" });
    expect(classifyReviewSentiment(review({ rating: 1 }))).toEqual({ sentiment: "negative", basis: "rating" });
  });

  it("normalizes a non-5 scale (8/10 positive, 5/10 neutral, 3/10 negative)", () => {
    expect(classifyReviewSentiment(review({ rating: 8, ratingScale: 10 })).sentiment).toBe("positive");
    expect(classifyReviewSentiment(review({ rating: 5, ratingScale: 10 })).sentiment).toBe("neutral");
    expect(classifyReviewSentiment(review({ rating: 3, ratingScale: 10 })).sentiment).toBe("negative");
  });

  it("rating wins even when the text markers disagree (rating is the stronger signal)", () => {
    // 5 stars but a bitter body — rating decides, basis 'rating'.
    const c = classifyReviewSentiment(review({ rating: 5, text: "terrible awful worst" }));
    expect(c).toEqual({ sentiment: "positive", basis: "rating" });
  });
});

describe("classifyReviewSentiment — lexical fallback (no usable rating)", () => {
  it("counts positive vs negative markers (basis 'lexical')", () => {
    expect(classifyReviewSentiment(review({ text: "Great and helpful and friendly" }))).toEqual({
      sentiment: "positive",
      basis: "lexical",
    });
    expect(classifyReviewSentiment(review({ text: "rude and slow, a total waste" }))).toEqual({
      sentiment: "negative",
      basis: "lexical",
    });
  });

  it("word-boundary aware — a marker inside a longer word does not hit", () => {
    // "badminton" contains "bad" but must not classify as negative.
    expect(classifyReviewSentiment(review({ text: "we played badminton" }))).toEqual({
      sentiment: "neutral",
      basis: "unknown",
    });
  });

  it("no rating AND no signal → neutral / basis 'unknown' (never a fabricated positive)", () => {
    expect(classifyReviewSentiment(review({ text: "The appointment was on Tuesday." }))).toEqual({
      sentiment: "neutral",
      basis: "unknown",
    });
    expect(classifyReviewSentiment(review({ rating: null, text: "" }))).toEqual({
      sentiment: "neutral",
      basis: "unknown",
    });
  });

  it("a NaN/invalid rating falls back to lexical, not a crash", () => {
    expect(classifyReviewSentiment(review({ rating: Number.NaN, text: "excellent" })).basis).toBe("lexical");
    expect(classifyReviewSentiment(review({ rating: 5, ratingScale: 0, text: "excellent" })).basis).toBe("lexical");
  });
});

describe("classifyReviewSentiment — determinism", () => {
  it("same review classifies byte-identically across runs", () => {
    const r = review({ rating: 2, text: "slow and rude" });
    const a = classifyReviewSentiment(r);
    const b = classifyReviewSentiment(r);
    expect(a).toEqual(b);
  });
});

describe("aggregateSentiment — counts only, tracks unknown basis", () => {
  it("distributes and counts unknown-basis reviews", () => {
    const dist = aggregateSentiment([
      review({ rating: 5 }),
      review({ rating: 4 }),
      review({ rating: 3 }),
      review({ rating: 1 }),
      review({ text: "just some neutral note about the weather" }), // unknown
    ]);
    expect(dist).toEqual({ positive: 2, neutral: 2, negative: 1, unknownBasis: 1, total: 5 });
  });

  it("an empty set is all-zero (honest — not fabricated)", () => {
    expect(aggregateSentiment([])).toEqual({ positive: 0, neutral: 0, negative: 0, unknownBasis: 0, total: 0 });
  });
});
