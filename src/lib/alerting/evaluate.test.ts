import { describe, expect, it } from "vitest";
import { evaluateSignals } from "./evaluate";
import { M17_WRITER_ALERT_TYPES } from "./rows";
import type { AlertScope, SignalBundle } from "./types";

const S: AlertScope = { tenantId: "t1", clientId: "c1" };

describe("evaluateSignals — honesty (absent signal ≠ alert)", () => {
  it("an empty bundle yields NO rows (nothing measured ⇒ nothing alerted)", () => {
    expect(evaluateSignals(S, {})).toEqual([]);
  });

  it("a present-but-sub-threshold signal yields no row", () => {
    const bundle: SignalBundle = {
      visibilityDrop: { previousScore: 50, latestScore: 49, previousRunAt: "a", latestRunAt: "b" },
    };
    expect(evaluateSignals(S, bundle)).toEqual([]);
  });

  it("only the measured signals that clear threshold produce rows, in deterministic order", () => {
    const bundle: SignalBundle = {
      visibilityDrop: { previousScore: 80, latestScore: 40, previousRunAt: "a", latestRunAt: "b" },
      siteDown: [{ propertyId: "p1", baseUrl: "https://x", httpStatus: 500, detectedAt: "d" }],
      reviewSpike: [
        { platform: "google", negativeCount: 8, windowDays: 30, baselineNegativePerWindow: 2, detectedAt: "d" },
        { platform: "yelp", negativeCount: 1, windowDays: 30, baselineNegativePerWindow: 2, detectedAt: "d" }, // sub-threshold, dropped
      ],
    };
    const rows = evaluateSignals(S, bundle);
    expect(rows.map((r) => r.type)).toEqual(["visibility_drop", "negative_review_spike", "site_down"]);
  });
});

describe("evaluateSignals — no double-write of other owners' classes", () => {
  it("every emitted row is one of M17's five writer types (never crawler_blocked / auto_rollback_fired)", () => {
    const bundle: SignalBundle = {
      visibilityDrop: { previousScore: 90, latestScore: 50, previousRunAt: "a", latestRunAt: "b" },
      competitorOvertook: [
        {
          competitorName: "R",
          clientShare: 0.2,
          competitorShare: 0.6,
          previousClientShare: 0.5,
          previousCompetitorShare: 0.3,
          latestRunAt: "b",
        },
      ],
      schemaBroke: [{ propertyId: "p", pageUrl: "u", schemaType: "FAQPage", detail: "x", detectedAt: "d" }],
      siteDown: [{ propertyId: "p", baseUrl: "u", httpStatus: null, detectedAt: "d" }],
      reviewSpike: [{ platform: "g", negativeCount: 9, windowDays: 30, baselineNegativePerWindow: 1, detectedAt: "d" }],
    };
    const rows = evaluateSignals(S, bundle);
    const writer = new Set<string>(M17_WRITER_ALERT_TYPES);
    for (const row of rows) {
      expect(writer.has(row.type)).toBe(true);
      expect(row.type).not.toBe("crawler_blocked");
      expect(row.type).not.toBe("auto_rollback_fired");
    }
    // SignalBundle structurally CANNOT carry those two classes — nothing to assert
    // beyond: the union of emitted types is a subset of the writer set.
    expect(rows.length).toBe(5);
  });
});
