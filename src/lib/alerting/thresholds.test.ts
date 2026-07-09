import { describe, expect, it } from "vitest";
import {
  competitorOvertookSeverity,
  isCompetitorOvertook,
  isReviewSpike,
  isSiteDown,
  isVisibilityDrop,
  reviewSpikeRatio,
  reviewSpikeSeverity,
  visibilityDropPoints,
  visibilityDropSeverity,
  COMPETITOR_OVERTOOK_MARGIN,
  REVIEW_SPIKE_MIN_NEGATIVE,
  VISIBILITY_DROP_CRITICAL_POINTS,
  VISIBILITY_DROP_FIRE_POINTS,
  VISIBILITY_DROP_WARNING_POINTS,
} from "./thresholds";
import type {
  CompetitorOvertookSignal,
  ReviewSpikeSignal,
  VisibilityDropSignal,
} from "./types";

function vd(previousScore: number, latestScore: number): VisibilityDropSignal {
  return { previousScore, latestScore, previousRunAt: "p", latestRunAt: "l" };
}
function co(
  prevClient: number,
  prevComp: number,
  client: number,
  comp: number,
): CompetitorOvertookSignal {
  return {
    competitorName: "Rival",
    clientShare: client,
    competitorShare: comp,
    previousClientShare: prevClient,
    previousCompetitorShare: prevComp,
    latestRunAt: "l",
  };
}
function rs(negativeCount: number, baseline: number): ReviewSpikeSignal {
  return {
    platform: "google",
    negativeCount,
    windowDays: 30,
    baselineNegativePerWindow: baseline,
    detectedAt: "d",
  };
}

describe("visibility_drop thresholds", () => {
  it("fires only at/above the fire line; a rise or a small dip does not", () => {
    expect(isVisibilityDrop(vd(80, 80 - VISIBILITY_DROP_FIRE_POINTS))).toBe(true);
    expect(isVisibilityDrop(vd(80, 80 - VISIBILITY_DROP_FIRE_POINTS + 0.1))).toBe(false);
    expect(isVisibilityDrop(vd(50, 90))).toBe(false); // a rise never fires
    expect(visibilityDropPoints(vd(80, 50))).toBe(30);
  });

  it("severity bands are deterministic: info < warning ≤ warning < critical", () => {
    expect(visibilityDropSeverity(vd(80, 80 - VISIBILITY_DROP_FIRE_POINTS))).toBe("info");
    expect(visibilityDropSeverity(vd(80, 80 - VISIBILITY_DROP_WARNING_POINTS))).toBe("warning");
    expect(visibilityDropSeverity(vd(80, 80 - VISIBILITY_DROP_CRITICAL_POINTS))).toBe("critical");
    // Determinism: same input, same output.
    expect(visibilityDropSeverity(vd(80, 55))).toBe(visibilityDropSeverity(vd(80, 55)));
  });
});

describe("competitor_overtook thresholds", () => {
  it("fires only on a crossing (level-or-behind → ahead by ≥ margin)", () => {
    expect(COMPETITOR_OVERTOOK_MARGIN).toBe(0.05);
    // Was behind, now ahead by clearly ≥ the margin → fires.
    expect(isCompetitorOvertook(co(0.5, 0.4, 0.3, 0.36))).toBe(true); // 0.06 lead
    // Was ALREADY ahead last run → not a crossing.
    expect(isCompetitorOvertook(co(0.3, 0.5, 0.3, 0.6))).toBe(false);
    // Now ahead but by LESS than the margin (flap guard) → no fire.
    expect(isCompetitorOvertook(co(0.5, 0.4, 0.3, 0.33))).toBe(false); // 0.03 lead
  });

  it("critical only when the new lead is a rout (≥ 0.25 ahead)", () => {
    expect(competitorOvertookSeverity(co(0.5, 0.4, 0.2, 0.4))).toBe("warning"); // 0.20 lead
    expect(competitorOvertookSeverity(co(0.5, 0.4, 0.1, 0.4))).toBe("critical"); // 0.30 lead
  });
});

describe("negative_review_spike thresholds", () => {
  it("needs BOTH the absolute floor and the ratio; one angry review is not a spike", () => {
    expect(isReviewSpike(rs(REVIEW_SPIKE_MIN_NEGATIVE - 1, 0))).toBe(false); // below floor
    expect(isReviewSpike(rs(4, 3))).toBe(false); // 4/3 < 2× ratio
    expect(isReviewSpike(rs(6, 3))).toBe(true); // 6/3 = 2×, above floor
  });

  it("a zero baseline is handled by the floor alone (no divide-by-zero); ratio is +Inf", () => {
    expect(reviewSpikeRatio(rs(5, 0))).toBe(Number.POSITIVE_INFINITY);
    expect(isReviewSpike(rs(5, 0))).toBe(true);
    expect(reviewSpikeSeverity(rs(5, 0))).toBe("critical");
  });

  it("severity escalates at the critical ratio", () => {
    expect(reviewSpikeSeverity(rs(6, 3))).toBe("warning"); // 2×
    expect(reviewSpikeSeverity(rs(12, 3))).toBe("critical"); // 4×
  });
});

describe("site_down threshold", () => {
  it("down = unreachable (null) or 5xx; a 4xx is up-but-erroring", () => {
    expect(isSiteDown(null)).toBe(true);
    expect(isSiteDown(503)).toBe(true);
    expect(isSiteDown(404)).toBe(false);
    expect(isSiteDown(200)).toBe(false);
  });
});
