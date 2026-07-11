import "server-only";

/**
 * LIVE wiring for the run-queue processor + sweeper — the ONLY place service
 * material, minted per-run tokens, and live network are assembled (ARCHITECTURE
 * RULING A1/A7). Imported exclusively by the route handlers; NEVER by unit
 * tests (which inject fakes into the pure orchestrator/sweeper).
 *
 * A1 data-access model, made concrete here:
 *  - `serviceClient` (service-role key) calls ONLY the reviewed SECURITY DEFINER
 *    RPCs: lease_next_run / reap_orphaned_runs / requeue_failed_runs. It NEVER
 *    touches a tenant data table. This is the sole service-role-class surface.
 *  - `contextFor(run)` mints a per-run tenant JWT (mint.ts) and builds a
 *    supabase-js client whose access token IS that JWT — so every read/write the
 *    adapter and the run-completion do is RLS-scoped to the leased run's tenant.
 *    The completion write (running → succeeded|failed) and the heartbeat go
 *    through THIS scoped client too, not the service client.
 *
 * A7: the adapter's fetch port is the socket-pinned `pinnedFetchPort()`.
 *
 * Fail-closed: if the server is not fully provisioned, `liveProcessorDeps` /
 * `liveSweepDeps` return null and the route answers 503 (never 500).
 */

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { tryGetProcessorRuntimeConfig, type ProcessorRuntimeConfig } from "@/lib/env.server";
import { liveResolvePort } from "@/lib/intelligence/audit/live-fetch";
import type { RunRow } from "@/lib/types/db";
import { auditAdapter } from "./adapters/audit";
import { brandExtractAdapter } from "./adapters/brand-extract";
import { HEARTBEAT_INTERVAL_MS } from "./config";
import {
  makeThrottledHeartbeat,
  RUN_PROCESSOR_MARKER,
  type ProcessorLogEvent,
  type RunExecutionContext,
} from "./execute";
import { mintRunJwt } from "./mint";
import type { RunOutcome } from "./outcome";
import { pinnedFetchPort } from "./pinned-fetch";
import type { ProcessorDeps } from "./process-once";
import { RUN_SWEEP_MARKER, type SweepDeps } from "./sweep";

