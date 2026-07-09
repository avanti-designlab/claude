/**
 * M17 → `alerts` row mapping (frozen schema: supabase/migrations/0006). PURE —
 * no server imports, no Supabase client — unit-tested in the default run;
 * persist.ts / sink.ts feed these rows to PostgREST.
 *
 * ── PAYLOAD + DEDUP (mirrors M5's rows.ts contract) ─────────────────────────
 * The frozen `alerts` table has NO dedup-key column and NO property_id column
 * (it is client-scoped). So — exactly like M5 — every row carries a stable
 * `fingerprint` INSIDE `payload`, and persist.ts dedups in application code by
 * scanning open alerts of the same type for a matching fingerprint. The
 * fingerprint encodes the STANDING CONDITION, not the magnitude, so a condition
 * that persists across runs does not spam a new alert each run (M5 precedent).
 * The magnitude lives in the payload for the dashboard. ⚑ A partial unique index
 * on `(tenant_id, client_id, type, (payload->>'fingerprint')) where not
 * acknowledged` would make dedup atomic/race-free — the SAME flag M5 raised;
 * one shared index would cover both. Flagged for the Orchestrator (post-freeze).
 */

import type { AlertSeverity, AlertType, M17WriterAlertType } from "./types";

/** Cap on any list stored in a payload — bounded rows (mirrors M5). */
export const MAX_ALERT_ITEMS = 50;

/** Insert shape for `alerts` (migration 0006 — only the caller-set columns). */
export interface AlertInsertRow {
  tenant_id: string;
  client_id: string;
  type: AlertType;
  severity: AlertSeverity;
  payload: AlertPayload;
}

/* ------------------------------------------------------------------ */
/* Payloads — one per class; all share the M5-style common core.       */
/* ------------------------------------------------------------------ */

interface AlertPayloadBase {
  /** Discriminant = the alert class (matches the row `type`). */
  kind: AlertType;
  /** Stable dedup key — encodes the STANDING CONDITION (see module header). */
  fingerprint: string;
  /** Human-readable, non-sensitive one-liner for the dashboard/notification. */
  summary: string;
  /** When the signal was measured (deterministic — caller-supplied ISO). */
  detectedAt: string;
}

export interface VisibilityDropPayload extends AlertPayloadBase {
  kind: "visibility_drop";
  previousScore: number;
  latestScore: number;
  pointsDropped: number;
  previousRunAt: string;
  latestRunAt: string;
}

export interface CompetitorOvertookPayload extends AlertPayloadBase {
  kind: "competitor_overtook";
  competitorName: string;
  clientShare: number;
  competitorShare: number;
  latestRunAt: string;
}

export interface SchemaBrokePayload extends AlertPayloadBase {
  kind: "schema_broke";
  propertyId: string;
  pageUrl: string;
  schemaType: string;
  detail: string;
}

export interface ReviewSpikePayload extends AlertPayloadBase {
  kind: "negative_review_spike";
  platform: string;
  negativeCount: number;
  windowDays: number;
  baselineNegativePerWindow: number;
}

export interface SiteDownPayload extends AlertPayloadBase {
  kind: "site_down";
  propertyId: string;
  baseUrl: string;
  httpStatus: number | null;
}

export interface AutoRollbackPayload extends AlertPayloadBase {
  kind: "auto_rollback_fired";
  /** The reverted change (dedup key basis — one alert per rollback event). */
  changeId: string;
}

export type AlertPayload =
  | VisibilityDropPayload
  | CompetitorOvertookPayload
  | SchemaBrokePayload
  | ReviewSpikePayload
  | SiteDownPayload
  | AutoRollbackPayload;

/* ------------------------------------------------------------------ */
/* Fingerprints — STANDING-CONDITION keys (not magnitude-keyed).       */
/* ------------------------------------------------------------------ */

/** One open visibility-drop per client at a time (condition = "score depressed"). */
export function visibilityDropFingerprint(clientId: string): string {
  return `visibility_drop|${clientId}`;
}

