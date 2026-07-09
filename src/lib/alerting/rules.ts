/**
 * M17 — the deterministic alert RULES: a measured signal → 0 or 1 `alerts`
 * rows. PURE (no DB, no wall-clock). doc 05 §M17; doc 07 §1.8.
 *
 * There is one rule per WRITER class (visibility_drop, competitor_overtook,
 * schema_broke, negative_review_spike, site_down). There is deliberately NO
 * crawler-block rule and NO auto-rollback rule here: those two classes are owned
 * by M5 and change-management respectively, and M17 must not re-derive them
 * (types.ts §OWNERSHIP). Each rule:
 *   - returns null when the measured signal does not clear its fire threshold
 *     (honesty: no signal-below-threshold alert, and — because the input is a
 *     concrete measured object — never a threshold-on-missing-data alert);
 *   - stamps the row with the STANDING-CONDITION fingerprint (rows.ts) so a
 *     persisting run can dedup a condition that spans runs.
 */

import {
  autoRollbackFingerprint,
  competitorOvertookFingerprint,
  reviewSpikeFingerprint,
  schemaBrokeFingerprint,
  siteDownFingerprint,
  visibilityDropFingerprint,
  type AlertInsertRow,
  type AutoRollbackPayload,
} from "./rows";
import {
  competitorOvertookSeverity,
  isCompetitorOvertook,
  isReviewSpike,
  isSiteDown,
  isVisibilityDrop,
  reviewSpikeSeverity,
  visibilityDropPoints,
  visibilityDropSeverity,
  SCHEMA_BROKE_SEVERITY,
  SITE_DOWN_SEVERITY,
} from "./thresholds";
import type {
  AlertScope,
  AlertSeverity,
  CompetitorOvertookSignal,
  ReviewSpikeSignal,
  SchemaBrokeSignal,
  SiteDownSignal,
  VisibilityDropSignal,
} from "./types";

/** Round a 0..1 share to a whole-percent for human copy. */
function pct(share: number): number {
  return Math.round(share * 100);
}

/* ------------------------------------------------------------------ */
/* Writer rules                                                        */
/* ------------------------------------------------------------------ */

export function visibilityDropRule(
  scope: AlertScope,
  signal: VisibilityDropSignal,
): AlertInsertRow | null {
  if (!isVisibilityDrop(signal)) return null;
  const pointsDropped = visibilityDropPoints(signal);
  return {
    tenant_id: scope.tenantId,
    client_id: scope.clientId,
    type: "visibility_drop",
    severity: visibilityDropSeverity(signal),
    payload: {
      kind: "visibility_drop",
      fingerprint: visibilityDropFingerprint(scope.clientId),
      summary: `Visibility Score fell ${pointsDropped.toFixed(1)} pts (${signal.previousScore.toFixed(1)} → ${signal.latestScore.toFixed(1)})`,
      detectedAt: signal.latestRunAt,
      previousScore: signal.previousScore,
      latestScore: signal.latestScore,
      pointsDropped,
      previousRunAt: signal.previousRunAt,
      latestRunAt: signal.latestRunAt,
    },
  };
}

export function competitorOvertookRule(
  scope: AlertScope,
  signal: CompetitorOvertookSignal,
): AlertInsertRow | null {
  if (!isCompetitorOvertook(signal)) return null;
  return {
    tenant_id: scope.tenantId,
    client_id: scope.clientId,
    type: "competitor_overtook",
    severity: competitorOvertookSeverity(signal),
    payload: {
      kind: "competitor_overtook",
      fingerprint: competitorOvertookFingerprint(scope.clientId, signal.competitorName),
      summary: `${signal.competitorName} overtook you in AI citations (${pct(signal.competitorShare)}% vs your ${pct(signal.clientShare)}%)`,
      detectedAt: signal.latestRunAt,
      competitorName: signal.competitorName,
      clientShare: signal.clientShare,
      competitorShare: signal.competitorShare,
      latestRunAt: signal.latestRunAt,
    },
  };
}

export function schemaBrokeRule(
  scope: AlertScope,
  signal: SchemaBrokeSignal,
): AlertInsertRow {
  // A schema-broke signal is emitted ONLY when verification already failed, so
  // there is no sub-threshold state — the signal's existence is the condition.
  return {
    tenant_id: scope.tenantId,
    client_id: scope.clientId,
    type: "schema_broke",
    severity: SCHEMA_BROKE_SEVERITY,
    payload: {
      kind: "schema_broke",
      fingerprint: schemaBrokeFingerprint(signal.propertyId, signal.pageUrl, signal.schemaType),
      summary: `${signal.schemaType} structured data broke on ${signal.pageUrl}`,
      detectedAt: signal.detectedAt,
      propertyId: signal.propertyId,
      pageUrl: signal.pageUrl,
      schemaType: signal.schemaType,
      detail: signal.detail,
    },
  };
}

