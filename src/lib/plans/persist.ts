/**
 * Plan persistence + reconciliation for a client (doc 03 §3/§6; frozen
 * schema: supabase/migrations/0004_plans_and_tasks.sql). Shared by the two
 * write paths that may create a plan:
 *   - onboarding (createClientFromOnboarding, src/lib/clients/actions.ts)
 *   - plan regeneration (regeneratePlanForClient, src/lib/plans/actions.ts)
 *
 * Deliberately NOT a "use server" module: exporting these helpers from an
 * action file would mint each one as a browser-invokable RPC endpoint. This
 * stays a plain server-side module that only the audited actions import.
 * Every caller passes a claim-scoped Supabase client and a CLAIM-SOURCED
 * tenantId (never anything the browser sent), and RLS (plans_insert /
 * tasks_insert / plans_delete policies, migration 0004) re-pins tenant_id
 * below us regardless — a row can never land outside, and a delete can never
 * reach outside, the caller's tenant.
 */

import type { CreatedClient, CreatedPlan } from "@/lib/clients/actions";
import { generatePlan } from "@/lib/plan";
import { ACTIVE_VERTICALS, getPlaybook } from "@/lib/playbooks";
import { planInsertRow, taskInsertRows } from "@/lib/plans/rows";
import type { createClient } from "@/lib/supabase/server";
import type { SeedVertical } from "@/lib/types/playbook";
import type { GeneratedRoadmap } from "@/lib/types/roadmap";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Interface-voice partial-failure notice (doc 06 §6): what happened + what to do. */
export const PLAN_WARNING =
  "Your client was saved, but we couldn’t create their plan — their board shows ‘None yet’ for now.";

/* ------------------------------------------------------------------ */
/* Redacted failure telemetry (carried ticket d)                       */
/* ------------------------------------------------------------------ */

/**
 * Every plan-write failure path emits exactly ONE server-side console.error
 * carrying ONLY:
 *   - the stable marker below (greppable in hosted logs),
 *   - which stage failed,
 *   - the Postgres/PostgREST error CODE, shape-checked — never free text.
 * NO payloads, NO user data, NO tenant/client ids, NO error messages: a
 * PostgREST `message`/`details` can quote row data verbatim, and the
 * secrets-in-logs rule (docs/ops/environments.md §Secrets rules) is absolute.
 */
export const PLAN_WRITE_FAILURE_MARKER = "[plan-write-failure]";

export type PlanWriteStage =
  | "plan_insert"
  | "tasks_insert"
  | "cleanup_delete"
  | "supersede_delete"
  | "thrown";

function logPlanWriteFailure(stage: PlanWriteStage, cause: unknown): void {
  console.error(
    `${PLAN_WRITE_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`
  );
}

/**
 * Extract a bare SQLSTATE/PostgREST code ("23505", "PGRST301"). Anything that
 * isn't a short alphanumeric token collapses to "unknown", so no data can
 * ride into the log line even through a hostile/misbehaving error object.
 */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)) {
      return code;
    }
  }
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* Playbook gate                                                       */
/* ------------------------------------------------------------------ */

/**
 * Gate 1a mirror (doc 02 "Validation-first rollout"): only ACTIVE verticals
 * serve clients — dormant/unknown verticals get no roadmap, exactly like the
 * onboarding plan reveal.
 */
function activePlaybook(vertical: string) {
  return (ACTIVE_VERTICALS as readonly string[]).includes(vertical)
    ? getPlaybook(vertical as SeedVertical)
    : null;
}

/* ------------------------------------------------------------------ */
/* persistPlan — generate + write a fresh plan and its tasks           */
/* ------------------------------------------------------------------ */

/**
 * Generate (server-side) and persist the plan + its tasks for a client.
 * Returns the created plan; or `plan: null` alone when the vertical has no
 * active playbook; or `plan: null` + `planWarning` when a write failed.
 *
 * PARTIAL-FAILURE DECISION (documented where it happens): if the CLIENT row
 * saved but the plan/tasks writes fail, onboarding still returns ok:true with
 * the client and `plan: null` + `planWarning`. We do NOT fail the whole
 * onboarding and do NOT delete the client, because:
 *  - the client row is operator-entered state, and it saved fine;
 *  - the plan is DERIVED state — `generatePlan` is pure and deterministic, so
 *    the regeneration path (regeneratePlanForClient) reproduces it losslessly
 *    from the playbook;
 *  - PostgREST over the anon key gives us no cross-table transaction here, so
 *    rather than fake atomicity we fail soft and say so in interface voice.
 */
