import "server-only";

/**
 * M3 Visibility Tracker — read API over stored `visibility_results` history
 * (frozen schema, migration 0006). These are the shapes the M19 dashboard's
 * pending gauges consume at the later wiring slice: latest Visibility Score,
 * the score time-series (the trend line — the product, doc 05 §M3), and the
 * latest share-of-voice. This module deliberately touches NO UI.
 *
 * All metrics are RECOMPUTED from stored rows via the same pure scoring
 * functions the live run uses (scoring.ts), so a read-back score always
 * equals the score the run reported — and stays computable across playbook
 * edits and vendor swaps (the stored shape is vendor-independent, doc 04 §7).
 *
 * RUN GROUPING: the frozen schema has no run id; persist.ts pins one
 * `captured_at` per run, so (client, captured_at) is the run key and rows
 * group on captured_at equality. Coverage (requested vs measured) is NOT
 * recoverable from history — only measured rows are stored (⚑ flagged in
 * persist.ts); read shapes report what IS knowable: sample counts and which
 * engines went unmeasured (score null — absent is never 0).
 *
 * TENANT SCOPING: callers pass a claim-scoped Supabase client; RLS
 * (`visibility_results_select`: `tenant_id = app.tenant_id() and
 * app.client_scope(client_id)`, migration 0006) is the isolation boundary —
 * a cross-tenant clientId yields zero rows, indistinguishable from "no runs
 * yet". The `eq(client_id)` filter narrows within the caller's own scope.
 * client_viewer reads its own client's gauges through the same policy.
 */

import { isUuidV4 } from "@/lib/clients/validate";
import type { VisibilityEngine } from "@/lib/types/db";
import type { Supabase } from "./persist";
import { MAX_TRACKED_QUERIES } from "./derive";
import {
  citedUrlInventory,
  perEngineBreakdown,
  shareOfVoice,
  visibilityScore,
  type CitedUrlEntry,
  type CompetitorRef,
  type EngineBreakdown,
  type MeasuredSample,
  type ShareOfVoiceReport,
} from "./scoring";

/* ------------------------------------------------------------------ */
/* Row caps (PostgREST returns at most its max-rows per request)       */
/* ------------------------------------------------------------------ */

/**
 * Enough rows to always hold one FULL run: MAX_TRACKED_QUERIES × 6 engines.
 * Latest-run reads fetch this many newest rows and keep the newest
 * captured_at group.
 */
const LATEST_RUN_ROW_CAP = MAX_TRACKED_QUERIES * 6;

/**
 * ⚑ Series reads fetch at most this many rows per request (the PostgREST
 * default max-rows — asking for more would be silently capped anyway). When
 * the cap is hit, the OLDEST captured_at group may be partial, so it is
 * dropped and the result says `truncated: true` — structurally, never a
 * silently short trend line. Deeper history needs pagination (a later slice).
 */
export const SERIES_ROW_CAP = 1000;

/** Only the columns the metrics need — never `select *`. */
const RESULT_COLUMNS = "engine, prompt, cited, position, cited_source, captured_at";

interface StoredResultRow {
  engine: VisibilityEngine;
  prompt: string;
  cited: boolean;
  position: number | null;
  cited_source: string | null;
  captured_at: string;
}

function toSample(row: StoredResultRow): MeasuredSample {
  return {
    engine: row.engine,
    prompt: row.prompt,
    cited: row.cited,
    position: row.position,
    citedSource: row.cited_source,
  };
}

/* ------------------------------------------------------------------ */
/* Read shapes (the dashboard-gauge contract)                          */
/* ------------------------------------------------------------------ */

/** One run's score as recomputed from storage. */
export interface VisibilityRunScore {
  /** The run key (stored captured_at, as PostgREST returns it). */
  runAt: string;
  /** Never null here — a stored run has ≥ 1 measured sample by construction. */
  score: number;
  /** Measured samples stored for the run. */
  samples: number;
  /** All six engines, canonical order; unmeasured engines carry score null. */
  engines: EngineBreakdown[];
}

export interface LatestShareOfVoice {
  runAt: string;
  samples: number;
  shareOfVoice: ShareOfVoiceReport;
  /** The run's cited-source inventory (M4's input). */
  citedUrls: CitedUrlEntry[];
}

export type LatestScoreRead =
  /** latest is null when the client has no stored runs yet (gauge shows pending). */
  | { kind: "ok"; latest: VisibilityRunScore | null }
  /** The read failed — retryable; never mistaken for "no runs yet". */
  | { kind: "failed" };

