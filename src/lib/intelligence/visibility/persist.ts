import "server-only";

/**
 * M3 Visibility Tracker — run persistence into the frozen `visibility_results`
 * table (supabase/migrations/0006; contract §5). History matters — citation
 * churn is 40–60% monthly, the trend line IS the product (doc 05 §M3) — so
 * every run's MEASURED samples are stored append-only.
 *
 * Deliberately NOT a "use server" module (house rule, src/lib/plans/persist.ts):
 * exporting helpers from an action file would mint browser-invokable RPC
 * endpoints. Only the audited action imports this. Every caller passes a
 * claim-scoped Supabase client and a CLAIM-SOURCED tenantId (never anything
 * the browser sent), and RLS (`visibility_results_insert`, migration 0006:
 * `tenant_id = app.tenant_id() and app.is_writer()`) re-pins tenant_id below
 * us regardless — a row can never land outside the caller's tenant.
 *
 * WHAT IS STORED (provider honesty):
 *  - MEASURED outcomes only. A failed sample is ABSENT from storage — never
 *    an invented `cited: false` row. 0/uncited means "measured, not cited".
 *  - Rows go through the port's `toVisibilityResultInsert` normalizer, so the
 *    stored shape is vendor-independent and the verbatim vendor payload
 *    (`raw`) NEVER reaches the database (doc 04 §7).
 *  - `captured_at` is PINNED to the run's `runAt` on every row — the run's
 *    identity in storage. The frozen schema has no run id, so
 *    (tenant_id, client_id, captured_at) IS the run key; reads group on it.
 *    All rows go in ONE insert statement, so a run is stored whole or not at
 *    all — no half-runs polluting the trend line.
 *
 * ⚑ FROZEN-SCHEMA LIMITATIONS (flagged for the Orchestrator, post-freeze):
 *  - No run-metadata table: requested-vs-measured coverage exists only in the
 *    action's immediate return, not in history. A `visibility_runs` table
 *    would preserve it.
 *  - No market/geo column: a "near me" prompt sampled per-location stores
 *    identical prompt rows whose market context is indistinguishable in
 *    history. Per-market attribution (M14) needs a schema addition.
 */

import { toVisibilityResultInsert } from "@/lib/connectors";
import type { createClient } from "@/lib/supabase/server";
import type { VisibilityRun } from "./sampler";
import { logVisibilityWriteFailure } from "./telemetry";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

export type PersistVisibilityRunOutcome =
  /** All measured rows stored (one statement — whole run or nothing). */
  | { kind: "persisted"; rows: number }
  /** The run measured nothing — nothing to store, and storing zeros would lie. */
  | { kind: "nothing_measured" }
  /** A write failed — retryable; nothing partial was stored. */
  | { kind: "failed" };

export async function persistVisibilityRun(
  supabase: Supabase,
  tenantId: string,
  clientId: string,
  run: VisibilityRun
): Promise<PersistVisibilityRunOutcome> {
  const measured = run.outcomes.filter(
    (outcome) => outcome.status === "measured"
  );
  if (measured.length === 0) return { kind: "nothing_measured" };

  let rows;
  try {
    if (!Number.isFinite(Date.parse(run.runAt))) {
      throw new Error("visibility run has no valid runAt timestamp");
    }
    rows = measured.map((outcome) => ({
      // Normalizer enforces the frozen contract (engine CHECK, non-empty
      // prompt, position ≥ 1, no `raw`) and pins the claim-sourced scope.
      ...toVisibilityResultInsert(
        { tenantId, clientId },
        { engine: outcome.engine, prompt: outcome.query.prompt },
        outcome.result
      ),
      // Run identity — see the module header.
      captured_at: run.runAt,
    }));
  } catch (cause) {
    // A row that can't be normalized is a bug or a hostile provider — the
    // whole run write fails honestly (redacted: marker + stage + code only).
    logVisibilityWriteFailure("row_mapping", cause);
    return { kind: "failed" };
  }

  try {
    const { error } = await supabase.from("visibility_results").insert(rows);
    if (error) {
      logVisibilityWriteFailure("results_insert", error);
      return { kind: "failed" };
    }
  } catch (cause) {
    // Thrown transport error (interrupted connection, fetch failure) — same
    // honest, retryable outcome; never a 500 out of the tracker.
    logVisibilityWriteFailure("thrown", cause);
    return { kind: "failed" };
  }

  return { kind: "persisted", rows: rows.length };
}
