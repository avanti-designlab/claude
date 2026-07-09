/**
 * M17 Alerting engine — public PURE surface (doc 05 §M17; doc 07 §1.8).
 *
 * Unifies every signal source into the frozen `alerts` table (migration 0006):
 * M17's own five WRITER rules (visibility_drop, competitor_overtook,
 * schema_broke, negative_review_spike, site_down), plus M5's `crawler_blocked`
 * and change-management's `auto_rollback_fired` — which M17 UNIFIES into the same
 * table + read feed WITHOUT re-writing them (M5 owns its writes; the auto-
 * rollback event reaches `alerts` only through the M17 sink, which persists what
 * change-management already fired). No double-writes; see types.ts §OWNERSHIP.
 *
 * Server-side layers are NOT re-exported here (this barrel stays importable
 * anywhere, e.g. for types in UI code) — import them by path:
 *   ./actions  — "use server" run + feed actions (runVisibilityAlertCheck, getActiveAlerts)
 *   ./persist  — server-only writer-alert persistence (dedup, fail-closed)
 *   ./sink     — server-only AlertSink for the change-management ChangeManager
 *   ./reads    — server-only unified active-alerts feed read
 */

export type {
  AlertScope,
  AlertSeverity,
  AlertType,
  CompetitorOvertookSignal,
  M17WriterAlertType,
  ReviewSpikeSignal,
  SchemaBrokeSignal,
  SignalBundle,
  SiteDownSignal,
  VisibilityDropSignal,
} from "./types";

export {
  isSiteDown,
  isCompetitorOvertook,
  isReviewSpike,
  isVisibilityDrop,
  competitorOvertookSeverity,
  reviewSpikeRatio,
  reviewSpikeSeverity,
  visibilityDropPoints,
  visibilityDropSeverity,
  COMPETITOR_OVERTOOK_MARGIN,
  COMPETITOR_OVERTOOK_CRITICAL_MARGIN,
  REVIEW_SPIKE_CRITICAL_RATIO,
  REVIEW_SPIKE_MIN_NEGATIVE,
  REVIEW_SPIKE_RATIO,
  SCHEMA_BROKE_SEVERITY,
  SITE_DOWN_SEVERITY,
  VISIBILITY_DROP_CRITICAL_POINTS,
  VISIBILITY_DROP_FIRE_POINTS,
  VISIBILITY_DROP_WARNING_POINTS,
} from "./thresholds";

export {
  competitorOvertookRule,
  competitorOvertookSignals,
  reviewSpikeRule,
  schemaBrokeRule,
  siteDownRule,
  visibilityDropRule,
  visibilityDropSignalFromSeries,
  type RunScorePoint,
  type ShareSnapshot,
} from "./rules";

export { evaluateSignals } from "./evaluate";

export {
  M17_WRITER_ALERT_TYPES,
  MAX_ALERT_ITEMS,
  activeAlertEntry,
  autoRollbackFingerprint,
  competitorOvertookFingerprint,
  isWriterAlertType,
  reviewSpikeFingerprint,
  schemaBrokeFingerprint,
  siteDownFingerprint,
  visibilityDropFingerprint,
  type ActiveAlertEntry,
  type AlertInsertRow,
  type AlertPayload,
} from "./rows";
