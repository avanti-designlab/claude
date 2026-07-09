/**
 * M16 ROI / attribution — normalize a source's measured outcomes into the
 * frozen `metrics` insert shape, and OWN the honest mapping from the module's
 * logical sources to the frozen `metrics.source` CHECK (doc 04 §7's "normalize
 * every vendor's response into our own schema" — here, into the data model).
 *
 * ⚑ FROZEN-SCHEMA GAP (flagged for the Orchestrator, post-freeze — same class
 * as the M3/M4 flags in visibility/persist.ts):
 *   `metrics.source` (migration 0006) is CHECK-constrained to
 *   ('gsc','ga4','call_tracking','local_rank','reviews'). Three of M16's five
 *   logical sources have a home (ga4, gsc, call_tracking); TWO DO NOT:
 *     - form_fills  → no `metrics.source` value exists
 *     - crm         → no `metrics.source` value exists
 *   There is ALSO no home for the COMPUTED attribution/ROI synthesis (no
 *   `attribution`/`roi` source, no run table). M16 therefore does what M3 did:
 *   it persists only what the frozen schema can honestly hold (raw ga4/gsc/
 *   call_tracking captures) and RECOMPUTES attribution at read time
 *   (reads.ts) rather than storing a synthesis the schema has no place for.
 *   An un-homed source is REFUSED at the persistence seam and surfaced as a
 *   typed gap — its outcomes are NEVER mis-filed under another source. Closing
 *   the gap = a backend migration adding the sources (+ optionally a
 *   `roi_runs`/attribution table); until then form_fills/crm stay
 *   port-and-attribution-only, absent from history (honestly, not silently).
 */

import { METRIC_SOURCES, type Json, type MetricRow, type MetricSource } from "@/lib/types/db";
import type { OutcomePeriod, OutcomeSample, RoiSourceId } from "./sources";

/**
 * Logical ROI source → frozen `metrics.source`, or null when the frozen CHECK
 * has NO home for it. `local_rank`/`reviews` are other modules' sources (M14/
 * M15) and are intentionally not produced here.
 */
export const ROI_SOURCE_TO_METRIC_SOURCE: Record<RoiSourceId, MetricSource | null> = {
  ga4: "ga4",
  gsc: "gsc",
  call_tracking: "call_tracking",
  form_fills: null,
  crm: null,
};

/** The logical sources that CAN be persisted into `metrics` today. */
export const HOMED_ROI_SOURCES: RoiSourceId[] = (
  Object.keys(ROI_SOURCE_TO_METRIC_SOURCE) as RoiSourceId[]
).filter((id) => ROI_SOURCE_TO_METRIC_SOURCE[id] !== null);

/** The logical sources with NO storage home yet (the flagged gap). */
export const UNHOMED_ROI_SOURCES: RoiSourceId[] = (
  Object.keys(ROI_SOURCE_TO_METRIC_SOURCE) as RoiSourceId[]
).filter((id) => ROI_SOURCE_TO_METRIC_SOURCE[id] === null);

/**
 * The vendor-independent shape stored in `metrics.data` (jsonb). Recomputation
 * at read time reconstructs {@link OutcomeSample}s from exactly this — so
 * stored history survives a vendor swap (doc 04 §7).
 */
export interface MetricCaptureData {
  vendor: string;
  period: OutcomePeriod;
  /** metric name → measured total for the period (finite, non-negative). */
  metrics: Record<string, number>;
}

/** Insert shape for a `metrics` row (id + captured_at are DB/persist-owned). */
export type MetricCaptureInsert = Omit<MetricRow, "id" | "captured_at">;

export type NormalizeCaptureOutcome =
  | { kind: "homed"; insert: MetricCaptureInsert }
  /** No `metrics.source` home for this logical source — the flagged gap. */
  | { kind: "unhomed"; source: RoiSourceId }
  /** The source measured nothing usable — nothing to store (storing 0s would lie). */
  | { kind: "empty" };

/**
 * Normalize one source's measured samples for one period into a `metrics`
 * insert, or refuse it honestly. Folds the source's samples into a
 * `{ metric: total }` map (measured 0s kept; NaN/negative/hostile dropped).
 * Refuses an un-homed source with a typed `unhomed` outcome — never files it
 * under a different source.
 */
export function toMetricCaptureInsert(
  scope: { tenantId: string; clientId: string },
  input: { source: RoiSourceId; vendor: string; period: OutcomePeriod; samples: OutcomeSample[] },
): NormalizeCaptureOutcome {
  const metricSource = ROI_SOURCE_TO_METRIC_SOURCE[input.source];
  if (metricSource === null) return { kind: "unhomed", source: input.source };

  if (!isPeriod(input.period)) {
    // A junk period would make the capture unidentifiable in history.
    return { kind: "empty" };
  }

  const metrics: Record<string, number> = {};
  for (const sample of input.samples) {
    if (sample.source !== input.source) continue; // never mix sources into one row
    if (typeof sample.metric !== "string" || sample.metric.trim() === "") continue;
    if (typeof sample.value !== "number" || !Number.isFinite(sample.value) || sample.value < 0) {
      continue;
    }
    const metric = sample.metric.trim();
    metrics[metric] = (metrics[metric] ?? 0) + sample.value;
  }
  if (Object.keys(metrics).length === 0) return { kind: "empty" };

  const data: MetricCaptureData = {
    vendor: typeof input.vendor === "string" ? input.vendor : "unknown",
    period: { start: input.period.start, end: input.period.end },
    metrics,
  };

  return {
    kind: "homed",
    insert: {
      tenant_id: scope.tenantId,
      client_id: scope.clientId,
      source: metricSource,
      data: data as unknown as Json,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Read-side reconstruction (defensive — jsonb is untrusted at rest)   */
/* ------------------------------------------------------------------ */

/**
 * Reconstruct {@link OutcomeSample}s from a stored `metrics.data` jsonb blob for
 * a given logical source. Trusts nothing: a hostile/legacy/misshaped row yields
 * `[]`, never a throw and never an invented value. This is the inverse of
 * {@link toMetricCaptureInsert} for the recompute-at-read path.
 */
export function outcomeSamplesFromCapture(source: RoiSourceId, data: unknown): OutcomeSample[] {
  if (typeof data !== "object" || data === null) return [];
  const record = data as Record<string, unknown>;
  const period = record.period;
  if (!isPeriod(period)) return [];
  const metrics = record.metrics;
  if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) return [];

  const samples: OutcomeSample[] = [];
  for (const [metric, value] of Object.entries(metrics as Record<string, unknown>)) {
    if (metric.trim() === "") continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    samples.push({
      source,
      metric,
      value,
      period: { start: period.start, end: period.end },
    });
  }
  return samples;
}

/** Map a stored `metrics.source` back to a logical ROI source (or null if it's another module's). */
export function metricSourceToRoiSource(source: unknown): RoiSourceId | null {
  if (typeof source !== "string") return null;
  if (!(METRIC_SOURCES as readonly string[]).includes(source)) return null;
  for (const id of Object.keys(ROI_SOURCE_TO_METRIC_SOURCE) as RoiSourceId[]) {
    if (ROI_SOURCE_TO_METRIC_SOURCE[id] === source) return id;
  }
  return null;
}

function isPeriod(value: unknown): value is OutcomePeriod {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.start === "string" &&
    typeof record.end === "string" &&
    Number.isFinite(Date.parse(record.start)) &&
    Number.isFinite(Date.parse(record.end))
  );
}
