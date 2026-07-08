/**
 * ChangeManager lifecycle + hard-invariant suite (doc 04 §2, §5).
 *
 * Each hard requirement gets a test that proves the VIOLATION is rejected:
 *  - no silent write (apply needs a persisted, previewed row; the row exists
 *    before any site write)
 *  - no write without a human approver (ai_draft gate)
 *  - automation_level 'auto' rejected at the seam
 *  - illegal status transitions rejected (no double-apply, no revert-before-apply)
 *  - rollback restores prior state via the SAME method
 *  - bulk requires an explicit approver + a batch preview; stops on failure
 *  - auto-rollback fires on a threshold breach; flag/off do not write
 *  - tenant context never crosses; client_viewer never writes
 *  - determinism: injected clock only, no wall-clock
 */

import { describe, expect, it } from "vitest";
import type {
  SiteChangeAutomationLevel,
  TenantUserRole,
} from "@/lib/types/db";
import {
  ApprovalRequiredError,
  AuthorizationError,
  AutomationLevelError,
  ChangeManager,
  ChangeNotFoundError,
  ConstraintViolationError,
  fixedClock,
  IllegalTransitionError,
  InMemoryChangeStore,
  MapAdapterRegistry,
  MethodNotRegisteredError,
  RecordingWriteAdapter,
  steppingClock,
  TenantScopeError,
  type AlertDraft,
  type AutoRollbackPolicyResolver,
  type Clock,
  type DesiredChange,
  type MonitoringSignal,
  type NewPreviewedChange,
  type TenantContext,
} from "./index";

/* ------------------------------------------------------------------ */
/* harness                                                            */
/* ------------------------------------------------------------------ */

function ctx(
  role: TenantUserRole = "operator",
  tenantId = "t1",
  id = "u-op",
): TenantContext {
  return { tenantId, actor: { id, role } };
}
const writer = ctx();
const viewer = ctx("client_viewer", "t1", "u-cv");

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

function setup(
  opts: {
    policyResolver?: AutoRollbackPolicyResolver;
    alertSink?: { emit: (a: AlertDraft) => void | Promise<void> };
    extraAdapters?: RecordingWriteAdapter[];
    clock?: Clock;
  } = {},
) {
  const clock = opts.clock ?? steppingClock("2026-07-08T00:00:00.000Z", 1000);
  const store = new InMemoryChangeStore({ clock });
  const wp = new RecordingWriteAdapter("wordpress");
  const registry = new MapAdapterRegistry([wp, ...(opts.extraAdapters ?? [])]);
  const manager = new ChangeManager({
    store,
    adapters: registry,
    clock,
    policyResolver: opts.policyResolver,
    alertSink: opts.alertSink,
  });
  return { manager, store, wp, registry, clock };
}

/** Seed the stub "live site" so a clean apply has no drift. */
function seedLive(adapter: RecordingWriteAdapter, d: DesiredChange): void {
  adapter.setCurrent(d.target, d.before);
}

