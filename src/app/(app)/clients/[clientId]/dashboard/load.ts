import "server-only";

/**
 * M19 white-label client dashboard — the read orchestration (doc 07 §1.10).
 *
 * This module CONSUMES the gated module read APIs; it invents no metric logic.
 * Every panel's data comes from an already-frozen, RLS-scoped read:
 *   Visibility Score + trend  → M3  (src/lib/intelligence/visibility/reads)
 *   Share of voice            → M3/M4 (same reads)
 *   Local rankings            → M14 (src/lib/local/persist#readLocalHistory)
 *   ROI                       → M16 (src/lib/roi/reads)
 *   Alerts                    → M17 (src/lib/alerting/reads)
 *   Work-done log + calendar  → site_changes / content_items (the tenant's real
 *                               activity — additive read-only queries here)
 *
 * TENANT + CLIENT SCOPING IS THE DATABASE'S JOB. We pass a claim-scoped
 * Supabase client (anon key + the caller's cookies) to every read; RLS pins
 * each row to `tenant_id = app.tenant_id()` AND `app.client_scope(client_id)`
 * (migrations 0005/0006). A `client_viewer` reading its own client, or a staff
 * role reading any client IN ITS TENANT, both flow through the same policies —
 * app code never widens the scope, and a cross-tenant / cross-client id simply
 * yields zero rows (indistinguishable from "nothing here yet"). The one client
 * fetch below is what turns an out-of-scope id into a clean `notFound`.
 *
 * HONESTY RULE (dashboard-wide): each panel resolves to one of three states —
 * `ready` (real stored data), `pending` (no data source connected yet — most
 * modules today, deferred behind fail-closed vendor ports), or `failed` (a read
 * error — retryable). No panel EVER fabricates a value; `pending` is a designed
 * state, never a placeholder number.
 */

import { createClient } from "@/lib/supabase/server";
import {
  getLatestVisibilityScore,
  getVisibilityScoreSeries,
  getLatestShareOfVoice,
  type LatestShareOfVoice,
  type VisibilityRunScore,
} from "@/lib/intelligence/visibility/reads";
import { readLocalHistory } from "@/lib/local/persist";
import type { LocalHistoryEntry } from "@/lib/local/rows";
import {
  getLatestRoiSnapshot,
  getRoiAttribution,
  type RoiAttributionSnapshot,
  type RoiSnapshot,
} from "@/lib/roi/reads";
import { readActiveAlerts } from "@/lib/alerting/reads";
import type { ActiveAlertEntry } from "@/lib/alerting/rows";
import {
  CONTENT_ITEM_STATUSES,
  type ClientLocation,
  type ClientStatus,
  type ContentItemStatus,
  type ContentItemType,
  type SiteChangeStatus,
  type SiteChangeType,
} from "@/lib/types/db";
import type { Vertical } from "@/lib/types/playbook";

/** How many stored tracker runs to draw on the trend line. */
const TREND_MAX_RUNS = 30;
/** Rows pulled for the work-done log (merged, then trimmed for display). */
const WORK_LOG_FETCH = 16;
const WORK_LOG_SHOW = 8;
/** Recent content rows shown on the calendar panel. */
const CALENDAR_RECENT_SHOW = 6;

/**
 * The three honest panel states. `pending` carries no data by design — the
 * panel renders its "activates when connected" invitation, never a number.
 */
export type PanelState<T> =
  | { state: "ready"; data: T }
  | { state: "pending" }
  | { state: "failed" };

export interface ClientHeader {
  id: string;
  name: string;
  vertical: Vertical;
  status: ClientStatus;
  locations: ClientLocation[];
  createdAt: string;
}

export interface VisibilityPanel {
  latest: VisibilityRunScore;
  series: VisibilityRunScore[];
  truncated: boolean;
}

export interface RoiPanel {
  snapshot: RoiSnapshot;
  /** Null when there is no prior snapshot to attribute against. */
  attribution: RoiAttributionSnapshot | null;
}

export interface WorkLogEvent {
  id: string;
  kind: "site_change_applied" | "site_change_reverted" | "content_published";
  /** The change/content type — a plain noun the client recognises. */
  subject: string;
  at: string;
}

export interface ContentCalendarPanel {
  /** Exact per-status counts (DB HEAD counts — never derived from a fetched page). */
  byStatus: Record<ContentItemStatus, number>;
  total: number;
  recent: Array<{
    id: string;
    type: ContentItemType;
    status: ContentItemStatus;
    updatedAt: string;
  }>;
}

export interface ClientDashboardData {
  client: ClientHeader;
  visibility: PanelState<VisibilityPanel>;
  shareOfVoice: PanelState<LatestShareOfVoice>;
  local: PanelState<LocalHistoryEntry[]>;
  roi: PanelState<RoiPanel>;
  /** Alerts records PROBLEMS only — an empty feed is "no open alerts", never an all-clear. */
  alerts: PanelState<ActiveAlertEntry[]>;
  workLog: PanelState<WorkLogEvent[]>;
  content: PanelState<ContentCalendarPanel>;
}

