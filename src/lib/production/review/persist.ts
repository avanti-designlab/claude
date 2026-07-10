import "server-only";

/**
 * R3 review-lifecycle persistence (frozen + 0009 schema: content_items). Plain
 * server-side module (NOT "use server") the review actions import — exporting
 * these from an action file would mint each as a browser RPC. Every caller
 * passes a claim-scoped Supabase client + a CLAIM-SOURCED tenantId; RLS
 * (`content_items_update`, migration 0005 — the is_writer floor) re-pins scope
 * below us, and the strengthened DB CHECKs (0009) are the real approval gate.
 */

import type { createClient } from "@/lib/supabase/server";
import type {
  AutomationLevel,
  ContentItemStatus,
  ContentItemType,
  ContentReviewVerdict,
  HumanizationResult,
  Json,
} from "@/lib/types/db";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/* ------------------------------------------------------------------ */
/* Redacted failure telemetry (house contract — content/persist.ts)    */
/* ------------------------------------------------------------------ */

export const REVIEW_FAILURE_MARKER = "[review-write-failure]";

export type ReviewFailureStage =
  | "review_read"
  | "member_resolve"
  | "verdict_write"
  | "approve_write"
  | "send_back_write"
  | "resubmit_write"
  | "revise_write";

export function logReviewFailure(stage: ReviewFailureStage, cause: unknown): void {
  console.error(`${REVIEW_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/** Bare SQLSTATE/PostgREST code, or "unknown" — no data can ride the log line. */
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
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** The content_items columns the review lifecycle reads (RLS-scoped). */
export interface ReviewRow {
  id: string;
  status: ContentItemStatus;
  type: ContentItemType;
  automation_level: AutomationLevel;
  body_hash: string;
  humanization: HumanizationResult | null;
  quality_review: ContentReviewVerdict | null;
  compliance_review: ContentReviewVerdict | null;
}

const REVIEW_COLUMNS =
  "id, status, type, automation_level, body_hash, humanization, quality_review, compliance_review";

/**
 * Read the review-relevant fields of ONE item. RLS scopes it; a nonexistent OR
 * another-tenant id is the SAME empty observation (doc 03 §4) → row: null.
 */
export async function readReviewRow(
  supabase: Supabase,
  contentItemId: string
): Promise<{ ok: true; row: ReviewRow | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("content_items")
    .select(REVIEW_COLUMNS)
    .eq("id", contentItemId)
    .maybeSingle();
  if (error) {
    logReviewFailure("review_read", error);
    return { ok: false };
  }
  if (!data) return { ok: true, row: null };
  return { ok: true, row: data as unknown as ReviewRow };
}

/**
 * Resolve the CALLER's tenant_users.id from their verified auth `sub`. Used to
 * stamp reviewed_by / approved_by from VERIFIED CLAIMS — never caller-supplied.
 * RLS (`tenant_users_select`) lets a writer read the tenant's memberships; the
 * eq(auth_user_id) narrows to the caller's own row (unique per tenant). null =
 * no membership (fail closed — the approve/verdict write then refuses).
 */
export async function resolveMemberId(
  supabase: Supabase,
  authUserId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("tenant_users")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (error || !data) {
    if (error) logReviewFailure("member_resolve", error);
    return null;
  }
  return data.id as string;
}

/* ------------------------------------------------------------------ */
/* Writes (RLS-scoped patch)                                           */
/* ------------------------------------------------------------------ */

/** One RLS-scoped patch to a content_items row. Any patch key is a real column. */
export type ContentPatch = Record<string, Json | null>;

/**
 * Apply a patch to ONE content_items row, tenant- and id-scoped. RLS re-pins the
 * tenant; select().single() turns a vanished/foreign row into an error (never a
 * silent no-op) and surfaces a DB CHECK rejection (e.g. a lost approval race) as
 * an error. Returns the new status on success.
 */
export async function applyContentPatch(
  supabase: Supabase,
  tenantId: string,
  contentItemId: string,
  patch: ContentPatch,
  stage: ReviewFailureStage
): Promise<{ ok: true; status: ContentItemStatus } | { ok: false }> {
  const { data, error } = await supabase
    .from("content_items")
    .update(patch)
    .eq("tenant_id", tenantId)
    .eq("id", contentItemId)
    .select("id, status")
    .single();
  if (error || !data) {
    logReviewFailure(stage, error);
    return { ok: false };
  }
  return { ok: true, status: data.status as ContentItemStatus };
}
