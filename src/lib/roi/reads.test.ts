/**
 * M16 ROI reads — snapshot recomputation from stored `metrics` (recompute ==
 * live), the ascending time-series with truncation honesty, and correlational
 * attribution of the latest window against the prior one using in-window
 * on-site work. Tenant isolation is RLS's job (migration 0006); these prove the
 * read SHAPES and the honesty, over a PostgREST-shaped fake.
 */

import { describe, expect, it, vi } from "vitest";
import { fakeRoiReadPostgrest, type ScriptedRead } from "./read-fake";
import { summarizeOutcomes } from "./attribution";
import {
  getLatestRoiSnapshot,
  getRoiAttribution,
  getRoiTimeSeries,
} from "./reads";
import type { Supabase } from "./persist";
import type { OutcomePeriod, OutcomeSample } from "./sources";

vi.mock("server-only", () => ({}));

const CLIENT_ID = "3f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const CUR: OutcomePeriod = { start: "2026-06-01T00:00:00.000Z", end: "2026-06-29T00:00:00.000Z" };
const PRIOR: OutcomePeriod = { start: "2026-05-01T00:00:00.000Z", end: "2026-05-29T00:00:00.000Z" };
const CUR_AT = "2026-06-30T00:00:00.000Z";
const PRIOR_AT = "2026-05-30T00:00:00.000Z";

function metricRow(source: string, metrics: Record<string, number>, capturedAt: string, period: OutcomePeriod) {
  return { source, data: { vendor: "in-memory", period, metrics }, captured_at: capturedAt };
}

function as(client: unknown): Supabase {
  return client as unknown as Supabase;
}

describe("getLatestRoiSnapshot", () => {
  it("recomputes the newest snapshot; the recompute equals a live summary", async () => {
    const rows = [
      metricRow("ga4", { sessions: 1200, conversions: 15 }, CUR_AT, CUR),
      metricRow("gsc", { clicks: 340 }, CUR_AT, CUR),
    ];
    const { client } = fakeRoiReadPostgrest({ data: rows });
    const read = await getLatestRoiSnapshot(as(client), CLIENT_ID);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok" || read.latest === null) throw new Error("expected a snapshot");
    expect(read.latest.capturedAt).toBe(CUR_AT);

    // Equivalence with a directly-computed live summary over the same samples.
    const live: OutcomeSample[] = [
      { source: "ga4", metric: "sessions", value: 1200, period: CUR },
      { source: "ga4", metric: "conversions", value: 15, period: CUR },
      { source: "gsc", metric: "clicks", value: 340, period: CUR },
    ];
    expect(read.latest.summary).toEqual(
      summarizeOutcomes(live, ["ga4", "gsc", "call_tracking"]),
    );
    // call_tracking never captured → absent, never zero.
    expect(read.latest.summary.coverage.absent).toContain("call_tracking");
  });

  it("returns latest=null on an unknown/non-UUID client without hitting the DB", async () => {
    const { client, reads } = fakeRoiReadPostgrest({ data: [] });
    const read = await getLatestRoiSnapshot(as(client), "not-a-uuid");
    expect(read).toEqual({ kind: "ok", latest: null });
    expect(reads).toHaveLength(0);
  });

  it("propagates a read failure as failed (never 'no captures')", async () => {
    const { client } = fakeRoiReadPostgrest({ error: { message: "boom", code: "PGRST301" } });
    expect(await getLatestRoiSnapshot(as(client), CLIENT_ID)).toEqual({ kind: "failed" });
  });
});

describe("getRoiTimeSeries", () => {
  it("groups snapshots and returns them ascending by captured_at", async () => {
    const rows = [
      metricRow("ga4", { sessions: 1200 }, CUR_AT, CUR),
      metricRow("ga4", { sessions: 800 }, PRIOR_AT, PRIOR),
    ];
    const { client } = fakeRoiReadPostgrest({ data: rows });
    const read = await getRoiTimeSeries(as(client), CLIENT_ID);
    if (read.kind !== "ok") throw new Error("expected ok");
    expect(read.series.map((s) => s.capturedAt)).toEqual([PRIOR_AT, CUR_AT]); // ascending
    expect(read.truncated).toBe(false);
  });

  it("caps to maxSnapshots (newest kept) and flags truncation", async () => {
    const rows = [
      metricRow("ga4", { sessions: 3 }, CUR_AT, CUR),
      metricRow("ga4", { sessions: 2 }, PRIOR_AT, PRIOR),
      metricRow("ga4", { sessions: 1 }, "2026-04-30T00:00:00.000Z", PRIOR),
    ];
    const { client } = fakeRoiReadPostgrest({ data: rows });
    const read = await getRoiTimeSeries(as(client), CLIENT_ID, { maxSnapshots: 1 });
    if (read.kind !== "ok") throw new Error("expected ok");
    expect(read.series.map((s) => s.capturedAt)).toEqual([CUR_AT]);
    expect(read.truncated).toBe(true);
  });
});

