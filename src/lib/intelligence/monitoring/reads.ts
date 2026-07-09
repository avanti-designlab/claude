import "server-only";

/**
 * M5 — read API over stored `alerts` for the latest crawler/render status per
 * property (frozen schema, migration 0006). Dashboard-bound later (M17/M19);
 * this module touches NO UI.
 *
 * ── WHAT THIS READ CAN AND CANNOT SHOW (honest, flagged) ────────────────────
 * The frozen schema has NO monitoring-run table — only `alerts`, which by
 * design records PROBLEMS (`crawler_blocked`), not the full per-crawler
 * allow/block grid or an all-clear pass. So "latest status" here means "the
 * property's currently-known crawler blocks + render risks" (its open
 * `crawler_blocked` alerts). An absence of alerts is the closest the stored
 * data comes to "all clear" — it is NOT proof a pass ran and everything passed.
 * ⚑ A `monitoring_runs` table (parallel to the flagged `visibility_runs`) would
 * persist the full grid + history for a true status view — flagged for the
 * Orchestrator, post-freeze. For a live full grid now, run `runPropertyMonitor`
 * (it returns the whole `PropertyMonitorReport`).
 *
 * `alerts` is CLIENT-scoped (no property_id column), so property filtering rides
 * on `payload.propertyId` in application code. RLS
 * (`alerts_select`: `tenant_id = app.tenant_id() and app.client_scope(client_id)`)
 * is the isolation boundary — a cross-tenant clientId yields zero rows,
 * indistinguishable from "no alerts". client_viewer reads its own client's
 * alerts through the same policy.
 */

import type { Supabase } from "./persist";
import { crawlerRenderStatusEntry, type CrawlerRenderStatusEntry } from "./rows";

/** Newest N crawler_blocked alerts surfaced per client (bounded status view). */
export const MONITOR_STATUS_MAX = 100;

const STATUS_COLUMNS = "id, severity, payload, acknowledged, created_at";

interface StoredAlertRow {
  id: string;
  severity: string;
  payload: unknown;
  acknowledged: boolean;
  created_at: string;
}

export type CrawlerRenderStatusRead =
  | { ok: true; entries: CrawlerRenderStatusEntry[] }
  | { ok: false };

/**
 * Latest crawler/render status for a client (optionally one property). Returns
 * the newest open `crawler_blocked` alerts, newest-first. `includeAcknowledged`
 * widens the view to acknowledged alerts too (history); default is open-only
 * (the current-issues view a dashboard wants).
 */
export async function readCrawlerRenderStatus(
  supabase: Supabase,
  clientId: string,
  options: { propertyId?: string; includeAcknowledged?: boolean } = {}
): Promise<CrawlerRenderStatusRead> {
  let query = supabase
    .from("alerts")
    .select(STATUS_COLUMNS)
    .eq("client_id", clientId)
    .eq("type", "crawler_blocked");
  if (options.includeAcknowledged !== true) query = query.eq("acknowledged", false);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error || !data) return { ok: false };

  const rows = data as unknown as StoredAlertRow[];
  let entries = rows.slice(0, MONITOR_STATUS_MAX).map(crawlerRenderStatusEntry);
  if (typeof options.propertyId === "string" && options.propertyId !== "") {
    entries = entries.filter((entry) => entry.propertyId === options.propertyId);
  }
  return { ok: true, entries };
}
