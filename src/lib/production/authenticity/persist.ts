import "server-only";

/**
 * M9 authenticity persistence + reads (FROZEN schema, migration 0005).
 *
 * Deliberately NOT a "use server" module (house rule — same as M8's
 * production/content/persist.ts and the audit/brand-kit persist modules):
 * exporting helpers from an action file would mint each as a browser-invokable
 * RPC. This stays a plain server-side module only the audited action imports.
 * Every caller passes a claim-scoped Supabase client + a CLAIM-SOURCED tenantId
 * (never anything the browser sent); RLS (`content_items_update` /
 * `content_items_select`, migration 0005) re-pins tenant scope + the writer floor
 * (`app.is_writer()`) below us regardless.
 *
 * UPDATE-ONLY here (M8 inserts the row; M9 updates it). M9 writes ONLY the columns
 * it owns — `humanization`, the pinned `status`='in_review', and (conditionally)
 * the humanized `body` — via {@link humanizationUpdatePayload}. It never writes a
 * review verdict and can never set approved/published (rows.ts pin + DB CHECK).
 */

import type { createClient } from "@/lib/supabase/server";
import { authenticityVerdictView, humanizationUpdatePayload, type AuthenticityDraftRow } from "./rows";
import type { AuthenticityVerdictView, HumanizationRecord } from "./types";
import type { ContentItemStatus } from "@/lib/types/db";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/* ------------------------------------------------------------------ */
/* Redacted failure telemetry (house contract — content/persist.ts)    */
/* ------------------------------------------------------------------ */

/**
 * Every M9 write/read failure emits exactly ONE server-side console.error carrying
 * ONLY the stable marker, which stage failed, and the Postgres/PostgREST error
 * CODE (shape-checked — never free text). NO body, NO humanized text, NO detection
 * SCORES, NO tenant/client ids, NO error messages: a PostgREST message can quote
 * row data verbatim, generated content + its authenticity scores are client data,
 * and the secrets-in-logs rule (docs/ops/environments.md §Secrets rules) is
 * absolute. Task point 3: "no content/scores-tied-to-client in logs beyond shape".
 */
export const AUTHENTICITY_FAILURE_MARKER = "[authenticity-write-failure]";

export type AuthenticityFailureStage =
  | "draft_read"
  | "humanize"
  | "humanization_update"
  | "verdict_read"
  | "thrown";

export function logAuthenticityFailure(stage: AuthenticityFailureStage, cause: unknown): void {
  console.error(`${AUTHENTICITY_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/**
 * Extract a bare SQLSTATE/PostgREST code ("23503", "PGRST301"). Anything that
 * isn't a short alphanumeric token collapses to "unknown", so no data can ride the
 * log line even through a hostile/misbehaving error object. (Local copy — the
 * content/audit equivalents are module-private and out of bounds to import.)
 */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)) return code;
  }
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

const DRAFT_COLUMNS = "id, client_id, brand_kit_id, type, automation_level, body, status, humanization";

/**
 * Read the draft M9 needs to run: body (the text to humanize), client_id (to
 * re-read the locked voice), status (the run-eligibility gate), and the current
 * humanization. RLS scopes the read to the caller's tenant + client_scope; a
 * nonexistent OR another-tenant id is the SAME empty observation (doc 03 §4) →
 * `row: null`.
 */
export async function readDraftForAuthenticity(
  supabase: Supabase,
  contentItemId: string,
): Promise<{ ok: true; row: AuthenticityDraftRow | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("content_items")
    .select(DRAFT_COLUMNS)
    .eq("id", contentItemId)
    .maybeSingle();
  if (error) return { ok: false };
  if (!data) return { ok: true, row: null };
  return { ok: true, row: data as AuthenticityDraftRow };
}

/**
 * Read the authenticity verdict for ONE item — what the Quality/Compliance gates +
 * the dashboard work-log consume. Returns the shaped view (or null when M9 has not
 * run) plus the item's status. RLS scopes the read; a nonexistent/other-tenant id
 * is `row: null` → `verdict: null`.
 */
export async function readHumanizationVerdict(
  supabase: Supabase,
  contentItemId: string,
): Promise<
  | { ok: true; status: ContentItemStatus | null; verdict: AuthenticityVerdictView | null }
  | { ok: false }
> {
  const { data, error } = await supabase
    .from("content_items")
    .select("status, humanization")
    .eq("id", contentItemId)
    .maybeSingle();
  if (error) return { ok: false };
  if (!data) return { ok: true, status: null, verdict: null };
  const row = data as { status: ContentItemStatus; humanization: unknown };
  return { ok: true, status: row.status, verdict: authenticityVerdictView(row.humanization) };
}

/* ------------------------------------------------------------------ */
/* persistHumanization — UPDATE humanization + status (+ body)          */
/* ------------------------------------------------------------------ */

/**
 * Record ONE authenticity result. Writes ONLY `humanization` + the pinned
 * `status`='in_review' + (conditionally) the humanized `body`. `tenantId` is
 * CLAIM-SOURCED and mirrored as an explicit filter alongside RLS (belt + braces:
 * RLS already re-pins tenant + is_writer). The row was read in-scope moments
 * earlier, so a failed/empty update is a real write failure (or a TOCTOU delete) →
 * honest `write_failed`; a bad `humanization`/`status` is impossible by
 * construction (the payload is built, never spread from caller input).
 */
export async function persistHumanization(
  supabase: Supabase,
  tenantId: string,
  args: { contentItemId: string; record: HumanizationRecord; bodyToPersist: string | null },
): Promise<{ ok: true } | { ok: false }> {
  const payload = humanizationUpdatePayload(args.record, args.bodyToPersist);
  const { data, error } = await supabase
    .from("content_items")
    .update(payload)
    .eq("id", args.contentItemId)
    .eq("tenant_id", tenantId)
    .select("id")
    .single();
  if (error || !data) {
    logAuthenticityFailure("humanization_update", error);
    return { ok: false };
  }
  return { ok: true };
}
