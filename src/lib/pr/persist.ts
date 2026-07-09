import "server-only";

/**
 * M12 PR entity-leverage — persistence + history reads (frozen schema:
 * supabase/migrations/0005_audits_content_items_site_changes.sql).
 *
 * Same posture as src/lib/local/persist.ts (M14) and src/lib/intelligence/audit/
 * persist.ts (M2):
 *  - NOT a "use server" module — exporting helpers from an action file would mint
 *    each as a browser-invokable RPC. A plain server-side module the M12 action
 *    (deferred, wired at 1.7) imports.
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER REPORT-SUPPLIED. The caller passes a
 *    tenantId taken from the VERIFIED JWT claim; RLS (`audits_insert` /
 *    `audits_select`, migration 0005) re-pins every row below us; the composite
 *    FK (tenant, client, property) → properties makes a cross-client or
 *    cross-tenant reference structurally impossible.
 *  - The stored capture carries `kind: "entity_authority"` and reads filter on it
 *    (rows.ts) — see the SHARED-TABLE precondition note there.
 *
 * Redacted telemetry (house contract): every failure path emits exactly ONE
 * server-side console.error carrying ONLY a stable marker, the stage, and the
 * bare Postgres/PostgREST CODE — never payloads, crawled content, report data,
 * entity names, press URLs, or tenant/client ids (a PostgREST message/details can
 * quote row data verbatim; the secrets-in-logs rule is absolute).
 */

import type { createClient } from "@/lib/supabase/server";
import {
  entityAuthorityInsertRow,
  entityAuthorityHistoryEntry,
  isEntityAuthorityScore,
  type EntityAuthorityHistoryEntry,
} from "./rows";
import type { EntityAuthorityReport } from "./types";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Interface-voice partial-failure notice (doc 06 §6): the assessment RAN — only
 *  the history row failed; the results are real and re-running retries the save. */
export const ENTITY_SAVE_WARNING =
  "Your entity-authority assessment ran, but we couldn’t save it to history — the results shown are live. Run it again to retry saving.";

/** History reads are bounded: newest N entity rows per client (trend needs recency). */
export const ENTITY_HISTORY_MAX = 100;

export const ENTITY_FAILURE_MARKER = "[entity-authority-failure]";

export type EntityFailureStage = "entity_insert" | "thrown";

/**
 * Bare SQLSTATE/PostgREST code ("23505", "PGRST301") — anything that isn't a
 * short alphanumeric token collapses to "unknown", so no data can ride into the
 * log line even through a hostile/misbehaving error object. (Local copy — the M2
 * equivalent is module-private and audit/** is out of bounds to modify; same
 * decision M14 made.)
 */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)) return code;
  }
  return "unknown";
}

export function logEntityFailure(stage: EntityFailureStage, cause: unknown): void {
  console.error(`${ENTITY_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/**
 * Persist one entity-authority assessment into the frozen `audits` table (with
 * the entity-authority discriminator). Returns the new row id, or `entityId:
 * null` + `saveWarning` when the write failed.
 *
 * PARTIAL-FAILURE DECISION: a failed insert does NOT fail the assessment — the
 * report is computed, real, and shown; only the HISTORY row is missing. Fail soft
 * in interface voice; a re-run writes a fresh row (captures are immutable — no
 * reconciliation).
 */
export async function persistEntityAuthority(
  supabase: Supabase,
  tenantId: string,
  target: { clientId: string; propertyId: string },
  report: EntityAuthorityReport,
): Promise<{ entityId: string | null; saveWarning?: string }> {
  const row = entityAuthorityInsertRow({
    tenantId,
    clientId: target.clientId,
    propertyId: target.propertyId,
    report,
  });
  try {
    const { data, error } = await supabase.from("audits").insert(row).select("id").single();
    if (error || !data) {
      logEntityFailure("entity_insert", error);
      return { entityId: null, saveWarning: ENTITY_SAVE_WARNING };
    }
    return { entityId: data.id as string };
  } catch (err) {
    logEntityFailure("thrown", err);
    return { entityId: null, saveWarning: ENTITY_SAVE_WARNING };
  }
}

/**
 * Newest-first ENTITY-AUTHORITY history for a client. RLS scopes the read to the
 * caller's tenant AND applies `app.client_scope`; eq(client_id) narrows within
 * that. The `kind` filter is applied in-process (the discriminator is nested
 * jsonb) so ONLY entity-authority captures are returned — M2 audit + M14 local
 * rows never leak into the entity trend line.
 */
export async function readEntityAuthorityHistory(
  supabase: Supabase,
  clientId: string,
): Promise<{ ok: true; entries: EntityAuthorityHistoryEntry[] } | { ok: false }> {
  const { data, error } = await supabase
    .from("audits")
    .select("id, property_id, score, created_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error || !data) return { ok: false };
  const rows = data as Array<{ id: string; property_id: string; score: unknown; created_at: string }>;
  const entries = rows
    .filter((r) => isEntityAuthorityScore(r.score))
    .slice(0, ENTITY_HISTORY_MAX)
    .map(entityAuthorityHistoryEntry);
  return { ok: true, entries };
}
