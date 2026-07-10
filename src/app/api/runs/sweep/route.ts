/**
 * POST /api/runs/sweep — the run-queue SWEEPER (ARCHITECTURE RULING A5/A6/A9).
 *
 * Same A2 hardening as the processor (nodejs runtime, POST-only, timing-safe
 * shared-secret auth, env-unset → 503 non-500). Reaps stale-heartbeat orphans
 * (running → failed/'orphaned') and re-queues failed runs under the attempt cap
 * past their backoff (failed → queued), all through the reviewed SECURITY
 * DEFINER functions — then kicks the processor UNCONDITIONALLY (QA F1): the
 * sweep functions themselves never touch a QUEUED row (reap = running-only,
 * requeue = failed-only), so a stale queued run whose enqueue kick was dropped
 * is recovered ONLY by a processor invocation. The unconditional kick makes
 * every sweep that invocation. An idle kick is cheap and the chain
 * self-terminates on an empty queue.
 *
 * DEV/MANUAL TRIGGER (ruling A9 — documented in docs/ops/environments.md):
 *   curl -X POST http://127.0.0.1:3000/api/runs/sweep \
 *        -H "authorization: Bearer $RUNS_PROCESSOR_SECRET"
 * Response is redacted: { reaped, requeued } counts only.
 */

import { authorizeProcessorRequest } from "@/lib/runs/auth";
import { kickProcessor } from "@/lib/runs/kick";
import { liveSweepDeps } from "@/lib/runs/live";
import { sweepRuns } from "@/lib/runs/sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeProcessorRequest(request.headers);
  if (!auth.ok) return json({ error: auth.reason }, auth.status);

  const deps = liveSweepDeps();
  if (!deps) return json({ error: "unconfigured" }, 503); // fail closed, non-500

  const summary = await sweepRuns(deps);
  // UNCONDITIONAL (QA F1): a stale QUEUED row yields {reaped:0, requeued:0} —
  // a conditional kick would strand it forever. See header.
  kickProcessor("process");

  return json(summary, 200);
}
