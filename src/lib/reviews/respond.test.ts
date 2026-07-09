/**
 * M15 DRAFT RESPONSE (pure). Drafts in brand voice through the reused
 * ContentGenerationProvider port; grounds against review+context; compliance
 * pre-screens as 'review_response'; the draft is structurally pre-approval and
 * un-sendable. Provider injected — no network, no SDK.
 */

import { describe, expect, it } from "vitest";
import { ScriptedContentProvider } from "@/lib/production/content";
import type { VoiceProfile } from "@/lib/types/brand";
import type { Vertical } from "@/lib/types/playbook";
import {
  buildReviewResponseSpec,
  draftReviewResponse,
  responseGroundingFacts,
  RESPONSE_GENERATION_CONTENT_TYPE,
  REVIEW_RESPONSE_DRAFT_STATUS,
  type DraftReviewResponseInput,
} from "./respond";
import type { IngestedReview } from "./types";

const VERTICAL: Vertical = "real-estate";

const VOICE: VoiceProfile = {
  descriptors: ["warm", "professional"],
  samples: ["We’re grateful for every client."],
  do: ["thank the reviewer"],
  dont: ["cheap"],
};

function review(over: Partial<IngestedReview> = {}): IngestedReview {
  return {
    platform: "google",
    author: "Jordan",
    rating: 2,
    ratingScale: 5,
    text: "The closing took longer than I expected and communication was slow.",
    postedAt: "2026-07-01T00:00:00Z",
    externalId: "g-1",
    ...over,
  };
}

function input(over: Partial<DraftReviewResponseInput> = {}): DraftReviewResponseInput {
  return {
    request: { review: review(), contextFacts: ["We now send weekly closing updates."] },
    voice: VOICE,
    vertical: VERTICAL,
    ...over,
  };
}

describe("buildReviewResponseSpec + responseGroundingFacts", () => {
  it("grounds on the review text + the context facts, and nothing else", () => {
    const req = { review: review(), contextFacts: ["We offer a 30-day follow-up."] };
    expect(responseGroundingFacts(req)).toEqual([
      "The closing took longer than I expected and communication was slow.",
      "We offer a 30-day follow-up.",
    ]);
  });

  it("uses the nearest generation analog (faq) with the review-response framing in the topic", () => {
    const spec = buildReviewResponseSpec(input());
    expect(spec.contentType).toBe(RESPONSE_GENERATION_CONTENT_TYPE);
    expect(spec.contentType).toBe("faq");
    expect(spec.topic).toMatch(/response to a negative/i);
    expect(spec.topic).toContain("google");
    // A review reply is not AEO-mapped content — the playbook mapping is minimal.
    expect(spec.playbook.targetPrompt).toBeNull();
    expect(spec.playbook.templates).toEqual([]);
    expect(spec.playbook.vertical).toBe("real-estate");
  });
});

describe("draftReviewResponse — brand voice reaches the provider", () => {
  it("passes the LOCKED voice into the spec and enforces it (voiceEnforced = descriptors)", async () => {
    const provider = new ScriptedContentProvider().script({
      // Prove the voice + grounding reached the provider by echoing them back.
      result: (spec) => ({
        title: "Response",
        body: `[${spec.voice.descriptors.join(",")}] Thank you, Jordan — we've fixed our updates.`,
        raw: {},
      }),
    });
    const res = await draftReviewResponse(provider, input());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.report.voiceEnforced).toEqual(["warm", "professional"]);
    expect(res.draft.body).toContain("[warm,professional]");
    // The exact voice constraint crossed the port.
    expect(provider.calls[0].voice.descriptors).toEqual(["warm", "professional"]);
    expect(provider.calls[0].voice.dont).toEqual(["cheap"]);
  });
});

describe("draftReviewResponse — structural pre-approval (never auto-sends)", () => {
  it("pins status='draft_pending_human_approval'; there is no sent state", async () => {
    const provider = new ScriptedContentProvider().script({
      result: { title: "R", body: "Thank you for the honest feedback, Jordan.", raw: {} },
    });
    const res = await draftReviewResponse(provider, input());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.status).toBe(REVIEW_RESPONSE_DRAFT_STATUS);
    expect(res.draft.status).toBe("draft_pending_human_approval");
    // The draft is a plain artifact — no send/post/publish affordance on it.
    expect((res.draft as unknown as Record<string, unknown>).send).toBeUndefined();
    expect(res.draft.report.responseType).toBe("review_response");
  });
});

describe("draftReviewResponse — grounding flags fabricated facts", () => {
  it("flags a statistic the review + context did not support", async () => {
    const provider = new ScriptedContentProvider().script({
      // 92% appears in neither the review nor the context facts → ungrounded.
      result: { title: "R", body: "We resolve 92% of closings ahead of schedule.", raw: {} },
    });
    const res = await draftReviewResponse(provider, input());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.report.ungroundedClaims.some((c) => c.excerpt.includes("92"))).toBe(true);
  });

  it("does NOT flag a figure that is present in a context fact", async () => {
    const provider = new ScriptedContentProvider().script({
      result: { title: "R", body: "We now send weekly updates for 30 days after signing.", raw: {} },
    });
    const res = await draftReviewResponse(
      provider,
      input({ request: { review: review(), contextFacts: ["We provide 30 days of weekly updates."] } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.report.ungroundedClaims.some((c) => c.excerpt.includes("30"))).toBe(false);
  });
});

describe("draftReviewResponse — compliance pre-screen for review_response", () => {
  it("flags a Fair-Housing steering phrase in a real-estate reply (block)", async () => {
    const provider = new ScriptedContentProvider().script({
      result: { title: "R", body: "Thanks! This community is perfect for families like yours.", raw: {} },
    });
    const res = await draftReviewResponse(provider, input());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const pre = res.draft.report.compliancePrescreen;
    expect(pre.pass).toBe(false);
    expect(pre.blockedRuleIds).toContain("real-estate.fair-housing-preference");
  });

  it("flags a banned voice.dont phrase the reply introduced", async () => {
    const provider = new ScriptedContentProvider().script({
      result: { title: "R", body: "Our service is never cheap, and we stand by our value.", raw: {} },
    });
    const res = await draftReviewResponse(provider, input());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.report.voiceViolations.some((v) => v.excerpt.toLowerCase() === "cheap")).toBe(true);
  });
});

describe("draftReviewResponse — honest failures (never a silent pass)", () => {
  it("a rejecting provider → generation_unavailable (raw cause not surfaced as content)", async () => {
    const provider = new ScriptedContentProvider().failNext(new Error("secret prompt boom"));
    const res = await draftReviewResponse(provider, input());
    expect(res).toMatchObject({ ok: false, reason: "generation_unavailable" });
  });

  it("an empty body → empty_generation (nothing to draft)", async () => {
    const provider = new ScriptedContentProvider().script({ result: { title: "", body: "   ", raw: {} } });
    const res = await draftReviewResponse(provider, input());
    expect(res).toMatchObject({ ok: false, reason: "empty_generation" });
  });
});
