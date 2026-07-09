import "server-only";

/**
 * Caption persistence + the social-queue reads (M11; FROZEN schema:
 * supabase/migrations/0005_audits_content_items_site_changes.sql).
 *
 * Deliberately NOT a "use server" module (house rule — same as
 * src/lib/production/content/persist.ts and src/lib/reviews/persist.ts): exporting
 * helpers from an action file would mint each as a browser-invokable RPC endpoint.
 * This stays a plain server-side module only the audited action imports. Every
 * caller passes a claim-scoped Supabase client and a CLAIM-SOURCED tenantId (never
 * anything the browser sent); RLS (`content_items_insert` / `content_items_select`,
 * migration 0005) re-pins tenant scope below us regardless, and the composite FKs
 * (tenant, client) → clients and (tenant, client, brand_kit) → brand_kits make a
 * cross-tenant OR cross-client reference structurally impossible.
 *
 * INSERT-ONLY here. M11 owns only the caption GENERATE step: it creates the row and
 * never updates it — humanization (M9), the review verdicts (the gates), and the
 * status transitions are OTHER owners' writes. A failed insert is a HARD failure.
 *
 * The reads REUSE M8's row shapers (contentDraftSummary/Detail) — a caption is a
 * `content_items` row like any other — and narrow to `type='caption'` so the social
 * queue surfaces captions only (a blog/pillar id read through here yields null).
 */

import type { createClient } from "@/lib/supabase/server";
import {
  contentDraftDetail,
  contentDraftSummary,
  type ContentDraftDetail,
  type ContentDraftSummary,
} from "@/lib/production/content";
import { captionInsertRow, CAPTION_CONTENT_TYPE } from "./rows";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/** The social queue is bounded newest-first (queue + work-log need recency; PostgREST caps rows anyway). */
export const SOCIAL_CAPTIONS_MAX = 100;

/* ------------------------------------------------------------------ */
/* Redacted failure telemetry (house contract — content/persist.ts)    */
/* ------------------------------------------------------------------ */

/**
 * Every social write/read failure emits exactly ONE server-side console.error
 * carrying ONLY: the stable marker, which stage failed, and the Postgres/PostgREST
 * error CODE (shape-checked — never free text). NO caption body, NO prompt, NO
 * brand/voice data, NO media ref, NO tenant/client ids, NO error messages: a
 * PostgREST message/details can quote row data verbatim, and generated content is
 * itself client data — the secrets-in-logs rule is absolute.
 */
export const SOCIAL_FAILURE_MARKER = "[social-write-failure]";

export type SocialFailureStage = "caption_insert" | "generate" | "media" | "thrown";

export function logSocialFailure(stage: SocialFailureStage, cause: unknown): void {
  console.error(`${SOCIAL_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/**
 * Extract a bare SQLSTATE/PostgREST code ("23503", "PGRST301"). Anything that isn't
 * a short alphanumeric token collapses to "unknown", so no data can ride into the
 * log line even through a hostile/misbehaving error object. (Local copy — the
 * content/reviews equivalents are module-private and out of bounds to import.)
 */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)) {
      return code;
    }
  }
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* persistCaption — insert one pre-approval caption row                */
/* ------------------------------------------------------------------ */

/**
 * Insert ONE freshly generated caption at the pinned pre-approval state (status
 * 'draft', automation_level 'ai_draft_human_approve', type 'caption' — see rows.ts).
 * `tenantId` is CLAIM-SOURCED; `clientId`/`brandKitId` are RLS-sourced by the action;
 * RLS + the composite FKs re-pin scope below us. A FK violation surfaces as a write
 * failure — the caption is not saved.
 */
export async function persistCaption(
  supabase: Supabase,
  tenantId: string,
  args: { clientId: string; brandKitId: string; body: string },
): Promise<{ ok: true; contentItemId: string } | { ok: false }> {
  const row = captionInsertRow({
    tenantId,
    clientId: args.clientId,
    brandKitId: args.brandKitId,
    body: args.body,
  });
  const { data, error } = await supabase.from("content_items").insert(row).select("id").single();
  if (error || !data) {
    logSocialFailure("caption_insert", error);
    return { ok: false };
  }
  return { ok: true, contentItemId: data.id as string };
}

/* ------------------------------------------------------------------ */
/* Reads (newest-first; RLS-scoped; type='caption')                    */
/* ------------------------------------------------------------------ */

const SUMMARY_COLUMNS =
  "id, type, status, automation_level, brand_kit_id, body, humanization, quality_review, compliance_review, created_at, updated_at";

/**
 * Newest-first captions for a client — the social queue (Content Quality /
 * Compliance / M9 / dashboard). RLS scopes the read to the caller's tenant AND
 * `app.client_scope`; eq(client_id) + eq(type,'caption') narrow within that.
 */
export async function readCaptionsForClient(
  supabase: Supabase,
  clientId: string,
): Promise<{ ok: true; entries: ContentDraftSummary[] } | { ok: false }> {
  const { data, error } = await supabase
    .from("content_items")
    .select(SUMMARY_COLUMNS)
    .eq("client_id", clientId)
    .eq("type", CAPTION_CONTENT_TYPE)
    .order("created_at", { ascending: false });
  if (error || !data) return { ok: false };
  const rows = data as Array<Parameters<typeof contentDraftSummary>[0]>;
  return { ok: true, entries: rows.slice(0, SOCIAL_CAPTIONS_MAX).map(contentDraftSummary) };
}

/**
 * The full caption for ONE item id — what a reviewer or M9 reads. RLS scopes the
 * read; the eq(type,'caption') keeps this read caption-only (a non-caption id is the
 * SAME empty observation as a nonexistent/other-tenant id) → `detail: null`.
 */
export async function readCaptionById(
  supabase: Supabase,
  contentItemId: string,
): Promise<{ ok: true; detail: ContentDraftDetail | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("content_items")
    .select(SUMMARY_COLUMNS)
    .eq("id", contentItemId)
    .eq("type", CAPTION_CONTENT_TYPE)
    .maybeSingle();
  if (error) return { ok: false };
  if (!data) return { ok: true, detail: null };
  return { ok: true, detail: contentDraftDetail(data as Parameters<typeof contentDraftDetail>[0]) };
}
