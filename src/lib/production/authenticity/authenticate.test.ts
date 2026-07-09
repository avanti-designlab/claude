/**
 * M9 core — humanize → detect → flag. Pins the governance-critical properties:
 *  - happy pass: clean rewrite + panel below threshold ⇒ passed, humanized body applied;
 *  - multi-detector panel reported in full;
 *  - CANNOT clear the panel ⇒ FLAGGED for human, scores VERBATIM, NEVER force-passed;
 *  - meaning-drift ⇒ flagged AND the drifted text is NOT applied to the body;
 *  - voice-drift ⇒ flagged;
 *  - providers unavailable ⇒ typed unavailable, NOTHING to persist (never a silent pass);
 *  - determinism: identical inputs ⇒ byte-identical record.
 */

import { describe, expect, it } from "vitest";
import { authenticate } from "./authenticate";
import { ScriptedDetectionProvider } from "./detector";
import { ScriptedHumanizerProvider } from "./humanizer";
import type { VoiceProfile } from "@/lib/types/brand";

const VOICE: VoiceProfile = {
  descriptors: ["calm", "factual"],
  samples: [],
  do: ["explain plainly"],
  dont: ["cheap", "guaranteed"],
};

const ORIGINAL = "We advise expat buyers through the local purchase process with care.";
/** A clean rewrite: no new statistics/superlatives, no banned phrases. */
const CLEAN = "We guide expat buyers through the local purchase process, step by step, with care.";

/** A humanizer that returns a fixed clean rewrite. */
function cleanHumanizer() {
  return new ScriptedHumanizerProvider("hz").rewrite(() => CLEAN);
}

describe("authenticate — happy pass", () => {
  it("clean rewrite + panel below threshold ⇒ passed, humanized body applied", async () => {
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      humanizer: cleanHumanizer(),
      detectors: [new ScriptedDetectionProvider("d1", 0.1), new ScriptedDetectionProvider("d2", 0.2)],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.verdict).toBe("passed");
    expect(res.record.passes).toBe(true);
    expect(res.record.humanized).toBe(true);
    expect(res.record.detection_score).toBe(0.2); // MAX aggregate
    expect(res.record.flaggedReasons).toEqual([]);
    expect(res.record.humanizer).toEqual({ vendor: "hz", applied: true });
    expect(res.bodyToPersist).toBe(CLEAN); // the humanized text becomes the body
  });

  it("reports EVERY detector in the panel verbatim (multi-detector, pilot 2–3)", async () => {
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      humanizer: cleanHumanizer(),
      detectors: [
        new ScriptedDetectionProvider("d1", 0.05),
        new ScriptedDetectionProvider("d2", 0.25),
        new ScriptedDetectionProvider("d3", 0.15),
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.detectors).toHaveLength(3);
    expect(res.record.detectors.map((d) => [d.vendor, d.aiLikelihood])).toEqual([
      ["d1", 0.05],
      ["d2", 0.25],
      ["d3", 0.15],
    ]);
    expect(res.record.aggregate).toMatchObject({ score: 0.25, detectorsAvailable: 3, detectorsBelow: 3 });
    expect(res.record.quorum).toEqual({ required: 3, met: true });
  });
});

describe("authenticate — CANNOT pass the panel ⇒ flagged, never force-passed", () => {
  it("one detector above threshold ⇒ flagged_for_human, scores verbatim, NOT marked clean", async () => {
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      humanizer: cleanHumanizer(),
      detectors: [new ScriptedDetectionProvider("d1", 0.1), new ScriptedDetectionProvider("d2", 0.85)],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.verdict).toBe("flagged_for_human");
    expect(res.record.passes).toBe(false); // NEVER force-passed
    expect(res.record.flaggedReasons).toContain("detection_above_threshold");
    // The offending score is reported VERBATIM, not massaged down to clear the line.
    expect(res.record.detectors.find((d) => d.vendor === "d2")?.aiLikelihood).toBe(0.85);
    expect(res.record.detection_score).toBe(0.85);
    // No drift, so the (still-flagged) humanized rewrite is kept as the base for the human.
    expect(res.record.humanized).toBe(true);
    expect(res.bodyToPersist).toBe(CLEAN);
  });
});

