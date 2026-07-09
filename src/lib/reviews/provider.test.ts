/**
 * The ReviewPlatformProvider PORT — read-only (the structural no-send pin) + its
 * scriptable fake + the deferred live provider (fails closed).
 */

import { describe, expect, it, vi } from "vitest";
import { ScriptedReviewPlatformProvider } from "./provider";
import { REVIEW_MONITOR_DEFERRED, resolveReviewPlatformProvider } from "./live-provider";
import type { IngestedReview } from "./types";

// ./live-provider imports "server-only" (it is the deferred vendor seam) — stub it
// so this pure-unit suite can exercise the fail-closed resolver.
vi.mock("server-only", () => ({}));

function review(over: Partial<IngestedReview> = {}): IngestedReview {
  return {
    platform: "google",
    author: "A. Reviewer",
    rating: 5,
    ratingScale: 5,
    text: "Great service.",
    postedAt: "2026-07-01T00:00:00Z",
    externalId: "g-1",
    ...over,
  };
}

describe("ReviewPlatformProvider is READ-ONLY (no reply/post/send exists)", () => {
  it("the port surface is fetch-only — no method can transmit a reply", () => {
    const p = new ScriptedReviewPlatformProvider();
    // The provider exposes ONLY fetchReviews (+ test-double helpers). There is no
    // post/reply/send — a review response can never be sent through this module.
    expect(typeof p.fetchReviews).toBe("function");
    expect((p as unknown as Record<string, unknown>).postResponse).toBeUndefined();
    expect((p as unknown as Record<string, unknown>).reply).toBeUndefined();
    expect((p as unknown as Record<string, unknown>).send).toBeUndefined();
  });
});

describe("ScriptedReviewPlatformProvider — journaling fake", () => {
  it("returns scripted reviews per platform and records calls", async () => {
    const p = new ScriptedReviewPlatformProvider()
      .script({ platform: "google", reviews: [review({ externalId: "g-1" })] })
      .script({ platform: "yelp", reviews: [review({ platform: "yelp", externalId: "y-1" })] });

    const g = await p.fetchReviews({ platform: "google", accountRef: "acct-g" });
    const y = await p.fetchReviews({ platform: "yelp", accountRef: "acct-y" });
    expect(g.reviews).toHaveLength(1);
    expect(y.reviews[0].platform).toBe("yelp");
    expect(p.calls.map((c) => c.platform)).toEqual(["google", "yelp"]);
  });

  it("an unscripted platform returns an EMPTY result (connected, none) — not unavailable", async () => {
    const p = new ScriptedReviewPlatformProvider();
    const res = await p.fetchReviews({ platform: "bbb", accountRef: "acct" });
    expect(res.reviews).toEqual([]);
  });

  it("failNext(platform) throws for that platform (the unavailable path)", async () => {
    const p = new ScriptedReviewPlatformProvider().failNext("yelp");
    await expect(p.fetchReviews({ platform: "yelp", accountRef: "acct" })).rejects.toThrow(/unavailable/);
    // Only the next yelp call fails; a subsequent one succeeds (empty).
    await expect(p.fetchReviews({ platform: "yelp", accountRef: "acct" })).resolves.toEqual({ reviews: [] });
  });
});

describe("resolveReviewPlatformProvider — deferred vendor fails closed", () => {
  it("rejects with a content-free sentinel (no account ref, no client data)", async () => {
    const p = resolveReviewPlatformProvider();
    expect(p.vendor).toBe("review-monitor-deferred");
    await expect(p.fetchReviews({ platform: "google", accountRef: "secret-acct" })).rejects.toThrow(
      REVIEW_MONITOR_DEFERRED,
    );
    expect(REVIEW_MONITOR_DEFERRED).not.toContain("secret-acct");
  });
});
