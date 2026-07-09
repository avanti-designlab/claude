import "server-only";

/**
 * M15 review-signal persistence + reads (FROZEN schema, migration 0006 `metrics`).
 *
 * Deliberately NOT a "use server" module (house rule — same as M8/M9's persist
 * modules): exporting helpers from an action file would mint each as a
 * browser-invokable RPC. This stays a plain server-side module only the audited
 * action imports. Every caller passes a claim-scoped Supabase client + a
 * CLAIM-SOURCED tenantId (never anything the browser sent); RLS (`metrics_insert`
 * / `metrics_select`, migration 0006) re-pins tenant scope + the writer floor
 * (`app.is_writer()`) below us regardless, and the composite FK (tenant, client)
 * → clients makes a cross-tenant reference structurally impossible.
 *
 * INSERT-ONLY here: a review signal is an append-only measurement capture (like
 * visibility_results / audits) — history is the product (doc 05: the trend line).
 * M15 never updates a prior signal. It writes ONLY `metrics` with source='reviews'
 * (see rows.ts) — never another source, never content_items, never a reply.
 */

import type { createClient } from "@/lib/supabase/server";
import { REVIEW_METRIC_SOURCE } from "./types";
import { reviewSignalEntry, reviewSignalMetricRow, type ReviewSignalEntry } from "./rows";
import type { ReviewSignal } from "./types";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Signal history is bounded newest-first (the dashboard/queue need recency; PostgREST caps rows anyway). */
export const REVIEW_SIGNALS_MAX = 100;

/* ------------------------------------------------------------------ */
/* Redacted failure telemetry (house contract — content/persist.ts)    */
/* ------------------------------------------------------------------ */

/**
 * Every M15 write/read failure emits exactly ONE server-side console.error
 * carrying ONLY the stable marker, which stage failed, and the Postgres/PostgREST
 * error CODE (shape-checked — never free text). NO review text, NO author, NO
 * drafted reply, NO tenant/client ids, NO error messages: a PostgREST message can
 * quote row data verbatim, and reviews + drafted replies are client data — the
 * secrets-in-logs rule (docs/ops/environments.md §Secrets rules) is absolute.
 */
export const REVIEW_FAILURE_MARKER = "[review-write-failure]";

export type ReviewFailureStage = "signal_insert" | "signal_read" | "generate" | "thrown";

export function logReviewFailure(stage: ReviewFailureStage, cause: unknown): void {
  console.error(`${REVIEW_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/**
 * Extract a bare SQLSTATE/PostgREST code ("23503", "PGRST301"). Anything that
 * isn't a short alphanumeric token collapses to "unknown", so no data can ride the
 * log line even through a hostile/misbehaving error object. (Local copy — the
 * content/audit equivalents are module-private and out of bounds to import.)
 */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)) return code;
  }
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* persistReviewSignal — insert one review-signal capture              */
/* ------------------------------------------------------------------ */

/**
 * Insert ONE review-signal capture into `metrics` (source='reviews'). `tenantId`
 * is CLAIM-SOURCED; `clientId` is RLS-sourced by the action; RLS + the composite
 * FK re-pin scope below us. A failed insert is a HARD failure (nothing was saved);
 * the caller returns an honest retryable error.
 */
export async function persistReviewSignal(
  supabase: Supabase,
  tenantId: string,
  args: { clientId: string; signal: ReviewSignal },
): Promise<{ ok: true; metricId: string } | { ok: false }> {
  const row = reviewSignalMetricRow({ tenantId, clientId: args.clientId, signal: args.signal });
  const { data, error } = await supabase.from("metrics").insert(row).select("id").single();
  if (error || !data) {
    logReviewFailure("signal_insert", error);
    return { ok: false };
  }
  return { ok: true, metricId: data.id as string };
}

/* ------------------------------------------------------------------ */
/* Read — the review-signal queue (RLS-scoped, newest-first)           */
/* ------------------------------------------------------------------ */

/**
 * Newest-first review signals for a client — the dashboard/queue + the trend the
 * gates and M17 read. RLS scopes the read to the caller's tenant AND
 * `app.client_scope` (a client_viewer sees only its own client's signals);
 * eq(client_id) + eq(source='reviews') narrow within that. Bounded to the most
 * recent N.
 */
export async function readReviewSignalsForClient(
  supabase: Supabase,
  clientId: string,
): Promise<{ ok: true; entries: ReviewSignalEntry[] } | { ok: false }> {
  const { data, error } = await supabase
    .from("metrics")
    .select("id, source, data, captured_at")
    .eq("client_id", clientId)
    .eq("source", REVIEW_METRIC_SOURCE)
    .order("captured_at", { ascending: false });
  if (error || !data) return { ok: false };
  const rows = data as Array<Parameters<typeof reviewSignalEntry>[0]>;
  return { ok: true, entries: rows.slice(0, REVIEW_SIGNALS_MAX).map(reviewSignalEntry) };
}
