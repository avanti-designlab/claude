/**
 * Rollback-safety hardening — adversarial gap-closing tests (Phase 1.2 QA gate,
 * doc 04 §2). These pin sub-scenarios of the sacred rollback invariants that the
 * main lifecycle suites (manager.test.ts / manager-hardening.test.ts /
 * auto-rollback.test.ts) do not exercise directly:
 *
 *  - INV 8 (drift): rollback is AUTHORITATIVE — it restores the captured
 *    before-baseline even when the live page drifts AFTER apply (an external
 *    change between apply and rollback). One-click undo must not be defeatable
 *    by drift.
 *  - INV 2 (auto-rollback retryable): a failed auto-revert is not merely "still
 *    applied" — it is GENUINELY retryable: a later monitor pass reverts it
 *    end-to-end (site restored). The change is never silently lost.
 *  - INV 7 (determinism): the FULL lifecycle through auto_reverted is
 *    byte-identical under a fixed clock — no wall-clock leaks into the
 *    monitor/rollback path (reverted_at, reverted_reason).
 *  - INV 1 (same-method / fail-loud): rolling back a change whose applied method
 *    adapter is unavailable fails LOUD and leaves the row applied — it is never
 *    silently marked reverted while the site still shows the change.
 *  - INV 4 (bulk): applyBatch cannot apply a FORGED member id that preview never
 *    minted — the batch entrypoint honours the same persisted-row guard as apply.
 */

import { describe, expect, it } from "vitest";
import type {
  Json,
  SiteChangeMethod,
  SiteChangeRow,
  TenantUserRole,
} from "@/lib/types/db";
import {
  ChangeManager,
  fixedClock,
  InMemoryChangeStore,
  MapAdapterRegistry,
  MethodNotRegisteredError,
  RecordingWriteAdapter,
  steppingClock,
  type AdapterWrite,
  type AutoRollbackPolicyResolver,
  type BatchPreview,
  type ChangeTarget,
  type DesiredChange,
  type MonitoringSignal,
  type StructuredDiff,
  type TenantContext,
  type WriteMethodAdapter,
} from "./index";

/* ------------------------------------------------------------------ */
/* harness (self-contained; mirrors manager.test.ts)                  */
/* ------------------------------------------------------------------ */

function ctx(
  role: TenantUserRole = "operator",
  tenantId = "t1",
  id = "u-op",
): TenantContext {
  return { tenantId, actor: { id, role } };
}
const writer = ctx();

function desired(overrides: Partial<DesiredChange> = {}): DesiredChange {
  return {
    tenantId: "t1",
    clientId: "c1",
    propertyId: "p1",
    method: "wordpress",
    changeType: "title",
    automationLevel: "ai_draft_human_approve",
    target: { url: "https://client.example/", locator: "title" },
    before: "Old Title",
    after: "New, Better Title",
    ...overrides,
  };
}

function setup(policyResolver?: AutoRollbackPolicyResolver, clock = steppingClock("2026-07-08T00:00:00.000Z", 1000)) {
  const store = new InMemoryChangeStore({ clock });
  const wp = new RecordingWriteAdapter("wordpress");
  const manager = new ChangeManager({
    store,
    adapters: new MapAdapterRegistry([wp]),
    clock,
    policyResolver,
  });
  return { manager, store, wp, clock };
}

function seedLive(adapter: RecordingWriteAdapter, d: DesiredChange): void {
  adapter.setCurrent(d.target, d.before);
}

function sig(overrides: Partial<MonitoringSignal> = {}): MonitoringSignal {
  return {
    metric: "visibility",
    deltaPct: -60,
    observedAt: "2026-07-08T01:00:00.000Z",
    ...overrides,
  };
}

const executePolicy: AutoRollbackPolicyResolver = () => ({
  mode: "execute",
  thresholds: { visibility: 30 },
});

/* ------------------------------------------------------------------ */
/* INV 8 — rollback is authoritative over a post-apply external change */
/* ------------------------------------------------------------------ */

