import "server-only";

/**
 * Non-blocking processor kick (ARCHITECTURE RULING A9). After an enqueue (or a
 * sweep that re-queued work, or a run that just finished), fire a POST at the
 * internal processor/sweeper endpoint so a queued run is picked up promptly
 * under `npm run dev` with no cron.
 *
 * HARD RULES (all from the ruling):
 *  - FIRE-AND-FORGET: never awaited by the caller, so the enqueue returns
 *    instantly regardless of the kick.
 *  - KICK FAILURE MUST NOT SURFACE: any error is swallowed here; the sweeper is
 *    the backstop, so a dropped kick only delays pickup, never loses a run.
 *  - SECRET NEVER LOGGED: it rides one Authorization header and nothing echoes
 *    it. `redirect: "error"` so the bearer secret is never re-sent to a
 *    redirect target.
 *  - UNCONFIGURED → SKIP: with no shared secret the endpoint would refuse (503)
 *    anyway, so we skip silently and let the sweeper/cron cover pickup.
 */

import { getRunsProcessorBaseUrl, getRunsProcessorSecret } from "@/lib/env.server";

export function kickProcessor(target: "process" | "sweep" = "process"): void {
  const secret = getRunsProcessorSecret();
  if (!secret) return; // unconfigured — sweeper/cron backstop covers pickup
  const url = `${getRunsProcessorBaseUrl()}/api/runs/${target}`;
  // Intentionally NOT awaited: the caller must not block on (or fail from) this.
  void fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: "{}",
    redirect: "error",
  }).catch(() => {
    /* swallow — kick failure must not surface (sweeper is the backstop) */
  });
}
