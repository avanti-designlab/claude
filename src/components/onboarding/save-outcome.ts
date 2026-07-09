/**
 * Pure flow logic for the onboarding save (no React, no server imports —
 * unit-tested in the default `npm test` run, like `@/lib/clients/format`).
 *
 * The onboarding flow fires `createClientFromOnboarding` when the operator
 * leaves step 3; the assembling beat (step 4) covers the in-flight await, and
 * the plan step (step 5) renders EXACTLY what the server persisted — the
 * roadmap shown is `result.plan.roadmap`, never a client-side regeneration,
 * so what the operator sees is what the database holds.
 */

import type {
  CreateClientResult,
  CreatedClient,
  CreatedPlan,
} from "@/lib/clients/actions";

/** Where the save is, from the flow's point of view (drives steps 4–5). */
export type SaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | {
      phase: "saved";
      client: CreatedClient;
      plan: CreatedPlan | null;
      planWarning?: string;
    }
  | { phase: "error"; message: string };

/** Map the server action's result into flow state. */
export function toSaveState(result: CreateClientResult): SaveState {
  if (!result.ok) {
    return { phase: "error", message: result.error };
  }
  return {
    phase: "saved",
    client: result.client,
    plan: result.plan,
    planWarning: result.planWarning,
  };
}

/**
 * The three ok-outcomes the plan step renders (mirrors the action's contract):
 * - "plan"              → plan + tasks persisted; show the saved roadmap.
 * - "no-playbook"       → plan null, no warning: nothing failed — the vertical
 *                         has no active playbook yet (Gate 1a). Client saved.
 * - "plan-write-failed" → plan null + planWarning: the client saved but the
 *                         plan write path failed. Non-fatal; show the warning.
 */
export type PlanOutcome = "plan" | "no-playbook" | "plan-write-failed";

export function planOutcome(
  plan: CreatedPlan | null,
  planWarning?: string
): PlanOutcome {
  if (plan) return "plan";
  return planWarning ? "plan-write-failed" : "no-playbook";
}

/** True once the server write has resolved, either way. */
export function isSettled(state: SaveState): boolean {
  return state.phase === "saved" || state.phase === "error";
}

/**
 * Step 4 resolves only when BOTH the assembling beat (skipped under reduced
 * motion) AND the real server write have finished — the animation covers the
 * in-flight await, and holds if the write is still pending when it ends.
 */
export function shouldReveal(
  reduced: boolean,
  timerDone: boolean,
  state: SaveState
): boolean {
  return (reduced || timerDone) && isSettled(state);
}
