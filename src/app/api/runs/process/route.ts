/**
 * POST /api/runs/process — the run-queue PROCESSOR (the app's first route
 * handler; ARCHITECTURE RULING A1/A2/A3).
 *
 * A2 hardening (all here):
 *  - `runtime = "nodejs"` — the Node pin (the socket-pinning egress closure and
 *    the crawl path require Node; NO edge runtime anywhere on this path).
 *  - POST-only — a GET/PUT gets Next's automatic 405 (no other export).
 *  - Timing-safe shared-secret auth; the secret rides one header and is never
 *    logged; env-UNSET fails closed with a NON-500 refusal (503).
 *  - No request-derived run selection: nothing in the body/query influences
 *    which run runs — the lease alone decides.
 *
 * A3: `maxDuration` and the crawl budget derive from the ONE config constant.
 * A9: after processing a run, kick again so the queue drains under `npm run dev`
 * with no cron. The response body is REDACTED (outcome + kind + closed
 * error_code only — never tenant/client/property ids or URLs).
 */

import { authorizeProcessorRequest } from "@/lib/runs/auth";
import { kickProcessor } from "@/lib/runs/kick";
import { liveProcessorDeps } from "@/lib/runs/live";
import { runProcessorOnce } from "@/lib/runs/process-once";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A3: Next requires this to be a STATIC literal (it cannot resolve an imported
// const), so it is hard-coded here and PINNED equal to SCAN_MAX_DURATION_SECONDS
// by src/lib/runs/route-config.test.ts — the ONE config constant remains the
// source of truth for the crawl budget, and the invariant is test-enforced.
export const maxDuration = 60;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeProcessorRequest(request.headers);
  if (!auth.ok) return json({ error: auth.reason }, auth.status);

  const deps = liveProcessorDeps();
  if (!deps) return json({ error: "unconfigured" }, 503); // fail closed, non-500

  const result = await runProcessorOnce(deps);

  // Drain: a processed run triggers the next pickup (chained, self-terminating
  // when the queue empties — an idle pass fires no kick).
  if (result.outcome === "processed") kickProcessor("process");

  return json(result, 200);
}
