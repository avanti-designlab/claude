/**
 * Run execution orchestrator — the kind-agnostic core the processor runs on a
 * LEASED run (ARCHITECTURE RULING A1/A4/A6). Pure control flow over INJECTED
 * ports, so it is unit-tested in the default `npm test` run with fakes; the real
 * ports (per-run minted-JWT client, socket-pinned fetch, live DNS) are wired in
 * src/lib/runs/live.ts and never touched by tests.
 *
 * The A1 contract lives in the shape of these ports, not in this file's logic:
 * `contextFor(run)` is the ONLY thing that mints the per-run tenant scope and
 * builds an RLS-enforced client; everything here — heartbeats, artifact writes,
 * run completion — flows through that scoped context. This module has no
 * service-role access and no way to reach another tenant.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ResolvePort } from "@/lib/intelligence/crawl";
import type { RunErrorCode, RunKind, RunRow } from "@/lib/types/db";
import type { FetchPort } from "@/lib/write-methods/shared";
import { toErrorCode, type RunOutcome, type RunResultRef } from "./outcome";
import { isLegalRunTransition } from "./transitions";

/** Redacted telemetry marker (grep-able in hosted logs). Only stage + kind +
 *  closed error_code ever ride a log line — never ids/urls/payloads. */
export const RUN_PROCESSOR_MARKER = "[run-processor]";

/** The RLS-scoped data client an adapter reads/writes through — a supabase-js
 *  client bearing the per-run minted JWT (RLS pins every row to the run tenant). */
export type RunScopedClient = SupabaseClient;

/** Everything a kind adapter needs to execute one leased run. */
export interface AdapterContext {
  run: RunRow;
  /** The leased run's tenant — the only tenant the scoped client can see. */
  tenantId: string;
  supabase: RunScopedClient;
  fetchPort: FetchPort;
  resolvePort: ResolvePort;
  /** Called between pages; throttled to the heartbeat cadence internally. */
  heartbeat(): Promise<void>;
  /** Injectable clock (real: Date.now). */
  now(): number;
}

/** A per-kind execution adapter: run the engine, return the artifact pointer,
 *  or throw a RunExecutionError (mapped to a closed error_code). */
export type KindAdapter = (ctx: AdapterContext) => Promise<{ resultRef: RunResultRef | null }>;

/**
 * The per-run execution context the processor builds AFTER leasing. The REAL
 * implementation (live.ts) mints the tenant JWT, constructs the RLS client, and
 * wires the throttled heartbeat + completion writes onto it. `complete` performs
 * the running → succeeded|failed write through that same RLS-scoped client (so
 * even the run's own completion is tenant-pinned, not service-role).
 */
export interface RunExecutionContext {
  adapterContext: AdapterContext;
  complete(outcome: RunOutcome): Promise<void>;
}

export type ProcessorLogEvent =
  | { stage: "leased"; kind: RunKind }
  | { stage: "succeeded"; kind: RunKind }
  | { stage: "failed"; kind: RunKind; errorCode: RunErrorCode };

export interface ExecuteDeps {
  /** Build the RLS-scoped, minted per-run context (A1). */
  contextFor(run: RunRow): RunExecutionContext;
  /** Registered per-kind adapters. An unregistered kind fails `misconfigured`
   *  (defensive — enqueue refuses non-executable kinds, so this is unreachable). */
  adapters: Partial<Record<RunKind, KindAdapter>>;
  /** Redacted structured log sink. */
  log(event: ProcessorLogEvent): void;
}

/**
 * Execute one leased run to a terminal state. The run arrives already `running`
 * (lease_next_run flipped it), so the only transitions here are
 * running → succeeded|failed — both legal via the processor (asserted against
 * the pinned transition table). Any thrown value becomes a closed error_code;
 * a run NEVER ends in an unreal/stuck state (honesty rule) — it always completes.
 */
export async function executeLeasedRun(run: RunRow, deps: ExecuteDeps): Promise<RunOutcome> {
  deps.log({ stage: "leased", kind: run.kind });
  const ctx = deps.contextFor(run);
  const adapter = deps.adapters[run.kind];

  let outcome: RunOutcome;
  if (!adapter) {
    outcome = { status: "failed", errorCode: "misconfigured" };
  } else {
    try {
      const { resultRef } = await adapter(ctx.adapterContext);
      outcome = { status: "succeeded", resultRef };
    } catch (err) {
      outcome = { status: "failed", errorCode: toErrorCode(err) };
    }
  }

  // ADVISORY-ONLY legality check (per Code Review): this evaluates against the
  // LEASED SNAPSHOT's status, which may be stale by completion time — it can
  // only vouch that the OUTCOME SHAPE is a legal processor edge, never that the
  // live row still accepts it. The REAL enforcement is structural and lives
  // elsewhere: the completion write is CAS-fenced on status+attempts (live.ts —
  // a lost lease matches 0 rows) and the 0012 transition-guard trigger refuses
  // any illegal edge at the database.
  if (!isLegalRunTransition("running", outcome.status, "processor")) {
    outcome = { status: "failed", errorCode: "engine_error" };
  }

  await ctx.complete(outcome);
  if (outcome.status === "succeeded") deps.log({ stage: "succeeded", kind: run.kind });
  else deps.log({ stage: "failed", kind: run.kind, errorCode: outcome.errorCode });
  return outcome;
}

/**
 * Wrap a FetchPort so each call first fires a (throttled) heartbeat. This is the
 * A6 per-page heartbeat hook: the crawler calls the injected fetch port once per
 * page (plus robots/llms), so wrapping the PORT — not the crawler's internals —
 * gives an honest between-pages heartbeat without touching crawl/**.
 */
export function heartbeatingFetch(port: FetchPort, heartbeat: () => Promise<void>): FetchPort {
  return async (url, init) => {
    await heartbeat();
    return port(url, init);
  };
}

/**
 * Throttled heartbeat: the FIRST call always writes; subsequent calls within
 * `intervalMs` are no-ops, so a fast crawl doesn't hammer the DB while a slow
 * one still proves liveness at the cadence. A write failure is swallowed (a
 * missed heartbeat only risks a false-orphan reap, which is self-healing via
 * retry — never crash the run over telemetry).
 */
export function makeThrottledHeartbeat(
  write: () => Promise<void>,
  intervalMs: number,
  now: () => number
): () => Promise<void> {
  let last: number | null = null;
  return async () => {
    const t = now();
    if (last !== null && t - last < intervalMs) return;
    last = t;
    try {
      await write();
    } catch {
      /* swallow — see header */
    }
  };
}