describe("authenticate — meaning/voice drift is caught (and drifted text never applied)", () => {
  it("meaning drift ⇒ flagged even when detection would pass; original body kept", async () => {
    const drifting = new ScriptedHumanizerProvider("hz").rewrite(
      () => `${CLEAN} In fact, 97% of clients close within days.`, // fabricated statistic
    );
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      humanizer: drifting,
      detectors: [new ScriptedDetectionProvider("d1", 0.05), new ScriptedDetectionProvider("d2", 0.05)], // would pass
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.verdict).toBe("flagged_for_human");
    expect(res.record.passes).toBe(false);
    expect(res.record.flaggedReasons).toContain("meaning_drift");
    expect(res.record.drift.meaning.map((m) => m.excerpt)).toContain("97%");
    // Drifted text is DISCARDED — the original body is kept.
    expect(res.record.humanized).toBe(false);
    expect(res.record.humanizer.applied).toBe(false);
    expect(res.bodyToPersist).toBeNull();
  });

  it("voice drift (introduced banned phrase) ⇒ flagged, original body kept", async () => {
    const drifting = new ScriptedHumanizerProvider("hz").rewrite(() => "We offer cheap, careful advice.");
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      humanizer: drifting,
      detectors: [new ScriptedDetectionProvider("d1", 0.05), new ScriptedDetectionProvider("d2", 0.05)],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.flaggedReasons).toContain("voice_drift");
    expect(res.record.drift.voice.map((v) => v.excerpt)).toContain("cheap");
    expect(res.bodyToPersist).toBeNull();
  });
});

describe("authenticate — providers unavailable ⇒ honest, nothing to persist", () => {
  it("humanizer throws ⇒ humanizer_unavailable (never a silent pass)", async () => {
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      humanizer: new ScriptedHumanizerProvider("hz").failNext(new Error("secret prompt inside")),
      detectors: [new ScriptedDetectionProvider("d1", 0.1), new ScriptedDetectionProvider("d2", 0.1)],
    });
    expect(res).toMatchObject({ ok: false, reason: "humanizer_unavailable" });
  });

  it("humanizer returns empty text ⇒ humanizer_empty", async () => {
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      humanizer: new ScriptedHumanizerProvider("hz").rewrite(() => "   "),
      detectors: [new ScriptedDetectionProvider("d1", 0.1), new ScriptedDetectionProvider("d2", 0.1)],
    });
    expect(res).toMatchObject({ ok: false, reason: "humanizer_empty" });
  });

  it("fewer than MIN_DETECTORS available ⇒ detectors_unavailable (partial readings returned)", async () => {
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      humanizer: cleanHumanizer(),
      detectors: [
        new ScriptedDetectionProvider("d1", 0.1),
        new ScriptedDetectionProvider("d2", 0.1).failNext(),
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("detectors_unavailable");
    expect(res.partial).toHaveLength(2);
    expect(res.partial?.find((r) => r.vendor === "d2")?.available).toBe(false);
  });

  it("an EMPTY detector panel (deferred vendors) ⇒ detectors_unavailable", async () => {
    const res = await authenticate({ body: ORIGINAL, voice: VOICE, humanizer: cleanHumanizer(), detectors: [] });
    expect(res).toMatchObject({ ok: false, reason: "detectors_unavailable" });
  });
});

describe("authenticate — determinism", () => {
  it("identical inputs ⇒ byte-identical record (no clock/random)", async () => {
    const run = () =>
      authenticate({
        body: ORIGINAL,
        voice: VOICE,
        humanizer: cleanHumanizer(),
        detectors: [new ScriptedDetectionProvider("d1", 0.1), new ScriptedDetectionProvider("d2", 0.2)],
      });
    const a = await run();
    const b = await run();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.record)).toBe(JSON.stringify(b.record));
  });
});
