/**
 * M15 DRAFT RESPONSE — draft an on-brand reply to a review, through the SAME
 * content pipeline as M8 (doc 05 M15 "draft on-brand responses (through the
 * content pipeline)"). Pure w.r.t. the platform: the LLM is the injected
 * {@link ContentGenerationProvider} port (reused from M8 — the SAME deferred
 * Anthropic seam, no second LLM port), no DB, no auth, no logging.
 *
 * WHY IT CANNOT AUTO-SEND (the governance spine, CLAUDE.md rule 5, doc 00 §2):
 *  - The output is a {@link ReviewResponseDraft} whose `status` is HARD-PINNED to
 *    {@link REVIEW_RESPONSE_DRAFT_STATUS} ('draft_pending_human_approval') — it is
 *    not a parameter; no caller can raise it to a "sent" state through here.
 *  - There is NO send/post/reply path in `src/lib/reviews/` at all: the monitor
 *    port is READ-ONLY (provider.ts), so this module structurally cannot transmit
 *    a reply. Publishing a response is a separate human-approved write (a social/
 *    reply connector wired by integrations at 1.7), never fired from a draft.
 *  - content-quality + compliance-review remain the hard gates; this flags, it
 *    never clears itself.
 *
 * GROUNDING (task point 3): a response must assert NO fact not present in the
 * review or the caller-supplied client context. It reuses M8's `findUngroundedClaims`
 * READ-ONLY (imported from @/lib/production/content), grounding the drafted reply
 * against [the review text, ...contextFacts] — any statistic/superlative the reply
 * introduces beyond that is flagged for the gates (exactly as M9's drift reuses the
 * same pass against the original body).
 *
 * COMPLIANCE PRE-SCREEN (generation-time guardrail): the drafted reply is screened
 * with the compliance skill under its OWN content type — `'review_response'` (the
 * skill supports it) — so vertical rules that apply to public replies (e.g.
 * real-estate Fair-Housing steering) surface before the hard gate. The pre-screen
 * is NOT the verdict; compliance-review is.
 */

import { checkCompliance } from "@/lib/skills/compliance";
import {
  deriveComplianceGuardrails,
  findBannedVoicePhrases,
  findUngroundedClaims,
  summarizeCompliancePrescreen,
  type BannedVoicePhrase,
  type CompliancePrescreen,
  type ContentGenerationProvider,
  type ContentGenerationSpec,
  type GeneratableContentType,
  type UngroundedClaim,
} from "@/lib/production/content";
import type { VoiceProfile } from "@/lib/types/brand";
import type { Vertical } from "@/lib/types/playbook";
import { classifyReviewSentiment } from "./sentiment";
import type { IngestedReview, ReviewSentiment } from "./types";

/* ------------------------------------------------------------------ */
/* The pinned pre-approval status + the generation-taxonomy nearest analog */
/* ------------------------------------------------------------------ */

/** The ONLY status a drafted response ever carries — pinned pre-approval, never "sent". */
export const REVIEW_RESPONSE_DRAFT_STATUS = "draft_pending_human_approval" as const;

/**
 * A review response has no dedicated content type in M8's GENERATION taxonomy
 * (`GeneratableContentType` = blog|faq|pillar). A public reply is a short
 * direct-answer message, so `faq` is the nearest structural analog we hand the
 * generation port; the AUTHORITATIVE nature of the request is carried in the spec
 * `topic` directive + the {@link ReviewResponseReport} `responseType`, and the
 * compliance pre-screen uses the correct `'review_response'` type. The honest
 * long-term fix (a real `review_response` generation type) is flagged by
 * REVIEW_RESPONSE_GENERATION_TYPE_GAP (rows.ts).
 */
export const RESPONSE_GENERATION_CONTENT_TYPE = "faq" as const satisfies GeneratableContentType;

/* ------------------------------------------------------------------ */
/* Contracts                                                           */
/* ------------------------------------------------------------------ */

export interface ReviewResponseRequest {
  /** The review being replied to (from a prior monitor pull; not persisted here). */
  review: IngestedReview;
  /**
   * Client-supplied facts the reply MAY assert (e.g. "We offer a 30-day
   * refund"). Together with the review text these are the ONLY grounding — a
   * reply asserting anything beyond them is flagged ungrounded.
   */
  contextFacts: string[];
}

/** Evidence the drafted reply carries into the gates (JSON-serializable; no PII beyond the reply). */
export interface ReviewResponseReport {
  vendor: string;
  /** The authoritative content type (the generation-spec type is the nearest analog — see above). */
  responseType: "review_response";
  reviewPlatform: string;
  reviewSentiment: ReviewSentiment;
  /** Brand voice descriptors enforced at generation. */
  voiceEnforced: string[];
  /** Facts the reply asserts that the review + context did not support — flagged, never emitted as fact. */
  ungroundedClaims: UngroundedClaim[];
  /** Banned voice.dont phrases present in the drafted reply — flagged, never gated. */
  voiceViolations: BannedVoicePhrase[];
  /** Compliance guardrail result under `'review_response'` (NOT the compliance-review verdict). */
  compliancePrescreen: CompliancePrescreen;
}

