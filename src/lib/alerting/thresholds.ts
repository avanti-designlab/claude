/**
 * M17 — fire thresholds + severity mapping (doc 05 §M17). PURE + deterministic.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚑ DOC-SILENT — RATIFY BEFORE CLIENT-FACING LAUNCH (added to the BUILD-STATE ⚑
 * list, alongside the M3 score formula, M4 lead-margin, M6 decay window, and M9
 * detection thresholds). doc 05 §M17 names WHICH classes alert but is SILENT on
 * HOW BIG a drop / WHAT velocity fires one, and on the severity bands. Every
 * magnitude below is a 1.8 engineering default — defensible and documented, not
 * doctrine. Changing a fire line re-shapes what pages an operator; changing a
 * severity band re-colours the dashboard. Decide against real GG data early.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Two honesty invariants hold regardless of the numbers:
 *  - A rule fires ONLY on a real measured signal (types.ts). A threshold is
 *    never applied to a missing/`unknown` value — there is no signal to test.
 *  - Severity is a total, deterministic function of the measured signal; the
 *    same signal always yields the same severity.
 */

import type {
  AlertSeverity,
  CompetitorOvertookSignal,
  ReviewSpikeSignal,
  VisibilityDropSignal,
} from "./types";

/* ------------------------------------------------------------------ */
/* visibility_drop — run-over-run points lost on the 0–100 score.      */
/* Below FIRE: noise, no alert. info < WARNING ≤ warning < CRITICAL.   */
/* ------------------------------------------------------------------ */

export const VISIBILITY_DROP_FIRE_POINTS = 10;
export const VISIBILITY_DROP_WARNING_POINTS = 15;
export const VISIBILITY_DROP_CRITICAL_POINTS = 25;

/** Points dropped (>0 means the score fell), or ≤0 when it held/rose. */
export function visibilityDropPoints(signal: VisibilityDropSignal): number {
  return signal.previousScore - signal.latestScore;
}

/** True iff the measured drop clears the fire line (a real, notable drop). */
export function isVisibilityDrop(signal: VisibilityDropSignal): boolean {
  return visibilityDropPoints(signal) >= VISIBILITY_DROP_FIRE_POINTS;
}

export function visibilityDropSeverity(signal: VisibilityDropSignal): AlertSeverity {
  const points = visibilityDropPoints(signal);
  if (points >= VISIBILITY_DROP_CRITICAL_POINTS) return "critical";
  if (points >= VISIBILITY_DROP_WARNING_POINTS) return "warning";
  return "info";
}

/* ------------------------------------------------------------------ */
/* competitor_overtook — measured share-of-voice crossing (share 0..1).*/
/* MARGIN is anti-flap: the competitor must clear the client by ≥5 pts  */
/* THIS run, having been level-or-behind LAST run. CRITICAL when the    */
/* new lead is a rout (≥25 pts).                                        */
/* ------------------------------------------------------------------ */

export const COMPETITOR_OVERTOOK_MARGIN = 0.05;
export const COMPETITOR_OVERTOOK_CRITICAL_MARGIN = 0.25;

/** True iff the competitor was level-or-behind last run and is now ahead by ≥ MARGIN. */
export function isCompetitorOvertook(signal: CompetitorOvertookSignal): boolean {
  const wasBehindOrLevel = signal.previousCompetitorShare <= signal.previousClientShare;
  const nowAheadByMargin = signal.competitorShare - signal.clientShare >= COMPETITOR_OVERTOOK_MARGIN;
  return wasBehindOrLevel && nowAheadByMargin;
}

export function competitorOvertookSeverity(signal: CompetitorOvertookSignal): AlertSeverity {
  const lead = signal.competitorShare - signal.clientShare;
  return lead >= COMPETITOR_OVERTOOK_CRITICAL_MARGIN ? "critical" : "warning";
}

/* ------------------------------------------------------------------ */
/* negative_review_spike — measured negatives vs a measured baseline.  */
/* Fire needs BOTH an absolute floor (≥3 negatives — one angry review   */
/* is not a spike) AND a ratio over baseline (≥2×). CRITICAL at ≥4×.    */
/* A zero/near-zero baseline is handled by the absolute floor alone.    */
/* ------------------------------------------------------------------ */

export const REVIEW_SPIKE_MIN_NEGATIVE = 3;
export const REVIEW_SPIKE_RATIO = 2;
export const REVIEW_SPIKE_CRITICAL_RATIO = 4;

/** Spike ratio vs baseline; when baseline is 0, any negatives read as "above baseline". */
export function reviewSpikeRatio(signal: ReviewSpikeSignal): number {
  if (signal.baselineNegativePerWindow <= 0) {
    return signal.negativeCount > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  return signal.negativeCount / signal.baselineNegativePerWindow;
}

export function isReviewSpike(signal: ReviewSpikeSignal): boolean {
  if (signal.negativeCount < REVIEW_SPIKE_MIN_NEGATIVE) return false;
  return reviewSpikeRatio(signal) >= REVIEW_SPIKE_RATIO;
}

export function reviewSpikeSeverity(signal: ReviewSpikeSignal): AlertSeverity {
  return reviewSpikeRatio(signal) >= REVIEW_SPIKE_CRITICAL_RATIO ? "critical" : "warning";
}

/* ------------------------------------------------------------------ */
/* schema_broke — a published structured-data block failed verification.*/
/* Fixed CRITICAL: broken JSON-LD removes rich-result / citation        */
/* eligibility, which is the whole point of M10. ⚑ Per-schema-type      */
/* severity tuning (a broken Breadcrumb < a broken LocalBusiness) is a  */
/* ratify follow-up — deliberately NOT guessed here.                    */
/* ------------------------------------------------------------------ */

export const SCHEMA_BROKE_SEVERITY: AlertSeverity = "critical";

/* ------------------------------------------------------------------ */
/* site_down — origin unreachable or 5xx. Always CRITICAL. Fire needs a */
/* measured DOWN reading: unreachable (status null) OR status ≥ 500. A  */
/* 4xx is "up but erroring" — NOT treated as down (⚑ ratify: whether a  */
/* base-URL 404 should page).                                           */
/* ------------------------------------------------------------------ */

export const SITE_DOWN_SEVERITY: AlertSeverity = "critical";

/** True iff the probe measured the origin as down (unreachable or 5xx). */
export function isSiteDown(httpStatus: number | null): boolean {
  return httpStatus === null || httpStatus >= 500;
}
