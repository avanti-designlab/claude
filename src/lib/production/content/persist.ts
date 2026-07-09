import "server-only";

/**
 * Content-draft persistence + reads (M8; FROZEN schema:
 * supabase/migrations/0005_audits_content_items_site_changes.sql).
 *
 * Deliberately NOT a "use server" module (house rule — same as
 * src/lib/intelligence/audit/persist.ts and src/lib/production/brand-kit/
 * persist.ts): exporting helpers from an action file would mint each one as a
 * browser-invokable RPC endpoint. This stays a plain server-side module only the
 * audited action imports. Every caller passes a claim-scoped Supabase client and
 * a CLAIM-SOURCED tenantId (never anything the browser sent); RLS
 * (`content_items_insert` / `content_items_select`, migration 0005) re-pins
 * tenant scope below us regardless, and the composite FKs (tenant, client) →
 * clients and (tenant, client, brand_kit) → brand_kits make a cross-tenant OR
 * cross-client reference structurally impossible.
 *
 * INSERT-ONLY here. M8 owns only the GENERATE step: it creates the draft row and
 * never updates it — humanization (M9), the review verdicts (the gates), and the
 * status transitions are OTHER owners' writes. So a failed insert is a HARD
 * failure (the draft was not saved); the caller returns an honest retryable
 * error.
 */

import type { createClient } from "@/lib/supabase/server";
import {
  contentDraftDetail,
  contentDraftInsertRow,
  contentDraftSummary,
  type ContentDraftDetail,
  type ContentDraftSummary,
} from "./rows";
import type { GeneratableContentType } from "./types";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Drafts list is bounded newest-first (review queue + work-log need recency; PostgREST caps rows server-side anyway). */
export const CONTENT_DRAFTS_MAX = 100;

/* ------------------------------------------------------------------ */
/* Redacted failure telemetry (house contract — audit/persist.ts)      */
/* ------------------------------------------------------------------ */

/**
 * Every content write/read failure emits exactly ONE server-side console.error
 * carrying ONLY: the stable marker, which stage failed, and the
 * Postgres/PostgREST error CODE (shape-checked — never free text). NO body, NO
 * prompt, NO brand/voice data, NO tenant/client ids, NO error messages: a
 * PostgREST `message`/`details` can quote row data verbatim, and generated
 * content itself is client data — the secrets-in-logs rule
 * (docs/ops/environments.md §Secrets rules) is absolute.
 */
export const CONTENT_FAILURE_MARKER = "[content-write-failure]";

export type ContentFailureStage = "content_insert" | "generate" | "thrown";

export function logContentFailure(stage: ContentFailureStage, cause: unknown): void {
  console.error(`${CONTENT_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/**
 * Extract a bare SQLSTATE/PostgREST code ("23503", "PGRST301"). Anything that
 * isn't a short alphanumeric token collapses to "unknown", so no data can ride
 * into the log line even through a hostile/misbehaving error object. (Local copy
 * — the audit/brand-kit equivalents are module-private and out of bounds to import.)
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
/* persistContentDraft — insert one pre-approval draft row             */
/* ------------------------------------------------------------------ */

/**
 * Insert ONE freshly generated draft at the pinned pre-approval state (status
 * 'draft', automation_level 'ai_draft_human_approve' — see rows.ts). `tenantId`
 * is CLAIM-SOURCED; `clientId`/`brandKitId` are RLS-sourced by the action; RLS +
 * the composite FKs re-pin scope below us. A FK violation (e.g. the brand kit
 * doesn't belong to this tenant+client) surfaces as a write failure — the draft
 * is not saved.
 */
export async function persistContentDraft(
  supabase: Supabase,
  tenantId: string,
  args: { clientId: string; brandKitId: string; type: GeneratableContentType; body: string },
): Promise<{ ok: true; contentItemId: string } | { ok: false }> {
  const row = contentDraftInsertRow({
    tenantId,
    clientId: args.clientId,
    brandKitId: args.brandKitId,
    type: args.type,
    body: args.body,
  });
  const { data, error } = await supabase
    .from("content_items")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    logContentFailure("content_insert", error);
    return { ok: false };
  }
  return { ok: true, contentItemId: data.id as string };
}

/* ------------------------------------------------------------------ */
/* Reads (newest-first; RLS-scoped)                                    */
/* ------------------------------------------------------------------ */

const SUMMARY_COLUMNS =
  "id, type, status, automation_level, brand_kit_id, body, humanization, quality_review, compliance_review, created_at, updated_at";

/**
 * Newest-first drafts for a client — the review queue + the dashboard work-log.
 * RLS scopes the read to the caller's tenant AND `app.client_scope` (a
 * client_viewer sees only its own client's items); eq(client_id) narrows within
 * that. Bounded to the most recent N.
 */
export async function readContentDraftsForClient(
  supabase: Supabase,
  clientId: string,
): Promise<{ ok: true; entries: ContentDraftSummary[] } | { ok: false }> {
  const { data, error } = await supabase
    .from("content_items")
    .select(SUMMARY_COLUMNS)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error || !data) return { ok: false };
  const rows = data as Array<Parameters<typeof contentDraftSummary>[0]>;
  return { ok: true, entries: rows.slice(0, CONTENT_DRAFTS_MAX).map(contentDraftSummary) };
}

/**
 * The full draft for ONE item id — what a reviewer (Content Quality / Compliance)
 * or M9 reads. RLS scopes the read; a nonexistent OR another-tenant id is the
 * SAME empty observation (kit-null parity, doc 03 §4) → `detail: null`.
 */
export async function readContentDraftById(
  supabase: Supabase,
  contentItemId: string,
): Promise<{ ok: true; detail: ContentDraftDetail | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("content_items")
    .select(SUMMARY_COLUMNS)
    .eq("id", contentItemId)
    .maybeSingle();
  if (error) return { ok: false };
  if (!data) return { ok: true, detail: null };
  return { ok: true, detail: contentDraftDetail(data as Parameters<typeof contentDraftDetail>[0]) };
}