/** The pre-approval artifact — structurally un-sendable (see the module header). */
export interface ReviewResponseDraft {
  /** Pinned pre-approval; there is no exported transition to a "sent" state. */
  status: typeof REVIEW_RESPONSE_DRAFT_STATUS;
  body: string;
  report: ReviewResponseReport;
}

export type DraftReviewResponseOutcome =
  | { ok: true; draft: ReviewResponseDraft }
  | { ok: false; reason: "generation_unavailable" | "empty_generation"; cause?: unknown };

export interface DraftReviewResponseInput {
  request: ReviewResponseRequest;
  /** The LOCKED brand voice (the action refuses to reach here without a kit). */
  voice: VoiceProfile;
  /** The client's vertical — drives the compliance pre-screen + generation guardrails. */
  vertical: Vertical;
}

/* ------------------------------------------------------------------ */
/* Spec construction                                                   */
/* ------------------------------------------------------------------ */

/** The locked voice → a spec-shaped constraint (defensive copies). */
function toVoiceConstraint(voice: VoiceProfile): ContentGenerationSpec["voice"] {
  return {
    descriptors: [...(voice.descriptors ?? [])],
    samples: [...(voice.samples ?? [])],
    do: [...(voice.do ?? [])],
    dont: [...(voice.dont ?? [])],
  };
}

/** The facts a reply may assert: the review text itself + the caller's context facts. */
export function responseGroundingFacts(request: ReviewResponseRequest): string[] {
  const facts: string[] = [];
  if (typeof request.review.text === "string" && request.review.text.trim() !== "") {
    facts.push(request.review.text.trim());
  }
  for (const fact of request.contextFacts) {
    if (typeof fact === "string" && fact.trim() !== "") facts.push(fact.trim());
  }
  return facts;
}

/**
 * Build the generation spec for a review reply. Voice + compliance guardrails +
 * grounding are constraints AT GENERATION (generic/off-brand/non-compliant/
 * fabricated replies steered away up front, not patched after). The `playbook`
 * mapping is minimal + honest — a review reply is NOT AEO-mapped content (no
 * target prompt, no templates/schema profile).
 */
export function buildReviewResponseSpec(input: DraftReviewResponseInput): ContentGenerationSpec {
  const { request, voice, vertical } = input;
  const { review } = request;
  const { sentiment } = classifyReviewSentiment(review);
  const scale = Number.isFinite(review.ratingScale) && review.ratingScale > 0 ? review.ratingScale : 5;
  const ratingLabel = typeof review.rating === "number" ? `${review.rating}/${scale}-star ` : "";

  return {
    contentType: RESPONSE_GENERATION_CONTENT_TYPE,
    topic:
      `Write a public, on-brand response to a ${sentiment} ${ratingLabel}review on ` +
      `${review.platform}. Address the reviewer's specific points; assert no fact ` +
      `not present in the review or the provided client context.`,
    groundingFacts: responseGroundingFacts(request),
    voice: toVoiceConstraint(voice),
    playbook: {
      vertical,
      templates: [],
      schemaProfile: [],
      entitySignals: [],
      targetPrompt: null,
    },
    complianceGuardrails: deriveComplianceGuardrails(vertical),
  };
}

/* ------------------------------------------------------------------ */
/* draftReviewResponse                                                 */
/* ------------------------------------------------------------------ */

/**
 * Draft one review response. The provider is injected; a thrown/rejected provider
 * (the deferred adapter, a timeout, a vendor error) maps to
 * `generation_unavailable` WITHOUT surfacing the raw cause as content. An empty
 * body is `empty_generation`. On success the reply passes the grounding + voice +
 * compliance-pre-screen guardrails and returns a PRE-APPROVAL draft — flagged, never
 * cleared, never sent.
 */
export async function draftReviewResponse(
  provider: ContentGenerationProvider,
  input: DraftReviewResponseInput,
): Promise<DraftReviewResponseOutcome> {
  const spec = buildReviewResponseSpec(input);

  let result;
  try {
    result = await provider.generate(spec);
  } catch (cause) {
    return { ok: false, reason: "generation_unavailable", cause };
  }

  const body = typeof result?.body === "string" ? result.body.trim() : "";
  if (body === "") return { ok: false, reason: "empty_generation" };

  const ungroundedClaims = findUngroundedClaims(body, spec.groundingFacts);
  const voiceViolations = findBannedVoicePhrases(body, spec.voice.dont);
  const prescreen = checkCompliance({
    vertical: input.vertical,
    contentType: "review_response",
    content: { text: body },
  });
  const { sentiment } = classifyReviewSentiment(input.request.review);

  return {
    ok: true,
    draft: {
      status: REVIEW_RESPONSE_DRAFT_STATUS,
      body,
      report: {
        vendor: provider.vendor,
        responseType: "review_response",
        reviewPlatform: input.request.review.platform,
        reviewSentiment: sentiment,
        voiceEnforced: spec.voice.descriptors,
        ungroundedClaims,
        voiceViolations,
        compliancePrescreen: summarizeCompliancePrescreen(prescreen),
      },
    },
  };
}
