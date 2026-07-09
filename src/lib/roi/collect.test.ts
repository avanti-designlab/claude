/**
 * M16 collection layer — the contributed / absent / failed distinction that
 * carries the module's honesty: a not-connected source is ABSENT (never zero),
 * a fetch error is FAILED (retryable, distinct from absent), and a misbehaving
 * adapter cannot smuggle another source's rows or bad values into the data.
 */

import { describe, expect, it } from "vitest";
import { collectOutcomes, type ResolvedSources } from "./collect";
import {
  InMemoryRoiSource,
  type OutcomePeriod,
  type RoiSource,
  type RoiSourceRequest,
  type RoiSourceResult,
} from "./sources";

const P: OutcomePeriod = { start: "2026-06-01T00:00:00.000Z", end: "2026-06-29T00:00:00.000Z" };
const noDelay = async () => {};

describe("collectOutcomes — coverage classification", () => {
  it("separates contributed, absent (not connected), and failed (errored)", async () => {
    const ga4 = new InMemoryRoiSource("ga4").report([{ metric: "sessions", value: 1000 }]);
    // A non-retryable failure so the one-shot fake stays FAILED (a retryable
    // one would be retried and the one-shot fault would clear → contributed).
    const callTracking = new InMemoryRoiSource("call_tracking").failNext("unexpected_response");
    const resolved: ResolvedSources = {
      ga4,
      gsc: null, // not connected → ABSENT
      call_tracking: callTracking, // connected but errors → FAILED
    };

    const collection = await collectOutcomes(resolved, P, {
      requested: ["ga4", "gsc", "call_tracking"],
      delay: noDelay,
    });

    expect(collection.coverage.contributing).toEqual(["ga4"]);
    expect(collection.coverage.absent).toEqual(["gsc"]);
    expect(collection.coverage.failed).toEqual(["call_tracking"]);
    expect(collection.coverage.coverage).toBeCloseTo(1 / 3);

    // The absent source contributes NO sample — it is not a zero.
    expect(collection.samples).toEqual([
      { source: "ga4", metric: "sessions", value: 1000, period: P },
    ]);
    const gsc = collection.outcomes.find((o) => o.sourceId === "gsc")!;
    expect(gsc.status).toBe("absent");
  });

  it("treats every unresolved source as absent when nothing is connected", async () => {
    const collection = await collectOutcomes({}, P, { delay: noDelay });
    expect(collection.coverage.contributing).toEqual([]);
    expect(collection.coverage.absent).toEqual(["ga4", "gsc", "call_tracking", "form_fills", "crm"]);
    expect(collection.coverage.failed).toEqual([]);
    expect(collection.samples).toEqual([]);
    expect(collection.coverage.coverage).toBe(0);
  });

  it("retries a retryable failure once, then succeeds", async () => {
    let calls = 0;
    const flaky: RoiSource = {
      sourceId: "ga4",
      vendor: "ga4-data-api",
      async fetchOutcomes(request: RoiSourceRequest): Promise<RoiSourceResult> {
        calls += 1;
        if (calls === 1) {
          const { RoiSourceError } = await import("./sources");
          throw new RoiSourceError("ga4", "rate_limited", "429");
        }
        return {
          source: "ga4",
          vendor: "ga4-data-api",
          period: request.period,
          samples: [{ source: "ga4", metric: "sessions", value: 5, period: request.period }],
        };
      },
    };
    const collection = await collectOutcomes({ ga4: flaky }, P, {
      requested: ["ga4"],
      delay: noDelay,
    });
    expect(calls).toBe(2);
    expect(collection.coverage.contributing).toEqual(["ga4"]);
  });

  it("does not retry a non-retryable failure", async () => {
    let calls = 0;
    const misconfigured: RoiSource = {
      sourceId: "ga4",
      vendor: "x",
      async fetchOutcomes(): Promise<RoiSourceResult> {
        calls += 1;
        const { RoiSourceError } = await import("./sources");
        throw new RoiSourceError("ga4", "unexpected_response", "bad payload");
      },
    };
    const collection = await collectOutcomes({ ga4: misconfigured }, P, {
      requested: ["ga4"],
      delay: noDelay,
    });
    expect(calls).toBe(1);
    expect(collection.coverage.failed).toEqual(["ga4"]);
    const outcome = collection.outcomes[0];
    expect(outcome.status === "failed" && outcome.failure).toBe("unexpected_response");
  });

  it("sanitizes a hostile adapter: drops junk values and re-stamps the source", async () => {
    const hostile: RoiSource = {
      sourceId: "ga4",
      vendor: "x",
      async fetchOutcomes(request): Promise<RoiSourceResult> {
        return {
          source: "ga4",
          vendor: "x",
          period: request.period,
          samples: [
            { source: "crm", metric: "revenue", value: 999999, period: request.period }, // wrong source
            { source: "ga4", metric: "sessions", value: Number.NaN, period: request.period },
            { source: "ga4", metric: "sessions", value: -3, period: request.period },
            { source: "ga4", metric: "", value: 5, period: request.period }, // empty metric
            { source: "ga4", metric: "sessions", value: 42, period: request.period }, // the one good row
          ],
        };
      },
    };
    const collection = await collectOutcomes({ ga4: hostile }, P, {
      requested: ["ga4"],
      delay: noDelay,
    });
    // Only the one valid row survives, re-stamped to ga4 (never crm).
    expect(collection.samples).toEqual([
      { source: "ga4", metric: "sessions", value: 42, period: P },
    ]);
  });

  it("is deterministic across repeated collections", async () => {
    const build = (): ResolvedSources => ({
      ga4: new InMemoryRoiSource("ga4").report([{ metric: "sessions", value: 10 }]),
      gsc: null,
    });
    const a = await collectOutcomes(build(), P, { requested: ["ga4", "gsc"], delay: noDelay });
    const b = await collectOutcomes(build(), P, { requested: ["ga4", "gsc"], delay: noDelay });
    expect(a).toEqual(b);
  });
});