export type ScoreSeriesRead =
  | {
      kind: "ok";
      /** Ascending by runAt — ready for the trend line. */
      series: VisibilityRunScore[];
      /** True when the row cap cut older history (see SERIES_ROW_CAP). */
      truncated: boolean;
    }
  | { kind: "failed" };

export type ShareOfVoiceRead =
  | { kind: "ok"; latest: LatestShareOfVoice | null }
  | { kind: "failed" };

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function buildRunScore(runAt: string, rows: StoredResultRow[]): VisibilityRunScore {
  const samples = rows.map(toSample);
  return {
    runAt,
    // Rows exist ⇒ ≥1 sample ⇒ visibilityScore is a number; ?? 0 is a type
    // guard, not a semantic (an empty group is never passed in).
    score: visibilityScore(samples) ?? 0,
    samples: samples.length,
    engines: perEngineBreakdown(samples),
  };
}

/** Group rows (already ordered captured_at DESC) into contiguous runs. */
function groupRuns(rows: StoredResultRow[]): Array<{ runAt: string; rows: StoredResultRow[] }> {
  const groups: Array<{ runAt: string; rows: StoredResultRow[] }> = [];
  for (const row of rows) {
    const current = groups[groups.length - 1];
    if (current && current.runAt === row.captured_at) {
      current.rows.push(row);
    } else {
      groups.push({ runAt: row.captured_at, rows: [row] });
    }
  }
  return groups;
}

/**
 * Newest-run rows for a client, or null when none / [] semantics. A non-UUID
 * clientId is definitionally unknown to Postgres: it yields the same "no
 * runs" observation without ever sending junk to the database.
 */
