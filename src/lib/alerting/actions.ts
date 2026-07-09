"use server";

import { AuthorizationError, requireAuth, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { getVisibilityScoreSeries } from "@/lib/intelligence/visibility/reads";
import { createClient } from "@/lib/supabase/server";
import { visibilityDropRule, visibilityDropSignalFromSeries } from "./rules";
import { persistWriterAlerts, type PersistAlertsOutcome } from "./persist";
import { readActiveAlerts } from "./reads";
import type { ActiveAlertEntry } from "./rows";
import { logAlertingRunFailure } from "./telemetry";
import type { AlertType } from "./types";

/**
 * M17 Alerting engine server actions (doc 05 §M17; doc 07 §1.8). Same security
 * posture as the M5 monitoring / M3 visibility actions:
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends
 *    only a clientId; the tenant comes from the caller's VERIFIED JWT claim, and
 *    RLS (`alerts_*`, migration 0006) re-pins every row below us. The composite
 *    FK (tenant, client) → clients makes a cross-tenant alert impossible.
 *  - WRITE RIGHTS MIRROR THE RLS POLICY: `alerts_insert` admits any writer
 *    (`app.is_writer()` = agency_admin | operator), so the run guard is
 *    `requireOperator()`. The feed read mirrors `alerts_select` (any tenant
 *    member, `app.client_scope` narrows a client_viewer), so it is `requireAuth()`.
 *
 * ── WHAT IS WIRED (honest scope) ─────────────────────────────────────────────
 * The ONLY writer class with a BUILT signal source today is `visibility_drop`
 * (M3's stored `visibility_results` history). `runVisibilityAlertCheck` reads
 * that real history and fires ONLY on a real measured run-over-run drop. The
 * other writer rules (competitor_overtook, schema_broke, negative_review_spike,
 * site_down) are pure + tested but their signal SOURCES are not built yet (M3
 * two-run share-of-voice config; M10/M14 schema verification; M15 review feeds;
 * an uptime probe) — so NO action fabricates them. `crawler_blocked` (M5) and
 * `auto_rollback_fired` (change-management via ./sink) are written by their
 * owners; this module only READS them, through the unified feed.
 */

const FORBIDDEN_ERROR =
  "You do not have permission to run alert checks, which is an agency staff action. Ask your admin to run it, or to change your role.";
const NOT_FOUND_ERROR =
  "We could not find that client. It may have been removed. Refresh your client list and try again.";
const CHECK_FAILED_ERROR = "We could not finish this alert check. Check your connection and try again.";
const FEED_READ_FAILED_ERROR = "We could not load alerts. Check your connection and try again.";

export type RunVisibilityAlertCheckResult =
  | {
      ok: true;
      /** What persistence did (inserted / deduped / no_alerts / failed). */
      alerts: PersistAlertsOutcome;
      /** Runs available to compare (0 or 1 ⇒ no baseline ⇒ never an alert — honest). */
      runsAvailable: number;
    }
  | { ok: false; reason: "forbidden" | "not_found" | "check_failed"; error: string };

/**
 * Run the visibility-drop alert check for one client: read the stored score
 * series (M3), compare the two most recent runs, and — ONLY on a real measured
 * drop past threshold — persist a `visibility_drop` alert (deduped against any
 * open one). Fewer than two runs, or no drop, yields no alert (never fabricated).
 */
export async function runVisibilityAlertCheck(input: {
  clientId: string;
}): Promise<RunVisibilityAlertCheckResult> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }

  const supabase = await createClient();

  // Confirm the client is in the caller's tenant (RLS-scoped). A nonexistent id
  // and another tenant's id are the SAME empty observation — correct (doc 03 §4).
  const clientRes = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (clientRes.error) {
    return { ok: false, reason: "check_failed", error: CHECK_FAILED_ERROR };
  }
  if (!clientRes.data) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }

  try {
    // Two most recent runs are enough for a run-over-run drop.
    const series = await getVisibilityScoreSeries(supabase, clientId, { maxRuns: 2 });
    if (series.kind === "failed") {
      // A failed read is NOT "no drop" — fail closed, retryable.
      return { ok: false, reason: "check_failed", error: CHECK_FAILED_ERROR };
    }

    const points = series.series.map((run) => ({ runAt: run.runAt, score: run.score }));
    const signal = visibilityDropSignalFromSeries(points);
    if (signal === null) {
      // <2 runs ⇒ no baseline ⇒ nothing to alert on (honest, not an error).
      return { ok: true, alerts: { kind: "no_alerts" }, runsAvailable: points.length };
    }

    const scope = { tenantId: claims.tenantId, clientId };
    const row = visibilityDropRule(scope, signal);
    const candidates = row ? [row] : [];
    const alerts = await persistWriterAlerts(supabase, scope, candidates);
    return { ok: true, alerts, runsAvailable: points.length };
  } catch (err) {
    logAlertingRunFailure(err);
    return { ok: false, reason: "check_failed", error: CHECK_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* Unified active-alerts feed (dashboard + operator console)           */
/* ------------------------------------------------------------------ */

export type GetActiveAlertsResult =
  | { ok: true; entries: ActiveAlertEntry[] }
  | { ok: false; reason: "not_found" | "read_failed"; error: string };

/**
 * The unified active-alerts feed for a client (every class). Guarded by
 * `requireAuth` ONLY — mirroring `alerts_select` honestly: reads are open to any
 * tenant member and `app.client_scope` already narrows a client_viewer to its
 * own client's alerts. RLS is the enforcement boundary; this adds nothing it
 * would have to fake.
 */
export async function getActiveAlerts(input: {
  clientId: string;
  types?: AlertType[];
  includeAcknowledged?: boolean;
}): Promise<GetActiveAlertsResult> {
  await requireAuth();

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }

  const supabase = await createClient();
  const feed = await readActiveAlerts(supabase, clientId, {
    types: Array.isArray(input?.types) ? input.types : undefined,
    includeAcknowledged: input?.includeAcknowledged === true,
  });
  if (!feed.ok) {
    return { ok: false, reason: "read_failed", error: FEED_READ_FAILED_ERROR };
  }
  return { ok: true, entries: feed.entries };
}
