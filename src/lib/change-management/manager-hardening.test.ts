/**
 * ChangeManager hardening suite — the seams not covered by the main
 * lifecycle suite (manager.test.ts):
 *
 *  - rollback reason is REQUIRED (reverted_reason is the audit trail;
 *    doc 04 §2 step 5) — refused BEFORE any adapter or store touch;
 *  - auto-rollback needs no caller-supplied reason (it generates its own
 *    from the breaches) — the requirement is manual-path-only;
 *  - verifyConnection (doc 04 §4): a read-only, no-op access check that
 *    never writes and never persists — success and failure both reported,
 *    unregistered methods and non-writer roles refused.
 */

import { describe, expect, it } from "vitest";
import type { TenantUserRole } from "@/lib/types/db";
import {
  AuthorizationError,
  ChangeManager,
  InMemoryChangeStore,
  MapAdapterRegistry,
  RecordingWriteAdapter,
  RollbackReasonRequiredError,
  steppingClock,
  type DesiredChange,
  type MonitoringSignal,
  type TenantContext,
} from "./index";

function ctx(role: TenantUserRole = "operator", id = "u-op"): TenantContext {
  return { tenantId: "t1", actor: { id, role } };
}

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
    after: "New Title",
    ...overrides,
  };
}

function setup() {
  const clock = steppingClock("2026-07-08T00:00:00.000Z", 1000);
  const store = new InMemoryChangeStore({ clock });
  const wp = new RecordingWriteAdapter("wordpress");
  const manager = new ChangeManager({
    store,
    adapters: new MapAdapterRegistry([wp]),
    clock,
    policyResolver: () => ({ mode: "execute", thresholds: { traffic: 20 } }),
  });
  return { manager, store, wp };
}

async function applied(manager: ChangeManager, wp: RecordingWriteAdapter) {
  const d = desired();
  wp.setCurrent(d.target, d.before);
  const preview = await manager.preview(d, ctx());
  await manager.apply(preview.change.id, { approvedBy: "u-approver" }, ctx());
  return { d, id: preview.change.id };
}

describe("rollback reason is required (manual path)", () => {
  it("refuses an empty reason before touching the adapter or the store", async () => {
    const { manager, store, wp } = setup();
    const { id } = await applied(manager, wp);
    const revertsBefore = wp.count("revert");

    for (const reason of ["", "   "]) {
      await expect(
        manager.rollback(id, { reason }, ctx())
      ).rejects.toBeInstanceOf(RollbackReasonRequiredError);
    }

    expect(wp.count("revert")).toBe(revertsBefore); // adapter never attempted
    expect(store.peek(id)?.status).toBe("applied"); // row untouched, retryable
    expect(store.peek(id)?.reverted_reason).toBeNull();
  });

  it("a real reason still reverts in one action", async () => {
    const { manager, store, wp } = setup();
    const { d, id } = await applied(manager, wp);

    const outcome = await manager.rollback(id, { reason: "operator revert" }, ctx());

    expect(outcome.change.status).toBe("reverted");
    expect(store.peek(id)?.reverted_reason).toBe("operator revert");
    expect(wp.current(d.target)).toBe(d.before);
  });

  it("auto-rollback is NOT blocked by the manual-reason rule — it generates its own", async () => {
    const { manager, store, wp } = setup();
    const { id } = await applied(manager, wp);
    const breach: MonitoringSignal = {
      metric: "traffic",
      deltaPct: -50,
      observedAt: "2026-07-08T01:00:00.000Z",
    };

    const evaluation = await manager.monitor(id, [breach], ctx());

    expect(evaluation.action).toBe("auto_reverted");
    expect(store.peek(id)?.reverted_reason).toMatch(/^auto-rollback: traffic -50%/);
  });
});

describe("verifyConnection (doc 04 §4 no-op access check)", () => {
  const check = {
    clientId: "c1",
    propertyId: "p1",
    method: "wordpress" as const,
    target: { url: "https://client.example/", locator: "title" },
  };

  it("reports ok on a reachable property WITHOUT writing or persisting anything", async () => {
    const { manager, store, wp } = setup();
    const verification = await manager.verifyConnection(check, ctx());

    expect(verification).toEqual({
      method: "wordpress",
      ok: true,
      detail: "read access verified",
    });
    expect(wp.count("read")).toBe(1);
    expect(wp.count("apply")).toBe(0);
    expect(wp.count("revert")).toBe(0);
    // No site_changes row was minted by a connection check.
    expect(store.peek("sc-1")).toBeUndefined();
  });

  it("reports (not throws) failure when no adapter is registered for the method", async () => {
    const { manager } = setup();
    const verification = await manager.verifyConnection(
      { ...check, method: "webflow" },
      ctx()
    );
    expect(verification.ok).toBe(false);
    expect(verification.detail).toMatch(/no write method adapter registered for 'webflow'/);
  });

  it("reports (not throws) failure when the adapter read throws", async () => {
    const { manager, wp } = setup();
    const original = wp.readCurrent.bind(wp);
    wp.readCurrent = async () => {
      wp.readCurrent = original;
      throw new Error("401 unauthorized");
    };

    const verification = await manager.verifyConnection(check, ctx());
    expect(verification.ok).toBe(false);
    expect(verification.detail).toBe("401 unauthorized");
  });

  it("client_viewer may not even probe connections", async () => {
    const { manager } = setup();
    await expect(
      manager.verifyConnection(check, ctx("client_viewer", "u-cv"))
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