/** Service-role client — calls ONLY the queue-infra RPCs (never tenant tables). */
function serviceClient(cfg: ProcessorRuntimeConfig): SupabaseClient {
  return createSupabaseClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Redacted processor telemetry — stage + kind + closed error_code ONLY. */
function logProcessorEvent(event: ProcessorLogEvent): void {
  const code = event.stage === "failed" ? ` error_code=${event.errorCode}` : "";
  console.error(`${RUN_PROCESSOR_MARKER} stage=${event.stage} kind=${event.kind}${code}`);
}

/** Redacted sweeper telemetry — stage + count ONLY (never run ids). */
function logSweepEvent(event: { stage: "reaped" | "requeued"; count: number }): void {
  console.error(`${RUN_SWEEP_MARKER} stage=${event.stage} count=${event.count}`);
}

/**
 * Build the RLS-scoped per-run execution context (A1). The scoped client uses
 * the minted JWT as its access token (supabase-js `accessToken`), so PostgREST
 * verifies it and applies app.tenant_id()/app.is_writer() RLS — identical to a
 * real operator of the run's tenant. apikey stays the anon key.
 *
 * LEASE FENCING (Code Review Blocker fix — the zombie-write closure). Every
 * state write this context performs — heartbeat AND completion, and any FUTURE
 * progress write — is a CAS fenced on `status = 'running' AND attempts =
 * <attempts at lease time>`:
 *  - `status='running'` stops a zombie (a processor that stalled past the
 *    orphan threshold) from stomping a terminal row (reaped → failed, operator
 *    → canceled, a peer's completion → succeeded);
 *  - `attempts` is the natural fencing TOKEN: requeue is the only thing that
 *    ever changes it (exactly +1, DB-enforced by the 0012 transition guard), so
 *    a row that was reaped and re-leased carries attempts+1 and the OLD
 *    holder's fenced write matches ZERO rows — it cannot stomp the new holder's
 *    running row either.
 * A fenced write that affects 0 rows means THIS processor's lease is LOST:
 * log one redacted `lost_lease` marker and STAND DOWN — never re-check, never
 * retrofit state, never write again (the row's real owner is the queue).
 * This CAS is the ONE fencing mechanism; the 0012 transition guard pins which
 * EDGES are legal, this fence pins WHO may drive them (see the guard's header).
 */
function contextFor(cfg: ProcessorRuntimeConfig, run: RunRow): RunExecutionContext {
  const minted = mintRunJwt({
    tenantId: run.tenant_id,
    secret: cfg.jwtSecret,
    issuer: `${cfg.supabaseUrl}/auth/v1`,
  });
  const runClient = createSupabaseClient(cfg.supabaseUrl, cfg.anonKey, {
    accessToken: async () => minted,
  });
  const pinned = pinnedFetchPort();

  /** Once true, this processor no longer owns the run — every writer stands down. */
  let leaseLost = false;

  const markLeaseLost = () => {
    if (!leaseLost) {
      leaseLost = true;
      console.error(`${RUN_PROCESSOR_MARKER} stage=lost_lease kind=${run.kind}`);
    }
  };

  /**
   * The fenced run-state write (see header). Returns:
   *  - "applied": exactly this lease's row was updated;
   *  - "lost": the fence matched 0 rows — the lease is gone (reaped/requeued/
   *    completed elsewhere); the caller must stand down;
   *  - "error": the write itself failed (transient) — state unknown, row
   *    untouched by us; recovery belongs to the sweeper, never to a blind retry.
   */
  const fencedRunUpdate = async (
    patch: Record<string, unknown>
  ): Promise<"applied" | "lost" | "error"> => {
    const { data, error } = await runClient
      .from("runs")
      .update(patch)
      .eq("id", run.id)
      .eq("status", "running")
      .eq("attempts", run.attempts)
      .select("id");
    if (error) return "error";
    if (!Array.isArray(data) || data.length === 0) return "lost";
    return "applied";
  };

  const now = () => Date.now();
  const heartbeat = makeThrottledHeartbeat(
    async () => {
      if (leaseLost) return; // stood down — no further writes
      try {
        const result = await fencedRunUpdate({ heartbeat_at: new Date().toISOString() });
        if (result === "lost") markLeaseLost();
        // "error" (transient network/db) is NOT lease loss: a missed beat only
        // risks a reap, which the retry path recovers honestly.
      } catch {
        /* transient throw — same reasoning as "error" */
      }
    },
    HEARTBEAT_INTERVAL_MS,
    now
  );

  const complete = async (outcome: RunOutcome) => {
    try {
      if (leaseLost) return; // stand down — never retrofit a lost run's state
      const patch =
        outcome.status === "succeeded"
          ? { status: "succeeded", result_ref: outcome.resultRef, error_code: null }
          : { status: "failed", error_code: outcome.errorCode };
      const result = await fencedRunUpdate(patch);
      if (result === "lost") {
        markLeaseLost();
      } else if (result === "error") {
        // Redacted: stage + kind only. The row stays running with a frozen
        // heartbeat → the sweeper reaps it → capped retry. Honest recovery,
        // never a blind second write.
        console.error(`${RUN_PROCESSOR_MARKER} stage=complete_error kind=${run.kind}`);
      }
    } catch {
      console.error(`${RUN_PROCESSOR_MARKER} stage=complete_error kind=${run.kind}`);
    } finally {
      // Dispose the per-run undici Agent on every path (CR hygiene minor).
      await pinned.close();
    }
  };

  return {
    adapterContext: {
      run,
      tenantId: run.tenant_id,
      supabase: runClient,
      fetchPort: pinned.port,
      resolvePort: liveResolvePort(),
      heartbeat,
      now,
    },
    complete,
  };
}

/**
 * Defense-in-depth shape guard on the lease RPC's answer (QA F3). On an empty
 * queue `lease_next_run()` returns a NULL composite; depending on PostgREST's
 * serialization that can surface as null OR as an object/array whose every
 * field is null. Without this guard a truthy all-null "run" would flow into
 * execution as a junk row (→ misconfigured → a fenced no-op completion → kick →
 * unbounded loop). Only a row carrying a real id + tenant_id + kind is a lease.
 * PostgREST's actual empty-case serialization is verified live at the A9 local
 * walkthrough (canary precedent).
 */
function asLeasedRun(data: unknown): RunRow | null {
  const row = (Array.isArray(data) ? data[0] : data) as Partial<RunRow> | null | undefined;
  if (!row || typeof row !== "object") return null;
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    typeof row.tenant_id !== "string" ||
    row.tenant_id.length === 0 ||
    typeof row.kind !== "string"
  ) {
    return null;
  }
  return row as RunRow;
}

/** REAL processor deps, or null (fail closed → route 503) when unprovisioned. */
export function liveProcessorDeps(): ProcessorDeps | null {
  const cfg = tryGetProcessorRuntimeConfig();
  if (!cfg) return null;
  const service = serviceClient(cfg);
  return {
    lease: async () => {
      const { data, error } = await service.rpc("lease_next_run");
      if (error) {
        console.error(`${RUN_PROCESSOR_MARKER} stage=lease_error`);
        return null;
      }
      return asLeasedRun(data);
    },
    contextFor: (run) => contextFor(cfg, run),
    adapters: { audit: auditAdapter, brand_extract: brandExtractAdapter },
    log: logProcessorEvent,
  };
}

/** REAL sweeper deps, or null (fail closed → route 503) when unprovisioned. */
export function liveSweepDeps(): SweepDeps | null {
  const cfg = tryGetProcessorRuntimeConfig();
  if (!cfg) return null;
  const service = serviceClient(cfg);
  return {
    reapOrphaned: async (staleBeforeIso) => {
      const { data, error } = await service.rpc("reap_orphaned_runs", {
        p_stale_before: staleBeforeIso,
      });
      if (error) {
        console.error(`${RUN_SWEEP_MARKER} stage=reap_error`);
        return [];
      }
      return (data as string[] | null) ?? [];
    },
    requeueFailed: async (cap, baseMs, maxMs) => {
      const { data, error } = await service.rpc("requeue_failed_runs", {
        p_cap: cap,
        p_base_backoff: `${baseMs} milliseconds`,
        p_max_backoff: `${maxMs} milliseconds`,
      });
      if (error) {
        console.error(`${RUN_SWEEP_MARKER} stage=requeue_error`);
        return [];
      }
      return (data as string[] | null) ?? [];
    },
    now: () => Date.now(),
    log: logSweepEvent,
  };
}
