/**
 * F1 isolation suite — STRUCTURAL GATES (contract §4, §5, §6; doc 00 §7.3).
 *
 * These invariants live BELOW RLS: CHECK constraints and composite foreign
 * keys that hold even for the superuser (RLS-bypassing) connection. If any of
 * these can be bypassed, isolation/governance is breakable regardless of
 * policies. Run as `db.admin` (superuser): RLS is bypassed, so ONLY the
 * structural guards are under test.
 *
 *  - content_items cannot reach approved/published without BOTH review verdicts.
 *  - NO site_change can leave `previewed` without a recorded approver
 *    (contract §6: no automation-level exemption exists); lifecycle
 *    timestamps are enforced.
 *  - automation_level rejects unknown values, and 'auto' is structurally
 *    impossible on site_changes (doc 00 §2, CLAUDE.md rule 5) while remaining
 *    valid on the non-publishing carriers (tasks, content_items).
 *  - composite FKs forbid pointing a row at another tenant's — or another
 *    client's — parent, even for the superuser.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupIsolationDb, type IsolationDb } from "../helpers/harness";
import {
  seedSiblingClientRows,
  seedTenantPair,
  type SeededTenant,
  type SiblingClientRows,
} from "../helpers/seed";

let db: IsolationDb;
let a: SeededTenant;
let b: SeededTenant;
let sibA: SiblingClientRows;

beforeAll(async () => {
  db = await setupIsolationDb();
  ({ a, b } = await seedTenantPair(db.admin));
  // A sibling client under tenant A — gives a same-tenant/other-client plan for
  // the composite-FK "same client, not just same tenant" assertion.
  sibA = await seedSiblingClientRows(db.admin, a);
});

afterAll(async () => {
  await db?.teardown();
});

async function expectRejected(
  sql: string,
  params: unknown[],
  pattern: RegExp
): Promise<void> {
  await expect(db.admin.query(sql, params)).rejects.toThrow(pattern);
}

describe("content_items review gate — no approval/publish without BOTH verdicts (doc 00 §7.3)", () => {
  const bothNull =
    `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, status`;

  it("INSERT status='approved' with NO verdicts is rejected", async () => {
    await expectRejected(
      `${bothNull}) values ($1, $2, 'blog', $3, 'x', 'approved')`,
      [a.tenantId, a.clientId, a.brandKitId],
      /content_items_reviewed_before_approval/
    );
  });

  it("INSERT status='published' with NO verdicts is rejected", async () => {
    await expectRejected(
      `${bothNull}) values ($1, $2, 'blog', $3, 'x', 'published')`,
      [a.tenantId, a.clientId, a.brandKitId],
      /content_items_reviewed_before_approval/
    );
  });

  it("INSERT status='approved' with ONLY quality_review is rejected", async () => {
    await expectRejected(
      `${bothNull}, quality_review) values ($1, $2, 'blog', $3, 'x', 'approved', '{}'::jsonb)`,
      [a.tenantId, a.clientId, a.brandKitId],
      /content_items_reviewed_before_approval/
    );
  });

  it("INSERT status='approved' with ONLY compliance_review is rejected", async () => {
    await expectRejected(
      `${bothNull}, compliance_review) values ($1, $2, 'blog', $3, 'x', 'approved', '{}'::jsonb)`,
      [a.tenantId, a.clientId, a.brandKitId],
      /content_items_reviewed_before_approval/
    );
  });

  it("UPDATE draft → approved without verdicts is rejected", async () => {
    await expectRejected(
      `update content_items set status = 'approved' where id = $1`,
      [a.contentItemId],
      /content_items_reviewed_before_approval/
    );
  });

  it("positive: approved WITH both verdicts succeeds (gate passes when reviewed)", async () => {
    const res = await db.admin.query(
      `${bothNull}, quality_review, compliance_review)
       values ($1, $2, 'blog', $3, 'x', 'approved', '{"v":"ok"}'::jsonb, '{"v":"ok"}'::jsonb)`,
      [a.tenantId, a.clientId, a.brandKitId]
    );
    expect(res.rowCount).toBe(1);
  });
});

describe("site_changes approval + lifecycle gates (contract §6; doc 03 §3)", () => {
  const base =
    `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff, automation_level, status, approved_by, applied_at)`;
  const diff = `'{"before":"a","after":"b"}'::jsonb`;

  it("ai_draft_human_approve change cannot go 'applied' without an approver", async () => {
    await expectRejected(
      `${base} values ($1, $2, $3, 'wordpress', 'title', ${diff}, 'ai_draft_human_approve', 'applied', null, now())`,
      [a.tenantId, a.clientId, a.propertyId],
      /site_changes_requires_approval/
    );
  });

  it("human_only change cannot go 'applied' without an approver", async () => {
    await expectRejected(
      `${base} values ($1, $2, $3, 'wordpress', 'title', ${diff}, 'human_only', 'applied', null, now())`,
      [a.tenantId, a.clientId, a.propertyId],
      /site_changes_requires_approval/
    );
  });

  it("'applied' without an applied_at timestamp is rejected (lifecycle integrity)", async () => {
    // Approver recorded and automation_level valid, so the ONLY violated
    // constraint is the timestamp gate — the assertion is deterministic.
    await expectRejected(
      `${base} values ($1, $2, $3, 'wordpress', 'title', ${diff}, 'ai_draft_human_approve', 'applied', $4, null)`,
      [a.tenantId, a.clientId, a.propertyId, a.operatorUserId],
      /site_changes_applied_has_timestamp/
    );
  });

  it("positive: a change with a recorded approver may go 'applied'", async () => {
    const res = await db.admin.query(
      `${base} values ($1, $2, $3, 'wordpress', 'title', ${diff}, 'ai_draft_human_approve', 'applied', $4, now())`,
      [a.tenantId, a.clientId, a.propertyId, a.operatorUserId]
    );
    expect(res.rowCount).toBe(1);
  });
});

describe("'auto' is structurally impossible on site_changes (doc 00 §2, CLAUDE.md rule 5; contract §6)", () => {
  // Inverse of the pre-remediation exemption: fully autonomous on-page
  // publishing can no longer even be REPRESENTED on this table.
  const insertCols =
    `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff, automation_level)`;
  const diff = `'{"before":"a","after":"b"}'::jsonb`;

  it("INSERT with automation_level='auto' is rejected by site_changes_automation_level_allowed", async () => {
    // status stays at the 'previewed' default, so the ONLY violated
    // constraint is the automation-level CHECK — deterministic assertion.
    await expectRejected(
      `${insertCols} values ($1, $2, $3, 'edge_worker', 'schema', ${diff}, 'auto')`,
      [a.tenantId, a.clientId, a.propertyId],
      /site_changes_automation_level_allowed/
    );
  });

  it("UPDATE of an existing site_change to automation_level='auto' is rejected", async () => {
    await expectRejected(
      `update site_changes set automation_level = 'auto' where id = $1`,
      [a.siteChangeId],
      /site_changes_automation_level_allowed/
    );
  });

  it("'auto' remains VALID on tasks and content_items (non-publishing carriers, contract §6)", async () => {
    const task = await db.admin.query(
      `insert into tasks (tenant_id, client_id, plan_id, module, automation_level)
       values ($1, $2, $3, 'rank_tracking', 'auto')`,
      [a.tenantId, a.clientId, a.planId]
    );
    expect(task.rowCount).toBe(1);
    const content = await db.admin.query(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, automation_level)
       values ($1, $2, 'blog', $3, 'x', 'auto')`,
      [a.tenantId, a.clientId, a.brandKitId]
    );
    expect(content.rowCount).toBe(1);
  });

  it("an 'auto' content_item still cannot reach 'published' without BOTH review verdicts", async () => {
    // 'auto' never shortcuts the review gate (contract §6): no verdicts…
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, automation_level, status)
       values ($1, $2, 'blog', $3, 'x', 'auto', 'published')`,
      [a.tenantId, a.clientId, a.brandKitId],
      /content_items_reviewed_before_approval/
    );
    // …and ONE verdict is not enough either.
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, automation_level, status, quality_review)
       values ($1, $2, 'blog', $3, 'x', 'auto', 'published', '{}'::jsonb)`,
      [a.tenantId, a.clientId, a.brandKitId],
      /content_items_reviewed_before_approval/
    );
  });
});

describe("automation_level CHECK rejects unknown values (contract §6)", () => {
  // params built lazily (inside each test) — `a` is populated only by beforeAll.
  const cases: {
    table: string;
    sql: string;
    params: () => unknown[];
    constraint: RegExp;
  }[] = [
    {
      table: "tasks",
      sql: `insert into tasks (tenant_id, client_id, plan_id, module, automation_level) values ($1, $2, $3, 'audit', 'yolo')`,
      params: () => [a.tenantId, a.clientId, a.planId],
      constraint: /tasks_automation_level_allowed/,
    },
    {
      table: "content_items",
      sql: `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, automation_level) values ($1, $2, 'blog', $3, 'x', 'yolo')`,
      params: () => [a.tenantId, a.clientId, a.brandKitId],
      constraint: /content_items_automation_level_allowed/,
    },
    {
      table: "site_changes",
      sql: `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff, automation_level) values ($1, $2, $3, 'wordpress', 'title', '{"before":"a","after":"b"}'::jsonb, 'yolo')`,
      params: () => [a.tenantId, a.clientId, a.propertyId],
      constraint: /site_changes_automation_level_allowed/,
    },
  ];
  for (const c of cases) {
    it(`${c.table}: automation_level='yolo' is rejected`, async () => {
      await expectRejected(c.sql, c.params(), c.constraint);
    });
  }
});

describe("composite FKs — tenant/client consistency holds even for the superuser", () => {
  it("tenant-A task cannot point at tenant-B's plan", async () => {
    await expectRejected(
      `insert into tasks (tenant_id, client_id, plan_id, module) values ($1, $2, $3, 'audit')`,
      [a.tenantId, a.clientId, b.planId],
      /foreign key constraint/
    );
  });

  it("tenant-A task cannot point at a SAME-TENANT but different-client plan", async () => {
    // Three-column FK (tenant_id, client_id, plan_id): the plan must belong to
    // the SAME client, not merely the same tenant.
    await expectRejected(
      `insert into tasks (tenant_id, client_id, plan_id, module) values ($1, $2, $3, 'audit')`,
      [a.tenantId, a.clientId, sibA.planId],
      /foreign key constraint/
    );
  });

  it("tenant-A content_item cannot point at tenant-B's brand_kit", async () => {
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body) values ($1, $2, 'blog', $3, 'x')`,
      [a.tenantId, a.clientId, b.brandKitId],
      /foreign key constraint/
    );
  });

  it("tenant-A site_change cannot point at tenant-B's property", async () => {
    await expectRejected(
      `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff) values ($1, $2, $3, 'wordpress', 'title', '{"before":"a","after":"b"}'::jsonb)`,
      [a.tenantId, a.clientId, b.propertyId],
      /foreign key constraint/
    );
  });

  it("tenant-A site_change cannot record a tenant-B user as applied_by (audit-trail actor)", async () => {
    await expectRejected(
      `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff, applied_by) values ($1, $2, $3, 'wordpress', 'title', '{"before":"a","after":"b"}'::jsonb, $4)`,
      [a.tenantId, a.clientId, a.propertyId, b.operatorUserId],
      /foreign key constraint/
    );
  });

  it("tenant-A task cannot be assigned to a tenant-B user", async () => {
    await expectRejected(
      `insert into tasks (tenant_id, client_id, plan_id, module, assigned_to) values ($1, $2, $3, 'audit', $4)`,
      [a.tenantId, a.clientId, a.planId, b.operatorUserId],
      /foreign key constraint/
    );
  });
});
