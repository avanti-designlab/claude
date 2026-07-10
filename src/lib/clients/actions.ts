"use server";

import { AuthorizationError, requireRole } from "@/lib/auth/guards";
import {
  ensurePlan,
  logPlanWriteFailure,
  PLAN_WARNING,
  persistPlan,
} from "@/lib/plans/persist";
import type { Supabase } from "@/lib/plans/persist";
import {
  ensureWebsiteProperty,
  type PersistedProperty,
} from "@/lib/clients/properties";
import { createClient } from "@/lib/supabase/server";
import type { ClientLocation, ClientStatus } from "@/lib/types/db";
import type { WebsiteValidation } from "@/lib/properties/validate";
import type { GeneratedRoadmap } from "@/lib/types/roadmap";
import { validateCreateClientInput, type ValidClientInput } from "./validate";

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
   * duplicate client, and the action recovers by making the row match THIS
   * payload (identical resubmit: the saved row is returned as-is, its plan
   * finished if that part had failed; edited resubmit: the row is updated
   * through to the resubmitted values — see recoverIdempotentReplay) —
   * indistinguishable from a first-time success. Omitted (older callers):
   * server-generated id, no idempotency — exactly the pre-ticket behavior.
   */
  idempotencyKey?: string;
  /**
   * The onboarding website (step 3): { url, platform }. Optional and backward
   * compatible — omitted or incomplete leaves no property (older callers are
   * unaffected). When present with a valid url + platform, a website property
   * is persisted (connection_method 'none', NEVER auth_ref) and reconciled on
   * replay alongside the client (see finalizeWithWebsite). The browser sends
   * only url + platform — never tenant_id, connection_method, or auth_ref.
   * SINGULAR by scope ruling (Orchestrator CONFIRMED 2026-07-10): onboarding
   * persists ONE website; additional step-3 properties are workspace-seam adds
   * (src/lib/properties/actions.ts). The onboarding-flow UI wiring that sends
   * this field is a frontend follow-up AFTER Code Review passes this batch.
   */
  website?: { url: string; platform: string };
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
      /**
       * The persisted website property, or null when none was entered (or it
       * couldn't be persisted — see propertyWarning). Absent for older callers
       * that send no website.
       */
      property?: PersistedProperty | null;
      /**
       * Present iff a website was entered but couldn't be saved (client still
       * saved). Independent of planWarning — both can appear.
       */
      propertyWarning?: string;
    }
  | { ok: false; error: string };

/**
 * Interface-voice insert failure (doc 06 §6): what happened + what to do,
 * never a raw Postgres/PostgREST string. Also returned BYTE-IDENTICAL on the
 * foreign-tenant idempotency collision — see recoverIdempotentReplay.
 */
const SAVE_FAILED_ERROR =
  "We couldn’t save this client. Check your connection and try again — nothing was created.";

/**
 * Interface-voice failure for a replay whose reconciling UPDATE failed (see
 * recoverIdempotentReplay). Deliberately NOT SAVE_FAILED_ERROR: by this point
 * the row from the first attempt exists, so "nothing was created" would be a
 * lie — and returning ok:true with the stale row would silently discard the
 * operator's edits. Retrying re-sends the same key and re-runs the update.
 */
const REPLAY_UPDATE_FAILED_ERROR =
  "We couldn’t save this client’s details. Check your connection and try again.";

/**
 * Interface-voice partial-failure notice (doc 06 §6) for the website property:
 * the client saved, but its site couldn't be recorded (a bad/incomplete URL, or
 * a write failure). Points at the workspace properties seam, which can add it.
 */
