/**
 * M15 MONITOR — ingest reviews across the requested platforms through the
 * {@link ReviewPlatformProvider} port (doc 05 M15). Pure w.r.t. the platform: the
 * provider is INJECTED (port + injected client only, no vendor SDK in tested
 * paths), no DB, no logging (review text is client data and must never ride a log
 * line — the action owns the one redacted telemetry line).
 *
 * THE HONESTY RULE THIS FILE ENFORCES: a platform whose fetch THROWS (unavailable
 * / unconnected / deferred) is recorded as EXCLUDED and NAMED — it is NOT added to
 * `coveredPlatforms` and contributes ZERO reviews to the ingest set, but it is
 * never silently treated as "this platform has no reviews". A platform that
 * successfully returns an empty list IS covered (an honest "connected, none yet").
 * Downstream sentiment/velocity therefore compute only over real reviews from
 * genuinely-connected platforms, and always know which platforms they exclude.
 */

import type { IngestedReview } from "./types";
import type { ReviewFetchRequest, ReviewPlatformProvider } from "./provider";

/** Bound the ingest so a pathological platform response can't blow up work. */
const MAX_REVIEWS = 5_000;

export interface MonitorRequest {
  /** One entry per platform+account to pull (an empty list ingests nothing). */
  pulls: ReviewFetchRequest[];
}

/** A platform that could not be monitored — named, with why (never counted as zero). */
export interface ExcludedPlatform {
  platform: string;
  reason: "unavailable";
}

export interface MonitorResult {
  /** All real reviews ingested from connected platforms (deduped by platform+externalId). */
  reviews: IngestedReview[];
  /** Platforms that returned successfully (connected) — the ones counts may cover. */
  coveredPlatforms: string[];
  /** Requested platforms whose fetch failed — excluded from all denominators, named. */
  excludedPlatforms: ExcludedPlatform[];
}

/**
 * Ingest reviews across every requested platform. Each pull is independent: one
 * platform being unavailable never fails the others (it is excluded). Reviews are
 * deduped by (platform, externalId) where an id is present, and bounded. The
 * provider is called once per pull; order of `pulls` is preserved for determinism.
 */
export async function ingestReviews(
  provider: ReviewPlatformProvider,
  request: MonitorRequest,
): Promise<MonitorResult> {
  const reviews: IngestedReview[] = [];
  const coveredPlatforms: string[] = [];
  const excludedPlatforms: ExcludedPlatform[] = [];
  const seen = new Set<string>();
  const coveredSet = new Set<string>();
  const excludedSet = new Set<string>();

  for (const pull of request.pulls) {
    let result;
    try {
      result = await provider.fetchReviews(pull);
    } catch {
      // Unavailable/unconnected: EXCLUDE + NAME. Never invents an empty result.
      if (!excludedSet.has(pull.platform)) {
        excludedSet.add(pull.platform);
        excludedPlatforms.push({ platform: pull.platform, reason: "unavailable" });
      }
      continue;
    }

    if (!coveredSet.has(pull.platform)) {
      coveredSet.add(pull.platform);
      coveredPlatforms.push(pull.platform);
    }

    for (const review of result.reviews) {
      if (reviews.length >= MAX_REVIEWS) break;
      const key =
        typeof review.externalId === "string" && review.externalId !== ""
          ? JSON.stringify([review.platform, review.externalId])
          : null;
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      reviews.push(review);
    }
  }

  // A platform can appear covered AND (from a separate failed pull) excluded — keep
  // it covered (it did return once) but still surface the excluded pull honestly.
  return { reviews, coveredPlatforms, excludedPlatforms };
}
