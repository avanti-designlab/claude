/**
 * M17 Alerting engine — signal input + alert type contracts (doc 05 §M17;
 * doc 07 §1.8). PURE: no DB, no server imports, no wall-clock — unit-tested in
 * the default run.
 *
 * ── THE 7 doc-07 CLASSES → the frozen `alerts.type` CHECK (migration 0006) ───
 * doc 07 §1.8 lists seven alert classes. Every one maps to an ALREADY-ALLOWED
 * value in the frozen `alerts_type_allowed` CHECK — no gap, nothing invented:
 *
 *   doc-07 class            → alerts.type              owner / M17 role
 *   ----------------------------------------------------------------------------
 *   visibility dropped      → visibility_drop          M17 WRITES (rule)
 *   competitor overtook     → competitor_overtook      M17 WRITES (rule)
 *   schema broke            → schema_broke             M17 WRITES (rule)
 *   crawler blocked         → crawler_blocked          M5 WRITES — M17 only READS
 *   review spike            → negative_review_spike    M17 WRITES (rule)
 *   site down               → site_down                M17 WRITES (rule)
 *   auto-rollback fired     → auto_rollback_fired      change-mgmt FIRES — M17
 *                                                      persists via its AlertSink
 *
 * NOTE the naming seam: doc 07 says "review spike"; the frozen CHECK value is
 * `negative_review_spike`. M17 maps to the frozen value (the CHECK is law).
 *
 * ── OWNERSHIP (no double-writes) ─────────────────────────────────────────────
 * M17 ORIGINATES exactly the five WRITER types below. `crawler_blocked` is
 * owned by M5 (src/lib/intelligence/monitoring/persist.ts writes it with its own
 * dedup); `auto_rollback_fired` is FIRED by the change-management manager
 * (src/lib/change-management/manager.ts) through an injected AlertSink. M17
 * UNIFIES those two into the same `alerts` table + read feed WITHOUT re-deriving
 * or re-writing them: it never runs a crawler-block rule, and it never detects
 * an auto-rollback — it only supplies the sink that persists the event
 * change-management already fired (see ./sink). This is enforced structurally in
 * ./persist (the writer entrypoint refuses any non-writer type).
 */

export type AlertSeverity = "info" | "warning" | "critical";

/** The frozen `alerts.type` values M17 ORIGINATES from measured signals. */
export type M17WriterAlertType =
  | "visibility_drop"
  | "competitor_overtook"
  | "schema_broke"
  | "negative_review_spike"
  | "site_down";

/** The full frozen `alerts.type` set — what the unified read feed can surface. */
export type AlertType = M17WriterAlertType | "crawler_blocked" | "auto_rollback_fired";

/**
 * Scope every alert row is pinned to. `tenantId` is ALWAYS claim-sourced by the
 * action (never a browser value); `clientId` comes from an RLS-scoped read.
 * RLS (`alerts_insert`, migration 0006) + the composite FK (tenant, client) →
 * clients re-pin both below us regardless.
 */
export interface AlertScope {
  tenantId: string;
  clientId: string;
}

/* ------------------------------------------------------------------ */
/* Signal inputs — one measured shape per writer rule.                 */
/*                                                                     */
/* Honesty: a rule consumes a MEASURED signal and returns 0 or 1 rows. */
/* A MISSING signal is simply not passed (the field is omitted from    */
/* the bundle) — it is `unknown`, never a fabricated alert. Threshold- */
/* on-missing-data is impossible: there is no signal object to test.   */
/* ------------------------------------------------------------------ */

/**
 * M3 visibility score fell run-over-run. Both scores are REAL measured run
 * scores (0–100, one decimal) from stored `visibility_results` history — a
 * client with <2 scored runs yields NO signal (no baseline to drop from).
 */
export interface VisibilityDropSignal {
  /** Prior run's Visibility Score (measured; never null here). */
  previousScore: number;
  /** Latest run's Visibility Score (measured; never null here). */
  latestScore: number;
  /** Run keys (stored captured_at) for the two compared runs. */
  previousRunAt: string;
  latestRunAt: string;
}

/**
 * A named competitor's measured share of voice CROSSED above the client's.
 * Shares are 0..1 (citations / measured), from M3 share-of-voice over two runs.
 * "Overtook" is a crossing event: behind-or-level last run, ahead this run.
 */
export interface CompetitorOvertookSignal {
  competitorName: string;
  /** Latest run. */
  clientShare: number;
  competitorShare: number;
  /** Prior run — the crossing is measured against a real earlier state. */
  previousClientShare: number;
  previousCompetitorShare: number;
  latestRunAt: string;
}

/**
 * A page's published JSON-LD failed verification (missing / invalid / no longer
 * matches). Produced by a schema-verification pass (M10/M14) — NOT yet built;
 * this shape is the contract that pass must emit. M17 fabricates none of it.
 */
export interface SchemaBrokeSignal {
  propertyId: string;
  pageUrl: string;
  /** The schema.org type that broke (e.g. "FAQPage", "LocalBusiness"). */
  schemaType: string;
  /** Non-sensitive one-liner: what verification found. */
  detail: string;
  detectedAt: string;
}

/**
 * A NEGATIVE-review spike measured against a real baseline (M15 review feeds) —
 * M15 is not built yet; this is the contract its velocity check must emit.
 */
export interface ReviewSpikeSignal {
  /** Review platform (e.g. "google", "yelp"). */
  platform: string;
  /** Negative reviews measured in the window. */
  negativeCount: number;
  windowDays: number;
  /** Measured baseline: typical negatives per window (the spike is vs THIS). */
  baselineNegativePerWindow: number;
  detectedAt: string;
}

/**
 * A property's site is unreachable or erroring at the origin. Produced by an
 * uptime/probe pass — NOT yet built; this is the contract it must emit.
 * `httpStatus` null means the probe could not connect (measured, not guessed).
 */
export interface SiteDownSignal {
  propertyId: string;
  baseUrl: string;
  /** Measured HTTP status, or null when the origin was unreachable. */
  httpStatus: number | null;
  detectedAt: string;
}

/**
 * The bundle an evaluation pass assembles from the signal sources it CAN read.
 * Every field is optional: a source that produced no measured signal contributes
 * nothing, and the evaluator emits nothing for it (honesty — absent ≠ alert).
 * `crawler_blocked` and `auto_rollback_fired` are DELIBERATELY absent — their
 * owners write them; the evaluator never re-derives them.
 */
export interface SignalBundle {
  visibilityDrop?: VisibilityDropSignal;
  competitorOvertook?: CompetitorOvertookSignal[];
  schemaBroke?: SchemaBrokeSignal[];
  reviewSpike?: ReviewSpikeSignal[];
  siteDown?: SiteDownSignal[];
}
