import "server-only";

/**
 * M16 ROI / attribution — read API over stored `metrics` history (frozen
 * schema, migration 0006). These are the shapes the M19 dashboard's work-log/
 * ROI panel consumes at the later wiring slice: the latest ROI snapshot, the
 * outcome time-series, and the correlational attribution of the latest window.
 * This module deliberately touches NO UI.
 *
 * RECOMPUTED, NEVER STORED-SYNTHESIS: the frozen schema has no home for a
 * computed attribution/ROI run (⚑ normalize.ts), so — exactly like the
 * visibility reads recompute the score from stored results — attribution is
 * RECOMPUTED here from stored raw captures via the same pure functions the live
 * collection uses (attribution.ts). A read-back number always equals the live
 * number and survives vendor swaps (stored shape is vendor-independent).
 *
 * SNAPSHOT GROUPING: the frozen schema has no run id; persist.ts pins one
 * `captured_at` per collection, so (client, captured_at) is the snapshot key
 * and rows group on captured_at equality (the visibility-run discipline).
 *
 * COVERAGE HONESTY: reads report coverage over the HOMED sources only
 * (ga4/gsc/call_tracking) — the sources storage can represent. form_fills/crm
 * are absent from history BY SCHEMA (no home), a structural fact documented in
 * normalize.ts, not a "connect me" gap, so they are not paraded as absent in
 * every snapshot. A homed source that simply wasn't connected at capture time
 * IS reported absent (never zero).
 *
 * TENANT SCOPING: callers pass a claim-scoped Supabase client; RLS
 * (`metrics_select`: `tenant_id = app.tenant_id() and app.client_scope(
 * client_id)`, migration 0006) is the isolation boundary — a cross-tenant
 * clientId yields zero rows, indistinguishable from "no captures yet". The
 * `eq(client_id)` filter narrows within the caller's own scope; a client_viewer
 * reads its own client's ROI through the same policy.
 */

import { isUuidV4 } from "@/lib/clients/validate";
import type { Supabase } from "./persist";
import {
  attributeOutcomes,
  summarizeOutcomes,
  type AttributionResult,
  type MetricValuation,
  type OutcomeSummary,
  type WorkEvent,
} from "./attribution";
import {
  HOMED_ROI_SOURCES,
  metricSourceToRoiSource,
  outcomeSamplesFromCapture,
  ROI_SOURCE_TO_METRIC_SOURCE,
} from "./normalize";
import type { OutcomePeriod, OutcomeSample } from "./sources";

/* ------------------------------------------------------------------ */
/* Row caps                                                            */
/* ------------------------------------------------------------------ */

/** Homed `metrics.source` values the ROI reads narrow to at the database. */
export const HOMED_METRIC_SOURCES = HOMED_ROI_SOURCES.map(
  (id) => ROI_SOURCE_TO_METRIC_SOURCE[id]!,
);

/** At most 3 homed sources per snapshot, so this many rows always holds one snapshot. */
const LATEST_SNAPSHOT_ROW_CAP = HOMED_ROI_SOURCES.length;

/**
 * ⚑ Series reads fetch at most this many rows (the PostgREST default max-rows).
 * When hit, the OLDEST snapshot may be partial, so it is dropped and the result
 * says `truncated: true` — structurally, never a silently short trend line.
 */
export const SERIES_ROW_CAP = 1000;

/** Bound on work-event rows joined for attribution (recent on-site work). */
const WORK_EVENTS_CAP = 500;

const METRIC_COLUMNS = "source, data, captured_at";

interface StoredMetricRow {
  source: string;
  data: unknown;
  captured_at: string;
}

/* ------------------------------------------------------------------ */
/* Read shapes (the dashboard-panel contract)                          */
/* ------------------------------------------------------------------ */

/** One snapshot's recomputed outcome summary. */
export interface RoiSnapshot {
  /** The snapshot key (stored captured_at). */
  capturedAt: string;
  /** Window the captures cover (min start / max end across the snapshot). */
  period: OutcomePeriod;
  summary: OutcomeSummary;
}

export type LatestRoiRead =
  | { kind: "ok"; latest: RoiSnapshot | null }
  | { kind: "failed" };

export type RoiSeriesRead =
  | { kind: "ok"; series: RoiSnapshot[]; truncated: boolean }
  | { kind: "failed" };

