/**
 * M16 ROI / attribution — the PURE attribution + ROI model (doc 05 §M16).
 *
 * This is the honest core: given MEASURED outcomes and the platform work that
 * preceded them, say what changed and — only where the data can bear it — what
 * it was worth, WITHOUT overclaiming causation. Every function here is pure and
 * deterministic (same inputs → identical output); the live action and the read
 * path both run these exact functions, so a recomputed number always equals the
 * number the run reported (the visibility-tracker discipline, scoring.ts).
 *
 * THE CAUSAL-HONESTY BOUNDARY (non-negotiable, doc 05 §M16 "answers 'did this
 * make money'"):
 *  - Attribution is CORRELATIONAL, never causal. Analytics can show outcomes
 *    rose in the window after the platform's work; it cannot prove the work
 *    caused it. Every attribution result is stamped `basis: "correlation"` and
 *    carries a plain-language `causalCaveat`. There is no code path that emits
 *    a causal claim — a caller literally cannot read one out of this module.
 *  - ABSENT ≠ ZERO. A metric with no measured samples is OMITTED from the
 *    summary, never reported as 0. An unconnected/failed source is listed as
 *    absent, never folded in as a zero contribution.
 *  - Partial coverage is STRUCTURAL. Every result names which sources
 *    contributed and which were absent, plus a coverage ratio — never a silent
 *    footnote, never an extrapolation to fill a gap.
 *  - NO EXTRAPOLATION. A metric measured in only one of the two comparison
 *    windows yields NO delta (`comparable: false`); it is never projected onto
 *    the missing window.
 *  - ROI is ABSENT unless a value-per-unit is SUPPLIED by the caller (a
 *    client-configured lead/deal value). We never invent a dollar figure, and
 *    even a computed figure is correlation-tagged and only ever counts positive
 *    deltas of comparable, valued metrics.
 */

import type { OutcomeSample, RoiSourceId } from "./sources";

/* ------------------------------------------------------------------ */
/* Outcome summary (one window)                                        */
/* ------------------------------------------------------------------ */

/** One metric's measured total across a window, with its contributing sources. */
export interface MetricTotal {
  metric: string;
  /** Sum of measured values (measured 0s included; absent metrics are omitted). */
  value: number;
  /** Distinct sources that measured this metric (sorted, canonical order). */
  sources: RoiSourceId[];
  /** Number of measured samples that fed the total. */
  samples: number;
}

/** Structural per-source coverage for a window — the honesty spine. */
export interface SourceCoverage {
  /** Sources asked for this window. */
  requested: RoiSourceId[];
  /** Sources that measured ≥ 1 sample. */
  contributing: RoiSourceId[];
  /** Requested sources with ZERO measured samples — ABSENT, never zero. */
  absent: RoiSourceId[];
  /** contributing / requested (0 when nothing was requested). */
  coverage: number;
}

export interface OutcomeSummary {
  /** Metrics present in canonical (metric-name) order; absent metrics omitted. */
  metrics: MetricTotal[];
  coverage: SourceCoverage;
}

const SOURCE_ORDER: Record<RoiSourceId, number> = {
  ga4: 0,
  gsc: 1,
  call_tracking: 2,
  form_fills: 3,
  crm: 4,
};

function sortSources(ids: Iterable<RoiSourceId>): RoiSourceId[] {
  return [...new Set(ids)].sort((a, b) => SOURCE_ORDER[a] - SOURCE_ORDER[b]);
}

/** A measured value must be a finite, non-negative number to count. */
function isMeasuredValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Summarize measured outcomes for one window against the set of sources that
 * were requested. Absent sources (and absent metrics) are reported
 * structurally, never as zeros. `requested` defaults to the sources that
 * actually appear — but callers SHOULD pass the full requested set so "GA4 not
 * connected" shows up as absent rather than vanishing.
 */
