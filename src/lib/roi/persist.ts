import "server-only";

/**
 * M16 ROI / attribution — capture persistence into the frozen `metrics` table
 * (supabase/migrations/0006; contract §5). Like visibility/persist.ts this is
 * deliberately NOT a "use server" module: exporting helpers from an action file
 * would mint browser-invokable RPC endpoints. Only the audited action imports
 * it. Every caller passes a claim-scoped Supabase client and a CLAIM-SOURCED
 * tenantId (never anything the browser sent); RLS (`metrics_insert`, migration
 * 0006: `tenant_id = app.tenant_id() and app.is_writer()`) re-pins tenant_id
 * below us regardless — a row can never land outside the caller's tenant.
 *
 * WHAT IS STORED (honesty):
 *  - Raw MEASURED captures for HOMED sources only (ga4/gsc/call_tracking).
 *    form_fills/crm have no `metrics.source` home yet (⚑ normalize.ts) — they
 *    are REFUSED and reported structurally as `unhomed`, never mis-filed.
 *  - The computed attribution/ROI synthesis is NOT stored (the schema has no
 *    home for it) — it is recomputed at read time (reads.ts) from these rows.
 *  - Every homed capture for one collection is pinned to ONE `captured_at`
 *    (the snapshot key, the visibility-run discipline) and written in ONE
 *    insert statement — a snapshot is stored whole or not at all.
 */

import type { createClient } from "@/lib/supabase/server";
import type { RoiCollection } from "./collect";
import {
  toMetricCaptureInsert,
  type MetricCaptureInsert,
} from "./normalize";
import type { RoiSourceId } from "./sources";
import { logRoiWriteFailure } from "./telemetry";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

export type PersistRoiCapturesOutcome =
  /** Homed captures stored (one statement). `unhomed` names sources with no schema home. */
  | { kind: "persisted"; rows: number; capturedAt: string; unhomed: RoiSourceId[] }
  /** Nothing homed to store this snapshot (all sources absent/failed/empty/unhomed). */
  | { kind: "nothing_homed"; unhomed: RoiSourceId[] }
  /** A write failed — retryable; nothing partial was stored. */
  | { kind: "failed" };

/**
 * Persist a collection's homed captures. `capturedAt` is the snapshot key —
 * pinned identically on every row so reads group runs on it (the frozen schema
 * has no run id; (tenant, client, source, captured_at) is the key).
 */
export async function persistRoiCaptures(
  supabase: Supabase,
  tenantId: string,
  clientId: string,
  collection: RoiCollection,
  capturedAt: string,
): Promise<PersistRoiCapturesOutcome> {
  if (!Number.isFinite(Date.parse(capturedAt))) {
    // A junk snapshot key would make the capture unidentifiable in history —
    // fail typed, store nothing (no half-run pollutes the trend line).
    logRoiWriteFailure("captures_insert", new Error("invalid capturedAt"));
    return { kind: "failed" };
  }

  const inserts: MetricCaptureInsert[] = [];
  const unhomed = new Set<RoiSourceId>();

  for (const outcome of collection.outcomes) {
    if (outcome.status !== "contributed") continue;
    const normalized = toMetricCaptureInsert(
      { tenantId, clientId },
      {
        source: outcome.sourceId,
        vendor: outcome.vendor,
        period: collection.period,
        samples: outcome.samples,
      },
    );
    if (normalized.kind === "homed") inserts.push(normalized.insert);
    else if (normalized.kind === "unhomed") unhomed.add(normalized.source);
  }

  const unhomedList = [...unhomed];
  if (inserts.length === 0) {
    return { kind: "nothing_homed", unhomed: unhomedList };
  }

  const rows = inserts.map((insert) => ({ ...insert, captured_at: capturedAt }));
  try {
    const { error } = await supabase.from("metrics").insert(rows);
    if (error) {
      logRoiWriteFailure("captures_insert", error);
      return { kind: "failed" };
    }
  } catch (cause) {
    logRoiWriteFailure("thrown", cause);
    return { kind: "failed" };
  }

  return { kind: "persisted", rows: rows.length, capturedAt, unhomed: unhomedList };
}
