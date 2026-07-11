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
/* brand_extract shallow-fetch bounds (⚑ ratify at wiring review)      */
/*                                                                     */
/* The brand_extract adapter is a DISTINCT shallow-fetch routine (not  */
/* crawlSite): homepage → linked stylesheets → optional /about, each   */
/* routed INDIVIDUALLY through the socket-pinned egress-guarded seam.   */
/* Its budget is sized to INTERACTIVE expectation — deliberately much   */
/* tighter than the 50s audit crawl budget (a ~12-fetch pull must not   */
/* run long). The route's maxDuration (SCAN_MAX_DURATION_SECONDS) is    */
/* shared with the audit path; the invariants that keep this budget     */
/* inside that window are pinned in config.test.ts.                     */
/* ------------------------------------------------------------------ */

/** Max linked stylesheets fetched from the homepage (cross-origin allowed, each
 *  egress-guarded). Bounds WORK; the aggregate budget below bounds TIME. */
export const BRAND_EXTRACT_MAX_STYLESHEETS = 10;

/** Per-fetch byte cap (homepage, each stylesheet, /about). 2 MiB — mirrors the
 *  audit crawler's per-page-cap discipline (Content-Length precheck + post-read
 *  length check); an over-cap body is refused, never truncated. */
export const BRAND_EXTRACT_MAX_FETCH_BYTES = 2 * 1024 * 1024;

/**
 * AGGREGATE wall-clock budget (ms) bounding the WHOLE shallow pull (homepage +
 * all stylesheets + /about), checked BETWEEN fetches. Interactive, and far below
 * the audit crawl budget. config.test.ts pins the two safety invariants:
 *   - it is < SCAN_CRAWL_BUDGET_MS (tighter than the audit path), and
 *   - budget + REQUEST_TIMEOUT_MS <= SCAN_CRAWL_BUDGET_MS, so even one final
 *     in-flight fetch admitted just before the deadline still finishes inside
 *     the route's honest crawl window (never a mid-write platform kill).
 */
export const BRAND_EXTRACT_AGGREGATE_BUDGET_MS = 30_000;

/** Enqueue-time SHAPE cap on the pasted URL — mirrors the runs.input_url CHECK
 *  bound (migration 0015 runs_input_url_len). */
export const BRAND_EXTRACT_INPUT_URL_MAX_CHARS = 2048;

/** Per candidate URL length cap in the persisted draft (mirrors LOGO_URL_MAX_CHARS
 *  in the brand-kit validate seam — kept in sync, not imported, to keep config
 *  free of skill imports). */
export const BRAND_EXTRACT_CANDIDATE_URL_MAX_CHARS = 2048;

/** Count caps on the persisted draft's candidate URL lists. */
export const BRAND_EXTRACT_MAX_LOGO_CANDIDATES = 8;
export const BRAND_EXTRACT_MAX_IMAGERY_CANDIDATES = 8;

/** Serialized `draft` jsonb cap — mirrors the brand_extract_drafts_draft_bounded
 *  CHECK (migration 0015). The count + URL caps keep a real draft well under it. */
export const BRAND_EXTRACT_DRAFT_MAX_CHARS = 65_536;

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
