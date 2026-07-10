"use server";

/**
 * updateTaskStatus — the ONE sanctioned thin write on `tasks.status`, added for
 * the plan tab (P1 slice). It lets a human move a plan task along a legal,
 * gate-free, reversible edge and NOTHING else:
 *   - human_only:               todo ⇄ in_progress AND in_progress ⇄ done
 *   - ai_draft_human_approve:   todo ⇄ in_progress ONLY (work-tracking; `done`
 *                               and every pipeline/gate word stay unreachable)
 *   - auto:                     no manual move at all
 * The legality rules — and the reasoning for why the subset is this narrow —
 * live in task-status.ts (one edge table drives both the UI and this action).
 * This action re-enforces every one of them at the write with a compare-and-set,
 * so a stale or hostile client can never widen the edge.
 *
 * SECURITY posture mirrors cancelRun / the M2 audit action exactly:
 *  - TENANT IS CLAIM-SOURCED: the browser sends only the task id + target; the
 *    tenant comes from the caller's VERIFIED JWT claim, and RLS (`tasks_update`:
 *    tenant_id = app.tenant_id() AND app.is_writer()) re-pins it below us.
 *  - WRITER FLOOR: requireOperator() (agency_admin | operator) mirrors
 *    tasks_update's is_writer() honestly — task status is day-to-day operator
 *    work, so this is the operator floor, NOT the stricter agency_admin gate the
 *    plan-REGENERATION action deliberately keeps. RLS remains the real floor.
 *  - CAS pins, beyond the id, the predicates `manualCasFor(to)` derives from the
 *    SAME edge table the UI renders:
 *      automation_level IN cas.levels — 'auto' is always excluded, so a
 *        machine-owned task matches ZERO rows; a `done` target's level set is
 *        human_only only, so a pipeline task can't be marked done (the 0013
 *        DB CHECK tasks_done_is_human_only is the authoritative backstop).
 *      status IN cas.sources          — the task must still hold one of the exact
 *        source statuses the target implies (a concurrent change is an honest
 *        "it already moved", never a silent clobber).
 *      id + tenant_id                 — claim-sourced tenant; RLS re-pins it.
 *  - ONLY status is written (no payload/assignee/automation_level): the update
 *    patch is exactly `{ status }` — a manual move can never change ownership.
 *
 * NO existence oracle: a nonexistent id, another tenant's id, a task whose level
 * the move isn't legal on, and a task that simply already moved are ALL the same
 * 0-row observation → one honest "conflict" outcome. The id is UUID-validated
 * first only to reject obvious garbage before a round-trip, never to reveal what
 * exists (doc 03 §4).
 *
 * This does NOT touch content_items (the R3 content lifecycle owns that surface);
 * it moves a PLAN task's own status only.
 */

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { createClient } from "@/lib/supabase/server";
import type { TaskStatus } from "@/lib/types/db";
import { isLegalManualTarget, manualCasFor } from "./task-status";

/** FROZEN CONTRACT — the plan-tab control consumes this exact shape. */
export type UpdateTaskStatusResult =
  | { ok: true; status: TaskStatus }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "illegal_transition"
        | "conflict"
        | "write_failed";
      error: string;
    };

/* Interface-voice outcomes (doc 06 §6): what happened + what to do — never a raw
 * Postgres/PostgREST string, and never a hint at what exists. */
const FORBIDDEN_ERROR =
  "You don’t have permission to update tasks — that’s an agency-staff action. Ask your admin, or to change your role.";
const NOT_FOUND_ERROR =
  "We couldn’t find that task. Refresh the plan and try again.";
const ILLEGAL_TRANSITION_ERROR =
  "That isn’t a move you can make on this task by hand. Refresh the plan and try again.";
const CONFLICT_ERROR =
  "This task already moved, or isn’t one you manage by hand — refresh the plan to see where it stands.";
const WRITE_FAILED_ERROR =
  "We couldn’t update this task. Check your connection and try again.";

export async function updateTaskStatus(input: {
  taskId: string;
  to: TaskStatus;
}): Promise<UpdateTaskStatusResult> {
  // AUTHZ — writer floor. requireOperator authenticates first (its /login
  // redirect must propagate; only the wrong-role case is trapped and mapped).
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  // Runtime backstop on the caller-supplied fields. A non-UUID can't be a task
  // id, so it is definitionally not found — and junk never reaches Postgres.
  const taskId = typeof input?.taskId === "string" ? input.taskId.trim() : "";
  if (!isUuidV4(taskId)) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }

  // The target must be inside the sanctioned legal set BEFORE any round-trip: a
  // tampered/garbage `to` (e.g. "published", "in_review") is rejected here, not
  // at the DB.
  const to = input?.to;
  if (!isLegalManualTarget(to)) {
    return {
      ok: false,
      reason: "illegal_transition",
      error: ILLEGAL_TRANSITION_ERROR,
    };
  }

  // The CAS predicates for this target — source status(es) + the automation
  // levels the move is legal on — derived from the same edge table the UI
  // renders (task-status.ts). null only if `to` targets no legal edge (can't
  // happen after isLegalManualTarget succeeds, but guarded, never assumed).
  const cas = manualCasFor(to);
  if (!cas) {
    return {
      ok: false,
      reason: "illegal_transition",
      error: ILLEGAL_TRANSITION_ERROR,
    };
  }

  const supabase = await createClient();
  // CAS: claim-sourced tenant (RLS re-pins it) + id + the automation levels this
  // move is legal on ('auto' always excluded; a `done` target is human_only-only
  // here AND by the 0013 DB CHECK) + the exact source status(es) the target
  // implies. select('id') turns a 0-row match into an honest "conflict", never a
  // silent no-op. Only `status` is written.
  const res = await supabase
    .from("tasks")
    .update({ status: to })
    .eq("tenant_id", claims.tenantId)
    .eq("id", taskId)
    .in("automation_level", [...cas.levels])
    .in("status", [...cas.sources])
    .select("id");
  if (res.error) {
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
  if (!Array.isArray(res.data) || res.data.length === 0) {
    // No matching row: the task moved, the move isn't legal on its level, or it
    // isn't visible under RLS. Indistinguishable by design — one honest refusal.
    return { ok: false, reason: "conflict", error: CONFLICT_ERROR };
  }
  return { ok: true, status: to };
}
