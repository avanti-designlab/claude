/**
 * Single-pass processor driver — lease one run, execute it, report a redacted
 * outcome (ARCHITECTURE RULING A1/A3). ONE run per invocation by design: the
 * crawl budget equals (maxDuration - overhead), so a second run in the same
 * request could exceed the platform ceiling. Draining the queue is the caller's
 * job via chained kicks (each processed run kicks the next pickup) + the sweeper.
 *
 * Pure over injected ports — unit-tested with fakes. `lease` is the ONE
 * service-role-class call (the SECURITY DEFINER lease_next_run RPC), injected
 * here as an opaque port so this module has no service-role material itself.
 */

import type { RunErrorCode, RunKind, RunRow } from "@/lib/types/db";
import { executeLeasedRun, type ExecuteDeps } from "./execute";

export interface ProcessorDeps extends ExecuteDeps {
  /** Claim the oldest queued run (lease_next_run RPC via the service client), or
   *  null when the queue is empty. The sole service-role-class op (A1). */
  lease(): Promise<RunRow | null>;
}

export type ProcessResult =
  | { outcome: "idle" }
  | { outcome: "processed"; status: "succeeded"; kind: RunKind }
  | { outcome: "processed"; status: "failed"; kind: RunKind; errorCode: RunErrorCode };

/**
 * Lease and process a single run. `idle` when nothing is queued. A `processed`
 * result (either terminal status) signals the caller to fire a follow-up kick so
 * the queue keeps draining under `npm run dev` with no cron (A9).
 */
export async function runProcessorOnce(deps: ProcessorDeps): Promise<ProcessResult> {
  const run = await deps.lease();
  if (!run) return { outcome: "idle" };
  const result = await executeLeasedRun(run, deps);
  if (result.status === "succeeded") {
    return { outcome: "processed", status: "succeeded", kind: run.kind };
  }
  return { outcome: "processed", status: "failed", kind: run.kind, errorCode: result.errorCode };
}
