/**
 * Deterministic review-velocity (doc 05 M15 "velocity alerts (feeds M17)"). Pure
 * — no clock, no randomness: the reference "now" is INJECTED (the action owns the
 * clock), so the same reviews + same `now` always yield the same velocity (pinned
 * by a determinism test).
 *
 * HONESTY OF THE WINDOW + THE DENOMINATOR:
 *  - The result always states `windowDays` and `windowEnd` — a velocity number
 *    with no window is noise (doc 05: the trend line is the product, not a
 *    snapshot).
 *  - `coveredPlatforms` are the connected ones the counts came from;
 *    `excludedPlatforms` (requested but unavailable) are listed, NOT folded into
 *    the denominator as zero — an unconnected platform must never look like "no
 *    new reviews" and mask a negative spike.
 *  - Reviews with no parseable `postedAt` are counted in `undatedCount` and
 *    EXCLUDED from the time buckets (we cannot honestly place them in a window).
 */

import type { IngestedReview, ReviewVelocity, VelocityTrend } from "./types";
import { REVIEW_SIGNAL_THRESHOLD_FLAGS } from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface VelocityInput {
  reviews: readonly IngestedReview[];
  /** The reference "now" (window end), ISO — injected, never a clock read. */
  now: string;
  /** Window length in days; defaults to the doc-silent launch default (⚑ ratify). */
  windowDays?: number;
  /** Platforms the reviews were actually pulled from (the connected ones). */
  coveredPlatforms: readonly string[];
  /** Requested-but-unavailable platforms — named, not zeroed. */
  excludedPlatforms: readonly string[];
}

function parseMs(iso: string | null): number | null {
  if (typeof iso !== "string" || iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Clamp a caller window to a sane positive integer (defends the buckets from junk). */
function resolveWindowDays(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    return REVIEW_SIGNAL_THRESHOLD_FLAGS.defaultWindowDays;
  }
  return Math.min(Math.floor(raw), 3650); // ≤ 10 years — a hard upper bound
}

/**
 * Compute velocity over the reviews for a stated window ending at `now`. Reviews
 * are bucketed into the current window [now − w, now] and the prior window
 * [now − 2w, now − w]; the trend is the sign of (current − prior). Undated and
 * out-of-both-windows reviews affect neither count (honestly). Deterministic.
 */
export function computeReviewVelocity(input: VelocityInput): ReviewVelocity {
  const windowDays = resolveWindowDays(input.windowDays);
  const nowMs = parseMs(input.now) ?? 0;
  const windowMs = windowDays * MS_PER_DAY;
  const currentFrom = nowMs - windowMs;
  const priorFrom = nowMs - 2 * windowMs;

  let currentCount = 0;
  let priorCount = 0;
  let undatedCount = 0;

  for (const review of input.reviews) {
    const ms = parseMs(review.postedAt);
    if (ms === null) {
      undatedCount += 1;
      continue;
    }
    // Current window is inclusive of `now`; prior window is [priorFrom, currentFrom).
    if (ms > currentFrom && ms <= nowMs) currentCount += 1;
    else if (ms > priorFrom && ms <= currentFrom) priorCount += 1;
  }

  const delta = currentCount - priorCount;
  const trend: VelocityTrend = delta > 0 ? "rising" : delta < 0 ? "falling" : "flat";

  return {
    windowDays,
    windowEnd: input.now,
    currentCount,
    priorCount,
    perDay: currentCount / windowDays,
    trend,
    delta,
    undatedCount,
    coveredPlatforms: [...input.coveredPlatforms],
    excludedPlatforms: [...input.excludedPlatforms],
  };
}
