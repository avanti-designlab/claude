/**
 * M15 Review management — shared types (doc 05 Part C M15; doc 07 §1.6).
 *
 * M15 owns four things inside the reputation surface (doc 05 M15): MONITOR
 * reviews across Google/Yelp/etc. (a deferred vendor connector, like
 * CitationDataProvider), compute deterministic SENTIMENT + review VELOCITY over
 * the ingested reviews, DRAFT on-brand responses through the content pipeline,
 * and persist the review SIGNAL. It generates; it never approves and never
 * auto-sends (CLAUDE.md rule 5; doc 00 §2). A drafted response is a
 * PRE-APPROVAL artifact — content-quality + compliance-review are the hard gates.
 *
 * HONESTY SPINE (stated up front, enforced throughout):
 *  - A platform that is NOT connected is EXCLUDED and NAMED — never counted as
 *    zero reviews (which would falsely depress velocity / hide a negative spike).
 *  - Sentiment is computed only over REAL ingested reviews; a review we cannot
 *    classify is `unknown`-basis, never a fabricated positive.
 *  - Velocity always states its window and which platforms it covers.
 *  - Nothing invents a review: the monitor port returns reviews or is
 *    unavailable — there is no "assume none" path.
 */

import type { MetricSource } from "@/lib/types/db";

/* ------------------------------------------------------------------ */
/* Platforms + one ingested review                                     */
/* ------------------------------------------------------------------ */

/**
 * The review platforms M15 monitors (doc 05 M15). OPEN set — a `string` on the
 * wire (like `SocialAccountRef.platform`), because new platforms onboard behind
 * the connector without a type change. This is the KNOWN set for UI/labels only.
 */
export const KNOWN_REVIEW_PLATFORMS = [
  "google",
  "yelp",
  "tripadvisor",
  "trustpilot",
  "bbb",
  "facebook",
] as const;
export type KnownReviewPlatform = (typeof KNOWN_REVIEW_PLATFORMS)[number];

/**
 * One review as ingested from a platform, normalized into OUR shape (the
 * connector doctrine, doc 04 §7: normalize every vendor response before use, so
 * modules never see a vendor payload). `rating` is on `ratingScale` (default 5);
 * a platform that returns no numeric rating leaves it null (honest — not 0).
 */
export interface IngestedReview {
  /** The source platform (open string; a KNOWN_REVIEW_PLATFORMS value where recognized). */
  platform: string;
  /** Reviewer display name, if the platform provides one. Null otherwise (never invented). */
  author: string | null;
  /** Raw star/score rating on `ratingScale`; null when the platform gave none. */
  rating: number | null;
  /** The scale `rating` is on (e.g. 5 for a 5-star system). */
  ratingScale: number;
  /** The review body text (may be empty for a rating-only review). */
  text: string;
  /** ISO-8601 date the review was posted; null when the platform didn't provide it. */
  postedAt: string | null;
  /** The platform's opaque review id — for dedup only. NEVER a credential. */
  externalId: string | null;
}

/* ------------------------------------------------------------------ */
/* Sentiment                                                           */
/* ------------------------------------------------------------------ */

export type ReviewSentiment = "positive" | "neutral" | "negative";

/**
 * HOW a review was classified — carried so aggregates stay honest about their
 * evidence: `rating` (a numeric rating drove it), `lexical` (no rating, decided
 * from text markers), `unknown` (no rating AND no text signal — defaulted to
 * neutral, and COUNTED as unknown so a caller can see how much was undetermined).
 */
export type SentimentBasis = "rating" | "lexical" | "unknown";

export interface SentimentClassification {
  sentiment: ReviewSentiment;
  basis: SentimentBasis;
}

/** Aggregate sentiment over a set of ingested reviews (counts only — no PII). */
export interface SentimentDistribution {
  positive: number;
  neutral: number;
  negative: number;
  /** How many of the above were `unknown`-basis (no rating + no lexical signal). */
  unknownBasis: number;
  total: number;
}

/* ------------------------------------------------------------------ */
/* Velocity                                                            */
/* ------------------------------------------------------------------ */

export type VelocityTrend = "rising" | "flat" | "falling";

/**
 * Deterministic review-velocity over a stated window. Every count names the
 * window it covers and the platforms it was computed from; a requested-but-
 * unavailable platform is listed in `excludedPlatforms`, NEVER folded into the
 * denominator as zero.
 */
export interface ReviewVelocity {
  windowDays: number;
  /** The reference "now" (window end), ISO — injected, never read from a clock. */
  windowEnd: string;
  /** Reviews posted within the current window [now - windowDays, now]. */
  currentCount: number;
  /** Reviews in the immediately-prior window [now - 2·windowDays, now - windowDays]. */
  priorCount: number;
  /** currentCount / windowDays — the per-day rate over the stated window. */
  perDay: number;
  trend: VelocityTrend;
  /** currentCount − priorCount (the movement the trend summarizes). */
  delta: number;
  /** Reviews with no parseable `postedAt` — excluded from the buckets (can't place in time). */
  undatedCount: number;
  /** Platforms these counts cover (the connected ones). */
  coveredPlatforms: string[];
  /** Requested-but-unavailable platforms — excluded from denominators, named not zeroed. */
  excludedPlatforms: string[];
}

/* ------------------------------------------------------------------ */
/* The review SIGNAL (the persisted aggregate — feeds M17 + dashboard) */
/* ------------------------------------------------------------------ */

/**
 * The aggregate M15 persists (to `metrics`, source='reviews' — the honest home,
 * see rows.ts) and surfaces to the dashboard; it feeds M17's
 * `negative_review_spike` alert and local rankings (doc 05 M15). Counts +
 * platform coverage + window ONLY — never individual review text/author (that is
 * neither needed for the signal nor persisted; see REVIEWS_TABLE_GAP).
 */
export interface ReviewSignal {
  windowDays: number;
  /** The reference "now" this signal was computed for (ISO). */
  capturedFor: string;
  totalIngested: number;
  undatedCount: number;
  coveredPlatforms: string[];
  excludedPlatforms: string[];
  sentiment: SentimentDistribution;
  velocity: {
    currentCount: number;
    priorCount: number;
    perDay: number;
    trend: VelocityTrend;
    delta: number;
  };
}

/* ------------------------------------------------------------------ */
/* The honest home + doc-silent thresholds (⚑ ratify)                  */
/* ------------------------------------------------------------------ */

/** The `metrics.source` M15 writes — the ONLY source it ever touches. */
export const REVIEW_METRIC_SOURCE = "reviews" as const satisfies MetricSource;

/**
 * Sentiment + velocity thresholds are doc-silent — flagged for ratification
 * against real client data at Gate 1a (mirrors the aeo-audit review-velocity +
 * M9 authenticity ⚑ ratify lists already in BUILD-STATE):
 *  - SENTIMENT (rating-based): normalized rating ≥ 0.7 → positive; < 0.5 →
 *    negative; else neutral (5-star: 4–5 pos, 3 neutral, 1–2 neg).
 *  - VELOCITY default window: 30 days (doc 05 hyper-local review cadence).
 */
export const REVIEW_SIGNAL_THRESHOLD_FLAGS = {
  sentimentPositiveAt: 0.7,
  sentimentNegativeBelow: 0.5,
  defaultWindowDays: 30,
} as const;