const PROPERTY_WARNING =
  "Your client was saved, but we couldn’t save their website — add it from the client's Properties once you're in.";

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
    // exists. Recover it instead of failing. The keyed client id IS the row id,
    // so the website property reconciles against that same client.
    if (value.idempotencyKey && error?.code === "23505") {
      const replay = await recoverIdempotentReplay(
        supabase,
        claims.tenantId,
        value.idempotencyKey,
        value
      );
      return finalizeWithWebsite(
        supabase,
        claims.tenantId,
        value.idempotencyKey,
        value.website,
        replay
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

  const base: CreateClientResult = planWarning
    ? { ok: true, client, plan, planWarning }
    : { ok: true, client, plan };

  // Website property (this batch): persisted after the client, reconciled on
  // replay. A property failure is a soft warning — the client already saved.
  return finalizeWithWebsite(
    supabase,
    claims.tenantId,
    client.id,
    value.website,
    base
  );
}

/**
 * Merge the onboarding website property into a client-save result. Runs on BOTH
 * the fresh path AND the replay path (recoverIdempotentReplay's output), which
 * is why ensureWebsiteProperty is idempotent: it inserts on the fresh path,
 * reconciles (or no-ops) on a replay. Never turns a client success into a
 * failure — the client is already saved; a website problem is a soft warning.
 *
 *   - result not ok (client didn't save, or a foreign-id replay) → returned
 *     UNCHANGED: no property is ever written against an unsaved/foreign client.
 *   - website 'none'    → unchanged (no URL was entered).
 *   - website 'invalid' → propertyWarning (a URL was entered but isn't persistable).
 *   - website 'ok'      → ensureWebsiteProperty; property on success, else warning.
 */
async function finalizeWithWebsite(
  supabase: Supabase,
  tenantId: string,
  clientId: string,
  website: WebsiteValidation,
  result: CreateClientResult
): Promise<CreateClientResult> {
  if (!result.ok) return result;

  switch (website.kind) {
    case "none":
      return result;
    case "invalid":
      return { ...result, property: null, propertyWarning: PROPERTY_WARNING };
    case "ok": {
      const outcome = await ensureWebsiteProperty(supabase, tenantId, clientId, {
        url: website.url,
        platform: website.platform,
      });
      return outcome.ok
        ? { ...result, property: outcome.property }
        : { ...result, property: null, propertyWarning: PROPERTY_WARNING };
    }
  }
}

/**
 * A keyed insert collided on the clients PK (23505): the id already exists
 * SOMEWHERE. Re-read it under OUR RLS and decide which of three worlds this is.
 *
 * 1. ROW VISIBLE, PAYLOAD IDENTICAL — the plain lost-response retry: the first
 *    request saved the client but its response never reached the browser.
 *    Return the saved row as a success and bring its plan to the state a
 *    first-time success would have produced (ensurePlan: hand back the
 *    existing tasked plan; supersede zero-task residue; or persist a fresh
 *    plan — which also recovers the client-saved-but-plan-failed case). The UI
 *    cannot, and must not be able to, tell this apart from a first-time save.
 *
 * 2. ROW VISIBLE, PAYLOAD DIVERGENT — UPDATE-THROUGH RECONCILIATION
 *    (Orchestrator decision, Code Review Major 1): the first attempt committed
 *    server-side, the UI showed failure, and the operator EDITED
 *    name/vertical/locations before retrying with the same key. Returning the
 *    original row here would announce success while silently discarding those
 *    edits — the DB would diverge from what the operator just confirmed. So
 *    the row is UPDATED to the submitted sanitized values (RLS-scoped;
 *    clients_update permits admin, migration 0003), then plan coherence:
 *      - vertical UNCHANGED → the existing plan/tasks still match the loaded
 *        playbook; ensurePlan exactly as in world 1.
 *      - vertical CHANGED → the replay-run's plan (if any) was generated from
 *        the WRONG playbook: supersede it — tasks first (tasks_plan_fk is
 *        `on delete restrict`, migration 0004), then the plan, both deletes
 *        tenant-scoped AND pinned to the read ids — then ensurePlan against
 *        the new vertical (live → fresh plan; dormant → plan:null, no warning,
 *        matching the no-playbook contract). GOVERNANCE NOTE on the deletes:
 *        the superseded plan/tasks belong to THIS SAME onboarding run —
 *        seconds old, purely derived (generatePlan is deterministic), with no
 *        human work attached — so this is replay reconciliation, not a silent
 *        auto-fix of operator-owned state.
 *    Any reconciliation failure is HONEST, never a silent stale return: a
 *    failed update → ok:false REPLAY_UPDATE_FAILED_ERROR; a failed supersede
 *    → ok:true with planWarning. Each emits one redacted telemetry line
 *    (replay_* stages).
 *
 * 3. ROW NOT VISIBLE — ADVERSARIAL CASE (pinned by test): the clients PK is
 *    GLOBAL (migration 0003), so the colliding id can belong to ANOTHER
 *    TENANT's row. Return the byte-identical generic save failure — no
 *    distinct text, no "already exists", nothing that distinguishes "foreign
 *    id" from a network blip. No update, no plan reads — the reconciliation
 *    paths above are only reachable once the row proved visible under OUR
 *    RLS. (The one extra RLS-scoped read makes the timing marginally
 *    different from a plain insert failure; that cannot be avoided without
 *    adding equalizing reads to every failure path. The residual,
 *    schema-frozen oracle we cannot remove: the INSERT itself succeeds iff
 *    the id is globally free, so a caller who already HOLDS a foreign row's
 *    id can confirm it exists somewhere. It cannot read, write, or attribute
 *    that row — RLS still isolates completely — and UUIDv4's 2^122 space
 *    makes discovering unknown ids by probing infeasible.)
 */
async function recoverIdempotentReplay(
  supabase: Supabase,
  tenantId: string,
  id: string,
  submitted: ValidClientInput
): Promise<CreateClientResult> {
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, vertical, status, locations")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) {
    // Foreign-tenant id (or a read blip): the SAME generic failure as any
    // other insert error — see adversarial note above. MUST stay identical
    // to the non-idempotent failure text.
    return { ok: false, error: SAVE_FAILED_ERROR };
  }

  const recovered: CreatedClient = {
    id: data.id as string,
    name: data.name as string,
    vertical: data.vertical as string,
    status: data.status as ClientStatus,
  };

  // World 1 vs 2: does the saved row already match what the operator just
  // confirmed? Locations compare structurally (jsonb does not preserve key
  // order, so string comparison would false-positive divergence).
  const savedLocations = (data.locations as ClientLocation[] | null) ?? [];
  const diverged =
    recovered.name !== submitted.name ||
    recovered.vertical !== submitted.vertical ||
    !jsonEqual(savedLocations, submitted.locations);

  if (!diverged) {
    // Identical resubmit — exactly the pre-reconciliation behavior.
    return replaySuccess(supabase, tenantId, recovered);
  }

  // UPDATE-THROUGH: make the row match the submitted sanitized values. RLS
  // (clients_update) re-pins the tenant regardless; the eq filters make the
  // claim-sourced scope explicit. select().single() turns a vanished row
  // (deleted between read and update) into an error instead of a silent no-op.
  const updated = await supabase
    .from("clients")
    .update({
      name: submitted.name,
      vertical: submitted.vertical,
      locations: submitted.locations,
    })
    .eq("tenant_id", tenantId)
    .eq("id", recovered.id)
    .select("id, name, vertical, status")
    .single();
  if (updated.error || !updated.data) {
    logPlanWriteFailure("replay_update", updated.error);
    return { ok: false, error: REPLAY_UPDATE_FAILED_ERROR };
  }
  const client: CreatedClient = {
    id: updated.data.id as string,
    name: updated.data.name as string,
    vertical: updated.data.vertical as string,
    status: updated.data.status as ClientStatus,
  };

  if (recovered.vertical === submitted.vertical) {
    // Only name/locations moved — the existing plan still matches its
    // playbook; reconcile plan state exactly as an identical replay would.
    return replaySuccess(supabase, tenantId, client);
  }

  // VERTICAL CHANGED: the replay-run's plan was generated from the wrong
  // playbook — supersede it before planning against the new vertical (see
  // world-2 governance note above). Read ids first so both deletes stay
  // pinned to exactly what we saw, never a blanket client_id sweep.
  const plansRes = await supabase
    .from("plans")
    .select("id")
    .eq("client_id", client.id);
  if (plansRes.error || !plansRes.data) {
    // Can't establish plan state → the honest partial-success path (same
    // contract as ensurePlan's read failures, which emit no telemetry).
    return { ok: true, client, plan: null, planWarning: PLAN_WARNING };
  }
  const planIds = (plansRes.data as Array<{ id: string }>).map((row) => row.id);
  if (planIds.length > 0) {
    // Tasks first: tasks_plan_fk is `on delete restrict` (migration 0004), so
    // a tasked plan cannot be deleted directly.
    const tasksDeleted = await supabase
      .from("tasks")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("client_id", client.id)
      .in("plan_id", planIds);
    if (tasksDeleted.error) {
      logPlanWriteFailure("replay_tasks_delete", tasksDeleted.error);
      return { ok: true, client, plan: null, planWarning: PLAN_WARNING };
    }
    const plansDeleted = await supabase
      .from("plans")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("client_id", client.id)
      .in("id", planIds);
    if (plansDeleted.error) {
      logPlanWriteFailure("replay_plans_delete", plansDeleted.error);
      return { ok: true, client, plan: null, planWarning: PLAN_WARNING };
    }
  }
  return replaySuccess(supabase, tenantId, client);
}

/**
 * Indistinguishable-from-first-time: same ok/plan/planWarning shapes the
 * first request would have produced for this client's current state.
 */
async function replaySuccess(
  supabase: Supabase,
  tenantId: string,
  client: CreatedClient
): Promise<CreateClientResult> {
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

/**
 * Structural equality over plain JSON data (array order significant, object
 * key order not). Both sides are trusted-plain by construction: `a` is a
 * jsonb column PostgREST just parsed, `b` came out of the runtime clamp.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    );
  }
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null
  ) {
    const aKeys = Object.keys(a);
    const bRecord = b as Record<string, unknown>;
    return (
      aKeys.length === Object.keys(b).length &&
      aKeys.every(
        (key) =>
          Object.hasOwn(b, key) &&
          jsonEqual((a as Record<string, unknown>)[key], bRecord[key])
      )
    );
  }
  return false;
}