export type ClientDashboardLoad =
  /** Env unset or the client fetch failed — render the degraded shell, never a 500. */
  | { ok: false }
  /** The id is not in the caller's scope (RLS returned nothing) — clean not-found. */
  | { ok: true; found: false }
  | { ok: true; found: true; data: ClientDashboardData };

type Supabase = Awaited<ReturnType<typeof createClient>>;

interface ClientHeaderRow {
  id: string;
  name: string;
  vertical: Vertical;
  status: ClientStatus;
  locations: ClientLocation[] | null;
  created_at: string;
}

/**
 * Load every panel for one client. Fails soft PER PANEL: a single module read
 * failing degrades only its own panel, so the rest of the dashboard still shows
 * real data (the honesty rule applies panel-by-panel, not all-or-nothing).
 */
export async function loadClientDashboard(
  clientId: string,
): Promise<ClientDashboardLoad> {
  let supabase: Supabase;
  try {
    supabase = await createClient();
  } catch {
    // Runtime env not provisioned (e.g. env-less build) — degrade, never 500.
    return { ok: false };
  }

  try {
    // The scope gate: RLS returns this row ONLY when the caller's tenant +
    // client_scope allow it. A non-existent OR out-of-scope id both land as
    // `null` here → a clean not-found (a client_viewer probing a sibling id
    // gets exactly this, never another client's data).
    const clientRes = await supabase
      .from("clients")
      .select("id, name, vertical, status, locations, created_at")
      .eq("id", clientId)
      .maybeSingle();
    if (clientRes.error) return { ok: false };
    if (!clientRes.data) return { ok: true, found: false };
    const row = clientRes.data as ClientHeaderRow;
    const client: ClientHeader = {
      id: row.id,
      name: row.name,
      vertical: row.vertical,
      status: row.status,
      locations: Array.isArray(row.locations) ? row.locations : [],
      createdAt: row.created_at,
    };

    const [
      latestVis,
      series,
      sov,
      local,
      roiLatest,
      roiAttribution,
      alerts,
      workLog,
      content,
    ] = await Promise.all([
      getLatestVisibilityScore(supabase, clientId),
      getVisibilityScoreSeries(supabase, clientId, { maxRuns: TREND_MAX_RUNS }),
      // Competitor set is sourced server-side at the wiring slice; until then it
      // is empty, so share-of-voice stays pending (no run + no competitors).
      getLatestShareOfVoice(supabase, clientId, []),
      readLocalHistory(supabase, clientId),
      getLatestRoiSnapshot(supabase, clientId),
      getRoiAttribution(supabase, clientId),
      readActiveAlerts(supabase, clientId),
      loadWorkLog(supabase, clientId),
      loadContentCalendar(supabase, clientId),
    ]);

    return {
      ok: true,
      found: true,
      data: {
        client,
        visibility: toVisibilityPanel(latestVis, series),
        shareOfVoice: toSovPanel(sov),
        local: toLocalPanel(local),
        roi: toRoiPanel(roiLatest, roiAttribution),
        alerts: toAlertsPanel(alerts),
        workLog,
        content,
      },
    };
  } catch {
    return { ok: false };
  }
}

/* ------------------------------------------------------------------ */
/* Panel-state mappers (read result → honest panel state)              */
/* ------------------------------------------------------------------ */

function toVisibilityPanel(
  latest: Awaited<ReturnType<typeof getLatestVisibilityScore>>,
  series: Awaited<ReturnType<typeof getVisibilityScoreSeries>>,
): PanelState<VisibilityPanel> {
  if (latest.kind === "failed") return { state: "failed" };
  if (latest.latest === null) return { state: "pending" };
  return {
    state: "ready",
    data: {
      latest: latest.latest,
      series: series.kind === "ok" ? series.series : [latest.latest],
      truncated: series.kind === "ok" ? series.truncated : false,
    },
  };
}

function toSovPanel(
  sov: Awaited<ReturnType<typeof getLatestShareOfVoice>>,
): PanelState<LatestShareOfVoice> {
  if (sov.kind === "failed") return { state: "failed" };
  if (sov.latest === null) return { state: "pending" };
  return { state: "ready", data: sov.latest };
}

function toLocalPanel(
  local: Awaited<ReturnType<typeof readLocalHistory>>,
): PanelState<LocalHistoryEntry[]> {
  if (!local.ok) return { state: "failed" };
  if (local.entries.length === 0) return { state: "pending" };
  return { state: "ready", data: local.entries };
}

function toRoiPanel(
  latest: Awaited<ReturnType<typeof getLatestRoiSnapshot>>,
  attribution: Awaited<ReturnType<typeof getRoiAttribution>>,
): PanelState<RoiPanel> {
  if (latest.kind === "failed") return { state: "failed" };
  if (latest.latest === null) return { state: "pending" };
  return {
    state: "ready",
    data: {
      snapshot: latest.latest,
      attribution:
        attribution.kind === "ok" ? attribution.attribution : null,
    },
  };
}

