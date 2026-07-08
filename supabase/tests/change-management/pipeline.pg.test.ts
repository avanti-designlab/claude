/**
 * Change-management pipeline vs the REAL F1 Postgres schema (Phase 1.2;
 * doc 04 §2; doc 07 §1.2 gate: Code Review rollback safety + QA rollback
 * suite).
 *
 * Runs the ACTUAL ChangeManager against the frozen migrations through RLS
 * (PgChangeStore → queryAs → SET ROLE authenticated + JWT claims), proving:
 *
 *  1. the full lifecycle previewed → applied → reverted/auto_reverted is
 *     contract-legal on the real schema, and every write leaves an audit row;
 *  2. the layer's typed refusals fire BEFORE Postgres is ever asked (approval
 *     gate, state machine, tenant scope, role gate);
 *  3. the schema CHECKs are a live backstop — deliberate bypass attempts at
 *     the SQL level are rejected by the database itself;
 *  4. rollback restores prior state via the SAME adapter that applied, and
 *     auto-rollback executes/records/alerts exactly per policy;
 *  5. bulk batches persist atomically, stop on first failure, and remain
 *     individually revertible.
 *
 * Requires local Postgres (supabase/tests/README.md):
 *   ISOLATION_DATABASE_URL or postgresql://postgres:postgres@127.0.0.1:5432/isolation_test
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApprovalRequiredError,
  AuthorizationError,
  ChangeManager,
  ChangeNotFoundError,
  IllegalTransitionError,
  MapAdapterRegistry,
  RecordingWriteAdapter,
  steppingClock,
  type AlertDraft,
  type AlertSink,
  type AutoRollbackPolicy,
  type ChangeTarget,
  type DesiredChange,
  type MonitoringSignal,
  type TenantContext,
} from "@/lib/change-management";
import type { Json } from "@/lib/types/db";
import {
  claimsFor,
  expectQueryRejected,
  setupIsolationDb,
  type IsolationDb,
} from "../helpers/harness";
import { seedTenantPair, type SeededTenant } from "../helpers/seed";
import { PgChangeStore } from "./pg-change-store";

let db: IsolationDb;
let a: SeededTenant;
let b: SeededTenant;
let store: PgChangeStore;
let adapter: RecordingWriteAdapter;
let registry: MapAdapterRegistry;

/** Collects alerts the pipeline emits (M17 seam). */
class CollectingAlertSink implements AlertSink {
  readonly alerts: AlertDraft[] = [];
  emit(alert: AlertDraft): void {
    this.alerts.push(alert);
  }
}

const EXECUTE_POLICY: AutoRollbackPolicy = {
  mode: "execute",
  thresholds: { traffic: 20, ranking: 30, visibility: 30 },
};
const FLAG_POLICY: AutoRollbackPolicy = {
  mode: "flag",
  thresholds: { traffic: 20 },
};

function ctxFor(t: SeededTenant, role: "operator" | "agency_admin" | "client_viewer", id: string): TenantContext {
  return { tenantId: t.tenantId, actor: { id, role } };
}

function manager(overrides: {
  policy?: AutoRollbackPolicy;
  alertSink?: AlertSink;
} = {}): ChangeManager {
  return new ChangeManager({
    store,
    adapters: registry,
    clock: steppingClock("2026-07-08T12:00:00.000Z"),
    policyResolver: () => overrides.policy ?? FLAG_POLICY,
    alertSink: overrides.alertSink,
  });
}

function desired(t: SeededTenant, target: ChangeTarget, before: Json, after: Json): DesiredChange {
  return {
    tenantId: t.tenantId,
    clientId: t.clientId,
    propertyId: t.propertyId,
    method: "wordpress",
    changeType: "title",
    target,
    before,
    after,
    source: "pg-suite",
  };
}

function breach(deltaPct: number): MonitoringSignal {
  return {
    metric: "traffic",
    deltaPct,
    windowDays: 7,
    observedAt: "2026-07-08T13:00:00.000Z",
    detail: "gsc:clicks",
  };
}

/** Read a row straight from Postgres as superuser (audit-trail ground truth). */
async function dbRow(id: string) {
  const res = await db.admin.query(`select * from site_changes where id = $1`, [id]);
  return res.rows[0];
}

