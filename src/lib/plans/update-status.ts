"use server";

/**
 * updateTaskStatus — the ONE sanctioned thin write on `tasks.status`, added for
 * the plan tab (P1 slice). It lets a human move a HUMAN-OWNED plan task along the
 * legal, gate-free edge (todo ⇄ in_progress) and NOTHING else. The legality rules
 * — and the reasoning for why the subset is this narrow — live in task-status.ts;
 * this action re-enforces every one of them at the write with a compare-and-set,
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
 *  - CAS pins THREE predicates, not just the id:
 *      automation_level = 'human_only'  — a machine-owned (auto) or pipeline
 *        (ai_draft_human_approve) task matches ZERO rows and is refused; the
 *        human/AI ownership boundary is enforced in the DB, not just the UI.
 *      status = requiredSourceFor(to)   — the task must still hold the exact
 *        source the target implies (todo⇄in_progress), so a concurrent change is
 *        an honest "it already moved", never a silent clobber.
 *      id + tenant_id                   — claim-sourced tenant; RLS re-pins it.
 *  - ONLY status is written (no payload/assignee/automation_level): the update
 *    patch is exactly `{ status }`.
 *
 * NO existence oracle: a nonexistent id, another tenant's id, a non-human_only
 * task, and a task that simply already moved are ALL the same 0-row observation
 * → one honest "conflict" outcome. The id is UUID-validated first only to reject
 * obvious garbage before a round-trip, never to reveal what exists (doc 03 §4).
 *
 * This does NOT touch content_items (the R3 content lifecycle owns that surface);
 * it moves a PLAN task's own status only.
 */

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { createClient } from "@/lib/supabase/server";
import type { TaskStatus } from "@/lib/types/db";
import { isLegalManualTarget, requiredSourceFor } from "./task-status";

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
  // tampered/garbage `to` (e.g. "published") is rejected here, not at the DB.
  const to = input?.to;
  if (!isLegalManualTarget(to)) {
    return {
      ok: false,
      reason: "illegal_transition",
      error: ILLEGAL_TRANSITION_ERROR,
    };
  }
  const from = requiredSourceFor(to);

  const supabase = await createClient();
  // CAS: claim-sourced tenant (RLS re-pins it) + id + human_only + the exact
  // source status. select('id') turns a 0-row match into an honest "conflict",
  // never a silent no-op. Only `status` is written.
  const res = await supabase
    .from("tasks")
    .update({ status: to })
    .eq("tenant_id", claims.tenantId)
    .eq("id", taskId)
    .eq("automation_level", "human_only")
    .eq("status", from)
    .select("id");
  if (res.error) {
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
  if (!Array.isArray(res.data) || res.data.length === 0) {
    // No matching row: the task moved, isn't human_only, or isn't visible under
    // RLS. Indistinguishable by design — one honest refusal.
    return { ok: false, reason: "conflict", error: CONFLICT_ERROR };
  }
  return { ok: true, status: to };
}
