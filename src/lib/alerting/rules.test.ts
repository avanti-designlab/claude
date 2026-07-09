import { describe, expect, it } from "vitest";
import {
  competitorOvertookRule,
  competitorOvertookSignals,
  reviewSpikeRule,
  schemaBrokeRule,
  siteDownRule,
  visibilityDropRule,
  visibilityDropSignalFromSeries,
  type RunScorePoint,
  type ShareSnapshot,
} from "./rules";
import {
  competitorOvertookFingerprint,
  siteDownFingerprint,
  visibilityDropFingerprint,
} from "./rows";
import type { AlertScope } from "./types";

const S: AlertScope = { tenantId: "tenant-1", clientId: "client-1" };

describe("visibilityDropRule", () => {
  it("fires on a real measured drop with a claim-scoped, condition-keyed row", () => {
    const row = visibilityDropRule(S, {
      previousScore: 80,
      latestScore: 50,
      previousRunAt: "r1",
      latestRunAt: "r2",
    });
    expect(row).not.toBeNull();
    expect(row!.tenant_id).toBe("tenant-1");
    expect(row!.client_id).toBe("client-1");
    expect(row!.type).toBe("visibility_drop");
    expect(row!.severity).toBe("critical"); // 30 pts
    expect(row!.payload.fingerprint).toBe(visibilityDropFingerprint("client-1"));
    expect(row!.payload.detectedAt).toBe("r2");
  });

  it("returns null when the score held or rose (no fabricated alert)", () => {
    expect(visibilityDropRule(S, { previousScore: 50, latestScore: 55, previousRunAt: "a", latestRunAt: "b" })).toBeNull();
    expect(visibilityDropRule(S, { previousScore: 50, latestScore: 50, previousRunAt: "a", latestRunAt: "b" })).toBeNull();
  });
});

describe("competitorOvertookRule", () => {
  it("fires on a crossing and keys the fingerprint per (client, competitor)", () => {
    const row = competitorOvertookRule(S, {
      competitorName: "Rival Realty",
      clientShare: 0.3,
      competitorShare: 0.5,
      previousClientShare: 0.5,
      previousCompetitorShare: 0.4,
      latestRunAt: "r2",
    });
    expect(row).not.toBeNull();
    expect(row!.type).toBe("competitor_overtook");
    expect(row!.payload.fingerprint).toBe(competitorOvertookFingerprint("client-1", "Rival Realty"));
  });

  it("returns null when the competitor was already ahead (not a crossing)", () => {
    expect(
      competitorOvertookRule(S, {
        competitorName: "Rival",
        clientShare: 0.2,
        competitorShare: 0.6,
        previousClientShare: 0.2,
        previousCompetitorShare: 0.6,
        latestRunAt: "r2",
      }),
    ).toBeNull();
  });
});

describe("schemaBrokeRule / siteDownRule", () => {
  it("schemaBrokeRule always emits (the signal IS the failed verification), fixed critical", () => {
    const row = schemaBrokeRule(S, {
      propertyId: "p1",
      pageUrl: "https://x.example/faq",
      schemaType: "FAQPage",
      detail: "JSON-LD absent",
      detectedAt: "d",
    });
    expect(row.type).toBe("schema_broke");
    expect(row.severity).toBe("critical");
  });

  it("siteDownRule fires on down, returns null when the origin is up", () => {
    const down = siteDownRule(S, { propertyId: "p1", baseUrl: "https://x.example", httpStatus: null, detectedAt: "d" });
    expect(down).not.toBeNull();
    expect(down!.type).toBe("site_down");
    expect(down!.payload.fingerprint).toBe(siteDownFingerprint("p1"));
    expect(siteDownRule(S, { propertyId: "p1", baseUrl: "https://x.example", httpStatus: 200, detectedAt: "d" })).toBeNull();
  });
});

describe("reviewSpikeRule", () => {
  it("fires only on a real spike vs baseline", () => {
    expect(
      reviewSpikeRule(S, { platform: "google", negativeCount: 6, windowDays: 30, baselineNegativePerWindow: 2, detectedAt: "d" }),
    ).not.toBeNull();
    expect(
      reviewSpikeRule(S, { platform: "google", negativeCount: 1, windowDays: 30, baselineNegativePerWindow: 2, detectedAt: "d" }),
    ).toBeNull();
  });
});

describe("visibilityDropSignalFromSeries — honesty on missing history", () => {
  it("returns null with fewer than two runs (no baseline ⇒ unknown, not a drop)", () => {
    expect(visibilityDropSignalFromSeries([])).toBeNull();
    expect(visibilityDropSignalFromSeries([{ runAt: "r1", score: 80 }])).toBeNull();
  });

  it("compares the two MOST RECENT runs of an ascending series", () => {
    const series: RunScorePoint[] = [
      { runAt: "r1", score: 90 },
      { runAt: "r2", score: 80 },
      { runAt: "r3", score: 55 },
    ];
    const signal = visibilityDropSignalFromSeries(series);
    expect(signal).toEqual({ previousScore: 80, latestScore: 55, previousRunAt: "r2", latestRunAt: "r3" });
  });
});

describe("competitorOvertookSignals — derivation from two snapshots", () => {
  it("returns [] with no prior snapshot (no baseline crossing measurable)", () => {
    const latest: ShareSnapshot = { clientShare: 0.4, competitorShares: new Map([["A", 0.5]]), runAt: "r2" };
    expect(competitorOvertookSignals(null, latest)).toEqual([]);
  });

  it("emits one signal per competitor, deterministically ordered by name", () => {
    const prev: ShareSnapshot = {
      clientShare: 0.5,
      competitorShares: new Map([["Zeta", 0.4], ["Alpha", 0.3]]),
      runAt: "r1",
    };
    const latest: ShareSnapshot = {
      clientShare: 0.3,
      competitorShares: new Map([["Zeta", 0.5], ["Alpha", 0.35]]),
      runAt: "r2",
    };
    const signals = competitorOvertookSignals(prev, latest);
    expect(signals.map((s) => s.competitorName)).toEqual(["Alpha", "Zeta"]);
    expect(signals[1].previousCompetitorShare).toBe(0.4);
  });
});
