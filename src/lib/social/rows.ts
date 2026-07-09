/**
 * Pure caption ⇄ `content_items` row mapping + the M11 SCHEMA-GAP flags (FROZEN
 * schema: supabase/migrations/0005_audits_content_items_site_changes.sql). No
 * server imports, no Supabase client — unit-tested in the default run; ./persist
 * feeds these rows to PostgREST and shapes reads back through them. Mirrors the
 * M8/M15 rows split.
 *
 * THE STRUCTURAL PRE-APPROVAL GUARANTEE (CLAUDE.md rule 5; doc 05 pipeline).
 * `captionInsertRow` is the ONLY way M11 builds a caption row, and it REUSES M8's
 * pinned pre-approval literals verbatim (single source of truth, anti-drift):
 *   - status            = 'draft'                  (never approved/published)
 *   - automation_level  = 'ai_draft_human_approve' (never 'auto')
 * Neither is a parameter. It also NEVER sets `quality_review` / `compliance_review`
 * (the independent gates' verdicts — writing them would be self-approval) nor
 * `humanization` (M9's). With both review columns NULL, the DB CHECK
 * `content_items_reviewed_before_approval` makes 'approved'/'published' structurally
 * unreachable regardless — code pin + schema pin, belt and braces.
 *
 * ── PERSISTENCE DECISION (against the FROZEN schema; M8/M15 precedent) ──────────
 * A CAPTION HAS an honest home: `content_items.type='caption'` (the type CHECK
 * enumerates 'caption' for exactly this). So the caption persists like an M8 draft.
 * The brand-forced MEDIA ref and the COMPOSED post (account + schedule) do NOT have
 * an honest home — no media-asset column, no `social_posts` table — so they are NOT
 * persisted (M15 precedent: return the artifact, flag the gap). Both gaps below.
 */

import type { ContentItemType } from "@/lib/types/db";
import {
  M8_AUTOMATION_LEVEL,
  M8_INITIAL_STATUS,
  type ContentItemInsertRow,
} from "@/lib/production/content";

/* ------------------------------------------------------------------ */
/* Pinned pre-approval literals (REUSED from M8 — one governance source) */
/* ------------------------------------------------------------------ */

/** Always 'caption' — the authoritative persisted type (the generation spec uses 'faq' as analog). */
export const CAPTION_CONTENT_TYPE = "caption" as const satisfies ContentItemType;
/** The pinned pre-approval status — M8's literal, re-exported so tests assert the constant. */
export const CAPTION_INITIAL_STATUS = M8_INITIAL_STATUS;
/** The pinned automation clamp — M8's literal. Publish-bound content is never 'auto' (doc 03 §6). */
export const CAPTION_AUTOMATION_LEVEL = M8_AUTOMATION_LEVEL;

/* ------------------------------------------------------------------ */
/* Greppable schema-gap flags (Orchestrator/docs agent — M3/M4/M8/M15 precedent) */
/* ------------------------------------------------------------------ */

export const CAPTION_GENERATION_TYPE_GAP =
  "M8's generation taxonomy (GeneratableContentType = blog|faq|pillar) has no 'caption' type, so " +
  "the caption generation spec uses 'faq' as the nearest structural analog (a short direct message). " +
  "The authoritative type rides in the report contentType + the 'social_caption' compliance " +
  "pre-screen + persistence as content_items.type='caption'. Proposed follow-up: a dedicated " +
  "'caption' generation content type, coordinated with the M8 owner.";

export const SOCIAL_MEDIA_REF_SCHEMA_GAP =
  "content_items (migration 0005) has no column for a generated media asset ref (url/vendor/type). " +
  "M11 captions persist as content_items.type='caption', but the brand-forced media a caption pairs " +
  "with has no persistence home, so the MediaRef is returned in the action result (un-persisted; M15 " +
  "precedent) for the gates. Proposed post-freeze: a tenant-scoped `social_assets` table OR a " +
  "content_items.media jsonb — Orchestrator + Code Review path (CLAUDE.md rule 1).";

export const SOCIAL_SCHEDULE_SCHEMA_GAP =
  "The frozen F1 schema (migrations 0001–0006) has NO `social_posts`/scheduling table, so a composed " +
  "post (account + media ref + schedule time) has no persistence home. composeSocialPost returns a " +
  "PRE-APPROVAL artifact (un-persisted, un-posted) for the gates + a later human-approved schedule " +
  "write. Proposed post-freeze: a tenant-scoped, RLS'd `social_posts` table — Orchestrator + Code " +
  "Review path.";

/* ------------------------------------------------------------------ */
/* captionInsertRow — insert one pre-approval caption row              */
/* ------------------------------------------------------------------ */

/**
 * Build the `content_items` row for ONE freshly generated caption. `type` is
 * hard-pinned to 'caption'; `status` and `automation_level` are hard-pinned to the
 * pre-approval state (reused from M8). Nothing the caller passes can change them.
 */
export function captionInsertRow(args: {
  tenantId: string;
  clientId: string;
  brandKitId: string;
  body: string;
}): ContentItemInsertRow {
  return {
    tenant_id: args.tenantId,
    client_id: args.clientId,
    type: CAPTION_CONTENT_TYPE,
    brand_kit_id: args.brandKitId,
    automation_level: CAPTION_AUTOMATION_LEVEL,
    body: args.body,
    status: CAPTION_INITIAL_STATUS,
  };
}
