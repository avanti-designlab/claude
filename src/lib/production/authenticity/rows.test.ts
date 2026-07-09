/**
 * M9 row mapping — the update-payload PIN (M9 can never write approved/published
 * or a review verdict) + the defensive verdict-view parse (rich / minimal / hostile
 * / null).
 */

import { describe, expect, it } from "vitest";
import {
  authenticityVerdictView,
  humanizationUpdatePayload,
  M9_ADVANCED_STATUS,
} from "./rows";
import type { HumanizationRecord } from "./types";

function record(overrides: Partial<HumanizationRecord> = {}): HumanizationRecord {
  return {
    humanized: true,
    detection_score: 0.2,
    passes: true,
    schemaVersion: 1,
    verdict: "passed",
    flaggedReasons: [],
    humanizer: { vendor: "hz", applied: true },
    detectors: [
      { vendor: "d1", available: true, aiLikelihood: 0.1, belowThreshold: true },
      { vendor: "d2", available: true, aiLikelihood: 0.2, belowThreshold: true },
    ],
    aggregate: { score: 0.2, detectorsAvailable: 2, detectorsBelow: 2, belowThreshold: true },
    quorum: { required: 2, met: true },
    thresholds: { passAt: 0.3, minDetectors: 2, requireUnanimous: true },
    drift: { meaning: [], voice: [], detected: false },
    compliancePrescreen: { pass: true, blockCount: 0, warnCount: 0, blockedRuleIds: [], disclaimer: "not legal review" },
    complianceRegression: { regressed: false, newBlockRuleIds: [], droppedRequiredRuleIds: [] },
    ...overrides,
  };
}

describe("humanizationUpdatePayload — M9 can never approve/publish or self-review", () => {
  it("pins status to 'in_review' and writes ONLY humanization (+ body)", () => {
    const payload = humanizationUpdatePayload(record(), "humanized body");
    expect(M9_ADVANCED_STATUS).toBe("in_review");
    expect(payload.status).toBe("in_review");
    expect(payload.body).toBe("humanized body");
    // The columns M9 must never touch are absent by construction.
    expect(payload).not.toHaveProperty("quality_review");
    expect(payload).not.toHaveProperty("compliance_review");
    expect(payload).not.toHaveProperty("automation_level");
    expect(payload).not.toHaveProperty("tenant_id");
  });

  it("omits body entirely when the humanized text is not applied (drift ⇒ keep original)", () => {
    const payload = humanizationUpdatePayload(record({ humanized: false }), null);
    expect(payload).not.toHaveProperty("body");
    expect(payload.status).toBe("in_review");
  });

  it("even a FLAGGED result still only advances to 'in_review' — never approved/published", () => {
    const payload = humanizationUpdatePayload(
      record({ passes: false, verdict: "flagged_for_human", flaggedReasons: ["detection_above_threshold"] }),
      "body",
    );
    expect(payload.status).toBe("in_review");
    expect(["approved", "published"]).not.toContain(payload.status);
  });
});

describe("authenticityVerdictView — defensive parse", () => {
  it("shapes a rich M9 record fully", () => {
    const view = authenticityVerdictView(record({ passes: false, verdict: "flagged_for_human", flaggedReasons: ["detection_above_threshold"] }));
    expect(view).not.toBeNull();
    expect(view!.verdict).toBe("flagged_for_human");
    expect(view!.passes).toBe(false);
    expect(view!.detectors).toHaveLength(2);
    expect(view!.detectionScore).toBe(0.2);
    expect(view!.flaggedReasons).toEqual(["detection_above_threshold"]);
    // FIX 3: the fresh compliance prescreen + regression delta ride into the view.
    expect(view!.compliancePrescreen).toEqual({
      pass: true,
      blockCount: 0,
      warnCount: 0,
      blockedRuleIds: [],
      disclaimer: "not legal review",
    });
    expect(view!.complianceRegression).toEqual({ regressed: false, newBlockRuleIds: [], droppedRequiredRuleIds: [] });
  });

  it("FIX 3: surfaces a regression + a blocked fresh prescreen for the downstream gate", () => {
    const view = authenticityVerdictView(
      record({
        passes: false,
        verdict: "flagged_for_human",
        flaggedReasons: ["compliance_regression"],
        compliancePrescreen: {
          pass: false,
          blockCount: 1,
          warnCount: 0,
          blockedRuleIds: ["real-estate.fair-housing-preference"],
          disclaimer: "not legal review",
        },
        complianceRegression: {
          regressed: true,
          newBlockRuleIds: ["real-estate.fair-housing-preference"],
          droppedRequiredRuleIds: [],
        },
      }),
    );
    expect(view!.flaggedReasons).toEqual(["compliance_regression"]);
    expect(view!.compliancePrescreen?.pass).toBe(false);
    expect(view!.compliancePrescreen?.blockedRuleIds).toEqual(["real-estate.fair-housing-preference"]);
    expect(view!.complianceRegression.regressed).toBe(true);
    expect(view!.complianceRegression.newBlockRuleIds).toEqual(["real-estate.fair-housing-preference"]);
  });

  it("returns null when M9 has not run (null / non-object humanization)", () => {
    expect(authenticityVerdictView(null)).toBeNull();
    expect(authenticityVerdictView(undefined)).toBeNull();
    expect(authenticityVerdictView("nope")).toBeNull();
    expect(authenticityVerdictView([1, 2])).toBeNull();
  });

  it("tolerates a legacy MINIMAL HumanizationResult (no rich fields)", () => {
    const view = authenticityVerdictView({ humanized: true, detection_score: 0.4, passes: false });
    expect(view).not.toBeNull();
    expect(view!.verdict).toBe("unknown"); // no rich verdict field
    expect(view!.passes).toBe(false);
    expect(view!.humanized).toBe(true);
    expect(view!.detectionScore).toBe(0.4);
    expect(view!.detectors).toEqual([]);
    // A legacy record carries no compliance fields — the view fails safe.
    expect(view!.compliancePrescreen).toBeNull();
    expect(view!.complianceRegression).toEqual({ regressed: false, newBlockRuleIds: [], droppedRequiredRuleIds: [] });
  });

  it("hostile / malformed jsonb is dead weight — safe defaults, never a throw, never a forced pass", () => {
    const hostile = {
      passes: "yes", // not a boolean ⇒ fail-closed to false
      verdict: "approved", // not an M9 verdict ⇒ 'unknown'
      flaggedReasons: ["__proto__", { evil: 1 }, "meaning_drift"],
      detectors: "not-an-array",
      detection_score: "high",
      drift: { meaning: [{ kind: "nope", excerpt: 5 }, { kind: "statistic", excerpt: "9%" }] },
      quorum: 42,
    };
    const view = authenticityVerdictView(hostile);
    expect(view).not.toBeNull();
    expect(view!.passes).toBe(false); // "yes" is not true
    expect(view!.verdict).toBe("unknown");
    expect(view!.flaggedReasons).toEqual(["meaning_drift"]); // only known reasons survive
    expect(view!.detectors).toEqual([]);
    expect(view!.detectionScore).toBeNull();
    expect(view!.drift.meaning).toEqual([{ kind: "statistic", excerpt: "9%" }]); // only well-formed excerpts
    expect(view!.quorum).toEqual({ required: null, met: null });
    // Malformed/absent compliance fields ⇒ safe defaults, never a forced pass.
    expect(view!.compliancePrescreen).toBeNull();
    expect(view!.complianceRegression).toEqual({ regressed: false, newBlockRuleIds: [], droppedRequiredRuleIds: [] });
  });
});
