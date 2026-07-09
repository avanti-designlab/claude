/**
 * M9 thresholds — the pure aggregation/quorum math + override clamping. These are
 * the doc-silent engineering choices (⚑ ratify list); the tests pin the DEFAULTS
 * and the anti-gaming quorum behaviour so a silent loosening is caught.
 */

import { describe, expect, it } from "vitest";
import {
  aggregatePanel,
  AUTHENTICITY_THRESHOLD_FLAGS,
  DEFAULT_THRESHOLDS,
  DETECTION_PASS_AT,
  MIN_DETECTORS,
  REQUIRE_UNANIMOUS,
  resolveThresholds,
  type ScoredDetector,
} from "./thresholds";

const AVAILABLE = (aiLikelihood: number): ScoredDetector => ({ available: true, aiLikelihood });
const UNAVAILABLE: ScoredDetector = { available: false, aiLikelihood: null };

describe("launch defaults (⚑ ratify list)", () => {
  it("pins the doc-silent defaults + a greppable flag", () => {
    expect(DETECTION_PASS_AT).toBe(0.3);
    expect(MIN_DETECTORS).toBe(2);
    expect(REQUIRE_UNANIMOUS).toBe(true);
    expect(DEFAULT_THRESHOLDS).toEqual({ passAt: 0.3, minDetectors: 2, requireUnanimous: true });
    expect(AUTHENTICITY_THRESHOLD_FLAGS).toContain("DETECTION_PASS_AT=0.30");
    expect(AUTHENTICITY_THRESHOLD_FLAGS).toContain("pilot 2–3");
  });
});

describe("resolveThresholds — a hostile/buggy override cannot silently loosen the gate", () => {
  it("falls back to defaults for absent/NaN/out-of-range fields", () => {
    expect(resolveThresholds()).toEqual(DEFAULT_THRESHOLDS);
    expect(resolveThresholds({ passAt: Number.NaN })).toEqual(DEFAULT_THRESHOLDS);
    expect(resolveThresholds({ minDetectors: 0 })).toEqual(DEFAULT_THRESHOLDS); // < 1 rejected
    expect(resolveThresholds({ minDetectors: -5 })).toEqual(DEFAULT_THRESHOLDS);
  });
  it("clamps passAt into [0,1] and floors minDetectors", () => {
    expect(resolveThresholds({ passAt: 5 }).passAt).toBe(1);
    expect(resolveThresholds({ passAt: -1 }).passAt).toBe(0);
    expect(resolveThresholds({ minDetectors: 3.9 }).minDetectors).toBe(3);
    expect(resolveThresholds({ requireUnanimous: false }).requireUnanimous).toBe(false);
  });
});

describe("aggregatePanel — MAX aggregate + unanimity quorum", () => {
  it("passes only when ALL available detectors are at/below the pass line (unanimous default)", () => {
    const agg = aggregatePanel([AVAILABLE(0.1), AVAILABLE(0.3)], DEFAULT_THRESHOLDS);
    expect(agg.score).toBe(0.3); // MAX, most conservative
    expect(agg.detectorsAvailable).toBe(2);
    expect(agg.detectorsBelow).toBe(2);
    expect(agg.quorumRequired).toBe(2);
    expect(agg.belowThreshold).toBe(true);
  });

  it("FAILS when even ONE detector is above the line (cannot pass on the lenient detector alone)", () => {
    const agg = aggregatePanel([AVAILABLE(0.1), AVAILABLE(0.8)], DEFAULT_THRESHOLDS);
    expect(agg.score).toBe(0.8);
    expect(agg.detectorsBelow).toBe(1);
    expect(agg.quorumMet).toBe(false);
    expect(agg.belowThreshold).toBe(false);
  });

  it("needs MIN_DETECTORS available — one available detector is never a panel pass", () => {
    const agg = aggregatePanel([AVAILABLE(0.05), UNAVAILABLE], DEFAULT_THRESHOLDS);
    expect(agg.detectorsAvailable).toBe(1);
    expect(agg.belowThreshold).toBe(false); // < MIN_DETECTORS
  });

  it("excludes unavailable detectors from the max and the quorum", () => {
    const agg = aggregatePanel([AVAILABLE(0.1), AVAILABLE(0.2), UNAVAILABLE], DEFAULT_THRESHOLDS);
    expect(agg.score).toBe(0.2); // the unavailable one contributes nothing
    expect(agg.detectorsAvailable).toBe(2);
    expect(agg.quorumRequired).toBe(2);
    expect(agg.belowThreshold).toBe(true);
  });

  it("non-unanimous quorum uses minDetectors agreeing", () => {
    const agg = aggregatePanel([AVAILABLE(0.1), AVAILABLE(0.2), AVAILABLE(0.9)], {
      passAt: 0.3,
      minDetectors: 2,
      requireUnanimous: false,
    });
    expect(agg.detectorsBelow).toBe(2);
    expect(agg.quorumRequired).toBe(2);
    expect(agg.belowThreshold).toBe(true); // 2 agree, quorum met
  });

  it("no available detectors ⇒ null score, never a pass", () => {
    const agg = aggregatePanel([UNAVAILABLE, UNAVAILABLE], DEFAULT_THRESHOLDS);
    expect(agg.score).toBeNull();
    expect(agg.belowThreshold).toBe(false);
  });
});
