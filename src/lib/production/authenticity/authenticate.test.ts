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
      vertical: "real-estate",
      contentType: "blog",
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
      vertical: "real-estate",
      contentType: "blog",
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
      vertical: "real-estate",
      contentType: "blog",
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
      vertical: "real-estate",
      contentType: "blog",
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
      vertical: "real-estate",
      contentType: "blog",
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

describe("authenticate — post-humanization compliance re-screen (drop/violation the drift can't see)", () => {
  const RE_DETECTORS = () => [new ScriptedDetectionProvider("d1", 0.05), new ScriptedDetectionProvider("d2", 0.05)];

  it("humanizer DROPS a required disclaimer ⇒ compliance_regression flagged, original kept", async () => {
    // Original satisfies the real-estate regulatory-freshness required element ("Last verified");
    // the humanizer rewrites it OUT — neither a stat/superlative nor a banned phrase, so drift passes.
    const original = "Golden visa rules for Dubai buyers. Last verified January 2025. Foreign buyers can apply.";
    const dropping = new ScriptedHumanizerProvider("hz").rewrite(
      () => "Golden visa rules for Dubai buyers. Foreign buyers can apply.",
    );
    const res = await authenticate({
      body: original,
      voice: VOICE,
      vertical: "real-estate",
      contentType: "blog",
      humanizer: dropping,
      detectors: RE_DETECTORS(), // detection would pass
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.verdict).toBe("flagged_for_human");
    expect(res.record.passes).toBe(false);
    expect(res.record.flaggedReasons).toContain("compliance_regression");
    // Drift did NOT catch it (no new stat/superlative/banned phrase) — compliance did.
    expect(res.record.drift.detected).toBe(false);
    // The dropped required element is surfaced for the human resolver.
    expect(res.record.complianceRegression.droppedRequiredRuleIds).toContain("real-estate.regulatory-freshness");
    // The humanized (non-compliant) text is NOT applied — the compliant original is kept.
    expect(res.record.humanized).toBe(false);
    expect(res.bodyToPersist).toBeNull();
  });

  it("humanizer INTRODUCES a Fair-Housing block phrase ⇒ compliance_regression flagged, original kept", async () => {
    // "perfect for growing families" is a Fair-Housing preference violation but NOT a stat/superlative/banned phrase.
    const original = "This home has four bedrooms and a large yard near downtown.";
    const violating = new ScriptedHumanizerProvider("hz").rewrite(
      () => "This home is perfect for growing families, with four bedrooms near downtown.",
    );
    const res = await authenticate({
      body: original,
      voice: VOICE,
      vertical: "real-estate",
      contentType: "blog",
      humanizer: violating,
      detectors: RE_DETECTORS(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.flaggedReasons).toContain("compliance_regression");
    expect(res.record.drift.detected).toBe(false); // drift is blind to it — compliance re-screen catches it
    expect(res.record.complianceRegression.newBlockRuleIds).toContain("real-estate.fair-housing-preference");
    expect(res.record.humanized).toBe(false);
    expect(res.bodyToPersist).toBeNull();
  });

  it("clean humanization ⇒ applied + FRESH prescreen (on the shipping body) attached", async () => {
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      vertical: "real-estate",
      contentType: "blog",
      humanizer: cleanHumanizer(),
      detectors: [new ScriptedDetectionProvider("d1", 0.1), new ScriptedDetectionProvider("d2", 0.2)],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.verdict).toBe("passed");
    expect(res.record.humanized).toBe(true);
    expect(res.bodyToPersist).toBe(CLEAN);
    // The fresh prescreen describes the SHIPPING (humanized) body — clean.
    expect(res.record.compliancePrescreen.pass).toBe(true);
    expect(res.record.compliancePrescreen.blockCount).toBe(0);
    expect(res.record.compliancePrescreen.disclaimer).toContain("not legal review");
    expect(res.record.complianceRegression.regressed).toBe(false);
  });

  it("M9 self-clear guard: the record carries NO review-verdict columns (it flags, it never approves)", async () => {
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      vertical: "real-estate",
      contentType: "blog",
      humanizer: cleanHumanizer(),
      detectors: [new ScriptedDetectionProvider("d1", 0.1), new ScriptedDetectionProvider("d2", 0.2)],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The compliance prescreen is a GUARDRAIL summary, never the compliance_review verdict.
    expect(res.record).not.toHaveProperty("compliance_review");
    expect(res.record).not.toHaveProperty("quality_review");
    expect(res.record).not.toHaveProperty("status");
  });
});

describe("authenticate — providers unavailable ⇒ honest, nothing to persist", () => {
  it("humanizer throws ⇒ humanizer_unavailable (never a silent pass)", async () => {
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      vertical: "real-estate",
      contentType: "blog",
      humanizer: new ScriptedHumanizerProvider("hz").failNext(new Error("secret prompt inside")),
      detectors: [new ScriptedDetectionProvider("d1", 0.1), new ScriptedDetectionProvider("d2", 0.1)],
    });
    expect(res).toMatchObject({ ok: false, reason: "humanizer_unavailable" });
  });

  it("humanizer returns empty text ⇒ humanizer_empty", async () => {
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      vertical: "real-estate",
      contentType: "blog",
      humanizer: new ScriptedHumanizerProvider("hz").rewrite(() => "   "),
      detectors: [new ScriptedDetectionProvider("d1", 0.1), new ScriptedDetectionProvider("d2", 0.1)],
    });
    expect(res).toMatchObject({ ok: false, reason: "humanizer_empty" });
  });

  it("fewer than MIN_DETECTORS available ⇒ detectors_unavailable (partial readings returned)", async () => {
    const res = await authenticate({
      body: ORIGINAL,
      voice: VOICE,
      vertical: "real-estate",
      contentType: "blog",
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
    const res = await authenticate({ body: ORIGINAL, voice: VOICE, vertical: "real-estate", contentType: "blog", humanizer: cleanHumanizer(), detectors: [] });
    expect(res).toMatchObject({ ok: false, reason: "detectors_unavailable" });
  });
});

describe("authenticate — determinism", () => {
  it("identical inputs ⇒ byte-identical record (no clock/random)", async () => {
    const run = () =>
      authenticate({
        body: ORIGINAL,
        voice: VOICE,
        vertical: "real-estate",
        contentType: "blog",
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