function toAlertsPanel(
  alerts: Awaited<ReturnType<typeof readActiveAlerts>>,
): PanelState<ActiveAlertEntry[]> {
  if (!alerts.ok) return { state: "failed" };
  // An empty feed is a real, honest "ready" (no open alerts) — not pending.
  return { state: "ready", data: alerts.entries };
}

/* ------------------------------------------------------------------ */
/* Work-done log — the retention weapon: what we actually did          */
/* ------------------------------------------------------------------ */

const APPLIED_SITE_STATUSES: readonly SiteChangeStatus[] = ["applied"];
const REVERTED_SITE_STATUSES: readonly SiteChangeStatus[] = [
  "reverted",
  "auto_reverted",
];

interface SiteChangeLogRow {
  id: string;
  change_type: SiteChangeType;
  status: SiteChangeStatus;
  applied_at: string | null;
  reverted_at: string | null;
  created_at: string;
}

interface PublishedContentRow {
  id: string;
  type: ContentItemType;
  updated_at: string;
}

/**
 * The work-done log unifies the two client-visible proofs of work: on-site
 * changes we APPLIED (and, honestly, any we reverted) and content we PUBLISHED.
 * Both are already tenant + client scoped by RLS; we only merge and sort. Only
 * real, committed actions appear — a previewed-but-unapplied change did nothing
 * to the live site, so it is never counted (mirrors the ROI work-event rule).
 */
async function loadWorkLog(
  supabase: Supabase,
  clientId: string,
): Promise<PanelState<WorkLogEvent[]>> {
  const [changesRes, publishedRes] = await Promise.all([
    supabase
      .from("site_changes")
      .select("id, change_type, status, applied_at, reverted_at, created_at")
      .eq("client_id", clientId)
      .in("status", [...APPLIED_SITE_STATUSES, ...REVERTED_SITE_STATUSES])
      .order("created_at", { ascending: false })
      .limit(WORK_LOG_FETCH),
    supabase
      .from("content_items")
      .select("id, type, updated_at")
      .eq("client_id", clientId)
      .eq("status", "published")
      .order("updated_at", { ascending: false })
      .limit(WORK_LOG_FETCH),
  ]);
  if (changesRes.error || publishedRes.error) return { state: "failed" };

  const events: WorkLogEvent[] = [];
  for (const row of (changesRes.data ?? []) as SiteChangeLogRow[]) {
    const applied = APPLIED_SITE_STATUSES.includes(row.status);
    events.push({
      id: row.id,
      kind: applied ? "site_change_applied" : "site_change_reverted",
      subject: row.change_type,
      at:
        (applied ? row.applied_at : row.reverted_at) ??
        row.applied_at ??
        row.created_at,
    });
  }
  for (const row of (publishedRes.data ?? []) as PublishedContentRow[]) {
    events.push({
      id: row.id,
      kind: "content_published",
      subject: row.type,
      at: row.updated_at,
    });
  }

  if (events.length === 0) return { state: "pending" };
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { state: "ready", data: events.slice(0, WORK_LOG_SHOW) };
}

/* ------------------------------------------------------------------ */
/* Content calendar — the pipeline, honestly counted                   */
/* ------------------------------------------------------------------ */

interface RecentContentRow {
  id: string;
  type: ContentItemType;
  status: ContentItemStatus;
  updated_at: string;
}

/**
 * The content calendar reports the pipeline distribution (exact HEAD counts per
 * status, so a number is never derived from a capped page) plus the most
 * recently touched items. `content_items` has no scheduled-publish column in the
 * frozen schema, so the panel presents STATUS + last-touched, and the panel copy
 * is honest that scheduled dates arrive with the social queue (M11).
 */
async function loadContentCalendar(
  supabase: Supabase,
  clientId: string,
): Promise<PanelState<ContentCalendarPanel>> {
  const countOf = (status: ContentItemStatus) =>
    supabase
      .from("content_items")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId)
      .eq("status", status);

  const [countsRes, recentRes] = await Promise.all([
    Promise.all(CONTENT_ITEM_STATUSES.map((status) => countOf(status))),
    supabase
      .from("content_items")
      .select("id, type, status, updated_at")
      .eq("client_id", clientId)
      .order("updated_at", { ascending: false })
      .limit(CALENDAR_RECENT_SHOW),
  ]);
  if (countsRes.some((r) => r.error || r.count === null) || recentRes.error) {
    return { state: "failed" };
  }

  const byStatus = Object.fromEntries(
    CONTENT_ITEM_STATUSES.map((status, i) => [status, countsRes[i].count ?? 0]),
  ) as Record<ContentItemStatus, number>;
  const total = CONTENT_ITEM_STATUSES.reduce((sum, s) => sum + byStatus[s], 0);
  if (total === 0) return { state: "pending" };

  return {
    state: "ready",
    data: {
      byStatus,
      total,
      recent: ((recentRes.data ?? []) as RecentContentRow[]).map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        updatedAt: r.updated_at,
      })),
    },
  };
}
