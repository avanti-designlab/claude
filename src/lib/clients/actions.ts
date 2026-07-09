"use server";

import { AuthorizationError, requireRole } from "@/lib/auth/guards";
import { ensurePlan, PLAN_WARNING, persistPlan } from "@/lib/plans/persist";
import type { Supabase } from "@/lib/plans/persist";
import { createClient } from "@/lib/supabase/server";
import type { ClientLocation, ClientStatus } from "@/lib/types/db";
import type { GeneratedRoadmap } from "@/lib/types/roadmap";
import { validateCreateClientInput } from "./validate";

/**
 * Client-record server actions (the real "make it real" write of this slice).
 *
 * Persisting a client is the first live tenant write in the product. Two hard
 * properties, both enforced here AND below us in the database:
 *
 *  1. TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The row's
 *     `tenant_id` is taken from the caller's VERIFIED JWT claim
 *     (`requireRole` → `getClaims` → supabase `getClaims()` signature-verified),
 *     not from anything the browser sent. The client payload carries only
 *     name / vertical / locations / idempotencyKey — there is no `tenant_id`
 *     field to spoof. Even if this code had a bug, the RLS INSERT policy
 *     (`clients_insert`: `with check (tenant_id = app.tenant_id() and
 *     app.is_admin())`, migration 0003) re-pins `tenant_id` to the caller's
 *     claim and rejects a mismatched or foreign tenant — so a cross-tenant
 *     write is structurally impossible, not merely discouraged.
 *
 *  2. WRITE RIGHTS ARE ADMIN-ONLY. `clients` writes are `agency_admin`-only
 *     (contract §3). We guard with `requireRole("agency_admin")` so the UI can
 *     show a precise permission message instead of a raw RLS rejection; RLS is
 *     still the real gate (`app.is_admin()`), the guard only mirrors it.
 *
 * NOTE — what this slice persists: the CLIENT row (name, vertical, locations,
 * status 'onboarding'), then the generated PLAN row and its TASKS rows
 * (migration 0004). The roadmap is generated SERVER-SIDE from the loaded
 * playbook (`generatePlan` — pure, deterministic; the onboarding UI's own
 * client-side call is display-only and never round-trips). The browser still
 * sends only name / vertical / locations, so a caller can no more forge a
 * roadmap, a playbook version, or a task's automation_level than it can a
 * tenant_id. If the plan write path fails after the client saved, onboarding
 * still succeeds — see persistPlan's partial-failure note
 * (src/lib/plans/persist.ts, shared with the plan-regeneration action).
 *
 * HARDENING (carried tickets a + c, real-data-slice gate record):
 *  - RUNTIME CLAMP: the payload is shape-checked / trimmed / length-capped by
 *    `validateCreateClientInput` (./validate.ts) BEFORE anything reaches
 *    Postgres; only the sanitized value is persisted.
 *  - IDEMPOTENT CREATE: an optional `idempotencyKey` becomes the row id, so a
 *    lost-response retry collides on the PK and is recovered as a success
 *    instead of duplicating the client (see recoverIdempotentReplay).
 */

export interface CreateClientInput {
  name: string;
  /** Onboarding's selected vertical (open set — mirrors `Vertical`). */
  vertical: string;
  /** Mapped from the onboarding location steps ([{name, address, geo}]). */
  locations: ClientLocation[];
  /**
   * Optional idempotency key (carried ticket a). When present it BECOMES the
   * client row id — generate ONE UUID v4 per onboarding run
   * (crypto.randomUUID()) and re-send the SAME key on retry. A retry of a
   * lost response then collides on the primary key instead of creating a
   * duplicate client, and the action recovers by returning the already-saved
   * row (finishing its plan if that part had failed) — indistinguishable from
   * a first-time success. Omitted (older callers): server-generated id, no
   * idempotency — exactly the pre-ticket behavior.
   */
  idempotencyKey?: string;
}

export interface CreatedClient {
  id: string;
  name: string;
  vertical: string;
  status: ClientStatus;
}

export interface CreatedPlan {
  id: string;
  playbookVersion: string;
  taskCount: number;
  roadmap: GeneratedRoadmap;
}

export type CreateClientResult =
  | {
      ok: true;
      client: CreatedClient;
      /**
       * Null when no plan was persisted: either the vertical has no ACTIVE
       * playbook (Gate 1a — nothing failed, no planWarning), or the plan/tasks
       * writes failed after the client saved (planWarning set).
       */
      plan: CreatedPlan | null;
      /** Present iff the client saved but the plan write path failed. */
      planWarning?: string;
    }
  | { ok: false; error: string };

/**
 * Interface-voice insert failure (doc 06 §6): what happened + what to do,
 * never a raw Postgres/PostgREST string. Also returned BYTE-IDENTICAL on the
 * foreign-tenant idempotency collision — see recoverIdempotentReplay.
 */
const SAVE_FAILED_ERROR =
  "We couldn’t save this client. Check your connection and try again — nothing was created.";