export async function persistPlan(
  supabase: Supabase,
  tenantId: string,
  client: CreatedClient
): Promise<{ plan: CreatedPlan | null; planWarning?: string }> {
  // Nothing failed when the playbook is dormant, so no planWarning: there is
  // simply no active playbook to plan from yet.
  const playbook = activePlaybook(client.vertical);
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
      logPlanWriteFailure("plan_insert", planError);
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
        logPlanWriteFailure("tasks_insert", tasksError);
        // Best-effort cleanup so we don't keep a plan the caller was just told
        // doesn't exist. If this delete ALSO fails, an empty plan row may
        // remain — readers must tolerate a plan with zero tasks, and
        // ensurePlan supersedes it on the next regenerate regardless. RLS
        // scopes the delete; the eq filters just make the intent explicit.
        const cleanup = await supabase
          .from("plans")
          .delete()
          .eq("tenant_id", tenantId)
          .eq("id", planId);
        if (cleanup.error) {
          logPlanWriteFailure("cleanup_delete", cleanup.error);
        }
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
  } catch (err) {
    // Same fail-soft path for anything unexpected (a thrown fetch error, an
    // interrupted connection): never 500 the caller over the derived plan.
    logPlanWriteFailure("thrown", err);
    return { plan: null, planWarning: PLAN_WARNING };
  }
}

/* ------------------------------------------------------------------ */
/* ensurePlan — idempotent "this client should have a plan"            */
/* ------------------------------------------------------------------ */

export type EnsurePlanOutcome =
  /** A plan WITH tasks already existed — returned untouched, never duplicated. */
  | { kind: "exists"; plan: CreatedPlan }
  /** A fresh plan + tasks were persisted (any zero-task residue superseded first). */
  | { kind: "created"; plan: CreatedPlan }
  /** The vertical has no active playbook (Gate 1a) — nothing failed. */
  | { kind: "no_playbook" }
  /** A read or write failed — retryable; nothing usable was produced. */
  | { kind: "failed" };

/** What ensurePlan reads back from `plans` (`created_at` is ordered by server-side, not selected). */
interface PlanSelectRow {
  id: string;
  playbook_version: string;
  /** Written by planInsertRow from the server generator — trusted shape. */
  generated_roadmap: GeneratedRoadmap;
}

/**
 * Reconcile a client to "has exactly one live plan":
 *  - a plan WITH tasks exists → return it (idempotent — NEVER a duplicate);
 *  - only zero-task plan rows exist (the tolerated partial-failure residue) →
 *    supersede: tenant-scoped delete of exactly those rows, then persist fresh;
 *  - no plan rows → persist fresh.
 *
 * KNOWN RACE (frozen-schema limitation, accepted): nothing in migration 0004
 * makes plans unique per client, so two CONCURRENT calls can both pass the
 * reads and both persist. The delete is pinned to the ids we read (never a
 * blanket client_id delete) so a concurrent request's fresh plan is never
 * swept; sequential lost-response retries — the case ticket (a) closes — are
 * fully idempotent. A per-client unique index would close the concurrent
 * window and needs the post-freeze schema path.
 */
export async function ensurePlan(
  supabase: Supabase,
  tenantId: string,
  client: CreatedClient
): Promise<EnsurePlanOutcome> {
  if (!activePlaybook(client.vertical)) return { kind: "no_playbook" };

  // What does this client already have? RLS scopes both reads to the caller's
  // tenant; eq(client_id) narrows within it. Single-client task volume sits
  // far below the PostgREST row cap (carried ticket b concerns dashboard-wide
  // aggregates, not this read).
  const plansRes = await supabase
    .from("plans")
    .select("id, playbook_version, generated_roadmap")
    .eq("client_id", client.id)
    .order("created_at", { ascending: false });
  if (plansRes.error || !plansRes.data) return { kind: "failed" };
  const planRows = plansRes.data as unknown as PlanSelectRow[];

  if (planRows.length > 0) {
    const tasksRes = await supabase
      .from("tasks")
      .select("plan_id")
      .eq("client_id", client.id);
    if (tasksRes.error || !tasksRes.data) return { kind: "failed" };
    const taskCounts = new Map<string, number>();
    for (const row of tasksRes.data as Array<{ plan_id: string }>) {
      taskCounts.set(row.plan_id, (taskCounts.get(row.plan_id) ?? 0) + 1);
    }

    // Idempotence: newest plan WITH tasks wins (newest first, so residue that
    // is newer than a good plan can never shadow it — it just stays tolerated
    // residue until a regenerate runs with no good plan present).
    const tasked = planRows.find((row) => (taskCounts.get(row.id) ?? 0) > 0);
    if (tasked) {
      return {
        kind: "exists",
        plan: {
          id: tasked.id,
          playbookVersion: tasked.playbook_version,
          taskCount: taskCounts.get(tasked.id) ?? 0,
          roadmap: tasked.generated_roadmap,
        },
      };
    }

    // Only zero-task rows exist. Supersede exactly what we read — RLS scopes
    // the delete; the eq filters make the intent explicit.
    const superseded = await supabase
      .from("plans")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("client_id", client.id)
      .in(
        "id",
        planRows.map((row) => row.id)
      );
    if (superseded.error) {
      logPlanWriteFailure("supersede_delete", superseded.error);
      return { kind: "failed" };
    }
  }

  const { plan, planWarning } = await persistPlan(supabase, tenantId, client);
  if (plan) return { kind: "created", plan };
  // persistPlan re-checks the playbook itself; plan:null without a warning
  // can only mean the vertical went dormant between our check and its check.
  return planWarning ? { kind: "failed" } : { kind: "no_playbook" };
}
