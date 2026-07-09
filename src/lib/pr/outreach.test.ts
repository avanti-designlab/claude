/**
 * M12 outreach DRAFTER — human-assisted, structurally un-sendable (mirror M15).
 * Grounded (no fabricated credentials/press), gate-flagged, voice-enforced.
 */

import { describe, expect, it, vi } from "vitest";

// index.ts re-exports the server-only persist module; neutralize the guard so
// this client-side test can import the module surface to assert no send path.
vi.mock("server-only", () => ({}));

import { ScriptedContentProvider } from "@/lib/production/content";
import type { VoiceProfile } from "@/lib/types/brand";
import type { Vertical } from "@/lib/types/playbook";
import {
  buildOutreachSpec,
  draftOutreachPitch,
  outreachGroundingFacts,
  OUTREACH_DRAFT_STATUS,
  type DraftOutreachInput,
} from "./outreach";
import * as prModule from "./index";
import type { EntityAuthorityReport } from "./types";

const VERTICAL: Vertical = "real-estate";
const VOICE: VoiceProfile = { descriptors: ["warm", "credible"], samples: ["We serve North Park."], do: ["be specific"], dont: ["cheap"] };

function input(over: Partial<DraftOutreachInput> = {}): DraftOutreachInput {
  return {
    request: {
      targetPublication: "Inman",
      angle: "How AI answer engines are reshaping how buyers find agents",
      groundingFacts: ["Daniel Reyes founded GG Realty in 2015.", "Featured in Forbes (corroborated on-site)."],
    },
    voice: VOICE,
    vertical: VERTICAL,
    ...over,
  };
}

describe("no send path (governance — CLAUDE.md rule 5)", () => {
  it("the pr module exports NO send/post/email/submit/publish outreach path", () => {
    const sendish = Object.keys(prModule).filter((k) => /(^|_)(send|post|email|submit|publish|fire)/i.test(k) && /outreach|pitch/i.test(k));
    expect(sendish).toEqual([]);
    // The only outreach entry points are the drafter + its pure helpers.
    expect(typeof prModule.draftOutreachPitch).toBe("function");
  });

  it("a successful draft is pinned to pre-approval; there is no 'sent' status to reach", async () => {
    const provider = new ScriptedContentProvider().script({ result: { title: "Pitch", body: "Hi Inman, Daniel Reyes founded GG Realty in 2015.", raw: {} } });
    const out = await draftOutreachPitch(provider, input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.status).toBe(OUTREACH_DRAFT_STATUS);
    expect(OUTREACH_DRAFT_STATUS).toBe("draft_pending_human_approval");
  });
});

describe("grounding + gate flags (generated content → the gates)", () => {
  it("refuses up front when there is nothing genuine to assert (no_grounding)", async () => {
    const provider = new ScriptedContentProvider().script({ result: { title: "Pitch", body: "should never be generated", raw: {} } });
    const out = await draftOutreachPitch(provider, input({ request: { targetPublication: "Inman", angle: "x", groundingFacts: [] } }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("no_grounding");
    expect(provider.calls).toHaveLength(0); // never even called the LLM
  });

  it("flags an ungrounded fabricated statistic the pitch introduces (never emitted as fact)", async () => {
    const provider = new ScriptedContentProvider().script({
      result: { title: "Pitch", body: "Daniel Reyes founded GG Realty and closed 4,321 deals with a 99% satisfaction rate.", raw: {} },
    });
    const out = await draftOutreachPitch(provider, input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.report.ungroundedClaims.length).toBeGreaterThan(0);
  });

  it("carries a compliance pre-screen + enforces the brand voice descriptors", async () => {
    const provider = new ScriptedContentProvider().script({ result: { title: "Pitch", body: "Daniel Reyes founded GG Realty in 2015.", raw: {} } });
    const out = await draftOutreachPitch(provider, input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.report.compliancePrescreen).toBeDefined();
    expect(out.draft.report.voiceEnforced).toEqual(["warm", "credible"]);
    expect(out.draft.report.outreachType).toBe("pr_outreach_pitch");
  });

  it("a deferred/unavailable provider maps to generation_unavailable (raw cause not leaked as content)", async () => {
    const provider = new ScriptedContentProvider().failNext(new Error("vendor 500"));
    const out = await draftOutreachPitch(provider, input());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("generation_unavailable");
  });

  it("empty generation → empty_generation", async () => {
    const provider = new ScriptedContentProvider().script({ result: { title: "Pitch", body: "   ", raw: {} } });
    const out = await draftOutreachPitch(provider, input());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("empty_generation");
  });
});

describe("outreachGroundingFacts — seeds from CORROBORATED press only", () => {
  it("includes corroborated press + on-page person, excludes uncorroborated claims", () => {
    const report: EntityAuthorityReport = {
      vertical: "real-estate",
      crawledAt: "2026-07-01T00:00:00.000Z",
      assessable: true,
      person: { status: "assessed", keyPersonName: "Daniel Reyes", namePresentOnPage: true, personSchemaPresent: true, sameAsPresentInSchema: true, notes: [] },
      press: {
        status: "assessed",
        pressSectionPresent: true,
        claimedPress: [
          { publication: "Forbes", url: null, mentionedOnPage: true, note: "" },
          { publication: "Inman", url: null, mentionedOnPage: false, note: "" },
        ],
        corroboratedCount: 1,
        claimedCount: 2,
        notes: [],
      },
      coverage: null,
      fixes: [],
    };
    const facts = outreachGroundingFacts(report, ["Serves North Park since 2015."]);
    expect(facts.some((f) => f.includes("Forbes"))).toBe(true);
    expect(facts.some((f) => f.includes("Inman"))).toBe(false); // uncorroborated — never asserted
    expect(facts.some((f) => f.includes("North Park"))).toBe(true);
  });
});

describe("buildOutreachSpec", () => {
  it("maps the pitch as non-AEO content (no target prompt / templates)", () => {
    const spec = buildOutreachSpec(input());
    expect(spec.playbook.targetPrompt).toBeNull();
    expect(spec.playbook.templates).toEqual([]);
    expect(spec.topic).toContain("Inman");
  });
});
