/**
 * generateContentDraft — the GENERATE step (provider injected; no DB, no auth,
 * no SDK). Pins the review-gated hard properties of generation:
 *  - the draft is MAPPED to the playbook + generated in the LOCKED voice, and
 *    those constraints demonstrably reach the provider;
 *  - the compliance ruleset is applied as a generation guardrail AND the
 *    post-gen pre-screen flags a vertical-prohibited claim that leaks through;
 *  - anti-fabrication: an ungrounded statistic is flagged, never emitted as fact;
 *  - honest failures: deferred/thrown provider → generation_unavailable; an
 *    empty body → empty_generation. M8 flags; it never gates.
 */

import { describe, expect, it } from "vitest";
import { cannabisPlaybook, realEstatePlaybook } from "@/lib/playbooks";
import type { VoiceProfile } from "@/lib/types/brand";
import { generateContentDraft } from "./generate";
import { ScriptedContentProvider } from "./provider";

const VOICE: VoiceProfile = {
  descriptors: ["confident", "precise"],
  samples: ["We advise, we don’t sell."],
  do: ["cite sources"],
  dont: ["hype"],
};

describe("generateContentDraft — playbook mapping + voice enforcement", () => {
  it("maps to the playbook and enforces the locked voice, and both reach the provider", async () => {
    const provider = new ScriptedContentProvider().script({
      result: (spec) => ({
        title: `On ${spec.topic}`,
        // Echo the constraints so we can prove they were passed through.
        body: `A calm overview. voice:${spec.voice.descriptors.join(",")} templates:${spec.playbook.templates.length}`,
        raw: {},
      }),
    });

    const out = await generateContentDraft(provider, {
      request: { contentType: "pillar", topic: "the buying process", groundingFacts: [] },
      playbook: realEstatePlaybook,
      voice: VOICE,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The provider received the full constrained spec.
    const spec = provider.calls[0];
    expect(spec.voice.descriptors).toEqual(["confident", "precise"]);
    expect(spec.playbook.vertical).toBe("real-estate");
    expect(spec.playbook.targetPrompt).toBe(realEstatePlaybook.prompt_library.find((e) => e.priority === "high")!.prompt);
    expect(spec.complianceGuardrails.length).toBeGreaterThan(0); // real-estate has block rules
    // The report reflects the enforced voice + mapping.
    expect(out.report.voiceEnforced).toEqual(["confident", "precise"]);
    expect(out.report.playbookMapping.vertical).toBe("real-estate");
    expect(out.report.vendor).toBe("scripted-fake");
    expect(out.report.contentType).toBe("pillar");
  });
});

describe("generateContentDraft — compliance guardrail applied at generation", () => {
  it("flags a vertical-prohibited claim that leaks into the body (pre-screen block)", async () => {
    // A hostile/careless provider emits a cannabis disease claim.
    const provider = new ScriptedContentProvider().script({
      result: { title: "Strain guide", body: "This product treats anxiety and cures insomnia.", raw: {} },
    });

    const out = await generateContentDraft(provider, {
      request: { contentType: "blog", topic: "strain guide", groundingFacts: [] },
      playbook: cannabisPlaybook,
      voice: VOICE,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The block rules were rendered into guardrails up front...
    expect(provider.calls[0].complianceGuardrails.length).toBeGreaterThan(0);
    // ...and the post-gen pre-screen flags the leak (compliance-review is still the HARD gate).
    expect(out.report.compliancePrescreen.pass).toBe(false);
    expect(out.report.compliancePrescreen.blockedRuleIds).toContain("cannabis.health-claims");
    // The draft is STILL produced (M8 flags; it does not gate) — the pre-approval
    // status + hard gate downstream are what block publication.
    expect(out.body).toContain("treats anxiety");
  });
});

describe("generateContentDraft — anti-fabrication grounding", () => {
  it("flags an ungrounded statistic the input never provided", async () => {
    const provider = new ScriptedContentProvider().script({
      result: { title: "t", body: "Our clients see a 98% approval rate.", raw: {} },
    });
    const out = await generateContentDraft(provider, {
      request: { contentType: "blog", topic: "mortgages", groundingFacts: ["We help expats with mortgages."] },
      playbook: realEstatePlaybook,
      voice: VOICE,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.ungroundedClaims.map((c) => c.excerpt)).toContain("98%");
  });

  it("does NOT flag a statistic that the grounding facts support", async () => {
    const provider = new ScriptedContentProvider().script({
      result: { title: "t", body: "We have closed 500 transactions.", raw: {} },
    });
    const out = await generateContentDraft(provider, {
      request: { contentType: "blog", topic: "track record", groundingFacts: ["Closed 500 transactions since 2018."] },
      playbook: realEstatePlaybook,
      voice: VOICE,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.ungroundedClaims).toEqual([]);
  });
});

describe("generateContentDraft — honest failures", () => {
  it("returns generation_unavailable when the provider rejects (deferred adapter / vendor down)", async () => {
    const provider = new ScriptedContentProvider().failNext(new Error("deferred"));
    const out = await generateContentDraft(provider, {
      request: { contentType: "blog", topic: "t", groundingFacts: [] },
      playbook: realEstatePlaybook,
      voice: VOICE,
    });
    expect(out).toMatchObject({ ok: false, reason: "generation_unavailable" });
  });

  it("returns empty_generation when the provider produces no body", async () => {
    const provider = new ScriptedContentProvider().script({ result: { title: "t", body: "   ", raw: {} } });
    const out = await generateContentDraft(provider, {
      request: { contentType: "blog", topic: "t", groundingFacts: [] },
      playbook: realEstatePlaybook,
      voice: VOICE,
    });
    expect(out).toMatchObject({ ok: false, reason: "empty_generation" });
  });
});
