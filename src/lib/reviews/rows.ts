/**
 * Pure ReviewSignal ⇄ `metrics` row mapping + the M15 SCHEMA-GAP flags (FROZEN
 * schema, migrations 0005/0006). No server imports, no Supabase client — unit-
 * tested in the default run; ./persist feeds these rows to PostgREST and shapes
 * reads back through them. Mirrors the M8/M9 rows split.
 *
 * ── PERSISTENCE DECISION (against the FROZEN schema; M3/M4 precedent) ──────────
 * The frozen F1 schema has NO `reviews` table and NO `review_response` content
 * type (content_items.type CHECK = blog|faq|caption|pillar|schema_copy,
 * migration 0005). So M15 does NOT force a wrong shape (exactly as M8 refuses to
 * persist a draft under the wrong type). Three honest outcomes:
 *
 *  1. The review SIGNAL (sentiment distribution + velocity, counts + platforms +
 *     window) HAS an honest home: `metrics` with source='reviews' (migration
 *     0006 enumerates 'reviews' for exactly this — external measurement captures).
 *     This is the M3 precedent (persist the normalized SIGNAL, not the raw vendor
 *     data), and it is what feeds M17's negative_review_spike + local rankings.
 *     Claim-sourced tenant + the `metrics_insert` RLS floor re-pin scope below us.
 *  2. INDIVIDUAL reviews (text/author/rating/date) have NO honest home (no
 *     `reviews` table) → NOT persisted (M4 precedent: persist nothing, flag the
 *     gap). They are input material for the signal, like a vendor citation payload
 *     that never lands in a table — only the normalized aggregate does.
 *  3. DRAFTED review RESPONSES have NO honest home (no review_response content
 *     type) → NOT persisted; the draft + its report ride back in the action result
 *     for the Quality/Compliance gates (as M8's GenerationReport does). Flagged.
 *
 * The metrics.data payload carries COUNTS + platform coverage + window ONLY — no
 * individual review text/author (no PII persisted, and none is needed).
 */

import type { MetricSource } from "@/lib/types/db";
import { REVIEW_METRIC_SOURCE, type ReviewSignal } from "./types";

/* ------------------------------------------------------------------ */
/* Greppable schema-gap flags (Orchestrator/docs agent — M3/M4/M8/M10 precedent) */
/* ------------------------------------------------------------------ */

export const REVIEWS_TABLE_GAP =
  "No `reviews` table exists in the frozen F1 schema (migrations 0001–0006), so individual " +
  "ingested reviews (text/author/rating/date/platform) have no honest persistence home. M15 " +
  "persists only the normalized review SIGNAL (to metrics, source='reviews'); raw reviews are " +
  "input material, not stored (M4 precedent). Proposed addition: a tenant-scoped, RLS'd `reviews` " +
  "table — post-freeze Orchestrator + Code Review path (CLAUDE.md rule 1).";

export const REVIEW_RESPONSE_CONTENT_TYPE_GAP =
  "content_items.type CHECK (migration 0005) is blog|faq|caption|pillar|schema_copy — it has NO " +
  "'review_response' type, so a drafted review response cannot be persisted to content_items " +
  "without forcing a wrong type (which M8 refuses on principle). M15 returns the draft + report in " +
  "the action result (un-persisted) for the gates. Proposed post-freeze options: add " +
  "'review_response' to content_items.type, OR a dedicated `review_responses` table — Orchestrator " +
  "+ Code Review path.";

export const REVIEW_RESPONSE_GENERATION_TYPE_GAP =
  "M8's generation taxonomy (GeneratableContentType = blog|faq|pillar) has no 'review_response' " +
  "type, so the review-reply generation spec uses 'faq' as the nearest structural analog (a short " +
  "direct-answer reply). The authoritative type rides in the spec topic directive + the report " +
  "responseType + the 'review_response' compliance pre-screen. Proposed follow-up: a dedicated " +
  "generation content type, coordinated with the M8 owner.";

/* ------------------------------------------------------------------ */
/* metrics(source='reviews') insert                                    */
/* ------------------------------------------------------------------ */

/** The `metrics.data` jsonb M15 writes — the self-describing review signal (counts only). */
export interface ReviewSignalMetricData {
  /** Bumps if the persisted shape changes (defensive read tolerance). */
  schemaVersion: 1;
  signal: ReviewSignal;
}

/** Insert shape for `metrics` — ONLY the columns M15 sets (captured_at defaults in-DB). */
export interface ReviewMetricInsertRow {
  tenant_id: string;
  client_id: string;
  /** Always 'reviews' — pinned, not a parameter (M15 never writes another source). */
  source: typeof REVIEW_METRIC_SOURCE;
  data: ReviewSignalMetricData;
}

/**
 * Build the `metrics` row for ONE review-signal capture. `tenantId` is
 * CLAIM-SOURCED; `clientId` is RLS-sourced by the action; RLS (`metrics_insert` =
 * tenant + is_writer) + the composite FK (tenant, client) → clients re-pin scope
 * below us, so a row can never land outside the caller's tenant/client. `source`
 * is hard-pinned to 'reviews'.
 */
export function reviewSignalMetricRow(args: {
  tenantId: string;
  clientId: string;
  signal: ReviewSignal;
}): ReviewMetricInsertRow {
  return {
    tenant_id: args.tenantId,
    client_id: args.clientId,
    source: REVIEW_METRIC_SOURCE,
    data: { schemaVersion: 1, signal: args.signal },
  };
}

/* ------------------------------------------------------------------ */
/* Read-side: the review-signal queue (dashboard + M17 + the gates)    */
/* ------------------------------------------------------------------ */

/** One review-signal history point — the lean shape for the dashboard/queue. */
export interface ReviewSignalEntry {
  id: string;
  capturedAt: string;
  /** The persisted signal, or null when the row's data jsonb is missing/corrupt. */
  signal: ReviewSignal | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape a raw `metrics` row (RLS-scoped, source='reviews') into a lean entry.
 * Trusted-by-construction (we wrote the jsonb through the validated builder), so
 * the parse is light — but a structurally corrupt `data` yields `signal: null`
 * rather than a thrown read (a malformed row must never crash the queue).
 */
export function reviewSignalEntry(row: {
  id: string;
  source: MetricSource;
  data: unknown;
  captured_at: string;
}): ReviewSignalEntry {
  const data = isObject(row.data) ? row.data : null;
  const signal = data && isObject(data.signal) ? (data.signal as unknown as ReviewSignal) : null;
  return { id: row.id, capturedAt: row.captured_at, signal };
}