/** Attribution of the latest window against the prior one, with work context. */
export interface RoiAttributionSnapshot extends AttributionResult {
  currentAt: string;
  /** Null when there is no prior snapshot to compare against. */
  baselineAt: string | null;
  currentPeriod: OutcomePeriod;
}

export type RoiAttributionRead =
  | { kind: "ok"; attribution: RoiAttributionSnapshot | null }
  | { kind: "failed" };

/* ------------------------------------------------------------------ */
/* Reconstruction helpers                                              */
/* ------------------------------------------------------------------ */

/** Reconstruct a snapshot's measured samples from its stored rows. */
function samplesOfSnapshot(rows: StoredMetricRow[]): OutcomeSample[] {
  const samples: OutcomeSample[] = [];
  for (const row of rows) {
    const sourceId = metricSourceToRoiSource(row.source);
    if (sourceId === null) continue; // another module's metric (local_rank/reviews)
    samples.push(...outcomeSamplesFromCapture(sourceId, row.data));
  }
  return samples;
}

/** Min start / max end across a snapshot's samples; falls back to captured_at. */
function periodOfSnapshot(capturedAt: string, samples: OutcomeSample[]): OutcomePeriod {
  if (samples.length === 0) return { start: capturedAt, end: capturedAt };
  let start = samples[0].period.start;
  let end = samples[0].period.end;
  for (const s of samples) {
    if (Date.parse(s.period.start) < Date.parse(start)) start = s.period.start;
    if (Date.parse(s.period.end) > Date.parse(end)) end = s.period.end;
  }
  return { start, end };
}

function buildSnapshot(capturedAt: string, rows: StoredMetricRow[]): RoiSnapshot {
  const samples = samplesOfSnapshot(rows);
  return {
    capturedAt,
    period: periodOfSnapshot(capturedAt, samples),
    summary: summarizeOutcomes(samples, HOMED_ROI_SOURCES),
  };
}