beforeAll(async () => {
  db = await setupIsolationDb();
  const pair = await seedTenantPair(db.admin);
  a = pair.a;
  b = pair.b;
  store = new PgChangeStore(db.admin);
  adapter = new RecordingWriteAdapter("wordpress");
  registry = new MapAdapterRegistry([adapter]);
}, 120_000);

afterAll(async () => {
  await db?.teardown();
});

describe("full lifecycle against the real schema", () => {
  const target: ChangeTarget = { url: "https://client-a.example.com/", locator: "title" };

  it("PREVIEW persists a previewed audit row before anything touches the site", async () => {
    adapter.setCurrent(target, "Old Title");
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const applyCount = adapter.count("apply");

    const preview = await manager().preview(desired(a, target, "Old Title", "New Title"), opCtx);

    expect(preview.change.status).toBe("previewed");
    expect(preview.diff.summary.identical).toBe(false);
    // Ground truth: the row exists in Postgres with the full diff payload.
    const raw = await dbRow(preview.change.id);
    expect(raw.status).toBe("previewed");
    expect(raw.approved_by).toBeNull();
    expect(raw.applied_at).toBeNull();
    expect(raw.diff.before).toBe("Old Title");
    expect(raw.diff.after).toBe("New Title");
    // No site write happened during preview.
    expect(adapter.count("apply")).toBe(applyCount);
    expect(adapter.current(target)).toBe("Old Title");
  });

  it("APPLY refuses without an approver — typed error, row untouched in DB", async () => {
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const preview = await manager().preview(desired(a, target, "Old Title", "New Title"), opCtx);
    const applyCount = adapter.count("apply");

    await expect(
      manager().apply(preview.change.id, { approvedBy: "" }, opCtx)
    ).rejects.toBeInstanceOf(ApprovalRequiredError);

    expect(adapter.count("apply")).toBe(applyCount); // adapter never attempted
    expect((await dbRow(preview.change.id)).status).toBe("previewed");
  });

  it("APPLY with approval writes the site AND transitions the row (approved_by, applied_by, applied_at)", async () => {
    adapter.setCurrent(target, "Old Title");
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const preview = await manager().preview(desired(a, target, "Old Title", "New Title"), opCtx);

    const outcome = await manager().apply(
      preview.change.id,
      { approvedBy: a.adminUserId },
      opCtx
    );

    expect(outcome.change.status).toBe("applied");
    expect(adapter.current(target)).toBe("New Title");
    const raw = await dbRow(preview.change.id);
    expect(raw.status).toBe("applied");
    expect(raw.approved_by).toBe(a.adminUserId);
    expect(raw.applied_by).toBe(a.operatorUserId);
    expect(raw.applied_at).not.toBeNull();
  });

  it("double-apply is refused by the state machine before Postgres is asked", async () => {
    adapter.setCurrent(target, "Old Title");
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const preview = await manager().preview(desired(a, target, "Old Title", "New Title"), opCtx);
    await manager().apply(preview.change.id, { approvedBy: a.adminUserId }, opCtx);
    const applyCount = adapter.count("apply");

    await expect(
      manager().apply(preview.change.id, { approvedBy: a.adminUserId }, opCtx)
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(adapter.count("apply")).toBe(applyCount);
  });

  it("ROLLBACK is one action: same adapter restores the before-state, row → reverted with reason + reverted_at", async () => {
    adapter.setCurrent(target, "Old Title");
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const preview = await manager().preview(desired(a, target, "Old Title", "New Title"), opCtx);
    await manager().apply(preview.change.id, { approvedBy: a.adminUserId }, opCtx);
    expect(adapter.current(target)).toBe("New Title");

    const outcome = await manager().rollback(
      preview.change.id,
      { reason: "operator one-click revert (pg suite)" },
      opCtx
    );

    expect(outcome.change.status).toBe("reverted");
    expect(adapter.current(target)).toBe("Old Title"); // prior state restored
    const raw = await dbRow(preview.change.id);
    expect(raw.status).toBe("reverted");
    expect(raw.reverted_reason).toBe("operator one-click revert (pg suite)");
    expect(raw.reverted_at).not.toBeNull();
    // Audit trail intact: apply actors survive the revert.
    expect(raw.approved_by).toBe(a.adminUserId);
    expect(raw.applied_at).not.toBeNull();
  });

  it("rollback of a never-applied (previewed) change is refused", async () => {
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const preview = await manager().preview(desired(a, target, "Old Title", "New Title"), opCtx);
    await expect(
      manager().rollback(preview.change.id, { reason: "nothing to revert" }, opCtx)
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it("adapter revert failure surfaces and the row STAYS applied (retryable)", async () => {
    const failTarget: ChangeTarget = { url: "https://client-a.example.com/fail-revert", locator: "title" };
    adapter.setCurrent(failTarget, "Old");
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const preview = await manager().preview(desired(a, failTarget, "Old", "New"), opCtx);
    await manager().apply(preview.change.id, { approvedBy: a.adminUserId }, opCtx);

    adapter.failRevertAt(failTarget);
    await expect(
      manager().rollback(preview.change.id, { reason: "will fail" }, opCtx)
    ).rejects.toThrow(/forced revert failure/);
    expect((await dbRow(preview.change.id)).status).toBe("applied"); // unchanged, retryable
  });
});

describe("schema backstops (deliberate SQL-level bypass attempts)", () => {
  it("the DB itself refuses leaving 'previewed' without approved_by (site_changes_requires_approval)", async () => {
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsFor("operator", a.tenantId),
      `update site_changes
         set status = 'applied', applied_at = now()
       where id = $1`,
      [a.siteChangeId],
      /site_changes_requires_approval/
    );
  });

  it("the DB itself refuses automation_level 'auto' on site_changes", async () => {
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsFor("operator", a.tenantId),
      `insert into site_changes
         (tenant_id, client_id, property_id, method, change_type, automation_level, diff)
       values ($1, $2, $3, 'wordpress', 'title', 'auto', '{"before": "a", "after": "b"}')`,
      [a.tenantId, a.clientId, a.propertyId],
      /site_changes_automation_level_allowed/
    );
  });

  it("the DB itself refuses a reverted state without reverted_at", async () => {
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsFor("operator", a.tenantId),
      `update site_changes
         set status = 'reverted',
             approved_by = $2,
             applied_at = now()
       where id = $1`,
      [a.siteChangeId, a.adminUserId],
      /site_changes_reverted_has_timestamp/
    );
  });
});

describe("tenant isolation + role gates through real RLS", () => {
  const target: ChangeTarget = { url: "https://client-a.example.com/iso", locator: "title" };

  it("tenant B cannot see or act on tenant A's change (RLS: invisible, not forbidden)", async () => {
    adapter.setCurrent(target, "Old");
    const opCtxA = ctxFor(a, "operator", a.operatorUserId);
    const preview = await manager().preview(desired(a, target, "Old", "New"), opCtxA);

    const opCtxB = ctxFor(b, "operator", b.operatorUserId);
    await expect(
      manager().apply(preview.change.id, { approvedBy: b.adminUserId }, opCtxB)
    ).rejects.toBeInstanceOf(ChangeNotFoundError);
    await expect(
      manager().rollback(preview.change.id, { reason: "cross-tenant" }, opCtxB)
    ).rejects.toBeInstanceOf(ChangeNotFoundError);
    expect((await dbRow(preview.change.id)).status).toBe("previewed");
  });

  it("a change cannot be smuggled across tenants at preview (seam + RLS agree)", async () => {
    const opCtxB = ctxFor(b, "operator", b.operatorUserId);
    // DesiredChange says tenant A, operating context is tenant B → refused at the seam.
    await expect(
      manager().preview(desired(a, target, "Old", "New"), opCtxB)
    ).rejects.toThrow(/does not match the operating tenant/);
  });

  it("client_viewer can never write: refused at the seam AND by the database", async () => {
    const viewerCtx = ctxFor(a, "client_viewer", a.viewerUserId);
    await expect(
      manager().preview(desired(a, target, "Old", "New"), viewerCtx)
    ).rejects.toBeInstanceOf(AuthorizationError);

    // Bypass the manager entirely: the store hits RLS, which refuses the insert.
    await expect(
      store.insertPreviewed(
        {
          clientId: a.clientId,
          propertyId: a.propertyId,
          method: "wordpress",
          changeType: "title",
          automationLevel: "ai_draft_human_approve",
          diff: { before: "x", after: "y", target },
        },
        viewerCtx
      )
    ).rejects.toThrow(/row-level security/);
  });
});

describe("MONITOR → auto-rollback against the real schema", () => {
  const target: ChangeTarget = { url: "https://client-a.example.com/monitored", locator: "title" };

  async function appliedChange(): Promise<string> {
    adapter.setCurrent(target, "Stable Title");
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const preview = await manager().preview(desired(a, target, "Stable Title", "Risky Title"), opCtx);
    await manager().apply(preview.change.id, { approvedBy: a.adminUserId }, opCtx);
    return preview.change.id;
  }

  it("flag mode: breach is flagged for a human; the DB row stays applied", async () => {
    const id = await appliedChange();
    const opCtx = ctxFor(a, "operator", a.operatorUserId);

    const evaluation = await manager({ policy: FLAG_POLICY }).monitor(id, [breach(-42)], opCtx);

    expect(evaluation.action).toBe("flagged");
    expect(evaluation.breaches).toHaveLength(1);
    expect((await dbRow(id)).status).toBe("applied");
    expect(adapter.current(target)).toBe("Risky Title");
  });

  it("execute mode: breach auto-reverts on site AND in the DB, records the reason, emits the alert", async () => {
    const id = await appliedChange();
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const sink = new CollectingAlertSink();

    const evaluation = await manager({ policy: EXECUTE_POLICY, alertSink: sink }).monitor(
      id,
      [breach(-42)],
      opCtx
    );

    expect(evaluation.action).toBe("auto_reverted");
    expect(adapter.current(target)).toBe("Stable Title"); // site restored
    const raw = await dbRow(id);
    expect(raw.status).toBe("auto_reverted");
    expect(raw.reverted_at).not.toBeNull();
    expect(raw.reverted_reason).toMatch(/auto-rollback: traffic -42%/);
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({
      tenantId: a.tenantId,
      clientId: a.clientId,
      type: "auto_rollback_fired",
      severity: "critical",
    });
  });

  it("below-threshold signals hold: no action, row stays applied", async () => {
    const id = await appliedChange();
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const evaluation = await manager({ policy: EXECUTE_POLICY }).monitor(id, [breach(-10)], opCtx);
    expect(evaluation.action).toBe("none");
    expect((await dbRow(id)).status).toBe("applied");
  });

  it("auto-revert adapter failure: monitoring survives, row stays applied + retryable", async () => {
    const failTarget: ChangeTarget = { url: "https://client-a.example.com/monitored-fail", locator: "title" };
    adapter.setCurrent(failTarget, "Stable");
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const preview = await manager().preview(desired(a, failTarget, "Stable", "Risky"), opCtx);
    await manager().apply(preview.change.id, { approvedBy: a.adminUserId }, opCtx);

    adapter.failRevertAt(failTarget);
    const evaluation = await manager({ policy: EXECUTE_POLICY }).monitor(
      preview.change.id,
      [breach(-42)],
      opCtx
    );

    expect(evaluation.action).toBe("auto_revert_failed");
    expect(evaluation.error?.message).toMatch(/forced revert failure/);
    expect((await dbRow(preview.change.id)).status).toBe("applied");
  });
});

describe("bulk batches against the real schema", () => {
  function bulkDesired(paths: string[]): DesiredChange[] {
    return paths.map((path) =>
      desired(
        a,
        { url: `https://client-a.example.com${path}`, locator: "title" },
        `Old ${path}`,
        `New ${path}`
      )
    );
  }

  it("previewBatch persists ALL members atomically as one reviewable batch", async () => {
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const members = bulkDesired(["/b1", "/b2", "/b3"]);
    members.forEach((m) => adapter.setCurrent(m.target, m.before));

    const batch = await manager().previewBatch(members, opCtx);

    expect(batch.members).toHaveLength(3);
    expect(batch.summary.byChangeType.title).toBe(3);
    for (const member of batch.members) {
      expect((await dbRow(member.change.id)).status).toBe("previewed");
    }
  });

  it("applyBatch without an approver applies NOTHING", async () => {
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const members = bulkDesired(["/c1", "/c2"]);
    members.forEach((m) => adapter.setCurrent(m.target, m.before));
    const batch = await manager().previewBatch(members, opCtx);

    await expect(
      manager().applyBatch(batch, { approvedBy: "" }, opCtx)
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    for (const member of batch.members) {
      expect((await dbRow(member.change.id)).status).toBe("previewed");
    }
  });

  it("partial-apply: failure STOPS the batch, is reported, and applied members remain individually revertible", async () => {
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const members = bulkDesired(["/d1", "/d2", "/d3"]);
    members.forEach((m) => adapter.setCurrent(m.target, m.before));
    const batch = await manager().previewBatch(members, opCtx);
    adapter.failApplyAt(members[1].target); // member 2 will fail

    const report = await manager().applyBatch(batch, { approvedBy: a.adminUserId }, opCtx);

    expect(report.complete).toBe(false);
    expect(report.applied.map((o) => o.change.id)).toEqual([batch.members[0].change.id]);
    expect(report.failed?.changeId).toBe(batch.members[1].change.id);
    expect(report.notAttempted).toEqual([batch.members[2].change.id]);
    expect((await dbRow(batch.members[0].change.id)).status).toBe("applied");
    expect((await dbRow(batch.members[1].change.id)).status).toBe("previewed");
    expect((await dbRow(batch.members[2].change.id)).status).toBe("previewed");

    // The applied member is individually revertible (doc 04 §2).
    const rollback = await manager().rollback(
      batch.members[0].change.id,
      { reason: "revert the partial batch member" },
      opCtx
    );
    expect(rollback.change.status).toBe("reverted");
    expect(adapter.current(members[0].target)).toBe("Old /d1");
  });

  it("re-running applyBatch resumes: skips applied members, applies the rest to completion", async () => {
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const members = bulkDesired(["/e1", "/e2", "/e3"]);
    members.forEach((m) => adapter.setCurrent(m.target, m.before));
    const batch = await manager().previewBatch(members, opCtx);

    // Member 1 is already applied (an earlier partial run).
    await manager().apply(batch.members[0].change.id, { approvedBy: a.adminUserId }, opCtx);

    const report = await manager().applyBatch(batch, { approvedBy: a.adminUserId }, opCtx);

    expect(report.previouslyApplied).toEqual([batch.members[0].change.id]);
    expect(report.applied.map((o) => o.change.id)).toEqual([
      batch.members[1].change.id,
      batch.members[2].change.id,
    ]);
    expect(report.failed).toBeUndefined();
    expect(report.complete).toBe(true);
    for (const member of batch.members) {
      expect((await dbRow(member.change.id)).status).toBe("applied");
    }
  });
});

describe("store optimistic transition guard through real RLS (DB-query layer, INV 5)", () => {
  const target: ChangeTarget = { url: "https://client-a.example.com/guard", locator: "title" };

  it("refuses a stale/concurrent illegal transition at the store layer, independent of the manager pre-check", async () => {
    adapter.setCurrent(target, "Old");
    const opCtx = ctxFor(a, "operator", a.operatorUserId);
    const preview = await manager().preview(desired(a, target, "Old", "New"), opCtx);
    await manager().apply(preview.change.id, { approvedBy: a.adminUserId }, opCtx);

    // Simulate a SECOND, concurrent apply that raced past the manager's in-process
    // state check (a real TOCTOU) by hitting the store directly: applied → applied.
    // The DB does NOT enforce transition DIRECTION via CHECK (only field presence),
    // so the store's optimistic `status = any(legal-sources)` predicate is the
    // DB-executed backstop. legal-sources('applied') = ['previewed'] and the row is
    // 'applied', so the UPDATE matches ZERO rows and refuses — no silent re-apply.
    await expect(
      store.update(
        preview.change.id,
        { status: "applied", approvedBy: a.adminUserId, appliedAt: "2026-07-08T12:00:00.000Z" },
        opCtx
      )
    ).rejects.toBeInstanceOf(ChangeNotFoundError);
    expect((await dbRow(preview.change.id)).status).toBe("applied"); // unchanged

    // Revert once through the pipeline; a stale re-revert is likewise refused
    // (legal-sources('reverted') = ['applied'], but the row is now 'reverted').
    await manager().rollback(preview.change.id, { reason: "one-click" }, opCtx);
    await expect(
      store.update(
        preview.change.id,
        { status: "reverted", revertedAt: "2026-07-08T12:00:01.000Z", revertedReason: "double revert" },
        opCtx
      )
    ).rejects.toBeInstanceOf(ChangeNotFoundError);

    // Ground truth: exactly one revert; both stale writes were blocked.
    expect((await dbRow(preview.change.id)).status).toBe("reverted");
  });
});
