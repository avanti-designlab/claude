/**
 * M16 attribution model — determinism + the causal-honesty boundaries:
 * absent ≠ zero, partial coverage is structural, no extrapolation across
 * windows, correlation-never-causation, and ROI absent-unless-valued with no
 * overclaim.
 */

import { describe, expect, it } from "vitest";
import {
  attributeOutcomes,
  summarizeOutcomes,
  type WorkEvent,
} from "./attribution";
import type { OutcomePeriod, OutcomeSample, RoiSourceId } from "./sources";

const P: OutcomePeriod = { start: "2026-06-01T00:00:00.000Z", end: "2026-06-29T00:00:00.000Z" };
const PRIOR: OutcomePeriod = { start: "2026-05-01T00:00:00.000Z", end: "2026-05-29T00:00:00.000Z" };

function sample(
  source: RoiSourceId,
  metric: string,
  value: number,
  period: OutcomePeriod = P,
): OutcomeSample {
  return { source, metric, value, period };
}

const WORK: WorkEvent[] = [
  { kind: "site_change_applied", at: "2026-06-05T00:00:00.000Z", detail: "title" },
  { kind: "content_published", at: "2026-06-10T00:00:00.000Z" },
];

const ALL: RoiSourceId[] = ["ga4", "gsc", "call_tracking", "form_fills", "crm"];

describe("summarizeOutcomes — absent ≠ zero, coverage is structural", () => {
  it("omits metrics with no samples and lists absent sources (never a zero)", () => {
    const summary = summarizeOutcomes([sample("ga4", "sessions", 1000)], ALL);
    // Only the measured metric exists — no invented conversions:0 etc.
    expect(summary.metrics).toEqual([
      { metric: "sessions", value: 1000, sources: ["ga4"], samples: 1 },
    ]);
    expect(summary.coverage.contributing).toEqual(["ga4"]);
    expect(summary.coverage.absent).toEqual(["gsc", "call_tracking", "form_fills", "crm"]);
    expect(summary.coverage.coverage).toBeCloseTo(1 / 5);
  });

  it("treats a measured 0 as real data (present metric, contributing source)", () => {
    const summary = summarizeOutcomes([sample("ga4", "conversions", 0)], ["ga4"]);
    expect(summary.metrics).toEqual([
      { metric: "conversions", value: 0, sources: ["ga4"], samples: 1 },
    ]);
    expect(summary.coverage.contributing).toEqual(["ga4"]);
    expect(summary.coverage.absent).toEqual([]);
  });

  it("sums a metric measured by multiple sources and lists them canonically", () => {
    const summary = summarizeOutcomes(
      [sample("gsc", "clicks", 40), sample("ga4", "clicks", 60)],
      ["ga4", "gsc"],
    );
    expect(summary.metrics).toEqual([
      { metric: "clicks", value: 100, sources: ["ga4", "gsc"], samples: 2 },
    ]);
  });

  it("ignores a hostile non-measurement (NaN / negative), never counting it", () => {
    const summary = summarizeOutcomes(
      [
        sample("ga4", "sessions", Number.NaN),
        sample("ga4", "sessions", -5),
        sample("ga4", "sessions", 10),
      ],
      ["ga4"],
    );
    expect(summary.metrics).toEqual([
      { metric: "sessions", value: 10, sources: ["ga4"], samples: 1 },
    ]);
  });
});

describe("attributeOutcomes — determinism", () => {
  it("is pure: identical inputs produce identical output", () => {
    const input = {
      requestedSources: ALL,
      baseline: [sample("ga4", "sessions", 800, PRIOR), sample("ga4", "conversions", 8, PRIOR)],
      current: [sample("ga4", "sessions", 1000), sample("ga4", "conversions", 12)],
      workEvents: WORK,
      valuations: [{ metric: "conversions", valuePerUnit: 250 }],
    };
    expect(attributeOutcomes(input)).toEqual(attributeOutcomes(input));
  });
});

describe("attributeOutcomes — no extrapolation, correlation only", () => {
  it("gives a delta only for metrics measured in BOTH windows", () => {
    const result = attributeOutcomes({
      requestedSources: ["ga4", "call_tracking"],
      baseline: [sample("ga4", "sessions", 1000, PRIOR)],
      current: [sample("ga4", "sessions", 1200), sample("call_tracking", "calls", 30)],
      workEvents: WORK,
    });
    const sessions = result.metrics.find((m) => m.metric === "sessions")!;
    expect(sessions).toMatchObject({ baseline: 1000, current: 1200, delta: 200, comparable: true });
    expect(sessions.deltaPct).toBeCloseTo(0.2);

    // calls exists only in the current window — NO delta is invented for it.
    const calls = result.metrics.find((m) => m.metric === "calls")!;
    expect(calls).toMatchObject({ baseline: null, current: 30, delta: null, comparable: false });
  });

  it("always stamps basis=correlation and carries a causal caveat", () => {
    const result = attributeOutcomes({
      requestedSources: ["ga4"],
      baseline: [sample("ga4", "sessions", 900, PRIOR)],
      current: [sample("ga4", "sessions", 1000)],
      workEvents: WORK,
    });
    expect(result.basis).toBe("correlation");
    expect(result.causalCaveat).toMatch(/correlation, not proven causation/i);
    expect(result.attributable).toBe(true);
  });

  it("claims nothing when there was no platform work in the window", () => {
    const result = attributeOutcomes({
      requestedSources: ["ga4"],
      baseline: [sample("ga4", "sessions", 900, PRIOR)],
      current: [sample("ga4", "sessions", 1000)],
      workEvents: [],
      valuations: [{ metric: "sessions", valuePerUnit: 5 }],
    });
    expect(result.attributable).toBe(false);
    expect(result.causalCaveat).toMatch(/no platform work/i);
    // Even with a valuation, ROI is not claimed without work in the window.
    expect(result.roi).toBeNull();
  });
});

describe("attributeOutcomes — ROI is absent unless valued, and never overclaims", () => {
  const base = {
    requestedSources: ["ga4", "crm"] as RoiSourceId[],
    baseline: [sample("ga4", "conversions", 8, PRIOR), sample("crm", "qualified_leads", 4, PRIOR)],
    current: [sample("ga4", "conversions", 12), sample("crm", "qualified_leads", 3)],
    workEvents: WORK,
  };

  it("returns roi=null when no valuation is supplied (absent, not zero)", () => {
    expect(attributeOutcomes(base).roi).toBeNull();
  });

  it("counts only comparable, positively-moving valued metrics", () => {
    const result = attributeOutcomes({
      ...base,
      valuations: [
        { metric: "conversions", valuePerUnit: 250 }, // +4 → 1000
        { metric: "qualified_leads", valuePerUnit: 500 }, // -1 → NOT counted
        { metric: "sessions", valuePerUnit: 1 }, // not comparable → NOT counted
      ],
    });
    expect(result.roi).not.toBeNull();
    expect(result.roi!.basis).toBe("correlation");
    expect(result.roi!.attributedValue).toBe(1000);
    expect(result.roi!.valuedMetrics).toEqual([
      { metric: "conversions", delta: 4, valuePerUnit: 250, value: 1000 },
    ]);
    // A declining metric and an unmeasured one are surfaced, never silently
    // netted into (or against) the attributed value.
    expect(result.roi!.unvaluable.sort()).toEqual(["qualified_leads", "sessions"]);
    expect(result.roi!.attributedValue).toBeGreaterThanOrEqual(0);
  });
});
