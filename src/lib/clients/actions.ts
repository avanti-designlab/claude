"use server";

import { AuthorizationError, requireRole } from "@/lib/auth/guards";
import { generatePlan } from "@/lib/plan";
import { ACTIVE_VERTICALS, getPlaybook } from "@/lib/playbooks";
import { planInsertRow, taskInsertRows } from "@/lib/plans/rows";
import { createClient } from "@/lib/supabase/server";
import type { ClientLocation, ClientStatus } from "@/lib/types/db";
import type { SeedVertical } from "@/lib/types/playbook";
import type { GeneratedRoadmap } from "@/lib/types/roadmap";

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
 *     name / vertical / locations — there is no `tenant_id` field to spoof.
 *     Even if this code had a bug, the RLS INSERT policy
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
 * still succeeds — see persistPlan's partial-failure note below.
 */

export interface CreateClientInput {
  name: string;
  /** Onboarding's selected vertical (open set — mirrors `Vertical`). */
  vertical: string;
  /** Mapped from the onboarding location steps ([{name, address, geo}]). */
  locations: ClientLocation[];
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

  const name = input.name?.trim();
  if (!name) {
    return { ok: false, error: "Add a name for this client before saving." };
  }
  const vertical = input.vertical?.trim();
  if (!vertical) {
    return {
      ok: false,
      error: "Pick an industry for this client before saving.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .insert({
      // Claim-sourced tenant scope — NEVER from the client payload. RLS
      // re-pins this to app.tenant_id() and rejects any mismatch.
      tenant_id: claims.tenantId,
      name,
      vertical,
      locations: input.locations ?? [],
      status: "onboarding",
    })
    .select("id, name, vertical, status")
    .single();

  if (error || !data) {
    // Interface-voice failure (doc 06 §6): what happened + what to do, never a
    // raw Postgres/PostgREST string.
    return {
      ok: false,
      error:
        "We couldn’t save this client. Check your connection and try again — nothing was created.",
    };
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

/** Interface-voice partial-failure notice (doc 06 §6): what happened + what to do. */
const PLAN_WARNING =
  "Your client was saved, but we couldn’t create their plan — their board shows ‘None yet’ for now.";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Generate (server-side) and persist the plan + its tasks for a just-created
 * client. Returns the created plan; or `plan: null` alone when the vertical
 * has no active playbook; or `plan: null` + `planWarning` when a write failed.
 *
 * PARTIAL-FAILURE DECISION (documented where it happens): if the CLIENT row
 * saved but the plan/tasks writes fail, onboarding still returns ok:true with
 * the client and `plan: null` + `planWarning`. We do NOT fail the whole
 * onboarding and do NOT delete the client, because:
 *  - the client row is operator-entered state, and it saved fine;
 *  - the plan is DERIVED state — `generatePlan` is pure and deterministic, so
 *    a future regeneration path reproduces it losslessly from the playbook
 *    (no such control exists yet — do not promise one in user-facing copy);
 *  - PostgREST over the anon key gives us no cross-table transaction here, so
 *    rather than fake atomicity we fail soft and say so in interface voice.
 */
async function persistPlan(
  supabase: Supabase,
  tenantId: string,
  client: CreatedClient
): Promise<{ plan: CreatedPlan | null; planWarning?: string }> {
  // Gate 1a mirror (doc 02 "Validation-first rollout"): only ACTIVE verticals
  // serve clients — dormant/unknown verticals get no roadmap, exactly like the
  // onboarding plan reveal. Nothing failed, so no planWarning: there is simply
  // no active playbook to plan from yet.
  const playbook = (ACTIVE_VERTICALS as readonly string[]).includes(
    client.vertical
  )
    ? getPlaybook(client.vertical as SeedVertical)
    : null;
  if (!playbook) return { plan: null };

  try {
    // SERVER-SIDE roadmap generation from the trusted, server-loaded playbook.
    // The browser never supplies a roadmap — the UI's display-side generatePlan
    // output is never round-tripped — so a caller cannot inject tasks, forge a
    // playbook version, or widen an automation_level.
    const roadmap = generatePlan({ playbook, now: new Date().toISOString() });

    const { data: planData, error: planError } = await supabase
      .from("plans")
      .insert(planInsertRow({ tenantId, clientId: client.id, roadmap }))
      .select("id")
      .single();
    if (planError || !planData) {
      return { plan: null, planWarning: PLAN_WARNING };
    }
    const planId = planData.id as string;

    const taskRows = taskInsertRows({
      tenantId,
      clientId: client.id,
      planId,
      roadmap,
    });
    if (taskRows.length > 0) {
      const { error: tasksError } = await supabase
        .from("tasks")
        .insert(taskRows);
      if (tasksError) {
        // Best-effort cleanup so we don't keep a plan the caller was just told
        // doesn't exist. If this delete ALSO fails, an empty plan row may
        // remain — readers must tolerate a plan with zero tasks, and a future
        // regeneration path supersedes it regardless. RLS scopes the delete;
        // the eq filters just make the intent explicit.
        await supabase
          .from("plans")
          .delete()
          .eq("tenant_id", tenantId)
          .eq("id", planId);
        return { plan: null, planWarning: PLAN_WARNING };
      }
    }

    return {
      plan: {
        id: planId,
        playbookVersion: roadmap.playbookVersion,
        taskCount: taskRows.length,
        roadmap,
      },
    };
  } catch {
    // Same fail-soft path for anything unexpected (a thrown fetch error, an
    // interrupted connection): the client already saved; never 500 the whole
    // onboarding over the derived plan.
    return { plan: null, planWarning: PLAN_WARNING };
  }
}
