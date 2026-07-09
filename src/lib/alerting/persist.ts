import "server-only";

/**
 * M17 alert persistence into the frozen `alerts` table (supabase/migrations/0006).
 *
 * Deliberately NOT a "use server" module (house rule, mirrored from
 * src/lib/intelligence/monitoring/persist.ts): exporting helpers from an action
 * file would mint browser-invokable RPC endpoints. Only audited callers import
 * this. Every caller passes a claim-scoped Supabase client and a CLAIM-SOURCED
 * tenantId (never anything the browser sent); RLS (`alerts_insert`, migration
 * 0006: `tenant_id = app.tenant_id() and app.is_writer()`) re-pins tenant_id
 * below us regardless, and the composite FK (tenant, client) → clients makes a
 * cross-client or cross-tenant alert structurally impossible.
 *
 * ── DEDUP (M5's established pattern, reused) ─────────────────────────────────
 * The frozen `alerts` schema has no dedup constraint, so a STANDING condition
 * would spam a new alert every evaluation run. Like M5, we dedup in application
 * code: before inserting, scan the client's OPEN (unacknowledged) alerts of the
 * SAME type and drop any candidate whose `payload.fingerprint` already has an
 * open alert. Semantics: WHILE an alert for the exact condition is open, no
 * duplicate is created; the re-alert cadence AFTER an operator acknowledges is a
 * later policy question. If a dedup read FAILS we FAIL CLOSED (no insert) rather
 * than risk duplicate spam on a degraded read — M5 precedent. ⚑ A partial unique
 * index (rows.ts) would make this atomic; flagged for the Orchestrator.
 *
 * ── NO DOUBLE-WRITE ─────────────────────────────────────────────────────────
 * `persistWriterAlerts` REFUSES any row whose type is not one of M17's five
 * writer types (rows.ts M17_WRITER_ALERT_TYPES). `crawler_blocked` (M5) can
 * never be written here; `auto_rollback_fired` reaches `alerts` only through
 * ./sink (the single persistence path for the change-management event). Both
 * entrypoints share ONE dedup+insert core (`persistAlertRowsCore`) — internal,
 * never exported — so the contract is unified without a second write path.
 */

import type { createClient } from "@/lib/supabase/server";
import { isWriterAlertType, type AlertInsertRow } from "./rows";
import { logAlertingWriteFailure } from "./telemetry";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Bounded dedup scan — newest N open alerts of a type per client (mirrors M5). */
export const ALERT_DEDUP_SCAN_MAX = 200;

export type PersistAlertsOutcome =
  /** New alert rows were written (dedup may have dropped some). */
  | { kind: "inserted"; inserted: number; deduped: number }
  /** Every candidate matched an already-open alert — nothing new to write. */
  | { kind: "deduped"; deduped: number }
  /** No candidate rows to persist. */
  | { kind: "no_alerts" }
  /** A read or write failed — retryable; nothing partial was written. */
  | { kind: "failed" };

/** Fingerprints of a client's currently-open alerts of one type. */
function openFingerprints(rows: unknown): Set<string> {
  const fingerprints = new Set<string>();
  if (!Array.isArray(rows)) return fingerprints;
  for (const row of rows.slice(0, ALERT_DEDUP_SCAN_MAX)) {
    if (typeof row !== "object" || row === null) continue;
    const payload = (row as { payload?: unknown }).payload;
    if (typeof payload === "object" && payload !== null) {
      const fp = (payload as { fingerprint?: unknown }).fingerprint;
      if (typeof fp === "string" && fp !== "") fingerprints.add(fp);
    }
  }
  return fingerprints;
}

/** Read one type's open fingerprints for a client. null ⇒ read failed (fail closed). */
async function readOpenFingerprints(
  supabase: Supabase,
  clientId: string,
  type: string,
): Promise<Set<string> | null> {
  try {
    const { data, error } = await supabase
      .from("alerts")
      .select("id, payload, acknowledged, created_at")
      .eq("client_id", clientId)
      .eq("type", type)
      .eq("acknowledged", false)
      .order("created_at", { ascending: false });
    if (error || !data) {
      logAlertingWriteFailure("dedup_read", error);
      return null;
    }
    return openFingerprints(data);
  } catch (cause) {
    logAlertingWriteFailure("thrown", cause);
    return null;
  }
}

/**
 * Shared dedup+insert core. INTERNAL (not exported): the only two callers are
 * `persistWriterAlerts` (writer-type-guarded) and ./sink (auto_rollback_fired,
 * the single path for the change-management event). Every candidate is deduped
 * against the client's open alerts of its OWN type; survivors insert in one call.
 * All candidates must share one clientId (the caller's RLS-scoped client).
 */
export async function persistAlertRowsCore(
  supabase: Supabase,
  clientId: string,
  candidates: AlertInsertRow[],
): Promise<PersistAlertsOutcome> {
  if (candidates.length === 0) return { kind: "no_alerts" };

  // Dedup per DISTINCT type (mirrors M5's per-type `.eq("type", …)` — one read
  // each, fail-closed if any read fails). Fingerprints are keyed with the type
  // so cross-type keys can never collide.
  const types = [...new Set(candidates.map((row) => row.type))];
  const open = new Set<string>();
  for (const type of types) {
    const fingerprints = await readOpenFingerprints(supabase, clientId, type);
    if (fingerprints === null) return { kind: "failed" };
    for (const fp of fingerprints) open.add(`${type}::${fp}`);
  }

  const fresh = candidates.filter((row) => !open.has(`${row.type}::${row.payload.fingerprint}`));
  const deduped = candidates.length - fresh.length;
  if (fresh.length === 0) return { kind: "deduped", deduped };

  try {
    const { error } = await supabase.from("alerts").insert(fresh);
    if (error) {
      logAlertingWriteFailure("alerts_insert", error);
      return { kind: "failed" };
    }
  } catch (cause) {
    logAlertingWriteFailure("thrown", cause);
    return { kind: "failed" };
  }

  return { kind: "inserted", inserted: fresh.length, deduped };
}

/**
 * Persist M17 WRITER-rule rows (visibility_drop / competitor_overtook /
 * schema_broke / negative_review_spike / site_down), deduped. Any row whose
 * type is not a writer type is REFUSED (returns `failed` + a redacted line):
 * that is a programming error (M17 must never write M5's or change-mgmt's
 * class), caught before it can double-write. Nothing partial is written on
 * refusal.
 */
export async function persistWriterAlerts(
  supabase: Supabase,
  scope: { tenantId: string; clientId: string },
  candidates: AlertInsertRow[],
): Promise<PersistAlertsOutcome> {
  for (const row of candidates) {
    if (!isWriterAlertType(row.type)) {
      // Do NOT write another owner's class through the writer path. Redacted:
      // the type name is a fixed enum member, never row data.
      logAlertingWriteFailure("alerts_insert", { code: "M17_NONWRITER" });
      return { kind: "failed" };
    }
    // Belt-and-braces: the caller must pin tenant/client from claim/RLS-scoped
    // values. RLS re-pins below us regardless, but a mismatched batch is a bug.
    if (row.tenant_id !== scope.tenantId || row.client_id !== scope.clientId) {
      logAlertingWriteFailure("alerts_insert", { code: "M17_SCOPE" });
      return { kind: "failed" };
    }
  }
  return persistAlertRowsCore(supabase, scope.clientId, candidates);
}
