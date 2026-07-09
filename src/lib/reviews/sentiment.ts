/**
 * Deterministic review sentiment classification (doc 05 M15 "sentiment
 * tracking"). Pure — no network, no DB, no LLM, no clock, no randomness: the same
 * review always classifies identically (pinned by a determinism test).
 *
 * RATING FIRST, TEXT AS FALLBACK, HONEST ABOUT WHICH. A numeric rating is the
 * strongest deterministic signal, so it decides when present. With no rating we
 * fall back to a small, fixed lexical count; with neither a rating nor any
 * lexical signal we return `neutral` with basis `unknown` — and the aggregate
 * COUNTS those, so a caller can always see how much of a distribution was
 * genuinely undetermined vs. measured. Nothing here fabricates a positive to fill
 * a gap.
 *
 * SCOPE (honest, like the compliance/grounding disclaimers): this is a coarse
 * 3-way classifier for trend/aggregate signal, NOT nuanced opinion mining. Its
 * thresholds are doc-silent launch defaults (⚑ REVIEW_SIGNAL_THRESHOLD_FLAGS).
 */

import {
  REVIEW_SIGNAL_THRESHOLD_FLAGS,
  type IngestedReview,
  type ReviewSentiment,
  type SentimentClassification,
  type SentimentDistribution,
} from "./types";

/** Bound the text scan so a pathological review body can't blow up work. */
const MAX_SCAN_CHARS = 20_000;

/** Fixed positive lexicon (word-boundary matched). Deliberately small + stable. */
const POSITIVE_MARKERS: readonly string[] = [
  "great", "excellent", "amazing", "wonderful", "fantastic", "perfect",
  "love", "loved", "recommend", "helpful", "friendly", "professional",
  "happy", "awesome", "outstanding", "attentive", "responsive", "thank",
];

/** Fixed negative lexicon (word-boundary matched). */
const NEGATIVE_MARKERS: readonly string[] = [
  "terrible", "awful", "worst", "horrible", "rude", "disappointed",
  "disappointing", "poor", "bad", "avoid", "waste", "scam", "unprofessional",
  "refund", "overpriced", "slow", "ignored", "never",
];

/** Word-ish boundary: a string edge ("") or a non-alphanumeric char (mirrors ground.ts). */
function isBoundaryChar(ch: string): boolean {
  return ch === "" || !/[a-z0-9]/.test(ch);
}

/** Count how many DISTINCT markers appear as bounded tokens in `lower`. */
function countMarkers(lower: string, markers: readonly string[]): number {
  let hits = 0;
  for (const marker of markers) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(marker, from);
      if (at === -1) break;
      const before = at === 0 ? "" : lower[at - 1];
      const after = lower[at + marker.length] ?? "";
      if (isBoundaryChar(before) && isBoundaryChar(after)) {
        hits += 1;
        break; // count each distinct marker at most once
      }
      from = at + marker.length;
    }
  }
  return hits;
}

/**
 * Classify one review. A valid numeric rating on a valid scale decides via the
 * normalized thresholds (basis `rating`); otherwise a fixed lexical count decides
 * (basis `lexical`); with no signal at all, `neutral`/`unknown`.
 */
export function classifyReviewSentiment(review: IngestedReview): SentimentClassification {
  const { rating, ratingScale } = review;
  const scaleOk = typeof ratingScale === "number" && Number.isFinite(ratingScale) && ratingScale > 0;
  const ratingOk = typeof rating === "number" && Number.isFinite(rating) && rating >= 0;

  if (ratingOk && scaleOk) {
    const normalized = Math.min(rating / ratingScale, 1);
    const sentiment: ReviewSentiment =
      normalized >= REVIEW_SIGNAL_THRESHOLD_FLAGS.sentimentPositiveAt
        ? "positive"
        : normalized < REVIEW_SIGNAL_THRESHOLD_FLAGS.sentimentNegativeBelow
          ? "negative"
          : "neutral";
    return { sentiment, basis: "rating" };
  }

  // No usable rating — fall back to a bounded lexical count over the text.
  const text = typeof review.text === "string" ? review.text : "";
  const lower = (text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text).toLowerCase();
  const pos = countMarkers(lower, POSITIVE_MARKERS);
  const neg = countMarkers(lower, NEGATIVE_MARKERS);
  if (pos === 0 && neg === 0) return { sentiment: "neutral", basis: "unknown" };
  const sentiment: ReviewSentiment = pos > neg ? "positive" : neg > pos ? "negative" : "neutral";
  return { sentiment, basis: "lexical" };
}

/**
 * Aggregate sentiment over a set of ingested reviews — counts only (no PII).
 * `unknownBasis` tracks how many were classified with no rating AND no lexical
 * signal, so the distribution never overstates its own certainty.
 */
export function aggregateSentiment(reviews: readonly IngestedReview[]): SentimentDistribution {
  const dist: SentimentDistribution = { positive: 0, neutral: 0, negative: 0, unknownBasis: 0, total: 0 };
  for (const review of reviews) {
    const { sentiment, basis } = classifyReviewSentiment(review);
    dist[sentiment] += 1;
    if (basis === "unknown") dist.unknownBasis += 1;
    dist.total += 1;
  }
  return dist;
}
