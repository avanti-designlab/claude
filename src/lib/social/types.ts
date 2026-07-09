/**
 * M11 Social — shared types (doc 05 Part B "Social design"; doc 07 §1.7).
 *
 * M11 is the SOCIAL arm of the brand-consistent production engine. It produces
 * three things, each brand-forced from M7's LOCKED kit from the START (never
 * patched after): the CAPTION (governed like M8 content — brand voice + grounding
 * + compliance pre-screen, gated by content-quality AND compliance-review), the
 * brand-forced MEDIA (Higgsfield/Motion, deferred vendor — the request carries the
 * kit's visual tokens as HARD constraints), and the COMPOSED post (caption + media
 * ref + schedule) which is a PRE-APPROVAL artifact only.
 *
 * NO AUTONOMOUS PUBLISHING (CLAUDE.md rule 5, doc 00 §2). Nothing in this module
 * ever posts: the caption persists at the pinned pre-approval state (status
 * 'draft', automation_level 'ai_draft_human_approve'); the composed post carries a
 * pinned pre-approval status and there is NO call to `SocialPostingProvider.schedule()`
 * anywhere in `src/lib/social/`. Publishing is a separate, human-approved connector
 * write (integrations, 1.7), never fired from here. (Mirror of M15's read-only /
 * pinned-status discipline.)
 */

import type { UngroundedClaim, BannedVoicePhrase, CompliancePrescreen } from "@/lib/production/content";
import type { LikenessRefs } from "@/lib/types/brand";

/* ------------------------------------------------------------------ */
/* Media — the brand-forced creative seam (Higgsfield/Motion, deferred) */
/* ------------------------------------------------------------------ */

/** The media shapes M11 produces — image or video (Reels/Shorts/carousels). */
export const SOCIAL_MEDIA_TYPES = ["image", "video"] as const;
export type SocialMediaType = (typeof SOCIAL_MEDIA_TYPES)[number];

export function isSocialMediaType(value: unknown): value is SocialMediaType {
  return typeof value === "string" && (SOCIAL_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * The HARD brand constraints forced onto EVERY media generation, sourced from
 * M7's locked kit (doc 05: creative is "brand-forced through the client's locked
 * brand kit"). This is the visual analog of M8's voice enforcement — off-brand
 * creative is prevented at generation, not corrected after.
 */
export interface BrandVisualConstraints {
  /** Brand-driven palette hexes the creative MUST use (accent trio from the locked kit's tokens). */
  palette: string[];
  /** The brand logo to lock into the creative; null when the kit carries none. */
  logoUrl: string | null;
  /** Higgsfield/Motion reference-element ids for product/founder likeness (on-likeness creative). */
  likenessRefs: LikenessRefs;
}

/** The creative ask (the caller-supplied part — direction only, never the brand). */
export interface MediaBrief {
  mediaType: SocialMediaType;
  /** The creative prompt/scene direction. */
  prompt: string;
  /** Target aspect ratio, e.g. "9:16" (Reels/Shorts), "1:1" (carousel). Open string. */
  aspectRatio?: string;
}

/**
 * The fully brand-forced request handed to the {@link MediaGenerationProvider}.
 * `brand` is NOT optional and NOT caller-supplied — it is derived server-side from
 * the locked kit (see ./media), so a caller can never request unbranded creative.
 */
export interface MediaGenerationRequest {
  brief: MediaBrief;
  brand: BrandVisualConstraints;
}

/**
 * A produced creative reference. Shape is a superset of the connectors'
 * `SocialAsset` ({url, type}) so it composes straight into a `SocialPostRequest`,
 * plus vendor provenance. Opaque — M11 never interprets the asset bytes.
 */
export interface MediaRef {
  url: string;
  type: SocialMediaType;
  /** Stable vendor id for provenance, e.g. "higgsfield", "motion", "scripted-fake". */
  vendor: string;
}

/* ------------------------------------------------------------------ */
/* Caption — content, governed like M8                                 */
/* ------------------------------------------------------------------ */

/** Evidence the drafted caption carries into the gates (JSON-serializable; no prompt/PII beyond the caption). */
export interface CaptionReport {
  vendor: string;
  /** The authoritative content type (the generation-spec type is the nearest analog — see caption.ts). */
  contentType: "caption";
  /** The target platform the caption was screened for (compliance platform signal); null if none. */
  platform: string | null;
  /** Brand voice descriptors enforced at generation. */
  voiceEnforced: string[];
  /** Facts the caption asserts that the grounding set did not support — flagged, never emitted as fact. */
  ungroundedClaims: UngroundedClaim[];
  /** Banned voice.dont phrases present in the drafted caption — flagged, never gated. */
  voiceViolations: BannedVoicePhrase[];
  /** Compliance guardrail result under 'social_caption' (NOT the compliance-review verdict). */
  compliancePrescreen: CompliancePrescreen;
}
