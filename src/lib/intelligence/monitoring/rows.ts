/**
 * M5 → `alerts` row mapping (frozen schema: supabase/migrations/0006, the
 * `alerts` table). Pure — no server imports, no Supabase client — so it is
 * unit-tested in the default run; persist.ts feeds these rows to PostgREST.
 *
 * ── WHY `alerts`, and how M5 maps onto it (the mapping decision) ─────────────
 * doc 07 §1.8 (M17) lists "crawler blocked" as an alert class, and the frozen
 * `alerts.type` CHECK includes `crawler_blocked`. A newly-detected AI-crawler
 * BLOCK and a render-visibility RISK are both exactly that class ("an AI engine
 * cannot read this content"), so BOTH map to `type = 'crawler_blocked'`,
 * distinguished by `payload.kind`. No new table is invented.
 *
 * ── DEDUP (what the frozen schema supports, and its limit) ──────────────────
 * `alerts` has NO dedup key column and NO property_id column — it is
 * client-scoped. So M5 carries `propertyId` and a stable `fingerprint` INSIDE
 * `payload`, and persist.ts dedups in application code by scanning recent OPEN
 * alerts for a matching fingerprint (a standing block does not spam a new alert
 * each run). ⚑ A partial unique index on
 * `(tenant_id, client_id, type, (payload->>'fingerprint')) where not acknowledged`
 * would make this atomic and race-free — flagged for the Orchestrator (post-freeze),
 * mirroring how M3 flagged its missing run-metadata table.
 *
 * Scoping ids (tenant_id / client_id) are pinned by the caller from
 * claim-/RLS-sourced values and re-pinned below us by RLS (`alerts_insert`,
 * migration 0006) plus the composite FK (tenant, client) → clients.
 */

import type { PropertyMonitorReport } from "./types";

export type AlertSeverity = "info" | "warning" | "critical";

/** Which M5 finding a `crawler_blocked` alert row represents. */
export type MonitorAlertKind = "crawler_block" | "render_risk";

/** Cap on URL/crawler lists stored in a payload — bounded rows. */
const MAX_ALERT_ITEMS = 50;

/** One blocked crawler, as stored in a crawler_block payload. */
export interface BlockedCrawlerRef {
  botId: string;
  operator: string;
  blockedPaths: string[];
}

/** The `alerts.payload` jsonb shape M5 writes. */
export interface MonitorAlertPayload {
  kind: MonitorAlertKind;
  /** Stable dedup key (see persist.ts). Encodes kind + property + the finding set. */
  fingerprint: string;
  propertyId: string;
  baseUrl: string;
  /** The pass timestamp (deterministic — the report's crawledAt). */
  detectedAt: string;
  /** Human-readable, non-sensitive one-liner for the dashboard/notification. */
  summary: string;
  /** crawler_block only: the crawlers blocked and where. */
  blockedCrawlers?: BlockedCrawlerRef[];
  /** render_risk only: the JS-dependent page URLs. */
  jsDependentUrls?: string[];
}

/** Insert shape for `alerts` (migration 0006 — only the caller-set columns). */
export interface AlertInsertRow {
  tenant_id: string;
  client_id: string;
  type: "crawler_blocked";
  severity: AlertSeverity;
  payload: MonitorAlertPayload;
}

function crawlerBlockFingerprint(propertyId: string, blockedBotIds: string[]): string {
  return `crawler_block|${propertyId}|${[...blockedBotIds].sort().join(",")}`;
}

function renderRiskFingerprint(propertyId: string, jsDependentUrls: string[]): string {
  return `render_risk|${propertyId}|${[...jsDependentUrls].sort().join(",")}`;
}

/**
 * Map a property report to the `alerts` rows it warrants (0, 1, or 2 rows):
 *  - a `crawler_block` row iff ≥1 crawler is `blocked`;
 *  - a `render_risk` row iff ≥1 crawled page is `js_dependent`.
 * `unknown` verdicts NEVER produce an alert (honesty: unknown ≠ blocked).
 */
