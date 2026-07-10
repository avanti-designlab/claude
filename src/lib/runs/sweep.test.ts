import { describe, expect, it, vi } from "vitest";
import { ORPHAN_STALE_MS, RETRY_ATTEMPT_CAP } from "./config";
import { sweepRuns, type SweepDeps } from "./sweep";

describe("sweepRuns — reap then requeue (recovery backstop)", () => {
  it("reaps orphans first, then requeues failed, and returns honest counts", async () => {
    const order: string[] = [];
    const now = Date.parse("2026-07-10T12:00:00.000Z");
    const reapOrphaned = vi.fn(async (staleBeforeIso: string) => {
      order.push("reap");
      // The cutoff is exactly now - ORPHAN_STALE_MS (mirrors reap_orphaned_runs).
      expect(staleBeforeIso).toBe(new Date(now - ORPHAN_STALE_MS).toISOString());
      return ["orphan-1", "orphan-2"];
    });
    const requeueFailed = vi.fn(async (cap: number) => {
      order.push("requeue");
      expect(cap).toBe(RETRY_ATTEMPT_CAP);
      return ["failed-1"];
    });
    const deps: SweepDeps = { reapOrphaned, requeueFailed, now: () => now, log: () => {} };

    const summary = await sweepRuns(deps);
    expect(summary).toEqual({ reaped: 2, requeued: 1 });
    expect(order).toEqual(["reap", "requeue"]); // reap BEFORE requeue
  });

  it("a FAILED run past backoff is requeued by the sweep (NOT dropped-kick recovery — neither sweep op touches a QUEUED row)", async () => {
    // QA correction (A8 gate): this models a run that FAILED and is past
    // backoff; the sweeper's requeue turns it back into runnable work. A queued
    // run whose enqueue kick was dropped is a DIFFERENT case: reap only touches
    // running, requeue only touches failed, so a stale queued row is recovered
    // only by a processor poke/lease — proven live in
    // supabase/tests/queue/qa-adversarial.pg.test.ts (kick-failure trace).
    const deps: SweepDeps = {
      reapOrphaned: async () => [],
      requeueFailed: async () => ["recovered-run"],
      now: () => 0,
      log: () => {},
    };
    const summary = await sweepRuns(deps);
    expect(summary.requeued).toBe(1);
  });

  it("a quiet sweep reaps and requeues nothing", async () => {
    const deps: SweepDeps = {
      reapOrphaned: async () => [],
      requeueFailed: async () => [],
      now: () => 0,
      log: () => {},
    };
    expect(await sweepRuns(deps)).toEqual({ reaped: 0, requeued: 0 });
  });
});
