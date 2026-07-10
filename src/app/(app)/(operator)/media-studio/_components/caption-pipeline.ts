/**
 * Image & Media Studio — pure, server-safe presentation constants shared by the
 * page (server) and the caption brief form (client island). NO server-only
 * imports and NO client hooks, so both layers can import it. Only TYPE imports
 * from the data layer (erased at build).
 *
 * Deliberately QUIET (doc 06 §4/§5 — operator module UIs are utilitarian). NO
 * internal module codes ever reach a rendered label (doc 06 §6).
 */

import type { ContentItemStatus } from "@/lib/types/db";

/** This studio's own route, for the "Clear"/self-links on the GET selector. */
export const MEDIA_STUDIO_HREF = "/media-studio";

/** Where every deferred-vendor honest state points (the Connections board). */
export const CONNECTIONS_HREF = "/connections";

/** The one human-decision surface — captions in review link INTO it. */
export const REVIEW_QUEUE_HREF = "/review-queue";

/* ------------------------------------------------------------------ */
/* Caption-brief input clamps                                          */
/* ------------------------------------------------------------------ */

/**
 * Flag (greppable by the Orchestrator/docs agent — M8/M11 precedent): M11's
 * `createSocialCaption` applies its OWN input clamps (src/lib/social/actions.ts:
 * TOPIC_MAX 500, GROUNDING_FACTS_MAX 100, GROUNDING_FACT_MAX 2000, PLATFORM_MAX
 * 100) but — unlike M8's `content/types.ts` — does NOT export them. So the brief
 * form MIRRORS them here with the same names/values, and the counter/blocking
 * copy stays honest against the server. If M11 ever changes those private clamps,
 * these must move in lockstep. The clean fix is a backend export (like M8's), so
 * the form consumes the engine constant directly instead of mirroring it —
 * post-freeze Orchestrator + Code Review path (CLAUDE.md rule 1).
 */
export const SOCIAL_CAPTION_CLAMP_EXPORT_GAP =
  "M11 createSocialCaption's input clamps (topic 500, facts 100 × 2000, platform " +
  "100) are private to src/lib/social/actions.ts and not exported, so the caption " +
  "brief form mirrors them; a backend export would let the form consume them directly.";

export const CAPTION_TOPIC_MAX = 500;
export const CAPTION_GROUNDING_FACTS_MAX = 100;
export const CAPTION_GROUNDING_FACT_MAX = 2000;
export const CAPTION_PLATFORM_MAX = 100;

/* ------------------------------------------------------------------ */
/* Platform options (drive M11's compliance platform signal only)      */
/* ------------------------------------------------------------------ */

/**
 * The optional target platform for a caption. It is NOT a connector — nothing
 * posts (M11 structurally cannot). It only tailors the caption and its
 * compliance pre-screen to where the caption will run (M11 `CaptionRequest.platform`
 * → the 'social_caption' compliance platform signal). The empty value sends no
 * platform (a general caption). Values are lowercase, ≤ CAPTION_PLATFORM_MAX chars.
 */
export const CAPTION_PLATFORM_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "General — no specific platform" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "x", label: "X (Twitter)" },
  { value: "tiktok", label: "TikTok" },
  { value: "youtube", label: "YouTube" },
];

/* ------------------------------------------------------------------ */
/* Caption status vocabulary (mirrors the content pipeline, one enum)  */
/* ------------------------------------------------------------------ */

export type PillTone = "muted" | "accent" | "positive" | "warm" | "negative";

export const CAPTION_STATUS_LABEL: Record<ContentItemStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  needs_revision: "In revision",
  approved: "Approved",
  published: "Published",
};

export const CAPTION_STATUS_TONE: Record<ContentItemStatus, PillTone> = {
  draft: "muted",
  in_review: "accent",
  needs_revision: "warm",
  approved: "positive",
  published: "positive",
};

/** A datetime, or an honest em-dash when the stamp isn't parseable — never faked.
 *  Fixed "en-US" locale so the server-rendered card text is deterministic. */
const DATE_TIME_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
export function medDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_TIME_MED.format(t) : "—";
}
