import "server-only";

/**
 * Audit persistence + history reads (M2; frozen schema:
 * supabase/migrations/0005_audits_content_items_site_changes.sql).
 *
 * Deliberately NOT a "use server" module (same rationale as
 * src/lib/plans/persist.ts): exporting helpers from an action file would mint
 * each one as a browser-invokable RPC endpoint. This stays a plain
 * server-side module that only the audited actions import. Every caller
 * passes a claim-scoped Supabase client and a CLAIM-SOURCED tenantId (never
 * anything the browser sent); RLS (`audits_insert` / `audits_select`,
 * migration 0005) re-pins tenant scope below us regardless, and the
 * composite FK (tenant, client, property) → properties makes a cross-client
 * or cross-tenant property reference structurally impossible.
 */

import type { createClient } from "@/lib/supabase/server";
import type { PropertyAuditResult } from "./engine";
import { auditHistoryEntry, auditInsertRow, type AuditHistoryEntry } from "./rows";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Interface-voice partial-failure notice (doc 06 §6): what happened + what
 * to do. The audit RAN — only the history row failed; the results shown are
 * real and re-running retries the save. */
export const AUDIT_SAVE_WARNING =
  "Your audit ran, but we couldn’t save it to history — the results shown are live. Run the audit again to retry saving.";

/** History reads are bounded: newest N rows per client (the trend line needs
 * recency, not the full archive; PostgREST caps rows server-side anyway —
 * same class as carried ticket (b) on dashboard aggregates). */
export const AUDIT_HISTORY_MAX = 100;

/* ------------------------------------------------------------------ */
/* Redacted failure telemetry (house contract — plans/persist.ts)      */
/* ------------------------------------------------------------------ */

/**
 * Every audit-run failure path emits exactly ONE server-side console.error
 * carrying ONLY:
 *   - the stable marker below (greppable in hosted logs),
 *   - which stage failed,
 *   - the Postgres/PostgREST error CODE, shape-checked — never free text.
 * NO payloads, NO crawled content, NO tenant/client ids, NO error messages:
 * a PostgREST `message`/`details` can quote row data verbatim, and the
 * secrets-in-logs rule (docs/ops/environments.md §Secrets rules) is absolute.
 */
export const AUDIT_FAILURE_MARKER = "[audit-run-failure]";

export type AuditFailureStage = "audit_insert" | "thrown";

export function logAuditFailure(stage: AuditFailureStage, cause: unknown): void {
  console.error(`${AUDIT_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/**
 * Extract a bare SQLSTATE/PostgREST code ("23505", "PGRST301"). Anything that
 * isn't a short alphanumeric token collapses to "unknown", so no data can
 * ride into the log line even through a hostile/misbehaving error object.
 * (Local copy — the plans equivalent is module-private and plans/** is out
 * of bounds to modify.)
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
/* persistAudit — one immutable history row per engine run             */
/* ------------------------------------------------------------------ */

/**
 * Persist one audit run into the frozen `audits` table. Returns the new row
 * id, or `auditId: null` + `saveWarning` when the write failed.
 *
 * PARTIAL-FAILURE DECISION (documented where it happens): a failed insert
 * does NOT fail the audit — the engine result is computed, real, and shown
 * to the caller; only the HISTORY row is missing. We fail soft, say so in
 * interface voice, and let a re-run retry the save (audits are immutable
 * captures, so a retry writes a fresh row — no reconciliation needed).
 */
export async function persistAudit(
  supabase: Supabase,
  tenantId: string,
  target: { clientId: string; propertyId: string },
  playbookVersion: string,
  result: PropertyAuditResult
): Promise<{ auditId: string | null; saveWarning?: string }> {
  const row = auditInsertRow({
    tenantId,
    clientId: target.clientId,
    propertyId: target.propertyId,
    playbookVersion,
    result,
  });
  const { data, error } = await supabase
    .from("audits")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    logAuditFailure("audit_insert", error);
    return { auditId: null, saveWarning: AUDIT_SAVE_WARNING };
  }
  return { auditId: data.id as string };
}

/* ------------------------------------------------------------------ */
/* readAuditHistory — the client's trend line                          */
/* ------------------------------------------------------------------ */

/**
 * Newest-first audit history for a client. RLS scopes the read to the
 * caller's tenant AND applies `app.client_scope` (a client_viewer sees only
 * its own client's audits); eq(client_id) narrows within that. `fixes` is
 * deliberately not selected — summaries come from the denormalized capture.
 */
export async function readAuditHistory(
  supabase: Supabase,
  clientId: string
): Promise<{ ok: true; entries: AuditHistoryEntry[] } | { ok: false }> {
  const { data, error } = await supabase
    .from("audits")
    .select("id, property_id, score, created_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error || !data) return { ok: false };
  const rows = data as Array<{ id: string; property_id: string; score: unknown; created_at: string }>;
  return { ok: true, entries: rows.slice(0, AUDIT_HISTORY_MAX).map(auditHistoryEntry) };
}
