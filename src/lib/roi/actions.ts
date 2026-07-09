"use server";

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { createClient } from "@/lib/supabase/server";
import {
  summarizeOutcomes,
  type OutcomeSummary,
} from "./attribution";
import { collectOutcomes, type CollectionCoverage } from "./collect";
import { HOMED_ROI_SOURCES } from "./normalize";
import { persistRoiCaptures } from "./persist";
import { resolveRoiSources } from "./provider";
import type { OutcomePeriod, RoiSourceId } from "./sources";
import { logPartialCollection } from "./telemetry";

/**
 * M16 ROI / attribution — the collect server action (doc 05 §M16; doc 07 §1.8).
 * Gathers a client's outcome sources over a period via the RoiSource ports,
 * persists the HOMED raw captures append-only (`metrics`, migration 0006), and
 * returns the snapshot with STRUCTURAL coverage honesty. Same security posture
 * as the visibility run action:
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends
 *    a clientId (+ a period); the tenant comes from the caller's VERIFIED JWT
 *    claim, and RLS (`metrics_insert`, migration 0006) re-pins every row.
 *  - WRITE RIGHTS ARE STAFF (`requireOperator`: agency_admin | operator) —
 *    mirroring the RLS floor (`app.is_writer()`). A client_viewer reads its ROI
 *    panel (reads.ts) but never runs a collection.
 *
 * HONESTY CONTRACT:
 *  - An unconnected source is ABSENT in the coverage, never a zero.
 *  - A homed capture that can't be stored fails typed (write_failed); a partial
 *    collection says so structurally (coverage) and in interface voice.
 *  - Un-homed sources (form_fills/crm — no `metrics.source`, ⚑ normalize.ts)
 *    are surfaced in `unhomed`, never mis-filed under another source.
 *  - No attribution/ROI is computed here — the schema has no home for a stored
 *    synthesis; attribution is recomputed at read time (reads.ts).
 */

const FORBIDDEN_ERROR =
  "You don’t have permission to collect ROI data — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const INVALID_PERIOD_ERROR =
  "We couldn’t read the reporting window, so we didn’t collect anything. Pick a start and end date and try again.";
const LOOKUP_FAILED_ERROR =
  "We couldn’t load that client. Check your connection and try again — nothing was collected.";
const WRITE_FAILED_ERROR =
  "We gathered the outcome data but couldn’t save it, so it isn’t part of the trend line. Run the collection again — nothing partial was stored.";
const NO_SOURCES_WARNING =
  "No outcome sources are connected yet, so there’s nothing to record. Connect GA4, Search Console, or call tracking to start measuring ROI.";

/** Cap the window so a hostile/absurd span never reaches the ports or storage. */
const MAX_PERIOD_DAYS = 366;
const DAY_MS = 86_400_000;

/**
 * FROZEN CONTRACT — the dashboard wiring slice consumes this exact shape.
 * Post-handoff changes require Orchestrator + Code Review sign-off.
 */
export interface RoiCollectionSummary {
  /** Snapshot key — equals every stored row's captured_at. */
  capturedAt: string;
  /** The window the collected metrics cover. */
  period: OutcomePeriod;
  /** Structural per-source coverage (contributing / absent / failed). */
  coverage: CollectionCoverage;
  /** Recomputed outcome summary over the homed sources (absent ≠ zero). */
  summary: OutcomeSummary;
  /** Homed rows stored in `metrics`. */
  persisted: number;
  /** Sources that measured but have no schema home yet (the flagged gap). */
  unhomed: RoiSourceId[];
}

export type CollectRoiSnapshotResult =
  | { ok: true; snapshot: RoiCollectionSummary; warning?: string }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "invalid_period" | "lookup_failed" | "write_failed";
      error: string;
    };

/** Validate the caller-supplied window — junk never reaches the ports/storage. */
function sanitizePeriod(raw: unknown): OutcomePeriod | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const start = typeof record.start === "string" ? record.start : "";
  const end = typeof record.end === "string" ? record.end : "";
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (startMs >= endMs) return null;
  if (endMs - startMs > MAX_PERIOD_DAYS * DAY_MS) return null;
  // No far-future windows (small clock-skew grace).
  if (startMs > Date.now() + DAY_MS) return null;
  return { start, end };
}

export async function collectRoiSnapshot(input: {
  clientId: string;
  period: { start: string; end: string };
}): Promise<CollectRoiSnapshotResult> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }
  const period = sanitizePeriod(input?.period);
  if (period === null) {
    return { ok: false, reason: "invalid_period", error: INVALID_PERIOD_ERROR };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .maybeSingle();
  if (error) {
    return { ok: false, reason: "lookup_failed", error: LOOKUP_FAILED_ERROR };
  }
  if (!data) {
    // RLS-scoped read empty: nonexistent id and another tenant's id are the
    // SAME observation here — correct and intended (doc 03 §4).
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }

  const resolved = resolveRoiSources();
  const collection = await collectOutcomes(resolved, period);
  const capturedAt = new Date().toISOString();

  // Claim-sourced tenant — NEVER from the client payload. RLS re-pins below us.
  const persisted = await persistRoiCaptures(
    supabase,
    claims.tenantId,
    clientId,
    collection,
    capturedAt,
  );
  if (persisted.kind === "failed") {
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
  const rows = persisted.kind === "persisted" ? persisted.rows : 0;
  const unhomed = persisted.unhomed;

  const degraded =
    collection.coverage.failed.length > 0 ||
    unhomed.length > 0 ||
    collection.coverage.absent.length > 0;
  if (degraded) {
    logPartialCollection({
      requested: collection.coverage.requested.length,
      contributing: collection.coverage.contributing.length,
      absent: collection.coverage.absent.length,
      failed: collection.coverage.failed.length,
      unhomed: unhomed.length,
    });
  }

  const snapshot: RoiCollectionSummary = {
    capturedAt,
    period,
    coverage: collection.coverage,
    summary: summarizeOutcomes(collection.samples, HOMED_ROI_SOURCES),
    persisted: rows,
    unhomed,
  };

  if (collection.coverage.contributing.length === 0) {
    return { ok: true, snapshot, warning: NO_SOURCES_WARNING };
  }
  if (collection.coverage.failed.length > 0) {
    return {
      ok: true,
      snapshot,
      warning: `Some sources didn’t answer this run — the figures reflect only what was measured. Collect again to fill the gaps.`,
    };
  }
  return { ok: true, snapshot };
}
