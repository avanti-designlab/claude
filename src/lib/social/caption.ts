/**
 * M11 CAPTION — draft an on-brand social caption through the SAME content pipeline
 * as M8 (doc 05 Part B: captions run "through the full pipeline incl. humanization
 * + compliance"). Pure w.r.t. the platform: the LLM is the injected
 * {@link ContentGenerationProvider} port (REUSED from M8 — the SAME deferred
 * Anthropic seam, no second LLM port), no DB, no auth, no logging.
 *
 * BRAND VOICE FROM THE START (doc 05 — generic-AI output prevented at generation).
 * Voice descriptors/samples/do/dont from the LOCKED kit are constraints IN the spec;
 * the caller cannot bypass them. The post-generation guardrails (grounding +
 * voice.dont screen + the 'social_caption' compliance pre-screen) FLAG leakage for
 * the gates — M11 flags, the hard gates (content-quality + compliance-review) decide.
 *
 * GROUNDING (anti-fabrication): a caption asserts NO fact not present in the
 * caller-supplied grounding set. Reuses M8's `findUngroundedClaims` READ-ONLY, so a
 * statistic/superlative the caption introduces beyond the grounding facts is flagged
 * (exactly as M15's review-reply drafting reuses the same pass).
 *
 * COMPLIANCE PRE-SCREEN under the caption's OWN content type — 'social_caption'
 * (the compliance skill supports it) — with the target platform passed through, so
 * platform-specific rules (e.g. cannabis on Meta) surface before the hard gate. The
 * pre-screen is NOT the verdict; compliance-review is.
 */

import { checkCompliance } from "@/lib/skills/compliance";
import {
  deriveComplianceGuardrails,
  findBannedVoicePhrases,
  findUngroundedClaims,
  summarizeCompliancePrescreen,
  type ContentGenerationProvider,
  type ContentGenerationSpec,
  type GeneratableContentType,
} from "@/lib/production/content";
import type { VoiceProfile } from "@/lib/types/brand";
import type { Vertical } from "@/lib/types/playbook";
import type { CaptionReport } from "./types";

/**
 * A caption has no dedicated type in M8's GENERATION taxonomy
 * (`GeneratableContentType` = blog|faq|pillar). A caption is a short, direct
 * message, so `faq` is the nearest structural analog we hand the generation port;
 * the AUTHORITATIVE nature rides in the spec `topic` directive + the
 * {@link CaptionReport} `contentType: 'caption'`, the compliance pre-screen uses the
 * correct 'social_caption' type, and persistence uses content_items.type='caption'.
 * The honest long-term fix (a real 'caption' generation type) is flagged by
 * CAPTION_GENERATION_TYPE_GAP (rows.ts).
 */
export const CAPTION_GENERATION_CONTENT_TYPE = "faq" as const satisfies GeneratableContentType;

/* ------------------------------------------------------------------ */
/* Contracts                                                           */
/* ------------------------------------------------------------------ */

export interface CaptionRequest {
  /** The topic / angle the caption covers (e.g. "new listing in the marina"). */
  topic: string;
  /** The facts the caption MAY assert (anti-fabrication grounding set). */
  groundingFacts: string[];
  /** Optional target platform (e.g. "instagram", "linkedin") — drives the compliance platform signal. */
  platform?: string;
}

export interface GenerateCaptionInput {
  request: CaptionRequest;
  /** The LOCKED brand voice (the action refuses to reach here without a kit). */
  voice: VoiceProfile;
  /** The client's vertical — drives the compliance pre-screen + generation guardrails. */
  vertical: Vertical;
}

export type GenerateCaptionOutcome =
  | { ok: true; body: string; report: CaptionReport }
  | { ok: false; reason: "generation_unavailable" | "empty_generation"; cause?: unknown };

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

/**
 * Build the generation spec for a caption. Voice + compliance guardrails + grounding
 * are constraints AT GENERATION (generic/off-brand/non-compliant/fabricated captions
 * steered away up front, not patched after). The `playbook` mapping is minimal +
 * honest — a caption is a short social message, NOT AEO-page content (no target
 * prompt, no templates/schema profile).
 */
export function buildCaptionSpec(input: GenerateCaptionInput): ContentGenerationSpec {
  const { request, voice, vertical } = input;
  const platformClause = request.platform ? ` for ${request.platform}` : "";
  return {
    contentType: CAPTION_GENERATION_CONTENT_TYPE,
    topic:
      `Write a short, on-brand social caption${platformClause} about ${request.topic}. ` +
      `Lead with the hook; assert no fact not present in the provided grounding facts.`,
    groundingFacts: [...request.groundingFacts],
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
/* generateCaption                                                     */
/* ------------------------------------------------------------------ */

/**
 * Draft one caption. The provider is injected; a thrown/rejected provider (the
 * deferred adapter, a timeout, a vendor error) maps to `generation_unavailable`
 * WITHOUT surfacing the raw cause as content. An empty body is `empty_generation`.
 * On success the caption passes the grounding + voice + 'social_caption'
 * compliance-pre-screen guardrails and returns the body + report — flagged, never
 * cleared, never approved by M11.
 */
export async function generateCaption(
  provider: ContentGenerationProvider,
  input: GenerateCaptionInput,
): Promise<GenerateCaptionOutcome> {
  const spec = buildCaptionSpec(input);

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
    contentType: "social_caption",
    content: {
      text: body,
      ...(input.request.platform ? { platform: input.request.platform } : {}),
    },
  });

  return {
    ok: true,
    body,
    report: {
      vendor: provider.vendor,
      contentType: "caption",
      platform: input.request.platform ?? null,
      voiceEnforced: spec.voice.descriptors,
      ungroundedClaims,
      voiceViolations,
      compliancePrescreen: summarizeCompliancePrescreen(prescreen),
    },
  };
}
