/**
 * ReviewPlatformProvider — the vendor-deferred review-monitoring seam for M15
 * (doc 05 M15; doc 07 §1.6). Modelled on the `CitationDataProvider` PORT pattern
 * (src/lib/connectors/citation-data.ts): the modules call THIS interface, never a
 * vendor SDK, so the review source (Google/Yelp/TripAdvisor/Trustpilot/BBB APIs,
 * or an aggregator) is swappable behind one adapter.
 *
 * READ-ONLY BY CONSTRUCTION — the STRUCTURAL no-auto-send pin (CLAUDE.md rule 5,
 * doc 00 §2). This port exposes ONLY `fetchReviews`. There is deliberately NO
 * `postResponse` / `reply` / `send` method anywhere in M15, so a drafted review
 * response CANNOT be transmitted from this module: publishing a reply would be a
 * separate, human-approved write path (a `SocialPostingProvider`-class connector
 * the integrations engineer wires at 1.7), never fired from the monitor. A
 * producing agent never approves — or sends — its own output.
 *
 * HOME NOTE: the sibling vendor ports (CitationDataProvider, SocialPostingProvider)
 * live in `src/lib/connectors/` (integrations-engineer territory). This one is
 * colocated in `src/lib/reviews/` to respect the M15 module boundary; its
 * long-term home is `connectors/` alongside the others, migrated when the real
 * adapter (the integrations half of M15) lands.
 *
 * DEFERRED VENDOR (like the citation/social real adapters): the real adapter
 * reads an operator/tenant secret from the vault (doc 04 §5) and lands in
 * ./live-provider at wiring time, behind this port. This module ships ONLY the
 * interface + a scriptable in-memory fake so the monitor/sentiment/velocity
 * pipeline can be built and tested with ZERO network and NO vendor SDK.
 */

import type { IngestedReview } from "./types";

/* ------------------------------------------------------------------ */
/* Interface (read-only)                                               */
/* ------------------------------------------------------------------ */

/** One monitoring pull: the platform + the opaque account ref (NEVER a credential). */
export interface ReviewFetchRequest {
  /** e.g. "google", "yelp" — an open string (KnownReviewPlatform where recognized). */
  platform: string;
  /** Provider-side account/location reference — opaque, never a secret (doc 03 §5). */
  accountRef: string;
  /** Optional incremental pull: only reviews posted at/after this ISO date. */
  since?: string;
}

/** The normalized result of one pull — reviews only (no vendor payload leaks out). */
export interface ReviewFetchResult {
  reviews: IngestedReview[];
}

/**
 * The provider-agnostic review-monitoring connector. Implementations:
 * `<Vendor>ReviewAdapter` (deferred) plus {@link ScriptedReviewPlatformProvider}
 * for tests. Vendor keys live in the secrets vault, resolved at call time by the
 * adapter — NEVER constructor-visible state on this interface. NOTE the single
 * method: monitoring is read-only; nothing here can write a reply.
 */
export interface ReviewPlatformProvider {
  /** Stable vendor id for provenance, e.g. "google-business", "scripted-fake". */
  readonly vendor: string;
  /** Fetch reviews for ONE platform+account. Unavailable ⇒ throw (never invents reviews). */
  fetchReviews(request: ReviewFetchRequest): Promise<ReviewFetchResult>;
}

/* ------------------------------------------------------------------ */
/* Scriptable fake (M15 tests; no vendor account, no SDK, no network)  */
/* ------------------------------------------------------------------ */

/** A scripted rule: first matching rule (by platform) wins. */
export interface ReviewScript {
  /** Match this platform (omit to match any). */
  platform?: string;
  /** The reviews this platform returns. */
  reviews: IngestedReview[];
}

/**
 * Scriptable, journaling test double. Behaves like a vendor adapter without any
 * network or SDK: script per-platform reviews, then assert on `calls`. Fault
 * injection via `failNext` exercises the platform-unavailable path (the monitor
 * must EXCLUDE such a platform, never treat it as zero reviews). An unscripted
 * platform returns an empty result — an HONEST "connected, no reviews" (distinct
 * from unavailable), which the monitor counts as covered-with-zero.
 */
export class ScriptedReviewPlatformProvider implements ReviewPlatformProvider {
  readonly vendor = "scripted-fake";
  readonly calls: ReviewFetchRequest[] = [];
  private scripts: ReviewScript[] = [];
  private failPlatforms = new Set<string>();
  private failAllOnce = false;

  script(rule: ReviewScript): this {
    this.scripts.push(rule);
    return this;
  }

  /** The next fetch for `platform` (or the next fetch, any platform) rejects — "platform unavailable". */
  failNext(platform?: string): this {
    if (platform === undefined) this.failAllOnce = true;
    else this.failPlatforms.add(platform);
    return this;
  }

  async fetchReviews(request: ReviewFetchRequest): Promise<ReviewFetchResult> {
    this.calls.push(request);
    if (this.failAllOnce) {
      this.failAllOnce = false;
      throw new Error(`review platform '${request.platform}' unavailable`);
    }
    if (this.failPlatforms.has(request.platform)) {
      this.failPlatforms.delete(request.platform);
      throw new Error(`review platform '${request.platform}' unavailable`);
    }
    const rule = this.scripts.find((s) => s.platform === undefined || s.platform === request.platform);
    return { reviews: rule ? [...rule.reviews] : [] };
  }
}
