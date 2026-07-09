import "server-only";

/**
 * M5 alert persistence into the frozen `alerts` table (supabase/migrations/0006).
 *
 * Deliberately NOT a "use server" module (house rule, src/lib/plans/persist.ts):
 * exporting helpers from an action file would mint browser-invokable RPC
 * endpoints. Only the audited action imports this. Every caller passes a
 * claim-scoped Supabase client and a CLAIM-SOURCED tenantId (never anything the
 * browser sent); RLS (`alerts_insert`, migration 0006:
 * `tenant_id = app.tenant_id() and app.is_writer()`) re-pins tenant_id below us
 * regardless, and the composite FK (tenant, client) → clients makes a
 * cross-client or cross-tenant alert structurally impossible.
 *
 * ── DEDUP ───────────────────────────────────────────────────────────────────
 * The frozen `alerts` schema has no dedup constraint, so a standing block would
 * spam a new alert every monitoring run. M5 dedups in application code: before
 * inserting, it scans the client's OPEN (unacknowledged) `crawler_blocked`
 * alerts and drops any candidate whose `payload.fingerprint` already has an open
 * alert. Semantics: WHILE an alert for the exact condition is open, no
 * duplicate is created; the re-alert cadence AFTER an operator acknowledges is
 * an M17 policy question, not M5's. If the dedup read FAILS we FAIL CLOSED (no
 * insert) rather than risk duplicate spam on a degraded read. ⚑ A partial
 * unique index (rows.ts) would make this atomic — flagged for the Orchestrator.
 */

import type { createClient } from "@/lib/supabase/server";
import { monitorAlertRows, type AlertInsertRow } from "./rows";
import type { PropertyMonitorReport } from "./types";
import { logMonitorWriteFailure } from "./telemetry";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Bounded dedup scan — newest N open crawler_blocked alerts per client. */
export const MONITOR_DEDUP_SCAN_MAX = 200;

export type PersistMonitorOutcome =
  /** New alert rows were written (dedup may have dropped some). */
  | { kind: "inserted"; inserted: number; deduped: number }
  /** Every candidate matched an already-open alert — nothing new to write. */
  | { kind: "deduped"; deduped: number }
  /** The report warrants no alert (no block, no render risk). */
  | { kind: "no_alerts" }
  /** A read or write failed — retryable; nothing partial was written. */
  | { kind: "failed" };

/** Fingerprints of the client's currently-open crawler_blocked alerts. */
function openFingerprints(rows: unknown): Set<string> {
  const fingerprints = new Set<string>();
  if (!Array.isArray(rows)) return fingerprints;
  for (const row of rows.slice(0, MONITOR_DEDUP_SCAN_MAX)) {
    if (typeof row !== "object" || row === null) continue;
    const payload = (row as { payload?: unknown }).payload;
    if (typeof payload === "object" && payload !== null) {
      const fp = (payload as { fingerprint?: unknown }).fingerprint;
      if (typeof fp === "string" && fp !== "") fingerprints.add(fp);
    }
  }
  return fingerprints;
}

export async function persistMonitorAlerts(
  supabase: Supabase,
  tenantId: string,
  target: { clientId: string; propertyId: string },
  report: PropertyMonitorReport
): Promise<PersistMonitorOutcome> {
  const candidates = monitorAlertRows({
    tenantId,
    clientId: target.clientId,
    propertyId: target.propertyId,
    report,
  });
  if (candidates.length === 0) return { kind: "no_alerts" };

  // Dedup scan — the client's OPEN crawler_blocked alerts (fingerprints only).
  let open: Set<string>;
  try {
    const { data, error } = await supabase
      .from("alerts")
      .select("id, payload, acknowledged, created_at")
      .eq("client_id", target.clientId)
      .eq("type", "crawler_blocked")
      .eq("acknowledged", false)
      .order("created_at", { ascending: false });
    if (error || !data) {
      // Fail closed: without the open set we cannot dedup, and inserting could
      // spam duplicates. Retryable, never partial.
      logMonitorWriteFailure("dedup_read", error);
      return { kind: "failed" };
    }
    open = openFingerprints(data);
  } catch (cause) {
    logMonitorWriteFailure("thrown", cause);
    return { kind: "failed" };
  }

  const fresh: AlertInsertRow[] = candidates.filter((row) => !open.has(row.payload.fingerprint));
  const deduped = candidates.length - fresh.length;
  if (fresh.length === 0) return { kind: "deduped", deduped };

  try {
    const { error } = await supabase.from("alerts").insert(fresh);
    if (error) {
      logMonitorWriteFailure("alerts_insert", error);
      return { kind: "failed" };
    }
  } catch (cause) {
    logMonitorWriteFailure("thrown", cause);
    return { kind: "failed" };
  }

  return { kind: "inserted", inserted: fresh.length, deduped };
}
