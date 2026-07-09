/**
 * M6 Content decay / freshness engine — public PURE surface (doc 05 M6,
 * doc 07 §1.4).
 *
 * The pipeline: crawl a property (guarded crawl layer, reused not forked) →
 * `assessDecay` scores each page's decay from the crawl's extracted
 * `lastModified` + visible-text signals → a per-page assessment + a prioritized
 * "refresh these first" worklist → `decayRefreshFixes` projects that worklist
 * into the plan generator via the SAME audit-merge shape M2 uses.
 *
 * Server-side layers are NOT re-exported here (this barrel stays importable
 * anywhere, e.g. types in UI code) — import them by path:
 *   ./actions   — "use server" scan action (runPropertyDecayScan)
 *   ./live-fetch — server-only production port wiring
 *   ./telemetry — server-only redacted failure logging
 */

export { assessDecay } from "./assess";
export {
  decayPlanInput,
  decayRefreshFixes,
  generatePlanWithDecay,
} from "./decay-to-plan";
export {
  DECAY_REFRESH_WINDOW_DAYS,
  DECAY_THRESHOLD_FLAGS,
  STALE_THRESHOLD_MULTIPLIER,
  STALE_STAT_MIN_AGE_YEARS,
  THIN_CONTENT_MIN_WORDS,
  type DecayOptions,
  type DecayReport,
  type DecaySignal,
  type DecaySignalKind,
  type DecayStatus,
  type DecaySummary,
  type PageDecayAssessment,
} from "./types";
