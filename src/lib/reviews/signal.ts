/**
 * Build the review SIGNAL — the aggregate M15 persists (to `metrics`,
 * source='reviews') and feeds to M17 (`negative_review_spike`) + the dashboard
 * (doc 05 M15). Pure — combines the deterministic sentiment distribution and the
 * velocity over ONE monitor result. Counts + platform coverage + window ONLY:
 * never individual review text/author (not needed for the signal, and there is no
 * honest home to persist raw reviews — see REVIEWS_TABLE_GAP).
 *
 * M15 computes + persists the signal; it does NOT write `alerts` — raising
 * `negative_review_spike` from the signal is M17's job (this module stays in its
 * lane, like M4/M6 which persist their own outputs and let M17 alert).
 */

import { aggregateSentiment } from "./sentiment";
import { computeReviewVelocity } from "./velocity";
import type { MonitorResult } from "./monitor";
import type { ReviewSignal } from "./types";

export interface BuildReviewSignalInput {
  monitor: MonitorResult;
  /** The reference "now" (window end), ISO — injected by the action (owns the clock). */
  now: string;
  /** Window length in days (stated in the signal); defaults inside velocity. */
  windowDays?: number;
}

/**
 * Assemble the {@link ReviewSignal} from a monitor result. Sentiment is computed
 * over the ingested reviews; velocity over the same reviews for the stated window,
 * carrying the covered/excluded platform split through so the persisted signal is
 * self-describing (which platforms it measured, which it could not).
 */
export function buildReviewSignal(input: BuildReviewSignalInput): ReviewSignal {
  const { monitor, now, windowDays } = input;
  const excludedNames = monitor.excludedPlatforms.map((e) => e.platform);

  const sentiment = aggregateSentiment(monitor.reviews);
  const velocity = computeReviewVelocity({
    reviews: monitor.reviews,
    now,
    windowDays,
    coveredPlatforms: monitor.coveredPlatforms,
    excludedPlatforms: excludedNames,
  });

  return {
    windowDays: velocity.windowDays,
    capturedFor: now,
    totalIngested: monitor.reviews.length,
    undatedCount: velocity.undatedCount,
    coveredPlatforms: [...monitor.coveredPlatforms],
    excludedPlatforms: excludedNames,
    sentiment,
    velocity: {
      currentCount: velocity.currentCount,
      priorCount: velocity.priorCount,
      perDay: velocity.perDay,
      trend: velocity.trend,
      delta: velocity.delta,
    },
  };
}
