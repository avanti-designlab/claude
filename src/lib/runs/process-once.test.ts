import { describe, expect, it } from "vitest";
import type { RunRow } from "@/lib/types/db";
import type { AdapterContext, ExecuteDeps, RunExecutionContext } from "./execute";
import type { RunOutcome } from "./outcome";
import { RunExecutionError } from "./outcome";
import { runProcessorOnce, type ProcessorDeps } from "./process-once";

function leasedRun(): RunRow {
  return {
    id: "run-1",
    tenant_id: "tenant-1",
    client_id: "client-1",
    property_id: "prop-1",
    input_url: null,
    kind: "audit",
    status: "running",
    attempts: 0,
    progress: {},
    heartbeat_at: null,
    requested_by: null,
    result_ref: null,
    error_code: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function depsFor(lease: () => Promise<RunRow | null>, adapterOutcome: "ok" | "fail"): ProcessorDeps {
  const completed: RunOutcome[] = [];
  const ctx: RunExecutionContext = {
    adapterContext: { run: leasedRun(), tenantId: "tenant-1" } as unknown as AdapterContext,
    complete: async (o) => {
      completed.push(o);
    },
  };
  const base: ExecuteDeps = {
    contextFor: () => ctx,
    adapters: {
      audit:
        adapterOutcome === "ok"
          ? async () => ({ resultRef: { kind: "audit", id: "a-1" } })
          : async () => {
              throw new RunExecutionError("engine_error");
            },
    },
    log: () => {},
  };
  return { ...base, lease };
}

describe("runProcessorOnce — one run per invocation", () => {
  it("idle when the queue is empty (lease returns null)", async () => {
    const result = await runProcessorOnce(depsFor(async () => null, "ok"));
    expect(result).toEqual({ outcome: "idle" });
  });

  it("processes a leased run to success", async () => {
    const result = await runProcessorOnce(depsFor(async () => leasedRun(), "ok"));
    expect(result).toEqual({ outcome: "processed", status: "succeeded", kind: "audit" });
  });

  it("reports a failed run with its closed error_code (drives the follow-up kick + eventual retry)", async () => {
    const result = await runProcessorOnce(depsFor(async () => leasedRun(), "fail"));
    expect(result).toEqual({ outcome: "processed", status: "failed", kind: "audit", errorCode: "engine_error" });
  });
});