describe("getRoiAttribution", () => {
  const metricsRows = [
    metricRow("ga4", { sessions: 1200, conversions: 15 }, CUR_AT, CUR),
    metricRow("ga4", { sessions: 800, conversions: 10 }, PRIOR_AT, PRIOR),
  ];

  it("attributes the latest window vs the prior one, using in-window on-site work", async () => {
    const scripts: ScriptedRead[] = [
      { data: metricsRows },
      {
        data: [
          { change_type: "title", applied_at: "2026-06-15T00:00:00.000Z", status: "applied" },
          { change_type: "schema", applied_at: "2026-01-01T00:00:00.000Z", status: "applied" }, // out of window
        ],
      },
    ];
    const { client } = fakeRoiReadPostgrest(scripts);
    const read = await getRoiAttribution(as(client), CLIENT_ID);
    if (read.kind !== "ok" || read.attribution === null) throw new Error("expected attribution");
    const a = read.attribution;
    expect(a.currentAt).toBe(CUR_AT);
    expect(a.baselineAt).toBe(PRIOR_AT);
    expect(a.basis).toBe("correlation");
    // Only the in-window change counts as work.
    expect(a.workEventCount).toBe(1);
    expect(a.attributable).toBe(true);
    const sessions = a.metrics.find((m) => m.metric === "sessions")!;
    expect(sessions).toMatchObject({ baseline: 800, current: 1200, delta: 400, comparable: true });
    // No valuation supplied → ROI absent, not invented.
    expect(a.roi).toBeNull();
  });

  it("computes correlation-tagged ROI only when a valuation is supplied", async () => {
    const scripts: ScriptedRead[] = [
      { data: metricsRows },
      { data: [{ change_type: "title", applied_at: "2026-06-15T00:00:00.000Z", status: "applied" }] },
    ];
    const { client } = fakeRoiReadPostgrest(scripts);
    const read = await getRoiAttribution(as(client), CLIENT_ID, {
      valuations: [{ metric: "conversions", valuePerUnit: 300 }],
    });
    if (read.kind !== "ok" || read.attribution === null) throw new Error("expected attribution");
    expect(read.attribution.roi).not.toBeNull();
    expect(read.attribution.roi!.basis).toBe("correlation");
    // conversions moved +5 → 5 × 300 = 1500.
    expect(read.attribution.roi!.attributedValue).toBe(1500);
  });

  it("has no baseline when only one snapshot exists (deltas not extrapolated)", async () => {
    const scripts: ScriptedRead[] = [
      { data: [metricRow("ga4", { sessions: 1200 }, CUR_AT, CUR)] },
      { data: [{ change_type: "title", applied_at: "2026-06-15T00:00:00.000Z", status: "applied" }] },
    ];
    const { client } = fakeRoiReadPostgrest(scripts);
    const read = await getRoiAttribution(as(client), CLIENT_ID);
    if (read.kind !== "ok" || read.attribution === null) throw new Error("expected attribution");
    expect(read.attribution.baselineAt).toBeNull();
    const sessions = read.attribution.metrics.find((m) => m.metric === "sessions")!;
    expect(sessions).toMatchObject({ baseline: null, current: 1200, delta: null, comparable: false });
    expect(read.attribution.attributable).toBe(false); // no comparable metric yet
  });

  it("fails if the work-events read fails (never a half-attribution)", async () => {
    const scripts: ScriptedRead[] = [
      { data: metricsRows },
      { error: { message: "boom", code: "PGRST301" } },
    ];
    const { client } = fakeRoiReadPostgrest(scripts);
    expect(await getRoiAttribution(as(client), CLIENT_ID)).toEqual({ kind: "failed" });
  });
});
