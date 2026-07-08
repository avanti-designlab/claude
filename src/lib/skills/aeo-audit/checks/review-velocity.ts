/**
 * Check 10 — Review velocity: recency and rate per the vertical's
 * expectations (SKILL.md). Expectations scale with local_intensity
 * (doc-silent thresholds — assumption recorded in the build report):
 *   hyper-local: ≥4 new reviews / 30 days, most recent ≤30 days old
 *   semi-local:  ≥1 new review  / 30 days, most recent ≤60 days old
 * Velocity is 60% of the check score, recency 40%. All time math is
 * relative to `site.crawledAt` (deterministic).
 */

import type { CheckContext, CheckOutcome, EvidenceItem, FixDraft } from "../types";
import { clamp, daysBetween, parseIsoMs, pluralize, round1 } from "../util";

const EXPECTATIONS = {
  "hyper-local": { perMonth: 4, recencyDays: 30 },
  "semi-local": { perMonth: 1, recencyDays: 60 },
} as const;

export function checkReviewVelocity(ctx: CheckContext): CheckOutcome {
  const { site, playbook } = ctx;
  const snapshots = site.reviewSnapshots;

  if (snapshots === undefined) {
    return {
      status: "skipped",
      skipReason: "no_data",
      score: null,
      evidence: [{ message: "No review snapshots supplied — connect review monitoring (M15) to score velocity." }],
      fixes: [],
    };
  }

  // National playbooks never reach this check (gated in audit.ts).
  const expectation =
    playbook.local_intensity === "hyper-local" ? EXPECTATIONS["hyper-local"] : EXPECTATIONS["semi-local"];

  const evidence: EvidenceItem[] = [];
  const fixes: FixDraft[] = [];

  let last30Count = 0;
  let mostRecentIso: string | null = null;
  for (const snapshot of snapshots) {
    for (const dateIso of snapshot.recentReviewDates) {
      const age = daysBetween(dateIso, site.crawledAt);
      if (age === null || age < 0) continue; // ignore unparsable/future dates
      if (age <= 30) last30Count += 1;
      if (mostRecentIso === null || (parseIsoMs(dateIso) ?? 0) > (parseIsoMs(mostRecentIso) ?? 0)) {
        mostRecentIso = dateIso;
      }
    }
  }

  const velocityScore = Math.min(last30Count / expectation.perMonth, 1) * 60;
  let recencyScore: number;
  let daysSinceLast: number | null = null;
  if (mostRecentIso === null) {
    recencyScore = 0;
    evidence.push({
      field: "recency",
      found: "no reviews observed",
      message: "No recent reviews observed on any source.",
    });
  } else {
    daysSinceLast = daysBetween(mostRecentIso, site.crawledAt) ?? Number.POSITIVE_INFINITY;
    recencyScore =
      daysSinceLast <= expectation.recencyDays
        ? 40
        : 40 * clamp(1 - (daysSinceLast - expectation.recencyDays) / expectation.recencyDays, 0, 1);
  }

  if (last30Count < expectation.perMonth) {
    evidence.push({
      field: "velocity",
      expected: `≥${expectation.perMonth} reviews in the 30 days before the crawl (${playbook.local_intensity})`,
      found: `${last30Count}`,
      message: `Review velocity below the ${playbook.local_intensity} expectation.`,
    });
  }
  if (daysSinceLast !== null && daysSinceLast > expectation.recencyDays) {
    evidence.push({
      field: "recency",
      expected: `most recent review ≤${expectation.recencyDays} days before the crawl`,
      found: `${Math.round(daysSinceLast)} days`,
      message: "Most recent review is older than the vertical's recency expectation.",
    });
  }

  const score = round1(clamp(velocityScore + recencyScore));

  if (score < 100) {
    fixes.push({
      id: "review_velocity/increase-review-velocity",
      checkId: "review_velocity",
      title: "Increase genuine review velocity",
      detail:
        `Observed ${pluralize(last30Count, "review")} in the last 30 days vs an expectation of ${expectation.perMonth} for a ` +
        `${playbook.local_intensity} vertical. Reviews must come from real customer flows (post-visit/post-purchase asks) — ` +
        "automated or incentivized review generation violates platform terms and is prohibited.",
      targetUrls: snapshots.map((snapshot) => `reviews:${snapshot.source}`),
      impact: playbook.local_intensity === "hyper-local" ? "high" : "medium",
      impactEstimate:
        playbook.local_intensity === "hyper-local"
          ? "High — review velocity is a primary local-pack and AI-trust signal in hyper-local verticals."
          : "Medium — steady review flow supports semi-local trust signals.",
      module: "M15",
      automationLevel: "human_only",
    });
  }

  return { status: "scored", score, evidence, fixes };
}
