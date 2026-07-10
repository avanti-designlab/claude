"use server";

/**
 * Acknowledge an alert — the ONE sanctioned thin write on the frozen `alerts`
 * table (migration 0006) that the UX audit's "close the loop" finding
 * authorized. It is the acknowledge counterpart the M17 engine never had: the
 * feed only ever grew, and M5's dedup design explicitly "self-heals on
 * acknowledge" (persist.ts readOpenFingerprints filters `acknowledged=false`),
 * so WITHOUT an acknowledge write a standing condition can never re-alert and an
 * open feed can never shrink. This action supplies exactly that flip and NOTHING
 * more — the M17 engine files (rules/persist/sink/reads/rows/evaluate) are frozen
 * and untouched.
 *
 * SECURITY posture mirrors cancelRun / the M17 run action exactly:
 *  - TENANT IS CLAIM-SOURCED: the browser sends only alert id(s); the tenant
 *    comes from the caller's VERIFIED JWT claim, and RLS (`alerts_update`,
 *    migration 0006: `tenant_id = app.tenant_id() AND app.is_writer()`) re-pins
 *    it below us regardless. The composite FK (tenant, client) → clients makes a
 *    cross-tenant row structurally unreachable.
 *  - WRITER FLOOR: requireOperator() mirrors `alerts_update`'s is_writer()
 *    (agency_admin | operator) honestly — a client_viewer is refused above the DB.
 *  - CAS ON acknowledged=false: the UPDATE only matches a still-UNACKNOWLEDGED
 *    row, so an already-acknowledged row (or another tenant's, or a nonexistent
 *    id) matches ZERO rows → an honest "already acknowledged" outcome, never a
 *    fake success. select('id') turns the 0-row match into that honest signal.
 *  - ONLY `acknowledged` is written. `updated_at` is bumped by the table's
 *    set_updated_at trigger (migration 0006), not by us.
 *
 * NO existence oracle: a nonexistent id, another tenant's id, and an
 * already-acknowledged id are ALL the same 0-row observation — correct and
 * intended (doc 03 §4). The id is UUID-validated first only to reject obvious
 * garbage before a round-trip, never to reveal what exists.
 *
 * ⚑ SCHEMA GAP (flagged for the Orchestrator — governed post-freeze addition):
 * `alerts` has NO `acknowledged_by` / `acknowledged_at` column, so this action
 * records WHO acknowledged and WHEN only implicitly (the trigger's `updated_at`,
 * which any future UPDATE would also touch — not a true audit field). Attribution
 * would need a schema migration; until then we write only what the table can back.
 *
 * ⚑ NO UN-ACKNOWLEDGE by design: re-opening an acknowledged alert would resurrect
 * its `payload.fingerprint` into persist.ts's open-dedup set and could suppress a
 * genuinely re-firing alert. So acknowledge is one-way; the acknowledged-history
 * view (alerts page `?view=acknowledged`) IS the recovery path — acknowledged
 * alerts stay findable, never irrecoverable.
 */

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { createClient } from "@/lib/supabase/server";
// The bulk-id cap IS the feed's own ceiling (reads.ts): one acknowledge-all call
// may never span more ids than any feed read can hand a caller — bounded, never
// tenant-wide. Imported, not re-declared: imports are unrestricted in a
// "use server" module (only its EXPORTS must be async functions).
import { ACTIVE_ALERTS_MAX } from "./reads";

/** FROZEN CONTRACT — the alerts UI consumes these exact shapes. */
export type AcknowledgeAlertResult =
  | { ok: true }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "already_acknowledged" | "acknowledge_failed";
      error: string;
    };

export type AcknowledgeAlertsResult =
  | { ok: true; acknowledged: number }
  | { ok: false; reason: "forbidden" | "not_found" | "acknowledge_failed"; error: string };

const FORBIDDEN_ERROR =
  "You don’t have permission to acknowledge alerts — that’s an agency staff action. Ask your admin to acknowledge it, or to change your role.";
const NOT_FOUND_ERROR =
  "We couldn’t find that alert. Refresh the list and try again.";
// Caller-neutral: the ACTION refreshes nothing — a UI may append its own refresh
// clause. This string must stay true for any future consumer.
const ALREADY_ACKNOWLEDGED_ERROR =
  "This alert was already acknowledged, so there’s nothing to do.";
const ACKNOWLEDGE_FAILED_ERROR =
  "We couldn’t acknowledge this alert. Check your connection and try again.";

/**
 * Acknowledge a single alert (open → acknowledged). CAS on `acknowledged=false`:
 * a still-open row flips and reports ok; anything else (already acknowledged,
 * foreign, or gone) is one honest 0-row "already acknowledged".
 */
export async function acknowledgeAlert(input: {
  alertId: string;
}): Promise<AcknowledgeAlertResult> {
  // AUTHZ — writer floor. requireOperator authenticates first (its /login
  // redirect must propagate; only the wrong-role case is trapped).
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  const alertId = typeof input?.alertId === "string" ? input.alertId.trim() : "";
  if (!isUuidV4(alertId)) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }

  const supabase = await createClient();
  // CAS: claim-sourced tenant (RLS re-pins it) + still-unacknowledged only.
  // select('id') turns a 0-row match into an honest "already acknowledged",
  // never a silent no-op or a fabricated success.
  const res = await supabase
    .from("alerts")
    .update({ acknowledged: true })
    .eq("tenant_id", claims.tenantId)
    .eq("id", alertId)
    .eq("acknowledged", false)
    .select("id");
  if (res.error) {
    return { ok: false, reason: "acknowledge_failed", error: ACKNOWLEDGE_FAILED_ERROR };
  }
  if (!Array.isArray(res.data) || res.data.length === 0) {
    // No open row matched: already acknowledged, or not visible under RLS.
    // Indistinguishable by design — honest, no existence oracle.
    return { ok: false, reason: "already_acknowledged", error: ALREADY_ACKNOWLEDGED_ERROR };
  }
  return { ok: true };
}

/**
 * Acknowledge a BOUNDED, EXPLICIT set of alert ids in one round-trip — the
 * "acknowledge all shown" affordance. Scoped strictly to the ids the caller
 * passes (the fetched/visible feed), never a blind tenant-wide UPDATE: the
 * `.in('id', ids)` filter is the ceiling, `.eq('acknowledged', false)` keeps it
 * CAS (already-acknowledged ids simply don't match and aren't counted), and the
 * batch is capped at ACTIVE_ALERTS_MAX (the feed's own read ceiling). Returns the
 * number actually flipped — honest when some ids were already acknowledged or out
 * of scope.
 */
export async function acknowledgeAlerts(input: {
  alertIds: string[];
}): Promise<AcknowledgeAlertsResult> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  // De-dupe + clamp: only well-formed uuids, bounded count. An empty/garbage
  // list never reaches Postgres — nothing to acknowledge.
  const ids = Array.isArray(input?.alertIds)
    ? [...new Set(input.alertIds.filter(isUuidV4))].slice(0, ACTIVE_ALERTS_MAX)
    : [];
  if (ids.length === 0) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }

  const supabase = await createClient();
  const res = await supabase
    .from("alerts")
    .update({ acknowledged: true })
    .eq("tenant_id", claims.tenantId)
    .in("id", ids)
    .eq("acknowledged", false)
    .select("id");
  if (res.error) {
    return { ok: false, reason: "acknowledge_failed", error: ACKNOWLEDGE_FAILED_ERROR };
  }
  return { ok: true, acknowledged: Array.isArray(res.data) ? res.data.length : 0 };
}
