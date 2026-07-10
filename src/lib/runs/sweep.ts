/**
 * The sweeper — the honesty + recovery backstop (ARCHITECTURE RULING A5/A6/A9).
 *
 * Two cross-tenant queue-maintenance ops, both through the reviewed SECURITY
 * DEFINER functions (migration 0012), injected here as opaque ports so this
 * module holds no service-role material:
 *  1. REAP orphans: a crashed/killed processor leaves a run stuck `running` with
 *     a frozen heartbeat. reap_orphaned_runs marks any running row whose last
 *     heartbeat is older than (maxDuration + 60s) failed/'orphaned' — so a run's
 *     visible state is ALWAYS real, never stuck-running.
 *  2. REQUEUE failed: requeue_failed_runs re-queues failed runs (failed→queued,
 *     attempts+1) that are under the attempt cap and past their capped-backoff
 *     window — the recovery path that turns a transient failure (or a reaped
 *     orphan, once its backoff elapses) back into runnable work.
 *
 * Order matters: reap first (so a just-crashed run becomes failed), then requeue
 * (a freshly-reaped orphan won't requeue THIS pass — its backoff hasn't elapsed
 * — but a previously-failed run past backoff will).
 *
 * DROPPED-KICK RECOVERY IS NOT HERE (QA F1 correction): NEITHER sweep op
 * touches a QUEUED row — reap matches running-only, requeue failed-only — so a
 * stale queued run (its enqueue kick was dropped) sails through this function
 * untouched. What recovers it is the sweep ROUTE's UNCONDITIONAL processor kick
 * (src/app/api/runs/sweep/route.ts): every sweep triggers a lease pass, which
 * is the only thing that picks up queued work. This function's job is orphan
 * honesty + capped retry; the route's kick is the pickup backstop.
 */

import { orphanCutoffIso, RETRY_ATTEMPT_CAP, RETRY_BASE_BACKOFF_MS, RETRY_MAX_BACKOFF_MS } from "./config";

/** Redacted marker for sweeper telemetry (counts only — never run ids). */
export const RUN_SWEEP_MARKER = "[run-sweeper]";

export interface SweepDeps {
  /** reap_orphaned_runs(p_stale_before) → reaped run ids. */
  reapOrphaned(staleBeforeIso: string): Promise<string[]>;
  /** requeue_failed_runs(cap, baseMs, maxMs) → re-queued run ids. */
  requeueFailed(cap: number, baseMs: number, maxMs: number): Promise<string[]>;
  now(): number;
  log(event: { stage: "reaped" | "requeued"; count: number }): void;
}

export interface SweepSummary {
  reaped: number;
  requeued: number;
}

export async function sweepRuns(deps: SweepDeps): Promise<SweepSummary> {
  const staleBefore = orphanCutoffIso(deps.now());
  const reaped = await deps.reapOrphaned(staleBefore);
  deps.log({ stage: "reaped", count: reaped.length });

  const requeued = await deps.requeueFailed(
    RETRY_ATTEMPT_CAP,
    RETRY_BASE_BACKOFF_MS,
    RETRY_MAX_BACKOFF_MS
  );
  deps.log({ stage: "requeued", count: requeued.length });

  return { reaped: reaped.length, requeued: requeued.length };
}