/** Group rows (already ordered captured_at DESC) into contiguous snapshots. */
function groupSnapshots(
  rows: StoredMetricRow[],
): Array<{ capturedAt: string; rows: StoredMetricRow[] }> {
  const groups: Array<{ capturedAt: string; rows: StoredMetricRow[] }> = [];
  for (const row of rows) {
    const current = groups[groups.length - 1];
    if (current && current.capturedAt === row.captured_at) current.rows.push(row);
    else groups.push({ capturedAt: row.captured_at, rows: [row] });
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Latest ROI snapshot for a client — the panel's headline. */
export async function getLatestRoiSnapshot(
  supabase: Supabase,
  clientId: string,
): Promise<LatestRoiRead> {
  if (!isUuidV4(clientId)) return { kind: "ok", latest: null };
  const { data, error } = await supabase
    .from("metrics")
    .select(METRIC_COLUMNS)
    .eq("client_id", clientId)
    .in("source", HOMED_METRIC_SOURCES)
    .order("captured_at", { ascending: false })
    .limit(LATEST_SNAPSHOT_ROW_CAP);
  if (error || !data) return { kind: "failed" };
  const rows = data as unknown as StoredMetricRow[];
  if (rows.length === 0) return { kind: "ok", latest: null };
  const capturedAt = rows[0].captured_at;
  const snapshotRows = rows.filter((r) => r.captured_at === capturedAt);
  return { kind: "ok", latest: buildSnapshot(capturedAt, snapshotRows) };
}

/**
 * Outcome time-series (ascending) — the trend line. Optional `since` (ISO;
 * invalid ignored) and `maxSnapshots` (newest N kept after grouping).
 */
export async function getRoiTimeSeries(
  supabase: Supabase,
  clientId: string,
  options: { since?: string; maxSnapshots?: number } = {},
): Promise<RoiSeriesRead> {
  if (!isUuidV4(clientId)) return { kind: "ok", series: [], truncated: false };

  const since =
    typeof options.since === "string" && Number.isFinite(Date.parse(options.since))
      ? options.since
      : null;

  let query = supabase
    .from("metrics")
    .select(METRIC_COLUMNS)
    .eq("client_id", clientId)
    .in("source", HOMED_METRIC_SOURCES);
  if (since !== null) query = query.gte("captured_at", since);
  const { data, error } = await query
    .order("captured_at", { ascending: false })
    .limit(SERIES_ROW_CAP);
  if (error || !data) return { kind: "failed" };
  const rows = data as unknown as StoredMetricRow[];

  let groups = groupSnapshots(rows);
  let truncated = false;
  if (rows.length >= SERIES_ROW_CAP && groups.length > 0) {
    truncated = true;
    if (groups.length > 1) groups = groups.slice(0, -1);
  }
  const maxSnapshots =
    typeof options.maxSnapshots === "number" &&
    Number.isInteger(options.maxSnapshots) &&
    options.maxSnapshots >= 1
      ? options.maxSnapshots
      : null;
  if (maxSnapshots !== null && groups.length > maxSnapshots) {
    truncated = true;
    groups = groups.slice(0, maxSnapshots);
  }

  return {
    kind: "ok",
    series: groups.map((g) => buildSnapshot(g.capturedAt, g.rows)).reverse(),
    truncated,
  };
}

/**
 * Correlational attribution of the latest window against the prior snapshot,
 * with the on-site work applied during the latest window as work events.
 * `valuations` (optional) come from server-side callers (client-configured
 * lead/deal value — which itself has no schema home yet, ⚑); without them ROI
 * is ABSENT (null), never invented. Returns `attribution: null` when there is
 * not yet a snapshot to attribute.
 */
export async function getRoiAttribution(
  supabase: Supabase,
  clientId: string,
  options: { valuations?: MetricValuation[] } = {},
): Promise<RoiAttributionRead> {
  if (!isUuidV4(clientId)) return { kind: "ok", attribution: null };

  // Enough rows to hold the two newest snapshots (current + baseline).
  const { data, error } = await supabase
    .from("metrics")
    .select(METRIC_COLUMNS)
    .eq("client_id", clientId)
    .in("source", HOMED_METRIC_SOURCES)
    .order("captured_at", { ascending: false })
    .limit(LATEST_SNAPSHOT_ROW_CAP * 2);
  if (error || !data) return { kind: "failed" };
  const rows = data as unknown as StoredMetricRow[];
  if (rows.length === 0) return { kind: "ok", attribution: null };

  const groups = groupSnapshots(rows);
  const currentGroup = groups[0];
  const baselineGroup = groups[1] ?? null;

  const currentSamples = samplesOfSnapshot(currentGroup.rows);
  const baselineSamples = baselineGroup ? samplesOfSnapshot(baselineGroup.rows) : [];
  const currentPeriod = periodOfSnapshot(currentGroup.capturedAt, currentSamples);

  const workEvents = await fetchWorkEvents(supabase, clientId, currentPeriod);
  if (workEvents.kind === "failed") return { kind: "failed" };

  const attribution = attributeOutcomes({
    requestedSources: HOMED_ROI_SOURCES,
    baseline: baselineSamples,
    current: currentSamples,
    workEvents: workEvents.events,
    ...(options.valuations ? { valuations: options.valuations } : {}),
  });

  return {
    kind: "ok",
    attribution: {
      ...attribution,
      currentAt: currentGroup.capturedAt,
      baselineAt: baselineGroup ? baselineGroup.capturedAt : null,
      currentPeriod,
    },
  };
}

/**
 * On-site work applied during `window` — the platform's contribution
 * (site_changes, migration 0005). Only APPLIED changes count as work; a
 * previewed-but-unapplied change did nothing to the live site. RLS scopes the
 * read to the caller's tenant + client_scope.
 */
async function fetchWorkEvents(
  supabase: Supabase,
  clientId: string,
  window: OutcomePeriod,
): Promise<{ kind: "ok"; events: WorkEvent[] } | { kind: "failed" }> {
  const { data, error } = await supabase
    .from("site_changes")
    .select("change_type, applied_at, status")
    .eq("client_id", clientId)
    .eq("status", "applied")
    .order("applied_at", { ascending: false })
    .limit(WORK_EVENTS_CAP);
  if (error || !data) return { kind: "failed" };
  const rows = data as Array<{ change_type: unknown; applied_at: unknown; status: unknown }>;

  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  const events: WorkEvent[] = [];
  for (const row of rows) {
    if (typeof row.applied_at !== "string") continue;
    const at = Date.parse(row.applied_at);
    if (!Number.isFinite(at) || at < start || at > end) continue; // only work IN the window
    events.push({
      kind: "site_change_applied",
      at: row.applied_at,
      ...(typeof row.change_type === "string" ? { detail: row.change_type } : {}),
    });
  }
  return { kind: "ok", events };
}
