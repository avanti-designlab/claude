/**
 * runs status-transition legality — the pure contract for the scan work-order
 * queue (migration 0011; ARCHITECTURE RULING 2026-07-10 A4). No server/DB
 * imports; unit-tested in the default `npm test` run.
 *
 * THIS IS A CONTRACT, NOT THE QUEUE. The processor / SECURITY DEFINER
 * lease_next_run() / sweeper are the separately-gated queue-infra block (ruling
 * A8) and consume these rules; the migration stores the states honestly. Pinning
 * every legal + illegal transition here (and in transitions.test.ts) satisfies
 * the A4 condition "legal transitions pinned + tested" without building the
 * queue infra.
 *
 * Legal graph (ruling A4):
 *   queued  → running    (processor leases it)
 *   queued  → canceled   (operator cancels a not-yet-started run; CAS on queued)
 *   running → succeeded   (processor finished)
 *   running → failed      (processor error, OR the SWEEPER marks a stale run failed)
 *   retry: a failed run RE-QUEUES the SAME row (failed → queued), attempts+1, to
 *          a cap; an operator "re-run" is a NEW row, never a terminal reopen.
 *   succeeded | canceled are TERMINAL and immutable; failed is terminal EXCEPT
 *          for the bounded retry re-queue.
 *
 * `via` distinguishes who may drive a transition — critically, running → failed
 * "by sweep only" for the STALE case (a live processor fails its own run
 * directly; the sweeper reaps abandoned ones). Both are the same target state;
 * `via` is what the tests pin.
 */

import { RUN_STATUSES, TERMINAL_RUN_STATUSES, type RunStatus } from "@/lib/types/db";

/** Who is driving a transition. */
export type RunTransitionVia =
  | "processor" // the leasing Node processor executing the run
  | "sweep" // the scheduled sweeper (reaps stale/abandoned runs)
  | "retry" // a re-queue of a failed run (same row, attempts+1)
  | "cancel"; // an operator cancel (only a not-yet-started run)

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * Is `from → to`, driven by `via`, a legal run transition? The single predicate
 * the future queue actions enforce and the tests pin. Terminal states are
 * immutable except the bounded failed → queued retry.
 */
export function isLegalRunTransition(
  from: RunStatus,
  to: RunStatus,
  via: RunTransitionVia
): boolean {
  switch (via) {
    case "processor":
      // The processor leases a queued run, then completes it.
      return (
        (from === "queued" && to === "running") ||
        (from === "running" && (to === "succeeded" || to === "failed"))
      );
    case "sweep":
      // The sweeper only reaps a stale RUNNING run into failed (orphaned) — it
      // never leases or completes work.
      return from === "running" && to === "failed";
    case "retry":
      // A failed run re-queues the SAME row (the caller enforces the attempt
      // cap; this predicate governs only the state edge).
      return from === "failed" && to === "queued";
    case "cancel":
      // Only a not-yet-started run can be canceled (CAS on queued) until a real
      // mid-run cancel exists (ruling A5).
      return from === "queued" && to === "canceled";
  }
}

/**
 * Should a failed run be retried? Pure policy over (status, attempts, cap): a
 * failed run re-queues while it is under the cap. `cap` is the provisional
 * attempt cap (ruling A6 ⚑, ratified at wiring) — passed in, never baked into a
 * frozen CHECK.
 */
export function shouldRetry(
  status: RunStatus,
  attempts: number,
  cap: number
): boolean {
  return status === "failed" && attempts < cap;
}

/** All statuses (re-exported for test enumeration convenience). */
export const ALL_RUN_STATUSES = RUN_STATUSES;