function sig(overrides: Partial<MonitoringSignal> = {}): MonitoringSignal {
  return {
    metric: "visibility",
    deltaPct: -45,
    observedAt: "2026-07-08T01:00:00.000Z",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* full lifecycle happy path                                          */
/* ------------------------------------------------------------------ */

describe("full lifecycle", () => {
  it("preview → apply → monitor(clean) → rollback", async () => {
    const { manager, wp } = setup();
    const d = desired();
    seedLive(wp, d);

    const preview = await manager.preview(d, writer);
    expect(preview.change.status).toBe("previewed");
    expect(preview.change.approved_by).toBeNull();
    expect(preview.diff.summary.identical).toBe(false);
    expect(wp.count("apply")).toBe(0); // preview never writes

    const applied = await manager.apply(
      preview.change.id,
      { approvedBy: "u-approver" },
      writer,
    );
    expect(applied.change.status).toBe("applied");
    expect(applied.change.approved_by).toBe("u-approver");
    expect(applied.change.applied_by).toBe("u-op");
    expect(applied.change.applied_at).not.toBeNull();
    expect(applied.warnings).toEqual([]);
    expect(wp.current(d.target)).toBe(d.after);

    const mon = await manager.monitor(preview.change.id, [], writer);
    expect(mon.action).toBe("none");

    const rolled = await manager.rollback(
      preview.change.id,
      { reason: "client asked" },
      writer,
    );
    expect(rolled.change.status).toBe("reverted");
    expect(rolled.change.reverted_at).not.toBeNull();
    expect(rolled.change.reverted_reason).toBe("client asked");
    expect(wp.current(d.target)).toBe(d.before); // restored
    expect(wp.count("revert")).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* invariant: no silent write                                         */
/* ------------------------------------------------------------------ */

describe("no silent write", () => {
  it("apply is impossible for a change that was never previewed", async () => {
    const { manager, wp } = setup();
    await expect(
      manager.apply("sc-nonexistent", { approvedBy: "h" }, writer),
    ).rejects.toThrow(ChangeNotFoundError);
    expect(wp.count("apply")).toBe(0);
  });

  it("an audit row exists BEFORE any write and is marked applied after", async () => {
    const { manager, store, wp } = setup();
    const d = desired();
    seedLive(wp, d);
    const p = await manager.preview(d, writer);
    // Row persisted while no write has happened yet.
    expect(store.peek(p.change.id)?.status).toBe("previewed");
    expect(wp.count("apply")).toBe(0);
    await manager.apply(p.change.id, { approvedBy: "h" }, writer);
    expect(store.peek(p.change.id)?.status).toBe("applied");
  });
});

/* ------------------------------------------------------------------ */
/* invariant: no write without approval                               */
/* ------------------------------------------------------------------ */

describe("human approval gate", () => {
  it("blocks apply with no approver and performs no write", async () => {
    const { manager, store, wp } = setup();
    const d = desired();
    seedLive(wp, d);
    const p = await manager.preview(d, writer);
    await expect(
      manager.apply(p.change.id, { approvedBy: "" }, writer),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(wp.count("apply")).toBe(0);
    expect(store.peek(p.change.id)?.status).toBe("previewed");
  });
});

/* ------------------------------------------------------------------ */
/* invariant: 'auto' automation rejected                              */
/* ------------------------------------------------------------------ */

describe("automation_level guard", () => {
  it("rejects 'auto' at the seam (autonomous on-page publish banned)", async () => {
    const { manager } = setup();
    const auto = "auto" as unknown as SiteChangeAutomationLevel;
    await expect(
      manager.preview(desired({ automationLevel: auto }), writer),
    ).rejects.toThrow(AutomationLevelError);
  });

  it("rejects an unknown automation level", async () => {
    const { manager } = setup();
    const bogus = "whenever" as unknown as SiteChangeAutomationLevel;
    await expect(
      manager.preview(desired({ automationLevel: bogus }), writer),
    ).rejects.toThrow(AutomationLevelError);
  });

  it("accepts human_only", async () => {
    const { manager } = setup();
    const p = await manager.preview(
      desired({ automationLevel: "human_only" }),
      writer,
    );
    expect(p.change.automation_level).toBe("human_only");
  });
});

/* ------------------------------------------------------------------ */
/* invariant: illegal transitions rejected                            */
/* ------------------------------------------------------------------ */

describe("status transitions", () => {
  it("refuses rollback of a never-applied change", async () => {
    const { manager, wp } = setup();
    const d = desired();
    seedLive(wp, d);
    const p = await manager.preview(d, writer);
    await expect(
      manager.rollback(p.change.id, { reason: "x" }, writer),
    ).rejects.toThrow(IllegalTransitionError);
    expect(wp.count("revert")).toBe(0);
  });

  it("refuses a second apply (no double-write)", async () => {
    const { manager, wp } = setup();
    const d = desired();
    seedLive(wp, d);
    const p = await manager.preview(d, writer);
    await manager.apply(p.change.id, { approvedBy: "h" }, writer);
    await expect(
      manager.apply(p.change.id, { approvedBy: "h" }, writer),
    ).rejects.toThrow(IllegalTransitionError);
    expect(wp.count("apply")).toBe(1);
  });

  it("refuses apply of an already-reverted change", async () => {
    const { manager, wp } = setup();
    const d = desired();
    seedLive(wp, d);
    const p = await manager.preview(d, writer);
    await manager.apply(p.change.id, { approvedBy: "h" }, writer);
    await manager.rollback(p.change.id, { reason: "x" }, writer);
    await expect(
      manager.apply(p.change.id, { approvedBy: "h" }, writer),
    ).rejects.toThrow(IllegalTransitionError);
  });
});

/* ------------------------------------------------------------------ */
/* invariant: rollback via the SAME method                            */
/* ------------------------------------------------------------------ */

describe("rollback fidelity", () => {
  it("restores the prior state via the SAME method, never another", async () => {
    const webflow = new RecordingWriteAdapter("webflow");
    const { manager, wp } = setup({ extraAdapters: [webflow] });
    const d = desired({ method: "wordpress" });
    seedLive(wp, d);
    const p = await manager.preview(d, writer);
    await manager.apply(p.change.id, { approvedBy: "h" }, writer);
    await manager.rollback(p.change.id, { reason: "regression" }, writer);

    const revertCall = wp.calls.find((c) => c.op === "revert");
    expect(revertCall?.value).toBe(d.before);
    expect(wp.count("revert")).toBe(1);
    expect(webflow.count("revert")).toBe(0); // never the wrong method
  });

  it("cannot apply when no adapter is registered for the method", async () => {
    const { manager } = setup(); // only wordpress registered
    const p = await manager.preview(desired({ method: "wix" }), writer);
    expect(p.change.status).toBe("previewed"); // preview needs no adapter
    await expect(
      manager.apply(p.change.id, { approvedBy: "h" }, writer),
    ).rejects.toThrow(MethodNotRegisteredError);
  });
});

/* ------------------------------------------------------------------ */
/* invariant: bulk = explicit approval + batch preview                */
/* ------------------------------------------------------------------ */

describe("bulk changes", () => {
  function batchItems(): DesiredChange[] {
    return [
      desired({ changeType: "title", target: { url: "https://c/", locator: "title" }, after: "T" }),
      desired({ changeType: "meta", target: { url: "https://c/", locator: "meta" }, after: "M" }),
      desired({ changeType: "h1", target: { url: "https://c/", locator: "h1" }, after: "H" }),
    ];
  }

  it("previews the whole batch as one diff; nothing applies", async () => {
    const { manager, wp } = setup();
    const batch = await manager.previewBatch(batchItems(), writer);
    expect(batch.summary.memberCount).toBe(3);
    expect(batch.members.every((m) => m.change.status === "previewed")).toBe(true);
    expect(wp.count("apply")).toBe(0);
  });

  it("refuses to apply a batch without an explicit human approver", async () => {
    const { manager, wp } = setup();
    const batch = await manager.previewBatch(batchItems(), writer);
    await expect(
      manager.applyBatch(batch, { approvedBy: "" }, writer),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(wp.count("apply")).toBe(0);
  });

  it("applies every member when approved as a batch", async () => {
    const { manager, wp, store } = setup();
    const items = batchItems();
    for (const d of items) seedLive(wp, d);
    const batch = await manager.previewBatch(items, writer);
    const report = await manager.applyBatch(batch, { approvedBy: "h" }, writer);
    expect(report.complete).toBe(true);
    expect(report.applied).toHaveLength(3);
    for (const m of batch.members) {
      expect(store.peek(m.change.id)?.status).toBe("applied");
    }
  });

  it("STOPS at the first failure; earlier members stay applied + revertible", async () => {
    const { manager, wp, store } = setup();
    const items = batchItems();
    for (const d of items) seedLive(wp, d);
    wp.failApplyAt(items[1].target); // second member fails to write
    const batch = await manager.previewBatch(items, writer);
    const report = await manager.applyBatch(batch, { approvedBy: "h" }, writer);

    expect(report.complete).toBe(false);
    expect(report.applied).toHaveLength(1);
    expect(report.failed?.changeId).toBe(batch.members[1].change.id);
    expect(report.notAttempted).toEqual([batch.members[2].change.id]);
    // first member is genuinely applied and can be rolled back
    const first = batch.members[0].change.id;
    expect(store.peek(first)?.status).toBe("applied");
    await manager.rollback(first, { reason: "unwind partial batch" }, writer);
    expect(store.peek(first)?.status).toBe("reverted");
  });

  it("refuses a batch that spans multiple clients", async () => {
    const { manager } = setup();
    const mixed = [desired({ clientId: "c1" }), desired({ clientId: "c2" })];
    await expect(manager.previewBatch(mixed, writer)).rejects.toThrow(
      ConstraintViolationError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* invariant: auto-rollback on threshold breach                       */
/* ------------------------------------------------------------------ */

describe("auto-rollback (MONITOR)", () => {
  const executePolicy: AutoRollbackPolicyResolver = () => ({
    mode: "execute",
    thresholds: { visibility: 30 },
  });
  const flagPolicy: AutoRollbackPolicyResolver = () => ({
    mode: "flag",
    thresholds: { visibility: 30 },
  });
  const offPolicy: AutoRollbackPolicyResolver = () => ({
    mode: "off",
    thresholds: { visibility: 30 },
  });

  async function applied(policyResolver: AutoRollbackPolicyResolver, alertSink?: {
    emit: (a: AlertDraft) => void | Promise<void>;
  }) {
    const h = setup({ policyResolver, alertSink });
    const d = desired();
    seedLive(h.wp, d);
    const p = await h.manager.preview(d, writer);
    await h.manager.apply(p.change.id, { approvedBy: "h" }, writer);
    return { ...h, d, id: p.change.id };
  }

  it("auto-reverts on a breach, logs the reason, restores the site, emits an alert", async () => {
    const alerts: AlertDraft[] = [];
    const { manager, wp, d, id } = await applied(executePolicy, {
      emit: (a) => {
        alerts.push(a);
      },
    });
    const mon = await manager.monitor(id, [sig({ deltaPct: -45 })], writer);
    expect(mon.action).toBe("auto_reverted");
    expect(mon.change?.status).toBe("auto_reverted");
    expect(mon.change?.reverted_reason).toMatch(/^auto-rollback/);
    expect(wp.count("revert")).toBe(1);
    expect(wp.current(d.target)).toBe(d.before); // restored
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("auto_rollback_fired");
    expect(alerts[0].tenantId).toBe("t1");
  });

  it("flag mode surfaces the breach but performs NO write", async () => {
    const { manager, wp, store, id } = await applied(flagPolicy);
    const mon = await manager.monitor(id, [sig({ deltaPct: -80 })], writer);
    expect(mon.action).toBe("flagged");
    expect(mon.breaches).toHaveLength(1);
    expect(wp.count("revert")).toBe(0);
    expect(store.peek(id)?.status).toBe("applied");
  });

  it("off mode takes no action", async () => {
    const { manager, id } = await applied(offPolicy);
    const mon = await manager.monitor(id, [sig({ deltaPct: -99 })], writer);
    expect(mon.action).toBe("none");
    expect(mon.breaches).toEqual([]);
  });

  it("no action when the drop is within tolerance", async () => {
    const { manager, wp, id } = await applied(executePolicy);
    const mon = await manager.monitor(id, [sig({ deltaPct: -5 })], writer);
    expect(mon.action).toBe("none");
    expect(wp.count("revert")).toBe(0);
  });

  it("does not monitor a change that is not applied", async () => {
    const { manager, wp } = setup({ policyResolver: executePolicy });
    const p = await manager.preview(desired(), writer); // never applied
    const mon = await manager.monitor(p.change.id, [sig()], writer);
    expect(mon.action).toBe("none");
    expect(wp.count("revert")).toBe(0);
  });

  it("auto_revert_failed leaves the change applied and retryable", async () => {
    const { manager, wp, store, d, id } = await applied(executePolicy);
    wp.failRevertAt(d.target); // the revert write will throw
    const mon = await manager.monitor(id, [sig({ deltaPct: -60 })], writer);
    expect(mon.action).toBe("auto_revert_failed");
    expect(mon.error).toBeInstanceOf(Error);
    expect(store.peek(id)?.status).toBe("applied"); // unchanged, can retry
  });

  it("a throwing alert sink does not undo the auto-rollback", async () => {
    const { manager, store, id } = await applied(executePolicy, {
      emit: () => {
        throw new Error("alert bus down");
      },
    });
    const mon = await manager.monitor(id, [sig({ deltaPct: -60 })], writer);
    expect(mon.action).toBe("auto_reverted");
    expect(mon.warnings.map((w) => w.code)).toContain("alert_emit_failed");
    expect(store.peek(id)?.status).toBe("auto_reverted");
  });
});

/* ------------------------------------------------------------------ */
/* invariant: tenant context never crosses                            */
/* ------------------------------------------------------------------ */

describe("tenant isolation", () => {
  it("a change is invisible and unusable from another tenant", async () => {
    const { manager, wp } = setup();
    const d = desired();
    seedLive(wp, d);
    const p = await manager.preview(d, writer); // tenant t1
    const other = ctx("operator", "t2", "u-op2");

    await expect(
      manager.apply(p.change.id, { approvedBy: "h" }, other),
    ).rejects.toThrow(ChangeNotFoundError);
    await expect(
      manager.rollback(p.change.id, { reason: "x" }, other),
    ).rejects.toThrow(ChangeNotFoundError);
    await expect(manager.monitor(p.change.id, [], other)).rejects.toThrow(
      ChangeNotFoundError,
    );
    expect(wp.count("apply")).toBe(0);
  });

  it("client_viewer can never write — preview/apply/rollback all refused", async () => {
    const { manager, wp } = setup();
    const d = desired();
    seedLive(wp, d);
    await expect(manager.preview(d, viewer)).rejects.toThrow(AuthorizationError);

    const p = await manager.preview(d, writer);
    await expect(
      manager.apply(p.change.id, { approvedBy: "h" }, viewer),
    ).rejects.toThrow(AuthorizationError);
    await expect(
      manager.rollback(p.change.id, { reason: "x" }, viewer),
    ).rejects.toThrow(AuthorizationError);
    expect(wp.count("apply")).toBe(0);
  });

  it("preview refuses a change whose tenant differs from the operating scope", async () => {
    const { manager } = setup();
    await expect(
      manager.preview(desired({ tenantId: "t2" }), writer),
    ).rejects.toThrow(TenantScopeError);
  });
});

/* ------------------------------------------------------------------ */
/* drift handling (rollback-safety)                                   */
/* ------------------------------------------------------------------ */

describe("drift between preview and apply", () => {
  it("warns (non-fatal) and re-baselines rollback to the LIVE state", async () => {
    const { manager, wp } = setup();
    const d = desired({ before: "Old", after: "New" });
    wp.setCurrent(d.target, "DRIFTED"); // live changed since the preview
    const p = await manager.preview(d, writer);
    const applied = await manager.apply(p.change.id, { approvedBy: "h" }, writer);
    expect(applied.warnings.map((w) => w.code)).toContain("drift_detected");
    expect(wp.current(d.target)).toBe("New");

    await manager.rollback(p.change.id, { reason: "undo" }, writer);
    // restored to the FRESH captured before ("DRIFTED"), not the stale "Old"
    expect(wp.current(d.target)).toBe("DRIFTED");
  });
});

/* ------------------------------------------------------------------ */
/* determinism                                                        */
/* ------------------------------------------------------------------ */

describe("determinism", () => {
  it("identical runs under a fixed clock produce identical rows (no wall-clock)", async () => {
    async function run() {
      const { manager, wp } = setup({
        clock: fixedClock("2026-07-08T12:00:00.000Z"),
      });
      const d = desired();
      seedLive(wp, d);
      const p = await manager.preview(d, writer);
      const a = await manager.apply(p.change.id, { approvedBy: "h" }, writer);
      return a.change;
    }
    const r1 = await run();
    const r2 = await run();
    expect(r2).toEqual(r1);
    expect(r1.applied_at).toBe("2026-07-08T12:00:00.000Z"); // injected, not Date.now
    expect(r1.id).toBe("sc-1"); // deterministic ids
  });
});

/* ------------------------------------------------------------------ */
/* store backstop (emulates RLS + CHECK constraints)                  */
/* ------------------------------------------------------------------ */

describe("InMemoryChangeStore backstop", () => {
  function newChange(): NewPreviewedChange {
    return {
      clientId: "c1",
      propertyId: "p1",
      method: "wordpress",
      changeType: "title",
      automationLevel: "ai_draft_human_approve",
      diff: { before: "a", after: "b", target: { url: "https://c/" } },
    };
  }

  it("refuses a non-writer insert (RLS is_writer)", async () => {
    const store = new InMemoryChangeStore({ clock: fixedClock("2026-07-08T00:00:00.000Z") });
    await expect(store.insertPreviewed(newChange(), viewer)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("refuses an illegal direct status jump (previewed → reverted)", async () => {
    const store = new InMemoryChangeStore({ clock: fixedClock("2026-07-08T00:00:00.000Z") });
    const row = await store.insertPreviewed(newChange(), writer);
    await expect(
      store.update(
        row.id,
        { status: "reverted", revertedAt: "2026-07-08T00:00:01.000Z" },
        writer,
      ),
    ).rejects.toThrow(IllegalTransitionError);
  });

  it("refuses composing an applied row without an approver (CHECK)", async () => {
    const store = new InMemoryChangeStore({ clock: fixedClock("2026-07-08T00:00:00.000Z") });
    const row = await store.insertPreviewed(newChange(), writer);
    await expect(
      store.update(
        row.id,
        { status: "applied", appliedAt: "2026-07-08T00:00:01.000Z" },
        writer,
      ),
    ).rejects.toThrow(ConstraintViolationError);
  });

  it("hides a row from another tenant (get → null, update → not found)", async () => {
    const store = new InMemoryChangeStore({ clock: fixedClock("2026-07-08T00:00:00.000Z") });
    const row = await store.insertPreviewed(newChange(), writer);
    const other = ctx("operator", "t2", "u-op2");
    expect(await store.getById(row.id, other)).toBeNull();
    await expect(
      store.update(row.id, { status: "applied" }, other),
    ).rejects.toThrow(ChangeNotFoundError);
  });
});