export async function createClientFromOnboarding(
  input: CreateClientInput
): Promise<CreateClientResult> {
  // AUTHZ. requireRole authenticates first (redirects to /login if there is no
  // verified claim — that redirect must propagate, so we only trap the
  // wrong-role case and rethrow everything else, including NEXT_REDIRECT).
  let claims;
  try {
    claims = await requireRole("agency_admin");
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        error:
          "You don’t have permission to add clients — that’s an agency-admin action. Ask your admin to add the client, or to change your role.",
      };
    }
    throw err;
  }

  // RUNTIME CLAMP (carried ticket c): the compile-time type is no defense
  // against hostile JSON. Shape/trim/length-cap everything before it can reach
  // Postgres; refusals are interface-voice. From here down only the SANITIZED
  // value is used — unknown keys dropped, fields trimmed and capped.
  const validated = validateCreateClientInput(input);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  const value = validated.value;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .insert({
      // IDEMPOTENCY KEY IS THE ROW ID (carried ticket a; schema-frozen-
      // compatible design). Validated strict-UUID-v4 above; a replayed key
      // hits the global PK (migration 0003) and lands in the 23505 branch
      // below instead of duplicating the client.
      ...(value.idempotencyKey ? { id: value.idempotencyKey } : {}),
      // Claim-sourced tenant scope — NEVER from the client payload. RLS
      // re-pins this to app.tenant_id() and rejects any mismatch.
      tenant_id: claims.tenantId,
      name: value.name,
      vertical: value.vertical,
      locations: value.locations,
      status: "onboarding",
    })
    .select("id, name, vertical, status")
    .single();

  if (error || !data) {
    // Unique violation on a KEYED insert = an idempotent replay (a
    // lost-response retry, or a concurrent double submit): the row already
    // exists. Recover it instead of failing.
    if (value.idempotencyKey && error?.code === "23505") {
      return recoverIdempotentReplay(
        supabase,
        claims.tenantId,
        value.idempotencyKey
      );
    }
    // Interface-voice failure (doc 06 §6): what happened + what to do, never a
    // raw Postgres/PostgREST string.
    return { ok: false, error: SAVE_FAILED_ERROR };
  }

  const client: CreatedClient = {
    id: data.id as string,
    name: data.name as string,
    vertical: data.vertical as string,
    status: data.status as ClientStatus,
  };

  // Plan + tasks (this slice). Same claim-sourced tenant scope as the client
  // insert above; RLS (`plans_insert` / `tasks_insert`, migration 0004)
  // re-pins tenant_id on both writes exactly as `clients_insert` did.
  const { plan, planWarning } = await persistPlan(
    supabase,
    claims.tenantId,
    client
  );

  return planWarning
    ? { ok: true, client, plan, planWarning }
    : { ok: true, client, plan };
}

/**
 * A keyed insert collided on the clients PK (23505): the id already exists
 * SOMEWHERE. Re-read it under OUR RLS and decide which of two worlds this is.
 *
 * 1. ROW VISIBLE (same tenant) — the lost-response retry: the first request
 *    saved the client but its response never reached the browser. Return the
 *    saved row as a success and bring its plan to the state a first-time
 *    success would have produced (ensurePlan: hand back the existing tasked
 *    plan; supersede zero-task residue; or persist a fresh plan — which also
 *    recovers the client-saved-but-plan-failed case). The UI cannot, and must
 *    not be able to, tell this apart from a first-time save.
 *
 * 2. ROW NOT VISIBLE — ADVERSARIAL CASE (pinned by test): the clients PK is
 *    GLOBAL (migration 0003), so the colliding id can belong to ANOTHER
 *    TENANT's row. Return the byte-identical generic save failure — no
 *    distinct text, no "already exists", nothing that distinguishes "foreign
 *    id" from a network blip. (The one extra RLS-scoped read makes the timing
 *    marginally different from a plain insert failure; that cannot be avoided
 *    without adding equalizing reads to every failure path. The residual,
 *    schema-frozen oracle we cannot remove: the INSERT itself succeeds iff
 *    the id is globally free, so a caller who already HOLDS a foreign row's
 *    id can confirm it exists somewhere. It cannot read, write, or attribute
 *    that row — RLS still isolates completely — and UUIDv4's 2^122 space
 *    makes discovering unknown ids by probing infeasible.)
 */
async function recoverIdempotentReplay(
  supabase: Supabase,
  tenantId: string,
  id: string
): Promise<CreateClientResult> {
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, vertical, status")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) {
    // Foreign-tenant id (or a read blip): the SAME generic failure as any
    // other insert error — see adversarial note above. MUST stay identical
    // to the non-idempotent failure text.
    return { ok: false, error: SAVE_FAILED_ERROR };
  }

  const client: CreatedClient = {
    id: data.id as string,
    name: data.name as string,
    vertical: data.vertical as string,
    status: data.status as ClientStatus,
  };

  // Indistinguishable-from-first-time: same ok/plan/planWarning shapes the
  // first request would have produced for this client's current state.
  const outcome = await ensurePlan(supabase, tenantId, client);
  switch (outcome.kind) {
    case "exists":
    case "created":
      return { ok: true, client, plan: outcome.plan };
    case "no_playbook":
      return { ok: true, client, plan: null };
    case "failed":
      return { ok: true, client, plan: null, planWarning: PLAN_WARNING };
  }
}
