/**
 * M9 detector panel — the multi-detector registry (doc 07 "pilot 2–3"). Pins:
 * every detector reports its own VERBATIM score; individual failures / garbage
 * scores are UNAVAILABLE (never counted as a pass); a detector error never fails
 * the whole panel and never leaks the raw error/text.
 */

import { describe, expect, it } from "vitest";
import { runDetectorPanel, ScriptedDetectionProvider, type AIDetectionProvider } from "./detector";
import { DETECTION_PASS_AT } from "./thresholds";

describe("runDetectorPanel — multi-detector reporting", () => {
  it("runs the whole panel and reports each detector verbatim, in registration order", async () => {
    const panel = [
      new ScriptedDetectionProvider("detector-a", 0.12),
      new ScriptedDetectionProvider("detector-b", 0.27),
      new ScriptedDetectionProvider("detector-c", 0.05),
    ];
    const readings = await runDetectorPanel(panel, "some candidate text", DETECTION_PASS_AT);
    expect(readings.map((r) => r.vendor)).toEqual(["detector-a", "detector-b", "detector-c"]);
    expect(readings.map((r) => r.aiLikelihood)).toEqual([0.12, 0.27, 0.05]); // verbatim, never massaged
    expect(readings.every((r) => r.available)).toBe(true);
    expect(readings.map((r) => r.belowThreshold)).toEqual([true, true, true]);
  });

  it("marks per-detector belowThreshold against passAt", async () => {
    const panel = [new ScriptedDetectionProvider("lo", 0.1), new ScriptedDetectionProvider("hi", 0.9)];
    const readings = await runDetectorPanel(panel, "x", DETECTION_PASS_AT);
    expect(readings[0].belowThreshold).toBe(true);
    expect(readings[1].belowThreshold).toBe(false);
    expect(readings[1].aiLikelihood).toBe(0.9); // the high score is reported, not hidden
  });

  it("a throwing detector is UNAVAILABLE (never a pass) and never leaks its error", async () => {
    const panel = [
      new ScriptedDetectionProvider("ok", 0.1),
      new ScriptedDetectionProvider("boom", 0.1).failNext(new Error("secret candidate text here")),
    ];
    const readings = await runDetectorPanel(panel, "x", DETECTION_PASS_AT);
    expect(readings[1]).toMatchObject({ vendor: "boom", available: false, aiLikelihood: null, note: "detector_error" });
    expect(JSON.stringify(readings)).not.toContain("secret");
    expect(readings[0].available).toBe(true); // one detector's failure doesn't fail the panel
  });

  it("a NaN / out-of-range score is UNAVAILABLE (detector_bad_score), not silently a pass", async () => {
    const panel = [
      new ScriptedDetectionProvider("nan", Number.NaN),
      new ScriptedDetectionProvider("over", 1.5),
      new ScriptedDetectionProvider("neg", -0.2),
    ];
    const readings = await runDetectorPanel(panel, "x", DETECTION_PASS_AT);
    expect(readings.every((r) => r.available === false && r.note === "detector_bad_score")).toBe(true);
    expect(readings.every((r) => r.belowThreshold === null)).toBe(true);
  });

  it("passes the exact candidate text to each detector (scorer can key on it)", async () => {
    const seen: string[] = [];
    const spy: AIDetectionProvider = {
      vendor: "spy",
      async detect(text) {
        seen.push(text);
        return { aiLikelihood: text.includes("robot") ? 0.99 : 0.01 };
      },
    };
    const readings = await runDetectorPanel([spy], "a robot wrote this", DETECTION_PASS_AT);
    expect(seen).toEqual(["a robot wrote this"]);
    expect(readings[0].aiLikelihood).toBe(0.99);
  });
});
