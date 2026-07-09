import "server-only";

/**
 * M14 Local SEO — persistence + history reads (frozen schema:
 * supabase/migrations/0005_audits_content_items_site_changes.sql).
 *
 * Same posture as src/lib/intelligence/audit/persist.ts (M2):
 *  - NOT a "use server" module — exporting helpers from an action file would
 *    mint each as a browser-invokable RPC. A plain server-side module the M14
 *    action imports.
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER REPORT-SUPPLIED. The caller passes a
 *    tenantId taken from the VERIFIED JWT claim; RLS (`audits_insert` /
 *    `audits_select`, migration 0005) re-pins every row below us; the composite
 *    FK (tenant, client, property) → properties makes a cross-client or
 *    cross-tenant reference structurally impossible.
 *  - The stored capture carries `kind: "local_assessment"` and reads filter on
 *    it (rows.ts) — see the SHARED-TABLE precondition note there.
 *
 * Redacted telemetry (house contract): every failure path emits exactly ONE
 * server-side console.error carrying ONLY a stable marker, the stage, and the
 * bare Postgres/PostgREST CODE — never payloads, crawled content, report data,
 * or tenant/client ids (a PostgREST message/details can quote row data
 * verbatim; the secrets-in-logs rule is absolute).
 */

import type { createClient } from "@/lib/supabase/server";
import { isLocalScore, localAssessmentInsertRow, localHistoryEntry, type LocalHistoryEntry } from "./rows";
import type { LocalReport } from "./types";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Interface-voice partial-failure notice (doc 06 §6): the assessment RAN — only
 *  the history row failed; the results are real and re-running retries the save. */
export const LOCAL_SAVE_WARNING =
  "Your local assessment ran, but we couldn’t save it to history — the results shown are live. Run it again to retry saving.";

/** History reads are bounded: newest N local rows per client (trend needs recency). */
export const LOCAL_HISTORY_MAX = 100;

export const LOCAL_FAILURE_MARKER = "[local-assessment-failure]";

export type LocalFailureStage = "local_insert" | "thrown";

/**
 * Bare SQLSTATE/PostgREST code ("23505", "PGRST301") — anything that isn't a
 * short alphanumeric token collapses to "unknown", so no data can ride into the
 * log line even through a hostile/misbehaving error object. (Local copy — the
 * M2 equivalent is module-private and audit/** is out of bounds to modify.)
 */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)) return code;
  }
  return "unknown";
}

export function logLocalFailure(stage: LocalFailureStage, cause: unknown): void {
  console.error(`${LOCAL_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/**
 * Persist one local assessment into the frozen `audits` table (with the
 * local-assessment discriminator). Returns the new row id, or `localId: null` +
 * `saveWarning` when the write failed.
 *
 * PARTIAL-FAILURE DECISION: a failed insert does NOT fail the assessment — the
 * report is computed, real, and shown; only the HISTORY row is missing. Fail
 * soft in interface voice; a re-run writes a fresh row (captures are immutable —
 * no reconciliation).
 */
export async function persistLocalAssessment(
  supabase: Supabase,
  tenantId: string,
  target: { clientId: string; propertyId: string },
  report: LocalReport,
): Promise<{ localId: string | null; saveWarning?: string }> {
  const row = localAssessmentInsertRow({
    tenantId,
    clientId: target.clientId,
    propertyId: target.propertyId,
    report,
  });
  try {
    const { data, error } = await supabase.from("audits").insert(row).select("id").single();
    if (error || !data) {
      logLocalFailure("local_insert", error);
      return { localId: null, saveWarning: LOCAL_SAVE_WARNING };
    }
    return { localId: data.id as string };
  } catch (err) {
    logLocalFailure("thrown", err);
    return { localId: null, saveWarning: LOCAL_SAVE_WARNING };
  }
}

/**
 * Newest-first LOCAL assessment history for a client. RLS scopes the read to
 * the caller's tenant AND applies `app.client_scope`; eq(client_id) narrows
 * within that. The `kind` filter is applied in-process (the discriminator is
 * nested jsonb) so ONLY local captures are returned — M2 audit rows never leak
 * into the local trend line.
 */
export async function readLocalHistory(
  supabase: Supabase,
  clientId: string,
): Promise<{ ok: true; entries: LocalHistoryEntry[] } | { ok: false }> {
  const { data, error } = await supabase
    .from("audits")
    .select("id, property_id, score, created_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error || !data) return { ok: false };
  const rows = data as Array<{ id: string; property_id: string; score: unknown; created_at: string }>;
  const entries = rows
    .filter((r) => isLocalScore(r.score))
    .slice(0, LOCAL_HISTORY_MAX)
    .map(localHistoryEntry);
  return { ok: true, entries };
}
