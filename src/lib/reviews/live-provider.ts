import "server-only";

/**
 * Production wiring for the M15 review-monitoring provider — the seam the action
 * tests vi.mock so no test ever touches the network or a vendor SDK (mirrors
 * src/lib/production/content/live-provider.ts and the audit live-fetch seam).
 *
 * DEFERRED VENDOR. The real adapter (Google Business Profile / Yelp / an
 * aggregator, reading a vault secret per doc 04 §5) is NOT yet provisioned, so
 * this module ships a provider whose `fetchReviews()` FAILS CLOSED with a
 * content-free sentinel. The monitor treats every such platform as EXCLUDED (a
 * named, honest exclusion) — never as "zero reviews", never a 500.
 *
 * WIRING-TIME GATE (like the write-methods first-live-connect canaries + the
 * content-generation deferral): when a review-source secret is provisioned, the
 * vendor adapter is implemented HERE, behind the {@link ReviewPlatformProvider}
 * port — the ONLY file that may import a review-vendor SDK. Ingested reviews then
 * flow through the SAME sentiment/velocity/signal pipeline this module ships.
 */

import type { ReviewFetchResult, ReviewPlatformProvider } from "./provider";

/** Content-free sentinel — carries no account ref, secret, or client data. */
export const REVIEW_MONITOR_DEFERRED =
  "Review monitoring is not available yet: the review-platform adapter is deferred until a " +
  "review-source secret is provisioned. No reviews were fetched.";

/**
 * The runtime provider. Until a vendor adapter is wired it fails closed; the
 * monitor catches the throw and marks the platform excluded. Deliberately NOT
 * importing any vendor SDK keeps every tested code path SDK-free.
 */
export function resolveReviewPlatformProvider(): ReviewPlatformProvider {
  return {
    vendor: "review-monitor-deferred",
    fetchReviews(): Promise<ReviewFetchResult> {
      return Promise.reject(new Error(REVIEW_MONITOR_DEFERRED));
    },
  };
}
