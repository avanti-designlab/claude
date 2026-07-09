"use server";

import { AuthorizationError, requireRole } from "@/lib/auth/guards";
import type { CreatedClient, CreatedPlan } from "@/lib/clients/actions";
import { isUuidV4 } from "@/lib/clients/validate";
import { ensurePlan } from "@/lib/plans/persist";
import { createClient } from "@/lib/supabase/server";
import type { ClientStatus } from "@/lib/types/db";

/**
 * Plan-regeneration server action (carried ticket a, part 1 — the recovery
 * control the onboarding partial-failure copy needed). Same security posture
 * as createClientFromOnboarding:
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser
 *    sends only a clientId; the tenant comes from the caller's VERIFIED JWT
 *    claim, and RLS (plans/tasks policies, migration 0004) re-pins every row
 *    below us regardless.
 *  - WRITE RIGHTS ARE ADMIN-ONLY (`requireRole("agency_admin")`) — a
 *    deliberate product choice STRICTER than RLS, which admits any writer on
 *    plans/tasks (`app.is_writer()`, operator included; migration 0004).
 *    Client-facing plan regeneration stays an admin surface until the
 *    operator-role UX is designed; RLS remains the enforcement floor either
 *    way. OPEN PRODUCT QUESTION: widen this guard to operators once their
 *    console ships.
 *  - The roadmap is generated SERVER-SIDE from the server-loaded playbook
 *    (persistPlan) — nothing generative round-trips through the browser.
 *
 * Outcomes (exhaustive):
 *  - client not visible under our RLS   → not_found. Cross-tenant ids are
 *    INDISTINGUISHABLE from nonexistent ones by design — RLS yields zero rows
 *    for both, so this action cannot be used to probe other tenants.
 *  - vertical has no active playbook    → no_playbook (Gate 1a; calm — nothing
 *    failed).
 *  - a plan WITH tasks already exists   → ok, alreadyExisted: true, the
 *    existing plan returned untouched. Idempotent: NEVER a duplicate plan.
 *  - only zero-task plan rows exist (the tolerated partial-failure residue)
 *    → superseded (tenant-scoped delete), then a fresh plan + tasks persisted
 *    → ok, alreadyExisted: false.
 *  - any read/write failure             → write_failed (retryable).
 *
 * ROLE-FAILURE MAPPING (documented decision): the frozen reason set has no
 * dedicated permission bucket, so an authenticated caller with the wrong role
 * gets reason "write_failed" — nothing was written, and retrying cannot make
 * it worse — with a permission-specific error string. The STRING is the
 * display truth; the reason is only the coarse bucket. Pinned by test.
 */

/**
 * FROZEN CONTRACT — the frontend consumes this exact shape. Post-handoff
 * changes require Orchestrator + Code Review sign-off (CLAUDE.md rule 1).
 */
export type RegeneratePlanResult =
  | { ok: true; plan: CreatedPlan; alreadyExisted: boolean }
  | {
      ok: false;
      reason: "no_playbook" | "not_found" | "write_failed";
      error: string;
    };

/* Interface-voice outcomes (doc 06 §6): what happened + what to do, never a
 * raw Postgres/PostgREST string. The no-playbook line mirrors the approved
 * onboarding copy ("a plan activates once this vertical's playbook ships") —
 * the backfill it promises is carried ticket (e), owner aeo-seo-logic-engineer. */
const PERMISSION_ERROR =
  "You don’t have permission to regenerate plans — that’s an agency-admin action. Ask your admin to run it, or to change your role.";
const NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const NO_PLAYBOOK_ERROR =
  "No active playbook for this industry yet, so there’s no plan to build. A plan activates once this vertical’s playbook ships.";
const WRITE_FAILED_ERROR =
  "We couldn’t rebuild this plan. Check your connection and try again.";

export async function regeneratePlanForClient(input: {
  clientId: string;
}): Promise<RegeneratePlanResult> {
  // AUTHZ. requireRole authenticates first (redirects to /login if there is no
  // verified claim — that redirect must propagate, so we only trap the
  // wrong-role case and rethrow everything else, including NEXT_REDIRECT).
  let claims;
  try {
    claims = await requireRole("agency_admin");
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "write_failed", error: PERMISSION_ERROR };
    }
    throw err;
  }

  // Runtime backstop on the one caller-supplied field: a non-UUID can't be a
  // client id, so it is definitionally not found — and junk never reaches
  // Postgres (same posture as the onboarding clamp, ticket c).
  const clientId =
    typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, vertical, status")
    .eq("id", clientId)
    .maybeSingle();
  if (error) {
    // A failed READ is not "not found" — it's retryable, and claiming the
    // client is gone would be a lie in interface voice.
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
  if (!data) {
    // RLS-scoped read came back empty: nonexistent id and another tenant's id
    // are the SAME observation here — correct and intended (doc 03 §4).
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }

  const client: CreatedClient = {
    id: data.id as string,
    name: data.name as string,
    vertical: data.vertical as string,
    status: data.status as ClientStatus,
  };

  const outcome = await ensurePlan(supabase, claims.tenantId, client);
  switch (outcome.kind) {
    case "exists":
      return { ok: true, plan: outcome.plan, alreadyExisted: true };
    case "created":
      return { ok: true, plan: outcome.plan, alreadyExisted: false };
    case "no_playbook":
      return { ok: false, reason: "no_playbook", error: NO_PLAYBOOK_ERROR };
    case "failed":
      return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
}
