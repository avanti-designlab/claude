"use server";

/**
 * Cancel a QUEUED scan run — the ONE legal raw tenant edge on the runs queue
 * (queued → canceled; ARCHITECTURE RULING A5). This is the sanctioned thin
 * addition the run-trigger UI block was authorized to add: the enqueue action
 * (enqueue.ts) had no cancel counterpart, and the frozen queue-infra files
 * (live/process-once/execute/sweep/kick/transitions/config) must not be touched.
 *
 * SECURITY posture mirrors enqueueRun / the M2 audit action exactly:
 *  - TENANT IS CLAIM-SOURCED: the browser sends only the run id; the tenant
 *    comes from the caller's VERIFIED JWT claim, and RLS (`runs_update`:
 *    tenant_id = app.tenant_id() AND app.is_writer()) re-pins it below us.
 *  - WRITER FLOOR: requireOperator() mirrors runs_update's is_writer() honestly.
 *  - CAS ON status='queued': the UPDATE only matches a still-queued row, so a
 *    run that already started (queued → running by the processor lease),
 *    finished, or was already canceled matches ZERO rows → honest
 *    "it already started" outcome, NOT a fake success. This is the same
 *    compare-and-set the ruling requires until a real mid-run cancel exists.
 *  - ONLY status is written (no progress/heartbeat/result_ref/error_code): the
 *    0012 runs_transition_guard's "cancel may only set status" clause re-enforces
 *    this at the database, and refuses any source status other than 'queued'.
 *
 * NO existence oracle: a nonexistent id, another tenant's id, and a run that is
 * simply no longer queued are ALL the same 0-row observation here — correct and
 * intended (doc 03 §4). The id is UUID-validated first only to reject obvious
 * garbage before a round-trip, never to reveal what exists.
 */

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { createClient } from "@/lib/supabase/server";

/** FROZEN CONTRACT — the run-trigger UI consumes this exact shape. */
export type CancelRunResult =
  | { ok: true }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "already_started" | "cancel_failed";
      error: string;
    };

const FORBIDDEN_ERROR =
  "You don’t have permission to cancel scans — that’s an agency staff action. Ask your admin to cancel it, or to change your role.";
const NOT_FOUND_ERROR =
  "We couldn’t find that scan. Refresh the list and try again.";
// Caller-neutral (CR minor 3): the ACTION doesn't refresh anything — a UI that
// does may append its own refresh clause. This string must stay true for any
// future consumer.
const ALREADY_STARTED_ERROR =
  "This scan already started or finished, so there’s nothing to cancel.";
const CANCEL_FAILED_ERROR =
  "We couldn’t cancel this scan. Check your connection and try again.";

export async function cancelRun(input: {
  runId: string;
}): Promise<CancelRunResult> {
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

  const runId = typeof input?.runId === "string" ? input.runId.trim() : "";
  if (!isUuidV4(runId)) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }

  const supabase = await createClient();
  // CAS: claim-sourced tenant (RLS re-pins it) + still-queued only. select('id')
  // turns a 0-row match into an honest "already started", never a silent no-op.
  const res = await supabase
    .from("runs")
    .update({ status: "canceled" })
    .eq("tenant_id", claims.tenantId)
    .eq("id", runId)
    .eq("status", "queued")
    .select("id");
  if (res.error) {
    return { ok: false, reason: "cancel_failed", error: CANCEL_FAILED_ERROR };
  }
  if (!Array.isArray(res.data) || res.data.length === 0) {
    // No queued row matched: the run left 'queued' (leased/finished/canceled),
    // or it isn't visible under RLS. Indistinguishable by design — honest.
    return { ok: false, reason: "already_started", error: ALREADY_STARTED_ERROR };
  }
  return { ok: true };
}
