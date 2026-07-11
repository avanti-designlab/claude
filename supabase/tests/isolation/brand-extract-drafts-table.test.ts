/**
 * F1 isolation suite — brand_extract_drafts STRUCTURAL + supersede gates, and the
 * runs.input_url coupling (migration 0015).
 *
 * Structural invariants (CHECKs, the partial-unique "one proposed per client"
 * index, composite FKs) are proven as `db.admin` (superuser: RLS bypassed, so ONLY
 * the structural guards are under test). The RLS read/write sweeps over
 * brand_extract_drafts are the shared catalog-driven suites (read-isolation /
 * write-isolation / client-viewer / posture) via ALL_TABLES + the WRITE_SPEC; this
 * file adds the table-specific gates those sweeps don't cover, plus a focused
 * writer-only-visibility proof (mirrors the runs precedent).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimsFor,
  queryAs,
  setupIsolationDb,
  type IsolationDb,
} from "../helpers/harness";
import { seedTenantPair, type SeededTenant } from "../helpers/seed";

let db: IsolationDb;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  db = await setupIsolationDb();
  ({ a, b } = await seedTenantPair(db.admin));
});

afterAll(async () => {
  await db?.teardown();
});

async function expectRejected(sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  await expect(db.admin.query(sql, params)).rejects.toThrow(pattern);
}

const INS = `insert into brand_extract_drafts (tenant_id, client_id, draft, status)`;
const OBJ = `'{}'::jsonb`;

describe("brand_extract_drafts closed enum + bounds (CHECKs)", () => {
  it("rejects an unknown status", async () => {
    await expectRejected(
      `${INS} values ($1, $2, ${OBJ}, 'live')`,
      [a.tenantId, a.siblingClientId],
      /brand_extract_drafts_status_allowed/
    );
  });

  it("rejects a non-object draft (array or scalar)", async () => {
    await expectRejected(
      `${INS} values ($1, $2, '[1,2,3]'::jsonb, 'proposed')`,
      [a.tenantId, a.siblingClientId],
      /brand_extract_drafts_draft_is_object/
    );
    await expectRejected(
      `${INS} values ($1, $2, '"x"'::jsonb, 'proposed')`,
      [a.tenantId, a.siblingClientId],
      /brand_extract_drafts_draft_is_object/
    );
  });

  it("rejects an over-cap serialized draft", async () => {
    await expectRejected(
      `${INS} values ($1, $2, jsonb_build_object('blob', repeat('x', 70000)), 'discarded')`,
      [a.tenantId, a.siblingClientId],
      /brand_extract_drafts_draft_bounded/
    );
  });
});

describe("brand_extract_drafts tenant/client consistency (composite FKs, even for the superuser)", () => {
  it("cannot attach to another TENANT's client", async () => {
    await expectRejected(
      `${INS} values ($1, $2, ${OBJ}, 'discarded')`,
      [a.tenantId, b.clientId],
      /foreign key constraint/
    );
  });

  it("cannot reference a run from another tenant (run_id composite FK)", async () => {
    await expectRejected(
      `insert into brand_extract_drafts (tenant_id, client_id, run_id, draft, status)
       values ($1, $2, $3, ${OBJ}, 'discarded')`,
      [a.tenantId, a.siblingClientId, b.runId],
      /foreign key constraint/
    );
  });

  it("CAN reference a run of its OWN tenant, and the draft survives that run's deletion (run_id → NULL)", async () => {
    // A fresh own-tenant run to link + then delete.
    const runRes = await db.admin.query<{ id: string }>(
      `insert into runs (tenant_id, client_id, kind) values ($1, $2, 'audit') returning id`,
      [a.tenantId, a.siblingClientId]
    );
    const runId = runRes.rows[0].id;
    const draftRes = await db.admin.query<{ id: string }>(
      `insert into brand_extract_drafts (tenant_id, client_id, run_id, draft, status)
       values ($1, $2, $3, ${OBJ}, 'discarded') returning id`,
      [a.tenantId, a.siblingClientId, runId]
    );
    const draftId = draftRes.rows[0].id;

    await db.admin.query(`delete from runs where id = $1`, [runId]);
    const after = await db.admin.query<{ run_id: string | null }>(
      `select run_id from brand_extract_drafts where id = $1`,
      [draftId]
    );
    expect(after.rowCount).toBe(1); // the draft (the artifact) survives
    expect(after.rows[0].run_id).toBeNull(); // only the provenance link dropped
  });
});

describe("brand_extract_drafts — NEVER two live (proposed) drafts per client", () => {
  it("a second proposed draft for the same client is refused (partial unique index)", async () => {
    await db.admin.query(`${INS} values ($1, $2, ${OBJ}, 'proposed')`, [
      a.tenantId,
      a.siblingClientId,
    ]);
    await expectRejected(
      `${INS} values ($1, $2, ${OBJ}, 'proposed')`,
      [a.tenantId, a.siblingClientId],
      /brand_extract_drafts_one_proposed_idx/
    );
  });

  it("supersede works: discard the live one, then a new proposed insert succeeds", async () => {
    // (continues from the row inserted above under a.siblingClientId)
    const superseded = await db.admin.query(
      `update brand_extract_drafts set status = 'discarded'
       where client_id = $1 and status = 'proposed'`,
      [a.siblingClientId]
    );
    expect(superseded.rowCount).toBe(1);
    const fresh = await db.admin.query(
      `${INS} values ($1, $2, ${OBJ}, 'proposed')`,
      [a.tenantId, a.siblingClientId]
    );
    expect(fresh.rowCount).toBe(1);
  });

  it("many DISCARDED / CONSUMED drafts per client are allowed (the index covers only 'proposed')", async () => {
    for (const status of ["discarded", "discarded", "consumed"]) {
      const res = await db.admin.query(`${INS} values ($1, $2, ${OBJ}, '${status}')`, [
        a.tenantId,
        a.siblingClientId,
      ]);
      expect(res.rowCount).toBe(1);
    }
  });
});

describe("runs.input_url coupling + brand_extract kind (migration 0015)", () => {
  it("a non-brand_extract run must NOT carry an input_url", async () => {
    await expectRejected(
      `insert into runs (tenant_id, client_id, kind, input_url) values ($1, $2, 'audit', 'https://x.example')`,
      [a.tenantId, a.clientId],
      /runs_input_url_only_brand_extract/
    );
  });

  it("a brand_extract run MUST carry an input_url", async () => {
    await expectRejected(
      `insert into runs (tenant_id, client_id, kind) values ($1, $2, 'brand_extract')`,
      [a.tenantId, a.clientId],
      /runs_input_url_only_brand_extract/
    );
  });

  it("rejects an over-long input_url", async () => {
    await expectRejected(
      `insert into runs (tenant_id, client_id, kind, input_url) values ($1, $2, 'brand_extract', repeat('x', 2049))`,
      [a.tenantId, a.clientId],
      /runs_input_url_len/
    );
  });

  it("positive: a client-scoped brand_extract run with a bounded input_url is valid", async () => {
    const res = await db.admin.query(
      `insert into runs (tenant_id, client_id, kind, input_url)
       values ($1, $2, 'brand_extract', 'https://client-site.example/')`,
      [a.tenantId, a.clientId]
    );
    expect(res.rowCount).toBe(1);
  });
});

describe("brand_extract_drafts RLS — writer-only (client_viewer is BLIND even to its own client)", () => {
  it("client_viewer sees ZERO drafts for its own client; operator sees the seeded one", async () => {
    // The drafts are INTERNAL pre-approval operator material: brand_extract_drafts_select
    // is `tenant_id = app.tenant_id() and app.is_writer()`, so a client_viewer (not a
    // writer) sees none — even under its own client. Positive control guards a
    // false-green from a blanket deny.
    const viewer = await queryAs<{ n: number }>(
      db.admin,
      "authenticated",
      claimsFor("client_viewer", b.tenantId, { clientId: b.clientId, sub: b.viewerSub }),
      `select count(*)::int as n from brand_extract_drafts where client_id = $1`,
      [b.clientId]
    );
    expect(viewer.rows[0].n).toBe(0);

    const operator = await queryAs<{ n: number }>(
      db.admin,
      "authenticated",
      claimsFor("operator", b.tenantId, { sub: b.operatorSub }),
      `select count(*)::int as n from brand_extract_drafts where client_id = $1`,
      [b.clientId]
    );
    expect(operator.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