describe("drift: external change AFTER apply, then rollback (INV 8)", () => {
  it("one-click rollback restores the captured baseline, not the external drift", async () => {
    const { manager, wp } = setup();
    const d = desired({ before: "Baseline", after: "Applied" });
    seedLive(wp, d);

    const p = await manager.preview(d, writer);
    await manager.apply(p.change.id, { approvedBy: "h" }, writer);
    expect(wp.current(d.target)).toBe("Applied");

    // Out-of-band mutation of the live page AFTER we applied (CMS edit, another
    // tool, a person). The rollback baseline was captured at apply time.
    wp.setCurrent(d.target, "ExternallyHijacked");

    const rolled = await manager.rollback(p.change.id, { reason: "one-click undo" }, writer);
    expect(rolled.change.status).toBe("reverted");
    // Authoritative undo: the captured before-state wins over the external drift.
    // If rollback "helpfully" skipped the write on drift, the hijack would persist
    // and the undo guarantee would be defeatable — this asserts it is not.
    expect(wp.current(d.target)).toBe("Baseline");
    expect(wp.count("revert")).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* INV 2 — a failed auto-revert is genuinely retryable                */
/* ------------------------------------------------------------------ */

/** A method adapter whose revert can be toggled to fail, then recover. */
class ToggleRevertAdapter implements WriteMethodAdapter {
  readonly method: SiteChangeMethod;
  failRevert = true;
  private readonly state = new Map<string, Json>();
  private reverts = 0;
  constructor(method: SiteChangeMethod) {
    this.method = method;
  }
  private key(t: ChangeTarget): string {
    return `${t.url}::${t.locator ?? ""}`;
  }
  async readCurrent(target: ChangeTarget): Promise<Json> {
    const k = this.key(target);
    return this.state.has(k) ? (this.state.get(k) as Json) : null;
  }
  async apply(w: AdapterWrite): Promise<void> {
    this.state.set(this.key(w.target), w.after);
  }
  async revert(w: AdapterWrite): Promise<void> {
    if (this.failRevert) throw new Error("toggle adapter: revert down");
    this.state.set(this.key(w.target), w.before);
    this.reverts++;
  }
  seed(target: ChangeTarget, v: Json): void {
    this.state.set(this.key(target), v);
  }
  current(target: ChangeTarget): Json {
    const k = this.key(target);
    return this.state.has(k) ? (this.state.get(k) as Json) : null;
  }
  revertCount(): number {
    return this.reverts;
  }
}

describe("auto-rollback failure is retryable, never silently lost (INV 2)", () => {
  it("a later monitor pass reverts a change whose first auto-revert failed", async () => {
    const clock = steppingClock("2026-07-08T00:00:00.000Z", 1000);
    const store = new InMemoryChangeStore({ clock });
    const adapter = new ToggleRevertAdapter("wordpress");
    const manager = new ChangeManager({
      store,
      adapters: new MapAdapterRegistry([adapter]),
      clock,
      policyResolver: executePolicy,
    });
    const d = desired({ before: "Stable", after: "Risky" });
    adapter.seed(d.target, d.before);

    const p = await manager.preview(d, writer);
    await manager.apply(p.change.id, { approvedBy: "h" }, writer);
    expect(adapter.current(d.target)).toBe("Risky");

    // First pass: the site revert throws → reported, row stays applied.
    const first = await manager.monitor(p.change.id, [sig()], writer);
    expect(first.action).toBe("auto_revert_failed");
    expect(store.peek(p.change.id)?.status).toBe("applied");
    expect(adapter.revertCount()).toBe(0);

    // The fault clears (transient CMS/API outage) and monitoring runs again.
    adapter.failRevert = false;
    const second = await manager.monitor(p.change.id, [sig()], writer);

    // Genuinely retryable: it reverts end-to-end this time.
    expect(second.action).toBe("auto_reverted");
    expect(store.peek(p.change.id)?.status).toBe("auto_reverted");
    expect(store.peek(p.change.id)?.reverted_reason).toMatch(/^auto-rollback/);
    expect(store.peek(p.change.id)?.reverted_at).not.toBeNull();
    expect(adapter.current(d.target)).toBe("Stable"); // site actually restored
    expect(adapter.revertCount()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* INV 7 — full-lifecycle determinism through auto_reverted           */
/* ------------------------------------------------------------------ */

describe("determinism through the whole lifecycle incl. auto-rollback (INV 7)", () => {
  it("preview → apply → monitor(execute→auto_reverted) is byte-identical under a fixed clock", async () => {
    async function run() {
      const { manager, wp } = setup(executePolicy, fixedClock("2026-07-08T12:00:00.000Z"));
      const d = desired();
      seedLive(wp, d);
      const p = await manager.preview(d, writer);
      await manager.apply(p.change.id, { approvedBy: "h" }, writer);
      const mon = await manager.monitor(p.change.id, [sig()], writer);
      return mon.change;
    }
    const r1 = await run();
    const r2 = await run();

    expect(r1?.status).toBe("auto_reverted");
    expect(r2).toEqual(r1); // byte-identical persisted row across runs
    // reverted_at is the INJECTED instant, never Date.now() from the revert path.
    expect(r1?.reverted_at).toBe("2026-07-08T12:00:00.000Z");
  });
});

/* ------------------------------------------------------------------ */
/* INV 1 — rollback fails LOUD when the applied method is unavailable  */
/* ------------------------------------------------------------------ */

describe("rollback fails loud when the applied method adapter is gone (INV 1)", () => {
  it("throws MethodNotRegisteredError and does NOT silently mark the row reverted", async () => {
    const clock = steppingClock("2026-07-08T00:00:00.000Z", 1000);
    const store = new InMemoryChangeStore({ clock });
    const wp = new RecordingWriteAdapter("wordpress");
    // The manager that applies has the wordpress adapter...
    const full = new ChangeManager({ store, adapters: new MapAdapterRegistry([wp]), clock });
    // ...a later process (mid-deploy) has lost it.
    const noAdapters = new ChangeManager({ store, adapters: new MapAdapterRegistry([]), clock });

    const d = desired();
    seedLive(wp, d);
    const p = await full.preview(d, writer);
    await full.apply(p.change.id, { approvedBy: "h" }, writer);

    await expect(
      noAdapters.rollback(p.change.id, { reason: "undo" }, writer),
    ).rejects.toThrow(MethodNotRegisteredError);

    // The adapter is resolved BEFORE the status write, so the row is untouched:
    // no "reverted" row while the site still shows the applied change.
    expect(store.peek(p.change.id)?.status).toBe("applied");
    expect(wp.current(d.target)).toBe(d.after);
    expect(wp.count("revert")).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* INV 4 — a forged batch member cannot be applied                    */
/* ------------------------------------------------------------------ */

describe("bulk apply refuses a forged (never-previewed) member (INV 4)", () => {
  it("applyBatch fails the forged member and applies nothing to the site", async () => {
    const { manager, wp } = setup();
    // applyBatch reads only member.change.id — a hostile caller hand-builds a
    // batch pointing at an id preview never minted.
    const forged: BatchPreview = {
      batchId: "batch:forged",
      tenantId: "t1",
      clientId: "c1",
      members: [
        {
          change: { id: "sc-never-previewed" } as SiteChangeRow,
          diff: {} as StructuredDiff,
        },
      ],
      summary: { memberCount: 1, byChangeType: {}, label: "forged" },
    };

    const report = await manager.applyBatch(forged, { approvedBy: "h" }, writer);

    expect(report.complete).toBe(false);
    expect(report.applied).toHaveLength(0);
    expect(report.failed?.changeId).toBe("sc-never-previewed");
    // No persisted previewed row ⇒ the load() guard refuses ⇒ zero site writes.
    expect(wp.count("apply")).toBe(0);
  });
});
