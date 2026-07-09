import "server-only";

/**
 * M17 — the UNIFIED active-alerts read feed over the frozen `alerts` table
 * (migration 0006). One read surface for the M19 dashboard + the operator
 * console: every alert class in one place — M17's writer alerts, M5's
 * `crawler_blocked`, and change-management's `auto_rollback_fired` — because
 * they all live in the same table. M17 UNIFIES the read even though it writes
 * only its own five classes. This module touches NO UI.
 *
 * TENANT SCOPING: callers pass a claim-scoped Supabase client; RLS
 * (`alerts_select`: `tenant_id = app.tenant_id() and app.client_scope(client_id)`,
 * migration 0006) is the isolation boundary — a cross-tenant clientId yields
 * zero rows, indistinguishable from "no alerts". `client_viewer` reads its own
 * client's alerts through the same policy. The `eq(client_id)` filter narrows
 * within the caller's own scope.
 *
 * The feed reports what IS stored. `alerts` records PROBLEMS, not all-clears, so
 * an empty feed means "no open alerts", NOT "everything was checked and passed"
 * (same honesty caveat M5's status read carries).
 */

import { activeAlertEntry, type ActiveAlertEntry } from "./rows";
import type { AlertType } from "./types";
import type { Supabase } from "./persist";

/** Newest N alerts surfaced per client (bounded feed). */
export const ACTIVE_ALERTS_MAX = 200;

const FEED_COLUMNS = "id, type, severity, payload, acknowledged, created_at";

interface StoredAlertRow {
  id: string;
  type: unknown;
  severity: unknown;
  payload: unknown;
  acknowledged: unknown;
  created_at: string;
}

export type ActiveAlertsRead =
  | { ok: true; entries: ActiveAlertEntry[] }
  | { ok: false };

/**
 * The active-alerts feed for a client, newest-first. Defaults to OPEN
 * (unacknowledged) alerts — the current-issues view a dashboard wants;
 * `includeAcknowledged` widens to history. An optional `types` filter narrows
 * to specific classes (e.g. only `crawler_blocked`), applied in application code
 * so any subset of the frozen types works without a schema change.
 */
export async function readActiveAlerts(
  supabase: Supabase,
  clientId: string,
  options: { types?: readonly AlertType[]; includeAcknowledged?: boolean } = {},
): Promise<ActiveAlertsRead> {
  let query = supabase.from("alerts").select(FEED_COLUMNS).eq("client_id", clientId);
  if (options.includeAcknowledged !== true) query = query.eq("acknowledged", false);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error || !data) return { ok: false };

  const rows = data as unknown as StoredAlertRow[];
  let entries = rows.slice(0, ACTIVE_ALERTS_MAX).map(activeAlertEntry);

  if (options.types && options.types.length > 0) {
    const wanted = new Set<AlertType>(options.types);
    entries = entries.filter((entry) => entry.type !== null && wanted.has(entry.type));
  }
  return { ok: true, entries };
}