async function fetchLatestRunRows(
  supabase: Supabase,
  clientId: string
): Promise<{ kind: "ok"; rows: StoredResultRow[] } | { kind: "failed" }> {
  const { data, error } = await supabase
    .from("visibility_results")
    .select(RESULT_COLUMNS)
    .eq("client_id", clientId)
    .order("captured_at", { ascending: false })
    .limit(LATEST_RUN_ROW_CAP);
  if (error || !data) return { kind: "failed" };
  const rows = data as unknown as StoredResultRow[];
  if (rows.length === 0) return { kind: "ok", rows: [] };
  const runAt = rows[0].captured_at;
  return { kind: "ok", rows: rows.filter((row) => row.captured_at === runAt) };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Latest Visibility Score for a client — the dashboard's headline gauge. */
export async function getLatestVisibilityScore(
  supabase: Supabase,
  clientId: string
): Promise<LatestScoreRead> {
  if (!isUuidV4(clientId)) return { kind: "ok", latest: null };
  const fetched = await fetchLatestRunRows(supabase, clientId);
  if (fetched.kind === "failed") return { kind: "failed" };
  if (fetched.rows.length === 0) return { kind: "ok", latest: null };
  return {
    kind: "ok",
    latest: buildRunScore(fetched.rows[0].captured_at, fetched.rows),
  };
}

/**
 * Score time-series (ascending) — the trend line. Optional `since` (ISO
 * timestamp; invalid values are ignored, documented) and `maxRuns` (newest N
 * runs kept after grouping).
 */
export async function getVisibilityScoreSeries(
  supabase: Supabase,
  clientId: string,
  options: { since?: string; maxRuns?: number } = {}
): Promise<ScoreSeriesRead> {
  if (!isUuidV4(clientId)) return { kind: "ok", series: [], truncated: false };

  const since =
    typeof options.since === "string" && Number.isFinite(Date.parse(options.since))
      ? options.since
      : null;

  let query = supabase
    .from("visibility_results")
    .select(RESULT_COLUMNS)
    .eq("client_id", clientId);
  if (since !== null) query = query.gte("captured_at", since);
  const { data, error } = await query
    .order("captured_at", { ascending: false })
    .limit(SERIES_ROW_CAP);
  if (error || !data) return { kind: "failed" };
  const rows = data as unknown as StoredResultRow[];

  let groups = groupRuns(rows);
  let truncated = false;
  if (rows.length >= SERIES_ROW_CAP && groups.length > 0) {
    // The cap was hit: the OLDEST group may be missing rows. Drop it (when it
    // isn't the only run) and say so — an honest shorter series beats a
    // silently wrong oldest point.
    truncated = true;
    if (groups.length > 1) groups = groups.slice(0, -1);
  }
  const maxRuns =
    typeof options.maxRuns === "number" &&
    Number.isInteger(options.maxRuns) &&
    options.maxRuns >= 1
      ? options.maxRuns
      : null;
  if (maxRuns !== null && groups.length > maxRuns) {
    truncated = true;
    groups = groups.slice(0, maxRuns);
  }

  return {
    kind: "ok",
    series: groups
      .map((group) => buildRunScore(group.runAt, group.rows))
      .reverse(),
    truncated,
  };
}

/* ------------------------------------------------------------------ */
/* Per-prompt latest-run results — THIN P1 read (adds `sentiment`)     */
/* ------------------------------------------------------------------ */

/**
 * Columns for the per-prompt view: `RESULT_COLUMNS` PLUS `sentiment`, which the
 * score / SOV reads don't need and deliberately don't select. Kept as a SEPARATE
 * constant + fetch so the load-bearing score reads (also consumed by the M19
 * dashboard gauges) stay byte-for-byte unchanged — this P1 slice must not perturb
 * them. (Modest duplication of the newest-run grouping is the deliberate trade.)
 */
const RESULT_ROW_COLUMNS =
  "engine, prompt, cited, position, sentiment, cited_source, captured_at";

interface StoredResultRowFull extends StoredResultRow {
  sentiment: string | null;
}

/** One measured prompt×engine sample, exactly as the per-prompt table renders it. */
export interface VisibilityPromptResult {
  engine: VisibilityEngine;
  prompt: string;
  cited: boolean;
  /** Citation rank when the engine reported one; null = not captured (never 0). */
  position: number | null;
  /** Vendor sentiment label (free text; value set is doc-silent, §9) or null = not captured. */
  sentiment: string | null;
  /** The source the engine cited (the competitor/page winning the answer) or null. */
  citedSource: string | null;
}

export type LatestRunResultsRead =
  | { kind: "ok"; latest: { runAt: string; rows: VisibilityPromptResult[] } | null }
  | { kind: "failed" };

function toPromptResult(row: StoredResultRowFull): VisibilityPromptResult {
  return {
    engine: row.engine,
    prompt: row.prompt,
    cited: row.cited,
    position: row.position,
    sentiment: row.sentiment,
    citedSource: row.cited_source,
  };
}

/**
 * The newest run's per-prompt samples — the operator's daily "which prompts are
 * we cited on, where, and who got cited instead" view. Returns EVERY measured
 * sample in the newest captured_at group (the UI bounds the DISPLAY, honestly).
 * Only MEASURED samples are stored (persist.ts), so an absent prompt/engine reads
 * as "not measured", never as "not cited". Mirrors `fetchLatestRunRows`' newest-run
 * grouping but selects `sentiment` too (see `RESULT_ROW_COLUMNS`). A non-UUID
 * clientId never reaches Postgres — same "no runs" observation as the score read.
 */
export async function getLatestRunResults(
  supabase: Supabase,
  clientId: string
): Promise<LatestRunResultsRead> {
  if (!isUuidV4(clientId)) return { kind: "ok", latest: null };
  const { data, error } = await supabase
    .from("visibility_results")
    .select(RESULT_ROW_COLUMNS)
    .eq("client_id", clientId)
    .order("captured_at", { ascending: false })
    .limit(LATEST_RUN_ROW_CAP);
  if (error || !data) return { kind: "failed" };
  const rows = data as unknown as StoredResultRowFull[];
  if (rows.length === 0) return { kind: "ok", latest: null };
  const runAt = rows[0].captured_at;
  const runRows = rows.filter((r) => r.captured_at === runAt).map(toPromptResult);
  return { kind: "ok", latest: { runAt, rows: runRows } };
}

/**
 * Latest share-of-voice vs named competitors, plus the run's cited-URL
 * inventory. Competitor refs come from server-side callers (the wiring slice
 * sources them from stored config) — arbitrary strings are safe here:
 * non-host-shaped domains simply never match (scoring.normalizeDomain).
 */
export async function getLatestShareOfVoice(
  supabase: Supabase,
  clientId: string,
  competitors: CompetitorRef[]
): Promise<ShareOfVoiceRead> {
  if (!isUuidV4(clientId)) return { kind: "ok", latest: null };
  const fetched = await fetchLatestRunRows(supabase, clientId);
  if (fetched.kind === "failed") return { kind: "failed" };
  if (fetched.rows.length === 0) return { kind: "ok", latest: null };
  const samples = fetched.rows.map(toSample);
  return {
    kind: "ok",
    latest: {
      runAt: fetched.rows[0].captured_at,
      samples: samples.length,
      shareOfVoice: shareOfVoice(samples, competitors),
      citedUrls: citedUrlInventory(samples, competitors),
    },
  };
}
