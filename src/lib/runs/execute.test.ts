import { describe, expect, it, vi } from "vitest";
import type { RunRow } from "@/lib/types/db";
import type { FetchPort } from "@/lib/write-methods/shared";
import {
  executeLeasedRun,
  heartbeatingFetch,
  makeThrottledHeartbeat,
  type AdapterContext,
  type ExecuteDeps,
  type KindAdapter,
  type ProcessorLogEvent,
  type RunExecutionContext,
} from "./execute";
import type { RunOutcome } from "./outcome";
import { RunExecutionError } from "./outcome";

function leasedRun(kind: RunRow["kind"] = "audit"): RunRow {
  return {
    id: "run-1",
    tenant_id: "tenant-1",
    client_id: "client-1",
    property_id: "prop-1",
    input_url: null,
    kind,
    status: "running", // post-lease
    attempts: 0,
    progress: {},
    heartbeat_at: new Date().toISOString(),
    requested_by: null,
    result_ref: null,
    error_code: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** A capturing execution context + the deps around it. */
function harness(adapter: KindAdapter | undefined) {
  const completed: RunOutcome[] = [];
  const logs: ProcessorLogEvent[] = [];
  let seenCtx: AdapterContext | null = null;

  const adapterContext = {
    run: leasedRun(),
    tenantId: "tenant-1",
    supabase: {} as AdapterContext["supabase"],
    fetchPort: (async () => ({ status: 200, headers: { get: () => null }, text: async () => "" })) as FetchPort,
    resolvePort: async () => [],
    heartbeat: async () => {},
    now: () => 0,
  } satisfies AdapterContext;

  const ctx: RunExecutionContext = {
    adapterContext,
    complete: async (o) => {
      completed.push(o);
    },
  };

  const wrapped: KindAdapter | undefined = adapter
    ? async (c) => {
        seenCtx = c;
        return adapter(c);
      }
    : undefined;

  const deps: ExecuteDeps = {
    contextFor: () => ctx,
    adapters: wrapped ? { audit: wrapped } : {},
    log: (e) => logs.push(e),
  };
  return { deps, completed, logs, adapterContext, getSeenCtx: () => seenCtx };
}

describe("executeLeasedRun — terminal outcomes + honest completion", () => {
  it("success: completes running→succeeded with the artifact result_ref", async () => {
    const h = harness(async () => ({ resultRef: { kind: "audit", id: "audit-9" } }));
    const outcome = await executeLeasedRun(leasedRun(), h.deps);
    expect(outcome).toEqual({ status: "succeeded", resultRef: { kind: "audit", id: "audit-9" } });
    expect(h.completed).toEqual([{ status: "succeeded", resultRef: { kind: "audit", id: "audit-9" } }]);
    expect(h.logs).toContainEqual({ stage: "succeeded", kind: "audit" });
  });

  it("mapped failure: a RunExecutionError becomes its closed error_code", async () => {
    const h = harness(async () => {
      throw new RunExecutionError("crawl_refused");
    });
    const outcome = await executeLeasedRun(leasedRun(), h.deps);
    expect(outcome).toEqual({ status: "failed", errorCode: "crawl_refused" });
    expect(h.completed).toEqual([{ status: "failed", errorCode: "crawl_refused" }]);
    expect(h.logs).toContainEqual({ stage: "failed", kind: "audit", errorCode: "crawl_refused" });
  });

  it("unmapped throw collapses to engine_error (no message leaks)", async () => {
    const h = harness(async () => {
      throw new Error("kaboom with sensitive://url");
    });
    const outcome = await executeLeasedRun(leasedRun(), h.deps);
    expect(outcome).toEqual({ status: "failed", errorCode: "engine_error" });
  });

  it("an unregistered kind fails misconfigured (defensive — enqueue refuses these)", async () => {
    const h = harness(undefined);
    const outcome = await executeLeasedRun(leasedRun("monitor"), h.deps);
    expect(outcome).toEqual({ status: "failed", errorCode: "misconfigured" });
    expect(h.completed).toEqual([{ status: "failed", errorCode: "misconfigured" }]);
  });

  it("hands the adapter the RLS-scoped context from contextFor", async () => {
    const h = harness(async () => ({ resultRef: null }));
    await executeLeasedRun(leasedRun(), h.deps);
    expect(h.getSeenCtx()).toBe(h.adapterContext);
  });

  it("always completes (never stuck): the run reaches a terminal state on every path", async () => {
    for (const adapter of [
      async () => ({ resultRef: null }),
      async () => {
        throw new RunExecutionError("budget_exhausted_total");
      },
      undefined,
    ] as (KindAdapter | undefined)[]) {
      const h = harness(adapter);
      await executeLeasedRun(leasedRun(), h.deps);
      expect(h.completed).toHaveLength(1);
      expect(["succeeded", "failed"]).toContain(h.completed[0].status);
    }
  });
});

describe("heartbeatingFetch — the A6 per-page hook", () => {
  it("fires the heartbeat before each fetch, then delegates to the port", async () => {
    const order: string[] = [];
    const port: FetchPort = async () => {
      order.push("fetch");
      return { status: 200, headers: { get: () => null }, text: async () => "" };
    };
    const wrapped = heartbeatingFetch(port, async () => {
      order.push("beat");
    });
    await wrapped("https://x.example/a", { method: "GET", headers: {}, redirect: "error" });
    await wrapped("https://x.example/b", { method: "GET", headers: {}, redirect: "error" });
    expect(order).toEqual(["beat", "fetch", "beat", "fetch"]);
  });
});

describe("makeThrottledHeartbeat", () => {
  it("first call writes; subsequent within the interval are no-ops; a later one writes again", async () => {
    let clock = 100_000;
    const write = vi.fn(async () => {});
    const beat = makeThrottledHeartbeat(write, 12_000, () => clock);
    await beat(); // first — writes
    await beat(); // same time — no-op
    clock += 5_000;
    await beat(); // 5s later — still throttled
    clock += 8_000;
    await beat(); // 13s after last write — writes
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("swallows a write failure (a missed heartbeat must never crash the run)", async () => {
    const beat = makeThrottledHeartbeat(
      async () => {
        throw new Error("db down");
      },
      12_000,
      () => 0
    );
    await expect(beat()).resolves.toBeUndefined();
  });
});
