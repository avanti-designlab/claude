/**
 * Caption generation — governed like M8 content. Proves the caption is generated in
 * the LOCKED brand voice (voice constraints reach the provider + are reported), that
 * the grounding + voice.dont + 'social_caption' compliance pre-screen guardrails run
 * and FLAG (never gate), and that deferred/empty generation is honest.
 */

import { describe, expect, it } from "vitest";
import { ScriptedContentProvider } from "@/lib/production/content";
import type { VoiceProfile } from "@/lib/types/brand";
import { buildCaptionSpec, CAPTION_GENERATION_CONTENT_TYPE, generateCaption } from "./caption";

const VOICE: VoiceProfile = {
  descriptors: ["confident", "warm"],
  samples: ["We advise, we don’t sell."],
  do: ["Lead with the answer"],
  dont: ["cheap", "act now"],
};

function input(platform?: string) {
  return {
    request: { topic: "a new marina listing", groundingFacts: ["The listing is a 2-bed near the marina."], ...(platform ? { platform } : {}) },
    voice: VOICE,
    vertical: "real-estate" as const,
  };
}

/** A provider that echoes a voice descriptor into the caption (proves voice reached generation). */
function voiceEchoProvider() {
  return new ScriptedContentProvider().script({
    result: (spec) => ({ title: "cap", body: `A ${spec.voice.descriptors[0]} note about the new listing.`, raw: {} }),
  });
}

describe("buildCaptionSpec", () => {
  it("uses 'faq' as the generation analog, carries the voice, minimal playbook mapping, platform in the directive", () => {
    const spec = buildCaptionSpec({ ...input(), request: { topic: "t", groundingFacts: [], platform: "instagram" } });
    expect(spec.contentType).toBe(CAPTION_GENERATION_CONTENT_TYPE); // 'faq'
    expect(spec.voice.descriptors).toEqual(["confident", "warm"]);
    expect(spec.topic).toContain("instagram");
    // a caption is not AEO-page content — no target prompt / templates / schema profile
    expect(spec.playbook.targetPrompt).toBeNull();
    expect(spec.playbook.templates).toEqual([]);
  });
});

describe("generateCaption", () => {
  it("generates in the locked brand voice + reports the enforced descriptors + platform", async () => {
    const out = await generateCaption(voiceEchoProvider(), input("instagram"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toContain("confident"); // the voice descriptor reached generation
    expect(out.report.voiceEnforced).toEqual(["confident", "warm"]);
    expect(out.report.contentType).toBe("caption");
    expect(out.report.platform).toBe("instagram");
  });

  it("flags an ungrounded statistic the caption asserts (grounding pass, not a gate)", async () => {
    const provider = new ScriptedContentProvider().script({
      result: { title: "c", body: "This marina is 98% sold out already.", raw: {} },
    });
    const out = await generateCaption(provider, input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.ungroundedClaims.some((c) => c.excerpt.includes("98"))).toBe(true);
  });

  it("flags a banned voice.dont phrase present in the caption (flag, never gate)", async () => {
    const provider = new ScriptedContentProvider().script({
      result: { title: "c", body: "This is a cheap deal you must grab.", raw: {} },
    });
    const out = await generateCaption(provider, input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.voiceViolations.some((v) => v.excerpt.toLowerCase() === "cheap")).toBe(true);
  });

  it("carries a compliance pre-screen summary (screened as social_caption, honest disclaimer)", async () => {
    const out = await generateCaption(voiceEchoProvider(), input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(typeof out.report.compliancePrescreen.pass).toBe("boolean");
    expect(Array.isArray(out.report.compliancePrescreen.blockedRuleIds)).toBe(true);
    expect(out.report.compliancePrescreen.disclaimer).toBeTruthy();
  });

  it("empty generation → empty_generation (nothing to persist)", async () => {
    const provider = new ScriptedContentProvider().script({ result: { title: "", body: "   ", raw: {} } });
    expect(await generateCaption(provider, input())).toMatchObject({ ok: false, reason: "empty_generation" });
  });

  it("a throwing (deferred) provider → generation_unavailable, cause retained, no raw cause as content", async () => {
    const provider = new ScriptedContentProvider().failNext(new Error("secret prompt leaked"));
    const out = await generateCaption(provider, input());
    expect(out).toMatchObject({ ok: false, reason: "generation_unavailable" });
    if (out.ok) return;
    expect(out.cause).toBeInstanceOf(Error);
  });
});