export function summarizeOutcomes(
  samples: OutcomeSample[],
  requested: RoiSourceId[],
): OutcomeSummary {
  const byMetric = new Map<string, { value: number; sources: Set<RoiSourceId>; samples: number }>();
  const contributing = new Set<RoiSourceId>();

  for (const sample of samples) {
    if (!isMeasuredValue(sample.value)) continue; // hostile/NaN value is not a measurement
    contributing.add(sample.source);
    const entry = byMetric.get(sample.metric) ?? { value: 0, sources: new Set(), samples: 0 };
    entry.value += sample.value;
    entry.sources.add(sample.source);
    entry.samples += 1;
    byMetric.set(sample.metric, entry);
  }

  const metrics: MetricTotal[] = [...byMetric.entries()]
    .map(([metric, entry]) => ({
      metric,
      value: entry.value,
      sources: sortSources(entry.sources),
      samples: entry.samples,
    }))
    .sort((a, b) => a.metric.localeCompare(b.metric));

  const requestedSet = sortSources(requested);
  const contributingSorted = sortSources(contributing);
  const absent = requestedSet.filter((id) => !contributing.has(id));

  return {
    metrics,
    coverage: {
      requested: requestedSet,
      contributing: contributingSorted,
      absent,
      coverage: requestedSet.length === 0 ? 0 : contributingSorted.length / requestedSet.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Work events (the platform's contribution)                           */
/* ------------------------------------------------------------------ */

/**
 * A unit of work the platform did, timestamped so it can be placed relative to
 * an outcome window. Kept deliberately small and source-shaped: an APPLIED site
 * change and a PUBLISHED content item are the concrete, on-record work units
 * (doc 04 §2 site_changes; doc 05 content pipeline). `at` is ISO-8601.
 */
export interface WorkEvent {
  kind: "site_change_applied" | "content_published";
  at: string;
  /** Coarse label for the work-log (e.g. change_type / content type). */
  detail?: string;
}

/* ------------------------------------------------------------------ */
/* Attribution (before → after, correlational)                         */
/* ------------------------------------------------------------------ */

/** Per-metric before/after comparison. `comparable` gates any delta claim. */
export interface MetricAttribution {
  metric: string;
  /** Present only when measured in the baseline window. */
  baseline: number | null;
  /** Present only when measured in the current window. */
  current: number | null;
  /** Non-null ONLY when measured in BOTH windows — never extrapolated. */
  delta: number | null;
  /** delta / baseline as a ratio; null when not comparable or baseline is 0. */
  deltaPct: number | null;
  /** True iff both windows measured this metric (a delta is meaningful). */
  comparable: boolean;
}

/** A caller-supplied monetary value per unit of a metric (e.g. $/lead). */
export interface MetricValuation {
  metric: string;
  valuePerUnit: number;
}

/** Correlation-tagged ROI — present ONLY when a valuation was supplied. */
export interface RoiEstimate {
  /** Sum over comparable, positively-moving valued metrics of delta × value. */
  attributedValue: number;
  /** Always "correlation" — this module never claims causation. */
  basis: "correlation";
  /** Which valued metrics contributed, with their attributed value. */
  valuedMetrics: Array<{ metric: string; delta: number; valuePerUnit: number; value: number }>;
  /** Valued metrics that could NOT be counted (not comparable, or non-positive delta). */
  unvaluable: string[];
}

export interface AttributionResult {
  basis: "correlation";
  causalCaveat: string;
  /** Count of platform work units placed in the current window. */
  workEventCount: number;
  workEventsByKind: Record<WorkEvent["kind"], number>;
  /**
   * True only when there was BOTH work in the window AND at least one
   * comparable metric — otherwise the module claims nothing.
   */
  attributable: boolean;
  metrics: MetricAttribution[];
  baselineCoverage: SourceCoverage;
  currentCoverage: SourceCoverage;
  /** Correlation-tagged ROI, or null when no valuation was supplied (absent, not 0). */
  roi: RoiEstimate | null;
}

const CAUSAL_CAVEAT =
  "Correlation, not proven causation: these outcomes were measured in the window following the platform's work. They may also reflect seasonality, paid media, or other factors this view does not control for.";

const NO_WORK_CAVEAT =
  "No platform work was recorded in this window, so no attribution is claimed — the outcome changes shown are for context only.";

function emptyByKind(): Record<WorkEvent["kind"], number> {
  return { site_change_applied: 0, content_published: 0 };
}

/**
 * Correlational before→after attribution. `baseline` and `current` are measured
 * outcome samples for two comparable windows; `workEvents` are the platform
 * work units placed in the current window; `valuations` (optional) turn
 * comparable positive deltas into a correlation-tagged dollar figure.
 *
 * Determinism: pure over its inputs. Honesty: absent metrics omitted; one-sided
 * metrics carry no delta; ROI absent unless valued; every result stamped
 * correlation.
 */
export function attributeOutcomes(input: {
  requestedSources: RoiSourceId[];
  baseline: OutcomeSample[];
  current: OutcomeSample[];
  workEvents: WorkEvent[];
  valuations?: MetricValuation[];
}): AttributionResult {
  const baselineSummary = summarizeOutcomes(input.baseline, input.requestedSources);
  const currentSummary = summarizeOutcomes(input.current, input.requestedSources);

  const baselineByMetric = new Map(baselineSummary.metrics.map((m) => [m.metric, m.value]));
  const currentByMetric = new Map(currentSummary.metrics.map((m) => [m.metric, m.value]));

  const allMetricNames = [
    ...new Set([...baselineByMetric.keys(), ...currentByMetric.keys()]),
  ].sort((a, b) => a.localeCompare(b));

  const metrics: MetricAttribution[] = allMetricNames.map((metric) => {
    const baseline = baselineByMetric.has(metric) ? baselineByMetric.get(metric)! : null;
    const current = currentByMetric.has(metric) ? currentByMetric.get(metric)! : null;
    const comparable = baseline !== null && current !== null;
    const delta = comparable ? current! - baseline! : null;
    const deltaPct =
      comparable && baseline! !== 0 ? (current! - baseline!) / baseline! : null;
    return { metric, baseline, current, delta, deltaPct, comparable };
  });

  const workEventsByKind = emptyByKind();
  for (const event of input.workEvents) {
    if (event.kind in workEventsByKind) workEventsByKind[event.kind] += 1;
  }
  const workEventCount = workEventsByKind.site_change_applied + workEventsByKind.content_published;

  const hasComparable = metrics.some((m) => m.comparable);
  const attributable = workEventCount > 0 && hasComparable;

  return {
    basis: "correlation",
    causalCaveat: workEventCount > 0 ? CAUSAL_CAVEAT : NO_WORK_CAVEAT,
    workEventCount,
    workEventsByKind,
    attributable,
    metrics,
    baselineCoverage: baselineSummary.coverage,
    currentCoverage: currentSummary.coverage,
    // ROI is only ever computed when the caller supplied a valuation AND the
    // work-in-window gate is open — never invented, never claimed on its own.
    roi:
      attributable && input.valuations && input.valuations.length > 0
        ? estimateRoi(metrics, input.valuations)
        : null,
  };
}

/**
 * Turn comparable, positively-moving valued metrics into a correlation-tagged
 * figure. A valued metric that isn't comparable, or whose delta is ≤ 0, counts
 * ZERO and is listed under `unvaluable` — we never claim value we can't
 * defend, and never net a "loss" into an ROI-for-our-work number.
 */
function estimateRoi(metrics: MetricAttribution[], valuations: MetricValuation[]): RoiEstimate {
  const byMetric = new Map(metrics.map((m) => [m.metric, m]));
  const valuedMetrics: RoiEstimate["valuedMetrics"] = [];
  const unvaluable: string[] = [];

  for (const valuation of valuations) {
    const attribution = byMetric.get(valuation.metric);
    const usable =
      attribution !== undefined &&
      attribution.comparable &&
      attribution.delta !== null &&
      attribution.delta > 0 &&
      Number.isFinite(valuation.valuePerUnit) &&
      valuation.valuePerUnit >= 0;
    if (!usable) {
      unvaluable.push(valuation.metric);
      continue;
    }
    valuedMetrics.push({
      metric: valuation.metric,
      delta: attribution!.delta!,
      valuePerUnit: valuation.valuePerUnit,
      value: attribution!.delta! * valuation.valuePerUnit,
    });
  }

  return {
    attributedValue: valuedMetrics.reduce((sum, m) => sum + m.value, 0),
    basis: "correlation",
    valuedMetrics,
    unvaluable,
  };
}
