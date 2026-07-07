/**
 * F1 isolation suite — CLIENT_VIEWER SCOPING (doc 03 §7 criterion 3; §2).
 *
 * A client_viewer is read-only and pinned to ONE client within its tenant. It
 * must: see its own client's rows on every client-scoped table; be BLIND to a
 * sibling client in the SAME tenant; see its own tenant row (white-label theme)
 * and its own membership row and nothing else; and be unable to write ANYTHING,
 * anywhere. The sibling client is fully populated (seedSiblingClientRows) so the
 * blindness assertions test real rows, not empty tables.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLIENT_SCOPED_TABLES,
  expectQueryRejected,
  queryAs,
  setupIsolationDb,
  type IsolationDb,
} from "../helpers/harness";
import {
  seedSiblingClientRows,
  seedTenantPair,
  type SeededTenant,
} from "../helpers/seed";
import { claimsForRole, REJECT_NO_GRANT, REJECT_RLS, WRITE_SPECS } from "./fixtures";

let db: IsolationDb;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  db = await setupIsolationDb();
  ({ a, b } = await seedTenantPair(db.admin));
  // Populate every client-scoped table under B's SIBLING client, so viewer
  // blindness is tested against real sibling rows (not empty tables).
  await seedSiblingClientRows(db.admin, b);
});

afterAll(async () => {
  await db?.teardown();
});

/** clients scopes on `id`; every other client-scoped table on `client_id`. */
function clientColumnOf(table: string): "id" | "client_id" {
  return table === "clients" ? "id" : "client_id";
}

async function viewerCountWhere(
  table: string,
  column: string,
  value: string
): Promise<number> {
  const res = await queryAs<{ n: number }>(
    db.admin,
    "authenticated",
    claimsForRole("client_viewer", b),
    `select count(*)::int as n from ${table} where ${column} = $1`,
    [value]
  );
  return res.rows[0].n;
}

describe("client_viewer READ — own client only, sibling client invisible", () => {
  for (const table of CLIENT_SCOPED_TABLES) {
    const col = clientColumnOf(table);

    it(`sees its OWN client's ${table} rows`, async () => {
      expect(await viewerCountWhere(table, col, b.clientId)).toBeGreaterThanOrEqual(1);
    });

    it(`is BLIND to the sibling client's ${table} rows (same tenant, other client)`, async () => {
      expect(await viewerCountWhere(table, col, b.siblingClientId)).toBe(0);
    });

    it(`cannot see tenant A's ${table} rows at all`, async () => {
      expect(await viewerCountWhere(table, "tenant_id", a.tenantId)).toBe(0);
    });
  }

  it("sees exactly ONE clients row — its own, never the sibling", async () => {
    const res = await queryAs<{ id: string }>(
      db.admin,
      "authenticated",
      claimsForRole("client_viewer", b),
      `select id from clients`
    );
    expect(res.rows.map((r) => r.id)).toEqual([b.clientId]);
  });

  it("sees its own tenant row (white-label) — exactly one, its own", async () => {
    const res = await queryAs<{ id: string }>(
      db.admin,
      "authenticated",
      claimsForRole("client_viewer", b),
      `select id from tenants`
    );
    expect(res.rows.map((r) => r.id)).toEqual([b.tenantId]);
  });

  it("sees ONLY its own membership row in tenant_users — not admin/operator rows", async () => {
    const res = await queryAs<{ id: string }>(
      db.admin,
      "authenticated",
      claimsForRole("client_viewer", b),
      `select id from tenant_users`
    );
    expect(res.rows.map((r) => r.id)).toEqual([b.viewerUserId]);
  });
});

describe("client_viewer WRITE — no write ability ANYWHERE (INSERT/UPDATE/DELETE)", () => {
  for (const spec of WRITE_SPECS) {
    it(`cannot INSERT into ${spec.table} (no write policy matches a viewer)`, async () => {
      const ins = spec.buildInsert(b); // even homed at its own client, WITH CHECK denies
      await expectQueryRejected(
        db.admin,
        "authenticated",
        claimsForRole("client_viewer", b),
        ins.text,
        ins.params,
        REJECT_RLS
      );
    });

    it(`UPDATE of its own ${spec.table} row touches ZERO rows (no update policy)`, async () => {
      const res = await queryAs(
        db.admin,
        "authenticated",
        claimsForRole("client_viewer", b),
        `update ${spec.table} set tenant_id = tenant_id where id = $1`,
        [spec.ownRowId(b)]
      );
      expect(res.rowCount ?? 0).toBe(0);
    });

    it(`DELETE of its own ${spec.table} row touches ZERO rows (no delete policy)`, async () => {
      const res = await queryAs(
        db.admin,
        "authenticated",
        claimsForRole("client_viewer", b),
        `delete from ${spec.table} where id = $1`,
        [spec.ownRowId(b)]
      );
      expect(res.rowCount ?? 0).toBe(0);
    });
  }

  it("UPDATE of its own tenant row touches ZERO rows (viewer cannot re-theme)", async () => {
    const res = await queryAs(
      db.admin,
      "authenticated",
      claimsForRole("client_viewer", b),
      `update tenants set name = name where id = $1`,
      [b.tenantId]
    );
    expect(res.rowCount ?? 0).toBe(0);
  });

  it("cannot INSERT a tenant (no grant)", async () => {
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsForRole("client_viewer", b),
      `insert into tenants (name) values ('viewer agency')`,
      undefined,
      REJECT_NO_GRANT
    );
  });
});