export function monitorAlertRows(args: {
  tenantId: string;
  clientId: string;
  propertyId: string;
  report: PropertyMonitorReport;
}): AlertInsertRow[] {
  const { tenantId, clientId, propertyId, report } = args;
  const rows: AlertInsertRow[] = [];

  if (report.hasCrawlerBlock) {
    const blocked = report.crawlers.filter((verdict) => verdict.access === "blocked");
    const blockedCrawlers: BlockedCrawlerRef[] = blocked.slice(0, MAX_ALERT_ITEMS).map((verdict) => ({
      botId: verdict.botId,
      operator: verdict.operator,
      blockedPaths: verdict.blockedPaths,
    }));
    // Critical when a citation-relevant crawler (search / user-fetch / the four
    // doc-named bots) is blocked — that removes the property from an AI ANSWER
    // surface. A training-only third-party block is a warning.
    const severity: AlertSeverity = blocked.some((verdict) => verdict.citationRelevant) ? "critical" : "warning";
    const botIds = blocked.map((verdict) => verdict.botId);
    rows.push({
      tenant_id: tenantId,
      client_id: clientId,
      type: "crawler_blocked",
      severity,
      payload: {
        kind: "crawler_block",
        fingerprint: crawlerBlockFingerprint(propertyId, botIds),
        propertyId,
        baseUrl: report.baseUrl,
        detectedAt: report.crawledAt,
        summary: `robots.txt blocks ${botIds.length} AI crawler(s): ${[...botIds].sort().join(", ")}`,
        blockedCrawlers,
      },
    });
  }

  if (report.hasRenderRisk) {
    const urls = report.render.jsDependentUrls.slice(0, MAX_ALERT_ITEMS);
    // Critical when EVERY crawled page is JS-dependent (nothing is visible);
    // otherwise a warning (some pages are readable).
    const allInvisible = report.render.visibleCount === 0;
    const severity: AlertSeverity = allInvisible ? "critical" : "warning";
    rows.push({
      tenant_id: tenantId,
      client_id: clientId,
      type: "crawler_blocked",
      severity,
      payload: {
        kind: "render_risk",
        fingerprint: renderRiskFingerprint(propertyId, report.render.jsDependentUrls),
        propertyId,
        baseUrl: report.baseUrl,
        detectedAt: report.crawledAt,
        summary: `${report.render.jsDependentCount} page(s) need client-side JS to render — invisible to most AI crawlers`,
        jsDependentUrls: urls,
      },
    });
  }

  return rows;
}

/* ------------------------------------------------------------------ */
/* Status read parsing (defensive jsonb)                               */
/* ------------------------------------------------------------------ */

/** One entry in the latest crawler/render status read (see reads.ts). */
export interface CrawlerRenderStatusEntry {
  alertId: string;
  kind: MonitorAlertKind | null;
  severity: string;
  propertyId: string | null;
  baseUrl: string | null;
  summary: string | null;
  blockedCrawlers: BlockedCrawlerRef[] | null;
  jsDependentUrls: string[] | null;
  detectedAt: string | null;
  acknowledged: boolean;
  createdAt: string;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string").slice(0, MAX_ALERT_ITEMS);
}

function blockedCrawlersOrNull(value: unknown): BlockedCrawlerRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs: BlockedCrawlerRef[] = [];
  for (const item of value.slice(0, MAX_ALERT_ITEMS)) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const botId = stringOrNull(rec.botId);
    if (botId === null) continue;
    refs.push({
      botId,
      operator: stringOrNull(rec.operator) ?? "",
      blockedPaths: stringArrayOrNull(rec.blockedPaths) ?? [],
    });
  }
  return refs;
}

/**
 * Shape a raw `alerts` row (RLS-scoped read) into a status entry. Defensive:
 * a malformed/hostile jsonb payload maps every field it can't read to
 * null/[] — a status read reports what was stored, it never throws or guesses.
 */
export function crawlerRenderStatusEntry(row: {
  id: string;
  severity: string;
  payload: unknown;
  acknowledged: boolean;
  created_at: string;
}): CrawlerRenderStatusEntry {
  const payload = (typeof row.payload === "object" && row.payload !== null ? row.payload : {}) as Record<string, unknown>;
  const kindRaw = payload.kind;
  const kind: MonitorAlertKind | null =
    kindRaw === "crawler_block" || kindRaw === "render_risk" ? kindRaw : null;
  return {
    alertId: row.id,
    kind,
    severity: row.severity,
    propertyId: stringOrNull(payload.propertyId),
    baseUrl: stringOrNull(payload.baseUrl),
    summary: stringOrNull(payload.summary),
    blockedCrawlers: blockedCrawlersOrNull(payload.blockedCrawlers),
    jsDependentUrls: stringArrayOrNull(payload.jsDependentUrls),
    detectedAt: stringOrNull(payload.detectedAt),
    acknowledged: row.acknowledged === true,
    createdAt: row.created_at,
  };
}
