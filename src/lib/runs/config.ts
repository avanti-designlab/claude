/**
 * Run-queue execution config — the SINGLE source of truth for the timing knobs
 * the processor route, the crawler budget, and the sweeper all derive from
 * (ARCHITECTURE RULING 2026-07-10, amendments A3 + A6). Pure constants + pure
 * helpers, no env, no server imports — unit-tested in the default `npm test`
 * run (config.test.ts), and safe to import from the route, the enqueue action,
 * and the sweeper alike.
 *
 * A3 INVARIANT (pinned by config.test.ts): the crawl budget the processor hands
 * the engine and the route's `maxDuration` derive from ONE place, with
 *   crawl budget <= (maxDuration - overhead)
 * so truncation is the crawler's HONEST `budget_exhausted` (recorded per-page),
 * never a routine platform kill mid-write. The overhead window is reserved for
 * the lease RPC, the per-run JWT mint, the property/client reads, the artifact
 * persist, and the run-completion write that bracket the crawl.
 */

/**
 * Route `maxDuration` (seconds). Vercel plan ceilings (A3 plan disclosure —
 * documented in docs/ops/environments.md): Hobby caps a Node function at 60s,
 * Pro at 300s. 60 is the Hobby-safe default; raising it for Pro is an
 * env/plan-documented change, not a code fork. Under `npm run dev` there is no
 * platform ceiling — the crawl budget below still applies, so local truncation
 * is honest and identical to hosted.
 */
export const SCAN_MAX_DURATION_SECONDS = 60;

/**
 * Seconds reserved OUTSIDE the crawl for lease + JWT mint + property/client
 * reads + artifact persist + run-completion write. The crawl budget is the rest
 * of the window, so a full-budget crawl still leaves room to finish honestly
 * before any platform ceiling.
 */
export const SCAN_OVERHEAD_SECONDS = 10;

/**
 * The crawl wall-clock budget (ms) the processor passes as the crawler's
 * `wallClockBudgetMs`. Derived — never hand-set — so the A3 invariant holds by
 * construction: budget == (maxDuration - overhead). A run that spends the whole
 * budget truncates via the crawler's honest `budget_exhausted`, and the
 * remaining overhead lets the processor record the (partial) result.
 */
export const SCAN_CRAWL_BUDGET_MS =
  (SCAN_MAX_DURATION_SECONDS - SCAN_OVERHEAD_SECONDS) * 1000;

/* ------------------------------------------------------------------ */
/* A6 provisional thresholds (⚑ ratify at wiring review)               */
/* ------------------------------------------------------------------ */

/**
 * Heartbeat cadence (ms). The processor stamps `heartbeat_at` at most this
 * often as the crawler advances page-to-page (A6: ≤~15s). 12s < 15s leaves
 * margin against the per-request timeout so a healthy run always beats before
 * the orphan threshold could fire.
 */
export const HEARTBEAT_INTERVAL_MS = 12_000;

/**
 * Orphan threshold (ms). A running run whose last heartbeat is older than this
 * is presumed abandoned (its processor died) and reaped to failed/'orphaned'
 * (A6: maxDuration + 60s). It is strictly greater than maxDuration, so a run
 * that is merely still executing within its own window is never reaped — only
 * one whose owner cannot possibly still be alive.
 */
export const ORPHAN_STALE_MS = (SCAN_MAX_DURATION_SECONDS + 60) * 1000;

/** Attempt cap (A6). A failed run re-queues while `attempts < cap`; matches
 *  transitions.ts shouldRetry() and migration 0012 requeue_failed_runs. */
export const RETRY_ATTEMPT_CAP = 3;

/** Backoff base (ms). Eligible-for-requeue window grows base*(attempts+1). */
export const RETRY_BASE_BACKOFF_MS = 30_000;

/** Backoff ceiling (ms) — the capped-backoff cap. */
export const RETRY_MAX_BACKOFF_MS = 5 * 60_000;

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Is a running run's heartbeat stale (older than the orphan threshold) as of
 * `nowMs`? A null/absent heartbeat is stale by definition (a leased run is
 * always stamped, so a missing stamp means something went wrong). This is the
 * TS mirror of migration 0012 reap_orphaned_runs' predicate (`heartbeat_at <
 * p_stale_before`, with p_stale_before = now - ORPHAN_STALE_MS): STRICTLY
 * past the cutoff is stale; a beat exactly AT the cutoff is SPARED — the SQL's
 * semantics win (QA F4), so the two predicates can never disagree, even for
 * one instant.
 *
 * NO PRODUCTION CONSUMER TODAY (kept deliberately): production reaping runs in
 * SQL (reap_orphaned_runs); this mirror exists so the threshold math is
 * unit-pinned and ready for the A5 "heartbeat freshness" UI rendering
 * ("no recent progress") when the run-trigger UI lands.
 */
export function isHeartbeatStale(
  heartbeatAtMs: number | null,
  nowMs: number,
  staleMs: number = ORPHAN_STALE_MS
): boolean {
  if (heartbeatAtMs === null) return true;
  return nowMs - heartbeatAtMs > staleMs;
}

/**
 * Capped backoff window (ms) a failed run must sit before re-queue, given how
 * many attempts it has already had. Grows linearly with attempts, capped —
 * mirrors migration 0012 requeue_failed_runs' `least(base*(attempts+1), max)`.
 */
export function retryBackoffMs(
  attempts: number,
  baseMs: number = RETRY_BASE_BACKOFF_MS,
  maxMs: number = RETRY_MAX_BACKOFF_MS
): number {
  return Math.min(baseMs * (attempts + 1), maxMs);
}

/** The timestamp a running run must have last beaten AFTER to be considered
 *  alive (the sweeper's `p_stale_before` cutoff), as an ISO string for the RPC. */
export function orphanCutoffIso(nowMs: number, staleMs: number = ORPHAN_STALE_MS): string {
  return new Date(nowMs - staleMs).toISOString();
}