/** One open overtaken-by per (client, competitor). */
export function competitorOvertookFingerprint(clientId: string, competitorName: string): string {
  return `competitor_overtook|${clientId}|${competitorName}`;
}

/** One open broken-schema per (property, page, schema type). */
export function schemaBrokeFingerprint(propertyId: string, pageUrl: string, schemaType: string): string {
  return `schema_broke|${propertyId}|${pageUrl}|${schemaType}`;
}

/** One open review spike per (client, platform). */
export function reviewSpikeFingerprint(clientId: string, platform: string): string {
  return `negative_review_spike|${clientId}|${platform}`;
}

/** One open site-down per property. */
export function siteDownFingerprint(propertyId: string): string {
  return `site_down|${propertyId}`;
}

/**
 * One alert per rollback EVENT (keyed to the reverted change), NOT a standing
 * condition — so a re-emit of the same rollback is idempotent (deduped), while
 * a rollback of a DIFFERENT change is a distinct event that alerts.
 */
export function autoRollbackFingerprint(changeId: string): string {
  return `auto_rollback_fired|${changeId}`;
}

/* ------------------------------------------------------------------ */
/* Feed read parsing (defensive jsonb — mirrors M5's status parse).    */
/* ------------------------------------------------------------------ */

/** The frozen `alerts.type` value set — for defensive read narrowing. */
const ALERT_TYPES: readonly AlertType[] = [
  "visibility_drop",
  "competitor_overtook",
  "schema_broke",
  "crawler_blocked",
  "negative_review_spike",
  "site_down",
  "auto_rollback_fired",
];

/** The frozen `alerts.severity` value set. */
const ALERT_SEVERITIES: readonly AlertSeverity[] = ["info", "warning", "critical"];

/** One entry in the unified active-alerts feed (reads.ts). */
export interface ActiveAlertEntry {
  alertId: string;
  /** null only if a stored row somehow carries a type outside the frozen CHECK. */
  type: AlertType | null;
  severity: AlertSeverity | null;
  /** Safe, extracted payload fields only — NEVER the raw jsonb (avoid leaking hostile payloads). */
  summary: string | null;
  fingerprint: string | null;
  detectedAt: string | null;
  acknowledged: boolean;
  createdAt: string;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function narrow<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Shape a raw `alerts` row (RLS-scoped read) into a feed entry. Defensive: a
 * malformed/hostile jsonb payload maps every field it can't read to null — a
 * feed read reports what was stored, it never throws or guesses, and it never
 * echoes the raw payload verbatim (only named, string-checked fields).
 */
export function activeAlertEntry(row: {
  id: string;
  type: unknown;
  severity: unknown;
  payload: unknown;
  acknowledged: unknown;
  created_at: string;
}): ActiveAlertEntry {
  const payload = (typeof row.payload === "object" && row.payload !== null ? row.payload : {}) as Record<string, unknown>;
  return {
    alertId: row.id,
    type: narrow(row.type, ALERT_TYPES),
    severity: narrow(row.severity, ALERT_SEVERITIES),
    summary: stringOrNull(payload.summary),
    fingerprint: stringOrNull(payload.fingerprint),
    detectedAt: stringOrNull(payload.detectedAt),
    acknowledged: row.acknowledged === true,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* Writer-type guard (no-double-write — see persist.ts).               */
/* ------------------------------------------------------------------ */

/**
 * The five frozen types M17 ORIGINATES. `crawler_blocked` (M5) and
 * `auto_rollback_fired` (change-mgmt) are DELIBERATELY excluded — the writer
 * persistence path refuses them so M17 can never double-write another owner's
 * class. (`auto_rollback_fired` reaches `alerts` only through ./sink, the single
 * persistence path for the event change-management already fired.)
 */
export const M17_WRITER_ALERT_TYPES: readonly M17WriterAlertType[] = [
  "visibility_drop",
  "competitor_overtook",
  "schema_broke",
  "negative_review_spike",
  "site_down",
];

export function isWriterAlertType(type: string): type is M17WriterAlertType {
  return (M17_WRITER_ALERT_TYPES as readonly string[]).includes(type);
}
