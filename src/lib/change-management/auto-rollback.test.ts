/**
 * Auto-rollback evaluation tests — the PURE decision logic (doc 04 §2, §5).
 * Sign convention: MonitoringSignal.deltaPct negative = worse; a signal
 * breaches when deltaPct <= -threshold. Determinism: no wall-clock, injected
 * observedAt only.
 */

import { describe, expect, it } from "vitest";
import {
  autoRollbackReason,
  describeBreach,
  evaluateBreaches,
  isBreach,
} from "./auto-rollback";
import type { AutoRollbackPolicy, MonitoringSignal } from "./types";

function sig(overrides: Partial<MonitoringSignal> = {}): MonitoringSignal {
  return {
    metric: "visibility",
    deltaPct: -40,
    observedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

const POLICY: AutoRollbackPolicy = {
  mode: "execute",
  thresholds: { traffic: 25, ranking: 30, visibility: 30 },
};

describe("isBreach", () => {
  it("breaches when the drop meets or exceeds the threshold", () => {
    expect(isBreach(sig({ deltaPct: -30 }), POLICY)).toBe(true); // exactly at
    expect(isBreach(sig({ deltaPct: -55 }), POLICY)).toBe(true); // well past
  });

  it("does not breach within tolerance, on improvement, or flat", () => {
    expect(isBreach(sig({ deltaPct: -29.9 }), POLICY)).toBe(false);
    expect(isBreach(sig({ deltaPct: 0 }), POLICY)).toBe(false);
    expect(isBreach(sig({ deltaPct: 15 }), POLICY)).toBe(false); // improved
  });

  it("never breaches a metric with no configured threshold", () => {
    const partial: AutoRollbackPolicy = { mode: "execute", thresholds: { traffic: 25 } };
    expect(isBreach(sig({ metric: "visibility", deltaPct: -99 }), partial)).toBe(false);
  });

  it("ignores non-finite deltas and non-positive thresholds", () => {
    expect(isBreach(sig({ deltaPct: Number.NaN }), POLICY)).toBe(false);
    const zero: AutoRollbackPolicy = { mode: "execute", thresholds: { visibility: 0 } };
    expect(isBreach(sig({ deltaPct: -99 }), zero)).toBe(false);
  });
});

describe("evaluateBreaches", () => {
  it("returns only the breaching signals, worst (most negative) first", () => {
    const breaches = evaluateBreaches(
      [
        sig({ metric: "traffic", deltaPct: -26 }),
        sig({ metric: "ranking", deltaPct: -10 }), // within tolerance
        sig({ metric: "visibility", deltaPct: -70 }),
      ],
      POLICY,
    );
    expect(breaches.map((b) => b.metric)).toEqual(["visibility", "traffic"]);
    expect(breaches[0].deltaPct).toBe(-70);
  });

  it("is deterministic: reordered input yields the identical breach order", () => {
    const signals = [
      sig({ metric: "traffic", deltaPct: -40 }),
      sig({ metric: "visibility", deltaPct: -40 }),
      sig({ metric: "ranking", deltaPct: -40 }),
    ];
    const forward = evaluateBreaches(signals, POLICY).map((b) => b.metric);
    const backward = evaluateBreaches([...signals].reverse(), POLICY).map((b) => b.metric);
    expect(backward).toEqual(forward); // ties broken by metric name
  });

  it("returns nothing when no signal breaches", () => {
    expect(evaluateBreaches([sig({ deltaPct: -5 })], POLICY)).toEqual([]);
  });
});

describe("reason strings", () => {
  it("describeBreach names the metric, delta, window, and threshold", () => {
    const text = describeBreach({
      metric: "visibility",
      deltaPct: -34,
      threshold: 30,
      signal: sig({ deltaPct: -34, windowDays: 7 }),
    });
    expect(text).toContain("visibility");
    expect(text).toContain("-34%");
    expect(text).toContain("7d");
    expect(text).toContain("30%");
  });

  it("autoRollbackReason leads with the worst breach and counts the rest", () => {
    const reason = autoRollbackReason([
      { metric: "visibility", deltaPct: -70, threshold: 30, signal: sig({ deltaPct: -70 }) },
      { metric: "traffic", deltaPct: -26, threshold: 25, signal: sig({ metric: "traffic", deltaPct: -26 }) },
    ]);
    expect(reason).toMatch(/^auto-rollback: visibility/);
    expect(reason).toContain("+1 more metric");
  });
});
