/**
 * Pure display logic for the dashboard's "Generate plan" control (no React,
 * no server imports — unit-tested in the default `npm test` run, mirroring
 * the onboarding flow's save-outcome module).
 *
 * The control invokes `regeneratePlanForClient` (src/lib/plans/actions.ts —
 * FROZEN CONTRACT) for a plan-less client in a LIVE vertical. This module
 * pins which cards get the control and how each result variant lands.
 */

import type { RegeneratePlanResult } from "@/lib/plans/actions";
import { ACTIVE_VERTICALS } from "@/lib/playbooks";
import type { JwtRole } from "@/lib/types/db";

/**
 * Gate 1a mirror for the client cards — the same source onboarding's
 * step-industry reads (ACTIVE_VERTICALS, doc 02 "Validation-first rollout"):
 * only verticals switched into active client use get the "Generate plan"
 * control. A dormant vertical's card keeps the quiet "None yet" row — its
 * plan activates when the playbook ships, and a button can't hurry that.
 */
export function isLiveVertical(vertical: string): boolean {
  return (ACTIVE_VERTICALS as readonly string[]).includes(vertical);
}

/** What a client card's Plan row renders. */
export type PlanRowVariant =
  /** The "Generate plan" control (the recovery UI). */
  | "generate"
  /** The plan's playbook-version row. */
  | "version"
  /** The quiet "None yet" row. */
  | "none";

/**
 * Which Plan row a client card gets (one decision, unit-tested):
 *
 *  - A HEALTHY plan (row exists AND it produced tasks) shows its version.
 *  - Otherwise the client needs a (re)generation — plan-less, or the
 *    documented tolerated partial-failure state: a zero-task residue plan
 *    (design review, 2026-07-09, Major 3). The control renders only when the
 *    caller can actually use it: `regeneratePlanForClient` is agency_admin-
 *    only, so any other role would collect a permission error on every press
 *    (Code Review minor 4) — they keep the quiet row instead. The vertical
 *    must also be LIVE (a button can't hurry a dormant playbook). The
 *    action's supersede path is idempotent and handles residue plans.
 *  - Everyone else: the version row if a (residue) plan exists, else "None
 *    yet". `role` is null when no verified claim is readable — fail closed,
 *    no control.
 */
export function planRowVariant(args: {
  role: JwtRole | null;
  vertical: string;
  hasPlan: boolean;
  taskCount: number;
}): PlanRowVariant {
  if (args.hasPlan && args.taskCount > 0) return "version";
  if (args.role === "agency_admin" && isLiveVertical(args.vertical)) {
    return "generate";
  }
  return args.hasPlan ? "version" : "none";
}

/** Interface-voice fallback when the action call itself fails to round-trip. */
export const GENERATE_UNREACHABLE =
  "We couldn’t reach the server. Check your connection and try again.";

/** What the control does with a settled action result. */
export type GeneratePlanOutcome =
  | { kind: "refresh" }
  | { kind: "error"; message: string };

/**
 * Map the server action's result into UI intent:
 *  - ok, alreadyExisted false → refresh: the fresh plan's numbers speak.
 *  - ok, alreadyExisted true  → refresh too: the plan appears exactly the
 *    same way — an already-done job is a success, not error theater.
 *  - not ok → the backend's error STRING verbatim (interface voice, doc 06
 *    §6 — the string is the display truth). `reason` is only the coarse
 *    bucket and never drives copy: wrong-role callers arrive as
 *    "write_failed" carrying a permission-specific message, and every
 *    failure leaves the control armed for a retry (the action is idempotent,
 *    so retrying can never duplicate a plan).
 */
export function toGeneratePlanOutcome(
  result: RegeneratePlanResult
): GeneratePlanOutcome {
  if (!result.ok) {
    return { kind: "error", message: result.error };
  }
  return { kind: "refresh" };
}
