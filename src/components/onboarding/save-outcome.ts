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

/**
 * Interface-voice fallback when the action call itself fails to round-trip
 * (network drop, lost response). HONEST about what we know (Code Review,
 * 2026-07-09): a lost RESPONSE does not mean a lost WRITE — the save may have
 * landed. The flow retries with the SAME idempotency key, so a retry recovers
 * an already-saved client (and, after edits, reconciles the row to the edited
 * values) instead of creating a duplicate. The copy promises exactly that —
 * never "nothing was created", which we cannot know.
 */
export const SAVE_UNREACHABLE =
  "We couldn’t confirm the save — check your connection and try again. If it already went through, retrying won’t create a duplicate.";

/**
 * The step-4 error panel's heading. The server action's failure strings open
 * with this exact sentence, so the panel trims it from the body instead of
 * saying it twice (see `saveErrorBody`).
 */
export const SAVE_ERROR_HEADING = "We couldn’t save this client";

/**
 * Body copy for the step-4 error panel: server strings that open with the
 * heading sentence get it trimmed; everything else — including
 * SAVE_UNREACHABLE, which deliberately opens with "We couldn’t confirm…" and
 * must never be truncated — renders verbatim.
 */
export function saveErrorBody(message: string): string {
  const prefix = `${SAVE_ERROR_HEADING}.`;
  return message.startsWith(prefix)
    ? message.slice(prefix.length).trim()
    : message;
}

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