export function reviewSpikeRule(
  scope: AlertScope,
  signal: ReviewSpikeSignal,
): AlertInsertRow | null {
  if (!isReviewSpike(signal)) return null;
  return {
    tenant_id: scope.tenantId,
    client_id: scope.clientId,
    type: "negative_review_spike",
    severity: reviewSpikeSeverity(signal),
    payload: {
      kind: "negative_review_spike",
      fingerprint: reviewSpikeFingerprint(scope.clientId, signal.platform),
      summary: `${signal.negativeCount} negative ${signal.platform} review(s) in ${signal.windowDays}d (baseline ${signal.baselineNegativePerWindow})`,
      detectedAt: signal.detectedAt,
      platform: signal.platform,
      negativeCount: signal.negativeCount,
      windowDays: signal.windowDays,
      baselineNegativePerWindow: signal.baselineNegativePerWindow,
    },
  };
}

export function siteDownRule(
  scope: AlertScope,
  signal: SiteDownSignal,
): AlertInsertRow | null {
  if (!isSiteDown(signal.httpStatus)) return null;
  const statusText = signal.httpStatus === null ? "unreachable" : `HTTP ${signal.httpStatus}`;
  return {
    tenant_id: scope.tenantId,
    client_id: scope.clientId,
    type: "site_down",
    severity: SITE_DOWN_SEVERITY,
    payload: {
      kind: "site_down",
      fingerprint: siteDownFingerprint(signal.propertyId),
      summary: `Site is down (${statusText}): ${signal.baseUrl}`,
      detectedAt: signal.detectedAt,
      propertyId: signal.propertyId,
      baseUrl: signal.baseUrl,
      httpStatus: signal.httpStatus,
    },
  };
}

/* ------------------------------------------------------------------ */
/* auto_rollback_fired payload builder (used by ./sink ONLY).          */
/*                                                                     */
/* This is NOT a rule — M17 never DETECTS an auto-rollback. The change- */
/* management manager fires the event; ./sink maps its AlertDraft into   */
/* the row below and persists it (the single write path). Kept here so  */
/* the payload shape lives with its siblings, but it originates no       */
/* signal of its own.                                                   */
/* ------------------------------------------------------------------ */

export function autoRollbackPayload(args: {
  changeId: string;
  summary: string;
  detectedAt: string;
}): AutoRollbackPayload {
  return {
    kind: "auto_rollback_fired",
    fingerprint: autoRollbackFingerprint(args.changeId),
    summary: args.summary,
    detectedAt: args.detectedAt,
    changeId: args.changeId,
  };
}

/* ------------------------------------------------------------------ */
/* Derivation helpers — turn a signal SOURCE's read shape into a signal.*/
/* PURE. These let the wiring action stay thin AND keep the honesty     */
/* (they return null when there is no measurable signal — e.g. <2 runs). */
/* ------------------------------------------------------------------ */

/** A minimal run-score point (matches M3 reads' VisibilityRunScore essentials). */
export interface RunScorePoint {
  runAt: string;
  score: number;
}

/**
 * Derive a visibility-drop signal from an ASCENDING series of run scores (M3
 * `getVisibilityScoreSeries`). Returns null when there are fewer than two runs
 * — NO baseline means NO signal (honesty: absent history is `unknown`, not a
 * drop). Compares the two MOST RECENT runs only.
 */
export function visibilityDropSignalFromSeries(series: readonly RunScorePoint[]): VisibilityDropSignal | null {
  if (series.length < 2) return null;
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  return {
    previousScore: previous.score,
    latestScore: latest.score,
    previousRunAt: previous.runAt,
    latestRunAt: latest.runAt,
  };
}

/** A minimal share-of-voice point for one entity across a run. */
export interface ShareSnapshot {
  clientShare: number;
  /** Competitor name → measured share for the run. */
  competitorShares: ReadonlyMap<string, number>;
  runAt: string;
}

/**
 * Derive competitor-overtook signals by comparing a PRIOR and a LATEST
 * share-of-voice snapshot (M3 `getLatestShareOfVoice` over two runs). One signal
 * per competitor that crossed from level-or-behind to ahead. Deterministic order
 * (competitor name asc). Returns [] when there is no prior snapshot — no
 * baseline means no crossing can be measured (honesty).
 */
export function competitorOvertookSignals(
  previous: ShareSnapshot | null,
  latest: ShareSnapshot,
): CompetitorOvertookSignal[] {
  if (previous === null) return [];
  const signals: CompetitorOvertookSignal[] = [];
  for (const [name, competitorShare] of latest.competitorShares) {
    signals.push({
      competitorName: name,
      clientShare: latest.clientShare,
      competitorShare,
      previousClientShare: previous.clientShare,
      previousCompetitorShare: previous.competitorShares.get(name) ?? 0,
      latestRunAt: latest.runAt,
    });
  }
  return signals.sort((a, b) => a.competitorName.localeCompare(b.competitorName));
}

/** Re-export so callers can read the fixed severities without importing thresholds. */
export const RULE_SEVERITY: Record<"schema_broke" | "site_down", AlertSeverity> = {
  schema_broke: SCHEMA_BROKE_SEVERITY,
  site_down: SITE_DOWN_SEVERITY,
};
